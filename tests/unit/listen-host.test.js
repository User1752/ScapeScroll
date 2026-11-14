'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveListenHost, isLoopbackHost } = require('../../server/modules/http/listen-host');

test('HOST wins over every default', () => {
  assert.equal(resolveListenHost({ env: { HOST: '127.0.0.1' }, fallback: '0.0.0.0' }), '127.0.0.1');
  assert.equal(resolveListenHost({ env: { HOST: '0.0.0.0' }, isPkg: true }), '0.0.0.0');
  assert.equal(resolveListenHost({ env: { HOST: '  ::1  ' } }), '::1');
});

test('without HOST the packaged exe is loopback-only', () => {
  assert.equal(resolveListenHost({ env: {}, isPkg: true, fallback: '0.0.0.0' }), '127.0.0.1');
});

test('without HOST and not packaged, the caller\'s fallback is used', () => {
  assert.equal(resolveListenHost({ env: {}, fallback: '127.0.0.1' }), '127.0.0.1');
  assert.equal(resolveListenHost({ env: {}, fallback: '0.0.0.0' }), '0.0.0.0');
  assert.equal(resolveListenHost({ env: {} }), '0.0.0.0');
});

test('an empty or blank HOST is treated as unset', () => {
  assert.equal(resolveListenHost({ env: { HOST: '' }, fallback: '127.0.0.1' }), '127.0.0.1');
  assert.equal(resolveListenHost({ env: { HOST: '   ' }, isPkg: true }), '127.0.0.1');
});

test('isLoopbackHost recognises the loopback spellings only', () => {
  for (const ok of ['127.0.0.1', '::1', 'localhost', ' LOCALHOST ']) assert.equal(isLoopbackHost(ok), true, ok);
  for (const bad of ['0.0.0.0', '192.168.1.5', '::', '', undefined]) assert.equal(isLoopbackHost(bad), false, String(bad));
});
