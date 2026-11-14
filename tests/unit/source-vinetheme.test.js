'use strict';

// The VineTheme template (generator/vinetheme.template.txt), the shared reader of React Server Components answers (rsc-reader.js) and the theme's detection.
// The answers are hand-written in the shape that was measured on real sites: rows "<hex id>:<value>", long strings as "T<hex byte length>," rows and
// references "$<id>"; the list of titles is a PAGE of the site (/series?sort=..&page=..), never its /api/ directory. What matters: the data is found by the
// names of its fields wherever it sits, references and text rows are followed, a chapter the site keeps back is not offered, a page the site marks as
// protected is refused instead of shown as a picture, never-listed categories are out of every list, ids are plain, and the theme is told by its series page.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { buildSource, supportedEngines } = require('../../server/modules/source-import/generator');
const { discoverVineTheme } = require('../../server/modules/source-import/generator/discover');
const { generateFromLink } = require('../../server/modules/source-import/generator/from-link');
const { detectApiEngine } = require('../../server/modules/source-import/api-engines');
const { rscRows, rscResolve, rscFind } = require('../../server/modules/source-import/rsc-reader');
const { analyzeSourceCode } = require('../../server/modules/source-import/static-report');
const { checkSourceContract } = require('../../server/modules/source-import/contract');
const { readDeclaredUiLiteral } = require('../../server/modules/common/source-ui');
const fetchUtils = require('../../server/modules/network/fetch-utils');

const ROOT = path.join(__dirname, '..', '..');
const BASE = 'https://vine.example';
const GENRES = [{ name: 'Action', slug: 'action' }, { name: 'Slice of Life', slug: 'slice-of-life' }, { name: 'Loli', slug: 'loli' }];
const built = (over = {}) => buildSource({ engine: 'vinetheme', base: BASE, name: 'Vine Example', genres: GENRES, ...over });

/** Loads generated code with fetchText answering from `answers` (path -> text). The headers of every request are kept. */
function load(code, answers) {
  const real = fetchUtils.fetchText;
  const asked = [];
  fetchUtils.fetchText = async (url, _retries, opts = {}) => {
    const key = url.replace(BASE, '');
    asked.push({ key, headers: opts.extraHeaders || {} });
    const hit = answers[key];
    if (hit === undefined) throw new Error('HTTP 404');
    if (hit instanceof Error) throw hit;
    return typeof hit === 'string' ? hit : JSON.stringify(hit);
  };
  try {
    const file = path.join(ROOT, 'data', 'sources', '__vine_test__.js');
    const mod = new Module(file, null);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod._compile(code, file);
    return { source: mod.exports, asked };
  } finally {
    fetchUtils.fetchText = real;
  }
}

/** A React Server Components stream: rows "<id>:<json>", or "<id>:T<hex byte length>,<text>" for { text }. */
const stream = (rows) => Object.entries(rows).map(([id, v]) => (v && typeof v === 'object' && v.text !== undefined ? `${id}:T${Buffer.byteLength(v.text).toString(16)},${v.text}` : `${id}:${JSON.stringify(v)}`)).join('\n') + '\n';
const element = (props) => ['$', 'div', null, props];

const item = (slug, title, extra = {}) => ({ id: `id-${slug}`, slug, urlSlug: slug, title, coverImage: `/covers/${slug}.webp`, type: 'MANHWA', status: 'ONGOING', rating: 4.2, isMature: false, nsfw: false, genres: [{ genre: { name: 'Action', slug: 'action' } }], chapters: [], ...extra });
/** A page of the series list: the titles, and the paging that goes with them (a page past the end has the paging and no list). */
const listPage = (items, { page = 1, totalPages = 1, hasMore = false } = {}) => stream({ 1: ['I', ['x'], 'y'], 4: element({ children: ['$L5'] }), 5: element({ ...(items ? { initialSeries: items } : {}), other: { total: items ? items.length : 0, page, totalPages, hasMore, loaded: 0 } }) });
const chapterRow = (n, extra = {}) => ({ id: `c${n}`, number: n, title: null, publishedAt: '2026-03-04T05:06:07.890Z', isLocked: false, coinPrice: 0, ...extra });
const series = (extra = {}) => ({ id: 's1', title: 'The Title', slug: 't', urlSlug: 't', description: '<p>One &amp; two</p>', coverImage: '/covers/t.webp', status: 'COMPLETED', type: 'MANHWA', genres: [{ genre: { name: 'Action', slug: 'action' } }], ...extra });
const detail = (chapters, { totalPages = 1, seriesExtra = {} } = {}) => stream({ 1: ['I', ['x'], 'y'], 4: element({ children: ['$L5'] }), 27: element({ series: series(seriesExtra), chapters, currentPage: 1, totalPages, sortOrder: 'desc', similarSeries: [] }) });
const chapterPage = (pages, extra = {}) => stream({ 2: element({ chapter: { id: 'c1', number: 1, title: null, pages, ...extra } }) });
const page = (n, extra = {}) => ({ id: `p${n}`, pageNumber: n, kind: 'CONTENT', isRedacted: false, imageUrl: `/media/${n}.webp`, width: 800, height: 1200, isEncrypted: false, tiles: [], hasStrips: false, strips: [], hasFragments: false, fragmentMap: null, fragmentMapIv: null, ...extra });
const L = (sort, p, extra = '') => `/series?sort=${sort}&page=${p}${extra}`;

// ── the shared reader ────────────────────────────────────────────────────

test('the rows of a stream: ids of any length, JSON rows, text rows read by BYTES, with or without a line break after them, rows that are not JSON skipped', () => {
  const withText = (text, between) => `0:["$","div",null,{"a":"$3"}]\n3:T${Buffer.byteLength(text).toString(16)},${text}${between}1a:I["mod",[],"x"]\nff:{"k":[1,2]}\n`;
  for (const between of ['', '\n', '\r\n']) {
    const rows = rscRows(withText('a text row', between));
    assert.deepEqual([...rows.keys()], ['0', '3', 'ff'], JSON.stringify(between));
    assert.equal(rows.get('3').text, 'a text row');
    assert.deepEqual(rows.get('ff').value, { k: [1, 2] });
  }
  const multi = 'héllo wörld – ✓\nsecond line';
  assert.equal(rscRows(withText(multi, '\n')).get('3').text, multi, 'the length is in bytes, not characters');
  assert.equal(rscRows('').size, 0);
  assert.equal(rscRows('not a stream at all').size, 0);
  assert.equal(rscRows('3:Tzz,abc').size, 0, 'a length that is not a number ends the reading, it does not loop');
});

test('references are followed: another row, a text row, "$undefined", "$$" for a dollar; a loop and a huge tree end', () => {
  const rows = rscRows(stream({ 1: { a: '$2', b: '$3', c: '$undefined', d: '$$5.00', e: '$Lb', f: '$@ff', g: '$unknown' }, 2: [1, 2, '$3'], 3: { text: 'plain' }, b: { x: 1 }, 10: { loop: '$10' } }));
  const out = rscResolve(rows.get('1').value, rows);
  assert.deepEqual(out, { a: [1, 2, 'plain'], b: 'plain', c: null, d: '$5.00', e: { x: 1 }, f: '$@ff', g: '$unknown' });
  const loop = rscResolve({ again: '$10' }, rows);
  assert.ok(JSON.stringify(loop).length < 5000, 'a row that refers to itself ends');
  const wide = { list: Array.from({ length: 250000 }, (_, i) => i) };
  assert.ok(JSON.stringify(rscResolve(wide, rows, { left: 1000 })).includes('null'), 'a budget stops a tree that is too big');
});

test('the data is found by the names of its fields, wherever it sits, and nothing is found when a field is renamed', () => {
  const rows = rscRows(stream({ 1: ['I'], 2: element({ deep: [{ x: { y: { series: { id: 1 }, chapters: [] } } }] }), 3: { series: 'a' } }));
  assert.deepEqual(rscFind(rows, (o) => o.series && typeof o.series === 'object' && o.chapters !== undefined).series, { id: 1 });
  assert.equal(rscFind(rows, (o) => o.seriesRenamed !== undefined), null);
  assert.equal(rscFind(rows, () => false), null);
  assert.equal(rscFind(new Map(), () => true), null);
});

// ── the file ─────────────────────────────────────────────────────────────

test('the template is a source like any other: it parses, has no risky call, meets the contract, declares an Adult mark, writes the genre slugs as literals and asks no /api/ path', () => {
  assert.ok(supportedEngines().includes('vinetheme'));
  const out = built();
  assert.deepEqual(analyzeSourceCode(out.code).risks, []);
  const { source } = load(out.code, {});
  assert.deepEqual(checkSourceContract(source, 'vine').errors, []);
  assert.ok(out.code.includes('"action":"action"') && out.code.includes('"slice of life":"slice-of-life"'));
  assert.ok(!out.code.includes('"loli":'), 'a never-listed genre is never offered');
  assert.ok(out.nsfw.includes('Adult'), 'a title the site flags as adult carries an Adult genre, so it is declared');
  assert.ok(readDeclaredUiLiteral(out.code), 'the declaration is a literal the Check can read');
  assert.ok(!/\/api\//.test(out.code.replace(/\/\/.*$/gm, '')), 'only pages are asked, never the /api/ directory the site\'s robots.txt closes');
  assert.match(out.code, /^\/\/ scrollscape-generated engine=vinetheme base=https:\/\/vine\.example on=\d{4}-\d{2}-\d{2}$/m);
});

// ── lists ────────────────────────────────────────────────────────────────

test('lists and search ask the site\'s own series page with its parameters; adult and never-listed titles are marked or left out; the next page is the site\'s own flag', async () => {
  const answers = {
    [L('popular', 1)]: listPage([item('top', 'Top Title'), item('adult', 'Adult One', { nsfw: true }), item('bad', 'Bad', { genres: [{ genre: { name: 'Loli', slug: 'loli' } }] })], { totalPages: 2, hasMore: true }),
    [L('updated', 2)]: listPage([item('later', 'Later')], { page: 2, totalPages: 2 }),
    [L('updated', 1, '&q=hero')]: listPage([item('hero', 'Hero')]),
    [L('trending', 1)]: listPage([item('hot', 'Hot', { genres: ['Drama'] })]),
    [L('updated', 1, '&q=zzzz')]: listPage(null),
    [L('updated', 999)]: listPage(null, { page: 999, totalPages: 8 }),
  };
  const { source, asked } = load(built().code, answers);
  const popular = await source.search('', 1, 'views');
  assert.deepEqual(popular.results.map((r) => r.id), ['top', 'adult'], 'the never-listed title is out');
  assert.deepEqual(popular.results[1].genres, ['Action', 'Adult'], 'a title the site flags as adult carries the mark Hide NSFW looks for');
  assert.equal(popular.hasNextPage, true);
  assert.equal(popular.results[0].url, `${BASE}/series/comic/top`);
  assert.match(popular.results[0].cover, /proxy-image/);
  assert.deepEqual((await source.search('', 2)).results.map((r) => r.id), ['later']);
  assert.deepEqual((await source.search('hero')).results.map((r) => r.id), ['hero']);
  assert.deepEqual((await source.trending()).results[0].genres, ['Drama'], 'a genre that is only a word is read as it is');
  assert.deepEqual(await source.search('zzzz'), { results: [], hasNextPage: false }, 'a search with no match has no list: nothing, not an error');
  assert.deepEqual(await source.search('', 999), { results: [], hasNextPage: false }, 'a page past the end');
  assert.equal(asked[0].headers.rsc, '1', 'the page is asked the way the site\'s own page asks for its data');
  assert.ok(asked.every((a) => !a.key.startsWith('/api/')), 'no /api/ path is ever asked');
  assert.deepEqual(await source.search('loli collection'), { results: [], hasNextPage: false });
});

test('genres go by the slug the site takes, several at once; an unknown or never-listed one is nothing and asks nothing; a page of another shape is an error', async () => {
  const answers = { [L('updated', 1, '&genre=action%2Cslice-of-life')]: listPage([item('both', 'Both')]) };
  const { source, asked } = load(built().code, answers);
  assert.deepEqual((await source.byGenres(['Action', 'slice of life'])).results.map((r) => r.id), ['both']);
  const before = asked.length;
  for (const names of [['Nope'], ['Loli'], ['Action', 'Oppai Shota'], []]) assert.deepEqual(await source.byGenres(names), { results: [], hasNextPage: false }, JSON.stringify(names));
  assert.equal(asked.length, before);
  await assert.rejects(load(built().code, { [L('updated', 1)]: stream({ 1: ['I'], 2: { nothing: 1 } }) }).source.search('', 1), /unexpected shape/);
  await assert.rejects(load(built().code, { [L('updated', 1)]: '<!DOCTYPE html><html></html>' }).source.search('', 1), /not with the data this source reads/);
});

// ── details and chapters, from the stream ────────────────────────────────

test('details are found in the stream by the names of the fields; references to other rows and long text rows are followed; an answer with no title is 404', async () => {
  const rows = { 4: element({ children: ['$L5'] }), 5: element({ deep: [{ nested: { series: { id: 's', title: 'Ünï Title', description: '$7', coverImage: '/c.webp', status: 'HIATUS', genres: '$8' }, chapters: '$9', totalPages: 1 } }] }), 7: { text: '<p>Ünïcode – text with $$ dollars</p>' }, 8: [{ genre: { name: 'Drama', slug: 'drama' } }], 9: [chapterRow(1)] };
  const { source, asked } = load(built().code, { '/series/comic/t?sort=desc': stream(rows) });
  const d = await source.mangaDetails('t');
  assert.deepEqual([d.id, d.title, d.status, d.url], ['t', 'Ünï Title', 'hiatus', `${BASE}/series/comic/t`]);
  assert.equal(d.description, 'Ünïcode – text with $$ dollars', 'a text row is read by its BYTE length, and what it holds is plain text');
  assert.deepEqual(d.genres, ['Drama'], 'a reference to a row of genres');
  assert.equal(asked[0].headers.rsc, '1');
  assert.equal(asked[0].headers.Referer, `${BASE}/`);
  const never = load(built().code, { '/series/comic/x?sort=desc': detail([chapterRow(1)], { seriesExtra: { genres: [{ genre: { name: 'Loli', slug: 'loli' } }] } }) });
  await assert.rejects(never.source.mangaDetails('x'), (err) => err.statusCode === 404);
  await assert.rejects(load(built().code, { '/series/comic/none?sort=desc': stream({ 1: ['I', 'nothing here'] }) }).source.mangaDetails('none'), (err) => err.statusCode === 404);
  await assert.rejects(load(built().code, { '/series/comic/page?sort=desc': '<!DOCTYPE html><html></html>' }).source.mangaDetails('page'), /not with the data this source reads/);
  for (const bad of ['../x', 'a/b', '', 'x y']) await assert.rejects(source.mangaDetails(bad), (err) => err.statusCode === 400, JSON.stringify(bad));
});

test('chapters: every page of the list is read; a chapter the site keeps back is not offered; newest first by number, decimals kept, real dates or null', async () => {
  const p1 = detail([chapterRow(3), chapterRow(2.5), chapterRow(9, { isLocked: true }), chapterRow(8, { coinPrice: 20 }), chapterRow(3)], { totalPages: 2 });
  const p2 = detail([chapterRow(1, { publishedAt: 'not a date' }), chapterRow(4, { publishedAt: '2999-01-01T00:00:00.000Z', title: 'Special' })], { totalPages: 2 });
  const { source, asked } = load(built().code, { '/series/comic/t?sort=desc': p1, '/series/comic/t?sort=desc&page=2': p2 });
  const { chapters } = await source.chapters('t');
  assert.deepEqual(chapters.map((c) => c.id), ['t/4', 't/3', 't/2.5', 't/1'], 'both pages, locked and priced ones left out, a repeat once');
  assert.equal(chapters[0].name, 'Chapter 4 - Special');
  assert.equal(chapters[0].url, `${BASE}/series/comic/t/chapter/4`);
  assert.deepEqual([chapters[0].publishAt, chapters[3].publishAt], [null, null], 'a date in the far future or not a date is null, never invented');
  assert.equal(chapters[1].publishAt, '2026-03-04T05:06:07.890Z');
  assert.deepEqual(asked.map((a) => a.key), ['/series/comic/t?sort=desc', '/series/comic/t?sort=desc&page=2']);
  await assert.rejects(load(built().code, { '/series/comic/t?sort=desc': detail([chapterRow(1, { isLocked: true })]) }).source.chapters('t'), /no readable chapter/);
  await assert.rejects(load(built().code, { '/series/comic/x?sort=desc': stream({ 1: ['I'] }) }).source.chapters('x'), (err) => err.statusCode === 404);
});

test('a title with more pages of chapters than the cap is read up to the cap and no further', async () => {
  const answers = {};
  for (let n = 1; n <= 60; n += 1) answers[`/series/comic/t?sort=desc${n > 1 ? `&page=${n}` : ''}`] = detail([chapterRow(n)], { totalPages: 60 });
  const { source, asked } = load(built().code, answers);
  const { chapters } = await source.chapters('t');
  assert.equal(chapters.length, 40);
  assert.equal(asked.length, 40);
});

// ── pages ────────────────────────────────────────────────────────────────

test('pages: in the site\'s order, relative addresses joined to the site; a page the site marks as protected makes the chapter refused; empty or missing is 404', async () => {
  const answers = {
    '/series/comic/t/chapter/1': chapterPage([page(2), page(1), page(3, { imageUrl: '' })]),
    '/series/comic/t/chapter/2': chapterPage([page(1), page(2, { isEncrypted: true })]),
    '/series/comic/t/chapter/3': chapterPage([page(1, { isRedacted: true })]),
    '/series/comic/t/chapter/4': chapterPage([page(1, { tiles: [[0, 1]] })]),
    '/series/comic/t/chapter/5': chapterPage([page(1, { hasStrips: true })]),
    '/series/comic/t/chapter/6': chapterPage([page(1, { hasFragments: true })]),
    '/series/comic/t/chapter/7': chapterPage([]),
    '/series/comic/t/chapter/8': stream({ 1: ['I'] }),
  };
  const { source } = load(built().code, answers);
  const { pages } = await source.pages('t/1');
  assert.deepEqual(pages.map((p) => decodeURIComponent(p.img).replace(/^.*url=/, '')), [`${BASE}/media/1.webp`, `${BASE}/media/2.webp`]);
  for (const n of [2, 3, 4, 5, 6]) await assert.rejects(source.pages(`t/${n}`), (err) => err.statusCode === 403 && /protected by the site/.test(err.message), `chapter ${n}`);
  await assert.rejects(source.pages('t/7'), (err) => err.statusCode === 404);
  await assert.rejects(source.pages('t/8'), (err) => err.statusCode === 404);
  for (const bad of ['../../etc/passwd', 't/1/2', 't/x', '12', 't/../1', '', 't/1e5', 't/1.2345']) await assert.rejects(source.pages(bad), (err) => err.statusCode === 400, JSON.stringify(bad));
});

// ── the theme is told by its series page ─────────────────────────────────

const respond = (map, robots) => async (url) => {
  const u = new URL(url);
  if (u.pathname === '/robots.txt') return robots === undefined ? new Response('no', { status: 404 }) : new Response(robots, { status: 200 });
  const hit = map[u.pathname];
  return hit === undefined ? new Response('no', { status: 404 }) : new Response(hit, { status: 200 });
};

test('the series page with its list and its paging names the theme; a page without them, a plain page or an error does not; its robots.txt decides what may be read', async () => {
  const good = listPage([item('a', 'A'), item('b', 'B')], { totalPages: 3, hasMore: true });
  const seen = [];
  const found = await detectApiEngine(BASE, { fetchImpl: async (url, init) => { seen.push([new URL(url).pathname, init.headers.rsc]); return respond({ '/series': good })(url); }, userAgent: 'test' });
  assert.deepEqual([found.id, found.api, found.unsupported], ['vinetheme', BASE, undefined]);
  assert.deepEqual(found.robots, { checked: true, disallowed: [] });
  assert.ok(seen.some(([p, rsc]) => p === '/series' && rsc === '1'), 'the page is asked with the rsc header');
  // A site that closes /api/ to robots is never asked for a path under it, not even to find out what the site is (the robots.txt is read first).
  const closedApi = [];
  const found2 = await detectApiEngine(BASE, { fetchImpl: async (url, init) => { closedApi.push(new URL(url).pathname); return respond({ '/series': good }, 'User-agent: *\nAllow: /\nDisallow: /api/\n')(url, init); }, userAgent: 'test' });
  assert.equal(found2.id, 'vinetheme');
  assert.ok(closedApi.some((p) => p === '/robots.txt') && closedApi.every((p) => !p.startsWith('/api/')), closedApi.join(' '));
  for (const wrong of [listPage(null), '<html>an ordinary page</html>', stream({ 1: element({ initialSeries: [{ title: 'x' }], other: { totalPages: 1, hasMore: false } }) }), 'nope']) {
    assert.equal(await detectApiEngine(BASE, { fetchImpl: respond({ '/series': wrong }), userAgent: 'test' }), null, String(wrong).slice(0, 40));
  }
  const closed = await detectApiEngine(BASE, { fetchImpl: respond({ '/series': good }, 'User-agent: *\nDisallow: /series/comic/\n'), userAgent: 'test' });
  assert.deepEqual(closed.robots.disallowed, ['/series/comic/']);
  const api = await detectApiEngine(BASE, { fetchImpl: respond({ '/series': good }, 'User-agent: *\nAllow: /\nDisallow: /api/\n'), userAgent: 'test' });
  assert.deepEqual(api.robots.disallowed, [], 'a site that closes /api/ is not held against: the source never asks it');
});

test('the genres are read from the titles of the series list: nested or flat, each with its slug; one without a slug is not offered; a list that does not answer is said', async () => {
  const asked = [];
  const pages = [listPage([item('a', 'A', { genres: [{ genre: { name: 'Action', slug: 'action' } }, { name: 'Drama', slug: 'drama' }, { genre: { name: 'No Slug' } }, 'Word'] })], { totalPages: 2, hasMore: true }), listPage([item('b', 'B', { genres: [{ genre: { name: 'action', slug: 'action' } }, { genre: { name: 'Mystery', slug: 'mystery' } }] })], { page: 2, totalPages: 2 })];
  const found = await discoverVineTheme(BASE, async () => '<title>Home - Vine Example</title>', async (url) => { asked.push(url); return rscRows(pages[asked.length - 1]); });
  assert.deepEqual(found.genres, [{ name: 'Action', slug: 'action' }, { name: 'Drama', slug: 'drama' }, { name: 'Mystery', slug: 'mystery' }]);
  assert.equal(found.name, 'Vine Example');
  assert.deepEqual(asked.map((u) => u.replace(BASE, '')), ['/series?sort=updated&page=1', '/series?sort=updated&page=2']);
  const down = await discoverVineTheme(BASE, async () => { throw new Error('HTTP 500'); }, async () => { throw new Error('HTTP 500'); });
  assert.deepEqual(down.genres, []);
  assert.ok(down.notes.some((n) => /title list did not answer/.test(n)) && down.notes.some((n) => /no genre list/.test(n)));
});

// ── from a link ───────────────────────────────────────────────────────────

const PAGES = { [`${BASE}/`]: '<html><head><title>Home - Vine Example</title></head><body></body></html>' };
const probe = (over = {}) => async () => ({ verdict: 'open', engine: { id: 'nextjs', name: 'Next.js', confidence: 'high' }, reasons: [], robots: { checked: [] }, pages: [{ label: 'home', finalUrl: `${BASE}/` }], ...over });
const deps = (over = {}) => ({ probeSite: probe(), readPageText: async (url) => { if (PAGES[url] === undefined) throw new Error('HTTP 404'); return PAGES[url]; }, detectApiEngine: async () => ({ id: 'vinetheme', name: 'VineTheme', api: BASE, evidence: 'x', robots: { checked: true, disallowed: [] } }), fetchRows: async () => rscRows(listPage([item('a', 'A', { genres: [{ genre: { name: 'Action', slug: 'action' } }, { genre: { name: 'Loli', slug: 'loli' } }] })])), ...over });

test('a Next.js site whose series page names the theme gets a VineTheme source written, with the genres from its titles; no markup is checked; a closed robots.txt is a refusal', async () => {
  const result = await generateFromLink('vine.example', { deps: deps() });
  assert.equal(result.status, 'generated');
  assert.equal(result.engine, 'vinetheme');
  assert.equal(result.name, 'Vine Example');
  assert.equal(result.genres, 1, 'the never-listed genre is not offered');
  assert.ok(result.nsfw.includes('Adult'));
  assert.match(result.code, /scrollscape-generated engine=vinetheme/);
  const note = { severity: 'warn', text: 'robots.txt forbids /api/ (api). A source must not depend on it.' };
  const other = { severity: 'warn', text: 'The site loads ad networks (X).' };
  const quiet = await generateFromLink('vine.example', { deps: deps({ probeSite: probe({ reasons: [note, other] }) }) });
  assert.deepEqual(quiet.probe.reasons.map((r) => r.text), [other.text], 'a source that asks pages only is not held to the site\'s rule about /api/');
  const closed = await generateFromLink('vine.example', { deps: deps({ detectApiEngine: async () => ({ id: 'vinetheme', name: 'VineTheme', api: BASE, evidence: 'x', robots: { checked: true, disallowed: ['/series'] } }) }) });
  assert.equal(closed.stage, 'engine');
  assert.match(closed.message, /closes what a source has to read \(\/series on vine\.example\)/);
});
