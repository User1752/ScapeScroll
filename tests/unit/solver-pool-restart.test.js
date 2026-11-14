'use strict';

// The solver pool against a fake FlareSolverr 3.5.2 on loopback (no browser, no network):
// FlareSolverr restarting in the middle of work, and the sessions of dead processes it leaves
// behind.
// The rig (tests/helpers/solver-pool-rig.js) checks the session discipline - no request for an
// id that was not confirmed or is being destroyed - when every test ends.

const test = require('node:test');
const assert = require('node:assert/strict');

const { A, B, sleep, until, makeClock, sequence, navigations, creates, destroys, captureFetchErrors, holdablePost, rig, rejectionOf } = require('../helpers/solver-pool-rig');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver-pool');

// ── FlareSolverr restarting ──────────────────────────────────────────────────

test('a restart: sessions are forgotten without a destroy, jobs wait, and the next one starts afresh', async (t) => {
  const r = await rig(t);
  await r.run(A, '/one').promise;
  await r.settled();
  const oldId = creates(r.fake)[0].session;
  r.fake.clearLog();

  r.pool.beginRestart('idle restart');
  assert.equal(r.pool.getStatus().state, 'restarting');
  assert.deepEqual(r.pool.getStatus().sessions, []);
  const waiting = r.run(A, '/two');
  await sleep(40);
  assert.equal(r.fake.log.length, 0, 'nothing is sent while FlareSolverr is being replaced, and the old session is not destroyed');

  await r.fake.restart();
  r.pool.endRestart({ ok: true });
  const result = await waiting.promise;
  await r.settled();
  assert.equal(result.mode, 'session');
  assert.deepEqual(sequence(r.fake), ['create', 'get /two', 'blank']);
  assert.notEqual(creates(r.fake)[0].session, oldId);
  assert.equal(r.pool.getStatus().state, 'active');
});

test('a job running when FlareSolverr is restarted fails with the raw transport error, and the pool does not go down for it', async (t) => {
  const thrown = captureFetchErrors(t);
  const r = await rig(t, { config: { downAfterWedgeMs: 60_000 } });
  await r.run(A, '/one').promise;
  await r.settled();
  r.fake.page(`${A}/running`, { delayMs: 500 });
  const running = r.run(A, '/running');
  await until(() => navigations(r.fake).some((e) => e.url.endsWith('/running')), 'the job to start');

  r.pool.beginRestart('wedged');
  const waiting = r.run(A, '/waiting');
  await r.fake.restart();
  const failure = await rejectionOf(running);
  assert.equal(failure, thrown[thrown.length - 1], 'the very same error');
  assert.equal(r.pool.getStatus().state, 'restarting', 'a restart is already under way: no fail-fast window');

  r.pool.endRestart({ ok: true });
  assert.equal(r.pool.getStatus().state, 'idle');
  r.fake.clearRules();
  const resumed = await waiting.promise;
  assert.equal(resumed.mode, 'session', 'the job that waited for the restart was not failed by the one that died in it');
  const next = await r.run(A, '/after').promise;
  assert.equal(next.mode, 'session');
  await r.settled();
});

test('a restart that ends well lifts the fail-fast window the solver\'s silence had opened', async (t) => {
  const held = holdablePost();
  const r = await rig(t, { deps: { post: held.post }, config: { downAfterWedgeMs: 60_000 } });
  await r.run(A, '/one').promise;
  await r.settled();
  const wedge = held.hold('/wedged');
  const wedged = r.run(A, '/wedged');
  await wedge.arrived;
  wedge.timeout(); // the solver took the call and never answered: our own abort fires
  await rejectionOf(wedged);
  assert.equal(r.pool.getStatus().state, 'down');
  assert.equal((await rejectionOf(r.run(A, '/refused'))).code, POOL_ERROR_CODES.DOWN);

  r.pool.beginRestart('recovered');
  const waiting = r.run(A, '/waits-for-the-restart');
  await sleep(20);
  assert.equal(r.pool.getStatus().state, 'restarting', 'a restart under way takes over from the fail-fast window');
  r.pool.endRestart({ ok: true });
  assert.equal(r.pool.getStatus().state, 'idle');
  assert.equal((await waiting.promise).mode, 'session', 'it was not refused for the window that came before the restart');
  assert.equal((await r.run(A, '/three').promise).mode, 'session');
  await r.settled();
});

test('failures within the window add up even when a session works in between', async (t) => {
  const clock = makeClock();
  // maxSessionUses 1: every job after the first opens a new session, so every job is a create.
  const r = await rig(t, { clock, config: { maxSessionUses: 1, circuit: { failures: 3, windowMs: 60_000, openMs: 10_000 } } });
  const failing = r.fake.command('sessions.create', { errorMessage: 'Boom while starting' });
  assert.equal((await r.run(A, '/1').promise).mode, 'stateless');
  failing.remove();
  assert.equal((await r.run(B, '/works').promise).mode, 'session');
  await r.settled();
  r.fake.command('sessions.create', { errorMessage: 'Boom while starting' });
  assert.equal((await r.run(A, '/2').promise).mode, 'stateless');
  assert.equal(r.pool.getStatus().circuit.open, false, 'two failures so far');
  assert.equal((await r.run(A, '/3').promise).mode, 'stateless');
  assert.equal(r.pool.getStatus().circuit.open, true, 'three in the window, with a success between the first and the second');
});

// The abort is fired by the test, between the begin of the restart and its end: a real timer of a few dozen
// milliseconds would fire before the restart began on a loaded machine, and the test would prove nothing.
test('a timeout that fires while FlareSolverr is being restarted does not open the fail-fast window', async (t) => {
  const held = holdablePost();
  const r = await rig(t, { deps: { post: held.post }, config: { downAfterWedgeMs: 60_000 } });
  await r.run(A, '/warm').promise;
  await r.settled();
  const wedge = held.hold('/wedged');
  const wedged = r.run(A, '/wedged');
  await wedge.arrived;
  r.pool.beginRestart('wedged');
  const waiting = r.run(B, '/waiting');
  wedge.timeout(); // its own abort fires in the middle of the restart
  assert.equal((await rejectionOf(wedged)).name, 'TimeoutError');
  await r.fake.restart();
  r.pool.endRestart({ ok: true });
  assert.equal((await waiting.promise).mode, 'session', 'the job that waited was not failed by the window a restart makes pointless');
  await r.settled();
});

test('a job that had been picked but had sent nothing when the restart began waits for it instead of failing', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = await rig(t, { deps: { getSolverProxy: async () => { await gate; return null; } } });
  const job = r.run(A, '/early');
  await sleep(20); // picked, and waiting for the proxy lookup
  r.pool.beginRestart('test');
  release();
  await sleep(30);
  assert.equal(r.fake.log.length, 0, 'nothing was sent into the restart');
  r.pool.endRestart({ ok: true });
  const result = await job.promise;
  assert.equal(result.mode, 'session');
  await r.settled();
});

test('jobs queued during a restart are refused when their deadline or the restart wait passes', async (t) => {
  const r = await rig(t, { config: { restartWaitMaxMs: 80 } });
  r.pool.beginRestart('test');
  const impatient = await rejectionOf(r.run(A, '/impatient', {}, { deadlineAt: Date.now() + 30 }));
  assert.equal(impatient.code, POOL_ERROR_CODES.RESTARTING);
  assert.equal(impatient.noRetry, true);
  const patient = await rejectionOf(r.run(A, '/patient'));
  assert.equal(patient.code, POOL_ERROR_CODES.RESTARTING);
  assert.equal(r.fake.log.length, 0);
  r.pool.endRestart({ ok: true });
});

test('a restart that did not come back: the pool is down for a while, queued jobs fail at once', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock, config: { downAfterWedgeMs: 30_000 } });
  r.pool.beginRestart('test');
  const waiting = r.run(A, '/waiting');
  r.pool.endRestart({ ok: false });
  assert.equal((await rejectionOf(waiting)).code, POOL_ERROR_CODES.DOWN);
  assert.equal(r.pool.getStatus().state, 'down');
  assert.equal((await rejectionOf(r.run(A, '/refused'))).code, POOL_ERROR_CODES.DOWN);
  await clock.advance(30_000);
  assert.equal(r.pool.getStatus().state, 'idle');
  assert.equal((await r.run(A, '/back').promise).mode, 'session');
  await r.settled();
});

test('a restart whose end is never reported is treated as failed, so the pool is not paused for good', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock, config: { restartWaitMaxMs: 1000, restartWatchdogGraceMs: 500 } });
  r.pool.beginRestart('test');
  r.assertTimersUnref();
  await clock.advance(1400);
  assert.equal(r.pool.getStatus().state, 'restarting');
  await clock.advance(200);
  assert.equal(r.pool.getStatus().state, 'down', 'no longer restarting');
  assert.ok(r.events.warns.some((m) => /never reported its end/.test(m)));
});

test('the pool subscribes to restarts itself, once, and lets go when it is closed', async (t) => {
  let registered = 0;
  let unsubscribed = 0;
  let listener = null;
  const r = await rig(t, { hooks: { onRestart(l) { registered += 1; listener = l; return () => { unsubscribed += 1; }; } } });
  assert.equal(registered, 1);
  listener({ phase: 'begin', reason: 'idle restart' });
  assert.equal(r.pool.getStatus().state, 'restarting');
  listener({ phase: 'end', ok: true });
  assert.equal(r.pool.getStatus().state, 'idle');
  listener({ phase: 'begin', reason: 'again' });
  listener({ phase: 'end', ok: false });
  assert.equal(r.pool.getStatus().state, 'down');
  listener(null);
  listener({ phase: 'unknown' });
  await r.pool.shutdown({ timeoutMs: 500 });
  assert.equal(unsubscribed, 1);
});

// ── Orphans ──────────────────────────────────────────────────────────────────

async function seed(fake, id) {
  const res = await fetch(fake.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cmd: 'sessions.create', session: id }) });
  assert.equal(res.status, 200);
}

test('the sweep destroys the sessions of dead ScrollScape processes and no one else\'s', async (t) => {
  const alive = new Set([4242]);
  const r = await rig(t, { deps: { pid: 7000, isPidAlive: (pid) => alive.has(pid) } });
  for (const id of ['ss-9999-abc-1', 'ss-9999-abc-2', 'ss-4242-abc-1', 'someone-elses-session', 'ss-bad']) await seed(r.fake, id);
  r.fake.clearLog();

  assert.equal(await r.pool.sweepOrphans(r.solverUrl), 2);
  assert.deepEqual(destroys(r.fake).map((e) => e.session).sort(), ['ss-9999-abc-1', 'ss-9999-abc-2']);
  assert.deepEqual([...r.fake.sessions.keys()].sort(), ['someone-elses-session', 'ss-4242-abc-1', 'ss-bad']);
  assert.equal(r.pool.getStatus().counters.orphansSwept, 2);
});

// Pids are reused (Windows, containers): a run that happens to get the pid of one that was stopped hard must
// still close what that one left, and never what it opened itself.
test('the sweep closes the sessions an earlier run with this very pid left, and never a session of this process', async (t) => {
  const r = await rig(t, { deps: { pid: 7000, isPidAlive: () => true } });
  await r.run(A, '/one').promise;
  await r.settled();
  const mine = creates(r.fake)[0].session;
  assert.match(mine, /^ss-7000-/);
  for (const id of ['ss-7000-zzz-1', 'ss-7000-zzz-2']) await seed(r.fake, id);
  r.fake.clearLog();

  assert.equal(await r.pool.sweepOrphans(r.solverUrl), 2);
  assert.deepEqual(destroys(r.fake).map((e) => e.session).sort(), ['ss-7000-zzz-1', 'ss-7000-zzz-2']);
  assert.ok(r.fake.sessions.has(mine), 'the session this process is using is untouched');
});

test('the sweep never even asks a solver that is not on this computer', async (t) => {
  const calls = [];
  const post = async (url, payload) => {
    calls.push(payload.cmd);
    return { httpStatus: 200, body: { status: 'ok', sessions: ['ss-9999-abc-1'] } };
  };
  const r = await rig(t, { deps: { isPidAlive: () => false, post } });
  assert.equal(await r.pool.sweepOrphans('http://203.0.113.9:8191/v1'), 0);
  assert.equal(await r.pool.sweepOrphans('https://solver.example/v1'), 0);
  assert.deepEqual(calls, []);
  assert.equal(await r.pool.sweepOrphans('http://localhost:8191/v1'), 1, 'localhost is this computer');
  assert.deepEqual(calls, ['sessions.list', 'sessions.destroy']);
});

test('the sweep does nothing for a solver that is not on this computer, and swallows every failure', async (t) => {
  const thrown = captureFetchErrors(t);
  const r = await rig(t, { deps: { isPidAlive: () => false } });
  await seed(r.fake, 'ss-9999-abc-1');
  r.fake.clearLog();
  const attempts = thrown.length;
  assert.equal(await r.pool.sweepOrphans('http://203.0.113.9:8191/v1'), 0);
  assert.equal(r.fake.log.length, 0);

  r.fake.command('sessions.list', { errorMessage: 'nope' });
  assert.equal(await r.pool.sweepOrphans(r.solverUrl), 0, 'a list that fails is nothing to act on');
  await r.fake.switchOff();
  assert.equal(await r.pool.sweepOrphans(r.solverUrl), 0, 'a refused connection only means FlareSolverr is not up');
  assert.ok(thrown.length > attempts);
  assert.equal(r.events.recovered, 0, 'housekeeping never recovers the solver');
  assert.notEqual(r.pool.getStatus().state, 'down');
});

test('a restart that kills FlareSolverr while a job is opening its session sends the job back to wait; the caller never sees the connection error', async (t) => {
  const r = await rig(t, { fakeOptions: { launchMs: 400 } });
  const opening = r.run(A, '/opening');
  await until(() => r.fake.log.some((e) => e.cmd === 'sessions.create'), 'the session to be asked for');

  r.pool.beginRestart('wedged');
  await r.fake.restart(); // cuts the create that is still launching Chrome
  await sleep(30);
  assert.equal(r.pool.getStatus().state, 'restarting', 'the job is waiting, not failed');
  r.fake.launchMs = 0;
  r.pool.endRestart({ ok: true });

  const result = await opening.promise;
  await r.settled();
  assert.equal(result.mode, 'session');
  assert.equal(navigations(r.fake).length, 1, 'the page was asked for once, after the restart');
});

test('two restarts that overlap pause the pool until the second one ends, and only then do the jobs go', async (t) => {
  const r = await rig(t);
  r.pool.beginRestart('idle restart');
  r.pool.beginRestart('hang recovery');
  const waiting = r.run(A, '/waiting');

  r.pool.endRestart({ ok: true });
  await sleep(40);
  assert.equal(r.pool.getStatus().state, 'restarting', 'the second restart is still going');
  assert.equal(r.fake.log.length, 0, 'nothing is sent into a FlareSolverr that is being killed');

  r.pool.endRestart({ ok: true });
  assert.equal((await waiting.promise).mode, 'session');
  await r.settled();
});
