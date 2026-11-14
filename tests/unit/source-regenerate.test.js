'use strict';

// "Regenerate": the origin line a generated source carries (generator/origin.js), which installed sources count as generated, and the
// route that writes one again (POST /api/sources/import/link with { regenerate: id } and POST /api/sources/import/generated). The
// network is replaced by a stub generator; the store and the sources folder are a temporary copy, the real data folder is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { buildSource } = require('../../server/modules/source-import/generator');
const { originLine, readOrigin, sameApartFromOrigin } = require('../../server/modules/source-import/generator/origin');
const { createRegenerate } = require('../../server/modules/source-import/regenerate');
const { sha256Of } = require('../../server/modules/source-import/static-report');
const storeModule = require('../../server/store');
const sourceLoader = require('../../server/sourceLoader');
const importRoutes = require('../../server/routes/source-import');
const { isPrivilegedRoute } = require('../../server/middleware/local-only');

const BASE = 'https://mangas.example';
const GENRES = [{ name: 'Action', slug: 'action' }];
const written = (over = {}) => buildSource({ engine: 'madara', base: BASE, name: 'Mangas Example', genres: GENRES, date: '2026-10-01', ...over });

// ── The origin line ───────────────────────────────────────────────────────

test('a generated file names where it came from, and the line reads back exactly', () => {
  const { code } = written();
  assert.equal(code.split('\n')[1], '// scrollscape-generated engine=madara base=https://mangas.example on=2026-10-01');
  assert.deepEqual(readOrigin(code), { engine: 'madara', base: BASE, on: '2026-10-01' });
  assert.deepEqual(readOrigin(written({ engine: 'mangathemesia' }).code), { engine: 'mangathemesia', base: BASE, on: '2026-10-01' });
  assert.match(written({ date: undefined }).code, /on=\d{4}-\d{2}-\d{2}\n/, 'today when no date is given');
  assert.match(written({ date: 'yesterday' }).code, /on=\d{4}-\d{2}-\d{2}\n/, 'a date that is not a date is not written');
});

test('only the exact line counts: another scheme, a path, a port-less lie, extra words or a line far down are no origin', () => {
  const line = (over) => originLine({ engine: 'madara', base: BASE, on: '2026-10-01', ...over });
  assert.deepEqual(readOrigin(`'use strict';\n${line({})}\n`), { engine: 'madara', base: BASE, on: '2026-10-01' });
  assert.equal(readOrigin(line({ base: 'http://mangas.example' })), null, 'https only');
  assert.equal(readOrigin(line({ base: `${BASE}/path` })), null, 'an origin, not an address with a path');
  assert.equal(readOrigin(line({ base: 'https://user:pw@mangas.example' })), null);
  assert.equal(readOrigin(line({ base: 'https://MANGAS.example' })), null, 'only the lower-case form the generator writes');
  assert.equal(readOrigin(line({ on: '28-10-2026' })), null);
  assert.equal(readOrigin(`${line({})} and more`), null);
  assert.equal(readOrigin(`x // ${line({}).slice(3)}`), null, 'a comment line of its own');
  assert.equal(readOrigin(`${'// filler\n'.repeat(1000)}${line({})}\n`), null, 'near the top only');
  assert.equal(readOrigin(null), null);
});

test('two generations are the same apart from the date they were written, whatever the line endings', () => {
  const a = written({ date: '2026-10-01' }).code;
  assert.equal(sameApartFromOrigin(a, written({ date: '2026-11-15' }).code), true);
  assert.equal(sameApartFromOrigin(a, a.replace(/\n/g, '\r\n')), true);
  assert.equal(sameApartFromOrigin(a, written({ name: 'Another Name' }).code), false);
  assert.equal(sameApartFromOrigin(a, written({ genres: [{ name: 'Drama', slug: 'drama' }] }).code), false);
});

// ── Which installed sources are generated ─────────────────────────────────

function rig(files = {}, entries = {}) {
  const store = { installedSources: {} };
  const texts = {};
  for (const [id, text] of Object.entries(files)) texts[id] = text;
  for (const [id, over] of Object.entries(entries)) {
    store.installedSources[id] = { id, name: id.toUpperCase(), installedVia: 'imported', sha256: sha256Of(texts[id] || ''), ...over };
  }
  const calls = [];
  const generate = async (url, options) => { calls.push({ url, ...options }); return { status: 'generated', id: options.id, name: 'N', engine: 'madara', code: written({ date: '2026-12-24' }).code, notes: ['A note.'], probe: {} }; };
  const regeneration = createRegenerate({ readStore: async () => store, readText: (id) => { if (!(id in texts)) throw new Error('ENOENT'); return texts[id]; }, generate });
  return { store, texts, calls, regeneration };
}

test('only an imported source whose file is still the installed one, and names its origin, is generated', async () => {
  const good = written().code;
  const edited = `${written().code}\n// edited by hand\n`;
  const handWritten = "'use strict';\nmodule.exports = { meta: { id: 'hand' } };\n";
  const { regeneration, store, texts } = rig(
    { good, edited, hand: handWritten, bundled: good, other: written({ engine: 'mangathemesia' }).code, unknown: originLine({ engine: 'nextjs', base: BASE, on: '2026-10-01' }) },
    { good: {}, edited: { sha256: sha256Of(good) }, hand: {}, bundled: { installedVia: 'bundled' }, other: {}, unknown: {}, nofile: {}, nosha: { sha256: '' } },
  );
  texts.nosha = good;
  store.installedSources.nosha.sha256 = '';
  const listed = await regeneration.list();
  assert.deepEqual(listed.map((s) => s.id).sort(), ['good', 'other']);
  assert.deepEqual(listed.find((s) => s.id === 'good'), { id: 'good', name: 'GOOD', engine: 'madara', base: BASE, on: '2026-10-01' });
  assert.equal(listed.find((s) => s.id === 'other').engine, 'mangathemesia');
});

// ── Regenerate ────────────────────────────────────────────────────────────

test('regenerate asks the generator for the address in the installed file, with the installed id, and says whether anything changed', async () => {
  const installed = written({ date: '2026-10-01' }).code;
  const { regeneration, calls } = rig({ mine: installed }, { mine: {} });
  const same = await regeneration.regenerate('mine', { denylist: ['danger.example'] });
  assert.deepEqual(calls[0], { url: BASE, id: 'mine', denylist: ['danger.example'] });
  assert.equal(same.status, 'generated');
  assert.equal(same.regenerated, true);
  assert.equal(same.unchanged, true, 'only the date differs');
  assert.deepEqual(same.notes, ['A note.']);

  const { regeneration: changed } = rig({ mine: written({ name: 'Old Name', date: '2026-10-01' }).code }, { mine: {} });
  assert.equal((await changed.regenerate('mine')).unchanged, false);
});

test('a site that is no longer open, or whose engine changed, is reported, not hidden', async () => {
  const { regeneration, store } = rig({ mine: written().code }, { mine: {} });
  const refusing = createRegenerate({
    readStore: async () => store, readText: () => written().code,
    generate: async () => ({ status: 'refused', stage: 'probe', message: 'Not open.', probe: { verdict: 'needs-solver' } }),
  });
  const refused = await refusing.regenerate('mine');
  assert.deepEqual([refused.status, refused.stage, refused.regenerated], ['refused', 'probe', true]);
  assert.equal(refused.code, undefined, 'nothing to put in the box');
  const moved = createRegenerate({
    readStore: async () => store, readText: () => written().code,
    generate: async () => ({ status: 'generated', engine: 'mangathemesia', code: written({ engine: 'mangathemesia' }).code, notes: ['x'] }),
  });
  assert.match((await moved.regenerate('mine')).notes[0], /looks like a mangathemesia site \(it was written as madara\)/);
  assert.ok(regeneration);
});

test('it refuses what is not installed, not generated, or edited since, and a bad id', async () => {
  const { regeneration } = rig({ hand: "module.exports = {};\n", edited: `${written().code}// x\n` }, { hand: {}, edited: { sha256: sha256Of(written().code) } });
  await assert.rejects(regeneration.regenerate('absent'), (e) => e.statusCode === 404);
  await assert.rejects(regeneration.regenerate('hand'), (e) => e.statusCode === 409 && /nothing to regenerate/.test(e.message));
  await assert.rejects(regeneration.regenerate('edited'), (e) => e.statusCode === 409);
  await assert.rejects(regeneration.regenerate('../etc/passwd'), (e) => e.statusCode === 400);
  await assert.rejects(regeneration.regenerate(''), (e) => e.statusCode === 400);
});

// ── The routes ────────────────────────────────────────────────────────────

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-regen-route-'));
const sourcesDir = path.join(root, 'data', 'sources');
const storePath = path.join(root, 'data', 'store.json');
fs.mkdirSync(sourcesDir, { recursive: true });
test.after(() => { storeModule.flushStoreSync(); fs.rmSync(root, { recursive: true, force: true }); });

async function startRoute(t, generate) {
  const code = written({ date: '2026-10-01' }).code;
  fs.writeFileSync(path.join(sourcesDir, 'mine.js'), code, 'utf8');
  fs.writeFileSync(path.join(sourcesDir, 'plain.js'), "module.exports = {};\n", 'utf8');
  const entry = (id, text) => ({ id, name: id, installedVia: 'imported', sha256: sha256Of(text) });
  fs.writeFileSync(storePath, JSON.stringify({ repos: [], history: [], favorites: [], settings: {}, installedSources: { mine: entry('mine', code), plain: entry('plain', "module.exports = {};\n") } }), 'utf8');
  storeModule.configure(storePath);
  await storeModule.initStore();
  sourceLoader.configure({ sourcesDir, snapSourcesDir: path.join(root, 'snap'), isPkg: false });
  importRoutes.configure({ stagingDir: path.join(root, 'staging'), generate });
  const app = express();
  app.use(express.json());
  importRoutes.registerSourceImportRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  return (route, body, headers = {}) => new Promise((resolve, reject) => {
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

test('the generated list and the regenerate request are on this computer only, and the address comes from the installed file', async (t) => {
  assert.equal(isPrivilegedRoute({ method: 'POST', originalUrl: '/api/sources/import/GENERATED' }), true);
  const asked = [];
  const send = await startRoute(t, async (url, options) => { asked.push({ url, ...options }); return { status: 'generated', id: options.id, name: 'N', engine: 'madara', code: written({ date: '2026-12-24' }).code, notes: [] }; });

  const listed = await send('/api/sources/import/generated', {});
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.sources.map((s) => [s.id, s.base, s.engine]), [['mine', BASE, 'madara']]);

  const answer = await send('/api/sources/import/link', { regenerate: 'mine', url: 'https://evil.example', id: 'other' });
  assert.equal(answer.status, 200);
  assert.deepEqual([answer.body.status, answer.body.regenerated, answer.body.unchanged], ['generated', true, true]);
  assert.deepEqual([asked[0].url, asked[0].id], [BASE, 'mine'], 'the request cannot point the generator anywhere else');

  assert.equal((await send('/api/sources/import/link', { regenerate: 'plain' })).status, 409);
  assert.equal((await send('/api/sources/import/link', { regenerate: 'absent' })).status, 404);

  for (const headers of [{ Host: 'localhost.evil.example' }, { 'X-Forwarded-For': '203.0.113.9' }, { Origin: 'https://evil.example' }]) {
    assert.equal((await send('/api/sources/import/generated', {}, headers)).status, 403, JSON.stringify(headers));
    assert.equal((await send('/api/sources/import/link', { regenerate: 'mine' }, headers)).status, 403, JSON.stringify(headers));
  }
  assert.equal(asked.length, 1, 'a refused request asked no site for anything');
});

test('the file written is LF whatever line endings the template on disk has (a checkout may turn them into CRLF)', () => {
  const real = fs.readFileSync;
  fs.readFileSync = (file, ...rest) => {
    const text = real(file, ...rest);
    return /\.template\.txt$/.test(String(file)) ? String(text).replace(/\r?\n/g, '\r\n') : text;
  };
  try {
    const { code } = written();
    assert.equal(code.includes('\r'), false);
    assert.deepEqual(readOrigin(code), { engine: 'madara', base: BASE, on: '2026-10-01' });
  } finally {
    fs.readFileSync = real;
  }
});
