'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveSolverSettings,
  applySolverSettings,
  sweepSolverOrphans,
  proxyFingerprint,
  createUserProxyProvider,
} = require('../../server/modules/network/solver-wiring');
const { createSolverPool } = require('../../server/modules/network/solver-pool');
const { normalizeProxyInfo, hashProxy } = require('../../server/modules/network/solver/proxy-info');
const { MESSAGES } = require('../../server/config/solver');

const ENV_NAME = 'SCROLLSCAPE_SOLVER_SESSIONS_DISABLED';

// A pool that only remembers what it was told.
function recordingPool() {
  const told = [];
  return { told, applySettings: (settings) => told.push(settings), sweepOrphans: async () => 0 };
}

// The warn-once memory is shared by every env switch of the process, so each test that provokes
// a warning uses a value of its own.
function captureConsole(t) {
  const lines = { error: [], warn: [] };
  t.mock.method(console, 'error', (message) => lines.error.push(String(message)));
  t.mock.method(console, 'warn', (message) => lines.warn.push(String(message)));
  return lines;
}

// Until the start-up probes are shown to survive the pool's queue (config/solver.js), nobody has it on without choosing so.
const DEFAULT_DECISION = { enabled: false, disabledBy: 'setting', maxSessions: 2, idleMinutes: 10 };

test('with nothing stored and nothing in the environment the pool is off, and would hold two sessions at most, ten minutes', () => {
  assert.deepEqual(resolveSolverSettings({}, {}), DEFAULT_DECISION);
  assert.deepEqual(resolveSolverSettings(undefined, null), DEFAULT_DECISION);
});

test('the stored settings choose the size and the idle time; the setting off says "setting"', () => {
  assert.deepEqual(
    resolveSolverSettings({ solverSessionsEnabled: true, solverSessionPoolSize: 3, solverSessionIdleMinutes: 15 }, {}),
    { enabled: true, disabledBy: null, maxSessions: 3, idleMinutes: 15 },
  );
  assert.deepEqual(
    resolveSolverSettings({ solverSessionsEnabled: false, solverSessionPoolSize: 2 }, {}),
    { enabled: false, disabledBy: 'setting', maxSessions: 2, idleMinutes: 10 },
  );
});

test('junk in the stored settings becomes the defaults, never a clamp and never a throw', () => {
  const hostile = { solverSessionsEnabled: 'false', solverSessionPoolSize: 1e9, solverSessionIdleMinutes: -4 };
  assert.deepEqual(resolveSolverSettings(hostile, {}), DEFAULT_DECISION);
  assert.deepEqual(resolveSolverSettings(null, {}), DEFAULT_DECISION);
});

test('the environment switch wins over the setting and says "env"', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', 'y', ' 1 ']) {
    for (const wanted of [true, false]) {
      const decided = resolveSolverSettings({ solverSessionsEnabled: wanted }, { [ENV_NAME]: value });
      assert.equal(decided.enabled, false, `${JSON.stringify(value)} with the setting ${wanted}`);
      assert.equal(decided.disabledBy, 'env');
    }
  }
});

test('an UNSET variable, or any spelling of "off", does not disable anything', () => {
  for (const env of [{}, { [ENV_NAME]: '' }, { [ENV_NAME]: '0' }, { [ENV_NAME]: 'false' }, { [ENV_NAME]: 'no' }, { [ENV_NAME]: 'off' }, { [ENV_NAME]: 'N' }]) {
    assert.deepEqual(resolveSolverSettings({ solverSessionsEnabled: true }, env), { enabled: true, disabledBy: null, maxSessions: 2, idleMinutes: 10 }, JSON.stringify(env));
  }
});

test('a value that is not understood still switches the pool off (a brake fails safe) and warns once', (t) => {
  const lines = captureConsole(t);
  const env = { [ENV_NAME]: 'perhaps-wiring-test' };

  assert.equal(resolveSolverSettings({}, env).enabled, false);
  assert.equal(resolveSolverSettings({}, env).disabledBy, 'env');
  assert.equal(lines.error.length, 1, 'warned once for the same value');
  assert.match(lines.error[0], new RegExp(ENV_NAME));
  assert.match(lines.error[0], /"perhaps-wiring-test"/);
  assert.match(lines.error[0], /treating it as 1/);
});

test('keys that belong to nothing here are not read: an old ad-filter setting changes nothing', () => {
  const decided = resolveSolverSettings({ adFilterEnabled: false, adFilterExceptions: ['x.example'] }, {});
  assert.deepEqual(decided, DEFAULT_DECISION);
  assert.deepEqual(resolveSolverSettings({ solverSessionsEnabled: true, adFilterEnabled: false }, {}), { ...DEFAULT_DECISION, enabled: true, disabledBy: null });
});

test('applySolverSettings tells the pool exactly what was decided, once, and returns it', () => {
  const pool = recordingPool();
  const applied = applySolverSettings(pool, { solverSessionsEnabled: true, solverSessionPoolSize: 2 }, {});
  assert.deepEqual(pool.told, [{ enabled: true, disabledBy: null, maxSessions: 2, idleMinutes: 10 }]);
  assert.deepEqual(applied, pool.told[0]);
});

test('applySolverSettings never throws, even when the pool cannot be told', (t) => {
  const lines = captureConsole(t);
  const broken = { applySettings() { throw new Error('the pool is gone'); } };
  assert.equal(applySolverSettings(broken, {}, {}), null);
  assert.equal(applySolverSettings(undefined, {}, {}), null);
  assert.equal(lines.warn.length, 2);
  assert.match(lines.warn[0], /the pool is gone/);
});

test('a real pool starts off and is switched on, resized and off again through the same call', async (t) => {
  const pool = createSolverPool();
  t.after(() => pool.shutdown({ timeoutMs: 50 }));
  assert.equal(pool.getStatus().state, 'disabled');
  assert.equal(pool.getStatus().disabledBy, null, 'nobody has told it anything yet');

  applySolverSettings(pool, {}, {});
  assert.equal(pool.getStatus().state, 'disabled', 'nothing chosen: the default is off');
  assert.equal(pool.getStatus().disabledBy, 'setting');

  applySolverSettings(pool, { solverSessionsEnabled: true }, {});
  assert.equal(pool.getStatus().enabled, true);
  assert.equal(pool.getStatus().state, 'idle', 'on, but no browser is opened before the first job');

  applySolverSettings(pool, { solverSessionsEnabled: false }, {});
  assert.equal(pool.getStatus().state, 'disabled');
  assert.equal(pool.getStatus().disabledBy, 'setting');

  applySolverSettings(pool, { solverSessionsEnabled: true }, { [ENV_NAME]: '1' });
  assert.equal(pool.getStatus().state, 'disabled');
  assert.equal(pool.getStatus().disabledBy, 'env');
});

test('the sweep for old sessions asks the pool about the current solver address and reports how many it closed', async () => {
  const asked = [];
  const pool = { sweepOrphans: async (url) => { asked.push(url); return 3; } };
  assert.equal(await sweepSolverOrphans(pool, async () => 'http://127.0.0.1:8191/v1'), 3);
  assert.deepEqual(asked, ['http://127.0.0.1:8191/v1']);
});

test('the sweep never rejects: a failing pool or address lookup is a warning and 0', async (t) => {
  const lines = captureConsole(t);
  const failing = { sweepOrphans: async () => { throw new Error('sweep broke'); } };
  assert.equal(await sweepSolverOrphans(failing, async () => 'http://127.0.0.1:8191/v1'), 0);
  assert.equal(await sweepSolverOrphans({ sweepOrphans: async () => 1 }, async () => { throw new Error('no store'); }), 0);
  assert.equal(lines.warn.length, 2);
  assert.match(lines.warn[0], /sweep broke/);
  assert.match(lines.warn[1], /no store/);
});

test('the proxy fingerprint changes with the url, the user name and the password, and shows none of them', () => {
  const base = { url: 'http://proxy.example:8080', username: 'alice', password: 'hunter2-wiring' };
  const fingerprint = proxyFingerprint(base);
  assert.match(fingerprint, /^user:[0-9a-f]{8}$/);
  assert.equal(proxyFingerprint({ ...base }), fingerprint, 'the same proxy always gives the same fingerprint');
  for (const changed of [{ url: 'http://proxy.example:8081' }, { username: 'bob' }, { password: 'hunter3-wiring' }]) {
    assert.notEqual(proxyFingerprint({ ...base, ...changed }), fingerprint, JSON.stringify(Object.keys(changed)));
  }
  assert.notEqual(proxyFingerprint({ url: base.url }), fingerprint, 'a proxy without credentials is another proxy');
  assert.ok(!fingerprint.includes('hunter2') && !fingerprint.includes('alice'));
});

test('the pool\'s proxy provider answers null without a proxy and the proxy itself when there is one', async () => {
  assert.equal(await createUserProxyProvider(async () => null)(), null);

  const proxy = { url: 'http://proxy.example:8080', username: 'alice', password: 'hunter2-wiring' };
  const answer = await createUserProxyProvider(async () => proxy)('http://127.0.0.1:8191/v1');
  assert.deepEqual(answer.proxy, proxy);
  assert.equal(answer.mode, 'user-proxy');
  assert.equal(answer.fingerprint, proxyFingerprint(proxy));
});

test('the pool keeps the fingerprint it is given: a new password is a new fingerprint', async () => {
  const withPassword = (password) => createUserProxyProvider(async () => ({ url: 'http://proxy.example:8080', username: 'alice', password }))();
  const before = normalizeProxyInfo(await withPassword('one-wiring'));
  const after = normalizeProxyInfo(await withPassword('two-wiring'));
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.equal(before.mode, 'user-proxy');
});

test('an unreadable setting fails the job once a proxy has been seen: carrying on would send the user out on their own address', async () => {
  const proxy = { url: 'http://proxy.example:8080', username: 'alice', password: 'hunter2-wiring' };
  let reading = 'proxy';
  const cause = Object.assign(new Error('library file unreadable: C:\\Users\\me\\data\\store.json'), { code: 'STORE_UNREADABLE' });
  const provider = createUserProxyProvider(async () => {
    if (reading === 'fails') throw cause;
    return reading === 'proxy' ? proxy : null;
  });

  assert.deepEqual((await provider()).proxy, proxy);
  reading = 'fails';
  await assert.rejects(provider(), (err) => {
    assert.equal(err.message, MESSAGES.proxyUnreadable);
    assert.equal(err.cause, cause, 'the real cause stays reachable');
    assert.doesNotMatch(err.message, /store\.json|Users|hunter2|alice/, 'and none of it is in the text a user sees');
    return true;
  });
  await assert.rejects(provider(), { message: MESSAGES.proxyUnreadable }, 'and it keeps failing for as long as the read does');

  reading = 'proxy';
  assert.equal((await provider()).fingerprint, proxyFingerprint(proxy), 'a read that works again is trusted again');
});

test('before any proxy was seen an unreadable setting means none, as it always did; once the proxy was removed it is none again', async () => {
  let fails = true;
  let proxy = null;
  const provider = createUserProxyProvider(async () => {
    if (fails) throw new Error('Store accessed before configure() was called.');
    return proxy;
  });
  assert.equal(await provider(), null, 'nothing was ever configured, nothing is at stake');

  fails = false;
  proxy = { url: 'http://proxy.example:8080' };
  assert.ok(await provider());
  proxy = null; // the user cleared the proxy
  assert.equal(await provider(), null);
  fails = true;
  assert.equal(await provider(), null, 'the last thing known was "no proxy"');
});

test('the fingerprint of a proxy is the hash the pool computes for itself, behind the prefix that says whose it is', () => {
  const proxy = { url: 'http://proxy.example:8080', username: 'alice', password: 'hunter2-wiring' };
  assert.equal(proxyFingerprint(proxy), `user:${hashProxy(proxy)}`);
  assert.equal(normalizeProxyInfo({ proxy }).fingerprint, hashProxy(proxy), 'the pool hashes the same fields when the provider gave none');
});
