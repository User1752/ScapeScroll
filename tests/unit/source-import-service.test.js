'use strict';

// The source import service (server/modules/source-import/service.js) on a real temporary folder, with the real
// loader core: preview reads and stages without running anything, install takes only the fingerprint back, runs the
// staged file once to read its exports, and either ends with the file in place and the store updated or leaves the
// sources folder exactly as it was.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSourceLoaderCore } = require('../../server/modules/source-loader/core');
const { safeId } = require('../../server/modules/common/identity');
const { SOURCE_IMPORT_FAILED } = require('../../server/modules/errors/error-codes');
const { sha256Of } = require('../../server/modules/source-import/static-report');
const limits = require('../../server/config/limits');
const { makeRig, rejection, sourceText, countRun, RUNS } = require('../helpers/source-import-server-rig');

// ── preview ─────────────────────────────────────────────────────────────────

test('preview reads and stages the file under its fingerprint without running it or touching the sources folder', async (t) => {
  const rig = makeRig(t);
  const code = sourceText('demo', { body: countRun });
  const report = await rig.service.preview({ code, id: 'demo' });
  assert.equal(report.ok, true);
  assert.equal(report.id, 'demo');
  assert.equal(report.idSource, 'given');
  assert.equal(report.sha256, sha256Of(code));
  assert.equal(report.canInstall, true);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.replace, false);
  assert.equal(report.existing, null);
  assert.deepEqual(rig.stagedFiles(), [`${report.sha256}.js`]);
  assert.equal(fs.readFileSync(path.join(rig.stagingDir, `${report.sha256}.js`), 'utf8'), code);
  assert.deepEqual(rig.liveFiles(), [], 'nothing reached the sources folder');
  assert.equal(globalThis[RUNS], undefined, 'the file was not run');
  assert.deepEqual(rig.store.installedSources, {});
  assert.equal(rig.writes.length, 0);
});

test('without an id the one inside meta is suggested; with neither there is nothing to stage', async (t) => {
  const rig = makeRig(t);
  const detected = await rig.service.preview({ code: sourceText('found-it') });
  assert.equal(detected.id, 'found-it');
  assert.equal(detected.idSource, 'detected');
  assert.equal(detected.detectedId, 'found-it');
  assert.equal(detected.canInstall, true);

  const none = await rig.service.preview({ code: 'exports.search = async () => ({});' });
  assert.equal(none.canInstall, false);
  assert.equal(none.idSource, 'none');
  assert.match(none.blockers[0], /No id found/);
  assert.equal(rig.stagedFiles().length, 1, 'only the first one was staged');
});

test('a given id wins over the detected one, and the report still tells what was detected', async (t) => {
  const rig = makeRig(t);
  const report = await rig.service.preview({ code: sourceText('inside'), id: 'outside' });
  assert.equal(report.id, 'outside');
  assert.equal(report.detectedId, 'inside');
});

test('a file that does not parse, a bad id or a reserved id is reported as a blocker and not staged', async (t) => {
  const rig = makeRig(t);
  const syntax = await rig.service.preview({ code: 'exports.a = ;\n', id: 'demo' });
  assert.equal(syntax.canInstall, false);
  assert.match(syntax.blockers.join(' '), /does not parse \(line 1\)/);
  const badId = await rig.service.preview({ code: sourceText('x'), id: '../evil' });
  assert.equal(badId.canInstall, false);
  assert.match(badId.blockers.join(' '), /letters, digits/);
  const reserved = await rig.service.preview({ code: sourceText('local'), id: 'Local' });
  assert.equal(reserved.canInstall, false);
  assert.match(reserved.blockers.join(' '), /reserved/);
  for (const device of ['con', 'NUL', 'Aux', 'prn', 'com1', 'LPT9']) {
    const refused = await rig.service.preview({ code: sourceText(device), id: device });
    assert.equal(refused.canInstall, false, device);
    assert.match(refused.blockers.join(' '), /device name on Windows/, device);
  }
  for (const fine of ['console', 'com10', 'nullable', 'lpt0']) {
    assert.equal((await rig.service.preview({ code: sourceText(fine), id: fine })).canInstall, true, fine);
  }
  assert.equal(rig.stagedFiles().length, 4, 'only the four fine ones were staged');
});

test('input that is not a source file is refused outright', async (t) => {
  const rig = makeRig(t);
  for (const bad of [undefined, null, 5, {}, '', '   \n']) {
    const err = await rejection(rig.service.preview({ code: bad, id: 'demo' }));
    assert.equal(err.statusCode, 400, String(bad));
    assert.equal(err.code, SOURCE_IMPORT_FAILED);
  }
  const nul = await rejection(rig.service.preview({ code: 'a\u0000b', id: 'demo' }));
  assert.match(nul.message, /NUL/);
  const big = await rejection(rig.service.preview({ code: 'x'.repeat(limits.sourceImportMaxBytes + 1), id: 'demo' }));
  assert.equal(big.statusCode, 413);
  const multibyte = await rejection(rig.service.preview({ code: 'é'.repeat(limits.sourceImportMaxBytes / 2 + 1), id: 'demo' }));
  assert.equal(multibyte.statusCode, 413, 'the limit is in bytes, not characters');
});

test('an id that is installed, on disk, or differs only in letter case is blocked; an earlier import can be replaced', async (t) => {
  const rig = makeRig(t);
  rig.store.installedSources.Bundled = { id: 'Bundled', installedVia: 'bundled', name: 'Bundled' };
  rig.store.installedSources.repo1 = { id: 'repo1', installedVia: 'repo', name: 'From a repo', version: '2' };
  rig.store.installedSources.mine = { id: 'mine', installedVia: 'imported', name: 'Mine', version: '1.0.0' };
  fs.writeFileSync(rig.live('stray'), sourceText('stray'));

  const caseClash = await rig.service.preview({ code: sourceText('bundled'), id: 'bundled' });
  assert.equal(caseClash.canInstall, false);
  assert.match(caseClash.blockers.join(' '), /letter case/);
  const viaRepo = await rig.service.preview({ code: sourceText('repo1'), id: 'repo1' });
  assert.equal(viaRepo.canInstall, false);
  assert.equal(viaRepo.existing.installedVia, 'repo');
  assert.match(viaRepo.blockers.join(' '), /not imported with this tool/);
  const onDisk = await rig.service.preview({ code: sourceText('stray'), id: 'stray' });
  assert.equal(onDisk.canInstall, false);
  assert.match(onDisk.blockers.join(' '), /already exists in the sources folder/);

  const again = await rig.service.preview({ code: sourceText('mine'), id: 'mine' });
  assert.equal(again.canInstall, true);
  assert.equal(again.replace, true);
  assert.equal(again.existing.installedVia, 'imported');
  assert.equal(again.existing.version, '1.0.0');
});

test('staged files expire after an hour and the oldest go when too many wait; other files are never touched', async (t) => {
  const rig = makeRig(t);
  fs.mkdirSync(rig.stagingDir, { recursive: true });
  const hash = (n) => String(n).padStart(64, '0');
  const age = (name, ms) => {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(path.join(rig.stagingDir, name), when, when);
  };
  fs.writeFileSync(path.join(rig.stagingDir, `${hash(1)}.js`), 'old');
  age(`${hash(1)}.js`, limits.sourceImportStagingTtlMs + 60_000);
  fs.writeFileSync(path.join(rig.stagingDir, 'notes.txt'), 'mine');
  fs.writeFileSync(path.join(rig.stagingDir, 'UPPER.js'), 'mine');
  for (let n = 2; n < 2 + limits.sourceImportStagingMaxFiles + 4; n += 1) {
    fs.writeFileSync(path.join(rig.stagingDir, `${hash(n)}.js`), 'fresh');
    age(`${hash(n)}.js`, 1000 * (1000 - n)); // a larger n is newer
  }
  const report = await rig.service.preview({ code: sourceText('demo'), id: 'demo' });
  const staged = rig.stagedFiles().filter((name) => /^[a-f0-9]{64}\.js$/.test(name));
  assert.ok(!staged.includes(`${hash(1)}.js`), 'the expired one went');
  assert.ok(!staged.includes(`${hash(2)}.js`), 'the oldest went to make room');
  assert.ok(staged.includes(`${report.sha256}.js`), 'the new one is kept');
  assert.ok(staged.length <= limits.sourceImportStagingMaxFiles);
  assert.deepEqual(rig.stagedFiles().filter((name) => !/^[a-f0-9]{64}\.js$/.test(name)).sort(), ['UPPER.js', 'notes.txt']);
});

// ── install ─────────────────────────────────────────────────────────────────

test('install puts exactly the checked file in place, registers it as imported and runs it only now', async (t) => {
  const rig = makeRig(t);
  const code = sourceText('demo', { body: countRun });
  const { sha256 } = await rig.service.preview({ code, id: 'demo' });
  assert.equal(globalThis[RUNS], undefined);

  const result = await rig.service.install({ sha256, id: 'demo' });
  assert.equal(result.ok, true);
  assert.equal(result.replaced, false);
  assert.deepEqual(result.methods, ['search', 'mangaDetails', 'chapters', 'pages']);
  assert.ok(globalThis[RUNS] >= 1, 'the file ran when it was installed');
  assert.equal(fs.readFileSync(rig.live('demo'), 'utf8'), code);
  assert.deepEqual(rig.liveFiles(), ['demo.js'], 'no temporary or backup file is left');
  assert.deepEqual(rig.stagedFiles(), [], 'the staged copy is gone');

  const entry = rig.store.installedSources.demo;
  assert.equal(entry.installedVia, 'imported');
  assert.equal(entry.sha256, sha256);
  assert.equal(entry.name, 'Demo demo');
  assert.equal(entry.version, '1.0.0');
  assert.equal(entry.author, 'Me');
  assert.match(entry.installedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(rig.writes.length, 1);
  assert.deepEqual(rig.counters, { flushed: 1, invalidated: 1 });
  assert.equal(typeof rig.core.loadSourceFromFile('demo').search, 'function', 'the loader serves it');
});

test('a file that does not meet the contract is refused before it reaches the sources folder, with every reason', async (t) => {
  const rig = makeRig(t);
  const { sha256 } = await rig.service.preview({ code: sourceText('demo', { omit: 'pages' }), id: 'demo' });
  const err = await rejection(rig.service.install({ sha256, id: 'demo' }));
  assert.equal(err.code, SOURCE_IMPORT_FAILED);
  assert.equal(err.statusCode, 400);
  assert.match(err.details.errors.join(' '), /pages\(\) is missing/);
  assert.deepEqual(rig.liveFiles(), []);
  assert.deepEqual(rig.store.installedSources, {});
  assert.equal(rig.writes.length, 0);
  assert.equal(rig.stagedFiles().length, 1, 'still staged: the person can fix the id and try again');
});

test('a meta.id that is not the id it is installed as is refused', async (t) => {
  const rig = makeRig(t);
  const { sha256 } = await rig.service.preview({ code: sourceText('inside'), id: 'outside' });
  const err = await rejection(rig.service.install({ sha256, id: 'outside' }));
  assert.match(err.details.errors.join(' '), /"inside" but the source would be installed as "outside"/);
  assert.deepEqual(rig.liveFiles(), []);
});

test('a file whose own code throws when it loads is refused, and the message holds no local path', async (t) => {
  const rig = makeRig(t);
  const code = "require('./no-such-helper-" + 'x'.repeat(10) + "');\n" + sourceText('demo');
  const { sha256 } = await rig.service.preview({ code, id: 'demo' });
  const err = await rejection(rig.service.install({ sha256, id: 'demo' }));
  assert.match(err.message, /could not be loaded: Cannot find module/);
  assert.doesNotMatch(err.message, /Require stack/);
  assert.doesNotMatch(err.message, new RegExp(rig.root.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
  assert.doesNotMatch(err.message, /[A-Za-z]:[\\/]/);
  assert.deepEqual(rig.liveFiles(), []);
});

test('install refuses what preview refused, even when the store changed in between', async (t) => {
  const rig = makeRig(t);
  const { sha256 } = await rig.service.preview({ code: sourceText('demo'), id: 'demo' });
  rig.store.installedSources.demo = { id: 'demo', installedVia: 'repo' };
  const err = await rejection(rig.service.install({ sha256, id: 'demo' }));
  assert.equal(err.statusCode, 409);
  assert.deepEqual(rig.liveFiles(), []);
});

test('the fingerprint and the id are validated; a name that is not a fingerprint never reaches the disk', async (t) => {
  const rig = makeRig(t);
  const { sha256 } = await rig.service.preview({ code: sourceText('demo'), id: 'demo' });
  for (const bad of [undefined, null, 5, '', 'abc', '../../etc/passwd', `${sha256}.js`, `..${path.sep}${sha256}`, sha256.toUpperCase(), `${sha256}\n`]) {
    const err = await rejection(rig.service.install({ sha256: bad, id: 'demo' }));
    assert.equal(err.statusCode, 400, String(bad));
  }
  for (const bad of [undefined, '', '../x', 'a/b', 'a b', 'local', 'LOCAL']) {
    const err = await rejection(rig.service.install({ sha256, id: bad }));
    assert.equal(err.statusCode, 400, String(bad));
  }
  const unknown = await rejection(rig.service.install({ sha256: 'f'.repeat(64), id: 'demo' }));
  assert.equal(unknown.statusCode, 404);
  assert.match(unknown.message, /choose it again/);
  assert.deepEqual(rig.liveFiles(), []);
});

test('a staged file that changed on disk is discarded, not installed', async (t) => {
  const rig = makeRig(t);
  const { sha256 } = await rig.service.preview({ code: sourceText('demo'), id: 'demo' });
  fs.appendFileSync(path.join(rig.stagingDir, `${sha256}.js`), '\n// changed after the check\n');
  const err = await rejection(rig.service.install({ sha256, id: 'demo' }));
  assert.equal(err.statusCode, 409);
  assert.deepEqual(rig.liveFiles(), []);
  assert.deepEqual(rig.stagedFiles(), []);
});

test('importing the same id again needs an explicit replace, keeps the previous file as .bak, and leaves one source', async (t) => {
  const rig = makeRig(t);
  const first = sourceText('demo', { meta: ", version2: 'first'" });
  const one = await rig.service.preview({ code: first, id: 'demo' });
  await rig.service.install({ sha256: one.sha256, id: 'demo' });

  const second = sourceText('demo', { body: '// version two' });
  const two = await rig.service.preview({ code: second, id: 'demo' });
  assert.equal(two.replace, true);
  const refused = await rejection(rig.service.install({ sha256: two.sha256, id: 'demo' }));
  assert.equal(refused.statusCode, 409);
  assert.match(refused.message, /confirm the replacement/);
  assert.equal(fs.readFileSync(rig.live('demo'), 'utf8'), first, 'the first one is still in place');

  const result = await rig.service.install({ sha256: two.sha256, id: 'demo', replace: true });
  assert.equal(result.replaced, true);
  assert.equal(fs.readFileSync(rig.live('demo'), 'utf8'), second);
  assert.equal(fs.readFileSync(`${rig.live('demo')}.bak`, 'utf8'), first);
  assert.deepEqual(rig.liveFiles(), ['demo.js', 'demo.js.bak'], 'no temporary file; the backup is not a source (the scan only reads .js)');
  assert.equal(rig.store.installedSources.demo.sha256, two.sha256);
  for (const notTrue of ['true', 1, 'yes', {}]) {
    const again = await rig.service.preview({ code: sourceText('demo', { body: `// ${String(notTrue)}` }), id: 'demo' });
    const err = await rejection(rig.service.install({ sha256: again.sha256, id: 'demo', replace: notTrue }));
    assert.equal(err.statusCode, 409, `replace: ${JSON.stringify(notTrue)} is not a confirmation`);
  }
});

test('a load that fails in the final place is rolled back: a new source leaves no file, a replacement gets the old file back', async (t) => {
  let failNext = false;
  const rig = makeRig(t, {
    loadSource: (core, id, opts) => {
      if (failNext) { failNext = false; throw new Error('final load failed'); }
      return core.loadSourceFromFile(id, opts);
    },
  });
  const fresh = await rig.service.preview({ code: sourceText('demo'), id: 'demo' });
  failNext = true;
  const err = await rejection(rig.service.install({ sha256: fresh.sha256, id: 'demo' }));
  assert.equal(err.statusCode, 500);
  assert.match(err.message, /rolled back: final load failed/);
  assert.deepEqual(rig.liveFiles(), []);
  assert.deepEqual(rig.store.installedSources, {});
  assert.equal(rig.writes.length, 0);

  const original = sourceText('demo', { body: '// original' });
  const first = await rig.service.preview({ code: original, id: 'demo' });
  await rig.service.install({ sha256: first.sha256, id: 'demo' });
  const next = await rig.service.preview({ code: sourceText('demo', { body: '// broken update' }), id: 'demo' });
  failNext = true;
  const failed = await rejection(rig.service.install({ sha256: next.sha256, id: 'demo', replace: true }));
  assert.equal(failed.statusCode, 500);
  assert.equal(fs.readFileSync(rig.live('demo'), 'utf8'), original, 'the previous source is back');
  assert.equal(rig.store.installedSources.demo.sha256, first.sha256, 'and the store still describes it');
});

test('two installs at the same moment run one after the other: one wins, the other is refused, one file results', async (t) => {
  const rig = makeRig(t);
  const { sha256 } = await rig.service.preview({ code: sourceText('demo'), id: 'demo' });
  const results = await Promise.allSettled([
    rig.service.install({ sha256, id: 'demo' }),
    rig.service.install({ sha256, id: 'demo' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, SOURCE_IMPORT_FAILED);
  assert.deepEqual(rig.liveFiles(), ['demo.js']);
});

test('the loader keeps no trace of a candidate: it is not cached and not found by id', async (t) => {
  const rig = makeRig(t);
  const staged = path.join(rig.stagingDir, 'candidate.js');
  fs.mkdirSync(rig.stagingDir, { recursive: true });
  fs.writeFileSync(staged, sourceText('ghost', { body: countRun }));
  const mod = rig.core.loadCandidateFromFile(staged, 'ghost');
  assert.equal(mod.meta.id, 'ghost');
  assert.ok(!Object.keys(require.cache).includes(path.resolve(staged)), 'not left in require.cache');
  assert.throws(() => rig.core.loadSourceFromFile('ghost'), /Source not found/);
});

test('inside a packaged exe the candidate resolves its requires from the bundled snapshot, not from where it sits', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-import-pkg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const snap = path.join(root, 'snap', 'data', 'sources');
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, 'helper-from-snapshot.js'), "module.exports = 'snapshot helper';");
  const staging = path.join(root, 'staging');
  fs.mkdirSync(staging);
  const file = path.join(staging, 'x.js');
  fs.writeFileSync(file, "exports.helper = require('./helper-from-snapshot');");
  const core = createSourceLoaderCore({ safeId });
  core.configure({ sourcesDir: path.join(root, 'data', 'sources'), snapSourcesDir: snap, isPkg: true });
  assert.equal(core.loadCandidateFromFile(file, 'x').helper, 'snapshot helper');
});
