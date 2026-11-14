'use strict';

// Import of an anime source file (server/modules/anime-sources/import.js, loader.js, routes/anime-source-import.js): Check, Install,
// Uninstall, the load at start, and the routes. The source loader runs real files in a temporary folder; the network is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const sourceLoader = require('../../server/sourceLoader');
const { createAnimeRegistry } = require('../../server/modules/anime-sources/registry');
const { registerBundled } = require('../helpers/fake-bundled');
const { createAnimeImportService, sourcePathIn } = require('../../server/modules/anime-sources/import');
const { loadInstalledAnimeSources } = require('../../server/modules/anime-sources/loader');
const animeImportRoutes = require('../../server/routes/anime-source-import');
const { isPrivilegedRoute } = require('../../server/middleware/local-only');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-anime-import-'));
const sourcesDir = path.join(root, 'data', 'anime-sources');
const stagingDir = path.join(root, 'data', 'anime-source-staging');
const loaderSourcesDir = path.join(root, 'data', 'sources');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
sourceLoader.configure({ sourcesDir: loaderSourcesDir, snapSourcesDir: path.join(root, 'snap'), isPkg: false });
const loadCandidate = sourceLoader.loadCandidateFromFile;

const sourceText = (id = 'demoanime', over = {}) => `// ${over.comment || 'a demo anime source'}
module.exports = {
  meta: { id: '${id}', name: '${over.name || 'Demo Anime'}', keyedBy: 'title', ${over.meta === undefined ? "stream: { hosts: ['cdn.example'] }" : over.meta} },
  getStreamSources: async ({ episode }) => ({ src: 'https://cdn.example/v/' + episode + '/master.m3u8' }),
  ${over.extra || ''}
};
${over.top || ''}
`;

function fresh() {
  fs.rmSync(sourcesDir, { recursive: true, force: true });
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(sourcesDir, { recursive: true });
  const registry = registerBundled(createAnimeRegistry());
  const service = createAnimeImportService({ stagingDir, sourcePath: sourcePathIn(sourcesDir), registry, loadCandidate });
  return { registry, service, files: () => fs.readdirSync(sourcesDir).sort() };
}
const installNew = async (service, text, id) => {
  const checked = await service.preview({ code: text, id });
  return service.install({ sha256: checked.sha256, id: checked.id });
};

// ── Check ─────────────────────────────────────────────────────────────────

test('Check reads the text without running it, stages it under its sha256, and says what it found', async () => {
  const { service } = fresh();
  const ran = [];
  global.__animeImportRan = ran;
  const report = await service.preview({ code: sourceText('demoanime', { top: 'global.__animeImportRan.push("ran");' }), id: 'demoanime' });
  assert.deepEqual(ran, [], 'the file is never run at this step');
  assert.deepEqual([report.ok, report.kind, report.id, report.canInstall, report.replace, report.existing, report.blockers], [true, 'anime', 'demoanime', true, false, null, []]);
  assert.match(report.sha256, /^[0-9a-f]{64}$/);
  assert.ok(report.hosts.includes('cdn.example'));
  assert.ok(fs.existsSync(path.join(stagingDir, `${report.sha256}.js`)), 'staged under its fingerprint');
  assert.deepEqual(fs.readdirSync(sourcesDir), [], 'nothing reaches the anime sources folder');
  delete global.__animeImportRan;
});

test('Check blocks what cannot be installed, and says why, without staging it', async () => {
  const { service } = fresh();
  const blockers = async (code, id) => (await service.preview({ code, id })).blockers.join(' | ');
  assert.match(await blockers('module.exports = {', 'x1'), /does not parse/);
  assert.match(await blockers(sourceText('Upper'), 'Upper'), /lower-case/);
  assert.match(await blockers(sourceText('a'), 'a'), /2 to 40/);
  assert.match(await blockers('module.exports = {};'), /No id found/);
  const bundled = await service.preview({ code: sourceText('shipped-a'), id: 'shipped-a' });
  assert.equal(bundled.canInstall, false);
  assert.match(bundled.blockers.join(' '), /ships with the app/);
  assert.equal(bundled.existing.state, 'blocked');
  assert.ok(!fs.existsSync(stagingDir) || fs.readdirSync(stagingDir).length === 0, 'a file that cannot be installed is not kept');
  await assert.rejects(service.preview({ code: '' }), (e) => e.statusCode === 400);
  await assert.rejects(service.preview({ code: `x\u0000y` }), (e) => e.statusCode === 400);
});

// ── Install and Uninstall ─────────────────────────────────────────────────

test('Install puts the checked file in place and in the registry; its video then comes through the relay of the app', async () => {
  const { service, registry, files } = fresh();
  const done = await installNew(service, sourceText(), 'demoanime');
  assert.deepEqual([done.ok, done.installed, done.replaced, done.stream.hosts], [true, { id: 'demoanime', name: 'Demo Anime' }, false, ['cdn.example']]);
  assert.deepEqual(files(), ['demoanime.js']);
  assert.ok(registry.list().some((s) => s.id === 'demoanime' && s.origin === 'imported'));
  assert.equal(registry.list().at(-1).id, 'demoanime', 'last in the fallback order');
  const stream = await registry.resolveStream('demoanime', { title: 'T', episode: 3 });
  assert.equal(stream.src, `/api/anime/demoanime/hls-proxy?url=${encodeURIComponent('https://cdn.example/v/3/master.m3u8')}`);
  assert.deepEqual(fs.readdirSync(stagingDir), [], 'the staged copy is gone');
});

test('an id already imported is replaced only when confirmed, and the old file is kept as .bak; one that ships is never replaced', async () => {
  const { service, registry, files } = fresh();
  await installNew(service, sourceText('demoanime', { name: 'First' }), 'demoanime');
  const second = await service.preview({ code: sourceText('demoanime', { name: 'Second' }), id: 'demoanime' });
  assert.deepEqual([second.canInstall, second.replace, second.existing.name], [true, true, 'First']);
  await assert.rejects(service.install({ sha256: second.sha256, id: 'demoanime' }), (e) => e.statusCode === 409 && /confirm the replacement/.test(e.message));
  const done = await service.install({ sha256: second.sha256, id: 'demoanime', replace: true });
  assert.equal(done.replaced, true);
  assert.deepEqual(files(), ['demoanime.js', 'demoanime.js.bak']);
  assert.match(fs.readFileSync(path.join(sourcesDir, 'demoanime.js.bak'), 'utf8'), /First/);
  assert.equal(registry.list().find((s) => s.id === 'demoanime').name, 'Second');
  assert.equal(registry.list().filter((s) => s.id === 'demoanime').length, 1);
  const bundled = await service.preview({ code: sourceText('shipped-b'), id: 'shipped-b' });
  await assert.rejects(service.install({ sha256: bundled.sha256 || 'a'.repeat(64), id: 'shipped-b', replace: true }), (e) => [404, 409].includes(e.statusCode));
});

test('an imported source has to declare its hosts and use the relay of the app; nothing is placed when the file is refused', async () => {
  const { service, registry, files } = fresh();
  const refuse = async (text, id, pattern) => {
    const checked = await service.preview({ code: text, id });
    assert.equal(checked.canInstall, true, 'the Check cannot know: it does not run the file');
    await assert.rejects(service.install({ sha256: checked.sha256, id }), (e) => e.statusCode === 400 && pattern.test([e.message, ...((e.details && e.details.errors) || [])].join(' ')), id);
    assert.deepEqual(files(), [], `${id}: nothing placed`);
    assert.ok(!registry.has(id), `${id}: not registered`);
  };
  await refuse(sourceText('nostream', { meta: "features: { dub: false }" }), 'nostream', /either fetchHlsResource\(\) or meta\.stream/);
  await refuse(sourceText('ownrelay', { meta: "features: {}", extra: 'fetchHlsResource: async () => ({ contentType: "video/mp4", body: Buffer.alloc(1) }),' }), 'ownrelay', /meta\.stream/);
  await refuse(sourceText('badhosts', { meta: "stream: { hosts: ['https://cdn.example/x'] }" }), 'badhosts', /meta\.stream\.hosts/);
  await refuse(sourceText('wrongid', { meta: "stream: { hosts: ['cdn.example'] }" }).replace("id: 'wrongid'", "id: 'other'"), 'wrongid', /meta\.id is "other", not "wrongid"/);
  await refuse(sourceText('throws', { top: 'throw new Error("boom at load");' }), 'throws', /could not be loaded: boom at load/);
});

test('Uninstall removes an imported source (file, .bak and registry entry); what ships, what is unknown and a bad id are refused', async () => {
  const { service, registry, files } = fresh();
  await installNew(service, sourceText(), 'demoanime');
  const second = await service.preview({ code: sourceText('demoanime', { name: 'Again' }), id: 'demoanime' });
  await service.install({ sha256: second.sha256, id: 'demoanime', replace: true });
  assert.deepEqual(files(), ['demoanime.js', 'demoanime.js.bak']);
  assert.deepEqual(await service.uninstall({ id: 'demoanime' }), { ok: true, removed: 'demoanime' });
  assert.deepEqual(files(), []);
  assert.ok(!registry.has('demoanime'));
  await assert.rejects(service.uninstall({ id: 'demoanime' }), (e) => e.statusCode === 404);
  await assert.rejects(service.uninstall({ id: 'shipped-a' }), (e) => e.statusCode === 409);
  for (const bad of ['../x', '', 'A', undefined, 'constructor']) await assert.rejects(service.uninstall({ id: bad }), (e) => e.statusCode === 404, String(bad));
  assert.ok(registry.has('shipped-a'));
});

// ── At start ──────────────────────────────────────────────────────────────

test('at start every file that passes the same judgement is loaded, and one that does not is skipped without stopping the others', () => {
  fresh();
  const put = (name, text) => fs.writeFileSync(path.join(sourcesDir, name), text, 'utf8');
  put('goodone.js', sourceText('goodone'));
  put('goodtwo.js', sourceText('goodtwo'));
  put('nostream.js', sourceText('nostream', { meta: 'features: {}' }));
  put('wrongname.js', sourceText('somethingelse'));
  put('broken.js', 'module.exports = {');
  put('throws.js', sourceText('throws', { top: 'throw new Error("boom");' }));
  put('Bad Name.js', sourceText('badname'));
  put('goodone.js.bak', sourceText('goodone'));
  put('goodone.js.tmp-abc123', sourceText('ghost'));
  const registry = registerBundled(createAnimeRegistry());
  const warnings = [];
  const result = loadInstalledAnimeSources({ dir: sourcesDir, registry, loadCandidate, warn: (m) => warnings.push(m) });
  assert.deepEqual(result.loaded, ['goodone', 'goodtwo']);
  assert.deepEqual(result.skipped.map((s) => s.file).sort(), ['Bad Name.js', 'broken.js', 'nostream.js', 'throws.js', 'wrongname.js']);
  assert.equal(warnings.length, 5);
  assert.deepEqual(registry.list().slice(-2).map((s) => [s.id, s.origin]), [['goodone', 'imported'], ['goodtwo', 'imported']]);
  assert.ok(!registry.has('ghost'), 'a temporary or backup file is never read');
  assert.deepEqual(loadInstalledAnimeSources({ dir: path.join(root, 'nowhere'), registry, loadCandidate }), { loaded: [], skipped: [] }, 'no folder yet: nothing imported');
});

// ── The routes ────────────────────────────────────────────────────────────

async function startRoute(t) {
  const { registry } = fresh();
  const result = animeImportRoutes.configure({ stagingDir, sourcesDir, loadCandidate, registry, warn: () => {} });
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  animeImportRoutes.registerAnimeSourceImportRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  const send = (route, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  return { send, registry, result };
}

test('the three routes are on the guard list, stay on this computer, and take a file from Check to Install to Uninstall', async (t) => {
  for (const route of ['/api/anime/sources/import/preview', '/api/anime/sources/import/install', '/api/anime/sources/uninstall']) {
    for (const spelling of [route, route.toUpperCase(), `${route}/`]) assert.equal(isPrivilegedRoute({ method: 'POST', originalUrl: spelling }), true, spelling);
  }
  const { send, registry, result } = await startRoute(t);
  assert.deepEqual(result, { loaded: [], skipped: [] });

  for (const headers of [{ Host: 'localhost.evil.example' }, { 'X-Forwarded-For': '203.0.113.9' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const refused = await send('/api/anime/sources/import/preview', { code: sourceText() }, headers);
    assert.equal(refused.status, 403, JSON.stringify(headers));
    assert.equal(refused.body.code, 'LOCAL_ONLY');
  }
  assert.deepEqual(fs.readdirSync(stagingDir), [], 'a refused request staged nothing');

  const preview = await send('/api/anime/sources/import/preview', { code: sourceText(), id: 'demoanime' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.canInstall, true);
  const install = await send('/api/anime/sources/import/install', { sha256: preview.body.sha256, id: 'demoanime' });
  assert.equal(install.status, 200);
  assert.ok(registry.has('demoanime'));
  assert.equal((await send('/api/anime/sources/import/install', { sha256: 'nothex', id: 'demoanime' })).status, 400);
  assert.equal((await send('/api/anime/sources/uninstall', { id: 'shipped-a' })).status, 409);
  assert.equal((await send('/api/anime/sources/uninstall', { id: 'demoanime' })).status, 200);
  assert.ok(!registry.has('demoanime'));
});

test('a failed request never writes the source text to a log', async (t) => {
  const { send } = await startRoute(t);
  const logged = [];
  for (const level of ['log', 'warn', 'error']) {
    const original = console[level];
    console[level] = (...args) => { logged.push(JSON.stringify(args)); };
    t.after(() => { console[level] = original; });
  }
  const marker = 'SECRET_ANIME_SOURCE_BODY_MARKER_5521';
  const refused = await send('/api/anime/sources/import/preview', { code: `// ${marker}\n${'x'.repeat(600 * 1024)}`, id: 'demoanime' });
  assert.equal(refused.status, 413);
  await send('/api/anime/sources/import/install', { sha256: 'nothex', id: marker, code: marker });
  assert.ok(logged.length > 0, 'the refusals were logged');
  assert.ok(!logged.join('\n').includes('x'.repeat(200)), 'the text of the file is not in the log');
  assert.match(logged.join('\n'), /codeLength/, 'only its length is');
});
