'use strict';

// Who hears about a FlareSolverr restart. Every browser session the solver pool
// holds lives inside FlareSolverr's process and dies with it, so the pool has to
// hear that the process is about to be replaced (it stops trusting its session
// ids and holds its queue) and when the new one is answering again. The
// lifecycle module announces (emitRestart); whoever cares subscribes
// (registerRestartListener, re-exported by flaresolverr-lifecycle.js).
//
// A registry of its own rather than a member of the lifecycle's `io`: a listener
// is wired once, when the pool is built, whereas `io` is what a single call is
// handed (the tests give every call a fake one). Nothing here touches a file, a
// process or a timer.

const restartListeners = new Set();

/**
 * Calls `listener` with { phase: 'begin', reason } when a restart is really going
 * ahead and with { phase: 'end', ok } when it is over, `ok` meaning FlareSolverr
 * answers its port again. Returns the function that unsubscribes it.
 */
function registerRestartListener(listener) {
  if (typeof listener !== 'function') throw new TypeError('A restart listener must be a function.');
  // An entry of its own, so registering the same function twice and
  // unsubscribing one of them leaves the other in place.
  const entry = { listener };
  restartListeners.add(entry);
  return () => { restartListeners.delete(entry); };
}

// A listener that throws, or an async one that rejects, is reported through
// `warn` and skipped: a restart is what keeps the app's browser alive, and a bug
// in an observer must not stop it (nor turn into an unhandled rejection that
// stops the process).
function emitRestart(phase, detail, warn) {
  const report = (err) => warn(`[FlareSolverr] A restart listener failed on '${phase}': ${err && err.message}`);
  for (const { listener } of [...restartListeners]) {
    try {
      const result = listener({ phase, ...detail });
      if (result && typeof result.catch === 'function') result.catch(report);
    } catch (err) {
      report(err);
    }
  }
}

module.exports = { registerRestartListener, emitRestart };
