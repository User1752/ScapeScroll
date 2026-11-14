'use strict';

// boundSolve bounds a navigation by the deadline the CALLER declared, not by the one the queue capped
// (intake.js keeps both: deadlineAt is how long the job may wait, solveDeadlineAt what the caller declared).

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { createJobs } = require('../../server/modules/network/solver/jobs');
const { createIntake } = require('../../server/modules/network/solver/intake');
const { createNavigation } = require('../../server/modules/network/solver/navigation');
const { runWithSolverContext } = require('../../server/modules/network/solver-context');

function makeEnv() {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, {});
  const state = createPoolState(cfg);
  state.enabled = true;
  const ports = createPorts({ now: () => clock.t }, state);
  const jobs = createJobs({ state, cfg, ports });
  const intake = createIntake({
    state, cfg, ports, jobs, wake() {}, passthrough: {},
    hostGate: { isBlocked: () => false },
    cookieWatch: { generation: () => 0 },
    circuit: { isOpen: () => false },
  });
  const navigation = createNavigation({ state, cfg, ports, hostGate: {}, cookieWatch: {}, circuit: {}, onTransportFailure() {} });
  const queue = () => state.queue;
  return { clock, cfg, state, intake, navigation, queue };
}

const request = { url: 'https://cf-site.example/', solverUrl: 'http://127.0.0.1:8191/v1' };
const askBounded = (env, declaredMs) => runWithSolverContext(
  { priority: 'background', boundSolve: true, deadlineAt: env.clock.t + declaredMs },
  () => env.intake.run(request, {}),
);

test('a background caller that declares 30 s keeps a 29 s bound although the queue only lets it wait 15 s', async () => {
  const env = makeEnv();
  const handle = await askBounded(env, 30_000);
  const [job] = env.queue();
  assert.equal(job.deadlineAt, env.clock.t + env.cfg.queue.backgroundWaitMaxMs, 'the queue still drops it after its own patience');
  assert.equal(job.solveDeadlineAt, env.clock.t + 30_000, 'but the caller\'s deadline is kept as it was declared');
  assert.equal(env.navigation.maxTimeoutFor(job, env.clock.t), 30_000 - env.cfg.boundSolveMarginMs);
  handle.promise.catch(() => {});
});

test('a caller that declares less than the queue allows is bounded by what it declared', async () => {
  const env = makeEnv();
  const handle = await askBounded(env, 8_000);
  const [job] = env.queue();
  assert.equal(job.deadlineAt, env.clock.t + 8_000);
  assert.equal(env.navigation.maxTimeoutFor(job, env.clock.t), 8_000 - env.cfg.boundSolveMarginMs);
  handle.promise.catch(() => {});
});

test('a joiner that extends the deadline or promotes the job raises the navigation bound too', async () => {
  const env = makeEnv();
  const handle = await askBounded(env, 6_000);
  const [job] = env.queue();
  const before = job.solveDeadlineAt;
  handle.extendDeadline(env.clock.t + 20_000);
  assert.equal(job.solveDeadlineAt, env.clock.t + 20_000);
  assert.ok(job.solveDeadlineAt > before);

  handle.promote('interactive');
  assert.ok(job.solveDeadlineAt >= job.deadlineAt, 'never bounded below the time the job may now wait');
  handle.promise.catch(() => {});
});

test('a job without a declared deadline is bounded by the queue\'s, as before; a hand-built job without the field too', () => {
  const env = makeEnv();
  const job = { request, boundSolve: true, deadlineAt: env.clock.t + 9_000 };
  assert.equal(env.navigation.maxTimeoutFor(job, env.clock.t), 9_000 - env.cfg.boundSolveMarginMs);
  assert.equal(env.navigation.maxTimeoutFor({ ...job, solveDeadlineAt: Infinity }, env.clock.t), 9_000 - env.cfg.boundSolveMarginMs);
});
