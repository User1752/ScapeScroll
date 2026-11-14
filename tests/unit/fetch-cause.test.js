'use strict';

// "fetch failed" with no reason (server/modules/network/fetch-cause.js): the reason is added to the message of the same error, and
// nothing else about a call changes. A fake `fetch` on a fake target, so nothing here touches the real global or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { installFetchCause, reasonOf } = require('../../server/modules/network/fetch-cause');

const failure = (cause) => new TypeError('fetch failed', cause === undefined ? undefined : { cause });
const targetThatRejects = (err) => ({ fetch: async () => { throw err; } });

test('the code of the cause is added to the message, and it is the same error object with its cause intact', async () => {
  const err = failure(Object.assign(new Error('connect ETIMEDOUT 203.0.113.9:443'), { code: 'ETIMEDOUT' }));
  const target = targetThatRejects(err);
  assert.equal(installFetchCause(target), true);
  await assert.rejects(target.fetch('https://site.example/'), (caught) => caught === err && caught.message === 'fetch failed (ETIMEDOUT)' && caught.cause.code === 'ETIMEDOUT');
  assert.ok(!err.message.includes('203.0.113.9'), 'a code, never an address');
});

test('a failure from trying several addresses (an AggregateError) gives the code of the first that has one', () => {
  const cause = Object.assign(new AggregateError([new Error('no code'), Object.assign(new Error('x'), { code: 'ENETUNREACH' })], 'all failed'), { code: undefined });
  assert.equal(reasonOf(failure(cause)), 'ENETUNREACH');
  assert.equal(reasonOf(failure(Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))), 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(reasonOf(failure(Object.assign(new Error('x'), { name: 'SomeError' }))), 'SomeError', 'the name when there is no code');
});

test('nothing to add, nothing changed: no cause, a cause with nothing to say, a message that is not "fetch failed", another kind of error', async () => {
  for (const err of [failure(), failure({}), failure('text'), new TypeError('Failed to parse URL'), Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }), Object.assign(new Error('aborted'), { name: 'TimeoutError' })]) {
    const before = err.message;
    const target = targetThatRejects(err);
    installFetchCause(target);
    await assert.rejects(target.fetch('x'), (caught) => caught === err && caught.message === before);
  }
});

test('a call that succeeds gets its response untouched, with the arguments it was given', async () => {
  const seen = [];
  const response = { status: 200 };
  const target = { fetch: async (...args) => { seen.push(args); return response; } };
  installFetchCause(target);
  assert.equal(await target.fetch('https://site.example/', { method: 'HEAD' }), response);
  assert.deepEqual(seen, [['https://site.example/', { method: 'HEAD' }]]);
});

test('installing twice wraps once, and a target with no fetch is left alone', async () => {
  const err = failure({ code: 'ECONNRESET' });
  const target = targetThatRejects(err);
  assert.equal(installFetchCause(target), true);
  const wrapper = target.fetch;
  assert.equal(installFetchCause(target), false);
  assert.equal(target.fetch, wrapper);
  await assert.rejects(target.fetch('x'), { message: 'fetch failed (ECONNRESET)' });
  assert.equal(installFetchCause({}), false);
});

test('an error that cannot be changed keeps its words and is still thrown', async () => {
  const err = Object.freeze(failure({ code: 'ETIMEDOUT' }));
  const target = targetThatRejects(err);
  installFetchCause(target);
  await assert.rejects(target.fetch('x'), (caught) => caught === err && caught.message === 'fetch failed');
});

test('the server installs it before anything else asks the network for anything', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const install = source.indexOf('installFetchCause()');
  assert.ok(install > 0, 'server.js calls installFetchCause()');
  assert.ok(install < source.indexOf("require('./server/modules/common/startup-guard')"), 'before the first of the app\'s own modules is loaded');
});
