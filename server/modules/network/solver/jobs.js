'use strict';

const { PRIORITIES } = require('../solver-context');
const { REFUSAL_KINDS, refusal } = require('./errors');

// A job's bookkeeping: counted while it is in flight, taken off the queue and
// answered exactly once. No decision about WHEN a job runs lives here (that is
// scheduler.js), nor about how (the two runners).
//
// A job's `state`: 'queued' | 'preflighting' | 'running' | 'passthrough' |
// 'settled'. `queued` and `preflighting` are "waiting" (isWaiting) and sit in
// state.queue.
//
// Interface:
//   beginRun / endRun          count the job as in flight (idempotent each way)
//   isWaiting, removeFromQueue
//   settle(job, resolved, value)   answers the job once; false when already answered
//   rejectJob(job, err, kind)      records the kind for the status, then settle
//   rejectQueued(code)             refuses every job that is still 'queued'
//   resolveWith(job, result)       answers with a navigation's result, noting the use
//   detach(promise)                background work: a rejection is logged once, never unhandled
//   waitBudget(priority), byPriority   the queue's patience and ordering

// The position of each priority, strongest first.
const PRIORITY_ORDER = Object.freeze(Object.fromEntries(PRIORITIES.map((priority, position) => [priority, position])));

const isWaiting = (job) => job.state === 'queued' || job.state === 'preflighting';

function beginRun(ctx, job) {
  if (job.counted) return;
  job.counted = true;
  ctx.state.inFlight += 1;
}

function endRun(ctx, job) {
  const { state } = ctx;
  if (!job.counted) return;
  job.counted = false;
  state.inFlight -= 1;
  if (state.inFlight === 0) {
    for (const done of state.drainWaiters.splice(0)) done();
  }
}

function removeFromQueue(ctx, job) {
  const at = ctx.state.queue.indexOf(job);
  if (at !== -1) ctx.state.queue.splice(at, 1);
}

function settle(ctx, job, resolved, value) {
  if (job.settled) return false;
  job.settled = true;
  job.state = 'settled';
  removeFromQueue(ctx, job);
  endRun(ctx, job);
  if (resolved) job.resolve(value); else job.reject(value);
  return true;
}

function rejectJob(ctx, job, err, kind) {
  ctx.ports.noteLastError(kind || REFUSAL_KINDS[err && err.code] || (err && err.kind) || 'error');
  settle(ctx, job, false, err);
}

function rejectQueued(ctx, code) {
  for (const job of ctx.state.queue.filter((j) => j.state === 'queued')) rejectJob(ctx, job, refusal(code));
}

function resolveWith(ctx, job, result) {
  ctx.ports.noteUsed();
  return settle(ctx, job, true, {
    data: result.data,
    mode: result.meta.mode,
    proxyMode: result.meta.proxyMode,
    fingerprint: result.meta.fingerprint,
    queuedMs: job.queuedMs,
    solveMs: result.meta.solveMs,
  });
}

// Background work whose failure is already handled inside: if one of these
// still rejects, say so once instead of letting it escape as an unhandled rejection.
function detach(ctx, promise) {
  promise.catch((err) => ctx.ports.warnOnce(`detached:${err && err.message}`, `Unexpected error: ${err && err.message}`));
}

function createJobs({ state, cfg, ports }) {
  const ctx = { state, ports };
  return {
    isWaiting,
    beginRun: (job) => beginRun(ctx, job),
    endRun: (job) => endRun(ctx, job),
    removeFromQueue: (job) => removeFromQueue(ctx, job),
    settle: (job, resolved, value) => settle(ctx, job, resolved, value),
    rejectJob: (job, err, kind) => rejectJob(ctx, job, err, kind),
    rejectQueued: (code) => rejectQueued(ctx, code),
    resolveWith: (job, result) => resolveWith(ctx, job, result),
    detach: (promise) => detach(ctx, promise),
    waitBudget: (priority) => (priority === 'background' ? cfg.queue.backgroundWaitMaxMs : cfg.queue.interactiveWaitMaxMs),
    priorityRank: (priority) => PRIORITY_ORDER[priority],
    byPriority: (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.seq - b.seq,
  };
}

module.exports = { createJobs };
