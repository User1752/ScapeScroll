'use strict';

// server/modules/network/solver/intake.js: the front door. run() validates a request,
// decides what happens to it (refused, sent down the old path, or queued) and hands back
// the handle. The scheduler is a "wake" counter here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver/errors');
const { createHostGate } = require('../../server/modules/network/solver/host-gate');
const { createCircuit } = require('../../server/modules/network/solver/circuit');
const { createCookieWatch } = require('../../server/modules/network/solver/cookie-watch');
const { createJobs } = require('../../server/modules/network/solver/jobs');
const { createIntake } = require('../../server/modules/network/solver/intake');
const { runWithSolverContext } = require('../../server/modules/network/solver-context');

const SOLVER = 'http://127.0.0.1:8191/v1';
const A = 'https://cf-site.example';

// A promise the code under test must settle. When a rule is broken it never does, and a test that
// waits for ever is worse than one that fails, so the wait is bounded.
function soon(promise, what, ms = 1000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what} was never answered` })), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function makeEnv(config = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, { queue: { maxQueued: 3 }, ...config });
  const state = createPoolState(cfg);
  state.enabled = true;
  const out = { woke: 0, passed: [] };
  const ports = createPorts({ now: () => clock.t, log: () => {}, warn: () => {}, recordError: async () => {} }, state);
  const hostGate = createHostGate({ cfg, state, ports });
  const circuit = createCircuit({ cfg, ports });
  const jobs = createJobs({ state, cfg, ports });
  const passthrough = { passThrough: (request) => { out.passed.push(request); return Promise.resolve({ passedThrough: true }); } };
  const cookieWatch = createCookieWatch({ cfg, ports });
  const intake = createIntake({ state, cfg, ports, hostGate, cookieWatch, circuit, jobs, passthrough, wake: () => { out.woke += 1; } });
  return { clock, cfg, state, out, hostGate, cookieWatch, circuit, intake };
}

const request = (path = '/a', over = {}) => ({ url: `${A}${path}`, solverUrl: SOLVER, ...over });

test('a request without a URL and a solver URL is a programming error, and nothing is queued', () => {
  const { state, intake } = makeEnv();
  for (const bad of [undefined, null, {}, { url: 'x' }, { solverUrl: SOLVER }, { url: '', solverUrl: SOLVER }, { url: 1, solverUrl: SOLVER }, { url: A, solverUrl: '' }]) {
    assert.throws(() => intake.run(bad), { name: 'TypeError', message: 'A solver request needs a url and a solverUrl.' });
  }
  assert.deepEqual(state.queue, []);
});

test('a valid request is queued with everything the scheduler needs, and the scheduler is woken', () => {
  const { clock, cfg, state, out, intake } = makeEnv();
  const handle = intake.run(request('/a'));
  intake.run(request('/b'));
  assert.equal(typeof handle.promote, 'function');
  assert.equal(typeof handle.extendDeadline, 'function');
  assert.ok(handle.promise instanceof Promise);

  const [job, second] = state.queue;
  assert.deepEqual([job.seq, second.seq], [1, 2]);
  assert.equal(job.url, `${A}/a`);
  assert.equal(job.solverUrl, SOLVER);
  assert.equal(job.hostKey, 'cf-site.example');
  assert.equal(job.mode, 'session');
  assert.equal(job.priority, 'interactive');
  assert.equal(job.state, 'queued');
  assert.equal(job.enqueuedAt, clock.t);
  assert.equal(job.deadlineAt, clock.t + cfg.queue.interactiveWaitMaxMs);
  assert.deepEqual([job.boundSolve, job.label, job.attempt, job.counted, job.settled, job.preflightSeen, job.preflightOff, job.slot, job.queuedMs], [false, '', 0, false, false, 0, false, null, 0]);
  assert.equal(state.counters.jobs, 2);
  assert.equal(out.woke, 2);
});

test('a job is queued in the cookie generation its site is at, so only a later navigation to the site gives its preflight something to try', () => {
  const { state, cookieWatch, intake } = makeEnv();
  cookieWatch.noteChange('cf-site.example');
  cookieWatch.noteChange('cf-site.example');
  intake.run(request('/after-two'));
  intake.run({ url: 'https://other-site.example/x', solverUrl: SOLVER });
  const [onSite, elsewhere] = state.queue;
  assert.equal(onSite.preflightSeen, 2);
  assert.equal(elsewhere.preflightSeen, 0, 'each site has its own');
});

test('what the caller declared sets the job\'s priority, patience and label; a deadline never gives more than the class allows', () => {
  const { clock, cfg, state, intake } = makeEnv();
  intake.run(request('/bg'), { priority: 'background', deadlineAt: clock.t + 5000, boundSolve: true, label: 'health' });
  intake.run(request('/far'), { priority: 'background', deadlineAt: clock.t + 10 * 60_000 });
  intake.run(request('/junk'), { priority: 'urgent', deadlineAt: NaN, boundSolve: 'yes', label: 42 });
  const [bg, far, junk] = state.queue;
  assert.deepEqual([bg.priority, bg.deadlineAt, bg.boundSolve, bg.label], ['background', clock.t + 5000, true, 'health']);
  assert.equal(far.deadlineAt, clock.t + cfg.queue.backgroundWaitMaxMs, 'the class patience caps a deadline far away');
  assert.deepEqual([junk.priority, junk.deadlineAt, junk.boundSolve, junk.label], ['interactive', clock.t + cfg.queue.interactiveWaitMaxMs, false, '']);
});

test('the surrounding code\'s declaration applies, the earlier deadline wins, and the call\'s own words win over the surrounding ones', async () => {
  const { clock, state, intake } = makeEnv();
  await runWithSolverContext({ priority: 'background', deadlineAt: clock.t + 4000, label: 'outer' }, async () => {
    intake.run(request('/a'));
    intake.run(request('/b'), { deadlineAt: clock.t + 9000, priority: 'interactive', label: 'inner' });
    intake.run(request('/c'), { deadlineAt: clock.t + 1000 });
  });
  const [a, b, c] = state.queue;
  assert.deepEqual([a.priority, a.deadlineAt, a.label], ['background', clock.t + 4000, 'outer']);
  assert.deepEqual([b.priority, b.deadlineAt, b.label], ['interactive', clock.t + 4000, 'inner'], 'a caller cannot be made to wait longer than the one above it');
  assert.equal(c.deadlineAt, clock.t + 1000);
});

test('a request with cookies, an open circuit, or no sessions on this FlareSolverr goes straight to the one-off lane', () => {
  const { clock, state, circuit, intake } = makeEnv();
  intake.run(request('/plain'));
  intake.run(request('/cookies', { cookies: [{ name: 'a', value: 'b' }] }));
  intake.run(request('/empty-cookies', { cookies: [] }));
  assert.deepEqual(state.queue.map((j) => j.mode), ['session', 'stateless', 'session']);

  for (let i = 0; i < 3; i += 1) circuit.noteFailure('launch');
  assert.equal(circuit.isOpen(clock.t), true);
  state.queue.length = 0;
  state.counters.jobs = 0;
  intake.run(request('/while-open'));
  assert.equal(state.queue[0].mode, 'stateless');

  const { state: other, intake: second } = makeEnv();
  other.sessionsUnsupported = true;
  second.run(request('/x'));
  assert.equal(other.queue[0].mode, 'stateless');
});

test('a caller that declared oneOff gets the one-off lane, whether it said so in the call or around it, cookies or not', async () => {
  const { state, intake } = makeEnv({ queue: { maxQueued: 10 } });
  intake.run(request('/in-the-call'), { oneOff: true });
  await runWithSolverContext({ oneOff: true }, async () => { intake.run(request('/around-the-call')); });
  intake.run(request('/ordinary'));
  intake.run(request('/not-a-true'), { oneOff: 'yes' });
  assert.deepEqual(state.queue.map((job) => job.mode), ['stateless', 'stateless', 'session', 'session']);
});

test('with the pool off the request goes down the old path and is never queued', async () => {
  const { state, out, intake } = makeEnv();
  state.enabled = false;
  const req = request('/a');
  const handle = intake.run(req);
  assert.deepEqual(out.passed, [req]);
  assert.deepEqual(state.queue, []);
  assert.deepEqual(await soon(handle.promise, 'the request'), { passedThrough: true });
  assert.doesNotThrow(() => { handle.promote('interactive'); handle.extendDeadline(Date.now() + 1000); });
  assert.equal(out.woke, 0);
});

test('with the pool closing the request is refused at once, in words that are not a timeout', async () => {
  const { state, out, intake } = makeEnv();
  state.shuttingDown = true;
  const handle = intake.run(request('/a'));
  await assert.rejects(soon(handle.promise, 'the job'), (err) => err.code === POOL_ERROR_CODES.SHUTTING_DOWN && err.noRetry === true && err.name !== 'TimeoutError');
  assert.equal(state.lastError.kind, 'shutting-down');
  assert.deepEqual(state.queue, []);
  assert.deepEqual(out.passed, []);
});

test('a job is refused before it is queued when the solver is down, the site is cooling down, or the queue is full', async () => {
  const { clock, state, out, hostGate, intake } = makeEnv();
  state.downUntil = clock.t + 1000;
  await assert.rejects(soon(intake.run(request('/a')).promise, 'a job in a down pool'), (err) => err.code === POOL_ERROR_CODES.DOWN && err.noRetry === true);
  state.downUntil = 0;

  hostGate.noteBlock('cf-site.example');
  await assert.rejects(soon(intake.run(request('/a')).promise, 'a job for a cooling site'), (err) => err.code === POOL_ERROR_CODES.HOST_COOLDOWN && err.rateLimited === true);
  intake.run({ url: 'https://other-site.example/a', solverUrl: SOLVER });
  assert.equal(state.queue.length, 1, 'another site is not affected');

  intake.run({ url: 'https://third-site.example/a', solverUrl: SOLVER });
  intake.run({ url: 'https://fourth-site.example/a', solverUrl: SOLVER });
  assert.equal(state.queue.length, 3);
  await assert.rejects(soon(intake.run({ url: 'https://fifth-site.example/a', solverUrl: SOLVER }).promise, 'a job for a full queue'), (err) => err.code === POOL_ERROR_CODES.QUEUE_FULL && err.noRetry === true);
  assert.equal(state.queue.length, 3);
  assert.equal(state.counters.jobs, 3, 'a refused job is not counted');
  assert.equal(out.woke, 3, 'and does not wake the scheduler');
});

test('a caller that joins a waiting job can raise its priority and extend its patience, never lower either', () => {
  const { clock, cfg, state, out, intake } = makeEnv();
  const handle = intake.run(request('/a'), { priority: 'background' });
  const [job] = state.queue;
  const wokeBefore = out.woke;

  handle.promote('background');
  assert.equal(job.priority, 'background');
  handle.promote('interactive');
  assert.equal(job.priority, 'interactive');
  assert.equal(job.deadlineAt, clock.t + cfg.queue.interactiveWaitMaxMs);
  handle.promote('background');
  assert.equal(job.priority, 'interactive', 'never lowered');
  assert.equal(job.deadlineAt, clock.t + cfg.queue.interactiveWaitMaxMs, 'and the deadline is never pulled in');
  assert.ok(out.woke > wokeBefore);

  const later = clock.t + 5 * 60_000;
  handle.extendDeadline(later);
  assert.equal(job.deadlineAt, later);
  handle.extendDeadline(later - 1000);
  handle.extendDeadline(NaN);
  handle.extendDeadline(undefined);
  assert.equal(job.deadlineAt, later);
});

test('a job that is no longer waiting is not changed by a late joiner', () => {
  const { clock, state, intake } = makeEnv();
  const handle = intake.run(request('/a'), { priority: 'background' });
  const [job] = state.queue;
  const deadline = job.deadlineAt;
  job.state = 'running';
  handle.promote('interactive');
  handle.extendDeadline(clock.t + 10 * 60_000);
  assert.equal(job.priority, 'background');
  assert.equal(job.deadlineAt, deadline);
});

test('a refused job whose caller dropped the handle is not an unhandled rejection', async () => {
  const { state, intake } = makeEnv();
  state.downUntil = Date.now() + 60_000;
  state.enabled = true;
  intake.run(request('/a')); // nobody reads .promise
  await new Promise((resolve) => { setImmediate(resolve); });
});
