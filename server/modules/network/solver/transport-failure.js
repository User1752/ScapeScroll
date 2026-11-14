'use strict';

const { POOL_ERROR_CODES } = require('./errors');
const { isTimeoutError, isSolverDown } = require('./classify');

// What it means for the pool when a request to FlareSolverr itself failed (no
// answer at all, as opposed to an answer that says an error). Local belief about
// which sessions exist is dropped (the next job asks FlareSolverr with
// sessions.list before it trusts an id again). Two failures are told apart, because
// they call for opposite things:
//   - A TIMEOUT (our own abort) outside a restart means the solver took the call and never answered:
//     it is wedged. For a while every job fails fast instead of each waiting out its own timeout.
//   - A REFUSED connection means nothing is listening: FlareSolverr is switched off, not installed,
//     not up yet or crashed. Each job fails by itself at once (nothing is waiting for anything), so a
//     fail-fast window buys nothing, and it would cost the words: a caller must keep hearing "FlareSolverr
//     is not reachable ... turn it on" for as long as that is true, and keep 3.1.2's retry for a blip.
//     The pool only remembers it (state.solverRefused, for System Health) until FlareSolverr answers.
// Any other failure (one reset keep-alive socket after a restart, TLS, DNS) does neither.
//
// The console hears of it once per episode: from the first failure until FlareSolverr answers
// again (navigation.js clears state.downReported). The fail-fast window opens again every time it
// lapses and a protected-site call tries, and a line each time would repeat for as long as nothing
// answers. A user who switched FlareSolverr off on purpose (the lifecycle knows, ports.isOffByChoice)
// is told nothing: a refused connection is what they chose.
//
// createTransportFailure({ state, cfg, ports, rejectQueued }) returns
// onTransportFailure(err, slot): `slot` is the session the request was for, or
// null. The error itself is never touched: whoever got it rethrows the same object.

// The console line of an episode, once; silent for a user who switched FlareSolverr off on purpose.
function sayOnce(ctx, line) {
  const { state, ports } = ctx;
  if (state.downReported || ports.isOffByChoice()) return;
  state.downReported = true;
  ports.warn(line);
}

// The solver is wedged: refuse what is queued and fail new jobs fast for a while.
function openFailFastWindow(ctx) {
  const { state, cfg, ports } = ctx;
  const wasUp = ports.now() >= state.downUntil;
  state.downUntil = ports.now() + cfg.downAfterWedgeMs;
  if (!wasUp) return;
  ctx.rejectQueued(POOL_ERROR_CODES.DOWN);
  sayOnce(ctx, `FlareSolverr is not answering; jobs fail fast for ${Math.round(cfg.downAfterWedgeMs / 1000)} s.`);
}

function onTransportFailure(ctx, err, slot) {
  const { state, ports } = ctx;
  ports.noteLastError('transport');
  for (const other of state.slots.values()) other.lastOkAt = 0;
  const wedged = isTimeoutError(err);
  // Our own abort leaves the browser in whatever state it was: it may still be
  // in the middle of the navigation, so the session is not reused as it is.
  if (slot && wedged) slot.suspect = true;
  // A restart is the reason it does not answer, and a pool that is off has no opinion.
  if (!state.enabled || state.restarting) return;
  state.solverRefused = !wedged && isSolverDown(err);
  if (wedged) {
    openFailFastWindow(ctx);
  } else if (state.solverRefused) {
    sayOnce(ctx, 'FlareSolverr is not reachable (the connection was refused); protected sites fail until it is back.');
  }
}

function createTransportFailure({ state, cfg, ports, rejectQueued }) {
  const ctx = { state, cfg, ports, rejectQueued };
  return (err, slot) => onTransportFailure(ctx, err, slot);
}

module.exports = { createTransportFailure };
