'use strict';

// The source import service when the disk, the store or the loader misbehave: a refusal the system lifts after a
// moment is tried again, a failure never leaves a half-installed source or a temporary file, the message never carries
// a local path, "rolled back" is only said when it is true, and what runs is the text whose hash was verified.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SOURCE_IMPORT_FAILED } = require('../../server/modules/errors/error-codes');
const { makeRig, rejection, fsError, sourceText } = require('../helpers/source-import-server-rig');

const toTarget = (to) => String(to).endsWith('demo.js');
const noLocalPath = (text) => assert.doesNotMatch(text, new RegExp(os.tmpdir().replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));

async function staged(rig, code = sourceText('demo'), id = 'demo') {
  const report = await rig.service.preview({ code, id });
  assert.equal(report.canInstall, true);
  return report.sha256;
}

// ── a refusal that lifts ────────────────────────────────────────────────────

test('a rename the system refuses once is tried again and the install goes through', async (t) => {
  let refused = 0;
  const rig = makeRig(t, {
    fsOverrides: {
      rename: async (from, to) => {
        if (toTarget(to) && refused < 1) { refused += 1; throw fsError('EPERM'); }
        return fs.promises.rename(from, to);
      },
    },
  });
  const sha256 = await staged(rig);
  const result = await rig.service.install({ sha256, id: 'demo' });
  assert.equal(result.ok, true);
  assert.equal(refused, 1);
  assert.deepEqual(rig.liveFiles(), ['demo.js']);
});

test('a rename refused every time fails after the tries, as a logged 500 without a path, leaving nothing behind', async (t) => {
  let tries = 0;
  const rig = makeRig(t, {
    fsOverrides: { rename: async (from, to) => { if (toTarget(to)) { tries += 1; throw fsError('EBUSY'); } return fs.promises.rename(from, to); } },
  });
  const sha256 = await staged(rig);
  const err = await rejection(rig.service.install({ sha256, id: 'demo' }));
  assert.equal(tries, 4, 'the first try and the three delays of the rig');
  assert.equal(err.statusCode, 500);
  assert.equal(err.code, SOURCE_IMPORT_FAILED);
  assert.equal(err.expected, undefined, 'a disk fault is logged, unlike a refusal');
  assert.match(err.message, /^The file could not be saved: EBUSY/);
  noLocalPath(err.message);
  assert.deepEqual(rig.liveFiles(), [], 'no temporary file is left in the sources folder');
  assert.deepEqual(rig.store.installedSources, {});
  assert.equal(rig.stagedFiles().length, 1, 'the checked file stays, so another click can try again');
});

test('an error that is not a passing refusal is not tried again', async (t) => {
  let tries = 0;
  const rig = makeRig(t, {
    fsOverrides: { rename: async (from, to) => { if (toTarget(to)) { tries += 1; throw fsError('ENOSPC'); } return fs.promises.rename(from, to); } },
  });
  const sha256 = await staged(rig);
  await rejection(rig.service.install({ sha256, id: 'demo' }));
  assert.equal(tries, 1);
});

test('a write that dies half way leaves no temporary file', async (t) => {
  const rig = makeRig(t, {
    fsOverrides: {
      writeFile: async (file, text, options) => {
        if (String(file).includes('demo.js.tmp-')) {
          await fs.promises.writeFile(file, String(text).slice(0, 10), options);
          throw fsError('ENOSPC');
        }
        return fs.promises.writeFile(file, text, options);
      },
    },
  });
  const sha256 = await staged(rig);
  const err = await rejection(rig.service.install({ sha256, id: 'demo' }));
  assert.match(err.message, /could not be saved: ENOSPC/);
  assert.deepEqual(rig.liveFiles(), []);
});

test('a staging folder that cannot be written makes Check fail as a 500 without a path', async (t) => {
  const rig = makeRig(t, { fsOverrides: { mkdir: async () => { throw fsError('EACCES'); } } });
  const err = await rejection(rig.service.preview({ code: sourceText('demo'), id: 'demo' }));
  assert.equal(err.statusCode, 500);
  assert.match(err.message, /^The file could not be saved: EACCES/);
  noLocalPath(err.message);
});

// ── rolling back honestly ───────────────────────────────────────────────────

test('when the final load fails and the undo is refused, the person is told to delete the file by hand', async (t) => {
  let failLoad = false;
  const rig = makeRig(t, {
    loadSource: (core, id, opts) => { if (failLoad) throw new Error('final load failed'); return core.loadSourceFromFile(id, opts); },
    fsOverrides: { unlink: async (file) => { if (toTarget(file)) throw fsError('EPERM'); return fs.promises.unlink(file); } },
  });
  const sha256 = await staged(rig);
  failLoad = true;
  const err = await rejection(rig.service.install({ sha256, id: 'demo' }));
  assert.equal(err.statusCode, 500);
  assert.match(err.message, /could not be rolled back: delete demo\.js from the sources folder by hand \(final load failed\)/);
  assert.doesNotMatch(err.message, /and was rolled back/);
  assert.deepEqual(rig.liveFiles(), ['demo.js'], 'the file really is still there, as the message says');
});

test('a store that cannot be written rolls the install back: the file goes and no entry is left', async (t) => {
  const rig = makeRig(t, { writeStoreImpl: async () => { throw new Error('store refused the write'); } });
  const sha256 = await staged(rig);
  const err = await rejection(rig.service.install({ sha256, id: 'demo' }));
  assert.match(err.message, /could not be registered and was rolled back: store refused the write/);
  assert.deepEqual(rig.liveFiles(), []);
  assert.deepEqual(rig.store.installedSources, {});
  assert.equal(rig.counters.flushed, 0);
});

test('a replacement whose store write fails gets the old file and the old entry back', async (t) => {
  let failWrites = false;
  const rig = makeRig(t, {
    writeStoreImpl: async () => { if (failWrites) throw new Error('store refused the write'); },
  });
  const first = await rig.service.preview({ code: sourceText('demo', { meta: ", marker: 'v1'" }), id: 'demo' });
  await rig.service.install({ sha256: first.sha256, id: 'demo' });
  const before = { ...rig.store.installedSources.demo };
  const second = await rig.service.preview({ code: sourceText('demo', { meta: ", marker: 'v2'" }), id: 'demo' });
  failWrites = true;
  await rejection(rig.service.install({ sha256: second.sha256, id: 'demo', replace: true }));
  assert.match(fs.readFileSync(rig.live('demo'), 'utf8'), /marker: 'v1'/);
  assert.deepEqual(rig.store.installedSources.demo, before);
  assert.equal(rig.core.loadSourceFromFile('demo').meta.marker, 'v1', 'and the old source is what is served');
});

test('a replacement serves the new module; a failed one keeps serving the old one', async (t) => {
  let failNext = false;
  const rig = makeRig(t, {
    loadSource: (core, id, opts) => { if (failNext) { failNext = false; throw new Error('final load failed'); } return core.loadSourceFromFile(id, opts); },
  });
  const one = await rig.service.preview({ code: sourceText('demo', { meta: ", marker: 'v1'" }), id: 'demo' });
  await rig.service.install({ sha256: one.sha256, id: 'demo' });
  assert.equal(rig.core.loadSourceFromFile('demo').meta.marker, 'v1');

  const two = await rig.service.preview({ code: sourceText('demo', { meta: ", marker: 'v2'" }), id: 'demo' });
  await rig.service.install({ sha256: two.sha256, id: 'demo', replace: true });
  assert.equal(rig.core.loadSourceFromFile('demo').meta.marker, 'v2', 'not the module cached from v1');

  const three = await rig.service.preview({ code: sourceText('demo', { meta: ", marker: 'v3'" }), id: 'demo' });
  failNext = true;
  await rejection(rig.service.install({ sha256: three.sha256, id: 'demo', replace: true }));
  assert.equal(rig.core.loadSourceFromFile('demo').meta.marker, 'v2', 'the undo brings v2 back, and it is what is served');
});

// ── what runs is what was checked ───────────────────────────────────────────

test('the candidate that runs is the text whose hash was verified, handed to the loader', async (t) => {
  const seen = [];
  let core;
  const rig = makeRig(t, {
    loadCandidate: (file, id, text) => { seen.push({ file, id, text }); return core.loadCandidateFromFile(file, id, text); },
  });
  core = rig.core;
  const code = sourceText('demo');
  const sha256 = await staged(rig, code);
  await rig.service.install({ sha256, id: 'demo' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].text, code);
  assert.equal(seen[0].id, 'demo');
});

test('the loader runs the text it is given, not what the file holds', async (t) => {
  const rig = makeRig(t);
  const file = path.join(rig.root, 'candidate.js');
  fs.writeFileSync(file, sourceText('on-disk'));
  assert.equal(rig.core.loadCandidateFromFile(file, 'x', sourceText('verified')).meta.id, 'verified');
  assert.equal(rig.core.loadCandidateFromFile(file, 'x').meta.id, 'on-disk', 'without text the file is read');
  assert.ok(!Object.keys(require.cache).includes(path.resolve(file)), 'and nothing is left in require.cache');
});

test('a checked file expires after an hour: installing it later asks for a new check', async (t) => {
  let clock = Date.now();
  const rig = makeRig(t, { now: () => clock });
  const sha256 = await staged(rig);
  clock += 61 * 60 * 1000;
  const err = await rejection(rig.service.install({ sha256, id: 'demo' }));
  assert.equal(err.statusCode, 404);
  assert.match(err.message, /choose it again/);
  assert.deepEqual(rig.stagedFiles(), [], 'the expired file was removed');
  assert.deepEqual(rig.liveFiles(), []);
});

test('install judges the id again: reserved names, device names and a letter-case clash are refused even for a file staged under another id', async (t) => {
  const rig = makeRig(t);
  rig.store.installedSources.Taken = { id: 'Taken', installedVia: 'bundled' };
  const sha256 = await staged(rig, sourceText('harmless'), 'harmless');
  for (const bad of ['local', 'LOCAL', 'con', 'NUL', 'com1', 'constructor', '__proto__', '../x', 'a b']) {
    const err = await rejection(rig.service.install({ sha256, id: bad }));
    assert.equal(err.statusCode, 400, bad);
    assert.equal(err.code, SOURCE_IMPORT_FAILED);
  }
  const clash = await rejection(rig.service.install({ sha256, id: 'taken' }));
  assert.equal(clash.statusCode, 409);
  assert.match(clash.message, /letter case/);
  assert.deepEqual(rig.liveFiles(), []);
});

// ── the staging folder is on the same disk: passing refusals are tried again there too ──

test('a staging rename the system refuses once does not fail Check', async (t) => {
  let refused = 0;
  const rig = makeRig(t, {
    fsOverrides: {
      rename: async (from, to) => {
        if (/source-staging/.test(String(to)) && refused < 1) { refused += 1; throw fsError('EPERM'); }
        return fs.promises.rename(from, to);
      },
    },
  });
  const report = await rig.service.preview({ code: sourceText('demo'), id: 'demo' });
  assert.equal(report.canInstall, true);
  assert.equal(refused, 1);
});

test('a read of the staged file the system refuses once is tried again; a refusal that stays is a disk fault, not an expired check', async (t) => {
  let refusals = 0;
  let always = false;
  const rig = makeRig(t, {
    fsOverrides: {
      readFile: async (file, options) => {
        if (/source-staging/.test(String(file)) && (always || refusals < 1)) { refusals += 1; throw fsError('EBUSY'); }
        return fs.promises.readFile(file, options);
      },
    },
  });
  const sha256 = await staged(rig);
  const result = await rig.service.install({ sha256, id: 'demo' });
  assert.equal(result.ok, true, 'one refusal is tried again');

  const again = await staged(rig, sourceText('demo-2'), 'demo-2');
  always = true;
  const err = await rejection(rig.service.install({ sha256: again, id: 'demo-2' }));
  assert.equal(err.statusCode, 500);
  assert.match(err.message, /^The file could not be saved: EBUSY/, 'not "no longer available"');
});

test('only a missing staged file is reported as no longer available', async (t) => {
  const rig = makeRig(t);
  const err = await rejection(rig.service.install({ sha256: 'f'.repeat(64), id: 'demo' }));
  assert.equal(err.statusCode, 404);
});

test('a second Check of the same text whose write dies half way leaves the first staged copy whole', async (t) => {
  let failStagingWrite = false;
  const rig = makeRig(t, {
    fsOverrides: {
      writeFile: async (file, text, options) => {
        if (failStagingWrite && /source-staging/.test(String(file))) {
          await fs.promises.writeFile(file, String(text).slice(0, 10), options);
          throw fsError('ENOSPC');
        }
        return fs.promises.writeFile(file, text, options);
      },
    },
  });
  const code = sourceText('demo');
  const first = await rig.service.preview({ code, id: 'demo' });
  failStagingWrite = true;
  await rejection(rig.service.preview({ code, id: 'demo' }));
  failStagingWrite = false;
  assert.deepEqual(rig.stagedFiles(), [`${first.sha256}.js`], 'whole, and no temporary name left');
  assert.equal((await rig.service.install({ sha256: first.sha256, id: 'demo' })).ok, true);
});

// ── the undo ────────────────────────────────────────────────────────────────

test('an undo the system refuses once is tried again, and a file that is already gone counts as undone', async (t) => {
  let failLoad = false;
  let refusals = 0;
  let vanish = false;
  const rig = makeRig(t, {
    loadSource: (core, id, opts) => {
      if (vanish) { fs.rmSync(path.join(rig.sourcesDir, `${id}.js`)); throw new Error('Source not found: demo'); }
      if (failLoad) throw new Error('final load failed');
      return core.loadSourceFromFile(id, opts);
    },
    fsOverrides: { unlink: async (file) => { if (toTarget(file) && failLoad && refusals < 1) { refusals += 1; throw fsError('EPERM'); } return fs.promises.unlink(file); } },
  });
  const one = await staged(rig);
  failLoad = true;
  const retried = await rejection(rig.service.install({ sha256: one, id: 'demo' }));
  assert.match(retried.message, /and was rolled back/);
  assert.deepEqual(rig.liveFiles(), []);

  failLoad = false;
  vanish = true;
  const gone = await rejection(rig.service.install({ sha256: one, id: 'demo' }));
  assert.match(gone.message, /and was rolled back/);
  assert.doesNotMatch(gone.message, /by hand/);
});

test('when a REPLACEMENT cannot be undone the person is told to restore the .bak, never to delete the only working file', async (t) => {
  let failLoad = false;
  const rig = makeRig(t, {
    loadSource: (core, id, opts) => { if (failLoad) throw new Error('final load failed'); return core.loadSourceFromFile(id, opts); },
    fsOverrides: {
      copyFile: async (from, to) => {
        if (failLoad && String(from).endsWith('.bak')) throw fsError('EPERM');
        return fs.promises.copyFile(from, to);
      },
    },
  });
  const first = await staged(rig, sourceText('demo', { meta: ", marker: 'v1'" }));
  await rig.service.install({ sha256: first, id: 'demo' });
  const second = await staged(rig, sourceText('demo', { meta: ", marker: 'v2'" }));
  failLoad = true;
  const err = await rejection(rig.service.install({ sha256: second, id: 'demo', replace: true }));
  assert.match(err.message, /could not be rolled back: restore demo\.js from demo\.js\.bak by hand/);
  assert.doesNotMatch(err.message, /delete demo\.js/);
  assert.match(fs.readFileSync(`${rig.live('demo')}.bak`, 'utf8'), /marker: 'v1'/, 'the .bak really holds the previous version');
});

// ── messages ────────────────────────────────────────────────────────────────

test('the reasons of a contract failure carry no path of this computer, spaces in it or not', async (t) => {
  const rig = makeRig(t);
  const leaked = path.join(os.tmpdir(), 'A folder with spaces', 'secret.txt');
  const code = `Object.defineProperty(exports, 'meta', { get() { throw new Error(${JSON.stringify(`ENOENT: open '${leaked}'`)}); } });\nexports.search = async () => ({});\n`;
  const sha256 = await staged(rig, code);
  const err = await rejection(rig.service.install({ sha256, id: 'demo' }));
  assert.equal(err.statusCode, 400);
  const text = JSON.stringify(err.details);
  assert.match(text, /exports could not be read: ENOENT: open '<path>'/);
  assert.doesNotMatch(text, /spaces|secret\.txt/, 'not even the tail after the first space');
});

