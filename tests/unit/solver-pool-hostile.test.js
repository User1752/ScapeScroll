'use strict';

// The solver pool against a fake FlareSolverr 3.5.2 on loopback (no browser, no network):
// hooks that throw, nobody waiting for a failure, settings that make no sense, and what the logs
// may contain.
// The rig (tests/helpers/solver-pool-rig.js) checks the session discipline - no request for an
// id that was not confirmed or is being destroyed - when every test ends.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGES: FAKE_TEXT } = require('../helpers/fake-flaresolverr');
const { A, B, sleep, until, makeClock, navigations, creates, rig, rejectionOf } = require('../helpers/solver-pool-rig');
const { createSolverPool } = require('../../server/modules/network/solver-pool');
const { SETTINGS_DEFAULTS, SETTINGS_BOUNDS } = require('../../server/config/solver');

const THIRD_SITE = 'https://third-site.example';

// ── Hostile surroundings ─────────────────────────────────────────────────────

test('a hook that throws or a logger that fails never breaks a job', async (t) => {
  const r = await rig(t, {
    hooks: { noteUsed() { throw new Error('hook'); }, onProxyFault() { throw new Error('hook'); } },
    deps: { recordError: async () => { throw new Error('disk full'); } },
  });
  const first = await r.run(A, '/one').promise;
  assert.equal(first.mode, 'session');
  r.fake.page(`${A}/blocked`, { errorMessage: FAKE_TEXT.blocked });
  assert.equal((await rejectionOf(r.run(A, '/blocked'))).kind, 'blocked', 'the recordError that fails is swallowed');
  r.fake.page(`${B}/proxy`, { errorMessage: FAKE_TEXT.proxyUnreachable });
  assert.equal((await rejectionOf(r.run(B, '/proxy'))).kind, 'proxy', 'and so is the onProxyFault that throws');
  await r.settled();
});

test('a job nobody is waiting for that fails is not an unhandled rejection', async (t) => {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  const r = await rig(t, { config: { queue: { maxQueued: 1 } } });
  r.fake.page(`${A}/slow`, { delayMs: 60 });
  r.run(A, '/slow');
  await until(() => navigations(r.fake).length === 1, 'the first job');
  r.run(A, '/queued');
  r.run(A, '/refused'); // the queue is full: its promise rejects, and the caller never looks
  await r.settled();
  await sleep(20);
  assert.deepEqual(seen, []);
});

test('a request on the old path that fails with nobody waiting for it is not an unhandled rejection either', async (t) => {
  const seen = [];
  const listener = (reason) => seen.push(reason);
  process.on('unhandledRejection', listener);
  t.after(() => process.off('unhandledRejection', listener));
  const r = await rig(t, { apply: false });
  await r.fake.switchOff();
  r.run(A, '/dropped'); // the pool is off and the solver is gone: the handle is dropped and its promise rejects
  await sleep(50);
  assert.deepEqual(seen, []);
});

test('settings that make no sense leave the pool off or at its defaults, and never throw', async (t) => {
  const r = await rig(t, { apply: false });
  for (const junk of [undefined, null, {}, { enabled: 'yes' }, { enabled: 1 }, 'on', 42]) {
    assert.doesNotThrow(() => r.pool.applySettings(junk));
    assert.equal(r.pool.getStatus().enabled, false, JSON.stringify(junk));
  }
  r.pool.applySettings({ enabled: true, maxSessions: 99, idleMinutes: 9999 });
  assert.equal(r.pool.getStatus().enabled, true);
  // Three sites at once: a clamp to the largest allowed size would open three browsers, the default opens fewer.
  assert.ok(SETTINGS_DEFAULTS.solverSessionPoolSize < SETTINGS_BOUNDS.solverSessionPoolSize.max, 'the check below tells a default from a clamp');
  await Promise.all([r.run(A, '/a').promise, r.run(B, '/b').promise, r.run(THIRD_SITE, '/c').promise]);
  await r.settled();
  assert.equal(r.pool.getStatus().sessions.length, SETTINGS_DEFAULTS.solverSessionPoolSize, 'an impossible number of sessions means the default, not the largest allowed');
});

test('a restart announced to a pool that is switched off changes nothing and starts no timer', async (t) => {
  const clock = makeClock();
  const r = await rig(t, { clock, apply: false });
  r.pool.beginRestart('test');
  r.pool.endRestart({ ok: false });
  assert.equal(clock.pending, 0);
  assert.equal(r.pool.getStatus().state, 'disabled');
  assert.equal((await r.run(A, '/one').promise).mode, 'stateless');
});

test('two pools in one process never mint the same session id', async (t) => {
  const first = await rig(t);
  const second = createSolverPool({ config: { hostSpacingMs: 0 }, log() {}, warn() {}, recordError: async () => {} });
  second.applySettings({ enabled: true, disabledBy: null, maxSessions: 1, idleMinutes: 10 });
  t.after(() => second.shutdown({ timeoutMs: 500 }));
  await first.run(A, '/one').promise;
  await second.run({ url: `${A}/two`, solverUrl: first.solverUrl }).promise;
  const ids = creates(first.fake).map((e) => e.session);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  await first.settled();
});

// ── Logs and recorded errors ─────────────────────────────────────────────────────

test('the log lines and the recorded errors hold no URL, cookie, credential or session id', async (t) => {
  const clock = makeClock();
  const proxy = { url: 'http://proxy-host.example:3128', username: 'proxyuser', password: 'hunter2' };
  const r = await rig(t, {
    clock,
    proxy: { proxy, mode: 'user-proxy', fingerprint: 'user:abc12345' },
    config: { maxSessionUses: 2, blockCooldown: { initialMs: 1000, maxMs: 2000 }, circuit: { failures: 2, windowMs: 60_000, openMs: 5000 } },
  });
  await r.run(A, '/p?token=QUERY-SECRET').promise;
  await r.pool.run({ url: `${A}/c?token=QUERY-SECRET`, solverUrl: r.solverUrl, cookies: [{ name: 'auth', value: 'COOKIE-SECRET' }] }).promise;
  r.fake.page(`${A}/blocked?token=QUERY-SECRET`, { errorMessage: `${FAKE_TEXT.blocked} https://cf-site.example/blocked?k=MESSAGE-SECRET` });
  await rejectionOf(r.run(A, '/blocked?token=QUERY-SECRET'));
  await clock.advance(1000);
  await r.run(A, '/again?token=QUERY-SECRET').promise;
  await r.run(A, '/third?token=QUERY-SECRET').promise; // the uses limit: a recycle
  r.pool.beginRestart('idle restart (SECRET-REASON-IS-FINE-HERE)');
  r.pool.endRestart({ ok: false });
  await clock.advance(31_000);
  r.fake.command('sessions.create', { errorMessage: 'Boom https://cf-site.example/x?k=CREATE-SECRET' });
  await r.run(A, '/f1').promise;
  await r.run(A, '/f2').promise; // opens the circuit
  await r.pool.closeAll('test');

  const written = JSON.stringify([r.events.logs, r.events.warns, r.events.errors]);
  assert.ok(r.events.logs.length + r.events.warns.length > 3, 'the scenario did produce log lines');
  for (const secret of ['QUERY-SECRET', 'COOKIE-SECRET', 'MESSAGE-SECRET', 'CREATE-SECRET', 'hunter2', 'proxyuser', 'proxy-host', 'abc12345', 'ss-', 'https://', 'http://', '?token']) {
    assert.ok(!written.includes(secret), `a log line or recorded error mentions ${secret}`);
  }
  for (const line of [...r.events.logs, ...r.events.warns]) assert.match(line, /^\[SolverPool\] /);
  for (const entry of r.events.errors) assert.deepEqual(Object.keys(entry.details).sort(), entry.details.host ? ['host', 'kind'] : ['kind']);
});
