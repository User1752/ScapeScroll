'use strict';

// With FlareSolverr off (or not up yet) a Cloudflare-protected source used to fail with Node's bare
// "fetch failed": nothing about the site, Cloudflare or FlareSolverr, and System Health filed it
// under "Unknown error". A REFUSED connection now says what is going on, in words the real error
// classifier files under Cloudflare, and a genuine challenge is not retried (the second attempt
// meets the same closed port). Everything else keeps its original behaviour: other network
// failures keep Node's error, and a transient 503 / 429 / empty page still gets fetchText's retry.

const test = require('node:test');
const assert = require('node:assert/strict');
const dnsPromises = require('node:dns').promises;

const LIFECYCLE_PATH = require.resolve('../../server/modules/network/flaresolverr-lifecycle');
const FETCH_UTILS_PATH = require.resolve('../../server/modules/network/fetch-utils');
const { classifySourceError, isTransientSourceErrorKey } = require('../../server/modules/system-health/service');

const SOLVER = 'http://127.0.0.1:8191/v1';

// fetch-utils takes recoverFromHang from the lifecycle module when it loads. The real one would
// try to bring a FlareSolverr up on a developer machine that has one installed, so load a private
// copy of fetch-utils against a stand-in that only counts the calls.
function loadFetchUtils(recoverCalls) {
  const original = require.cache[LIFECYCLE_PATH];
  delete require.cache[FETCH_UTILS_PATH];
  require.cache[LIFECYCLE_PATH] = {
    id: LIFECYCLE_PATH, filename: LIFECYCLE_PATH, loaded: true,
    exports: { noteFlaresolverrUsed() {}, recoverFromHang() { recoverCalls.push('recover'); } },
  };
  try {
    return require(FETCH_UTILS_PATH);
  } finally {
    if (original) require.cache[LIFECYCLE_PATH] = original; else delete require.cache[LIFECYCLE_PATH];
    delete require.cache[FETCH_UTILS_PATH];
  }
}

const refused = (code = 'ECONNREFUSED') => Object.assign(
  new TypeError('fetch failed'),
  { cause: Object.assign(new Error(`connect ${code} 127.0.0.1:8191`), { code }) },
);

// siteResponses: what the site answers, in order; the last one repeats. solverError: what the
// connection to the solver does (a thrown error), or null when the solver is not expected to be called.
function stubNetwork(t, { siteResponses = [{ status: 403, body: '<html>Just a moment...</html>' }], solverError = refused() } = {}) {
  const realFetch = globalThis.fetch;
  const realLookup = dnsPromises.lookup;
  const calls = { site: 0, solver: 0 };
  dnsPromises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  globalThis.fetch = async (url) => {
    if (String(url) === SOLVER) {
      calls.solver++;
      throw solverError;
    }
    const answer = siteResponses[Math.min(calls.site, siteResponses.length - 1)];
    calls.site++;
    return new Response(answer.body, { status: answer.status });
  };
  t.after(() => { globalThis.fetch = realFetch; dnsPromises.lookup = realLookup; });
  return calls;
}

test('a refused FlareSolverr connection explains itself and keeps the original cause', async (t) => {
  stubNetwork(t);
  const recoverCalls = [];
  const { executeFlareSolverr } = loadFetchUtils(recoverCalls);

  await assert.rejects(
    executeFlareSolverr('https://cf-site.example/page', SOLVER),
    (err) => {
      assert.equal(err.code, 'FLARESOLVERR_UNAVAILABLE');
      assert.match(err.message, /Cloudflare/);
      assert.match(err.message, /FlareSolverr is not reachable/);
      assert.doesNotMatch(err.message, /cf-site\.example/, 'no host name in the text (it would steer the classifier)');
      assert.equal(err.cause.message, 'fetch failed', 'the real error stays reachable');
      assert.equal(err.cause.cause.code, 'ECONNREFUSED');
      assert.equal(Object.keys(err).includes('cause'), false, 'cause is not an enumerable property (logs and JSON stay clean)');
      return true;
    },
  );
  assert.equal(recoverCalls.length, 1, 'the self-healing hook still runs');
});

test('the REAL classifier files the thrown message under Cloudflare, as a transient (degraded) state', async (t) => {
  stubNetwork(t);
  const { executeFlareSolverr } = loadFetchUtils([]);
  const thrown = await executeFlareSolverr('https://api.example.com/x', SOLVER).catch((e) => e);

  const classified = classifySourceError(thrown.message);
  assert.equal(classified.key, 'cloudflare_or_challenge');
  assert.equal(classified.code, 'error-3');
  assert.equal(isTransientSourceErrorKey(classified.key), true, 'shown as a warning, not a failure');
});

test('other network failures keep Node\'s own error: they are not "switched off"', async (t) => {
  for (const solverError of [
    new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }),
    new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND solver.lan'), { code: 'ENOTFOUND' }) }),
    new TypeError('fetch failed', { cause: Object.assign(new Error('wrong version number'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }) }),
  ]) {
    stubNetwork(t, { solverError });
    const { executeFlareSolverr } = loadFetchUtils([]);
    await assert.rejects(executeFlareSolverr('https://cf-site.example/', SOLVER), (err) => err === solverError, solverError.cause.code);
  }
});

test('an unreachable host and a "connection refused" inside an AggregateError (localhost) both count as down', async (t) => {
  for (const cause of [
    Object.assign(new Error('no route'), { code: 'EHOSTUNREACH' }),
    Object.assign(new AggregateError([Object.assign(new Error('v6'), { code: 'ECONNREFUSED' }), Object.assign(new Error('v4'), { code: 'ECONNREFUSED' })]), {}),
  ]) {
    stubNetwork(t, { solverError: new TypeError('fetch failed', { cause }) });
    const { executeFlareSolverr } = loadFetchUtils([]);
    await assert.rejects(executeFlareSolverr('https://cf-site.example/', SOLVER), (err) => err.code === 'FLARESOLVERR_UNAVAILABLE');
  }
});

test('our own timeout is not rewritten: the solver was there, it just never answered', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); };
  t.after(() => { globalThis.fetch = realFetch; });
  const recoverCalls = [];
  const { executeFlareSolverr } = loadFetchUtils(recoverCalls);

  await assert.rejects(executeFlareSolverr('https://cf-site.example/', SOLVER), (err) => err.name === 'TimeoutError' && !err.code);
  assert.equal(recoverCalls.length, 1);
});

test('a genuine challenge (403) with no solver stops at the first attempt instead of backing off', async (t) => {
  const calls = stubNetwork(t);
  const { fetchText, configure } = loadFetchUtils([]);
  configure({ readStore: async () => ({ settings: { flaresolverrUrl: SOLVER } }) });

  const started = Date.now();
  await assert.rejects(fetchText('https://cf-site.example/list'), (err) => err.code === 'FLARESOLVERR_UNAVAILABLE');
  assert.equal(calls.site, 1, 'one request to the site');
  assert.equal(calls.solver, 1, 'one attempt at the solver');
  assert.ok(Date.now() - started < 1000, 'no 1.5 s + 3 s back-off');
});

// The user who switched FlareSolverr off still gets the retry that fetchText has always given a
// blip: the closed solver port must not take it away.
test('a 503 that clears on the next attempt is still retried when FlareSolverr is off', async (t) => {
  const calls = stubNetwork(t, { siteResponses: [{ status: 503, body: 'busy' }, { status: 200, body: '<html>the page</html>' }] });
  const { fetchText, configure } = loadFetchUtils([]);
  configure({ readStore: async () => ({ settings: { flaresolverrUrl: SOLVER } }) });

  assert.equal(await fetchText('https://plain-site.example/list'), '<html>the page</html>');
  assert.equal(calls.site, 2, 'the second attempt happened');
});

test('an empty 200 that clears on the next attempt is still retried when FlareSolverr is off', async (t) => {
  const calls = stubNetwork(t, { siteResponses: [{ status: 200, body: '' }, { status: 200, body: '<html>the page</html>' }] });
  const { fetchText, configure } = loadFetchUtils([]);
  configure({ readStore: async () => ({ settings: { flaresolverrUrl: SOLVER } }) });

  assert.equal(await fetchText('https://plain-site.example/list'), '<html>the page</html>');
  assert.equal(calls.site, 2);
});
