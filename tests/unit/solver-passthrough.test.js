'use strict';

// server/modules/network/solver/passthrough.js: the pool switched off is the code that
// existed before it. The raw post is the test's; nothing here queues, spaces or locks.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { NO_PROXY } = require('../../server/modules/network/solver/proxy-info');
const { createJobs } = require('../../server/modules/network/solver/jobs');
const { createPassThrough } = require('../../server/modules/network/solver/passthrough');

const SOLVER = 'http://127.0.0.1:8191/v1';

// A promise the code under test must settle. When a rule is broken it never does, and a test that
// waits for ever is worse than one that fails, so the wait is bounded.
function soon(promise, what, ms = 1000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what} was never answered` })), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function makeEnv({ answer = { httpStatus: 200, body: { status: 'ok', solution: { response: '<html>' } } }, proxyInfo = NO_PROXY, resolveProxy, config = {} } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, config);
  const state = createPoolState(cfg);
  const ports = createPorts({ now: () => clock.t }, state);
  const jobs = createJobs({ state, cfg, ports });
  const sent = [];
  const post = async (solverUrl, payload, options) => {
    sent.push({ solverUrl, payload, timeoutMs: options.timeoutMs });
    clock.t += 7;
    if (typeof answer === 'function') return answer();
    return answer;
  };
  const passthrough = createPassThrough({ cfg, ports, post, resolveProxy: resolveProxy || (async () => proxyInfo), jobs });
  return { clock, cfg, state, jobs, sent, passthrough };
}

test('it sends the legacy payload to the solver and answers in the pool\'s shape', async () => {
  const { cfg, sent, passthrough } = makeEnv();
  const result = await passthrough.passThrough({ url: 'https://cf-site.example/a', solverUrl: SOLVER });
  assert.deepEqual(sent, [{
    solverUrl: SOLVER,
    payload: { cmd: 'request.get', url: 'https://cf-site.example/a', maxTimeout: cfg.requestMaxTimeoutMs },
    timeoutMs: cfg.requestMaxTimeoutMs + cfg.requestAbortGraceMs,
  }]);
  assert.deepEqual(result, {
    data: { status: 'ok', solution: { response: '<html>' } }, mode: 'stateless', proxyMode: 'none', fingerprint: 'none', queuedMs: 0, solveMs: 7,
  });
});

test('cookies, the proxy and the caller\'s own time limit go along', async () => {
  const proxyInfo = { proxy: { url: 'http://127.0.0.1:3128', username: 'u', password: 'p' }, mode: 'user-proxy', fingerprint: 'user:1' };
  const { cfg, sent, passthrough } = makeEnv({ proxyInfo });
  const cookies = [{ name: 'a', value: 'b' }];
  const result = await passthrough.passThrough({ url: 'https://cf-site.example/', solverUrl: SOLVER, cookies, maxTimeoutMs: 12_000 });
  assert.deepEqual(sent[0].payload, { cmd: 'request.get', url: 'https://cf-site.example/', maxTimeout: 12_000, cookies, proxy: proxyInfo.proxy });
  assert.equal(sent[0].timeoutMs, 12_000 + cfg.requestAbortGraceMs);
  assert.deepEqual([result.proxyMode, result.fingerprint], ['user-proxy', 'user:1']);
});

test('anything but a 2xx answer with a JSON body is the old error, with no code', async () => {
  for (const [answer, text] of [
    [{ httpStatus: 500, body: { status: 'error', message: 'Cloudflare has blocked this request' } }, 'FlareSolverr HTTP 500'],
    [{ httpStatus: 502, body: null }, 'FlareSolverr HTTP 502'],
    [{ httpStatus: 200, body: null }, 'FlareSolverr HTTP 200'],
    [{ httpStatus: 199, body: { status: 'ok' } }, 'FlareSolverr HTTP 199'],
    [{ httpStatus: 300, body: { status: 'ok' } }, 'FlareSolverr HTTP 300'],
    [null, 'FlareSolverr HTTP 0'],
  ]) {
    const { passthrough } = makeEnv({ answer });
    await assert.rejects(passthrough.passThrough({ url: 'https://cf-site.example/', solverUrl: SOLVER }), (err) => err.message === text && err.code === undefined && err.noRetry === undefined, text);
  }
});

test('a request that got no answer is the very same error', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const { passthrough } = makeEnv({ answer: () => { throw refused; } });
  await assert.rejects(passthrough.passThrough({ url: 'https://cf-site.example/', solverUrl: SOLVER }), (err) => err === refused);
});

test('a waiting job released to this path leaves the queue and is answered by it', async () => {
  const { state, sent, passthrough } = makeEnv();
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  const job = {
    state: 'queued', counted: true, settled: false, request: { url: 'https://cf-site.example/a', solverUrl: SOLVER }, resolve, reject: () => {},
  };
  state.queue.push(job);
  state.inFlight = 1;

  passthrough.release(job);
  assert.equal(job.state, 'passthrough', 'out of the queue and no longer the pool\'s');
  assert.deepEqual(state.queue, []);
  assert.equal(state.inFlight, 0);
  const result = await soon(promise, 'the released job');
  assert.equal(result.mode, 'stateless');
  assert.equal(job.settled, true);
  assert.equal(sent.length, 1);
});

test('a released job whose request fails is rejected with that failure', async () => {
  const { passthrough } = makeEnv({ answer: { httpStatus: 503, body: null } });
  let reject;
  const promise = new Promise((_, rej) => { reject = rej; });
  const job = { state: 'queued', counted: false, settled: false, request: { url: 'https://cf-site.example/a', solverUrl: SOLVER }, resolve: () => {}, reject };
  passthrough.release(job);
  await assert.rejects(soon(promise, 'the released job'), /FlareSolverr HTTP 503/);
});

// ── Per-site concurrency ─────────────────────────────────────────────────────
// With the pool off every call used to be one stateless Chrome. Calls for the SAME page are one call (single-flight),
// but twenty different pages of one site were twenty Chromes at once: a few at a time is what a site and a computer
// can take, and it keeps switching the pool off a safe thing to do.

const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

// A post the test answers one call at a time; it counts how many are in flight and the most there ever were.
function gatedPost() {
  const gate = { inFlight: 0, peak: 0, started: [], waiting: [] };
  gate.post = (solverUrl, payload) => {
    gate.inFlight += 1;
    gate.peak = Math.max(gate.peak, gate.inFlight);
    gate.started.push(payload.url);
    return new Promise((resolve, reject) => {
      gate.waiting.push({
        ok: () => { gate.inFlight -= 1; resolve({ httpStatus: 200, body: { status: 'ok', solution: { response: payload.url } } }); },
        fail: (err) => { gate.inFlight -= 1; reject(err); },
      });
    });
  };
  return gate;
}

function makeGated(config) {
  const gate = gatedPost();
  const cfg = mergeConfig(POOL, config || {});
  const state = createPoolState(cfg);
  const ports = createPorts({ now: () => 1_700_000_000_000 }, state);
  const jobs = createJobs({ state, cfg, ports });
  const passthrough = createPassThrough({ cfg, ports, post: gate.post, resolveProxy: async () => NO_PROXY, jobs });
  const call = (path, host = 'cf-site.example') => passthrough.passThrough({ url: `https://${host}${path}`, solverUrl: SOLVER });
  return { gate, cfg, state, passthrough, call };
}

const pageUrls = (count) => Array.from({ length: count }, (_, n) => `https://cf-site.example/page-${n}`);

test('the cap is a named constant of the pool, two by default', () => {
  assert.equal(POOL.passThroughSiteLimit, 2);
});

test('twenty different pages of one site never have more than the cap in flight, and each is answered with its own page, first come first served', async () => {
  const { gate, cfg, call } = makeGated();
  const calls = Array.from({ length: 20 }, (_, n) => call(`/page-${n}`));
  await flush();
  assert.equal(gate.inFlight, cfg.passThroughSiteLimit);

  while (gate.waiting.length) {
    gate.waiting.shift().ok();
    await flush();
    assert.ok(gate.inFlight <= cfg.passThroughSiteLimit, 'never more than the cap');
  }
  assert.equal(gate.peak, cfg.passThroughSiteLimit);
  const results = await soon(Promise.all(calls), 'the twenty calls');
  assert.deepEqual(results.map((r) => r.data.solution.response), pageUrls(20), 'each got its own page');
  assert.deepEqual(gate.started, pageUrls(20), 'first come, first served');
});

test('a single call is unchanged: no wait, the legacy payload byte for byte, the same time limit', async () => {
  const { gate, call } = makeGated();
  const only = call('/only');
  await flush();
  assert.equal(gate.inFlight, 1);
  gate.waiting.shift().ok();
  const result = await soon(only, 'the call');
  assert.deepEqual([result.mode, result.queuedMs], ['stateless', 0]);

  const { cfg, sent, passthrough } = makeEnv();
  await passthrough.passThrough({ url: 'https://cf-site.example/only', solverUrl: SOLVER });
  assert.equal(JSON.stringify(sent[0].payload), JSON.stringify({ cmd: 'request.get', url: 'https://cf-site.example/only', maxTimeout: cfg.requestMaxTimeoutMs }));
  assert.equal(sent[0].timeoutMs, cfg.requestMaxTimeoutMs + cfg.requestAbortGraceMs, 'the time a call may take is not shortened by the line it stood in');
});

test('two sites are independent: a site with all its places taken does not hold up another', async () => {
  const { gate, cfg, call } = makeGated({ passThroughSiteLimit: 1 });
  call('/a1');
  const waitingA = call('/a2');
  await flush();
  assert.equal(cfg.passThroughSiteLimit, 1);
  assert.deepEqual(gate.started, ['https://cf-site.example/a1']);

  const otherSite = call('/b1', 'other-site.example');
  await flush();
  assert.deepEqual(gate.started, ['https://cf-site.example/a1', 'https://other-site.example/b1'], 'the other site went straight in');
  assert.equal(gate.peak, 2);

  while (gate.waiting.length) { gate.waiting.shift().ok(); await flush(); }
  await soon(Promise.all([waitingA, otherSite]), 'both');
});

test('the cap is per site as the pool knows sites: www and a subdomain share it, two names under a country suffix do not', async () => {
  const { gate, call } = makeGated({ passThroughSiteLimit: 1 });
  call('/x', 'www.cf-site.example');
  call('/y', 'cdn.cf-site.example');
  call('/z', 'one.co.th');
  call('/z', 'two.co.th');
  await flush();
  assert.deepEqual(gate.started, ['https://www.cf-site.example/x', 'https://one.co.th/z', 'https://two.co.th/z']);
  while (gate.waiting.length) { gate.waiting.shift().ok(); await flush(); }
});

test('every waiter is released when a call fails, and none is left behind', async () => {
  const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const { gate, call } = makeGated({ passThroughSiteLimit: 1 });
  const settled = ['/f1', '/f2', '/f3', '/f4'].map((path) => call(path).then((value) => value, (err) => err));
  await flush();

  gate.waiting.shift().fail(boom); // no answer at all
  await flush();
  assert.deepEqual(gate.started.slice(-1), ['https://cf-site.example/f2'], 'the next in line went at once');
  gate.waiting.shift().ok();
  await flush();
  gate.waiting.shift().fail(boom);
  await flush();
  gate.waiting.shift().ok();
  const outcomes = await soon(Promise.all(settled), 'all four');
  assert.equal(outcomes[0], boom, 'the very same error');
  assert.equal(outcomes[1].mode, 'stateless');
  assert.equal(outcomes[2], boom);
  assert.equal(outcomes[3].mode, 'stateless');
  assert.equal(gate.inFlight, 0);
});

test('an answer that is an error, and a proxy lookup that fails, give their place back too', async () => {
  const bad = makeEnv({ config: { passThroughSiteLimit: 1 }, answer: { httpStatus: 500, body: { status: 'error' } } });
  const failing = ['/e1', '/e2', '/e3'].map((path) => bad.passthrough.passThrough({ url: `https://cf-site.example${path}`, solverUrl: SOLVER }));
  const results = await soon(Promise.allSettled(failing), 'three failing calls');
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected', 'rejected']);
  assert.equal(bad.sent.length, 3, 'each one still got its turn');

  let lookups = 0;
  const unreadable = makeEnv({
    config: { passThroughSiteLimit: 1 },
    resolveProxy: async () => {
      lookups += 1;
      if (lookups === 1) throw new Error('settings cannot be read');
      return NO_PROXY;
    },
  });
  const two = ['/p1', '/p2'].map((path) => unreadable.passthrough.passThrough({ url: `https://cf-site.example${path}`, solverUrl: SOLVER }));
  const outcomes = await soon(Promise.allSettled(two), 'two calls');
  assert.equal(outcomes[0].status, 'rejected');
  assert.match(outcomes[0].reason.message, /settings cannot be read/);
  assert.equal(outcomes[1].status, 'fulfilled', 'the second was not stuck behind the first');
  assert.equal(unreadable.sent.length, 1, 'and nothing was sent without the proxy for the first');
});

test('a waiting job released to this path takes its turn like any other call', async () => {
  const { gate, state, passthrough, call } = makeGated({ passThroughSiteLimit: 1 });
  const holder = call('/holder');
  let resolve;
  const answered = new Promise((res) => { resolve = res; });
  const job = { state: 'queued', counted: false, settled: false, request: { url: 'https://cf-site.example/released', solverUrl: SOLVER }, resolve, reject: () => {} };
  state.queue.push(job);
  passthrough.release(job);
  await flush();
  assert.deepEqual(gate.started, ['https://cf-site.example/holder'], 'the released job waits for the holder');
  gate.waiting.shift().ok();
  await flush();
  gate.waiting.shift().ok();
  await soon(holder, 'the holder');
  assert.equal((await soon(answered, 'the released job')).data.solution.response, 'https://cf-site.example/released');
});
