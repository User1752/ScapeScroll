'use strict';

/*
 * A fake FlareSolverr 3.5.2 on 127.0.0.1, for the solver pool's tests. No browser,
 * no network beyond loopback, no file is touched.
 *
 *   const fake = await startFakeFlareSolverr({ latencyMs: 0, launchMs: 0 });
 *   t.after(() => fake.stop());            // every test closes it, or node --test hangs
 *   fake.url                               // 'http://127.0.0.1:<port>/v1'   (POST)
 *   fake.baseUrl                           // 'http://127.0.0.1:<port>/'     (GET -> { msg, version, userAgent })
 *
 * WHAT IT MODELS (read from sessions.py / flaresolverr_service.py of 3.5.2; the traps the pool is built around)
 *   1. request.get with an UNKNOWN session id silently creates an UNPROXIED session
 *      (fake.lazyCreated, log entry .lazy). The answer does not say so.
 *   2. request.get ignores `proxy` for an existing session: the browser keeps the proxy it was created with
 *      (log entry .usedProxy is what Chrome really ran with; .proxy is what the caller sent).
 *   3. session_ttl_minutes older than the session recreates its browser WITHOUT the proxy (fake.ttlDropped).
 *      fake.ageSession(id, ms) makes a session that old without waiting.
 *   4. sessions.create is idempotent: a second create for an id that exists answers "Session already
 *      exists." and does NOT apply the new proxy. A session is in the table (and in sessions.list) only
 *      once its browser has launched (launchMs after the create arrived).
 *   5. There is no lock per session. Overlapping calls on one session collide (fake.collisions, .collided)
 *      and each of them gets the page of the LAST navigation, not necessarily its own. A latencyMs (or a
 *      delayMs) is what makes calls overlap at all: with none, every call finishes before the next arrives.
 *   6. A request.get with no session launches a browser of its own and quits it afterwards (fake.launches,
 *      .stateless): its cookies are gone with it. Cookies in the payload of a SESSION call go into that
 *      session's jar and stay for every later call on it.
 *   7. sessions.destroy of an unknown id is an error. A destroy takes effect when it ARRIVES (the id is
 *      already gone while the reply is still on its way, so a request.get for it lazily recreates it
 *      unproxied) and it kills a request that is still running on that session.
 *   8. A request.get that takes longer than its maxTimeout is answered with "Timeout after 35.0 seconds."
 *      (maxTimeout / 1000 as a Python float) after maxTimeout, and the session stays.
 *   9. Every error is { status: 'error', message: 'Error: ...' } with HTTP 500. Errors raised while solving
 *      are prefixed "Error solving the challenge. " and have newlines escaped as \n, as FlareSolverr does.
 *      (unverified until a real FlareSolverr shows them: the HTTP 500 carrier and every message other than MESSAGES.blocked,
 *      .timeout, .sessionMissing and .invalidCmd, which were read from the sources)
 *  10. about:blank (and data:text/html,) answer an empty page with no cookies (unverified until a real
 *      FlareSolverr shows that 3.5.2 accepts about:blank and answers it fast).
 *
 * SCRIPTING (the newest matching rule wins; an unscripted URL answers a page that contains its own URL)
 *   fake.page(urlOrRegex, outcome)   request.get navigations to that URL
 *   fake.command(cmd, outcome)       any call of 'sessions.create' | 'sessions.list' | 'sessions.destroy' | 'request.get'
 *   Both return the rule: { hits, remove() }. fake.clearRules() drops them all.
 *   outcome = {
 *     html, cookies,      page source, and the cookies the SITE sets (default: one cf_clearance for the host)
 *     delayMs,            extra time before the reply (inside the maxTimeout for request.get)
 *     errorMessage,       answer an error instead: the INNER text; the prefixes above are added. No effect on state
 *     kill,               with errorMessage, request.get only: the driver is dead - that session answers the same
 *                         error until destroyed, and its destroy answers an error although it IS removed
 *     httpStatus,         HTTP status of the reply (default 200, or 500 for an error)
 *     rawBody,            send this text instead of JSON (a relay's "Bad Gateway")
 *     hang,               never answer (a wedged FlareSolverr that never even started on the call: no effect on
 *                         state); released by restart() / stop()
 *     drop,               close the connection without answering
 *     times,              apply to the next N matching calls only
 *   }   drop, rawBody and httpStatus replace only the reply: the call's effect on state still happens.
 *
 * INSPECTION
 *   fake.log         one entry per /v1 call, in arrival order: { seq, t, endedAt, cmd, session, url, maxTimeout,
 *                    proxy, usedProxy, hadCookies, ttl, stateless, launched, lazy, ttlRecreated, existed,
 *                    collided, aborted, outcome, httpStatus, error }. t / endedAt are epoch ms (endedAt is null
 *                    until the call ends); outcome is 'ok' | 'error' | 'raw' | 'drop' | 'cancelled' (null while
 *                    running, and for a call that hangs); aborted means the client went away first.
 *   fake.sessions    Map id -> { id, proxy, lazy, requests, inflight, createdAt }
 *   fake.lazyCreated, fake.ttlDropped (ids), fake.collisions, fake.launches, fake.launchOverlaps (a launch
 *   that started while another was still launching), fake.inFlight, fake.peakInFlight
 *   fake.waitFor(predicate, { timeoutMs }) resolves with the first log entry the predicate accepts (now or later)
 *   fake.clearLog()
 *
 * PROCESS
 *   fake.latencyMs, fake.launchMs   may be changed at any time
 *   fake.restart()  a new process on the same port: every connection is cut, in-flight calls die, sessions
 *                   are gone; scripted rules and the log stay
 *   fake.stop()     the port refuses connections; sessions are gone (idempotent, safe in t.after)
 *   fake.start()    listens again on the SAME port (a stop() followed by start() is a restart with a refused
 *                   window in between); it also switches a switched-off fake on
 *   fake.switchOff() / fake.switchOn()
 *                   "FlareSolverr is not running" for a while, and back. Every fetch to the fake fails like a
 *                   refused connection (TypeError 'fetch failed', cause.code ECONNREFUSED) without touching the
 *                   network, in-flight calls die and sessions are gone, but the port stays HELD. That is the
 *                   difference from stop(): when many test processes run at once, the port stop() gives back can be
 *                   taken by another one before the test connects, and the "switched-off FlareSolverr" then answers.
 *                   A test that wants FlareSolverr away for a while (not the end of the fake) uses this.
 *
 * Every timer here is unref'd; the listening socket is not, so a test that awaits only unref'd timers of the
 * code under test is still kept alive while the fake is up.
 */

// How it is organised: this file is only the public face. The parts are in
// ./fake-solver/ and share one state object (state.js) instead of a closure:
//   texts, site-data   what it answers with; what a site shows and sets (pure)
//   signals, waits     the exceptions that steer it; waits a restart can release
//   rules, log         scripting; the log and fake.waitFor
//   browsers           what a session's browser is and what launching one costs
//   session-commands, request-get   the four commands
//   replies, dispatch, http-shell   answering, running one call, the HTTP server

const { createFakeState } = require('./fake-solver/state');
const { switchedOff } = require('./fake-solver/switched-off');
const { USER_AGENT, BLANK_HTML, MESSAGES, pageHtml } = require('./fake-solver/texts');
const { addRule } = require('./fake-solver/rules');
const { waitFor } = require('./fake-solver/log');
const { cancelPending } = require('./fake-solver/waits');
const { listen } = require('./fake-solver/http-shell');

// Lets the calls that were just cancelled finish their bookkeeping before the caller looks at the counters.
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

// The scripting and inspection methods of the public object.
function addScripting(state) {
  const { fake } = state;
  fake.page = (urlOrRegex, outcome) => addRule(state, 'request.get', urlOrRegex, outcome);
  fake.command = (cmd, outcome) => addRule(state, cmd, undefined, outcome);
  fake.clearRules = () => { state.rules.length = 0; };
  fake.clearLog = () => { fake.log.length = 0; };
  fake.ageSession = (id, ms) => {
    const browser = state.sessions.get(id);
    if (!browser) return false;
    browser.createdAt -= ms;
    return true;
  };
  fake.waitFor = (predicate, options) => waitFor(state, predicate, options);
}

// The process methods: restart (a new process on the same port), stop, start.
function addProcessControl(state) {
  const { fake } = state;
  fake.restart = async () => {
    cancelPending(state);
    state.sessions.clear();
    if (state.server) state.server.closeAllConnections();
    await settle();
  };

  // Switched off: the fake stays bound to its port, but nothing reaches it through fetch (fake-solver/switched-off.js),
  // and what it had in flight and its sessions are gone, as when the process dies.
  fake.switchOff = async () => {
    if (!state.server) return;
    switchedOff.add(fake.baseUrl);
    cancelPending(state);
    state.sessions.clear();
    state.server.closeAllConnections();
    await settle();
  };
  fake.switchOn = () => { switchedOff.delete(fake.baseUrl); };

  fake.stop = async () => {
    switchedOff.delete(fake.baseUrl);
    if (!state.server) return;
    const closing = state.server;
    state.server = null;
    cancelPending(state);
    state.sessions.clear();
    closing.closeAllConnections();
    await new Promise((resolve) => { closing.close(() => resolve()); });
    await settle();
  };

  fake.start = async () => {
    if (!state.server) await listen(state, fake.port);
    switchedOff.delete(fake.baseUrl);
    return fake;
  };
}

async function startFakeFlareSolverr({ version = '3.5.2', latencyMs = 0, launchMs = 0 } = {}) {
  const state = createFakeState({ version, latencyMs, launchMs });
  addScripting(state);
  addProcessControl(state);
  await listen(state, 0);
  return state.fake;
}

module.exports = {
  startFakeFlareSolverr,
  MESSAGES,
  pageHtml,
  BLANK_HTML,
  USER_AGENT,
};
