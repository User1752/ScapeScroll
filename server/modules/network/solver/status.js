'use strict';

// What the pool reports about itself (System Health reads it). Counts and states
// only: no session id, URL, cookie, proxy detail or message text. Reads the shared
// state and the two parts that own what is not in it (the gates' cooldowns and the
// circuit); changes nothing.
//
// Interface: getStatus() -> a JSON-safe object: { enabled, disabledBy, state, sessions, queued, inFlight,
// counters, cooldowns, circuit, lastError, solver }.

// What the status says about the proxy a session was created with.
const PROXY_LABELS = Object.freeze({ 'user-proxy': 'user', none: 'none' });

function currentState(ctx, t) {
  const { state } = ctx;
  if (!state.enabled) return 'disabled';
  if (state.restarting) return 'restarting';
  if (t < state.downUntil) return 'down';
  if (ctx.circuit.isOpen(t)) return 'circuit-open';
  return ctx.slots.liveSlots().length ? 'active' : 'idle';
}

// What the pool knows about FlareSolverr itself, so the row next to FlareSolverr's own in System Health
// does not say "Ready" about a browser that cannot open: 'off' when the user switched it off on purpose
// (asked of the lifecycle at the moment of the question, so it is never stale), 'refused' when the last
// request to it was refused and nothing has answered since, null otherwise (no news, or it is answering).
function solverNote(ctx) {
  if (ctx.ports.isOffByChoice()) return 'off';
  return ctx.state.solverRefused ? 'refused' : null;
}

function describeSlot(slot, t) {
  return {
    idleMs: slot.status === 'idle' ? Math.max(0, t - slot.lastUsedAt) : 0,
    ageMs: slot.createdAt ? Math.max(0, t - slot.createdAt) : 0,
    uses: slot.uses,
    busy: slot.status !== 'idle',
    proxy: PROXY_LABELS[slot.proxyMode] || 'none',
  };
}

function getStatus(ctx) {
  const { state } = ctx;
  const t = ctx.ports.now();
  const queued = { interactive: 0, background: 0 };
  for (const job of state.queue) {
    if (job.state === 'queued') queued[job.priority] += 1;
  }
  return {
    enabled: state.enabled,
    disabledBy: state.enabled ? null : state.disabledBy,
    state: currentState(ctx, t),
    sessions: ctx.slots.liveSlots().map((slot) => describeSlot(slot, t)),
    queued,
    inFlight: state.inFlight,
    counters: { ...state.counters },
    cooldowns: ctx.hostGate.cooldowns(t),
    circuit: ctx.circuit.status(t),
    lastError: state.lastError ? { ...state.lastError } : null,
    solver: solverNote(ctx),
  };
}

/** { state, ports, slots, hostGate, circuit } -> { getStatus }. */
function createStatus({ state, ports, slots, hostGate, circuit }) {
  const ctx = { state, ports, slots, hostGate, circuit };
  return { getStatus: () => getStatus(ctx) };
}

module.exports = { createStatus };
