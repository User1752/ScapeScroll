'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { safeFetch, assertPublicUrl, MAX_REDIRECTS } = require('../../server/modules/network/safe-fetch');
const { isSafeUrl, isPrivateAddress, isLocalhostName } = require('../../server/modules/common/sanitize');

// A scripted stand-in for fetch(): each key is a URL, each value the Response
// to hand back. Records every request so a test can see exactly which hops
// were (not) made.
function scriptedFetch(routes) {
  const calls = [];
  async function fetchImpl(url, init) {
    calls.push({ url: String(url), init });
    const route = routes[String(url)];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return route instanceof Response ? route : route();
  }
  fetchImpl.calls = calls;
  return fetchImpl;
}

const redirect = (to, status = 302) => () => new Response(null, { status, headers: { location: to } });
const ok = (text = 'ok') => () => new Response(text, { status: 200 });

// DNS stub: names map to fixed addresses, anything else resolves publicly.
const lookupTable = (table) => async (host) =>
  (table[host] || ['93.184.216.34']).map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
const assertUrl = (table = {}) => (url) => assertPublicUrl(url, { lookup: lookupTable(table) });

test('isPrivateAddress covers loopback, RFC1918, link-local, CGNAT and mapped IPv6', () => {
  for (const addr of [
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.169.254', '0.0.0.0', '0.1.2.3', '100.64.0.1', '100.127.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '[::1]',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1',
    '64:ff9b::7f00:1', '64:ff9b::a00:1', '2002:7f00:1::', '2002:c0a8:101::1',
  ]) {
    assert.equal(isPrivateAddress(addr), true, `${addr} should be private`);
  }
});

test('isPrivateAddress leaves public addresses and non-IPs alone', () => {
  for (const addr of ['93.184.216.34', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1',
    '2606:4700:4700::1111', '::ffff:8.8.8.8', 'example.com', '10.example.com', '']) {
    assert.equal(isPrivateAddress(addr), false, `${addr} should not be private`);
  }
});

test('isSafeUrl catches the spellings the old prefix test missed', () => {
  for (const url of [
    'http://localhost./x', 'http://LOCALHOST/x', 'http://app.localhost/x',
    'http://100.64.1.2/x', 'http://0.0.0.1/x', 'http://[::]/x', 'http://[::ffff:7f00:1]/x',
    'http://2130706433/x', 'http://0x7f.1/x', 'http://127.1/x',
  ]) {
    assert.equal(isSafeUrl(url), false, `${url} should be blocked`);
  }
});

test('isSafeUrl no longer rejects public names that merely start with digits', () => {
  assert.equal(isSafeUrl('https://10.example.com/x'), true);
  assert.equal(isSafeUrl('https://127.0.0.1.example.com/x'), true);
  assert.equal(isLocalhostName('notlocalhost'), false);
});

test('safeFetch returns a plain response without touching redirects', async () => {
  const fetchImpl = scriptedFetch({ 'https://a.example/x': ok('hello') });
  const res = await safeFetch('https://a.example/x', {}, { fetchImpl, assertUrl: assertUrl() });
  assert.equal(await res.text(), 'hello');
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].init.redirect, 'manual');
});

test('safeFetch follows a redirect between public hosts', async () => {
  const fetchImpl = scriptedFetch({
    'https://a.example/x': redirect('https://b.example/y'),
    'https://b.example/y': ok('landed'),
  });
  const res = await safeFetch('https://a.example/x', {}, { fetchImpl, assertUrl: assertUrl() });
  assert.equal(await res.text(), 'landed');
  assert.deepEqual(fetchImpl.calls.map(c => c.url), ['https://a.example/x', 'https://b.example/y']);
});

test('safeFetch resolves a relative Location against the current URL', async () => {
  const fetchImpl = scriptedFetch({
    'https://a.example/dir/x': redirect('../final'),
    'https://a.example/final': ok('rel'),
  });
  const res = await safeFetch('https://a.example/dir/x', {}, { fetchImpl, assertUrl: assertUrl() });
  assert.equal(await res.text(), 'rel');
});

test('safeFetch refuses a redirect to loopback and never requests it', async () => {
  const fetchImpl = scriptedFetch({
    'https://a.example/x': redirect('http://127.0.0.1:4000/api/settings'),
    'http://127.0.0.1:4000/api/settings': ok('SECRET'),
  });
  await assert.rejects(
    safeFetch('https://a.example/x', {}, { fetchImpl, assertUrl: assertUrl() }),
    err => err.code === 'UNSAFE_URL',
  );
  assert.deepEqual(fetchImpl.calls.map(c => c.url), ['https://a.example/x']);
});

test('safeFetch refuses redirects to every private spelling', async () => {
  for (const target of [
    'http://localhost:4000/api/settings', 'http://[::1]:4000/api/settings', 'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data/', 'http://2130706433:4000/', 'http://0.0.0.0:4000/',
  ]) {
    const fetchImpl = scriptedFetch({ 'https://a.example/x': redirect(target) });
    await assert.rejects(
      safeFetch('https://a.example/x', {}, { fetchImpl, assertUrl: assertUrl() }),
      err => err.code === 'UNSAFE_URL',
      target,
    );
    assert.equal(fetchImpl.calls.length, 1, `${target} must not be requested`);
  }
});

test('safeFetch refuses a public-looking name that resolves to a private address', async () => {
  const fetchImpl = scriptedFetch({ 'https://evil.example/x': ok('SECRET') });
  const guard = assertUrl({ 'evil.example': ['127.0.0.1'] });
  await assert.rejects(safeFetch('https://evil.example/x', {}, { fetchImpl, assertUrl: guard }), /private address/);
  assert.equal(fetchImpl.calls.length, 0);
});

test('safeFetch refuses a name with ANY private address among several', async () => {
  const guard = assertUrl({ 'mixed.example': ['93.184.216.34', '10.0.0.9'] });
  await assert.rejects(safeFetch('https://mixed.example/', {}, { fetchImpl: scriptedFetch({}), assertUrl: guard }), /private address/);
});

test('assertPublicUrl lets an unresolvable name through for fetch() to report', async () => {
  const failing = async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };
  await assertPublicUrl('https://no-such-host.example/', { lookup: failing });
});

test('safeFetch stops redirect loops', async () => {
  const fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://a.example/again' } });
  await assert.rejects(
    safeFetch('https://a.example/again', {}, { fetchImpl, assertUrl: assertUrl() }),
    /Too many redirects/,
  );
});

test('safeFetch allows exactly maxRedirects hops', async () => {
  const hops = {};
  for (let i = 0; i < MAX_REDIRECTS; i++) hops[`https://a.example/${i}`] = redirect(`https://a.example/${i + 1}`);
  hops[`https://a.example/${MAX_REDIRECTS}`] = ok('end');
  const res = await safeFetch('https://a.example/0', {}, { fetchImpl: scriptedFetch(hops), assertUrl: assertUrl() });
  assert.equal(await res.text(), 'end');
});

test('safeFetch drops credentials when a redirect crosses origins, keeps them within one', async () => {
  const fetchImpl = scriptedFetch({
    'https://a.example/x': redirect('https://a.example/y'),
    'https://a.example/y': redirect('https://b.example/z'),
    'https://b.example/z': ok(),
  });
  await safeFetch('https://a.example/x', { headers: { Cookie: 'sid=1', Authorization: 'Bearer t', Referer: 'https://r.example/' } },
    { fetchImpl, assertUrl: assertUrl() });
  const [first, sameOrigin, crossOrigin] = fetchImpl.calls.map(c => new Headers(c.init.headers));
  assert.equal(first.get('cookie'), 'sid=1');
  assert.equal(sameOrigin.get('cookie'), 'sid=1');
  assert.equal(sameOrigin.get('authorization'), 'Bearer t');
  assert.equal(crossOrigin.get('cookie'), null);
  assert.equal(crossOrigin.get('authorization'), null);
  assert.equal(crossOrigin.get('referer'), 'https://r.example/');
});

test('safeFetch turns a POST into a body-less GET on 303 but replays it on 307', async () => {
  const see = async (status) => {
    const fetchImpl = scriptedFetch({
      'https://a.example/x': redirect('https://a.example/y', status),
      'https://a.example/y': ok(),
    });
    await safeFetch('https://a.example/x', { method: 'POST', body: 'payload' }, { fetchImpl, assertUrl: assertUrl() });
    return fetchImpl.calls[1].init;
  };
  const after303 = await see(303);
  assert.equal(after303.method, 'GET');
  assert.equal(after303.body, undefined);
  const after307 = await see(307);
  assert.equal(after307.method, 'POST');
  assert.equal(after307.body, 'payload');
});

test('safeFetch hands a non-follow redirect mode back to the caller after checking the URL', async () => {
  const fetchImpl = scriptedFetch({ 'https://a.example/x': redirect('https://b.example/y') });
  const res = await safeFetch('https://a.example/x', { redirect: 'manual' }, { fetchImpl, assertUrl: assertUrl() });
  assert.equal(res.status, 302);
  assert.equal(fetchImpl.calls.length, 1);
  await assert.rejects(
    safeFetch('http://127.0.0.1/', { redirect: 'manual' }, { fetchImpl, assertUrl: assertUrl() }),
    err => err.code === 'UNSAFE_URL',
  );
});

test('safeFetch rejects a non-http scheme in a redirect', async () => {
  const fetchImpl = scriptedFetch({ 'https://a.example/x': redirect('file:///etc/passwd') });
  await assert.rejects(
    safeFetch('https://a.example/x', {}, { fetchImpl, assertUrl: assertUrl() }),
    err => err.code === 'UNSAFE_URL',
  );
});

// A DNS64 resolver (phone tethering, some ISPs) answers 64:ff9b::<ipv4> for every
// IPv4-only public host; blocking the whole prefix broke those networks. Only the
// private IPv4 ranges underneath it are refused.
test('NAT64 addresses of PUBLIC hosts are allowed, those wrapping private IPv4 are not', async () => {
  for (const addr of ['64:ff9b::5db8:d822', '64:ff9b::808:808', '64:ff9b::101:101']) {
    assert.equal(isPrivateAddress(addr), false, `${addr} wraps a public address`);
  }
  for (const addr of ['64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::c0a8:101', '64:ff9b::ac10:1', '64:ff9b::6440:1']) {
    assert.equal(isPrivateAddress(addr), true, `${addr} wraps a private address`);
  }
  assert.equal(isPrivateAddress('2002:5db8:d822::1'), true, '6to4 stays blocked as a whole');

  const fetchImpl = scriptedFetch({ 'https://v4only.example/': ok('through the translator') });
  const guard = assertUrl({ 'v4only.example': ['64:ff9b::5db8:d822'] });
  const res = await safeFetch('https://v4only.example/', {}, { fetchImpl, assertUrl: guard });
  assert.equal(await res.text(), 'through the translator');
});

test('a redirect that drops the body also drops the headers that describe it', async () => {
  const fetchImpl = scriptedFetch({
    'https://a.example/x': redirect('https://a.example/y', 303),
    'https://a.example/y': ok(),
  });
  await safeFetch('https://a.example/x', {
    method: 'POST',
    body: 'a=1',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': '3', Accept: 'text/html' },
  }, { fetchImpl, assertUrl: assertUrl() });
  const second = new Headers(fetchImpl.calls[1].init.headers);
  assert.equal(second.get('content-type'), null);
  assert.equal(second.get('content-length'), null);
  assert.equal(second.get('accept'), 'text/html');
});

// Headers come in as latin-1 text. A server that sends the target as raw UTF-8
// bytes was fetched at the wrong path (double percent-encoding), where native
// fetch decodes it as UTF-8 first. http.ServerResponse cannot emit such bytes,
// so this talks raw TCP.
test('a raw UTF-8 Location is followed to the same path native fetch would use', async () => {
  const seen = [];
  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      const requestPath = chunk.toString('latin1').split(' ')[1];
      seen.push(requestPath);
      const head = requestPath === '/start'
        ? Buffer.concat([Buffer.from('HTTP/1.1 302 Found\r\nLocation: '), Buffer.from('/caf\u00e9/\u65e5\u672c', 'utf8'), Buffer.from('\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')])
        : Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      socket.end(head);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await safeFetch(`${base}/start`, {}, { assertUrl: async () => {} });
    assert.equal(await res.text(), 'ok');
    assert.deepEqual(seen, ['/start', '/caf%C3%A9/%E6%97%A5%E6%9C%AC']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a resolver that never answers fails the request instead of stalling it', async () => {
  const hang = () => new Promise(() => {});
  await assert.rejects(
    assertPublicUrl('https://slow-dns.example/', { lookup: hang, lookupTimeoutMs: 30 }),
    err => err.code === 'DNS_TIMEOUT',
  );
});

// The real resolver would make these tests depend on the network they run on (a hijacking
// resolver answers for any name, a black-holed one stalls): answer every lookup with a public address.
function stubDns(t) {
  const dnsPromises = require('node:dns').promises;
  const real = dnsPromises.lookup;
  dnsPromises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  t.after(() => { dnsPromises.lookup = real; });
}

test('a blocked redirect is not retried with back-off by fetchJson', async (t) => {
  stubDns(t);
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:4000/api/settings' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const { fetchJson } = require('../../server/modules/network/fetch-utils');
  const started = Date.now();
  await assert.rejects(fetchJson('https://public-looking.invalid/data.json'), (err) => err.code === 'UNSAFE_URL');
  assert.equal(calls, 1, 'one request, no retries');
  assert.ok(Date.now() - started < 1000, 'no 1.5 s + 3 s back-off');
});
