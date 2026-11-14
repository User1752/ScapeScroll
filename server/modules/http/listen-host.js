'use strict';

/**
 * Which network interface the server listens on.
 *
 * `HOST` always wins when set. Otherwise the packaged exe is loopback-only,
 * and everything else uses `fallback` (the caller's per-branch default).
 * Loopback means "this computer only": the right choice on a café/office
 * network, where anyone else on the LAN could otherwise open your library.
 *
 * @param {{ env?: NodeJS.ProcessEnv, isPkg?: boolean, fallback?: string }} [options]
 * @returns {string}
 */
function resolveListenHost({ env = process.env, isPkg = false, fallback = '0.0.0.0' } = {}) {
  const requested = String(env?.HOST || '').trim();
  if (requested) return requested;
  return isPkg ? '127.0.0.1' : fallback;
}

/** @param {string} host */
function isLoopbackHost(host) {
  return ['127.0.0.1', '::1', 'localhost'].includes(String(host || '').trim().toLowerCase());
}

module.exports = { resolveListenHost, isLoopbackHost };
