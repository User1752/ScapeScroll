'use strict';

// Which installed sources can be uninstalled: the two origins this app put on disk itself ('repo', installed from a
// repository, and 'imported', a file the person imported with the import tool) and nothing else. A source whose file
// the person or the build placed ('bundled', or no origin at all on data from before the field existed) is refused.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSourceLifecycleService } = require('../../server/modules/sources/lifecycle');

function makeRig(t, installedSources) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = { installedSources: { ...installedSources }, repos: [] };
  const calls = { cleared: [], invalidated: 0, writes: 0 };
  const service = createSourceLifecycleService({
    readStore: async () => store,
    writeStore: async () => { calls.writes += 1; },
    sourcePath: (id) => path.join(dir, `${id}.js`),
    builtinSourcePath: () => '',
    loadSourceFromFile: () => ({}),
    clearSourceCache: (id) => calls.cleared.push(id),
    listAvailableSourcesFromRepos: async () => [],
    invalidatePopularAll: () => { calls.invalidated += 1; },
  });
  const touch = (id) => fs.writeFileSync(path.join(dir, `${id}.js`), '// file');
  return { dir, store, calls, service, touch, exists: (id) => fs.existsSync(path.join(dir, `${id}.js`)) };
}

test('an imported source and a repository source can be uninstalled: the file goes, the store entry goes, the caches are cleared', async (t) => {
  const rig = makeRig(t, { mine: { installedVia: 'imported' }, fromRepo: { installedVia: 'repo' } });
  fs.writeFileSync(path.join(rig.dir, 'mine.js.bak'), '// previous version');
  fs.writeFileSync(path.join(rig.dir, 'mine.js.import.json'), '{}'); // the marker the command line leaves
  for (const id of ['mine', 'fromRepo']) {
    rig.touch(id);
    assert.deepEqual(await rig.service.uninstallById(id), { ok: true });
    assert.equal(rig.exists(id), false, id);
    assert.equal(rig.store.installedSources[id], undefined, id);
  }
  assert.equal(fs.existsSync(path.join(rig.dir, 'mine.js.bak')), false, 'the backup of a replaced file goes with the source');
  assert.equal(fs.existsSync(path.join(rig.dir, 'mine.js.import.json')), false, 'and so does the import marker');
  assert.deepEqual(rig.calls.cleared, ['mine', 'fromRepo']);
  assert.equal(rig.calls.invalidated, 2);
});

test('a bundled source, one with no origin and one that is not installed are refused, and their files stay', async (t) => {
  const rig = makeRig(t, { bundled: { installedVia: 'bundled' }, old: {} });
  rig.touch('bundled');
  rig.touch('old');
  for (const id of ['bundled', 'old', 'missing']) {
    await assert.rejects(rig.service.uninstallById(id), (err) => err.statusCode === 400 && /bundled/.test(err.message), id);
  }
  assert.equal(rig.exists('bundled'), true);
  assert.equal(rig.exists('old'), true);
  assert.equal(rig.calls.writes, 0);
});

test('an id that is not a safe id is refused before anything is read or removed', async (t) => {
  const rig = makeRig(t, { mine: { installedVia: 'imported' } });
  rig.touch('mine');
  for (const bad of ['../mine', 'a/b', '', undefined, null, 5]) {
    await assert.rejects(rig.service.uninstallById(bad), (err) => err.statusCode === 400, String(bad));
  }
  assert.equal(rig.exists('mine'), true);
});
