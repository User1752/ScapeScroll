'use strict';

// POST /api/settings and the three settings of the FlareSolverr session pool: judged together before
// anything is read or written, stored, and handed to the pool after the save. The real route runs on a real
// Express server on loopback against the store singleton pointed at a temporary file, so the
// data folder is never touched. The pool is a recording stand-in (or, in the last test, the one the route
// finds in a stubbed fetch-utils): nothing here builds a real pool or loads the FlareSolverr lifecycle.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const storeModule = require('../../server/store');
const { registerSettingsRoutes, SAVED_SETTINGS_FIELDS } = require('../../server/routes/settings');
const { normalizeSolverSettings } = require('../../server/modules/common/solver-settings');

const FETCH_UTILS_PATH = require.resolve('../../server/modules/network/fetch-utils');
const ENV_NAME = 'SCROLLSCAPE_SOLVER_SESSIONS_DISABLED';

// The store singleton is configured once per process: the first test sets the file up, every test
// starts from the same stored settings.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-solver-settings-'));
const storePath = path.join(dir, 'store.json');
const STORED = { proxyUrl: 'http://proxy.example:8080', proxyPassword: 'secret-route-test', discordClientId: '' };

async function resetStore() {
  fs.writeFileSync(storePath, JSON.stringify({ repos: [], installedSources: {}, history: [], favorites: [], settings: { ...STORED } }), 'utf8');
  storeModule.configure(storePath);
  await storeModule.initStore(); // loads the file again: the in-memory library of the test before is replaced
}

// A save queues a delayed disk write. The last flush marks the store as shut down, so a write still
// queued when the folder goes away is dropped instead of failing on a missing folder.
test.after(() => {
  storeModule.flushStoreSync();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function startRoute(t, options) {
  await resetStore();
  const app = express();
  app.use(express.json());
  registerSettingsRoutes(app, options);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    post: async (body) => {
      const res = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    },
    get: async () => (await (await fetch(`${base}/api/settings`)).json()).data,
  };
}

const stored = async () => (await storeModule.readStore()).settings;
const onDisk = () => JSON.parse(fs.readFileSync(storePath, 'utf8')).settings;

function recordingApply() {
  const told = [];
  return { told, applySolver: (settings) => told.push({ ...settings }) };
}

test('a store that never heard of the feature stores no pool key: the defaults are applied when the settings are read', async (t) => {
  const apply = recordingApply();
  const { get, post } = await startRoute(t, apply);
  const settings = await get();
  assert.deepEqual(Object.keys(settings).filter((key) => key.startsWith('solver')), [], 'nothing is written for a key nobody set');
  const defaults = normalizeSolverSettings(settings);
  assert.equal(defaults.solverSessionsEnabled, false);
  assert.equal(defaults.solverSessionPoolSize, 2);
  assert.equal(defaults.solverSessionIdleMinutes, 10);
  assert.deepEqual(Object.keys(settings).filter((key) => key.startsWith('adFilter')), []);

  // Saving an unrelated setting does not write the pool's defaults either.
  await post({ proxyUrl: 'http://proxy.example:8080' });
  assert.deepEqual(Object.keys(await get()).filter((key) => key.startsWith('solver')), []);
});

test('the three keys are stored, written to disk at once, and the pool is told what is stored', async (t) => {
  const apply = recordingApply();
  const { post } = await startRoute(t, apply);

  const answer = await post({ solverSessionsEnabled: false, solverSessionPoolSize: 3, solverSessionIdleMinutes: 5 });

  assert.deepEqual(answer, { status: 200, body: { ok: true } }, 'the settings are never echoed back');
  for (const settings of [await stored(), onDisk()]) {
    assert.deepEqual([settings.solverSessionsEnabled, settings.solverSessionPoolSize, settings.solverSessionIdleMinutes], [false, 3, 5]);
  }
  assert.equal(apply.told.length, 1);
  assert.deepEqual([apply.told[0].solverSessionsEnabled, apply.told[0].solverSessionPoolSize, apply.told[0].solverSessionIdleMinutes], [false, 3, 5]);
  assert.equal(apply.told[0].proxyUrl, STORED.proxyUrl, 'the pool gets the whole stored settings, the proxy included');
});

test('one bad value refuses the whole save: nothing in the body is stored and the pool is not told', async (t) => {
  const apply = recordingApply();
  const { post } = await startRoute(t, apply);
  const before = JSON.stringify(await stored());

  const bad = [
    [{ solverSessionPoolSize: 0 }, /solverSessionPoolSize must be a whole number from 1 to 3/],
    [{ solverSessionPoolSize: 4 }, /solverSessionPoolSize/],
    [{ solverSessionPoolSize: 1.5 }, /solverSessionPoolSize/],
    [{ solverSessionPoolSize: '2' }, /solverSessionPoolSize/],
    [{ solverSessionPoolSize: null }, /solverSessionPoolSize/],
    [{ solverSessionIdleMinutes: 16 }, /solverSessionIdleMinutes must be a whole number from 1 to 15/],
    [{ solverSessionIdleMinutes: -1 }, /solverSessionIdleMinutes/],
    [{ solverSessionsEnabled: 'false' }, /solverSessionsEnabled must be true or false/],
    [{ solverSessionsEnabled: 0 }, /solverSessionsEnabled/],
  ];
  for (const [patch, message] of bad) {
    // good values for other keys travel with the bad one and must not be applied either
    const answer = await post({ proxyUrl: 'http://changed.example:1', solverSessionPoolSize: 2, ...patch });
    assert.equal(answer.status, 400, JSON.stringify(patch));
    assert.equal(answer.body.ok, false);
    assert.match(answer.body.error, message);
  }
  assert.equal(JSON.stringify(await stored()), before, 'not one key changed');
  assert.deepEqual(apply.told, []);
});

test('a key of the retired ad filter is an ordinary unknown key: ignored, not stored, never refused', async (t) => {
  const apply = recordingApply();
  const { post } = await startRoute(t, apply);

  const answer = await post({ adFilterEnabled: 'garbage', adFilterExceptions: 'not-a-list', solverSessionPoolSize: 2 });

  assert.equal(answer.status, 200);
  const settings = await stored();
  assert.equal(settings.solverSessionPoolSize, 2);
  assert.deepEqual(Object.keys(settings).filter((key) => key.startsWith('adFilter')), []);
  assert.deepEqual(Object.keys(onDisk()).filter((key) => key.startsWith('adFilter')), []);
});

test('saving something else leaves the three keys alone and still tells the pool', async (t) => {
  const apply = recordingApply();
  const { post } = await startRoute(t, apply);
  await post({ solverSessionPoolSize: 2 });

  await post({ proxyUrl: 'http://other.example:9090' });

  assert.equal((await stored()).solverSessionPoolSize, 2);
  assert.equal(apply.told.length, 2);
  assert.equal(apply.told[1].proxyUrl, 'http://other.example:9090');
  assert.equal(apply.told[1].solverSessionPoolSize, 2);
});

test('without an injected stand-in the route finds the pool in fetch-utils and the environment switch applies', async (t) => {
  const told = [];
  const original = require.cache[FETCH_UTILS_PATH];
  require.cache[FETCH_UTILS_PATH] = {
    id: FETCH_UTILS_PATH, filename: FETCH_UTILS_PATH, loaded: true, children: [], paths: [],
    exports: { getSolverPool: () => ({ applySettings: (settings) => told.push(settings) }) },
  };
  const savedEnv = process.env[ENV_NAME];
  delete process.env[ENV_NAME];
  t.after(() => {
    if (original) require.cache[FETCH_UTILS_PATH] = original; else delete require.cache[FETCH_UTILS_PATH];
    if (savedEnv === undefined) delete process.env[ENV_NAME]; else process.env[ENV_NAME] = savedEnv;
  });
  const { post } = await startRoute(t);

  await post({ solverSessionIdleMinutes: 7 });
  assert.deepEqual(told[0], { enabled: false, disabledBy: 'setting', maxSessions: 2, idleMinutes: 7 }, 'nothing chosen: the pool stays off');

  await post({ solverSessionsEnabled: true });
  assert.deepEqual(told[1], { enabled: true, disabledBy: null, maxSessions: 2, idleMinutes: 7 });

  process.env[ENV_NAME] = '1';
  await post({ solverSessionsEnabled: true });
  assert.deepEqual(told[2], { enabled: false, disabledBy: 'env', maxSessions: 2, idleMinutes: 7 });
});

// The rest of what POST /api/settings stores: a value is copied when it is of the type the setting has, and is otherwise ignored.
// (The Discord switch is only sent a wrong type here: a true would make the route connect to a Discord that may be running.)
test('every other setting is saved as it always was: a string for a string setting, nothing of the wrong type, nothing unknown', async (t) => {
  const { post } = await startRoute(t, recordingApply());
  const good = {
    flaresolverrUrl: 'http://127.0.0.1:9999/v1',
    proxyUrl: 'http://proxy-two.example:3128',
    proxyUsername: 'proxy-user',
    proxyPassword: 'proxy-secret',
    comicVineApiKey: 'comic-key',
    suwayomiUrl: 'http://suwayomi.example:4567',
    suwayomiUsername: 'suwayomi-user',
    suwayomiPassword: 'suwayomi-secret',
    discordClientId: '1234567890',
  };
  // JSON.parse makes "__proto__" an ordinary own key, which is how it reaches a server.
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
  assert.equal((await post({ ...good, ...hostile, notASetting: 'x' })).status, 200);
  const settings = await stored();
  for (const [key, value] of Object.entries(good)) assert.equal(settings[key], value, key);
  assert.equal('notASetting' in settings, false, 'a key nobody knows is not stored');
  assert.equal({}.polluted, undefined, 'nothing reached Object.prototype');
  assert.equal(Object.keys(settings).includes('constructor'), false);

  const wrong = {
    flaresolverrUrl: 5, proxyUrl: null, proxyUsername: ['a'], proxyPassword: { x: 1 }, comicVineApiKey: true, suwayomiUrl: 7, suwayomiUsername: false,
    suwayomiPassword: 0, discordClientId: 12, discordRichPresenceEnabled: 'yes',
  };
  assert.equal((await post(wrong)).status, 200);
  const after = await stored();
  for (const [key, value] of Object.entries(good)) assert.equal(after[key], value, `${key} keeps its value when the new one is not a string`);
  assert.notEqual(after.discordRichPresenceEnabled, 'yes', 'a string is not a boolean');
  assert.deepEqual(onDisk(), after, 'and what is stored is on disk');
});

test('every setting the route saves as it comes is in its table, once, and is saved from a request of its own', async (t) => {
  const { post } = await startRoute(t, recordingApply());
  const keys = SAVED_SETTINGS_FIELDS.map(([key]) => key);
  assert.equal(new Set(keys).size, keys.length, 'no key twice');
  assert.ok(keys.length >= 11, 'the ten every edition has, and this edition\'s own');
  for (const [key, type] of SAVED_SETTINGS_FIELDS) {
    if (type !== 'string') continue; // a true Discord switch would make the route connect to a Discord that may be running
    const value = `value-for-${key}`;
    assert.equal((await post({ [key]: value })).status, 200, key);
    assert.equal((await stored())[key], value, key);
    assert.equal(onDisk()[key], value, `${key} is on disk`);
  }
});
