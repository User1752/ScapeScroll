'use strict';

// The solver pool's tests stand on the fake FlareSolverr, so the fake itself is
// tested: every behaviour of FlareSolverr 3.5.2 that the pool is designed around
// must be reproduced exactly, or a green pool test proves nothing. Loopback only.
// This file: the server, sessions and the traps around them (proxy, ttl, overlapping calls, cookies) and time.
// Scripting, process control, hang and drop, and the log are in fake-flaresolverr-control.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { MESSAGES, pageHtml } = require('../helpers/fake-flaresolverr');
const { A, B, OTHER, PROXY, start, call, create, get } = require('../helpers/fake-client');

// ── The server ──────────────────────────────────────────────────────────────

test('the root answers like FlareSolverr and every reply carries the version', async (t) => {
  const fake = await start(t, { version: '3.5.2' });
  assert.match(fake.url, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.match(fake.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const root = await (await fetch(fake.baseUrl)).json();
  assert.deepEqual(root, { msg: 'FlareSolverr is ready!', version: '3.5.2', userAgent: fake.userAgent });

  const answer = await create(fake, 's1');
  assert.equal(answer.body.version, '3.5.2');
  assert.equal(typeof answer.body.startTimestamp, 'number');
  assert.ok(answer.body.endTimestamp >= answer.body.startTimestamp);

  const other = await start(t, { version: '9.9.9' });
  assert.equal((await (await fetch(other.baseUrl)).json()).version, '9.9.9');
});

test('a malformed call is answered the way FlareSolverr does', async (t) => {
  const fake = await start(t);
  const noCmd = await call(fake, {});
  assert.equal(noCmd.status, 500);
  assert.deepEqual([noCmd.body.status, noCmd.body.message], ['error', "Error: Request parameter 'cmd' is mandatory."]);

  const unknown = await call(fake, { cmd: 'sessions.explode' });
  assert.equal(unknown.status, 500);
  assert.equal(unknown.body.message, `Error: ${MESSAGES.invalidCmd('sessions.explode')}`);

  const noUrl = await call(fake, { cmd: 'request.get' });
  assert.equal(noUrl.status, 500);
  assert.match(noUrl.body.message, /^Error: Request parameter 'url' is mandatory in 'request.get' command\.$/);

  const bad = await fetch(fake.url, { method: 'POST', body: '{nope' });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${fake.baseUrl}nothing-here`)).status, 404);
});

// ── Sessions ────────────────────────────────────────────────────────────────

test('sessions.create makes a session with its proxy; list shows it; create again changes nothing', async (t) => {
  const fake = await start(t);
  const first = await create(fake, 's1', PROXY);
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.status, first.body.message, first.body.session], ['ok', 'Session created successfully.', 's1']);
  assert.deepEqual(fake.sessions.get('s1').proxy, PROXY);

  const list = await call(fake, { cmd: 'sessions.list' });
  assert.deepEqual([list.body.status, list.body.message, list.body.sessions], ['ok', '', ['s1']]);

  // Idempotent, and the proxy sent the second time is NOT applied.
  const again = await create(fake, 's1', { url: 'http://127.0.0.1:5555' });
  assert.equal(again.body.message, 'Session already exists.');
  assert.deepEqual(fake.sessions.get('s1').proxy, PROXY, 'the first proxy is still the one in force');
  const entry = fake.log.at(-1);
  assert.equal(entry.existed, true);
  assert.deepEqual(entry.usedProxy, PROXY);
  assert.deepEqual(entry.proxy, { url: 'http://127.0.0.1:5555' }, 'the log keeps what the caller sent');
  assert.equal(fake.launches, 1, 'no second browser');
});

test('a create without an id gets one made up', async (t) => {
  const fake = await start(t);
  const answer = await call(fake, { cmd: 'sessions.create' });
  assert.match(answer.body.session, /^fake-session-\d+$/);
  assert.ok(fake.sessions.has(answer.body.session));
});

test('sessions.destroy removes it, and an id it does not know is an error', async (t) => {
  const fake = await start(t);
  await create(fake, 's1');
  const gone = await call(fake, { cmd: 'sessions.destroy', session: 's1' });
  assert.equal(gone.status, 200);
  assert.deepEqual([gone.body.status, gone.body.message], ['ok', 'The session has been removed.']);
  assert.equal(fake.sessions.size, 0);

  const missing = await call(fake, { cmd: 'sessions.destroy', session: 's1' });
  assert.equal(missing.status, 500);
  assert.deepEqual([missing.body.status, missing.body.message], ['error', "Error: The session doesn't exist."]);
  const none = await call(fake, { cmd: 'sessions.destroy' });
  assert.equal(none.body.message, "Error: The session doesn't exist.");
});

test('a session is listed only once its browser has launched', async (t) => {
  // The launch is long enough that a loaded machine cannot let it finish before the list below is asked.
  const fake = await start(t, { launchMs: 800 });
  const creating = create(fake, 's1');
  await fake.waitFor((e) => e.cmd === 'sessions.create');
  assert.deepEqual((await call(fake, { cmd: 'sessions.list' })).body.sessions, [], 'still launching');
  await creating;
  assert.deepEqual((await call(fake, { cmd: 'sessions.list' })).body.sessions, ['s1']);
});

// ── request.get and the traps ───────────────────────────────────────────────

test('request.get on a session returns the page, the cookies and the user agent', async (t) => {
  const fake = await start(t);
  await create(fake, 's1');
  const answer = await get(fake, A, { session: 's1' });
  assert.equal(answer.status, 200);
  assert.equal(answer.body.status, 'ok');
  const { solution } = answer.body;
  assert.equal(solution.url, A);
  assert.equal(solution.status, 200);
  assert.deepEqual(solution.headers, {});
  assert.equal(solution.response, pageHtml(A));
  assert.equal(solution.userAgent, fake.userAgent);
  assert.deepEqual(solution.cookies.map((c) => [c.name, c.value, c.domain]), [['cf_clearance', 'clearance-cf-site.example', 'cf-site.example']]);
});

test('TRAP: request.get on an unknown session id quietly creates it, without the proxy', async (t) => {
  const fake = await start(t);
  const answer = await get(fake, A, { session: 'never-created', proxy: PROXY });
  assert.equal(answer.body.status, 'ok', 'and nothing in the answer says it happened');
  assert.deepEqual(fake.lazyCreated, ['never-created']);
  const entry = fake.log.at(-1);
  assert.equal(entry.lazy, true);
  assert.equal(entry.launched, true);
  assert.equal(entry.usedProxy, null, 'the proxy the caller sent was not used');
  assert.deepEqual(entry.proxy, PROXY);
  assert.deepEqual((await call(fake, { cmd: 'sessions.list' })).body.sessions, ['never-created']);
  assert.equal(fake.sessions.get('never-created').proxy, null);
  // And a later create does not fix it.
  assert.equal((await create(fake, 'never-created', PROXY)).body.message, 'Session already exists.');
  assert.equal(fake.sessions.get('never-created').proxy, null);
});

test('TRAP: request.get ignores a proxy for a session that exists', async (t) => {
  const fake = await start(t);
  await create(fake, 's1', PROXY);
  await get(fake, A, { session: 's1', proxy: { url: 'http://127.0.0.1:9999' } });
  const entry = fake.log.at(-1);
  assert.deepEqual(entry.usedProxy, PROXY);
  assert.deepEqual(entry.proxy, { url: 'http://127.0.0.1:9999' });
  assert.deepEqual(fake.lazyCreated, []);
  assert.equal(fake.launches, 1);
});

test('TRAP: session_ttl_minutes older than the session recreates it without the proxy', async (t) => {
  const fake = await start(t);
  await create(fake, 's1', PROXY);
  await get(fake, A, { session: 's1', session_ttl_minutes: 10 });
  assert.deepEqual(fake.ttlDropped, [], 'young enough: kept');
  assert.deepEqual(fake.sessions.get('s1').proxy, PROXY);

  assert.equal(fake.ageSession('s1', 11 * 60_000), true);
  await get(fake, A, { session: 's1', session_ttl_minutes: 10 });
  assert.deepEqual(fake.ttlDropped, ['s1']);
  const entry = fake.log.at(-1);
  assert.equal(entry.ttlRecreated, true);
  assert.equal(entry.usedProxy, null);
  assert.equal(fake.sessions.get('s1').proxy, null, 'the proxy is gone for good');
  assert.equal(fake.launches, 2);

  // Without a ttl in the call, age does not matter.
  fake.ageSession('s1', 999 * 60_000);
  await get(fake, A, { session: 's1' });
  assert.deepEqual(fake.ttlDropped, ['s1']);
  assert.equal(fake.ageSession('nope', 1), false);
});

test('TRAP: overlapping calls on one session collide, and each gets the page of the LAST navigation', async (t) => {
  const fake = await start(t, { latencyMs: 60 });
  await create(fake, 's1');
  const first = get(fake, A, { session: 's1' });
  await fake.waitFor((e) => e.url === A);
  const second = get(fake, B, { session: 's1' });
  const [one, two] = await Promise.all([first, second]);

  assert.equal(fake.collisions, 1);
  assert.equal(one.body.solution.response, pageHtml(B), 'the first call got the second call\'s page');
  assert.equal(one.body.solution.url, B);
  assert.equal(two.body.solution.response, pageHtml(B));
  const entries = fake.log.filter((e) => e.cmd === 'request.get');
  assert.deepEqual(entries.map((e) => e.collided), [true, true]);
  assert.ok(fake.peakInFlight >= 2);
  assert.equal(fake.inFlight, 0);
});

test('calls that do not overlap, or sit on different sessions, never collide', async (t) => {
  const fake = await start(t, { latencyMs: 40 });
  await create(fake, 's1');
  await create(fake, 's2');
  const [one, two] = await Promise.all([get(fake, A, { session: 's1' }), get(fake, B, { session: 's2' })]);
  assert.equal(one.body.solution.response, pageHtml(A));
  assert.equal(two.body.solution.response, pageHtml(B));
  await get(fake, A, { session: 's1' });
  await get(fake, B, { session: 's1' });
  assert.equal(fake.collisions, 0);
});

test('TRAP: a call with no session launches a browser of its own, and its cookies do not outlive it', async (t) => {
  const fake = await start(t);
  const stateless = await get(fake, A, { proxy: PROXY, cookies: [{ name: 'login', value: 'secret', domain: 'cf-site.example' }] });
  assert.equal(stateless.body.status, 'ok');
  assert.ok(stateless.body.solution.cookies.some((c) => c.name === 'login'), 'it was in that browser while it lived');
  const entry = fake.log.at(-1);
  assert.deepEqual([entry.stateless, entry.launched, entry.hadCookies], [true, true, true]);
  assert.deepEqual(entry.usedProxy, PROXY, 'a throwaway browser does take the proxy');
  assert.equal(fake.sessions.size, 0);
  assert.equal(fake.launches, 1);

  await create(fake, 's1');
  const later = await get(fake, A, { session: 's1' });
  assert.equal(later.body.solution.cookies.some((c) => c.name === 'login'), false);
  await get(fake, A);
  assert.equal(fake.launches, 3, 'every stateless call starts a browser');
});

test('TRAP: cookies sent with a SESSION call stay in that session for every later call', async (t) => {
  const fake = await start(t);
  await create(fake, 's1');
  await get(fake, A, { session: 's1', cookies: [{ name: 'login', value: 'secret', domain: 'cf-site.example' }] });
  const later = await get(fake, B, { session: 's1' });
  assert.ok(later.body.solution.cookies.some((c) => c.name === 'login' && c.value === 'secret'), 'an anonymous caller now carries the login');
  assert.equal(fake.log.at(-1).hadCookies, false);

  await create(fake, 's2');
  const clean = await get(fake, A, { session: 's2' });
  assert.equal(clean.body.solution.cookies.some((c) => c.name === 'login'), false, 'another session is another browser');
});

test('cookies persist in a session across calls, and only a site\'s own cookies come back for it', async (t) => {
  const fake = await start(t);
  fake.page(A, { cookies: [{ name: 'dle', value: '1' }] });
  fake.page(B, { cookies: [] });
  await create(fake, 's1');
  await get(fake, A, { session: 's1' });
  const second = await get(fake, B, { session: 's1' });
  assert.deepEqual(second.body.solution.cookies.map((c) => c.name), ['dle'], 'set by A, still in the jar when B answers');
  const elsewhere = await get(fake, OTHER, { session: 's1' });
  assert.deepEqual(elsewhere.body.solution.cookies.map((c) => c.domain), ['other-site.example'], 'not cf-site.example\'s');
});

test('TRAP: sessions.destroy takes effect when it arrives, so the id is free again while the reply is still on its way', async (t) => {
  const fake = await start(t);
  await create(fake, 's1', PROXY);
  fake.command('sessions.destroy', { delayMs: 150 });
  const destroying = call(fake, { cmd: 'sessions.destroy', session: 's1' });
  await fake.waitFor((e) => e.cmd === 'sessions.destroy');
  assert.equal(fake.sessions.has('s1'), false, 'already gone');
  const racing = await get(fake, A, { session: 's1' });
  assert.equal(racing.body.status, 'ok');
  assert.deepEqual(fake.lazyCreated, ['s1'], 'and a call for it made a new, unproxied session');
  assert.equal(fake.sessions.get('s1').proxy, null);
  assert.equal((await destroying).body.status, 'ok');
});

test('a destroy under a running request kills that request', async (t) => {
  const fake = await start(t);
  await create(fake, 's1');
  fake.page(A, { delayMs: 120 });
  const running = get(fake, A, { session: 's1' });
  await fake.waitFor((e) => e.url === A);
  await call(fake, { cmd: 'sessions.destroy', session: 's1' });
  const answer = await running;
  assert.equal(answer.status, 500);
  assert.match(answer.body.message, /^Error: Error solving the challenge\. invalid session id/);
});

// ── Time ────────────────────────────────────────────────────────────────────

test('a navigation longer than maxTimeout is answered with the timeout text, and the session stays', async (t) => {
  const fake = await start(t);
  await create(fake, 's1');
  fake.page(A, { delayMs: 400 });
  const started = Date.now();
  const answer = await get(fake, A, { session: 's1', maxTimeout: 60 });
  assert.ok(Date.now() - started < 300, 'cut at maxTimeout, not at the end of the page');
  assert.equal(answer.status, 500);
  assert.equal(answer.body.message, 'Error: Error solving the challenge. Timeout after 0.06 seconds.');
  assert.equal(fake.sessions.has('s1'), true);
  assert.equal(MESSAGES.timeout(35000), 'Timeout after 35.0 seconds.');
  assert.equal(MESSAGES.timeout(60000), 'Timeout after 60.0 seconds.');
  assert.match(MESSAGES.timeout(35000), /Timeout after [\d.]+ seconds/i);
});

test('a missing or tiny maxTimeout means 60 seconds, as in FlareSolverr', async (t) => {
  const fake = await start(t);
  fake.page(A, { delayMs: 30 });
  assert.equal((await get(fake, A, { maxTimeout: undefined })).body.status, 'ok');
  assert.equal((await get(fake, A, { maxTimeout: 0 })).body.status, 'ok');
  assert.equal(fake.log.at(-1).maxTimeout, 0, 'the log keeps what was sent');
});

test('launching a browser is not part of the navigation clock', async (t) => {
  const fake = await start(t, { launchMs: 120 });
  const answer = await get(fake, A, { maxTimeout: 50 });
  assert.equal(answer.body.status, 'ok');
});

test('launches that start while another is still launching are counted', async (t) => {
  const fake = await start(t, { launchMs: 80 });
  await Promise.all([create(fake, 's1'), create(fake, 's2'), get(fake, A)]);
  assert.equal(fake.launches, 3);
  assert.equal(fake.launchOverlaps, 2);

  const serial = await start(t, { launchMs: 40 });
  await create(serial, 's1');
  await create(serial, 's2');
  assert.equal(serial.launchOverlaps, 0);
  assert.ok(serial.log.every((e) => e.launched));
  const [x, y] = serial.log;
  assert.ok(y.t >= x.endedAt, 'the log has the intervals to check non-overlap with');
});
