'use strict';

// The small parts of the source import tool, each on its own: the id rules, the staging folder, the path scrubbing of
// messages, the shared retry of passing filesystem refusals, two loader details, and the report's cost on odd input.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { suggestId, checkId, chooseId } = require('../../server/modules/source-import/ids');
const { createStaging } = require('../../server/modules/source-import/staging');
const { describeError, diskFailure, MESSAGE_MAX } = require('../../server/modules/source-import/failure');
const { retryTransientFs } = require('../../server/modules/common/fs-retry');
const { analyzeSourceCode } = require('../../server/modules/source-import/static-report');
const { createSourceLoaderCore } = require('../../server/modules/source-loader/core');
const { safeId } = require('../../server/modules/common/identity');
const limits = require('../../server/config/limits');
const { fsError, sourceText } = require('../helpers/source-import-server-rig');

const hash = (n) => String(n).padStart(64, '0');
const tempDir = (t, name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scrollscape-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// ── ids ─────────────────────────────────────────────────────────────────────

test('the id a file names is the one inside its meta, not the first id: in the file', () => {
  assert.equal(suggestId("exports.meta = { id: 'my-site', name: 'X' };"), 'my-site');
  assert.equal(suggestId('module.exports = { meta: { name: "X", id: "mod-style" }, search() {} };'), 'mod-style');
  assert.equal(suggestId("const meta = { id: 'const-meta' };"), 'const-meta');
  const genreTableFirst = "const GENRES = [{ id: 'action', name: 'Action' }];\nexports.meta = { id: 'my-site', name: 'X' };";
  assert.equal(suggestId(genreTableFirst), 'my-site');
  assert.equal(suggestId("const GENRES = [{ id: 'action' }];\nexports.search = async () => ({});"), '', 'no meta id: nothing is guessed');
  assert.equal(suggestId("exports.meta = { name: 'X', nested: { id: 'wrong' } };"), '', 'a brace closes the search for the meta id');
});

test('chooseId prefers the typed id, falls back to the detected one, and explains a refusal', () => {
  const code = "exports.meta = { id: 'inside' };";
  assert.deepEqual(chooseId('typed', code), { id: 'typed', idSource: 'given', detectedId: 'inside', problem: '' });
  assert.deepEqual(chooseId('  ', code), { id: 'inside', idSource: 'detected', detectedId: 'inside', problem: '' });
  assert.equal(chooseId(undefined, 'nothing here').idSource, 'none');
  assert.match(chooseId('../x', code).problem, /letters, digits/);
});

test('ids that are names every object already has are refused with a true reason', () => {
  for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
    assert.throws(() => checkId(bad), /reserved word/, bad);
  }
  for (const fine of ['Constructor', 'constructors', 'proto', 'my-source']) assert.equal(checkId(fine), fine);
});

// ── staging ─────────────────────────────────────────────────────────────────

function ageFile(file, ms) {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
}

test('pruning never deletes a file an install is working on, removes expired leftovers, and ignores every other name', async (t) => {
  const dir = tempDir(t, 'staging');
  const staging = createStaging({ stagingDir: dir, fsImpl: fs.promises, now: Date.now });
  const old = limits.sourceImportStagingTtlMs + 60_000;
  const strangers = [`${hash(7)}.txt`, `${hash(8)}.JS`, `x${hash(9)}.js`, 'notes.txt', `${hash(10)}.js.bak`];
  const names = { inUse: `${hash(1)}.js`, expired: `${hash(2)}.js`, orphanTmp: `${hash(3)}.js.tmp-abc123`, freshTmp: `${hash(4)}.js.tmp-def456` };
  for (const name of [...Object.values(names), ...strangers]) fs.writeFileSync(path.join(dir, name), 'x');
  for (const name of [names.inUse, names.expired, names.orphanTmp, ...strangers]) ageFile(path.join(dir, name), old);

  await staging.whileInUse(hash(1), () => staging.prune());
  const left = fs.readdirSync(dir).sort();
  assert.ok(left.includes(names.inUse), 'in use: kept although expired');
  assert.ok(!left.includes(names.expired), 'expired: gone');
  assert.ok(!left.includes(names.orphanTmp), 'an old half-written leftover: gone');
  assert.ok(left.includes(names.freshTmp), 'a recent one may still be being written: kept');
  for (const stranger of strangers) assert.ok(left.includes(stranger), `${stranger} is not this module's file`);
  await staging.prune();
  assert.ok(!fs.readdirSync(dir).includes(names.inUse), 'once it is no longer in use it is pruned like any other');
});

test('too many waiting files: the oldest go, and writing the same text again replaces it whole', async (t) => {
  const dir = tempDir(t, 'staging-cap');
  const staging = createStaging({ stagingDir: dir, fsImpl: fs.promises, now: Date.now });
  const extra = 5;
  for (let n = 1; n <= limits.sourceImportStagingMaxFiles + extra; n += 1) {
    fs.writeFileSync(path.join(dir, `${hash(n)}.js`), 'x');
    ageFile(path.join(dir, `${hash(n)}.js`), 1000 * (1000 - n));
  }
  await staging.put(hash(99), 'new text');
  const left = fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.js$/.test(name));
  assert.ok(left.length <= limits.sourceImportStagingMaxFiles);
  assert.ok(left.includes(`${hash(99)}.js`));
  assert.ok(!left.includes(`${hash(1)}.js`), 'the oldest went');
  await staging.put(hash(99), 'new text');
  assert.equal(fs.readFileSync(path.join(dir, `${hash(99)}.js`), 'utf8'), 'new text');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), [], 'no temporary name is left');
});

// ── messages carry no local path ────────────────────────────────────────────

test('a message loses drive, UNC and POSIX paths and the staging folder, but keeps URLs and stays one capped line', () => {
  const staging = path.join(os.tmpdir(), 'ss-staging');
  const cases = [
    [`ENOENT: no such file or directory, open 'C:\\Users\\someone\\data\\x.js'`, "ENOENT: no such file or directory, open '<path>'"],
    [`EACCES: permission denied, open '\\\\NAS\\share\\ScrollScape\\data\\store.json'`, "EACCES: permission denied, open '<path>'"],
    ["ENOENT: no such file or directory, open '/home/someone/ScrollScape/data/secrets.txt'", "ENOENT: no such file or directory, open '<path>'"],
    ['fetch failed: https://site.example/api/v1', 'fetch failed: https://site.example/api/v1'],
    ['Z:/mapped/drive/file.js failed', '<path> failed'],
    [`${staging}${path.sep}abc.js:3`, '<staging>' + path.sep + 'abc.js:3'],
    ['Cannot find module \'cheerio-x\'\nRequire stack:\n- C:\\x\\y.js', "Cannot find module 'cheerio-x'"],
  ];
  for (const [input, expected] of cases) {
    const got = describeError(new Error(input), staging);
    assert.equal(got, expected, input);
  }
  assert.ok(describeError(new Error('x'.repeat(5000))).length <= MESSAGE_MAX);
  assert.equal(describeError(undefined), 'Unknown error');
});

test('a disk failure is a logged 500 with a path-free message', () => {
  const err = diskFailure(fsError('EPERM', "EPERM: operation not permitted, rename 'C:\\a\\b.tmp' -> 'C:\\a\\b.js'"));
  assert.equal(err.statusCode, 500);
  assert.equal(err.expected, undefined);
  assert.equal(err.message, "The file could not be saved: EPERM: operation not permitted, rename '<path>' -> '<path>'");
});

// ── the shared retry of passing filesystem refusals ─────────────────────────

test('only EPERM, EBUSY and EACCES are tried again, with the delays given, and the last refusal is thrown as it came', async () => {
  const slept = [];
  const sleepFn = async (ms) => { slept.push(ms); };
  let calls = 0;
  const value = await retryTransientFs(async () => { calls += 1; if (calls < 3) throw fsError('EBUSY'); return 'done'; }, { delays: [5, 10, 20], sleepFn });
  assert.equal(value, 'done');
  assert.deepEqual(slept, [5, 10]);

  slept.length = 0;
  calls = 0;
  const err = await retryTransientFs(async () => { calls += 1; throw fsError('EACCES'); }, { delays: [1, 2], sleepFn }).catch((e) => e);
  assert.equal(err.code, 'EACCES');
  assert.equal(calls, 3);
  assert.deepEqual(slept, [1, 2]);

  for (const code of ['ENOENT', 'ENOSPC', 'EEXIST', undefined]) {
    calls = 0;
    await retryTransientFs(async () => { calls += 1; throw fsError(code); }, { sleepFn }).catch(() => {});
    assert.equal(calls, 1, String(code));
  }
  assert.equal(await retryTransientFs(async (attempt) => attempt, { sleepFn }), 0, 'the task is told which try it is');
});

// ── the loader ──────────────────────────────────────────────────────────────

test('inside the exe a candidate in a folder called like its id is still flat, so its requires resolve at the right depth', (t) => {
  const root = tempDir(t, 'pkg-flat');
  const snap = path.join(root, 'snap', 'data', 'sources');
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, 'helper-at-root.js'), "module.exports = 'root helper';");
  const stagingFolder = path.join(root, 'source-staging');
  fs.mkdirSync(stagingFolder);
  const file = path.join(stagingFolder, `${hash(1)}.js`);
  fs.writeFileSync(file, "exports.helper = require('./helper-at-root');");
  const core = createSourceLoaderCore({ safeId });
  core.configure({ sourcesDir: path.join(root, 'data', 'sources'), snapSourcesDir: snap, isPkg: true });
  assert.equal(core.loadCandidateFromFile(file, 'source-staging').helper, 'root helper');
});

test('a file that disappears between listing the sources folder and reading it does not fail the scan', async (t) => {
  const root = tempDir(t, 'scan-race');
  const sourcesDir = path.join(root, 'sources');
  fs.mkdirSync(sourcesDir);
  fs.writeFileSync(path.join(sourcesDir, 'a.js'), sourceText('a'));
  fs.writeFileSync(path.join(sourcesDir, 'b.js'), sourceText('b'));
  const store = { installedSources: {} };
  const core = createSourceLoaderCore({ safeId, readStore: async () => store, writeStore: async () => {} });
  core.configure({ sourcesDir, snapSourcesDir: path.join(root, 'snap'), isPkg: false });

  const realStat = fs.statSync;
  fs.statSync = (target, ...rest) => {
    if (String(target).endsWith('b.js')) throw fsError('ENOENT');
    return realStat(target, ...rest);
  };
  t.after(() => { fs.statSync = realStat; });
  await core.autoInstallLocalSources();
  assert.deepEqual(Object.keys(store.installedSources), ['a']);

  fs.statSync = (target, ...rest) => {
    if (String(target).endsWith('b.js')) throw fsError('EIO');
    return realStat(target, ...rest);
  };
  await assert.rejects(core.autoInstallLocalSources(), (err) => err.code === 'EIO', 'any other error is still an error');
});

// ── the report on odd input ─────────────────────────────────────────────────

test('require with spaces inside the parentheses is a name, not a computed require', () => {
  const report = analyzeSourceCode("const a = require( 'fs' );\nconst b = require(\n'./x'\n);\nconst c = require( name );\nconst d = require( `./x${y}` );");
  assert.deepEqual(report.requires.map((r) => r.specifier), ['fs', './x']);
  assert.equal(report.dynamicRequires, 2);
});

test('tens of thousands of distinct requires cost little, only fifty are listed, and the computed ones after them still count', () => {
  const names = Array.from({ length: 28000 }, (_, n) => `require('m${n}');`).join('');
  const code = `${names}\nrequire(computed);\nrequire(\`./a\${b}\`);`;
  const started = Date.now();
  const report = analyzeSourceCode(code);
  assert.ok(Date.now() - started < 2000, 'it was seconds before the lookup was limited to the listed names');
  assert.equal(report.requires.length, 50);
  assert.deepEqual(report.requires.slice(0, 2).map((r) => r.specifier), ['m0', 'm1']);
  assert.equal(report.dynamicRequires, 2);
  assert.equal(report.requiresMore, 27950, 'and the report says how many it left out');
});

test('what the report cuts is counted, never silently dropped', () => {
  const names = Array.from({ length: 60 }, (_, n) => `require('m${n}');`).join('');
  const hosts = Array.from({ length: 55 }, (_, n) => `'https://h${n}.example.com/x'`).join(',');
  const cut = analyzeSourceCode(`${names}\nconst u = [${hosts}];`);
  assert.equal(cut.requires.length, 50);
  assert.equal(cut.requiresMore, 10);
  assert.equal(cut.hosts.length, 50);
  assert.equal(cut.hostsMore, 5);
  const small = analyzeSourceCode("require('a'); require('a'); const u = 'https://x.example.com';");
  assert.deepEqual([small.requiresMore, small.hostsMore], [0, 0]);
});

// ── second-review details ───────────────────────────────────────────────────

test('ids the library special-cases are reserved, in any letter case', () => {
  for (const reserved of ['local', 'Local', 'anilist', 'AniList', 'unknown', 'UNKNOWN']) assert.throws(() => checkId(reserved), /reserved/, reserved);
  assert.equal(checkId('anilist2'), 'anilist2');
});

test('a quoted path is scrubbed whole even when it has spaces, which this project\'s own folder does', () => {
  const own = path.join(os.tmpdir(), 'Vault 1.0', 'Projetos', 'ScrollScape', 'data', 'sources', 'x.js');
  const got = describeError(new Error(`ENOENT: no such file or directory, open '${own}'`));
  assert.equal(got, "ENOENT: no such file or directory, open '<path>'");
  assert.equal(describeError(new Error("EACCES: open 'D:\\My Files\\Projects\\x.js' failed")), "EACCES: open '<path>' failed");
  assert.equal(describeError(new Error("open '/home/me/my project/data/x.js' failed")), "open '<path>' failed");
});

test('outside the exe a candidate sees the file name and folder it will be installed under', (t) => {
  const root = tempDir(t, 'candidate-name');
  const sourcesDir = path.join(root, 'data', 'sources');
  fs.mkdirSync(sourcesDir, { recursive: true });
  const staged = path.join(root, 'data', 'source-staging', `${hash(1)}.js`);
  fs.mkdirSync(path.dirname(staged));
  fs.writeFileSync(staged, 'exports.file = __filename; exports.dir = __dirname;');
  const core = createSourceLoaderCore({ safeId });
  core.configure({ sourcesDir, snapSourcesDir: path.join(root, 'snap'), isPkg: false });
  const mod = core.loadCandidateFromFile(staged, 'my-site');
  assert.equal(mod.file, path.join(sourcesDir, 'my-site.js'));
  assert.equal(mod.dir, sourcesDir);
});

test('inside the exe a flat source whose id is the sources folder\'s own name is still flat', (t) => {
  const root = tempDir(t, 'pkg-sources-name');
  const snap = path.join(root, 'snap', 'data', 'sources');
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, 'helper-at-root.js'), "module.exports = 'root helper';");
  const sourcesDir = path.join(root, 'data', 'sources');
  fs.mkdirSync(sourcesDir, { recursive: true });
  const file = path.join(sourcesDir, 'sources.js');
  fs.writeFileSync(file, "exports.helper = require('./helper-at-root');");
  const core = createSourceLoaderCore({ safeId });
  core.configure({ sourcesDir, snapSourcesDir: snap, isPkg: true });
  assert.equal(core.loadCandidateFromFile(file, 'sources').helper, 'root helper');
});
