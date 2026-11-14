'use strict';

// The filters of an extension (genres, status, sort) in the Advanced Search of a source that runs through the person's Suwayomi-Server:
// reading the server's list of filters into a plan (engine/filter-plan.js), writing the source from it, and what the written source sends to
// the server's search with filters. The list comes from a third-party extension, so what matters is that only plain names and small numbers
// get into the file, that a category that is never listed is never offered, and that a request is only ever made for a choice the plan has.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { planFilters, normalizePlan, isEmpty } = require('../../server/modules/source-catalog/engine/filter-plan');
const { buildEngineSource } = require('../../server/modules/source-catalog/engine');
const { checkSourceContract } = require('../../server/modules/source-import/contract');
const { analyzeSourceCode } = require('../../server/modules/source-import/static-report');
const { sanitizeSourceUi } = require('../../server/modules/common/source-ui');

const SOURCE_ID = '6289731484943315811';

const check = (name, state = false) => ({ type: 'CheckBox', filter: { name, state } });
const tri = (name, state = 0) => ({ type: 'TriState', filter: { name, state } });
const group = (name, items) => ({ type: 'Group', filter: { name, state: items } });
const select = (name, values, state = 0) => ({ type: 'Select', filter: { name, values, state } });
const sort = (name, values) => ({ type: 'Sort', filter: { name, values, state: null } });
const header = (name) => ({ type: 'Header', filter: { name, state: 0 } });

// A list shaped like a real extension's: a header, a sort, a status, a genre group.
const REAL = () => [
  header('Filters apply to the search'),
  sort('Sort by', ['Popularity', 'Latest update', 'Title A-Z', 'Rating']),
  select('Status', ['All', 'Ongoing', 'Completed', 'On Hiatus', 'Cancelled']),
  group('Genres', [tri('Action'), tri('Comedy'), tri('Loli'), tri('Shota Contact'), tri('Action'), tri('Drama')]),
];

// ── the plan ─────────────────────────────────────────────────────────────

test('a usual list gives the genres (without the never-listed ones and repeats), the status and the sort, with the positions the server gave', () => {
  const plan = planFilters(REAL());
  assert.deepEqual(plan.genres, { position: 3, group: true, kind: 'tristate', items: [{ name: 'Action', index: 0 }, { name: 'Comedy', index: 1 }, { name: 'Drama', index: 5 }] });
  assert.deepEqual(plan.status, { position: 2, group: false, kind: 'select', map: { ongoing: 1, completed: 2, hiatus: 3, cancelled: 4 } });
  assert.equal(plan.sort.position, 1);
  assert.equal(plan.sort.kind, 'sort');
  assert.deepEqual(plan.sort.options.map((o) => [o.value, o.label, o.index, o.ascending]), [['o0', 'Popularity', 0, false], ['o1', 'Latest update', 1, false], ['o2', 'Title A-Z', 2, true], ['o3', 'Rating', 3, false]]);
});

test('the other usual shapes: genres and status as boxes, the genres as a select, the sort as a select; and what is not understood is left out', () => {
  const boxes = planFilters([group('Tags', [check('Romance'), check('Isekai')]), group('Status', [check('Releasing'), check('Finished')])]);
  assert.deepEqual(boxes.genres, { position: 0, group: true, kind: 'checkbox', items: [{ name: 'Romance', index: 0 }, { name: 'Isekai', index: 1 }] });
  assert.deepEqual(boxes.status, { position: 1, group: true, kind: 'checkbox', map: { ongoing: 0, completed: 1 } });
  const selects = planFilters([select('Genre', ['All', 'Action', 'Drama', 'Horror']), select('Order by', ['Newest', 'Oldest'])]);
  assert.deepEqual(selects.genres, { position: 0, group: false, kind: 'select', items: [{ name: 'Action', index: 1 }, { name: 'Drama', index: 2 }, { name: 'Horror', index: 3 }] });
  assert.equal(selects.sort.kind, 'select');
  assert.equal(selects.sort.options[1].ascending, false);
  // A mixed group, a text box, a status with one known word, a sort with one option: nothing to offer.
  const nothing = planFilters([group('Genres', [check('A'), tri('B')]), { type: 'Text', filter: { name: 'Author', state: '' } }, select('Status', ['All', 'Ongoing']), sort('Sort', ['Only'])]);
  assert.equal(isEmpty(nothing), true);
  for (const junk of [null, undefined, 'x', 5, {}, [null, 5, 'x', {}], [{ type: 'Group', filter: null }]]) assert.equal(isEmpty(planFilters(junk)), true, JSON.stringify(junk));
});

test('names are cut to plain text and capped: markup, control characters, long names and too many genres', () => {
  const evil = planFilters([group('Genres', [tri('<img src=x onerror=PWN(1)>'), tri('Good Genre'), tri('x'.repeat(100)), tri('"; process.exit(1); "'), tri('Fine'), tri('')])]);
  const names = evil.genres.items.map((i) => i.name);
  assert.ok(names.every((n) => /^[\p{L}\p{N}+][\p{L}\p{N} &'’.+\-/()!:,]*$/u.test(n) && n.length <= 40), names.join('|'));
  assert.ok(names.includes('Good Genre') && names.includes('Fine'));
  const many = planFilters([group('Genres', Array.from({ length: 400 }, (_, i) => tri(`Genre ${i}`)))]);
  assert.equal(many.genres.items.length, 200);
  const sorts = planFilters([sort('Sort', Array.from({ length: 40 }, (_, i) => `Option ${i}`))]);
  assert.equal(sorts.sort.options.length, 12);
});

test('normalizePlan rebuilds a plan from scratch: a hostile or damaged one keeps only plain names and small whole numbers', () => {
  const hostile = {
    genres: { position: 3, group: true, kind: 'tristate', items: [{ name: 'Action', index: 0 }, { name: '<b>x</b>', index: 1 }, { name: 'Loli', index: 2 }, { name: 'Ok', index: -4 }, { name: 'Ok', index: 1.5 }, { name: 'Fine', index: 9999 }, { name: 'Real', index: 7 }, null, 'x'] },
    status: { position: 2, kind: 'select', map: { ongoing: 1, completed: '2', hiatus: 99999, cancelled: -1, evil: 3 } },
    sort: { position: 1, kind: 'sort', options: [{ label: 'Latest', index: 0, ascending: 'yes' }, { label: 'Latest', index: 1 }, { label: '<x>', index: 2 }, { label: 'Title', index: 3, ascending: true }] },
    extra: 'ignored',
  };
  const plan = normalizePlan(hostile);
  assert.deepEqual(plan.genres.items, [{ name: 'Action', index: 0 }, { name: 'b x /b', index: 1 }, { name: 'Real', index: 7 }]);
  assert.deepEqual(plan.status, { position: 2, group: false, kind: 'select', map: { ongoing: 1 } });
  assert.deepEqual(plan.sort.options.map((o) => [o.value, o.label, o.ascending]), [['o0', 'Latest', false], ['o2', 'x', false], ['o3', 'Title', true]]);
  assert.ok(!('extra' in plan));
  for (const junk of [null, undefined, 'x', 5, [], { genres: 'x', status: [], sort: 7 }]) assert.deepEqual(normalizePlan(junk), { genres: null, status: null, sort: null, tags: null });
  assert.deepEqual(normalizePlan(planFilters(REAL())), planFilters(REAL()), 'a plan that came from planFilters is kept as it is');
});

// ── the written file ─────────────────────────────────────────────────────

const build = (filterPlan) => buildEngineSource({ sourceId: SOURCE_ID, name: 'Alpha Scans', supportsLatest: true, isNsfw: false, date: '2026-11-10', filterPlan });
const tmp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-filters-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const load = (t, built) => { const file = path.join(tmp(t), `${built.id}-${Math.random().toString(16).slice(2)}.js`); fs.writeFileSync(file, built.code); return require(file); };

test('the written file declares what the extension has, in the shapes the app accepts, and still raises no warning in the Check', (t) => {
  const built = build(planFilters(REAL()));
  assert.deepEqual(built.filters, { genres: true, status: true, sort: true, tags: false });
  const mod = load(t, built);
  assert.deepEqual(mod.meta.ui.filters.orderBy, [{ value: 'o0', label: 'Popularity' }, { value: 'o1', label: 'Latest update' }, { value: 'o2', label: 'Title A-Z' }, { value: 'o3', label: 'Rating' }]);
  assert.equal(mod.meta.ui.filters.publicationStatus, true);
  assert.equal(mod.meta.ui.filters.genres, true);
  assert.deepEqual(mod.meta.ui.genres, ['Action', 'Comedy', 'Drama']);
  const ui = sanitizeSourceUi(mod.meta.ui);
  assert.deepEqual(ui.problems, [], 'the app drops nothing of what is declared');
  assert.deepEqual(checkSourceContract(mod, built.id).errors, []);
  assert.deepEqual(analyzeSourceCode(built.code).risks, []);
  assert.equal(typeof mod.byGenres, 'function');
});

test('with nothing to offer the file is as it was: no filters declared, and the same shape for the same input', (t) => {
  const none = build(undefined);
  assert.deepEqual(none.filters, { genres: false, status: false, sort: false, tags: false });
  const mod = load(t, none);
  assert.deepEqual(mod.meta.ui.filters, { orderBy: false, publicationStatus: false, contentRating: false, format: false, genres: false });
  assert.deepEqual(mod.meta.ui.genres, []);
  assert.equal(build(planFilters(REAL())).code, build(planFilters(REAL())).code);
  assert.equal(none.code.includes('__'), false);
});

test('a hostile plan cannot put code in the file: the names are plain text in a literal', (t) => {
  const plan = { genres: { position: 1, group: true, kind: 'checkbox', items: [{ name: '"); process.exit(1); ("', index: 0 }, { name: 'Real', index: 1 }] }, status: null, sort: null };
  const built = build(plan);
  assert.ok(!built.code.includes('process.exit'));
  assert.deepEqual(analyzeSourceCode(built.code).risks, []);
  const mod = load(t, built);
  assert.ok(mod.meta.ui.genres.every((name) => /^[\p{L}\p{N} ]+$/u.test(name)));
});

// ── what the written file asks of the server ─────────────────────────────

async function rig(t, filterPlan) {
  const requests = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ mangaList: [{ id: 1, sourceId: SOURCE_ID, title: 'T', genre: [], status: 'ONGOING', realUrl: 'https://alpha.example/m/1' }], hasNextPage: false }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  globalThis.ScrollScapeHost = Object.freeze({ readSettings: async () => ({ suwayomiUrl: `http://127.0.0.1:${server.address().port}`, suwayomiUsername: '', suwayomiPassword: '' }) });
  t.after(() => { delete globalThis.ScrollScapeHost; });
  return { mod: load(t, build(filterPlan)), requests };
}

test('a sort and a status go to the server\'s search with filters, as the changes it understands; no choice is the plain list', async (t) => {
  const { mod, requests } = await rig(t, planFilters(REAL()));
  await mod.search('', 1);
  assert.equal(requests.pop().url, `/api/v1/source/${SOURCE_ID}/popular/1`, 'nothing chosen: the usual list');
  await mod.search('', 1, 'relevance', { publicationStatus: '' });
  assert.equal(requests.pop().url, `/api/v1/source/${SOURCE_ID}/popular/1`, 'a sort the extension does not have is not asked for');
  await mod.search('', 2, 'o2', { publicationStatus: 'completed' });
  const sent = requests.pop();
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, `/api/v1/source/${SOURCE_ID}/quick-search?pageNum=2`);
  assert.deepEqual(sent.body, { searchTerm: '', filter: [{ position: 1, state: JSON.stringify({ index: 2, ascending: true }) }, { position: 2, state: '2' }] });
  await mod.search('word', 1, '', { publicationStatus: 'ongoing' });
  assert.deepEqual(requests.pop().body, { searchTerm: 'word', filter: [{ position: 2, state: '1' }] });
  await mod.search('word', 1);
  assert.equal(requests.pop().url, `/api/v1/source/${SOURCE_ID}/search?searchTerm=word&pageNum=1`, 'a word alone is the plain search');
});

test('genres: each one the extension has becomes a change of its group; one it has not, or a category that is never listed, asks nothing', async (t) => {
  const { mod, requests } = await rig(t, planFilters(REAL()));
  const out = await mod.byGenres(['Comedy', 'drama'], 'o1', { publicationStatus: 'hiatus' }, 1);
  assert.equal(out.results.length, 1);
  assert.deepEqual(out.results[0].genres, ['Comedy', 'Drama'], 'the titles are tagged with the genres asked for, which the app needs to keep them');
  const sent = requests.pop();
  assert.equal(sent.url, `/api/v1/source/${SOURCE_ID}/quick-search?pageNum=1`);
  assert.deepEqual(sent.body, {
    searchTerm: '',
    filter: [
      { position: 1, state: JSON.stringify({ index: 1, ascending: false }) },
      { position: 2, state: '3' },
      { position: 3, state: JSON.stringify({ position: 1, state: '1' }) },
      { position: 3, state: JSON.stringify({ position: 5, state: '1' }) },
    ],
  });
  const before = requests.length;
  assert.deepEqual(await mod.byGenres(['Western']), { results: [], hasNextPage: false });
  assert.deepEqual(await mod.byGenres(['Action', 'Loli']), { results: [], hasNextPage: false });
  assert.deepEqual(await mod.byGenres(['Shotacon']), { results: [], hasNextPage: false });
  assert.deepEqual(await mod.byGenres([]), { results: [], hasNextPage: false });
  assert.equal(requests.length, before, 'none of those asked the server anything');
  const { mod: bare, requests: bareRequests } = await rig(t, undefined);
  assert.deepEqual(await bare.byGenres(['Action']), { results: [], hasNextPage: false }, 'a source with no genres has none to give');
  assert.equal(bareRequests.length, 0);
});

test('the genre as a select and the status as boxes are written the way the server reads them; a select takes one genre', async (t) => {
  const plan = planFilters([select('Genre', ['All', 'Action', 'Drama', 'Horror']), group('Status', [check('Releasing'), check('Finished')])]);
  const { mod, requests } = await rig(t, plan);
  const tagged = await mod.byGenres(['Drama', 'Horror'], '', { publicationStatus: 'completed' }, 1);
  assert.deepEqual(tagged.results[0].genres, ['Drama'], 'a select takes one genre, so the titles are tagged with that one only');
  assert.deepEqual(requests.pop().body, { searchTerm: '', filter: [{ position: 1, state: JSON.stringify({ position: 1, state: 'true' }) }, { position: 0, state: '2' }] });
});

// ── tags the person types ────────────────────────────────────────────────

// Like a real list that has a genre group and a free-text box named Tags.
const WITH_TAGS = () => [...REAL(), { type: 'Header', filter: { name: 'Separate tags with commas', state: 0 } }, { type: 'Text', filter: { name: 'Tags', state: '' } }, { type: 'Text', filter: { name: 'Uploader', state: '' } }];

test('a free-text box named Tags is kept in the plan only next to a genre list, and the written file declares that tags can be typed', (t) => {
  const plan = planFilters(WITH_TAGS());
  assert.deepEqual(plan.tags, { position: 5 });
  assert.equal(planFilters([{ type: 'Text', filter: { name: 'Tags', state: '' } }]).tags, null, 'no genre list, no place to type one');
  assert.equal(planFilters([...REAL(), { type: 'Text', filter: { name: 'Uploader', state: '' } }]).tags, null, 'only a box called Tags');
  assert.deepEqual(normalizePlan(plan).tags, { position: 5 });
  assert.equal(normalizePlan({ tags: { position: 5 } }).tags, null, 'a plan with no genres drops the box');
  for (const bad of [{ position: -1 }, { position: 'x' }, { position: 9999 }, 'x', 5, null]) assert.equal(normalizePlan({ ...planFilters(REAL()), tags: bad }).tags, null, JSON.stringify(bad));
  const built = build(plan);
  assert.equal(built.filters.tags, true);
  const mod = load(t, built);
  assert.equal(mod.meta.ui.customTags, true);
  assert.deepEqual(sanitizeSourceUi(mod.meta.ui).problems, []);
  assert.equal(sanitizeSourceUi(mod.meta.ui).ui.customTags, true);
  assert.equal(load(t, build(planFilters(REAL()))).meta.ui.customTags, false);
});

test('a genre of the extension goes to its group and a word the person typed goes to the Tags box, together; a word with nowhere to go asks nothing', async (t) => {
  const { mod, requests } = await rig(t, planFilters(WITH_TAGS()));
  await mod.byGenres(['Comedy', 'creampie', 'big boobs'], '', {}, 1);
  const sent = requests.pop();
  assert.deepEqual(sent.body, { searchTerm: '', filter: [{ position: 3, state: JSON.stringify({ position: 1, state: '1' }) }, { position: 5, state: 'creampie,big boobs' }] });
  const out = await mod.byGenres(['creampie'], '', {}, 1);
  assert.deepEqual(requests.pop().body, { searchTerm: '', filter: [{ position: 5, state: 'creampie' }] }, 'only typed words');
  assert.deepEqual(out.results[0].genres, ['creampie'], 'the titles are tagged with the typed tag, which the app needs to keep them');
  const before = requests.length;
  for (const bad of [['-creampie'], ['a,b'], ['x'.repeat(60)], ['<b>'], ['"; drop'], ['Action', 'Lolicon'], ['loli'], ['a', 'b', 'c', 'd', 'e', 'f']]) assert.deepEqual(await mod.byGenres(bad), { results: [], hasNextPage: false }, JSON.stringify(bad));
  assert.equal(requests.length, before, 'none of those asked the server anything');
  const plain = await rig(t, planFilters(REAL()));
  assert.deepEqual(await plain.mod.byGenres(['creampie']), { results: [], hasNextPage: false }, 'an extension with no Tags box has nowhere to put it');
  assert.equal(plain.requests.length, 0);
});

test('typed tags also work as the only choice of a source whose genre filter is a select, and a select still takes one genre', async (t) => {
  const plan = planFilters([select('Genre', ['All', 'Action', 'Drama', 'Horror']), { type: 'Text', filter: { name: 'Tags', state: '' } }]);
  const { mod, requests } = await rig(t, plan);
  const out = await mod.byGenres(['Drama', 'Horror', 'isekai'], '', {}, 1);
  assert.deepEqual(requests.pop().body, { searchTerm: '', filter: [{ position: 0, state: '2' }, { position: 1, state: 'isekai' }] });
  assert.deepEqual(out.results[0].genres, ['Drama', 'isekai'], 'the second genre of a select is not asked for, so it is not claimed');
});
