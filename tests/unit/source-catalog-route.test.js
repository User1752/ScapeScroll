'use strict';

// The catalog's route (POST /api/sources/catalog/list) and the way a row of the catalog reaches the generator
// (POST /api/sources/import/link with { catalog: { key } }). The catalog itself is replaced by a recorder: what matters here is who may
// ask, what is passed on and what is not, and that the address a source is written for is always the catalog's, never the browser's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const catalogRoutes = require('../../server/routes/source-catalog');
const importRoutes = require('../../server/routes/source-import');
const { isPrivilegedRoute } = require('../../server/middleware/local-only');
const { createFailure } = require('../../server/modules/source-import/failure');

function request(port, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function start(t, { catalog, generate } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-catalog-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  catalogRoutes.configure({ catalog });
  importRoutes.configure({ stagingDir: path.join(dir, 'staging'), denylistFile: '', generate: generate || (async () => ({ status: 'refused', stage: 'probe', message: 'x', probe: {} })) });
  const app = express();
  app.use(express.json());
  catalogRoutes.registerSourceCatalogRoutes(app);
  importRoutes.registerSourceImportRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  return { list: (body, headers) => request(port, '/api/sources/catalog/list', body, headers), link: (body, headers) => request(port, '/api/sources/import/link', body, headers) };
}

const recorder = (over = {}) => {
  const calls = { list: [], siteOf: [], failed: [] };
  return {
    calls,
    list: async (params, installed, options) => { calls.list.push({ params, installed, options }); return { rows: [], total: 0, offset: 0, limit: 60, lang: 'en', languages: [], counts: {}, pending: { themes: 0, dns: 0, paused: false }, stale: false, fetchedAt: 0 }; },
    siteOf: async (key) => { calls.siteOf.push(key); return { url: 'https://alpha.example', name: 'Alpha', pkg: 'p', theme: 'madara', warning: 'SAFE', id: 'alpha' }; },
    markFailed: async (key, reason) => { calls.failed.push([key, reason]); return true; },
    ...over,
  };
};

test('the list route is on the guard list: it stays on this computer, and a request that is not from it is refused before anything is asked', async (t) => {
  assert.equal(isPrivilegedRoute({ method: 'POST', originalUrl: '/api/sources/catalog/list' }), true);
  assert.equal(isPrivilegedRoute({ method: 'POST', originalUrl: '/API/Sources/Catalog/LIST/' }), true);
  const catalog = recorder();
  const { list } = await start(t, { catalog });
  for (const headers of [{ Host: 'localhost.evil.example' }, { 'X-Forwarded-For': '203.0.113.9' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const answer = await list({}, headers);
    assert.equal(answer.status, 403, JSON.stringify(headers));
    assert.equal(answer.body.code, 'LOCAL_ONLY');
  }
  assert.equal(catalog.calls.list.length, 0);
});

test('the list route passes on only the fields it knows, cut and checked, and answers what the catalog answered', async (t) => {
  const catalog = recorder();
  const { list } = await start(t, { catalog });
  const answer = await list({ lang: 'pt-BR', q: 'x'.repeat(500), warnings: ['SAFE', 7, null, 'MIXED', 'NSFW', 'EXTRA'], nativeOnly: false, hideCloudflare: true, hideAdult: true, hideInstalled: true, onlyInstalled: true, offset: '60', limit: 25, url: 'https://evil.example', catalog: { key: 'x' } });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  assert.equal(answer.body.lang, 'en');
  const { params } = catalog.calls.list[0];
  assert.deepEqual(Object.keys(params).sort(), ['hideAdult', 'hideCloudflare', 'hideInstalled', 'lang', 'limit', 'nativeOnly', 'offset', 'onlyInstalled', 'q', 'warnings']);
  assert.equal(params.lang, 'pt-BR');
  assert.equal(params.q.length, 80);
  assert.deepEqual(params.warnings, ['SAFE', 'MIXED', 'NSFW'], 'at most three, and only text');
  assert.equal(params.nativeOnly, false);
  assert.equal(params.hideCloudflare, true);
  assert.equal(params.hideAdult, true);
  assert.equal(params.hideInstalled, true);
  assert.equal(params.onlyInstalled, true);
  assert.equal(params.offset, 60);
  assert.equal(params.limit, 25);
});

test('a body that is not what the screen sends gets the defaults instead of an error', async (t) => {
  const catalog = recorder();
  const { list } = await start(t, { catalog });
  for (const body of [{}, { lang: 5, q: [], warnings: 'SAFE', nativeOnly: 'no', hideCloudflare: 'yes', offset: 'x', limit: 'y' }]) assert.equal((await list(body)).status, 200);
  const [first, second] = catalog.calls.list.map((call) => call.params);
  for (const params of [first, second]) {
    assert.equal(params.lang, '');
    assert.equal(params.q, '');
    assert.equal(params.nativeOnly, true);
    assert.equal(params.hideCloudflare, false);
    assert.equal(params.hideAdult, false);
    assert.equal(params.hideInstalled, false);
    assert.equal(params.onlyInstalled, false);
    assert.equal(params.offset, 0);
    assert.equal(params.limit, undefined);
  }
  assert.equal(second.warnings, undefined);
});

test('the marks of what is installed are passed to the catalog, and a store that cannot be read only leaves them empty', async (t) => {
  const catalog = recorder();
  const { list } = await start(t, { catalog });
  assert.equal((await list({})).status, 200);
  const { installed } = catalog.calls.list[0];
  assert.ok(installed.ids instanceof Set && installed.bases instanceof Set);
});

test('the catalog is told whether a Suwayomi-Server is set up, and a store that cannot say counts as not set up', async (t) => {
  for (const [hasEngine, expected] of [[async () => true, true], [async () => false, false], [async () => { throw new Error('store not ready'); }, false]]) {
    const catalog = recorder();
    catalogRoutes.configure({ catalog, hasEngine: async () => { try { return await hasEngine(); } catch (_) { return false; } } });
    const { list } = await start(t, { catalog });
    assert.equal((await list({})).status, 200);
    assert.equal(catalog.calls.list[0].options.extensionEngine, expected);
  }
});

test('a failure of the catalog is an answer with its own sentence, not a crash', async (t) => {
  const { list } = await start(t, { catalog: recorder({ list: async () => { throw createFailure('The list of extensions could not be read (offline). Check the connection and try again.', 502); } }) });
  const answer = await list({});
  assert.equal(answer.status, 502);
  assert.equal(answer.body.ok, false);
  assert.match(answer.body.error, /could not be read/);
});

test('the list route is rate limited, since the screen asks again every few seconds', async (t) => {
  const { list } = await start(t, { catalog: recorder() });
  const statuses = [];
  for (let i = 0; i < 64; i += 1) statuses.push((await list({})).status);
  assert.ok(statuses.slice(0, 60).every((s) => s === 200));
  assert.ok(statuses.slice(60).every((s) => s === 429), `got ${statuses.slice(58)}`);
});

test('a row of the catalog is written through the link route, with the catalog\'s address and the id it names, never an address of the browser\'s', async (t) => {
  const catalog = recorder();
  const calls = [];
  const { link } = await start(t, { catalog, generate: async (url, options) => { calls.push({ url, ...options }); return { status: 'generated', id: 'alpha', name: 'Alpha', code: 'exports.meta = {};', notes: [] }; } });
  const answer = await link({ catalog: { key: 'eu.kanade.tachiyomi.extension.en.alpha#0' }, url: 'https://evil.example', id: 'chosen-by-browser' });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.ok, true);
  assert.equal(answer.body.status, 'generated');
  assert.deepEqual(catalog.calls.siteOf, ['eu.kanade.tachiyomi.extension.en.alpha#0']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://alpha.example');
  assert.equal(calls[0].id, 'alpha');
});

test('when the generator refuses a row of the catalog (the site did not answer, the template does not fit) the catalog is told, and the answer is still the refusal; a generated source tells it nothing', async (t) => {
  const key = 'eu.kanade.tachiyomi.extension.en.alpha#0';
  const refused = recorder();
  const a = await start(t, { catalog: refused, generate: async () => ({ status: 'refused', stage: 'probe', message: 'unreachable', notes: [] }) });
  const answer = await a.link({ catalog: { key } });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.status, 'refused');
  assert.deepEqual(refused.calls.failed, [[key, 'probe']]);
  const fine = recorder();
  const b = await start(t, { catalog: fine, generate: async () => ({ status: 'generated', id: 'alpha', name: 'Alpha', code: 'exports.meta = {};', notes: [] }) });
  await b.link({ catalog: { key } });
  assert.deepEqual(fine.calls.failed, []);
  const broken = recorder({ markFailed: async () => { throw new Error('disk'); } });
  const c = await start(t, { catalog: broken, generate: async () => ({ status: 'refused', stage: 'fit', message: 'x', notes: [] }) });
  assert.equal((await c.link({ catalog: { key } })).body.status, 'refused', 'a failure of the memory never changes the answer');
});

test('a refusal of the catalog (a site that cannot be written, one that is gone, one this edition does not offer) is an error answer and the generator is never reached', async (t) => {
  for (const [status, message] of [[409, 'by hand'], [404, 'no longer in the catalog'], [403, 'not available in this edition'], [400, 'not an entry']]) {
    let reached = 0;
    const { link } = await start(t, { catalog: recorder({ siteOf: async () => { throw createFailure(message, status); } }), generate: async () => { reached += 1; return { status: 'generated', id: 'x', name: 'X', code: 'x', notes: [] }; } });
    const answer = await link({ catalog: { key: 'eu.kanade.tachiyomi.extension.en.alpha#0' } });
    assert.equal(answer.status, status);
    assert.equal(answer.body.ok, false);
    assert.match(answer.body.error, new RegExp(message));
    assert.equal(reached, 0, message);
  }
});

test('the link route still takes a pasted address, and a catalog entry that is not text is ignored in favour of it', async (t) => {
  const calls = [];
  const { link } = await start(t, { catalog: recorder(), generate: async (url) => { calls.push(url); return { status: 'generated', id: 'x', name: 'X', code: 'x', notes: [] }; } });
  assert.equal((await link({ url: 'mangas.example', catalog: 'nope' })).status, 200);
  assert.equal((await link({ url: 'mangas.example', catalog: { key: 42 } })).status, 200);
  assert.deepEqual(calls, ['mangas.example', 'mangas.example']);
  assert.equal((await link({ catalog: {} })).status, 400, 'with neither an address nor a row there is nothing to write');
});
