'use strict';

// server/modules/network/solver/stateless-lane.js: the one-off browser. The transport answers from
// a script, navigation and the scheduler are recorders, and the launch lock and the state are the
// real ones, so a lock that is not given back, or a job that is not answered, shows.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { POOL_ERROR_CODES, REFUSAL_KINDS, refusal } = require('../../server/modules/network/solver/errors');
const { fail } = require('../../server/modules/network/solver/navigation');
const { createLaunchLock } = require('../../server/modules/network/solver/launch-lock');
const { createStatelessLane } = require('../../server/modules/network/solver/stateless-lane');

const SOLVER = 'http://127.0.0.1:8191/v1';
const PROXY = { proxy: { url: 'http://127.0.0.1:3128' }, mode: 'user-proxy', fingerprint: 'user:abcd1234' };
const OK_ANSWER = { httpStatus: 200, body: { status: 'ok', solution: { response: '<html></html>' } } };
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

function makeEnv({ resolveProxy = async () => PROXY } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, {});
  const state = createPoolState(cfg);
  state.enabled = true;
  const out = { requests: [], resolved: [], rejected: [], requeued: [], unexpected: [], used: 0, lockFree: 0 };
  // What the parts the lane leans on answer: the transport's answers in order (an Error is thrown), what
  // startNavigation resolves (a function of the job and of the lane's "cancelled" predicate), and the
  // outcome table's verdict on an answer.
  const script = {
    answers: [],
    startNavigation: async () => clock.t,
    outcome: (seen, meta) => ({ type: 'ok', data: seen.body, meta }),
  };
  const ports = createPorts({ now: () => clock.t, log: () => {}, warn: () => {}, hooks: { noteUsed: () => { out.used += 1; } } }, state);
  const transport = {
    requestStateless: async (solverUrl, url, maxTimeout, cookies, proxy) => {
      out.requests.push({ solverUrl, url, maxTimeout, cookies, proxy });
      const next = script.answers.length ? script.answers.shift() : OK_ANSWER;
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const navigation = {
    startNavigation: (job, cancelled) => script.startNavigation(job, cancelled),
    statelessTimeoutFor: () => 35_000,
    transportOutcome: (err, slot) => fail(err, 'transport', slot ? 'suspect' : 'invalidate'),
    navigationOutcome: (job, slot, seen, meta) => script.outcome(seen, meta),
  };
  const jobs = {
    resolveWith: (job, result) => { out.resolved.push([job, result]); },
    rejectJob: (job, err, kind) => { out.rejected.push([job, err, kind]); },
  };
  const scheduler = {
    requeue: (job) => { out.requeued.push(job); },
    failUnexpected: (job, slot, err) => { out.unexpected.push([job, slot, err]); },
  };
  const launchLock = createLaunchLock({ onFree: () => { out.lockFree += 1; } });
  const lane = createStatelessLane({
    state, ports, transport, resolveProxy, launchLock, navigation, jobs, scheduler,
  });
  return { clock, state, out, script, launchLock, lane, jobs };
}

const newJob = () => ({ url: 'https://cf-site.example/a', solverUrl: SOLVER, request: { cookies: [{ name: 'sid', value: 'x' }] } });

test('a one-off job sends the legacy request with its cookies and the proxy, answers the caller, and gives the lock back', async () => {
  const env = makeEnv();
  const job = newJob();
  await env.lane.start(job, env.launchLock.tryAcquire());

  assert.deepEqual(env.out.requests, [{
    solverUrl: SOLVER, url: job.url, maxTimeout: 35_000, cookies: job.request.cookies, proxy: PROXY.proxy,
  }]);
  assert.equal(env.out.resolved.length, 1);
  const [answered, result] = env.out.resolved[0];
  assert.equal(answered, job);
  assert.equal(result.type, 'ok');
  assert.deepEqual([result.meta.mode, result.meta.proxyMode, result.meta.fingerprint], ['stateless', 'user-proxy', 'user:abcd1234']);
  assert.equal(result.meta.solveMs, 0);
  assert.deepEqual(env.out.rejected, []);
  assert.equal(env.out.lockFree, 1, 'the launch lock is free again');
  assert.notEqual(env.launchLock.tryAcquire(), null);
});

test('a restart that began while the job waited for its turn sends it back to the scheduler: nothing is sent, the lock is freed, the caller is not answered', async () => {
  const env = makeEnv();
  const asked = [];
  // What the real navigation does: it asks the lane's predicate and gives up with null when it says yes.
  env.script.startNavigation = async (job, cancelled) => {
    asked.push(cancelled());
    return cancelled() ? null : env.clock.t;
  };
  env.state.restarting = true;
  const job = newJob();
  await env.lane.start(job, env.launchLock.tryAcquire());

  assert.deepEqual(asked, [true], 'the lane says a restart began');
  assert.deepEqual(env.out.requeued, [job]);
  assert.deepEqual(env.out.requests, []);
  assert.deepEqual(env.out.resolved, []);
  assert.deepEqual(env.out.rejected, []);
  assert.equal(env.out.lockFree, 1);

  env.state.restarting = false;
  await env.lane.start(job, env.launchLock.tryAcquire());
  assert.equal(env.out.requests.length, 1, 'without a restart the same job goes ahead');
});

test('a site whose cooldown opened while the job waited for the launch lock refuses it: nothing is launched, the lock is freed', async () => {
  const env = makeEnv();
  // What the real navigation resolves when the site is blocked by the time the job may start (navigation.js).
  const kind = REFUSAL_KINDS[POOL_ERROR_CODES.HOST_COOLDOWN];
  const cooldown = fail(refusal(POOL_ERROR_CODES.HOST_COOLDOWN), kind, 'keep');
  env.script.startNavigation = async () => cooldown;
  const job = newJob();
  await env.lane.start(job, env.launchLock.tryAcquire());

  assert.deepEqual(env.out.requests, [], 'no request to the site during its cooldown');
  assert.deepEqual(env.out.rejected, [[job, cooldown.error, kind]]);
  assert.deepEqual(env.out.requeued, []);
  assert.equal(env.out.lockFree, 1);
});

test('a solver that does not answer is the raw error for the caller, and the use is noted', async () => {
  const env = makeEnv();
  const refused = new TypeError('fetch failed');
  env.script.answers.push({ transport: refused });
  const job = newJob();
  await env.lane.start(job, env.launchLock.tryAcquire());
  assert.equal(env.out.rejected.length, 1);
  const [rejectedJob, err, kind] = env.out.rejected[0];
  assert.equal(rejectedJob, job);
  assert.equal(err, refused, 'the very same object');
  assert.equal(kind, 'transport');
  assert.equal(env.out.used, 1);
  assert.equal(env.out.lockFree, 1);
  assert.deepEqual(env.out.resolved, []);
});

test('an answer that says an error is the rejection the outcome table made for it', async () => {
  const env = makeEnv();
  const blocked = Object.assign(new Error('blocked'), { rateLimited: true });
  env.script.answers.push({ httpStatus: 500, body: { status: 'error', message: 'Cloudflare has blocked this request.' } });
  env.script.outcome = () => fail(blocked, 'blocked', 'keep');
  await env.lane.start(newJob(), env.launchLock.tryAcquire());
  assert.deepEqual(env.out.rejected.map(([, err, kind]) => [err, kind]), [[blocked, 'blocked']]);
  assert.equal(env.out.used, 1, 'FlareSolverr was reached, so the idle watcher is told');
});

test('something that should never fail still gives the lock back and answers the caller with an internal error', async () => {
  const boom = new Error('proxy store unreadable');
  const env = makeEnv({ resolveProxy: async () => { throw boom; } });
  await env.lane.start(newJob(), env.launchLock.tryAcquire());
  assert.deepEqual(env.out.rejected.map(([, err, kind]) => [err, kind]), [[boom, 'internal']]);
  assert.equal(env.out.lockFree, 1);
  assert.deepEqual(env.out.requests, [], 'nothing is sent without the proxy');
});

test('a failure while answering the caller is handed to the scheduler, which throws the job away', async () => {
  const env = makeEnv();
  const boom = new Error('answering broke');
  env.jobs.resolveWith = () => { throw boom; };
  const job = newJob();
  await env.lane.start(job, env.launchLock.tryAcquire());
  assert.deepEqual(env.out.unexpected, [[job, null, boom]]);
  assert.equal(env.out.lockFree, 1, 'the lock was already given back before the answer');
});

test('the fallback counts the job, waits for the launch lock, and runs the same lane', async () => {
  const env = makeEnv();
  const held = env.launchLock.tryAcquire();
  const running = env.lane.runFallback(newJob());
  await tick();
  assert.equal(env.state.counters.statelessJobs, 1);
  assert.deepEqual(env.out.requests, [], 'the lock is taken: nothing is launched');

  held();
  await running;
  assert.equal(env.out.requests.length, 1);
  assert.equal(env.out.resolved.length, 1);
  assert.notEqual(env.launchLock.tryAcquire(), null, 'and the lock is free at the end');
});

test('a fallback that wakes up in a pool that is closing is refused cleanly and gives the lock back', async () => {
  const env = makeEnv();
  const held = env.launchLock.tryAcquire();
  const running = env.lane.runFallback(newJob());
  await tick();
  env.state.shuttingDown = true;
  held();
  await running;

  assert.deepEqual(env.out.requests, []);
  assert.equal(env.out.rejected.length, 1);
  assert.equal(env.out.rejected[0][1].code, POOL_ERROR_CODES.SHUTTING_DOWN);
  assert.equal(env.out.rejected[0][1].noRetry, true);
  assert.notEqual(env.launchLock.tryAcquire(), null);
});
