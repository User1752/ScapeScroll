'use strict';

const { POOL_ERROR_CODES, refusal } = require('./errors');
const { isPlainObject } = require('./plain-object');

// The direct preflight: when a queued session job is picked and its caller supplied
// request.preflight(), that is tried BEFORE the job takes a slot. The caller's function may
// answer from a cookie another job warmed meanwhile with a plain request; a non-null { data }
// resolves the job as mode 'direct' (no slot, no spacing). Anything else, including a throw,
// only means "no": the job goes on to the browser. Preflights run OUTSIDE the scheduler's
// pass and ONE AT A TIME pool-wide (state.preflightBusy): a queued job being preflighted counts
// as in flight, and the next job's preflight starts only when it ended. When one is tried
// (once per change of the site's cookie) is the scheduler's business, see cookie-watch.js.
//
// What preflight() may answer:
//   { data }     the page: the job is answered, mode 'direct'
//   undefined    nothing to try (no cookie newer than the call): says nothing about the site
//   null / else  tried, and the site said no: noted for the site's current cookie, so the
//                other jobs waiting for it are not each sent to hear the same
// A throw, or no answer before the job's own patience ends, is "no" for this job alone: it
// says something about this request, not about the cookie.
//
// A job that goes through the user's proxy is never preflighted (preflightOff): the request
// would leave from the app's own address, so a page it got would be the wrong one, and a
// block it met would blame the wrong address.
//
// Interface: start(job), called by the scheduler.

const GAVE_UP = Symbol('gave up');

function start(ctx, job) {
  const { state, jobs } = ctx;
  state.preflightBusy = true;
  job.state = 'preflighting';
  jobs.beginRun(job);
  // The scheduler records the site's cookie generation on the job just before it starts the preflight.
  const generation = job.preflightSeen;
  jobs.detach(Promise.resolve().then(() => runPreflight(ctx, job, generation)));
}

// What the caller's preflight() said, as one of 'hit' (with the answer), 'no', 'nothing',
// 'failed' or 'proxied' (not asked at all).
async function ask(ctx, job) {
  const { ports } = ctx;
  let giveUp = null;
  try {
    if ((await ctx.resolveProxy(job.solverUrl)).proxy) {
      job.preflightOff = true;
      return { kind: 'proxied' };
    }
    // The lane is shared, so one that never answers is given up on when the job's own
    // patience ends: the caller is not waiting for it after that.
    const timedOut = new Promise((resolve) => { giveUp = ports.startTimer(() => resolve(GAVE_UP), Math.max(0, job.deadlineAt - ports.now())); });
    const attempt = Promise.resolve(job.request.preflight());
    attempt.catch(() => {}); // if it loses the race and fails later, nobody is waiting for it
    const answer = await Promise.race([attempt, timedOut]);
    if (isPlainObject(answer) && isPlainObject(answer.data)) return { kind: 'hit', direct: answer };
    if (answer === GAVE_UP) return { kind: 'failed' };
    return { kind: answer === undefined ? 'nothing' : 'no' };
  } catch (_) {
    return { kind: 'failed' }; // a failed preflight only means "no": the job goes to the browser
  } finally {
    ports.stopTimer(giveUp);
  }
}

async function runPreflight(ctx, job, generation) {
  finishPreflight(ctx, job, await ask(ctx, job), generation);
}

// What the answer means now: the pool may have been switched off or closed while
// the preflight ran, and the job may already have been answered.
function finishPreflight(ctx, job, verdict, generation) {
  const { state, ports, jobs } = ctx;
  state.preflightBusy = false;
  if (job.settled) {
    ctx.wake();
    return;
  }
  if (state.shuttingDown) {
    jobs.rejectJob(job, refusal(POOL_ERROR_CODES.SHUTTING_DOWN));
  } else if (!state.enabled) {
    ctx.passthrough.release(job);
  } else if (verdict.kind === 'hit') {
    state.counters.directJobs += 1;
    jobs.settle(job, true, { data: verdict.direct.data, mode: 'direct', proxyMode: 'none', fingerprint: 'none', queuedMs: ports.now() - job.enqueuedAt, solveMs: 0 });
  } else {
    if (verdict.kind === 'no') ctx.cookieWatch.noteMiss(job.hostKey, generation);
    jobs.endRun(job);
    job.state = 'queued';
  }
  ctx.wake();
}

/** { state, ports, jobs, passthrough, cookieWatch, resolveProxy, wake } -> { start }. `wake` is the scheduler's schedulePump. */
function createPreflight({ state, ports, jobs, passthrough, cookieWatch, resolveProxy, wake }) {
  const ctx = { state, ports, jobs, passthrough, cookieWatch, resolveProxy, wake };
  return { start: (job) => start(ctx, job) };
}

module.exports = { createPreflight };
