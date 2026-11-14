'use strict';

const { hostKeyOf } = require('../../common/host-utils');
const { PRIORITIES, DEFAULT_PRIORITY, getSolverContext, mergeSolverContext } = require('../solver-context');
const { POOL_ERROR_CODES, REFUSAL_KINDS, refusal } = require('./errors');

// The front door: run(request, ctx) validates a request, decides what happens to
// it (refused at once, sent down the pass-through path because the pool is off,
// or queued for the scheduler) and hands the caller its handle. Everything after
// the job is in the queue is scheduler.js.
//
// A job is { seq, request, url, solverUrl, hostKey, mode, priority, enqueuedAt,
// deadlineAt, solveDeadlineAt, boundSolve, label, state, attempt, counted, settled, preflightSeen,
// preflightOff, slot, queuedMs, resolve, reject }, documented at buildJob().
// Interface: run(request, callCtx). Private state: the job sequence number.

// Why a job is refused before it is queued, or null.
function admissionRefusal(ctx, job, t) {
  const { state, cfg } = ctx;
  if (state.shuttingDown) return POOL_ERROR_CODES.SHUTTING_DOWN;
  if (t < state.downUntil) return POOL_ERROR_CODES.DOWN;
  if (ctx.hostGate.isBlocked(job.hostKey, t)) return POOL_ERROR_CODES.HOST_COOLDOWN;
  if (state.queue.length >= cfg.queue.maxQueued) return POOL_ERROR_CODES.QUEUE_FULL;
  return null;
}

// How long a call may WAIT for its turn, and how it ranks: what the caller declared, never more than the queue's
// patience for its priority. The same for a queued job and for a call on the pool-off lane (passthrough.js).
function patienceOf(ctx, merged, t) {
  const priority = PRIORITIES.includes(merged.priority) ? merged.priority : DEFAULT_PRIORITY;
  const declared = Number.isFinite(merged.deadlineAt) ? merged.deadlineAt : Infinity;
  return { priority, declared, deadlineAt: Math.min(declared, t + ctx.jobs.waitBudget(priority)) };
}

// mode: 'session' unless cookies were supplied (never given to a shared browser), the caller declared
// oneOff (a browser of its own: solver-context.js says why) or the pool is known not to be working.
// deadlineAt bounds how long the job may WAIT.
// state: 'queued' -> 'preflighting' -> 'running' -> 'settled' (see jobs.js).
// preflightSeen: the site's cookie generation the job was queued in, or last tried (cookie-watch.js);
// preflightOff: set when a preflight can never apply to it (the user's proxy is in use).
function buildJob(ctx, request, merged, t, settleWith) {
  const { state, circuit } = ctx;
  const { priority, declared, deadlineAt } = patienceOf(ctx, merged, t);
  const hasCookies = Array.isArray(request.cookies) && request.cookies.length > 0;
  const hostKey = hostKeyOf(request.url);
  const job = {
    seq: ctx.nextJobSeq,
    request,
    url: request.url,
    solverUrl: request.solverUrl,
    hostKey,
    // Cookies are never given to a shared browser; neither is a call that asked for a browser of its
    // own, nor anything while the pool is known not to be working.
    mode: hasCookies || merged.oneOff === true || circuit.isOpen(t) || state.sessionsUnsupported ? 'stateless' : 'session',
    priority,
    enqueuedAt: t,
    deadlineAt,
    solveDeadlineAt: declared, // what the caller declared, uncapped: boundSolve bounds the navigation by it (navigation.js)
    boundSolve: merged.boundSolve === true,
    label: merged.label || '',
    state: 'queued',
    attempt: 0,
    counted: false,
    settled: false,
    preflightSeen: ctx.cookieWatch.generation(hostKey),
    preflightOff: false,
    slot: null,
    queuedMs: 0,
    resolve: settleWith.resolve,
    reject: settleWith.reject,
  };
  ctx.nextJobSeq += 1;
  return job;
}

// The caller's handle. A caller that joins this job (same site, same page) brings
// its own patience: the job takes the stronger priority and the later deadline, so
// a short probe can never fail an interactive caller that is waiting for the same answer.
function buildHandle(ctx, job, promise) {
  const { jobs } = ctx;
  return {
    promise,
    promote(wanted) {
      if (!jobs.isWaiting(job)) return;
      const stronger = PRIORITIES.includes(wanted) ? wanted : PRIORITIES.at(-1); // what is not understood is the weakest
      if (jobs.priorityRank(stronger) < jobs.priorityRank(job.priority)) job.priority = stronger;
      job.deadlineAt = Math.max(job.deadlineAt, ctx.ports.now() + jobs.waitBudget(stronger));
      job.solveDeadlineAt = Math.max(job.solveDeadlineAt, job.deadlineAt);
      ctx.wake();
    },
    extendDeadline(epochMs) {
      if (!jobs.isWaiting(job) || !Number.isFinite(epochMs)) return;
      job.deadlineAt = Math.max(job.deadlineAt, epochMs);
      job.solveDeadlineAt = Math.max(job.solveDeadlineAt, epochMs);
      ctx.wake();
    },
  };
}

// A handle for a request that never enters the pool; nothing to promote.
function inertHandle(promise) {
  promise.catch(() => {}); // a caller that dropped the handle must not crash the process
  return { promise, promote() {}, extendDeadline() {} };
}

/**
 * Queues a FlareSolverr request. request = { url, solverUrl, cookies?, maxTimeoutMs?,
 * preflight? }; callCtx = { priority?, deadlineAt?, label?, boundSolve?, oneOff? } laid over what the
 * surrounding code declared (solver-context.js).
 * Returns { promise, promote(priority), extendDeadline(epochMs) }; the promise resolves
 * { data, mode, proxyMode, fingerprint, queuedMs, solveMs } or rejects (see POOL_ERROR_CODES).
 */
function run(ctx, request, callCtx) {
  const { state, ports, jobs } = ctx;
  if (!request || typeof request.url !== 'string' || !request.url || typeof request.solverUrl !== 'string' || !request.solverUrl) {
    throw new TypeError('A solver request needs a url and a solverUrl.');
  }
  if (state.shuttingDown) {
    ports.noteLastError(REFUSAL_KINDS[POOL_ERROR_CODES.SHUTTING_DOWN]);
    return inertHandle(Promise.reject(refusal(POOL_ERROR_CODES.SHUTTING_DOWN)));
  }
  const merged = mergeSolverContext(getSolverContext(), callCtx);
  const t = ports.now();
  if (!state.enabled) {
    const { priority, deadlineAt } = patienceOf(ctx, merged, t);
    return inertHandle(ctx.passthrough.passThrough(request, { rank: jobs.priorityRank(priority), deadlineAt }));
  }
  const settleWith = {};
  const promise = new Promise((res, rej) => { settleWith.resolve = res; settleWith.reject = rej; });
  promise.catch(() => {}); // a caller that dropped the handle must not crash the process
  const job = buildJob(ctx, request, merged, t, settleWith);
  const handle = buildHandle(ctx, job, promise);

  const refusalCode = admissionRefusal(ctx, job, t);
  if (refusalCode) {
    jobs.rejectJob(job, refusal(refusalCode));
    return handle;
  }
  state.counters.jobs += 1;
  state.queue.push(job);
  ctx.wake();
  return handle;
}

/** { state, cfg, ports, hostGate, cookieWatch, circuit, jobs, passthrough, wake } -> { run }. */
function createIntake({ state, cfg, ports, hostGate, cookieWatch, circuit, jobs, passthrough, wake }) {
  const ctx = { state, cfg, ports, hostGate, cookieWatch, circuit, jobs, passthrough, wake, nextJobSeq: 1 };
  return { run: (request, callCtx) => run(ctx, request, callCtx) };
}

module.exports = { createIntake };
