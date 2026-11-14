'use strict';

// POST /api/settings and the disabled sources list (settings.disabledSourceIds): the browser sends the whole
// list, the server stores the cleaned copy that the System Health probes read, and GET /api/settings gives it
// back. The real route runs on a real Express server on loopback against the store singleton pointed at a
// temporary file, so the data folder is never touched (same rig as solver-settings-route.test.js). The
// FlareSolverr pool is a recording stand-in: nothing here builds a real pool.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const storeModule = require('../../server/store');
const limits = require('../../server/config/limits');
const { registerSettingsRoutes, SAVED_SETTINGS_FIELDS } = require('../../server/routes/settings');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-disabled-sources-'));
const storePath = path.join(dir, 'store.json');
const STORED = { proxyUrl: 'http://proxy.example:8080', discordClientId: '' };

async function resetStore(settings = {}) {
  fs.writeFileSync(storePath, JSON.stringify({ repos: [], installedSources: {}, history: [], favorites: [], settings: { ...STORED, ...settings } }), 'utf8');
  storeModule.configure(storePath);
  await storeModule.initStore(); // loads the file again: the in-memory library of the test before is replaced
}

// A save queues a delayed disk write. The last flush marks the store as shut down, so a write still
// queued when the folder goes away is dropped instead of failing on a missing folder.
test.after(() => {
  storeModule.flushStoreSync();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function startRoute(t, settings) {
  await resetStore(settings);
  const app = express();
  app.use(express.json());
  const told = [];
  registerSettingsRoutes(app, { applySolver: (saved) => told.push({ ...saved }) });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (text) => {
    const res = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: text });
    return { status: res.status, body: await res.json() };
  };
  return {
    told,
    post: (body) => send(JSON.stringify(body)),
    postRaw: send, // the text as it travels: JSON.parse makes "__proto__" an ordinary own key, which is how it reaches a server
    get: async () => (await (await fetch(`${base}/api/settings`)).json()).data,
    // The narrow read the browser uses at every start-up: the list and nothing else.
    getList: async () => {
      const res = await fetch(`${base}/api/settings/disabled-sources`);
      return { status: res.status, body: await res.json() };
    },
  };
}

const stored = async () => (await storeModule.readStore()).settings;
const onDisk = () => JSON.parse(fs.readFileSync(storePath, 'utf8')).settings;

test('the route saves the list as an idList field, once, next to the plain ones', () => {
  const fields = SAVED_SETTINGS_FIELDS.filter(([key]) => key === 'disabledSourceIds');
  assert.deepEqual(fields, [['disabledSourceIds', 'idList']]);
  assert.equal(Object.isFrozen(SAVED_SETTINGS_FIELDS.find(([key]) => key === 'disabledSourceIds')), true);
});

test('a library that never heard of the feature reads back with an empty list', async (t) => {
  const { get } = await startRoute(t);
  assert.deepEqual((await get()).disabledSourceIds, []);
});

test('a valid list is stored, written to disk at once, and the next GET returns it', async (t) => {
  const { post, get } = await startRoute(t);

  const answer = await post({ disabledSourceIds: ['alpha', 'beta-2', 'gamma_3'] });

  assert.deepEqual(answer, { status: 200, body: { ok: true } }, 'the settings are never echoed back');
  assert.deepEqual((await stored()).disabledSourceIds, ['alpha', 'beta-2', 'gamma_3']);
  assert.deepEqual(onDisk().disabledSourceIds, ['alpha', 'beta-2', 'gamma_3']);
  assert.deepEqual((await get()).disabledSourceIds, ['alpha', 'beta-2', 'gamma_3']);
});

test('a repeated id is stored once, in the order it first came', async (t) => {
  const { post, get } = await startRoute(t);
  await post({ disabledSourceIds: ['beta', 'alpha', 'beta', 'alpha'] });
  assert.deepEqual((await get()).disabledSourceIds, ['beta', 'alpha']);
});

test('an empty list clears the stored one', async (t) => {
  const { post, get } = await startRoute(t, { disabledSourceIds: ['alpha', 'beta'] });
  assert.deepEqual((await get()).disabledSourceIds, ['alpha', 'beta']);

  assert.equal((await post({ disabledSourceIds: [] })).status, 200);

  assert.deepEqual((await stored()).disabledSourceIds, []);
  assert.deepEqual(onDisk().disabledSourceIds, []);
  assert.deepEqual((await get()).disabledSourceIds, []);
});

test('the list sent replaces the stored one, it is not merged into it', async (t) => {
  const { post, get } = await startRoute(t, { disabledSourceIds: ['alpha', 'beta'] });
  await post({ disabledSourceIds: ['gamma'] });
  assert.deepEqual((await get()).disabledSourceIds, ['gamma']);
});

test('a list with one bad entry, a list over the cap or a value that is no list changes nothing, and is not an error', async (t) => {
  const { post, get } = await startRoute(t, { disabledSourceIds: ['kept'] });
  const overCap = Array.from({ length: limits.disabledSourceIdsMax + 1 }, (_, i) => `s${i}`);
  const refused = [
    ['alpha', 5], ['alpha', null], ['alpha', ''], ['alpha', 'two words'], ['alpha', 'a/b'], ['alpha', '<b>'], ['alpha', {}], ['alpha', ['beta']],
    ['alpha', '__proto__'], ['alpha', 'x'.repeat(5000)], overCap, Array.from({ length: 5000 }, (_, i) => `s${i}`),
    'alpha', 5, null, true, { 0: 'alpha', length: 1 }, { alpha: true },
  ];
  for (const disabledSourceIds of refused) {
    const answer = await post({ disabledSourceIds });
    assert.equal(answer.status, 200, JSON.stringify(disabledSourceIds).slice(0, 60));
    assert.deepEqual((await get()).disabledSourceIds, ['kept'], JSON.stringify(disabledSourceIds).slice(0, 60));
  }
  assert.deepEqual(onDisk().disabledSourceIds, ['kept']);
});

test('a list at the cap is stored whole', async (t) => {
  const { post, get } = await startRoute(t);
  const atCap = Array.from({ length: limits.disabledSourceIdsMax }, (_, i) => `s${i}`);
  await post({ disabledSourceIds: atCap });
  assert.deepEqual((await get()).disabledSourceIds, atCap);
});

test('a hostile body changes nothing it should not: an object under the key, or a __proto__ of its own', async (t) => {
  const { postRaw, get } = await startRoute(t, { disabledSourceIds: ['kept'] });
  const bodies = [
    '{"disabledSourceIds":{"__proto__":["alpha"]}}',
    '{"disabledSourceIds":{"constructor":{"prototype":{"polluted":true}}}}',
    '{"__proto__":{"disabledSourceIds":["alpha"],"polluted":true}}',
    '{"constructor":{"prototype":{"disabledSourceIds":["alpha"]}}}',
  ];
  for (const text of bodies) {
    assert.equal((await postRaw(text)).status, 200, text);
    assert.deepEqual((await get()).disabledSourceIds, ['kept'], text);
  }
  // a valid list next to a __proto__ key of its own: the list is taken, the __proto__ is not
  assert.equal((await postRaw('{"disabledSourceIds":["alpha"],"__proto__":{"polluted":true}}')).status, 200);
  assert.deepEqual((await get()).disabledSourceIds, ['alpha']);
  assert.equal({}.polluted, undefined, 'nothing reached Object.prototype');
  assert.equal(Object.getPrototypeOf(await stored()), Object.prototype);
  assert.equal(Object.keys(await stored()).includes('__proto__'), false);
});

test('other keys in the same body are still saved when the list is refused, and when it is accepted', async (t) => {
  const { post, get } = await startRoute(t, { disabledSourceIds: ['kept'] });

  await post({ disabledSourceIds: ['alpha', 5], proxyUrl: 'http://changed.example:1' });
  let settings = await get();
  assert.deepEqual(settings.disabledSourceIds, ['kept']);
  assert.equal(settings.proxyUrl, 'http://changed.example:1');

  await post({ disabledSourceIds: ['alpha'], proxyUrl: 'http://changed-again.example:2', solverSessionPoolSize: 3 });
  settings = await get();
  assert.deepEqual(settings.disabledSourceIds, ['alpha']);
  assert.equal(settings.proxyUrl, 'http://changed-again.example:2');
  assert.equal(settings.solverSessionPoolSize, 3);
});

test('saving something else leaves the list alone', async (t) => {
  const { post, get } = await startRoute(t, { disabledSourceIds: ['alpha', 'beta'] });
  await post({ proxyUrl: 'http://other.example:9090' });
  assert.deepEqual((await get()).disabledSourceIds, ['alpha', 'beta']);
});

test('a body with a bad pool setting is refused whole, the list in it included', async (t) => {
  const { post, get, told } = await startRoute(t, { disabledSourceIds: ['kept'] });
  const answer = await post({ disabledSourceIds: ['alpha'], solverSessionPoolSize: 99 });
  assert.equal(answer.status, 400);
  assert.deepEqual((await get()).disabledSourceIds, ['kept']);
  assert.deepEqual(told, []);
});

test('the pool is told after a list is saved, like after every save, and gets the list with the rest', async (t) => {
  const { post, told } = await startRoute(t);
  await post({ disabledSourceIds: ['alpha'] });
  assert.equal(told.length, 1);
  assert.deepEqual(told[0].disabledSourceIds, ['alpha']);
});

// ── GET /api/settings/disabled-sources: the list for the start-up of every page, without the credentials ──

test('the narrow read gives the list and nothing else, even when the library holds credentials', async (t) => {
  const { post, getList } = await startRoute(t, { proxyPassword: 'hunter2', comicVineApiKey: 'key-123', suwayomiPassword: 'pw' });
  assert.deepEqual(await getList(), { status: 200, body: { ok: true, data: { disabledSourceIds: [] } } }, 'empty when nothing was ever saved');

  await post({ disabledSourceIds: ['alpha', 'beta'] });
  const { status, body } = await getList();
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, data: { disabledSourceIds: ['alpha', 'beta'] } });
  assert.doesNotMatch(JSON.stringify(body), /hunter2|key-123|pw/);
});

test('the narrow read repairs what a hand edit left in the library instead of handing it on', async (t) => {
  const { getList } = await startRoute(t);
  const settings = await stored();
  settings.disabledSourceIds = ['ok', '__proto__', { x: 1 }, 'ok', 'a b'];
  const { body } = await getList();
  assert.deepEqual(body.data.disabledSourceIds, ['ok']);
  settings.disabledSourceIds = 'not a list';
  assert.deepEqual((await getList()).body.data.disabledSourceIds, []);
});
