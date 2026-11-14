'use strict';

// What the probe learns past the home page (source-import/site-probe.js with site-chapter.js and site-engines.js): which engine the
// site looks like, how a chapter delivers its images, and whether the image host wants a Referer. Pages are written by hand.

const test = require('node:test');
const assert = require('node:assert/strict');

const { probeSite } = require('../../server/modules/source-import/site-probe');
const { detectEngine } = require('../../server/modules/source-import/site-engines');

const page = (body, head = '') => `<!doctype html><html><head><title>A Site</title>${head}</head><body>${body}</body></html>`;
const anchors = (n, prefix) => Array.from({ length: n }, (_, i) => `<a href="${prefix}${i}">Title ${i}</a>`).join('');
const HOME = page(`<form action="/search" method="get"><input name="q"></form>${anchors(24, '/manga/title-')}`);
const TITLE = page(`<h1>Title</h1>${anchors(3, '/manga/title-0/chapter-')}<a href="/manga/other/chapter-9">other</a>${anchors(10, '/manga/title-')}`);
const chapterWith = (images, scripts = '') => page(`<div class="reading-content">${images}</div>${anchors(6, '/manga/title-')}${scripts}`);
const imgs = (n, attrs) => Array.from({ length: n }, (_, i) => `<div class="page-chapter"><img ${attrs(i)}></div>`).join('');

function siteOf(routes, imageAnswer = () => 200) {
  const seen = { images: [], pages: [] };
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    if (init.headers && init.headers.Range) { seen.images.push({ url, referer: init.headers.Referer || '' }); return new Response('x', { status: imageAnswer(init.headers.Referer || '', u), headers: { 'content-type': 'image/webp' } }); }
    seen.pages.push(u.pathname);
    const hit = routes[u.pathname + u.search] || routes[u.pathname];
    return hit === undefined ? new Response('missing', { status: 404 }) : new Response(hit, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  return { fetchImpl, seen };
}
const run = (routes, imageAnswer) => { const site = siteOf(routes, imageAnswer); return probeSite('https://manga.example/', { fetchImpl: site.fetchImpl, userAgent: 'ua', sleep: async () => {} }).then((result) => ({ result, seen: site.seen })); };
const base = (chapter) => ({ '/': HOME, '/search?q=a': HOME, '/manga/title-0': TITLE, '/manga/title-0/chapter-0': chapter, '/manga/title-0/chapter-2': chapter });
const ids = (result) => result.reasons.map((r) => r.id);

test('a chapter with its images in the HTML is read as inline, from the title\'s OWN chapters (not another title\'s), and the image host is asked with and without a Referer', async () => {
  const chapter = chapterWith(imgs(5, (i) => `src="https://cdn.example/${i}.webp"`));
  const { result, seen } = await run(base(chapter));
  const chapters = result.pages.filter((p) => p.label === 'chapter');
  assert.equal(chapters.length, 2);
  assert.deepEqual(chapters.map((p) => new URL(p.finalUrl).pathname), ['/manga/title-0/chapter-0', '/manga/title-0/chapter-2'], 'the first and the last chapter of this title; the link to another title is left out');
  assert.equal(chapters[0].chapter.kind, 'inline');
  assert.equal(chapters[0].chapter.real, 5);
  assert.ok(ids(result).includes('chapter-images-inline'));
  assert.ok(ids(result).includes('images-open'));
  assert.deepEqual(seen.images.map((i) => i.referer), ['', 'https://referer-check.invalid/']);
  assert.equal(result.verdict, 'open');
  assert.ok(result.requests <= 11);
});

test('a chapter that holds only placeholders and asks an endpoint for the images is "ajax", with the endpoint and the id, and a warning that says what to do', async () => {
  const chapter = chapterWith(imgs(3, () => 'src="/themes/x/images/Loading/Loading.gif"'), '<script>const CHAPTER_ID = 61636; $.post("/ajax/image/list/chap/" + CHAPTER_ID, function (e) {});</script>');
  const { result } = await run(base(chapter));
  assert.equal(result.pages.find((p) => p.label === 'chapter').chapter.kind, 'ajax');
  const warning = result.reasons.find((r) => r.id === 'chapter-images-ajax');
  assert.equal(warning.severity, 'warn');
  assert.equal(warning.chapterId, '61636');
  assert.match(warning.text, /ajax\/image\/list\/chap\/.*61636|61636/);
  assert.match(warning.text, /broken pages/);
  assert.ok(!ids(result).includes('images-open'), 'nothing to ask the image host about when there is no real image address');
});

test('chapters served in different ways are flagged, and no image found at all is "unconfirmed"', async () => {
  const inline = chapterWith(imgs(4, (i) => `src="https://cdn.example/${i}.webp"`));
  const lazy = chapterWith(imgs(3, () => 'src="/Loading.gif"'), '<script>chapter_id = 7; fetch("/api/chapter/images");</script>');
  const mixed = await run({ ...base(inline), '/manga/title-0/chapter-2': lazy });
  assert.ok(ids(mixed.result).includes('chapter-images-mixed'));
  assert.ok(ids(mixed.result).includes('chapter-images-ajax'));
  const none = await run(base(page(`<p>Not a reader</p>${anchors(6, '/x/')}`)));
  assert.ok(ids(none.result).includes('chapter-images-unconfirmed'));
});

test('an image host that wants the site\'s own Referer is reported with what to declare; one that refuses everything is reported too', async () => {
  const chapter = chapterWith(imgs(4, (i) => `src="https://cdn.example/${i}.webp"`));
  const needs = await run(base(chapter), (referer) => (referer === 'https://manga.example/' ? 200 : 403));
  assert.ok(ids(needs.result).includes('images-referer-required'));
  assert.match(needs.result.reasons.find((r) => r.id === 'images-referer-required').text, /imageReferers/);
  assert.deepEqual(needs.seen.images.map((i) => i.referer), ['', 'https://referer-check.invalid/', 'https://manga.example/']);
  const blocked = await run(base(chapter), () => 403);
  assert.ok(ids(blocked.result).includes('images-blocked'));
  const foreign = await run(base(chapter), (referer) => (referer === 'https://referer-check.invalid/' ? 403 : 200));
  assert.ok(ids(foreign.result).includes('images-foreign-blocked'));
  assert.equal(foreign.result.verdict, 'open', 'a refused foreign Referer is information, not a verdict');
});

test('the images are never downloaded: one byte is asked for, and only the status is kept', async () => {
  const chapter = chapterWith(imgs(4, (i) => `src="https://cdn.example/${i}.webp"`));
  const asked = [];
  const site = siteOf(base(chapter));
  await probeSite('https://manga.example/', { fetchImpl: async (url, init) => { if (init.headers && init.headers.Range) asked.push(init.headers.Range); return site.fetchImpl(url, init); }, userAgent: 'ua', sleep: async () => {} });
  assert.ok(asked.length >= 2);
  assert.ok(asked.every((r) => r === 'bytes=0-0'));
});

test('the home page is read for its engine, which is named with its confidence and what to expect of it', async () => {
  const madara = page(`<body class="wp-manga">${anchors(20, '/manga/m-')}</body>`, '<link rel="stylesheet" href="/wp-content/themes/madara/style.css">');
  const { result } = await run({ '/': madara });
  assert.equal(result.engine.id, 'madara');
  assert.ok(ids(result).includes('engine'));
  assert.match(result.reasons.find((r) => r.id === 'engine').text, /Madara/);
});

test('engines: each family is recognised by its own signals, a specific engine beats generic WordPress, and an unknown site is just unknown', () => {
  assert.equal(detectEngine('<script>ts_reader.run({});</script><div id="readerarea"></div><div class="bsx"></div>').id, 'mangathemesia');
  assert.equal(detectEngine('<link href="/themes/nettruyen/a.css"><div class="page-chapter"></div><div id="image_container"></div>').confidence, 'high');
  assert.equal(detectEngine('<div class="row-content-chapter"></div><div class="container-chapter-reader"></div>').id, 'mangabox');
  assert.equal(detectEngine('<script id="__NEXT_DATA__" type="application/json">{}</script>').id, 'nextjs');
  assert.equal(detectEngine('<script>window.__NUXT__={}</script>').id, 'nuxt');
  assert.equal(detectEngine('<link href="/wp-content/themes/x/style.css">').id, 'wordpress');
  assert.equal(detectEngine('<link href="/wp-content/themes/madara/a.css"><div class="wp-manga"></div>').id, 'madara', 'specific beats generic WordPress');
  assert.equal(detectEngine('<html><body>hello</body></html>'), null);
  assert.equal(detectEngine(null), null);
  assert.equal(detectEngine('<script src="/_next/static/a.js"></script>', { 'x-powered-by': 'Next.js' }).confidence, 'medium');
});
