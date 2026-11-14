'use strict';

const { SOLVER_SESSION_FAILED } = require('../../errors/error-codes');

// The circuit breaker. Session-level failures (launch, create, an old FlareSolverr
// without sessions) within a window open the circuit: every job runs stateless
// until it closes. The first session job after the window is the closing probe; a
// failure then reopens it at once.
//
// Interface:
//   noteFailure(kind)   a session-level failure; may open the circuit
//   noteSuccess()       a session worked; closes the circuit once its window is over
//   isOpen(t)           jobs must run stateless
//   status(t)           { open, secondsLeft } for the status
//   reset()             closes it and forgets the failures: a restart that brought FlareSolverr back ended the
//                       cause of the failures that opened it (restart.js calls it)
// State (private): the failure times inside the window and when the circuit closes.

function noteFailure(ctx, kind) {
  const { cfg, ports, circuit } = ctx;
  const t = ports.now();
  ports.noteLastError(kind);
  if (t < circuit.openUntil) return;
  circuit.failures = circuit.failures.filter((at) => t - at < cfg.circuit.windowMs);
  circuit.failures.push(t);
  const probing = circuit.openUntil !== 0;
  if (!probing && circuit.failures.length < cfg.circuit.failures) return;
  circuit.openUntil = t + cfg.circuit.openMs;
  circuit.failures = [];
  ports.warn(`Browser sessions kept failing (${kind}); using one-off browsers for ${Math.round(cfg.circuit.openMs / 1000)} s.`);
  ports.record(SOLVER_SESSION_FAILED, 'Browser sessions kept failing; one-off browsers are used for a while.', { kind });
}

function noteSuccess(ctx) {
  const { ports, circuit } = ctx;
  if (circuit.openUntil !== 0 && ports.now() >= circuit.openUntil) {
    circuit.openUntil = 0;
    ports.log('Browser sessions work again; the circuit is closed.');
  }
}

function reset(ctx) {
  const { ports, circuit } = ctx;
  if (ports.now() < circuit.openUntil) ports.log('FlareSolverr was restarted; the circuit is closed.');
  circuit.openUntil = 0;
  circuit.failures = [];
}

function createCircuit({ cfg, ports }) {
  const ctx = { cfg, ports, circuit: { failures: [], openUntil: 0 } };
  return {
    noteFailure: (kind) => noteFailure(ctx, kind),
    noteSuccess: () => noteSuccess(ctx),
    reset: () => reset(ctx),
    isOpen: (t) => t < ctx.circuit.openUntil,
    status: (t) => ({
      open: t < ctx.circuit.openUntil,
      secondsLeft: Math.max(0, Math.ceil((ctx.circuit.openUntil - t) / 1000)),
    }),
  };
}

module.exports = { createCircuit };
