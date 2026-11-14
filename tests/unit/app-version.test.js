'use strict';

// The version of the app in the corner of Settings: GET /api/version (server/routes/version.js, server/modules/common/app-version.js) and the
// label that shows it (public/modules/ui-settings-version.js, run here in a vm sandbox with a stub api()).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const express = require('express');

const ROOT = path.join(__dirname, '..', '..');
const { getAppVersion } = require('../../server/modules/common/app-version');
const { registerVersionRoutes } = require('../../server/routes/version');
const pkg = require('../../package.json');

const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

test('the version is the one package.json says, and anything that is not a plain version number is empty', () => {
  assert.equal(getAppVersion(), pkg.version);
  assert.match(getAppVersion(), /^\d+\.\d+\.\d+$/);
  assert.equal(getAppVersion(() => ({ version: '3.3.1-beta.2' })), '3.3.1-beta.2');
  for (const bad of [{}, { version: 3 }, { version: '' }, { version: '3.3' }, { version: '<script>1.2.3' }, { version: '1.2.3\n' }, null, undefined]) {
    assert.equal(getAppVersion(() => bad), '', JSON.stringify(bad));
  }
  assert.equal(getAppVersion(() => { throw new Error('no package.json in the snapshot'); }), '', 'a label never fails the app');
});

test('GET /api/version answers { ok, version } and nothing else', async () => {
  const app = express();
  registerVersionRoutes(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/version`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, version: pkg.version });
  } finally {
    server.close();
  }
});

function labelWith(apiImpl, element) {
  const context = { api: apiImpl, document: { getElementById: (id) => (id === 'settingsAppVersion' ? element : null) }, console };
  vm.createContext(context);
  vm.runInContext(read('public', 'modules', 'ui-settings-version.js'), context, { filename: 'ui-settings-version.js' });
  return context;
}

test('the label shows v<version>, asks the server once, and a server that cannot say leaves it empty without an error', async () => {
  const el = { textContent: '' };
  let asked = 0;
  const ctx = labelWith(async (route) => { asked += 1; assert.equal(route, '/api/version'); return { ok: true, version: '3.3.1' }; }, el);
  await ctx.fillSettingsAppVersion();
  assert.equal(el.textContent, 'v3.3.1');
  el.textContent = '';
  await ctx.fillSettingsAppVersion();
  assert.equal(el.textContent, 'v3.3.1', 'filled again when Settings opens again');
  assert.equal(asked, 1, 'but the server is asked once');

  const none = { textContent: '' };
  await labelWith(async () => ({ ok: true, version: '' }), none).fillSettingsAppVersion();
  assert.equal(none.textContent, '');
  const old = { textContent: '' };
  await labelWith(async () => { throw new Error('404'); }, old).fillSettingsAppVersion();
  assert.equal(old.textContent, '', 'an old server with no such route');
  await labelWith(async () => ({ ok: true, version: '1.2.3' }), null).fillSettingsAppVersion(); // no label in the page: nothing to do, nothing thrown
});

test('a failed ask is asked again the next time, and the version is set as text, never as markup', async () => {
  const el = { textContent: '' };
  let calls = 0;
  const ctx = labelWith(async () => { calls += 1; if (calls === 1) throw new Error('offline'); return { ok: true, version: '<img src=x onerror=PWN()>' }; }, el);
  await ctx.fillSettingsAppVersion();
  assert.equal(el.textContent, '');
  await ctx.fillSettingsAppVersion();
  assert.equal(calls, 2);
  assert.equal(el.textContent, 'v<img src=x onerror=PWN()>', 'textContent, so it is only text');
});

test('the corner is in the Settings markup, loaded by the page, called when Settings opens, and styled', () => {
  assert.match(read('public', 'modules', 'ui-settings-modal-html.js'), /<span id="settingsAppVersion" class="settings-app-version"/);
  const html = read('public', 'index.html');
  assert.ok(html.indexOf('ui-settings-version.js') > 0 && html.indexOf('ui-settings-version.js') < html.indexOf('ui-settings-modal.js'));
  assert.match(read('public', 'modules', 'ui-settings-modal.js'), /fillSettingsAppVersion\(\)/);
  assert.match(read('public', 'css-modules', 'settings-modal.css'), /\.settings-app-version\s*\{/);
  assert.match(read('server', 'routes', 'bootstrap.js'), /registerVersionRoutes\(app\)/);
});
