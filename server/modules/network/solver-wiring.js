'use strict';

const { ENV_NAMES, MESSAGES } = require('../../config/solver');
const { flagState, warnOnce, shown } = require('../common/env-flags');
const { normalizeSolverSettings } = require('../common/solver-settings');
const { hashProxy } = require('./solver/proxy-info');

// What the app tells the FlareSolverr session pool, and the little it asks the app
// in return. The pool starts OFF and works out nothing for itself, so the three
// callers that know the settings (server.js at boot, POST /api/settings after a
// save, the startup sweep) all go through here: one place decides what "on" means.
//
// Interface:
//   resolveSolverSettings(settings, env)   the pure decision: what the pool is told
//   applySolverSettings(pool, settings, env)   tell it; never throws
//   sweepSolverOrphans(pool, getSolverUrl)   once per process, after FlareSolverr is up; never throws
//   createUserProxyProvider(readProxyConfig) the pool's getSolverProxy: the proxy of Settings > Proxy
//   proxyFingerprint(proxy)                  how a change of that proxy is noticed

// SCROLLSCAPE_SOLVER_SESSIONS_DISABLED is a brake, so a value that is not understood
// still applies it (staying off is the safe way to be wrong). The warn-once memory is
// shared by every env switch of the process, hence the key prefix of our own.
function envSwitchesPoolOff(env) {
  const state = flagState(env, ENV_NAMES.solverSessionsDisabled);
  if (state === 'unknown') {
    const raw = env[ENV_NAMES.solverSessionsDisabled];
    warnOnce(`solver-sessions-disabled=${raw}`,
      `[SolverPool] ${ENV_NAMES.solverSessionsDisabled}=${shown(raw)} is not understood (use 1 or 0); treating it as 1, so the hidden browser is not reused.`);
  }
  return state !== 'off';
}

/**
 * What the pool is told, from the stored settings and the environment.
 * `disabledBy` is what System Health reports: the pool cannot tell a setting from the
 * environment switch by itself. Junk in the settings becomes the defaults.
 *
 * @returns {{ enabled: boolean, disabledBy: 'env'|'setting'|null, maxSessions: number, idleMinutes: number }}
 */
function resolveSolverSettings(settings, env = process.env) {
  const wanted = normalizeSolverSettings(settings);
  const envOff = envSwitchesPoolOff(env || {});
  let disabledBy = null;
  if (envOff) disabledBy = 'env';
  else if (!wanted.solverSessionsEnabled) disabledBy = 'setting';
  return {
    enabled: disabledBy === null,
    disabledBy,
    maxSessions: wanted.solverSessionPoolSize,
    idleMinutes: wanted.solverSessionIdleMinutes,
  };
}

/**
 * Applies the settings to the pool. Never throws: a settings save that already reached
 * the disk must not turn into a 500 because the pool could not be told. Returns what it
 * told the pool (or null when it could not).
 */
function applySolverSettings(pool, settings, env = process.env) {
  try {
    const applied = resolveSolverSettings(settings, env);
    pool.applySettings(applied);
    return applied;
  } catch (err) {
    console.warn(`[SolverPool] Could not apply the browser-session settings: ${err && err.message}`);
    return null;
  }
}

/**
 * Once per process, after FlareSolverr had its chance to come up: closes the sessions a
 * previous run of this app left behind. The pool decides whether to do anything (nothing
 * while it is off, nothing for a FlareSolverr that is not on this computer). Resolves with
 * the number closed and never rejects, so a failure can not hold up what follows.
 */
async function sweepSolverOrphans(pool, getSolverUrl) {
  try {
    return await pool.sweepOrphans(await getSolverUrl());
  } catch (err) {
    console.warn(`[SolverPool] The sweep for old browser sessions failed: ${err && err.message}`);
    return 0;
  }
}

// The prefix says whose proxy it is; a new password gives a new fingerprint, so the session is recycled
// (proxy-info.js hashProxy keeps the password out of every log).
function proxyFingerprint(proxy) {
  return `user:${hashProxy(proxy)}`;
}

/**
 * The pool's getSolverProxy: the proxy of Settings > Proxy, or null when none is set.
 * The pool asks before every job and recycles the session between jobs when the answer
 * changed, so a change in Settings needs no message to the pool.
 *
 * `readProxyConfig` resolves the proxy, null when unset, and REJECTS when the setting cannot be read.
 * Those are different: a job sent without the proxy of a user who configured one would leave on their
 * own address. So once a proxy has been seen, a read that fails fails the job (in words that say why,
 * the cause kept) until a read works again. Before any proxy was seen nothing is at stake, and an
 * unreadable setting means none, as it always did (the store is not up yet, or this module is used
 * without the app's store).
 */
function createUserProxyProvider(readProxyConfig) {
  let lastSeen = null; // the proxy the last successful read found
  return async function getSolverProxy() {
    let proxy;
    try {
      proxy = await readProxyConfig();
    } catch (err) {
      if (lastSeen) throw new Error(MESSAGES.proxyUnreadable, { cause: err });
      return null;
    }
    lastSeen = proxy || null;
    return proxy ? { proxy, mode: 'user-proxy', fingerprint: proxyFingerprint(proxy) } : null;
  };
}

module.exports = {
  resolveSolverSettings,
  applySolverSettings,
  sweepSolverOrphans,
  proxyFingerprint,
  createUserProxyProvider,
};
