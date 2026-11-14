'use strict';

// Parity between the hand-written per-source tables (ui-advanced-search.js, calendar/service.js) and what a source can
// say about itself in meta.ui: whatever the tables say about a source today, a declaration can say too. Each table
// entry is turned into a declaration and run through the real sanitiser; nothing may be lost except a name that is
// never offered (those tables still list a few, see the last test).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ui = require('../../server/modules/common/source-ui');

const ROOT = path.join(__dirname, '..', '..');
const noop = () => {};
const el = new Proxy(function () {}, { get: () => el, apply: () => el, construct: () => el, set: () => true });

// The real front-end file run with browser stand-ins; what it needs and does not have is stubbed one name at a time.
function loadTables() {
  const source = fs.readFileSync(path.join(ROOT, 'public', 'modules', 'ui-advanced-search.js'), 'utf8');
  const stubs = {};
  for (let attempt = 0; attempt < 40; attempt++) {
    const context = {
      console, document: el, window: el, localStorage: { getItem: () => null, setItem: noop }, navigator: {}, location: { href: '' },
      state: { installedSources: {}, settings: {} }, setTimeout: noop, setInterval: noop, requestAnimationFrame: noop,
      $: () => el, escapeHtml: (s) => s, t: (k) => k, tr: (k, d) => d, api: noop, showToast: noop, fetch: noop, ...stubs,
    };
    vm.createContext(context);
    try {
      vm.runInContext(source, context, { filename: 'ui-advanced-search.js' });
    } catch (err) {
      const missing = /^(\w+) is not defined/.exec(String(err.message));
      if (missing && !(missing[1] in stubs)) { stubs[missing[1]] = el; continue; }
      assert.fail(`ui-advanced-search.js stopped before its tables: ${err.message}`);
    }
    const get = (name) => vm.runInContext(name, context);
    return { caps: get('ADV_SOURCE_CAPABILITIES'), genres: get('PER_SOURCE_GENRES'), order: get('CUSTOM_ORDER_BY_OPTIONS') };
  }
  return assert.fail('too many missing names');
}

function nativeDateSources() {
  const text = fs.readFileSync(path.join(ROOT, 'server', 'modules', 'calendar', 'service.js'), 'utf8');
  const list = /NATIVE_DATE_SOURCES = new Set\(\[([^\]]*)\]/.exec(text);
  assert.ok(list, 'the calendar list is where it was');
  return new Set((list[1].match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)));
}

const tables = loadTables();
const native = nativeDateSources();
const ids = [...new Set([...Object.keys(tables.caps), ...Object.keys(tables.genres), ...Object.keys(tables.order), ...native])].filter((id) => id !== 'default').sort();

function declarationFor(id) {
  const caps = tables.caps[id];
  const genres = tables.genres[id];
  const order = tables.order[id];
  const declaration = {};
  if (caps || order) declaration.filters = { ...(caps || {}) };
  if (order) declaration.filters.orderBy = order.map((option) => ({ value: option.value, label: option.label }));
  if (genres) { declaration.genres = [...genres.genres]; declaration.nsfwGenres = [...genres.nsfw]; }
  if (native.has(id)) declaration.nativeDates = true;
  return declaration;
}

test('the tables are found and cover the sources the project has', () => {
  assert.ok(ids.length >= 15, `only ${ids.length} sources found in the tables`);
  for (const id of ['mangadex', 'weebcentral']) assert.ok(ids.includes(id), `${id} is in the tables`);
  assert.deepEqual([...new Set(Object.values(tables.caps).flatMap((entry) => Object.keys(entry)))].sort(), ['contentRating', 'format', 'genres', 'orderBy', 'publicationStatus'],
    'a new capability key in the tables would need a field in meta.ui');
});

test('every filter, sort option, genre and adult flag a table holds survives as a declaration (apart from never-offered names)', () => {
  const problemsFound = [];
  for (const id of ids) {
    const declaration = declarationFor(id);
    const verdict = ui.sanitizeSourceUi(declaration);
    const out = verdict.ui || {};
    const caps = tables.caps[id];
    const genres = tables.genres[id];
    const order = tables.order[id];
    if (caps) for (const key of Object.keys(caps)) {
      if (key === 'orderBy' && order) continue;
      if (!out.filters || out.filters[key] !== caps[key]) problemsFound.push(`${id}: capability ${key} changed`);
    }
    if (order && JSON.stringify(out.orderBy) !== JSON.stringify(order.map((o) => ({ value: o.value, label: o.label })))) problemsFound.push(`${id}: sort options changed`);
    if (order && !(out.filters && out.filters.orderBy === true)) problemsFound.push(`${id}: sort filter lost`);
    if (genres) {
      const kept = new Set(out.genres || []);
      const lost = genres.genres.filter((name) => !kept.has(name));
      const unexpected = lost.filter((name) => !verdict.problems.some((p) => p.level === 'error' && p.message.includes(`"${name}"`)));
      if (unexpected.length) problemsFound.push(`${id}: genres lost without being a never-offered name: ${unexpected.join(', ')}`);
      const adultKept = new Set(out.nsfwGenres || []);
      const adultLost = [...genres.nsfw].filter((name) => kept.has(name) && !adultKept.has(name));
      if (adultLost.length) problemsFound.push(`${id}: adult flags lost: ${adultLost.join(', ')}`);
    }
    if (native.has(id) && !out.nativeDates) problemsFound.push(`${id}: native dates lost`);
    // A never-offered name that was dropped from the genre list is also dropped from its adult list: that is the same loss.
    const droppedNames = verdict.problems.filter((p) => p.level === 'error').map((p) => /"([^"]+)"/.exec(p.message)[1]);
    const otherWarnings = verdict.problems.filter((p) => p.level === 'warning' && !droppedNames.some((name) => p.message.includes(`"${name}"`)));
    if (otherWarnings.length) problemsFound.push(`${id}: ${otherWarnings.map((p) => p.message).join(' | ')}`);
  }
  assert.deepEqual(problemsFound, []);
});

test('a declaration made from the tables gives the browser the same answers as the tables do', () => {
  // The browser's lookups (getSourceGenreConfig etc.) are exercised in source-ui-integration.test.js; here the data they
  // would read out of /api/state is compared with what the tables hold, source by source.
  for (const id of ids) {
    const out = ui.sanitizeSourceUi(declarationFor(id)).ui || {};
    const genres = tables.genres[id];
    if (genres) {
      const offered = (out.genres || []).length;
      assert.ok(offered >= genres.genres.length - 4, `${id}: the declared genre list is the table's, bar a few never-offered names`);
    }
    const order = tables.order[id];
    // (the tables come from another realm: compared as text, not by prototype)
    if (order) assert.equal(JSON.stringify((out.orderBy || []).map((o) => o.value)), JSON.stringify(Array.from(order, (o) => o.value)), `${id}: the same sort values in the same order`);
  }
});

test('the hand-written genre tables still offer names the rule says are never offered (known, for the owner to decide)', () => {
  const offered = {};
  for (const id of ids) {
    const genres = tables.genres[id];
    if (!genres) continue;
    const names = genres.genres.filter((name) => /(^|[^a-z])(loli|shota|toddler)/i.test(name));
    if (names.length) offered[id] = names.sort();
  }
  // Documents today's state so a change is noticed either way; remove an entry when its table is cleaned.
  assert.deepEqual(Object.keys(offered).sort(), ['allmanga', 'kingofshojo', 'mangadex', 'mangahub', 'weebcentral']);
});
