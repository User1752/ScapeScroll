'use strict';

// server/modules/network/solver/jobs.js: a job's bookkeeping. Jobs here are
// hand-made objects with the fields the module reads; no scheduling, no FlareSolverr.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver/errors');
const { createJobs } = require('../../server/modules/network/solver/jobs');

// A promise the code under test must settle. When a rule is broken it never does, and a test that
// waits for ever is worse than one that fails, so the wait is bounded.
function soon(promise, what, ms = 1000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what} was never answered` })), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function makeEnv(config = {}) {
  const cfg = mergeConfig(POOL, config);
  const state = createPoolState(cfg);
  const out = { used: 0, warns: [] };
  const ports = createPorts({ warn: (m) => out.warns.push(m), hooks: { noteUsed: () => { out.used += 1; } } }, state);
  return { cfg, state, out, jobs: createJobs({ state, cfg, ports }) };
}

function makeJob(over = {}) {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const job = {
    seq: 1, priority: 'interactive', state: 'queued', counted: false, settled: false, queuedMs: 7, resolve, reject, ...over,
  };
  return { job, promise };
}

test('a job is counted once while it is in flight, and waiters hear when nothing is', () => {
  const { state, jobs } = makeEnv();
  const { job } = makeJob();
  let drained = 0;
  state.drainWaiters.push(() => { drained += 1; });

  jobs.beginRun(job);
  jobs.beginRun(job);
  assert.equal(state.inFlight, 1);
  jobs.endRun(job);
  assert.equal(state.inFlight, 0);
  assert.equal(drained, 1);
  jobs.endRun(job); // already ended: nothing goes negative
  assert.equal(state.inFlight, 0);
  assert.equal(drained, 1);
});

test('a job is answered once: it leaves the queue, stops counting, and the first answer stands', async () => {
  const { state, jobs } = makeEnv();
  const { job, promise } = makeJob();
  state.queue.push(job);
  jobs.beginRun(job);

  assert.equal(jobs.settle(job, true, { data: 1 }), true);
  assert.equal(job.state, 'settled');
  assert.deepEqual(state.queue, []);
  assert.equal(state.inFlight, 0);
  assert.equal(jobs.settle(job, false, new Error('late')), false);
  assert.deepEqual(await promise, { data: 1 });
});

test('a rejection records the kind System Health shows: the explicit one, else the refusal\'s, else the error\'s', async () => {
  const { state, jobs } = makeEnv();
  const cases = [
    [(code) => Object.assign(new Error('x'), { code }), POOL_ERROR_CODES.QUEUE_FULL, 'driver', 'driver'],
    [(code) => Object.assign(new Error('x'), { code }), POOL_ERROR_CODES.QUEUE_FULL, undefined, 'queue-full'],
    [() => Object.assign(new Error('x'), { kind: 'timeout' }), undefined, undefined, 'timeout'],
    [() => new Error('x'), undefined, undefined, 'error'],
  ];
  for (const [makeError, code, kind, expected] of cases) {
    const { job, promise } = makeJob();
    const err = makeError(code);
    jobs.rejectJob(job, err, kind);
    assert.equal(state.lastError.kind, expected);
    await assert.rejects(promise, (e) => e === err);
  }
});

test('rejectQueued refuses the jobs still waiting for a slot, each with an error of its own, and leaves the others', async () => {
  const { state, jobs } = makeEnv();
  const a = makeJob();
  const b = makeJob({ seq: 2 });
  const running = makeJob({ seq: 3, state: 'running' });
  const preflighting = makeJob({ seq: 4, state: 'preflighting' });
  state.queue.push(a.job, b.job, running.job, preflighting.job);

  jobs.rejectQueued(POOL_ERROR_CODES.DOWN);
  const errors = await soon(Promise.all([a.promise, b.promise].map((p) => p.catch((e) => e))), 'the refused jobs');
  assert.deepEqual(errors.map((e) => e.code), [POOL_ERROR_CODES.DOWN, POOL_ERROR_CODES.DOWN]);
  assert.notEqual(errors[0], errors[1]);
  assert.equal(running.job.settled, false);
  assert.equal(preflighting.job.settled, false);
  assert.deepEqual(state.queue, [running.job, preflighting.job]);
});

test('resolveWith answers with the navigation\'s result and notes that the solver was used', async () => {
  const { out, jobs } = makeEnv();
  const { job, promise } = makeJob({ queuedMs: 12 });
  const result = { data: { status: 'ok' }, meta: { mode: 'session', proxyMode: 'user-proxy', fingerprint: 'user:1', solveMs: 340, ignored: true } };
  assert.equal(jobs.resolveWith(job, result), true);
  assert.deepEqual(await promise, {
    data: { status: 'ok' }, mode: 'session', proxyMode: 'user-proxy', fingerprint: 'user:1', queuedMs: 12, solveMs: 340,
  });
  assert.equal(out.used, 1);
});

test('detached work that rejects is reported once, never left unhandled', async () => {
  const { out, jobs } = makeEnv();
  jobs.detach(Promise.reject(new Error('background failure')));
  jobs.detach(Promise.reject(new Error('background failure')));
  jobs.detach(Promise.resolve());
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(out.warns, ['[SolverPool] Unexpected error: background failure']);
});

test('waiting states, patience and order', () => {
  const { cfg, jobs } = makeEnv();
  assert.equal(jobs.isWaiting({ state: 'queued' }), true);
  assert.equal(jobs.isWaiting({ state: 'preflighting' }), true);
  for (const state of ['running', 'settled', 'passthrough']) assert.equal(jobs.isWaiting({ state }), false, state);

  assert.equal(jobs.waitBudget('interactive'), cfg.queue.interactiveWaitMaxMs);
  assert.equal(jobs.waitBudget('background'), cfg.queue.backgroundWaitMaxMs);
  assert.equal(jobs.waitBudget(undefined), cfg.queue.interactiveWaitMaxMs);

  const list = [
    { priority: 'background', seq: 1 }, { priority: 'interactive', seq: 3 }, { priority: 'background', seq: 2 }, { priority: 'interactive', seq: 2 },
  ];
  assert.deepEqual(list.sort(jobs.byPriority).map((j) => `${j.priority[0]}${j.seq}`), ['i2', 'i3', 'b1', 'b2']);
  assert.ok(jobs.priorityRank('interactive') < jobs.priorityRank('background'));
});
