'use strict';

const { POOL_ERROR_CODES, refusal } = require('./errors');

// The scheduler: who runs next, and on what. The queue is looked at in one
// synchronous pass, so a slot, a gate and a job are decided together and no two
// jobs can be given the same one. The pass is coalesced through a microtask and
// never throws: an unexpected error rejects the job it concerns and is logged once.
//
// It decides; it does not run anything. Starting a job goes through `dispatch`,
// three functions the composition root binds to the parts that do the work
// (late-bound: those parts are built after the scheduler, and call back into it):
//   dispatch.startPreflight(job)          preflight.js
//   dispatch.runSession(job, slot)        session-runner.js
//   dispatch.startStateless(job, release) stateless-lane.js
//
// Interface:
//   schedulePump()                 look at the queue again soon (coalesced)
//   requeue(job)                   a job goes back to waiting its turn
//   failUnexpected(job, slot, err) answer a job with an internal error and throw its slot away
//   stopWake()                     cancel the timer that wakes the scheduler
// Private state: whether a pass is scheduled, and the wake-up timer.

function schedulePump(ctx) {
  const { state } = ctx;
  if (ctx.pumpScheduled || !state.enabled || state.shuttingDown) return;
  ctx.pumpScheduled = true;
  queueMicrotask(() => pump(ctx));
}

function pump(ctx) {
  const { state, ports } = ctx;
  ctx.pumpScheduled = false;
  if (!state.enabled || state.shuttingDown) return;
  try {
    pumpQueue(ctx);
  } catch (err) {
    ports.warnOnce(`pump:${err && err.message}`, `The scheduler failed: ${err && err.message}`);
  }
}

function pumpQueue(ctx) {
  const { state, ports, hostGate, cookieWatch, jobs } = ctx;
  const t = ports.now();
  hostGate.prune(t);
  cookieWatch.prune(t);
  let wakeAt = Infinity;
  const waiting = state.queue.filter((job) => job.state === 'queued').sort(jobs.byPriority);
  for (const job of waiting) {
    try {
      wakeAt = Math.min(wakeAt, considerJob(ctx, job, t));
    } catch (err) {
      // A runner that threw while it was being started has already been given its slot (null before that).
      failUnexpected(ctx, job, job.slot, err);
    }
  }
  armWake(ctx, wakeAt, t);
}

// While FlareSolverr restarts, a job waits up to restartWaitMaxMs (or its own
// deadline). Answers when it should be looked at again.
function considerWhileRestarting(ctx, job, t) {
  const { cfg, jobs } = ctx;
  if (t >= job.deadlineAt || t - job.enqueuedAt >= cfg.restartWaitMaxMs) {
    jobs.rejectJob(job, refusal(POOL_ERROR_CODES.RESTARTING));
    return Infinity;
  }
  return Math.min(job.deadlineAt, job.enqueuedAt + cfg.restartWaitMaxMs);
}

// A job that had to wait may find that another job solved its site meanwhile: the cookie
// that solve left lets the caller answer it with a plain request. A job is tried once per
// change of its site's cookie (cookie-watch.js). The first pump after it was queued has
// nothing to try, since no cookie newer than the job exists yet. The check comes before the
// site's spacing and the slot, so a job at the head of the queue never starts a navigation
// without having tried the cookie that is there now.
// One preflight at a time pool-wide, so twenty waiting lookups are never twenty simultaneous
// requests to a Cloudflare site; none when the caller is about to give up anyway, and none
// at a cookie that already got a "no" from the site for another job.
// Returns the wake time when the job must wait here, or null to carry on.
function preflightStep(ctx, job, t, wake) {
  const { state, cfg, cookieWatch } = ctx;
  if (job.mode !== 'session' || typeof job.request.preflight !== 'function' || job.preflightOff) return null;
  const generation = cookieWatch.generation(job.hostKey);
  if (job.preflightSeen === generation) return null;
  if (!cookieWatch.isWorthAsking(job.hostKey) || job.deadlineAt - t < cfg.preflightMinBudgetMs) {
    job.preflightSeen = generation; // decided against it, for this cookie
    return null;
  }
  if (state.preflightBusy) return wake;
  job.preflightSeen = generation;
  ctx.dispatch.startPreflight(job);
  return wake;
}

// The job can start now: takes the one-off lane or a slot, reserves the site's
// spacing and hands the job to the runner. Answers when to look again (Infinity:
// only when something changes).
function startJob(ctx, job, t, wake) {
  const { state, hostGate, launchLock, jobs, dispatch } = ctx;
  if (job.mode === 'stateless') {
    const release = launchLock.tryAcquire();
    if (!release) return wake;
    jobs.removeFromQueue(job);
    job.state = 'running';
    jobs.beginRun(job);
    state.counters.statelessJobs += 1;
    hostGate.reserve(job.hostKey, t);
    jobs.detach(dispatch.startStateless(job, release));
    return Infinity;
  }

  const choice = chooseSlot(ctx, job, t);
  if (!choice.slot) return Math.min(wake, choice.wakeAt);
  jobs.removeFromQueue(job);
  job.state = 'running';
  job.slot = choice.slot;
  jobs.beginRun(job);
  state.counters.sessionJobs += 1;
  if (choice.slot.status === 'idle') choice.slot.status = 'busy';
  state.affinity.set(job.hostKey, choice.slot);
  hostGate.reserve(job.hostKey, t);
  jobs.detach(dispatch.runSession(job, choice.slot));
  return Infinity;
}

// Starts the job if it can start now, and answers when it should be looked at
// again (Infinity: only when something changes).
function considerJob(ctx, job, t) {
  const { state, hostGate, circuit, jobs } = ctx;
  if (state.restarting) return considerWhileRestarting(ctx, job, t);
  // The solver was declared wedged: what was queued then was refused, and a job that comes back
  // later (a driver-error retry, the end of a preflight) must not start a session on it either.
  if (t < state.downUntil) {
    jobs.rejectJob(job, refusal(POOL_ERROR_CODES.DOWN));
    return Infinity;
  }
  if (t >= job.deadlineAt) {
    // Never reaches FlareSolverr: the caller has stopped waiting for it.
    state.counters.queueTimeouts += 1;
    jobs.rejectJob(job, refusal(POOL_ERROR_CODES.QUEUE_TIMEOUT));
    return Infinity;
  }
  const wake = job.deadlineAt;
  if (hostGate.isBlocked(job.hostKey, t)) {
    jobs.rejectJob(job, refusal(POOL_ERROR_CODES.HOST_COOLDOWN));
    return Infinity;
  }
  // The circuit may have opened while this job waited: it does not try a session.
  if (job.mode === 'session' && (circuit.isOpen(t) || state.sessionsUnsupported)) job.mode = 'stateless';

  const preflightWake = preflightStep(ctx, job, t, wake);
  if (preflightWake !== null) return preflightWake;

  const startAt = hostGate.nextStartAt(job.hostKey);
  if (t < startAt) return Math.min(wake, startAt);
  return startJob(ctx, job, t, wake);
}

// A site keeps the browser that holds its cookies; it waits a while for it
// before taking any other.
function chooseSlot(ctx, job, t) {
  const { state, cfg, slots } = ctx;
  const live = slots.liveSlots();
  const home = state.affinity.get(job.hostKey);
  if (home && live.includes(home)) {
    if (home.status === 'idle') return { slot: home };
    const giveUpAt = job.enqueuedAt + cfg.affinityWaitMs;
    if (t < giveUpAt) return { wakeAt: giveUpAt };
  }
  const idle = live.find((slot) => slot.status === 'idle');
  if (idle) return { slot: idle };
  if (live.length < state.maxSessions) return { slot: slots.newSlot() };
  return { wakeAt: Infinity };
}

// One timer for whichever comes first: a spaced site becoming free, a job's
// deadline, the end of an affinity wait.
function armWake(ctx, wakeAt, t) {
  const { ports } = ctx;
  ports.stopTimer(ctx.wakeTimer);
  ctx.wakeTimer = null;
  if (!Number.isFinite(wakeAt)) return;
  ctx.wakeTimer = ports.startTimer(() => {
    ctx.wakeTimer = null;
    schedulePump(ctx);
  }, Math.max(0, wakeAt - t));
}

// The job goes back to waiting its turn (a restart began before it sent
// anything, or its first browser died and it gets a second one). This happens
// long after run() looked at the state, and a pool that was switched off or
// closed meanwhile no longer schedules the queue: the job is answered here, the
// way a queued one is when that happens, or it would wait for ever.
function requeue(ctx, job) {
  const { state, jobs } = ctx;
  if (job.settled) return;
  job.slot = null;
  if (state.shuttingDown) {
    jobs.rejectJob(job, refusal(POOL_ERROR_CODES.SHUTTING_DOWN));
    return;
  }
  if (!state.enabled) {
    ctx.passthrough.release(job);
    return;
  }
  jobs.endRun(job);
  job.state = 'queued';
  if (!state.queue.includes(job)) state.queue.push(job);
  schedulePump(ctx);
}

// The failure of something that should never fail: the caller is told, the
// slot is thrown away because nobody knows what state it is in, and the next
// job starts over.
function failUnexpected(ctx, job, slot, err) {
  ctx.ports.warnOnce(`unexpected:${err && err.message}`, `Unexpected error: ${err && err.message}`);
  ctx.jobs.rejectJob(job, err, 'internal');
  if (slot && !slot.dead) ctx.slots.closeSlot(slot, 'error').catch(() => {});
  schedulePump(ctx);
}

function stopWake(ctx) {
  ctx.ports.stopTimer(ctx.wakeTimer);
  ctx.wakeTimer = null;
}

/** { state, cfg, ports, hostGate, cookieWatch, circuit, launchLock, slots, jobs, passthrough, dispatch } -> the interface in the header. */
function createScheduler({ state, cfg, ports, hostGate, cookieWatch, circuit, launchLock, slots, jobs, passthrough, dispatch }) {
  const ctx = {
    state, cfg, ports, hostGate, cookieWatch, circuit, launchLock, slots, jobs, passthrough, dispatch, pumpScheduled: false, wakeTimer: null,
  };
  return {
    schedulePump: () => schedulePump(ctx),
    requeue: (job) => requeue(ctx, job),
    failUnexpected: (job, slot, err) => failUnexpected(ctx, job, slot, err),
    stopWake: () => stopWake(ctx),
  };
}

module.exports = { createScheduler };
