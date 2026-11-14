'use strict';

const { MESSAGES } = require('../../../config/solver');
const { isTimeoutError } = require('./classify');
const { POOL_ERROR_CODES, REFUSAL_KINDS, refusal, rejection } = require('./errors');

// One navigation, whichever lane sends it: how long it may take, the moment it
// may start, and what its answer means for the job and for the session it ran on
// (the outcome table). Pure decisions over the answer; the effects it has are
// on the gate, the circuit, the counters and the slot it was handed.
//
// An outcome is { type: 'ok', data, meta } or the result of fail():
// { type: 'error', error, kind, slotAction, retry? }, where slotAction is one of
// slot-release.js's actions. `meta` is { mode, proxyMode, fingerprint, solveMs }.
//
// Interface: maxTimeoutFor(job, startedAt) for a session, statelessTimeoutFor(job) for a one-off
// browser, startNavigation(job, cancelled), navigationOutcome(job, slot, seen, meta),
// transportOutcome(err, slot), releaseStart(job). `slot` is null on the stateless lane.
// startNavigation resolves the start time, null when cancelled, or an error outcome (fail()) that
// refuses the job because its site went into its cooldown while the job waited.

const fail = (error, kind, slotAction, extra) => ({ type: 'error', error, kind, slotAction, ...extra });

// How long FlareSolverr is given for a navigation: the request's own limit, else the default.
function ceilingOf(ctx, job) {
  return Number.isFinite(job.request.maxTimeoutMs) && job.request.maxTimeoutMs > 0
    ? job.request.maxTimeoutMs
    : ctx.cfg.requestMaxTimeoutMs;
}

// How long a navigation IN A SESSION may take. The deadline only decides how long a job may
// WAIT; a navigation that has started keeps its full time (a cold Cloudflare
// challenge needs 15-20 s and its cookie is worth having even if the caller gave
// up), unless the caller said its page never is a challenge (boundSolve). What an
// abandoned background solve costs the session is unverified until a real FlareSolverr shows
// how a startup burst of protected-site probes fares when each one holds a browser to the end.
// Only a session can be bounded: its browser is already running, so FlareSolverr's own clock
// and our abort (this plus a grace) start together.
function maxTimeoutFor(ctx, job, startedAt) {
  const { cfg } = ctx;
  const ceiling = ceilingOf(ctx, job);
  // The caller's own deadline, not the one the queue capped (intake.js): a caller that would wait 30 s for a
  // page must not have its solve cut at 15 s because that is all the queue lets a background job wait.
  const bound = Number.isFinite(job.solveDeadlineAt) ? job.solveDeadlineAt : job.deadlineAt;
  if (!job.boundSolve || !Number.isFinite(bound)) return ceiling;
  return Math.min(ceiling, Math.max(cfg.boundSolveMinMs, bound - startedAt - cfg.boundSolveMarginMs));
}

// A one-off browser always gets the full time, boundSolve or not. It is launched BEFORE
// FlareSolverr's own clock starts, so a short abort (a bounded timeout plus the grace) can fire while
// Chrome is still starting; the abort reads as a wedged FlareSolverr and restarts it for nothing.
function statelessTimeoutFor(ctx, job) {
  return ceilingOf(ctx, job);
}

// The moment a navigation really starts, and the only place that decides it. A job
// that has to open a browser first is ready seconds after it was picked, and the job
// picked after it (a cookie request, a fallback) can be ready sooner or at the very
// same moment, so the pick alone cannot keep two starts apart: each one claims its
// site here, synchronously, and one that finds the site claimed waits out the
// spacing. Resolves the start time, or null when `cancelled()` says the job must not
// go ahead after all (a restart began while it waited). The spacing itself is unverified until a
// real FlareSolverr shows the smallest gap at which the sites the app uses never block the solver.
// The site's cooldown is looked at again here, last: it can open after the job was picked, while
// another call to the site was answered "blocked" and this one was opening its browser.
async function startNavigation(ctx, job, cancelled) {
  for (;;) {
    if (cancelled()) return null;
    const startedAt = ctx.ports.now();
    if (ctx.hostGate.isBlocked(job.hostKey, startedAt)) return cooldownOutcome(ctx, job);
    const waitMs = ctx.hostGate.claimStart(job.hostKey, startedAt);
    if (waitMs === 0) {
      job.queuedMs = startedAt - job.enqueuedAt;
      return startedAt;
    }
    await ctx.ports.sleep(waitMs);
  }
}

// A block: the first one leaves the session alone (it is fine, the site just wants
// to be left alone); a second one in a row says this browser's profile may be what
// the site dislikes.
function blockedOutcome(ctx, job, slot, seen) {
  const count = ctx.hostGate.noteBlock(job.hostKey);
  return fail(rejection('blocked', job.url, seen.message), 'blocked', slot && count === 2 ? 'recycle' : 'keep');
}

// Text this pool does not know. Nothing is recycled for one of them; several in a
// row on one session are treated as that session being unhealthy.
function unknownOutcome(ctx, job, slot, seen) {
  let action = 'keep';
  if (slot) {
    slot.otherFailures += 1;
    if (slot.otherFailures >= ctx.cfg.otherFailuresBeforeRecycle) {
      slot.otherFailures = 0;
      action = 'recycle';
    }
  }
  return fail(rejection('other', job.url, seen.message), 'other', action);
}

// What a finished navigation means for the job and for its session. `slot` is
// null on the stateless lane.
function navigationOutcome(ctx, job, slot, seen, meta) {
  const { cfg, ports, state } = ctx;
  state.downReported = false; // FlareSolverr answered, whatever it said: the next time it does not is a new episode
  switch (seen.kind) {
    case 'ok': {
      ctx.hostGate.noteSuccess(job.hostKey);
      // The call layer is about to save the cookie of this answer: jobs waiting for the site may
      // be answered with it (preflight.js).
      ctx.cookieWatch.noteChange(job.hostKey);
      if (slot) {
        slot.otherFailures = 0;
        slot.uses += 1;
        slot.lastOkAt = ports.now();
        ctx.circuit.noteSuccess();
      }
      return { type: 'ok', data: seen.body, meta };
    }
    case 'blocked':
      return blockedOutcome(ctx, job, slot, seen);
    case 'timeout':
      return fail(rejection('timeout', job.url, seen.message), 'timeout', 'probe');
    case 'driver':
    case 'launch': {
      const retry = !!slot && job.attempt === 0 && job.deadlineAt - ports.now() >= cfg.driverRetryMinBudgetMs;
      return fail(rejection(seen.kind, job.url, seen.message), seen.kind, 'recycle', { retry });
    }
    case 'proxy':
      // Only "cannot reach the proxy at all" says anything about the proxy itself.
      if (/ERR_PROXY_CONNECTION_FAILED/i.test(seen.message)) ports.reportProxyFault(slot ? slot.fingerprint : meta.fingerprint);
      return fail(rejection('proxy', job.url, seen.message), 'proxy', 'recycle');
    case 'navigation':
      return fail(rejection('navigation', job.url, seen.message), 'navigation', 'keep');
    case 'http':
      state.counters.httpErrors += 1;
      return fail(new Error(MESSAGES.http(seen.httpStatus)), 'http', 'keep');
    default:
      return unknownOutcome(ctx, job, slot, seen);
  }
}

// A request that never got an answer: the original error, untouched.
function transportOutcome(ctx, err, slot) {
  ctx.onTransportFailure(err, slot);
  return fail(err, 'transport', slot && isTimeoutError(err) ? 'suspect' : 'invalidate');
}

// The job was picked for its site but failed before any navigation (no session could be opened because
// FlareSolverr did not answer): the site was never touched, so the spacing reserved for the job goes back.
function releaseStart(ctx, job) {
  ctx.hostGate.release(job.hostKey);
}

// The site's cooldown opened after the job was picked: a request now would be one more during the
// cooldown, and its answer would end the cooldown early (noteSuccess). The job is refused the way the
// scheduler refuses one at pick time; the site was not touched, so its spacing goes back, and a session
// the job held is fine.
function cooldownOutcome(ctx, job) {
  releaseStart(ctx, job);
  return fail(refusal(POOL_ERROR_CODES.HOST_COOLDOWN), REFUSAL_KINDS[POOL_ERROR_CODES.HOST_COOLDOWN], 'keep');
}

/** { state, cfg, ports, hostGate, cookieWatch, circuit, onTransportFailure } -> the interface in the header. */
function createNavigation({ state, cfg, ports, hostGate, cookieWatch, circuit, onTransportFailure }) {
  const ctx = { state, cfg, ports, hostGate, cookieWatch, circuit, onTransportFailure };
  return {
    maxTimeoutFor: (job, startedAt) => maxTimeoutFor(ctx, job, startedAt),
    statelessTimeoutFor: (job) => statelessTimeoutFor(ctx, job),
    startNavigation: (job, cancelled) => startNavigation(ctx, job, cancelled),
    navigationOutcome: (job, slot, seen, meta) => navigationOutcome(ctx, job, slot, seen, meta),
    transportOutcome: (err, slot) => transportOutcome(ctx, err, slot),
    releaseStart: (job) => releaseStart(ctx, job),
  };
}

module.exports = { createNavigation, fail };
