'use strict';

// POST /api/sources/import/preview and /install on a real Express server on loopback, with the real store singleton
// and loader pointed at a temporary folder (the data folder is never touched). What matters here is what the service
// tests cannot show: the routes stay on this computer whatever the headers say, the source text never reaches a log,
// and the guard list names both routes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const storeModule = require('../../server/store');
const sourceLoader = require('../../server/sourceLoader');
const importRoutes = require('../../server/routes/source-import');
const { PRIVILEGED_ROUTES, isPrivilegedRoute } = require('../../server/middleware/local-only');
const { SOURCE_IMPORT_FAILED } = require('../../server/modules/errors/error-codes');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-import-route-'));
const sourcesDir = path.join(root, 'data', 'sources');
const stagingDir = path.join(root, 'data', 'source-staging');
const storePath = path.join(root, 'data', 'store.json');
fs.mkdirSync(sourcesDir, { recursive: true });

const MARKER = 'SECRET_SOURCE_BODY_MARKER_7731';
const sourceText = (id = 'demo', extra = '') => `${extra}
exports.meta = { id: '${id}', name: 'Demo', version: '1.0.0' };
exports.search = async () => ({});
exports.mangaDetails = async () => ({});
exports.chapters = async () => ({});
exports.pages = async () => ({});
`;

test.after(() => {
  storeModule.flushStoreSync();
  fs.rmSync(root, { recursive: true, force: true });
});

async function startRoute(t) {
  fs.writeFileSync(storePath, JSON.stringify({ repos: [], installedSources: {}, history: [], favorites: [], settings: {} }), 'utf8');
  storeModule.configure(storePath);
  await storeModule.initStore();
  sourceLoader.configure({ sourcesDir, snapSourcesDir: path.join(root, 'snap'), isPkg: false });
  for (const name of fs.readdirSync(sourcesDir)) fs.rmSync(path.join(sourcesDir, name), { force: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });
  importRoutes.configure({ stagingDir });

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  importRoutes.registerSourceImportRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  const send = (route, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: route, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  return { send, preview: (body, headers) => send('/api/sources/import/preview', body, headers), install: (body, headers) => send('/api/sources/import/install', body, headers) };
}

const installed = async () => (await storeModule.readStore()).installedSources;

test('the three routes are in the guard list under their lower-case paths, whatever the spelling of the request', () => {
  for (const route of ['/api/sources/import/preview', '/api/sources/import/install', '/api/sources/import/test']) {
    assert.ok(PRIVILEGED_ROUTES.some((r) => r.method === 'POST' && r.path === route), route);
    for (const spelling of [route, route.toUpperCase(), `${route}/`, `${route}?x=1`]) {
      assert.equal(isPrivilegedRoute({ method: 'POST', originalUrl: spelling }), true, spelling);
    }
  }
});

test('preview then install through HTTP puts the source in place and in the store', async (t) => {
  const api = await startRoute(t);
  const preview = await api.preview({ code: sourceText('demo'), id: 'demo' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.canInstall, true);
  const result = await api.install({ sha256: preview.body.sha256, id: 'demo' });
  assert.equal(result.status, 200);
  assert.equal(result.body.installed.installedVia, 'imported');
  assert.ok(fs.existsSync(path.join(sourcesDir, 'demo.js')));
  assert.equal((await installed()).demo.installedVia, 'imported');
});

test('a request that is not from this computer is refused on both routes, with nothing staged or installed', async (t) => {
  const api = await startRoute(t);
  const refusals = [
    { Host: 'evil.example' },
    { Host: 'localhost.evil.example' },
    { 'X-Forwarded-For': '203.0.113.9' },
    { Forwarded: 'for=203.0.113.9' },
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' },
    { Origin: 'https://evil.example' },
    { Origin: 'null' },
  ];
  for (const headers of refusals) {
    const preview = await api.preview({ code: sourceText('demo'), id: 'demo' }, headers);
    assert.equal(preview.status, 403, JSON.stringify(headers));
    assert.equal(preview.body.code, 'LOCAL_ONLY');
    // A password alone does not open these routes (it needs the opt-in switch too), so the refusal does not offer "set a password" as the remedy; it names the switch.
    assert.doesNotMatch(preview.body.error, /set an Access Password/);
    assert.match(preview.body.error, /Allow installing sources from other devices/);
    assert.match(preview.body.error, /SCROLLSCAPE_ALLOW_REMOTE_IMPORT=1/);
    const install = await api.install({ sha256: 'a'.repeat(64), id: 'demo' }, headers);
    assert.equal(install.status, 403, JSON.stringify(headers));
    const tested = await api.send('/api/sources/import/test', { id: 'demo' }, headers);
    assert.equal(tested.status, 403, JSON.stringify(headers));
  }
  assert.ok(!fs.existsSync(stagingDir) || fs.readdirSync(stagingDir).length === 0);
  assert.deepEqual(fs.readdirSync(sourcesDir), []);
  assert.deepEqual(await installed(), {});
});

test('a refused or failed request never writes the source text to a log', async (t) => {
  const api = await startRoute(t);
  const logged = [];
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level];
    console[level] = (...args) => { logged.push(JSON.stringify(args)); };
    t.after(() => { console[level] = original; });
  }
  const big = `// ${MARKER}\n${'x'.repeat(600 * 1024)}`;
  const tooBig = await api.preview({ code: big, id: 'demo' });
  assert.equal(tooBig.status, 413);
  const badId = await api.preview({ code: sourceText('demo', `// ${MARKER}`), id: '../bad' });
  assert.equal(badId.status, 200, 'a bad id is a blocker in the report, not an error');
  const broken = await api.preview({ code: sourceText('demo', `// ${MARKER}\n`).replace('exports.pages', 'exports.nothing'), id: 'demo' });
  const failed = await api.install({ sha256: broken.body.sha256, id: 'demo' });
  assert.equal(failed.status, 400);
  assert.equal(failed.body.code, SOURCE_IMPORT_FAILED);
  assert.ok(failed.body.details === undefined && Array.isArray(failed.body.errors), 'the reasons come back with the error');
  assert.ok(logged.length > 0, 'the failures were logged');
  assert.ok(!logged.join('\n').includes(MARKER), 'but not with the file in them');
});

test('the response of a failed request has the usual shape and names every reason', async (t) => {
  const api = await startRoute(t);
  const code = sourceText('demo').replace('exports.pages', 'exports.nothing');
  const preview = await api.preview({ code, id: 'demo' });
  const failed = await api.install({ sha256: preview.body.sha256, id: 'demo' });
  assert.equal(failed.status, 400);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.code, SOURCE_IMPORT_FAILED);
  assert.match(failed.body.errors.join(' '), /pages\(\) is missing/);
});

test('a body that is not what the route expects is a 400, not a crash', async (t) => {
  const api = await startRoute(t);
  for (const body of [{}, { code: 5 }, { code: ['a'] }, { code: null, id: {} }, { __proto__: { code: 'x' } }]) {
    const res = await api.preview(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  for (const body of [{}, { sha256: 5 }, { sha256: 'a'.repeat(64) }, { sha256: 'a'.repeat(64), id: 'demo' }]) {
    const res = await api.install(body);
    assert.ok([400, 404].includes(res.status), JSON.stringify(body));
  }
});

test('replacing over HTTP needs the explicit confirmation, forwards it, and the store file is written at once', async (t) => {
  const api = await startRoute(t);
  const first = await api.preview({ code: sourceText('demo'), id: 'demo' });
  await api.install({ sha256: first.body.sha256, id: 'demo' });
  const onDisk = () => JSON.parse(fs.readFileSync(storePath, 'utf8')).installedSources;
  assert.equal(onDisk().demo.installedVia, 'imported', 'flushed by the route, not left to the delayed write');

  const second = await api.preview({ code: sourceText('demo', '// second version'), id: 'demo' });
  assert.equal(second.body.replace, true);
  const refused = await api.install({ sha256: second.body.sha256, id: 'demo' });
  assert.equal(refused.status, 409);
  const replaced = await api.install({ sha256: second.body.sha256, id: 'demo', replace: true });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.replaced, true);
  assert.match(fs.readFileSync(path.join(sourcesDir, 'demo.js'), 'utf8'), /second version/);
  assert.match(fs.readFileSync(path.join(sourcesDir, 'demo.js.bak'), 'utf8'), /exports\.meta/);
  assert.equal(onDisk().demo.sha256, second.body.sha256);
});

test('the routes are rate limited: the 31st request in a minute is refused', async (t) => {
  const api = await startRoute(t);
  const statuses = [];
  for (let n = 0; n < 31; n += 1) statuses.push((await api.preview({ code: '', id: 'demo' })).status);
  assert.deepEqual(statuses.slice(0, 30), new Array(30).fill(400), 'the first thirty reach the service (and are refused there)');
  assert.equal(statuses[30], 429);
});

// ── The live test route ────────────────────────────────────────────────────

// A source with no pages, so the test never reaches the network (the image check is skipped).
const testableSource = () => `
exports.meta = { id: 'demo', name: 'Demo', version: '1.0.0' };
exports.search = async (q, page) => (page > 1 ? { results: [], hasNextPage: false } : { results: [{ id: 't1', title: 'Test Title', cover: '/c.png', genres: [] }], hasNextPage: false });
exports.mangaDetails = async () => ({ title: 'Test Title', status: 'ongoing', genres: [], description: 'd' });
exports.chapters = async () => ({ chapters: [{ id: 'c1', name: 'Chapter 1', chapter: '1', publishAt: null }] });
exports.pages = async () => ({ pages: [] });
`;

test('testing a source over HTTP runs the checklist, answers every check, and remembers the outcome', async (t) => {
  const api = await startRoute(t);
  const preview = await api.preview({ code: testableSource(), id: 'demo' });
  await api.install({ sha256: preview.body.sha256, id: 'demo' });
  const res = await api.send('/api/sources/import/test', { id: 'demo', depth: 'basic' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.verified, false, 'a source with no pages is not verified');
  assert.equal(res.body.checks.find((c) => c.id === 'browse').status, 'pass');
  assert.equal(res.body.checks.find((c) => c.id === 'pages').status, 'fail');
  assert.equal(res.body.checks.find((c) => c.id === 'images').status, 'skip');
  assert.ok(res.body.calls > 0 && res.body.durationMs >= 0);
  assert.equal((await installed()).demo.liveTest.verified, false);
});

test('testing refuses what is not installed, an id that is not an id, and a body that is not a body', async (t) => {
  const api = await startRoute(t);
  const missing = await api.send('/api/sources/import/test', { id: 'nothing' });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, SOURCE_IMPORT_FAILED);
  for (const body of [{}, { id: '../x' }, { id: 5 }, { id: 'local' }, { id: { a: 1 } }]) {
    const res = await api.send('/api/sources/import/test', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test('the test route has its own, tighter limit: the 7th request in a minute is refused', async (t) => {
  const api = await startRoute(t);
  const statuses = [];
  for (let n = 0; n < 7; n += 1) statuses.push((await api.send('/api/sources/import/test', {})).status);
  assert.deepEqual(statuses.slice(0, 6), new Array(6).fill(400), 'the first six reach the service (and are refused there)');
  assert.equal(statuses[6], 429);
});
