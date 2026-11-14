'use strict';

const { interpret } = require('./classify');
const { POOL_ERROR_CODES, refusal } = require('./errors');
const { fail } = require('./navigation');

// The stateless lane: a one-off browser, the legacy payload. Used for cookie
// requests (cookies injected into a shared browser would authenticate every later
// anonymous call), while the circuit is open, when this FlareSolverr has no
// sessions, and as the fallback for a job whose session could not be opened. It
// holds the launch lock for its whole request. A transport failure never falls
// back to anything else: the solver itself is down, a second try would only
// double the wait.
//
// Interface:
//   start(job, release)   the scheduler picked a stateless job and took the launch lock
//   runFallback(job)      a session job whose session could not be opened runs here
// `release` frees the launch lock; the lane calls it once the request is over.

async function runStatelessLane(ctx, job, release) {
  const { state, ports } = ctx;
  let result;
  try {
    const proxyInfo = await ctx.resolveProxy(job.solverUrl);
    const startedAt = await ctx.navigation.startNavigation(job, () => state.restarting);
    if (startedAt === null) {
      ctx.scheduler.requeue(job);
      return;
    }
    if (typeof startedAt !== 'number') {
      result = startedAt; // the site's cooldown opened while the job waited (after the launch lock, too): nothing is sent
    } else {
      const maxTimeout = ctx.navigation.statelessTimeoutFor(job);
      const res = await ctx.transport.requestStateless(job.solverUrl, job.url, maxTimeout, job.request.cookies, proxyInfo.proxy);
      if (res.transport) {
        result = ctx.navigation.transportOutcome(res.transport, null);
      } else {
        const meta = { mode: 'stateless', proxyMode: proxyInfo.mode, fingerprint: proxyInfo.fingerprint, solveMs: ports.now() - startedAt };
        result = ctx.navigation.navigationOutcome(job, null, interpret(res), meta);
      }
    }
  } catch (err) {
    result = fail(err, 'internal');
  } finally {
    release();
  }
  if (result.type === 'ok') {
    ctx.jobs.resolveWith(job, result);
  } else {
    ports.noteUsed();
    ctx.jobs.rejectJob(job, result.error, result.kind);
  }
}

async function runStatelessFallback(ctx, job) {
  const { state } = ctx;
  state.counters.statelessJobs += 1;
  const release = await ctx.launchLock.acquire();
  if (state.shuttingDown) {
    release();
    ctx.jobs.rejectJob(job, refusal(POOL_ERROR_CODES.SHUTTING_DOWN));
    return;
  }
  await runStatelessLane(ctx, job, release);
}

async function startStateless(ctx, job, release) {
  try {
    await runStatelessLane(ctx, job, release);
  } catch (err) {
    ctx.scheduler.failUnexpected(job, null, err);
  }
}

/** { state, ports, transport, resolveProxy, launchLock, navigation, jobs, scheduler } -> the interface in the header. */
function createStatelessLane({ state, ports, transport, resolveProxy, launchLock, navigation, jobs, scheduler }) {
  const ctx = { state, ports, transport, resolveProxy, launchLock, navigation, jobs, scheduler };
  return {
    start: (job, release) => startStateless(ctx, job, release),
    runFallback: (job) => runStatelessFallback(ctx, job),
  };
}

module.exports = { createStatelessLane };
