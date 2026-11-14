'use strict';

// "Reset all settings" (and the reset of the section that holds the Disabled sources list) empties the browser's
// copy of the list. The server keeps its own copy for System Health, and start-up only ever ADDS to it, so without a
// push after the reset the server would keep skipping sources the screen now shows as switched on. The real
// public/modules/ui-settings.js runs in a vm sandbox (no browser), like the other front-end tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', '..', 'public', 'modules', 'ui-settings.js');

// An array made inside the vm context has that realm's Array.prototype, which deepStrictEqual refuses.
const plain = (value) => JSON.parse(JSON.stringify(value));

function makeEnv({ withPush = true } = {}) {
  const pushed = [];
  const stored = {};
  const sandbox = {
    console,
    localStorage: { getItem: (k) => stored[k] ?? null, setItem: (k, v) => { stored[k] = v; }, removeItem: (k) => { delete stored[k]; } },
    state: { settings: {}, chapterCountCache: {}, readChapters: new Set(), flaggedChapters: new Set(), readingProgress: {}, installedSources: {} },
    document: { getElementById: () => null, documentElement: { dataset: {} } },
  };
  if (withPush) sandbox.pushDisabledSourcesToServer = (list) => { pushed.push(JSON.parse(JSON.stringify(list))); };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), sandbox, { filename: FILE });
  sandbox.state.settings.disabledSourceIds = ['alpha', 'beta'];
  return { sandbox, pushed };
}

test('resetting the section that holds the list pushes the emptied list to the server', () => {
  const { sandbox, pushed } = makeEnv();
  sandbox.window.resetSettingsSection(['disabledSourceIds']);
  assert.deepEqual(plain(sandbox.state.settings.disabledSourceIds), []);
  assert.deepEqual(pushed, [[]]);
});

test('"Reset all settings" pushes it too, once', () => {
  const { sandbox, pushed } = makeEnv();
  sandbox.window.resetSettingsSection(Object.keys(vm.runInContext('DEFAULT_SETTINGS', sandbox)));
  assert.deepEqual(pushed, [[]]);
});

test('resetting something else leaves the server alone', () => {
  const { sandbox, pushed } = makeEnv();
  const other = Object.keys(vm.runInContext('DEFAULT_SETTINGS', sandbox)).find((key) => key !== 'disabledSourceIds');
  sandbox.window.resetSettingsSection([other]);
  sandbox.window.resetSettingsSection(other);
  assert.deepEqual(pushed, []);
  assert.deepEqual(plain(sandbox.state.settings.disabledSourceIds), ['alpha', 'beta'], 'and the list is untouched');
});

test('without the sync script the reset works exactly as before', () => {
  const { sandbox } = makeEnv({ withPush: false });
  assert.doesNotThrow(() => sandbox.window.resetSettingsSection(['disabledSourceIds']));
  assert.deepEqual(plain(sandbox.state.settings.disabledSourceIds), []);
});
