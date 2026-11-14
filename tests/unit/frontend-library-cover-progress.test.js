'use strict';

// The ring under the library's side column that counts the covers as they load (public/modules/ui-library-cover-progress.js). What must hold:
//  - the count is of DISTINCT covers, the ones the browser already has count from the start, and a cover that fails is done too;
//  - at most a few are asked for at once, the top of the page first, and a newer draw of the library stops the one in progress;
//  - the ring appears only if loading takes more than a moment (a library in the cache never shows it), fills as covers arrive, stays a
//    little at 100% and goes; it is placed under the column, or above it when the window leaves no room.
// The real module runs in a vm sandbox with a fake page, manual timers and covers whose loading the test controls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const PUBLIC = path.join(MODULES, '..');
const SHOW = 350;
const HOLD = 700;

function locale(lang) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(MODULES, `i18n/locales/${lang}.js`), 'utf8'), ctx);
  return ctx.window.ScrollScapeI18nLocales[lang];
}
const EN = locale('en-GB');

// ── a page just big enough for the ring ─────────────────────────────────────

function fakeEl(tag = 'div') {
  const el = {
    tag, hidden: false, isConnected: true, style: {}, attrs: {}, text: {}, offsetHeight: 96,
    classes: new Set(),
    classList: { add: (c) => el.classes.add(c), remove: (c) => el.classes.delete(c), toggle: (c, on) => (on ? el.classes.add(c) : el.classes.delete(c)), contains: (c) => el.classes.has(c) },
    setAttribute: (k, v) => { el.attrs[k] = String(v); },
    querySelector: (sel) => el.parts[sel],
    parts: {},
  };
  for (const sel of ['.lcp-done', '.lcp-total', '.lcp-arc']) {
    const part = { attrs: {}, textContent: '', setAttribute: (k, v) => { part.attrs[k] = String(v); } };
    el.parts[sel] = part;
  }
  return el;
}

function sandbox({ panel = { width: 100, top: 100, bottom: 700 }, innerHeight = 900 } = {}) {
  const timers = [];
  const created = [];
  const loads = [];
  let nextId = 1;
  const ctx = {
    console, Math, Number, String, Object, Array, Map, Set, Promise, JSON,
    window: { innerHeight, addEventListener() {} },
    document: {
      createElement: () => { const el = fakeEl(); created.push(el); return el; },
      body: { appendChild() {} },
      getElementById: (id) => (id === 'librarySideActions' && panel ? { getBoundingClientRect: () => ({ ...panel, height: panel.bottom - panel.top }) } : null),
    },
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    escapeHtml: (s) => String(s),
    t: (key) => EN[key] ?? key,
  };
  ctx.window.innerHeight = innerHeight;
  Object.defineProperty(ctx, 'innerHeight', { get: () => innerHeight });
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(MODULES, 'ui-library-cover-progress.js'), 'utf8'), ctx, { filename: 'ui-library-cover-progress.js' });
  // covers whose loading the test controls: each call waits until the test finishes it
  ctx.lcpLoadImage = (src) => new Promise((resolve) => { loads.push({ src, finish: () => resolve('ok'), fail: () => resolve('failed') }); });
  return { ctx, timers, created, loads, fire: (ms) => { const t = timers.find((x) => x.ms === ms); if (t) { timers.splice(timers.indexOf(t), 1); t.fn(); } } };
}

const img = (src, ready = false, currentSrc = '') => ({ src, currentSrc, complete: ready, naturalWidth: ready ? 300 : 0 });
const grid = (images) => ({ querySelectorAll: () => images });
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

// ── the engine ──────────────────────────────────────────────────────────────

test('what is counted: distinct covers in page order, those the browser already has, and nothing without an address', () => {
  const { ctx } = sandbox();
  const found = ctx.lcpSources([img('/c/a.jpg', true), img('/c/b.jpg'), img('/c/b.jpg'), img(''), img('/c/c.jpg', false, '/c/c-real.jpg'), img('/c/d.jpg', true), null]);
  assert.deepEqual([...found.all], ['/c/a.jpg', '/c/b.jpg', '/c/c-real.jpg', '/c/d.jpg']);
  assert.deepEqual([...found.pending], ['/c/b.jpg', '/c/c-real.jpg']);
  assert.equal(found.ready, 2);
  const none = ctx.lcpSources([]);
  assert.deepEqual([[...none.all], [...none.pending], none.ready], [[], [], 0]);
});

test('the engine asks for a few at a time, top first, counts a failed cover as done, and reports each step from what was already there', async () => {
  const { ctx } = sandbox();
  const pending = Array.from({ length: 10 }, (_, i) => `/c/${i}.jpg`);
  const asked = [];
  let inFlight = 0;
  let peak = 0;
  const progress = [];
  const result = await ctx.lcpRun({
    pending, ready: 3, total: 13, concurrency: 4, isCurrent: () => true,
    load: async (src) => { asked.push(src); inFlight++; peak = Math.max(peak, inFlight); await tick(); inFlight--; return src === '/c/4.jpg' ? 'failed' : 'ok'; },
    onProgress: (done, total) => progress.push([done, total]),
  });
  assert.equal(result, 13, 'all 13 are done, the failed one included');
  assert.deepEqual(asked, pending, 'the order of the page');
  assert.equal(peak, 4, 'never more than asked for at once, and the pool was used');
  assert.deepEqual(progress[0], [3, 13], 'it starts from what the browser already had');
  assert.deepEqual(progress.map((p) => p[0]), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test('a newer draw stops the one in progress: no more covers are asked for and nothing more is reported', async () => {
  const { ctx } = sandbox();
  let current = true;
  const asked = [];
  const progress = [];
  const run = ctx.lcpRun({
    pending: Array.from({ length: 20 }, (_, i) => `/c/${i}.jpg`), ready: 0, total: 20, concurrency: 2, isCurrent: () => current,
    load: async (src) => { asked.push(src); await tick(); if (asked.length === 4) current = false; return 'ok'; },
    onProgress: (done) => progress.push(done),
  });
  await run;
  assert.ok(asked.length <= 6, `stopped soon after the switch (${asked.length} asked)`);
  assert.ok(progress.length <= 5);
  assert.deepEqual(await ctx.lcpRun({ pending: [], ready: 5, total: 5, concurrency: 6, isCurrent: () => true, load: async () => 'ok', onProgress() {} }), 5, 'nothing to load: done at once');
});

// ── the ring ────────────────────────────────────────────────────────────────

test('a library already in the cache shows nothing: no ring is even built', async () => {
  const s = sandbox();
  await s.ctx.libraryCoverProgressStart(grid([img('/c/a.jpg', true), img('/c/b.jpg', true)]));
  assert.equal(s.created.length, 0);
  assert.equal(s.timers.some((t) => t.ms === SHOW), false);
  await s.ctx.libraryCoverProgressStart(null);
  assert.equal(s.created.length, 0);
});

test('covers that load before the moment is up never show the ring', async () => {
  const s = sandbox();
  const run = s.ctx.libraryCoverProgressStart(grid([img('/c/a.jpg'), img('/c/b.jpg')]));
  await tick();
  s.loads.forEach((l) => l.finish());
  await run;
  assert.equal(s.created.length, 0, 'quick: nothing appeared');
  assert.equal(s.timers.some((t) => t.ms === SHOW), false, 'and the pending "show" was cancelled');
});

test('slow covers: the ring appears after the moment, fills as they arrive, says done/total, holds at 100% and goes', async () => {
  const s = sandbox();
  const images = [img('/c/ready.jpg', true), ...Array.from({ length: 8 }, (_, i) => img(`/c/${i}.jpg`))];
  const run = s.ctx.libraryCoverProgressStart(grid(images));
  await tick();
  assert.equal(s.created.length, 0, 'not yet: only after the moment');
  assert.equal(s.loads.length, 6, 'six are being asked for');

  s.loads[0].finish(); s.loads[1].fail();
  await tick();
  s.fire(SHOW);
  const ring = s.created[0];
  assert.equal(ring.hidden, false);
  assert.equal(ring.attrs.role, 'progressbar');
  assert.equal(ring.parts['.lcp-done'].textContent, '3', '1 it had + 2 that finished (one of them failed)');
  assert.equal(ring.parts['.lcp-total'].textContent, '/9');
  assert.equal(ring.attrs['aria-label'], 'Loading covers: 3 of 9');
  assert.equal(ring.attrs['aria-valuenow'], '3');
  const circumference = 2 * Math.PI * 18;
  assert.equal(Number(ring.parts['.lcp-arc'].attrs['stroke-dashoffset']), Number((circumference * (1 - 3 / 9)).toFixed(2)));
  assert.equal(ring.classes.has('is-done'), false);

  while (s.loads.some((l) => !l.finished)) { const l = s.loads.find((x) => !x.finished); l.finished = true; l.finish(); await tick(); }
  await run;
  assert.equal(ring.parts['.lcp-done'].textContent, '9');
  assert.equal(ring.classes.has('is-done'), true);
  assert.equal(Number(ring.parts['.lcp-arc'].attrs['stroke-dashoffset']), 0, 'the ring is full');
  assert.equal(ring.hidden, false, 'it stays a little at 100%');
  s.fire(HOLD);
  assert.equal(ring.classes.has('is-leaving'), true);
  s.fire(300);
  assert.equal(ring.hidden, true);
});

test('a newer draw of the library replaces the ring that was filling: the old run draws nothing more', async () => {
  const s = sandbox();
  const first = s.ctx.libraryCoverProgressStart(grid(Array.from({ length: 12 }, (_, i) => img(`/c/${i}.jpg`))));
  await tick();
  s.fire(SHOW);
  const ring = s.created[0];
  assert.equal(ring.parts['.lcp-total'].textContent, '/12');
  const second = s.ctx.libraryCoverProgressStart(grid([img('/c/x.jpg', true)])); // the new draw has everything already: the ring goes
  await tick();
  const before = ring.parts['.lcp-done'].textContent;
  s.loads.forEach((l) => l.finish());
  await first;
  await second;
  assert.equal(ring.parts['.lcp-done'].textContent, before, 'the old run did not draw after it was replaced');
  s.fire(0);
  assert.equal(ring.classes.has('is-leaving'), true, 'and the new draw sent the ring away');
});

test('the ring sits under the column, with its width and edge; above it when the window leaves no room', async () => {
  const roomy = sandbox({ panel: { width: 100, top: 140, bottom: 735 }, innerHeight: 890 });
  const run = roomy.ctx.libraryCoverProgressStart(grid([img('/c/a.jpg')]));
  await tick();
  roomy.fire(SHOW);
  const ring = roomy.created[0];
  assert.equal(ring.style.top, '745px', 'the column\'s bottom plus 10');
  assert.equal(ring.style.width, '100px');
  assert.equal(ring.style.right, '12px');
  roomy.loads.forEach((l) => l.finish());
  await run;

  const tight = sandbox({ panel: { width: 100, top: 200, bottom: 820 }, innerHeight: 860 });
  const run2 = tight.ctx.libraryCoverProgressStart(grid([img('/c/a.jpg')]));
  await tick();
  tight.fire(SHOW);
  assert.equal(tight.created[0].style.top, `${200 - 96 - 10}px`, 'no room below: above the column');
  tight.loads.forEach((l) => l.finish());
  await run2;

  const small = sandbox({ panel: { width: 100, top: -80, bottom: 540 }, innerHeight: 450 }); // the column fills the window: beside it, at the bottom
  const run4 = small.ctx.libraryCoverProgressStart(grid([img('/c/a.jpg')]));
  await tick();
  small.fire(SHOW);
  assert.equal(small.created[0].style.right, '122px', 'the column\'s width and gap, left of it');
  assert.equal(small.created[0].style.top, `${450 - 8 - 96 - 4}px`);
  small.loads.forEach((l) => l.finish());
  await run4;

  const none = sandbox({ panel: null });
  const run3 = none.ctx.libraryCoverProgressStart(grid([img('/c/a.jpg')]));
  await tick();
  none.fire(SHOW);
  none.loads.forEach((l) => l.finish());
  await run3; // a page with no column (another view) must not throw
});

// ── the wiring ──────────────────────────────────────────────────────────────

test('it is wired: after every draw of the library, with its stylesheet and script, and its words in English and Portuguese', () => {
  const lib = fs.readFileSync(path.join(MODULES, 'ui-library.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(lib, /setTimeout\(\(\) => \{ if \(typeof libraryCoverProgressStart === 'function'\) libraryCoverProgressStart\(\$\("library"\)\); \}, 0\);/);
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /css-modules\/library-cover-progress\.css/);
  assert.ok(html.indexOf('modules/ui-library-cover-progress.js') > html.indexOf('modules/ui-library.js'));
  const css = fs.readFileSync(path.join(PUBLIC, 'css-modules', 'library-cover-progress.css'), 'utf8');
  assert.match(css, /\.library-cover-progress \{[^}]*position: fixed;/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /pointer-events: none;/, 'never in the way of the column or the covers');
  for (const lang of ['en-GB', 'pt-PT']) {
    const table = locale(lang);
    for (const key of ['library.coverProgress.label', 'library.coverProgress.aria']) assert.ok(typeof table[key] === 'string' && table[key], `${lang} ${key}`);
    assert.match(table['library.coverProgress.aria'], /\{done\}.*\{total\}/);
  }
});

// ── the home page ───────────────────────────────────────────────────────────

test('on a page with no side column (the home page) the ring takes the bottom right corner', async () => {
  const s = sandbox({ panel: null, innerHeight: 800 });
  const run = s.ctx.libraryCoverProgressStart(grid([img('/c/a.jpg')]));
  await tick();
  s.fire(SHOW);
  const ring = s.created[0];
  assert.deepEqual([ring.style.right, ring.style.width, ring.style.top], ['16px', '84px', `${800 - 8 - 96 - 8}px`]);
  s.loads.forEach((l) => l.finish());
  await run;
  // A column that exists but is not on screen (the library is hidden) has no size: the same corner.
  const hidden = sandbox({ panel: { width: 0, top: 0, bottom: 0 }, innerHeight: 800 });
  const run2 = hidden.ctx.libraryCoverProgressStart(grid([img('/c/a.jpg')]));
  await tick();
  hidden.fire(SHOW);
  assert.equal(hidden.created[0].style.right, '16px');
  hidden.loads.forEach((l) => l.finish());
  await run2;
});

// a card of the home page: its image (or none), and whether it still has the "?" waiting for a cover
const card = ({ id, src, complete = false, placeholder = false } = {}) => ({
  dataset: id ? { sourceId: 's', mangaId: id } : {},
  querySelector: (sel) => (sel === 'img' ? (src === undefined ? null : { src, currentSrc: '', complete, naturalWidth: complete ? 300 : 0 }) : (placeholder ? {} : null)),
});

function homePage(ctx, { manga = [], anime = [], animeHidden = true } = {}) {
  const box = (cards, hidden) => ({ classList: { contains: (c) => hidden && c === 'hidden' }, querySelectorAll: () => cards });
  const boxes = { discoverMangaContent: box(manga, false), discoverAnimeContent: box(anime, animeHidden) };
  ctx.document.getElementById = (id) => boxes[id] || null; // no side column either
}

test('the home page has one slot per card: a card the auto-scroll cloned counts once, and the home that is not in use is not counted', () => {
  const { ctx } = sandbox();
  homePage(ctx, { manga: [card({ id: 'a', src: '/a.jpg' }), card({ id: 'a', src: '/a.jpg' }), card({ id: 'b', src: '/b.jpg' }), card({ src: '/x.jpg' })], anime: [card({ id: 'z', src: '/z.jpg' })] });
  assert.equal(ctx.homeCoverSlots().length, 3, 'a, b and the one with no id; the clone of a and the hidden anime home are not');
  homePage(ctx, { manga: [card({ id: 'a', src: '/a.jpg' })], anime: [card({ id: 'z', src: '/z.jpg' })], animeHidden: false });
  assert.equal(ctx.homeCoverSlots().length, 2, 'both homes when both are shown');
});

test('a card is done when its cover has loaded or failed, or when no cover is being looked for any more; the others are waiting', () => {
  const { ctx } = sandbox();
  const loaded = new Set(['/asked.jpg']);
  const cards = [
    card({ id: 'ready', src: '/ready.jpg', complete: true }),
    card({ id: 'asked', src: '/asked.jpg' }),
    card({ id: 'far', src: '/far.jpg' }),
    card({ id: 'search', placeholder: true }),
    card({ id: 'plain' }),
    card({ id: 'noaddress', src: '' }),
  ];
  const searching = ctx.homeCoverCount(cards, loaded, true);
  assert.deepEqual([searching.total, searching.done, [...searching.toLoad]], [6, 4, ['/far.jpg']], 'the one still searched for and the one not yet loaded wait');
  const over = ctx.homeCoverCount(cards, loaded, false);
  assert.deepEqual([over.total, over.done], [6, 5], 'once the search is over a "?" is final: done');
});

test('the count follows the cards: it shows after a moment, fills as covers load and as the search for the rest ends, and goes away', async () => {
  const s = sandbox({ panel: null, innerHeight: 800 });
  let searching = 1;
  s.ctx.homeHydrationActive = () => searching;
  const waiting = card({ id: 'far', src: '/far.jpg' });
  homePage(s.ctx, { manga: [card({ id: 'ready', src: '/ready.jpg', complete: true }), waiting, card({ id: 'search', placeholder: true })] });
  s.ctx.homeCoverProgressStart();
  assert.equal(s.loads.length, 1, 'the cover not yet loaded is asked for at once');
  assert.equal(s.created.length, 0, 'nothing is shown before the moment has passed');
  s.fire(400); // the next look: 400 ms in, past the 350 ms
  const ring = s.created[0];
  assert.equal(ring.hidden, false);
  assert.deepEqual([ring.parts['.lcp-done'].textContent, ring.parts['.lcp-total'].textContent], ['1', '/3']);
  s.loads[0].finish();
  await tick();
  s.fire(400);
  assert.equal(ring.parts['.lcp-done'].textContent, '2', 'the cover that was asked for is done');
  searching = 0; // the search for covers is over: the "?" stays
  s.fire(400);
  assert.deepEqual([ring.parts['.lcp-done'].textContent, ring.classes.has('is-done')], ['3', true]);
  s.fire(HOLD);
  s.fire(300);
  assert.equal(ring.hidden, true, 'and it goes away');
});

test('a home page that is already complete shows nothing, and a newer count (or the library) replaces the one in progress', async () => {
  const s = sandbox({ panel: null });
  s.ctx.homeHydrationActive = () => 0;
  homePage(s.ctx, { manga: [card({ id: 'a', src: '/a.jpg', complete: true })] });
  s.ctx.homeCoverProgressStart();
  assert.equal(s.created.length, 0);
  assert.equal(s.timers.length, 0, 'and nothing is looked at again');
  const t = sandbox({ panel: null });
  t.ctx.homeHydrationActive = () => 1;
  homePage(t.ctx, { manga: [card({ id: 'a', placeholder: true })] });
  t.ctx.homeCoverProgressStart();
  assert.equal(t.timers.length, 1);
  const first = t.timers[0];
  homePage(t.ctx, { manga: [] });
  t.ctx.homeCoverProgressStart(); // newer
  const scheduled = t.timers.length;
  first.fn(); // the old one wakes up: it sees it was replaced and does not look again
  assert.equal(t.timers.length, scheduled, 'no new look was scheduled by the replaced count');
  assert.equal(t.created.length, 0);
});

test('a row drawn is told from a cover swapped into a card that was already there, and the page is watched from its two contents', () => {
  const { ctx } = sandbox();
  assert.equal(ctx.homeCoverProgressIsRowDrawn([{ addedNodes: [{ nodeType: 1, classList: ['manga-card'] }] }]), true);
  assert.equal(ctx.homeCoverProgressIsRowDrawn([{ addedNodes: [{ nodeType: 1, classList: [] }] }, { addedNodes: [{ nodeType: 3 }] }]), false);
  assert.equal(ctx.homeCoverProgressIsRowDrawn([]), false);
  const src = fs.readFileSync(path.join(MODULES, 'ui-library-cover-progress.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /\['discoverMangaContent', 'discoverAnimeContent'\]\.map/);
  assert.match(src, /observe\(box, \{ childList: true, subtree: true \}\)/);
  assert.match(src, /view\.classList\.contains\('hidden'\)\)\) return; \/\/ another page is in use: no ring on it/);
  assert.equal(sandbox().ctx.homeCoverProgressWatch(), null, 'a page without MutationObserver is left alone');
  const discover = fs.readFileSync(path.join(MODULES, 'ui-discover.js'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(discover, /window\.homeHydrationActive = \(\) => _hydrationsRunning;/);
  assert.match(discover, /_hydrationsRunning\+\+;\s*try \{\s*await _hydrateMissingGenresRun\(container\);\s*\} finally \{\s*_hydrationsRunning--;/);
});
