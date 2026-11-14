'use strict';

// What a source can declare about itself in `meta.ui`, so installing the file is enough for the app to use it well:
// which filters are real, its own genre list, its own sort options, whether every title is adult, whether its chapter
// dates are real (calendar) and which image hosts want a Referer. Before this, each of those was a table keyed by the
// source id in the front end or in fetch-utils.js that somebody had to edit by hand.
//
// A declaration comes from a file nobody has reviewed line by line, so it is DATA to be validated, never trusted:
//   - sanitizeSourceUi() keeps only what it understands, within size and character limits, and reports the rest;
//   - a declaration can only narrow things (hide, label, flag as adult). It cannot widen what a source may reach: the
//     Referer rules below only accept an origin whose host the source's own code already names.
//
// Shape (every field optional):
//   ui: {
//     filters: { orderBy: bool | [value | { value, label }], publicationStatus: bool, contentRating: bool, format: bool, genres: bool },
//     genres: ['Name', ...],            // the names byGenres() accepts; implies filters.genres
//     nsfwGenres: ['Name', ...],        // a subset of genres the app treats as adult
//     adultOnly: true,                  // every title of this source is adult content
//     nativeDates: true,                // chapters carry real publish dates (calendar)
//     customTags: true,                 // byGenres() also accepts a tag the person types (the genre box then lets them add one)
//     imageReferers: [{ host: 'cdn.example.com' | '*.example.com', referer: 'https://example.com' }],
//   }

const ORDER_BY_LABELS = Object.freeze({
  relevance: 'Best Match',
  latestUploadedChapter: 'Latest Upload',
  title: 'Title (A-Z)',
  '-title': 'Title (Z-A)',
  rating: 'Highest Rating',
  followedCount: 'Most Follows',
  createdAt: 'Recently Added',
  year: 'Year Ascending',
  '-year': 'Year Descending',
});
const FILTER_KEYS = Object.freeze(['orderBy', 'publicationStatus', 'contentRating', 'format', 'genres']);
const TOP_LEVEL_KEYS = Object.freeze(['filters', 'genres', 'nsfwGenres', 'adultOnly', 'nativeDates', 'customTags', 'imageReferers']);

// Wildcard bases a Referer rule may not use: public suffixes, and hosts shared by many unrelated sites (a rule there would
// change the Referer of images that are not this source's).
const SHARED_WILDCARD_BASES = new Set([
  'co.uk', 'org.uk', 'com.br', 'co.jp', 'com.au', 'co.kr', 'co.in', 'com.cn', 'com.mx', 'co.nz', 'com.tr', 'co.za', 'com.ar', 'com.tw',
  'cloudfront.net', 'amazonaws.com', 'googleusercontent.com', 'githubusercontent.com', 'imgur.com', 'cloudflare.com', 'akamaihd.net',
  'fastly.net', 'azureedge.net', 'b-cdn.net', 'jsdelivr.net', 'blogspot.com', 'wp.com', 'wixstatic.com', 'discordapp.com',
  'discordapp.net', 'twimg.com', 'fbcdn.net', 'imgbb.com', 'postimg.cc', 'pinimg.com',
]);

const MAX_GENRES = 200;
const MAX_NAME_LENGTH = 40;
const MAX_ORDER_OPTIONS = 12;
const MAX_REFERERS = 10;
const MAX_PROBLEMS = 30;

// Categories about sexualised minors are never offered (guide rule 1.6, GUIDELINES): the start of any word of a name.
const NEVER_LISTED_RE = /(^|[^a-z])(loli|shota|toddler)/i;
// A genre name may start with a plus sign ("+100 Chapter" is a real category of a real site).
const GENRE_NAME_RE = /^[\p{L}\p{N}+][\p{L}\p{N} &'’.+\-/()!:,]*$/u;
// A sort value is sent to the source as it is and the source reads it: the nine the app knows have a standard label, any other
// simple word is allowed when the declaration gives it a label (a source may sort by "favorites").
const ORDER_VALUE_RE = /^-?[A-Za-z][A-Za-z0-9_-]{0,30}$/;
const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} &'’.+\-/()!:,]*$/u;
const HOST_RE = /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

// Only an ordinary object literal: an object whose prototype was replaced (`{ __proto__: {...} }`) would let fields be read
// through it that Object.keys() does not list.
const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

// Any value as short text for a message, without ever calling the value's own toString (it may be a trap).
const shown = (value) => (typeof value === 'string' ? value : Object.prototype.toString.call(value)).slice(0, 40);

// Look-alike letters that would get a never-offered name past the check: accents, full-width forms, a few Cyrillic/Greek
// letters and the dotless i / long s. Heuristic: the source's own code can list anything.
const CONFUSABLES = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ο': 'o', 'ι': 'i', 'ı': 'i', 'ſ': 's', 'ɩ': 'i', 'ӏ': 'l', 'ⅼ': 'l', 'ɡ': 'g' };
function foldForNeverListed(name) {
  const folded = name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\x20-\x7e]/g, (ch) => CONFUSABLES[ch] || ch);
  return folded;
}
function namesNeverListedCategory(name) {
  const folded = foldForNeverListed(name);
  // word starts, and the same with the separators taken out of the whole name ("sho-ta", "l o l i")
  return NEVER_LISTED_RE.test(folded) || /^(loli|shota|toddler)/.test(folded.replace(/[^a-z]/g, ''));
}

function cleanName(value, max = MAX_NAME_LENGTH) {
  if (typeof value !== 'string') return '';
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > 0 && text.length <= max && GENRE_NAME_RE.test(text) ? text : '';
}

function sanitizeFilters(raw, out, problems) {
  if (raw === undefined) return;
  if (!isPlainObject(raw)) { problems.push({ level: 'warning', message: 'ui.filters is not an object: ignored.' }); return; }
  const filters = {};
  for (const key of Object.keys(raw)) {
    if (!FILTER_KEYS.includes(key)) { problems.push({ level: 'warning', message: `ui.filters.${shown(key)} is not a known filter: ignored.` }); continue; }
    const value = raw[key];
    if (key === 'orderBy' && Array.isArray(value)) {
      const options = [];
      const seen = new Set();
      if (value.length > MAX_ORDER_OPTIONS) problems.push({ level: 'warning', message: `ui.filters.orderBy has more than ${MAX_ORDER_OPTIONS} options: the rest were dropped.` });
      for (const entry of value.slice(0, MAX_ORDER_OPTIONS)) {
        const optionValue = typeof entry === 'string' ? entry : (isPlainObject(entry) ? entry.value : undefined);
        if (typeof optionValue !== 'string' || !ORDER_VALUE_RE.test(optionValue)) {
          problems.push({ level: 'warning', message: `ui.filters.orderBy: "${shown(optionValue)}" is not a usable sort value (a simple word, optionally starting with "-"): dropped.` });
          continue;
        }
        if (seen.has(optionValue)) continue;
        const standard = Object.prototype.hasOwnProperty.call(ORDER_BY_LABELS, optionValue) ? ORDER_BY_LABELS[optionValue] : '';
        let label = standard;
        if (isPlainObject(entry) && entry.label !== undefined) {
          const wanted = typeof entry.label === 'string' ? entry.label.trim() : '';
          if (wanted && wanted.length <= MAX_NAME_LENGTH && LABEL_RE.test(wanted)) label = wanted;
          else problems.push({ level: 'warning', message: `ui.filters.orderBy: the label of "${optionValue}" is not valid text${standard ? ': the standard label is used' : ''}.` });
        }
        if (!label) {
          problems.push({ level: 'warning', message: `ui.filters.orderBy: "${optionValue}" is not one of the sort values the app labels (${Object.keys(ORDER_BY_LABELS).join(', ')}), so it needs a label: { value, label }. Dropped.` });
          continue;
        }
        seen.add(optionValue);
        options.push({ value: optionValue, label });
      }
      if (options.length > 0) { filters.orderBy = true; out.orderBy = options; }
      else { filters.orderBy = false; problems.push({ level: 'warning', message: 'ui.filters.orderBy has no usable value: treated as false.' }); }
      continue;
    }
    if (typeof value !== 'boolean') { problems.push({ level: 'warning', message: `ui.filters.${shown(key)} must be true or false: ignored.` }); continue; }
    filters[key] = value;
  }
  if (Object.keys(filters).length > 0) out.filters = filters;
}

function sanitizeGenres(raw, out, problems) {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) { problems.push({ level: 'warning', message: 'ui.genres is not a list: ignored.' }); return; }
  const genres = [];
  const seen = new Set();
  for (const entry of raw) {
    const name = cleanName(entry);
    if (!name) { problems.push({ level: 'warning', message: `ui.genres: "${shown(entry)}" is not a usable genre name (letters, digits and simple punctuation, up to ${MAX_NAME_LENGTH}): dropped.` }); continue; }
    if (namesNeverListedCategory(name)) { problems.push({ level: 'error', message: `ui.genres: "${name}" is a category that is never offered (it names sexualised minors): remove it from the declaration.` }); continue; }
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (genres.length >= MAX_GENRES) { problems.push({ level: 'warning', message: `ui.genres has more than ${MAX_GENRES} names: the rest were dropped.` }); break; }
    seen.add(key);
    genres.push(name);
  }
  if (genres.length > 0) out.genres = genres;
}

function sanitizeNsfwGenres(raw, out, problems) {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) { problems.push({ level: 'warning', message: 'ui.nsfwGenres is not a list: ignored.' }); return; }
  const known = new Map((out.genres || []).map((name) => [name.toLowerCase(), name]));
  const nsfw = [];
  for (const entry of raw) {
    const name = cleanName(entry);
    const match = name ? known.get(name.toLowerCase()) : undefined;
    if (!match) { problems.push({ level: 'warning', message: `ui.nsfwGenres: "${shown(entry)}" is not in ui.genres: dropped.` }); continue; }
    if (!nsfw.includes(match)) nsfw.push(match);
  }
  if (nsfw.length > 0) out.nsfwGenres = nsfw;
}

function sanitizeReferers(raw, out, problems, knownHosts) {
  if (raw === undefined) return;
  if (!Array.isArray(raw)) { problems.push({ level: 'warning', message: 'ui.imageReferers is not a list: ignored.' }); return; }
  const rules = [];
  for (const entry of raw.slice(0, MAX_REFERERS)) {
    const host = isPlainObject(entry) && typeof entry.host === 'string' ? entry.host.trim().toLowerCase() : '';
    if (!HOST_RE.test(host)) { problems.push({ level: 'warning', message: `ui.imageReferers: "${shown(isPlainObject(entry) ? entry.host : entry)}" is not a host name (example.com or *.example.com): dropped.` }); continue; }
    if (host.startsWith('*.') && SHARED_WILDCARD_BASES.has(host.slice(2))) {
      problems.push({ level: 'warning', message: `ui.imageReferers: "${host}" covers hosts of unrelated sites: name the host of this source's images instead. Dropped.` });
      continue;
    }
    let origin = '';
    try {
      const url = new URL(String(entry.referer));
      const plain = url.protocol === 'https:' && !url.username && !url.password && !url.port && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash;
      if (plain) origin = url.origin;
    } catch { /* not a URL */ }
    if (!origin) { problems.push({ level: 'warning', message: `ui.imageReferers: the referer of "${host}" must be a plain https origin (https://example.com): dropped.` }); continue; }
    // Narrow-only: a source may only ask for a Referer on a site its own code already names, so the image proxy cannot be
    // pointed at an unrelated site with a Referer of somebody else's.
    if (knownHosts && !knownHosts.has(new URL(origin).hostname.toLowerCase())) {
      problems.push({ level: 'warning', message: `ui.imageReferers: ${origin} is not a host the source's own code names: dropped.` });
      continue;
    }
    rules.push({ host, referer: origin });
  }
  if (raw.length > MAX_REFERERS) problems.push({ level: 'warning', message: `ui.imageReferers has more than ${MAX_REFERERS} rules: the rest were dropped.` });
  if (rules.length > 0) out.imageReferers = rules;
}

/**
 * Validates a raw `meta.ui`. Never throws and never runs anything.
 *
 * @param {unknown} raw  what the source declared (undefined = nothing declared)
 * @param {{ knownHosts?: Set<string> | null }} [options]  the hosts the source's code names (lower case); when given, a
 *        Referer rule must point at one of them
 * @returns {{ present: boolean, ui: object | null, problems: { level: 'error' | 'warning', message: string }[] }}
 *          `ui` holds only what was understood; an `error` problem means the declaration must not be installed as it is
 */
function sanitizeSourceUi(raw, options = {}) {
  try {
    return judgeSourceUi(raw, options);
  } catch (err) {
    // A value built to make a conversion throw (an object whose toString is not a function) must not become a 500.
    return { present: true, ui: null, problems: [{ level: 'error', message: 'meta.ui could not be read: ' + shown(String((err && err.message) || 'unreadable')) }] };
  }
}

function judgeSourceUi(raw, { knownHosts = null } = {}) {
  const problems = [];
  if (raw === undefined || raw === null) return { present: false, ui: null, problems };
  if (!isPlainObject(raw)) {
    problems.push({ level: 'error', message: 'meta.ui must be an object.' });
    return { present: true, ui: null, problems };
  }
  const out = {};
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.includes(key)) problems.push({ level: 'warning', message: `ui.${shown(key)} is not a known field: ignored.` });
  }
  sanitizeFilters(raw.filters, out, problems);
  sanitizeGenres(raw.genres, out, problems);
  sanitizeNsfwGenres(raw.nsfwGenres, out, problems);
  for (const flag of ['adultOnly', 'nativeDates', 'customTags']) {
    if (raw[flag] === undefined) continue;
    if (typeof raw[flag] !== 'boolean') problems.push({ level: 'warning', message: `ui.${flag} must be true or false: ignored.` });
    else if (raw[flag]) out[flag] = true;
  }
  sanitizeReferers(raw.imageReferers, out, problems, knownHosts);
  // A genre list is what makes the genre filter real; saying so twice is not required.
  if (out.genres && !(out.filters && out.filters.genres === false)) out.filters = { ...(out.filters || {}), genres: true };
  return { present: true, ui: Object.keys(out).length > 0 ? out : {}, problems: capProblems(problems) };
}

// Every error stays (one of them blocks the install); only the warnings are cut, with a line saying so.
function capProblems(problems) {
  const errors = problems.filter((p) => p.level === 'error');
  const warnings = problems.filter((p) => p.level !== 'error');
  if (warnings.length <= MAX_PROBLEMS) return problems;
  return [...errors, ...warnings.slice(0, MAX_PROBLEMS), { level: 'warning', message: `${warnings.length - MAX_PROBLEMS} more warnings not shown.` }];
}

// What the browser gets: everything except the server-side Referer rules.
function clientViewOfUi(ui) {
  if (!ui) return null;
  const { imageReferers: _imageReferers, ...rest } = ui;
  return rest;
}

// ── Registry: the declarations of the sources loaded in this process ───────────────────────────────────────────────
// Filled by the source loader whenever it loads a source file and emptied when a source is unloaded, so the places that
// only know a source id (the calendar, the image proxy) can ask without importing the loader.
const registry = new Map();

function registerSourceUi(id, ui) {
  if (ui && typeof ui === 'object') registry.set(String(id), ui);
  else registry.delete(String(id));
}
function unregisterSourceUi(id) { registry.delete(String(id)); }
function clearSourceUiRegistry() { registry.clear(); }
function getSourceUi(id) { return registry.get(String(id)) || null; }
function sourceHasNativeDates(id) { return getSourceUi(id)?.nativeDates === true; }

// The Referer a loaded source declared for an image host: an exact host rule beats a `*.` rule; '' when none.
function declaredRefererForHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return '';
  let wildcard = '';
  for (const ui of registry.values()) {
    for (const rule of ui.imageReferers || []) {
      if (rule.host === host) return rule.referer;
      if (!wildcard && rule.host.startsWith('*.') && host.endsWith(rule.host.slice(1))) wildcard = rule.referer;
    }
  }
  return wildcard;
}

// ── Reading the declaration out of the text WITHOUT running it (the Check step) ────────────────────────────────────
// The Check never runs a file, so it can only show a declaration that is written as a plain literal (objects, lists,
// strings, numbers, true/false/null, comments). Anything computed (a spread of a constant, a function call) is reported
// as "not readable before installing" and gets read, and validated again, after the file has been loaded.

function balancedObjectEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return -1;
      i = close + 1;
    } else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function parseLiteral(text) {
  let i = 0;
  const fail = (why) => { throw new Error(why); };
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
      else if (text[i] === '/' && text[i + 1] === '*') { const close = text.indexOf('*/', i + 2); if (close < 0) fail('unterminated comment'); i = close + 2; }
      else return;
    }
  };
  const string = () => {
    const quote = text[i++];
    let out = '';
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\\') {
        const next = text[i + 1];
        const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
        if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; continue; }
        if (next === 'x' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 2, i + 4))) { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16)); i += 4; continue; }
        out += Object.prototype.hasOwnProperty.call(simple, next) ? simple[next] : next;
        i += 2;
      } else if (text[i] === '\n') fail('newline in string');
      else out += text[i++];
    }
    if (text[i] !== quote) fail('unterminated string');
    i++;
    return out;
  };
  const value = () => {
    skip();
    const ch = text[i];
    if (ch === '{') return object();
    if (ch === '[') return list();
    if (ch === '"' || ch === "'") return string();
    const word = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?![\w$])/.exec(text.slice(i));
    if (!word) fail(`not a plain literal near "${text.slice(i, i + 20).replace(/\s+/g, ' ')}"`);
    i += word[0].length;
    return word[0] === 'true' ? true : word[0] === 'false' ? false : word[0] === 'null' ? null : Number(word[0]);
  };
  const key = () => {
    skip();
    if (text[i] === '"' || text[i] === "'") { const quoted = string(); if (quoted === '__proto__') fail('__proto__ is not a field'); return quoted; }
    const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(i));
    if (!word) fail('object key expected');
    i += word[0].length;
    if (word[0] === '__proto__') fail('__proto__ is not a field');
    return word[0];
  };
  const object = () => {
    const out = {};
    i++;
    for (;;) {
      skip();
      if (text[i] === '}') { i++; return out; }
      const name = key();
      skip();
      if (text[i] !== ':') fail('":" expected');
      i++;
      Object.defineProperty(out, name, { value: value(), enumerable: true, writable: true, configurable: true });
      skip();
      if (text[i] === ',') i++;
      else if (text[i] !== '}') fail('"," or "}" expected');
    }
  };
  const list = () => {
    const out = [];
    i++;
    for (;;) {
      skip();
      if (text[i] === ']') { i++; return out; }
      out.push(value());
      skip();
      if (text[i] === ',') i++;
      else if (text[i] !== ']') fail('"," or "]" expected');
    }
  };
  const result = value();
  skip();
  if (i < text.length) fail('unexpected text after the object');
  return result;
}

// ── Finding the declaration in the text, the way the runtime will see it ───────────────────────────────────────────
// Comments and strings are masked first (same length, so positions stay), so a `ui: {` in a comment or a string is
// not a declaration. Only a property of the meta object (or an assignment to meta.ui) counts, and a declaration that
// appears more than once is reported as ambiguous instead of guessing which one wins.
function lexicalMask(text, { keepStrings = false } = {}) {
  const out = text.split('');
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; };
  const startsRegex = (i) => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j < 0 || '(,=:[!&|?{};+-*%<>~^'.includes(text[j])) return true;
    // `return /x/`, `typeof /x/`, `case /x/`: a keyword before the slash also starts a regular expression
    return /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/.test(text.slice(Math.max(0, j - 12), j + 1));
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      let end = i; while (end < text.length && text[end] !== '\n') end++;
      blank(i, end); i = end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? text.length : close + 2;
      blank(i, end); i = end - 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      let end = i + 1;
      while (end < text.length && text[end] !== ch) { if (text[end] === '\\') end++; end++; }
      if (!keepStrings) blank(i + 1, end);
      i = end;
    } else if (ch === '/' && startsRegex(i)) {
      let end = i + 1, inClass = false;
      while (end < text.length && text[end] !== '\n') {
        if (text[end] === '\\') end++;
        else if (text[end] === '[') inClass = true;
        else if (text[end] === ']') inClass = false;
        else if (text[end] === '/' && !inClass) break;
        end++;
      }
      if (text[end] === '/') { if (!keepStrings) blank(i + 1, end); i = end; }
    }
  }
  return out.join('');
}

// The text with its comments blanked and its strings kept: what the file names as URLs, without the ones in comments.
function withoutComments(text) {
  return lexicalMask(String(text), { keepStrings: true });
}

// Property named `ui` at the top level of an object literal that starts at `open` (index of its `{`), in masked text.
function findTopLevelUi(masked, original, open) {
  const close = balancedObjectEnd(masked, open);
  if (close < 0) return { close: -1, hits: [] };
  const hits = [];
  let depth = 0;
  for (let i = open; i <= close; i++) {
    const ch = masked[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    else if (depth === 1 && (ch === 'u' || ch === '"' || ch === "'")) {
      const quoted = ch !== 'u';
      const name = quoted ? original.slice(i + 1, i + 3) : original.slice(i, i + 2);
      const afterName = i + (quoted ? 4 : 2);
      if (name === 'ui' && (!quoted || original[i + 3] === ch) && !/[\w$]/.test(masked[i - 1] || ' ') && (quoted || !/[\w$]/.test(masked[afterName] || ' '))) {
        let before = i - 1; while (before > open && /\s/.test(masked[before])) before--;
        let after = afterName; while (after < close && /\s/.test(masked[after])) after++;
        if ((masked[before] === '{' || masked[before] === ',') && masked[after] === ':') hits.push(after + 1);
      }
    }
  }
  return { close, hits };
}

/**
 * Looks for the declaration the way the runtime will see it: `ui:` among the properties of the meta object, or an
 * assignment to `meta.ui`. A declaration that is not a plain literal (a constant, a call, a conditional) is reported
 * as present but not readable; more than one is ambiguous.
 * @returns {{ found: boolean, readable: boolean, value?: unknown, reason?: string, range?: [number, number] }}
 */
function readDeclaredUiLiteral(text) {
  const original = String(text);
  const masked = lexicalMask(original);
  const values = []; // each: index just after the `:` / `=`

  const metaObject = /(?:\bexports\s*\.\s*meta\s*=|\bmeta\s*:|(?:^|[\s;])meta\s*=)\s*(?=\{)/g;
  for (const match of masked.matchAll(metaObject)) {
    const open = match.index + match[0].length;
    values.push(...findTopLevelUi(masked, original, open).hits);
  }
  for (const match of masked.matchAll(/\bmeta\s*(?:\.\s*ui|\[\s*(?:'[^']*'|"[^"]*")\s*\])\s*=(?!=)/g)) {
    if (/\bmeta\s*\[/.test(match[0]) && !/\bui\b/.test(original.slice(match.index, match.index + match[0].length))) continue;
    values.push(match.index + match[0].length);
  }
  if (values.length === 0) return { found: false, readable: false };
  if (values.length > 1) return { found: true, readable: false, reason: 'meta.ui is declared more than once' };

  let start = values[0];
  while (start < masked.length && /\s/.test(masked[start])) start++;
  if (masked[start] !== '{') return { found: true, readable: false, reason: 'it is not an object literal' };
  const end = balancedObjectEnd(masked, start);
  if (end < 0) return { found: true, readable: false, reason: 'the object is not closed' };
  // `range` is where the literal sits in the text, so a caller can look at the file without the declaration itself.
  const range = [start, end + 1];
  try {
    return { found: true, readable: true, value: parseLiteral(original.slice(start, end + 1)), range };
  } catch (err) {
    return { found: true, readable: false, reason: String((err && err.message) || err).slice(0, 120), range };
  }
}

module.exports = {
  ORDER_BY_LABELS,
  NEVER_LISTED_RE,
  namesNeverListedCategory,
  sanitizeSourceUi,
  clientViewOfUi,
  registerSourceUi,
  unregisterSourceUi,
  clearSourceUiRegistry,
  getSourceUi,
  sourceHasNativeDates,
  declaredRefererForHost,
  readDeclaredUiLiteral,
  withoutComments,
};
