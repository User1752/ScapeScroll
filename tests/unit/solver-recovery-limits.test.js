'use strict';

// The three limits that keep a FlareSolverr that hangs from turning into a loop: the brake on the restarts the app starts by itself
// (flaresolverr-restart-brake.js), the memory of the site that keeps leaving it without an answer (solver/wedge-memory.js, used by
// solver-call.js) and the quiet stretch during a live Test (common/quiet-mode.js). All against fake clocks and fakes: nothing here
// touches a network, a process or a file. The brake's use inside the lifecycle is tested in flaresolverr-lifecycle.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRestartBrake } = require('../../server/modules/network/flaresolverr-restart-brake');
const { createWedgeMemory, SITE_PAUSED_CODE } = require('../../server/modules/network/solver/wedge-memory');
const { createQuietMode, beginQuiet, isQuiet } = require('../../server/modules/common/quiet-mode');
const { createSolverCaller } = require('../../server/modules/network/solver-call');
const { createSingleFlight } = require('../../server/modules/network/single-flight');
const { getSolverContext } = require('../../server/modules/network/solver-context');
const { createFlareSolverrCheck } = require('../../server/modules/system-health/solver-rows');
const { createSourceHealthCheckService } = require('../../server/modules/sources/health-check');
const { createAnimeHealthCheckService } = require('../../server/modules/system-health/anime-health');
const { RECOVERY_BRAKE, WEDGE_PAUSE, MESSAGES } = require('../../server/config/solver');

const MINUTE = 60_000;

function fakeClock(start = 1_000_000) {
  const clock = { now: start, read: () => clock.now, advance: (ms) => { clock.now += ms; } };
  return clock;
}

// ── The brake ────────────────────────────────────────────────────────────────

test('the brake lets the first recovery through and holds a second one that comes right behind it', () => {
  const clock = fakeClock();
  const brake = createRestartBrake({ now: clock.read });
  assert.deepEqual(brake.check(), { allowed: true, why: null, retryInMs: 0 });
  brake.record();
  clock.advance(5_000);
  const held = brake.check();
  assert.equal(held.allowed, false);
  assert.equal(held.why, 'gap');
  assert.equal(held.retryInMs, RECOVERY_BRAKE.minGapMs - 5_000);
  clock.advance(RECOVERY_BRAKE.minGapMs);
  assert.equal(brake.check().allowed, true);
});

test('the brake allows maxPerWindow recoveries in the window and says when the oldest ages out', () => {
  const clock = fakeClock();
  const brake = createRestartBrake({ now: clock.read });
  const first = clock.now;
  for (let i = 0; i < RECOVERY_BRAKE.maxPerWindow; i += 1) {
    assert.equal(brake.check().allowed, true, `recovery ${i + 1}`);
    brake.record();
    clock.advance(RECOVERY_BRAKE.minGapMs);
  }
  const held = brake.check();
  assert.equal(held.allowed, false);
  assert.equal(held.why, 'limit');
  assert.equal(held.retryInMs, first + RECOVERY_BRAKE.windowMs - clock.now);
  clock.advance(held.retryInMs);
  assert.equal(brake.check().allowed, true, 'the oldest has aged out');
});

test('the brake status is counts and times only, and paused only while the limit (not the gap) holds', () => {
  const clock = fakeClock();
  const brake = createRestartBrake({ now: clock.read });
  assert.deepEqual(brake.status(), { restarts: 0, windowMinutes: 15, paused: false, retryInSeconds: 0 });
  brake.record();
  assert.equal(brake.status().paused, false, 'right behind a restart is the gap, which is not a pause');
  for (let i = 1; i < RECOVERY_BRAKE.maxPerWindow; i += 1) { clock.advance(RECOVERY_BRAKE.minGapMs); brake.record(); }
  const status = brake.status();
  assert.equal(status.paused, true);
  assert.equal(status.restarts, RECOVERY_BRAKE.maxPerWindow);
  assert.ok(status.retryInSeconds > 0);
  assert.deepEqual(Object.keys(status).sort(), ['paused', 'restarts', 'retryInSeconds', 'windowMinutes']);
  brake.reset();
  assert.equal(brake.status().restarts, 0);
});

// ── The memory of a site that wedges the solver ─────────────────────────────

test('a site is paused on its second stall within the window, and a call to it is refused with a text that names no site', () => {
  const clock = fakeClock();
  const logs = [];
  const memory = createWedgeMemory({ now: clock.read, log: (m) => logs.push(m) });
  assert.equal(memory.noteStall('cf-site.example'), false, 'one stall is not yet a pattern');
  assert.equal(memory.pausedFor('cf-site.example'), 0);
  clock.advance(5 * MINUTE);
  assert.equal(memory.noteStall('cf-site.example'), true, 'the second one is');
  assert.equal(memory.pausedFor('cf-site.example'), WEDGE_PAUSE.pauseMs);
  assert.equal(memory.status().paused, 1);
  assert.equal(logs.length, 1);
  const err = memory.error();
  assert.equal(err.code, SITE_PAUSED_CODE);
  assert.equal(err.rateLimited, true, 'fetchText does not retry it');
  assert.equal(err.message, MESSAGES.sitePaused);
  clock.advance(WEDGE_PAUSE.pauseMs);
  assert.equal(memory.pausedFor('cf-site.example'), 0, 'the pause ends by itself');
  assert.equal(memory.status().paused, 0);
});

test('two stalls too far apart are two separate events, and a page that came back forgives the site', () => {
  const clock = fakeClock();
  const memory = createWedgeMemory({ now: clock.read });
  memory.noteStall('cf-site.example');
  clock.advance(WEDGE_PAUSE.windowMs + 1);
  assert.equal(memory.noteStall('cf-site.example'), false, 'the first one has left the window');

  memory.noteAnswered('cf-site.example');
  clock.advance(MINUTE);
  assert.equal(memory.noteStall('cf-site.example'), false, 'answered pages wipe the count');
  assert.equal(memory.pausedFor('cf-site.example'), 0);
});

test('a stall right after another site\'s is the same wedge seen twice, not evidence against the second site', () => {
  const clock = fakeClock();
  const memory = createWedgeMemory({ now: clock.read });
  memory.noteStall('culprit.example');
  clock.advance(5_000);
  assert.equal(memory.noteStall('bystander.example'), false);
  clock.advance(WEDGE_PAUSE.collateralMs + 1_000);
  assert.equal(memory.noteStall('bystander.example'), false, 'it was never counted, so this is its first');
  clock.advance(MINUTE);
  assert.equal(memory.noteStall('culprit.example'), true, 'the site that really wedges it still reaches the second stall');
  assert.equal(memory.pausedFor('bystander.example'), 0);
});

// ── The caller uses it ───────────────────────────────────────────────────────

function timeoutError() {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'TimeoutError';
  return err;
}

function callerWith(answers, wedges) {
  const spy = { used: 0, recovered: 0, runs: 0 };
  const pool = {
    run() {
      spy.runs += 1;
      const answer = answers.shift();
      const promise = answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      promise.catch(() => {});
      return { promise, promote() {}, extendDeadline() {} };
    },
  };
  const call = createSolverCaller({
    pool,
    flights: createSingleFlight(),
    assertPublicUrl: async () => {},
    getSolverContext,
    noteUsed: () => { spy.used += 1; },
    recoverFromHang: () => { spy.recovered += 1; },
    saveDomainSession: () => {},
    getDomainSession: () => null,
    safeFetch: () => assert.fail('no plain request was expected'),
    isChromeErrorPage: () => false,
    isBotChallengePage: () => false,
    needsChallengeSolve: () => false,
    siteLabel: (url) => new URL(url).hostname,
    userAgent: 'default-UA',
    ...(wedges ? { wedges } : {}),
  });
  return { call, spy };
}

const PAGE = { data: { status: 'ok', solution: { response: '<html>ok</html>', cookies: [], userAgent: 'ua' } }, mode: 'session' };
const SOLVER = 'http://127.0.0.1:8191/v1';

test('a site that leaves the solver without an answer twice is refused at once the third time, without touching the solver', async () => {
  const memory = createWedgeMemory({ now: fakeClock().read });
  const { call, spy } = callerWith([timeoutError(), timeoutError(), PAGE], memory);
  await assert.rejects(call('https://cf-site.example/a', SOLVER), { name: 'TimeoutError' });
  await assert.rejects(call('https://cf-site.example/b', SOLVER), { name: 'TimeoutError' });
  assert.equal(spy.recovered, 2, 'each stall still asks for the recovery (the brake decides, not this layer)');
  const runsBefore = spy.runs;
  const usedBefore = spy.used;
  await assert.rejects(call('https://cf-site.example/c', SOLVER), { code: SITE_PAUSED_CODE });
  assert.equal(spy.runs, runsBefore, 'the pool was not asked');
  assert.equal(spy.used, usedBefore, 'and the refusal does not count as use of FlareSolverr, so it keeps its idle clock');
  const other = await call('https://other-site.example/a', SOLVER);
  assert.equal(other, '<html>ok</html>', 'another site is not affected');
});

test('a refused connection is not a stall: nothing was hanging', async () => {
  const memory = createWedgeMemory({ now: fakeClock().read });
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const { call } = callerWith([refused, refused, refused], memory);
  for (let i = 0; i < 3; i += 1) await assert.rejects(call(`https://cf-site.example/${i}`, SOLVER));
  assert.equal(memory.pausedFor('cf-site.example'), 0);
});

test('a caller built without the memory behaves exactly as before: nothing is ever paused', async () => {
  const { call } = callerWith([timeoutError(), timeoutError(), PAGE]);
  await assert.rejects(call('https://cf-site.example/a', SOLVER), { name: 'TimeoutError' });
  await assert.rejects(call('https://cf-site.example/b', SOLVER), { name: 'TimeoutError' });
  assert.equal(await call('https://cf-site.example/c', SOLVER), '<html>ok</html>');
});

// ── The quiet stretch ────────────────────────────────────────────────────────

test('quiet lasts from begin to end, nests, and ending twice does not end somebody else\'s stretch', () => {
  const clock = fakeClock();
  const quiet = createQuietMode({ now: clock.read });
  assert.equal(quiet.isQuiet(), false);
  const endA = quiet.begin();
  const endB = quiet.begin();
  assert.equal(quiet.isQuiet(), true);
  endA();
  endA();
  assert.equal(quiet.isQuiet(), true, 'B is still running');
  endB();
  assert.equal(quiet.isQuiet(), false);
});

test('a stretch whose end is never called expires by itself, so a crash cannot silence the probes for good', () => {
  const clock = fakeClock();
  const quiet = createQuietMode({ now: clock.read, maxMs: 6 * MINUTE });
  quiet.begin();
  clock.advance(6 * MINUTE - 1);
  assert.equal(quiet.isQuiet(), true);
  clock.advance(1);
  assert.equal(quiet.isQuiet(), false);
});

test('while the app is quiet the source probes call no site and answer from what they last knew', async () => {
  let storeReads = 0;
  const service = createSourceHealthCheckService({ readStore: () => { storeReads += 1; return {}; }, loadSourceFromFile: () => assert.fail('no source was to be loaded') });
  const end = beginQuiet();
  try {
    assert.equal(isQuiet(), true);
    assert.deepEqual(await service.runHealthCheck(), [], 'nothing known yet: an empty list, not a call to every site');
    assert.equal(storeReads, 0);
  } finally {
    end();
  }
  assert.equal(isQuiet(), false);
});

test('the anime probes stand aside too', async () => {
  const service = createAnimeHealthCheckService();
  const end = beginQuiet();
  try {
    assert.deepEqual(await service.runHealthCheck(), []);
  } finally {
    end();
  }
});

// ── System Health ───────────────────────────────────────────────────────────

function reachableFetch(t) {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ version: '3.5.2' }) }));
}

function checkWith(getRecoveryStatus) {
  return createFlareSolverrCheck({ getFlaresolverrUrl: async () => 'http://127.0.0.1:8191/v1', isFlaresolverrManaged: () => true, timeoutMs: 1000, getRecoveryStatus });
}

test('the FlareSolverr row says nothing extra until the app has had to restart it', async (t) => {
  reachableFetch(t);
  assert.deepEqual(await checkWith(() => ({ restarts: 0, windowMinutes: 15, paused: false, retryInSeconds: 0 }))(), { id: 'flaresolverr', name: 'FlareSolverr', ok: true, error: '', details: 'Reachable v3.5.2' });
  assert.equal((await checkWith(() => null)()).details, 'Reachable v3.5.2');
  assert.equal((await checkWith(() => { throw new Error('boom'); })()).details, 'Reachable v3.5.2', 'a failing status never fails the row');
});

test('the row counts the restarts, and turns into a warning while the brake has paused them', async (t) => {
  reachableFetch(t);
  const counted = await checkWith(() => ({ restarts: 2, windowMinutes: 15, paused: false, retryInSeconds: 0 }))();
  assert.equal(counted.ok, true);
  assert.equal(counted.details, 'Reachable v3.5.2, restarted 2 times by the app in the last 15 min');

  const paused = await checkWith(() => ({ restarts: 3, windowMinutes: 15, paused: true, retryInSeconds: 400 }))();
  assert.equal(paused.ok, false);
  assert.equal(paused.severity, 'warning');
  assert.match(paused.error, /keeps hanging.*restarted 3 times.*paused for 7 more min/);
});
