'use strict';

// FlareSolverr off or not installed, with the session pool ON (the default): the real pool and the
// real caller (solver-call.js), a FlareSolverr that refuses every connection (a post that rejects
// like fetch does), and the real classifier. A refused connection fails each call at once with the
// words 3.1.2 gave ("FlareSolverr is not reachable ... Turn FlareSolverr on"), and keeps 3.1.2's
// retry for a blip. Only a wedged solver - one that took the call and never answered - makes the
// next calls fail fast, with their own words ("not answering. Try again in a moment.").
// Nothing here opens a socket, a browser or a file.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSolverPool } = require('../../server/modules/network/solver-pool');
const { createSolverCaller } = require('../../server/modules/network/solver-call');
const { createSingleFlight } = require('../../server/modules/network/single-flight');
const { getSolverContext } = require('../../server/modules/network/solver-context');
const { MESSAGES } = require('../../server/config/solver');
const { POOL_ERROR_CODES, CALLER_ERROR_CODES } = require('../../server/modules/network/solver/errors');
const { classifySourceError, isTransientSourceErrorKey } = require('../../server/modules/system-health/service');
const { makeClock } = require('../helpers/solver-pool-rig');

const SOLVER = 'http://127.0.0.1:8191/v1';
const SITE = 'https://cf-site.example';

const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8191'), { code: 'ECONNREFUSED' }) });
const timedOut = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

// The real pool and the real caller around a post the test scripts; `answer` is called for every post.
// The pool's time is a clock this file never moves: a call that had to wait for anything (the 1.5 s between two
// navigations to one site, a retry, a queue) would hang the test instead of passing slowly.
function setup(t, answer, { offByChoice = false, config = {} } = {}) {
  const spy = { posts: [], recovered: 0, warns: [] }; // recovered: what the CALLER asked for (the pool never does for a refusal)
  const clock = makeClock();
  const pool = createSolverPool({
    config,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    post: async (solverUrl, payload) => {
      spy.posts.push(payload.cmd);
      return answer(payload);
    },
    getSolverProxy: async () => null,
    hooks: { isOffByChoice: () => offByChoice },
    log: () => {},
    warn: (line) => spy.warns.push(line),
    recordError: async () => {},
  });
  pool.applySettings({ enabled: true, disabledBy: null, maxSessions: 2, idleMinutes: 10 });
  t.after(() => pool.shutdown({ timeoutMs: 50 }));
  const call = createSolverCaller({
    pool,
    flights: createSingleFlight(),
    assertPublicUrl: async () => {},
    getSolverContext,
    noteUsed: () => {},
    recoverFromHang: () => { spy.recovered += 1; },
    saveDomainSession: () => {},
    getDomainSession: () => null,
    safeFetch: () => assert.fail('no plain request was expected'),
    isChromeErrorPage: () => false,
    isBotChallengePage: () => false,
    needsChallengeSolve: () => false,
    siteLabel: (url) => new URL(url).hostname,
    userAgent: 'test-agent',
  });
  return { pool, call, spy, clock };
}

const failureOf = (promise) => promise.then(() => assert.fail('the call was expected to fail'), (err) => err);

test('FlareSolverr refusing connections: five concurrent calls and a sixth later all get the "not reachable" words, none of them "not answering"', async (t) => {
  const { pool, call, spy, clock } = setup(t, () => { throw refused(); });

  const failures = await Promise.all([1, 2, 3, 4, 5].map((n) => failureOf(call(`${SITE}/page-${n}`, SOLVER))));
  await clock.advance(20_000); // later, but still inside the 30 s window a wedge would have opened
  failures.push(await failureOf(call(`${SITE}/page-6`, SOLVER)));

  for (const err of failures) {
    assert.equal(err.code, CALLER_ERROR_CODES.UNAVAILABLE, err.message);
    assert.equal(err.message, MESSAGES.unreachable);
    assert.notEqual(err.code, POOL_ERROR_CODES.DOWN);
    assert.equal(err.noRetry, undefined, 'a blip is retried, as in 3.1.2 (fetchText decides by its own challenged flag)');
    assert.equal(err.cause.cause.code, 'ECONNREFUSED', 'the real error stays reachable');
    // The words land in the Cloudflare bucket System Health shows as a warning, with the real classifier.
    const classified = classifySourceError(err.message);
    assert.equal(classified.key, 'cloudflare_or_challenge');
    assert.equal(isTransientSourceErrorKey(classified.key), true);
  }
  assert.deepEqual(spy.posts, Array(6).fill('sessions.create'), 'every call asked FlareSolverr itself: a refused connection costs nothing, and it may be up by now');
  assert.equal(spy.recovered, 6, 'the caller still asks for the self-healing restart, like 3.1.2');
  assert.notEqual(pool.getStatus().state, 'down');
  assert.equal(pool.getStatus().lastError.kind, 'transport');
});

test('with FlareSolverr switched off the words are the same, call after call', async (t) => {
  const { pool, call, spy } = setup(t, () => { throw refused(); }, { offByChoice: true });
  assert.equal((await failureOf(call(`${SITE}/first`, SOLVER))).message, MESSAGES.unreachable);

  // Not the 30 s fail-fast window of a wedged solver: the next call is not refused in advance, whenever it comes.
  const second = await failureOf(call(`${SITE}/second`, SOLVER));
  assert.equal(second.code, CALLER_ERROR_CODES.UNAVAILABLE);
  assert.equal(second.message, MESSAGES.unreachable);
  assert.equal(spy.posts.length, 2);
  assert.equal(pool.getStatus().state, 'idle', 'nothing is open, nothing is failing fast');
});

test('a wedged FlareSolverr (it takes the call and never answers) still opens the fail-fast window', async (t) => {
  const { pool, call, spy } = setup(t, () => { throw timedOut(); });

  const wedged = await failureOf(call(`${SITE}/wedged`, SOLVER));
  assert.equal(wedged.name, 'TimeoutError', 'our own abort, as the original error');
  assert.equal(spy.recovered, 1, 'the caller asks for the restart');
  assert.equal(pool.getStatus().state, 'down');

  const posts = spy.posts.length;
  const fast = await failureOf(call(`${SITE}/next`, SOLVER));
  assert.equal(fast.code, POOL_ERROR_CODES.DOWN);
  assert.equal(fast.message, MESSAGES.down);
  assert.equal(fast.noRetry, true);
  assert.equal(spy.posts.length, posts, 'failing fast: nothing was sent');
  assert.doesNotMatch(fast.message, /switched off|not installed|Turn FlareSolverr on/i);
  assert.equal(classifySourceError(fast.message).key, 'cloudflare_or_challenge');
});

test('a refusal that follows a wedge does not extend the window, and a wedge that follows a refusal opens it', async (t) => {
  let next = refused;
  const { pool, call } = setup(t, () => { throw next(); });

  await failureOf(call(`${SITE}/a`, SOLVER));
  assert.notEqual(pool.getStatus().state, 'down', 'a refusal alone opens nothing');

  next = timedOut;
  await failureOf(call(`${SITE}/b`, SOLVER));
  assert.equal(pool.getStatus().state, 'down');
  assert.equal((await failureOf(call(`${SITE}/c`, SOLVER))).code, POOL_ERROR_CODES.DOWN);
});

test('the console hears of a refused connection once per episode, and not at all when the user turned FlareSolverr off', async (t) => {
  const on = setup(t, () => { throw refused(); });
  for (const n of [1, 2, 3]) await failureOf(on.call(`${SITE}/on-${n}`, SOLVER));
  assert.equal(on.spy.warns.length, 1, 'one line for the whole episode');
  assert.match(on.spy.warns[0], /FlareSolverr is not reachable/);
  assert.doesNotMatch(on.spy.warns[0], /fail fast/, 'nothing fails fast for a refusal');

  const off = setup(t, () => { throw refused(); }, { offByChoice: true });
  for (const n of [1, 2, 3]) await failureOf(off.call(`${SITE}/off-${n}`, SOLVER));
  assert.deepEqual(off.spy.warns, [], 'a refused connection is what they chose');
});

test('FlareSolverr answering again ends the episode: the status stops saying it is refusing, and the next refusal is said again', async (t) => {
  let alive = false;
  const { pool, call, spy } = setup(t, (payload) => {
    if (!alive) throw refused();
    return { httpStatus: 200, body: payload.cmd === 'sessions.create' ? { status: 'ok' } : { status: 'ok', solution: { response: '<html>page</html>', cookies: [], userAgent: 'ua' } } };
  });

  await failureOf(call(`${SITE}/down`, SOLVER));
  assert.equal(pool.getStatus().solver, 'refused');

  alive = true;
  assert.equal(await call('https://up-site.example/up', SOLVER), '<html>page</html>');
  assert.equal(pool.getStatus().solver, null, 'it answered');

  alive = false;
  await pool.closeAll().catch(() => {});
  await failureOf(call('https://third-site.example/down-again', SOLVER));
  assert.equal(spy.warns.filter((line) => /not reachable/.test(line)).length, 2, 'a new episode is a new line');
});
