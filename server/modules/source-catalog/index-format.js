'use strict';

// Reading the list a repository of Mihon-compatible extensions publishes: each extension, the sites it covers and what kind of content
// they carry. Two layouts exist: the current one ({ name, extensionList: { extensions: [...] } }) and the old plain array. The text is
// third-party data, so every value that comes out is a short plain string or a number, and a site whose address is not a plain
// https address is left out (a source can only be written for one).

const WARNINGS = Object.freeze(['SAFE', 'MIXED', 'NSFW']);
const PACKAGE_RE = /^eu\.kanade\.tachiyomi\.extension\.([a-z]{2,4})\.([a-z0-9_]{1,60})$/;
const LANG_RE = /^[A-Za-z]{2,4}(?:-[A-Za-z0-9]{2,8})?$/;
const ICON_HOSTS = require('../../config/catalog').iconHosts;
const SOURCE_ID_RE = /^\d{1,20}$/;
const MAX_EXTENSIONS = 5000;
const MAX_SITES_PER_EXTENSION = 400;

// Control, separator and bidi characters. The class is built from code points, not typed, so that no editor or tool can turn an
// escape in this file into the character itself (a line separator inside a regular expression is a syntax error).
const UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]];
const UNSAFE_CHARS = new RegExp(`[${UNSAFE_RANGES.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`, 'g');
const oneLine = (value, max) => String(value === undefined || value === null ? '' : value).replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** 'CONTENT_WARNING_NSFW', 'nsfw', 3 or (the old layout) nsfw: 1 -> 'NSFW'; anything not understood counts as 'MIXED', the careful middle. */
function warningOf(raw) {
  if (typeof raw === 'number') return [null, 'SAFE', 'MIXED', 'NSFW'][raw] || 'MIXED';
  const word = String(raw === undefined || raw === null ? '' : raw).toUpperCase().replace(/^CONTENT_WARNING_/, '');
  if (word === 'UNSPECIFIED') return 'SAFE';
  return WARNINGS.includes(word) ? word : 'MIXED';
}

/** The origin of a plain https address, or '' when it is anything else (an address with a login, a port, a different scheme). */
function httpsOrigin(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

/** The icon of an extension: a plain https address on a host the catalog may show logos from, or '' (the person then sees an initial instead). */
function iconOf(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return '';
    if (!ICON_HOSTS.includes(url.hostname)) return '';
    return /^\/[A-Za-z0-9._~%@/+-]{1,280}$/.test(url.pathname) && url.href.length <= 320 ? url.href : '';
  } catch (_) {
    return '';
  }
}

function siteOf(raw, fallbackLang) {
  const site = raw && typeof raw === 'object' ? raw : {};
  const url = httpsOrigin(site.homeUrl !== undefined ? site.homeUrl : site.baseUrl);
  if (!url) return null;
  const lang = String(site.language !== undefined ? site.language : site.lang || fallbackLang || '').trim();
  const known = LANG_RE.test(lang) || lang === 'all';
  // The id the source has in the extension (and in Suwayomi): a whole number written as text, up to 20 digits, never a JS number (they do not fit one).
  const rawId = typeof site.id === 'string' ? site.id.trim() : '';
  return {
    sourceId: SOURCE_ID_RE.test(rawId) ? rawId : '',
    name: oneLine(site.name, 80) || new URL(url).hostname,
    lang: known ? lang : (LANG_RE.test(fallbackLang) ? fallbackLang : 'all'),
    url,
    host: new URL(url).hostname,
  };
}

function extensionOf(raw) {
  const ext = raw && typeof raw === 'object' ? raw : {};
  const pkg = String(ext.packageName !== undefined ? ext.packageName : ext.pkg || '');
  if (!PACKAGE_RE.test(pkg)) return null;
  const fallbackLang = PACKAGE_RE.exec(pkg)[1];
  const sites = (Array.isArray(ext.sources) ? ext.sources : []).slice(0, MAX_SITES_PER_EXTENSION).map((s) => siteOf(s, fallbackLang)).filter(Boolean);
  if (!sites.length) return null;
  return {
    pkg,
    name: oneLine(ext.name, 80) || pkg,
    version: oneLine(ext.versionName !== undefined ? ext.versionName : ext.version, 30),
    icon: iconOf(ext.resources && ext.resources.iconUrl),
    // The old layout only knows adult or not.
    warning: ext.contentWarning !== undefined ? warningOf(ext.contentWarning) : (Number(ext.nsfw) === 1 ? 'NSFW' : 'SAFE'),
    sites,
  };
}

/**
 * @param {unknown} json   the parsed text of the repository's list
 * @returns {{ format: 'current' | 'old', extensions: Array<{ pkg: string, name: string, version: string, warning: 'SAFE'|'MIXED'|'NSFW', sites: Array<{ name: string, lang: string, url: string, host: string }> }> }}
 * @throws {Error} when the text is not a list of extensions this app can read
 */
function parseRepoIndex(json) {
  let format;
  let list;
  if (Array.isArray(json)) {
    format = 'old';
    list = json;
  } else if (json && typeof json === 'object' && json.extensionList && typeof json.extensionList === 'object') {
    format = 'current';
    list = Array.isArray(json.extensionList) ? json.extensionList : Object.values(json.extensionList).filter(Array.isArray).flat();
  } else if (json && typeof json === 'object' && typeof json.extensionListUrl === 'string') {
    throw new Error('This repository keeps its list of extensions in a separate file, which is not supported yet.');
  } else {
    throw new Error('This is not a list of extensions.');
  }
  const extensions = list.slice(0, MAX_EXTENSIONS).map(extensionOf).filter(Boolean);
  if (!extensions.length) throw new Error('The repository lists no extension this app can read.');
  return { format, extensions };
}

module.exports = { parseRepoIndex, warningOf, httpsOrigin, PACKAGE_RE, WARNINGS };
