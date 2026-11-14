'use strict';

// The local copy of the library's covers (server/modules/covers/service.js, routes/covers.js). What must hold:
//  - a cover is fetched once and kept; the page is told where (a map of address -> file) and only a name the index knows is ever served;
//  - the library is the only thing that decides what is kept: a cover that a title stops using (it was changed, or the title left the
//    library) is deleted, a cover two titles share stays until both are gone, and a title with a chosen cover keeps THAT one;
//  - nothing it fetches is trusted: not an image, empty or too large is refused, and a failure is left alone for a while, not hammered;
//  - when the store cannot say what the library is, nothing is deleted.
// A temporary folder and a fake image fetch: nothing here touches the network or the real library.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const {
  createLibraryCoverService, coverUrlKey, coverOverrideKey, effectiveCover, wantedCovers, refererHintFor, FILE_RE,
} = require('../../server/modules/covers/service');
const { createLibraryContentService } = require('../../server/modules/library/content-service');
const limitsFile = require('../../server/config/limits');
const coverRoutes = require('../../server/routes/covers');
const { StorageService } = require('../../server/store');

const LIMITS = { ...limitsFile, libraryCoverSpacingMs: 0, libraryCoverRetryMs: 1000, libraryCoverMaxBytes: 1000 };
const bytes = (n, fill = 7) => Buffer.alloc(n, fill);
const A = 'https://img.example/a.jpg';
const B = 'https://img.example/b.webp';
const fav = (id, cover, sourceId = 'src') => ({ id, title: id, cover, sourceId });

function fixture({ favorites = [], coverOverrides = {}, fetchImage, store } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-covers-'));
  const state = { store: store || { favorites, coverOverrides }, clock: 1_000_000, calls: [] };
  const fetchDefault = async (req) => {
    state.calls.push(req);
    return { contentType: /\.webp/.test(req.url) ? 'image/webp' : 'image/jpeg', body: bytes(200) };
  };
  const service = createLibraryCoverService({
    dir, limits: LIMITS, now: () => state.clock, sleep: async () => {}, logger: { warn() {} },
    readStore: async () => state.store,
    fetchImage: fetchDefault && (fetchImage ? async (req) => { state.calls.push(req); return fetchImage(req); } : fetchDefault),
  });
  return { dir, state, service, files: () => fs.readdirSync(dir).filter((n) => n !== 'index.json').sort(), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('the address a cover is known by: its own https address, in any of the forms it is saved in', () => {
  assert.equal(coverUrlKey(A), A);
  assert.equal(coverUrlKey('http://img.example/a.jpg'), A, 'the page asks for https, so that is the key');
  assert.equal(coverUrlKey(`/api/proxy-image?url=${encodeURIComponent(A)}&ref=x`), A, 'a cover saved as this app\'s proxy address');
  assert.equal(coverUrlKey('https://readermc.org/images/thumbnails/My Daughter.webp'), 'https://readermc.org/images/thumbnails/My Daughter.webp');
  for (const none of ['', '   ', null, undefined, '/api/local/x/thumb', 'data:image/png;base64,AAAA', '/api/proxy-image?url=', 'ftp://x/y.jpg']) {
    assert.equal(coverUrlKey(none), '', `${none} is not a remote image`);
  }
});

test('the cover a title shows: the one chosen, else the source\'s; the key of a choice is the one the library service uses', () => {
  const store = { coverOverrides: { 'a:src': ' https://chosen.example/c.jpg ' } };
  assert.equal(effectiveCover(store, fav('a', A)), 'https://chosen.example/c.jpg');
  assert.equal(effectiveCover(store, fav('b', B)), B);
  const content = createLibraryContentService({ readStore: async () => ({}), writeStore: async () => {}, safeManga: (m) => m, isSafeUrl: () => true });
  for (const [id, source] of [['plain', 'src'], ['a/b c:d', 'my source'], ['x'.repeat(400), ''], ['id', undefined]]) {
    assert.equal(coverOverrideKey(id, source), content.safeStatusKey(id, source), `${id.slice(0, 12)}…`);
  }
});

test('what the library needs: one entry per distinct remote cover, none for a local manga, the Referer some hosts want', () => {
  const store = {
    favorites: [fav('a', A), fav('dup', A, 'other'), fav('b', `/api/proxy-image?url=${encodeURIComponent(B)}&ref=${encodeURIComponent('https://site.example/')}`),
      fav('l', '/api/local/l/thumb', 'local'), fav('m', 'https://m.example/m.jpg', 'local'), fav('n', ''), fav('o', 'https://wp.youtube-anime.com/x/001.webp'), fav('p', 'https://cdn.batcave.biz/p.jpg')],
    coverOverrides: {},
  };
  const wanted = wantedCovers(store);
  assert.deepEqual([...wanted.keys()], [A, B, 'https://wp.youtube-anime.com/x/001.webp', 'https://cdn.batcave.biz/p.jpg']);
  assert.equal(wanted.get(B), 'https://site.example/', 'the hint a cover was saved with');
  assert.equal(wanted.get('https://wp.youtube-anime.com/x/001.webp'), 'https://allmanga.to');
  assert.equal(wanted.get('https://cdn.batcave.biz/p.jpg'), 'https://batcave.biz/');
  assert.equal(refererHintFor('https://img.example/a.jpg'), undefined);
  assert.deepEqual([...wantedCovers({ favorites: [] }).keys()], []);
  assert.deepEqual([...wantedCovers({}).keys()], [], 'no list of favourites: nothing needed (and nothing is deleted on that, below)');
});

test('adding a title keeps its cover: fetched once, saved under a name from the address, listed in the map, served by name', async () => {
  const f = fixture({ favorites: [fav('a', A), fav('b', B)] });
  try {
    const summary = await f.service.reconcile();
    assert.deepEqual(summary, { downloaded: 2, removed: 0, failed: 0, kept: 0, pending: 0 });
    assert.equal(f.state.calls.length, 2);
    assert.ok(f.state.calls.every((c) => c.measureBytes === true), 'the whole body, to be checked and written');
    const map = await f.service.getMap();
    assert.deepEqual(Object.keys(map).sort(), [A, B]);
    for (const local of Object.values(map)) assert.match(local, /^\/api\/library-cover\/[a-f0-9]{24}\.(jpg|webp)$/);
    const name = map[A].split('/').pop();
    assert.deepEqual(await f.service.getFile(name), { path: path.join(f.dir, name), type: 'image/jpeg' });
    assert.equal((await f.service.getFile(map[B].split('/').pop())).type, 'image/webp');
    assert.equal(fs.readFileSync(path.join(f.dir, name)).length, 200);

    f.state.calls.length = 0;
    assert.equal((await f.service.reconcile()).kept, 2, 'a second look finds both and fetches nothing');
    assert.equal(f.state.calls.length, 0);
  } finally { f.cleanup(); }
});

test('changing a cover replaces the old one; a title that leaves the library takes its cover with it; a shared cover stays until both go', async () => {
  const f = fixture({ favorites: [fav('a', A), fav('twin', A, 'other'), fav('b', B)] });
  try {
    await f.service.reconcile();
    assert.equal(f.files().length, 2, 'the cover two titles share is one file');

    f.state.store.favorites = [fav('a', A), fav('b', B)]; // the twin left: its cover is still needed by a
    assert.deepEqual(await f.service.reconcile(), { downloaded: 0, removed: 0, failed: 0, kept: 2, pending: 0 });
    assert.equal(f.files().length, 2);

    f.state.store.favorites = [fav('a', 'https://img.example/a-new.jpg'), fav('b', B)]; // the cover of a changed
    const changed = await f.service.reconcile();
    assert.equal(changed.downloaded, 1);
    assert.equal(changed.removed, 1, 'the old file is deleted');
    assert.deepEqual(Object.keys(await f.service.getMap()).sort(), ['https://img.example/a-new.jpg', B]);
    assert.equal(f.files().length, 2);

    f.state.store.favorites = [fav('b', B)]; // a left the library
    assert.equal((await f.service.reconcile()).removed, 1);
    f.state.store.favorites = [];
    assert.equal((await f.service.reconcile()).removed, 1);
    assert.deepEqual(f.files(), [], 'a library of no titles keeps no covers');
    assert.deepEqual(await f.service.getMap(), {});
  } finally { f.cleanup(); }
});

test('a cover the person chose is the one kept, and the source\'s cover is not fetched at all', async () => {
  const f = fixture({ favorites: [fav('a', A)], coverOverrides: { 'a:src': 'https://chosen.example/c.jpg' } });
  try {
    await f.service.reconcile();
    assert.deepEqual(f.state.calls.map((c) => c.url), ['https://chosen.example/c.jpg']);
    delete f.state.store.coverOverrides['a:src']; // the choice was undone: the source's cover is back
    const back = await f.service.reconcile();
    assert.deepEqual([back.downloaded, back.removed], [1, 1]);
    assert.deepEqual(Object.keys(await f.service.getMap()), [A]);
  } finally { f.cleanup(); }
});

test('what is fetched is not trusted: not an image, empty, too large; and the answer is never kept', async () => {
  const answers = {
    'https://x.example/html': { contentType: 'text/html', body: bytes(300) },
    'https://x.example/empty': { contentType: 'image/png', body: bytes(10) },
    'https://x.example/huge': { contentType: 'image/png', body: bytes(5000) },
    'https://x.example/ok': { contentType: 'image/png; charset=binary', body: bytes(300) },
    'https://x.example/stream': { contentType: 'image/avif', body: new Response(bytes(300)).body },
  };
  const f = fixture({ favorites: Object.keys(answers).map((u, i) => fav(`t${i}`, u)), fetchImage: async ({ url }) => answers[url] });
  try {
    const s = await f.service.reconcile();
    assert.deepEqual([s.downloaded, s.failed], [2, 3]);
    assert.deepEqual(Object.keys(await f.service.getMap()).sort(), ['https://x.example/ok', 'https://x.example/stream']);
    assert.equal(f.files().length, 2);
    assert.ok(f.files().every((n) => FILE_RE.test(n)), 'no leftover temporary file');
  } finally { f.cleanup(); }
});

test('a cover that could not be fetched is left alone for a while, then tried again; the page keeps working with its own address meanwhile', async () => {
  let up = false;
  const f = fixture({ favorites: [fav('a', A)], fetchImage: async () => { if (!up) throw new Error('Upstream image request failed with 403'); return { contentType: 'image/jpeg', body: bytes(200) }; } });
  try {
    assert.equal((await f.service.reconcile()).failed, 1);
    assert.deepEqual(await f.service.getMap(), {}, 'nothing to swap in: the cover is asked of its own host as before');
    f.state.calls.length = 0;
    up = true;
    f.state.clock += 500;
    assert.equal((await f.service.reconcile()).pending, 1, 'inside the wait: not tried');
    assert.equal(f.state.calls.length, 0);
    f.state.clock += 1000;
    assert.equal((await f.service.reconcile()).downloaded, 1, 'after the wait: tried, and kept');
    assert.deepEqual((await f.service.status()), { stored: 1, failed: 0, running: false, busy: false });
  } finally { f.cleanup(); }
});

test('files that belong to nothing are swept; a file that went missing is fetched again; the index survives a restart', async () => {
  const f = fixture({ favorites: [fav('a', A)] });
  try {
    await f.service.reconcile();
    const name = f.files()[0];
    fs.writeFileSync(path.join(f.dir, `${'f'.repeat(24)}.jpg`), bytes(10));
    fs.writeFileSync(path.join(f.dir, 'abc.jpg.tmp'), bytes(10));
    fs.writeFileSync(path.join(f.dir, 'notes.txt'), 'x');
    await f.service.reconcile();
    assert.deepEqual(f.files().sort(), [name, 'notes.txt'].sort(), 'the stray cover and the temporary file are gone; what is not a cover is left alone');

    fs.unlinkSync(path.join(f.dir, name));
    assert.equal((await f.service.reconcile()).downloaded, 1, 'the file is back');

    const again = createLibraryCoverService({ dir: f.dir, limits: LIMITS, readStore: async () => f.state.store, fetchImage: async () => { throw new Error('should not be asked'); }, sleep: async () => {}, logger: { warn() {} } });
    assert.deepEqual(Object.keys(await again.getMap()), [A], 'a new process reads the index');
    assert.equal((await again.reconcile()).kept, 1);
  } finally { f.cleanup(); }
});

test('when the store cannot say what the library is, nothing is deleted', async () => {
  const f = fixture({ favorites: [fav('a', A)] });
  try {
    await f.service.reconcile();
    f.state.store = { settings: {} }; // no list of favourites
    assert.equal((await f.service.reconcile()).removed, 0);
    f.state.store = null;
    assert.equal((await f.service.reconcile()).removed, 0);
    assert.equal(f.files().length, 1);
    const broken = createLibraryCoverService({ dir: f.dir, limits: LIMITS, readStore: async () => { throw new Error('store is being written'); }, fetchImage: async () => ({}), sleep: async () => {}, logger: { warn() {} } });
    assert.equal(await broken.reconcile(), null, 'a store that cannot be read ends the look quietly');
    assert.equal(f.files().length, 1);
  } finally { f.cleanup(); }
});

test('a look that is asked for while another runs is made once more afterwards (the library may have changed meanwhile)', async () => {
  const f = fixture({ favorites: [fav('a', A)] });
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let first = true;
    const slow = createLibraryCoverService({
      dir: f.dir, limits: { ...LIMITS, libraryCoverDebounceMs: 5 }, sleep: async () => {}, logger: { warn() {} },
      readStore: async () => f.state.store,
      fetchImage: async (req) => { f.state.calls.push(req); if (first) { first = false; await gate; } return { contentType: 'image/jpeg', body: bytes(200) }; },
    });
    const run = slow.reconcile();
    assert.equal((await slow.status()).busy, true, 'while a look runs the page is told to keep asking');
    f.state.store.favorites.push(fav('b', B)); // the library changes while the first look is fetching
    const second = slow.reconcile();
    assert.equal(second, run, 'the same look, not a second at once');
    release();
    await run;
    await new Promise((resolve) => { setTimeout(resolve, 80); });
    assert.deepEqual(Object.keys(await slow.getMap()).sort(), [A, B], 'the one that arrived meanwhile was picked up by the follow-up look');
    assert.equal((await slow.status()).busy, false, 'and once everything is fetched it says it is done');
  } finally { f.cleanup(); }
});

// ── the routes ──────────────────────────────────────────────────────────────

async function withServer(f, fn) {
  const app = express();
  coverRoutes.configure({ dir: f.dir, readStore: async () => f.state.store, fetchImage: async (req) => { f.state.calls.push(req); return { contentType: 'image/webp', body: bytes(300, 9) }; } });
  coverRoutes.registerCoverRoutes(app);
  const server = http.createServer(app);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((resolve) => { server.close(resolve); }); }
}

test('the routes: the map, a kept cover by name with safe headers, and a 404 for anything else', async () => {
  const f = fixture({ favorites: [fav('a', B)] });
  try {
    await withServer(f, async (base) => {
      const empty = await (await fetch(`${base}/api/library-covers`)).json();
      assert.deepEqual([empty.ok, empty.covers, empty.stored], [true, {}, 0]);

      const started = await (await fetch(`${base}/api/library-covers/sync`, { method: 'POST' })).json();
      assert.equal(started.started, true, 'answers at once: a first look can take minutes');
      for (let i = 0; i < 50 && !(await (await fetch(`${base}/api/library-covers`)).json()).stored; i++) await new Promise((resolve) => { setTimeout(resolve, 20); });

      const map = (await (await fetch(`${base}/api/library-covers`)).json()).covers;
      const local = map[B];
      assert.match(local, /^\/api\/library-cover\/[a-f0-9]{24}\.webp$/);
      const res = await fetch(`${base}${local}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/webp');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.match(res.headers.get('cache-control'), /immutable/);
      assert.equal((await res.arrayBuffer()).byteLength, 300);

      const name = local.split('/').pop();
      for (const bad of ['index.json', '..%2Findex.json', 'zzzzzzzzzzzzzzzzzzzzzzzz.webp', `${'0'.repeat(24)}.webp`, `${name}.tmp`, `${name.slice(0, 24)}.svg`, '%00']) {
        assert.equal((await fetch(`${base}/api/library-cover/${bad}`)).status, 404, bad);
      }
    });
  } finally { f.cleanup(); }
});

// ── the store tells the covers that it was written ──────────────────────────

test('the store calls the listeners after a write, and a listener that throws does not stop the write', async () => {
  const errors = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-store-'));
  const storage = new StorageService({ logger: { error: (...a) => errors.push(a.join(' ')), warn() {}, log() {} }, delayMs: 5 });
  storage.configure(path.join(dir, 'store.json'));
  const calls = [];
  storage.onWrite(() => calls.push('first'));
  storage.onWrite(() => { throw new Error('boom'); });
  storage.onWrite(() => calls.push('third'));
  storage.onWrite('not a function');
  const store = { favorites: [] };
  await storage.writeStore(store);
  assert.deepEqual(calls, ['first', 'third']);
  assert.equal(storage.store, store, 'the store was kept');
  assert.match(errors.join('\n'), /write listener failed: boom/);
  await new Promise((resolve) => { setTimeout(resolve, 150); }); // the debounced write to the temporary folder finishes before it is removed
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the files are in place: wired in server.js and bootstrap, ignored by git, and in the limits file', () => {
  const root = path.join(__dirname, '..', '..');
  const text = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  assert.match(text('server.js'), /storeModule\.onWrite\(\(\) => coverService\.scheduleReconcile\(\)\)/);
  assert.match(text('server.js'), /coverService\.start\(\)/);
  assert.match(text('server/routes/bootstrap.js'), /registerCoverRoutes\(app\)/);
  assert.match(text('.gitignore'), /^data\/covers\/$/m);
  for (const key of ['libraryCoverMaxBytes', 'libraryCoverSpacingMs', 'libraryCoverRetryMs', 'libraryCoverDebounceMs', 'libraryCoverStartDelayMs']) assert.ok(limitsFile[key] > 0, key);
});
