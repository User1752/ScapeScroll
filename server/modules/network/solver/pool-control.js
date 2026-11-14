'use strict';

const { POOL_ERROR_CODES } = require('./errors');

// Controlling the pool as a whole: applying the settings the app pushes
// (switching the pool on and off, resizing it, changing the idle time) and
// shutting it down. It changes the shared flags and tells the parts that own
// timers and sessions what to stop; it holds no scheduling or session logic.
//
// Interface:
//   applySettings({ enabled, disabledBy, maxSessions, idleMinutes })   never throws
//   shutdown({ timeoutMs })                                            idempotent
// Private state: the promise of the shutdown in progress.

const clampWhole = (value, min, max, fallback) => (Number.isInteger(value) && value >= min && value <= max ? value : fallback);

// Switching the pool off: queued jobs go down the pass-through path at once, the
// restart and timer machinery stops, and the sessions are closed (a busy one when
// its job ends).
function switchOff(ctx) {
  const { state } = ctx;
  for (const job of state.queue.filter((j) => j.state === 'queued')) ctx.passthrough.release(job);
  ctx.restart.reset(); // a restart in progress no longer matters, and its end is ignored
  state.downUntil = 0;
  ctx.scheduler.stopWake();
  ctx.slots.stopIdleTimer();
  ctx.slots.closeAll('disabled').catch(() => {});
}

// Still on: a smaller pool closes the extra IDLE slots (a busy one is found by
// the resize check when its job ends).
function resize(ctx) {
  const { state, slots } = ctx;
  slots.stopIdleTimer(); // re-armed below with the new interval
  for (const slot of slots.liveSlots().sort((a, b) => a.lastUsedAt - b.lastUsedAt)) {
    if (slots.liveSlots().length <= state.maxSessions) break;
    if (slot.status === 'idle') slots.closeSlot(slot, 'resized').catch(() => {});
  }
  if (state.slots.size > 0) slots.ensureIdleTimer();
  ctx.scheduler.schedulePump();
}

/**
 * { enabled, disabledBy: 'setting' | 'env' | null, maxSessions, idleMinutes }. Never throws.
 * Switching the pool off closes its sessions (a busy one when its job ends), sends the
 * queued jobs down the pass-through path at once, and stops every timer.
 */
function applySettings(ctx, settings = {}) {
  const { state, cfg, ports } = ctx;
  try {
    const wasEnabled = state.enabled;
    state.enabled = settings.enabled === true;
    state.disabledBy = state.enabled ? null : (settings.disabledBy === 'env' || settings.disabledBy === 'setting' ? settings.disabledBy : null);
    state.maxSessions = clampWhole(settings.maxSessions, cfg.maxSessionsMin, cfg.maxSessionsCap, cfg.defaultMaxSessions);
    state.idleMs = clampWhole(settings.idleMinutes, cfg.idleMinutesMin, cfg.idleMinutesMax, cfg.defaultIdleMinutes) * 60_000;

    if (!state.enabled) {
      if (wasEnabled) switchOff(ctx);
      return;
    }
    resize(ctx);
  } catch (err) {
    ports.warn(`Applying the settings failed: ${err && err.message}`);
  }
}

// Waits for the running jobs (up to the timeout), then for every slot to be gone.
async function drainAndClose(ctx, timeoutMs) {
  const { state, ports } = ctx;
  let giveUp = null;
  const timedOut = new Promise((resolve) => { giveUp = ports.startTimer(resolve, timeoutMs); });
  const drained = new Promise((resolve) => {
    if (state.inFlight === 0) resolve(); else state.drainWaiters.push(resolve);
  });
  await Promise.race([drained, timedOut]);
  // A session still being parked on its blank page is closed as soon as that ends.
  const empty = new Promise((resolve) => {
    if (state.slots.size === 0) resolve(); else state.emptyWaiters.push(resolve);
  });
  await Promise.race([Promise.all([ctx.slots.closeAll('shutdown'), empty]), timedOut]);
  ports.stopTimer(giveUp);
  ctx.slots.stopIdleTimer();
}

/** Stops the pool: queued jobs are rejected, running ones are waited for (up to timeoutMs), sessions are closed. Idempotent. */
function shutdown(ctx, { timeoutMs = ctx.cfg.shutdownTimeoutMs } = {}) {
  if (ctx.shutdownPromise) return ctx.shutdownPromise;
  ctx.state.shuttingDown = true;
  ctx.restart.unsubscribe();
  ctx.jobs.rejectQueued(POOL_ERROR_CODES.SHUTTING_DOWN);
  ctx.scheduler.stopWake();
  ctx.restart.stopWatchdog();
  ctx.shutdownPromise = drainAndClose(ctx, timeoutMs);
  return ctx.shutdownPromise;
}

/** { state, cfg, ports, slots, jobs, scheduler, passthrough, restart } -> { applySettings, shutdown }. */
function createPoolControl({ state, cfg, ports, slots, jobs, scheduler, passthrough, restart }) {
  const ctx = { state, cfg, ports, slots, jobs, scheduler, passthrough, restart, shutdownPromise: null };
  return {
    applySettings: (settings) => applySettings(ctx, settings),
    shutdown: (options) => shutdown(ctx, options),
  };
}

module.exports = { createPoolControl };
