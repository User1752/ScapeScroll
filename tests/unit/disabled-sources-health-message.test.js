'use strict';

// The "Source live health probe" check of the System Health smoke test used to answer a warning,
// "No installed sources to run live probe.", whenever the probe had no rows. With sources installed but
// every one of them disabled by the user the probe has no rows on purpose, which is not a problem: the
// check says so and passes. The warning stays for a library with no installed source at all.
// The service runs on injected stand-ins in a temporary project folder; nothing touches the network or
// the real data folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSystemHealthService } = require('../../server/modules/system-health/service');

const CHECK_ID = 'source-health-probe';
const ALL_DISABLED = 'Every installed source is disabled; nothing to probe.';
const NO_SOURCES = 'No installed sources to run live probe.';

// The live probe races each source against a 15 s timer; mocked, it cannot keep the test process alive.
const mockTimers = (t) => t.mock.timers.enable({ apis: ['setTimeout'] });

function makeService(t, { installed, disabledSourceIds }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-health-message-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'server', 'routes'), { recursive: true });

  const store = {
    installedSources: Object.fromEntries(installed.map((id) => [id, { name: id.toUpperCase() }])),
    settings: disabledSourceIds === undefined ? {} : { disabledSourceIds },
  };
  const searched = [];
  const service = createSystemHealthService({
    readStore: async () => store,
    writeStore: async () => {},
    loadSourceFromFile: (id) => ({
      meta: { id, name: id },
      search: () => { searched.push(id); return { results: [], hasNextPage: false }; },
      mangaDetails: async () => ({}),
      chapters: async () => ({ chapters: [] }),
      pages: async () => ({ pages: [] }),
    }),
    getFlaresolverrUrl: async () => '',
    fetchProxyImage: async () => ({}),
    projectRoot: root,
    dataDir: path.join(root, 'data'),
  });
  return { service, searched };
}

async function probeCheck(service) {
  const { checks } = await service.runSmokeTest();
  return checks.find((check) => check.id === CHECK_ID);
}

test('every installed source disabled: the check passes and says why there is nothing to probe', async (t) => {
  mockTimers(t);
  const { service, searched } = makeService(t, { installed: ['alpha', 'beta'], disabledSourceIds: ['alpha', 'beta'] });

  const check = await probeCheck(service);

  assert.equal(check.status, 'pass');
  assert.equal(check.details, ALL_DISABLED);
  assert.deepEqual(searched, [], 'and nothing was probed');
});

test('no installed source at all: the warning stays, even when a list of disabled ids is stored', async (t) => {
  mockTimers(t);
  for (const disabledSourceIds of [undefined, [], ['alpha']]) {
    const { service } = makeService(t, { installed: [], disabledSourceIds });
    const check = await probeCheck(service);
    assert.equal(check.status, 'warning', JSON.stringify(disabledSourceIds));
    assert.equal(check.details, NO_SOURCES);
  }
});

test('some sources disabled: only the enabled ones are probed and counted', async (t) => {
  mockTimers(t);
  const { service, searched } = makeService(t, { installed: ['alpha', 'beta', 'gamma'], disabledSourceIds: ['beta'] });

  const check = await probeCheck(service);

  assert.equal(check.status, 'pass');
  assert.equal(check.details, 'All 2 source probes passed.');
  assert.deepEqual(searched.sort(), ['alpha', 'gamma']);
});

test('nothing disabled, or a list that disables nothing installed: every source is probed as before', async (t) => {
  mockTimers(t);
  for (const disabledSourceIds of [undefined, [], ['not-installed'], 'alpha', [7, null]]) {
    const { service, searched } = makeService(t, { installed: ['alpha', 'beta'], disabledSourceIds });
    const check = await probeCheck(service);
    assert.equal(check.details, 'All 2 source probes passed.', JSON.stringify(disabledSourceIds));
    assert.deepEqual(searched.sort(), ['alpha', 'beta']);
  }
});
