'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hostKeyOf, isLoopbackUrl } = require('../../server/modules/common/host-utils');
const { TWO_LEVEL_SUFFIXES } = require('../../server/config/solver');

test('hostKeyOf keeps the registrable domain of a URL and drops www, subdomains, port and path', () => {
  assert.equal(hostKeyOf('https://example.com/a/b?c=1#d'), 'example.com');
  assert.equal(hostKeyOf('https://www.example.com/'), 'example.com');
  assert.equal(hostKeyOf('https://WWW.Example.COM:8443/x'), 'example.com');
  assert.equal(hostKeyOf('https://api.v2.cdn.example.com/x'), 'example.com');
  assert.equal(hostKeyOf('http://user:pass@sub.example.com/'), 'example.com');
});

test('hostKeyOf also takes a bare host name', () => {
  assert.equal(hostKeyOf('example.com'), 'example.com');
  assert.equal(hostKeyOf('www.example.com'), 'example.com');
  assert.equal(hostKeyOf('Sub.Example.com:8080'), 'example.com');
  assert.equal(hostKeyOf('example.com/path'), 'example.com');
  assert.equal(hostKeyOf('example.com.'), 'example.com');
});

test('hostKeyOf gives a site under a two-level suffix three labels, so co.uk is not one site', () => {
  assert.equal(hostKeyOf('https://foo.co.uk/'), 'foo.co.uk');
  assert.equal(hostKeyOf('https://www.foo.co.uk/'), 'foo.co.uk');
  assert.equal(hostKeyOf('https://a.b.foo.co.uk/'), 'foo.co.uk');
  assert.equal(hostKeyOf('https://x.com.br/'), 'x.com.br');
  assert.equal(hostKeyOf('https://www.x.com.au/'), 'x.com.au');
  assert.equal(hostKeyOf('https://cdn.x.co.jp/'), 'x.co.jp');
  // The 3.1.2 copies in fetch-utils took the last two labels, so every site
  // under co.uk shared the one key "co.uk" - and with it saved Cloudflare cookies.
  assert.notEqual(hostKeyOf('https://one.co.uk/'), hostKeyOf('https://two.co.uk/'));
  // A suffix on its own has nothing in front of it to keep.
  assert.equal(hostKeyOf('co.uk'), 'co.uk');
  assert.equal(hostKeyOf('www.co.uk'), 'co.uk');
});

test('hostKeyOf returns IP literals and single labels as they are', () => {
  assert.equal(hostKeyOf('http://127.0.0.1:8191/v1'), '127.0.0.1');
  assert.equal(hostKeyOf('192.168.1.5'), '192.168.1.5');
  assert.equal(hostKeyOf('http://[::1]:8191/v1'), '::1');
  assert.equal(hostKeyOf('[::1]'), '::1');
  assert.equal(hostKeyOf('::1'), '::1');
  assert.equal(hostKeyOf('2001:db8::7'), '2001:db8::7');
  assert.equal(hostKeyOf('localhost'), 'localhost');
  assert.equal(hostKeyOf('http://localhost:3000/'), 'localhost');
  assert.equal(hostKeyOf('intranet'), 'intranet');
  // The URL parser's own normal form for odd IPv4 spellings.
  assert.equal(hostKeyOf('http://2130706433/'), '127.0.0.1');
  assert.equal(hostKeyOf('http://0x7f.1/'), '127.0.0.1');
});

test('an IPv6 address gets the same key bare, in brackets and inside a URL, however it is spelled', () => {
  // The same site must never be two keys: a caller that keys spacing by a bare host and another that keys by a URL would split it.
  const spellings = [
    ['2001:0db8::7', '2001:db8::7'],
    ['2001:DB8:0:0:0:0:0:7', '2001:db8::7'],
    ['0:0:0:0:0:0:0:1', '::1'],
    ['::ffff:127.0.0.1', '::ffff:7f00:1'],
  ];
  for (const [spelling, expected] of spellings) {
    assert.equal(hostKeyOf(spelling), expected, `bare ${spelling}`);
    assert.equal(hostKeyOf(`[${spelling}]`), expected, `bracketed ${spelling}`);
    assert.equal(hostKeyOf(`http://[${spelling}]/`), expected, `in a URL ${spelling}`);
    assert.equal(hostKeyOf(spelling), hostKeyOf(`http://[${spelling}]:8191/v1`), `bare and URL agree for ${spelling}`);
  }
  // An address the URL parser refuses (a zone id) is still an address, not "default".
  assert.equal(hostKeyOf('fe80::1%eth0'), 'fe80::1%eth0');
});

test('hostKeyOf maps international names to their punycode form', () => {
  assert.equal(hostKeyOf('https://www.bücher.example/'), 'xn--bcher-kva.example');
});

test('hostKeyOf answers "default" when nothing parses, and never throws', () => {
  for (const junk of ['', '   ', null, undefined, 'a b', 'file:///etc/passwd', 'http://', 'a..b.com', '.', '..', '[object Object]', 'http://exa mple.com']) {
    assert.equal(hostKeyOf(junk), 'default', JSON.stringify(junk));
  }
  assert.equal(hostKeyOf({}), 'default');
  assert.equal(hostKeyOf({ toString() { throw new Error('boom'); } }), 'default');
  assert.doesNotThrow(() => hostKeyOf(Symbol('x')));
  assert.doesNotThrow(() => hostKeyOf('http://%zz/'));
});

test('hostKeyOf does not strip the www of a name that is only www plus a suffix', () => {
  assert.equal(hostKeyOf('www.com'), 'www.com');
  assert.equal(hostKeyOf('https://www.com/'), 'www.com');
});

test('isLoopbackUrl is true for localhost, 127.0.0.0/8 and [::1] only', () => {
  for (const url of [
    'http://localhost:8191/v1', 'http://LOCALHOST/', 'http://127.0.0.1:8191/v1', 'http://127.8.9.10/',
    'http://[::1]:8191/v1', 'http://[0:0:0:0:0:0:0:1]/', 'http://2130706433/', 'http://0x7f.1/', 'https://127.0.0.1/',
  ]) {
    assert.equal(isLoopbackUrl(url), true, url);
  }
});

test('isLoopbackUrl does not mistake a look-alike or a non-local address for loopback', () => {
  for (const url of [
    'http://127.0.0.1.evil.com/', 'http://localhost.evil.com/', 'http://evil.com/127.0.0.1', 'http://evil.com@127.0.0.1.evil.com/',
    'http://0.0.0.0:8191/', 'http://192.168.1.5:8191/', 'http://10.0.0.1/', 'http://[::]/', 'http://[::ffff:7f00:1]/',
    'https://example.com/', 'http://128.0.0.1/', 'http://1127.0.0.1/',
  ]) {
    assert.equal(isLoopbackUrl(url), false, url);
  }
});

test('isLoopbackUrl judges the parsed host, so input that is not a URL is never loopback', () => {
  for (const value of ['', '   ', null, undefined, 5, {}, 'localhost:8191', '127.0.0.1', 'not a url', 'http://']) {
    assert.equal(isLoopbackUrl(value), false, String(value));
  }
});

// The check services-health.js carried before it used this module:
//   hostname === 'localhost' || isLoopbackListenAddress(hostname)
// with the lifecycle's isLoopbackListenAddress written out (it accepts '[::1]',
// '::1' and 127.x.x.x). Holding the helper to it keeps every spelling that row
// already treated as "the local copy".
function formerIsLoopbackUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === 'localhost' || ['[::1]', '::1'].includes(hostname) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  } catch {
    return false;
  }
}

test('isLoopbackUrl answers as the System Health check did for every spelling that check was tested with', () => {
  for (const url of [
    'http://127.0.0.1:8191/v1', 'http://localhost:8191/v1', 'http://[::1]:8191/v1', 'http://127.0.0.2:8191/v1',
    'http://127.255.255.254/', 'http://127.1/', 'http://LocalHost:8191/', 'http://localhost./', 'http://app.localhost:3000/',
    'http://[::ffff:127.0.0.1]/', 'http://[::]/', 'http://0.0.0.0:8191/v1', 'http://192.168.1.5:8191/v1', 'http://100.68.10.126/',
    'http://1127.0.0.1/', 'http://127.0.0/', 'http://127.0.0.1.evil.com/', 'http://example.com/', 'ftp://127.0.0.1/', '',
  ]) {
    assert.equal(isLoopbackUrl(url), formerIsLoopbackUrl(url), url);
  }
});

test('every two-level suffix is a lower-case "label.label"', () => {
  assert.ok(TWO_LEVEL_SUFFIXES.size >= 25, 'about thirty entries');
  for (const suffix of TWO_LEVEL_SUFFIXES) {
    assert.match(suffix, /^[a-z]+\.[a-z]+$/, suffix);
  }
});

test('two tenants of a shared host are two sites: their cookies, spacing and cooldown are never one', () => {
  const tenants = ['github.io', 'pages.dev', 'vercel.app', 'workers.dev', 'netlify.app', 'blogspot.com', 'herokuapp.com', 'web.app', 'firebaseapp.com'];
  for (const host of tenants) {
    assert.equal(hostKeyOf(`https://one.${host}/x`), `one.${host}`, host);
    assert.equal(hostKeyOf(`https://two.${host}/x`), `two.${host}`, host);
    assert.notEqual(hostKeyOf(`https://one.${host}/`), hostKeyOf(`https://two.${host}/`), host);
    assert.equal(hostKeyOf(`https://www.one.${host}/`), `one.${host}`, 'a tenant keeps its own subdomains together');
    assert.equal(hostKeyOf(`https://cdn.assets.one.${host}/`), `one.${host}`, host);
  }
  assert.equal(hostKeyOf('https://github.io/'), 'github.io', 'the host itself is a site too');
  assert.equal(hostKeyOf('https://example.com/'), 'example.com', 'an ordinary site is unchanged');
});

// Not only the suffixes TWO_LEVEL_SUFFIXES lists: any country-code pair (a second-level label of at most three
// letters under a two-letter country code: co.th, com.pl, or.id, com.eg) is a suffix, so the sites under a
// country nobody listed never fall onto one shared key either.
test('a country-code second-level pair is a two-level suffix even when nobody listed it', () => {
  const unlisted = ['co.th', 'com.pl', 'or.id', 'com.eg', 'ac.th', 'net.pk', 'gov.sa', 'edu.pe', 'ne.ke'];
  for (const suffix of unlisted) {
    assert.equal(TWO_LEVEL_SUFFIXES.has(suffix), false, `${suffix} is not in the list: the rule alone has to cover it`);
    assert.equal(hostKeyOf(`https://one.${suffix}/x`), `one.${suffix}`, suffix);
    assert.equal(hostKeyOf(`https://www.one.${suffix}/`), `one.${suffix}`, `${suffix}: www is dropped`);
    assert.equal(hostKeyOf(`https://cdn.assets.one.${suffix}/`), `one.${suffix}`, `${suffix}: a site keeps its own subdomains together`);
    assert.notEqual(hostKeyOf(`https://one.${suffix}/`), hostKeyOf(`https://two.${suffix}/`), `${suffix}: two sites, two keys`);
  }
  // A suffix on its own, and a bare name under it, have nothing in front to keep or are already three labels.
  assert.equal(hostKeyOf('co.th'), 'co.th');
  assert.equal(hostKeyOf('www.co.th'), 'co.th');
  assert.equal(hostKeyOf('one.co.th'), 'one.co.th');
});

test('the country-code rule changes nothing for names it does not describe', () => {
  assert.equal(hostKeyOf('https://foo.co/'), 'foo.co', 'two labels are a site as they are');
  assert.equal(hostKeyOf('https://www.foo.co/'), 'foo.co');
  assert.equal(hostKeyOf('https://a.b.com/'), 'b.com', 'a three-letter top level is not a country code');
  assert.equal(hostKeyOf('https://a.b.org/'), 'b.org');
  assert.equal(hostKeyOf('https://x.example.pl/'), 'example.pl', 'a long second-level label is the site, not a suffix');
  assert.equal(hostKeyOf('https://api.mangadex.org/'), 'mangadex.org');
  assert.equal(hostKeyOf('https://cdn.readcomiconline.li/'), 'readcomiconline.li');
  assert.equal(hostKeyOf('https://x.b2.cn/'), 'b2.cn', 'only letters make a suffix label');
  assert.equal(hostKeyOf('https://a.xn--j1amh.ua/'), 'xn--j1amh.ua', 'nor does an internationalised label');
  // Listed suffixes, the shared hosts and IP literals keep answering as before.
  assert.equal(hostKeyOf('https://x.co.uk/'), 'x.co.uk');
  assert.equal(hostKeyOf('https://one.github.io/'), 'one.github.io');
  assert.equal(hostKeyOf('http://10.0.0.5/'), '10.0.0.5');
});
