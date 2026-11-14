'use strict';

// server/modules/network/solver/transport.js: the POST, and the shape of every
// command. The payload rules are the point (each one was a trap in FlareSolverr
// 3.5.2), so they are asserted on the exact objects that would be sent.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { defaultPost, statelessPayload, createTransport } = require('../../server/modules/network/solver/transport');

function makeTransport(answer = { httpStatus: 200, body: { status: 'ok' } }) {
  const sent = [];
  const post = async (solverUrl, payload, options) => {
    sent.push({ solverUrl, payload, timeoutMs: options.timeoutMs });
    if (typeof answer === 'function') return answer(payload);
    return answer;
  };
  return { sent, transport: createTransport({ post, cfg: POOL }) };
}

const confirmedSlot = (over = {}) => ({
  id: 'ss-1-a-1', status: 'idle', dead: false, confirmed: true, solverUrl: 'http://127.0.0.1:8191/v1', ...over,
});

test('the stateless payload is the legacy one: cookies and proxy only when there are any', () => {
  assert.deepEqual(statelessPayload('https://cf-site.example/', 35000, undefined, null), { cmd: 'request.get', url: 'https://cf-site.example/', maxTimeout: 35000 });
  assert.deepEqual(statelessPayload('u', 1, [], null), { cmd: 'request.get', url: 'u', maxTimeout: 1 });
  assert.deepEqual(statelessPayload('u', 1, 'not-an-array', null), { cmd: 'request.get', url: 'u', maxTimeout: 1 });
  const cookies = [{ name: 'a', value: 'b' }];
  const proxy = { url: 'http://127.0.0.1:3128' };
  const full = statelessPayload('u', 1, cookies, proxy);
  assert.deepEqual(full, { cmd: 'request.get', url: 'u', maxTimeout: 1, cookies, proxy });
  assert.deepEqual(Object.keys(full), ['cmd', 'url', 'maxTimeout', 'cookies', 'proxy'], 'the same key order as before the pool');
});

test('sessions.create is the only command that carries a proxy, and it carries nothing else', async () => {
  const { sent, transport } = makeTransport();
  await transport.createSession('http://s/v1', 'ss-9-x-2', { url: 'http://127.0.0.1:3128', username: 'u', password: 'p' });
  await transport.createSession('http://s/v1', 'ss-9-x-3', null);
  assert.deepEqual(sent[0].payload, { cmd: 'sessions.create', session: 'ss-9-x-2', proxy: { url: 'http://127.0.0.1:3128', username: 'u', password: 'p' } });
  assert.deepEqual(sent[1].payload, { cmd: 'sessions.create', session: 'ss-9-x-3' });
  assert.equal(sent[0].timeoutMs, POOL.sessionCreateTimeoutMs);
  assert.ok(sent.every((s) => !('session_ttl_minutes' in s.payload)), 'a ttl would drop the proxy on expiry');
});

test('list and destroy are bare commands with their own time limits', async () => {
  const { sent, transport } = makeTransport();
  await transport.listSessions('http://s/v1');
  await transport.destroySession('http://s/v1', 'ss-1-a-1');
  assert.deepEqual(sent.map((s) => s.payload), [{ cmd: 'sessions.list' }, { cmd: 'sessions.destroy', session: 'ss-1-a-1' }]);
  assert.deepEqual(sent.map((s) => s.timeoutMs), [POOL.sessionListTimeoutMs, POOL.sessionDestroyTimeoutMs]);
});

test('a request for a session carries the id, the page and the time, and never a proxy, a ttl or cookies', async () => {
  const { sent, transport } = makeTransport();
  const slot = confirmedSlot();
  const res = await transport.requestInSession(slot, 'https://cf-site.example/a', 35000, 40000);
  assert.deepEqual(res, { httpStatus: 200, body: { status: 'ok' } });
  assert.deepEqual(sent, [{
    solverUrl: slot.solverUrl,
    payload: { cmd: 'request.get', session: 'ss-1-a-1', url: 'https://cf-site.example/a', maxTimeout: 35000 },
    timeoutMs: 40000,
  }]);
});

test('a request is refused, and nothing is sent, for a session that is not safe to ask', async () => {
  const { sent, transport } = makeTransport();
  for (const unsafe of [
    confirmedSlot({ dead: true }),
    confirmedSlot({ status: 'closing' }),
    confirmedSlot({ id: null }),
    confirmedSlot({ confirmed: false }),
  ]) {
    assert.deepEqual(await transport.requestInSession(unsafe, 'https://cf-site.example/', 1, 1), { refused: true });
  }
  assert.deepEqual(sent, [], 'FlareSolverr would have created the unknown id without the proxy');
  // 'busy', 'resetting' and 'opening' (confirmed) are fine: the job holds the slot.
  for (const status of ['busy', 'resetting', 'opening']) {
    assert.deepEqual((await transport.requestInSession(confirmedSlot({ status }), 'u', 1, 1)).httpStatus, 200);
  }
});

test('a one-off request has the abort grace added to its time limit', async () => {
  const { sent, transport } = makeTransport();
  await transport.requestStateless('http://s/v1', 'https://cf-site.example/', 35000, [{ name: 'c', value: 'v' }], { url: 'http://127.0.0.1:3128' });
  assert.equal(sent[0].timeoutMs, 35000 + POOL.requestAbortGraceMs);
  assert.deepEqual(sent[0].payload, {
    cmd: 'request.get', url: 'https://cf-site.example/', maxTimeout: 35000, cookies: [{ name: 'c', value: 'v' }], proxy: { url: 'http://127.0.0.1:3128' },
  });
});

// "A request.get is only ever sent through requestInSession's confirmed-session guard" holds by construction:
// the object the pool's parts receive has no method that sends a payload of the caller's choosing.
test('the transport offers the named commands and nothing that sends an arbitrary payload', () => {
  const { transport } = makeTransport();
  assert.deepEqual(Object.keys(transport).sort(), ['createSession', 'destroySession', 'listSessions', 'requestInSession', 'requestStateless']);
  assert.equal(typeof transport.call, 'undefined');
});

test('a command never throws: a failed request is { transport } holding the very same error', async () => {
  const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
  const { transport } = makeTransport(() => { throw boom; });
  for (const res of [
    await transport.listSessions('http://s/v1'),
    await transport.destroySession('http://s/v1', 'ss-1-a-1'),
    await transport.createSession('http://s/v1', 'ss-1-a-2', null),
    await transport.requestStateless('http://s/v1', 'https://cf-site.example/', 1, undefined, null),
    await transport.requestInSession(confirmedSlot(), 'https://cf-site.example/', 1, 1),
  ]) {
    assert.equal(res.transport, boom);
    assert.equal('httpStatus' in res, false);
  }
});

test('an answer is reduced to a whole HTTP status and a plain-object body', async () => {
  const cases = [
    [{ httpStatus: 500, body: { status: 'error' } }, { httpStatus: 500, body: { status: 'error' } }],
    [{ httpStatus: '200', body: [] }, { httpStatus: 0, body: null }],
    [{ httpStatus: 200, body: 'text' }, { httpStatus: 200, body: null }],
    [null, { httpStatus: 0, body: null }],
    [{}, { httpStatus: 0, body: null }],
  ];
  for (const [answer, expected] of cases) {
    const { transport } = makeTransport(answer);
    assert.deepEqual(await transport.listSessions('http://s/v1'), expected, JSON.stringify(answer));
  }
});

test('defaultPost resolves for any HTTP status, reads fetch at call time and keeps the raw error', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const calls = [];
  const respond = (status, text) => async (url, init) => {
    calls.push({ url, init });
    return { status, text: async () => text };
  };

  globalThis.fetch = respond(500, '{"status":"error","message":"boom"}');
  assert.deepEqual(await defaultPost('http://s/v1', { cmd: 'x' }, { timeoutMs: 1000 }), { httpStatus: 500, body: { status: 'error', message: 'boom' } });
  assert.equal(calls[0].url, 'http://s/v1');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.body, '{"cmd":"x"}');
  assert.ok(calls[0].init.signal instanceof AbortSignal);

  globalThis.fetch = respond(502, '<html>bad gateway</html>');
  assert.deepEqual(await defaultPost('http://s/v1', {}, { timeoutMs: 1000 }), { httpStatus: 502, body: null });
  globalThis.fetch = respond(200, '[1,2]');
  assert.deepEqual(await defaultPost('http://s/v1', {}, { timeoutMs: 1000 }), { httpStatus: 200, body: null }, 'an array is not a FlareSolverr answer');

  const refused = new TypeError('fetch failed');
  globalThis.fetch = async () => { throw refused; };
  await assert.rejects(defaultPost('http://s/v1', {}, { timeoutMs: 1000 }), (err) => err === refused);
});
