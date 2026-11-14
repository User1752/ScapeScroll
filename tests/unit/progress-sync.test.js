'use strict';

// The reading progress kept on the server, end to end: the real public/modules/progress-sync.js in a vm sandbox per BROWSER (each with
// its own localStorage and state), talking over HTTP to the real routes and service. What has to hold:
//  - nothing a browser has is lost the first time it meets the server, and nothing is taken away from the server then;
//  - a change made in one browser (a chapter read, unmarked, the place a manga was left at) reaches the other;
//  - what could not be sent (offline, tab closed) waits in localStorage and is sent later;
//  - a server with far less than the browser never overwrites it without the person choosing;
//  - a restored backup file replaces the server's copy;
//  - the chapters of a browser's first upload are not dated "today".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const progressRoutes = require('../../server/routes/progress');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'modules', 'progress-sync.js'), 'utf8');
const unref = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; };

async function startServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-progress-e2e-'));
  const service = progressRoutes.configure({ filePath: path.join(dir, 'reading-progress.json') });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  progressRoutes.registerProgressRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  // the service saves a little after a change and makes its folder if it is missing: let it finish before the folder goes
  t.after(async () => { await service.flush(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { port: server.address().port, service };
}

// One browser: its own localStorage and state, the real saveSettings() writes and hook. `storage` is what is already in localStorage
// (a restart is a new browser over the same storage).
function browser(port, storage = {}) {
  const store = storage;
  const requests = [];
  const b = { store, requests, renders: 0, offline: false, forceStatus: null };
  const state = {
    settings: {}, readChapters: new Set(), flaggedChapters: new Set(), lastReadChapter: {}, highestReadChapter: {}, lastReadPages: {}, lastReadPageTotals: {},
  };
  // what loadSettings() does with the keys
  const get = (k) => (k in store ? JSON.parse(store[k]) : null);
  if (get('scrollscapeReadChapters')) state.readChapters = new Set(get('scrollscapeReadChapters'));
  if (get('scrollscapeFlaggedChapters')) state.flaggedChapters = new Set(get('scrollscapeFlaggedChapters'));
  const prog = get('scrollscapeReadingProgress');
  if (prog) { state.lastReadPages = prog.pages; state.lastReadChapter = prog.chapters; state.highestReadChapter = prog.highestChapter; state.lastReadPageTotals = prog.pageTotals; }

  const context = {
    console, state, setTimeout: unref, clearTimeout, Response,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    dbg: new Proxy({}, { get: () => () => {} }),
    document: { addEventListener() {}, getElementById: () => null, visibilityState: 'visible' },
    window: { addEventListener() {} },
    showToast() {}, confirm: () => true,
    renderLibrary() { b.renders++; },
    fetch: async (url, opts = {}) => {
      if (b.offline) throw new TypeError('fetch failed');
      requests.push({ method: opts.method || 'GET', url, body: opts.body ? JSON.parse(opts.body) : null });
      if (b.forceStatus && opts.method === 'POST') return new Response('{}', { status: b.forceStatus, headers: { 'Content-Type': 'application/json' } });
      return fetch(`http://127.0.0.1:${port}${url}`, opts);
    },
  };
  // the real saveSettings(): the same four keys, then the sync hook
  context.saveSettings = () => {
    store.scrollscapeReadChapters = JSON.stringify([...state.readChapters]);
    store.scrollscapeFlaggedChapters = JSON.stringify([...state.flaggedChapters]);
    store.scrollscapeReadingProgress = JSON.stringify({ pages: state.lastReadPages, chapters: state.lastReadChapter, highestChapter: state.highestReadChapter, pageTotals: state.lastReadPageTotals });
    if (typeof context.progressSyncMarkDirty === 'function') context.progressSyncMarkDirty();
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'progress-sync.js' });
  b.ctx = context;
  b.state = state;
  b.read = () => [...state.readChapters].sort();
  b.init = () => context.progressSyncInit();
  b.flush = () => context.progressSyncFlushNow();
  b.markRead = (...keys) => { for (const k of keys) state.readChapters.add(k); context.saveSettings(); };
  b.unmark = (...keys) => { for (const k of keys) state.readChapters.delete(k); context.saveSettings(); };
  b.restart = () => browser(port, store);
  return b;
}

const seeded = (port, { read = [], last = {}, highest = {}, synced = false, extra = {} } = {}) => {
  const storage = {
    scrollscapeReadChapters: JSON.stringify(read),
    scrollscapeFlaggedChapters: '[]',
    scrollscapeReadingProgress: JSON.stringify({ pages: {}, chapters: last, highestChapter: highest, pageTotals: {} }),
    ...(synced ? { scrollscapeProgressSynced: '1' } : {}),
    ...extra,
  };
  return browser(port, storage);
};
const keys = (n, prefix = 'm') => Array.from({ length: n }, (_, i) => `${prefix}:ch-${i}`);
const today = () => Math.floor(Date.now() / 86_400_000);

test('the first browser uploads what it has (as read BEFORE, not today); an empty second one receives it and redraws', async (t) => {
  const { port, service } = await startServer(t);
  const a = seeded(port, { read: ['a:1', 'a:2', 'b:1'], last: { a: '2' }, highest: { a: 2 } });
  assert.equal((await a.init()).ok, true);

  assert.equal(service.status().initialized, true);
  assert.deepEqual(service.get().read.sort(), ['a:1', 'a:2', 'b:1']);
  assert.deepEqual(service.get().last.a.c, '2');
  assert.deepEqual([...service.readEntries().map(([, day]) => day)], [0, 0, 0], 'none of them is dated today');

  const b = seeded(port, {});
  const result = await b.init();
  assert.equal(result.changed, true);
  assert.deepEqual(b.read(), ['a:1', 'a:2', 'b:1']);
  assert.equal(b.state.lastReadChapter.a, '2');
  assert.equal(b.state.highestReadChapter.a, 2);
  assert.ok(b.renders >= 1, 'the library is drawn again with the new progress');
  assert.equal(JSON.parse(b.store.scrollscapeReadChapters).length, 3, 'and it is in this browser\'s own storage too');
});

test('a chapter read in one browser reaches the other (dated today), and so does unmarking it', async (t) => {
  const { port, service } = await startServer(t);
  const a = seeded(port, { read: ['a:1', 'a:2'] });
  await a.init();
  let b = seeded(port, {});
  await b.init();

  a.markRead('a:3');
  await a.flush();
  assert.ok(service.get().read.includes('a:3'));
  assert.equal(Object.fromEntries(service.readEntries())['a:3'], today(), 'a chapter read now is dated today');

  b = b.restart();
  await b.init();
  assert.deepEqual(b.read(), ['a:1', 'a:2', 'a:3']);

  a.unmark('a:1');
  await a.flush();
  b = b.restart();
  await b.init();
  assert.deepEqual(b.read(), ['a:2', 'a:3'], 'the unmark is not undone by the other browser still having the key');
});

test('what could not be sent waits in localStorage across a restart and is sent later; sending twice changes nothing', async (t) => {
  const { port, service } = await startServer(t);
  const a = seeded(port, { read: ['a:1'] });
  await a.init();

  a.offline = true;
  a.markRead('a:9');
  a.state.lastReadChapter.a = '9';
  a.ctx.saveSettings();
  await a.flush(); // cannot be sent
  assert.ok(JSON.parse(a.store.scrollscapeProgressQueue).length >= 1, 'it is in the queue, in localStorage');
  assert.ok(!service.get().read.includes('a:9'));

  const again = a.restart(); // the tab was closed and opened again, now online
  await again.init();
  assert.ok(again.read().includes('a:9'), 'the restarted browser still has it');
  await again.flush();
  assert.ok(service.get().read.includes('a:9'));
  assert.equal(service.get().last.a.c, '9');
  assert.equal(again.store.scrollscapeProgressQueue, undefined, 'and the queue is empty');

  const before = JSON.stringify(service.get());
  await service.applyOps({ readAdd: ['a:9'], last: { a: { c: '9', at: 1 } } });
  assert.equal(JSON.stringify({ ...service.get(), rev: 0 }), JSON.stringify({ ...JSON.parse(before), rev: 0 }), 'the same change again is a no-op');
});

test('the first time a browser meets a server that has progress, both only ADD: nothing is lost on either side', async (t) => {
  const { port, service } = await startServer(t);
  const a = seeded(port, { read: ['a:1', 'a:2'], last: { a: '2' }, highest: { a: 2 } });
  await a.init();

  // c has read other things (and also manga a, further on) and has never synced
  const c = seeded(port, { read: ['c:1', 'a:1', 'a:5'], last: { c: '1', a: '5' }, highest: { c: 1, a: 5 } });
  await c.init();

  assert.deepEqual(service.get().read.sort(), ['a:1', 'a:2', 'a:5', 'c:1'], 'the server gained what c had');
  assert.deepEqual(c.read(), ['a:1', 'a:2', 'a:5', 'c:1'], 'c gained what the server had');
  assert.equal(service.get().last.a.c, '2', 'where both have a place, the server\'s is kept (a browser has no times to compare)');
  assert.equal(service.get().last.c.c, '1');
  assert.equal(service.get().highest.a, 5, 'the highest number is the higher of the two');
  assert.equal(Object.fromEntries(service.readEntries())['c:1'], 0, 'c\'s old chapters are not dated today');
});

test('safety rail: a server with far less than the browser changes nothing until the person chooses', async (t) => {
  const { port, service } = await startServer(t);
  const e = seeded(port, { read: keys(10, 'old') });
  await e.init();

  const d = seeded(port, { read: keys(150), synced: true });
  const result = await d.init();
  assert.equal(result.conflict, true);
  assert.equal(d.read().length, 150, 'this browser keeps what it has');
  assert.equal(service.get().read.length, 10, 'and the server is not changed either');
  assert.equal(d.ctx.progressSyncStatus().conflict, true);
  assert.equal(d.ctx.progressSyncStatus().ready, false);

  d.markRead('m:new'); // while in conflict nothing is sent
  await d.flush();
  assert.equal(service.get().read.length, 10);

  const r = await d.ctx.progressSyncReplaceServerCopy();
  assert.equal(r.read, 151);
  assert.equal(service.get().read.length, 151);
  assert.equal(d.ctx.progressSyncStatus().conflict, false);
});

test('...and the other choice: this browser takes the server\'s progress', async (t) => {
  const { port, service } = await startServer(t);
  await seeded(port, { read: keys(10, 'old') }).init();
  const d = seeded(port, { read: keys(150), synced: true });
  assert.equal((await d.init()).conflict, true);
  const r = await d.ctx.progressSyncUseServerCopy();
  assert.equal(r.read, 10);
  assert.deepEqual(d.read(), service.get().read.sort());
  d.markRead('old:fresh');
  await d.flush();
  assert.ok(service.get().read.includes('old:fresh'), 'and from then on it syncs again');
});

test('a restored backup file replaces the server\'s progress on the next start', async (t) => {
  const { port, service } = await startServer(t);
  await seeded(port, { read: ['wrong:1', 'wrong:2', 'wrong:3'] }).init();
  const f = seeded(port, { read: ['right:1', 'right:2'], synced: true });
  f.ctx.progressSyncForceUploadOnNextStart();
  await f.init();
  assert.deepEqual(service.get().read.sort(), ['right:1', 'right:2']);
  assert.equal(f.store.scrollscapeProgressForceUpload, undefined, 'it happens once');
});

test('a big first upload goes in several requests, the first one carrying init, all of them marked as old reading', async (t) => {
  const { port, service } = await startServer(t);
  const a = seeded(port, { read: keys(4000) });
  await a.init();
  const posts = a.requests.filter((r) => r.method === 'POST');
  assert.ok(posts.length >= 3, `${posts.length} requests`);
  assert.equal(posts[0].body.ops.init, true);
  assert.ok(posts.every((p) => p.body.ops.legacy === true));
  assert.ok(posts.every((p) => p.body.ops.readAdd.length <= 1500));
  assert.equal(service.get().read.length, 4000);
});

test('where a manga was left: the newest place wins in every browser', async (t) => {
  const { port, service } = await startServer(t);
  const a = seeded(port, { read: ['m:1'], last: { m: '1' } });
  await a.init();
  const b = seeded(port, {});
  await b.init();

  a.state.lastReadChapter.m = '5';
  a.ctx.saveSettings();
  await a.flush();
  await new Promise((r) => setTimeout(r, 5));
  b.state.lastReadChapter.m = '9';
  b.ctx.saveSettings();
  await b.flush();

  assert.equal(service.get().last.m.c, '9');
  const a2 = a.restart();
  await a2.init();
  assert.equal(a2.state.lastReadChapter.m, '9');
});

test('a request the server will never accept is dropped; the ones behind it still go', async (t) => {
  const { port, service } = await startServer(t);
  const a = seeded(port, { read: ['a:1'] });
  await a.init();
  a.forceStatus = 400;
  a.markRead('a:2');
  await a.flush();
  assert.equal(JSON.parse(a.store.scrollscapeProgressQueue || '[]').length, 0, 'not kept for ever');
  a.forceStatus = null;
  a.markRead('a:3');
  await a.flush();
  assert.ok(service.get().read.includes('a:3'));
});

test('when the server cannot be reached at start the browser keeps working from its own copy', async (t) => {
  const { port } = await startServer(t);
  const a = seeded(port, { read: ['a:1', 'a:2'] });
  a.offline = true;
  const r = await a.init();
  assert.equal(r.ok, false);
  assert.deepEqual(a.read(), ['a:1', 'a:2'], 'nothing is lost or replaced');
  a.markRead('a:3');
  await a.flush();
  assert.deepEqual(a.read(), ['a:1', 'a:2', 'a:3']);
});

test('lowering one manga (from AniList\'s number) reaches the server, including the highest chapter, and the other browser and a restart', async (t) => {
  const { port, service } = await startServer(t);
  const k = keys(10, 'kingdom');
  const a = seeded(port, { read: [...k, 'other:1'], last: { kingdom: 'ch-9', other: '1' }, highest: { kingdom: 916, other: 1 } });
  await a.init();
  assert.equal(service.get().highest.kingdom, 916);

  await a.ctx.progressSyncLowerManga({ mangaId: 'kingdom', readRemove: k.slice(3), lastChapterId: 'ch-2', highest: 3 });

  assert.deepEqual(service.get().read.sort(), [...k.slice(0, 3), 'other:1'].sort(), 'only that manga loses chapters');
  assert.equal(service.get().highest.kingdom, 3, 'the highest goes DOWN too, although the server only ever raises it');
  assert.equal(service.get().last.kingdom.c, 'ch-2');
  assert.equal(service.get().highest.other, 1, 'the others are untouched');
  assert.equal(a.state.readChapters.size, 4);
  assert.equal(a.state.highestReadChapter.kingdom, 3);
  assert.equal(a.state.lastReadChapter.kingdom, 'ch-2');
  assert.equal(a.state.lastReadPages['kingdom:ch-2'], 0);

  // nothing is sent back as if it were a new change, and nothing is left waiting
  await a.flush();
  assert.equal(service.get().highest.kingdom, 3);
  assert.equal(service.get().read.length, 4);
  assert.equal(a.ctx.progressSyncStatus().pending, 0);

  const b = seeded(port, {});
  await b.init();
  assert.equal(b.state.highestReadChapter.kingdom, 3);
  assert.equal(b.read().length, 4);
  const again = a.restart();
  await again.init();
  assert.equal(again.state.highestReadChapter.kingdom, 3, 'a restart of the same browser keeps the lowered number');
});

test('lowering is refused before the browser is in step with the server, and a server that cannot be reached changes nothing here', async (t) => {
  const { port, service } = await startServer(t);
  const a = seeded(port, { read: keys(5, 'k'), highest: { k: 5 } });
  await assert.rejects(() => a.ctx.progressSyncLowerManga({ mangaId: 'k', readRemove: ['k:ch-4'], highest: 1 }), /not in step/);
  await a.init();
  a.offline = true;
  await assert.rejects(() => a.ctx.progressSyncLowerManga({ mangaId: 'k', readRemove: ['k:ch-4'], lastChapterId: 'ch-3', highest: 4 }));
  assert.equal(a.state.readChapters.size, 5, 'this browser still has what the server still has');
  assert.equal(a.state.highestReadChapter.k, 5);
  assert.equal(service.get().read.length, 5);
});
