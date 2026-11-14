'use strict';

const { recordError: defaultRecordError } = require('../../error-logger');

// The pool's effects on the outside world, as functions every part can call
// without caring how they are implemented: the clock, timers that never keep the
// process alive, the log, the error registry, and the three hooks the app gives
// the pool. Each is built from what createSolverPool() was injected with (so a
// test supplies a fake clock, a recording logger, ...) and none of them can
// throw into the pool: a failing logger or hook must not stop a job.

const AREA = 'solver-pool';
const LOG_PREFIX = '[SolverPool]';

// Timers are unref'd here and only here, so "no pool timer keeps the process
// alive" is one line to check.
function buildTimers(deps) {
  const setTimerImpl = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimerImpl = deps.clearTimer || ((handle) => clearTimeout(handle));

  function startTimer(fn, ms) {
    const handle = setTimerImpl(fn, ms);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return handle;
  }

  function stopTimer(handle) {
    if (handle) clearTimerImpl(handle);
  }

  const sleep = (ms) => new Promise((resolve) => { startTimer(resolve, ms); });
  return { startTimer, stopTimer, sleep };
}

function buildDiagnostics(deps, state, now) {
  const writeLog = deps.log || ((message) => console.log(message));
  const writeWarn = deps.warn || ((message) => console.warn(message));
  const reportError = deps.recordError || defaultRecordError;
  const loggedOnce = new Set();

  // Never throws: the pool says things from inside its own bookkeeping (a circuit that has just
  // opened, a restart that must still be settled), so a failing logger must not cut them short.
  const guarded = (write) => (message) => {
    try {
      write(`${LOG_PREFIX} ${message}`);
    } catch (_) {
      // nothing to do
    }
  };
  const log = guarded(writeLog);
  const warn = guarded(writeWarn);

  function warnOnce(key, message) {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    warn(message);
  }

  // Never throws and never rejects: a failing logger must not stop the pool.
  function record(code, message, details) {
    try {
      Promise.resolve(reportError({ code, area: AREA, message, details })).catch(() => {});
    } catch (_) {
      // nothing to do
    }
  }

  const isoNow = () => {
    const t = now();
    return new Date(Number.isFinite(t) ? t : Date.now()).toISOString();
  };

  // What System Health shows as the last error: a kind, never a message.
  function noteLastError(kind) {
    state.lastError = { at: isoNow(), kind };
  }

  return { log, warn, warnOnce, record, noteLastError };
}

// The hooks are looked up at call time (a test may swap one) and called as
// methods of the object they came in.
function buildHookCalls(hooks) {
  function noteUsed() {
    try {
      if (typeof hooks.noteUsed === 'function') hooks.noteUsed();
    } catch (_) {
      // a failing hook must not break the pool
    }
  }

  function recoverSolver() {
    try {
      if (typeof hooks.recoverFromHang === 'function') hooks.recoverFromHang();
    } catch (_) {
      // a failing hook must not break the pool
    }
  }

  function reportProxyFault(fingerprint) {
    if (typeof hooks.onProxyFault !== 'function') return;
    try {
      hooks.onProxyFault({ fingerprint });
    } catch (_) {
      // a failing hook must not break the pool
    }
  }

  // Whether the user switched FlareSolverr off on purpose (the lifecycle knows): then a connection
  // that is refused is what they chose, the pool does not say it is not reachable, and System Health
  // says the browser is waiting for a FlareSolverr that is off. What the hook cannot answer is "no".
  function isOffByChoice() {
    try {
      return typeof hooks.isOffByChoice === 'function' && hooks.isOffByChoice() === true;
    } catch (_) {
      return false;
    }
  }

  // Whoever restarts FlareSolverr announces it through this registration; the
  // answer (an unsubscribe function) is kept by restart.js. Null when the app
  // gave no registration.
  const subscribeRestart = typeof hooks.onRestart === 'function' ? (listener) => hooks.onRestart(listener) : null;

  return { noteUsed, recoverSolver, reportProxyFault, isOffByChoice, subscribeRestart };
}

function createPorts(deps, state) {
  const now = deps.now || Date.now;
  return Object.freeze({
    now,
    ...buildTimers(deps),
    ...buildDiagnostics(deps, state, now),
    ...buildHookCalls(deps.hooks || {}),
  });
}

module.exports = { createPorts };
