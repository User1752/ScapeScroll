'use strict';

const { interpret, isTimeoutError } = require('./classify');

// The slot registry: the places a browser session can live, how they are
// created, retired and destroyed, and the idle timer that retires a slot nobody
// has used for a while. It never decides which job gets a slot (scheduler.js)
// nor creates the session inside one (sessions.js).
//
// A slot is { key, id, status, solverUrl, fingerprint, proxyMode, createdAt,
// lastUsedAt, lastOkAt, uses, confirmed, otherFailures, suspect, dead,
// closeAfter, closing }, documented at newSlot(). Its `status`:
//   'opening'   assigned to a job, session not confirmed yet
//   'idle' | 'busy'
//   'resetting' parking the tab on a blank page
//   'closing'   being destroyed
// Only an 'idle' slot is ever picked for a job, and a 'closing' one no longer
// counts against maxSessions: a job that arrives meanwhile gets a new slot (and a
// new id) instead of waiting for the destroy, and can never be handed the id that
// is going away.
//
// Interface:
//   newSlot(), liveSlots()           create one / the ones not closing
//   dropSlot(slot)                   forget a slot without telling FlareSolverr (nothing was created, or its process is gone)
//   closeSlot(slot, reason)          retire it: status 'closing' BEFORE the destroy is sent; idempotent
//   closeOtherIdleSlots(except)      free chromedriver for a launch retry
//   closeAll(reason)                 retire every idle slot; a busy one when its job ends
//   destroyRemote({ id, solverUrl }) best-effort destroy of one session id
//   abandonAll()                     FlareSolverr is restarting: every slot is dead, nothing is sent
//   ensureIdleTimer(), stopIdleTimer()
// Private state: the slot key counter and the idle timer.

// Closings that retire a session for a reason of their own, as opposed to the
// ones that throw a (possibly healthy) session away because of a problem.
const RETIRE_REASONS = new Set(['idle', 'disabled', 'resized', 'shutdown', 'closed']);

const liveSlots = (ctx) => [...ctx.state.slots.values()].filter((slot) => slot.status !== 'closing');

// status: see the header. `confirmed`: a sessions.create / sessions.list of this
// FlareSolverr process named the id. `suspect`: our own abort left the browser in
// an unknown state. `dead`: it went with a restart. `closeAfter`: the reason to
// close it as soon as its job ends. `closing`: the promise of its destroy.
function newSlot(ctx) {
  const { state, ports } = ctx;
  const slot = {
    key: ctx.nextSlotKey,
    id: null,
    status: 'opening',
    solverUrl: null,
    fingerprint: null,
    proxyMode: 'none',
    createdAt: 0,
    lastUsedAt: ports.now(),
    lastOkAt: 0,
    uses: 0,
    confirmed: false,
    otherFailures: 0,
    suspect: false,
    dead: false,
    closeAfter: null,
    closing: null,
  };
  ctx.nextSlotKey += 1;
  state.slots.set(slot.key, slot);
  ensureIdleTimer(ctx);
  return slot;
}

function forgetAffinity(state, slot) {
  for (const [hostKey, held] of state.affinity) {
    if (held === slot) state.affinity.delete(hostKey);
  }
}

function noteSlotRemoved(ctx) {
  const { state } = ctx;
  if (state.slots.size === 0) {
    stopIdleTimer(ctx);
    for (const done of state.emptyWaiters.splice(0)) done();
  }
  ctx.wake();
}

function dropSlot(ctx, slot) {
  slot.dead = true;
  forgetAffinity(ctx.state, slot);
  ctx.state.slots.delete(slot.key);
  noteSlotRemoved(ctx);
}

// Best effort: "already gone" is success, any other answer is only logged. A
// destroy that times out means a wedged driver, the one case where the pool
// itself asks for the solver to be recovered.
async function destroyRemote(ctx, { id, solverUrl }) {
  const res = await ctx.transport.destroySession(solverUrl, id);
  if (res.transport) {
    ctx.onTransportFailure(res.transport, null);
    if (isTimeoutError(res.transport)) ctx.ports.recoverSolver();
    return;
  }
  const seen = interpret(res);
  if (seen.kind === 'ok') return;
  if (seen.message && /doesn'?t exist|does not exist/i.test(seen.message)) return;
  ctx.ports.warnOnce('destroy-failed', 'FlareSolverr refused to close a session; it will go away with the next restart or idle close.');
}

/**
 * Retires a slot. Its status becomes 'closing' BEFORE the destroy is sent, so
 * nothing can be handed the id while it is going away. Idempotent.
 */
function closeSlot(ctx, slot, why) {
  const { state, ports } = ctx;
  const reason = why || 'unspecified'; // a log line and the recycle count always have one
  if (slot.closing) return slot.closing;
  if (slot.dead) {
    state.slots.delete(slot.key);
    noteSlotRemoved(ctx);
    return Promise.resolve();
  }
  slot.status = 'closing';
  forgetAffinity(state, slot);
  const wasConfirmed = slot.confirmed && !!slot.id;
  if (!RETIRE_REASONS.has(reason)) state.counters.recycles += 1;
  ports.log(`Session #${slot.key} ${RETIRE_REASONS.has(reason) ? 'closed' : 'recycled'} (${reason}).`);
  slot.closing = (async () => {
    try {
      if (wasConfirmed) await destroyRemote(ctx, { id: slot.id, solverUrl: slot.solverUrl });
    } catch (err) {
      ports.warnOnce('close-failed', `Closing a session failed: ${err && err.message}`);
    } finally {
      state.slots.delete(slot.key);
      noteSlotRemoved(ctx);
    }
  })();
  return slot.closing;
}

async function closeOtherIdleSlots(ctx, except) {
  const closing = liveSlots(ctx).filter((slot) => slot !== except && slot.status === 'idle').map((slot) => closeSlot(ctx, slot, 'launch-retry'));
  await Promise.all(closing);
}

/** Destroys every session, best effort. One that is busy is destroyed when its job ends. */
async function closeAll(ctx, reason = 'closed') {
  const closing = [];
  for (const slot of [...ctx.state.slots.values()]) {
    if (slot.closing) closing.push(slot.closing);
    else if (slot.status === 'idle') closing.push(closeSlot(ctx, slot, reason));
    else slot.closeAfter = reason;
  }
  await Promise.all(closing);
}

// FlareSolverr's process is being killed: every session dies with it, so no
// destroy is sent and no old id is trusted again.
function abandonAll(ctx) {
  const { state } = ctx;
  for (const slot of state.slots.values()) slot.dead = true;
  state.slots.clear();
  state.affinity.clear();
  noteSlotRemoved(ctx);
}

// One timer, and only while a slot exists.
function ensureIdleTimer(ctx) {
  const { state, cfg, ports } = ctx;
  if (ctx.idleTimer || !state.enabled) return;
  const tick = Math.max(1, Math.min(cfg.idleTickMs, state.idleMs / 2));
  ctx.idleTimer = ports.startTimer(() => checkIdle(ctx), tick);
}

function stopIdleTimer(ctx) {
  ctx.ports.stopTimer(ctx.idleTimer);
  ctx.idleTimer = null;
}

function checkIdle(ctx) {
  const { state, ports } = ctx;
  ctx.idleTimer = null;
  try {
    const t = ports.now();
    const waiting = state.queue.some((job) => job.state === 'queued');
    for (const slot of liveSlots(ctx)) {
      if (slot.status === 'idle' && !waiting && t - slot.lastUsedAt >= state.idleMs) closeSlot(ctx, slot, 'idle').catch(() => {});
    }
  } catch (err) {
    ports.warnOnce('idle-check', `The idle check failed: ${err && err.message}`);
  }
  if (state.slots.size > 0) ensureIdleTimer(ctx);
}

/**
 * { state, cfg, ports, transport, onTransportFailure, wake } -> the interface in
 * the header. `wake` asks the scheduler to look at the queue again; it is
 * late-bound by the composition root because the scheduler is built after the
 * parts that wake it.
 */
function createSlots({ state, cfg, ports, transport, onTransportFailure, wake }) {
  const ctx = { state, cfg, ports, transport, onTransportFailure, wake, nextSlotKey: 1, idleTimer: null };
  return {
    newSlot: () => newSlot(ctx),
    liveSlots: () => liveSlots(ctx),
    dropSlot: (slot) => dropSlot(ctx, slot),
    closeSlot: (slot, reason) => closeSlot(ctx, slot, reason),
    closeOtherIdleSlots: (except) => closeOtherIdleSlots(ctx, except),
    closeAll: (reason) => closeAll(ctx, reason), // no reason named: 'closed'
    destroyRemote: (target) => destroyRemote(ctx, target),
    abandonAll: () => abandonAll(ctx),
    ensureIdleTimer: () => ensureIdleTimer(ctx),
    stopIdleTimer: () => stopIdleTimer(ctx),
  };
}

module.exports = { createSlots };
