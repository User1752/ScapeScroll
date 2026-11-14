'use strict';

// Node's fetch says only "fetch failed" when the network fails: the reason (ETIMEDOUT, ECONNRESET, ENOTFOUND, EAI_AGAIN, a certificate)
// sits in err.cause. Every source that reports err.message, System Health and the error log showed the bare words, which is how a
// home-network IPv6 problem took a whole evening of commands on a CasaOS box to find.
//
// Installed once, at start-up (server.js): the SAME error object is rethrown with the reason added to its message ("fetch failed
// (ETIMEDOUT)"), so nothing that looks for /fetch failed/ stops matching, err.cause and err.name are untouched, and a call that
// succeeds, or fails for any other reason (an abort, a bad URL), is not touched at all. The reason is a code, never an address.

const REASON_MAX = 40;

// The code of the failure: the cause's own, or the first of an AggregateError (what trying several addresses in a row leaves).
function reasonOf(err) {
  const cause = err && err.cause;
  if (!cause || typeof cause !== 'object') return '';
  const inner = Array.isArray(cause.errors) ? cause.errors.find((e) => e && e.code) : null;
  const code = cause.code || (inner && inner.code) || cause.name || '';
  return String(code).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, REASON_MAX);
}

/**
 * Wraps `target.fetch` once. Returns true when it did, false when it was already wrapped (or there is no fetch).
 * @param {{ fetch?: Function }} [target]  where fetch lives (the global object; a test passes its own)
 */
function installFetchCause(target = globalThis) {
  const original = target.fetch;
  if (typeof original !== 'function' || original.addsCause === true) return false;
  const wrapped = async function fetch(...args) {
    try {
      return await original.apply(this, args);
    } catch (err) {
      if (err instanceof TypeError && err.message === 'fetch failed') {
        const reason = reasonOf(err);
        if (reason) {
          try { err.message = `fetch failed (${reason})`; } catch (_) { /* a frozen error keeps its words */ }
        }
      }
      throw err;
    }
  };
  wrapped.addsCause = true;
  target.fetch = wrapped;
  return true;
}

module.exports = { installFetchCause, reasonOf };
