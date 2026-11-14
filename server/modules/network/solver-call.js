'use strict';

const { createHash } = require('crypto');
const { POOL, MESSAGES } = require('../../config/solver');
const { hostKeyOf } = require('../common/host-utils');
const { isSolverDown, describeSolverMessage } = require('./solver/classify');
const { CALLER_ERROR_CODES } = require('./solver/errors');

// Everything the app does around ONE call to the FlareSolverr session pool, in the
// order it happens (fetch-utils.js builds the instance and exports it as
// executeFlareSolverr; the pool itself knows nothing of pages, cookies saved for a
// site or the wording callers see):
//   1. a target Chrome must not be sent to (loopback, a private address) is refused
//      before the solver is asked, and an identical call already running is joined
//      instead of repeated (single-flight.js, keyed by flightKey below);
//   2. the call is queued; a queued call can be answered without a browser when a cookie
//      saved meanwhile lets a plain request through (the preflight);
//   3. a request that got no answer from FlareSolverr becomes the error callers have
//      always seen (explainFailure), the self-healing restart included;
//   4. the page is taken in: its cookies are saved for the site, a Chrome error page is
//      refused, a bot-check shell is asked for once more inside the same session, and a
//      proof-of-work page is retried with the cookies just saved.
//
// This factory is stateless: the pool, the registry of running calls and every other
// collaborator are injected, so a test (or a fresh copy of fetch-utils) gets fresh state.
// Interface: createSolverCaller(deps) -> executeFlareSolverr(targetUrl, solverUrl, cookies)
// resolving the page's HTML; flightKey(url, cookies) is exported because it is pure and tested alone.

const REQUIRED_DEPS = [
  'pool', 'flights', 'assertPublicUrl', 'getSolverContext', 'noteUsed', 'recoverFromHang',
  'saveDomainSession', 'getDomainSession', 'safeFetch',
  'isChromeErrorPage', 'isBotChallengePage', 'needsChallengeSolve', 'siteLabel', 'userAgent',
];

// What a source's user sees when a Cloudflare-protected site has to be solved but FlareSolverr
// cannot be reached (MESSAGES.unreachable says why its wording is what it is). Only a connection
// that was REFUSED or unreachable counts (isSolverDown): a reset socket, a TLS mismatch, a DNS
// failure or a mistyped solver URL are different problems and keep Node's original error instead
// of being called "switched off".
function solverUnreachableError(cause) {
  const err = new Error(MESSAGES.unreachable, { cause });
  err.code = CALLER_ERROR_CODES.UNAVAILABLE;
  return err;
}

// sha1 of the sorted name/value pairs; '' for no cookies. Two calls with different cookies
// (two accounts) are different pages even for the same URL. Each pair is written as JSON,
// so no character in a name or a value can be taken for the separator between two cookies.
function cookieHash(cookies) {
  if (!Array.isArray(cookies) || !cookies.length) return '';
  const pairs = cookies.map((cookie) => JSON.stringify([cookie && cookie.name, cookie && cookie.value])).sort();
  return createHash('sha1').update(JSON.stringify(pairs)).digest('hex');
}

/**
 * What "the same request" means for single-flight: this site, this exact URL (the
 * fragment is never sent to the site), these exact cookies. Never the site alone: two
 * different pages of one site must not share an answer. A call that needs a browser of its own
 * (oneOff, solver-context.js) is never the same as one that does not: it must not be handed a
 * page that came out of a shared browser, nor hand its page to a caller that asked for none.
 */
function flightKey(targetUrl, cookies, oneOff = false) {
  let url = String(targetUrl);
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    url = parsed.href;
  } catch (_) {
    // not a URL: the text itself is the best key there is
  }
  return `${hostKeyOf(url)}\n${url}\n${cookieHash(cookies)}${oneOff === true ? '\none-off' : ''}`;
}

// A plain GET of the page with the cookie a solve saved for the site, or null when that
// does not give the page. Never throws. The proof-of-work retry and the preflight both
// use it.
async function fetchDirect(deps, targetUrl, session) {
  const headers = {
    'User-Agent': session?.userAgent || deps.userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (session?.cookieHeader) headers['Cookie'] = session.cookieHeader;
  try {
    const res = await deps.safeFetch(targetUrl, { headers, signal: AbortSignal.timeout(POOL.directFetchTimeoutMs) });
    return res.ok ? await res.text() : null;
  } catch (_) {
    return null;
  }
}

// The pool tries this for a call that had to wait in the queue, before it takes a browser:
// if another call solved this site while it waited, the cookie it saved may let a plain
// request through, and then no browser (and no spacing) is spent. Only a cookie saved AFTER
// this call was queued says anything new, and each cookie is tried once (the pool asks again
// for every change of the site's cookie, never more often than that for one call). Answers:
//   { data }    the page
//   undefined   nothing to try: no cookie newer than the call, or this one was tried already
//   null        tried, and the site did not give the page
// Not used for a call that carries cookies of its own (a logged-in page): an anonymous request
// would return the wrong page. How often it can answer a queued call is unverified until a
// real FlareSolverr shows how a startup burst of protected-site probes and lookups fares with
// the pool on against the pool off.
function buildPreflight(deps, targetUrl, enqueuedAt) {
  let triedStamp = 0;
  return async () => {
    const session = deps.getDomainSession(targetUrl);
    if (!session || session.timestamp <= enqueuedAt || session.timestamp === triedStamp) return undefined;
    triedStamp = session.timestamp;
    const text = await fetchDirect(deps, targetUrl, session);
    if (text === null || deps.needsChallengeSolve(text)) return null;
    return { data: { status: 'ok', solution: { response: text, cookies: [], userAgent: session.userAgent } } };
  };
}

// The error the caller gets for a request that never got an answer from FlareSolverr (the
// pool rethrows the raw transport error, or refuses with its own code). The objects are the
// ones callers have always seen.
function explainFailure(deps, err, targetUrl) {
  // Our own 40s wait firing (not FlareSolverr answering with a clean
  // error) means it never responded at all - confirmed live this can
  // mean FlareSolverr's whole process is wedged (some Cloudflare Turnstile
  // challenges get stuck mid-solve in a way its own maxTimeout can't
  // interrupt), which would silently break every other source's use of
  // it too until someone notices and restarts it by hand.
  //
  // A connection-refused/DNS-style failure (Node's fetch() throws a plain
  // TypeError "fetch failed" for these, with the real reason on
  // err.cause.code) is a DIFFERENT failure mode from a hang - it means the
  // process isn't there to even accept the connection (crashed, killed, or
  // never came up - confirmed live: a stale-driver-lock startup crash
  // looks exactly like this, immediately, not after any timeout at all).
  // recoverFromHang() covers both: it already no-ops safely when nothing
  // is resolvable, and now bootstraps a cold "never started" instance too.
  const isFetchFailed = err instanceof TypeError && /fetch failed/i.test(err.message || '');
  const isConnFailure = err?.name === 'TimeoutError' || err?.name === 'AbortError' || isFetchFailed;
  if (isConnFailure) {
    deps.recoverFromHang();
  }
  // Our own abort (not a refused connection) is the sign that THIS page left FlareSolverr hanging: the site remembers it.
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') deps.wedges?.noteStall(hostKeyOf(targetUrl));
  // Only a refused/unreachable connection gets the clearer wording; our own timeout keeps its
  // original error (the solver was there, it just never answered), and so does any other
  // network failure (see isSolverDown).
  //
  // The pool's own refusals (restarting, known to be down, queue full, ...) are returned as they
  // are: FlareSolverr is switched ON in those cases, so "switched off or not installed" would be
  // false, and their texts and noRetry flag say what is going on. No restart is asked for over
  // them either (FlareSolverr is already being restarted, or just failed to answer); only the raw
  // transport errors above do.
  if (isFetchFailed && isSolverDown(err)) return solverUnreachableError(err);
  return err;
}

// One trip through the pool; the answer is { data, mode, ... } or this module's explanation of the failure.
async function submit(deps, job, flight) {
  const enqueuedAt = Date.now();
  const hasCookies = Array.isArray(job.cookies) && job.cookies.length > 0;
  const request = { url: job.targetUrl, solverUrl: job.solverUrl, cookies: job.cookies };
  if (!hasCookies) request.preflight = buildPreflight(deps, job.targetUrl, enqueuedAt);
  try {
    const handle = deps.pool.run(request, flight.patience());
    flight.attach(handle);
    return await handle.promise;
  } catch (err) {
    throw explainFailure(deps, err, job.targetUrl);
  }
}

// The page of an answer, after what is done with every page: the cookies of the solve are kept
// for the site, and a Chrome error page is an error, not content. Throws for an answer that is not a page.
function takeInPage(deps, targetUrl, outcome) {
  const data = outcome.data;
  if (!(data.status === 'ok' && data.solution && data.solution.response)) {
    throw new Error(MESSAGES.other(describeSolverMessage(data.message)));
  }
  // A page the preflight fetched carries no cookies of its own: nothing new to save.
  if (outcome.mode !== 'direct') {
    deps.saveDomainSession(targetUrl, data.solution.cookies || [], data.solution.userAgent || '');
  }
  const html = data.solution.response;
  if (deps.isChromeErrorPage(html)) {
    throw new Error(MESSAGES.navigation(deps.siteLabel(targetUrl)));
  }
  return html;
}

// If initial load returned JS PoW challenge page before redirecting, retry via direct fetch using saved cookies.
// Runs after the call has been answered, so it holds no browser.
async function retryProofOfWork(deps, targetUrl, html) {
  if (!(html.includes('/_v') && (html.includes('powNonce') || html.includes('pow_hash')))) return html;
  await new Promise((resolve) => setTimeout(resolve, POOL.powRetryDelayMs));
  const directHtml = await fetchDirect(deps, targetUrl, deps.getDomainSession(targetUrl));
  return directHtml !== null && !directHtml.includes('/_v') ? directHtml : html;
}

// Runs inside the flight: asks the pool, takes the page in, and asks once more when a site's own
// bot check (a 200 OK "verifying your browser" shell that no cookie from another page gets past)
// is served inside a session. Chrome in the session keeps what the first attempt earned, which is
// why the second attempt can pass where a one-off browser never does; the host's spacing applies to
// it like to any navigation. A one-off browser keeps its old behaviour: the shell is returned and
// the caller (resolveViaSolver) reports it, fetchText retries. That the second attempt passes the
// shell is unverified until a real FlareSolverr shows a site whose bot-check shell is passed on a
// second page inside one session.
async function solveOnce(deps, job, flight) {
  let outcome = await submit(deps, job, flight);
  let html = takeInPage(deps, job.targetUrl, outcome);
  deps.wedges?.noteAnswered(hostKeyOf(job.targetUrl)); // a page came back: the site does not wedge the solver
  for (let retry = 0; retry < POOL.shellResolveRetries && outcome.mode === 'session' && deps.isBotChallengePage(html); retry += 1) {
    outcome = await submit(deps, job, flight);
    html = takeInPage(deps, job.targetUrl, outcome);
  }
  return retryProofOfWork(deps, job.targetUrl, html);
}

// Only a verdict that the target is not safe stops the call: a resolver that is down or slow says
// nothing about the target, and Chrome would meet the same problem and report it better.
function refuseUnsafeTarget(err) {
  if (err && err.code === CALLER_ERROR_CODES.UNSAFE_URL) throw err;
}

/**
 * deps: { pool, flights, assertPublicUrl, getSolverContext, noteUsed, recoverFromHang, saveDomainSession,
 * getDomainSession, safeFetch, isChromeErrorPage, isBotChallengePage, needsChallengeSolve, siteLabel, userAgent }.
 * Throws at once when one is missing. `wedges` (solver/wedge-memory.js) is optional: without it no site is ever paused.
 */
function createSolverCaller(deps) {
  const missing = REQUIRED_DEPS.filter((name) => deps?.[name] === undefined || deps[name] === null);
  if (missing.length) throw new TypeError(`createSolverCaller is missing: ${missing.join(', ')}`);

  // Three declared parameters on purpose: callers (and the tests that pass cookies) tell the
  // editions apart by executeFlareSolverr.length.
  return async function executeFlareSolverr(targetUrl, solverUrl, cookies) {
    // A site that keeps leaving the solver without an answer is refused here, before FlareSolverr is touched or counted as used.
    if (deps.wedges?.pausedFor(hostKeyOf(targetUrl)) > 0) throw deps.wedges.error();
    deps.noteUsed();
    // Chrome follows redirects by itself, so the first hop and its DNS answer are checked here.
    await deps.assertPublicUrl(targetUrl).catch(refuseUnsafeTarget);
    const job = { targetUrl, solverUrl, cookies };
    const declared = deps.getSolverContext();
    return deps.flights.run(flightKey(targetUrl, cookies, declared.oneOff === true), declared, (flight) => solveOnce(deps, job, flight));
  };
}

module.exports = { createSolverCaller, flightKey };
