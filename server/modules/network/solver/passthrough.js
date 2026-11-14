'use strict';

const { MESSAGES } = require('../../../config/solver');
const { hostKeyOf } = require('../../common/host-utils');
const { POOL_ERROR_CODES, REFUSAL_KINDS, refusal } = require('./errors');
const { isPlainObject } = require('./plain-object');
const { statelessPayload } = require('./transport');
const { createSiteLimit } = require('./site-limit');

// The pool switched off: what the app did before the pool existed. One stateless
// request with the legacy payload, no queue, gate, lock or state, and the legacy
// error for any answer that is not 2xx. This is the rollback path, so it talks to
// FlareSolverr through the raw `post` (a transport error is rethrown as the same
// object) and shares nothing with the pooled lanes except the proxy lookup.
//
// One thing it does add to what 3.1.2 did: at most cfg.passThroughSiteLimit calls per site are in flight at a time
// (site-limit.js), the others waiting their turn first come first served. Identical calls are already one (single-flight),
// but twenty DIFFERENT pages of one site would otherwise be twenty Chromes at once. What is sent is untouched: the payload
// and the time limit of a call are exactly 3.1.2's, and the wait comes before the call, never out of its time.
// The wait itself is bounded the way a queued job's is: a call waits only as long as its caller declared (or the
// queue's patience for its priority, intake.js), an interactive call goes before a background one, and no more
// than cfg.queue.maxQueued wait for one site; the rest are refused with the pool's own "busy" errors. Without that,
// calls nobody waits for any more would still start a Chrome each, and a burst would delay the next reader.
//
// Interface:
//   passThrough(request, patience)   Promise of { data, mode: 'stateless', ... } or the legacy rejection;
//                          patience = { rank, deadlineAt } (a lower rank goes first; deadlineAt is the latest
//                          moment the call may still be waiting for its turn), none for no limit
//   release(job)           a job that was waiting when the pool was switched off (or
//                          sent back to the queue after that): out of the queue,
//                          unaffected by the pool; settle() finishes it

async function sendOnce(ctx, request, waitedMs) {
  const { cfg, ports } = ctx;
  const proxyInfo = await ctx.resolveProxy(request.solverUrl);
  const maxTimeout = Number.isFinite(request.maxTimeoutMs) && request.maxTimeoutMs > 0 ? request.maxTimeoutMs : cfg.requestMaxTimeoutMs;
  const payload = statelessPayload(request.url, maxTimeout, request.cookies, proxyInfo.proxy);
  const startedAt = ports.now();
  const res = await ctx.post(request.solverUrl, payload, { timeoutMs: maxTimeout + cfg.requestAbortGraceMs });
  const httpStatus = Number.isInteger(res && res.httpStatus) ? res.httpStatus : 0;
  if (httpStatus < 200 || httpStatus > 299 || !isPlainObject(res.body)) throw new Error(MESSAGES.http(httpStatus));
  return {
    data: res.body, mode: 'stateless', proxyMode: proxyInfo.mode, fingerprint: proxyInfo.fingerprint, queuedMs: waitedMs, solveMs: ports.now() - startedAt,
  };
}

// The pool's own refusal, with the kind System Health shows as the last error (as intake.js does).
function refused(ctx, code) {
  ctx.ports.noteLastError(REFUSAL_KINDS[code]);
  return refusal(code);
}

// Waits for the site's turn, but not past `patience.deadlineAt` (no timer when there is none), and not at all
// when the line for the site is already as long as the pool's own queue may be. A call that gives up leaves the
// line; one that gets its place at the very moment its time runs out keeps it.
async function takeTurn(ctx, key, patience) {
  const { siteLimit, ports, cfg } = ctx;
  if (siteLimit.waitingFor(key) >= cfg.queue.maxQueued) throw refused(ctx, POOL_ERROR_CODES.QUEUE_FULL);
  const turn = siteLimit.acquire(key, patience.rank || 0);
  if (!Number.isFinite(patience.deadlineAt)) return turn;
  let giveUp;
  const timedOut = new Promise((_, reject) => {
    giveUp = ports.startTimer(() => {
      if (turn.cancel()) reject(refused(ctx, POOL_ERROR_CODES.QUEUE_TIMEOUT));
    }, Math.max(0, patience.deadlineAt - ports.now()));
  });
  try {
    return await Promise.race([turn, timedOut]);
  } finally {
    ports.stopTimer(giveUp);
  }
}

// Takes the site's turn, sends, and always gives the place back, whatever the call did: a waiter must never be stuck behind a failure.
async function passThrough(ctx, request, patience = {}) {
  const askedAt = ctx.ports.now();
  const release = await takeTurn(ctx, hostKeyOf(request.url), patience);
  const waitedMs = ctx.ports.now() - askedAt;
  try {
    return await sendOnce(ctx, request, waitedMs);
  } finally {
    release();
  }
}

function releaseToPassThrough(ctx, job) {
  const { jobs } = ctx;
  jobs.removeFromQueue(job);
  jobs.endRun(job);
  job.state = 'passthrough'; // out of the queue and unaffected by the pool; settle() finishes it
  const patience = { rank: jobs.priorityRank(job.priority), deadlineAt: job.deadlineAt };
  passThrough(ctx, job.request, patience).then((value) => jobs.settle(job, true, value), (err) => jobs.settle(job, false, err));
}

/** { cfg, ports, post, resolveProxy, jobs } -> the interface in the header. */
function createPassThrough({ cfg, ports, post, resolveProxy, jobs }) {
  const ctx = { cfg, ports, post, resolveProxy, jobs, siteLimit: createSiteLimit(cfg.passThroughSiteLimit) };
  return {
    passThrough: (request, patience) => passThrough(ctx, request, patience),
    release: (job) => releaseToPassThrough(ctx, job),
  };
}

module.exports = { createPassThrough };
