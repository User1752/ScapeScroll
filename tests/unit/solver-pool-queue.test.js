'use strict';

// The solver pool against a fake FlareSolverr 3.5.2 on loopback (no browser, no network):
// the queue: limits, deadlines, priorities, and the direct preflight of a job that waited.
// The rig (tests/helpers/solver-pool-rig.js) checks the session discipline - no request for an
// id that was not confirmed or is being destroyed - when every test ends.

const test = require('node:test');
const assert = require('node:assert/strict');

const { A, sleep, until, makeClock, navigations, rig, rejectionOf } = require('../helpers/solver-pool-rig');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver-pool');
const { runWithSolverContext } = require('../../server/modules/network/solver-context');
const { defaultPost } = require('../../server/modules/network/solver/transport');
const { MESSAGES } = require('../../server/config/solver');

// ── Queue, deadlines, priorities ─────────────────────────────────────────────

test('a full queue refuses at once, without a request, in words that are not a timeout', async (t) => {
  const r = await rig(t, { config: { queue: { maxQueued: 2 } } });
  r.fake.page(`${A}/slow`, { delayMs: 120 });
  const slow = r.run(A, '/slow').promise;
  await until(() => navigations(r.fake).length === 1, 'the slow job');
  const queued = [r.run(A, '/q1').promise, r.run(A, '/q2').promise];
  const seen = r.fake.log.length;
  const refused = await rejectionOf(r.run(A, '/q3'));
  assert.equal(refused.code, POOL_ERROR_CODES.QUEUE_FULL);
  assert.equal(refused.message, MESSAGES.busy);
  assert.equal(refused.noRetry, true);
  assert.ok(!['TimeoutError', 'AbortError'].includes(refused.name));
  assert.equal(r.fake.log.length, seen);
  await Promise.all([slow, ...queued]);
});

test('a job whose deadline passes in the queue is dropped and never reaches FlareSolverr', async (t) => {
  const r = await rig(t);
  r.fake.page(`${A}/slow`, { delayMs: 200 });
  const slow = r.run(A, '/slow').promise;
  await until(() => navigations(r.fake).length === 1, 'the slow job');
  const dropped = await rejectionOf(r.run(A, '/impatient', {}, { deadlineAt: Date.now() + 40, priority: 'background' }));
  assert.equal(dropped.code, POOL_ERROR_CODES.QUEUE_TIMEOUT);
  assert.equal(dropped.message, MESSAGES.busy);
  assert.equal(dropped.noRetry, true);
  assert.ok(!['TimeoutError', 'AbortError'].includes(dropped.name));
  await slow;
  await r.settled();
  assert.equal(navigations(r.fake).some((e) => e.url.endsWith('/impatient')), false);
  assert.equal(r.pool.getStatus().counters.queueTimeouts, 1);
});

test('a deadline declared around the call is read from the surrounding context', async (t) => {
  const r = await rig(t);
  r.fake.page(`${A}/slow`, { delayMs: 200 });
  const slow = r.run(A, '/slow').promise;
  await until(() => navigations(r.fake).length === 1, 'the slow job');
  const dropped = await rejectionOf(runWithSolverContext({ priority: 'background', deadlineAt: Date.now() + 40 }, () => r.run(A, '/ambient').promise));
  assert.equal(dropped.code, POOL_ERROR_CODES.QUEUE_TIMEOUT);
  await slow;
});

test('interactive jobs go before background ones, first come first served inside a class', async (t) => {
  const r = await rig(t);
  r.fake.page(`${A}/slow`, { delayMs: 100 });
  const slow = r.run(A, '/slow').promise;
  await until(() => navigations(r.fake).length === 1, 'the slow job');
  const jobs = [
    r.run(A, '/bg1', {}, { priority: 'background' }).promise,
    r.run(A, '/bg2', {}, { priority: 'background' }).promise,
    r.run(A, '/int1').promise,
    r.run(A, '/int2').promise,
  ];
  await Promise.all([slow, ...jobs]);
  assert.deepEqual(navigations(r.fake).map((e) => new URL(e.url).pathname), ['/slow', '/int1', '/int2', '/bg1', '/bg2']);
});

test('a joiner can raise the priority and extend the deadline of a job that is still waiting', async (t) => {
  const r = await rig(t);
  r.fake.page(`${A}/slow`, { delayMs: 150 });
  const slow = r.run(A, '/slow').promise;
  await until(() => navigations(r.fake).length === 1, 'the slow job');
  const other = r.run(A, '/other', {}, { priority: 'background' });
  const background = r.run(A, '/bg', {}, { priority: 'background', deadlineAt: Date.now() + 40 });
  background.promote('interactive');
  background.extendDeadline(Date.now() + 5000);
  await Promise.all([slow, background.promise, other.promise]);
  assert.deepEqual(navigations(r.fake).map((e) => new URL(e.url).pathname), ['/slow', '/bg', '/other'], 'promoted ahead of the job that was queued before it was');
});

test('a declared deadline never shortens a navigation that has started, unless the caller said so', async (t) => {
  const r = await rig(t);
  await r.run(A, '/plain', {}, { deadlineAt: Date.now() + 8000 }).promise;
  assert.equal(navigations(r.fake)[0].maxTimeout, 35000);

  await r.run(A, '/bound', {}, { deadlineAt: Date.now() + 8000, boundSolve: true }).promise;
  const bound = navigations(r.fake)[1].maxTimeout;
  assert.ok(bound >= 6000 && bound <= 7000, `derived from the deadline: ${bound}`);

  await r.run(A, '/floor', {}, { deadlineAt: Date.now() + 2000, boundSolve: true }).promise;
  assert.equal(navigations(r.fake)[2].maxTimeout, 5000, 'never below the floor');
  await r.settled();
});

test('a caller\'s own timeout replaces the default ceiling', async (t) => {
  const r = await rig(t);
  await r.run(A, '/short', { maxTimeoutMs: 12_000 }).promise;
  assert.equal(navigations(r.fake)[0].maxTimeout, 12_000);
  await r.settled();
});

test('boundSolve shortens a navigation in a session only: a one-off browser keeps the full time and the legacy abort', async (t) => {
  const seen = [];
  const post = (solverUrl, payload, options) => {
    if (payload.cmd === 'request.get') seen.push({ url: payload.url, session: payload.session || null, maxTimeout: payload.maxTimeout, timeoutMs: options.timeoutMs });
    return defaultPost(solverUrl, payload, options);
  };
  const r = await rig(t, { deps: { post } });
  const patience = { deadlineAt: Date.now() + 8000, boundSolve: true };

  await r.run(A, '/in-session', {}, patience).promise;
  await r.run(A, '/one-off', { cookies: [{ name: 'sid', value: 'mine', domain: 'cf-site.example' }] }, patience).promise;
  await r.settled();

  const inSession = seen.find((entry) => entry.url.endsWith('/in-session'));
  assert.ok(inSession.session, 'the first went to a browser that was already running');
  assert.ok(inSession.maxTimeout >= 6000 && inSession.maxTimeout <= 7000, `bounded by the deadline: ${inSession.maxTimeout}`);
  assert.equal(inSession.timeoutMs, inSession.maxTimeout + 5000);

  const oneOff = seen.find((entry) => entry.url.endsWith('/one-off'));
  assert.equal(oneOff.session, null);
  assert.equal(oneOff.maxTimeout, 35_000, 'a browser that is launched on demand is not bounded');
  assert.equal(oneOff.timeoutMs, 40_000, 'and our abort stays where it always was (the timeout plus 5 s)');
});

test('a one-off browser that launches slower than a bounded timeout would allow is not mistaken for a wedged FlareSolverr', async (t) => {
  // Scaled down: a bounded timeout of 90 ms plus a 40 ms grace would have cut the request at 130 ms,
  // while Chrome (150 ms here, seconds live) was still launching - which reads as a hang and restarts
  // FlareSolverr for nothing. The pool's time is the test's, so the 100 ms deadline is a number and not a race: on a loaded
  // machine the job could otherwise be dropped from the queue before it started.
  const clock = makeClock();
  const r = await rig(t, { clock, config: { boundSolveMinMs: 40, boundSolveMarginMs: 10, requestAbortGraceMs: 40 }, fakeOptions: { launchMs: 150 } });
  const jar = [{ name: 'sid', value: 'mine', domain: 'cf-site.example' }];

  const res = await r.run(A, '/cookies', { cookies: jar }, { deadlineAt: clock.now() + 100, boundSolve: true }).promise;

  assert.equal(res.mode, 'stateless');
  assert.equal(r.events.recovered, 0);
  assert.notEqual(r.pool.getStatus().state, 'down');
});

// ── Preflight ────────────────────────────────────────────────────────────────

const directAnswer = () => ({ data: { status: 'ok', solution: { response: '<html>direct</html>', cookies: [], userAgent: 'direct' } } });

test('a job that waited and whose site was solved meanwhile is answered by its preflight: no slot, one preflight at a time', async (t) => {
  const r = await rig(t);
  r.fake.page(`${A}/first`, { delayMs: 120 });
  const first = r.run(A, '/first').promise;
  await until(() => navigations(r.fake).length === 1, 'the first job');
  await sleep(5);

  let running = 0;
  let peak = 0;
  let calls = 0;
  const preflight = async () => {
    calls += 1;
    running += 1;
    peak = Math.max(peak, running);
    await sleep(4);
    running -= 1;
    return directAnswer();
  };
  const waiting = Array.from({ length: 20 }, (_, i) => r.run(A, `/w${i}`, { preflight }).promise);
  const results = await Promise.all(waiting);
  await first;
  await r.settled();
  assert.ok(results.every((res) => res.mode === 'direct' && res.data.solution.response === '<html>direct</html>'));
  assert.equal(calls, 20);
  assert.equal(peak, 1, 'never two plain requests to the site at once');
  assert.equal(navigations(r.fake).length, 1, 'no further navigation');
  assert.equal(r.pool.getStatus().counters.directJobs, 20);
});

test('waiting jobs are tried after the navigation ahead of them finished, once each, and never before the cookie exists', async (t) => {
  // The shape of the real burst: twenty lookups of one site queue behind the first one, which is the
  // only job that can produce the cookie. A try made before it ends can only fail, and each job is
  // given exactly one for the cookie it leaves.
  const r = await rig(t);
  r.fake.page(`${A}/first`, { delayMs: 120 });
  let cookieAt = null;
  const first = r.run(A, '/first').promise.then((res) => { cookieAt = Date.now(); return res; });
  await until(() => navigations(r.fake).length === 1, 'the first job');

  const asked = [];
  const preflight = (i) => async () => {
    asked.push({ i, afterCookie: cookieAt !== null });
    return cookieAt === null ? null : directAnswer();
  };
  const waiting = Array.from({ length: 20 }, (_, i) => r.run(A, `/w${i}`, { preflight: preflight(i) }).promise);
  const results = await Promise.all(waiting);
  await first;
  await r.settled();

  assert.ok(results.every((res) => res.mode === 'direct'));
  assert.equal(asked.length, 20);
  assert.ok(asked.every((entry) => entry.afterCookie), 'not one try before the cookie existed');
  assert.equal(new Set(asked.map((entry) => entry.i)).size, 20, 'each job once');
  assert.equal(navigations(r.fake).length, 1, 'no further navigation');
  assert.equal(r.pool.getStatus().counters.directJobs, 20);
});

test('a plain no from the site spares the other waiting jobs the same try, until the next navigation changes the cookie', async (t) => {
  const r = await rig(t);
  r.fake.page(`${A}/first`, { delayMs: 80 });
  const first = r.run(A, '/first').promise;
  await until(() => navigations(r.fake).length === 1, 'the first job');
  const asked = [];
  const refusing = (name) => async () => { asked.push(name); return null; };
  const jobs = ['/x1', '/x2', '/x3'].map((path) => r.run(A, path, { preflight: refusing(path) }).promise);
  await Promise.all([first, ...jobs]);
  await r.settled();
  // The first job to be tried got a no; the others were not sent to hear it at that cookie. Each
  // navigation after that changes the cookie, and then the next job in line gets the one try for it.
  assert.deepEqual(asked, ['/x1', '/x2', '/x3'], 'three tries for three cookies, instead of 3 + 2 + 1');
  assert.equal(navigations(r.fake).filter((e) => e.url.includes('/x')).length, 3);
});

test('a preflight that says no, throws, or has too little time left lets the job go to the browser', async (t) => {
  const r = await rig(t);
  const cases = {
    no: async () => null,
    throws: async () => { throw new Error('boom'); },
    malformed: async () => ({ data: 'not an object' }),
  };
  for (const [name, preflight] of Object.entries(cases)) {
    r.fake.page(`${A}/first-${name}`, { delayMs: 60 });
    const first = r.run(A, `/first-${name}`).promise;
    await until(() => navigations(r.fake).some((e) => e.url.endsWith(`/first-${name}`)), 'the first job');
    const [res] = await Promise.all([r.run(A, `/${name}`, { preflight }).promise, first]);
    assert.equal(res.mode, 'session', name);
  }

  r.fake.page(`${A}/first-late`, { delayMs: 60 });
  const lastFirst = r.run(A, '/first-late').promise;
  await until(() => navigations(r.fake).some((e) => e.url.endsWith('/first-late')), 'the first job');
  let impatientCalls = 0;
  const impatient = r.run(A, '/impatient', { preflight: async () => { impatientCalls += 1; return directAnswer(); } }, { deadlineAt: Date.now() + 2000 }).promise;
  const [late] = await Promise.all([impatient, lastFirst]);
  assert.equal(late.mode, 'session');
  assert.equal(impatientCalls, 0, 'skipped when less than 3 s of the deadline remain');
  await r.settled();
});

test('a job that did not have to wait is not preflighted', async (t) => {
  const r = await rig(t, { clock: makeClock() });
  let calls = 0;
  await r.run(A, '/now', { preflight: async () => { calls += 1; return directAnswer(); } }).promise;
  assert.equal(calls, 0);
  await r.settled();
});

test('a preflight that never answers cannot hold up the others beyond its own job\'s patience', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock });
  r.fake.page(`${A}/first`, { delayMs: 60 });
  const first = r.run(A, '/first').promise;
  await until(() => navigations(r.fake).length === 1, 'the first job');
  const hung = r.run(A, '/hung', { preflight: () => new Promise(() => {}) }, { deadlineAt: clock.now() + 8000 });
  let calls = 0;
  const second = r.run(A, '/second', { preflight: async () => { calls += 1; return directAnswer(); } });
  await clock.advance(10); // both have now waited
  await first;
  await sleep(30);
  assert.equal(calls, 0, 'the lane is held by the preflight that does not answer');
  await clock.advance(8000);
  assert.equal((await rejectionOf(hung)).code, POOL_ERROR_CODES.QUEUE_TIMEOUT, 'its caller gave up');
  assert.equal((await second.promise).mode, 'direct');
  assert.equal(calls, 1);
  await r.settled();
});
