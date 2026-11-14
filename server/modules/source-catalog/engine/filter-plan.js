'use strict';

// What a source that runs through the person's own Suwayomi-Server can offer in the Advanced Search: the genres, the status and the sort the
// EXTENSION itself has. The Suwayomi-Server lists the filters of an extension (GET /api/v1/source/<id>/filters) and accepts a search with
// filter changes (POST .../quick-search); the written source cannot ask the server what the filters are at run time (its declaration, meta.ui, is
// read when the file is installed), so this reads them once, when the source is written, and keeps a small PLAN: which position of the filter
// list is the genre list, which is the status, which is the sort, and what each choice is.
//
// The list comes from a third-party extension through a server: every name is cut to plain text and every number is checked before it is kept,
// and the plan enters the written file as a JSON literal (engine/index.js), never as code. Only the common shapes are understood (a group of
// check boxes for the genres, a select or a sort for the order, a select or a group for the status); anything else is left out, and a source
// with nothing recognised simply has no filters, as before.

const MAX_GENRES = 200;
const MAX_ORDER_OPTIONS = 12;
const MAX_POSITION = 500;
const NAME_MAX = 40;

// Same shapes the app's own validation of meta.ui accepts (server/modules/common/source-ui.js), so what is declared here is never dropped there.
const GENRE_NAME_RE = /^[\p{L}\p{N}+][\p{L}\p{N} &'’.+\-/()!:,]*$/u;
const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N} &'’.+\-/()!:,]*$/u;
// Categories about sexualised minors are never offered: the start of any word of a name.
const NEVER_LISTED_RE = /(^|[^a-z])(loli|shota|toddler)/i;

// Control, separator and bidi characters (built from code points, never typed).
const UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]];
const UNSAFE_CHARS = new RegExp(`[${UNSAFE_RANGES.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`, 'g');
const OUTSIDE_NAME = /[^\p{L}\p{N} &'’.+\-/()!:,]/gu;

const GENRE_GROUP_RE = /genre|tag|categor|theme/i;
const GENRE_SELECT_RE = /genre|categor/i;
const STATUS_RE = /status/i;
const TAGS_RE = /^tags?$/i;
const SORT_RE = /sort|order/i;
const ALL_RE = /^(all|any|none|every|default)\b/i;
// The status words of the app, and what an extension calls them.
const STATUS_WORDS = Object.freeze([
  ['ongoing', /ongoing|publishing|releasing|updating|serializ/i],
  ['completed', /complet|finish|ended|end$/i],
  ['hiatus', /hiatus|paused/i],
  ['cancelled', /cancel|dropped|discontinu/i],
]);
// Sorts that mean "A to Z" are asked ascending; every other sort is asked the way a reader expects a list of titles (newest, most).
const ASCENDING_RE = /a-z|alphabet|\bname\b|\btitle\b/i;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const position = (value) => (Number.isInteger(value) && value >= 0 && value <= MAX_POSITION ? value : -1);

/** A name as plain text in the shapes above, or '' when nothing usable is left. */
function cleanName(value, re) {
  const text = String(value === undefined || value === null ? '' : value).replace(UNSAFE_CHARS, ' ').replace(OUTSIDE_NAME, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
  return text && re.test(text) ? text : '';
}

const nameOf = (entry) => (isObject(entry) && isObject(entry.filter) && typeof entry.filter.name === 'string' ? entry.filter.name : '');
const typeOf = (entry) => (isObject(entry) && typeof entry.type === 'string' ? entry.type : '');
const valuesOf = (entry) => (isObject(entry) && isObject(entry.filter) && Array.isArray(entry.filter.values) ? entry.filter.values : []);
const itemsOf = (entry) => (isObject(entry) && isObject(entry.filter) && Array.isArray(entry.filter.state) ? entry.filter.state : []);

function genresOf(list) {
  // A group of check boxes or three-state boxes named like a genre list: the usual shape.
  for (let at = 0; at < list.length; at += 1) {
    const entry = list[at];
    if (typeOf(entry) !== 'Group' || !GENRE_GROUP_RE.test(nameOf(entry))) continue;
    const kinds = new Set();
    const seen = new Set();
    const items = [];
    itemsOf(entry).forEach((item, index) => {
      const kind = typeOf(item) === 'TriState' ? 'tristate' : (typeOf(item) === 'CheckBox' ? 'checkbox' : '');
      const name = kind ? cleanName(nameOf(item), GENRE_NAME_RE) : '';
      if (!name || NEVER_LISTED_RE.test(name) || seen.has(name.toLowerCase()) || items.length >= MAX_GENRES || index > MAX_POSITION) return;
      seen.add(name.toLowerCase());
      kinds.add(kind);
      items.push({ name, index });
    });
    if (items.length >= 2 && kinds.size === 1) return { position: position(at), group: true, kind: [...kinds][0], items };
  }
  // A select named like a genre: one genre at a time (the first value is usually "All").
  for (let at = 0; at < list.length; at += 1) {
    const entry = list[at];
    if (typeOf(entry) !== 'Select' || !GENRE_SELECT_RE.test(nameOf(entry))) continue;
    const seen = new Set();
    const items = [];
    valuesOf(entry).forEach((value, index) => {
      if (typeof value !== 'string' || ALL_RE.test(value.trim())) return;
      const name = cleanName(value, GENRE_NAME_RE);
      if (!name || NEVER_LISTED_RE.test(name) || seen.has(name.toLowerCase()) || items.length >= MAX_GENRES || index > MAX_POSITION) return;
      seen.add(name.toLowerCase());
      items.push({ name, index });
    });
    if (items.length >= 3) return { position: position(at), group: false, kind: 'select', items };
  }
  return null;
}

// A free-text box named "Tags": the person can type a tag of their own (the extension reads it as a list of words). It is only offered next to a genre
// list, which is where the app has the box to type in.
function tagsOf(list) {
  for (let at = 0; at < list.length; at += 1) {
    if (typeOf(list[at]) === 'Text' && TAGS_RE.test(nameOf(list[at]).trim())) return { position: position(at) };
  }
  return null;
}

const statusOfLabel = (label) => {
  const found = STATUS_WORDS.find(([, re]) => re.test(label));
  return found ? found[0] : '';
};

function statusOf(list) {
  for (let at = 0; at < list.length; at += 1) {
    const entry = list[at];
    if (!STATUS_RE.test(nameOf(entry))) continue;
    const map = {};
    if (typeOf(entry) === 'Select') {
      valuesOf(entry).forEach((value, index) => {
        const word = typeof value === 'string' ? statusOfLabel(value) : '';
        if (word && map[word] === undefined && index <= MAX_POSITION) map[word] = index;
      });
      if (Object.keys(map).length >= 2) return { position: position(at), group: false, kind: 'select', map };
    } else if (typeOf(entry) === 'Group') {
      const kinds = new Set();
      itemsOf(entry).forEach((item, index) => {
        const kind = typeOf(item) === 'TriState' ? 'tristate' : (typeOf(item) === 'CheckBox' ? 'checkbox' : '');
        const word = kind ? statusOfLabel(nameOf(item)) : '';
        if (word && map[word] === undefined && index <= MAX_POSITION) { map[word] = index; kinds.add(kind); }
      });
      if (Object.keys(map).length >= 2 && kinds.size === 1) return { position: position(at), group: true, kind: [...kinds][0], map };
    }
  }
  return null;
}

function sortOf(list) {
  const entries = [];
  list.forEach((entry, at) => { if (typeOf(entry) === 'Sort' || (typeOf(entry) === 'Select' && SORT_RE.test(nameOf(entry)))) entries.push([entry, at]); });
  // A real sort filter first, a select named like one second.
  entries.sort((a, b) => (typeOf(a[0]) === 'Sort' ? 0 : 1) - (typeOf(b[0]) === 'Sort' ? 0 : 1));
  for (const [entry, at] of entries) {
    const kind = typeOf(entry) === 'Sort' ? 'sort' : 'select';
    const options = [];
    const labels = new Set();
    valuesOf(entry).forEach((value, index) => {
      const label = typeof value === 'string' ? cleanName(value, LABEL_RE) : '';
      if (!label || labels.has(label.toLowerCase()) || options.length >= MAX_ORDER_OPTIONS || index > MAX_POSITION) return;
      labels.add(label.toLowerCase());
      options.push({ value: `o${index}`, label, index, ascending: kind === 'sort' && ASCENDING_RE.test(label) });
    });
    if (options.length >= 2) return { position: position(at), kind, options };
  }
  return null;
}

/**
 * @param {unknown} raw   what GET /api/v1/source/<id>/filters answered
 * @returns {{ genres: object|null, status: object|null, sort: object|null, tags: object|null }}   what the extension's filters offer, in the shapes this app can use
 */
function planFilters(raw) {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_POSITION + 1) : [];
  const genres = genresOf(list);
  return { genres, status: statusOf(list), sort: sortOf(list), tags: genres ? tagsOf(list) : null };
}

const isEmpty = (plan) => !plan || (!plan.genres && !plan.status && !plan.sort);

/**
 * The same plan, rebuilt from scratch with every limit applied again: what the written file is made from is never taken on trust, even from
 * the code above (a plan that came from somewhere else, or was edited, cannot put anything but plain names and small numbers in the file).
 * @param {unknown} plan
 */
function normalizePlan(plan) {
  const p = isObject(plan) ? plan : {};
  const out = { genres: null, status: null, sort: null, tags: null };
  const g = isObject(p.genres) ? p.genres : null;
  if (g && position(g.position) >= 0 && ['checkbox', 'tristate', 'select'].includes(g.kind) && Array.isArray(g.items)) {
    const seen = new Set();
    const items = [];
    for (const item of g.items.slice(0, MAX_GENRES)) {
      const name = isObject(item) ? cleanName(item.name, GENRE_NAME_RE) : '';
      const index = isObject(item) ? position(item.index) : -1;
      if (!name || index < 0 || NEVER_LISTED_RE.test(name) || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      items.push({ name, index });
    }
    if (items.length) out.genres = { position: position(g.position), group: g.kind !== 'select' && g.group === true, kind: g.kind, items };
  }
  if (out.genres && isObject(p.tags) && position(p.tags.position) >= 0) out.tags = { position: position(p.tags.position) };
  const s = isObject(p.status) ? p.status : null;
  if (s && position(s.position) >= 0 && ['checkbox', 'tristate', 'select'].includes(s.kind) && isObject(s.map)) {
    const map = {};
    for (const [word] of STATUS_WORDS) if (position(s.map[word]) >= 0) map[word] = s.map[word];
    if (Object.keys(map).length) out.status = { position: position(s.position), group: s.kind !== 'select' && s.group === true, kind: s.kind, map };
  }
  const o = isObject(p.sort) ? p.sort : null;
  if (o && position(o.position) >= 0 && ['sort', 'select'].includes(o.kind) && Array.isArray(o.options)) {
    const labels = new Set();
    const options = [];
    for (const option of o.options.slice(0, MAX_ORDER_OPTIONS)) {
      const label = isObject(option) ? cleanName(option.label, LABEL_RE) : '';
      const index = isObject(option) ? position(option.index) : -1;
      if (!label || index < 0 || labels.has(label.toLowerCase())) continue;
      labels.add(label.toLowerCase());
      options.push({ value: `o${index}`, label, index, ascending: o.kind === 'sort' && option.ascending === true });
    }
    if (options.length >= 2) out.sort = { position: position(o.position), kind: o.kind, options };
  }
  return out;
}

module.exports = { planFilters, normalizePlan, isEmpty, STATUS_WORDS, MAX_GENRES, MAX_ORDER_OPTIONS };
