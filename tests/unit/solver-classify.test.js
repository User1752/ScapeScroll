'use strict';

// server/modules/network/solver/classify.js on its own: what a FlareSolverr answer
// or a failed request means. Pure, so every case here is a plain call.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const {
  classifyFlareSolverrMessage,
  describeSolverMessage,
  refusesBlankPage,
  interpret,
  isTimeoutError,
  isSolverDown,
} = require('../../server/modules/network/solver/classify');

test('each class of FlareSolverr message is recognised, and the first matching class wins', () => {
  const table = [
    ['blocked', 'Error: Error solving the challenge. Cloudflare has blocked this request. Probably your IP is banned'],
    ['timeout', 'Error: Error solving the challenge. Timeout after 35.0 seconds.'],
    ['unsupported', "Request parameter 'cmd' = 'sessions.create' is invalid"],
    ['unsupported', 'invalid cmd'],
    ['driver', 'invalid session id'],
    ['driver', 'disconnected: not connected to DevTools'],
    ['launch', 'chromedriver.exe is locked'],
    ['proxy', 'unknown error: net::ERR_PROXY_CONNECTION_FAILED'],
    ['proxy', 'unknown error: net::ERR_TUNNEL_CONNECTION_FAILED'],
    ['navigation', 'unknown error: net::ERR_NAME_NOT_RESOLVED'],
    ['other', 'nobody has seen this before'],
    ['other', ''],
  ];
  for (const [kind, message] of table) assert.equal(classifyFlareSolverrMessage(message), kind, message);
  // A proxy failure also contains net::ERR_, but it is a proxy failure, not a navigation error.
  assert.equal(classifyFlareSolverrMessage('net::ERR_PROXY_CONNECTION_FAILED'), 'proxy');
  // The proxy refusing the tunnel to the site is the proxy's doing as well, not a navigation error of the site.
  assert.equal(classifyFlareSolverrMessage('net::ERR_TUNNEL_CONNECTION_FAILED'), 'proxy');
  assert.equal(classifyFlareSolverrMessage(undefined), 'other');
  assert.equal(classifyFlareSolverrMessage(null), 'other');
  assert.equal(classifyFlareSolverrMessage(42), 'other');
});

test('"disconnected" counts as a dead driver only as a word of its own, and matching is repeatable', () => {
  assert.equal(classifyFlareSolverrMessage('net::ERR_INTERNET_DISCONNECTED'), 'navigation');
  assert.equal(classifyFlareSolverrMessage('disconnected'), 'driver');
  for (let i = 0; i < 3; i += 1) assert.equal(classifyFlareSolverrMessage('Cloudflare has blocked this request'), 'blocked');
});

test('what a user may see of a message: first line, no URLs, bounded', () => {
  assert.equal(describeSolverMessage('boom\nsecond'), 'boom');
  assert.equal(describeSolverMessage('boom\\nescaped'), 'boom');
  assert.equal(describeSolverMessage('cannot load https://cf-site.example/a?token=SECRET now'), 'cannot load now');
  assert.equal(describeSolverMessage('x'.repeat(500)).length, 160);
  for (const empty of ['', undefined, null, 'https://cf-site.example/only-a-url']) assert.equal(describeSolverMessage(empty), 'Unknown error');
});

test('a huge message is answered at once and a cut never leaves half of a credential', () => {
  // The patterns are quadratic on a long unbroken run: 300k characters took minutes before the line was cut first.
  const started = Date.now();
  assert.equal(describeSolverMessage('a'.repeat(300000)), 'Unknown error');
  assert.equal(describeSolverMessage(`boom ${'a'.repeat(300000)}`), 'boom');
  assert.ok(Date.now() - started < 2000, 'the sanitiser must not scale with the size of the message');
  // The cut falls inside the credential: its first half must not be what remains.
  const padding = 'a'.repeat(POOL.solverLineMaxChars - 'https://h/'.length - 8);
  for (const tail of [' user:pa', ' user:passw0rd@host more', ' us']) {
    const shown = describeSolverMessage(`https://h/${padding}${tail}ssw0rd@host`);
    assert.doesNotMatch(shown, /user|passw|us\b/, tail);
  }
});

test('no address and no local path survives in what a user may see, whatever the scheme', () => {
  // A path is cut together with the rest of its line: a folder name with a space in it would otherwise
  // be left half shown.
  const shown = {
    'proxy refused socks5://user:pass@10.0.0.1:1080 for good': 'proxy refused for good',
    'cannot open ftp://files.example/a and wss://live.example/b': 'cannot open and',
    'loaded chrome-error://chromewebdata/ instead': 'loaded instead',
    'driver at C:\\Program Files\\Solver\\chromedriver.exe crashed': 'driver at',
    'cannot read d:/Users/me/AppData/profile now': 'cannot read',
    'share \\\\fileserver\\public\\cookies.sqlite is locked': 'share',
    'net::ERR_NAME_NOT_RESOLVED at about:blank': 'net::ERR_NAME_NOT_RESOLVED at about:blank',
    'a:b is not a drive and 3:30 is not a path': 'a:b is not a drive and 3:30 is not a path',
  };
  for (const [raw, expected] of Object.entries(shown)) assert.equal(describeSolverMessage(raw), expected, raw);
});

// What FlareSolverr echoes of a proxy it was given is not always a URL: a Selenium or Chrome message can carry the
// bare user:password@host form, and Linux or macOS paths are as private as Windows ones. Cut like the others.
test('a proxy with credentials but no scheme, and a path on a Unix computer, do not survive either', () => {
  const shown = {
    'connect to bob:secret@10.0.0.5:1080 failed': 'connect to failed',
    'proxy bob:p@ss/w0rd@proxy.example:3128 refused': 'proxy refused',
    'proxy user:@proxy.example:3128 refused': 'proxy refused',
    'cannot find Chrome binary at /usr/bin/google-chrome now': 'cannot find Chrome binary at',
    'cannot read /home/john smith/.config/chrome now': 'cannot read',
    'permission denied: (/var/lib/solver/profile)': 'permission denied: (',
    '/usr/bin/chromedriver crashed': 'Unknown error',
  };
  for (const [raw, expected] of Object.entries(shown)) assert.equal(describeSolverMessage(raw), expected, raw);
  assert.doesNotMatch(describeSolverMessage('connect to bob:secret@10.0.0.5:1080 failed'), /bob|secret|10\.0/);
});

test('text that only looks a little like a credential or a path is left alone', () => {
  for (const same of [
    'Error: invalid selector: a:b is not an address',
    'sent mail to admin@example.org twice',
    'retry 3:30 at 12/05/2024 and 1/2 of them',
    'and/or the other one',
    'POST /v1 was refused',
    'listening on localhost:8191/v1/sessions',
    'net::ERR_NAME_NOT_RESOLVED at about:blank',
    'read /tmp now',
  ]) {
    assert.equal(describeSolverMessage(same), same, same);
  }
});

test('interpret: ok, the kind of an error message, or http when there is nothing usable', () => {
  const ok = interpret({ httpStatus: 200, body: { status: 'ok', solution: {} } });
  assert.deepEqual([ok.kind, ok.httpStatus], ['ok', 200]);
  assert.equal(ok.body.status, 'ok');

  // The body is read whatever the HTTP status: FlareSolverr carries its errors as 500 + JSON.
  const blocked = interpret({ httpStatus: 500, body: { status: 'error', message: 'Cloudflare has blocked this request' } });
  assert.deepEqual(blocked, { kind: 'blocked', message: 'Cloudflare has blocked this request', httpStatus: 500 });

  assert.deepEqual(interpret({ httpStatus: 502, body: null }), { kind: 'http', httpStatus: 502 });
  assert.deepEqual(interpret({ httpStatus: 200, body: { status: 'error' } }), { kind: 'http', httpStatus: 200 });
  assert.deepEqual(interpret({ httpStatus: 200, body: { status: 'error', message: 42 } }), { kind: 'http', httpStatus: 200 });
  // "ok" wins over a message that happens to be there.
  assert.equal(interpret({ httpStatus: 200, body: { status: 'ok', message: 'Cloudflare has blocked this request' } }).kind, 'ok');
});

test('isTimeoutError: only our own timeout and abort', () => {
  assert.equal(isTimeoutError(new DOMException('x', 'TimeoutError')), true);
  assert.equal(isTimeoutError(new DOMException('x', 'AbortError')), true);
  assert.equal(isTimeoutError(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  for (const other of [new Error('x'), new TypeError('fetch failed'), null, undefined, 'TimeoutError']) assert.equal(isTimeoutError(other), false);
});

test('isSolverDown: a refused or unroutable connection, also inside an AggregateError, nothing else', () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  assert.equal(isSolverDown(refused), true);
  const unreachable = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENETUNREACH' } });
  assert.equal(isSolverDown(unreachable), true);
  // "localhost" resolving to ::1 and 127.0.0.1 gives an AggregateError of refusals.
  const aggregate = Object.assign(new TypeError('fetch failed'), { cause: { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] } });
  assert.equal(isSolverDown(aggregate), true);
  for (const other of [
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }),
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
    new TypeError('fetch failed'),
    null,
    undefined,
  ]) assert.equal(isSolverDown(other), false);
});

test('refusesBlankPage: only an answer that blames the page itself says this FlareSolverr will not park a session on it', () => {
  const answer = (message) => interpret({ httpStatus: 500, body: { status: 'error', message } });
  for (const message of [
    'Error: unknown error: invalid argument: about:blank is not allowed',
    'Error: Request parameter \'url\' is invalid',
    'Error solving the challenge. net::ERR_INVALID_URL',
    'Error: data:text/html, was refused',
  ]) {
    assert.equal(refusesBlankPage(answer(message)), true, message);
  }
  // The browser itself failing says nothing about the page: a dead driver, a launch that failed, a timeout, a bad proxy.
  for (const message of [
    'Error: invalid session id',
    'Error starting Chrome: PermissionError',
    'Error solving the challenge. Timeout after 10.0 seconds.',
    'Error: unknown error: net::ERR_PROXY_CONNECTION_FAILED',
    'Error: no',
    'Cloudflare has blocked this request',
    '',
  ]) {
    assert.equal(refusesBlankPage(answer(message)), false, message);
  }
  assert.equal(refusesBlankPage({ kind: 'http', httpStatus: 502 }), false, 'a relay that answered nothing usable');
  assert.equal(refusesBlankPage({ kind: 'ok' }), false);
});
