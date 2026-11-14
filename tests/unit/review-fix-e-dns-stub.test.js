'use strict';

// stubDns (tests/helpers/fetch-utils-rig.js) puts a fake resolver on dns.promises.lookup and the test's
// t.after hooks put things back. A test that stubs twice (rig() stubs once, and the test may stub again
// with answers of its own) must still end with the REAL resolver, whatever order the hooks run in:
// restoring "what was there when I stubbed" puts the first stub back for the rest of the process.

const test = require('node:test');
const assert = require('node:assert/strict');
const dnsPromises = require('node:dns').promises;

const { stubDns } = require('../helpers/fetch-utils-rig');

const realLookup = dnsPromises.lookup;
const PUBLIC = [{ address: '93.184.216.34', family: 4 }];
const INTERNAL = [{ address: '10.0.0.5', family: 4 }];

// A stand-in for the test context that keeps its hooks, so a test can run them in any order.
function fakeContext() {
  const hooks = [];
  return { hooks, after: (hook) => hooks.push(hook) };
}

const inOrder = (hooks) => hooks;
const reversed = (hooks) => [...hooks].reverse();
const release = (context, order = inOrder) => { for (const hook of order(context.hooks)) hook(); };

// Whatever the helper did, the next test starts from the real resolver.
function putRealBack() {
  dnsPromises.lookup = realLookup;
}

test('the stub answers a public address, a mapped address, or throws a mapped error', async () => {
  const context = fakeContext();
  const failure = Object.assign(new Error('lookup timed out'), { code: 'DNS_TIMEOUT' });
  stubDns(context, { 'internal.example': '10.0.0.5', 'slow.example': failure });
  try {
    assert.deepEqual(await dnsPromises.lookup('any.example'), PUBLIC);
    assert.deepEqual(await dnsPromises.lookup('internal.example'), INTERNAL);
    await assert.rejects(dnsPromises.lookup('slow.example'), { code: 'DNS_TIMEOUT' });
  } finally {
    release(context);
  }
  const restored = dnsPromises.lookup === realLookup;
  putRealBack();
  assert.ok(restored, 'the real resolver is back after one stub');
});

for (const [name, order] of [['in the order they were registered', inOrder], ['in reverse', reversed]]) {
  test(`two stubs in one test: the real resolver is back when the hooks run ${name}`, () => {
    const context = fakeContext();
    stubDns(context);
    stubDns(context, { 'internal.example': '10.0.0.5' });
    assert.notStrictEqual(dnsPromises.lookup, realLookup, 'stubbed while the test runs');
    release(context, order);
    const restored = dnsPromises.lookup === realLookup;
    putRealBack();
    assert.ok(restored, 'the first stub was left installed');
  });
}

test('the stubs of two tests that overlap: the one still running keeps its own, the last one to end puts the real resolver back', async () => {
  const first = fakeContext();
  const second = fakeContext();
  stubDns(first);
  stubDns(second, { 'internal.example': '10.0.0.5' });
  try {
    release(first);
    assert.deepEqual(await dnsPromises.lookup('internal.example'), INTERNAL, 'the second test is still being answered by its own stub');
    release(second);
    assert.strictEqual(dnsPromises.lookup, realLookup);

    stubDns(first, { 'internal.example': '10.0.0.5' });
    stubDns(second);
    release(second);
    assert.deepEqual(await dnsPromises.lookup('internal.example'), INTERNAL, 'the first test is back to its own stub when the later one ends first');
    release(first);
    assert.strictEqual(dnsPromises.lookup, realLookup);
  } finally {
    putRealBack();
  }
});

test('a hook that runs twice does not drop another test\'s stub', () => {
  const first = fakeContext();
  const second = fakeContext();
  stubDns(first);
  stubDns(second);
  try {
    release(first);
    release(first);
    assert.notStrictEqual(dnsPromises.lookup, realLookup, 'the second test is still stubbed');
    release(second);
    assert.strictEqual(dnsPromises.lookup, realLookup);
  } finally {
    putRealBack();
  }
});

test('with the real t.after hooks: a test that stubs twice leaves the real resolver behind when it ends', async (t) => {
  try {
    await t.test('stubs twice, as a test that uses rig() and then its own stubDns does', (inner) => {
      stubDns(inner);
      stubDns(inner, { 'internal.example': '10.0.0.5' });
    });
    assert.strictEqual(dnsPromises.lookup, realLookup);
  } finally {
    putRealBack();
  }
});
