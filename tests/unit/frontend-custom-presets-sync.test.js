'use strict';

// Custom themes (Customize view): public/modules/ui-ui-binding.js keeps the list in localStorage and copies it to the
// server (PUT /api/theme-presets); on every load the server copy replaces this browser's list. Two things used to go
// wrong together: the PUT's answer was never looked at, and a save the server did not take was then overwritten by the
// older server copy on the next load (the "Vertical focus" of a saved theme went back to the default).
// As in frontend-inline-handlers.test.js the real script runs in a vm sandbox, with the timer and the network under the
// test's control.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULES_DIR = path.join(__dirname, '..', '..', 'public', 'modules');
const SCRIPTS = ['utils.js', 'ui-discover.js', 'ui-shop-view.js', 'ui-ui-binding.js'];
const PRESETS_KEY = 'scrollscape_custom_presets';
const UNSYNCED_KEY = 'scrollscape_custom_presets_unsynced';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { const d = {}; d.promise = new Promise((resolve) => { d.resolve = resolve; }); return d; };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const preset = (id, over = {}) => ({ id, name: id, charUrl: 'https://example.com/a.png', charPosX: 50, charPosY: 100, ...over });

// `network` answers every fetch: (url, opts) => response | Promise | throws. Timers are held until fire() is called.
function makeEnv(network) {
  const storage = new Map();
  const requests = [];
  const toasts = [];
  const timers = [];
  const sandbox = {
    console,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: (k) => { storage.delete(k); },
    },
    fetch: (url, opts) => { requests.push({ url, opts }); return Promise.resolve().then(() => network(url, opts)); },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    t: (key) => key,
  };
  sandbox.window = sandbox;
  sandbox.document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild() {}, remove() {}, classList: { add() {}, remove() {}, toggle() {} } }),
    addEventListener() {},
    documentElement: { style: { setProperty() {}, removeProperty() {} }, getAttribute: () => '' },
    head: { appendChild() {} },
    body: { appendChild() {}, classList: { toggle() {}, remove() {} } },
  };
  vm.createContext(sandbox);
  for (const file of SCRIPTS) {
    const full = path.join(MODULES_DIR, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), sandbox, { filename: full });
  }
  // After the scripts: utils.js declares its own showToast, which would replace a stub given up front.
  sandbox.showToast = (...args) => { toasts.push(args); };
  return {
    ctx: sandbox,
    storage,
    requests,
    toasts,
    puts: () => requests.filter((r) => r.opts && r.opts.method === 'PUT'),
    // Runs the debounced save that is waiting, the way the 180 ms timer would.
    async fire() {
      const pending = timers.map((fn, i) => [fn, i]).filter(([fn]) => fn);
      assert.equal(pending.length, 1, 'exactly one save is waiting');
      const [fn, i] = pending[0];
      timers[i] = null;
      await fn();
    },
    waiting: () => timers.filter(Boolean).length,
  };
}

test('a save the server takes clears the "not synced" flag, and sends every field of the preset', async () => {
  const env = makeEnv(() => response(200, { ok: true }));
  env.ctx.saveCustomPresets([preset('custom-1')]);
  assert.equal(env.storage.get(UNSYNCED_KEY), '1', 'flagged as soon as it is queued');
  await env.fire();
  assert.equal(env.storage.has(UNSYNCED_KEY), false);
  assert.equal(env.toasts.length, 0);
  const sent = JSON.parse(env.puts()[0].opts.body);
  assert.equal(sent.presets[0].charPosY, 100, 'the vertical focus is in the request');
});

test('a PUT the server answers with an error keeps the flag and tells the user', async () => {
  const env = makeEnv(() => response(500, {}));
  env.ctx.saveCustomPresets([preset('custom-1')]);
  await env.fire();
  assert.equal(env.storage.get(UNSYNCED_KEY), '1');
  assert.equal(env.toasts.length, 1);
  assert.equal(env.toasts[0][0], 'customization.toastPresetSyncFailed');
  assert.equal(env.toasts[0][2], 'error');
  assert.equal(JSON.parse(env.storage.get(PRESETS_KEY))[0].charPosY, 100, 'this browser keeps the theme');
});

test('a PUT that never reaches the server keeps the flag and tells the user', async () => {
  const env = makeEnv(() => { throw new TypeError('Failed to fetch'); });
  env.ctx.saveCustomPresets([preset('custom-1')]);
  await env.fire();
  assert.equal(env.storage.get(UNSYNCED_KEY), '1');
  assert.equal(env.toasts.length, 1);
});

test('on load, a list that never reached the server is sent again instead of being replaced by the server copy', async () => {
  const stale = [preset('custom-1', { charPosY: 50 })];
  const env = makeEnv((url, opts) => (opts && opts.method === 'PUT' ? response(200, { ok: true }) : response(200, { presets: stale })));
  env.storage.set(PRESETS_KEY, JSON.stringify([preset('custom-1', { charPosY: 100 })]));
  env.storage.set(UNSYNCED_KEY, '1');
  await env.ctx.syncCustomPresetsFromDisk();
  assert.equal(JSON.parse(env.storage.get(PRESETS_KEY))[0].charPosY, 100, 'the browser copy is untouched');
  await env.fire();
  assert.equal(JSON.parse(env.puts()[0].opts.body).presets[0].charPosY, 100, 'and it is what the server receives');
  assert.equal(env.storage.has(UNSYNCED_KEY), false, 'flag cleared once the server took it');
});

test('on load with nothing waiting, the server copy still wins (another device\'s change comes through)', async () => {
  const fromServer = [preset('custom-9', { charPosY: 20 })];
  const env = makeEnv(() => response(200, { presets: fromServer }));
  env.storage.set(PRESETS_KEY, JSON.stringify([preset('custom-1')]));
  await env.ctx.syncCustomPresetsFromDisk();
  assert.deepEqual(JSON.parse(env.storage.get(PRESETS_KEY)).map((p) => p.id), ['custom-9']);
  assert.equal(env.waiting(), 0);
});

test('an empty server is filled from this browser, as before', async () => {
  const env = makeEnv(() => response(200, { presets: [] }));
  env.storage.set(PRESETS_KEY, JSON.stringify([preset('custom-1')]));
  await env.ctx.syncCustomPresetsFromDisk();
  await env.fire();
  assert.deepEqual(JSON.parse(env.puts()[0].opts.body).presets.map((p) => p.id), ['custom-1']);
});

test('an unreadable server answer on load changes nothing', async () => {
  const env = makeEnv(() => response(503, {}));
  env.storage.set(PRESETS_KEY, JSON.stringify([preset('custom-1')]));
  env.storage.set(UNSYNCED_KEY, '1');
  await env.ctx.syncCustomPresetsFromDisk();
  assert.equal(env.waiting(), 0);
  assert.equal(env.storage.get(UNSYNCED_KEY), '1');
  assert.equal(JSON.parse(env.storage.get(PRESETS_KEY)).length, 1);
});

test('a slow earlier request that finishes after a newer save does not clear the flag', async () => {
  const first = deferred();
  let n = 0;
  const env = makeEnv((url, opts) => (opts && opts.method === 'PUT' && ++n === 1 ? first.promise : response(200, { ok: true })));
  env.ctx.saveCustomPresets([preset('custom-1', { charPosY: 10 })]);
  const firstDone = env.fire(); // request 1 is in flight
  await settle();
  env.ctx.saveCustomPresets([preset('custom-1', { charPosY: 100 })]); // newer save queued behind it
  first.resolve(response(200, { ok: true }));
  await firstDone;
  assert.equal(env.storage.get(UNSYNCED_KEY), '1', 'the newer list has not been sent yet');
  await env.fire();
  assert.equal(env.storage.has(UNSYNCED_KEY), false);
  assert.equal(JSON.parse(env.puts()[1].opts.body).presets[0].charPosY, 100);
});

test('the flag and the toast keys exist, in both languages', () => {
  for (const name of ['en-GB', 'pt-PT']) {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MODULES_DIR, 'i18n', 'locales', name + '.js'), 'utf8'), sandbox);
    const locale = sandbox.window.ScrollScapeI18nLocales[name];
    for (const key of ['customization.toastPresetSyncFailed', 'customization.toastPresetSyncFailedHint']) {
      assert.equal(typeof locale[key], 'string', name + ' ' + key);
      assert.ok(locale[key].length > 10);
    }
  }
});
