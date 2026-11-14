'use strict';

// The second half of the tests of the fake FlareSolverr (fake-flaresolverr.test.js has the first): what a test can
// script (errors, dead drivers, raw bodies, hang, drop), the process (restart, stop, start) and the log. The pool's
// tests lean on every one of these, so each is pinned here. Loopback only.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { MESSAGES, pageHtml, BLANK_HTML } = require('../helpers/fake-flaresolverr');
const { A, B, OTHER, PROXY, start, call, create, get, sleep } = require('../helpers/fake-client');

// ── Scripting ───────────────────────────────────────────────────────────────

test('an error is HTTP 500 with the inner text wrapped and newlines escaped, and changes no state', async (t) => {
  const fake = await start(t);
  await create(fake, 's1');
  fake.page(A, { errorMessage: MESSAGES.blocked });
  const blocked = await get(fake, A, { session: 's1' });
  assert.equal(blocked.status, 500);
  assert.deepEqual([blocked.body.status, blocked.body.message], ['error', `Error: Error solving the challenge. ${MESSAGES.blocked}`]);
  assert.equal(blocked.body.solution, undefined);

  fake.page(B, { errorMessage: 'line one\nline two' });
  assert.equal((await get(fake, B, { session: 's1' })).body.message, 'Error: Error solving the challenge. line one\\nline two');

  fake.command('sessions.create', { errorMessage: MESSAGES.launchConflict });
  const refused = await create(fake, 's2');
  assert.equal(refused.status, 500);
  assert.equal(refused.body.message, `Error: ${MESSAGES.launchConflict}`);
  assert.equal(fake.sessions.has('s2'), false, 'a failed create makes no session');
  assert.equal(fake.log.at(-1).error, MESSAGES.launchConflict);
});

test('a dead driver keeps failing until the session is destroyed, and its destroy errors although it removes it', async (t) => {
  const fake = await start(t);
  await create(fake, 's1');
  fake.page(A, { errorMessage: MESSAGES.driverDead, kill: true, times: 1 });
  const first = await get(fake, A, { session: 's1' });
  assert.match(first.body.message, /invalid session id/);
  const second = await get(fake, B, { session: 's1' });
  assert.equal(second.status, 500, 'the rule was for one call, but the driver stays dead');
  assert.match(second.body.message, /invalid session id/);
  assert.match((await get(fake, B, { session: 's1' })).body.message, /invalid session id: session deleted as the browser has closed the connection\\nfrom disconnected/);

  const destroy = await call(fake, { cmd: 'sessions.destroy', session: 's1' });
  assert.equal(destroy.status, 500);
  assert.match(destroy.body.message, /invalid session id/);
  assert.equal(fake.sessions.has('s1'), false, 'removed all the same');
  assert.equal((await get(fake, B, { session: 's1' })).body.status, 'ok', 'a fresh browser under the same id');
});

test('rules: newest wins, times expires them, remove() and clearRules() drop them, hits count', async (t) => {
  const fake = await start(t);
  const general = fake.page(/cf-site\.example/, { html: '<p>regex</p>' });
  const specific = fake.page(A, { html: '<p>exact</p>' });
  assert.equal((await get(fake, A)).body.solution.response, '<p>exact</p>');
  assert.equal((await get(fake, B)).body.solution.response, '<p>regex</p>');
  assert.equal((await get(fake, OTHER)).body.solution.response, pageHtml(OTHER));

  specific.remove();
  specific.remove();
  assert.equal((await get(fake, A)).body.solution.response, '<p>regex</p>');
  assert.equal(specific.hits, 1);
  assert.equal(general.hits, 2);

  const once = fake.page(A, { errorMessage: 'boom', times: 2 });
  assert.equal((await get(fake, A)).status, 500);
  assert.equal((await get(fake, A)).status, 500);
  assert.equal((await get(fake, A)).status, 200, 'expired after two');
  assert.equal(once.hits, 2);

  fake.clearRules();
  assert.equal((await get(fake, A)).body.solution.response, pageHtml(A));

  const command = fake.command('request.get', { html: '<p>any</p>' });
  assert.equal((await get(fake, OTHER)).body.solution.response, '<p>any</p>');
  command.remove();
});

test('a rule with a typo or an unknown command is refused when it is written', async (t) => {
  const fake = await start(t);
  assert.throws(() => fake.page(A, { delayMS: 5 }), /unknown outcome field 'delayMS'/);
  assert.throws(() => fake.command('sessions.explode', {}), /no command 'sessions.explode'/);
  assert.throws(() => fake.page(A, { kill: true }), /kill/);
  assert.throws(() => fake.command('sessions.create', { errorMessage: 'x', kill: true }), /kill/);
});

test('about:blank and data: answer an empty page with no cookies, and can be scripted to fail', async (t) => {
  const fake = await start(t);
  await create(fake, 's1');
  await get(fake, A, { session: 's1' });
  for (const url of ['about:blank', 'data:text/html,']) {
    const answer = await get(fake, url, { session: 's1', maxTimeout: 10000 });
    assert.equal(answer.body.solution.response, BLANK_HTML, url);
    assert.deepEqual(answer.body.solution.cookies, [], url);
    assert.equal(answer.body.solution.url, url);
  }
  fake.page('about:blank', { errorMessage: 'unknown error: unsupported scheme', times: 1 });
  assert.equal((await get(fake, 'about:blank', { session: 's1' })).status, 500);
  assert.equal((await get(fake, 'about:blank', { session: 's1' })).status, 200);
});

test('rawBody and httpStatus replace the reply, not the effect', async (t) => {
  const fake = await start(t);
  fake.command('sessions.create', { httpStatus: 502, rawBody: '<html>Bad Gateway</html>' });
  const relay = await create(fake, 's1');
  assert.equal(relay.status, 502);
  assert.equal(relay.body, null);
  assert.equal(relay.text, '<html>Bad Gateway</html>');
  assert.equal(fake.sessions.has('s1'), true, 'the session was made, the answer was lost');
  assert.equal(fake.log.at(-1).outcome, 'raw');

  fake.page(A, { httpStatus: 503 });
  const odd = await get(fake, A, { session: 's1' });
  assert.equal(odd.status, 503);
  assert.equal(odd.body.status, 'ok');
});

test('drop closes the connection without an answer', async (t) => {
  const fake = await start(t);
  fake.command('sessions.list', { drop: true, times: 1 });
  await assert.rejects(call(fake, { cmd: 'sessions.list' }), (err) => err instanceof TypeError && /fetch failed/.test(err.message));
  assert.equal(fake.log.at(-1).outcome, 'drop');
  assert.equal(fake.log.at(-1).aborted, false, 'the fake closed it, not the client');
  assert.equal((await call(fake, { cmd: 'sessions.list' })).status, 200);
});

test('hang never answers until the fake restarts; the client\'s own abort still works', async (t) => {
  const fake = await start(t);
  fake.page(A, { hang: true });
  // The client gives up once the call has ARRIVED, not after a guess of how long that takes on a loaded machine.
  const client = new AbortController();
  const pending = call(fake, { cmd: 'request.get', url: A }, { signal: client.signal });
  await fake.waitFor((e) => e.url === A);
  client.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  const entry = await fake.waitFor((e) => e.aborted);
  assert.equal(entry.endedAt, null);
  assert.equal(fake.inFlight, 1, 'a wedged FlareSolverr is still busy with it');
});

test('restart() frees a hung call and counts it as cancelled', async (t) => {
  const fake = await start(t);
  fake.page(A, { hang: true });
  const hung = call(fake, { cmd: 'request.get', url: A }).catch((err) => err);
  await fake.waitFor((e) => e.url === A);
  assert.equal(fake.inFlight, 1);
  await fake.restart();
  const err = await hung;
  assert.ok(err instanceof TypeError, 'the connection was cut');
  assert.equal(fake.inFlight, 0);
  assert.equal(fake.log.at(-1).outcome, 'cancelled');
});

test('the client\'s abort is recorded, and the fake keeps working on the call like the real one', async (t) => {
  const fake = await start(t);
  await create(fake, 's1');
  fake.page(A, { delayMs: 400 });
  // The client gives up once the call has ARRIVED, with plenty of the 400 ms of solving still to go.
  const client = new AbortController();
  const pending = call(fake, { cmd: 'request.get', url: A, session: 's1' }, { signal: client.signal });
  await fake.waitFor((e) => e.url === A);
  client.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
  const entry = await fake.waitFor((e) => e.url === A && e.aborted);
  assert.equal(entry.endedAt, null, 'still being solved');
  assert.equal(fake.sessions.get('s1').inflight, 1, 'so the session is still busy');
  await fake.waitFor((e) => e.url === A && e.endedAt !== null && e.aborted);
  assert.equal(fake.sessions.get('s1').inflight, 0);
});

// ── Process ─────────────────────────────────────────────────────────────────

test('restart() is a new process: sessions gone, same port, rules and log kept', async (t) => {
  const fake = await start(t);
  await create(fake, 's1', PROXY);
  fake.page(A, { html: '<p>kept</p>' });
  const { port, url } = fake;
  const before = fake.log.length;
  await fake.restart();

  assert.equal(fake.sessions.size, 0);
  assert.deepEqual((await call(fake, { cmd: 'sessions.list' })).body.sessions, []);
  assert.equal(fake.port, port);
  assert.equal(fake.url, url);
  assert.ok(fake.log.length >= before, 'log kept');
  assert.equal((await get(fake, A)).body.solution.response, '<p>kept</p>', 'rules kept');
  // The trap the pool must avoid after a restart: an old id lazily comes back with no proxy.
  await get(fake, A, { session: 's1' });
  assert.deepEqual(fake.lazyCreated, ['s1']);
});

test('a call cut off by restart() does not touch the new process', async (t) => {
  const fake = await start(t, { launchMs: 100 });
  const creating = create(fake, 's1').catch((err) => err);
  await fake.waitFor((e) => e.cmd === 'sessions.create');
  await fake.restart();
  assert.ok((await creating) instanceof Error);
  await sleep(150);
  assert.equal(fake.sessions.size, 0, 'the browser that was launching never appears');
  assert.equal(fake.inFlight, 0);
});

test('stop() refuses connections, start() listens again on the same port, stop() is safe to repeat', async (t) => {
  const fake = await start(t);
  await create(fake, 's1');
  const { url } = fake;
  await fake.stop();
  await fake.stop();
  await assert.rejects(fetch(url, { method: 'POST', body: '{}' }), (err) => err instanceof TypeError && err.cause && err.cause.code === 'ECONNREFUSED');

  assert.equal(await fake.start(), fake);
  assert.equal(await fake.start(), fake, 'start() while running is harmless');
  assert.equal(fake.url, url);
  assert.deepEqual((await call(fake, { cmd: 'sessions.list' })).body.sessions, [], 'a stop is a new process too');
});

// stop() really gives the port back, and in a run of many test processes at once another one can take it before the test
// connects (a made-up "FlareSolverr is off" then answers). switchOff() is the same for everyone who reaches the fake with
// fetch, and the port stays held.
test('switchOff() refuses every fetch like a FlareSolverr that is not running, holds the port, and switchOn() is a new process on it', async (t) => {
  const fake = await start(t);
  const other = await start(t);
  await create(fake, 's1');
  const { url, baseUrl, port } = fake;
  const hung = call(fake, { cmd: 'request.get', url: A }).catch((err) => err);
  fake.page(A, { hang: true });
  await fake.waitFor((e) => e.url === A);

  await fake.switchOff();
  assert.ok((await hung) instanceof TypeError, 'the call in flight died with the process');
  for (const target of [url, baseUrl]) {
    await assert.rejects(fetch(target, { method: 'POST', body: '{}' }), (err) => {
      assert.ok(err instanceof TypeError);
      assert.equal(err.message, 'fetch failed');
      assert.equal(err.cause.code, 'ECONNREFUSED');
      assert.equal(err.cause.port, port);
      return true;
    });
  }
  assert.equal(fake.sessions.size, 0, 'sessions went with the process');
  assert.equal(fake.inFlight, 0);
  assert.deepEqual((await call(other, { cmd: 'sessions.list' })).body.sessions, [], 'another fake is not affected');

  // Nobody else can take the port while it is "off": that is the point.
  const rival = net.createServer();
  await assert.rejects(new Promise((resolve, reject) => { rival.once('error', reject); rival.listen(port, '127.0.0.1', resolve); }), (err) => err.code === 'EADDRINUSE');

  fake.switchOn();
  assert.equal(fake.url, url, 'the same address');
  assert.deepEqual((await call(fake, { cmd: 'sessions.list' })).body.sessions, [], 'a new process: no sessions');
  fake.switchOn(); // harmless when it is on
  assert.equal((await call(fake, { cmd: 'sessions.list' })).status, 200);
});

test('stop() ends a switched-off fake for good, and start() brings a stopped one back', async (t) => {
  const fake = await start(t);
  const { url } = fake;
  await fake.switchOff();
  await fake.stop();
  await assert.rejects(fetch(url, { method: 'POST', body: '{}' }), (err) => err.cause && err.cause.code === 'ECONNREFUSED');
  await fake.start();
  assert.equal((await call(fake, { cmd: 'sessions.list' })).status, 200);

  await fake.switchOff();
  await fake.start(); // start() on a switched-off fake switches it on
  assert.equal((await call(fake, { cmd: 'sessions.list' })).status, 200);
});

// ── Inspection ──────────────────────────────────────────────────────────────

test('the log keeps what was sent and when, in arrival order', async (t) => {
  const fake = await start(t, { latencyMs: 20 });
  const before = Date.now();
  await create(fake, 's1', PROXY);
  await get(fake, A, { session: 's1', maxTimeout: 1234, session_ttl_minutes: 7, cookies: [{ name: 'x', value: 'y' }] });
  const [make, nav] = fake.log;
  assert.deepEqual(make.seq, 1);
  assert.equal(nav.seq, 2);
  assert.ok(make.t >= before && make.endedAt >= make.t + 15);
  assert.ok(nav.t >= make.endedAt);
  assert.deepEqual([make.cmd, make.session, make.proxy], ['sessions.create', 's1', PROXY]);
  assert.deepEqual([nav.cmd, nav.session, nav.url, nav.maxTimeout, nav.ttl, nav.hadCookies], ['request.get', 's1', A, 1234, 7, true]);
  assert.deepEqual([nav.outcome, nav.httpStatus, nav.error], ['ok', 200, null]);
  fake.clearLog();
  assert.deepEqual(fake.log, []);
  await get(fake, A, { session: 's1' });
  assert.equal(fake.log[0].seq, 3, 'sequence numbers keep counting');
});

test('waitFor resolves for a call that already happened or one that comes later, and says so when none does', async (t) => {
  const fake = await start(t);
  await create(fake, 's1');
  assert.equal((await fake.waitFor((e) => e.cmd === 'sessions.create')).session, 's1');

  const waiting = fake.waitFor((e) => e.cmd === 'sessions.list');
  await call(fake, { cmd: 'sessions.list' });
  assert.equal((await waiting).cmd, 'sessions.list');

  const ended = fake.waitFor((e) => e.cmd === 'request.get' && e.endedAt !== null);
  await get(fake, A);
  assert.equal((await ended).outcome, 'ok');

  await assert.rejects(fake.waitFor((e) => e.cmd === 'never', { timeoutMs: 30 }), /saw no call matching .* within 30 ms/);
  await assert.rejects(fake.waitFor(() => { throw new Error('x'); }, { timeoutMs: 30 }), /within 30 ms/);
});

test('latency can be changed while it runs', async (t) => {
  const fake = await start(t);
  const fast = Date.now();
  await create(fake, 's1');
  const fastMs = Date.now() - fast;
  fake.latencyMs = 100;
  const slow = Date.now();
  await call(fake, { cmd: 'sessions.list' });
  const slowMs = Date.now() - slow;
  assert.ok(slowMs >= 90, `the slow call took ${slowMs} ms`);
  // Relative, not an absolute bound: on a busy machine the first call alone can take longer than 90 ms.
  assert.ok(fastMs < slowMs, `the fast call took ${fastMs} ms, the slow one ${slowMs} ms`);
});
