'use strict';

const cheerio = require('cheerio');
const { detectDateOrder } = require('../chapter-dates');

// What a template cannot know and a title page tells: how the site prints its dates. Read in memory from a page the generator already fetched.

const DATE_SELECTORS = Object.freeze({ madara: '.chapter-release-date', mangathemesia: '.chapterdate' });
const MAX_SAMPLES = 40;

/** The printed dates of the chapters of a page, as text (the first ones). */
function chapterDateTexts(engineId, html) {
  const selector = DATE_SELECTORS[engineId];
  if (!selector) return [];
  const $ = cheerio.load(String(html || '').slice(0, 1_500_000));
  return $(selector).slice(0, MAX_SAMPLES).map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean);
}

/** The `lang` of a page ("en-US", "pt-BR"), or ''. */
function pageLanguage(html) {
  const m = /<html[^>]*\blang=["']([A-Za-z-]{2,10})["']/i.exec(String(html || '').slice(0, 4000));
  return m ? m[1] : '';
}

/** How the site orders a numeric date, from its home page's language and the dates of a title's chapters. */
function dateOrderOf(engineId, chaptersHtml, homeHtml) {
  return detectDateOrder(chapterDateTexts(engineId, chaptersHtml), pageLanguage(homeHtml));
}

/** The address of a title page from any address of the site's titles ("/folder/slug/" from "/folder/slug/chapter-3/"), or '' when it has no such shape. */
function titlePageOf(url) {
  try {
    const u = new URL(String(url));
    const parts = u.pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? `${u.origin}/${parts[0]}/${parts[1]}/` : '';
  } catch (_) {
    return '';
  }
}

/**
 * The addresses of titles on a list page of the site: same-origin links of the shape /<folder>/<slug>/, each once, in the order of the page.
 * @param {string} html  @param {string} base  the site's origin  @param {string} folder  the folder the site keeps its titles in  @param {number} [max]
 */
function titleLinksFrom(html, base, folder, max = 6) {
  const found = [];
  const seen = new Set();
  let origin;
  try { origin = new URL(base).origin; } catch (_) { return found; }
  const re = /href\s*=\s*["']([^"'#?]+)["']/gi;
  const text = String(html || '').slice(0, 1_500_000);
  let m;
  while ((m = re.exec(text)) && found.length < max) {
    let url;
    try { url = new URL(m[1], origin); } catch (_) { continue; }
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.origin !== origin || parts.length !== 2 || parts[0] !== folder) continue;
    const page = `${origin}/${parts[0]}/${parts[1]}/`;
    if (!seen.has(page)) { seen.add(page); found.push(page); }
  }
  return found;
}

/** Whether the page really lists chapters (elements of the theme's chapter list): a page that only MENTIONS the class in a style or a script does not. */
function hasMadaraChapters(html) {
  try {
    return cheerio.load(String(html || '').slice(0, 2_000_000))('li.wp-manga-chapter').length > 0;
  } catch (_) {
    return false;
  }
}

module.exports = { hasMadaraChapters, chapterDateTexts, pageLanguage, dateOrderOf, titlePageOf, titleLinksFrom };
