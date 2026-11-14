'use strict';

// server/modules/network/solver/session-runner.js: one job on the slot the scheduler gave it. Every
// part it leans on (sessions, navigation, the transport, the release, the scheduler) is a script or
// a recorder, so each way an attempt can end, and what the caller and the slot get for it, is visible.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL, MESSAGES } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { POOL_ERROR_CODES, REFUSAL_KINDS, refusal } = require('../../server/modules/network/solver/errors');
const { fail } = require('../../server/modules/network/solver/navigation');
const { createSessionRunner } = require('../../server/modules/network/solver/session-runner');

const SOLVER = 'http://127.0.0.1:8191/v1';
const PROXY = { proxy: { url: 'http://127.0.0.1:3128' }, mode: 'user-proxy', fingerprint: 'user:abcd1234' };
const OK_ANSWER = { httpStatus: 200, body: { status: 'ok', solution: { response: '<html></html>' } } };

function makeEnv({ resolveProxy = async () => PROXY } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, {});
  const out = {
    steps: [], requests: [], resolved: [], rejected: [], requeued: [], released: [], dropped: [], fallbacks: [], unexpected: [], used: 0,
  };
  // What each part answers; a function is called with the slot / job it was given.
  const script = {
    recycleReason: null,
    killOnRecycle: false,
    ready: { ok: true },
    startedAt: clock.t,
    request: OK_ANSWER,
    outcome: (seen, meta) => ({ type: 'ok', data: seen.body, meta }),
  };
  const ports = createPorts({ now: () => clock.t, log: () => {}, warn: () => {}, hooks: { noteUsed: () => { out.used += 1; } } }, {});
  const sessions = {
    recycleReason: () => script.recycleReason,
    recycleSlot: async (slot, why) => {
      out.steps.push(`recycle:${why}`);
      if (script.killOnRecycle) slot.dead = true;
    },
    confirmSession: async (slot) => {
      out.steps.push('confirm');
      return typeof script.ready === 'function' ? script.ready(slot) : script.ready;
    },
  };
  const navigation = {
    startNavigation: async (job, cancelled) => {
      out.steps.push('start');
      return cancelled() ? null : script.startedAt;
    },
    maxTimeoutFor: () => 30_000,
    navigationOutcome: (job, slot, seen, meta) => script.outcome(seen, meta),
    transportOutcome: (err) => fail(err, 'transport', 'suspect'),
    releaseStart: () => { out.steps.push('release-start'); },
  };
  const transport = {
    requestInSession: async (slot, url, maxTimeout, timeoutMs) => {
      out.steps.push('request');
      out.requests.push({ url, maxTimeout, timeoutMs });
      return typeof script.request === 'function' ? script.request(slot) : script.request;
    },
  };
  const slots = { dropSlot: (slot) => { out.dropped.push(slot); } };
  const slotRelease = { releaseSlot: async (slot, action, kind) => { out.released.push([slot, action, kind]); } };
  const jobs = {
    resolveWith: (job, result) => { out.resolved.push([job, result]); },
    rejectJob: (job, err, kind) => { out.rejected.push([job, err, kind]); },
  };
  const scheduler = {
    requeue: (job) => { out.requeued.push(job); },
    failUnexpected: (job, slot, err) => { out.unexpected.push([job, slot, err]); },
  };
  const statelessLane = { runFallback: async (job) => { out.fallbacks.push(job); } };
  const runner = createSessionRunner({
    cfg, ports, transport, resolveProxy, slots, sessions, navigation, slotRelease, jobs, scheduler, statelessLane,
  });
  return { clock, cfg, out, script, runner, jobs, slotRelease };
}

const newJob = (over = {}) => ({ url: 'https://cf-site.example/a', solverUrl: SOLVER, attempt: 0, ...over });
const newSlot = (over = {}) => ({ key: 1, id: 'ss-1-a-1', dead: false, status: 'busy', proxyMode: 'user-proxy', fingerprint: 'user:abcd1234', ...over });

test('a job on a healthy slot confirms the session, navigates, answers the caller, and only then tidies the slot', async () => {
  const env = makeEnv();
  const job = newJob();
  const slot = newSlot();
  await env.runner.run(job, slot);

  assert.deepEqual(env.out.steps, ['confirm', 'start', 'request']);
  assert.deepEqual(env.out.requests, [{ url: job.url, maxTimeout: 30_000, timeoutMs: 30_000 + env.cfg.requestAbortGraceMs }]);
  assert.equal(env.out.resolved.length, 1);
  const [answered, result] = env.out.resolved[0];
  assert.equal(answered, job);
  assert.deepEqual(result.meta, { mode: 'session', proxyMode: 'user-proxy', fingerprint: 'user:abcd1234', solveMs: 0 });
  assert.deepEqual(env.out.released, [[slot, 'keep', undefined]]);
  assert.deepEqual(env.out.requeued, []);
});

test('a session that can no longer serve the next job is recycled first, and the job goes on with a new one', async () => {
  const env = makeEnv();
  env.script.recycleReason = 'age';
  await env.runner.run(newJob(), newSlot());
  assert.deepEqual(env.out.steps, ['recycle:age', 'confirm', 'start', 'request']);
  assert.equal(env.out.resolved.length, 1);
});

test('a restart that took the slot at any step before anything was sent sends the job back to the queue, forgetting a slot that is still registered', async () => {
  // While the proxy is looked up: the slot is already dead, so there is nothing to forget.
  let env = makeEnv();
  let job = newJob();
  let slot = newSlot({ dead: true });
  await env.runner.run(job, slot);
  assert.deepEqual(env.out.requeued, [job]);
  assert.deepEqual(env.out.steps, []);
  assert.deepEqual(env.out.dropped, []);
  assert.deepEqual(env.out.released, []);

  // While the old session is being recycled.
  env = makeEnv();
  env.script.recycleReason = 'uses';
  env.script.killOnRecycle = true;
  job = newJob();
  slot = newSlot();
  await env.runner.run(job, slot);
  assert.deepEqual(env.out.steps, ['recycle:uses']);
  assert.deepEqual(env.out.requeued, [job]);

  // While the session is confirmed: the confirmation says so, and the slot is still on the books.
  env = makeEnv();
  env.script.ready = { restart: true };
  job = newJob();
  slot = newSlot();
  await env.runner.run(job, slot);
  assert.deepEqual(env.out.requeued, [job]);
  assert.deepEqual(env.out.dropped, [slot]);
  assert.deepEqual(env.out.requests, []);

  // Or it died while the answer was on its way.
  env = makeEnv();
  env.script.ready = (s) => { s.dead = true; return { ok: true }; };
  job = newJob();
  slot = newSlot();
  await env.runner.run(job, slot);
  assert.deepEqual(env.out.requeued, [job]);
  assert.deepEqual(env.out.dropped, [], 'a dead slot is already gone');
});

test('a restart that began while the job waited out its site\'s spacing cancels the navigation and requeues the job', async () => {
  const env = makeEnv();
  env.script.startedAt = null;
  const job = newJob();
  const slot = newSlot();
  await env.runner.run(job, slot);
  assert.deepEqual(env.out.requeued, [job]);
  assert.deepEqual(env.out.requests, []);
  assert.deepEqual(env.out.released, [], 'the slot is not released: the restart already took it');
});

test('a site whose cooldown opened while the session was being opened refuses the job: nothing is sent, and the session is kept', async () => {
  const env = makeEnv();
  // What the real navigation resolves when the site is blocked by the time the job may start (navigation.js).
  const kind = REFUSAL_KINDS[POOL_ERROR_CODES.HOST_COOLDOWN];
  const cooldown = fail(refusal(POOL_ERROR_CODES.HOST_COOLDOWN), kind, 'keep');
  env.script.startedAt = cooldown;
  const job = newJob();
  const slot = newSlot();
  await env.runner.run(job, slot);
  assert.deepEqual(env.out.requests, [], 'no request to the site during its cooldown');
  assert.deepEqual(env.out.rejected, [[job, cooldown.error, kind]]);
  assert.deepEqual(env.out.released, [[slot, 'keep', kind]]);
  assert.deepEqual(env.out.requeued, []);
});

test('no session could be opened: the empty slot is dropped and the job runs in a one-off browser', async () => {
  const env = makeEnv();
  env.script.ready = { fallback: true };
  const job = newJob();
  const slot = newSlot();
  await env.runner.run(job, slot);
  assert.deepEqual(env.out.dropped, [slot]);
  assert.deepEqual(env.out.fallbacks, [job]);
  assert.deepEqual(env.out.requests, []);
  assert.deepEqual(env.out.released, []);
  assert.deepEqual(env.out.resolved, []);
});

test('a solver that does not answer while the session is confirmed or used is the raw error, and the slot is suspect', async () => {
  const refused = new TypeError('fetch failed');
  let env = makeEnv();
  env.script.ready = { transport: refused };
  let slot = newSlot();
  await env.runner.run(newJob(), slot);
  assert.deepEqual(env.out.rejected.map(([, err, kind]) => [err, kind]), [[refused, 'transport']]);
  assert.deepEqual(env.out.released, [[slot, 'suspect', 'transport']]);
  assert.equal(env.out.used, 1);
  assert.deepEqual(env.out.steps, ['confirm', 'release-start'], 'no navigation: the site is given its spacing back');

  env = makeEnv();
  env.script.request = { transport: refused };
  slot = newSlot();
  await env.runner.run(newJob(), slot);
  assert.deepEqual(env.out.rejected.map(([, err, kind]) => [err, kind]), [[refused, 'transport']]);
  assert.deepEqual(env.out.released, [[slot, 'suspect', 'transport']]);
  assert.deepEqual(env.out.steps, ['confirm', 'start', 'request'], 'a navigation that really started keeps its spacing');
});

test('a request the transport would not send is a restart when the slot is dead, and otherwise an internal error that throws the session away', async () => {
  let env = makeEnv();
  env.script.request = (s) => { s.dead = true; return { refused: true }; };
  let job = newJob();
  await env.runner.run(job, newSlot());
  assert.deepEqual(env.out.requeued, [job]);
  assert.deepEqual(env.out.rejected, []);

  env = makeEnv();
  env.script.request = { refused: true };
  job = newJob();
  const slot = newSlot();
  await env.runner.run(job, slot);
  assert.equal(env.out.rejected.length, 1);
  const [rejectedJob, err, kind] = env.out.rejected[0];
  assert.equal(rejectedJob, job);
  assert.equal(err.message, MESSAGES.sessionNotReady);
  assert.equal(kind, 'internal');
  assert.deepEqual(env.out.released, [[slot, 'recycle', 'internal']]);
  assert.deepEqual(env.out.requeued, []);
});

test('an error the outcome table asks to retry puts the job back with one attempt used, and the slot is released after it', async () => {
  const env = makeEnv();
  const dead = new Error('the browser died');
  env.script.outcome = () => fail(dead, 'driver', 'recycle', { retry: true });
  const job = newJob();
  const slot = newSlot();
  await env.runner.run(job, slot);
  assert.equal(job.attempt, 1);
  assert.deepEqual(env.out.requeued, [job]);
  assert.deepEqual(env.out.rejected, [], 'the caller is not told yet');
  assert.deepEqual(env.out.released, [[slot, 'recycle', 'driver']]);
  assert.equal(env.out.used, 1);
});

test('an error with no retry is the rejection the table made, with the kind for the status, and the slot gets the action the table chose', async () => {
  const env = makeEnv();
  const blocked = Object.assign(new Error('blocked'), { rateLimited: true });
  env.script.outcome = () => fail(blocked, 'blocked', 'keep');
  const job = newJob();
  const slot = newSlot();
  await env.runner.run(job, slot);
  assert.deepEqual(env.out.rejected, [[job, blocked, 'blocked']]);
  assert.deepEqual(env.out.released, [[slot, 'keep', 'blocked']]);
  assert.deepEqual(env.out.requeued, []);
});

test('a proxy lookup that fails fails the job with that error and keeps the session: nothing is sent without the proxy', async () => {
  const boom = new Error('the store is unreadable');
  const env = makeEnv({ resolveProxy: async () => { throw boom; } });
  const job = newJob();
  const slot = newSlot();
  await env.runner.run(job, slot);
  assert.deepEqual(env.out.rejected, [[job, boom, 'internal']]);
  assert.deepEqual(env.out.released, [[slot, 'keep', 'internal']]);
  assert.deepEqual(env.out.steps, []);
});

test('something that should never fail, while the attempt runs, answers the caller and throws the session away', async () => {
  const env = makeEnv();
  const boom = new Error('sessions broke');
  env.script.ready = () => { throw boom; };
  const job = newJob();
  const slot = newSlot();
  await env.runner.run(job, slot);
  assert.deepEqual(env.out.rejected, [[job, boom, 'internal']]);
  assert.deepEqual(env.out.released, [[slot, 'recycle', 'internal']]);
});

test('something that fails while the job is being concluded is handed to the scheduler, and run() still never rejects', async () => {
  const env = makeEnv();
  const boom = new Error('answering broke');
  env.jobs.resolveWith = () => { throw boom; };
  const job = newJob();
  const slot = newSlot();
  await assert.doesNotReject(env.runner.run(job, slot));
  assert.deepEqual(env.out.unexpected, [[job, slot, boom]]);
  assert.deepEqual(env.out.released, [], 'the scheduler throws the slot away');
});

test('a restart that killed FlareSolverr while the session was being opened or listed requeues the job: the connection error is the restart, not the job\'s failure', async () => {
  const refused = new TypeError('fetch failed');
  const env = makeEnv();
  env.script.ready = (slot) => { slot.dead = true; return { transport: refused }; };
  const job = newJob();
  const slot = newSlot();
  await env.runner.run(job, slot);

  assert.deepEqual(env.out.requeued, [job], 'nothing had been sent for the page: the job waits for the new FlareSolverr');
  assert.deepEqual(env.out.rejected, [], 'the raw error is not handed to the caller');
  assert.deepEqual(env.out.requests, []);
  assert.deepEqual(env.out.released, []);

  // The same failure with the slot alive is a real one: FlareSolverr did not answer, and the caller hears it.
  const real = makeEnv();
  real.script.ready = { transport: refused };
  const realJob = newJob();
  await real.runner.run(realJob, newSlot());
  assert.deepEqual(real.out.requeued, []);
  assert.equal(real.out.rejected[0][1], refused);
});
