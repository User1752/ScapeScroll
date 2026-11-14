'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeRelayContentType,
  applyUntrustedContentHeaders,
  sendRelayedResource,
} = require('../../server/modules/http/untrusted-content');

function fakeRes() {
  return {
    headers: {},
    sent: undefined,
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    send(body) { this.sent = body; return this; },
  };
}

test('keeps the media types the players actually consume', () => {
  for (const [input, expected] of [
    ['application/vnd.apple.mpegurl', 'application/vnd.apple.mpegurl'],
    ['application/x-mpegURL', 'application/x-mpegurl'],
    ['video/mp2t', 'video/mp2t'],
    ['video/mp4; codecs="avc1"', 'video/mp4'],
    ['audio/aac', 'audio/aac'],
    ['image/jpeg', 'image/jpeg'],
    ['image/webp', 'image/webp'],
    ['text/vtt; charset=utf-8', 'text/vtt'],
    ['text/plain', 'text/plain'],
    ['application/octet-stream', 'application/octet-stream'],
  ]) {
    assert.equal(safeRelayContentType(input), expected, input);
  }
});

test('anything that can be a script-capable document is downgraded to octet-stream', () => {
  for (const hostile of [
    'text/html',
    'text/html; charset=utf-8',
    'application/xhtml+xml',
    'image/svg+xml',
    'text/xml',
    'application/xml',
    'text/javascript',
    'application/javascript',
    'application/json',
    'multipart/x-mixed-replace',
    'TEXT/HTML',
  ]) {
    assert.equal(safeRelayContentType(hostile), 'application/octet-stream', hostile);
  }
});

test('a missing or empty Content-Type is downgraded too', () => {
  for (const missing of [undefined, null, '']) assert.equal(safeRelayContentType(missing), 'application/octet-stream');
});

test('applyUntrustedContentHeaders disables sniffing and sandboxes the response', () => {
  const res = fakeRes();
  applyUntrustedContentHeaders(res);
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /\bsandbox\b/);
  assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/);
});

test('sendRelayedResource sends the body with a safe type, the headers and no caching', () => {
  const res = fakeRes();
  sendRelayedResource(res, 'text/html', Buffer.from('<script>alert(1)</script>'));
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.ok(res.headers['content-security-policy']);
  assert.equal(res.sent.toString(), '<script>alert(1)</script>');

  const playlist = fakeRes();
  sendRelayedResource(playlist, 'application/vnd.apple.mpegurl', '#EXTM3U');
  assert.equal(playlist.headers['content-type'], 'application/vnd.apple.mpegurl');
});
