'use strict';

// The whole path of "Allow installing sources from other devices", with the real pieces and nothing replaced: the real store on disk, the real login service,
// the real auth gate, the real settings route (the toggle's POST), and the real requireThisComputer guard on a route of the import tool. A request is made to look
// like another device by its Host header (the sockets are all loopback). The point is that the saved setting really reaches the guard: a toggle that saves
// but is never read would pass every unit test of the parts and still leave the person looking at the same refusal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const store = require('../../server/store');
const { createAuthService } = require('../../server/modules/auth/service');
const { createAuthGate, SESSION_COOKIE } = require('../../server/middleware/auth-gate');
const { requireThisComputer, configureRemoteImportSetting } = require('../../server/middleware/local-only');
const { registerSettingsRoutes } = require('../../server/routes/settings');

const NAMES = ['SCROLLSCAPE_ALLOW_REMOTE_IMPORT', 'SCROLLSCAPE_ADMIN_LOCAL_ONLY'];
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));

async function startApp(t) {
  NAMES.forEach((n) => { delete process.env[n]; });
  t.after(() => { NAMES.forEach((n) => { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; }); configureRemoteImportSetting(async () => false); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-remote-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, JSON.stringify({ repos: [], installedSources: {}, history: [], favorites: [], settings: {} }), 'utf8');
  store.configure(storePath);
  await store.initStore();
  const authService = createAuthService({ readStore: store.readStore, writeStore: store.writeStore });
  await authService.setPassword({ newPassword: 'a long test password' });
  const { token } = await authService.login('a long test password');
  // exactly what server.js does
  configureRemoteImportSetting(async () => {
    const current = await store.readStore();
    return !!(current && current.settings && current.settings.allowRemoteImport === true);
  });
  const app = express();
  app.use(express.json());
  app.use('/api', createAuthGate(authService));
  registerSettingsRoutes(app, { applySolver: () => {} });
  for (const route of ['/api/sources/import/preview', '/api/sources/catalog/list', '/api/sources/engine/prepare']) {
    app.post(route, requireThisComputer, (req, res) => res.json({ ok: true, reached: route }));
  }
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  // Another device: the address of the server in the Host header, the cookie of a logged-in browser, and what a browser sends from the app's own page.
  const remote = (method, route, body, { cookie = `${SESSION_COOKIE}=${token}`, extra = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers = { Host: '192.168.1.97:4000', Origin: 'http://192.168.1.97:4000', 'Sec-Fetch-Site': 'same-origin', ...(cookie ? { Cookie: cookie } : {}), ...extra, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  return { remote, token };
}

test('a logged-in browser on another device is refused until the toggle is saved, and is answered right after, with nothing restarted', async (t) => {
  const { remote } = await startApp(t);
  for (const route of ['/api/sources/import/preview', '/api/sources/catalog/list', '/api/sources/engine/prepare']) {
    const before = await remote('POST', route, {});
    assert.equal(before.status, 403, route);
    assert.equal(before.body.code, 'LOCAL_ONLY', route);
  }
  const save = await remote('POST', '/api/settings', { allowRemoteImport: true });
  assert.equal(save.status, 200, 'a logged-in remote session can save the toggle');
  const read = await remote('GET', '/api/settings');
  assert.equal(read.body.data.allowRemoteImport, true, 'and it is what the page reads back');
  for (const route of ['/api/sources/import/preview', '/api/sources/catalog/list', '/api/sources/engine/prepare']) {
    const after = await remote('POST', route, {});
    assert.equal(after.status, 200, `${route} after the toggle`);
    assert.equal(after.body.reached, route);
  }
});

test('turning the toggle off closes it again at once, and a request with no login or another session is never let through', async (t) => {
  const { remote } = await startApp(t);
  await remote('POST', '/api/settings', { allowRemoteImport: true });
  assert.equal((await remote('POST', '/api/sources/import/preview', {})).status, 200);
  assert.equal((await remote('POST', '/api/sources/import/preview', {}, { cookie: '' })).status, 401, 'no cookie: the gate answers first');
  assert.equal((await remote('POST', '/api/sources/import/preview', {}, { cookie: `${SESSION_COOKIE}=not-a-session` })).status, 401);
  await remote('POST', '/api/settings', { allowRemoteImport: false });
  assert.equal((await remote('POST', '/api/sources/import/preview', {})).status, 403);
});

test('a toggle sent as text, a number or an object does not turn it on, and a cross-site request is refused even with it on', async (t) => {
  const { remote } = await startApp(t);
  for (const value of ['true', 1, {}, [], null]) {
    await remote('POST', '/api/settings', { allowRemoteImport: value });
    assert.equal((await remote('POST', '/api/sources/import/preview', {})).status, 403, JSON.stringify(value));
  }
  await remote('POST', '/api/settings', { allowRemoteImport: true });
  assert.equal((await remote('POST', '/api/sources/import/preview', {}, { extra: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await remote('POST', '/api/sources/import/preview', {}, { extra: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-site' } })).status, 403);
  assert.equal((await remote('POST', '/api/sources/import/preview', {})).status, 200, 'the app\'s own page is the one that is let through');
});

test('the environment\'s "admin local only" still wins over a saved toggle', async (t) => {
  const { remote } = await startApp(t);
  await remote('POST', '/api/settings', { allowRemoteImport: true });
  process.env.SCROLLSCAPE_ADMIN_LOCAL_ONLY = '1';
  const refused = await remote('POST', '/api/sources/import/preview', {});
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'LOCAL_ONLY');
});
