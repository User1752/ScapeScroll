'use strict';

// The Iken template and the API detection (generator/iken.template.txt, api-engines.js, discoverIken). The network is replaced: the API answers what the
// real one was measured to answer (the field names and shapes), with made-up titles. What matters: the source asks the API the way the site's own page does,
// reads only the fields it names, keeps a never-listed category out of every list, offers no chapter the site keeps back, refuses ids that are not plain,
// and the engine is told by the SHAPE of an API answer (never by a word on a page).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { buildSource, supportedEngines } = require('../../server/modules/source-import/generator');
const { discoverIken } = require('../../server/modules/source-import/generator/discover');
const { generateFromLink } = require('../../server/modules/source-import/generator/from-link');
const { detectApiEngine, checkApiRobots, apiOrigins } = require('../../server/modules/source-import/api-engines');
const { analyzeSourceCode } = require('../../server/modules/source-import/static-report');
const { checkSourceContract } = require('../../server/modules/source-import/contract');
const fetchUtils = require('../../server/modules/network/fetch-utils');

const ROOT = path.join(__dirname, '..', '..');
const BASE = 'https://reader.example';
const API = 'https://api.reader.example';
const GENRES = [{ name: 'Action', slug: '1' }, { name: 'Drama', slug: '5' }, { name: 'Loli', slug: '9' }, { name: 'Adult', slug: '12' }];

const built = (over = {}) => buildSource({ engine: 'iken', base: BASE, api: API, name: 'Reader Example', genres: GENRES, ...over });

/** Loads generated code the way an installed source is loaded, with fetchText answering from `answers` (path -> JSON or Error). */
function load(code, answers) {
  const real = fetchUtils.fetchText;
  const asked = [];
  fetchUtils.fetchText = async (url, _retries, opts = {}) => {
    asked.push({ url, headers: opts.extraHeaders || {} });
    const key = url.replace(API, '');
    const hit = answers[key] !== undefined ? answers[key] : answers[key.replace(/\?.*$/, '')];
    if (hit === undefined) throw new Error('HTTP 404');
    if (hit instanceof Error) throw hit;
    return typeof hit === 'string' ? hit : JSON.stringify(hit);
  };
  try {
    const file = path.join(ROOT, 'data', 'sources', '__iken_test__.js');
    const mod = new Module(file, null);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod._compile(code, file);
    return { source: mod.exports, asked };
  } finally {
    fetchUtils.fetchText = real;
  }
}

const post = (slug, title, extra = {}) => ({ id: 7, slug, postTitle: title, featuredImage: `https://storage.reader.example/${slug}.jpg`, seriesType: 'MANHWA', seriesStatus: 'ONGOING', genres: [{ id: 1, name: 'Action' }], chapters: [], ...extra });
const list = (posts, total = posts.length) => ({ posts, totalCount: total, searchTerm: '' });
const chapter = (id, number, extra = {}) => ({ id, slug: `chapter-${number}`, number, title: '', createdAt: '2026-03-04T05:06:07.890Z', price: 0, isLocked: false, isTimeLocked: false, chapterPurchased: false, ...extra });

// ── the file ─────────────────────────────────────────────────────────────

test('the template is a source like any other: it parses, has no risky call, meets the contract, and puts the API and the genre ids in as literals', () => {
  assert.ok(supportedEngines().includes('iken'));
  const out = built();
  assert.equal(out.id, 'reader');
  assert.deepEqual(analyzeSourceCode(out.code).risks, []);
  const { source } = load(out.code, {});
  assert.deepEqual(checkSourceContract(source, 'reader').errors, []);
  assert.ok(out.code.includes(`const API = "${API}";`));
  assert.ok(out.code.includes('"action":1') && out.code.includes('"drama":5'));
  assert.ok(!out.code.includes('"loli"'), 'a never-listed genre is never offered, so it has no id');
  assert.equal(built({ api: undefined }).code.includes(`const API = "${BASE}";`), true, 'without an API address it is the site itself');
  assert.match(out.code, /^\/\/ scrollscape-generated engine=iken base=https:\/\/reader\.example on=\d{4}-\d{2}-\d{2}$/m);
});

test('an API address that is not a plain https address is refused, and hostile values cannot put code in the file', () => {
  for (const bad of ['http://api.reader.example', 'https://user:pass@api.reader.example', 'not a url', 'javascript:alert(1)']) {
    assert.throws(() => built({ api: bad }), /API address/, bad);
  }
  const hostile = built({ name: '"; process.exit(1); //', genres: [{ name: 'a"; evil(); "', slug: '3' }, { name: 'x', slug: '3"; evil(); "' }] });
  assert.deepEqual(analyzeSourceCode(hostile.code).risks, []);
  assert.ok(!/evil\(\)/.test(hostile.code.replace(/"[^"\n]*"/g, '""')));
});

// ── lists and search ─────────────────────────────────────────────────────

test('lists and search are asked of the API the way the site\'s own page asks, with the site as origin and referrer; novels and never-listed titles are left out', async () => {
  const answers = {
    '/api/query?page=1&perPage=24&searchTerm=&orderBy=totalViews&orderDirection=desc&seriesStatus=&seriesType=&genreIds=': list([post('top', 'Top Title'), post('story', 'A Story', { isNovel: true }), post('bad', 'Bad One', { genres: [{ id: 9, name: 'Loli' }] })], 80),
    '/api/query?page=2&perPage=24&searchTerm=&orderBy=lastChapterAddedAt&orderDirection=desc&seriesStatus=&seriesType=&genreIds=': list([post('later', 'Later')], 80),
    '/api/query?page=1&perPage=24&searchTerm=hero&orderBy=lastChapterAddedAt&orderDirection=desc&seriesStatus=&seriesType=&genreIds=': list([post('hero-one', 'Hero One')], 1),
  };
  const { source, asked } = load(built().code, answers);
  const popular = await source.search('', 1, 'views');
  assert.deepEqual(popular.results.map((r) => r.id), ['top'], 'a novel and a never-listed title are not returned');
  assert.equal(popular.hasNextPage, true, '80 titles, 24 a page');
  assert.match(popular.results[0].cover, /proxy-image/);
  assert.equal(popular.results[0].url, `${BASE}/series/top`);
  assert.deepEqual((await source.search('', 2)).results.map((r) => r.id), ['later']);
  assert.equal((await source.search('', 2)).hasNextPage, true);
  assert.deepEqual((await source.search('hero', 1)).results.map((r) => r.id), ['hero-one']);
  assert.deepEqual(asked[0].headers, { Accept: 'application/json, text/plain, */*', Origin: BASE, Referer: `${BASE}/` });
  assert.deepEqual(await source.search('loli collection', 1), { results: [], hasNextPage: false }, 'a never-listed search is nothing, and nothing is asked');
  assert.equal(asked.length, 5 - 1 + 0, 'the never-listed search asked nothing');
});

test('genres go by the id the API takes, several at once; an unknown or never-listed one is nothing and asks nothing', async () => {
  const answers = { '/api/query?page=1&perPage=24&searchTerm=&orderBy=lastChapterAddedAt&orderDirection=desc&seriesStatus=&seriesType=&genreIds=1%2C5': list([post('both', 'Both')], 1) };
  const { source, asked } = load(built().code, answers);
  assert.deepEqual((await source.byGenres(['Action', 'drama'])).results.map((r) => r.id), ['both']);
  const before = asked.length;
  for (const names of [['Nope'], ['Loli'], ['Action', 'Oppai Shota'], []]) assert.deepEqual(await source.byGenres(names), { results: [], hasNextPage: false }, JSON.stringify(names));
  assert.equal(asked.length, before, 'nothing was asked');
});

test('an answer that is not a list, or not JSON, or a challenge page, is an error that says so', async () => {
  const q = '/api/query?page=1&perPage=24&searchTerm=&orderBy=lastChapterAddedAt&orderDirection=desc&seriesStatus=&seriesType=&genreIds=';
  await assert.rejects(load(built().code, { [q]: { nope: 1 } }).source.search('', 1), /unexpected shape/);
  await assert.rejects(load(built().code, { [q]: '<html>x</html>' }).source.search('', 1), /did not answer with JSON/);
  await assert.rejects(load(built().code, { [q]: '<title>Just a moment...</title>' }).source.search('', 1), /anti-bot/);
});

// ── details, chapters, pages ─────────────────────────────────────────────

test('details: the title, its text without markup, status, genres and authors; an answer with no title is 404; a bad id is 400', async () => {
  const answers = { '/api/post?postSlug=t': { post: post('t', 'The Title', { postContent: '<p>One &amp; two</p><script>x()</script>', author: 'A', artist: 'A', seriesStatus: 'COMPLETED', genres: [{ id: 1, name: 'Action' }, { id: 5, name: 'Drama' }] }) }, '/api/post?postSlug=none': { post: null } };
  const { source } = load(built().code, answers);
  const d = await source.mangaDetails('t');
  assert.deepEqual([d.id, d.title, d.status, d.author, d.url], ['t', 'The Title', 'completed', 'A', `${BASE}/series/t`]);
  assert.equal(d.description, 'One & two');
  assert.deepEqual(d.genres, ['Action', 'Drama']);
  await assert.rejects(source.mangaDetails('none'), (err) => err.statusCode === 404);
  for (const bad of ['../x', 'a/b', '', 'x y']) await assert.rejects(source.mangaDetails(bad), (err) => err.statusCode === 400, JSON.stringify(bad));
});

test('chapters come from their own call, newest first with real dates; a chapter the site keeps back is not offered; none readable is an error', async () => {
  const rows = [chapter(11, 1), chapter(12, 2), chapter(13, 3, { isLocked: true }), chapter(14, 4, { price: 5 }), chapter(15, 5, { isTimeLocked: true }), chapter(16, 6, { price: 5, chapterPurchased: true }), chapter(12, 2)];
  const answers = { '/api/post?postSlug=t': { post: post('t', 'The Title', { id: 77 }) }, '/api/chapters?postId=77': { post: { chapters: rows } } };
  const { source, asked } = load(built().code, answers);
  const { chapters } = await source.chapters('t');
  assert.deepEqual(chapters.map((c) => c.id), ['t/16', 't/12', 't/11'], 'newest first, locked and priced ones left out, a repeat once');
  assert.equal(chapters[0].name, 'Chapter 6');
  assert.equal(chapters[0].publishAt, '2026-03-04T05:06:07.890Z');
  assert.ok(asked.some((a) => a.url === `${API}/api/chapters?postId=77`), 'the numeric id of the title is what the list asks for');
  const none = load(built().code, { '/api/post?postSlug=t': { post: post('t', 'T', { id: 5 }) }, '/api/chapters?postId=5': { post: { chapters: [chapter(1, 1, { isLocked: true })] } } });
  await assert.rejects(none.source.chapters('t'), /no readable chapter/);
  await assert.rejects(load(built().code, { '/api/post?postSlug=x': { post: null } }).source.chapters('x'), (err) => err.statusCode === 404);
  const future = load(built().code, { '/api/post?postSlug=t': { post: post('t', 'T', { id: 5 }) }, '/api/chapters?postId=5': { post: { chapters: [chapter(1, 1, { createdAt: '2999-01-01T00:00:00.000Z' }), chapter(2, 2, { createdAt: 'not a date' })] } } });
  assert.deepEqual((await future.source.chapters('t')).chapters.map((c) => c.publishAt), [null, null], 'a date that is not real is null, never invented');
});

test('pages: in the order the site gives, absolute addresses, spaces escaped; locked or empty is refused; an id with a path is 400', async () => {
  const images = [{ url: 'https://storage.reader.example/b 2.jpg', order: 2 }, { url: 'https://storage.reader.example/a.jpg', order: 1 }, { url: '', order: 3 }, { url: '/relative.jpg', order: 4 }];
  const answers = { '/api/chapter?chapterId=12': { chapter: { images } }, '/api/chapter?chapterId=13': { chapter: { images: [], isLocked: true } }, '/api/chapter?chapterId=14': { chapter: { images: [] } }, '/api/chapter?chapterId=15': { chapter: null } };
  const { source } = load(built().code, answers);
  const { pages } = await source.pages('t/12');
  assert.equal(pages.length, 3);
  assert.deepEqual(pages.map((p) => decodeURIComponent(p.img).replace(/^.*url=/, '')), ['https://storage.reader.example/a.jpg', 'https://storage.reader.example/b%202.jpg', `${BASE}/relative.jpg`]);
  await assert.rejects(source.pages('t/13'), (err) => err.statusCode === 403);
  await assert.rejects(source.pages('t/14'), (err) => err.statusCode === 404);
  await assert.rejects(source.pages('t/15'), (err) => err.statusCode === 404);
  for (const bad of ['../../etc/passwd', 't/12/13', 't/x', '12', 't/../12', '']) await assert.rejects(source.pages(bad), (err) => err.statusCode === 400, JSON.stringify(bad));
});

// ── the engine is told by the API, not by a page ──────────────────────────

test('the API hosts tried are the site\'s name with api. in front (www removed), then the site itself', () => {
  assert.deepEqual(apiOrigins('https://www.reader.example'), ['https://api.reader.example', 'https://www.reader.example']);
  assert.deepEqual(apiOrigins('https://reader.example'), ['https://api.reader.example', 'https://reader.example']);
  assert.deepEqual(apiOrigins('not a url'), []);
});

const answerWith = (map) => async (url) => {
  const hit = map[url.replace(/\?.*$/, '')];
  if (hit === undefined) return new Response('no', { status: 404 });
  return new Response(typeof hit === 'string' ? hit : JSON.stringify(hit), { status: 200 });
};

test('an API that answers with the fields of the engine names it; one that answers with something else, with an error, or on no host, does not', async () => {
  const good = list([post('a', 'A'), post('b', 'B')], 2);
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([url, init.headers.Origin, init.headers.Referer, init.headers.Accept]); return answerWith({ [`${API}/api/query`]: good })(url); };
  const found = await detectApiEngine(BASE, { fetchImpl, userAgent: 'test' });
  assert.deepEqual([found.id, found.api], ['iken', API]);
  assert.match(found.evidence, /api\.reader\.example\/api\/query/);
  assert.deepEqual(seen[0].slice(1), [BASE, `${BASE}/`, 'application/json, text/plain, */*'], 'asked the way the site\'s own page asks');
  const same = await detectApiEngine(BASE, { fetchImpl: answerWith({ [`${BASE}/api/query`]: good }), userAgent: 'test' });
  assert.equal(same.api, BASE, 'when the API is the site itself');
  for (const wrong of [{ posts: [] , totalCount: 0 }, { posts: [{ slug: 1, postTitle: 'x' }], totalCount: 1 }, { posts: [{ slug: 'a', postTitle: 'x' }] }, { data: [] }, 'not json', [], null]) {
    assert.equal(await detectApiEngine(BASE, { fetchImpl: answerWith({ [`${API}/api/query`]: wrong }), userAgent: 'test' }), null, JSON.stringify(wrong));
  }
  assert.equal(await detectApiEngine(BASE, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, userAgent: 'test' }), null);
  assert.equal(await detectApiEngine(BASE, { fetchImpl: answerWith({}), userAgent: 'test' }), null);
});

test('a host the person\'s list of dangerous sites names is never asked', async () => {
  const asked = [];
  const found = await detectApiEngine(BASE, { fetchImpl: async (url) => { asked.push(url); return answerWith({ [`${API}/api/query`]: list([post('a', 'A')], 1) })(url); }, userAgent: 'test', denylist: ['api.reader.example'] });
  assert.ok(asked.every((u) => !u.startsWith(API)), asked.join(' '));
  assert.equal(found, null);
});

// ── from a link ───────────────────────────────────────────────────────────

const PAGES = { [`${BASE}/`]: '<html><head><title>Home - Reader Example</title></head><body></body></html>' };
const probe = (over = {}) => async () => ({ verdict: 'open', engine: { id: 'nextjs', name: 'Next.js', confidence: 'high' }, reasons: [], robots: { checked: [] }, pages: [{ label: 'home', finalUrl: `${BASE}/` }], ...over });
const deps = (over = {}) => ({ probeSite: probe(), readPageText: async (url) => { if (PAGES[url] === undefined) throw new Error('HTTP 404'); return PAGES[url]; }, detectApiEngine: async () => ({ id: 'iken', name: 'Iken', api: API, evidence: 'x' }), fetchJson: async () => [{ id: 1, name: 'Action' }, { id: 9, name: 'Loli' }, { id: 'x', name: 'Bad' }, null], ...over });

test('a Next.js site whose API names the engine gets an Iken source written, with the name from the home page and the genres from the API', async () => {
  const result = await generateFromLink('reader.example', { deps: deps() });
  assert.equal(result.status, 'generated');
  assert.equal(result.engine, 'iken');
  assert.equal(result.name, 'Reader Example');
  assert.equal(result.api, API);
  assert.equal(result.genres, 1, 'the never-listed genre and the entries that are not genres are not offered');
  assert.ok(result.code.includes(`const API = "${API}";`));
  assert.match(result.code, /scrollscape-generated engine=iken/);
});

test('when no API names an engine, the refusal is the same as before; a page that already names a known engine never asks the API', async () => {
  const none = await generateFromLink('reader.example', { deps: deps({ detectApiEngine: async () => null }) });
  assert.equal(none.status, 'refused');
  assert.equal(none.stage, 'engine');
  let asked = 0;
  const madara = await generateFromLink('reader.example', { deps: deps({ probeSite: probe({ engine: { id: 'madara', name: 'Madara', confidence: 'high' } }), detectApiEngine: async () => { asked += 1; return null; } }) });
  assert.equal(asked, 0);
  assert.equal(madara.stage, 'fit', 'it went on to the Madara fit check');
  const closed = await generateFromLink('reader.example', { deps: deps({ probeSite: probe({ verdict: 'needs-solver' }), detectApiEngine: async () => { asked += 1; return null; } }) });
  assert.equal(closed.stage, 'probe');
  assert.equal(asked, 0, 'a site that is not open is not asked either');
});

test('the genre list of the API is read from the API\'s own origin, and a list that does not answer leaves the source without genres and says so', async () => {
  const asked = [];
  const found = await discoverIken(BASE, async () => '<title>Home - Reader Example</title>', API, async (url) => { asked.push(url); return [{ id: 2, name: 'Drama' }]; });
  assert.deepEqual(asked, [`${API}/api/genres`]);
  assert.deepEqual(found.genres, [{ name: 'Drama', slug: '2' }]);
  const down = await discoverIken(BASE, async () => { throw new Error('HTTP 500'); }, API, async () => { throw new Error('HTTP 500'); });
  assert.deepEqual(down.genres, []);
  assert.ok(down.notes.some((n) => /genre list did not answer/.test(n)) && down.notes.some((n) => /no genre list/.test(n)));
});

// ── robots.txt of the host the API is on ──────────────────────────────────

test('the robots.txt asked about is the one of the host the requests go to: an api. host with no rule is open, and a rule on a path the source asks closes it', async () => {
  const good = list([post('a', 'A')], 1);
  const withRobots = (robots, host = API) => async (url) => {
    if (url === `${host}/robots.txt`) return robots === null ? new Response('nope', { status: 404 }) : new Response(robots, { status: 200 });
    return answerWith({ [`${host}/api/query`]: good })(url);
  };
  const detect = (robots, host) => detectApiEngine(BASE, { fetchImpl: withRobots(robots, host), userAgent: 'test' });
  const open = await detect(null);
  assert.deepEqual(open.robots, { checked: true, disallowed: [] }, 'no robots.txt, no rule');
  assert.deepEqual((await detect('User-agent: *\nAllow: /\n')).robots.disallowed, []);
  assert.deepEqual((await detect('<html>not a robots file</html>')).robots.disallowed, []);
  // A host that closes /api/ to robots is never asked for a path under it, not even to find out what the site is: nothing is detected.
  const touched = [];
  const closedFetch = async (url, init) => { touched.push(url); return withRobots('User-agent: *\nDisallow: /api/\n')(url, init); };
  assert.equal(await detectApiEngine(BASE, { fetchImpl: closedFetch, userAgent: 'test' }), null);
  assert.ok(touched.includes(`${API}/robots.txt`) && touched.every((u) => !u.startsWith(`${API}/api/`)), touched.join(' '));
  const part = await detect('User-agent: *\nDisallow: /api/chapter\n');
  assert.deepEqual(part.robots.disallowed, ['/api/chapters', '/api/chapter'], 'only the paths the source asks, by prefix');
  const other = await detect('User-agent: ia_archiver\nDisallow: /\n');
  assert.deepEqual(other.robots.disallowed, [], 'a rule for another robot is not ours');
  assert.equal(await detect('User-agent: *\nDisallow: /api/*\n', BASE), null, 'an API on the site itself is judged by the site\'s own robots.txt, and is not asked');
  assert.deepEqual(await checkApiRobots(async () => { throw new Error('down'); }, API, ['/api/query'], {}), { checked: false, disallowed: [] });
});

test('from a link: an API its robots.txt closes is a refusal that says which paths; one on its own host is not held against the site\'s own rule about /api/', async () => {
  const api = (robots, host = API) => async () => ({ id: 'iken', name: 'Iken', api: host, evidence: 'x', robots });
  const closed = await generateFromLink('reader.example', { deps: deps({ detectApiEngine: api({ checked: true, disallowed: ['/api/query'] }) }) });
  assert.equal(closed.status, 'refused');
  assert.match(closed.message, /closes what a source has to read \(\/api\/query on api\.reader\.example\)/);
  assert.equal(closed.code, undefined, 'nothing is written');
  const note = { severity: 'warn', text: 'robots.txt forbids /api/ (api). A source must not depend on it.' };
  const other = { severity: 'warn', text: 'The site loads ad networks (X).' };
  const open = { checked: true, disallowed: [] };
  const separate = await generateFromLink('reader.example', { deps: deps({ probeSite: probe({ reasons: [note, other] }), detectApiEngine: api(open) }) });
  assert.equal(separate.status, 'generated');
  assert.deepEqual(separate.probe.reasons.map((r) => r.text), [other.text], 'the site\'s rule about its own /api/ is not about the API host that was checked');
  const same = await generateFromLink('reader.example', { deps: deps({ probeSite: probe({ reasons: [note] }), detectApiEngine: api(open, BASE) }) });
  assert.equal(same.probe.reasons.length, 1, 'when the API is the site itself the warning stays');
});
