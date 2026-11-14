'use strict';

// The marker a source imported from the command line leaves next to its file (common/import-marker.js), and what the scan of the
// sources folder does with it (source-loader/local-register.js): a file with a marker that still matches is an IMPORTED source,
// any other file is a plain local one. The store itself is never involved in leaving the marker.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const marker = require('../../server/modules/common/import-marker');
const { registerLocalSources } = require('../../server/modules/source-loader/local-register');

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-marker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = (id) => path.join(dir, `${id}.js`);
  const put = (id, text = `// source ${id}`) => { fs.writeFileSync(file(id), text); return file(id); };
  return { dir, file, put };
}

test('a marker names the sha256 of the file and when it was imported, and is read back only while it matches', (t) => {
  const { put } = folder(t);
  const file = put('demo', 'exports.meta = { id: "demo" };');
  const written = marker.writeImportMarker(file, fs.readFileSync(file, 'utf8'), { now: () => Date.parse('2026-10-28T12:00:00Z') });
  assert.equal(written.sha256, marker.sha256OfText('exports.meta = { id: "demo" };'));
  assert.equal(marker.markerPathFor(file), `${file}.import.json`);
  assert.deepEqual(marker.readValidImportMarker(file), { sha256: written.sha256, importedAt: '2026-10-28T12:00:00.000Z' });
  fs.appendFileSync(file, '\n// edited by hand');
  assert.equal(marker.readValidImportMarker(file), null, 'a file edited since is no longer what was imported');
});

test('a missing, unreadable, malformed or forged marker is "no marker", never an error', (t) => {
  const { put, file } = folder(t);
  put('a');
  assert.equal(marker.readValidImportMarker(file('a')), null, 'no marker file');
  for (const body of ['', 'not json', '[]', 'null', '{"sha256":"abc"}', '{"sha256":5}', JSON.stringify({ sha256: 'z'.repeat(64) })]) {
    fs.writeFileSync(marker.markerPathFor(file('a')), body);
    assert.equal(marker.readValidImportMarker(file('a')), null, body);
  }
  assert.equal(marker.readValidImportMarker(file('nothing-here')), null, 'no file at all');
  fs.writeFileSync(marker.markerPathFor(file('a')), JSON.stringify({ sha256: marker.sha256OfText('// source a'), importedAt: 'yesterday-ish' }));
  assert.equal(marker.readValidImportMarker(file('a')).importedAt, '', 'a date that is not a date is dropped, the marker still counts');
});

test('removing a marker that is not there is not an error', async (t) => {
  const { put } = folder(t);
  const file = put('a');
  await marker.removeImportMarker(file);
  marker.writeImportMarker(file, '// source a');
  await marker.removeImportMarker(file);
  assert.equal(fs.existsSync(marker.markerPathFor(file)), false);
});

function scan(dir, store, load = (id) => ({ meta: { name: `Name ${id}`, version: '2.0.0' } })) {
  const warnings = [];
  return registerLocalSources({
    store, ids: fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => f.slice(0, -3)),
    loadSourceFromFile: load, sourcePath: (id) => path.join(dir, `${id}.js`), warn: (m) => warnings.push(m),
  }).then(() => warnings);
}

test('the scan registers a file with a matching marker as imported (with its sha256 and date), and any other file as bundled', async (t) => {
  const { dir, put } = folder(t);
  const imported = put('imported');
  marker.writeImportMarker(imported, '// source imported', { now: () => Date.parse('2026-10-28T09:00:00Z') });
  put('plain');
  const edited = put('edited');
  marker.writeImportMarker(edited, '// source edited');
  fs.appendFileSync(edited, '\n// changed after the import');
  const store = { installedSources: {} };
  await scan(dir, store);
  assert.equal(store.installedSources.imported.installedVia, 'imported');
  assert.equal(store.installedSources.imported.sha256, marker.sha256OfText('// source imported'));
  assert.equal(store.installedSources.imported.installedAt, '2026-10-28T09:00:00.000Z');
  assert.equal(store.installedSources.imported.name, 'Name imported');
  assert.equal(store.installedSources.plain.installedVia, 'bundled');
  assert.equal(store.installedSources.plain.sha256, undefined);
  assert.equal(store.installedSources.edited.installedVia, 'bundled', 'a marker for text that is no longer in the file does not count');
});

test('a source registered as bundled before it had a marker becomes imported once it has one; imported and repository entries are left alone', async (t) => {
  const { dir, put } = folder(t);
  marker.writeImportMarker(put('early'), '// source early');
  marker.writeImportMarker(put('repo'), '// source repo');
  const store = { installedSources: { early: { id: 'early', installedVia: 'bundled' }, repo: { id: 'repo', installedVia: 'repo' } } };
  await scan(dir, store);
  assert.equal(store.installedSources.early.installedVia, 'imported');
  assert.equal(store.installedSources.early.sha256, marker.sha256OfText('// source early'));
  assert.equal(store.installedSources.repo.installedVia, 'repo', 'a marker never takes over a repository source');
  const before = JSON.stringify(store);
  await scan(dir, store);
  assert.equal(JSON.stringify(store), before, 'a second scan changes nothing');
});

test('a file that cannot be loaded is warned about and left out; a marker that throws on read does not stop the scan', async (t) => {
  const { dir, put } = folder(t);
  put('broken');
  put('fine');
  const store = { installedSources: {} };
  const warnings = await scan(dir, store, (id) => { if (id === 'broken') throw new Error('Cannot find module'); return { meta: {} }; });
  assert.equal(store.installedSources.broken, undefined);
  assert.match(warnings[0], /Auto-install failed for broken: Cannot find module/);
  assert.equal(store.installedSources.fine.name, 'fine', 'a source without a name in meta is listed by its id');
  assert.equal(store.installedSources.fine.version, '1.0.0');
  const throwing = { installedSources: {} };
  await registerLocalSources({ store: throwing, ids: ['fine'], loadSourceFromFile: () => ({ meta: {} }), sourcePath: () => { throw new Error('path escapes'); } });
  assert.equal(throwing.installedSources.fine.installedVia, 'bundled');
});
