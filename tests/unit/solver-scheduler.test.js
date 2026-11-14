'use strict';

// server/modules/network/solver/scheduler.js: who runs next, and on what. The real
// jobs, gate, circuit and launch lock are used; the slots are a list, and starting a
// job is a recorder, so nothing here talks to FlareSolverr.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { hostKeyOf } = require('../../server/modules/common/host-utils');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver/errors');
const { createHostGate } = require('../../server/modules/network/solver/host-gate');
const { createCircuit } = require('../../server/modules/network/solver/circuit');
const { createCookieWatch } = require('../../server/modules/network/solver/cookie-watch');
const { createJobs } = require('../../server/modules/network/solver/jobs');
const { createLaunchLock } = require('../../server/modules/network/solver/launch-lock');
const { createScheduler } = require('../../server/modules/network/solver/scheduler');

const SOLVER = 'http://127.0.0.1:8191/v1';
const A = 'https://cf-site.example';
const B = 'https://other-site.example';
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

// A promise the code under test must settle. When a rule is broken it never does, and a test that
// waits for ever is worse than one that fails, so the wait is bounded.
function soon(promise, what, ms = 1000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what} was never answered` })), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function makeEnv({ maxSessions = 1, idleSlots = 0 } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, { hostSpacingMs: 100 });
  const state = createPoolState(cfg);
  state.enabled = true;
  state.maxSessions = maxSessions;
  const timers = [];
  const out = { sessions: [], stateless: [], preflights: [], released: [], closed: [], warns: [] };
  const ports = createPorts({
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const handle = { ms, unref() { return this; } };
      handle.fn = () => { timers.splice(timers.indexOf(handle), 1); fn(); };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => { const at = timers.indexOf(handle); if (at !== -1) timers.splice(at, 1); },
    log: () => {},
    warn: (m) => out.warns.push(m),
    recordError: async () => {},
  }, state);
  const hostGate = createHostGate({ cfg, state, ports });
  const cookieWatch = createCookieWatch({ cfg, ports });
  const circuit = createCircuit({ cfg, ports });
  const jobs = createJobs({ state, cfg, ports });

  const slotList = [];
  for (let i = 0; i < idleSlots; i += 1) slotList.push({ key: i + 1, status: 'idle', dead: false });
  const slots = {
    liveSlots: () => slotList.filter((s) => s.status !== 'closing'),
    newSlot: () => { const slot = { key: slotList.length + 1, status: 'opening', dead: false }; slotList.push(slot); return slot; },
    closeSlot: (slot, reason) => { out.closed.push([slot.key, reason]); slot.status = 'closing'; return Promise.resolve(); },
  };
  const env = { clock, cfg, state, timers, out, hostGate, cookieWatch, circuit, jobs, slotList };
  const launchLock = createLaunchLock({ onFree: () => env.scheduler.schedulePump() });
  env.dispatch = {
    startPreflight: (job) => { out.preflights.push(job); },
    runSession: async (job, slot) => { out.sessions.push([job, slot]); },
    startStateless: async (job, release) => { out.stateless.push([job, release]); },
  };
  env.scheduler = createScheduler({
    state, cfg, ports, hostGate, cookieWatch, circuit, launchLock, slots, jobs, passthrough: { release: (job) => out.released.push(job) }, dispatch: env.dispatch,
  });
  return env;
}

let seq = 0;
function enqueue(env, url, over = {}) {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  const t = env.clock.t;
  const job = {
    seq: (seq += 1),
    request: {},
    url,
    solverUrl: SOLVER,
    hostKey: hostKeyOf(url),
    mode: 'session',
    priority: 'interactive',
    enqueuedAt: t,
    deadlineAt: t + 30_000,
    boundSolve: false,
    label: '',
    state: 'queued',
    attempt: 0,
    counted: false,
    settled: false,
    preflightSeen: 0,
    preflightOff: false,
    slot: null,
    queuedMs: 0,
    resolve,
    reject,
    ...over,
  };
  env.state.queue.push(job);
  return { job, promise };
}

async function pump(env) {
  env.scheduler.schedulePump();
  await tick();
}

const urls = (started) => started.map(([job]) => new URL(job.url).pathname);

test('a job is given a new slot while there is room, and the site, the counters and the spacing are noted', async () => {
  const env = makeEnv();
  const { job } = enqueue(env, `${A}/a`);
  await pump(env);

  assert.equal(env.out.sessions.length, 1);
  const [[started, slot]] = env.out.sessions;
  assert.equal(started, job);
  assert.equal(job.state, 'running');
  assert.equal(job.slot, slot);
  assert.deepEqual(env.state.queue, []);
  assert.equal(env.state.inFlight, 1);
  assert.equal(env.state.counters.sessionJobs, 1);
  assert.equal(env.state.affinity.get('cf-site.example'), slot);
  assert.equal(env.hostGate.nextStartAt('cf-site.example'), env.clock.t + 100);
});

test('a free slot is used before a new one is made, and it becomes busy', async () => {
  const env = makeEnv({ maxSessions: 3, idleSlots: 1 });
  enqueue(env, `${A}/a`);
  await pump(env);
  assert.equal(env.slotList.length, 1);
  assert.equal(env.slotList[0].status, 'busy');
});

test('with every slot busy and no room for another, the job stays queued', async () => {
  const env = makeEnv();
  env.slotList.push({ key: 1, status: 'busy', dead: false });
  const { job } = enqueue(env, `${A}/a`);
  await pump(env);
  assert.equal(job.state, 'queued');
  assert.equal(env.out.sessions.length, 0);
  assert.equal(env.slotList.length, 1, 'no second browser beyond maxSessions');
  assert.equal(env.timers.length, 1, 'only the deadline wakes it');
  assert.equal(env.timers[0].ms, 30_000);
});

test('interactive jobs go before background ones, first come first served inside a class', async () => {
  const env = makeEnv({ idleSlots: 1 });
  // Different sites, so spacing does not come into it.
  enqueue(env, `${A}/background-1`, { priority: 'background' });
  enqueue(env, `${B}/interactive-1`);
  enqueue(env, 'https://third-site.example/interactive-2');
  await pump(env);
  assert.deepEqual(urls(env.out.sessions), ['/interactive-1'], 'one slot, one job');
  env.slotList[0].status = 'idle';
  await pump(env);
  assert.deepEqual(urls(env.out.sessions), ['/interactive-1', '/interactive-2']);
});

test('a site is spaced without holding up another, and then waits for the browser that holds its cookies', async () => {
  const env = makeEnv({ maxSessions: 3, idleSlots: 3 });
  enqueue(env, `${A}/first`);
  enqueue(env, `${A}/second`);
  enqueue(env, `${B}/other`);
  await pump(env);
  assert.deepEqual(urls(env.out.sessions), ['/first', '/other'], 'the second job of the site waits, the other site goes on');
  assert.equal(env.timers.length, 1);
  assert.equal(env.timers[0].ms, 100, 'woken when the spacing is over');

  env.clock.t += 100;
  env.timers[0].fn();
  await tick();
  assert.equal(env.out.sessions.length, 2, 'spacing is over, but the browser with the site\'s cookies is busy: it waits for it');

  env.out.sessions[0][1].status = 'idle';
  await pump(env);
  assert.deepEqual(urls(env.out.sessions), ['/first', '/other', '/second']);
  assert.equal(env.out.sessions[2][1], env.out.sessions[0][1], 'the same browser');
});

test('after the affinity wait the site takes any free browser', async () => {
  const env = makeEnv({ maxSessions: 2, idleSlots: 2 });
  const { clock, cfg } = env;
  enqueue(env, `${A}/first`);
  await pump(env);
  clock.t += 100;
  enqueue(env, `${A}/second`, { enqueuedAt: clock.t - cfg.affinityWaitMs - 1 });
  await pump(env);
  assert.equal(env.out.sessions.length, 2);
  assert.notEqual(env.out.sessions[1][1], env.out.sessions[0][1]);
});

test('a job whose deadline passed in the queue is refused and never started', async () => {
  const env = makeEnv({ idleSlots: 1 });
  const { job, promise } = enqueue(env, `${A}/a`, { deadlineAt: env.clock.t - 1 });
  await pump(env);
  await assert.rejects(soon(promise, 'the job'), (err) => err.code === POOL_ERROR_CODES.QUEUE_TIMEOUT && err.noRetry === true);
  assert.equal(job.settled, true);
  assert.equal(env.state.counters.queueTimeouts, 1);
  assert.equal(env.out.sessions.length, 0);
});

test('a site in its cooldown is refused at pick time, still without a request', async () => {
  const env = makeEnv({ idleSlots: 1 });
  const { promise } = enqueue(env, `${A}/a`);
  env.hostGate.noteBlock('cf-site.example');
  await pump(env);
  await assert.rejects(soon(promise, 'the job'), (err) => err.code === POOL_ERROR_CODES.HOST_COOLDOWN && err.rateLimited === true);
  assert.equal(env.out.sessions.length, 0);
});

test('while FlareSolverr restarts a job waits, and is refused when its patience ends', async () => {
  const env = makeEnv({ idleSlots: 1 });
  env.state.restarting = true;
  const { job, promise } = enqueue(env, `${A}/a`, { deadlineAt: env.clock.t + 5000 });
  await pump(env);
  assert.equal(job.state, 'queued');
  assert.equal(env.out.sessions.length, 0);
  assert.equal(env.timers[0].ms, 5000);

  env.clock.t += 5000;
  env.timers[0].fn();
  await assert.rejects(soon(promise, 'the job'), (err) => err.code === POOL_ERROR_CODES.RESTARTING);
});

test('a one-off job takes the launch lock; the next waits for it and starts the moment it is released', async () => {
  const env = makeEnv();
  const first = enqueue(env, `${A}/a`, { mode: 'stateless' });
  const second = enqueue(env, `${B}/b`, { mode: 'stateless' });
  await pump(env);
  assert.equal(env.out.stateless.length, 1);
  const [[startedJob, release]] = env.out.stateless;
  assert.equal(startedJob, first.job);
  assert.equal(typeof release, 'function');
  assert.equal(second.job.state, 'queued', 'the lock is taken');
  assert.equal(env.state.counters.statelessJobs, 1);

  release();
  await tick();
  assert.equal(env.out.stateless.length, 2);
  assert.equal(env.out.stateless[1][0], second.job);
});

test('a session job runs one-off when the circuit is open or this FlareSolverr has no sessions', async () => {
  const env = makeEnv({ idleSlots: 1 });
  for (let i = 0; i < 3; i += 1) env.circuit.noteFailure('launch');
  const open = enqueue(env, `${A}/a`);
  await pump(env);
  assert.equal(open.job.mode, 'stateless');
  assert.equal(env.out.stateless.length, 1);
  assert.equal(env.out.sessions.length, 0);

  const unsupported = makeEnv({ idleSlots: 1 });
  unsupported.state.sessionsUnsupported = true;
  const job = enqueue(unsupported, `${A}/a`);
  await pump(unsupported);
  assert.equal(job.job.mode, 'stateless');
});

test('a waiting job is tried once per change of the cookie of its site, never more, and the try comes before the browser', async () => {
  const env = makeEnv();
  env.slotList.push({ key: 1, status: 'busy', dead: false });
  const request = { preflight: () => Promise.resolve(null) };
  const waited = enqueue(env, `${A}/waited`, { request });
  await pump(env);
  assert.deepEqual(env.out.preflights, [], 'queued behind a busy browser, with no cookie newer than itself: nothing to try');

  env.cookieWatch.noteChange('cf-site.example');
  await pump(env);
  assert.deepEqual(env.out.preflights, [waited.job]);
  assert.equal(waited.job.preflightSeen, 1);
  assert.equal(env.out.sessions.length, 0, 'it waits for the answer of its preflight');

  await pump(env); // the preflight said no (here: it never took the job)
  assert.equal(env.out.preflights.length, 1, 'never twice for the same cookie');

  env.cookieWatch.noteChange('cf-site.example');
  await pump(env);
  assert.equal(env.out.preflights.length, 2, 'a new cookie, a new try, before the browser is taken');

  env.slotList[0].status = 'idle';
  await pump(env); // the cookie it has now was tried: on to the browser
  assert.deepEqual(urls(env.out.sessions), ['/waited']);
  assert.equal(env.out.preflights.length, 2);
});

test('no preflight for a job with too little time left, one that must not have one, a cookie the site already refused, or while another is being tried', async () => {
  const env = makeEnv({ maxSessions: 4, idleSlots: 4 });
  const request = { preflight: () => Promise.resolve(null) };
  const hurried = enqueue(env, `${A}/hurried`, { request, deadlineAt: env.clock.t + env.cfg.preflightMinBudgetMs - 1 });
  enqueue(env, `${B}/proxied`, { request, preflightOff: true });
  const refused = enqueue(env, 'https://third-site.example/refused', { request });
  const stateless = enqueue(env, 'https://fourth-site.example/cookies', { request, mode: 'stateless' });
  for (const host of ['cf-site.example', 'other-site.example', 'third-site.example', 'fourth-site.example']) env.cookieWatch.noteChange(host);
  env.cookieWatch.noteMiss('third-site.example', 1);
  await pump(env);
  assert.deepEqual(env.out.preflights, []);
  assert.equal(hurried.job.preflightSeen, 1, 'decided against it, for this cookie');
  assert.equal(refused.job.preflightSeen, 1, 'the site already said no to this cookie');
  assert.equal(stateless.job.preflightSeen, 0, 'a job with cookies of its own is never preflighted');
  assert.deepEqual(urls(env.out.sessions).sort(), ['/hurried', '/proxied', '/refused']);
  assert.equal(env.out.stateless.length, 1);

  env.state.preflightBusy = true;
  const queued = enqueue(env, 'https://fifth-site.example/queued', { request });
  env.cookieWatch.noteChange('fifth-site.example');
  await pump(env);
  assert.deepEqual(env.out.preflights, [], 'another preflight is running: this one waits');
  assert.equal(queued.job.state, 'queued');
  assert.equal(queued.job.preflightSeen, 0);

  env.state.preflightBusy = false;
  await pump(env);
  assert.deepEqual(env.out.preflights, [queued.job]);
});

test('a cookie that changed while the job waited for its turn is still tried before the job starts', async () => {
  // The job has already been tried for generation 1; a navigation to the site finishes and the cookie
  // changes again: the job must be tried for it before it spends a spacing slot and a browser.
  const env = makeEnv({ idleSlots: 1 });
  const request = { preflight: () => Promise.resolve(null) };
  const { job } = enqueue(env, `${A}/head`, { request, preflightSeen: 1 });
  env.cookieWatch.noteChange('cf-site.example');
  env.cookieWatch.noteChange('cf-site.example');
  await pump(env);
  assert.deepEqual(env.out.preflights, [job]);
  assert.equal(job.preflightSeen, 2);
  assert.equal(env.out.sessions.length, 0, 'the browser comes after the try');
});

test('requeue sends a job back to wait; a settled one is left alone', async () => {
  const env = makeEnv({ idleSlots: 1 });
  const { job } = enqueue(env, `${A}/a`);
  await pump(env);
  assert.equal(env.state.inFlight, 1);

  env.scheduler.requeue(job);
  assert.equal(job.state, 'queued');
  assert.equal(job.slot, null);
  assert.equal(env.state.inFlight, 0);
  assert.deepEqual(env.state.queue, [job]);
  env.scheduler.requeue(job);
  assert.deepEqual(env.state.queue, [job], 'never queued twice');

  const done = enqueue(env, `${B}/done`);
  env.jobs.settle(done.job, true, {});
  env.scheduler.requeue(done.job);
  assert.equal(env.state.queue.includes(done.job), false);
});

test('a job sent back after the pool was switched off or closed is answered, not left waiting', async () => {
  const off = makeEnv();
  const queued = enqueue(off, `${A}/a`);
  off.state.enabled = false;
  off.scheduler.requeue(queued.job);
  assert.deepEqual(off.out.released, [queued.job], 'the old path takes it');

  const closed = makeEnv();
  const refused = enqueue(closed, `${A}/a`);
  closed.state.shuttingDown = true;
  closed.scheduler.requeue(refused.job);
  await assert.rejects(soon(refused.promise, 'the job'), (err) => err.code === POOL_ERROR_CODES.SHUTTING_DOWN);
});

test('an unexpected failure answers the job with that error, throws its slot away and says so once', async () => {
  const env = makeEnv();
  const slot = { key: 7, status: 'busy', dead: false };
  const first = enqueue(env, `${A}/a`);
  const second = enqueue(env, `${B}/b`);
  const err = new Error('should never happen');

  env.scheduler.failUnexpected(first.job, slot, err);
  env.scheduler.failUnexpected(second.job, { ...slot, dead: true }, err);
  await assert.rejects(soon(first.promise, 'the first job'), (e) => e === err);
  await assert.rejects(soon(second.promise, 'the second job'), (e) => e === err);
  assert.equal(env.state.lastError.kind, 'internal');
  assert.deepEqual(env.out.closed, [[7, 'error']], 'a dead slot is not closed again');
  assert.equal(env.out.warns.length, 1);
});

test('a runner that throws while being started fails that job only, its slot is thrown away, and the scheduler carries on', async () => {
  // One slot and no room for another: if the slot of the job that failed stayed busy, the next job would wait for ever.
  const env = makeEnv({ maxSessions: 1, idleSlots: 1 });
  const boom = new Error('runner exploded');
  env.dispatch.runSession = () => { throw boom; };
  const bad = enqueue(env, `${A}/bad`);
  await pump(env);
  await assert.rejects(soon(bad.promise, 'the job'), (err) => err === boom);
  assert.equal(env.state.inFlight, 0, 'the job is no longer counted');
  assert.deepEqual(env.out.closed, [[1, 'error']], 'the slot it was given is closed');

  env.dispatch.runSession = async (job, slot) => { env.out.sessions.push([job, slot]); };
  enqueue(env, `${B}/good`);
  await pump(env);
  assert.deepEqual(urls(env.out.sessions), ['/good']);
});

test('nothing is scheduled while the pool is off or closing, and the wake timer can be stopped', async () => {
  const env = makeEnv({ idleSlots: 1 });
  enqueue(env, `${A}/a`);
  env.state.enabled = false;
  await pump(env);
  env.state.enabled = true;
  env.state.shuttingDown = true;
  await pump(env);
  assert.equal(env.out.sessions.length, 0);

  env.state.shuttingDown = false;
  env.slotList[0].status = 'busy';
  await pump(env);
  assert.equal(env.timers.length, 1, 'the deadline timer');
  env.scheduler.stopWake();
  assert.equal(env.timers.length, 0);
});

test('a pass that throws is reported once, starts nothing, and the next pass runs as usual', async () => {
  const env = makeEnv({ idleSlots: 1 });
  const prune = env.hostGate.prune;
  env.hostGate.prune = () => { throw new Error('gate broke'); };
  enqueue(env, `${A}/a`);
  await pump(env);
  await pump(env);
  assert.equal(env.out.sessions.length, 0);
  assert.equal(env.out.warns.length, 1, 'said once');
  assert.match(env.out.warns[0], /The scheduler failed: gate broke/);

  env.hostGate.prune = prune;
  await pump(env);
  assert.deepEqual(urls(env.out.sessions), ['/a']);
});
