'use strict';

// Start-up safety of the library file. initStore() used to answer ANY failure
// to read or parse store.json (one EBUSY from an antivirus, a truncated file,
// a UTF-8 BOM) with an empty store, and the boot-time write then replaced the
// real library with it, with no backup. These tests pin the opposite:
// ENOENT starts empty, everything else stops and leaves the file untouched.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { StorageService } = require('../../server/store');

const LIBRARY = {
  repos: [],
  installedSources: {},
  history: [],
  favorites: [{ id: 'one-piece', title: 'One Piece', sourceId: 'mangadex' }],
};
const LIBRARY_TEXT = JSON.stringify(LIBRARY, null, 2);

const silentLogger = { error() {}, warn() {}, log() {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits for the debounced write to have happened: polls what it leaves behind instead of guessing how long a loaded
// machine takes to run a 10 ms timer and two file operations.
async function until(check, what, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

// The file looks untouched for a long time ago, so a write shows as a newer modification time.
function ageFile(storePath) {
  const longAgo = new Date(Date.now() - 3_600_000);
  fs.utimesSync(storePath, longAgo, longAgo);
  return longAgo.getTime();
}
const rewrittenSince = (storePath, since) => () => fs.statSync(storePath).mtimeMs > since + 60_000;

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-store-init-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeService(storePath, deps = {}) {
  const service = new StorageService({ logger: silentLogger, delayMs: 10, ...deps });
  service.configure(storePath);
  return service;
}

function filesIn(dir) {
  return fs.readdirSync(dir).sort();
}

// Everything that could write the store, after a failed load.
async function tryEveryWritePath(service) {
  await service.writeStore({ favorites: [], history: [] });
  service.flushNow();
  service.flushStoreSync();
  await sleep(60); // outlasts the 10 ms test debounce
}

test('initStore on a missing file (first run)', async (t) => {
  const dir = makeDir(t);
  const storePath = path.join(dir, 'store.json');
  const service = makeService(storePath);

  await service.initStore(); // resolves, as before
  assert.strictEqual(service.store, null);
  await assert.rejects(() => service.readStore(), { code: 'ENOENT' });

  service.flushNow();
  service.flushStoreSync();
  assert.deepStrictEqual(filesIn(dir), [], 'nothing is created out of thin air');
});

test('initStore loads a valid library and normalises it', async (t) => {
  const dir = makeDir(t);
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, LIBRARY_TEXT, 'utf8');
  const service = makeService(storePath);

  await service.initStore();
  assert.strictEqual(service.store.favorites[0].id, 'one-piece');
  assert.ok(Array.isArray(service.store.animeFavorites), 'defaults were filled in');
  assert.strictEqual((await service.readStore()).favorites.length, 1);
});

test('a library saved with a UTF-8 BOM loads instead of being replaced', async (t) => {
  const dir = makeDir(t);
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, '﻿' + LIBRARY_TEXT, 'utf8');
  const service = makeService(storePath);

  await service.initStore();
  assert.strictEqual(service.store.favorites.length, 1);
  assert.strictEqual(service.store.favorites[0].id, 'one-piece');

  // The same file through the lazy readStore() path (no initStore first).
  const lazy = makeService(storePath);
  assert.strictEqual((await lazy.readStore()).favorites[0].id, 'one-piece');

  // Boot-time write keeps the library; the BOM is simply dropped.
  const since = ageFile(storePath);
  await service.writeStore(service.store);
  await until(rewrittenSince(storePath, since), 'the boot-time write');
  const after = fs.readFileSync(storePath, 'utf8');
  assert.ok(!after.startsWith('﻿'));
  assert.strictEqual(JSON.parse(after).favorites[0].id, 'one-piece');
});

test('a zero-byte or blank file starts fresh (nothing left to lose)', async (t) => {
  for (const content of ['', '  \n\t ']) {
    const dir = makeDir(t);
    const storePath = path.join(dir, 'store.json');
    fs.writeFileSync(storePath, content, 'utf8');
    const service = makeService(storePath);

    await service.initStore();
    assert.deepStrictEqual(service.store.favorites, []);
    assert.deepStrictEqual(filesIn(dir), ['store.json'], 'no .corrupt copy of an empty file');
  }
});

test('control: a valid library survives the boot-time write', async (t) => {
  const dir = makeDir(t);
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, LIBRARY_TEXT, 'utf8');
  const service = makeService(storePath);

  // The same sequence server.js and the source loader run at boot.
  await service.initStore();
  const since = ageFile(storePath);
  await service.writeStore(await service.readStore());
  await until(rewrittenSince(storePath, since), 'the boot-time write');

  assert.strictEqual(JSON.parse(fs.readFileSync(storePath, 'utf8')).favorites[0].id, 'one-piece');
});

test('an unparsable file stops start-up, is kept as a copy and is never overwritten', async (t) => {
  const bad = {
    'truncated JSON': LIBRARY_TEXT.slice(0, 60),
    'trailing comma': '{"favorites": [{"id": "one-piece"},], "history": []}',
    'a JSON array': '[1, 2, 3]',
    'JSON null': 'null',
    'a JSON string': '"one-piece"',
    'a shape the normaliser cannot take': '{"repos": [null], "favorites": [{"id": "one-piece"}]}',
  };

  for (const [name, content] of Object.entries(bad)) {
    const dir = makeDir(t);
    const storePath = path.join(dir, 'store.json');
    fs.writeFileSync(storePath, content, 'utf8');
    const before = fs.readFileSync(storePath);
    const service = makeService(storePath);

    await assert.rejects(() => service.initStore(), (e) => {
      assert.strictEqual(e.code, 'STORE_CORRUPT', name);
      assert.ok(e.message.includes(storePath), `${name}: names the file`);
      assert.ok(/copy was kept as .*store\.json\.corrupt-/.test(e.message), `${name}: names the copy`);
      return true;
    });
    assert.strictEqual(service.store, null, `${name}: no store in memory`);

    await tryEveryWritePath(service);

    assert.ok(fs.readFileSync(storePath).equals(before), `${name}: store.json is byte-identical`);
    const copies = filesIn(dir).filter((f) => f.startsWith('store.json.corrupt-'));
    assert.strictEqual(copies.length, 1, `${name}: exactly one copy kept`);
    assert.ok(fs.readFileSync(path.join(dir, copies[0])).equals(before), `${name}: the copy is byte-faithful`);
    assert.deepStrictEqual(
      filesIn(dir).filter((f) => f !== 'store.json' && f !== copies[0]),
      [],
      `${name}: no tmp file or anything else was written`,
    );
  }
});

test('a transient read error (EBUSY) stops start-up and never overwrites the library', async (t) => {
  const dir = makeDir(t);
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, LIBRARY_TEXT, 'utf8');
  const before = fs.readFileSync(storePath);

  const busyFsp = {
    ...fsp,
    readFile: async () => {
      const err = new Error('resource busy or locked');
      err.code = 'EBUSY';
      throw err;
    },
  };
  const service = makeService(storePath, { fsp: busyFsp });

  await assert.rejects(() => service.initStore(), (e) => {
    assert.strictEqual(e.code, 'STORE_UNREADABLE');
    assert.ok(e.message.includes('EBUSY'));
    assert.ok(e.message.includes(storePath));
    return true;
  });
  assert.strictEqual(service.store, null);

  // The old behaviour: boot continues, the loader writes the store back.
  await tryEveryWritePath(service);

  assert.ok(fs.readFileSync(storePath).equals(before), 'store.json is byte-identical');
  assert.deepStrictEqual(filesIn(dir), ['store.json'], 'no copy for a merely unreadable file, no tmp file');
});

test('a failed load is sticky: later reads rethrow it and make no second copy', async (t) => {
  const dir = makeDir(t);
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, '{"favorites": [', 'utf8');
  const service = makeService(storePath);

  const first = await service.initStore().then(() => null, (e) => e);
  assert.strictEqual(first.code, 'STORE_CORRUPT');
  await assert.rejects(() => service.readStore(), (e) => e === first);
  await assert.rejects(() => service.initStore(), (e) => e === first);

  assert.strictEqual(filesIn(dir).filter((f) => f.startsWith('store.json.corrupt-')).length, 1);
});

test('if the safety copy itself cannot be made, start-up still stops with the file untouched', async (t) => {
  const dir = makeDir(t);
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, '{"favorites": [', 'utf8');
  const before = fs.readFileSync(storePath);

  const noCopyFs = {
    ...fs,
    copyFileSync() {
      const err = new Error('disk full');
      err.code = 'ENOSPC';
      throw err;
    },
  };
  const service = makeService(storePath, { fs: noCopyFs });

  await assert.rejects(() => service.initStore(), (e) => {
    assert.strictEqual(e.code, 'STORE_CORRUPT');
    assert.ok(/could NOT be kept \(ENOSPC\)/.test(e.message));
    return true;
  });
  await tryEveryWritePath(service);

  assert.ok(fs.readFileSync(storePath).equals(before));
  assert.deepStrictEqual(filesIn(dir), ['store.json']);
});

test('a store that failed to load can never be flushed, even after the process hook runs', async (t) => {
  const dir = makeDir(t);
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, LIBRARY_TEXT.slice(0, 40), 'utf8');
  const before = fs.readFileSync(storePath);
  const service = makeService(storePath);

  await assert.rejects(() => service.initStore(), { code: 'STORE_CORRUPT' });

  // Even if something managed to put a blank store in memory, the guard holds.
  service.store = { favorites: [], history: [] };
  service.flushStoreSync(); // what SIGINT/SIGTERM run (minus the process.exit)
  service.flushNow();
  assert.ok(fs.readFileSync(storePath).equals(before));
  assert.strictEqual(service.isShuttingDown, false, 'the guarded flush is not a shutdown flush');
});

// The FlareSolverr session pool's three settings are server-authoritative: the pool runs in this process,
// so whatever a backup import or a hand edit leaves in the library is repaired when it is loaded.
const { normaliseStore } = require('../../server/modules/store/schema');
const { normalizeSolverSettings } = require('../../server/modules/common/solver-settings');

const SOLVER_KEYS = ['solverSessionsEnabled', 'solverSessionPoolSize', 'solverSessionIdleMinutes'];
const DEFAULTS = [false, 2, 10];
const valuesOf = (settings) => SOLVER_KEYS.map((key) => normalizeSolverSettings(settings)[key]);

test('a library with no settings stores NO pool key: the defaults are read, never written, and nothing about the ad filter', () => {
  const store = {};
  normaliseStore(store);
  assert.deepStrictEqual(SOLVER_KEYS.map((key) => store.settings[key]), [undefined, undefined, undefined]);
  assert.deepStrictEqual(valuesOf(store.settings), DEFAULTS, 'they apply when the settings are read');
  assert.deepStrictEqual(Object.keys(store.settings).filter((key) => key.startsWith('adFilter')), []);
});

test('a stored value is a choice: it survives loading; junk is removed (the default applies), never a clamp', () => {
  const kept = { settings: { solverSessionsEnabled: true, solverSessionPoolSize: 3, solverSessionIdleMinutes: 15 } };
  normaliseStore(kept);
  assert.deepStrictEqual(SOLVER_KEYS.map((key) => kept.settings[key]), [true, 3, 15]);

  const hostile = { settings: { solverSessionsEnabled: 'yes', solverSessionPoolSize: 1e9, solverSessionIdleMinutes: '5' } };
  normaliseStore(hostile);
  assert.deepStrictEqual(SOLVER_KEYS.map((key) => hostile.settings[key]), [undefined, undefined, undefined]);
  assert.deepStrictEqual(valuesOf(hostile.settings), DEFAULTS);

  const edges = { settings: { solverSessionPoolSize: 4, solverSessionIdleMinutes: 16 } };
  normaliseStore(edges);
  assert.deepStrictEqual([edges.settings.solverSessionPoolSize, edges.settings.solverSessionIdleMinutes], [undefined, undefined]);
  assert.deepStrictEqual(valuesOf(edges.settings), DEFAULTS);
});

test('loading twice changes nothing: a library that never set a key never gets it', () => {
  const store = { settings: { solverSessionPoolSize: 1 } };
  normaliseStore(store);
  normaliseStore(store);
  assert.deepStrictEqual(Object.keys(store.settings).filter((key) => key.startsWith('solver')), ['solverSessionPoolSize']);
  assert.strictEqual(store.settings.solverSessionPoolSize, 1, 'a deliberate 1 is kept');
});

test('other settings are left exactly as they are, including a key nothing here knows', () => {
  const store = { settings: { proxyUrl: 'http://proxy.example:8080', adFilterEnabled: 'whatever', solverSessionPoolSize: 2 } };
  normaliseStore(store);
  assert.strictEqual(store.settings.proxyUrl, 'http://proxy.example:8080');
  assert.strictEqual(store.settings.adFilterEnabled, 'whatever', 'an unknown key is not repaired, copied or removed');
  assert.strictEqual(store.settings.solverSessionPoolSize, 2);
});

test('a library file with hostile pool settings is repaired when it is loaded', async (t) => {
  const dir = makeDir(t);
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, JSON.stringify({ ...LIBRARY, settings: { solverSessionPoolSize: 999, solverSessionsEnabled: null } }), 'utf8');
  const service = makeService(storePath);

  await service.initStore();

  const { settings } = await service.readStore();
  assert.deepStrictEqual(SOLVER_KEYS.map((key) => settings[key]), [undefined, undefined, undefined]);
  assert.deepStrictEqual(valuesOf(settings), DEFAULTS);
});

// The disabled sources list is server-authoritative too: the live probes of System Health read it, so
// whatever a backup import or a hand edit leaves in the library is repaired when it is loaded.
test('a library with no settings gets an empty disabled sources list', () => {
  const store = {};
  normaliseStore(store);
  assert.deepStrictEqual(store.settings.disabledSourceIds, []);

  const without = { settings: { proxyUrl: 'http://proxy.example:8080' } };
  normaliseStore(without);
  assert.deepStrictEqual(without.settings.disabledSourceIds, []);
});

test('a valid disabled sources list survives loading, in order', () => {
  const store = { settings: { disabledSourceIds: ['beta', 'alpha', 'gamma-3'] } };
  normaliseStore(store);
  assert.deepStrictEqual(store.settings.disabledSourceIds, ['beta', 'alpha', 'gamma-3']);
  normaliseStore(store);
  assert.deepStrictEqual(store.settings.disabledSourceIds, ['beta', 'alpha', 'gamma-3'], 'loading twice changes nothing');
});

test('a junk disabled sources list is repaired: not a list becomes empty, a dirty list keeps its usable ids', () => {
  for (const junk of ['alpha', 5, null, true, { 0: 'alpha' }]) {
    const store = { settings: { disabledSourceIds: junk } };
    normaliseStore(store);
    assert.deepStrictEqual(store.settings.disabledSourceIds, [], String(junk));
  }
  const dirty = { settings: { disabledSourceIds: ['alpha', 7, '', 'two words', 'alpha', '__proto__', 'x'.repeat(5000), 'beta'] } };
  normaliseStore(dirty);
  assert.deepStrictEqual(dirty.settings.disabledSourceIds, ['alpha', 'beta']);
});

test('repairing the disabled sources list leaves every other setting exactly as it is', () => {
  const store = { settings: { proxyUrl: 'http://proxy.example:8080', adFilterEnabled: 'whatever', disabledSourceIds: 'junk' } };
  normaliseStore(store);
  assert.strictEqual(store.settings.proxyUrl, 'http://proxy.example:8080');
  assert.strictEqual(store.settings.adFilterEnabled, 'whatever', 'an unknown key is not repaired, copied or removed');
  assert.deepStrictEqual(SOLVER_KEYS.map((key) => store.settings[key]), [undefined, undefined, undefined], 'and no pool default is written');
});

test('a library file with a hostile disabled sources list is repaired when it is loaded', async (t) => {
  const dir = makeDir(t);
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, JSON.stringify({ ...LIBRARY, settings: { disabledSourceIds: ['alpha', { x: 1 }, 'beta'] } }), 'utf8');
  const service = makeService(storePath);

  await service.initStore();

  assert.deepStrictEqual((await service.readStore()).settings.disabledSourceIds, ['alpha', 'beta']);
});
