'use strict';

const cheerio = require('cheerio');
const { isPlaceholderAddress } = require('./placeholder');

// How one chapter page of a site delivers its images, read from its HTML only (nothing here touches the network). It is the
// difference between a source that works and one that shows broken pages: the first source the add-source skill wrote read the
// HTML of a chapter that held three "Loading.gif" placeholders where the site's own JavaScript later put 146 real pages.
//
//   inline     the addresses are in the HTML (src, or a lazy attribute such as data-src / data-original that holds the real one)
//   ajax       the HTML holds only placeholders (or nothing) and the page asks an endpoint for the list: `endpoints` names them
//   script     the addresses are in a script of the page (a JSON object or an array: ts_reader.run({...}), `images = [...]`)
//   none       nothing that looks like page images was found (a title page, a login, a challenge, an empty shell)

const BODY_CAP = 1_500_000;
const IMAGE_FILE_RE = /\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i;
// Where a reader's images live in the common themes; the first selector that matches anything wins.
const CONTAINERS = Object.freeze([
  '.page-chapter img', '.reading-content img', '#readerarea img', '.chapter-content img', '#image_container img',
  '.container-chapter-reader img', '#chapter-images img', '.chapter-container img', '#viewer img', '.reader-area img', '.read-content img',
]);
const LAZY_ATTRS = Object.freeze(['data-original', 'data-src', 'data-lazy-src', 'data-url', 'data-cfsrc']);
// A request the page makes to fill the images in: a path with ajax / api / chapter / image / pages in it, in a script.
const ENDPOINT_RE = /["'`]((?:\/|https?:\/\/[^"'`\s]+\/)[A-Za-z0-9_\-./]*(?:ajax|api|chapter|chap|images?|pages?)[A-Za-z0-9_\-./]*)(?:["'`]|\s*\+)/gi;
// An id the page keeps for that request: `const CHAPTER_ID = 61636;`, `chapter_id: 12`, `chapId = "ab"`.
const ID_RE = /\b(?:CHAPTER_ID|chapter_?id|chap_?id|chapterId)\b\s*[:=]\s*["']?([\w-]{1,40})/i;
const MAX_ENDPOINTS = 6;

function readImg($, node) {
  const attrs = {};
  for (const name of ['src', ...LAZY_ATTRS]) { const value = String($(node).attr(name) || '').trim(); if (value) attrs[name] = value; }
  const lazy = LAZY_ATTRS.find((name) => attrs[name] && !isPlaceholderAddress(attrs[name]));
  const real = lazy ? attrs[lazy] : (attrs.src && !isPlaceholderAddress(attrs.src) ? attrs.src : '');
  // An <img> that has an address but no real one is a placeholder (its real address comes later, from a script).
  return { real, lazyAttr: lazy || '', placeholder: !real && Object.keys(attrs).length > 0 };
}

function imagesInContainers($, pageUrl) {
  for (const selector of CONTAINERS) {
    const nodes = $(selector).toArray();
    if (nodes.length) return { selector, entries: nodes.map((node) => readImg($, node)), pageUrl };
  }
  return clusteredImages($, pageUrl);
}

// A site whose reader has none of the known containers: its pages are still the biggest group of pictures that live in one
// folder of one host ("/chapters/<slug>/1/<hash>.webp"), unlike the logo, the cover and the icons that sit alone.
function clusteredImages($, pageUrl) {
  const groups = new Map();
  $('img').each((_, node) => {
    const entry = readImg($, node);
    if (!entry.real) return;
    let key;
    try { const u = new URL(entry.real, pageUrl); key = `${u.hostname}${u.pathname.replace(/[^/]*$/, '')}`; } catch (_) { return; }
    groups.set(key, [...(groups.get(key) || []), entry]);
  });
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  return best && best.length >= 3 ? { selector: '(the largest group of pictures in one folder)', entries: best, pageUrl } : null;
}

/** Image addresses that sit in the page's scripts: a JSON "images": [...] or any run of three or more picture URLs. */
function imagesInScripts($) {
  const found = [];
  $('script:not([src])').each((_, el) => {
    const body = String($(el).html() || '');
    const urls = body.match(/https?:\\?\/\\?\/(?:[^"'\s\\]|\\\/)+?\.(?:jpe?g|png|webp|avif|gif)/gi) || [];
    const cleaned = urls.map((u) => u.replace(/\\\//g, '/')).filter((u) => !isPlaceholderAddress(u));
    if (cleaned.length >= 3) found.push(...cleaned);
  });
  return [...new Set(found)];
}

/** The paths a script uses to ask for the images, and the chapter id it keeps for that request. */
function endpointsIn($) {
  const endpoints = [];
  let chapterId = '';
  // htmx: an element that fetches a fragment of the page (hx-get="/chapters/<id>/images") is the same thing as a script's request.
  $('[hx-get], [data-hx-get]').each((_, el) => {
    const path = String($(el).attr('hx-get') || $(el).attr('data-hx-get') || '');
    if (/image|page|chapter/i.test(path) && !endpoints.includes(path)) endpoints.push(path);
  });
  $('script:not([src])').each((_, el) => {
    const body = String($(el).html() || '');
    if (!chapterId) { const id = ID_RE.exec(body); if (id) chapterId = id[1]; }
    for (const match of body.matchAll(ENDPOINT_RE)) {
      const path = match[1];
      if (IMAGE_FILE_RE.test(path) || /\.(css|js|json)(\?|$)/i.test(path) || /^\/(wp-content|wp-includes|themes|static|assets)\//i.test(path)) continue;
      if (!endpoints.includes(path)) endpoints.push(path);
    }
  });
  return { endpoints: endpoints.slice(0, MAX_ENDPOINTS), chapterId };
}

/**
 * @param {string} html
 * @param {string} pageUrl
 * @returns {{
 *   kind: 'inline'|'ajax'|'script'|'none', selector: string, total: number, real: number, placeholders: number, distinct: number,
 *   lazyAttr: string, sample: string, endpoints: string[], chapterId: string, scriptImages: number,
 * }}
 */
function analyzeChapterPage(html, pageUrl) {
  let $;
  try { $ = cheerio.load(String(html || '').slice(0, BODY_CAP)); } catch (_) { $ = cheerio.load(''); }
  const found = imagesInContainers($, pageUrl);
  const entries = found ? found.entries : [];
  const real = entries.filter((e) => e.real);
  const placeholders = entries.filter((e) => e.placeholder).length;
  const lazyAttr = (real.find((e) => e.lazyAttr) || {}).lazyAttr || '';
  const scriptImages = imagesInScripts($);
  const { endpoints, chapterId } = endpointsIn($);

  let kind = 'none';
  if (real.length >= 2 || (real.length === 1 && placeholders === 0)) kind = 'inline';
  else if (scriptImages.length >= 3) kind = 'script';
  else if ((placeholders > 0 || entries.length === 0) && (endpoints.length || chapterId) && (entries.length > 0 || /reader|chapter|image/i.test($('body').attr('class') || ''))) kind = 'ajax';
  else if (placeholders > 0) kind = 'ajax'; // only placeholders and no endpoint named: still not something to read from the HTML
  else if (entries.length === 0 && endpoints.some((e) => /image|page/i.test(e))) kind = 'ajax'; // no picture at all, and the page asks for them

  const firstAddress = real.length ? real[0].real : (scriptImages[0] || '');
  let sample;
  try { sample = firstAddress ? new URL(firstAddress, pageUrl).href : ''; } catch (_) { sample = firstAddress; }
  return {
    kind,
    selector: found ? found.selector : '',
    total: entries.length,
    real: real.length,
    placeholders,
    distinct: new Set(real.map((e) => e.real)).size,
    lazyAttr,
    sample,
    endpoints,
    chapterId,
    scriptImages: scriptImages.length,
  };
}

const NOT_A_CHAPTER_TAIL = /\/(report|comments?|list|all|latest|new|rss|feed|download|bookmark|follow)\/?$/i;

// A path of one chapter: a chapter / chap / episode / read word followed by a number or an id ("/chapter-12", "/chapter/1",
// "/chapters/01M5V7R4TX", "/read/12"), never the list of chapters ("/chapters") or a page about one ("/chapters/700921/report").
function looksLikeChapterPath(pathname, search = '') {
  if (NOT_A_CHAPTER_TAIL.test(pathname)) return false;
  if (/[?&](?:chapter|chap|ch|ep|episode)=\d/i.test(search)) return true; // /chaptered.php?manga=308&chapter=12
  if (/\/c\d{1,5}(?:\.\d+)?(?:\/|$)/i.test(pathname)) return true; // /manga/<slug>/c258/1.html
  if (/\/ch[-_.]?\d/i.test(pathname)) return true;
  return /(chapters?|chap|episodes?|ep|read)[-_/.]?[-\w]*\d/i.test(pathname.replace(/\/(chapters?|chap|episodes?|ep|read)\/?$/i, ''));
}

/** A link on a title page that leads to one of its chapters: [first, last] in page order (newest and oldest on most sites). */
function chapterLinksFrom(html, pageUrl) {
  let $;
  try { $ = cheerio.load(String(html || '').slice(0, BODY_CAP)); } catch (_) { return []; }
  const seen = new Set();
  const links = [];
  $('a[href]').each((_, a) => {
    let url;
    try { url = new URL($(a).attr('href'), pageUrl); } catch (_) { return; }
    if (!/^https?:$/.test(url.protocol) || url.origin !== new URL(pageUrl).origin) return;
    if (!looksLikeChapterPath(url.pathname, url.search)) return;
    const href = url.href.split('#')[0];
    if (!seen.has(href)) { seen.add(href); links.push(href); }
  });
  const own = new URL(pageUrl).pathname.replace(/\/$/, '');
  const ofThisTitle = own.split('/').filter(Boolean).length >= 1 ? links.filter((href) => new URL(href).pathname.startsWith(`${own}/`)) : [];
  const chosen = ofThisTitle.length ? ofThisTitle : links;
  if (chosen.length < 2) return chosen;
  return [chosen[0], chosen[chosen.length - 1]];
}

/**
 * A title page whose chapter list is not in its HTML but fetched by a call (Madara: a POST to admin-ajax.php with the action
 * manga_get_chapters, or to <title address>/ajax/chapters/). Returns what to ask, or null.
 */
function chapterListRequest(html) {
  const text = String(html || '').slice(0, BODY_CAP);
  if (/manga_get_chapters/.test(text)) return { kind: 'madara', endpoint: '/wp-admin/admin-ajax.php', action: 'manga_get_chapters', hint: 'POST /wp-admin/admin-ajax.php with action=manga_get_chapters and manga=<the title\'s numeric id>, or POST <title address>/ajax/chapters/' };
  if (/\/ajax\/chapters\/?["'`]/.test(text)) return { kind: 'madara', endpoint: '/ajax/chapters/', action: '', hint: 'POST <title address>/ajax/chapters/ (an empty POST returns the chapter list)' };
  return null;
}

module.exports = { analyzeChapterPage, chapterLinksFrom, chapterListRequest, CONTAINERS };
