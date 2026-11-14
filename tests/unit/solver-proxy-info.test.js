'use strict';

// server/modules/network/solver/proxy-info.js: the proxy the browser is pointed at,
// reduced to what FlareSolverr may be told.

const test = require('node:test');
const assert = require('node:assert/strict');

const { NO_PROXY, normalizeProxyInfo, createProxyResolver } = require('../../server/modules/network/solver/proxy-info');

test('no proxy, or anything that is not a proxy description, is "none"', () => {
  for (const junk of [null, undefined, 'http://127.0.0.1:3128', 42, [], {}, { proxy: null }, { proxy: {} }, { proxy: { url: '' } }, { proxy: 'x' }]) {
    assert.equal(normalizeProxyInfo(junk), NO_PROXY, JSON.stringify(junk));
  }
  assert.deepEqual(NO_PROXY, { proxy: null, mode: 'none', fingerprint: 'none' });
  assert.ok(Object.isFrozen(NO_PROXY));
});

test('only url, username and password reach FlareSolverr', () => {
  const info = normalizeProxyInfo({
    proxy: { url: 'http://127.0.0.1:3128', username: 'user', password: 'secret', extra: 'x', headers: { a: 1 } },
    mode: 'user-proxy',
    fingerprint: 'user:abcd1234',
  });
  assert.deepEqual(info.proxy, { url: 'http://127.0.0.1:3128', username: 'user', password: 'secret' });
  assert.equal(info.mode, 'user-proxy');
  assert.equal(info.fingerprint, 'user:abcd1234');

  const bare = normalizeProxyInfo({ proxy: { url: 'http://127.0.0.1:3128', username: '', password: '' }, mode: 'user-proxy', fingerprint: 'user:5' });
  assert.deepEqual(bare.proxy, { url: 'http://127.0.0.1:3128' }, 'empty credentials are not sent');
  assert.equal(bare.mode, 'user-proxy');
});

test('whatever mode a lookup claims, the only proxy there is is the user\'s', () => {
  for (const mode of ['user-proxy', 'none', 'ad-filter', undefined, 'whatever']) {
    assert.equal(normalizeProxyInfo({ proxy: { url: 'http://p' }, mode, fingerprint: 'f' }).mode, 'user-proxy', String(mode));
  }
});

test('a proxy without a fingerprint gets a hashed one that changes with the password and never contains it', () => {
  const make = (password) => normalizeProxyInfo({ proxy: { url: 'http://p:1', username: 'u', password } }).fingerprint;
  const one = make('hunter2');
  assert.match(one, /^[0-9a-f]{8}$/);
  assert.notEqual(one, make('hunter3'), 'a password change recycles the browser');
  assert.equal(one, make('hunter2'), 'and the same proxy gives the same fingerprint');
  assert.ok(!one.includes('hunter2'));
  assert.equal(normalizeProxyInfo({ proxy: { url: 'http://p' }, fingerprint: 12345 }).fingerprint, '12345', 'a given fingerprint is kept, as text');
});

test('the resolver passes the solver URL on and normalises the answer; a failing lookup fails the job', async () => {
  const seen = [];
  const resolve = createProxyResolver(async (solverUrl) => { seen.push(solverUrl); return { proxy: { url: 'http://p:1', junk: true }, mode: 'user-proxy', fingerprint: 'user:9' }; });
  const info = await resolve('http://127.0.0.1:8191/v1');
  assert.deepEqual(seen, ['http://127.0.0.1:8191/v1']);
  assert.deepEqual(info, { proxy: { url: 'http://p:1' }, mode: 'user-proxy', fingerprint: 'user:9' });

  assert.equal(await createProxyResolver(async () => null)('http://x'), NO_PROXY);

  const boom = new Error('lookup failed');
  await assert.rejects(createProxyResolver(async () => { throw boom; })('http://x'), (err) => err === boom, 'the same error, not "no proxy"');
  await assert.rejects(createProxyResolver(() => { throw boom; })('http://x'), (err) => err === boom, 'also when it throws before returning a promise');
});
