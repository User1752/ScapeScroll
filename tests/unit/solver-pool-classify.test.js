'use strict';

// What the pool makes of FlareSolverr's answers, part one: the classifier on the recorded strings (all but
// blocked / timeout / invalid-command are Selenium wording, unverified until a real FlareSolverr shows the
// exact messages), the session ids, and the texts users see, run through the REAL System Health classifier
// (the lesson of 3.1.2: a text is only as good as the bucket it lands in). What the pool does with each kind of
// answer, end to end, is in solver-pool-outcomes.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGES: FAKE_TEXT } = require('../helpers/fake-flaresolverr');
const { classifySourceError, isTransientSourceErrorKey, STEERING } = require('../helpers/real-classifier');
const {
  classifyFlareSolverrMessage,
  describeSolverMessage,
  buildSessionId,
  parseSessionId,
} = require('../../server/modules/network/solver-pool');
const { MESSAGES } = require('../../server/config/solver');

// ── The classifier on recorded strings ───────────────────────────────────────

test('the strings FlareSolverr and Selenium print land in the kind the pool acts on', () => {
  const table = [
    ['blocked', FAKE_TEXT.blocked],
    ['blocked', `Error: Error solving the challenge. ${FAKE_TEXT.blocked}`],
    ['timeout', FAKE_TEXT.timeout(35000)],
    ['timeout', 'Error: Error solving the challenge. Timeout after 35.0 seconds.'],
    ['unsupported', FAKE_TEXT.invalidCmd('sessions.create')],
    ['unsupported', 'invalid cmd'],
    ['driver', FAKE_TEXT.driverDead],
    ['driver', FAKE_TEXT.windowClosed],
    ['launch', FAKE_TEXT.launchConflict],
    ['proxy', FAKE_TEXT.proxyUnreachable],
    ['proxy', 'unknown error: net::ERR_PROXY_AUTH_UNSUPPORTED'],
    // The proxy answered and refused the tunnel to the site: the proxy's doing, so a proxy failure like the others.
    ['proxy', FAKE_TEXT.tunnelFailed],
    ['navigation', FAKE_TEXT.navigation],
    ['other', 'something nobody has seen before'],
    ['other', ''],
  ];
  for (const [kind, message] of table) {
    assert.equal(classifyFlareSolverrMessage(message), kind, message);
  }
  assert.equal(classifyFlareSolverrMessage(undefined), 'other');
  assert.equal(classifyFlareSolverrMessage(null), 'other');
});

test('every phrase of the driver and launch rows is recognised on its own', () => {
  for (const phrase of [
    'invalid session id', 'no such window', 'target window already closed', 'web view not found', 'chrome not reachable',
    'disconnected', 'not connected to DevTools', 'session deleted', 'page crash', 'unexpected alert',
    'HTTPConnectionPool(host=\'localhost\', port=1234): Max retries exceeded with url: /session/x', 'Connection refused', 'RemoteDisconnected',
  ]) {
    assert.equal(classifyFlareSolverrMessage(`Error: Error solving the challenge. ${phrase}`), 'driver', phrase);
  }
  for (const phrase of ['PermissionError', 'Error starting Chrome', 'chromedriver.exe is locked', 'chromedriver in use', 'chromedriver: access denied']) {
    assert.equal(classifyFlareSolverrMessage(`Error: ${phrase}`), 'launch', phrase);
  }
});

test('a page problem that happens to contain "disconnected" is not a dead driver', () => {
  assert.equal(classifyFlareSolverrMessage('unknown error: net::ERR_INTERNET_DISCONNECTED'), 'navigation');
  assert.equal(classifyFlareSolverrMessage('unknown error: net::ERR_NAME_NOT_RESOLVED'), 'navigation');
  assert.equal(classifyFlareSolverrMessage('disconnected: not connected to DevTools'), 'driver');
});

test('a proxy failure is a proxy failure, not also a navigation error, and matching is repeatable', () => {
  assert.equal(classifyFlareSolverrMessage(FAKE_TEXT.proxyUnreachable), 'proxy');
  // No global flag on any pattern: the same text twice must give the same answer.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(classifyFlareSolverrMessage(FAKE_TEXT.blocked), 'blocked');
    assert.equal(classifyFlareSolverrMessage(FAKE_TEXT.timeout(500)), 'timeout');
  }
});

test('what a user may see of an unknown message: its first line, without URLs, bounded', () => {
  assert.equal(describeSolverMessage('Error: boom\nsecond line'), 'Error: boom');
  assert.equal(describeSolverMessage('Error: boom\\nescaped second line'), 'Error: boom', 'FlareSolverr escapes newlines as \\n');
  assert.equal(describeSolverMessage('failed to load https://cf-site.example/a?token=SECRET today'), 'failed to load today');
  assert.doesNotMatch(describeSolverMessage('see http://cf-site.example/x and https://other-site.example/y?a=b'), /example|http/);
  assert.equal(describeSolverMessage('x'.repeat(1000)).length, 160);
  assert.equal(describeSolverMessage(''), 'Unknown error');
  assert.equal(describeSolverMessage('https://cf-site.example/only-a-url'), 'Unknown error');
  assert.equal(describeSolverMessage(undefined), 'Unknown error');
});

// ── Session ids ──────────────────────────────────────────────────────────────

test('a session id carries the pid and a tag, and parses back to exactly its parts', () => {
  const id = buildSessionId(4242, 'mvo272', 7);
  assert.equal(id, 'ss-4242-mvo272-7');
  assert.deepEqual(parseSessionId(id), { pid: 4242, tag: 'mvo272', n: 7 });
  assert.deepEqual(parseSessionId(buildSessionId(1, 'a0', 123456)), { pid: 1, tag: 'a0', n: 123456 });
});

test('an id that is not ours is never parsed, so the orphan sweep leaves it alone', () => {
  for (const foreign of [
    'my-session', 'ss-', 'ss-4242', 'ss-4242-abc', 'ss-4242-abc-', 'ss--abc-1', 'ss-abc-abc-1', 'ss-4242--1',
    'ss-4242-ABC-1', 'ss-4242-abc-1-2', 'xss-4242-abc-1', 'SS-4242-abc-1', 'ss-0-abc-1', 'ss-4242-a_c-1', ' ss-4242-abc-1',
    `ss-${'9'.repeat(30)}-abc-1`, 'ss-4242-abc-1\n', '', null, undefined, 42, {}, ['ss-4242-abc-1'],
  ]) {
    assert.equal(parseSessionId(foreign), null, JSON.stringify(foreign));
  }
  assert.equal(parseSessionId('other-4242-abc-1', 'other-')?.pid, 4242, 'the prefix comes from the config');
});

// ── The user-facing texts, through the real classifier ───────────────────────

// The bucket each text must land in, and whether System Health shows it as a degraded (warning) state
// rather than a failure. The first group is the wording written for this pool. The second keeps the wording
// from before the pool (or is only seen while the app closes or when something that cannot happen did),
// which the classifier files where it always has: changing a word there is a behaviour change.
const EXPECTED_BUCKETS = {
  blocked: ['cloudflare_or_challenge', true],
  hostCooldown: ['rate_limit', true],
  sitePaused: ['rate_limit', true],
  timeout: ['timeout_or_network', true],
  driver: ['cloudflare_or_challenge', true],
  launch: ['cloudflare_or_challenge', true],
  proxy: ['cloudflare_or_challenge', true],
  busy: ['cloudflare_or_challenge', true],
  restarting: ['cloudflare_or_challenge', true],
  down: ['cloudflare_or_challenge', true],
  unreachable: ['cloudflare_or_challenge', true],
  proxyUnreadable: ['cloudflare_or_challenge', true],

  navigation: ['unknown', false],
  other: ['unknown', false],
  http: ['api_error', false],
  shuttingDown: ['unknown', false],
  sessionNotReady: ['unknown', false],
};

// What the templates are given here: no site, so there is no host name in the text.
const TEMPLATE_ARGUMENTS = { navigation: null, other: 'Something odd happened', http: 502 };

const renderMessage = (name) => (typeof MESSAGES[name] === 'function' ? MESSAGES[name](TEMPLATE_ARGUMENTS[name]) : MESSAGES[name]);

test('every user-facing text lands in the bucket it was written for, and steers nothing', () => {
  assert.deepEqual(Object.keys(MESSAGES).sort(), Object.keys(EXPECTED_BUCKETS).sort(), 'a new message needs an expected bucket here');
  assert.deepEqual(Object.keys(TEMPLATE_ARGUMENTS).sort(), Object.keys(MESSAGES).filter((name) => typeof MESSAGES[name] === 'function').sort());
  for (const [name, [bucket, transient]] of Object.entries(EXPECTED_BUCKETS)) {
    const text = renderMessage(name);
    const classified = classifySourceError(text);
    assert.equal(classified.key, bucket, `${name}: ${text}`);
    assert.equal(isTransientSourceErrorKey(classified.key), transient, `${name} is shown as ${transient ? 'a warning' : 'a failure'}`);
    for (const pattern of STEERING) assert.doesNotMatch(text, pattern, `${name} must not match ${pattern}`);
  }
});

test('the navigation text names the site it is about, without www, as it did before the pool', () => {
  assert.equal(MESSAGES.navigation('cf-site.example'), 'cf-site.example unavailable (server unreachable). Try again in a moment.');
  assert.equal(classifySourceError(MESSAGES.navigation('cf-site.example')).key, 'unknown');
});
