'use strict';

// The "Browser sessions" row of System Health sits next to FlareSolverr's own. When FlareSolverr is off (by choice,
// or not installed) or refusing connections, the row must not say "Ready" or "retrying shortly" while its neighbour
// says "Off": it says the browser is waiting for FlareSolverr. Fed with statuses and with a real pool; no network,
// no file of the data folder (the lifecycle module is replaced while the health modules load, because the real one
// reads data/setup.json when it is loaded).

const test = require('node:test');
const assert = require('node:assert/strict');

const LIFECYCLE_PATH = require.resolve('../../server/modules/network/flaresolverr-lifecycle');
const lifecycleBefore = require.cache[LIFECYCLE_PATH];
require.cache[LIFECYCLE_PATH] = {
  id: LIFECYCLE_PATH, filename: LIFECYCLE_PATH, loaded: true, exports: { isManaged: () => false },
};
const { createServicesHealthCheckService, checkSolverPool } = require('../../server/modules/system-health/services-health');
const { toSourceStatus, classifySourceError } = require('../../server/modules/system-health/service');
const { createSolverPool } = require('../../server/modules/network/solver-pool');
if (lifecycleBefore) require.cache[LIFECYCLE_PATH] = lifecycleBefore; else delete require.cache[LIFECYCLE_PATH];

const SOLVER_URL = 'http://127.0.0.1:8191/v1';
const OFF_TEXT = 'Waiting for FlareSolverr (it is off)';
const UNREACHABLE_TEXT = 'Waiting for FlareSolverr (it is not reachable)';

function status(overrides = {}) {
  return {
    enabled: true,
    disabledBy: null,
    state: 'idle',
    sessions: [],
    queued: { interactive: 0, background: 0 },
    inFlight: 0,
    counters: {},
    cooldowns: [],
    circuit: { open: false, secondsLeft: 0 },
    lastError: null,
    solver: null,
    ...overrides,
  };
}

const session = (overrides = {}) => ({ idleMs: 180_000, ageMs: 540_000, uses: 41, busy: false, proxy: 'none', ...overrides });

test('FlareSolverr switched off: whatever the pool otherwise looks like, the row says it is waiting, and it is not a fault', () => {
  for (const state of ['idle', 'active', 'down']) {
    const row = checkSolverPool(status({ state, solver: 'off', sessions: state === 'active' ? [session()] : [] }));
    assert.deepEqual(row, { id: 'solver-pool', name: 'Browser sessions', ok: true, error: '', details: OFF_TEXT }, state);
  }
});

test('FlareSolverr refusing connections: the row says it is not reachable, and it is not a fault either', () => {
  for (const state of ['idle', 'active', 'down']) {
    const row = checkSolverPool(status({ state, solver: 'refused', sessions: state === 'active' ? [session()] : [] }));
    assert.deepEqual(row, { id: 'solver-pool', name: 'Browser sessions', ok: true, error: '', details: UNREACHABLE_TEXT }, state);
  }
});

test('what is not about FlareSolverr being away keeps its words: the pool off, a restart, a circuit that opened', () => {
  assert.equal(checkSolverPool(status({ enabled: false, state: 'disabled', disabledBy: 'setting', solver: 'off' })).details, 'Off (not switched on in Settings)');
  assert.equal(checkSolverPool(status({ state: 'restarting', solver: 'refused' })).details, 'FlareSolverr is restarting; requests wait');
  const open = checkSolverPool(status({ state: 'circuit-open', circuit: { open: true, secondsLeft: 100 }, solver: null }));
  assert.equal(open.severity, 'warning');
  assert.equal(checkSolverPool(status({ solver: null })).details, 'Ready (a browser opens when a protected site is first needed)');
  assert.equal(checkSolverPool(status({ state: 'down' })).details, 'FlareSolverr did not answer; retrying shortly', 'a wedge is still a wedge');
});

test('a status from before the pool knew about FlareSolverr (no "solver" field) reads as no news', () => {
  const old = status();
  delete old.solver;
  assert.equal(checkSolverPool(old).details, 'Ready (a browser opens when a protected site is first needed)');
});

test('the waiting rows name no site, address, path or session, and the real classifier never files them as an error type', () => {
  for (const solver of ['off', 'refused']) {
    const row = checkSolverPool(status({ solver, cooldowns: [{ host: 'cf-site.example', secondsLeft: 9 }], lastError: { at: '2026-10-26T10:00:00.000Z', kind: 'transport' } }));
    const shown = JSON.stringify(row);
    for (const leak of ['cf-site', 'example', 'http', '127.0.0.1', '8191', 'ss-', 'cookie', 'proxy']) assert.ok(!shown.includes(leak), `${solver}: ${leak}`);
    // An ok row is never classified, but the words must not be the kind the classifier would take for a fault if they ever were.
    const classified = classifySourceError(row.details);
    assert.notEqual(classified.key, 'api_error', row.details);
    assert.notEqual(classified.key, 'site_maintenance', row.details);
    const [converted] = toSourceStatus([row]).results;
    assert.equal(converted.status, 'pass');
    assert.equal(converted.details, row.details);
  }
});

// The services check, with FlareSolverr's own probe scripted: `reply` is what GET <solver>/ does.
async function rowsWith(t, { reply, snapshot, managed = false, solverUrl = SOLVER_URL }) {
  const real = globalThis.fetch;
  const solverOrigin = new URL(solverUrl).origin + '/';
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://graphql.anilist.co')) return { ok: true, status: 200, json: async () => ({ data: {} }) };
    if (String(url).startsWith(solverOrigin)) return reply();
    throw new Error(`unexpected request to ${url}`);
  };
  t.after(() => { globalThis.fetch = real; });
  const service = createServicesHealthCheckService({ getFlaresolverrUrl: async () => solverUrl, isFlaresolverrManaged: () => managed, getSolverSnapshot: () => snapshot });
  const rows = await service.runServiceChecks();
  return { flare: rows.find((row) => row.id === 'flaresolverr'), pool: rows.find((row) => row.id === 'solver-pool') };
}

const refusedFetch = () => {
  throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
};

test('next to a FlareSolverr row that says "Off", the pool row never says "Ready", even before any call told the pool anything', async (t) => {
  const { flare, pool } = await rowsWith(t, { reply: refusedFetch, snapshot: status() });
  assert.match(flare.details, /^Off \(/);
  assert.equal(pool.details, OFF_TEXT);
  assert.equal(pool.ok, true);
});

test('next to a FlareSolverr row that is Reachable, an old memory of a refusal is not repeated', async (t) => {
  const reachable = () => ({ ok: true, status: 200, json: async () => ({ version: '3.5.2' }) });
  const { flare, pool } = await rowsWith(t, { reply: reachable, snapshot: status({ solver: 'refused' }) });
  assert.match(flare.details, /^Reachable/);
  assert.equal(pool.details, 'Ready (a browser opens when a protected site is first needed)', 'FlareSolverr answers: the pool\'s memory of the time it did not is stale');
});

test('a FlareSolverr that should be up but is not shows the failure on its own row, and the pool row waits for it', async (t) => {
  const { flare, pool } = await rowsWith(t, { reply: refusedFetch, snapshot: status({ solver: 'refused' }), managed: true });
  assert.equal(flare.ok, false);
  assert.equal(pool.details, UNREACHABLE_TEXT);
  assert.equal(pool.ok, true);
});

test('the rows of a real pool: off by choice, refused, and answering again', async (t) => {
  let alive = false;
  let offByChoice = true;
  const pool = createSolverPool({
    post: async (url, payload) => {
      if (!alive) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      return { httpStatus: 200, body: payload.cmd === 'request.get' ? { status: 'ok', solution: { response: '<html></html>', cookies: [], userAgent: 'ua' } } : { status: 'ok' } };
    },
    hooks: { isOffByChoice: () => offByChoice },
    log: () => {},
    warn: () => {},
    recordError: async () => {},
  });
  t.after(() => pool.shutdown({ timeoutMs: 50 }));
  pool.applySettings({ enabled: true, disabledBy: null, maxSessions: 1, idleMinutes: 10 });

  assert.equal(checkSolverPool(pool.getStatus()).details, OFF_TEXT, 'switched off on purpose, before any call');
  offByChoice = false;
  assert.match(checkSolverPool(pool.getStatus()).details, /^Ready/);

  await pool.run({ url: 'https://cf-site.example/a', solverUrl: SOLVER_URL }).promise.then(() => assert.fail('expected a refusal'), () => {});
  assert.equal(checkSolverPool(pool.getStatus()).details, UNREACHABLE_TEXT);

  alive = true;
  await pool.run({ url: 'https://other-site.example/b', solverUrl: SOLVER_URL }).promise;
  assert.notEqual(checkSolverPool(pool.getStatus()).details, UNREACHABLE_TEXT, 'it answered');
});

// "Off" is the app's own choice about the FlareSolverr it would start on this computer. A copy the user runs elsewhere
// (a NAS) that is down shows a real failure on its row, and the pool row beside it must not call that "off".
test('the pool\'s own "off" does not stand next to a real failure of FlareSolverr', () => {
  const failed = { id: 'flaresolverr', name: 'FlareSolverr', ok: false, error: 'fetch failed' };
  for (const state of ['idle', 'active', 'down']) {
    const row = checkSolverPool(status({ state, solver: 'off', sessions: state === 'active' ? [session()] : [] }), failed);
    assert.equal(row.details, UNREACHABLE_TEXT, state);
    assert.equal(row.ok, true, state);
  }
  // Nothing changes without such a row: no neighbour at all, one that is Off, one that answers.
  assert.equal(checkSolverPool(status({ solver: 'off' })).details, OFF_TEXT);
  assert.equal(checkSolverPool(status({ solver: 'off' }), { ...failed, ok: true, error: '', details: 'Off (not installed, or you chose not to use it)' }).details, OFF_TEXT);
  assert.match(checkSolverPool(status({ solver: 'off' }), { ...failed, ok: true, error: '', details: 'Reachable v3.5.2' }).details, /^Ready/);
});

test('answered "skip" at the first run, then pointed at a NAS copy that is down: the two rows agree', async (t) => {
  const { flare, pool } = await rowsWith(t, { reply: refusedFetch, snapshot: status({ solver: 'off' }), solverUrl: 'http://nas.lan:8191/v1' });
  assert.equal(flare.ok, false, 'a copy on another host is the user\'s to keep up: a real failure');
  assert.equal(pool.details, UNREACHABLE_TEXT);
  assert.notEqual(pool.details, OFF_TEXT);
});
