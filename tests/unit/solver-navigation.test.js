'use strict';

// server/modules/network/solver/navigation.js: how long a navigation may take, when it
// may start, and what each kind of answer means for the job and for its session (the
// outcome table). The gate and the circuit are the real ones; the clock is the test's.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { POOL_ERROR_CODES, REFUSAL_KINDS } = require('../../server/modules/network/solver/errors');
const { createHostGate } = require('../../server/modules/network/solver/host-gate');
const { createCircuit } = require('../../server/modules/network/solver/circuit');
const { createCookieWatch } = require('../../server/modules/network/solver/cookie-watch');
const { createNavigation, fail } = require('../../server/modules/network/solver/navigation');

const URL_A = 'https://cf-site.example/a';

function makeEnv(config = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, { hostSpacingMs: 30, ...config });
  const state = createPoolState(cfg);
  const out = { faults: [], failures: [] };
  const ports = createPorts({
    now: () => clock.t,
    // A real timer that keeps the process alive: the test is waiting on it.
    setTimer: (fn, ms) => ({ id: setTimeout(fn, ms) }),
    clearTimer: (handle) => clearTimeout(handle.id),
    log: () => {},
    warn: () => {},
    recordError: async () => {},
    hooks: { onProxyFault: (info) => out.faults.push(info) },
  }, state);
  const hostGate = createHostGate({ cfg, state, ports });
  const circuit = createCircuit({ cfg, ports });
  const cookieWatch = createCookieWatch({ cfg, ports });
  const navigation = createNavigation({ state, cfg, ports, hostGate, cookieWatch, circuit, onTransportFailure: (err, slot) => out.failures.push([err, slot]) });
  return { clock, cfg, state, out, hostGate, cookieWatch, circuit, navigation };
}

const makeJob = (clock, over = {}) => ({
  url: URL_A, hostKey: 'cf-site.example', request: {}, boundSolve: false, deadlineAt: clock.t + 30_000, enqueuedAt: clock.t, attempt: 0, queuedMs: 0, ...over,
});
const makeSlot = (over = {}) => ({ fingerprint: 'user:abc', otherFailures: 0, uses: 4, lastOkAt: 0, ...over });
const meta = { mode: 'session', proxyMode: 'none', fingerprint: 'none', solveMs: 10 };
const answer = (kind, message = '') => ({ kind, message, httpStatus: 500 });

test('a navigation keeps its full time, or the caller\'s own, unless the caller said its page is never a challenge', () => {
  const { clock, cfg, navigation } = makeEnv();
  const start = clock.t;
  const job = makeJob(clock);
  assert.equal(navigation.maxTimeoutFor(job, start), cfg.requestMaxTimeoutMs);

  for (const own of [12_000, 60_000]) assert.equal(navigation.maxTimeoutFor(makeJob(clock, { request: { maxTimeoutMs: own } }), start), own);
  for (const bad of [0, -5, NaN, '9000', null]) assert.equal(navigation.maxTimeoutFor(makeJob(clock, { request: { maxTimeoutMs: bad } }), start), cfg.requestMaxTimeoutMs, String(bad));

  // A deadline alone never shortens it; boundSolve derives the time from the deadline, within [floor, ceiling].
  assert.equal(navigation.maxTimeoutFor(makeJob(clock, { deadlineAt: start + 2000 }), start), cfg.requestMaxTimeoutMs);
  assert.equal(navigation.maxTimeoutFor(makeJob(clock, { boundSolve: true, deadlineAt: start + 8000 }), start), 8000 - cfg.boundSolveMarginMs);
  assert.equal(navigation.maxTimeoutFor(makeJob(clock, { boundSolve: true, deadlineAt: start + 500 }), start), cfg.boundSolveMinMs, 'never below the floor');
  assert.equal(navigation.maxTimeoutFor(makeJob(clock, { boundSolve: true, deadlineAt: start + 120_000 }), start), cfg.requestMaxTimeoutMs, 'never above the ceiling');
  assert.equal(navigation.maxTimeoutFor(makeJob(clock, { boundSolve: true, deadlineAt: Infinity }), start), cfg.requestMaxTimeoutMs);
});

test('only a session is bounded by boundSolve: a one-off browser always gets the full time', () => {
  // A one-off browser launches before FlareSolverr's own clock starts. A short abort (a bounded
  // timeout plus the grace) would fire while Chrome is still starting and read as a wedged FlareSolverr.
  const { clock, cfg, navigation } = makeEnv();
  const start = clock.t;
  const bound = makeJob(clock, { boundSolve: true, deadlineAt: start + 6000 });
  assert.equal(navigation.maxTimeoutFor(bound, start), cfg.boundSolveMinMs, 'in a session it is cut to the floor');
  assert.equal(navigation.statelessTimeoutFor(bound), cfg.requestMaxTimeoutMs, 'in a one-off browser it is not');
  assert.equal(navigation.statelessTimeoutFor(makeJob(clock, { boundSolve: true, request: { maxTimeoutMs: 12_000 } })), 12_000, 'the limit the request asked for still applies');
  for (const bad of [0, -5, NaN, null]) assert.equal(navigation.statelessTimeoutFor(makeJob(clock, { request: { maxTimeoutMs: bad } })), cfg.requestMaxTimeoutMs, String(bad));
});

test('a navigation starts at once on a free site and records how long the job waited', async () => {
  const { clock, navigation } = makeEnv();
  const job = makeJob(clock, { enqueuedAt: clock.t - 250 });
  assert.equal(await navigation.startNavigation(job, () => false), clock.t);
  assert.equal(job.queuedMs, 250);
});

test('a second navigation to the same site waits out the spacing; a cancelled one never starts', async () => {
  const { clock, cfg, navigation } = makeEnv();
  const realNow = Date.now;
  clock.t = realNow(); // the waiting is real, so the clock must be too
  const first = makeJob(clock);
  const second = makeJob(clock);
  const t0 = await navigation.startNavigation(first, () => false);

  const startedAt = [];
  const waiting = navigation.startNavigation(second, () => false).then((t) => startedAt.push(t));
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(startedAt, [], 'still waiting');
  // Let the real time pass; the fake clock follows it.
  const tick = setInterval(() => { clock.t = Date.now(); }, 2);
  try {
    await waiting;
  } finally {
    clearInterval(tick);
  }
  assert.ok(startedAt[0] - t0 >= cfg.hostSpacingMs - 3, `started ${startedAt[0] - t0} ms after the first`);

  assert.equal(await navigation.startNavigation(makeJob(clock), () => true), null, 'cancelled before it started');
});

test('a navigation that is cancelled while it waits does not go ahead after all', async () => {
  const { clock, navigation } = makeEnv();
  clock.t = Date.now();
  await navigation.startNavigation(makeJob(clock), () => false);
  let cancelled = false;
  const tick = setInterval(() => { clock.t = Date.now(); }, 2);
  try {
    const waiting = navigation.startNavigation(makeJob(clock), () => cancelled);
    cancelled = true; // a restart began while it waited
    assert.equal(await waiting, null);
  } finally {
    clearInterval(tick);
  }
});

test('ok: the site is forgiven and the session counted; on the one-off lane there is no session to count', () => {
  const { clock, hostGate, cookieWatch, navigation } = makeEnv();
  hostGate.noteBlock('cf-site.example');
  assert.equal(cookieWatch.generation('cf-site.example'), 0);
  const slot = makeSlot({ otherFailures: 2 });
  const body = { status: 'ok', solution: {} };
  const outcome = navigation.navigationOutcome(makeJob(clock), slot, { kind: 'ok', body, httpStatus: 200 }, meta);
  assert.deepEqual(outcome, { type: 'ok', data: body, meta });
  assert.equal(hostGate.isBlocked('cf-site.example', clock.t), false);
  assert.deepEqual([slot.otherFailures, slot.uses, slot.lastOkAt], [0, 5, clock.t]);

  assert.equal(cookieWatch.generation('cf-site.example'), 1, 'the cookie of this answer may be new: jobs waiting for the site can try it');
  const stateless = navigation.navigationOutcome(makeJob(clock), null, { kind: 'ok', body, httpStatus: 200 }, meta);
  assert.equal(stateless.type, 'ok');
  assert.equal(cookieWatch.generation('cf-site.example'), 2, 'also from a one-off browser');
});

test('an answer that is not a page leaves the cookie generation of the site alone', () => {
  const { clock, cookieWatch, navigation } = makeEnv();
  for (const seen of [answer('blocked', 'Cloudflare has blocked this request'), answer('timeout', 'Timeout after 35.0 seconds'), answer('other', 'x'), { kind: 'http', httpStatus: 502 }]) {
    navigation.navigationOutcome(makeJob(clock), makeSlot(), seen, meta);
  }
  assert.equal(cookieWatch.generation('cf-site.example'), 0);
});

test('blocked: the first block leaves the session alone, the second in a row recycles it; the site is rate limited either way', () => {
  const { clock, state, navigation } = makeEnv();
  const blocked = answer('blocked', 'Cloudflare has blocked this request');
  const first = navigation.navigationOutcome(makeJob(clock), makeSlot(), blocked, meta);
  assert.equal(first.type, 'error');
  assert.equal(first.kind, 'blocked');
  assert.equal(first.slotAction, 'keep');
  assert.equal(first.error.code, POOL_ERROR_CODES.REJECTED);
  assert.equal(first.error.rateLimited, true);
  assert.equal(state.counters.hostBlocks, 1);

  clock.t += 61_000; // the cooldown is over, the site blocks again
  const second = navigation.navigationOutcome(makeJob(clock), makeSlot(), blocked, meta);
  assert.equal(second.slotAction, 'recycle');
});

test('blocked: a one-off browser has nothing to recycle, not even on the second block in a row where a session is recycled', () => {
  // The second block is the one that recycles, so it is the one that shows the guard: on a later block the count is past 2 anyway.
  const { clock, navigation } = makeEnv();
  const blocked = answer('blocked', 'Cloudflare has blocked this request');
  assert.equal(navigation.navigationOutcome(makeJob(clock), null, blocked, meta).slotAction, 'keep');
  clock.t += 61_000;
  assert.equal(navigation.navigationOutcome(makeJob(clock), null, blocked, meta).slotAction, 'keep');
});

test('timeout: the session is probed, not thrown away', () => {
  const { clock, navigation } = makeEnv();
  const outcome = navigation.navigationOutcome(makeJob(clock), makeSlot(), answer('timeout', 'Timeout after 35.0 seconds'), meta);
  assert.deepEqual([outcome.kind, outcome.slotAction], ['timeout', 'probe']);
});

test('driver and launch failures recycle the session, and earn one more try only with a session, a first attempt and time left', () => {
  const { clock, cfg, navigation } = makeEnv();
  const driver = answer('driver', 'invalid session id');
  const retry = (job, slot, seen = driver) => navigation.navigationOutcome(job, slot, seen, meta);

  const first = retry(makeJob(clock), makeSlot());
  assert.deepEqual([first.kind, first.slotAction, first.retry], ['driver', 'recycle', true]);
  assert.equal(retry(makeJob(clock), makeSlot(), answer('launch', 'Error starting Chrome')).retry, true);
  assert.equal(retry(makeJob(clock, { attempt: 1 }), makeSlot()).retry, false, 'a second failure is final');
  assert.equal(retry(makeJob(clock), null).retry, false, 'a one-off browser is not retried');
  assert.equal(retry(makeJob(clock, { deadlineAt: clock.t + cfg.driverRetryMinBudgetMs - 1 }), makeSlot()).retry, false, 'no time for another try');
  assert.equal(retry(makeJob(clock, { deadlineAt: clock.t + cfg.driverRetryMinBudgetMs }), makeSlot()).retry, true);
});

test('proxy: recycled, and the filter hears of it only when the proxy could not be reached at all', () => {
  const { clock, out, navigation } = makeEnv();
  const unreachable = answer('proxy', 'unknown error: net::ERR_PROXY_CONNECTION_FAILED');
  const outcome = navigation.navigationOutcome(makeJob(clock), makeSlot({ fingerprint: 'filter:5' }), unreachable, meta);
  assert.deepEqual([outcome.kind, outcome.slotAction], ['proxy', 'recycle']);
  assert.deepEqual(out.faults, [{ fingerprint: 'filter:5' }], 'the fingerprint of the session that failed');

  navigation.navigationOutcome(makeJob(clock), null, unreachable, { ...meta, fingerprint: 'user:9' });
  assert.deepEqual(out.faults[1], { fingerprint: 'user:9' }, 'a one-off browser reports its own proxy');

  navigation.navigationOutcome(makeJob(clock), makeSlot(), answer('proxy', 'net::ERR_PROXY_AUTH_UNSUPPORTED'), meta);
  assert.equal(out.faults.length, 2, 'other proxy errors are recycled but are not reported');

  const tunnel = navigation.navigationOutcome(makeJob(clock), makeSlot(), answer('proxy', 'unknown error: net::ERR_TUNNEL_CONNECTION_FAILED'), meta);
  assert.deepEqual([tunnel.kind, tunnel.slotAction], ['proxy', 'recycle'], 'a tunnel the proxy refused is the proxy\'s doing');
  assert.equal(out.faults.length, 2, 'but the proxy answered, so it is no reachability fault');
});

test('navigation and http answers change nothing about the session', () => {
  const { clock, state, navigation } = makeEnv();
  const page = navigation.navigationOutcome(makeJob(clock), makeSlot(), answer('navigation', 'net::ERR_NAME_NOT_RESOLVED'), meta);
  assert.deepEqual([page.kind, page.slotAction], ['navigation', 'keep']);
  assert.match(page.error.message, /^cf-site\.example unavailable/);

  const http = navigation.navigationOutcome(makeJob(clock), makeSlot(), { kind: 'http', httpStatus: 502 }, meta);
  assert.deepEqual([http.kind, http.slotAction], ['http', 'keep']);
  assert.equal(http.error.message, 'FlareSolverr HTTP 502');
  assert.equal(http.error.code, undefined, 'the old text, as before the pool');
  assert.equal(state.counters.httpErrors, 1);
});

test('text nobody knows: nothing is recycled for one, but three in a row on one session are', () => {
  const { clock, navigation } = makeEnv();
  const slot = makeSlot();
  const unknown = answer('other', 'something new');
  const actions = [1, 2, 3].map(() => navigation.navigationOutcome(makeJob(clock), slot, unknown, meta).slotAction);
  assert.deepEqual(actions, ['keep', 'keep', 'recycle']);
  assert.equal(slot.otherFailures, 0, 'the count starts over');
  assert.equal(navigation.navigationOutcome(makeJob(clock), null, unknown, meta).slotAction, 'keep');
  const err = navigation.navigationOutcome(makeJob(clock), slot, unknown, meta).error;
  assert.equal(err.kind, 'other');
  assert.match(err.message, /^FlareSolverr failed: something new$/);
});

test('a request that got no answer is reported with the very same error, and the session is only suspected after our own abort', () => {
  const { clock, out, navigation } = makeEnv();
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const refused = new TypeError('fetch failed');
  const slot = makeSlot();
  const a = navigation.transportOutcome(timeout, slot);
  const b = navigation.transportOutcome(refused, slot);
  const c = navigation.transportOutcome(timeout, null);
  assert.equal(a.error, timeout);
  assert.equal(b.error, refused);
  assert.deepEqual([a.slotAction, b.slotAction, c.slotAction], ['suspect', 'invalidate', 'invalidate']);
  assert.deepEqual(out.failures, [[timeout, slot], [refused, slot], [timeout, null]]);
  assert.equal(a.kind, 'transport');
  void clock;
});

test('fail builds the error outcome the runners hand to the slot release', () => {
  const err = new Error('x');
  assert.deepEqual(fail(err, 'internal', 'keep'), { type: 'error', error: err, kind: 'internal', slotAction: 'keep' });
  assert.deepEqual(fail(err, 'driver', 'recycle', { retry: true }), { type: 'error', error: err, kind: 'driver', slotAction: 'recycle', retry: true });
});

test('releaseStart gives the site its spacing back: a job that failed before it navigated touched nothing', () => {
  const { clock, hostGate, navigation } = makeEnv({ hostSpacingMs: 1500 });
  hostGate.reserve('cf-site.example', clock.t);
  assert.equal(hostGate.nextStartAt('cf-site.example'), clock.t + 1500, 'picked: the site is reserved');
  navigation.releaseStart(makeJob(clock));
  assert.equal(hostGate.nextStartAt('cf-site.example'), 0, 'the next job for the site does not wait for a navigation that never happened');
});

// ── A cooldown that opens after the job was picked ──────────────────────────

test('a navigation does not start into a cooldown that opened after the job was picked: the job is refused and the spacing goes back', async () => {
  const { clock, hostGate, navigation } = makeEnv({ hostSpacingMs: 1500 });
  hostGate.reserve('cf-site.example', clock.t); // the job was picked
  hostGate.noteBlock('cf-site.example'); // and then another call to the site was answered "blocked"

  const outcome = await navigation.startNavigation(makeJob(clock), () => false);
  assert.equal(outcome.type, 'error');
  assert.equal(outcome.error.code, POOL_ERROR_CODES.HOST_COOLDOWN);
  assert.equal(outcome.error.rateLimited, true);
  assert.deepEqual([outcome.kind, outcome.slotAction], [REFUSAL_KINDS[POOL_ERROR_CODES.HOST_COOLDOWN], 'keep'], 'a healthy session is kept');
  assert.equal(hostGate.nextStartAt('cf-site.example'), 0, 'the site was not touched: nobody waits for a navigation that never happened');

  clock.t += 61_000;
  assert.equal(await navigation.startNavigation(makeJob(clock), () => false), clock.t, 'once the cooldown is over it starts as usual');
});

test('a navigation that waits out the spacing looks at the cooldown again when it wakes up', async () => {
  const { clock, hostGate, navigation } = makeEnv();
  clock.t = Date.now(); // the waiting is real, so the clock must be too
  await navigation.startNavigation(makeJob(clock), () => false);
  const waiting = navigation.startNavigation(makeJob(clock), () => false);
  hostGate.noteBlock('cf-site.example'); // while it waits
  const tick = setInterval(() => { clock.t = Date.now(); }, 2);
  try {
    const outcome = await waiting;
    assert.equal(outcome.error.code, POOL_ERROR_CODES.HOST_COOLDOWN);
  } finally {
    clearInterval(tick);
  }
});
