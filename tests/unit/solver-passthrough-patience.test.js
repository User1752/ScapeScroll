'use strict';

// server/modules/network/solver/passthrough.js and intake.js: with the pool off a call waits for its site's turn
// only as long as a queued job would (what the caller declared, or the queue's patience for its priority), an
// interactive call goes before a background one, and the line for one site is as long as the pool's queue may
// be and no longer. A call that gives up never reaches FlareSolverr. Clock and timers are the test's.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { NO_PROXY } = require('../../server/modules/network/solver/proxy-info');
const { createJobs } = require('../../server/modules/network/solver/jobs');
const { createPassThrough } = require('../../server/modules/network/solver/passthrough');
const { createIntake } = require('../../server/modules/network/solver/intake');
const { runWithSolverContext } = require('../../server/modules/network/solver-context');

const SOLVER = 'http://127.0.0.1:8191/v1';
const SITE = 'https://cf-site.example/';

// Each `post` waits until the test lets it go, so a call can hold its place for as long as the test wants.
function makeEnv(config = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, config);
  const state = createPoolState(cfg);
  const timers = [];
  const ports = createPorts({
    now: () => clock.t,
    setTimer: (fn, ms) => { const timer = { fn, due: clock.t + ms, live: true }; timers.push(timer); return timer; },
    clearTimer: (timer) => { timer.live = false; },
  }, state);
  const jobs = createJobs({ state, cfg, ports });
  const holds = [];
  const sent = [];
  const post = (solverUrl, payload) => new Promise((resolve) => {
    sent.push(payload.url);
    holds.push(() => resolve({ httpStatus: 200, body: { status: 'ok' } }));
  });
  const passthrough = createPassThrough({ cfg, ports, post, resolveProxy: async () => NO_PROXY, jobs });
  const advance = (ms) => {
    clock.t += ms;
    for (const timer of timers.filter((x) => x.live && x.due <= clock.t)) { timer.live = false; timer.fn(); }
  };
  const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };
  return { clock, cfg, state, jobs, ports, sent, holds, passthrough, advance, settle };
}

const page = (n) => ({ url: `${SITE}${n}`, solverUrl: SOLVER });
const state = async (promise) => {
  let seen = 'pending';
  promise.then(() => { seen = 'answered'; }, (err) => { seen = err.code || 'failed'; });
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  return seen;
};

test('a call whose time runs out while it waits for its turn is refused as busy, leaves the line and never reaches the solver', async () => {
  const env = makeEnv();
  env.passthrough.passThrough(page(1)).catch(() => {});
  env.passthrough.passThrough(page(2)).catch(() => {});
  await env.settle();
  assert.equal(env.sent.length, 2, 'the two places of the site are taken');

  const waiting = env.passthrough.passThrough(page(3), { rank: 0, deadlineAt: env.clock.t + 1000 });
  await env.settle();
  assert.equal(await state(waiting), 'pending');
  env.advance(1000);
  await assert.rejects(waiting, (err) => err.code === 'SOLVER_QUEUE_TIMEOUT' && err.noRetry === true);

  env.holds.shift()();
  env.holds.shift()();
  await env.settle();
  assert.deepEqual(env.sent, [`${SITE}1`, `${SITE}2`], 'the third page was never sent');
});

test('a call that still has time gets its turn when a place frees, and its timer is stopped', async () => {
  const env = makeEnv();
  env.passthrough.passThrough(page(1)).catch(() => {});
  env.passthrough.passThrough(page(2)).catch(() => {});
  const waiting = env.passthrough.passThrough(page(3), { rank: 0, deadlineAt: env.clock.t + 5000 });
  await env.settle();
  env.advance(1000);
  env.holds.shift()();
  await env.settle();
  assert.deepEqual(env.sent, [`${SITE}1`, `${SITE}2`, `${SITE}3`]);
  env.advance(10_000); // the deadline passes while it is being answered: nothing happens to it
  env.holds.shift()();
  env.holds.shift()();
  assert.equal(await state(waiting), 'answered');
});

test('an interactive call goes before a background one that asked earlier', async () => {
  const env = makeEnv();
  env.passthrough.passThrough(page(1)).catch(() => {});
  env.passthrough.passThrough(page(2)).catch(() => {});
  const background = env.passthrough.passThrough(page('background'), { rank: env.jobs.priorityRank('background') });
  const interactive = env.passthrough.passThrough(page('interactive'), { rank: env.jobs.priorityRank('interactive') });
  await env.settle();
  env.holds.shift()();
  await env.settle();
  assert.equal(env.sent.at(-1), `${SITE}interactive`);
  env.holds.shift()();
  await env.settle();
  assert.equal(env.sent.at(-1), `${SITE}background`);
  env.holds.forEach((release) => release());
  await Promise.all([background, interactive]);
});

test('the line for one site is as long as the pool queue may be: the next call is refused at once, another site is not affected', async () => {
  const env = makeEnv({ queue: { maxQueued: 3 } });
  const calls = Array.from({ length: 5 }, (_, n) => env.passthrough.passThrough(page(n)));
  calls.forEach((call) => call.catch(() => {}));
  await env.settle();
  assert.equal(env.sent.length, 2, 'two in flight, three in line');
  await assert.rejects(env.passthrough.passThrough(page('one-too-many')), (err) => err.code === 'SOLVER_QUEUE_FULL' && err.noRetry === true);
  const other = env.passthrough.passThrough({ url: 'https://other.example/', solverUrl: SOLVER });
  await env.settle();
  assert.equal(env.sent.at(-1), 'https://other.example/', 'another site goes straight in');
  env.holds.forEach((release) => release());
  await other;
});

test('a refusal is what System Health shows as the last error, as with the pool on', async () => {
  const env = makeEnv({ queue: { maxQueued: 1 } });
  env.passthrough.passThrough(page(1)).catch(() => {});
  env.passthrough.passThrough(page(2)).catch(() => {});
  env.passthrough.passThrough(page(3)).catch(() => {});
  await env.settle();
  await assert.rejects(env.passthrough.passThrough(page(4)), { code: 'SOLVER_QUEUE_FULL' });
  assert.equal(env.state.lastError && env.state.lastError.kind, 'queue-full');
});

test('through the front door: the caller\'s declared deadline and priority are what the pool-off lane honours', async () => {
  const env = makeEnv();
  env.state.enabled = false;
  const intake = createIntake({ state: env.state, cfg: env.cfg, ports: env.ports, hostGate: {}, cookieWatch: {}, circuit: {}, jobs: env.jobs, passthrough: env.passthrough, wake() {} });
  intake.run(page(1), {}).promise.catch(() => {});
  intake.run(page(2), {}).promise.catch(() => {});
  const impatient = await runWithSolverContext({ priority: 'background', deadlineAt: env.clock.t + 300 }, () => intake.run(page(3), {}));
  const patient = intake.run(page(4), { priority: 'interactive' });
  patient.promise.catch(() => {});
  await env.settle();
  env.advance(300);
  await assert.rejects(impatient.promise, { code: 'SOLVER_QUEUE_TIMEOUT' });
  env.holds.shift()();
  await env.settle();
  assert.equal(env.sent.at(-1), `${SITE}4`, 'the interactive call got the place, the abandoned one never asked for it');
  assert.equal(env.sent.includes(`${SITE}3`), false);
  env.holds.forEach((release) => release());
  await patient.promise;
});

test('a call with a deadline too far away for a timer to hold gets none: no setTimeout overflow', async () => {
  const env = makeEnv();
  env.passthrough.passThrough(page(1)).catch(() => {});
  env.passthrough.passThrough(page(2)).catch(() => {});
  const waiting = env.passthrough.passThrough(page(3), { rank: 0, deadlineAt: Infinity });
  await env.settle();
  env.advance(1_000_000);
  assert.equal(await state(waiting), 'pending', 'no deadline: it keeps waiting');
  env.holds.shift()();
  env.holds.shift()();
  await env.settle();
  env.holds.shift()();
  assert.equal(await state(waiting), 'answered');
});
