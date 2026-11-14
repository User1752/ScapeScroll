'use strict';

// The solver pool against a fake FlareSolverr 3.5.2 on loopback (no browser, no network):
// one job at a time per session, spacing per site, affinity, and a site Cloudflare blocked.
// The rig (tests/helpers/solver-pool-rig.js) checks the session discipline - no request for an
// id that was not confirmed or is being destroyed - when every test ends.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGES: FAKE_TEXT } = require('../helpers/fake-flaresolverr');
const { A, B, sleep, until, makeClock, navigations, destroys, timedPost, TIMER_SLACK_MS, rig, rejectionOf } = require('../helpers/solver-pool-rig');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver-pool');
const { MESSAGES } = require('../../server/config/solver');
const { SOLVER_HOST_BLOCKED } = require('../../server/modules/errors/error-codes');

// ── One job at a time, spaced per site ───────────────────────────────────────

test('navigations to one site are spaced, and a spaced site does not hold up another', async (t) => {
  // The pool's time is the test's: how long a1 takes on a busy machine must not decide whether a2 is
  // still waiting out its spacing when b1 is picked.
  const clock = makeClock();
  const sends = [];
  const r = await rig(t, { clock, config: { hostSpacingMs: 80 }, deps: { post: timedPost(sends, clock.now) } });
  const [a1, a2, b1] = [r.run(A, '/a1'), r.run(A, '/a2'), r.run(B, '/b1')];
  await Promise.all([a1.promise, b1.promise]);
  assert.deepEqual(sends.map((s) => s.path), ['/a1', '/b1'], 'b1 does not wait behind the spaced a2');

  await clock.advance(79);
  assert.equal(sends.length, 2, 'a2 is still inside its spacing');
  await clock.advance(1);
  await a2.promise;
  await r.settled();
  assert.deepEqual(sends.map((s) => s.path), ['/a1', '/b1', '/a2']);
  assert.ok(sends[2].at - sends[0].at >= 80, `a1 -> a2 took ${sends[2].at - sends[0].at} ms`);
});

test('six callers racing for one site still start at least one spacing apart', async (t) => {
  const sends = [];
  // Every call takes longer than the spacing, so a second job sent onto a busy session WOULD overlap the first and
  // be counted as a collision: with no latency each call is over before the next arrives, and nothing can collide.
  const r = await rig(t, { config: { hostSpacingMs: 50 }, settings: { maxSessions: 3 }, fakeOptions: { latencyMs: 80 }, deps: { post: timedPost(sends) } });
  const results = await Promise.all(['/1', '/2', '/3', '/4', '/5', '/6'].map((path) => r.run(A, path).promise));
  await r.settled();
  assert.equal(results.length, 6);
  assert.equal(sends.length, 6);
  const starts = sends.map((s) => s.at).sort((a, b) => a - b);
  for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] - starts[i - 1] >= 50 - TIMER_SLACK_MS, `gap ${i}: ${starts[i] - starts[i - 1]} ms`);
  assert.equal(r.fake.collisions, 0);
});

test('with several sessions a site keeps the one that holds its cookies, and waits for it a while', async (t) => {
  const r = await rig(t, { settings: { maxSessions: 2 }, config: { affinityWaitMs: 400 } });
  await Promise.all([r.run(A, '/a1').promise, r.run(B, '/b1').promise]);
  await r.settled();
  const home = (host) => navigations(r.fake).find((e) => e.url.startsWith(host)).session;
  assert.notEqual(home(A), home(B), 'two sessions were opened');

  // The other session is idle, but a2 belongs to the one that is busy.
  r.fake.page(`${A}/a-slow`, { delayMs: 120 });
  const slow = r.run(A, '/a-slow').promise;
  await until(() => navigations(r.fake).some((e) => e.url.endsWith('/a-slow')), 'the slow job');
  const next = r.run(A, '/a2').promise;
  await Promise.all([slow, next]);
  await r.settled();
  assert.equal(navigations(r.fake).find((e) => e.url.endsWith('/a2')).session, home(A));
});

test('after the affinity wait the site takes any free session', async (t) => {
  const r = await rig(t, { settings: { maxSessions: 2 }, config: { affinityWaitMs: 30 } });
  await Promise.all([r.run(A, '/a1').promise, r.run(B, '/b1').promise]);
  await r.settled();
  const homeA = navigations(r.fake).find((e) => e.url.endsWith('/a1')).session;
  r.fake.page(`${A}/a-slow`, { delayMs: 300 });
  const slow = r.run(A, '/a-slow').promise;
  await until(() => navigations(r.fake).some((e) => e.url.endsWith('/a-slow')), 'the slow job');
  const next = await r.run(A, '/a2').promise;
  assert.notEqual(navigations(r.fake).find((e) => e.url.endsWith('/a2')).session, homeA);
  assert.match(next.data.solution.response, /a2/);
  await slow;
});

test('lowering the number of sessions closes the extra idle ones', async (t) => {
  const r = await rig(t, { settings: { maxSessions: 2 } });
  await Promise.all([r.run(A, '/a1').promise, r.run(B, '/b1').promise]);
  await r.settled();
  assert.equal(r.pool.getStatus().sessions.length, 2);
  r.pool.applySettings({ enabled: true, disabledBy: null, maxSessions: 1, idleMinutes: 10 });
  await until(() => destroys(r.fake).length === 1, 'one destroy');
  await until(() => r.pool.getStatus().sessions.length === 1, 'one session left');
});

// ── Cloudflare blocking a site ───────────────────────────────────────────────

test('a blocked site is left alone, for longer each time, and forgiven by a success', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock, config: { blockCooldown: { initialMs: 1000, maxMs: 4000 } } });
  const blocked = r.fake.page(`${A}/blocked`, { errorMessage: FAKE_TEXT.blocked });

  const first = await rejectionOf(r.run(A, '/blocked'));
  assert.equal(first.code, POOL_ERROR_CODES.REJECTED);
  assert.equal(first.kind, 'blocked');
  assert.equal(first.rateLimited, true);
  assert.deepEqual(r.events.errors.map((e) => [e.code, e.area, e.details]), [[SOLVER_HOST_BLOCKED, 'solver-pool', { host: 'cf-site.example', kind: 'blocked' }]]);
  await r.settled();
  assert.equal(destroys(r.fake).length, 0, 'the first block keeps the session');

  const seenBefore = r.fake.log.length;
  const cooling = await rejectionOf(r.run(A, '/another-page'));
  assert.equal(cooling.code, POOL_ERROR_CODES.HOST_COOLDOWN);
  assert.equal(cooling.message, MESSAGES.hostCooldown);
  assert.equal(cooling.rateLimited, true);
  assert.equal(cooling.noRetry, undefined);
  assert.equal(r.fake.log.length, seenBefore, 'rejected without a single request to FlareSolverr');
  assert.deepEqual(r.pool.getStatus().cooldowns, [{ host: 'cf-site.example', secondsLeft: 1 }]);

  await r.run(B, '/fine').promise;

  await clock.advance(1000);
  const second = await rejectionOf(r.run(A, '/blocked'));
  assert.equal(second.kind, 'blocked');
  assert.deepEqual(r.pool.getStatus().cooldowns, [{ host: 'cf-site.example', secondsLeft: 2 }], 'twice as long');
  await until(() => destroys(r.fake).length === 1, 'the recycle after two blocks in a row');
  assert.equal(r.events.errors.length, 2, 'one entry per cooldown that opens');

  await clock.advance(2000);
  blocked.remove();
  await r.run(A, '/blocked').promise;
  assert.deepEqual(r.pool.getStatus().cooldowns, [], 'a success clears it');

  r.fake.page(`${A}/blocked-again`, { errorMessage: FAKE_TEXT.blocked });
  await rejectionOf(r.run(A, '/blocked-again'));
  assert.deepEqual(r.pool.getStatus().cooldowns, [{ host: 'cf-site.example', secondsLeft: 1 }], 'and the next block starts from the beginning');
  await r.settled();
});

test('a cooldown that opens while a job waits rejects that job at pick time, still without a request', async (t) => {
  const r = await rig(t, { config: { blockCooldown: { initialMs: 5000, maxMs: 5000 } } });
  r.fake.page(`${A}/blocked`, { errorMessage: FAKE_TEXT.blocked, delayMs: 60 });
  const blocked = r.run(A, '/blocked');
  await until(() => navigations(r.fake).length === 1, 'the first job');
  const waiting = r.run(A, '/waiting');
  const first = await rejectionOf(blocked);
  assert.equal(first.kind, 'blocked');
  const second = await rejectionOf(waiting);
  assert.equal(second.code, POOL_ERROR_CODES.HOST_COOLDOWN);
  assert.equal(navigations(r.fake).length, 1);
  await r.settled();
});

test('a site that has not been seen for ten minutes is forgotten, cooldown history included', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock, settings: { idleMinutes: 15 }, config: { blockCooldown: { initialMs: 1000, maxMs: 4000 } } });
  const rule = r.fake.page(`${A}/blocked`, { errorMessage: FAKE_TEXT.blocked });
  await rejectionOf(r.run(A, '/blocked'));
  await r.settled();
  await clock.advance(11 * 60_000);
  await r.run(B, '/anything').promise; // the scheduler runs, and prunes the idle site
  await r.settled();
  assert.deepEqual(r.pool.getStatus().cooldowns, []);
  await rejectionOf(r.run(A, '/blocked'));
  assert.deepEqual(r.pool.getStatus().cooldowns, [{ host: 'cf-site.example', secondsLeft: 1 }], 'a first block again, not a second in a row');
  rule.remove();
  await r.settled();
  assert.equal(destroys(r.fake).length, 0, 'so no recycle either');
});

// ── Spacing in the corners ───────────────────────────────────────────────────

test('spacing counts from the moment a navigation really starts, so a slow launch is not free time', async (t) => {
  const sends = [];
  const r = await rig(t, { config: { hostSpacingMs: 150 }, fakeOptions: { launchMs: 100 }, deps: { post: timedPost(sends) } });
  const [first, second] = await Promise.all([r.run(A, '/a1').promise, r.run(A, '/a2').promise]);
  await r.settled();
  assert.equal(first.mode, 'session');
  assert.equal(second.mode, 'session');
  assert.ok(sends[1].at - sends[0].at >= 150 - TIMER_SLACK_MS, `a1 -> a2 took ${sends[1].at - sends[0].at} ms, the browser launch had been counted as waiting`);
});

test('a site is spaced even when a second session is free to take its next job', async (t) => {
  const sends = [];
  const r = await rig(t, { settings: { maxSessions: 2 }, config: { hostSpacingMs: 80, affinityWaitMs: 0 }, deps: { post: timedPost(sends) } });
  await Promise.all([r.run(A, '/a1').promise, r.run(A, '/a2').promise]);
  await r.settled();
  assert.ok(sends[1].at - sends[0].at >= 80 - TIMER_SLACK_MS, `two sessions started ${sends[1].at - sends[0].at} ms apart`);
});

// The job that was picked first can be ready last (it has to open a browser), and the one picked
// after it is then ready the moment the launch lock is free: both must not go out together.
const cookieJob = (r, path) => r.pool.run({ url: `${A}${path}`, solverUrl: r.solverUrl, cookies: [{ name: 'sid', value: 'x', domain: 'cf-site.example' }] });

test('a session job that first opens a browser and a one-off job for the same site still start a spacing apart', async (t) => {
  const sends = [];
  const r = await rig(t, { config: { hostSpacingMs: 80 }, fakeOptions: { launchMs: 120 }, deps: { post: timedPost(sends) } });
  const results = await Promise.all([r.run(A, '/session-job').promise, cookieJob(r, '/cookie-job').promise]);
  await r.settled();
  assert.deepEqual(results.map((res) => res.mode).sort(), ['session', 'stateless']);
  assert.equal(sends.length, 2);
  const gap = Math.abs(sends[1].at - sends[0].at);
  assert.ok(gap >= 80 - TIMER_SLACK_MS, `the two navigations started ${gap} ms apart`);
});

test('a job that waits out its site\'s spacing at the last moment does not send into a restart that began meanwhile', async (t) => {
  const sends = [];
  const r = await rig(t, { config: { hostSpacingMs: 400 }, fakeOptions: { launchMs: 120 }, deps: { post: timedPost(sends) } });
  const jobs = [r.run(A, '/session-job').promise, cookieJob(r, '/cookie-job').promise];
  await until(() => sends.length === 1, 'the first navigation');
  r.pool.beginRestart('test'); // the other job is now waiting for the spacing to pass
  await sleep(500);
  assert.equal(sends.length, 1, 'it was not sent while FlareSolverr was being replaced');
  r.pool.endRestart({ ok: true });
  const results = await Promise.all(jobs);
  assert.ok(results.every((res) => res.data.status === 'ok'));
  assert.equal(sends.length, 2);
  await r.settled();
});
