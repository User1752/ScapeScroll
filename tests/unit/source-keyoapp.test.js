'use strict';

// The Keyoapp template (first version of the theme: server-rendered pages) and its detection (generator/keyoapp.template.txt, api-engines.js, discoverKeyoapp).
// The pages are hand-written in the shape that was measured on a real site (the containers, the attributes that carry a title's tags, type and status, the
// chapter rows, the script that names the picture host). What matters: the list of every title is read once and filtered here, a never-listed category is out
// of every list, a chapter the site keeps back is not offered, pictures are joined to the host the page's own script names, ids are plain, and the newer
// versions of the theme are named and refused, not mistaken for this one.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { buildSource, supportedEngines } = require('../../server/modules/source-import/generator');
const { discoverKeyoapp, keyoappGenresFrom } = require('../../server/modules/source-import/generator/discover');
const { checkFit } = require('../../server/modules/source-import/generator/fit');
const { generateFromLink } = require('../../server/modules/source-import/generator/from-link');
const { detectApiEngine } = require('../../server/modules/source-import/api-engines');
const { analyzeSourceCode } = require('../../server/modules/source-import/static-report');
const { checkSourceContract } = require('../../server/modules/source-import/contract');
const fetchUtils = require('../../server/modules/network/fetch-utils');

const ROOT = path.join(__dirname, '..', '..');
const BASE = 'https://keyo.example';
const GENRES = [{ name: 'Action', slug: 'action' }, { name: 'Slice of Life', slug: 'slice-of-life' }, { name: 'Loli', slug: 'loli' }];
const built = (over = {}) => buildSource({ engine: 'keyoapp', base: BASE, name: 'Keyo Example', genres: GENRES, ...over });

function load(code, pages) {
  const real = fetchUtils.fetchText;
  const asked = [];
  fetchUtils.fetchText = async (url) => {
    asked.push(url.replace(BASE, ''));
    const hit = pages[url.replace(BASE, '')];
    if (hit === undefined) throw new Error('HTTP 404');
    if (hit instanceof Error) throw hit;
    return hit;
  };
  try {
    const file = path.join(ROOT, 'data', 'sources', '__keyoapp_test__.js');
    const mod = new Module(file, null);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod._compile(code, file);
    return { source: mod.exports, asked };
  } finally {
    fetchUtils.fetchText = real;
  }
}

const button = (slug, title, { tags = ['action'], type = 'manhwa', status = 'ongoing' } = {}) => `<button id="x${slug}" alt="${title}" title="${title}" tags='${JSON.stringify(tags)}' data-type="${type}" data-status="${status}" class="group"><a href="/series/${slug}/" alt="${title}" title="${title}"><div class="relative"><div class="bg-cover" style="background-image: url('https://cdn.example/${slug}.jpg')"></div><div class="font-bold">${title}</div></div></a></button>`;
const DROPDOWN = '<script>initializeDropdownMenu({ type: "type", items: [{ value:"manhwa", displayName:"Manhwa" }] }); initializeDropdownMenu({ type: "genre", placeholder: "Genre", multi: true, items: [{ value:"action", displayName:"Action" }, { displayName:"Slice of Life", value:"slice-of-life" }, { value:"loli", displayName:"Loli" } ] });</script>';
const SERIES = (buttons) => `<html><body>${DROPDOWN}<div id="searched_series_page">${buttons}</div></body></html>`;
const latestCard = (slug, title) => `<div class="group latest-poster"><a href="/series/${slug}/" title="${title}" style="background-image: url('https://cdn.example/${slug}.jpg')"></a><div><a href="/series/${slug}/" title="${title}"></a></div></div>`;
const LATEST = (cards) => `<html><body><div class="grid">${cards}</div></body></html>`;
const row = (slug, name, date, extra = '') => `<a class="group" href="/chapter/${slug}/" title="${name}"><div><span class="flex"><span class="text-sm">${name}</span>${extra}</span><div><span class="text-xs">${date}</span></div></div></a>`;
const DETAIL = (rows, extra = '') => `<html><body><div class="grid"><h1>The Title</h1></div><div class="photoURL" style="background-image: url('https://cdn.example/t.jpg')"></div><div id="expand_content"><p>One &amp; two</p></div><div><div class="font-medium"><span>Status</span></div><div>ongoing</div></div><div><div><span>Author</span></div><div>Someone</div></div><div><div><span>Artist</span></div><div>Someone</div></div><div><div class="grid"><h1>x</h1><a href="/series?genre=action">Action,</a><a href="/series?genre=slice-of-life">Slice of Life</a></div></div>${extra}<div id="chapters">${rows}</div></body></html>`;
const CHAPTER = (imgs, script = '<script>let realUrl = `https://pics.example/uploads/${uid}`</script>') => `<html><body>${script}<div id="pages">${imgs}</div></body></html>`;

// ── the file ─────────────────────────────────────────────────────────────

test('the template is a source like any other, and the genres are written as literals with the value the site uses', () => {
  assert.ok(supportedEngines().includes('keyoapp'));
  const out = built();
  assert.deepEqual(analyzeSourceCode(out.code).risks, []);
  const { source } = load(out.code, {});
  assert.deepEqual(checkSourceContract(source, 'keyo').errors, []);
  assert.ok(out.code.includes('"action":"action"') && out.code.includes('"slice of life":"slice-of-life"'));
  assert.match(out.code, /^\/\/ scrollscape-generated engine=keyoapp base=https:\/\/keyo\.example on=\d{4}-\d{2}-\d{2}$/m);
});

// ── lists and search ─────────────────────────────────────────────────────

test('the list of every title is read once and filtered here: search by text, the latest order, A to Z, and pages of 24', async () => {
  const many = Array.from({ length: 30 }, (_, i) => button(`t${i}`, `Title ${String(i).padStart(2, '0')}`)).join('');
  const pages = { '/series': SERIES(button('hero', 'Hero One') + button('zed', 'Zed Story', { type: 'novel' }) + button('bad', 'Bad', { tags: ['loli'] }) + button('apple', 'Apple') + button('x-y', 'Quote\'s')), '/latest/': LATEST(latestCard('apple', 'Apple') + latestCard('hero', 'Hero One') + latestCard('zed', 'Zed Story') + latestCard('apple', 'Apple') + latestCard('gone', 'Not in the list')) };
  const { source, asked } = load(built().code, pages);
  assert.deepEqual((await source.search('hero')).results.map((r) => r.id), ['hero'], 'a title the text matches');
  assert.deepEqual((await source.search('')).results.map((r) => r.id), ['apple', 'hero'], 'the latest order, only titles that are in the list, once each, no novel');
  assert.deepEqual((await source.search('', 1, 'title')).results.map((r) => r.id), ['apple', 'hero', 'x-y'], 'A to Z, without the novel and the never-listed one');
  assert.deepEqual((await source.search('Bad')).results, [], 'a never-listed title is not in any list');
  assert.equal(asked.filter((u) => u === '/series').length, 1, 'the list of every title was read once');
  const big = load(built().code, { '/series': SERIES(many) });
  const first = await big.source.search('', 1, 'title');
  assert.equal(first.results.length, 24);
  assert.equal(first.hasNextPage, true);
  const second = await big.source.search('', 2, 'title');
  assert.equal(second.results.length, 6);
  assert.equal(second.hasNextPage, false);
  assert.match(first.results[0].cover, /proxy-image/);
  assert.equal(first.results[0].url, `${BASE}/series/t0/`);
  assert.equal(first.results[0].tags, undefined, 'the tags are not part of a card');
  assert.deepEqual(await source.search('loli collection'), { results: [], hasNextPage: false });
});

test('genres: every genre asked for has to be on the title; an unknown or never-listed one is nothing and asks nothing', async () => {
  const pages = { '/series': SERIES(button('a', 'A', { tags: ['action'] }) + button('b', 'B', { tags: ['action', 'slice-of-life'] }) + button('c', 'C', { tags: ['slice-of-life'] })) };
  const { source, asked } = load(built().code, pages);
  assert.deepEqual((await source.byGenres(['Action'])).results.map((r) => r.id), ['a', 'b']);
  assert.deepEqual((await source.byGenres(['action', 'Slice of Life'])).results.map((r) => r.id), ['b']);
  assert.deepEqual((await source.byGenres(['Slice of Life'])).results[0].genres, ['Action', 'Slice Of Life'], 'the name of a tag is the one the site gave the genre');
  const before = asked.length;
  for (const names of [['Nope'], ['Loli'], ['Action', 'Oppai Shota'], []]) assert.deepEqual(await source.byGenres(names), { results: [], hasNextPage: false }, JSON.stringify(names));
  assert.equal(asked.length, before);
  await assert.rejects(load(built().code, { '/series': '<html><body>no list here</body></html>' }).source.search('x'), /unexpected shape/);
});

// ── details, chapters, pages ─────────────────────────────────────────────

test('details: title, text, cover, status and authors read from the labels, genres from the filter links; a page that is not a title is 404; a bad id is 400', async () => {
  const { source } = load(built().code, { '/series/t/': DETAIL(''), '/series/none/': '<html><body><div class="grid"></div></body></html>' });
  const d = await source.mangaDetails('t');
  assert.deepEqual([d.id, d.title, d.status, d.author, d.url], ['t', 'The Title', 'ongoing', 'Someone', `${BASE}/series/t/`]);
  assert.equal(d.description, 'One & two');
  assert.deepEqual(d.genres, ['Action', 'Slice of Life']);
  assert.match(d.cover, /proxy-image/);
  await assert.rejects(source.mangaDetails('none'), (err) => err.statusCode === 404);
  for (const bad of ['../x', 'a/b', '', 'x y']) await assert.rejects(source.mangaDetails(bad), (err) => err.statusCode === 400, JSON.stringify(bad));
  const never = load(built().code, { '/series/x/': DETAIL('').replace('Action,', 'Loli,') });
  await assert.rejects(never.source.mangaDetails('x'), (err) => err.statusCode === 404);
});

test('chapters: newest first as the page lists them; paid and not-yet-out chapters are not offered; dates are real or null', async () => {
  const rows = row('t-3', 'Chapter 3', '2 hours ago') + row('t-2', 'Chapter 2', 'Mar 4, 2026') + row('t-paid', 'Chapter 9', '1 day ago', '<img alt="Coin" src="/c.png">') + row('t-soon', 'Chapter 10', 'soon', '<span>Upcoming</span>') + row('t-1', 'Chapter 1', '3 weeks ago') + row('t-3', 'Chapter 3', '2 hours ago');
  const { source } = load(built().code, { '/series/t/': DETAIL(rows) });
  const { chapters } = await source.chapters('t');
  assert.deepEqual(chapters.map((c) => c.id), ['t-3', 't-2', 't-1']);
  assert.deepEqual(chapters.map((c) => c.chapter), ['3', '2', '1']);
  assert.equal(chapters[0].url, `${BASE}/chapter/t-3/`);
  assert.ok(Date.now() - Date.parse(chapters[0].publishAt) < 3 * 3600 * 1000, 'hours ago is a real time');
  assert.equal(chapters[1].publishAt, new Date('Mar 4, 2026').toISOString(), 'a day is kept as the day');
  assert.equal(chapters[2].publishAt, null, 'weeks ago is not a publication date: never invented');
  await assert.rejects(load(built().code, { '/series/t/': DETAIL(row('t-p', 'Chapter 1', '1 day ago', '<img alt="Coin">')) }).source.chapters('t'), /no readable chapter/);
  await assert.rejects(load(built().code, { '/series/x/': '<html><body></body></html>' }).source.chapters('x'), (err) => err.statusCode === 404);
});

test('pages: the picture ids are joined to the host the page\'s own script names; locked or empty is refused; an id with a path is 400', async () => {
  const pages = {
    '/chapter/ok/': CHAPTER('<img uid="a/1.jpg"><img uid="b.webp"><img uid=""><img uid="../../x"><img uid="a b">'),
    '/chapter/old/': CHAPTER('<img src="https://cdn.example/1.jpg"><img data-src="/2.jpg">', '<script>nothing</script>'),
    '/chapter/nohost/': CHAPTER('<img uid="a.jpg">', '<script>nothing</script>'),
    '/chapter/locked/': '<html><body><div id="pages"></div><p>This chapter is locked for members</p></body></html>',
    '/chapter/none/': '<html><body><div id="pages"></div></body></html>',
  };
  const { source } = load(built().code, pages);
  const { pages: ok } = await source.pages('ok');
  assert.deepEqual(ok.map((p) => decodeURIComponent(p.img).replace(/^.*url=/, '')), ['https://pics.example/uploads/a/1.jpg', 'https://pics.example/uploads/b.webp']);
  assert.equal((await source.pages('old')).pages.length, 2, 'the older layout names the whole address');
  await assert.rejects(source.pages('nohost'), (err) => err.statusCode === 404, 'a picture id with no host is not guessed');
  await assert.rejects(source.pages('locked'), (err) => err.statusCode === 403);
  await assert.rejects(source.pages('none'), (err) => err.statusCode === 404);
  for (const bad of ['../../etc/passwd', 'a/b', '', 'x y']) await assert.rejects(source.pages(bad), (err) => err.statusCode === 400, JSON.stringify(bad));
});

// ── the fit, the genres, the detection ────────────────────────────────────

test('the markup of the theme fits; one without its containers does not, and says what is missing', () => {
  const fits = checkFit('keyoapp', { detail: DETAIL(''), list: SERIES(button('a', 'A')), search: '' });
  assert.deepEqual(fits, { fits: true, missing: [] });
  assert.deepEqual(checkFit('keyoapp', { detail: '<h1>x</h1>', list: '<div></div>', search: '' }).missing, ['the title on a title page', 'the chapter list on a title page', 'the cards of the title list']);
});

test('the genres are read from the dropdown script in whichever order its keys come, and a page without it has none', () => {
  assert.deepEqual(keyoappGenresFrom(SERIES('')), [{ name: 'Action', slug: 'action' }, { name: 'Slice of Life', slug: 'slice-of-life' }, { name: 'Loli', slug: 'loli' }]);
  for (const none of ['', undefined, '<html></html>', '<script>initializeDropdownMenu({ type: "type", items: [] })</script>']) assert.deepEqual(keyoappGenresFrom(none), [], String(none));
});

test('discovery reads the name from the home page and the genres from the series page, and says what it could not read', async () => {
  const found = await discoverKeyoapp(BASE, async (url) => (url.endsWith('/series') ? SERIES('') : '<html><head><title>Home - Keyo Example</title></head></html>'));
  assert.equal(found.name, 'Keyo Example');
  assert.equal(found.genres.length, 3);
  const down = await discoverKeyoapp(BASE, async () => { throw new Error('HTTP 500'); });
  assert.deepEqual(down.genres, []);
  assert.ok(down.notes.some((n) => /no genre list/.test(n)));
});

const answerWith = (pages) => async (url) => { const hit = pages[new URL(url).pathname]; return hit === undefined ? new Response('no', { status: 404 }) : new Response(hit, { status: 200 }); };

test('the first version is told by the series page\'s own containers; the newer version is named and refused; a page with neither is not this theme', async () => {
  const v1 = await detectApiEngine(BASE, { fetchImpl: answerWith({ '/series': SERIES(button('a', 'A') + button('b', 'B') + button('c', 'C')) }), userAgent: 'test', engines: undefined });
  assert.deepEqual([v1.id, v1.api, v1.unsupported], ['keyoapp', BASE, undefined]);
  assert.deepEqual(v1.robots, { checked: true, disallowed: [] });
  const ajax = async (url, init) => { const u = new URL(url); return u.pathname === '/' && u.search.includes('_ajax=search') ? new Response(JSON.stringify({ html: '<a class="group"></a>', has_more: true }), { status: 200 }) : answerWith({})(url, init); };
  const v2 = await detectApiEngine(BASE, { fetchImpl: ajax, userAgent: 'test' });
  assert.equal(v2.id, 'keyoapp');
  assert.match(v2.unsupported, /newer version of the Keyoapp theme/);
  const asked = [];
  await detectApiEngine(BASE, { fetchImpl: async (url, init) => { asked.push([url, init.headers['X-Requested-With']]); return new Response('no', { status: 404 }); }, userAgent: 'test' });
  assert.ok(asked.some(([url, header]) => url.includes('_ajax=search') && header === 'XMLHttpRequest'), 'the newer version is asked the way its own page asks');
  assert.ok(asked.some(([url, header]) => url.endsWith('/series') && header === undefined));
  const html = async (url) => (new URL(url).pathname === '/' ? new Response('<html>an ordinary page</html>', { status: 200 }) : new Response('no', { status: 404 }));
  assert.equal(await detectApiEngine(BASE, { fetchImpl: html, userAgent: 'test' }), null, 'a page that answers the ajax address with HTML is not the newer version');
  for (const other of ['<html><body>hello</body></html>', SERIES(button('a', 'A')), '<div id="searched_series_page"></div>']) {
    assert.equal(await detectApiEngine(BASE, { fetchImpl: answerWith({ '/series': other }), userAgent: 'test' }), null, other.slice(0, 40));
  }
  const closed = await detectApiEngine(BASE, { fetchImpl: async (url) => (url.endsWith('/robots.txt') ? new Response('User-agent: *\nDisallow: /chapter/\n') : answerWith({ '/series': SERIES(button('a', 'A') + button('b', 'B') + button('c', 'C')) })(url)), userAgent: 'test' });
  assert.deepEqual(closed.robots.disallowed, ['/chapter/'], 'the robots.txt of the site decides for a theme that is read from its pages');
});

// ── from a link ───────────────────────────────────────────────────────────

const PAGES = {
  [`${BASE}/`]: '<html><head><title>Home - Keyo Example</title></head><body></body></html>',
  [`${BASE}/series`]: SERIES(button('a', 'A') + button('b', 'B') + button('c', 'C')),
  [`${BASE}/series/t/`]: DETAIL(row('t-1', 'Chapter 1', '1 day ago')),
  [`${BASE}/series/a/`]: DETAIL(row('a-1', 'Chapter 1', '1 day ago')),
};
const probe = (over = {}) => async () => ({ verdict: 'open', engine: { id: 'htmx', name: 'htmx', confidence: 'low' }, reasons: [], robots: { checked: [] }, pages: [{ label: 'home', finalUrl: `${BASE}/` }, { label: 'detail', finalUrl: `${BASE}/series/t/` }], ...over });
const deps = (over = {}, pages = PAGES) => ({ probeSite: probe(), readPageText: async (url) => { if (pages[url] === undefined) throw new Error('HTTP 404'); return pages[url]; }, detectApiEngine: async () => ({ id: 'keyoapp', name: 'Keyoapp', api: BASE, evidence: 'x', robots: { checked: true, disallowed: [] } }), ...over });

test('from a link: a site of the first version gets a source written (its fit is checked on the series page and a title page); a page that does not fit, the newer version and a closed robots.txt are refused', async () => {
  const result = await generateFromLink('keyo.example', { deps: deps() });
  assert.equal(result.status, 'generated');
  assert.equal(result.engine, 'keyoapp');
  assert.equal(result.name, 'Keyo Example');
  assert.equal(result.genres, 2, 'the never-listed genre is not offered');
  assert.ok(!result.code.includes('const API'), 'a page-read engine has no API address');
  // The probe may have picked a chapter page as its "title page": the fit is checked on a title page taken from the series page.
  const chapterPick = await generateFromLink('keyo.example', { deps: deps({ probeSite: probe({ pages: [{ label: 'home', finalUrl: `${BASE}/` }, { label: 'detail', finalUrl: `${BASE}/chapter/t-1/` }] }) }) });
  assert.equal(chapterPick.status, 'generated');
  const unfit = await generateFromLink('keyo.example', { deps: deps({}, { ...PAGES, [`${BASE}/series`]: '<html><body><div class="card"></div></body></html>' }) });
  assert.equal(unfit.stage, 'fit');
  assert.match(unfit.message, /cards of the title list/);
  const newer = await generateFromLink('keyo.example', { deps: deps({ detectApiEngine: async () => ({ id: 'keyoapp', name: 'Keyoapp', api: BASE, evidence: 'x', unsupported: 'a newer version of the Keyoapp theme (its pages are filled in by scripts), which this app cannot read yet', robots: { checked: false, disallowed: [] } }) }) });
  assert.equal(newer.stage, 'engine');
  assert.match(newer.message, /built on a newer version of the Keyoapp theme/);
  assert.equal(newer.code, undefined);
  const closed = await generateFromLink('keyo.example', { deps: deps({ detectApiEngine: async () => ({ id: 'keyoapp', name: 'Keyoapp', api: BASE, evidence: 'x', robots: { checked: true, disallowed: ['/chapter/'] } }) }) });
  assert.equal(closed.stage, 'engine');
  assert.match(closed.message, /closes what a source has to read \(\/chapter\/ on keyo\.example\)/);
});
