'use strict';

// A FlareSolverr URL saved as http://user:pass@host:8191/v1 (a copy behind a basic-auth proxy): Node refuses to send a
// request to it and its message echoes the whole address, password included. That text must not reach the System Health
// row (served to every client on the network), nor the error a source shows and the error log keeps. No network: fetch
// is replaced, and the text below is what Node 24 really says (it refuses while building the request, before any
// connection).

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFlareSolverrCheck } = require('../../server/modules/system-health/solver-rows');
const { defaultPost } = require('../../server/modules/network/solver/transport');
const { createSolverPool } = require('../../server/modules/network/solver-pool');

const SECRET_URL = 'http://user:pa55word@nas.lan:8191/v1';
const NODE_TEXT = 'Request cannot be constructed from a URL that includes credentials: http://user:pa55word@nas.lan:8191/';

const credentialsRefusal = () => new TypeError(NODE_TEXT);
const leaks = (value) => /pa55word|user:|nas\.lan|:\/\//.test(value);

function stubFetch(t, impl) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => { globalThis.fetch = real; });
}

test('the FlareSolverr row does not repeat the address Node echoes, and still says what went wrong', async (t) => {
  stubFetch(t, async () => { throw credentialsRefusal(); });
  const check = createFlareSolverrCheck({ getFlaresolverrUrl: async () => SECRET_URL, isFlaresolverrManaged: () => false, timeoutMs: 1000 });
  const row = await check();
  assert.equal(row.ok, false);
  assert.match(row.error, /^Request cannot be constructed from a URL that includes credentials/);
  assert.ok(!leaks(JSON.stringify(row)), row.error);
});

test('the row keeps the words of every other failure', async (t) => {
  for (const message of ['fetch failed', 'The operation was aborted due to timeout']) {
    stubFetch(t, async () => { throw new TypeError(message); });
    const check = createFlareSolverrCheck({ getFlaresolverrUrl: async () => 'http://nas.lan:8191/v1', isFlaresolverrManaged: () => false, timeoutMs: 1000 });
    assert.equal((await check()).error, message);
  }
});

test('the error a caller gets from the transport has no address in its message or its stack, and is the same error', async (t) => {
  const refusal = credentialsRefusal();
  stubFetch(t, async () => { throw refusal; });
  await assert.rejects(defaultPost(SECRET_URL, { cmd: 'sessions.list' }, { timeoutMs: 1000 }), (err) => {
    assert.equal(err, refusal, 'the raw error, not a copy: callers still look at its name and cause');
    assert.ok(err instanceof TypeError);
    assert.match(err.message, /^Request cannot be constructed from a URL that includes credentials/);
    assert.ok(!leaks(err.message), err.message);
    assert.ok(!leaks(String(err.stack)), err.stack);
    assert.match(String(err.stack), /^TypeError: Request cannot be constructed/);
    return true;
  });
});

test('an error without an address is passed on untouched', async (t) => {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8191'), { code: 'ECONNREFUSED' });
  const refused = new TypeError('fetch failed', { cause });
  const stackBefore = refused.stack;
  stubFetch(t, async () => { throw refused; });
  await assert.rejects(defaultPost('http://127.0.0.1:8191/v1', {}, { timeoutMs: 1000 }), (err) => err === refused && err.message === 'fetch failed' && err.stack === stackBefore && err.cause === cause);
});

test('a call through the real pool fails without the address in the error the caller sees', async (t) => {
  stubFetch(t, async () => { throw credentialsRefusal(); });
  const pool = createSolverPool({ log: () => {}, warn: () => {}, recordError: async () => {} });
  t.after(() => pool.shutdown({ timeoutMs: 50 }));
  pool.applySettings({ enabled: true, disabledBy: null, maxSessions: 1, idleMinutes: 10 });
  await assert.rejects(pool.run({ url: 'https://cf-site.example/a', solverUrl: SECRET_URL }).promise, (err) => {
    assert.ok(!leaks(String(err && err.message)), err && err.message);
    assert.ok(!leaks(String(err && err.stack)), err && err.stack);
    return true;
  });
});
