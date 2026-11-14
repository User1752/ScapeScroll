'use strict';

// server/modules/network/solver/preflight.js: the direct try a waiting job gets before it takes a
// slot. The real jobs and state are used; the caller's preflight() is a script, and what the pool
// does with a job that is not answered by it (the old path) is a recorder.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver/errors');
const { createJobs } = require('../../server/modules/network/solver/jobs');
const { createCookieWatch } = require('../../server/modules/network/solver/cookie-watch');
const { NO_PROXY } = require('../../server/modules/network/solver/proxy-info');
const { createPreflight } = require('../../server/modules/network/solver/preflight');

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const DIRECT = { data: { status: 'ok', solution: { response: '<html>direct</html>', cookies: [], userAgent: 'direct' } } };

function makeEnv() {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, {});
  const state = createPoolState(cfg);
  state.enabled = true;
  const timers = [];
  const out = { released: [], woke: 0 };
  const ports = createPorts({
    now: () => clock.t,
    // A timer that has fired is gone, as a real one is.
    setTimer: (fn, ms) => {
      const handle = { ms, unref() { return this; } };
      handle.fn = () => { timers.splice(timers.indexOf(handle), 1); fn(); };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => { const at = timers.indexOf(handle); if (at !== -1) timers.splice(at, 1); },
    log: () => {},
    warn: () => {},
    recordError: async () => {},
  }, state);
  const jobs = createJobs({ state, cfg, ports });
  const passthrough = { release: (job) => { out.released.push(job); } };
  const cookieWatch = createCookieWatch({ cfg, ports });
  const env = { clock, state, timers, out, jobs, cookieWatch, proxy: NO_PROXY, resolveProxy: async () => env.proxy };
  env.preflight = createPreflight({
    state, ports, jobs, passthrough, cookieWatch, resolveProxy: (solverUrl) => env.resolveProxy(solverUrl), wake: () => { out.woke += 1; },
  });
  return env;
}

// A queued job whose caller supplied `preflightFn`; `answer` is its promise as the caller sees it.
function queued(env, preflightFn, over = {}) {
  let resolve;
  let reject;
  const answer = new Promise((res, rej) => { resolve = res; reject = rej; });
  answer.catch(() => {});
  const t = env.clock.t;
  const job = {
    seq: 1,
    request: { preflight: preflightFn },
    hostKey: 'cf-site.example',
    preflightSeen: 3,
    preflightOff: false,
    enqueuedAt: t - 2000,
    deadlineAt: t + 30_000,
    state: 'queued',
    settled: false,
    counted: false,
    resolve,
    reject,
    ...over,
  };
  env.state.queue.push(job);
  return { job, answer };
}

test('starting a preflight takes the pool-wide lane, marks the job and counts it as in flight', async () => {
  const env = makeEnv();
  let release;
  const { job } = queued(env, () => new Promise((resolve) => { release = resolve; }));
  env.preflight.start(job);
  assert.equal(env.state.preflightBusy, true);
  assert.equal(job.state, 'preflighting');
  assert.equal(env.state.inFlight, 1);
  await tick();
  assert.equal(env.timers.length, 1, 'the give-up timer for a caller that never answers');
  release(null);
  await tick();
});

test('a preflight that answers with data resolves the job as direct: no slot, nothing sent, the lane free again', async () => {
  const env = makeEnv();
  const { job, answer } = queued(env, async () => DIRECT);
  env.preflight.start(job);
  const result = await answer;
  assert.deepEqual(result, { data: DIRECT.data, mode: 'direct', proxyMode: 'none', fingerprint: 'none', queuedMs: 2000, solveMs: 0 });
  assert.equal(env.state.counters.directJobs, 1);
  assert.equal(env.state.preflightBusy, false);
  assert.equal(env.state.inFlight, 0);
  assert.equal(job.state, 'settled');
  assert.equal(env.timers.length, 0, 'the give-up timer is cleared');
  assert.ok(env.out.woke >= 1, 'the scheduler may look at the queue again');
});

test('anything but a plain { data } object, or a throw, only means "no": the job goes back to wait for the browser', async () => {
  for (const preflightFn of [async () => null, async () => undefined, async () => ({}), async () => ({ data: 'x' }), async () => [DIRECT], () => { throw new Error('lookup broke'); }, async () => { throw new Error('lookup broke'); }]) {
    const env = makeEnv();
    const { job } = queued(env, preflightFn);
    env.preflight.start(job);
    await tick();
    await tick();
    assert.equal(job.state, 'queued', String(preflightFn));
    assert.equal(job.settled, false);
    assert.equal(env.state.preflightBusy, false);
    assert.equal(env.state.inFlight, 0, 'no longer counted');
    assert.equal(env.state.counters.directJobs, 0);
    assert.ok(env.out.woke >= 1);
  }
});

test('a preflight that never answers is given up on when the job\'s own patience ends', async () => {
  const env = makeEnv();
  const { job } = queued(env, () => new Promise(() => {}), { deadlineAt: env.clock.t + 8000 });
  env.preflight.start(job);
  await tick();
  assert.equal(env.timers.length, 1);
  assert.equal(env.timers[0].ms, 8000);
  assert.equal(job.state, 'preflighting');

  env.timers[0].fn();
  await tick();
  assert.equal(job.state, 'queued', 'the caller is not waiting for it any more: the browser takes the job');
  assert.equal(env.state.preflightBusy, false);

  const late = makeEnv();
  const past = queued(late, () => new Promise(() => {}), { deadlineAt: late.clock.t - 5 });
  late.preflight.start(past.job);
  await tick();
  assert.equal(late.timers[0].ms, 0, 'a deadline that has passed gives no time at all');
});

test('a job that was answered while its preflight ran is left alone: the lane is freed and nothing is settled twice', async () => {
  const env = makeEnv();
  let finish;
  const { job, answer } = queued(env, () => new Promise((resolve) => { finish = resolve; }));
  env.preflight.start(job);
  await tick();
  const refusal = new Error('answered by someone else');
  env.jobs.rejectJob(job, refusal);
  await assert.rejects(answer, (err) => err === refusal);

  finish(DIRECT);
  await tick();
  assert.equal(env.state.counters.directJobs, 0, 'the direct answer is thrown away');
  assert.equal(env.state.preflightBusy, false);
  assert.equal(job.state, 'settled');
  assert.ok(env.out.woke >= 1);
});

test('a pool that was closed while the preflight ran refuses the job, even when the preflight had an answer', async () => {
  const env = makeEnv();
  let finish;
  const { job, answer } = queued(env, () => new Promise((resolve) => { finish = resolve; }));
  env.preflight.start(job);
  await tick();
  env.state.shuttingDown = true;
  finish(DIRECT);
  const err = await answer.then(() => assert.fail('expected a refusal'), (e) => e);
  assert.equal(err.code, POOL_ERROR_CODES.SHUTTING_DOWN);
  assert.equal(env.state.counters.directJobs, 0);
  assert.equal(env.state.preflightBusy, false);
  assert.equal(env.state.inFlight, 0);
});

test('a pool that was switched off while the preflight ran hands the job to the old path', async () => {
  const env = makeEnv();
  let finish;
  const { job } = queued(env, () => new Promise((resolve) => { finish = resolve; }));
  env.preflight.start(job);
  await tick();
  env.state.enabled = false;
  finish(DIRECT);
  await tick();
  assert.deepEqual(env.out.released, [job]);
  assert.equal(env.state.counters.directJobs, 0);
  assert.equal(env.state.preflightBusy, false);
});

// ── What a preflight teaches the pool about the cookie ──────────────────────

const HOST = 'cf-site.example';

test('a plain no from the site is noted for the cookie it was tried at, so other jobs of the site are not sent to hear the same', async () => {
  const env = makeEnv();
  const { job } = queued(env, async () => null);
  for (let i = 0; i < 3; i += 1) env.cookieWatch.noteChange(HOST);
  assert.equal(env.cookieWatch.isWorthAsking(HOST), true);
  env.preflight.start(job);
  await tick();
  assert.equal(job.state, 'queued');
  assert.equal(env.cookieWatch.isWorthAsking(HOST), false, 'refused at generation 3');

  env.cookieWatch.noteChange(HOST);
  assert.equal(env.cookieWatch.isWorthAsking(HOST), true, 'a new cookie is worth a new try');
});

test('nothing to try, a throw and a preflight that ran out of patience say nothing about the cookie', async () => {
  const cases = {
    'nothing to try': async () => undefined,
    'a throw': async () => { throw new Error('lookup broke'); },
    'no answer in time': () => new Promise(() => {}),
  };
  for (const [label, preflightFn] of Object.entries(cases)) {
    const env = makeEnv();
    const { job } = queued(env, preflightFn);
    for (let i = 0; i < 3; i += 1) env.cookieWatch.noteChange(HOST);
    env.preflight.start(job);
    await tick();
    if (label === 'no answer in time') {
      env.timers[0].fn();
      await tick();
    }
    assert.equal(job.state, 'queued', label);
    assert.equal(env.cookieWatch.isWorthAsking(HOST), true, label);
  }
});

test('a job that goes through the proxy of the user is never preflighted: the request would leave from the address of the app', async () => {
  const env = makeEnv();
  env.proxy = { proxy: { url: 'http://proxy.example:8080' }, mode: 'user-proxy', fingerprint: 'user:abc' };
  let asked = 0;
  const { job } = queued(env, async () => { asked += 1; return DIRECT; });
  env.preflight.start(job);
  await tick();
  assert.equal(asked, 0, 'the caller was not even asked');
  assert.equal(job.state, 'queued', 'on to the browser, with the proxy');
  assert.equal(job.preflightOff, true, 'and the scheduler will not try again');
  assert.equal(env.state.preflightBusy, false);
  assert.equal(env.cookieWatch.isWorthAsking(HOST), true, 'it says nothing about the cookie');
  assert.equal(env.timers.length, 0, 'no give-up timer was left behind');
});

test('a proxy lookup that fails leaves the job to the browser, where the same failure fails it properly', async () => {
  const env = makeEnv();
  env.resolveProxy = async () => { throw new Error('store unreadable'); };
  let asked = 0;
  const { job } = queued(env, async () => { asked += 1; return DIRECT; });
  env.preflight.start(job);
  await tick();
  assert.equal(asked, 0);
  assert.equal(job.state, 'queued');
  assert.equal(job.preflightOff, false);
  assert.equal(env.state.preflightBusy, false);
});
