'use strict';

// The solver pool against a fake FlareSolverr 3.5.2 on loopback (no browser, no network):
// how a session ends: idle close, age, uses, closeAll, and closing the pool; what the status and
// the counters say.
// The rig (tests/helpers/solver-pool-rig.js) checks the session discipline - no request for an
// id that was not confirmed or is being destroyed - when every test ends.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGES: FAKE_TEXT } = require('../helpers/fake-flaresolverr');
const { A, B, sleep, until, makeClock, sequence, navigations, creates, destroys, rig, rejectionOf } = require('../helpers/solver-pool-rig');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver-pool');

// ── Idle close, age and uses ─────────────────────────────────────────────────

test('an idle session is closed after its idle time, by a timer that exists only while a session does', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock, settings: { idleMinutes: 1 } });
  assert.equal(clock.pending, 0);
  await r.run(A, '/one').promise;
  await r.settled();
  assert.equal(clock.pending, 1, 'one idle timer');
  r.assertTimersUnref();

  await clock.advance(30_000);
  assert.equal(destroys(r.fake).length, 0, 'not yet');
  await clock.advance(31_000);
  await until(() => destroys(r.fake).length === 1, 'the idle destroy');
  await until(() => clock.pending === 0, 'the idle timer to go with the session');
  assert.equal(r.pool.getStatus().sessions.length, 0, 'no session, no timer');
  assert.equal(r.events.used, 1, 'closing an idle session is not use');
});

test('a job that arrives while an idle session is being destroyed gets a new session, never the closing id', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock, settings: { idleMinutes: 1 } });
  await r.run(A, '/one').promise;
  await r.settled();
  const closingId = creates(r.fake)[0].session;

  r.fake.command('sessions.destroy', { delayMs: 200 });
  await clock.advance(60_000);
  await until(() => destroys(r.fake).length === 1, 'the destroy to be sent');
  const during = await r.run(A, '/two').promise;
  assert.equal(during.mode, 'session');
  const ids = creates(r.fake).map((e) => e.session);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[1], closingId);
  assert.equal(navigations(r.fake).find((e) => e.url.endsWith('/two')).session, ids[1]);
  await r.settled();
});

test('closeAll racing a new job: the job gets a new id and the destroyed one is never asked for', async (t) => {
  const r = await rig(t);
  await r.run(A, '/one').promise;
  await r.settled();
  const closingId = creates(r.fake)[0].session;

  r.fake.command('sessions.destroy', { delayMs: 150 });
  const closing = r.pool.closeAll('test');
  await until(() => destroys(r.fake).length === 1, 'the destroy to be sent');
  const during = await r.run(A, '/two').promise;
  await closing;
  assert.equal(during.mode, 'session');
  assert.notEqual(creates(r.fake)[1].session, closingId);
  await r.settled();
});

test('a destroy that times out asks for the solver to be recovered', async (t) => {
  const r = await rig(t, { config: { sessionDestroyTimeoutMs: 40 } });
  await r.run(A, '/one').promise;
  await r.settled();
  r.fake.command('sessions.destroy', { hang: true });
  await r.pool.closeAll('test');
  assert.equal(r.events.recovered, 1, 'the one place the pool does it itself');
});

test('a destroy that works never asks for it, and "already gone" counts as done', async (t) => {
  const r = await rig(t);
  await r.run(A, '/one').promise;
  await r.settled();
  await r.fake.restart(); // the session is gone, so the destroy is answered with an error
  await r.pool.closeAll('test');
  assert.equal(r.events.recovered, 0);
  assert.equal(r.pool.getStatus().sessions.length, 0);
  assert.equal(r.events.warns.length, 0);
});

test('a session is recycled between jobs after its uses, never in the middle of one', async (t) => {
  const r = await rig(t, { config: { maxSessionUses: 2 } });
  await r.run(A, '/1').promise;
  await r.run(A, '/2').promise;
  await r.settled();
  assert.equal(creates(r.fake).length, 1);
  await r.run(A, '/3').promise;
  await r.settled();
  assert.deepEqual(sequence(r.fake), ['create', 'get /1', 'blank', 'get /2', 'blank', 'destroy', 'create', 'get /3', 'blank']);
  assert.equal(navigations(r.fake).filter((e) => e.session === creates(r.fake)[0].session).length, 2, 'two uses, not three');
});

test('a session is recycled when it gets too old, but a job that is running when it does is not touched', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock, config: { maxSessionAgeMs: 5000 } });
  r.fake.page(`${A}/long`, { delayMs: 80 });
  const long = r.run(A, '/long').promise;
  await until(() => navigations(r.fake).length === 1, 'the job to start');
  await clock.advance(10_000); // the session is now too old, in the middle of the job
  await long;
  await r.settled();
  assert.equal(destroys(r.fake).length, 0, 'never mid-job');
  await r.run(A, '/next').promise;
  await r.settled();
  assert.equal(destroys(r.fake).length, 1);
  assert.equal(creates(r.fake).length, 2);
});

// ── Closing ──────────────────────────────────────────────────────────────────

test('closing the pool refuses what is queued, finishes what is running, destroys the sessions and leaves no timer', async (t) => {
  const r = await rig(t, { fakeOptions: { latencyMs: 60 } });
  await r.run(A, '/warm').promise;
  await r.settled();
  const running = r.run(A, '/running').promise;
  await until(() => navigations(r.fake).some((e) => e.url.endsWith('/running')), 'the job to start');
  const queued = r.run(A, '/queued');
  const closing = r.pool.shutdown({ timeoutMs: 2000 });
  assert.equal(r.pool.shutdown({ timeoutMs: 2000 }), closing, 'idempotent: the same promise');
  const refused = await rejectionOf(queued);
  assert.equal(refused.code, POOL_ERROR_CODES.SHUTTING_DOWN);
  assert.equal(refused.noRetry, true);
  assert.match((await running).data.solution.response, /running/);
  await closing;
  assert.equal(destroys(r.fake).length, 1);
  assert.equal(r.pool.getStatus().sessions.length, 0);
  assert.equal((await rejectionOf(r.run(A, '/late'))).code, POOL_ERROR_CODES.SHUTTING_DOWN);
  r.assertTimersUnref();
  assert.equal(r.liveTimers(), 0, 'no handle left');
  await r.pool.shutdown({ timeoutMs: 100 });
});

test('every timer the pool starts is unref\'d, and none is left once it has no work', async (t) => {
  const r = await rig(t, { config: { hostSpacingMs: 40 } });
  await Promise.all([r.run(A, '/1').promise, r.run(A, '/2').promise]);
  await r.settled();
  r.assertTimersUnref();
  await r.pool.closeAll('test');
  await sleep(10);
  assert.equal(r.liveTimers(), 0);
});

test('the status holds counts and states only: no cookie, query, credential, proxy detail or session id', async (t) => {
  const proxy = { url: 'http://proxy-host.example:3128', username: 'proxyuser', password: 'hunter2' };
  const r = await rig(t, { proxy: { proxy, mode: 'user-proxy', fingerprint: 'user:abc12345' } });
  await r.run(A, '/p?token=QUERY-SECRET').promise;
  await r.pool.run({ url: `${A}/c`, solverUrl: r.solverUrl, cookies: [{ name: 'auth', value: 'COOKIE-SECRET' }] }).promise;
  r.fake.page(`${A}/blocked`, { errorMessage: `${FAKE_TEXT.blocked} https://cf-site.example/blocked?k=MESSAGE-SECRET` });
  await rejectionOf(r.run(A, '/blocked'));

  const status = r.pool.getStatus();
  const text = JSON.stringify(status);
  for (const secret of ['QUERY-SECRET', 'COOKIE-SECRET', 'MESSAGE-SECRET', 'hunter2', 'proxyuser', 'proxy-host', 'abc12345', 'ss-', 'Cloudflare has blocked', 'https://']) {
    assert.ok(!text.includes(secret), `the status mentions ${secret}`);
  }
  assert.deepEqual(Object.keys(status.lastError).sort(), ['at', 'kind']);
  assert.equal(status.lastError.kind, 'blocked');
  assert.deepEqual(Object.keys(status.sessions[0]).sort(), ['ageMs', 'busy', 'idleMs', 'proxy', 'uses']);
  assert.equal(status.sessions[0].proxy, 'user');
  assert.deepEqual(JSON.parse(text), status, 'JSON-safe');
  await r.settled();
});

test('the counters add up and the work of the pool is noted for the idle watcher', async (t) => {
  const r = await rig(t);
  await r.run(A, '/1').promise;
  await r.run(A, '/2').promise;
  await r.pool.run({ url: `${B}/c`, solverUrl: r.solverUrl, cookies: [{ name: 'a', value: 'b' }] }).promise;
  await r.settled();
  const c = r.pool.getStatus().counters;
  assert.equal(c.jobs, 3);
  assert.equal(c.sessionJobs, 2);
  assert.equal(c.statelessJobs, 1);
  assert.equal(r.events.used, 3, 'once per job that ended');
});

test('a bad request is a programming error and says so at once', async (t) => {
  const r = await rig(t);
  assert.throws(() => r.pool.run(null), TypeError);
  assert.throws(() => r.pool.run({ url: '', solverUrl: r.solverUrl }), TypeError);
  assert.throws(() => r.pool.run({ url: `${A}/x` }), TypeError);
  assert.equal(r.fake.log.length, 0);
});
