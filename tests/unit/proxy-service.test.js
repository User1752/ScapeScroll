const test = require('node:test');
const assert = require('node:assert');
const { createProxyService } = require('../../server/modules/proxy/service');

test('Proxy Service - Security boundaries', async (t) => {
  const isSafeUrlMock = (url) => {
    // Basic mock logic mimicking actual isSafeUrl
    if (url.includes('localhost') || url.includes('127.0.0.1')) return false;
    return true;
  };

  const service = createProxyService({ isSafeUrl: isSafeUrlMock });

  await t.test('Rejects invalid URLs', async () => {
    await assert.rejects(
      () => service.fetchProxyImage({ url: 'http://localhost/image.png' }),
      { statusCode: 400, message: 'Invalid image URL' }
    );
  });

  await t.test('Rejects AniList missing query', async () => {
    await assert.rejects(
      () => service.proxyAniList({ variables: {} }),
      { statusCode: 400, message: 'Missing query' }
    );
  });
});

// Number(null) is 0, so a chunked upstream response (no Content-Length) used to be
// announced as 0 bytes followed by the whole image; and a Content-Encoding means
// fetch() already decoded the body, so the declared length no longer matches it.
// The real resolver would make these tests depend on the network they run on (a hijacking
// resolver answers for any name, a black-holed one stalls): answer every lookup with a public address.
function stubDns(t) {
  const dnsPromises = require('node:dns').promises;
  const real = dnsPromises.lookup;
  dnsPromises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  t.after(() => { dnsPromises.lookup = real; });
}

test('Proxy Service - only announces a Content-Length the upstream really sent for the streamed body', async (t) => {
  stubDns(t);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const service = createProxyService({ isSafeUrl: () => true });
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const respond = (headers) => { globalThis.fetch = async () => new Response(png, { status: 200, headers }); };

  respond({ 'content-type': 'image/png', 'transfer-encoding': 'chunked' });
  assert.equal((await service.fetchProxyImage({ url: 'https://img-a.example/a.png' })).contentLength, undefined);

  respond({ 'content-type': 'image/png', 'content-length': String(png.length) });
  assert.equal((await service.fetchProxyImage({ url: 'https://img-b.example/b.png' })).contentLength, png.length);

  respond({ 'content-type': 'image/png', 'content-length': '3', 'content-encoding': 'gzip' });
  assert.equal((await service.fetchProxyImage({ url: 'https://img-c.example/c.png' })).contentLength, undefined);
});

// `ref` comes from the client. The cookies saved for the referer's site must not be sent to whatever host `url`
// names (a LAN client could point it at a server of its own), but an image on the same site, a subdomain such
// as a CDN, still gets the site's cookies.
test('Proxy Service - the saved cookies of the referer\'s site go only to hosts of that same site', async (t) => {
  stubDns(t);
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  const { saveDomainSession } = require('../../server/modules/network/fetch-utils');
  saveDomainSession('https://protected-site.example/', [{ name: 'cf_clearance', value: 'CLEARANCE' }, { name: 'sessionid', value: 'LOGIN' }]);
  const seen = [];
  globalThis.fetch = async (target, init) => {
    seen.push({ url: String(target), cookie: init && init.headers && (init.headers.Cookie || init.headers.cookie) });
    return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  const service = createProxyService({ isSafeUrl: () => true });
  const ref = 'https://protected-site.example/manga/1';

  await service.fetchProxyImage({ url: 'https://attacker-server.example/pic.png', ref });
  await service.fetchProxyImage({ url: 'https://cdn.protected-site.example/pic.png', ref });
  await service.fetchProxyImage({ url: 'https://protected-site.example/pic.png' });

  const cookieOf = (host) => seen.find((s) => new URL(s.url).hostname === host).cookie;
  assert.equal(cookieOf('attacker-server.example'), undefined, 'another site gets no cookie');
  assert.match(cookieOf('cdn.protected-site.example'), /cf_clearance=CLEARANCE; sessionid=LOGIN/);
  assert.match(cookieOf('protected-site.example'), /cf_clearance=CLEARANCE/);
});
