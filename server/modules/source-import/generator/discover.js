'use strict';

const cheerio = require('cheerio');

// What a template cannot know and a page tells: the site's name and the genres it lists. Read in memory (the app's own
// private-address-checked request, nothing written), from the pages the theme documents; a page that does not answer leaves the
// field empty and the generator says so instead of guessing.

const genreFromLink = ($, a) => {
  const href = String($(a).attr('href') || '');
  const m = href.match(/\/manga-genre\/([^/?#]+)/);
  const name = $(a).clone().children('span, .count').remove().end().text().replace(/\s+/g, ' ').trim();
  return m && name ? { name, slug: decodeURIComponent(m[1]) } : null;
};

const { SUBPATH_RE, DEFAULT_SUBPATH } = require('./index');

/**
 * The folder a site keeps its titles in ("manga", "series", "komik"...): the first part of the address of a title page the probe found.
 * A title page has at least two parts (the folder and the title); anything that is not a plain word falls back to "manga", and the fit
 * check then looks for the cards of the list in the folder this names, so a wrong guess is refused, not written.
 */
function titleFolderFrom(titleUrl) {
  try {
    const parts = new URL(String(titleUrl)).pathname.split('/').filter(Boolean);
    return parts.length >= 2 && SUBPATH_RE.test(parts[0]) ? decodeURIComponent(parts[0]).toLowerCase() : DEFAULT_SUBPATH;
  } catch (_) {
    return DEFAULT_SUBPATH;
  }
}

const ADULT_SITE_RE = /\b(hentai|porn|porno|xxx|nsfw|adults? only|adult (manga|comics|webtoons?|content))\b|(^|[^\w])18\+/i;

/**
 * Whether the site presents itself as adult-only: its own name or description says so (it is a statement of the site, not a guess from
 * a genre), or the home page shows an age check. A general site with an "Adult" genre among a hundred is not adult-only.
 */
function looksAdultOnly(html, { ageGate = false } = {}) {
  const $ = cheerio.load(String(html || '').slice(0, 400_000));
  const said = [siteNameFrom(html), $('title').first().text(), $('meta[name="description"]').attr('content'), $('meta[property="og:description"]').attr('content')].join(' ');
  return ageGate === true || ADULT_SITE_RE.test(said);
}

/** The site's name from its own markup: og:site_name, else the title before its separator. */
function siteNameFrom(html) {
  const $ = cheerio.load(String(html || '').slice(0, 400_000));
  const og = $('meta[property="og:site_name"]').attr('content');
  if (og && og.trim()) return og.trim();
  const title = $('title').first().text().trim();
  return title.split(/\s[-|–—]\s/).pop().trim() || title;
}

/** The genres of a Madara site: the advanced-search form's checkboxes, else the genre links of any page. */
function madaraGenresFrom(html) {
  const $ = cheerio.load(String(html || '').slice(0, 1_500_000));
  const found = [];
  $('input[name="genre[]"]').each((_, input) => {
    const slug = String($(input).attr('value') || '').trim();
    const id = $(input).attr('id');
    const label = (id && $(`label[for="${id}"]`).first().text()) || $(input).parent().text();
    const name = String(label || '').replace(/\s+/g, ' ').replace(/\(\d+\)\s*$/, '').trim();
    if (slug && name) found.push({ name, slug });
  });
  if (!found.length) $('a[href*="/manga-genre/"]').each((_, a) => { const g = genreFromLink($, a); if (g) found.push(g); });
  return found;
}

/**
 * @param {string} base
 * @param {(url: string) => Promise<string>} fetchPage  reads a page in memory
 */
async function discoverMadara(base, fetchPage, folder = DEFAULT_SUBPATH) {
  const notes = [];
  let name = '';
  let genres = [];
  let adultOnly = false;
  try { const home = await fetchPage(`${base}/`); name = siteNameFrom(home); adultOnly = looksAdultOnly(home); } catch (err) { notes.push(`the home page did not answer (${String(err.message).slice(0, 60)})`); }
  for (const url of [`${base}/?s=&post_type=wp-manga`, `${base}/${folder}/`]) {
    if (genres.length) break;
    try { genres = madaraGenresFrom(await fetchPage(url)); } catch (err) { notes.push(`${new URL(url).pathname}${new URL(url).search} did not answer (${String(err.message).slice(0, 60)})`); }
  }
  if (!genres.length) notes.push('no genre list was found: the source is generated without genres');
  return { name, genres, notes, adultOnly };
}

/** The genres of a MangaThemesia list page: the filter's checkboxes (their value is what the filter takes). */
function mangaThemesiaGenresFrom(html) {
  const $ = cheerio.load(String(html || '').slice(0, 1_500_000));
  const found = [];
  $('input[name="genre[]"]').each((_, input) => {
    const value = String($(input).attr('value') || '').trim();
    const id = $(input).attr('id');
    const label = (id && $(`label[for="${id}"]`).first().text()) || $(input).parent().text();
    const name = String(label || '').replace(/\s+/g, ' ').replace(/\(\d+\)\s*$/, '').trim();
    if (value && name) found.push({ name, slug: value });
  });
  return found;
}

/** @param {string} base  @param {(url: string) => Promise<string>} fetchPage  @param {string} [folder]  the folder of the titles */
async function discoverMangaThemesia(base, fetchPage, folder = DEFAULT_SUBPATH) {
  const notes = [];
  let name = '';
  let genres = [];
  let adultOnly = false;
  try { const home = await fetchPage(`${base}/`); name = siteNameFrom(home); adultOnly = looksAdultOnly(home); } catch (err) { notes.push(`the home page did not answer (${String(err.message).slice(0, 60)})`); }
  try { genres = mangaThemesiaGenresFrom(await fetchPage(`${base}/${folder}/`)); } catch (err) { notes.push(`/${folder}/ did not answer (${String(err.message).slice(0, 60)})`); }
  if (!genres.length) notes.push('no genre list was found: the source is generated without genres');
  return { name, genres, notes, adultOnly };
}

/**
 * The name and the genres of an Iken site: the name from the home page, the genres from the API's own list (each with the numeric id its filter takes).
 * @param {string} base  @param {(url: string) => Promise<string>} fetchPage  @param {string} api  the API's origin  @param {(url: string) => Promise<any>} fetchJson
 */
async function discoverIken(base, fetchPage, api, fetchJson) {
  const notes = [];
  let name = '';
  let genres = [];
  let adultOnly = false;
  try { const home = await fetchPage(`${base}/`); name = siteNameFrom(home); adultOnly = looksAdultOnly(home); } catch (err) { notes.push(`the home page did not answer (${String(err.message).slice(0, 60)})`); }
  try {
    const list = await fetchJson(`${api}/api/genres`);
    genres = (Array.isArray(list) ? list : []).filter((g) => g && Number.isInteger(g.id) && typeof g.name === 'string').map((g) => ({ name: g.name, slug: String(g.id) }));
  } catch (err) { notes.push(`the genre list did not answer (${String(err.message).slice(0, 60)})`); }
  if (!genres.length) notes.push('no genre list was found: the source is generated without genres');
  return { name, genres, notes, adultOnly };
}

/** The genres of a Keyoapp site: the items of the genre dropdown the series page starts with a script (each has the value its filter and every title's tags use). */
function keyoappGenresFrom(html) {
  const text = String(html || '').slice(0, 2_000_000);
  const at = text.search(/type:\s*["']genre["']/);
  if (at < 0) return [];
  const block = text.slice(at, at + 80_000);
  const start = block.indexOf('items');
  if (start < 0) return [];
  const items = block.slice(start, block.indexOf(']', start) < 0 ? undefined : block.indexOf(']', start));
  const found = [];
  for (const object of items.match(/\{[^{}]*\}/g) || []) {
    const value = /value:\s*["']([^"']{1,60})["']/.exec(object);
    const label = /displayName:\s*["']([^"']{1,60})["']/.exec(object);
    if (value && label) found.push({ name: label[1], slug: value[1] });
    if (found.length >= 200) break;
  }
  return found;
}

/** @param {string} base  @param {(url: string) => Promise<string>} fetchPage */
async function discoverKeyoapp(base, fetchPage) {
  const notes = [];
  let name = '';
  let genres = [];
  let adultOnly = false;
  try { const home = await fetchPage(`${base}/`); name = siteNameFrom(home); adultOnly = looksAdultOnly(home); } catch (err) { notes.push(`the home page did not answer (${String(err.message).slice(0, 60)})`); }
  try { genres = keyoappGenresFrom(await fetchPage(`${base}/series`)); } catch (err) { notes.push(`/series did not answer (${String(err.message).slice(0, 60)})`); }
  if (!genres.length) notes.push('no genre list was found: the source is generated without genres');
  return { name, genres, notes, adultOnly };
}

/**
 * The name and the genres of a VineTheme site: the name from the home page, the genres from the titles on the first pages of the site's own series list
 * (each carries its genres with the slug the site's filter takes). A genre no title carries is not offered.
 * @param {string} base  @param {(url: string) => Promise<string>} fetchPage  @param {(url: string) => Promise<Map<string, object>>} fetchRows  the rows of a page asked with the rsc header
 */
async function discoverVineTheme(base, fetchPage, fetchRows) {
  const { rscResolve, rscFind } = require('../rsc-reader');
  const notes = [];
  let name = '';
  let adultOnly = false;
  const found = new Map();
  try { const home = await fetchPage(`${base}/`); name = siteNameFrom(home); adultOnly = looksAdultOnly(home); } catch (err) { notes.push(`the home page did not answer (${String(err.message).slice(0, 60)})`); }
  try {
    for (let page = 1; page <= 3; page += 1) {
      const rows = await fetchRows(`${base}/series?sort=updated&page=${page}`);
      const list = rscFind(rows, (o) => Array.isArray(o.initialSeries) || typeof o.initialSeries === 'string');
      for (const item of list ? [].concat(rscResolve(list.initialSeries, rows) || []) : []) {
        for (const g of Array.isArray(item && item.genres) ? item.genres : []) {
          const inner = g && typeof g === 'object' ? g : {};
          const label = String(inner.name || (inner.genre && inner.genre.name) || '').trim();
          const slug = String(inner.slug || (inner.genre && inner.genre.slug) || '').trim();
          if (label && slug && !found.has(label.toLowerCase())) found.set(label.toLowerCase(), { name: label, slug });
        }
      }
      const paging = rscFind(rows, (o) => 'totalPages' in o && 'hasMore' in o && 'page' in o);
      if (!(paging && paging.hasMore)) break;
    }
  } catch (err) { notes.push(`the title list did not answer (${String(err.message).slice(0, 60)})`); }
  const genres = [...found.values()];
  if (!genres.length) notes.push('no genre list was found: the source is generated without genres');
  return { name, genres, notes, adultOnly };
}

module.exports = { discoverVineTheme, discoverKeyoapp, keyoappGenresFrom, discoverIken, titleFolderFrom, discoverMadara, discoverMangaThemesia, siteNameFrom, madaraGenresFrom, mangaThemesiaGenresFrom, looksAdultOnly };
