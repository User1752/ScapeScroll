'use strict';

const { isPlainObject } = require('./plain-object');
const { describeSolverMessage } = require('./classify');

// Speaking to FlareSolverr: the HTTP post, and the shape of every command the pool
// sends. Every payload is built HERE and nowhere else, because what a command
// must not carry is the whole point (each was a trap in FlareSolverr 3.5.2):
//   - `proxy` is read only by `sessions.create`; a session request that carries
//     one is ignored, and session_ttl_minutes would drop it on expiry;
//   - cookies in a session payload stay for every later caller;
//   - `request.get` for a session id FlareSolverr does not know silently creates
//     an UNPROXIED session, so requestInSession() refuses an id this process has
//     not seen confirmed, or that is being (or has been) destroyed.

// Node's refusal of a URL with user:pass@ in it (a FlareSolverr behind a basic-auth proxy) echoes the whole address,
// password included, in the message and in the first line of the stack. Callers hand that text to a source's
// error and so to the error log, so the address is taken out here, at the one place it can come from. Only the
// text changes: it is still the same error object, name and cause, and a message without an address is not touched.
function withoutAddress(err) {
  const message = err && err.message;
  if (typeof message !== 'string' || !message.includes('://')) return err;
  const clean = describeSolverMessage(message);
  Object.defineProperty(err, 'message', { value: clean, configurable: true, writable: true });
  if (typeof err.stack === 'string') {
    Object.defineProperty(err, 'stack', { value: err.stack.split(message).join(clean), configurable: true, writable: true });
  }
  return err;
}

// POST JSON to FlareSolverr. Resolves for ANY HTTP status (FlareSolverr answers
// its errors with 500 and a JSON body that says what went wrong); the body is
// null when it is not a JSON object. Rejects with the raw fetch error, the same
// object (its text without any address, see withoutAddress), so a caller can still
// tell a refused connection from a timeout.
// globalThis.fetch is looked up at call time so a test that stubs it works.
async function defaultPost(solverUrl, payload, { timeoutMs }) {
  let res;
  try {
    res = await globalThis.fetch(solverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw withoutAddress(err);
  }
  // An abort while the body streams rejects here untouched; only a body that is
  // not JSON is swallowed.
  const text = await res.text();
  let body = null;
  try {
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed)) body = parsed;
  } catch (_) {
    body = null;
  }
  return { httpStatus: res.status, body };
}

// The legacy one-off request: what the app sent before the pool existed, and what
// the stateless lane and the pass-through path still send.
function statelessPayload(url, maxTimeout, cookies, proxy) {
  const payload = { cmd: 'request.get', url, maxTimeout };
  if (Array.isArray(cookies) && cookies.length) payload.cookies = cookies;
  if (proxy) payload.proxy = proxy;
  return payload;
}

// { transport } when the request itself failed (the raw error, never wrapped);
// otherwise { httpStatus, body } whatever the status was. Any answer at all, an error included, tells
// whoever listens (ctx.onAnswer) that FlareSolverr is there.
async function callSolver(ctx, solverUrl, payload, timeoutMs) {
  let res;
  try {
    res = await ctx.post(solverUrl, payload, { timeoutMs });
  } catch (err) {
    return { transport: err };
  }
  if (ctx.onAnswer) ctx.onAnswer();
  return {
    httpStatus: Number.isInteger(res && res.httpStatus) ? res.httpStatus : 0,
    body: isPlainObject(res && res.body) ? res.body : null,
  };
}

// The only place a request for a session is sent. It refuses an id that was not
// confirmed by this process, or whose session is being closed or went with a
// restart. The payload is built here and holds nothing else.
async function requestInSession(ctx, slot, url, maxTimeout, timeoutMs) {
  if (slot.dead || slot.status === 'closing' || !slot.id || !slot.confirmed) return { refused: true };
  return callSolver(ctx, slot.solverUrl, { cmd: 'request.get', session: slot.id, url, maxTimeout }, timeoutMs);
}

function createSession(ctx, solverUrl, id, proxy) {
  const payload = { cmd: 'sessions.create', session: id };
  if (proxy) payload.proxy = proxy;
  return callSolver(ctx, solverUrl, payload, ctx.cfg.sessionCreateTimeoutMs);
}

/**
 * { post, cfg, onAnswer? } -> the commands, each resolving like callSolver ({ transport } or
 * { httpStatus, body }); requestInSession also resolves { refused: true } when it
 * would have been unsafe to send. `onAnswer` is called whenever FlareSolverr answered a request.
 *
 * callSolver itself is private on purpose: nothing that receives this object can send a payload of
 * its own, so "a request.get is only ever sent for a confirmed session, through requestInSession"
 * holds by construction and not by convention.
 */
function createTransport({ post, cfg, onAnswer }) {
  const ctx = { post, cfg, onAnswer };
  return {
    createSession: (solverUrl, id, proxy) => createSession(ctx, solverUrl, id, proxy),
    listSessions: (solverUrl) => callSolver(ctx, solverUrl, { cmd: 'sessions.list' }, cfg.sessionListTimeoutMs),
    destroySession: (solverUrl, id) => callSolver(ctx, solverUrl, { cmd: 'sessions.destroy', session: id }, cfg.sessionDestroyTimeoutMs),
    requestInSession: (slot, url, maxTimeout, timeoutMs) => requestInSession(ctx, slot, url, maxTimeout, timeoutMs),
    requestStateless: (solverUrl, url, maxTimeout, cookies, proxy) => callSolver(
      ctx,
      solverUrl,
      statelessPayload(url, maxTimeout, cookies, proxy),
      maxTimeout + cfg.requestAbortGraceMs,
    ),
  };
}

module.exports = { defaultPost, statelessPayload, createTransport };
