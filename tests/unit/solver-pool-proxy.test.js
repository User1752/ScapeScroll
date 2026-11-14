'use strict';

// The solver pool against a fake FlareSolverr 3.5.2 on loopback (no browser, no network):
// cookies, the pool switched off (the old path), and the proxy the browser is given.
// The rig (tests/helpers/solver-pool-rig.js) checks the session discipline - no request for an
// id that was not confirmed or is being destroyed - when every test ends.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGES: FAKE_TEXT } = require('../helpers/fake-flaresolverr');
const { A, B, sleep, until, makeClock, navigations, commands, creates, destroys, captureFetchErrors, rig, rejectionOf, outcomeOf } = require('../helpers/solver-pool-rig');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver-pool');

// ── Cookies, and the pool switched off ───────────────────────────────────────

test('a request with cookies runs in a one-off browser and leaves nothing in the shared session', async (t) => {
  const r = await rig(t);
  await r.run(A, '/anonymous').promise;
  await r.settled();
  const cookies = [{ name: 'auth', value: 'a-secret-value', domain: 'cf-site.example' }];
  const withCookies = await r.pool.run({ url: `${A}/account`, solverUrl: r.solverUrl, cookies }).promise;
  assert.equal(withCookies.mode, 'stateless');
  const entry = navigations(r.fake).find((e) => e.url.endsWith('/account'));
  assert.equal(entry.session, null);
  assert.equal(entry.hadCookies, true);
  assert.equal(entry.stateless, true);

  const later = await r.run(A, '/anonymous-again').promise;
  assert.equal(later.mode, 'session');
  assert.equal(later.data.solution.cookies.some((c) => c.name === 'auth'), false, 'the cookie did not reach the shared browser');
  assert.equal(r.pool.getStatus().counters.statelessJobs, 1);
  await r.settled();
});

test('switched off, the pool sends the old payload and nothing else: no session, no timer, the old error text', async (t) => {
  const thrown = captureFetchErrors(t);
  const clock = makeClock();
  const proxy = { proxy: { url: 'http://127.0.0.1:3128', username: 'u', password: 'p' }, mode: 'user-proxy', fingerprint: 'user:x' };
  const r = await rig(t, { clock, apply: false, proxy });
  assert.equal(r.pool.getStatus().state, 'disabled', 'a pool nobody has switched on is off');
  assert.equal(r.pool.getStatus().enabled, false);

  const first = await r.run(A, '/one').promise;
  assert.equal(first.mode, 'stateless');
  assert.match(first.data.solution.response, /\/one/);
  const entry = r.fake.log[0];
  assert.equal(entry.cmd, 'request.get');
  assert.equal(entry.session, null);
  assert.equal(entry.maxTimeout, 35000);
  assert.deepEqual(entry.proxy, proxy.proxy, 'the proxy still goes with every request');
  assert.equal(entry.hadCookies, false);

  r.pool.applySettings({ enabled: false, disabledBy: 'env', maxSessions: 1, idleMinutes: 10 });
  await r.pool.run({ url: `${A}/two`, solverUrl: r.solverUrl, cookies: [{ name: 'a', value: 'b' }] }).promise;
  assert.equal(r.fake.log[1].hadCookies, true);

  r.fake.page(`${A}/error`, { errorMessage: 'anything at all' });
  const refused = await rejectionOf(r.run(A, '/error'));
  assert.equal(refused.message, 'FlareSolverr HTTP 500', 'a non-2xx answer is the old text, whatever FlareSolverr said');
  assert.equal(refused.code, undefined);

  assert.equal(await r.pool.sweepOrphans(r.solverUrl), 0);
  assert.equal(commands(r.fake, 'sessions.list').length, 0);
  assert.equal(r.fake.log.filter((e) => e.cmd.startsWith('sessions.')).length, 0, 'no session command ever');
  assert.equal(clock.pending, 0, 'no timer ever');

  await r.fake.switchOff();
  const down = await rejectionOf(r.run(A, '/down'));
  assert.equal(down, thrown[thrown.length - 1], 'a transport error is rethrown as it is');
  assert.deepEqual(r.pool.getStatus().counters.jobs, 0);
  assert.equal(r.events.used, 0, 'the caller notes the use in this mode');
});

test('disabledBy reports what applySettings was told', async (t) => {
  const r = await rig(t, { apply: false });
  assert.equal(r.pool.getStatus().disabledBy, null);
  r.pool.applySettings({ enabled: false, disabledBy: 'setting', maxSessions: 1, idleMinutes: 10 });
  assert.deepEqual([r.pool.getStatus().enabled, r.pool.getStatus().disabledBy, r.pool.getStatus().state], [false, 'setting', 'disabled']);
  r.pool.applySettings({ enabled: false, disabledBy: 'env', maxSessions: 1, idleMinutes: 10 });
  assert.equal(r.pool.getStatus().disabledBy, 'env');
  r.pool.applySettings({ enabled: true, disabledBy: 'env', maxSessions: 1, idleMinutes: 10 });
  assert.deepEqual([r.pool.getStatus().enabled, r.pool.getStatus().disabledBy, r.pool.getStatus().state], [true, null, 'idle']);
  r.pool.applySettings({ enabled: false, disabledBy: 'nonsense', maxSessions: 1, idleMinutes: 10 });
  assert.equal(r.pool.getStatus().disabledBy, null);
});

test('switching the pool off closes its session, and jobs already queued go straight to the old path', async (t) => {
  const r = await rig(t);
  await r.run(A, '/warm').promise;
  await r.settled();
  r.fake.page(`${A}/slow`, { delayMs: 150 });
  const slow = r.run(A, '/slow').promise;
  await until(() => navigations(r.fake).some((e) => e.url.endsWith('/slow')), 'the slow job');
  const queued = [r.run(A, '/q1'), r.run(B, '/q2')];

  r.pool.applySettings({ enabled: false, disabledBy: 'setting', maxSessions: 1, idleMinutes: 10 });
  const released = await Promise.all(queued.map((h) => h.promise));
  assert.ok(released.every((res) => res.mode === 'stateless'), 'never stranded behind a pool that no longer schedules');
  assert.ok((await slow).data.solution.response.includes('/slow'), 'the job that was running finishes');
  await until(() => destroys(r.fake).length === 1, 'the busy session to be destroyed when its job ends');
  assert.equal(r.pool.getStatus().sessions.length, 0);
  assert.equal(r.liveTimers(), 0);

  const after = await r.run(A, '/after').promise;
  assert.equal(after.mode, 'stateless');
});

// A job that is sent back to wait (its first browser died, or its session went with a restart) is a
// step the pool takes by itself, long after run() looked at the state: it must be taken correctly
// when the pool has meanwhile been switched off or closed, because nothing schedules the queue then.

test('a job sent back for a second try while the pool is switched off is answered by the old path, not left waiting', async (t) => {
  const r = await rig(t);
  r.fake.page(`${A}/dies`, { errorMessage: FAKE_TEXT.driverDead, kill: true, delayMs: 100, times: 1 });
  const job = r.run(A, '/dies');
  await until(() => navigations(r.fake).length === 1, 'the request to start');
  r.pool.applySettings({ enabled: false, disabledBy: 'setting', maxSessions: 1, idleMinutes: 10 });

  const outcome = await outcomeOf(job);
  assert.ok(!outcome.stuck, 'the job was never answered');
  assert.equal(outcome.value.mode, 'stateless');
  assert.match(outcome.value.data.solution.response, /\/dies/);
  assert.equal(navigations(r.fake)[1].session, null, 'the second try is the old stateless request');
  assert.equal(r.pool.getStatus().inFlight, 0);
});

test('a job sent back for a second try while the pool is closing is refused cleanly, and closing still finishes', async (t) => {
  const r = await rig(t);
  r.fake.page(`${A}/dies`, { errorMessage: FAKE_TEXT.driverDead, kill: true, delayMs: 100, times: 1 });
  const job = r.run(A, '/dies');
  await until(() => navigations(r.fake).length === 1, 'the request to start');
  const closing = r.pool.shutdown({ timeoutMs: 1500 });

  const outcome = await outcomeOf(job);
  assert.ok(!outcome.stuck, 'the job was never answered');
  assert.equal(outcome.error.code, POOL_ERROR_CODES.SHUTTING_DOWN);
  assert.equal(outcome.error.noRetry, true);
  await closing;
  assert.equal(r.pool.getStatus().inFlight, 0);
  assert.equal(navigations(r.fake).length, 1, 'no second try was sent into a closing pool');
});

test('a job whose session went with a restart and that is sent back after the pool was switched off takes the old path', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = await rig(t, { deps: { getSolverProxy: async () => { await gate; return null; } } });
  const job = r.run(A, '/early');
  await sleep(20); // picked, and waiting for the proxy lookup
  r.pool.beginRestart('test');
  r.pool.applySettings({ enabled: false, disabledBy: 'env', maxSessions: 1, idleMinutes: 10 });
  release();

  const outcome = await outcomeOf(job);
  assert.ok(!outcome.stuck, 'the job was never answered');
  assert.equal(outcome.value.mode, 'stateless');
  assert.match(outcome.value.data.solution.response, /\/early/);
});

test('a job whose session went with a restart and that is sent back after the pool was closed is refused', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = await rig(t, { deps: { getSolverProxy: async () => { await gate; return null; } } });
  const job = r.run(A, '/early');
  await sleep(20);
  r.pool.beginRestart('test');
  const closing = r.pool.shutdown({ timeoutMs: 1500 });
  release();

  const outcome = await outcomeOf(job);
  assert.ok(!outcome.stuck, 'the job was never answered');
  assert.equal(outcome.error.code, POOL_ERROR_CODES.SHUTTING_DOWN);
  await closing;
  assert.equal(r.fake.log.length, 0, 'nothing was sent');
});

// ── The proxy the browser is given ───────────────────────────────────────────

test('only url, username and password reach FlareSolverr, and a proxy without a fingerprint gets a hashed one', async (t) => {
  const proxy = { url: 'http://127.0.0.1:3128', username: 'user', password: 'hunter2', note: 'not for FlareSolverr' };
  const r = await rig(t, { proxy: { proxy, mode: 'user-proxy' } });
  const result = await r.run(A, '/one').promise;
  assert.deepEqual(creates(r.fake)[0].proxy, { url: proxy.url, username: 'user', password: 'hunter2' });
  assert.match(result.fingerprint, /^[0-9a-f]{8}$/);
  assert.ok(!result.fingerprint.includes('hunter2'));
  assert.ok(!JSON.stringify(r.pool.getStatus()).includes(result.fingerprint));

  const other = await rig(t, { proxy: { proxy: { ...proxy, password: 'another' }, mode: 'user-proxy' } });
  assert.notEqual((await other.run(A, '/one').promise).fingerprint, result.fingerprint, 'a new password is a new proxy');
  await r.settled();
  await other.settled();
});

test('a proxy lookup that fails fails the job instead of sending it out without the proxy', async (t) => {
  const r = await rig(t, { deps: { getSolverProxy: async () => { throw new Error('the store is unreadable'); } } });
  const failure = await rejectionOf(r.run(A, '/one'));
  assert.equal(failure.message, 'the store is unreadable');
  assert.equal(r.fake.log.length, 0);
  await until(() => r.pool.getStatus().sessions.length === 0, 'the slot to be dropped');

  const off = await rig(t, { apply: false, deps: { getSolverProxy: async () => { throw new Error('the store is unreadable'); } } });
  assert.equal((await rejectionOf(off.run(A, '/one'))).message, 'the store is unreadable', 'also on the old path');
  assert.equal(off.fake.log.length, 0);
});

test('a proxy lookup that fails for a job holding a healthy session fails that job and keeps the session', async (t) => {
  let lookups = 0;
  const r = await rig(t, {
    deps: {
      getSolverProxy: async () => {
        lookups += 1;
        if (lookups === 2) throw new Error('the store is unreadable');
        return null;
      },
    },
  });
  await r.run(A, '/one').promise;
  await r.settled();
  const failure = await rejectionOf(r.run(A, '/two'));
  assert.equal(failure.message, 'the store is unreadable');
  await r.settled();
  assert.equal(navigations(r.fake).length, 1, 'nothing was sent for the job that failed');
  assert.equal(destroys(r.fake).length, 0, 'the session is fine, and so is its cookie jar');

  const third = await r.run(A, '/three').promise;
  assert.equal(third.mode, 'session');
  assert.equal(creates(r.fake).length, 1, 'the same session served the next job');
  await r.settled();
});

test('a session behind the user\'s proxy is labelled as such, without saying where the proxy is', async (t) => {
  const r = await rig(t, { proxy: { proxy: { url: 'http://127.0.0.1:55555' }, mode: 'user-proxy', fingerprint: 'user:55555' } });
  const result = await r.run(A, '/one').promise;
  assert.equal(result.proxyMode, 'user-proxy');
  assert.equal(r.pool.getStatus().sessions[0].proxy, 'user');
  assert.ok(!JSON.stringify(r.pool.getStatus()).includes('55555'));
  await r.settled();
});
