'use strict';

// Writing a source without an AI (server/modules/source-import/generator/): the Madara template filled from measured facts. The
// generated file is judged like any imported one (it parses, has no risks, passes the contract) and is RUN against hand-written
// Madara markup with the network replaced, so what it does with search, details, chapters and pages is seen without a site.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { buildSource, supportedEngines, idFromBase } = require('../../server/modules/source-import/generator');
const { discoverMadara, discoverMangaThemesia, titleFolderFrom, siteNameFrom, madaraGenresFrom } = require('../../server/modules/source-import/generator/discover');
const { analyzeSourceCode } = require('../../server/modules/source-import/static-report');
const { checkSourceContract } = require('../../server/modules/source-import/contract');
const { readDeclaredUiLiteral, sanitizeSourceUi } = require('../../server/modules/common/source-ui');

const ROOT = path.join(__dirname, '..', '..');
const fetchUtils = require('../../server/modules/network/fetch-utils');
const safeFetchModule = require('../../server/modules/network/safe-fetch');

const GENRES = [{ name: 'Action', slug: 'action' }, { name: 'Romance', slug: 'romance' }, { name: 'Adult', slug: 'adult' }, { name: 'Loli', slug: 'loli' }, { name: 'Oppai Shota', slug: 'oppai-shota' }];
const BASE = 'https://mangas.example';

// Loads generated code the way an installed source is loaded (as data/sources/<id>.js), with the two network helpers replaced.
function load(code, { pages = {}, posts = {} } = {}) {
  const realFetchText = fetchUtils.fetchText;
  const realSafeFetch = safeFetchModule.safeFetch;
  const asked = [];
  fetchUtils.fetchText = async (url) => {
    asked.push(url);
    const hit = pages[url] !== undefined ? pages[url] : pages[url.replace(/\?.*$/, '')];
    if (hit === undefined) throw new Error('HTTP 404');
    if (hit instanceof Error) throw hit;
    return hit;
  };
  safeFetchModule.safeFetch = async (url, init) => {
    asked.push(`${init.method} ${url}`);
    const body = posts[url];
    return new Response(body === undefined ? 'nope' : body, { status: body === undefined ? 404 : 200 });
  };
  try {
    const file = path.join(ROOT, 'data', 'sources', '__generated_test__.js');
    const mod = new Module(file, null);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod._compile(code, file);
    return { source: mod.exports, asked };
  } finally {
    fetchUtils.fetchText = realFetchText; // the generated file captured the fakes when it loaded
    safeFetchModule.safeFetch = realSafeFetch;
  }
}

const card = (slug, title, genres = '') => `<div class="page-item-detail"><div class="item-thumb"><img data-src="/covers/${slug}.jpg" src="data:image/gif;base64,R0lGOD"></div><div class="post-title"><h3><a href="${BASE}/manga/${slug}/">${title}</a></h3></div>${genres}</div>`;
const LIST = (cards, next = '') => `<html><body><div class="c-page-content">${cards}</div>${next}</body></html>`;
const TITLE = (h1, extra = '') => `<html><body><div class="post-title"><h1><span class="manga-title-badges hot">HOT</span> ${h1}</h1></div><div class="summary_image"><img data-src="/covers/t.jpg"></div><div class="genres-content"><a>Action</a><a>Drama</a></div><div class="author-content"><a>Someone</a></div><div class="post-content_item"><div class="summary-heading"><h5>Status</h5></div><div class="summary-content">OnGoing</div></div><div class="description-summary"><div class="summary__content"><p>A story.</p></div></div>${extra}</body></html>`;
const CHAPTER_LIST = '<ul><li class="wp-manga-chapter"><a href="https://mangas.example/manga/t-one/chapter-2/">Chapter 2</a><span class="chapter-release-date"><i>3 days ago</i></span></li><li class="wp-manga-chapter"><a href="https://mangas.example/manga/t-one/chapter-1/">Chapter 1</a><span class="chapter-release-date"><i>October 1, 2025</i></span></li></ul>';

const generated = () => buildSource({ engine: 'madara', base: BASE, name: 'Mangas Example', genres: GENRES });

// ── The file ───────────────────────────────────────────────────────────────

test('the Madara template is filled with measured facts only, and the result is a source like any other: parsed, no risks, the contract met', () => {
  const out = generated();
  assert.equal(out.id, 'mangas');
  assert.equal(out.name, 'Mangas Example');
  assert.equal(out.genres, 3, 'the two never-listed names are dropped');
  assert.deepEqual(out.nsfw, ['Adult']);
  const report = analyzeSourceCode(out.code);
  assert.equal(report.syntaxError, null);
  assert.deepEqual(report.risks, []);
  assert.deepEqual(report.hosts, ['mangas.example']);
  assert.ok(!/__[A-Z_]+__/.test(out.code), 'no placeholder left');
  const { source } = load(out.code);
  const verdict = checkSourceContract(source, 'mangas');
  assert.ok(verdict.ok, JSON.stringify(verdict.errors));
  assert.deepEqual(verdict.errors, []);
});

test('the declaration in the generated file is a plain literal the Check reads, with the genres and adult genres that were measured', () => {
  const out = generated();
  const found = readDeclaredUiLiteral(out.code);
  assert.equal(found.readable, true, found.reason);
  const ui = sanitizeSourceUi(found.value, { knownHosts: new Set(['mangas.example']) });
  assert.deepEqual(ui.problems.filter((p) => p.level === 'error'), []);
  assert.deepEqual(ui.ui.genres, ['Action', 'Romance', 'Adult']);
  assert.deepEqual(ui.ui.nsfwGenres, ['Adult']);
  assert.equal(ui.ui.orderBy.length, 5);
});

test('hostile values cannot put code in the file: names, ids, addresses and genres are validated and written as JSON literals', () => {
  const evil = buildSource({ engine: 'madara', base: BASE, name: 'X"; process.exit(1); //\n*/ require("child_process")', genres: [{ name: '"; process.exit(1); //', slug: 'ok-slug' }, { name: 'Fine', slug: '../../etc' }, { name: 'Fine2', slug: 'fine' }] });
  assert.deepEqual(analyzeSourceCode(evil.code).risks, []);
  assert.doesNotMatch(evil.name, /["();./\\]/, 'the name keeps only letters, digits and a few marks');
  assert.doesNotThrow(() => load(evil.code));
  assert.equal(evil.genres, 2, 'a slug that is not a slug is dropped');
  assert.throws(() => buildSource({ engine: 'madara', base: 'http://insecure.example' }), /https/);
  assert.throws(() => buildSource({ engine: 'madara', base: 'https://user:pw@x.example' }), /https/);
  assert.throws(() => buildSource({ engine: 'madara', base: 'not a url' }), /web address/);
  assert.throws(() => buildSource({ engine: 'madara', base: BASE, id: '../x' }), /usable source id/);
  assert.throws(() => buildSource({ engine: 'wordpress', base: BASE }), /No template/);
  assert.deepEqual(supportedEngines(), ['madara', 'mangathemesia', 'iken', 'keyoapp', 'vinetheme']);
});

test('the id comes from the host: no www, no suffix', () => {
  assert.equal(idFromBase('https://www.mangas.example'), 'mangas');
  assert.equal(idFromBase('https://manhwas.example'), 'manhwas');
  assert.equal(idFromBase('https://a.b.example.co'), 'a-b-example');
});

// ── What the generated source does with Madara markup ─────────────────────

test('search: a text search and the site\'s own list are asked the way the theme documents, cards are read, never-listed ones are dropped', async () => {
  const pages = {
    [`${BASE}/?s=hero&post_type=wp-manga`]: LIST(card('hero-one', 'Hero One') + card('bad-one', 'Bad One', '<div class="mg_genres"><a>Loli</a></div>'), '<a class="nextpostslink" href="#">next</a>'),
    [`${BASE}/manga/?m_orderby=views`]: LIST(card('top', 'Top Title')),
    [`${BASE}/manga/page/2/?m_orderby=latest`]: LIST(card('later', 'Later')),
  };
  const { source } = load(generated().code, { pages });
  const text = await source.search('hero', 1);
  assert.deepEqual(text.results.map((r) => r.id), ['hero-one'], 'the never-listed card is not returned');
  assert.equal(text.hasNextPage, true);
  assert.match(text.results[0].cover, /proxy-image/);
  assert.equal((await source.search('', 1, 'views')).results[0].id, 'top');
  assert.equal((await source.search('', 2)).results[0].id, 'later');
  assert.deepEqual(await source.search('loli collection', 1), { results: [], hasNextPage: false }, 'a never-listed search is nothing, and nothing is asked');
});

test('a site whose robots.txt forbids the text search is scanned through its list pages instead, and never asked for /?s=', async () => {
  const asked = [];
  const pages = { [`${BASE}/manga/?m_orderby=alphabet`]: LIST(card('alpha', 'Alpha') + card('beta-hero', 'Beta Hero')) };
  const { source, asked: log } = load(buildSource({ engine: 'madara', base: BASE, name: 'M', genres: GENRES, textSearch: false }).code, { pages });
  const result = await source.search('hero', 1);
  assert.deepEqual(result.results.map((r) => r.id), ['beta-hero']);
  assert.ok(log.every((u) => !/[?&]s=/.test(u)), 'the forbidden search path was never asked');
  assert.equal(asked.length, 0);
});

test('genres: one genre at a time, by its slug; an unknown or never-listed one is nothing', async () => {
  const pages = { [`${BASE}/manga-genre/action/?m_orderby=latest`]: LIST(card('a1', 'A1')) };
  const { source } = load(generated().code, { pages });
  const result = await source.byGenres(['Action']);
  assert.equal(result.results[0].id, 'a1');
  assert.deepEqual(result.results[0].genres, ['Action'], 'the result is labelled with what was asked');
  assert.deepEqual((await source.byGenres(['Nonexistent'])).results, []);
  assert.deepEqual((await source.byGenres(['Loli'])).results, []);
  assert.deepEqual((await source.byGenres([])).results, []);
});

test('details: the title without its badges, cover, status, genres, author and description; a page that is not a title is 404; a bad id is 400', async () => {
  const pages = { [`${BASE}/manga/t-one/`]: TITLE('The Title'), [`${BASE}/manga/home/`]: '<html><body>home page</body></html>', [`${BASE}/manga/bad/`]: TITLE('Bad', '<div class="genres-content"><a>Loli</a></div>') };
  const { source } = load(generated().code, { pages });
  const d = await source.mangaDetails('t-one');
  assert.equal(d.title, 'The Title');
  assert.deepEqual(d.genres, ['Action', 'Drama']);
  assert.equal(d.author, 'Someone');
  assert.equal(d.description, 'A story.');
  assert.equal(d.status, 'ongoing');
  await assert.rejects(source.mangaDetails('home'), (e) => e.statusCode === 404);
  await assert.rejects(source.mangaDetails('../etc'), (e) => e.statusCode === 400);
  await assert.rejects(source.mangaDetails('nothing-here'), (e) => e.statusCode === 404);
});

test('chapters: from the title page when it lists them, else by the theme\'s own POST; newest first, real dates or null, ids that carry the title', async () => {
  const inline = load(generated().code, { pages: { [`${BASE}/manga/t-one/`]: TITLE('The Title', CHAPTER_LIST) } });
  const a = await inline.source.chapters('t-one');
  assert.deepEqual(a.chapters.map((c) => c.id), ['t-one/chapter-2', 't-one/chapter-1']);
  assert.match(a.chapters[1].publishAt, /^2025-(09-30|10-01)T/, 'a date with no time is local midnight, whatever the zone');
  assert.ok(a.chapters[0].publishAt && Date.now() - Date.parse(a.chapters[0].publishAt) < 4 * 86400000);
  assert.equal(a.chapters[0].chapter, '2');
  const posted = load(generated().code, { pages: { [`${BASE}/manga/t-one/`]: TITLE('The Title') }, posts: { [`${BASE}/manga/t-one/ajax/chapters/`]: CHAPTER_LIST } });
  assert.equal((await posted.source.chapters('t-one')).chapters.length, 2);
  assert.ok(posted.asked.includes(`POST ${BASE}/manga/t-one/ajax/chapters/`));
  await assert.rejects(posted.source.chapters('../x'), (e) => e.statusCode === 400);
  const bare = load(generated().code, { pages: { [`${BASE}/manga/t-one/`]: TITLE('The Title') } });
  await assert.rejects(bare.source.chapters('t-one'), (e) => e.statusCode === 404 || /HTTP 404|no chapter list/.test(e.message));
});

test('pages: the real address from data-src, a tiny inline picture or a loading picture is not a page, and ids with a path are refused', async () => {
  const reader = (imgs) => `<html><body><div class="reading-content">${imgs}</div></body></html>`;
  const good = [1, 2, 3].map((i) => `<div class="page-break"><img src="data:image/gif;base64,R0lGOD" data-src="  https://cdn.example/p/0${i}.jpg "></div>`).join('') + '<img src="/themes/x/Loading.gif">';
  const { source } = load(generated().code, { pages: { [`${BASE}/manga/t-one/chapter-1/?style=list`]: reader(good), [`${BASE}/manga/t-one/chapter-9/?style=list`]: '<html><body>the title page</body></html>' } });
  const result = await source.pages('t-one/chapter-1');
  assert.equal(result.pages.length, 3);
  assert.match(decodeURIComponent(result.pages[0].img), /cdn\.example\/p\/01\.jpg$/);
  await assert.rejects(source.pages('t-one/chapter-9'), (e) => e.statusCode === 404);
  for (const bad of ['../../etc/passwd', 't-one', '/chapter-1', 'a/../b', '']) await assert.rejects(source.pages(bad), (e) => e.statusCode === 400, bad);
});

// ── Discovery ──────────────────────────────────────────────────────────────

test('discovery reads the name and the genres from the pages the theme documents, and says what it could not read', async () => {
  const form = '<form><input type="checkbox" name="genre[]" value="action" id="g1"><label for="g1">Action <span>(12)</span></label><input type="checkbox" name="genre[]" value="slice-of-life" id="g2"><label for="g2">Slice of Life</label></form>';
  assert.deepEqual(madaraGenresFrom(form), [{ name: 'Action', slug: 'action' }, { name: 'Slice of Life', slug: 'slice-of-life' }]);
  assert.deepEqual(madaraGenresFrom('<a href="/manga-genre/drama/">Drama <span class="count">(4)</span></a>'), [{ name: 'Drama', slug: 'drama' }]);
  assert.equal(siteNameFrom('<html><head><meta property="og:site_name" content="Mangas Example"><title>x</title></head></html>'), 'Mangas Example');
  assert.equal(siteNameFrom('<html><head><title>Read Manga Online - Mangas Example</title></head></html>'), 'Mangas Example');
  const found = await discoverMadara(BASE, async (url) => { if (/post_type/.test(url)) return form; if (url === `${BASE}/`) return '<title>Home - Mangas Example</title>'; throw new Error('HTTP 500'); });
  assert.equal(found.name, 'Mangas Example');
  assert.equal(found.genres.length, 2);
  const none = await discoverMadara(BASE, async () => { throw new Error('HTTP 500'); });
  assert.deepEqual(none.genres, []);
  assert.ok(none.notes.some((n) => /no genre list/.test(n)));
});

// ── Does the template fit the site? ────────────────────────────────────────

const { checkFit } = require('../../server/modules/source-import/generator/fit');

test('a Madara site with the theme\'s markup fits; a customised theme that keeps the scripts but not the markup does not, and says what is missing', () => {
  const standard = { detail: TITLE('A Title'), list: LIST(card('a', 'A')), search: '<div class="c-tabs-item__content"></div>', chapters: CHAPTER_LIST };
  assert.deepEqual(checkFit('madara', standard), { fits: true, missing: [] });
  const custom = { detail: '<h1 class="htitle">A Title</h1>', list: '<div class="hgrid"></div>', search: standard.search, chapters: CHAPTER_LIST };
  const result = checkFit('madara', custom);
  assert.equal(result.fits, false);
  assert.deepEqual(result.missing, ['the title on a title page', 'the cards of the title list']);
  const unread = checkFit('madara', { detail: '', list: '', search: '', chapters: '' });
  assert.equal(unread.fits, false);
  assert.equal(unread.missing.length, 4);
  // A site whose chapter list a script of its own fills in (no list in the page, none from the theme's call) is refused, not written to fail later.
  const scripted = checkFit('madara', { ...standard, chapters: '<div id="nav-chapters-container"><a href="/manga/t/chapter-1/">1</a></div><div class="chapters-loading"></div>' });
  assert.deepEqual(scripted, { fits: false, missing: ['the chapter list of a title'] });
  assert.match(unread.missing[0], /could not be read/);
  assert.equal(checkFit('nextjs', standard).fits, false, 'no template for an engine is not a fit');
});

// ── The folder a site keeps its titles in ("manga" is only the usual one) ───

test('the folder of the titles is read from the address of a title page, and anything that is not a plain word is "manga"', () => {
  assert.equal(titleFolderFrom('https://x.example/series/a-title/'), 'series');
  assert.equal(titleFolderFrom('https://x.example/Komik/a-title/chapter-3/'), 'komik');
  assert.equal(titleFolderFrom('https://x.example/manga/a-title/'), 'manga');
  for (const none of ['https://x.example/a-title/', 'https://x.example/', 'not a url', '', undefined, null, 'https://x.example/%3Cscript%3E/a-title/', 'https://x.example/a.b/title/', `https://x.example/${'w'.repeat(40)}/title/`]) {
    assert.equal(titleFolderFrom(none), 'manga', String(none));
  }
});

test('the folder is put in the file as a JSON literal; a value that is not a plain word is not used, and every address of both templates follows it', () => {
  for (const engine of ['madara', 'mangathemesia']) {
    const out = buildSource({ engine, base: BASE, name: 'Folder Example', genres: GENRES, subpath: 'series' });
    assert.equal(out.subpath, 'series');
    assert.ok(out.code.includes('const SUB = "series";'));
    assert.ok(!/\/manga\//.test(out.code.replace('/manga-genre/', '')), `${engine}: no address is fixed to /manga/`);
    for (const bad of ['a/b', '../x', 'x"; process.exit(1); //', '', 'a b', '.hidden', 'x'.repeat(40), 5, null]) {
      const fallback = buildSource({ engine, base: BASE, name: 'Folder Example', genres: GENRES, subpath: bad });
      assert.equal(fallback.subpath, 'manga', JSON.stringify(bad));
      assert.ok(fallback.code.includes('const SUB = "manga";'));
    }
    assert.equal(buildSource({ engine, base: BASE, name: 'Folder Example', genres: GENRES }).subpath, 'manga', 'no value is the usual folder');
  }
});

test('Madara with another folder: the list, the cards, the details, the chapters (also by the theme POST) and the pages are all asked in that folder', async () => {
  const card2 = (slug, title) => card(slug, title).replace('/manga/', '/series/');
  const chapters = CHAPTER_LIST.split('/manga/').join('/series/');
  const pages = {
    [`${BASE}/series/?m_orderby=views`]: LIST(card2('top', 'Top Title')),
    [`${BASE}/series/t/`]: TITLE('The Title'),
    [`${BASE}/series/t/chapter-2/?style=list`]: '<div class="reading-content"><img data-src="/p/1.jpg"></div>',
  };
  const posts = { [`${BASE}/series/t/ajax/chapters/`]: chapters };
  const { source, asked } = load(buildSource({ engine: 'madara', base: BASE, name: 'Folder Example', genres: GENRES, subpath: 'series' }).code, { pages, posts });
  const list = await source.search('', 1, 'views');
  assert.deepEqual(list.results.map((r) => [r.id, r.url]), [['top', `${BASE}/series/top`]]);
  assert.equal((await source.mangaDetails('t')).url, `${BASE}/series/t/`);
  const ch = await source.chapters('t');
  assert.equal(ch.chapters.length, 2);
  assert.ok(ch.chapters.every((c) => c.url.startsWith(`${BASE}/series/t-`) || c.url.startsWith(`${BASE}/series/`)), 'chapter addresses are in the folder');
  assert.equal((await source.pages('t/chapter-2')).pages.length, 1);
  assert.ok(asked.every((url) => !/\/manga\//.test(url.replace('/manga-genre/', ''))), `nothing was asked in /manga/: ${asked.join(' ')}`);
  // A card that points into another folder is not a title of this site.
  const other = load(buildSource({ engine: 'madara', base: BASE, name: 'Folder Example', genres: GENRES, subpath: 'series' }).code, { pages: { [`${BASE}/series/?m_orderby=views`]: LIST(card('top', 'Top Title')) } });
  assert.deepEqual((await other.source.search('', 1, 'views')).results, []);
});

test('MangaThemesia with another folder: the list, the cards, the details and the chapters are asked in that folder', async () => {
  const card2 = (slug, title) => MST_CARD(slug, title).replace('/manga/', '/komik/');
  const pages = {
    [`${BASE}/komik/?page=1&order=popular`]: MST_LIST(card2('top', 'Top')),
    [`${BASE}/komik/t/`]: MST_TITLE(),
  };
  const { source, asked } = load(buildSource({ engine: 'mangathemesia', base: BASE, name: 'Folder Example', genres: GENRES, subpath: 'komik' }).code, { pages });
  const list = await source.search('', 1, 'views');
  assert.deepEqual(list.results.map((r) => [r.id, r.url]), [['top', `${BASE}/komik/top/`]]);
  assert.equal((await source.mangaDetails('t')).url, `${BASE}/komik/t/`);
  assert.ok(asked.every((url) => !/\/manga\//.test(url)), `nothing was asked in /manga/: ${asked.join(' ')}`);
});

test('discovery asks the genres of the folder the site really uses, not /manga/', async () => {
  const asked = [];
  const read = async (url) => { asked.push(url); return url.endsWith('/series/') ? '<form><input name="genre[]" value="act" id="g1"><label for="g1">Action (3)</label></form>' : '<html><title>Home - Folder Site</title></html>'; };
  const found = await discoverMangaThemesia(BASE, read, 'series');
  assert.deepEqual(found.genres, [{ name: 'Action', slug: 'act' }]);
  assert.ok(asked.includes(`${BASE}/series/`) && !asked.includes(`${BASE}/manga/`));
  const madara = await discoverMadara(BASE, read, 'series');
  assert.ok(asked.includes(`${BASE}/series/`) && madara.name === 'Folder Site');
});

// ── The MangaThemesia / Mangastream template ───────────────────────────────

const mst = (extra = {}) => buildSource({ engine: 'mangathemesia', base: BASE, name: 'Stream Example', genres: GENRES, ...extra });
const MST_CARD = (slug, title) => `<div class="bs"><div class="bsx"><a href="${BASE}/manga/${slug}/" title="${title}"><div class="limit"><img src="/covers/${slug}.jpg"></div><div class="tt">${title}</div></a></div></div>`;
const MST_LIST = (cards, next = '') => `<html><body><div class="listupd">${cards}</div>${next}</body></html>`;
const MST_TITLE = (extra = '') => `<html><body><h1 class="entry-title">The Title</h1><div class="thumb"><img src="/covers/t.jpg"></div><div class="mgen"><a>Action</a></div><div class="tsinfo"><div class="imptdt">Status <i>Ongoing</i></div><div class="imptdt">Author <i>Someone</i></div></div><div class="entry-content" itemprop="description"><p>A story.</p></div><div id="chapterlist"><ul><li><a href="${BASE}/t-one-chapter-2/"><span class="chapternum">Chapter 2</span><span class="chapterdate">October 28, 2026</span></a></li><li><a href="${BASE}/t-one-chapter-1/"><span class="chapternum">Chapter 1</span><span class="chapterdate">October 1, 2025</span></a></li></ul></div>${extra}</body></html>`;

test('the Mangastream template is a source like any other, and it fits a site that has the theme\'s markup and not one that has not', () => {
  const out = mst();
  assert.equal(out.id, 'mangas');
  assert.deepEqual(analyzeSourceCode(out.code).risks, []);
  const { source } = load(out.code);
  assert.deepEqual(checkSourceContract(source, 'mangas').errors, []);
  assert.deepEqual(checkFit('mangathemesia', { detail: MST_TITLE(), list: MST_LIST(MST_CARD('a', 'A')), search: '' }), { fits: true, missing: [] });
  assert.deepEqual(checkFit('mangathemesia', { detail: '<h1>x</h1>', list: '<div></div>', search: '' }).missing, ['the title on a title page', 'the chapter list on a title page', 'the cards of the title list']);
});

test('Mangastream: the list and the search are asked the way the theme documents, a text search that robots.txt forbids is a scan of the list', async () => {
  const pages = {
    [`${BASE}/manga/?page=1&order=update`]: MST_LIST(MST_CARD('one', 'One'), '<div class="hpage"><a class="r" href="?page=2">Next</a></div>'),
    [`${BASE}/manga/?page=1&order=popular`]: MST_LIST(MST_CARD('top', 'Top')),
    [`${BASE}/?s=hero`]: MST_LIST(MST_CARD('hero-one', 'Hero One')),
    [`${BASE}/manga/?page=1&order=title`]: MST_LIST(MST_CARD('alpha', 'Alpha') + MST_CARD('beta-hero', 'Beta Hero')),
    [`${BASE}/manga/?page=1&order=update&genre%5B%5D=action`]: MST_LIST(MST_CARD('act', 'Act')),
  };
  const open = load(mst().code, { pages }).source;
  const a = await open.search('', 1);
  assert.equal(a.results[0].id, 'one');
  assert.equal(a.hasNextPage, true);
  assert.equal(a.results[0].title, 'One');
  assert.equal((await open.search('', 1, 'views')).results[0].id, 'top');
  assert.equal((await open.search('hero', 1)).results[0].id, 'hero-one');
  assert.equal((await open.byGenres(['Action'])).results[0].id, 'act');
  assert.deepEqual((await open.byGenres(['Loli'])).results, []);
  const scanning = load(mst({ textSearch: false }).code, { pages });
  assert.deepEqual((await scanning.source.search('hero', 1)).results.map((r) => r.id), ['beta-hero']);
  assert.ok(scanning.asked.every((u) => !/[?&]s=/.test(u)), 'the forbidden search was never asked');
});

test('Mangastream: details, chapters (ids that are the chapter\'s own address), and pages from the reader script or the reader area', async () => {
  const images = [1, 2, 3].map((i) => `"https:\\/\\/cdn.example\\/ch\\/${i}.webp"`).join(',');
  const reader = `<html><body><div id="readerarea"></div><script>ts_reader.run({"post_id":1,"sources":[{"source":"S1","images":[${images}]}]});</script></body></html>`;
  const readerArea = '<html><body><div id="readerarea"><img data-src="https://cdn.example/a/1.jpg" src="/x/Loading.gif"><img src="https://cdn.example/a/2.jpg"></div></body></html>';
  const pages = { [`${BASE}/manga/t-one/`]: MST_TITLE(), [`${BASE}/t-one-chapter-1/`]: reader, [`${BASE}/t-one-chapter-2/`]: readerArea, [`${BASE}/t-one-chapter-9/`]: '<html><body>another page</body></html>' };
  const { source } = load(mst().code, { pages });
  const d = await source.mangaDetails('t-one');
  assert.deepEqual([d.title, d.status, d.author, d.description, d.genres], ['The Title', 'ongoing', 'Someone', 'A story.', ['Action']]);
  const c = await source.chapters('t-one');
  assert.deepEqual(c.chapters.map((x) => x.id), ['t-one-chapter-2', 't-one-chapter-1']);
  assert.equal(c.chapters[0].chapter, '2');
  assert.deepEqual((await source.pages('t-one-chapter-1')).pages.length, 3);
  assert.deepEqual((await source.pages('t-one-chapter-2')).pages.length, 2, 'a loading picture is not a page');
  await assert.rejects(source.pages('t-one-chapter-9'), (e) => e.statusCode === 404);
  for (const bad of ['../../etc/passwd', 'a/b', '']) await assert.rejects(source.pages(bad), (e) => e.statusCode === 400, bad);
  await assert.rejects(source.mangaDetails('../x'), (e) => e.statusCode === 400);
});

test('Mangastream discovery reads the filter\'s genres', () => {
  const { mangaThemesiaGenresFrom } = require('../../server/modules/source-import/generator/discover');
  const form = '<ul class="genrez"><li><input type="checkbox" name="genre[]" value="academy" id="a"><label for="a">Academy</label></li><li><input type="checkbox" name="genre[]" value="slice-of-life" id="b"><label for="b">Slice of Life</label></li></ul>';
  assert.deepEqual(mangaThemesiaGenresFrom(form), [{ name: 'Academy', slug: 'academy' }, { name: 'Slice of Life', slug: 'slice-of-life' }]);
});

// ── What the third real site taught (a site that forbids its text search, keeps its newest chapters for subscribers) ──

test('a chapter the site keeps back is a 403 that says so, not a missing chapter (both templates)', async () => {
  const lockedPage = '<html><body><div id="readerarea" class="reading-content"><p>This chapter is locked. Unlock it with coins.</p></div></body></html>';
  const madara = load(generated().code, { pages: { [`${BASE}/manga/t-one/chapter-5/?style=list`]: lockedPage } }).source;
  await assert.rejects(madara.pages('t-one/chapter-5'), (e) => e.statusCode === 403 && /locked/.test(e.message));
  const stream = load(mst().code, { pages: { [`${BASE}/t-one-chapter-5/`]: lockedPage } }).source;
  await assert.rejects(stream.pages('t-one-chapter-5'), (e) => e.statusCode === 403 && /locked/.test(e.message));
});

test('a search that robots.txt forbids reads the list once and keeps it: the second search asks nothing', async () => {
  const pages = { [`${BASE}/manga/?page=1&order=title`]: MST_LIST(MST_CARD('alpha', 'Alpha') + MST_CARD('beta-hero', 'Beta Hero')) };
  const { source, asked } = load(mst({ textSearch: false }).code, { pages });
  assert.equal((await source.search('hero', 1)).results.length, 1);
  const first = asked.length;
  assert.equal((await source.search('alpha', 1)).results[0].id, 'alpha');
  assert.equal(asked.length, first, 'the index answered');
});

test('chapter dates that are only a day keep the day even when several chapters came out on it', async () => {
  const sameDay = [1, 2, 3, 4, 5].map((i) => `<li><a href="${BASE}/t-one-chapter-${i}/"><span class="chapternum">Chapter ${i}</span><span class="chapterdate">October 28, 2025</span></a></li>`).join('');
  const html = MST_TITLE().replace(/<div id="chapterlist">[\s\S]*<\/div>/, `<div id="chapterlist"><ul>${sameDay}</ul></div>`);
  const { source } = load(mst().code, { pages: { [`${BASE}/manga/t-one/`]: html } });
  const dates = (await source.chapters('t-one')).chapters.map((c) => c.publishAt);
  assert.equal(dates.filter(Boolean).length, 5, 'a batch of day-only dates is not a batch import');
});

test('the live Test reads the next chapter when the newest ones are locked on the site, and says which; a locked oldest or a real failure still fails', async () => {
  const { runner, statusOf, detailOf, fakeSource, refused } = require('../helpers/live-test-rig');
  const real = (n) => Array.from({ length: n }, (_, i) => ({ index: i, img: `https://cdn.example/${n}/${i}.webp` }));
  const locked = (id) => { throw refused(`chapter "${id}" is locked on the site`, 403); };
  const mod = fakeSource({ pages: async (id) => { if (String(id).includes('..')) throw refused('invalid id', 400); if (id === 'c5' || id === 'c4') return locked(id); return { pages: real(4) }; } });
  const result = await runner(mod)();
  assert.equal(statusOf(result, 'pages'), 'pass', detailOf(result, 'pages'));
  assert.match(detailOf(result, 'pages'), /chapter 3 from the top \(the newest are locked on the site\)/);
  const allLocked = fakeSource({ pages: async (id) => { if (String(id).includes('..')) throw refused('invalid id', 400); return locked(id); } });
  assert.equal(statusOf(await runner(allLocked)(), 'pages'), 'fail', 'three locked chapters in a row are still a source that cannot be read');
  const broken = fakeSource({ pages: async (id) => { if (String(id).includes('..')) throw refused('invalid id', 400); throw new Error('boom'); } });
  assert.equal(statusOf(await runner(broken)(), 'pages'), 'fail');
});

// ── Never-listed titles are kept out of every list, not only the genre names (both templates) ──

test('Madara: the titles of the site\'s never-listed genre are read from its genre pages and left out of the lists, the search and the details', async () => {
  const pages = {
    [`${BASE}/manga/?m_orderby=latest`]: LIST(card('good', 'Good') + card('bad', 'Bad Title')),
    [`${BASE}/?s=title&post_type=wp-manga`]: LIST(card('bad', 'Bad Title') + card('fine', 'Fine Title')),
    [`${BASE}/manga-genre/loli/?m_orderby=latest`]: LIST(card('bad', 'Bad Title'), '<a class="nextpostslink" href="#">n</a>'),
    [`${BASE}/manga-genre/loli/page/2/?m_orderby=latest`]: LIST(card('bad2', 'Bad Two')),
    [`${BASE}/manga-genre/oppai-shota/?m_orderby=latest`]: LIST(''),
    [`${BASE}/manga/bad/`]: TITLE('Bad Title'),
  };
  const { source, asked } = load(generated().code, { pages });
  assert.deepEqual((await source.search('', 1)).results.map((r) => r.id), ['good']);
  assert.deepEqual((await source.search('title', 1)).results.map((r) => r.id), ['fine']);
  await assert.rejects(source.mangaDetails('bad'), (e) => e.statusCode === 404, 'a title of that genre is not found, whatever its page says');
  await assert.rejects(source.chapters('bad'), (e) => e.statusCode === 404);
  const reads = asked.filter((u) => /manga-genre\/loli\/$|manga-genre\/loli\/\?/.test(u)).length;
  assert.equal(reads, 1, 'the genre page is read once and kept');
});

test('Madara: if a never-listed genre page cannot be read, the source refuses to list instead of listing without the exclusion', async () => {
  const pages = { [`${BASE}/manga/?m_orderby=latest`]: LIST(card('good', 'Good')) };
  const { source } = load(generated().code, { pages }); // the genre pages answer 404 in the stub... so it is "no such page", not a failure
  assert.deepEqual((await source.search('', 1)).results.map((r) => r.id), ['good'], 'a genre page that is a 404 holds no titles');
  const broken = load(generated().code, { pages: { [`${BASE}/manga/?m_orderby=latest`]: LIST(card('good', 'Good')), [`${BASE}/manga-genre/loli/?m_orderby=latest`]: new Error('HTTP 503') } });
  await assert.rejects(broken.source.search('', 1), /503/, 'listing without the exclusion is refused');
});

test('Mangastream: the same exclusion, through the list filter of the theme', async () => {
  const pages = {
    [`${BASE}/manga/?page=1&order=update`]: MST_LIST(MST_CARD('good', 'Good') + MST_CARD('bad', 'Bad Title')),
    [`${BASE}/manga/?page=1&order=update&genre%5B%5D=loli`]: MST_LIST(MST_CARD('bad', 'Bad Title')),
    [`${BASE}/manga/?page=1&order=update&genre%5B%5D=oppai-shota`]: MST_LIST(''),
    [`${BASE}/manga/bad/`]: MST_TITLE(),
  };
  const { source } = load(mst().code, { pages });
  assert.deepEqual((await source.search('', 1)).results.map((r) => r.id), ['good']);
  await assert.rejects(source.mangaDetails('bad'), (e) => e.statusCode === 404);
  assert.ok(buildSource({ engine: 'mangathemesia', base: BASE, genres: GENRES }).neverListedGenres === 2);
});

test('a site with no never-listed genre costs nothing extra: no genre page is ever asked for', async () => {
  const pages = { [`${BASE}/manga/?m_orderby=latest`]: LIST(card('a', 'A')) };
  const out = buildSource({ engine: 'madara', base: BASE, name: 'M', genres: [{ name: 'Action', slug: 'action' }] });
  assert.equal(out.neverListedGenres, 0);
  const { source, asked } = load(out.code, { pages });
  await source.search('', 1);
  assert.deepEqual(asked, [`${BASE}/manga/?m_orderby=latest`]);
});

// ── A site that presents itself as adult-only says so in its declaration ──

test('a site that calls itself adult, or shows an age check, is declared adult-only; a general site with an "Adult" genre is not', () => {
  const { looksAdultOnly } = require('../../server/modules/source-import/generator/discover');
  assert.equal(looksAdultOnly('<html><head><title>Best Hentai Manga - Example</title></head></html>'), true);
  assert.equal(looksAdultOnly('<html><head><title>Example</title><meta name="description" content="Read adult manga online, 18+ only"></head></html>'), true);
  assert.equal(looksAdultOnly('<html><head><title>Example Scans</title></head></html>', { ageGate: true }), true);
  assert.equal(looksAdultOnly('<html><head><title>Example Scans - Manhwa</title><meta name="description" content="Read manhwa online"></head><body>Genres: Action, Adult, Drama</body></html>'), false);
  const flagged = buildSource({ engine: 'madara', base: BASE, name: 'X', genres: GENRES, adultOnly: true });
  assert.equal(flagged.adultOnly, true);
  const ui = sanitizeSourceUi(readDeclaredUiLiteral(flagged.code).value, { knownHosts: new Set(['mangas.example']) });
  assert.equal(ui.ui.adultOnly, true);
  assert.equal(sanitizeSourceUi(readDeclaredUiLiteral(generated().code).value, { knownHosts: new Set(['mangas.example']) }).ui.adultOnly, undefined);
});
