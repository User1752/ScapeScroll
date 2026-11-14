'use strict';

// The images of a source that reads through the person's own Suwayomi-Server are this app's own relay paths (/api/suwayomi/...). The server-side
// image fetching (the source Test, chapter downloads, save offline) has to accept exactly those two shapes and nothing near them, and get the bytes
// from the Suwayomi service, never from an address built out of the path.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isRelayImage, fetchRelayImage } = require('../../server/modules/suwayomi/relay-image');
const { createPageUrlResolver } = require('../../server/modules/network/fetch-utils');
const { isSafeUrl } = require('../../server/modules/common/sanitize');

const webStream = (...parts) => new ReadableStream({ start(controller) { parts.forEach((p) => controller.enqueue(Buffer.from(p))); controller.close(); } });

test('only the two shapes of the relay are accepted: a cover, and a page of a chapter, with whole numbers', () => {
  for (const good of ['/api/suwayomi/thumbnail/12', '/api/suwayomi/page/12/3/0', '/api/suwayomi/page/999999999999/999999/999999']) assert.equal(isRelayImage(good), true, good);
  const bad = ['/api/suwayomi/thumbnail/', '/api/suwayomi/thumbnail/1a', '/api/suwayomi/thumbnail/1/2', '/api/suwayomi/page/1/2', '/api/suwayomi/page/1/2/3/4',
    '/api/suwayomi/page/1/2/3?x=1', '/api/suwayomi/page/1/2/3#x', '/api/suwayomi/page/../2/3', '/api/suwayomi/page/1/2/-3', '//evil.example/api/suwayomi/page/1/2/3',
    'https://evil.example/api/suwayomi/page/1/2/3', 'http://localhost/api/suwayomi/page/1/2/3', ' /api/suwayomi/page/1/2/3', '/api/suwayomi/page/1/2/3 ', '/api/suwayomi/test',
    '/api/proxy-image?url=/api/suwayomi/page/1/2/3', '', null, undefined, 5, { img: '/api/suwayomi/page/1/2/3' }];
  for (const value of bad) assert.equal(isRelayImage(value), false, String(value));
});

test('a page of the relay is resolved by the page-address resolver, and the look-alikes are still refused', () => {
  const { resolvePageUrl } = createPageUrlResolver({ isSafeUrl });
  assert.deepEqual(resolvePageUrl({ index: 0, img: '/api/suwayomi/page/12/3/0' }), { url: '/api/suwayomi/page/12/3/0', referer: '' });
  assert.deepEqual(resolvePageUrl('/api/suwayomi/thumbnail/7'), { url: '/api/suwayomi/thumbnail/7', referer: '' });
  assert.equal(resolvePageUrl({ img: '/api/suwayomi/page/12/3/0?x=1' }), null);
  assert.equal(resolvePageUrl({ img: '/api/suwayomi/page/1/../../etc/passwd' }), null);
  assert.equal(resolvePageUrl({ img: '/some/other/path.jpg' }), null, 'a relative path that is not the relay is still not an address to fetch');
});

test('the bytes come from the Suwayomi service, by the numbers of the path and nothing else', async () => {
  const calls = [];
  const service = {
    getThumbnail: async (id) => { calls.push(['thumbnail', id]); return { body: webStream('co', 'ver'), contentType: 'image/png' }; },
    getPage: async (...args) => { calls.push(['page', ...args]); return { body: webStream('pa', 'ge'), contentType: 'image/jpeg' }; },
  };
  assert.equal((await fetchRelayImage('/api/suwayomi/page/12/3/4', { service })).toString(), 'page');
  assert.equal((await fetchRelayImage('/api/suwayomi/thumbnail/7', { service })).toString(), 'cover');
  assert.deepEqual(calls, [['page', '12', '3', '4'], ['thumbnail', '7']]);
  await assert.rejects(fetchRelayImage('https://evil.example/a.png', { service }), /Not an image of the Suwayomi relay/);
  await assert.rejects(fetchRelayImage('/api/suwayomi/page/1/2/3?x', { service }), /Not an image/);
  assert.equal(calls.length, 2, 'a refused path asks nothing');
});

test('an answer that is too large is refused, and a failure of the service is the failure of the fetch', async () => {
  const huge = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); } });
  await assert.rejects(fetchRelayImage('/api/suwayomi/page/1/2/3', { service: { getPage: async () => ({ body: huge, contentType: 'image/png' }) } }), /too large/);
  const failing = { getPage: async () => { throw Object.assign(new Error('Suwayomi-Server returned HTTP 500'), { statusCode: 502 }); } };
  await assert.rejects(fetchRelayImage('/api/suwayomi/page/1/2/3', { service: failing }), /HTTP 500/);
});
