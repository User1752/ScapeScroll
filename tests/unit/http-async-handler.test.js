'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const errorLogger = require('../../server/modules/error-logger');
const { createAsyncHandler } = require('../../server/modules/http/async-handler');

// A thrown 500 below makes createAsyncHandler call recordError(); point it at
// a throwaway dir so it can never write into the real data/error-log.json.
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-test-'));
errorLogger.configure(logDir);
process.on('exit', () => {
  try { fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function createMockRes() {
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('createAsyncHandler returns 400 and message for expected errors', async () => {
  const wrap = createAsyncHandler('TEST');
  const handler = wrap(async () => {
    const err = new Error('Bad request');
    err.statusCode = 400;
    err.expected = true;
    throw err;
  });

  const req = { method: 'GET', originalUrl: '/x', params: {}, body: {} };
  const res = createMockRes();

  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await handler(req, res, () => {});
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(res.statusCode, 400);
  assert.deepStrictEqual(res.body, { ok: false, error: 'Bad request' });
});

test('a failed request logs its body with the credential-shaped fields hidden', async () => {
  const handler = createAsyncHandler('TEST')(async () => {
    const err = new Error('Bad request');
    err.statusCode = 400;
    throw err;
  });
  const req = {
    method: 'POST',
    originalUrl: '/api/settings',
    params: {},
    body: { accessPassword: 'hunter2', proxyPassword: 'p', comicVineApiKey: 'k', sessionToken: 't', Cookie: 'c', authorization: 'Bearer x', theme: 'dark', pageSize: 20 },
  };
  const logged = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { logged.push(args); };
  try {
    await handler(req, createMockRes(), () => {});
  } finally {
    console.warn = originalWarn;
  }

  const body = logged[0][1].body;
  for (const key of ['accessPassword', 'proxyPassword', 'comicVineApiKey', 'sessionToken', 'Cookie', 'authorization']) {
    assert.equal(body[key], '[redacted]', key);
  }
  assert.equal(body.theme, 'dark', 'an ordinary field is logged as it is');
  assert.equal(body.pageSize, 20);
  assert.equal(req.body.accessPassword, 'hunter2', 'the request itself is not changed');
  assert.doesNotMatch(JSON.stringify(logged), /hunter2/);
});

test('createAsyncHandler returns fallback status/message', async () => {
  const handler = createAsyncHandler('TEST');
  const req = {};
  const res = {
    status: function (code) { this.statusCode = code; return this; },
    json: function (data) { this.body = data; }
  };

  const failingRoute = async () => {
    const err = new Error('boom');
    throw err;
  };

  await handler(failingRoute)(req, res, () => {});

  assert.strictEqual(res.statusCode, 500);
  assert.deepStrictEqual(res.body, { ok: false, error: 'boom' });
});
