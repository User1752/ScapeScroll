'use strict';

const { Failure } = require('./signals');
const { MESSAGES } = require('./texts');
const { hostOf, cookieMatchesHost, clone, setCookie, siteCookies, pageFor } = require('./site-data');
const { pause } = require('./waits');
const { makeBrowser, launchBrowser } = require('./browsers');

// request.get: which browser answers, how long the navigation takes, what goes
// wrong with it, and the page, cookies and user agent it answers with. The traps
// of FlareSolverr 3.5.2 this models are numbered 1, 2, 3, 5, 6 and 8 in the header
// of fake-flaresolverr.js.

const DEFAULT_MAX_TIMEOUT_MS = 60_000;

// Errors raised while solving are prefixed and have newlines escaped, as FlareSolverr does.
const solving = (inner) => new Failure(`Error solving the challenge. ${String(inner).replace(/\n/g, '\\n')}`);

// A browser for an id FlareSolverr did not have (or no longer has): started on the spot, with no
// proxy, and nothing in the answer says so.
async function launchUnproxied(state, entry, callEpoch) {
  await launchBrowser(state, entry, callEpoch);
  const browser = makeBrowser(entry.session, null, true);
  state.sessions.set(entry.session, browser);
  return browser;
}

// Which browser answers: the session's, or a throwaway one launched for this call alone.
async function browserFor(state, body, entry, callEpoch) {
  const { fake, sessions } = state;
  if (!entry.session) {
    entry.stateless = true;
    await launchBrowser(state, entry, callEpoch);
    const throwaway = makeBrowser(null, clone(entry.proxy), false);
    entry.usedProxy = throwaway.proxy;
    return throwaway;
  }
  const ttlMs = Number(body.session_ttl_minutes) > 0 ? Number(body.session_ttl_minutes) * 60_000 : 0;
  let browser = sessions.get(entry.session);
  if (!browser) {
    // Unknown id: a browser is created for it, with no proxy.
    entry.lazy = true;
    fake.lazyCreated.push(entry.session);
    browser = await launchUnproxied(state, entry, callEpoch);
  } else if (ttlMs && Date.now() - browser.createdAt > ttlMs) {
    // Too old for the ttl the caller sent: destroyed and recreated, again with no proxy.
    entry.ttlRecreated = true;
    fake.ttlDropped.push(entry.session);
    sessions.delete(entry.session);
    browser.removed = true;
    browser = await launchUnproxied(state, entry, callEpoch);
  }
  entry.usedProxy = browser.proxy;
  return browser;
}

// The navigation itself. Only it counts against maxTimeout: the browser was started before that clock began.
async function load(state, { body, entry, outcome, callEpoch, browser, maxTimeout }) {
  if (entry.hadCookies) {
    for (const cookie of body.cookies) setCookie(browser.jar, cookie, hostOf(entry.url));
  }
  const takes = state.fake.latencyMs + (outcome.delayMs || 0);
  await pause(state, Math.min(takes, maxTimeout), callEpoch);
  if (takes > maxTimeout) throw solving(MESSAGES.timeout(maxTimeout));
  if (browser.removed) throw solving(MESSAGES.driverDead);
  if (browser.dead) throw solving(browser.deadMessage);
  if (outcome.errorMessage !== undefined) {
    if (outcome.kill) {
      browser.dead = true;
      browser.deadMessage = outcome.errorMessage;
    }
    throw solving(outcome.errorMessage);
  }
}

// The answer: the page the browser shows NOW (not necessarily this call's, when calls overlap), and the
// cookies of that page's site.
function solutionOf(state, { browser, own, entry, outcome }) {
  const host = hostOf(entry.url);
  for (const cookie of siteCookies(outcome, entry.url)) setCookie(browser.jar, cookie, host);
  const shown = browser.page;
  if (shown !== own) entry.collided = true;
  const shownHost = hostOf(shown.url);
  return {
    message: 'Challenge not detected!',
    solution: {
      url: shown.url,
      status: 200,
      headers: {},
      response: shown.html,
      cookies: [...browser.jar.values()].filter((cookie) => cookieMatchesHost(cookie, shownHost)),
      userAgent: state.fake.userAgent,
    },
  };
}

async function requestGet(state, body, entry, outcome, callEpoch) {
  if (!entry.url) throw new Failure("Request parameter 'url' is mandatory in 'request.get' command.");
  const maxTimeout = Number(body.maxTimeout) >= 1 ? Math.trunc(Number(body.maxTimeout)) : DEFAULT_MAX_TIMEOUT_MS;
  const browser = await browserFor(state, body, entry, callEpoch);

  // No lock per session: a call that arrives while another is running on the browser collides with it.
  if (browser.inflight > 0) {
    state.fake.collisions += 1;
    entry.collided = true;
  }
  browser.inflight += 1;
  browser.requests += 1;
  const own = pageFor(entry.url, outcome);
  browser.page = own; // the last navigation to arrive is the page every reader after it sees
  try {
    await load(state, { body, entry, outcome, callEpoch, browser, maxTimeout });
    return solutionOf(state, { browser, own, entry, outcome });
  } finally {
    browser.inflight -= 1;
  }
}

module.exports = { requestGet };
