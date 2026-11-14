'use strict';

// The image proxy's request (server/modules/proxy/service.js) for the hosts config/image-hosts.js lists. Measured on the library's own covers
// on 2026-11-01: the covers host of one site answers 403 to a request that claims to be a browser and 200 to a plain one, and two others
// answer 403 when their own address is the Referer and 200 when there is none. Every other host keeps the request it always had.
// The network is replaced (a fake fetch that records the headers) and every name resolves to a public address.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createProxyService } = require('../../server/modules/proxy/service');
const IMAGE_HOSTS = require('../../server/config/image-hosts');

function stubNetwork(t) {
  const dnsPromises = require('node:dns').promises;
  const realLookup = dnsPromises.lookup;
  const realFetch = globalThis.fetch;
  dnsPromises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers || {})) });
    return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  t.after(() => { dnsPromises.lookup = realLookup; globalThis.fetch = realFetch; });
  return sent;
}

const service = createProxyService({ isSafeUrl: () => true });

test('a host that refuses a browser User-Agent is asked without one (and still gets its Referer)', async (t) => {
  const sent = stubNetwork(t);
  await service.fetchProxyImage({ url: 'https://uploads.mangadex.org/covers/abc/def.jpg' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers['user-agent'], undefined, 'no User-Agent of ours: the fetch adds its plain one');
  assert.match(sent[0].headers.referer, /^https:\/\/uploads\.mangadex\.org/);
  assert.match(sent[0].headers.accept, /image\//);
});

test('hosts that refuse their own address as Referer are asked with none, even when the page names one', async (t) => {
  const sent = stubNetwork(t);
  await service.fetchProxyImage({ url: 'https://mancover.xyz/cover/2024/07/x.webp' });
  await service.fetchProxyImage({ url: 'https://cdn.anime-planet.com/manga/primary/x.webp?t=1' });
  await service.fetchProxyImage({ url: 'https://mancover.xyz/cover/2024/07/y.webp', ref: 'https://somewhere.example/page' });
  assert.equal(sent.length, 3);
  for (const s of sent) {
    assert.equal(s.headers.referer, undefined, s.url);
    assert.match(s.headers['user-agent'], /Mozilla/, 'these hosts only mind the Referer');
  }
});

test('every other host keeps the request it always had: a browser User-Agent and its Referer', async (t) => {
  const sent = stubNetwork(t);
  await service.fetchProxyImage({ url: 'https://img-a.example/a.png' });
  await service.fetchProxyImage({ url: 'https://cdn.readdetectiveconan.com/file/x/2965.jpg' });
  assert.match(sent[0].headers['user-agent'], /Mozilla/);
  assert.equal(sent[0].headers.referer, 'https://img-a.example');
  assert.equal(sent[1].headers.referer, 'https://mangapill.com', 'the Referer a host was already known to want');
});

test('the lists are exact: a look-alike host name is not on them', () => {
  const matches = (list, host) => list.some((re) => re.test(host));
  assert.equal(matches(IMAGE_HOSTS.withoutUserAgentHosts, 'uploads.mangadex.org'), true);
  assert.equal(matches(IMAGE_HOSTS.withoutUserAgentHosts, 'uploads.mangadex.org.evil.example'), false);
  assert.equal(matches(IMAGE_HOSTS.withoutUserAgentHosts, 'evil-uploads.mangadex.org'), false);
  assert.equal(matches(IMAGE_HOSTS.withoutRefererHosts, 'mancover.xyz'), true);
  assert.equal(matches(IMAGE_HOSTS.withoutRefererHosts, 'cdn.anime-planet.com'), true);
  assert.equal(matches(IMAGE_HOSTS.withoutRefererHosts, 'mancover.xyz.evil.example'), false);
  assert.equal(matches(IMAGE_HOSTS.withoutRefererHosts, 'notanime-planet.com'), false);
});
