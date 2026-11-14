'use strict';

// Start-up checks that decide whether the app may boot at all, kept out of
// server.js (GUIDELINES: server.js stays thin). Everything that touches the
// process or the console is injectable, so the refusal paths are testable
// without exiting the test runner.

const startupConfig = require('../../config/startup');

function consoleIsInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// Blocking on purpose: it runs while server.js is still loading, before any
// event loop work could wait for a key.
function pauseSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Resolves the folder that holds the user's library, or explains why it cannot
 * (SCROLLSCAPE_HOME unusable, two libraries, ...) and exits. Never starts an
 * empty library somewhere else.
 *
 * @param {{ getAppRoot: () => string, interactive?: () => boolean, pause?: (ms: number) => void,
 *           log?: (msg: string) => void, exit?: (code: number) => never, config?: object }} deps
 */
function resolveUserRootOrExit({
  getAppRoot,
  interactive = consoleIsInteractive,
  pause = pauseSync,
  log = console.error,
  exit = process.exit,
  config = startupConfig,
}) {
  try {
    return getAppRoot();
  } catch (err) {
    log(`[Setup] ${err.message}`);
    // A double-clicked exe's window closes the moment the process exits.
    if (interactive()) pause(config.fatalPauseMs);
    return exit(1);
  }
}

/**
 * Prints why the app is stopping and, on a console, waits briefly for Enter so
 * the message can be read before the window closes.
 */
function exitWithMessage(message, code = 1, {
  interactive = consoleIsInteractive,
  stdin = process.stdin,
  log = console.error,
  exit = process.exit,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  config = startupConfig,
} = {}) {
  log(message);
  if (!interactive()) { exit(code); return; }
  log('Press Enter to close this window.');
  const timer = setTimer(() => exit(code), config.closePromptTimeoutMs);
  stdin.once('data', () => { clearTimer(timer); exit(code); });
  stdin.resume();
}

/**
 * One ScrollScape per library: two processes keep separate in-memory copies of
 * store.json and overwrite each other. Packaged exe only. The lock is advisory
 * and fails open (see acquireInstanceLock): it only refuses a confirmed live owner.
 * Resolves to true when boot may continue; when refused it reports and never resolves
 * (the exit is already on its way), so nothing after it runs.
 */
function guardSingleInstance({
  isPkg,
  userRoot,
  acquireInstanceLock,
  onProcessExit = (release) => process.on('exit', release),
  warn = console.warn,
  report = exitWithMessage,
}) {
  if (!isPkg) return Promise.resolve(true);
  const lock = acquireInstanceLock(userRoot);
  if (lock.warning) warn(`[Setup] Single-instance check skipped: ${lock.warning}.`);
  if (lock.ok) {
    onProcessExit(lock.release);
    return Promise.resolve(true);
  }
  const who = lock.host
    ? ` on the PC named ${lock.host}`
    : (Number.isFinite(lock.pid) ? ` (PID ${lock.pid})` : '');
  report(`[Setup] ScrollScape is already running from ${userRoot}${who}. `
    + `Use that window, or close it first. If it is not running, delete ${lock.file}.`);
  return new Promise(() => {});
}

module.exports = { resolveUserRootOrExit, exitWithMessage, guardSingleInstance };
