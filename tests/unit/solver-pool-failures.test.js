'use strict';

// The solver pool against a fake FlareSolverr 3.5.2 on loopback (no browser, no network):
// a driver that dies, a launch that conflicts, a FlareSolverr that does not answer or answers
// oddly, and repeated blocks.
// The rig (tests/helpers/solver-pool-rig.js) checks the session discipline - no request for an
// id that was not confirmed or is being destroyed - when every test ends.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGES: FAKE_TEXT } = require('../helpers/fake-flaresolverr');
const { A, B, until, makeClock, sequence, creates, destroys, captureFetchErrors, holdablePost, rig, rejectionOf } = require('../helpers/solver-pool-rig');
const { POOL } = require('../../server/config/solver');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver-pool');
const { SOLVER_SESSION_FAILED } = require('../../server/modules/errors/error-codes');

// ── Driver failures, launch conflicts, session creation ─────────────────────

test('a launch that keeps failing sends jobs to one-off browsers, and three of them open the circuit', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock, config: { circuit: { failures: 3, windowMs: 60_000, openMs: 20_000 } } });
  const rule = r.fake.command('sessions.create', { errorMessage: 'Boom while starting' });

  for (let i = 1; i <= 3; i += 1) {
    const result = await r.run(A, `/p${i}`).promise;
    assert.equal(result.mode, 'stateless', 'the job still gets its page');
    assert.match(result.data.solution.response, new RegExp(`/p${i}`));
  }
  assert.equal(creates(r.fake).length, 3);
  assert.equal(r.pool.getStatus().state, 'circuit-open');
  assert.equal(r.pool.getStatus().circuit.open, true);
  assert.equal(r.events.errors.filter((e) => e.code === SOLVER_SESSION_FAILED).length, 1, 'one entry per opening');
  assert.deepEqual(r.events.errors[0].details, { kind: 'create' });
  assert.equal(r.events.warns.filter((m) => /kept failing/.test(m)).length, 1);

  const open = await r.run(A, '/open').promise;
  assert.equal(open.mode, 'stateless');
  assert.equal(creates(r.fake).length, 3, 'no session is attempted while the circuit is open');

  await clock.advance(20_000);
  rule.remove();
  assert.equal(r.pool.getStatus().state, 'idle');
  const probe = await r.run(A, '/probe').promise;
  assert.equal(probe.mode, 'session', 'the first job after the window is the closing probe');
  assert.equal(r.pool.getStatus().circuit.open, false);
  assert.ok(r.events.logs.some((m) => /circuit is closed/.test(m)));
  await r.settled();
});

test('a probe that fails reopens the circuit at once', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock, config: { circuit: { failures: 2, windowMs: 60_000, openMs: 10_000 } } });
  r.fake.command('sessions.create', { errorMessage: 'Boom while starting' });
  await r.run(A, '/1').promise;
  await r.run(A, '/2').promise;
  assert.equal(r.pool.getStatus().circuit.open, true);
  await clock.advance(10_000);
  const probe = await r.run(A, '/probe').promise;
  assert.equal(probe.mode, 'stateless');
  assert.equal(r.pool.getStatus().circuit.open, true, 'one failure after the window is enough');
  assert.equal(r.events.errors.length, 2);
});

test('launches never overlap: a session being created and a one-off browser wait for each other', async (t) => {
  const r = await rig(t, { settings: { maxSessions: 3 }, fakeOptions: { launchMs: 30 }, config: { hostSpacingMs: 0 } });
  const jobs = [
    r.run(A, '/a').promise,
    r.run(B, '/b').promise,
    r.run('https://third-site.example', '/c').promise,
    r.pool.run({ url: `${A}/with-cookies`, solverUrl: r.solverUrl, cookies: [{ name: 'auth', value: 'x' }] }).promise,
  ];
  await Promise.all(jobs);
  await r.settled();
  assert.equal(r.fake.launches, 4);
  assert.equal(r.fake.launchOverlaps, 0);
});

test('a FlareSolverr without sessions: stateless, and the rest of the epoch does not ask again', async (t) => {
  const r = await rig(t);
  r.fake.command('sessions.create', { errorMessage: FAKE_TEXT.invalidCmd('sessions.create') });
  assert.equal((await r.run(A, '/one').promise).mode, 'stateless');
  assert.equal((await r.run(A, '/two').promise).mode, 'stateless');
  assert.equal(creates(r.fake).length, 1);
});

// ── When FlareSolverr does not answer ────────────────────────────────────────

// A refused connection is not a wedge: nothing is listening, so each call finds that out for itself at once and the
// pool opens no fail-fast window (solver-unreachable.test.js has the whole path through the caller).
test('a refused connection reaches the caller as the very same error, every time, and the pool neither fails fast nor piles on', async (t) => {
  const thrown = captureFetchErrors(t);
  const r = await rig(t);
  await r.run(A, '/one').promise;
  await r.settled();
  await r.fake.switchOff();

  for (const path of ['/two', '/three']) {
    const attempts = thrown.length;
    const failure = await rejectionOf(r.run(A, path));
    assert.equal(failure, thrown[thrown.length - 1], 'the error object fetch threw, untouched');
    assert.equal(failure.cause.code, 'ECONNREFUSED');
    assert.ok(thrown.length > attempts, 'FlareSolverr was asked again: a refused connection costs nothing and it may be up by now');
  }
  assert.equal(r.events.recovered, 0, 'recovering the solver is the caller\'s job for errors that reach it');
  assert.notEqual(r.pool.getStatus().state, 'down');
  assert.equal(r.pool.getStatus().solver, 'refused');

  r.fake.switchOn();
  r.fake.clearLog();
  const again = await r.run(A, '/four').promise;
  await r.settled();
  assert.equal(again.mode, 'session');
  assert.deepEqual(sequence(r.fake), ['list', 'create', 'get /four', 'blank'], 'the old id is verified, found gone, and replaced');
  assert.equal(r.pool.getStatus().solver, null, 'it answered');
});

// The pool's time is the test's, and only the wedged job has a short limit: every other navigation keeps the 35 s
// default, so a loaded machine cannot abort a healthy one.
test('our own abort is the original TimeoutError, does not recover the solver itself, and the session is not reused as it is', async (t) => {
  const thrown = captureFetchErrors(t);
  const clock = makeClock();
  const r = await rig(t, { clock, config: { requestAbortGraceMs: 40 } });
  await r.run(A, '/warm').promise;
  await r.settled();
  const oldId = creates(r.fake)[0].session;

  r.fake.page(`${A}/wedged`, { hang: true });
  const failure = await rejectionOf(r.run(A, '/wedged', { maxTimeoutMs: 40 }));
  assert.equal(failure.name, 'TimeoutError');
  assert.equal(failure, thrown[thrown.length - 1]);
  assert.equal(r.events.recovered, 0);
  assert.equal(r.pool.getStatus().state, 'down');
  const refused = await rejectionOf(r.run(A, '/queued-meanwhile'));
  assert.equal(refused.code, POOL_ERROR_CODES.DOWN);
  assert.ok(!['TimeoutError', 'AbortError'].includes(refused.name));

  await clock.advance(POOL.downAfterWedgeMs);
  r.fake.clearRules();
  r.fake.clearLog();
  const after = await r.run(A, '/after').promise;
  await r.settled();
  assert.equal(after.mode, 'session');
  assert.deepEqual(sequence(r.fake), ['destroy', 'create', 'get /after', 'blank'], 'the browser that may still be mid-navigation is replaced, not reused');
  assert.equal(destroys(r.fake)[0].session, oldId);
});

test('any other transport failure only makes the pool check its session before the next use', async (t) => {
  const r = await rig(t);
  await r.run(A, '/warm').promise;
  await r.settled();
  r.fake.page(`${A}/reset`, { drop: true, times: 1 });
  const failure = await rejectionOf(r.run(A, '/reset'));
  assert.ok(failure instanceof Error);
  assert.notEqual(r.pool.getStatus().state, 'down', 'one reset socket must not fail every job for a while');
  await r.settled();
  r.fake.clearLog();
  await r.run(A, '/next').promise;
  await r.settled();
  assert.deepEqual(sequence(r.fake), ['list', 'get /next', 'blank'], 'verified, found, kept');
});

// ── Odd answers to the control commands ──────────────────────────────────────

test('a session list that fails is read as "cannot tell": the old session is closed and a new one opened', async (t) => {
  const r = await rig(t, { config: { verifySkipWithinMs: 0 } });
  await r.run(A, '/one').promise;
  await r.settled();
  r.fake.command('sessions.list', { errorMessage: 'cannot list right now', times: 1 });
  r.fake.clearLog();
  const second = await r.run(A, '/two').promise;
  await r.settled();
  assert.equal(second.mode, 'session');
  assert.deepEqual(sequence(r.fake), ['list', 'destroy', 'create', 'get /two', 'blank']);
});

test('a create that is answered with "already exists" is not trusted: that id is removed and the job runs without a session', async (t) => {
  let swallowed = false;
  const post = async (url, payload, { timeoutMs }) => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.json();
    if (payload.cmd === 'sessions.create' && !swallowed) {
      swallowed = true;
      return { httpStatus: 200, body: { ...body, message: 'Session already exists.' } };
    }
    return { httpStatus: res.status, body };
  };
  const r = await rig(t, { deps: { post } });
  const result = await r.run(A, '/one').promise;
  assert.equal(result.mode, 'stateless');
  assert.equal(destroys(r.fake).length, 1, 'whatever sits under that id did not get the proxy');
  assert.equal(destroys(r.fake)[0].session, creates(r.fake)[0].session);
});

test('a refused connection while a session is being opened reaches the caller untouched and leaves no half-open session behind', async (t) => {
  const thrown = captureFetchErrors(t);
  const r = await rig(t);
  await r.fake.switchOff();
  const failure = await rejectionOf(r.run(A, '/one'));
  assert.equal(failure, thrown[thrown.length - 1]);
  assert.equal(failure.cause.code, 'ECONNREFUSED');
  await until(() => r.pool.getStatus().sessions.length === 0, 'the slot to be dropped');
  assert.equal(r.pool.getStatus().state, 'idle', 'a refusal is not a wedge: no fail-fast window');
  assert.equal(r.pool.getStatus().solver, 'refused');
});

// ── Repeated blocks and launch retries ───────────────────────────────────────────

test('only the second block in a row recycles the session, not every one after it', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock, config: { blockCooldown: { initialMs: 1000, maxMs: 4000 } } });
  r.fake.page(/\/blocked/, { errorMessage: FAKE_TEXT.blocked });
  await rejectionOf(r.run(A, '/blocked1'));
  await clock.advance(1000);
  await rejectionOf(r.run(A, '/blocked2'));
  await until(() => destroys(r.fake).length === 1, 'the recycle after the second block');
  await clock.advance(2000);
  await rejectionOf(r.run(A, '/blocked3'));
  await r.settled();
  assert.equal(destroys(r.fake).length, 1, 'once');
  assert.deepEqual(r.pool.getStatus().cooldowns, [{ host: 'cf-site.example', secondsLeft: 4 }], 'but the cooldown keeps growing, up to its cap');
});

test('a failed launch closes another browser that is idle (it may be what holds chromedriver), then tries once more', async (t) => {
  // The order that matters - the first browser is busy when the second is asked for, and free again by the time that launch
  // fails - is the test's own: the busy navigation and the second session's create are parked until it lets them go, instead
  // of being a race between timers of a few dozen milliseconds.
  let parked = null;
  const held = holdablePost();
  const post = async (solverUrl, payload, options) => {
    if (payload.cmd === 'sessions.create' && parked) {
      const gate = parked;
      parked = null;
      gate.entered();
      await gate.released;
    }
    return held.post(solverUrl, payload, options);
  };
  const r = await rig(t, { settings: { maxSessions: 2 }, deps: { post } });
  await r.run(A, '/warm').promise;
  await r.settled();
  const firstId = creates(r.fake)[0].session;

  const gate = {};
  gate.released = new Promise((resolve) => { gate.release = resolve; });
  const entered = new Promise((resolve) => { gate.entered = resolve; });
  parked = gate;
  r.fake.command('sessions.create', { errorMessage: FAKE_TEXT.launchConflict, times: 1 });
  const busyNavigation = held.hold('/busy');
  const busy = r.run(A, '/busy').promise;
  await busyNavigation.arrived; // the first browser is busy for as long as the test says
  const secondJob = r.run(B, '/second').promise; // needs a second browser: its create is parked
  await entered;
  busyNavigation.release(); // the first browser frees up
  await busy;
  await until(() => r.pool.getStatus().sessions.some((s) => !s.busy), 'the first browser to be free again');
  gate.release(); // the launch fails now, and the first browser is idle
  const second = await secondJob;
  assert.equal(second.mode, 'session', 'the launch was retried');
  assert.ok(destroys(r.fake).some((e) => e.session === firstId), 'the idle browser was closed before the retry');
  assert.equal(creates(r.fake).length, 3);
  await r.settled();
});

test('"FlareSolverr is not reachable" is said once per episode, however many calls are refused, and again after an answer', async (t) => {
  const r = await rig(t);
  const said = () => r.events.warns.filter((m) => /is not reachable/.test(m)).length;
  await r.run(A, '/one').promise;
  await r.settled();

  await r.fake.switchOff();
  for (const path of ['/refused-1', '/refused-2', '/refused-3']) await rejectionOf(r.run(A, path));
  assert.equal(said(), 1, 'one line for the whole episode');
  assert.deepEqual(r.events.warns.filter((m) => /fail fast/.test(m)), [], 'nothing fails fast for a refusal');

  r.fake.switchOn();
  await r.run(A, '/answered').promise; // FlareSolverr answered: the episode is over
  await r.settled();
  await r.fake.switchOff();
  await rejectionOf(r.run(A, '/refused-4'));
  assert.equal(said(), 2, 'a new episode is a new line');
});

test('a user who switched FlareSolverr off on purpose is told nothing, every call still gets the raw refusal, and the status says why', async (t) => {
  const thrown = captureFetchErrors(t);
  const r = await rig(t, { hooks: { isOffByChoice: () => true } });
  await r.fake.switchOff();

  for (const path of ['/refused', '/again']) {
    const failure = await rejectionOf(r.run(A, path));
    assert.equal(failure, thrown[thrown.length - 1]);
    assert.equal(failure.cause.code, 'ECONNREFUSED');
  }
  assert.deepEqual(r.events.warns.filter((m) => /FlareSolverr is not/.test(m)), []);
  assert.notEqual(r.pool.getStatus().state, 'down');
  assert.equal(r.pool.getStatus().solver, 'off');
});
