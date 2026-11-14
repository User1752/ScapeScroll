'use strict';

// A caller that declares `oneOff` (solver-context.js) gets a browser of its own for that call, never a session
// other callers share. Cover search is the one user: Google and Brave keep SafeSearch in COOKIES, so a persistent
// session that served a search with "Hide NSFW" off could serve unfiltered results to the next search with it on.
// Three layers: the call layer (what it hands the pool), the pool (what a one-off job becomes), and a real
// fake FlareSolverr (what is actually sent).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSolverCaller, flightKey } = require('../../server/modules/network/solver-call');
const { createSingleFlight } = require('../../server/modules/network/single-flight');
const { runWithSolverContext, getSolverContext } = require('../../server/modules/network/solver-context');
const { A, B, navigations, commands, creates, destroys, rig } = require('../helpers/solver-pool-rig');

const SOLVER = 'http://127.0.0.1:8191/v1';
const PAGE = 'https://search-engine.example/images?q=cover';

// ── The call layer ───────────────────────────────────────────────────────────

function page(html = '<html>results</html>') {
  return { data: { status: 'ok', solution: { response: html, cookies: [], userAgent: 'ua' } }, mode: 'stateless', queuedMs: 0, solveMs: 1 };
}

// A pool whose answers the test scripts, one per run().
function scriptedPool(answers) {
  const runs = [];
  return {
    runs,
    run(request, ctx) {
      runs.push({ request, ctx });
      const answer = answers.shift();
      const promise = typeof answer === 'function' ? answer() : Promise.resolve(answer);
      promise.catch(() => {});
      return { promise, promote() {}, extendDeadline() {} };
    },
  };
}

function makeCaller(answers) {
  const pool = scriptedPool(answers);
  const call = createSolverCaller({
    pool,
    flights: createSingleFlight(),
    assertPublicUrl: async () => {},
    getSolverContext,
    noteUsed: () => {},
    recoverFromHang: () => {},
    saveDomainSession: () => {},
    getDomainSession: () => null,
    safeFetch: () => assert.fail('no plain request was expected'),
    isChromeErrorPage: () => false,
    isBotChallengePage: () => false,
    needsChallengeSolve: () => false,
    siteLabel: (url) => new URL(url).hostname,
    userAgent: 'test-agent',
  });
  return { call, pool };
}

test('a one-off call is never the same flight as an ordinary call for the same page', () => {
  const ordinary = flightKey(PAGE, undefined);
  const oneOff = flightKey(PAGE, undefined, true);
  assert.notEqual(oneOff, ordinary, 'an ordinary caller must not be handed a page that came out of (or went into) a shared browser, or the other way round');
  assert.ok(oneOff.startsWith(ordinary), 'only an addition: every key of an ordinary call is what it was');
  assert.equal(flightKey(PAGE, undefined, false), ordinary);
  assert.equal(flightKey(PAGE, undefined, 'yes'), ordinary, 'only a real true counts');
});

test('the declaration reaches the pool with the call; an ordinary call carries no such word', async () => {
  const { call, pool } = makeCaller([page(), page()]);
  await runWithSolverContext({ priority: 'background', oneOff: true }, () => call(PAGE, SOLVER));
  await call('https://other-site.example/x', SOLVER);
  assert.equal(pool.runs[0].ctx.oneOff, true);
  assert.equal('oneOff' in pool.runs[1].ctx, false);
});

test('a one-off call and an ordinary call for the same page do not share a run', async () => {
  const gates = [];
  const answer = () => new Promise((resolve) => { gates.push(resolve); });
  const { call, pool } = makeCaller([answer, answer]);

  const ordinary = call(PAGE, SOLVER);
  const oneOff = runWithSolverContext({ oneOff: true }, () => call(PAGE, SOLVER));
  const again = runWithSolverContext({ oneOff: true }, () => call(PAGE, SOLVER));
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(pool.runs.length, 2, 'one run for the ordinary caller, one shared by the two one-off callers');

  gates.forEach((resolve, index) => resolve(page(`<html>run ${index}</html>`)));
  assert.deepEqual(await Promise.all([ordinary, oneOff, again]), ['<html>run 0</html>', '<html>run 1</html>', '<html>run 1</html>']);
});

// ── The pool, against a fake FlareSolverr ────────────────────────────────────

test('a one-off job gets a browser of its own even though a healthy session is open, and leaves that session as it was', async (t) => {
  const r = await rig(t);
  await r.run(A, '/warm').promise;
  await r.settled();
  const sessionId = creates(r.fake)[0].session;
  r.fake.clearLog();

  const result = await r.run(B, '/images?q=cover', {}, { oneOff: true }).promise;
  assert.equal(result.mode, 'stateless');
  const [sent] = navigations(r.fake);
  assert.equal(sent.stateless, true, 'a request.get with no session: FlareSolverr launches a browser and quits it');
  assert.equal(sent.session, null);
  assert.equal(sent.hadCookies, false, 'nothing is put in it either');
  assert.deepEqual(commands(r.fake, 'sessions.create'), []);
  assert.deepEqual(destroys(r.fake), []);
  assert.equal(r.fake.sessions.has(sessionId), true, 'the shared session is untouched');

  // The next ordinary call still goes through the shared session.
  r.fake.clearLog();
  const ordinary = await r.run(A, '/after').promise;
  await r.settled();
  assert.equal(ordinary.mode, 'session');
  assert.equal(navigations(r.fake)[0].session, sessionId);
});

test('a one-off job needs no session to exist, opens none, and counts as a one-off browser in the status', async (t) => {
  const r = await rig(t);
  const result = await r.run(A, '/images?q=cover', {}, { oneOff: true }).promise;
  await r.settled();
  assert.equal(result.mode, 'stateless');
  assert.equal(creates(r.fake).length, 0);
  assert.deepEqual(r.pool.getStatus().sessions, []);
  assert.equal(r.pool.getStatus().counters.statelessJobs, 1);
});

test('the declaration can come from the code around the call, like the rest of a caller\'s patience', async (t) => {
  const r = await rig(t);
  const result = await runWithSolverContext({ oneOff: true, priority: 'background' }, () => r.pool.run({ url: `${A}/images`, solverUrl: r.solverUrl }).promise);
  assert.equal(result.mode, 'stateless');
  assert.equal(creates(r.fake).length, 0);
});

test('a call that did not declare it is untouched: it still gets a session', async (t) => {
  const r = await rig(t);
  assert.equal((await r.run(A, '/plain').promise).mode, 'session');
  await r.settled();
});
