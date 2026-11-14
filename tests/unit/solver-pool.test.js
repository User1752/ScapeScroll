'use strict';

// The solver pool against a fake FlareSolverr 3.5.2 on loopback (no browser, no network):
// opening, using and parking a session: one session per slot, reused, reset on a blank page, the
// list before a request, recycling on a proxy change, a timeout and what is asked of the browser
// afterwards.
// The rig (tests/helpers/solver-pool-rig.js) checks the session discipline - no request for an
// id that was not confirmed or is being destroyed - when every test ends.

const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakeFlareSolverr } = require('../helpers/fake-flaresolverr');
const { A, sleep, until, sequence, navigations, commands, creates, destroys, assertSessionDiscipline, rig, rejectionOf } = require('../helpers/solver-pool-rig');
const { parseSessionId } = require('../../server/modules/network/solver-pool');

// ── Opening, using and parking a session ─────────────────────────────────────

test('nothing is opened until the first job; then the session is created with the proxy and used with nothing but its id', async (t) => {
  const proxy = { url: 'http://127.0.0.1:3128', username: 'user', password: 'hunter2' };
  const r = await rig(t, { proxy: { proxy, mode: 'user-proxy', fingerprint: 'user:abc' } });
  assert.equal(r.fake.log.length, 0, 'a pool nobody has used sends nothing');
  assert.equal(r.liveTimers(), 0, 'and has no timer');
  assert.deepEqual(r.pool.getStatus().sessions, []);

  const result = await r.run(A, '/one').promise;
  const [create, get] = r.fake.log;
  assert.equal(create.cmd, 'sessions.create');
  assert.deepEqual(create.proxy, proxy, 'the proxy goes to the create, the only request that applies it');
  assert.deepEqual(r.fake.sessions.get(create.session).proxy, proxy);
  assert.equal(get.cmd, 'request.get');
  assert.equal(get.session, create.session);
  assert.equal(get.maxTimeout, 35000);
  assert.equal(get.proxy, null);
  assert.equal(get.ttl, null);
  assert.equal(get.hadCookies, false);
  assert.equal(parseSessionId(create.session).pid, process.pid, 'the id carries the pid the orphan sweep judges');

  assert.equal(result.mode, 'session');
  assert.equal(result.proxyMode, 'user-proxy');
  assert.equal(result.fingerprint, 'user:abc');
  assert.equal(result.data.status, 'ok');
  assert.match(result.data.solution.response, /\/one/);
  assert.ok(result.queuedMs >= 0 && result.solveMs >= 0);
  await r.settled();
});

test('five concurrent jobs never overlap on the session and each gets its own page', async (t) => {
  const r = await rig(t, { fakeOptions: { latencyMs: 15 } });
  const paths = ['/p1', '/p2', '/p3', '/p4', '/p5'];
  const results = await Promise.all(paths.map((path) => r.run(A, path).promise));
  results.forEach((res, i) => assert.match(res.data.solution.response, new RegExp(paths[i])));
  assert.equal(r.fake.collisions, 0, 'two requests on one session interleave in FlareSolverr');
  assert.equal(r.fake.peakInFlight, 1);
  assert.equal(creates(r.fake).length, 1);
  await r.settled();
});

test('the second job reuses the session', async (t) => {
  const r = await rig(t);
  await r.run(A, '/one').promise;
  await r.run(A, '/two').promise;
  await r.settled();
  assert.equal(creates(r.fake).length, 1);
  assert.deepEqual(sequence(r.fake), ['create', 'get /one', 'blank', 'get /two', 'blank']);
  assert.equal(r.pool.getStatus().sessions[0].uses, 2);
});

test('a job is answered before the browser is parked on a blank page, and the reset answer is never used', async (t) => {
  const r = await rig(t);
  r.fake.page('about:blank', { delayMs: 150 });
  const first = await r.run(A, '/one').promise;
  await until(() => r.fake.log.some((e) => e.url === 'about:blank'), 'the blank reset');
  const reset = r.fake.log.find((e) => e.url === 'about:blank');
  assert.equal(reset.outcome, null, 'the caller already has its answer while the reset is still running');
  assert.equal(first.data.solution.url, `${A}/one`);
  assert.deepEqual(first.data.solution.cookies.map((c) => c.name), ['cf_clearance']);

  const second = r.run(A, '/two').promise;
  await sleep(30);
  assert.equal(navigations(r.fake).length, 1, 'the next job waits for the browser to be free');
  await second;
  const next = navigations(r.fake)[1];
  assert.ok(next.t >= reset.endedAt - 1, 'and starts only after the reset ended');
  assert.equal(r.pool.getStatus().counters.resets >= 1, true);
  await r.settled();
});

test('after FlareSolverr was restarted behind its back, the next job asks before it trusts the id', async (t) => {
  const r = await rig(t, { config: { verifySkipWithinMs: 0 } });
  await r.run(A, '/one').promise;
  await r.settled();
  const firstId = creates(r.fake)[0].session;
  await r.fake.restart();
  r.fake.clearLog();

  const second = await r.run(A, '/two').promise;
  await r.settled();
  assert.deepEqual(sequence(r.fake), ['list', 'create', 'get /two', 'blank'], 'the list comes BEFORE the request, then a new session');
  assert.notEqual(creates(r.fake)[0].session, firstId);
  assert.deepEqual(r.fake.lazyCreated, []);
  assert.equal(second.mode, 'session');
});

test('the list before a request is skipped when the last answer is fresh, and sent when it is not', async (t) => {
  const fresh = await rig(t, { config: { verifySkipWithinMs: 60_000 } });
  await fresh.run(A, '/one').promise;
  await fresh.run(A, '/two').promise;
  await fresh.settled();
  assert.equal(commands(fresh.fake, 'sessions.list').length, 0);

  const strict = await rig(t, { config: { verifySkipWithinMs: 0 } });
  await strict.run(A, '/one').promise;
  await strict.run(A, '/two').promise;
  await strict.settled();
  assert.deepEqual(sequence(strict.fake), ['create', 'get /one', 'blank', 'list', 'get /two', 'blank']);
});

test('with a proxy configured the list is never skipped: a restart nobody announced cannot hand the job an unproxied session', async (t) => {
  const proxy = { url: 'http://127.0.0.1:3128' };
  const r = await rig(t, { config: { verifySkipWithinMs: 60_000 }, proxy: { proxy, mode: 'user-proxy', fingerprint: 'user:abc' } });
  await r.run(A, '/one').promise;
  await r.settled();
  await r.fake.restart(); // behind the pool's back: no begin / end event was sent for it
  r.fake.clearLog();

  const second = await r.run(A, '/two').promise;
  await r.settled();
  assert.deepEqual(sequence(r.fake), ['list', 'create', 'get /two', 'blank'], 'asked before it trusted the id, although the last answer was seconds old');
  assert.deepEqual(r.fake.lazyCreated, [], 'FlareSolverr was never asked about an id it did not have');
  assert.deepEqual(r.fake.sessions.get(creates(r.fake)[0].session).proxy, proxy, 'the job went out through the proxy');
  assert.equal(second.mode, 'session');
});

test('a changed proxy fingerprint recycles the session between jobs, and the new one gets the new proxy', async (t) => {
  let current = { proxy: { url: 'http://127.0.0.1:3128' }, mode: 'user-proxy', fingerprint: 'user:one' };
  const r = await rig(t, { deps: { getSolverProxy: async () => current } });
  await r.run(A, '/one').promise;
  await r.settled();
  const oldId = creates(r.fake)[0].session;

  current = { proxy: { url: 'http://127.0.0.1:4128' }, mode: 'user-proxy', fingerprint: 'user:two' };
  r.fake.command('sessions.destroy', { delayMs: 60 });
  const second = r.run(A, '/two').promise;
  const third = r.run(A, '/three').promise;
  await Promise.all([second, third]);
  await r.settled();

  // The list before /three is there although the last answer is fresh: a proxy is configured.
  assert.deepEqual(sequence(r.fake), ['create', 'get /one', 'blank', 'destroy', 'create', 'get /two', 'blank', 'list', 'get /three', 'blank']);
  assert.equal(destroys(r.fake)[0].session, oldId);
  assert.equal(creates(r.fake)[1].proxy.url, 'http://127.0.0.1:4128');
  assert.notEqual(creates(r.fake)[1].session, oldId);
  assert.equal(r.pool.getStatus().counters.recycles, 1);
});

test('a recycle sends its destroy to the solver the session lives on, and creates on the one the job names', async (t) => {
  const r = await rig(t);
  const other = await startFakeFlareSolverr();
  t.after(() => other.stop());
  await r.run(A, '/one').promise;
  await r.settled();
  const oldId = creates(r.fake)[0].session;

  await r.pool.run({ url: `${A}/two`, solverUrl: other.url }).promise;
  await until(() => destroys(r.fake).length === 1, 'the destroy on the first solver');
  assert.equal(destroys(r.fake)[0].session, oldId);
  assert.equal(commands(other, 'sessions.destroy').length, 0, 'the second solver never heard of the old id');
  assert.equal(creates(other).length, 1);
  assertSessionDiscipline(other);
  await r.pool.closeAll('test');
});

test('every create uses a new id, also when the same slot is recycled again and again', async (t) => {
  const r = await rig(t, { config: { maxSessionUses: 1 } });
  for (let i = 0; i < 4; i += 1) await r.run(A, `/p${i}`).promise;
  await r.settled();
  const ids = creates(r.fake).map((e) => e.session);
  assert.equal(ids.length, 4);
  assert.equal(new Set(ids).size, 4);
});

// ── Parking on a blank page ──────────────────────────────────────────────────

test('when the blank page is refused every time, sessions are recycled after use instead, and it is said once', async (t) => {
  const r = await rig(t);
  // The refusal blames the page itself; one that blamed the browser (a dead driver) would not make the pool give up on blank pages.
  r.fake.page(/^(about:blank|data:)/, { errorMessage: 'unknown error: invalid argument: this url is not allowed' });
  for (let i = 1; i <= 3; i += 1) {
    await r.run(A, `/p${i}`).promise;
    await until(() => destroys(r.fake).length === i, 'the recycle after a failed reset');
  }
  assert.equal(r.events.warns.filter((m) => /blank page/.test(m)).length, 1);
  r.fake.clearLog();
  await r.run(A, '/p4').promise;
  await until(() => destroys(r.fake).length === 1, 'the session to go after its job');
  assert.deepEqual(sequence(r.fake), ['create', 'get /p4', 'destroy'], 'no more attempts at the reset: the session goes after its job');
  assert.equal(r.events.warns.filter((m) => /blank page/.test(m)).length, 1);
});

test('about:blank refused but data: accepted is a working reset', async (t) => {
  const r = await rig(t);
  r.fake.page('about:blank', { errorMessage: 'refused' });
  await r.run(A, '/one').promise;
  await r.settled();
  assert.deepEqual(sequence(r.fake), ['create', 'get /one', 'blank', 'blank']);
  assert.equal(destroys(r.fake).length, 0);
  assert.equal(r.events.warns.length, 0);
});

// ── A timeout, and what is asked of the browser afterwards ───────────────────

test('after a timeout the browser gets a moment before it is asked for a blank page', async (t) => {
  const r = await rig(t, { config: { requestMaxTimeoutMs: 40, blankResetSettleMs: 150 } });
  r.fake.page(`${A}/slow`, { delayMs: 300 });
  await rejectionOf(r.run(A, '/slow'));
  await until(() => r.fake.log.some((e) => e.url === 'about:blank'), 'the probe');
  const answered = navigations(r.fake)[0];
  const probe = r.fake.log.find((e) => e.url === 'about:blank');
  assert.ok(probe.t - answered.endedAt >= 140, `the probe came ${probe.t - answered.endedAt} ms after the timeout`);
});

test('probes that fail after timeouts recycle the browser but do not make the pool give up on blank pages', async (t) => {
  const r = await rig(t, { config: { requestMaxTimeoutMs: 30, blankResetSettleMs: 1 } });
  r.fake.page(/\/slow/, { delayMs: 200 });
  r.fake.page(/^(about:blank|data:)/, { errorMessage: 'driver is stuck' });
  for (let i = 1; i <= 4; i += 1) {
    await rejectionOf(r.run(A, `/slow${i}`));
    await until(() => destroys(r.fake).length === i, 'the recycle');
  }
  assert.equal(r.events.warns.filter((m) => /blank page/.test(m)).length, 0);
});

// ── What the pool writes ─────────────────────────────────────────────────────

test('no line the pool writes has a hole in it, whatever happened: a recycle, a block, a restart, a close with no reason', async (t) => {
  const r = await rig(t, { settings: { maxSessions: 2 }, config: { maxSessionUses: 1, blockCooldown: { initialMs: 50, maxMs: 100 }, downAfterWedgeMs: 50 } });
  const B = 'https://other-site.example';
  await Promise.all([r.run(A, '/a1').promise, r.run(B, '/b1').promise]);
  await Promise.all([r.run(A, '/a2').promise, r.run(B, '/b2').promise]); // each session reached its use limit: recycled
  await r.settled();
  r.fake.page(`${A}/blocked`, { errorMessage: 'Cloudflare has blocked this request. Probably your IP is banned' });
  await rejectionOf(r.run(A, '/blocked'));
  await r.settled();
  r.pool.beginRestart(undefined);
  r.pool.endRestart({ ok: false });
  await sleep(70);
  r.pool.beginRestart('a restart with a reason');
  r.pool.endRestart({ ok: true });
  await r.run(A, '/after').promise;
  await r.settled();
  await r.pool.closeAll(); // the public call names no reason
  await r.pool.shutdown({ timeoutMs: 500 });

  const lines = [...r.events.logs, ...r.events.warns];
  assert.ok(lines.length >= 6, 'the run said enough to be worth checking');
  for (const line of lines) assert.doesNotMatch(line, /undefined|\[object|NaN|null\)/, line);
  assert.ok(lines.some((line) => /Session #\d+ recycled \(uses\)/.test(line)), 'and the reason of a recycle is in it');
});
