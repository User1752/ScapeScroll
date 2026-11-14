'use strict';

const { MESSAGES } = require('../../../config/solver');
const { interpret } = require('./classify');
const { fail } = require('./navigation');

// Running one job on the slot the scheduler gave it: make sure the slot holds a
// session (sessions.js), navigate (navigation.js), then answer the caller FIRST
// and only then tidy the browser up (slot-release.js).
//
// An attempt ends in one of:
//   { type: 'ok', data, meta }            the page: the caller is answered, then the slot is parked
//   { type: 'error', ... }                see navigation.js; the caller gets the error, the slot its action
//   { type: 'requeue' }                   nothing was sent (a restart took the slot, or the pool is closing)
//   { type: 'fallback' }                  no session could be opened: the job runs in a one-off browser
//
// Interface: run(job, slot). It never rejects (the scheduler detaches it anyway).

async function attemptOnSession(ctx, job, slot) {
  const { cfg, ports, navigation } = ctx;
  // A lookup that fails says nothing about the session: the job fails (it is never sent
  // without the proxy), and a healthy session keeps its cookie jar.
  let proxyInfo;
  try {
    proxyInfo = await ctx.resolveProxy(job.solverUrl);
  } catch (err) {
    return fail(err, 'internal', 'keep');
  }
  if (slot.dead) return { type: 'requeue' };

  const why = ctx.sessions.recycleReason(slot, job.solverUrl, proxyInfo);
  if (why) {
    await ctx.sessions.recycleSlot(slot, why);
    if (slot.dead) return { type: 'requeue' };
  }

  const ready = await ctx.sessions.confirmSession(slot, job, proxyInfo);
  // A restart comes first: it is what killed the connection of a create or a list that failed with
  // it, nothing had been sent for the page yet, and the job belongs to the new FlareSolverr.
  if (ready.restart || slot.dead) return { type: 'requeue' };
  if (ready.transport) {
    // Nothing was asked of the site: it must not be made to wait a spacing for a navigation that never happened.
    navigation.releaseStart(job);
    return navigation.transportOutcome(ready.transport, slot);
  }
  if (ready.fallback) return { type: 'fallback' };

  const startedAt = await navigation.startNavigation(job, () => slot.dead);
  if (startedAt === null) return { type: 'requeue' };
  // The site's cooldown opened while the session was being opened: this is the outcome that refuses the job.
  if (typeof startedAt !== 'number') return startedAt;
  const maxTimeout = navigation.maxTimeoutFor(job, startedAt);
  const res = await ctx.transport.requestInSession(slot, job.url, maxTimeout, maxTimeout + cfg.requestAbortGraceMs);
  if (res.refused) return slot.dead ? { type: 'requeue' } : fail(new Error(MESSAGES.sessionNotReady), 'internal', 'recycle');
  if (res.transport) return navigation.transportOutcome(res.transport, slot);
  const meta = { mode: 'session', proxyMode: slot.proxyMode, fingerprint: slot.fingerprint, solveMs: ports.now() - startedAt };
  return navigation.navigationOutcome(job, slot, interpret(res), meta);
}

// The caller is answered first; only then is the browser tidied up.
async function conclude(ctx, job, slot, result) {
  const { jobs, scheduler } = ctx;
  if (result.type === 'requeue') {
    // Nothing was sent: a restart took the session (it is already gone) or the pool is
    // closing. The job waits for the new FlareSolverr, or is answered if the pool no
    // longer schedules (requeue says how).
    if (!slot.dead) ctx.slots.dropSlot(slot);
    scheduler.requeue(job);
    return;
  }
  if (result.type === 'fallback') {
    // No session could be opened for this job: it runs in a one-off browser, and the
    // empty slot is dropped (the circuit decides whether later jobs try again).
    ctx.slots.dropSlot(slot);
    await ctx.statelessLane.runFallback(job);
    return;
  }
  if (result.type === 'ok') {
    jobs.resolveWith(job, result);
    await ctx.slotRelease.releaseSlot(slot, 'keep');
    return;
  }
  ctx.ports.noteUsed();
  if (result.retry) {
    // The browser died under this job: it gets one more, on a fresh session.
    job.attempt += 1;
    scheduler.requeue(job);
  } else {
    jobs.rejectJob(job, result.error, result.kind);
  }
  await ctx.slotRelease.releaseSlot(slot, result.slotAction, result.kind);
}

async function runSession(ctx, job, slot) {
  let result;
  try {
    result = await attemptOnSession(ctx, job, slot);
  } catch (err) {
    // Something that should not fail did: nobody knows what state the session is in.
    result = fail(err, 'internal', 'recycle');
  }
  try {
    await conclude(ctx, job, slot, result);
  } catch (err) {
    ctx.scheduler.failUnexpected(job, slot, err);
  }
}

/**
 * { cfg, ports, transport, resolveProxy, slots, sessions, navigation, slotRelease,
 * jobs, scheduler, statelessLane } -> { run }.
 */
function createSessionRunner({
  cfg, ports, transport, resolveProxy, slots, sessions, navigation, slotRelease, jobs, scheduler, statelessLane,
}) {
  const ctx = {
    cfg, ports, transport, resolveProxy, slots, sessions, navigation, slotRelease, jobs, scheduler, statelessLane,
  };
  return { run: (job, slot) => runSession(ctx, job, slot) };
}

module.exports = { createSessionRunner };
