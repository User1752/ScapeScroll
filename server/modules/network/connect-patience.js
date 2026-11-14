'use strict';

const limits = require('../../config/limits');

// How long Node waits for ONE address of a site before it tries the next. A site usually has several addresses (a CDN gives a handful of
// IPv4 and IPv6 ones) and Node tries them one after another, giving each only 250 ms; when every attempt is slower than that, which a busy
// connection, a home server under a burst of health probes or a far-away site makes easy, the call fails at once with
// "fetch failed (ETIMEDOUT)" although the site is up (measured on a CasaOS box: the same sites passed one by one and failed together).
// A longer wait per address costs nothing when the network is quick and turns those failures into slow successes.
//
// Called once at start-up (server.js). If the person already chose a value (NODE_OPTIONS=--network-family-autoselection-attempt-timeout=...)
// it is left alone.

const NODE_DEFAULT_MS = 250;

/**
 * @param {typeof import('net')} [netModule]
 * @param {number} [ms]
 * @returns {boolean} true when the value was raised
 */
function raiseConnectPatience(netModule = require('net'), ms = limits.connectAttemptTimeoutMs) {
  if (typeof netModule.setDefaultAutoSelectFamilyAttemptTimeout !== 'function') return false;
  const current = typeof netModule.getDefaultAutoSelectFamilyAttemptTimeout === 'function'
    ? netModule.getDefaultAutoSelectFamilyAttemptTimeout()
    : NODE_DEFAULT_MS;
  if (current !== NODE_DEFAULT_MS) return false;
  netModule.setDefaultAutoSelectFamilyAttemptTimeout(ms);
  return true;
}

module.exports = { raiseConnectPatience, NODE_DEFAULT_MS };
