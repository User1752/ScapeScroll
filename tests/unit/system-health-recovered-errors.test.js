'use strict';

// The error log keeps a source's records for 7 days, so a problem that was fixed (seen live: MangaHub's
// "curl exit ENOENT" of one night, after curl was made independent of PATH) held System Health at "warning"
// for a week even though the source passed every live probe. The live probe is the current truth: the records
// of a source that PASSES NOW stop counting once they are older than RECOVERED_SOURCE_ERROR_AFTER_MS. Records from
// the last hours still count (a source that flaps is not "recovered"), and a source that does not pass keeps all
// of its records for the whole window. The service runs on injected stand-ins in a temp folder: no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { collectRecentSourceErrors, createSystemHealthService } = require('../../server/modules/system-health/service');
const { RECOVERED_SOURCE_ERROR_AFTER_MS } = require('../../server/config/system-health');

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-10-26T19:00:00Z');
const hoursAgo = (hours) => new Date(NOW - hours * HOUR_MS).toISOString();
// A record as the error handler writes it for a call of a source: the request path is in details.url.
const entry = (area, lastSeenAt, extra = {}) => ({
  area, code: 'HTTP-500', message: `${area} failed`, count: 3, lastSeenAt, details: { url: `/api/source/${area}/search?q=x` }, ...extra,
});

test('the recovery age is 12 hours', () => {
  assert.equal(RECOVERED_SOURCE_ERROR_AFTER_MS, 12 * HOUR_MS);
});

test('the old records of a source that passes now are dropped; recent ones and other sources keep theirs', () => {
  const entries = [
    entry('fixed', hoursAgo(19)), // passes now, last seen 19 h ago: recovered
    entry('flapping', hoursAgo(3)), // passes now, but failed 3 h ago: still counts
    entry('broken', hoursAgo(30)), // does not pass now: all of the window counts
    entry('unprobed', hoursAgo(30)), // no live result at all: counts as before
  ];
  const areas = (result) => result.map((e) => e.area).sort();
  const withHealthy = collectRecentSourceErrors(entries, ['fixed', 'flapping', 'broken', 'unprobed'], { now: NOW, healthyIds: ['fixed', 'flapping'] });
  assert.deepEqual(areas(withHealthy), ['broken', 'flapping', 'unprobed']);

  const without = collectRecentSourceErrors(entries, ['fixed', 'flapping', 'broken', 'unprobed'], { now: NOW });
  assert.deepEqual(areas(without), ['broken', 'fixed', 'flapping', 'unprobed'], 'nothing changes when no live result is given');
  for (const junk of [undefined, null, [], 'fixed', 7, {}]) {
    assert.deepEqual(areas(collectRecentSourceErrors(entries, ['fixed', 'broken'], { now: NOW, healthyIds: junk })), ['broken', 'fixed'], JSON.stringify(junk));
  }
});

test('only a record of a call the probe exercises is dropped: chapters, pages, details and records with no call path keep their window', () => {
  const at = (method) => entry('s', hoursAgo(19), { details: { url: `/api/source/s/${method}` } });
  const kept = collectRecentSourceErrors([
    at('chapters'), at('pages'), at('mangaDetails'),
    entry('s', hoursAgo(19), { details: {} }),
    entry('s', hoursAgo(19), { details: undefined }),
    entry('s', hoursAgo(19), { details: { url: '/api/proxy-image?url=x' } }),
  ], ['s'], { now: NOW, healthyIds: ['s'] });
  assert.equal(kept.length, 6, 'a passing search says nothing about these');

  const probed = ['search', 'authorSearch', 'trending', 'popularAllTime', 'recentlyAdded', 'latestUpdates', 'byGenres'].map(at);
  assert.equal(collectRecentSourceErrors(probed, ['s'], { now: NOW, healthyIds: ['s'] }).length, 0);
  const spelled = entry('s', hoursAgo(19), { details: { url: '/api/source/s/search/?q=a&b=c' } });
  assert.equal(collectRecentSourceErrors([spelled], ['s'], { now: NOW, healthyIds: ['s'] }).length, 0, 'a query string or a trailing slash does not hide the call');
  assert.equal(collectRecentSourceErrors([at('pages')], ['s'], { now: NOW }).length, 1);
});

test('the age is a limit at 12 hours: exactly at it still counts, a moment past it does not', () => {
  const at = collectRecentSourceErrors([entry('s', hoursAgo(12))], ['s'], { now: NOW, healthyIds: ['s'] });
  assert.equal(at.length, 1);
  const past = collectRecentSourceErrors([entry('s', new Date(NOW - 12 * HOUR_MS - 1000).toISOString())], ['s'], { now: NOW, healthyIds: ['s'] });
  assert.equal(past.length, 0);
});

// ── the System Health smoke check, end to end ───────────────────────────────────────────────────────

const mockTimers = (t) => t.mock.timers.enable({ apis: ['setTimeout'] });

function makeService(t, { entries, failing = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-recovered-errors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'server', 'routes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'error-log.json'), JSON.stringify(entries));
  const store = { installedSources: { alpha: { name: 'ALPHA' }, beta: { name: 'BETA' } }, settings: {} };
  return createSystemHealthService({
    readStore: async () => store,
    writeStore: async () => {},
    loadSourceFromFile: (id) => ({
      meta: { id, name: id },
      search: () => { if (failing.includes(id)) throw new Error('boom'); return { results: [], hasNextPage: false }; },
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

const logCheck = async (service) => (await service.runSmokeTest()).checks.find((check) => check.id === 'source-error-log');
const realNow = Date.now();
const ago = (hours) => new Date(realNow - hours * HOUR_MS).toISOString();

test('smoke check: stale records of a source that passes stop holding the check at "warning"', async (t) => {
  mockTimers(t);
  const check = await logCheck(makeService(t, { entries: [entry('alpha', ago(19)), entry('alpha', ago(20), { code: 'X' })] }));
  assert.equal(check.status, 'pass', check.details);
  assert.match(check.details, /No recent source errors/);
});

test('smoke check: the same records still count while the source fails the live probe, or when they are recent', async (t) => {
  mockTimers(t);
  const stillFailing = await logCheck(makeService(t, { entries: [entry('beta', ago(19))], failing: ['beta'] }));
  assert.equal(stillFailing.status, 'warning');
  assert.match(stillFailing.details, /Source errors detected \(1 records; 1 repeated >= 3 times\)/);

  const recent = await logCheck(makeService(t, { entries: [entry('alpha', ago(2))] }));
  assert.equal(recent.status, 'warning');
  assert.match(recent.details, /Source errors detected \(1 records/);

  const mixed = await logCheck(makeService(t, { entries: [entry('alpha', ago(19)), entry('beta', ago(19))], failing: ['beta'] }));
  assert.match(mixed.details, /Source errors detected \(1 records/, 'only the failing source keeps its record');
});
