'use strict';

// Updates of the sources written for the extension engine: which have a newer extension in the person's Suwayomi-Server (with what changed), and
// updating one (the extension in that server, then the source written again for the card's Check). Everything runs against a made-up server and a
// made-up catalog. What matters: the package is always the repository's (the body holds the id of an installed source and nothing else), nothing
// is updated unless the person confirmed, the routes stay on this computer, and what a third party says (a changelog) is only ever plain text.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const engineRoutes = require('../../server/routes/source-engine');
const { createSuwayomiService } = require('../../server/modules/suwayomi/service');
const { createCatalog, createCaches } = require('../../server/modules/source-catalog/catalog');
const baseConfig = require('../../server/config/catalog');
const { isPrivilegedRoute } = require('../../server/middleware/local-only');
const { createFailure } = require('../../server/modules/source-import/failure');

const SOURCE_ID = '6289731484943315811';
const OTHER_ID = '1111111111111111111';
const PKG = 'eu.kanade.tachiyomi.extension.en.alpha';
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const closeAfter = (t, server) => t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function rig(over = {}) {
  const calls = { list: 0, update: [], site: [], changelog: [] };
  const suwayomi = {
    getConfig: async () => ({ baseUrl: 'http://suwayomi.local:4567' }),
    listExtensions: async () => { calls.list += 1; return over.extensions || [{ pkg: PKG, name: 'Alpha', versionName: '1.7.0', installed: true, hasUpdate: true }]; },
    updateExtension: async (pkg) => { calls.update.push(pkg); return { updated: true }; },
    listSources: async () => [{ id: SOURCE_ID, name: 'Alpha Scans', lang: 'en', supportsLatest: true, isNsfw: false, baseUrl: '' }],
    ...over.suwayomi,
  };
  const catalog = {
    engineSiteOfSourceId: async (id) => { calls.site.push(id); if (id !== SOURCE_ID) throw createFailure('The repository no longer lists this source.', 404); return { pkg: PKG, sourceId: SOURCE_ID, name: 'Alpha Scans', lang: 'en', warning: 'SAFE', id: `sw-${SOURCE_ID}` }; },
    changelogFor: async (pkg) => { calls.changelog.push(pkg); return over.changelog || { url: `https://github.com/keiyoushi/extensions-source/commits/main/src/en/alpha`, text: 'Fixed the chapter list.' }; },
    ...over.catalog,
  };
  return { calls, suwayomi, catalog, installed: over.installed || [SOURCE_ID] };
}

async function start(t, r) {
  engineRoutes.configure({ suwayomi: r.suwayomi, catalog: () => r.catalog, installed: async () => r.installed });
  const app = express();
  app.use(express.json());
  engineRoutes.registerSourceEngineRoutes(app);
  const server = await listen(app);
  closeAfter(t, server);
  const port = server.address().port;
  return { updates: (body = {}) => post(port, '/api/sources/engine/updates', body), update: (body) => post(port, '/api/sources/engine/update', body) };
}

// ── which sources have an update ─────────────────────────────────────────

test('the routes are on the guard list: they stay on this computer', () => {
  for (const path of ['/api/sources/engine/updates', '/api/sources/engine/update']) assert.equal(isPrivilegedRoute({ method: 'POST', originalUrl: path }), true, path);
});

test('a source whose extension has a newer version is listed with its version and what changed; one that is up to date is not', async (t) => {
  const r = rig({ installed: [SOURCE_ID, OTHER_ID], extensions: [
    { pkg: PKG, name: 'Alpha', versionName: '1.7.0', installed: true, hasUpdate: true },
    { pkg: 'eu.kanade.tachiyomi.extension.en.beta', name: 'Beta', versionName: '2.0.0', installed: true, hasUpdate: false },
  ] });
  r.catalog.engineSiteOfSourceId = async (id) => (id === SOURCE_ID
    ? { pkg: PKG, sourceId: SOURCE_ID, name: 'Alpha Scans', lang: 'en', warning: 'SAFE', id: `sw-${SOURCE_ID}` }
    : { pkg: 'eu.kanade.tachiyomi.extension.en.beta', sourceId: OTHER_ID, name: 'Beta', lang: 'en', warning: 'SAFE', id: `sw-${OTHER_ID}` });
  const { updates } = await start(t, r);
  const answer = await updates();
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body, { ok: true, checked: 2, updates: [{ id: `sw-${SOURCE_ID}`, name: 'Alpha Scans', version: '1.7.0', changelogUrl: 'https://github.com/keiyoushi/extensions-source/commits/main/src/en/alpha', changelog: 'Fixed the chapter list.' }] });
  assert.equal(r.calls.list, 1, 'one call to the server, whatever the number of sources');
  assert.deepEqual(r.calls.changelog, [PKG], 'a changelog is asked for only where there is an update');
});

test('nothing installed asks nothing of the server; a source the repository no longer lists is skipped; a server that fails is said', async (t) => {
  const none = rig({ installed: [] });
  assert.deepEqual((await (await start(t, none)).updates()).body, { ok: true, updates: [], checked: 0 });
  assert.equal(none.calls.list, 0);
  const gone = rig({ installed: [OTHER_ID] });
  assert.deepEqual((await (await start(t, gone)).updates()).body, { ok: true, updates: [], checked: 1 });
  const down = rig({ suwayomi: { listExtensions: async () => { throw Object.assign(new Error('Suwayomi-Server could not list its extensions (HTTP 500).'), { statusCode: 502 }); } } });
  const failed = await (await start(t, down)).updates();
  assert.equal(failed.status, 502);
  assert.match(JSON.stringify(failed.body), /could not list its extensions/);
  const noServer = rig({ suwayomi: { getConfig: async () => null } });
  assert.equal((await (await start(t, noServer)).updates()).status, 400);
});

test('an extension that is not installed in the server, or has no update flag, is not offered', async (t) => {
  const r = rig({ extensions: [{ pkg: PKG, name: 'Alpha', versionName: '1.7.0', installed: false, hasUpdate: true }] });
  assert.deepEqual((await (await start(t, r)).updates()).body.updates, []);
});

// ── updating one ─────────────────────────────────────────────────────────

test('updating asks the server for the repository\'s package of that source, then answers the source written again, in the shape of a link answer', async (t) => {
  const r = rig();
  const { update } = await start(t, r);
  const answer = await update({ id: `sw-${SOURCE_ID}`, acknowledge: true, pkg: 'evil.package', url: 'https://evil.example' });
  assert.equal(answer.status, 200);
  assert.deepEqual({ ok: answer.body.ok, status: answer.body.status, id: answer.body.id, engine: answer.body.engine }, { ok: true, status: 'generated', id: `sw-${SOURCE_ID}`, engine: 'suwayomi' });
  assert.match(answer.body.code, new RegExp(`source=${SOURCE_ID}`));
  assert.deepEqual(r.calls.update, [PKG], 'the package is the repository\'s, whatever the browser sent');
  assert.ok(answer.body.notes.some((n) => /was updated in your Suwayomi-Server/.test(n)));
});

test('nothing is updated unless the person confirmed, and only an installed engine source can be: any other id is refused before the server is asked', async (t) => {
  const r = rig();
  // The route allows a few a minute, so the bad requests are spread over several runs of it.
  const first = await start(t, r);
  for (const body of [{ id: `sw-${SOURCE_ID}` }, { id: `sw-${SOURCE_ID}`, acknowledge: 'true' }, { id: `sw-${SOURCE_ID}`, acknowledge: 1 }]) assert.equal((await first.update(body)).status, 400, JSON.stringify(body));
  const ids = [SOURCE_ID, `sw-${OTHER_ID}`, 'sw-', 'sw-1/../2', 'sw-abc', '../x', '', 7, null, `sw-${'9'.repeat(30)}`];
  for (let at = 0; at < ids.length; at += 3) {
    const { update } = await start(t, r);
    for (const id of ids.slice(at, at + 3)) assert.equal((await update({ id, acknowledge: true })).status, 404, String(id));
  }
  assert.deepEqual(r.calls.update, [], 'the server was never asked');
});

test('a failure of the server on the update is said in its own sentence, and nothing is written', async (t) => {
  const r = rig({ suwayomi: { updateExtension: async () => { throw Object.assign(new Error('Suwayomi-Server could not update the extension (HTTP 500). It said: Server Error'), { statusCode: 502 }); } } });
  const answer = await (await start(t, r)).update({ id: `sw-${SOURCE_ID}`, acknowledge: true });
  assert.equal(answer.status, 502);
  assert.match(JSON.stringify(answer.body), /could not update the extension/);
  const gone = rig({ suwayomi: { listSources: async () => [] } });
  assert.equal((await (await start(t, gone)).update({ id: `sw-${SOURCE_ID}`, acknowledge: true })).status, 409);
});

// ── the Suwayomi service ─────────────────────────────────────────────────

const reply = (status, body, text) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => (text === undefined ? JSON.stringify(body) : text), headers: { get: () => 'application/json' } });
const clientWith = (answer) => {
  const calls = [];
  const service = createSuwayomiService({ readStore: async () => ({ settings: { suwayomiUrl: 'http://suwayomi.local:4567/', suwayomiUsername: 'u', suwayomiPassword: 'p' } }), fetchImpl: async (url, init) => { calls.push({ url, init }); return answer(url, init); } });
  return { service, calls };
};

test('the extension list comes back as plain values, with the version and whether there is an update; a bad answer is an error', async () => {
  const { service, calls } = clientWith(() => reply(200, [
    { pkgName: PKG, name: 'Alpha', versionName: '1.7.0', installed: true, hasUpdate: true, extra: 'x' },
    { pkgName: '../evil', name: 'Evil', versionName: '1', installed: true, hasUpdate: true },
    null,
    { pkgName: 'eu.kanade.tachiyomi.extension.en.beta', name: 'B'.repeat(200), versionName: 3, installed: 1, hasUpdate: 0 },
  ]));
  const list = await service.listExtensions();
  assert.deepEqual(list, [
    { pkg: PKG, name: 'Alpha', versionName: '1.7.0', installed: true, hasUpdate: true },
    { pkg: 'eu.kanade.tachiyomi.extension.en.beta', name: 'B'.repeat(80), versionName: '3', installed: true, hasUpdate: false },
  ]);
  assert.equal(calls[0].url, 'http://suwayomi.local:4567/api/v1/extension/list');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  await assert.rejects(clientWith(() => reply(200, { not: 'a list' })).service.listExtensions(), (err) => err.statusCode === 502);
  await assert.rejects(clientWith(() => reply(500)).service.listExtensions(), (err) => err.statusCode === 502 && /HTTP 500/.test(err.message));
  await assert.rejects(clientWith(() => reply(401)).service.listExtensions(), (err) => err.statusCode === 401);
});

test('updating an extension: a success or a redirect is done, a failure carries the server\'s line; a package name that is not one asks nothing', async () => {
  const { service, calls } = clientWith(() => reply(201));
  assert.deepEqual(await service.updateExtension(PKG), { updated: true });
  assert.equal(calls[0].url, `http://suwayomi.local:4567/api/v1/extension/update/${PKG}`);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.deepEqual(await clientWith(() => reply(302)).service.updateExtension(PKG), { updated: false });
  await assert.rejects(clientWith(() => reply(500, {}, '<html>Server Error</html>')).service.updateExtension(PKG), (err) => err.statusCode === 502 && /It said: Server Error$/.test(err.message) && !/</.test(err.message));
  await assert.rejects(clientWith(() => reply(401)).service.updateExtension(PKG), (err) => err.statusCode === 401);
  for (const bad of ['', undefined, '../x', 'a b', 'a/b', 'x'.repeat(200)]) await assert.rejects(service.updateExtension(bad), (err) => err.statusCode === 400, String(bad));
  assert.equal(calls.length, 1);
});

// ── the catalog: the source by its id, and what changed ──────────────────

const ext = (name, id) => ({ name, packageName: `eu.kanade.tachiyomi.extension.en.${name.toLowerCase()}`, versionName: '1.0.1', contentWarning: 'CONTENT_WARNING_SAFE', sources: [{ id, name, language: 'en', homeUrl: `https://${name.toLowerCase()}.example/` }] });
const INDEX = { name: 'Repo', extensionList: { extensions: [ext('Alpha', SOURCE_ID), ext('Gamma', OTHER_ID)] } };
function catalogWith(over = {}) {
  const asked = [];
  const fetchText = async (url) => {
    asked.push(url);
    if (over.fetchText) { const answer = await over.fetchText(url); if (answer) return answer; }
    if (url === baseConfig.repoIndexUrl) return { status: 200, text: JSON.stringify(INDEX) };
    return { status: 404, text: '' };
  };
  const config = { ...baseConfig, allowedWarnings: over.allowedWarnings || baseConfig.allowedWarnings };
  const catalog = createCatalog({ fetchText, caches: createCaches(''), config, denylist: () => over.denylist || [], resolver: { resolve4: async () => [], resolve6: async () => [] }, sleep: async () => {} });
  t_after.push(() => catalog.close());
  return { catalog, asked };
}
const t_after = [];
test.after(() => { t_after.forEach((fn) => fn()); });

test('the catalog finds the extension of an engine source by the id the server gave it: the repository\'s package, the edition\'s cap and the dangerous list apply', async () => {
  const { catalog } = catalogWith();
  assert.deepEqual(await catalog.engineSiteOfSourceId(SOURCE_ID), { pkg: PKG, sourceId: SOURCE_ID, name: 'Alpha', lang: 'en', warning: 'SAFE', id: `sw-${SOURCE_ID}` });
  await assert.rejects(catalog.engineSiteOfSourceId('42'), (err) => err.statusCode === 404);
  for (const bad of ['', 'abc', '1/2', undefined, null, '9'.repeat(30)]) await assert.rejects(catalog.engineSiteOfSourceId(bad), (err) => err.statusCode === 400, String(bad));
  await assert.rejects(catalogWith({ denylist: ['alpha.example'] }).catalog.engineSiteOfSourceId(SOURCE_ID), (err) => err.statusCode === 403);
  await assert.rejects(catalogWith({ allowedWarnings: ['NSFW'] }).catalog.engineSiteOfSourceId(SOURCE_ID), (err) => err.statusCode === 403);
});

test('what changed: always a link to the history of the extension\'s folder, and the start of its CHANGELOG.md as plain text when there is one; kept for a day', async () => {
  const text = `# Changes




- Fixed <b>chapters</b>${String.fromCharCode(0)}${String.fromCharCode(0x202e)} and more
${'x'.repeat(5000)}`;
  const { catalog, asked } = catalogWith({ fetchText: async (url) => (url.endsWith('/src/en/alpha/CHANGELOG.md') ? { status: 200, text } : null) });
  const log = await catalog.changelogFor(PKG);
  assert.equal(log.url, 'https://github.com/keiyoushi/extensions-source/commits/main/src/en/alpha');
  assert.ok(log.text.startsWith('# Changes\n\n- Fixed <b>chapters</b>'), log.text.slice(0, 60));
  assert.ok(log.text.length <= 1500);
  assert.ok([...log.text].every((ch) => ch.codePointAt(0) !== 0 && ch.codePointAt(0) !== 0x202e), 'control and direction characters are gone');
  const before = asked.length;
  assert.deepEqual(await catalog.changelogFor(PKG), log);
  assert.equal(asked.length, before, 'asked once');
  const none = await catalogWith().catalog.changelogFor('eu.kanade.tachiyomi.extension.en.gamma');
  assert.deepEqual(none, { url: 'https://github.com/keiyoushi/extensions-source/commits/main/src/en/gamma', text: '' }, 'no file is not an error');
  const failing = await catalogWith({ fetchText: async () => { throw new Error('offline'); } }).catalog.changelogFor('eu.kanade.tachiyomi.extension.en.delta');
  assert.equal(failing.text, '');
  for (const bad of ['', undefined, '../x', 'eu.kanade.tachiyomi.extension.en.a/b', 'evil.package', 'eu.kanade.tachiyomi.extension.en.x"y']) assert.deepEqual(await catalogWith().catalog.changelogFor(bad), { url: '', text: '' }, String(bad));
});
