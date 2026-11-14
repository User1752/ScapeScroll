'use strict';

const fs = require('fs');
const path = require('path');
const { namesNeverListedCategory } = require('../../common/source-ui');
const { originLine } = require('./origin');

// Writing a source from what the probe measured, WITHOUT an AI: the site's engine names a template (a source file whose shape is
// documented for that software), and the measured facts (the base address, the name, the genres, whether the text search is
// allowed) are the only things filled in. Every value is validated and put in as a JSON literal, so a hostile page cannot put code
// in the generated file; the result still goes through the Check and the live Test before it is installed.

const TEMPLATES = Object.freeze({
  madara: path.join(__dirname, 'madara.template.txt'),
  mangathemesia: path.join(__dirname, 'mangathemesia.template.txt'),
  iken: path.join(__dirname, 'iken.template.txt'),
  keyoapp: path.join(__dirname, 'keyoapp.template.txt'),
  vinetheme: path.join(__dirname, 'vinetheme.template.txt'),
});
const ID_RE = /^[a-z0-9][a-z0-9_-]{1,59}$/;
const SLUG_RE = /^[a-z0-9][\w-]{0,59}$/i;
const MAX_GENRES = 120;
// The folder a site keeps its titles in: a plain word ("manga", "series", "komik"...), put into addresses and a pattern, so nothing else is accepted.
const SUBPATH_RE = /^[a-z0-9][\w-]{0,29}$/i;
const DEFAULT_SUBPATH = 'manga';
// How a numeric date is read when no day above 12 settles it; measured on the site, "mdy" (what a plain Date.parse did) when nothing was.
const DATE_ORDERS = Object.freeze(['dmy', 'mdy', 'ymd']);
// What the app hides with Hide NSFW: names a general site gives to adult material ("ecchi" is not one of them).
const NSFW_GENRE_RE = /^(adult|mature|smut|hentai|erotica|sexual violence|sexual content)$/i;

/** The engines a template exists for. */
const supportedEngines = () => Object.keys(TEMPLATES);

// Control, separator and bidi characters are removed (the class is spelled with escapes).
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]', 'g');
const oneLine = (value, max) => String(value === undefined || value === null ? '' : value).replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** A readable id for a site: its host without "www." and the suffix ("mangas.example" -> "mangas"). */
function idFromBase(base) {
  const host = new URL(base).hostname.replace(/^www\./, '');
  return host.split('.').slice(0, -1).join('-').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || host.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * A site name that is safe to print and to put in a comment: letters, digits, spaces and a few marks, nothing that could be read as
 * code or look like a risky call (a dot, an underscore, a bracket, a quote or a slash becomes a space).
 */
const cleanLabel = (value, max) => oneLine(value, max).replace(/[^\p{L}\p{N} '&!+-]/gu, ' ').replace(/\s+/g, ' ').trim();
const cleanName = (name, fallback) => cleanLabel(name, 60) || fallback;

const isNeverListed = (name) => namesNeverListedCategory(name) || /(^|[^a-z])(loli|shota|toddler)/i.test(name);

/** The slugs of the site's own never-listed genres: their titles are kept out of every list by the generated source. */
function neverListedSlugs(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const name = oneLine(item && item.name, 60);
    const slug = String((item && item.slug) || '').trim();
    if (name && SLUG_RE.test(slug) && isNeverListed(name) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

function cleanGenres(raw) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    const name = cleanLabel(item && item.name, 40);
    const slug = String((item && item.slug) || '').trim();
    if (!name || !SLUG_RE.test(slug) || seen.has(name.toLowerCase())) continue;
    if (isNeverListed(name)) continue; // never listed, never offered
    seen.add(name.toLowerCase());
    out.push({ name, slug });
    if (out.length >= MAX_GENRES) break;
  }
  return out;
}

/**
 * @param {{ engine: string, base: string, name?: string, id?: string, genres?: { name: string, slug: string }[], textSearch?: boolean, nativeDates?: boolean, adultOnly?: boolean, subpath?: string, api?: string, dateOrder?: string, date?: string }} config
 * @returns {{ code: string, id: string, name: string, genres: number, nsfw: string[], textSearch: boolean, neverListedGenres: number, adultOnly: boolean }}
 */
function buildSource(config) {
  const file = TEMPLATES[config && config.engine];
  if (!file) throw new Error(`No template for "${config && config.engine}" (supported: ${supportedEngines().join(', ') || 'none'}).`);
  let url;
  try { url = new URL(String(config.base)); } catch (err) { throw new Error('The base address is not a web address.', { cause: err }); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The base address must be a plain https address.');
  const base = url.origin;
  const id = String(config.id || idFromBase(base));
  if (!ID_RE.test(id)) throw new Error(`"${id}" is not a usable source id (letters, digits, "_" and "-", 2 to 60 characters).`);
  const name = cleanName(config.name, id);
  const genres = cleanGenres(config.genres);
  const never = neverListedSlugs(config.genres);
  const nsfw = genres.map((g) => g.name).filter((n) => NSFW_GENRE_RE.test(n));
  // A site that flags a title as adult (not by a genre) has that title carry an "Adult" genre in its cards, so Hide NSFW can hide it.
  if (config.engine === 'vinetheme' && !nsfw.includes('Adult')) nsfw.push('Adult');
  const subpath = typeof config.subpath === 'string' && SUBPATH_RE.test(config.subpath) ? config.subpath : DEFAULT_SUBPATH;
  const dateOrder = DATE_ORDERS.includes(config.dateOrder) ? config.dateOrder : 'mdy';
  const slugs = Object.fromEntries(genres.map((g) => [g.name.toLowerCase(), g.slug]));
  // Where the site's JSON API is (the engines that have one): an https address of its own, else the site itself. Genres of such an engine are numeric ids.
  let api = base;
  if (config.api !== undefined && config.api !== null && config.api !== '') {
    let apiUrl;
    try { apiUrl = new URL(String(config.api)); } catch (err) { throw new Error('The API address is not a web address.', { cause: err }); }
    if (apiUrl.protocol !== 'https:' || apiUrl.username || apiUrl.password) throw new Error('The API address must be a plain https address.');
    api = apiUrl.origin;
  }
  const genreIds = Object.fromEntries(genres.filter((g) => /^\d{1,9}$/.test(g.slug)).map((g) => [g.name.toLowerCase(), Number(g.slug)]));

  // The day it was written, in the file's header: it is what a later "Regenerate" says it replaces.
  const on = /^\d{4}-\d{2}-\d{2}$/.test(String(config.date || '')) ? config.date : new Date().toISOString().slice(0, 10);

  const fills = {
    __ORIGIN__: originLine({ engine: config.engine, base, on }),
    __NAME_TEXT__: name, __BASE_TEXT__: base,
    __SUBPATH__: JSON.stringify(subpath), __DATE_ORDER__: JSON.stringify(dateOrder),
    __API__: JSON.stringify(api), __GENRE_IDS__: JSON.stringify(genreIds),
    __BASE__: JSON.stringify(base), __NAME__: JSON.stringify(name), __ID__: JSON.stringify(id),
    __NEVER_SLUGS__: JSON.stringify(never), __ADULT_ONLY__: config.adultOnly === true ? 'true' : 'false',
    __GENRE_SLUGS__: JSON.stringify(slugs), __GENRES__: JSON.stringify(genres.map((g) => g.name)), __NSFW__: JSON.stringify(nsfw),
    __TEXT_SEARCH__: config.textSearch === false ? 'false' : 'true', __NATIVE_DATES__: config.nativeDates === true ? 'true' : 'false',
  };
  // LF whatever the checkout did to the template: the file written is the same on every computer (and its fingerprint with it).
  let code = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  // Longest token first: __NAME_TEXT__ must not be eaten by __NAME__.
  for (const token of Object.keys(fills).sort((a, b) => b.length - a.length)) code = code.split(token).join(fills[token]);
  if (/__[A-Z_]+__/.test(code)) throw new Error('A placeholder of the template was left unfilled.');
  return { code, id, name, genres: genres.length, nsfw, textSearch: config.textSearch !== false, neverListedGenres: never.length, adultOnly: config.adultOnly === true, subpath, api, dateOrder };
}

module.exports = { buildSource, supportedEngines, idFromBase, SUBPATH_RE, DEFAULT_SUBPATH };
