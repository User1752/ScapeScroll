'use strict';

const { POOL_ERROR_CODES } = require('./errors');

// FlareSolverr's process is about to be killed and started again: every session
// dies with it. Nothing is destroyed (the process that would answer is going
// away), no old id is trusted again, and queued jobs wait. The lifecycle module
// announces begin/end; the pool subscribes itself (subscribe), so whoever builds
// it only passes the registration function.
//
// Restarts are counted, not flagged: two can be in flight at once, and then the events
// arrive as begin, begin, end, end. The pool resumes only when the count is back to zero,
// and the last restart to end decides whether FlareSolverr is back (and, when it is, closes the
// circuit: circuit.reset()). An end the pool has no begin for (it was off, or switched off
// meanwhile) counts for nothing.
//
// Interface:
//   beginRestart(reason), endRestart({ ok })   ok: jobs resume; not ok: the pool is 'down' for a while
//   subscribe()                                listen for the lifecycle's begin/end events, once
//   unsubscribe()                              stop listening (shutdown)
//   stopWatchdog()                             cancel the guard timer (shutdown)
//   reset()                                    forget any restart in progress (the pool was switched off)
// Private state: the number of restarts in flight, the watchdog timer and the unsubscribe function.

function beginRestart(ctx, reason) {
  const { state, cfg, ports } = ctx;
  if (!state.enabled || state.shuttingDown) return;
  ctx.restartsInFlight += 1;
  if (!state.restarting) {
    state.restarting = true;
    state.downUntil = 0; // the restart is the recovery: jobs wait for it instead of failing fast
    state.sessionsUnsupported = false;
    state.blankUnsupported = false;
    state.blankFailures = 0;
    ctx.slots.abandonAll();
    ports.log(`FlareSolverr is restarting (${String(reason || 'no reason given').slice(0, cfg.logReasonMaxChars)}); jobs wait.`);
  }
  ports.stopTimer(ctx.watchdog);
  // If the end of the restart is never reported (a bug in whoever restarts it), the pool
  // must not stay paused for the rest of the process.
  ctx.watchdog = ports.startTimer(() => {
    ctx.watchdog = null;
    ports.warn('A FlareSolverr restart never reported its end; treating it as failed.');
    ctx.restartsInFlight = 0;
    settleRestart(ctx, false);
  }, cfg.restartWaitMaxMs + cfg.restartWatchdogGraceMs);
  ctx.wake();
}

function endRestart(ctx, { ok } = {}) {
  if (!ctx.state.restarting) return;
  ctx.restartsInFlight = Math.max(0, ctx.restartsInFlight - 1);
  if (ctx.restartsInFlight > 0) return; // another restart is still killing and spawning: wait for it
  settleRestart(ctx, !!ok);
}

// The last restart is over: the pool resumes, or goes down for a while when it did not come back.
function settleRestart(ctx, ok) {
  const { state, cfg, ports } = ctx;
  if (!state.restarting) return;
  state.restarting = false;
  stopWatchdog(ctx);
  if (ok) {
    state.downReported = false;
    state.solverRefused = false;
    // The session failures that opened the circuit came from the process that is gone. Not at the
    // begin: a restart that does not bring FlareSolverr back leaves the cause where it was.
    ctx.circuit.reset();
    ports.log('FlareSolverr is back; jobs resume.');
    ctx.wake();
    return;
  }
  state.downUntil = ports.now() + cfg.downAfterWedgeMs;
  ports.warn(`FlareSolverr did not come back; jobs fail fast for ${Math.round(cfg.downAfterWedgeMs / 1000)} s.`);
  ctx.rejectQueued(POOL_ERROR_CODES.DOWN);
}

function stopWatchdog(ctx) {
  ctx.ports.stopTimer(ctx.watchdog);
  ctx.watchdog = null;
}

// The pool was switched off: whatever restart was in progress no longer matters, and the end it
// would have been paired with is ignored.
function reset(ctx) {
  ctx.restartsInFlight = 0;
  ctx.state.restarting = false;
  stopWatchdog(ctx);
}

function subscribe(ctx) {
  if (typeof ctx.ports.subscribeRestart !== 'function') return;
  ctx.unsubscribeFn = ctx.ports.subscribeRestart((evt) => {
    if (!evt) return;
    if (evt.phase === 'begin') beginRestart(ctx, evt.reason);
    else if (evt.phase === 'end') endRestart(ctx, { ok: evt.ok === true });
  });
}

function unsubscribe(ctx) {
  if (typeof ctx.unsubscribeFn === 'function') ctx.unsubscribeFn();
  ctx.unsubscribeFn = null;
}

/** { state, cfg, ports, slots, circuit, rejectQueued, wake } -> the interface in the header. */
function createRestart({ state, cfg, ports, slots, circuit, rejectQueued, wake }) {
  const ctx = { state, cfg, ports, slots, circuit, rejectQueued, wake, restartsInFlight: 0, watchdog: null, unsubscribeFn: null };
  return {
    beginRestart: (reason) => beginRestart(ctx, reason),
    endRestart: (outcome) => endRestart(ctx, outcome),
    subscribe: () => subscribe(ctx),
    unsubscribe: () => unsubscribe(ctx),
    stopWatchdog: () => stopWatchdog(ctx),
    reset: () => reset(ctx),
  };
}

module.exports = { createRestart };
