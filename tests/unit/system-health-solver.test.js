'use strict';

// What System Health says about the FlareSolverr session pool: one row in the External Services grid,
// one row in the dependency check, and the patience the health probes declare to the solver.
// Everything is fed in by the test (a status object, a fetch that answers for FlareSolverr and GitHub):
// no pool, no network and no file of the data folder is touched. The lifecycle module is replaced by a
// stand-in while the health modules load, because the real one reads data/setup.json when it is loaded.

const test = require('node:test');
const assert = require('node:assert/strict');

const LIFECYCLE_PATH = require.resolve('../../server/modules/network/flaresolverr-lifecycle');
const lifecycleBefore = require.cache[LIFECYCLE_PATH];
require.cache[LIFECYCLE_PATH] = {
  id: LIFECYCLE_PATH, filename: LIFECYCLE_PATH, loaded: true, exports: { isManaged: () => false },
};
const { createServicesHealthCheckService, checkSolverPool } = require('../../server/modules/system-health/services-health');
const { toSourceStatus, classifySourceError, isTransientSourceErrorKey } = require('../../server/modules/system-health/service');
const { createDependencyHealthCheckService, checkFlareSolverrVersion } = require('../../server/modules/system-health/dependency-health');
const { updatePinnedCdnLib } = require('../../server/modules/system-health/dependency-update');
const { createSourceHealthCheckService } = require('../../server/modules/sources/health-check');
const { getSolverContext } = require('../../server/modules/network/solver-context');
const { createSolverPool } = require('../../server/modules/network/solver-pool');
const { applySolverSettings } = require('../../server/modules/network/solver-wiring');
if (lifecycleBefore) require.cache[LIFECYCLE_PATH] = lifecycleBefore; else delete require.cache[LIFECYCLE_PATH];

const SOLVER_URL = 'http://127.0.0.1:8191/v1';
const MINUTE = 60_000;

// A pool status as pool.getStatus() builds it (server/modules/network/solver/status.js).
function status(overrides = {}) {
  return {
    enabled: true,
    disabledBy: null,
    state: 'idle',
    sessions: [],
    queued: { interactive: 0, background: 0 },
    inFlight: 0,
    counters: { jobs: 0, sessionJobs: 0, statelessJobs: 0, directJobs: 0, resets: 0, recycles: 0, hostBlocks: 0, queueTimeouts: 0, orphansSwept: 0, httpErrors: 0 },
    cooldowns: [],
    circuit: { open: false, secondsLeft: 0 },
    lastError: null,
    ...overrides,
  };
}

const session = (overrides = {}) => ({ idleMs: 3 * MINUTE, ageMs: 9 * MINUTE, uses: 41, busy: false, proxy: 'none', ...overrides });

test('a pool that is off says why: the setting, or the environment switch', () => {
  assert.deepEqual(checkSolverPool(status({ enabled: false, state: 'disabled', disabledBy: 'setting' })), {
    id: 'solver-pool', name: 'Browser sessions', ok: true, error: '', details: 'Off (not switched on in Settings)',
  });
  assert.equal(checkSolverPool(status({ enabled: false, state: 'disabled', disabledBy: 'env' })).details, 'Off (SCROLLSCAPE_SOLVER_SESSIONS_DISABLED is set)');
  assert.equal(checkSolverPool(status({ enabled: false, state: 'disabled', disabledBy: null })).details, 'Off', 'not told anything yet');
});

test('a pool that is on says whether a browser is open, and how busy it is', () => {
  assert.equal(checkSolverPool(status()).details, 'Ready (a browser opens when a protected site is first needed)');
  assert.equal(checkSolverPool(status({ state: 'active', sessions: [session()] })).details, '1 session open (idle 3 min, 41 requests), queue 0');
  assert.equal(
    checkSolverPool(status({ state: 'active', sessions: [session({ busy: true, idleMs: 0, uses: 1 })], queued: { interactive: 2, background: 1 } })).details,
    '1 session open (in use, 1 request), queue 3',
  );
  assert.equal(
    checkSolverPool(status({ state: 'active', sessions: [session({ idleMs: 5 * MINUTE }), session({ idleMs: 2 * MINUTE, uses: 9 })] })).details,
    '2 sessions open (idle 2 min, 50 requests), queue 0',
  );
});

test('a restart or a FlareSolverr that does not answer is information, not a fault', () => {
  const restarting = checkSolverPool(status({ state: 'restarting' }));
  assert.deepEqual([restarting.ok, restarting.error, restarting.details], [true, '', 'FlareSolverr is restarting; requests wait']);
  const down = checkSolverPool(status({ state: 'down' }));
  assert.deepEqual([down.ok, down.error, down.details], [true, '', 'FlareSolverr did not answer; retrying shortly']);
});

test('only a pool that keeps failing is a problem, and it says so itself (severity warning) with the minutes left', () => {
  const row = checkSolverPool(status({ state: 'circuit-open', circuit: { open: true, secondsLeft: 230 } }));
  assert.equal(row.ok, false);
  assert.equal(row.severity, 'warning');
  assert.equal(row.error, 'Browser sessions kept failing; using one-off browsers for the next 4 min');
  assert.equal(checkSolverPool(status({ state: 'circuit-open', circuit: { open: true, secondsLeft: 0 } })).error.endsWith('next 1 min'), true);
});

test('the rows name no site, URL, cookie, proxy or session id: sites cooling down are only counted', () => {
  const snapshot = status({
    state: 'active',
    sessions: [session({ proxy: 'user' })],
    cooldowns: [{ host: 'cf-site.example', secondsLeft: 40 }, { host: 'other-site.example', secondsLeft: 20 }],
    lastError: { at: '2026-10-25T10:00:00.000Z', kind: 'blocked' },
  });
  const row = checkSolverPool(snapshot);
  assert.equal(row.details, '1 session open (idle 3 min, 41 requests), queue 0, 2 sites cooling down');
  const shown = JSON.stringify(row);
  for (const leak of ['cf-site', 'other-site', 'http', 'cookie', 'proxy', 'ss-']) assert.ok(!shown.includes(leak), leak);
  assert.equal(checkSolverPool(status({ cooldowns: [{ host: 'cf-site.example', secondsLeft: 40 }] })).details.endsWith(', 1 site cooling down'), true);
});

test('what is not a status, or a state nobody knows, leaves the row out', () => {
  for (const nothing of [null, undefined, 'idle', 42, [], { state: 'something-new' }]) {
    assert.equal(checkSolverPool(nothing), null, JSON.stringify(nothing));
  }
});

test('the rows of a real pool, as it reports itself', async (t) => {
  const pool = createSolverPool();
  t.after(() => pool.shutdown({ timeoutMs: 50 }));
  assert.equal(checkSolverPool(pool.getStatus()).details, 'Off');
  applySolverSettings(pool, {}, {});
  assert.equal(checkSolverPool(pool.getStatus()).details, 'Off (not switched on in Settings)', 'nothing chosen: the default is off');
  applySolverSettings(pool, { solverSessionsEnabled: false }, {});
  assert.equal(checkSolverPool(pool.getStatus()).details, 'Off (not switched on in Settings)');
  applySolverSettings(pool, { solverSessionsEnabled: true }, { SCROLLSCAPE_SOLVER_SESSIONS_DISABLED: '1' });
  assert.equal(checkSolverPool(pool.getStatus()).details, 'Off (SCROLLSCAPE_SOLVER_SESSIONS_DISABLED is set)');
  applySolverSettings(pool, { solverSessionsEnabled: true }, {});
  assert.equal(checkSolverPool(pool.getStatus()).details, 'Ready (a browser opens when a protected site is first needed)');
  pool.beginRestart('test');
  assert.equal(checkSolverPool(pool.getStatus()).details, 'FlareSolverr is restarting; requests wait');
});

test('with the REAL classifier a failing pool row is a warning, and its text is not filed under a misleading error type', () => {
  const rows = [30, 120, 240, 300].map((secondsLeft) => checkSolverPool(status({ state: 'circuit-open', circuit: { open: true, secondsLeft } })));
  for (const row of rows) {
    const classified = classifySourceError(row.error);
    assert.notEqual(classified.key, 'api_error', row.error);
    assert.notEqual(classified.key, 'site_maintenance', row.error);
    // Without the severity this text (it matches nothing) would be a hard failure and land in
    // "external services are unreachable".
    assert.equal(isTransientSourceErrorKey(classified.key), false, 'the classifier alone would call it a failure');
  }
  const converted = toSourceStatus(rows);
  assert.deepEqual(converted.results.map((r) => r.status), ['warning', 'warning', 'warning', 'warning']);
  assert.equal(converted.summary.failing, 0);
  assert.equal(converted.summary.degraded, 4);
  assert.equal(converted.results[0].severity, 'warning');
});

test('a row that fails without a severity is still a failure: the new field changes nothing else', () => {
  const [row] = toSourceStatus([{ id: 'anilist', name: 'AniList API', ok: false, error: 'something unexpected broke' }]).results;
  assert.equal(row.status, 'fail');
  assert.equal('severity' in row, false);
  const [ok] = toSourceStatus([checkSolverPool(status())]).results;
  assert.equal(ok.status, 'pass');
  assert.equal(ok.details, 'Ready (a browser opens when a protected site is first needed)');
});

// The services check, with the network stubbed: FlareSolverr and AniList answer, nothing else does.
async function serviceRows(t, options) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://graphql.anilist.co')) return { ok: true, status: 200, json: async () => ({ data: {} }) };
    if (String(url).startsWith('http://127.0.0.1:8191/')) return { ok: true, status: 200, json: async () => ({ version: '3.5.2' }) };
    throw new Error(`unexpected request to ${url}`);
  };
  t.after(() => { globalThis.fetch = real; });
  const warnings = [];
  t.mock.method(console, 'error', (message) => warnings.push(String(message)));
  const service = createServicesHealthCheckService({ getFlaresolverrUrl: async () => SOLVER_URL, isFlaresolverrManaged: () => true, ...options });
  return { rows: await service.runServiceChecks(), warnings };
}

test('the row sits next to FlareSolverr\'s own in the External Services grid', async (t) => {
  const { rows } = await serviceRows(t, { getSolverSnapshot: () => status() });
  assert.deepEqual(rows.map((row) => row.id), ['flaresolverr', 'solver-pool', 'anilist', 'discord']);
});

test('without a snapshot, or with one that throws, the grid is exactly what it was and health never fails', async (t) => {
  const plain = await serviceRows(t, {});
  assert.deepEqual(plain.rows.map((row) => row.id), ['flaresolverr', 'anilist', 'discord']);

  const nothing = await serviceRows(t, { getSolverSnapshot: () => null });
  assert.deepEqual(nothing.rows.map((row) => row.id), ['flaresolverr', 'anilist', 'discord']);

  const broken = await serviceRows(t, { getSolverSnapshot: () => { throw new Error('the pool is not built yet'); } });
  assert.deepEqual(broken.rows.map((row) => row.id), ['flaresolverr', 'anilist', 'discord']);
  assert.equal(broken.warnings.length, 1);
  assert.match(broken.warnings[0], /the pool is not built yet/);
});

test('the row is read on every call, not frozen with the 20 s cache of the network probes', async (t) => {
  const real = globalThis.fetch;
  let anilistAllowed = true;
  globalThis.fetch = async (url) => {
    if (!anilistAllowed && String(url).startsWith('https://graphql.anilist.co')) throw new Error('the third-party probe should have come from the cache');
    return { ok: true, status: 200, json: async () => ({ version: '3.5.2' }) };
  };
  t.after(() => { globalThis.fetch = real; });
  let current = status();
  const service = createServicesHealthCheckService({ getFlaresolverrUrl: async () => SOLVER_URL, isFlaresolverrManaged: () => true, getSolverSnapshot: () => current });

  const first = await service.runServiceChecks();
  assert.match(first.find((row) => row.id === 'solver-pool').details, /^Ready/);

  anilistAllowed = false;
  current = status({ state: 'restarting' });
  const second = await service.runServiceChecks();
  assert.equal(second.find((row) => row.id === 'solver-pool').details, 'FlareSolverr is restarting; requests wait');
  assert.equal(second.find((row) => row.id === 'anilist').ok, true, 'the third-party row still comes from the cache');
});

// The dependency check: GET <solver>/ for the installed version, GitHub for the latest.
function solverFetch(t, { installed, latest, githubFails = false, solverUp = true } = {}) {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const text = String(url);
    seen.push(text);
    if (text.startsWith('http://127.0.0.1:8191/')) {
      if (!solverUp) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
      return { ok: true, status: 200, json: async () => ({ msg: 'ready', version: installed }) };
    }
    if (text === 'https://api.github.com/repos/FlareSolverr/FlareSolverr/releases/latest') {
      assert.equal(init.headers['User-Agent'], 'ScrollScape');
      if (githubFails) return { ok: false, status: 403, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ tag_name: `v${latest}` }) };
    }
    throw new Error('offline');
  };
  t.after(() => { globalThis.fetch = real; });
  return seen;
}

const solverRow = (getUrl = async () => SOLVER_URL) => checkFlareSolverrVersion(getUrl);

test('FlareSolverr that is not running has no version to judge and costs no request to GitHub', async (t) => {
  const seen = solverFetch(t, { solverUp: false, latest: '3.9.9' });
  const row = await solverRow();
  assert.deepEqual(row, { id: 'tool-flaresolverr', name: 'FlareSolverr', ok: true, details: 'not running (version unknown)', updatable: false });
  assert.deepEqual(seen, ['http://127.0.0.1:8191/'], 'only the local question, not one request to GitHub');

  const noUrl = await solverRow(async () => { throw new Error('no store'); });
  assert.equal(noUrl.details, 'not running (version unknown)');
});

test('an up-to-date FlareSolverr on the verified release line is reported as the latest', async (t) => {
  solverFetch(t, { installed: '3.5.2', latest: '3.5.2' });
  assert.deepEqual(await solverRow(), { id: 'tool-flaresolverr', name: 'FlareSolverr', ok: true, details: '3.5.2 (latest)', updatable: false });
});

test('an older FlareSolverr is a finding that can never be updated from here', async (t) => {
  solverFetch(t, { installed: '3.3.21', latest: '3.5.2' });
  assert.deepEqual(await solverRow(), {
    id: 'tool-flaresolverr', name: 'FlareSolverr', ok: false, error: '3.3.21 installed - latest is 3.5.2', latestVersion: '3.5.2', updatable: false,
  });
});

test('a newer release line than the one the pool was verified on is flagged for a re-test', async (t) => {
  solverFetch(t, { installed: '3.6.0', latest: '3.6.0' });
  const row = await solverRow();
  assert.equal(row.ok, true);
  assert.equal(row.details, '3.6.0 (latest; the browser session pool was verified on 3.5.x - re-test after updating)');
});

test('when GitHub cannot be reached the installed version is still shown, and it is not a failure', async (t) => {
  solverFetch(t, { installed: '3.5.2', githubFails: true });
  const row = await solverRow();
  assert.equal(row.ok, true);
  assert.equal(row.details, '3.5.2 (couldn\'t reach GitHub: GitHub HTTP 403)');
});

test('the FlareSolverr row joins the dependency check only when the service knows where FlareSolverr is', async (t) => {
  solverFetch(t, { installed: '3.5.2', latest: '3.5.2' });
  const withUrl = await createDependencyHealthCheckService({ getFlaresolverrUrl: async () => SOLVER_URL }).runDependencyChecks({ force: true });
  const row = withUrl.find((r) => r.id === 'tool-flaresolverr');
  assert.equal(row.name, 'FlareSolverr');
  assert.equal(withUrl.some((r) => r.id.startsWith('dep-tool')), false, 'never an npm id');

  const without = await createDependencyHealthCheckService().runDependencyChecks({ force: true });
  assert.equal(without.some((r) => r.id === 'tool-flaresolverr'), false);
});

test('"not running" is not kept for 12 hours: the next call asks the local FlareSolverr again and nothing else', async (t) => {
  const real = globalThis.fetch;
  const calls = { solver: 0, github: 0, other: 0 };
  let installed = null; // null: nothing answers
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.startsWith('http://127.0.0.1:8191/')) {
      calls.solver += 1;
      if (!installed) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) });
      return { ok: true, status: 200, json: async () => ({ msg: 'ready', version: installed }) };
    }
    if (text.startsWith('https://api.github.com/')) {
      calls.github += 1;
      return { ok: true, status: 200, json: async () => ({ tag_name: 'v3.5.2' }) };
    }
    calls.other += 1; // the npm registry and nodejs.org: unreachable here
    throw new Error('offline');
  };
  t.after(() => { globalThis.fetch = real; });
  const service = createDependencyHealthCheckService({ getFlaresolverrUrl: async () => SOLVER_URL });
  const rowOf = (results) => results.find((r) => r.id === 'tool-flaresolverr');

  const first = await service.runDependencyChecks();
  assert.equal(rowOf(first).details, 'not running (version unknown)');
  const others = calls.other;
  assert.ok(others > 0, 'the registries were asked once');

  const still = await service.runDependencyChecks(); // FlareSolverr is still down: asked again, still nothing to say
  assert.equal(rowOf(still).details, 'not running (version unknown)');
  assert.equal(calls.solver, 2);
  assert.equal(calls.github, 0, 'and GitHub is never asked for a FlareSolverr that is not running');
  assert.equal(calls.other, others, 'the other rows were kept');

  installed = '3.5.2'; // it came up a minute later
  const up = await service.runDependencyChecks();
  assert.equal(rowOf(up).details, '3.5.2 (latest)');
  assert.equal(calls.other, others, 'still the rows that were kept');
  assert.equal(up.length, first.length, 'the same rows, one replaced');

  const solverCalls = calls.solver;
  const githubCalls = calls.github;
  const kept = await service.runDependencyChecks(); // a row with a version keeps like the rest
  assert.equal(rowOf(kept).details, '3.5.2 (latest)');
  assert.deepEqual([calls.solver, calls.github, calls.other], [solverCalls, githubCalls, others], 'nothing is asked: the 12 h cache holds again');
});

test('the update route cannot be talked into touching that row: an id it does not know is a 400', async () => {
  await assert.rejects(updatePinnedCdnLib('tool-flaresolverr'), (err) => err.statusCode === 400);
});

test('with the REAL classifier the outdated-FlareSolverr row is an ordinary dependency finding and shows no host', () => {
  const row = { id: 'tool-flaresolverr', name: 'FlareSolverr', ok: false, error: '3.3.21 installed - latest is 3.5.2', latestVersion: '3.5.2', updatable: false };
  const [converted] = toSourceStatus([row]).results;
  assert.equal(converted.status, 'fail', 'like every other outdated dependency');
  assert.notEqual(classifySourceError(row.error).key, 'api_error');
  assert.equal(converted.updatable, false);
  assert.equal(converted.latestVersion, '3.5.2');
});

// The probes declare how patient they are around the call into the source (solver-context.js).
test('a source probe declares background patience that ends just before its own timeout gives up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // the probe's 15 s timeout never fires and never keeps the test alive
  const seen = [];
  const sources = {
    withHealthCheck: { healthCheck: async () => { seen.push(getSolverContext()); return { ok: true }; }, search: async () => ({ results: [] }) },
    searchOnly: { search: async () => { seen.push(getSolverContext()); return { results: [] }; } },
  };
  const service = createSourceHealthCheckService({
    readStore: async () => ({ installedSources: { one: { name: 'One' }, two: { name: 'Two' } } }),
    loadSourceFromFile: (id) => (id === 'one' ? sources.withHealthCheck : sources.searchOnly),
  });

  const before = Date.now();
  const results = await service.runHealthCheck();

  assert.deepEqual(results.map((r) => [r.id, r.ok]), [['one', true], ['two', true]]);
  assert.equal(seen.length, 2);
  for (const declared of seen) {
    assert.equal(declared.priority, 'background');
    assert.equal(declared.label, 'health');
    assert.equal('boundSolve' in declared, false, 'an abandoned probe goes on solving and warms the cookie');
    assert.ok(declared.deadlineAt >= before + 13_900 && declared.deadlineAt <= Date.now() + 14_000, String(declared.deadlineAt - before));
  }
});

test('a probe that throws before its first await is still reported the way it always was', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const service = createSourceHealthCheckService({
    readStore: async () => ({ installedSources: { broken: { name: 'Broken' } } }),
    loadSourceFromFile: () => ({ healthCheck: () => { throw new Error('boom'); }, search: async () => ({ results: [] }) }),
  });
  assert.deepEqual(await service.runHealthCheck(), [{ id: 'broken', name: 'Broken', ok: false, error: 'probe threw: boom' }]);
});
