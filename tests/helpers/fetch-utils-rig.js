'use strict';

// The rig the tests of fetch-utils and the solver pool behind it share (fetch-utils-solver,
// solver-callers, solver-burst): the real fetch-utils with its real pool, a fake FlareSolverr on
// loopback, a lifecycle stand-in that only counts (so nothing starts or restarts a real
// FlareSolverr, opens a browser or reaches the network), and one guard over everything that could
// leave the process.
//
// The guard is installed when this file is required, so it covers the whole test file and cannot
// be forgotten by a test that adds a plain request later:
//   - a request to the fake FlareSolverr goes through;
//   - a request to a made-up site (the reserved .example names the tests use) is answered by the
//     test (stubSite), or by default as the protected site it stands for: a challenge;
//   - anything else - a real host, a loopback port that is not the fake - is refused with an
//     error and recorded, and the rig fails the test when it ends. A caller that swallows the
//     error (the preflight does) cannot hide it.

const assert = require('node:assert/strict');
const dnsPromises = require('node:dns').promises;

const { startFakeFlareSolverr } = require('./fake-flaresolverr');
const { sleep, assertSessionDiscipline } = require('./solver-pool-rig');

const LIFECYCLE_PATH = require.resolve('../../server/modules/network/flaresolverr-lifecycle');
const FETCH_UTILS_PATH = require.resolve('../../server/modules/network/fetch-utils');

const SITE = 'https://cf-site.example';
const CHALLENGE = '<html><title>Just a moment...</title></html>';

const realFetch = globalThis.fetch;
const guard = {
  bases: new Set(), // the fake FlareSolverrs that are up
  handler: null, // how the made-up sites answer; null = the default challenge
  seen: [], // the plain requests to made-up sites since the last stubSite
  strays: [], // what the guard refused
};

const isMadeUpSite = (url) => {
  try {
    return new URL(url).hostname.endsWith('.example');
  } catch {
    return false;
  }
};

globalThis.fetch = async function guardedFetch(url, init) {
  const text = String(url);
  if ([...guard.bases].some((base) => text.startsWith(base))) return realFetch(url, init);
  if (!isMadeUpSite(text)) {
    guard.strays.push(text);
    throw new Error(`test guard: a real network call to ${text} was refused`);
  }
  guard.seen.push({ url: text, headers: init && init.headers });
  return guard.handler ? guard.handler(text, init) : new Response(CHALLENGE, { status: 403 });
};

// A private copy of fetch-utils, built against a lifecycle stand-in. `lifecycle` adds exports to it.
function loadFetchUtils(calls = { used: 0, recovered: 0 }, lifecycle = {}) {
  const original = require.cache[LIFECYCLE_PATH];
  delete require.cache[FETCH_UTILS_PATH];
  require.cache[LIFECYCLE_PATH] = {
    id: LIFECYCLE_PATH,
    filename: LIFECYCLE_PATH,
    loaded: true,
    exports: {
      noteFlaresolverrUsed() { calls.used += 1; },
      recoverFromHang() { calls.recovered += 1; },
      ...lifecycle,
    },
  };
  try {
    return require(FETCH_UTILS_PATH);
  } finally {
    if (original) require.cache[LIFECYCLE_PATH] = original; else delete require.cache[LIFECYCLE_PATH];
    delete require.cache[FETCH_UTILS_PATH];
  }
}

// Every site name resolves to a public address, except the ones `answers` maps (to an address, or to an error).
// The real resolver is kept in one slot while any stub is up, and the hooks only take their own stub off the
// list: a test that stubs twice (rig() does it once, the test may do it again with answers of its own) ends with
// the real one back whatever order its t.after hooks run in. Restoring "what was there when I stubbed" would put
// the first stub back, and it would stay installed for the rest of the process.
const dnsStubs = []; // the stubs that are up, oldest first
let realLookup = null;

function stubDns(t, answers = {}) {
  if (dnsStubs.length === 0) realLookup = dnsPromises.lookup;
  const stub = async (host) => {
    const answer = answers[host];
    if (answer instanceof Error) throw answer;
    return [{ address: answer || '93.184.216.34', family: 4 }];
  };
  dnsStubs.push(stub);
  dnsPromises.lookup = stub;
  t.after(() => {
    const at = dnsStubs.indexOf(stub);
    if (at >= 0) dnsStubs.splice(at, 1);
    dnsPromises.lookup = dnsStubs.length ? dnsStubs[dnsStubs.length - 1] : realLookup;
  });
}

// Plain requests to a site (the fetchText attempt, the preflight, the proof-of-work retry) are answered
// by `handler` from here on; whatever goes to the fake FlareSolverr is left alone. Returns the list of
// site requests made from now on.
function stubSite(t, handler) {
  guard.handler = handler;
  guard.seen = [];
  t.after(() => { guard.handler = null; });
  return guard.seen;
}

// A fake FlareSolverr, a fresh fetch-utils pointed at it and (unless `pool` is false) the pool switched on,
// everything closed in the right order when the test ends.
async function rig(t, { pool = true, fakeOptions = {}, settings = {}, lifecycle = {}, readStore } = {}) {
  stubDns(t);
  guard.handler = null;
  guard.seen = [];
  const fake = await startFakeFlareSolverr(fakeOptions);
  guard.bases.add(fake.baseUrl);
  const calls = { used: 0, recovered: 0 };
  const fu = loadFetchUtils(calls, lifecycle);
  fu.configure({ readStore: readStore || (async () => ({ settings: { flaresolverrUrl: fake.url } })) });
  if (pool) fu.getSolverPool().applySettings({ enabled: true, disabledBy: null, maxSessions: 1, idleMinutes: 10, ...settings });
  t.after(async () => {
    await Promise.race([fu.getSolverPool().shutdown({ timeoutMs: 1000 }), sleep(2500)]);
    await fake.stop();
    guard.bases.delete(fake.baseUrl);
    const strays = guard.strays.splice(0);
    if (pool) assertSessionDiscipline(fake);
    assert.deepEqual(strays, [], 'the test reached for the real network');
  });
  return { fake, fu, calls, executeFlareSolverr: fu.executeFlareSolverr, pool: fu.getSolverPool() };
}

module.exports = {
  SITE,
  CHALLENGE,
  LIFECYCLE_PATH,
  FETCH_UTILS_PATH,
  loadFetchUtils,
  stubDns,
  stubSite,
  rig,
  guard,
};
