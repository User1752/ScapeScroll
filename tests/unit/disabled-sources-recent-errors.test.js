'use strict';

// The System Health numbers cover the sources the user left switched on. The error-log history of a source
// that was switched off (a site that keeps timing out, which is why it was switched off) must not keep
// "Recent source errors detected" lit for the 7 days the window lasts. The service runs on injected stand-ins in a
// temporary folder: nothing touches the network or the real data folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { enabledSourceIdsOf } = require('../../server/modules/sources/disabled-sources');
const { createSystemHealthService } = require('../../server/modules/system-health/service');

test('enabledSourceIdsOf: the installed ids that are not disabled, in installed order, whatever the store holds', () => {
  const store = (installed, list) => ({ installedSources: Object.fromEntries(installed.map((id) => [id, {}])), settings: { disabledSourceIds: list } });
  assert.deepEqual(enabledSourceIdsOf(store(['a', 'b', 'c'], ['b'])), ['a', 'c']);
  assert.deepEqual(enabledSourceIdsOf(store(['a', 'b'], [])), ['a', 'b']);
  assert.deepEqual(enabledSourceIdsOf(store(['a', 'b'], ['a', 'b'])), []);
  assert.deepEqual(enabledSourceIdsOf(store(['a'], ['not-installed'])), ['a'], 'a disabled id nobody installed changes nothing');
  for (const junk of [undefined, null, 'a', 7, {}, [7, null, {}]]) {
    assert.deepEqual(enabledSourceIdsOf(store(['a', 'b'], junk)), ['a', 'b'], JSON.stringify(junk));
  }
  for (const broken of [undefined, null, 5, 'x', {}, { installedSources: null }, { installedSources: [] }]) {
    assert.doesNotThrow(() => enabledSourceIdsOf(broken));
  }
  assert.deepEqual(enabledSourceIdsOf(undefined), []);
});

const mockTimers = (t) => t.mock.timers.enable({ apis: ['setTimeout'] });

function makeService(t, { disabledSourceIds }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-recent-errors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'server', 'routes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const now = new Date().toISOString();
  const entry = (area) => ({ area, code: 'HTTP-500', message: `${area} timed out after 45000ms`, count: 3, lastSeenAt: now });
  fs.writeFileSync(path.join(root, 'data', 'error-log.json'), JSON.stringify([entry('alpha'), entry('beta')]));

  const store = {
    installedSources: { alpha: { name: 'ALPHA' }, beta: { name: 'BETA' } },
    settings: disabledSourceIds === undefined ? {} : { disabledSourceIds },
  };
  return createSystemHealthService({
    readStore: async () => store,
    writeStore: async () => {},
    loadSourceFromFile: (id) => ({
      meta: { id, name: id },
      search: () => ({ results: [], hasNextPage: false }),
      mangaDetails: async () => ({}),
      chapters: async () => ({ chapters: [] }),
      pages: async () => ({ pages: [] }),
    }),
    getFlaresolverrUrl: async () => '',
    fetchProxyImage: async () => ({}),
    projectRoot: root,
    dataDir: path.join(root, 'data'),
  });
}

async function errorLogCheck(service) {
  const { checks } = await service.runSmokeTest();
  return checks.find((check) => check.id === 'source-error-log');
}

test('the smoke check counts the log records of the sources left on and ignores the ones switched off', async (t) => {
  mockTimers(t);
  const none = await errorLogCheck(makeService(t, { disabledSourceIds: undefined }));
  assert.match(none.details, /Source errors detected \(2 records; 2 repeated >= 3 times\)/, 'both records count when nothing is disabled');

  const some = await errorLogCheck(makeService(t, { disabledSourceIds: ['beta'] }));
  assert.match(some.details, /Source errors detected \(1 records; 1 repeated >= 3 times\)/);

  const both = await errorLogCheck(makeService(t, { disabledSourceIds: ['alpha', 'beta'] }));
  assert.equal(both.status, 'pass', both.details);
  assert.match(both.details, /No recent source errors/);
});
