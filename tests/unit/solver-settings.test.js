'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSolverSettings, repairSolverSettings, parseSolverSettingsUpdate } = require('../../server/modules/common/solver-settings');
const { DEFAULT_IDLE_MINUTES } = require('../../server/modules/network/flaresolverr-lifecycle');
const {
  POOL, SETTINGS_DEFAULTS, SETTINGS_BOUNDS, ENV_NAMES,
  DEFAULT_FLARESOLVERR_URL, FLARESOLVERR_VERIFIED_VERSION, FLARESOLVERR_RELEASES_URL, MESSAGES,
  SOLVER_VERSION_TIMEOUT_MS, CALLER_PATIENCE, TWO_LEVEL_SUFFIXES, solverStatusUrl,
} = require('../../server/config/solver');
const errorCodes = require('../../server/modules/errors/error-codes');

const DEFAULTS = {
  solverSessionsEnabled: false,
  solverSessionPoolSize: 2,
  solverSessionIdleMinutes: 10,
};

// Every value differs from its default, so a test that keeps one can tell it from a default coming back.
const GOOD_UPDATE = {
  solverSessionsEnabled: true,
  solverSessionPoolSize: 3,
  solverSessionIdleMinutes: 15,
};

// The keys of the feature that an update may carry, with a value of the right
// type and one of the wrong type for each.
const WRONG_TYPES = [
  ['solverSessionsEnabled', ['false', 'true', 0, 1, null, undefined, {}, []]],
  ['solverSessionPoolSize', ['2', 0, 4, 1.5, NaN, Infinity, -Infinity, -1, 1e9, null, undefined, true, [2], {}]],
  ['solverSessionIdleMinutes', ['5', 0, 16, 1.5, NaN, Infinity, -1, 120, null, undefined, true, [5], {}]],
];

// Keys that are not the feature's: the settings code must treat them like any other unknown key.
const OTHER_KEYS = { adFilterEnabled: false, adFilterExceptions: ['example.com'], adFilterConsent: 'download', somethingElse: 1 };

test('the defaults are the intended ones, and there are exactly three keys', () => {
  assert.deepEqual(normalizeSolverSettings({}), DEFAULTS);
  assert.deepEqual({ ...SETTINGS_DEFAULTS }, DEFAULTS);
});

test('nothing usable in means the defaults out, and the function never throws', () => {
  for (const raw of [undefined, null, 'x', 5, true, [], [1, 2], () => {}, Symbol('x'), { unrelated: 1 }]) {
    assert.deepEqual(normalizeSolverSettings(raw), DEFAULTS, String(typeof raw));
  }
});

test('valid stored values are kept, including both ends of each range', () => {
  assert.deepEqual(normalizeSolverSettings(GOOD_UPDATE), GOOD_UPDATE);
  assert.equal(normalizeSolverSettings({ solverSessionPoolSize: 1 }).solverSessionPoolSize, 1);
  assert.equal(normalizeSolverSettings({ solverSessionPoolSize: 3 }).solverSessionPoolSize, 3);
  assert.equal(normalizeSolverSettings({ solverSessionIdleMinutes: 1 }).solverSessionIdleMinutes, 1);
  assert.equal(normalizeSolverSettings({ solverSessionIdleMinutes: 15 }).solverSessionIdleMinutes, 15);
  assert.equal(normalizeSolverSettings({ solverSessionsEnabled: true }).solverSessionsEnabled, true);
});

test('a stored value of the wrong type or out of range becomes the default, never a clamped one', () => {
  for (const [key, values] of WRONG_TYPES) {
    for (const value of values) {
      const out = normalizeSolverSettings({ [key]: value });
      assert.deepEqual(out[key], SETTINGS_DEFAULTS[key], `${key}: ${String(value)}`);
    }
  }
  // 1e9 sessions is not "the maximum", it is a mistake.
  assert.equal(normalizeSolverSettings({ solverSessionPoolSize: 1e9 }).solverSessionPoolSize, SETTINGS_DEFAULTS.solverSessionPoolSize);
  assert.equal(normalizeSolverSettings({ solverSessionIdleMinutes: 16 }).solverSessionIdleMinutes, 10);
});

test('one bad value does not cost the good ones next to it', () => {
  const out = normalizeSolverSettings({ ...GOOD_UPDATE, solverSessionPoolSize: 99 });
  assert.deepEqual(out, { ...GOOD_UPDATE, solverSessionPoolSize: SETTINGS_DEFAULTS.solverSessionPoolSize });
});

test('a hostile backup import is repaired and the valid parts survive; the defaults are applied on reading, never stored', () => {
  // The way schema.js applies it: repairSolverSettings removes the junk from store.settings and writes
  // nothing; whoever needs a value reads it through normalizeSolverSettings.
  const settings = {
    flaresolverrUrl: 'http://127.0.0.1:8191/v1',
    theme: 'dark',
    solverSessionsEnabled: 'yes please',
    solverSessionPoolSize: 1e9,
    solverSessionIdleMinutes: 7,
  };
  repairSolverSettings(settings);
  assert.deepEqual(settings, {
    flaresolverrUrl: 'http://127.0.0.1:8191/v1',
    theme: 'dark',
    solverSessionIdleMinutes: 7,
  }, 'the junk is gone, the valid choice and the other keys stay, and no default was written');
  assert.deepEqual(normalizeSolverSettings(settings), {
    solverSessionsEnabled: SETTINGS_DEFAULTS.solverSessionsEnabled,
    solverSessionPoolSize: SETTINGS_DEFAULTS.solverSessionPoolSize,
    solverSessionIdleMinutes: 7,
  }, 'reading it gives the default where the junk was');
});

test('keys that are not the feature\'s are not read and not added: repairing writes nothing, reading returns only the three keys', () => {
  const out = normalizeSolverSettings({ ...GOOD_UPDATE, ...OTHER_KEYS });
  assert.deepEqual(out, GOOD_UPDATE);
  const settings = { theme: 'dark', ...OTHER_KEYS };
  const before = structuredClone(settings);
  repairSolverSettings(settings);
  assert.deepEqual(settings, before, 'no pool key is added, and the other keys are left as they were');
  assert.deepEqual(Object.keys(normalizeSolverSettings(settings)).sort(), ['solverSessionIdleMinutes', 'solverSessionPoolSize', 'solverSessionsEnabled']);
});

test('the result is a fresh object each time, so a caller cannot change the defaults', () => {
  const first = normalizeSolverSettings({});
  first.solverSessionPoolSize = 3;
  assert.deepEqual(normalizeSolverSettings({}), DEFAULTS);
  assert.ok(Object.isFrozen(SETTINGS_DEFAULTS));
  assert.ok(Object.isFrozen(SETTINGS_BOUNDS));
});

test('only properties the object owns count, and __proto__ cannot smuggle a setting in', () => {
  const inherited = Object.create({ solverSessionPoolSize: 3, solverSessionsEnabled: true });
  assert.deepEqual(normalizeSolverSettings(inherited), DEFAULTS);

  const hostile = JSON.parse('{"__proto__":{"solverSessionPoolSize":3,"solverSessionsEnabled":true,"polluted":true}}');
  assert.deepEqual(normalizeSolverSettings(hostile), DEFAULTS);
  assert.equal({}.polluted, undefined);
  assert.equal(normalizeSolverSettings(hostile).polluted, undefined);

  const thrower = { get solverSessionPoolSize() { throw new Error('boom'); }, solverSessionsEnabled: true };
  assert.deepEqual(normalizeSolverSettings(thrower), { ...DEFAULTS, solverSessionsEnabled: true });
});

test('a clean update comes back as a patch with the same values', () => {
  assert.deepEqual(parseSolverSettingsUpdate(GOOD_UPDATE), { patch: GOOD_UPDATE, error: null });
  assert.deepEqual(parseSolverSettingsUpdate({ solverSessionPoolSize: 2 }), { patch: { solverSessionPoolSize: 2 }, error: null });
  assert.deepEqual(parseSolverSettingsUpdate({ solverSessionsEnabled: false }), { patch: { solverSessionsEnabled: false }, error: null });
  assert.deepEqual(parseSolverSettingsUpdate({ solverSessionIdleMinutes: 1 }), { patch: { solverSessionIdleMinutes: 1 }, error: null });
});

test('an update with nothing for this feature is an empty patch, not an error', () => {
  for (const updates of [undefined, null, {}, 'x', 5, [], { flaresolverrUrl: 'http://127.0.0.1:8191/v1', proxyUrl: '' }]) {
    assert.deepEqual(parseSolverSettingsUpdate(updates), { patch: {}, error: null }, String(typeof updates));
  }
});

test('unknown keys are ignored and never copied into the patch', () => {
  const result = parseSolverSettingsUpdate({ solverSessionPoolSize: 2, flaresolverrUrl: 'x', ...OTHER_KEYS });
  assert.deepEqual(result, { patch: { solverSessionPoolSize: 2 }, error: null });
});

test('a key that is not the feature\'s is not validated: a bad value of one is no reason to refuse the update', () => {
  for (const bad of ['x', 5, null, {}, [], ['not a host']]) {
    for (const key of ['adFilterEnabled', 'adFilterExceptions']) {
      assert.deepEqual(parseSolverSettingsUpdate({ [key]: bad, solverSessionPoolSize: 2 }), { patch: { solverSessionPoolSize: 2 }, error: null }, `${key}: ${String(bad)}`);
    }
  }
});

test('booleans must be real booleans: the strings "false" and "true", 0, 1 and null are refused', () => {
  for (const value of ['false', 'true', 0, 1, null, undefined, {}, []]) {
    assert.deepEqual(
      parseSolverSettingsUpdate({ solverSessionsEnabled: value }),
      { patch: {}, error: 'solverSessionsEnabled must be true or false.' },
      String(value),
    );
  }
});

test('the whole numbers must be integers inside the bounds, and the message says which', () => {
  const poolMessage = 'solverSessionPoolSize must be a whole number from 1 to 3.';
  const idleMessage = 'solverSessionIdleMinutes must be a whole number from 1 to 15.';
  for (const value of ['2', 0, 4, 1.5, NaN, Infinity, -Infinity, -1, 1e9, null, true, [2], {}]) {
    assert.deepEqual(parseSolverSettingsUpdate({ solverSessionPoolSize: value }), { patch: {}, error: poolMessage }, String(value));
  }
  for (const value of ['5', 0, 16, 1.5, NaN, Infinity, -1, 120, null, true, [5], {}]) {
    assert.deepEqual(parseSolverSettingsUpdate({ solverSessionIdleMinutes: value }), { patch: {}, error: idleMessage }, String(value));
  }
  assert.equal(parseSolverSettingsUpdate({ solverSessionPoolSize: undefined }).error, poolMessage);
  assert.equal(parseSolverSettingsUpdate({ solverSessionPoolSize: 1 }).error, null);
  assert.equal(parseSolverSettingsUpdate({ solverSessionPoolSize: 3 }).error, null);
  assert.equal(parseSolverSettingsUpdate({ solverSessionIdleMinutes: 15 }).error, null);
});

test('the messages come from the bounds in the config, not from a second copy of them', () => {
  assert.match(parseSolverSettingsUpdate({ solverSessionPoolSize: 0 }).error, new RegExp(`from ${SETTINGS_BOUNDS.solverSessionPoolSize.min} to ${SETTINGS_BOUNDS.solverSessionPoolSize.max}\\.$`));
  assert.match(parseSolverSettingsUpdate({ solverSessionIdleMinutes: 0 }).error, new RegExp(`from ${SETTINGS_BOUNDS.solverSessionIdleMinutes.min} to ${SETTINGS_BOUNDS.solverSessionIdleMinutes.max}\\.$`));
});

test('an update is all or nothing: one bad value and nothing at all is applied', () => {
  for (const [key, values] of WRONG_TYPES) {
    for (const value of values) {
      const result = parseSolverSettingsUpdate({ ...GOOD_UPDATE, [key]: value });
      assert.deepEqual(result.patch, {}, `${key}: ${String(value)}`);
      assert.match(result.error, new RegExp(`^${key} `), `${key}: ${String(value)}`);
    }
  }
});

test('when several values are bad the first key in the settings order is reported', () => {
  const result = parseSolverSettingsUpdate({ solverSessionIdleMinutes: 'x', solverSessionPoolSize: 9 });
  assert.equal(result.error, 'solverSessionPoolSize must be a whole number from 1 to 3.');
});

test('__proto__ and inherited properties in an update are ignored', () => {
  const hostile = JSON.parse('{"__proto__":{"solverSessionPoolSize":99,"polluted":true},"solverSessionIdleMinutes":4}');
  assert.deepEqual(parseSolverSettingsUpdate(hostile), { patch: { solverSessionIdleMinutes: 4 }, error: null });
  assert.equal({}.polluted, undefined);
  const inherited = Object.create({ solverSessionPoolSize: 99 });
  assert.deepEqual(parseSolverSettingsUpdate(inherited), { patch: {}, error: null });
});

test('the error texts avoid the words that steer the System Health classifier', () => {
  const errors = [
    parseSolverSettingsUpdate({ solverSessionsEnabled: 'x' }).error,
    parseSolverSettingsUpdate({ solverSessionPoolSize: 0 }).error,
    parseSolverSettingsUpdate({ solverSessionIdleMinutes: 0 }).error,
  ];
  for (const text of errors) assert.doesNotMatch(text.toLowerCase(), /\bapi|\brapid|capital|http 500|maintenance|temporarily unavailable/, text);
});

test('config/solver.js: the pool caps are the settings bounds, and the defaults sit inside them', () => {
  assert.equal(POOL.defaultMaxSessions, SETTINGS_DEFAULTS.solverSessionPoolSize);
  assert.equal(POOL.maxSessionsMin, SETTINGS_BOUNDS.solverSessionPoolSize.min);
  assert.equal(POOL.maxSessionsCap, SETTINGS_BOUNDS.solverSessionPoolSize.max);
  assert.equal(POOL.defaultIdleMinutes, SETTINGS_DEFAULTS.solverSessionIdleMinutes);
  assert.equal(POOL.idleMinutesMin, SETTINGS_BOUNDS.solverSessionIdleMinutes.min);
  assert.equal(POOL.idleMinutesMax, SETTINGS_BOUNDS.solverSessionIdleMinutes.max);
  for (const key of ['solverSessionPoolSize', 'solverSessionIdleMinutes']) {
    const { min, max } = SETTINGS_BOUNDS[key];
    assert.ok(SETTINGS_DEFAULTS[key] >= min && SETTINGS_DEFAULTS[key] <= max, key);
  }
  // The pool must close its sessions before FlareSolverr restarts itself when idle: compared with the
  // lifecycle's own default, so lowering that one without lowering the pool's bound fails here.
  assert.ok(Number.isFinite(DEFAULT_IDLE_MINUTES), 'the lifecycle exports its idle-restart default');
  assert.ok(POOL.idleMinutesMax < DEFAULT_IDLE_MINUTES, `${POOL.idleMinutesMax} must stay below ${DEFAULT_IDLE_MINUTES}`);
});

test('config/solver.js: the tunables that matter hold the values they were chosen to have', () => {
  assert.equal(POOL.requestMaxTimeoutMs, 35_000);
  assert.equal(POOL.requestAbortGraceMs, 5_000);
  assert.equal(POOL.sessionCreateTimeoutMs, 60_000);
  assert.equal(POOL.sessionListTimeoutMs, 8_000);
  assert.equal(POOL.sessionDestroyTimeoutMs, 15_000);
  assert.equal(POOL.blankResetMaxTimeoutMs, 10_000);
  assert.equal(POOL.blankResetSettleMs, 400);
  assert.equal(POOL.maxSessionAgeMs, 3_600_000);
  assert.equal(POOL.maxSessionUses, 150);
  assert.equal(POOL.verifySkipWithinMs, 2_000);
  assert.equal(POOL.orphanIdPrefix, 'ss-');
  assert.deepEqual(POOL.queue, { maxQueued: 24, interactiveWaitMaxMs: 30_000, backgroundWaitMaxMs: 15_000 });
  assert.equal(POOL.restartWaitMaxMs, 120_000);
  assert.equal(POOL.downAfterWedgeMs, 30_000);
  assert.deepEqual(POOL.circuit, { failures: 3, windowMs: 300_000, openMs: 300_000 });
  assert.equal(POOL.hostSpacingMs, 1_500);
  assert.deepEqual(POOL.blockCooldown, { initialMs: 60_000, maxMs: 300_000 });
  assert.equal(POOL.shellResolveRetries, 1);
  assert.equal(POOL.affinityWaitMs, 20_000);
  assert.equal(POOL.driverRetryMinBudgetMs, 10_000);
  assert.equal(POOL.launchRetryDelayMs, 2_000);
  assert.equal(POOL.idleTickMs, 60_000);
  assert.equal(POOL.passThroughSiteLimit, 2, 'the pool-off path: different pages of one site in flight at once');
  // The numbers the pool's rules are built on: gate pruning, blank reset, restart watchdog, preflight, boundSolve, recycling.
  assert.equal(POOL.gatePruneAfterMs, 600_000);
  assert.equal(POOL.blankResetAbortGraceMs, 3_000);
  assert.equal(POOL.restartWatchdogGraceMs, 30_000);
  assert.equal(POOL.preflightMinBudgetMs, 3_000);
  assert.equal(POOL.boundSolveMarginMs, 1_000);
  assert.equal(POOL.boundSolveMinMs, 5_000);
  assert.equal(POOL.otherFailuresBeforeRecycle, 3);
  assert.equal(POOL.blankFailuresBeforeUnsupported, 3);
  // What used to be a bare number inside the modules.
  assert.equal(POOL.shutdownTimeoutMs, 5_000);
  assert.equal(POOL.solverTextMaxChars, 160);
  assert.equal(POOL.logReasonMaxChars, 80);
  assert.equal(POOL.fingerprintHexChars, 8);
  for (const [key, value] of Object.entries(POOL)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value) && value > 0, key);
  }
});

test('config/solver.js: environment names, URLs and the verified FlareSolverr version', () => {
  assert.deepEqual({ ...ENV_NAMES }, { solverSessionsDisabled: 'SCROLLSCAPE_SOLVER_SESSIONS_DISABLED' });
  assert.equal(DEFAULT_FLARESOLVERR_URL, 'http://127.0.0.1:8191/v1');
  assert.equal(FLARESOLVERR_VERIFIED_VERSION, '3.5.2');
  assert.equal(new URL(FLARESOLVERR_RELEASES_URL).protocol, 'https:');
  assert.equal(new URL(FLARESOLVERR_RELEASES_URL).hostname, 'api.github.com');
});

test('config/solver.js: what used to be bare numbers and lists in the call layer and the callers is named here', () => {
  for (const value of [POOL.directFetchTimeoutMs, POOL.powRetryDelayMs, SOLVER_VERSION_TIMEOUT_MS, ...Object.values(CALLER_PATIENCE)]) {
    assert.ok(Number.isFinite(value) && value > 0, String(value));
  }
  // A caller stops queueing for the browser before its own timeout: the margins are smaller than what they are taken from.
  assert.ok(CALLER_PATIENCE.coverGiveUpMarginMs < CALLER_PATIENCE.coverTryMs);
  assert.ok(Array.isArray(POOL.blankUrls) && POOL.blankUrls.length >= 1 && Object.isFrozen(POOL.blankUrls));
  assert.ok(POOL.blankUrls.every((url) => typeof url === 'string' && url));
});

test('config/solver.js: the status page of a FlareSolverr is the root of the address kept in Settings', () => {
  assert.equal(solverStatusUrl('http://127.0.0.1:8191/v1'), 'http://127.0.0.1:8191/');
  assert.equal(solverStatusUrl('http://nas.example:8191/v1/'), 'http://nas.example:8191/');
  assert.equal(solverStatusUrl('http://127.0.0.1:8191/'), 'http://127.0.0.1:8191/', 'already the root');
  assert.equal(solverStatusUrl(DEFAULT_FLARESOLVERR_URL), 'http://127.0.0.1:8191/');
});

test('config/solver.js: shared hosts are suffixes of their own, so two tenants are never one site', () => {
  for (const suffix of ['github.io', 'pages.dev', 'vercel.app', 'workers.dev', 'netlify.app', 'blogspot.com', 'herokuapp.com', 'web.app', 'firebaseapp.com']) {
    assert.ok(TWO_LEVEL_SUFFIXES.has(suffix), suffix);
  }
});

// What the templates are given in a test. The site is null on purpose: a text that
// names a host is the one thing the plain texts must not do.
const TEMPLATE_ARGUMENTS = { navigation: null, other: 'Something odd happened', http: 502 };

test('config/solver.js: a message is a plain text or a template, and the plain ones are whole sentences that name no host', () => {
  assert.deepEqual(Object.keys(MESSAGES).sort(), [
    'blocked', 'busy', 'down', 'driver', 'hostCooldown', 'http', 'launch', 'navigation', 'other', 'proxy',
    'proxyUnreadable', 'restarting', 'sessionNotReady', 'shuttingDown', 'sitePaused', 'timeout', 'unreachable',
  ]);
  assert.deepEqual(Object.keys(TEMPLATE_ARGUMENTS).sort(), Object.entries(MESSAGES).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort());
  for (const [kind, value] of Object.entries(MESSAGES)) {
    const text = typeof value === 'function' ? value(TEMPLATE_ARGUMENTS[kind]) : value;
    assert.equal(typeof text, 'string', kind);
    assert.ok(text.length > 20, kind);
    if (typeof value === 'string') assert.match(text, /[.]$/, kind);
    assert.doesNotMatch(text.toLowerCase(), /\bapi|\brapid|capital|maintenance|temporarily unavailable/, kind);
    assert.doesNotMatch(text, /\b[a-z0-9-]+\.(com|net|org|io|to|example)\b/i, kind);
  }
  assert.equal(MESSAGES.driver, MESSAGES.launch);
});

test('config/solver.js: the templates fill in what only the caller has, and keep the wording from before the pool', () => {
  assert.equal(MESSAGES.navigation('cf-site.example'), 'cf-site.example unavailable (server unreachable). Try again in a moment.');
  assert.equal(MESSAGES.navigation(null), 'This site unavailable (server unreachable). Try again in a moment.');
  assert.equal(MESSAGES.other('Error: boom'), 'FlareSolverr failed: Error: boom');
  assert.equal(MESSAGES.http(502), 'FlareSolverr HTTP 502');
  assert.equal(MESSAGES.http(0), 'FlareSolverr HTTP 0');
});

test('config/solver.js: the proxy text does not name a kind of proxy', () => {
  // Browser sessions go through the proxy from Settings, if any; there is no
  // other, so a text blaming another one would be false.
  assert.equal(MESSAGES.proxy, 'Cloudflare solver: the proxy was not reachable.');
  assert.doesNotMatch(MESSAGES.proxy, /filter|ad-/i);
});

test('the two new error codes follow ERROR-018 and are unique', () => {
  assert.equal(errorCodes.LOCG_REQUEST_FAILED, 'ERROR-018');
  assert.equal(errorCodes.SOLVER_SESSION_FAILED, 'ERROR-019');
  assert.equal(errorCodes.SOLVER_HOST_BLOCKED, 'ERROR-020');
  const values = Object.values(errorCodes);
  assert.equal(new Set(values).size, values.length, 'no code is used twice');
  assert.equal(new Set(Object.keys(errorCodes)).size, Object.keys(errorCodes).length);
});

// ── repairSolverSettings: what is stored is cleaned, and nothing is ever added ─────────────────────────

test('repairSolverSettings removes junk, keeps valid choices, adds nothing and leaves other keys alone', () => {
  const settings = { solverSessionsEnabled: 'yes', solverSessionPoolSize: 1, solverSessionIdleMinutes: 99, proxyUrl: 'http://p', unknown: 7 };
  assert.strictEqual(repairSolverSettings(settings), settings, 'the same object, in place');
  assert.deepEqual(settings, { solverSessionPoolSize: 1, proxyUrl: 'http://p', unknown: 7 });
  assert.deepEqual(repairSolverSettings({}), {}, 'an absent key stays absent');
  const once = { solverSessionsEnabled: false };
  repairSolverSettings(once);
  repairSolverSettings(once);
  assert.deepEqual(once, { solverSessionsEnabled: false });
});

test('repairSolverSettings never throws and is safe against hostile input', () => {
  for (const notAnObject of [undefined, null, 5, 'x', true]) assert.equal(repairSolverSettings(notAnObject), notAnObject);
  const polluted = JSON.parse('{"__proto__": {"solverSessionPoolSize": 1e9}, "solverSessionIdleMinutes": 3}');
  repairSolverSettings(polluted);
  assert.equal(({}).solverSessionPoolSize, undefined, 'Object.prototype is untouched');
  assert.equal(polluted.solverSessionIdleMinutes, 3);
  const frozen = Object.freeze({ solverSessionPoolSize: 1e9 });
  assert.doesNotThrow(() => repairSolverSettings(frozen));
  assert.equal(normalizeSolverSettings(frozen).solverSessionPoolSize, SETTINGS_DEFAULTS.solverSessionPoolSize, 'reading it still gives the default');
  const thrower = {};
  Object.defineProperty(thrower, 'solverSessionsEnabled', { enumerable: true, configurable: true, get() { throw new Error('boom'); } });
  assert.doesNotThrow(() => repairSolverSettings(thrower));
});
