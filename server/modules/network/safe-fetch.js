'use strict';

// fetch() for URLs that a client (or a third-party server) gets to choose.
//
// isSafeUrl() only judges the URL it is handed. The built-in fetch then
// follows redirects on its own, so "https://public.example/x" answering
// "302 Location: http://127.0.0.1:4000/api/settings" walks straight past it —
// and because the second request is made by this very process it arrives
// from loopback, which the local-only guard (middleware/local-only.js)
// treats as the owner. That turned every URL-taking relay into a way for any
// LAN client to read the settings and the whole backup.
//
// safeFetch closes that by following redirects itself and re-checking every
// hop: the scheme and literal host (isSafeUrl) AND what the host name
// resolves to, so a public-looking name that points at 127.0.0.1 is refused
// as well.
//
// Known limit: the name is resolved here and again inside fetch(), so a DNS
// server that answers differently the second time (rebinding with TTL 0) can
// still slip through. Closing that needs the connection itself pinned to the
// address checked here, which the built-in fetch cannot do.

const dns = require('dns').promises;
const net = require('net');
const { isSafeUrl, isPrivateAddress } = require('../common/sanitize');

// Native fetch allows 20; a chain of http -> https -> www -> /path -> localised
// path is normal, but nothing legitimate needs twenty hops.
const MAX_REDIRECTS = 10;
// A resolver that never answers must not stall a request that fetch() itself
// would have timed out: the lookup below runs before fetch() sees any signal.
const DNS_LOOKUP_TIMEOUT_MS = 5000;
const PUBLIC_HOST_TTL_MS = 30_000;
const PUBLIC_HOST_CACHE_MAX = 500;
const publicHosts = new Map(); // host -> time it last resolved to public addresses only
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Credentials meant for one origin must not follow a redirect to another —
// the same rule fetch() applies when it follows redirects itself.
const CROSS_ORIGIN_STRIPPED_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
// Describe the request body, so they go when a redirect turns the request into
// a body-less GET (fetch() drops the same set).
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location'];

// UNSAFE_URL is a permanent verdict, not a network blip: callers that retry
// transient failures (fetchJson, fetchText, fetchImageBuffer) check this code
// so a blocked target is not tried three times with a back-off in between.
function blockedError(message = 'Blocked unsafe URL') {
  const err = new Error(message);
  err.code = 'UNSAFE_URL';
  return err;
}

// Headers arrive as latin-1 text; a server that sends the redirect target as raw
// UTF-8 ("Location: /café") would be percent-encoded twice by new URL() and
// fetched at the wrong address, where native fetch decodes it as UTF-8 first.
function decodeLocation(raw) {
  for (let i = 0; i < raw.length; i++) {
    if (raw.charCodeAt(i) > 0x7f) return Buffer.from(raw, 'latin1').toString('utf8');
  }
  return raw;
}

function lookupWithTimeout(lookup, host, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`DNS lookup for ${host} timed out`), { code: 'DNS_TIMEOUT' }));
    }, timeoutMs);
  });
  return Promise.race([lookup(host, { all: true }), timeout]).finally(() => clearTimeout(timer));
}

// Throws unless `rawUrl` is http(s) and neither its literal host nor any
// address its name resolves to is private/loopback/link-local. A name that
// fails to resolve is let through: fetch() cannot reach it either, and the
// resulting error is the more useful one to surface.
async function assertPublicUrl(rawUrl, { lookup = dns.lookup, lookupTimeoutMs = DNS_LOOKUP_TIMEOUT_MS } = {}) {
  if (!isSafeUrl(rawUrl)) throw blockedError();
  const host = new URL(rawUrl).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return;
  // A reader page asks for dozens of images from the same few hosts; resolving
  // each one again (plus the resolution fetch() does itself) is wasted latency.
  // Only a "public" verdict is remembered, and only briefly.
  const checkedAt = publicHosts.get(host);
  if (checkedAt !== undefined && Date.now() - checkedAt < PUBLIC_HOST_TTL_MS) return;
  let addresses;
  try {
    addresses = await lookupWithTimeout(lookup, host, lookupTimeoutMs);
  } catch (err) {
    if (err.code === 'DNS_TIMEOUT') throw err;
    return;
  }
  if (addresses.some(entry => isPrivateAddress(entry.address))) {
    throw blockedError('Blocked unsafe URL (host resolves to a private address)');
  }
  if (publicHosts.size >= PUBLIC_HOST_CACHE_MAX) publicHosts.clear();
  publicHosts.set(host, Date.now());
}

function withoutCredentials(headers) {
  const copy = new Headers(headers);
  for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) copy.delete(name);
  return copy;
}

/**
 * Drop-in for fetch(url, init) with SSRF protection on every hop.
 * `init.redirect` other than 'follow' (or unset) is passed through untouched,
 * since the caller then handles redirects — and their safety — itself.
 *
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @param {{ maxRedirects?: number, fetchImpl?: Function, assertUrl?: Function }} [deps]
 */
async function safeFetch(url, init = {}, deps = {}) {
  const {
    maxRedirects = MAX_REDIRECTS,
    fetchImpl = fetch,
    assertUrl = assertPublicUrl,
  } = deps;

  if (init.redirect && init.redirect !== 'follow') {
    await assertUrl(String(url));
    return fetchImpl(url, init);
  }

  let current = String(url);
  let { method, body, headers } = init;
  for (let hop = 0; ; hop++) {
    await assertUrl(current);
    const res = await fetchImpl(current, { ...init, method, body, headers, redirect: 'manual' });

    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null;
    if (!location) return res;

    if (hop >= maxRedirects) {
      res.body?.cancel?.().catch(() => {});
      throw new Error(`Too many redirects (more than ${maxRedirects})`);
    }

    let next;
    try {
      next = new URL(decodeLocation(location), current);
    } catch {
      res.body?.cancel?.().catch(() => {});
      throw blockedError('Blocked unsafe URL (malformed redirect target)');
    }
    // Free the connection of the redirect response nobody will read.
    res.body?.cancel?.().catch(() => {});

    if (next.origin !== new URL(current).origin && headers) headers = withoutCredentials(headers);
    // As fetch() does: 303 always becomes a body-less GET, and so do 301/302
    // answers to a POST. 307/308 replay the request unchanged.
    const methodName = String(method || 'GET').toUpperCase();
    if (res.status === 303 ? methodName !== 'HEAD' : (res.status === 301 || res.status === 302) && methodName === 'POST') {
      method = 'GET';
      body = undefined;
      if (headers) {
        headers = new Headers(headers);
        for (const name of BODY_HEADERS) headers.delete(name);
      }
    }
    current = next.href;
  }
}

module.exports = { safeFetch, assertPublicUrl, MAX_REDIRECTS };
