'use strict';

const { createHash } = require('crypto');
const { POOL } = require('../../../config/solver');
const { isPlainObject } = require('./plain-object');

// What the browser is pointed at, as the pool keeps it: the answer of the
// injected getSolverProxy() reduced to { proxy, mode, fingerprint } and nothing
// else, so a stray field can never reach FlareSolverr. The only proxy a browser
// can be pointed at is the one in Settings, so `mode` is 'user-proxy' or 'none'.

const NO_PROXY = Object.freeze({ proxy: null, mode: 'none', fingerprint: 'none' });

// A short hash of the proxy including its password: the fingerprint that tells the pool the proxy
// changed, without the password (or even the user name) ever showing in a log or in System Health.
function hashProxy(proxy) {
  return createHash('sha1').update(`${proxy.url}\n${proxy.username || ''}\n${proxy.password || ''}`).digest('hex').slice(0, POOL.fingerprintHexChars);
}

// Only url, username and password survive. A proxy without a fingerprint gets a
// hashed one (the password is part of the hash, never of the fingerprint text).
function normalizeProxyInfo(info) {
  if (!isPlainObject(info)) return NO_PROXY;
  const source = isPlainObject(info.proxy) && info.proxy.url ? info.proxy : null;
  if (!source) return NO_PROXY;
  const proxy = { url: source.url };
  if (source.username) proxy.username = source.username;
  if (source.password) proxy.password = source.password;
  return {
    proxy,
    mode: 'user-proxy',
    fingerprint: String(info.fingerprint || hashProxy(proxy)),
  };
}

// What the browser is pointed at. A lookup that throws fails the job: carrying
// on without the proxy would send a user who configured one out on their own IP.
function createProxyResolver(getSolverProxy) {
  return async function resolveProxy(solverUrl) {
    return normalizeProxyInfo(await getSolverProxy(solverUrl));
  };
}

module.exports = { NO_PROXY, hashProxy, normalizeProxyInfo, createProxyResolver };
