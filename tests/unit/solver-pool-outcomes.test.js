'use strict';

// What the pool makes of FlareSolverr's answers, part two: what each kind of answer does to the session and to the
// caller, end to end against the fake FlareSolverr (no browser, no network). The classifier on the recorded strings and
// the texts through the real System Health classifier are in solver-pool-classify.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { startFakeFlareSolverr, MESSAGES: FAKE_TEXT } = require('../helpers/fake-flaresolverr');
const { classifySourceError, isTransientSourceErrorKey, STEERING } = require('../helpers/real-classifier');
const { createSolverPool, POOL_ERROR_CODES } = require('../../server/modules/network/solver-pool');
const { MESSAGES } = require('../../server/config/solver');

const SITE = 'https://cf-site.example';

// ── What the pool does with each kind, end to end ────────────────────────────

const unrefSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(check, what = 'the condition') {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

async function rig(t, { config = {}, proxy = null } = {}) {
  const fake = await startFakeFlareSolverr();
  const events = { faults: [], errors: [], recovered: 0 };
  const pool = createSolverPool({
    config: { hostSpacingMs: 0, blankResetSettleMs: 5, launchRetryDelayMs: 5, ...config },
    getSolverProxy: async () => proxy,
    hooks: {
      noteUsed() {},
      recoverFromHang() { events.recovered += 1; },
      onProxyFault(info) { events.faults.push(info); },
    },
    log() {},
    warn() {},
    recordError: async (entry) => { events.errors.push(entry); },
  });
  pool.applySettings({ enabled: true, disabledBy: null, maxSessions: 1, idleMinutes: 10 });
  t.after(async () => {
    fake.clearRules();
    await Promise.race([pool.shutdown({ timeoutMs: 1000 }), unrefSleep(2000)]);
    await fake.stop();
  });
  return { fake, pool, events, solverUrl: fake.url };
}

const navigations = (fake) => fake.log.filter((e) => e.cmd === 'request.get' && e.url && e.url !== 'about:blank' && !e.url.startsWith('data:'));
const destroys = (fake) => fake.log.filter((e) => e.cmd === 'sessions.destroy');
const creates = (fake) => fake.log.filter((e) => e.cmd === 'sessions.create');

async function rejectionOf(handle) {
  try {
    await handle.promise;
  } catch (err) {
    return err;
  }
  return assert.fail('the job was expected to fail');
}

const run = (r, path = '/page') => r.pool.run({ url: `${SITE}${path}`, solverUrl: r.solverUrl });

test('blocked: the caller is told Cloudflare blocked the solver, it is not retried, and the session is kept', async (t) => {
  const r = await rig(t);
  r.fake.page(`${SITE}/blocked`, { errorMessage: FAKE_TEXT.blocked });
  const err = await rejectionOf(run(r, '/blocked'));
  assert.equal(err.code, POOL_ERROR_CODES.REJECTED);
  assert.equal(err.kind, 'blocked');
  assert.equal(err.message, MESSAGES.blocked);
  assert.equal(err.rateLimited, true, 'fetchText must not back off and retry a blocked site');
  assert.equal('solverMessage' in err, false, 'the raw text is not attached: it can hold an address or a path');
  await until(() => r.fake.log.some((e) => e.url === 'about:blank'), 'the blank reset');
  assert.equal(destroys(r.fake).length, 0, 'the first block keeps the session');
  assert.equal(classifySourceError(err.message).key, 'cloudflare_or_challenge');
});

test('timeout: reported as a timeout and the session is kept when it still answers', async (t) => {
  const r = await rig(t, { config: { requestMaxTimeoutMs: 40 } });
  r.fake.page(`${SITE}/slow`, { delayMs: 300 });
  const err = await rejectionOf(run(r, '/slow'));
  assert.equal(err.kind, 'timeout');
  assert.equal(err.message, MESSAGES.timeout);
  assert.equal(err.rateLimited, undefined);
  assert.equal(err.noRetry, undefined, 'a timeout may be retried once by the caller');
  assert.equal(classifySourceError(err.message).key, 'timeout_or_network');
  await until(() => r.fake.log.some((e) => e.url === 'about:blank' && e.outcome === 'ok'), 'the probe');
  assert.equal(destroys(r.fake).length, 0, 'a plain timeout never recycles: the cookie jar is the valuable part');
  await run(r, '/after').promise;
  assert.equal(creates(r.fake).length, 1, 'the next job is served by the same session');
});

test('timeout: a probe that fails recycles the session', async (t) => {
  const r = await rig(t, { config: { requestMaxTimeoutMs: 40 } });
  r.fake.page(`${SITE}/slow`, { delayMs: 300 });
  r.fake.page(/^(about:blank|data:)/, { errorMessage: 'driver is stuck' });
  await rejectionOf(run(r, '/slow'));
  await until(() => destroys(r.fake).length === 1, 'the destroy');
  r.fake.clearRules();
  await run(r, '/after').promise;
  assert.equal(creates(r.fake).length, 2, 'the next job opens a new session');
  assert.notEqual(creates(r.fake)[0].session, creates(r.fake)[1].session);
});

test('driver: the dead browser is recycled and the job runs once more on a fresh session', async (t) => {
  const r = await rig(t);
  r.fake.page(`${SITE}/dying`, { errorMessage: FAKE_TEXT.driverDead, kill: true, times: 1 });
  const result = await run(r, '/dying').promise;
  assert.equal(result.mode, 'session');
  assert.match(result.data.solution.response, /dying/);
  const sessions = creates(r.fake).map((e) => e.session);
  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0], sessions[1], 'a fresh id, never the one that died');
  assert.equal(destroys(r.fake).length, 1);
  assert.equal(navigations(r.fake).length, 2);
  assert.equal(r.pool.getStatus().counters.recycles, 1);
});

test('driver: the second failure reaches the caller, in the words written for it', async (t) => {
  const r = await rig(t);
  r.fake.page(`${SITE}/dying`, { errorMessage: FAKE_TEXT.windowClosed, kill: true });
  const err = await rejectionOf(run(r, '/dying'));
  assert.equal(err.kind, 'driver');
  assert.equal(err.message, MESSAGES.driver);
  assert.equal(navigations(r.fake).length, 2, 'exactly one retry');
  assert.equal(classifySourceError(err.message).key, 'cloudflare_or_challenge');
});

test('driver: no retry when too little of the job\'s patience is left', async (t) => {
  const r = await rig(t, { config: { driverRetryMinBudgetMs: 60_000 } });
  r.fake.page(`${SITE}/dying`, { errorMessage: FAKE_TEXT.driverDead, kill: true });
  const err = await rejectionOf(run(r, '/dying'));
  assert.equal(err.kind, 'driver');
  assert.equal(navigations(r.fake).length, 1);
  await until(() => destroys(r.fake).length === 1, 'the recycle');
});

test('launch: a failed launch is retried once and the retry opens the session', async (t) => {
  const r = await rig(t);
  r.fake.command('sessions.create', { errorMessage: FAKE_TEXT.launchConflict, times: 1 });
  const first = await run(r, '/one').promise;
  assert.equal(first.mode, 'session');
  const ids = creates(r.fake).map((e) => e.session);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], 'every create has an id of its own');
});

test('launch: two failed launches send the job to a one-off browser, and the caller never hears of it', async (t) => {
  const r = await rig(t);
  r.fake.command('sessions.create', { errorMessage: FAKE_TEXT.launchConflict });
  const result = await run(r, '/one').promise;
  assert.equal(result.mode, 'stateless');
  assert.match(result.data.solution.response, /\/one/);
  assert.equal(creates(r.fake).length, 2);
});

test('launch: when the one-off browser cannot start either, the caller sees the launch text', async (t) => {
  const r = await rig(t);
  r.fake.command('sessions.create', { errorMessage: FAKE_TEXT.launchConflict });
  r.fake.page(`${SITE}/never`, { errorMessage: FAKE_TEXT.launchConflict });
  const err = await rejectionOf(run(r, '/never'));
  assert.equal(err.kind, 'launch');
  assert.equal(err.message, MESSAGES.launch);
  assert.equal(creates(r.fake).length, 2, 'one retry of the launch');
});

test('proxy: the session is recycled, and only "cannot reach the proxy at all" is reported as a fault', async (t) => {
  const proxy = { proxy: { url: 'http://127.0.0.1:3128' }, mode: 'user-proxy', fingerprint: 'user:one' };
  const r = await rig(t, { proxy });

  r.fake.page(`${SITE}/down`, { errorMessage: FAKE_TEXT.proxyUnreachable, times: 1 });
  const unreachable = await rejectionOf(run(r, '/down'));
  assert.equal(unreachable.kind, 'proxy');
  assert.equal(unreachable.message, MESSAGES.proxy);
  assert.deepEqual(r.events.faults, [{ fingerprint: 'user:one' }], 'the fingerprint of the session that failed');
  await until(() => destroys(r.fake).length === 1, 'the recycle');

  r.fake.page(`${SITE}/other`, { errorMessage: 'unknown error: net::ERR_PROXY_AUTH_UNSUPPORTED', times: 1 });
  const other = await rejectionOf(run(r, '/other'));
  assert.equal(other.kind, 'proxy');
  assert.equal(r.events.faults.length, 1, 'another proxy error recycles the session but is no reachability fault');
  await until(() => destroys(r.fake).length === 2, 'the second recycle');
});

test('proxy: a tunnel the proxy refused is a proxy failure: the session is recycled, but it is no reachability fault', async (t) => {
  const r = await rig(t, { proxy: { proxy: { url: 'http://127.0.0.1:3128' }, mode: 'user-proxy', fingerprint: 'user:one' } });
  r.fake.page(`${SITE}/tunnel`, { errorMessage: FAKE_TEXT.tunnelFailed });
  const err = await rejectionOf(run(r, '/tunnel'));
  assert.equal(err.kind, 'proxy');
  assert.equal(err.message, MESSAGES.proxy);
  assert.equal(r.events.faults.length, 0, 'the proxy answered: only "cannot reach the proxy at all" is a reachability fault');
  await until(() => destroys(r.fake).length === 1, 'the recycle');
});

test('navigation: a page-level error keeps the session and keeps today\'s wording', async (t) => {
  const r = await rig(t);
  r.fake.page(`${SITE}/gone`, { errorMessage: FAKE_TEXT.navigation });
  const err = await rejectionOf(run(r, '/gone'));
  assert.equal(err.kind, 'navigation');
  assert.equal(err.message, 'cf-site.example unavailable (server unreachable). Try again in a moment.');
  assert.equal(r.events.faults.length, 0);
  await until(() => r.fake.log.some((e) => e.url === 'about:blank'), 'the blank reset');
  assert.equal(destroys(r.fake).length, 0);
});

test('unknown text degrades to "other": the first line, URLs stripped, and nothing is recycled for one', async (t) => {
  const r = await rig(t);
  r.fake.page(`${SITE}/odd`, { errorMessage: `Something odd happened at https://cf-site.example/odd?secret=1\nsecond line` });
  const err = await rejectionOf(run(r, '/odd'));
  assert.equal(err.kind, 'other');
  // Today's wording: FlareSolverr's own message ("Error: Error solving the challenge. ...") after the prefix.
  assert.equal(err.message, 'FlareSolverr failed: Error: Error solving the challenge. Something odd happened at');
  assert.doesNotMatch(err.message, /secret|https?:/);
  await until(() => r.fake.log.some((e) => e.url === 'about:blank'), 'the blank reset');
  assert.equal(destroys(r.fake).length, 0);
  assert.equal(creates(r.fake).length, 1);
});

test('three unknown answers in a row on one session recycle it defensively', async (t) => {
  const r = await rig(t);
  r.fake.page(/\/odd/, { errorMessage: 'Something odd happened' });
  for (let i = 1; i <= 3; i += 1) {
    const err = await rejectionOf(run(r, `/odd${i}`));
    assert.equal(err.kind, 'other');
  }
  await until(() => destroys(r.fake).length === 1, 'the defensive recycle');
  assert.equal(creates(r.fake).length, 1, 'recycled after the third, not before');
});

test('a relay\'s non-JSON answer is "FlareSolverr HTTP <status>", counted, and recycles nothing', async (t) => {
  const r = await rig(t);
  r.fake.page(`${SITE}/relay`, { rawBody: 'Bad Gateway', httpStatus: 502 });
  const err = await rejectionOf(run(r, '/relay'));
  assert.equal(err.message, 'FlareSolverr HTTP 502');
  assert.equal(err.code, undefined, 'a plain Error, as before the pool');
  await until(() => r.fake.log.some((e) => e.url === 'about:blank'), 'the blank reset');
  assert.equal(destroys(r.fake).length, 0);
  assert.equal(r.pool.getStatus().counters.httpErrors, 1);
  assert.equal(r.pool.getStatus().lastError.kind, 'http');
});

test('a JSON error is read whatever the HTTP status says', async (t) => {
  const r = await rig(t);
  r.fake.page(`${SITE}/ok-status`, { errorMessage: FAKE_TEXT.blocked, httpStatus: 200 });
  assert.equal((await rejectionOf(run(r, '/ok-status'))).kind, 'blocked');
});

test('a FlareSolverr that has no sessions: the job runs one-off and later jobs do not ask again until a restart', async (t) => {
  const r = await rig(t);
  r.fake.command('sessions.create', { errorMessage: FAKE_TEXT.invalidCmd('sessions.create') });
  const first = await run(r, '/one').promise;
  assert.equal(first.mode, 'stateless');
  assert.equal(creates(r.fake).length, 1);

  const second = await run(r, '/two').promise;
  assert.equal(second.mode, 'stateless');
  assert.equal(creates(r.fake).length, 1, 'no second attempt in this epoch');

  r.pool.beginRestart('test');
  r.pool.endRestart({ ok: true });
  r.fake.clearRules();
  const third = await run(r, '/three').promise;
  assert.equal(third.mode, 'session', 'a new FlareSolverr may support them');
});

test('the errors the pool raises itself are safe text, never a stack, and never mistaken for a hung solver', async (t) => {
  const r = await rig(t, { config: { queue: { maxQueued: 1 } } });
  r.fake.latencyMs = 80;
  const running = run(r, '/running');
  await until(() => navigations(r.fake).length === 1, 'the first job');
  const queued = run(r, '/queued');
  const refused = await rejectionOf(run(r, '/refused'));
  assert.equal(refused.code, POOL_ERROR_CODES.QUEUE_FULL);
  assert.equal(refused.message, MESSAGES.busy);
  assert.equal(refused.noRetry, true);
  assert.equal(refused.rateLimited, undefined, 'a busy local queue is not a rate limit');
  assert.ok(!['TimeoutError', 'AbortError'].includes(refused.name), 'it must not trigger the hang recovery');
  assert.doesNotMatch(refused.message, /\n|\bat /);
  await running.promise;
  await queued.promise;
});

test('the texts for a restarting, silent or closing solver are safe too', async (t) => {
  const r = await rig(t);
  r.pool.beginRestart('test');
  const restarting = await rejectionOf(r.pool.run({ url: `${SITE}/a`, solverUrl: r.solverUrl }, { deadlineAt: Date.now() + 20 }));
  r.pool.endRestart({ ok: false });
  const down = await rejectionOf(run(r, '/b'));
  await r.pool.shutdown({ timeoutMs: 500 });
  const closing = await rejectionOf(run(r, '/c'));

  assert.equal(restarting.code, POOL_ERROR_CODES.RESTARTING);
  assert.equal(down.code, POOL_ERROR_CODES.DOWN);
  assert.equal(closing.code, POOL_ERROR_CODES.SHUTTING_DOWN);
  for (const err of [restarting, down, closing]) {
    assert.equal(err.noRetry, true, 'a local state is not worth a second try');
    assert.ok(!['TimeoutError', 'AbortError'].includes(err.name));
    for (const pattern of STEERING) assert.doesNotMatch(err.message, pattern);
  }
  for (const err of [restarting, down]) {
    const classified = classifySourceError(err.message);
    assert.equal(classified.key, 'cloudflare_or_challenge', err.message);
    assert.equal(isTransientSourceErrorKey(classified.key), true);
  }
});
