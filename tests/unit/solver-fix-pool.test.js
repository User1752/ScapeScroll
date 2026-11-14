'use strict';

// The solver pool against a fake FlareSolverr 3.5.2 on loopback, end to end: three rules the review of the
// session pool found broken where parts meet. A job that comes back to the queue while the fail-fast
// window is open; a job whose site went into its cooldown while it opened its session; a circuit that a
// restart did not close. The rig (tests/helpers/solver-pool-rig.js) checks the session discipline
// when every test ends.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGES: FAKE_TEXT } = require('../helpers/fake-flaresolverr');
const { A, B, makeClock, navigations, creates, holdablePost, rig, rejectionOf } = require('../helpers/solver-pool-rig');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver-pool');

// ── The fail-fast window ─────────────────────────────────────────────────────

test('a job that comes back to the queue while the fail-fast window is open is refused, not sent to the solver just declared wedged', async (t) => {
  const held = holdablePost();
  const r = await rig(t, { deps: { post: held.post }, settings: { maxSessions: 2 }, config: { downAfterWedgeMs: 60_000 } });
  const running = held.hold('/running');
  const wedged = held.hold('/wedged');
  const first = r.run(A, '/running');
  const second = r.run(B, '/wedged');
  await Promise.all([running.arrived, wedged.arrived]);

  // The second job's request is never answered; the first job's browser turns out to be dead, which is a retry.
  r.fake.page(`${A}/running`, { errorMessage: FAKE_TEXT.driverDead, kill: true });
  wedged.timeout();
  await rejectionOf(second);
  assert.equal(r.pool.getStatus().state, 'down');
  const createdBefore = creates(r.fake).length;

  running.release();
  const failure = await rejectionOf(first);
  assert.equal(failure.code, POOL_ERROR_CODES.DOWN);
  assert.equal(failure.noRetry, true);
  assert.equal(creates(r.fake).length, createdBefore, 'no session is opened on a solver the pool has just declared wedged');
});

// ── A site's cooldown ────────────────────────────────────────────────────────

test('a job whose site went into its cooldown while it was opening its session is refused: no request is sent during the cooldown', async (t) => {
  // Two jobs for one site, each on a session of its own. The second session takes its time (the launch lock,
  // then a slow launch); meanwhile the first job is answered "blocked", which starts the site's cooldown.
  const r = await rig(t, { settings: { maxSessions: 2 }, config: { affinityWaitMs: 0 } });
  r.fake.command('sessions.create', { delayMs: 400 });
  r.fake.command('sessions.create', { times: 1 }); // the newest rule wins: the first create is quick
  r.fake.page(`${A}/one`, { errorMessage: FAKE_TEXT.blocked });
  const first = r.run(A, '/one');
  const second = r.run(A, '/two');

  assert.equal((await rejectionOf(first)).kind, 'blocked');
  const refused = await rejectionOf(second);
  assert.equal(refused.code, POOL_ERROR_CODES.HOST_COOLDOWN);
  assert.equal(refused.rateLimited, true);
  assert.deepEqual(navigations(r.fake).map((e) => new URL(e.url).pathname), ['/one'], 'the site heard from the pool once');
  await r.settled();
});

// ── The circuit and a restart ────────────────────────────────────────────────

async function withOpenCircuit(t) {
  const clock = makeClock();
  const r = await rig(t, { clock, config: { circuit: { failures: 3, windowMs: 60_000, openMs: 300_000 } } });
  const failing = r.fake.command('sessions.create', { errorMessage: 'Boom while starting' });
  for (let i = 1; i <= 3; i += 1) assert.equal((await r.run(A, `/p${i}`).promise).mode, 'stateless');
  assert.equal(r.pool.getStatus().state, 'circuit-open');
  return { r, failing };
}

test('a restart that brought FlareSolverr back closes the circuit its old failures opened', async (t) => {
  const { r, failing } = await withOpenCircuit(t);
  r.pool.beginRestart('a stale chromedriver lock');
  assert.equal(r.pool.getStatus().circuit.open, true, 'not at the begin: the restart may still fail');
  failing.remove(); // the restart cleared what made the launches fail
  r.pool.endRestart({ ok: true });

  assert.equal(r.pool.getStatus().circuit.open, false);
  assert.notEqual(r.pool.getStatus().state, 'circuit-open');
  assert.equal((await r.run(A, '/after').promise).mode, 'session', 'no throwaway browser for the rest of the 300 s window');
  await r.settled();
});

test('a restart that did not bring FlareSolverr back leaves the circuit as it was', async (t) => {
  const { r } = await withOpenCircuit(t);
  r.pool.beginRestart('x');
  r.pool.endRestart({ ok: false });
  assert.equal(r.pool.getStatus().circuit.open, true);
});
