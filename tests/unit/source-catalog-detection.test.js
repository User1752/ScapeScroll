'use strict';

// What the catalog works out in the background: the theme an extension is built on (its build file on GitHub), whether a site sits behind
// Cloudflare (its name in the DNS against Cloudflare's published ranges, never the site itself), and the queue both run in.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTheme, themeFolder, createThemeResolver } = require('../../server/modules/source-catalog/themes');
const { createCloudflareCheck, parseRanges, FALLBACK_V4, FALLBACK_V6 } = require('../../server/modules/source-catalog/cloudflare');
const { createWorkQueue } = require('../../server/modules/source-catalog/work-queue');
const { createTtlDiskCache } = require('../../server/modules/common/ttl-disk-cache');

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const until = async (condition) => { for (let i = 0; i < 200 && !condition(); i += 1) await tick(); };

// ── themes ────────────────────────────────────────────────────────────────

test('the theme is the one named in the build file; a file that names none is a scraper of its own site ("custom")', () => {
  assert.equal(parseTheme('plugins { id("x") }\next {\n    extName = "A"\n    theme = "madara"\n    baseUrl = "https://a.example"\n}'), 'madara');
  assert.equal(parseTheme('  theme = "mangathemesia"'), 'mangathemesia');
  assert.equal(parseTheme('ext { extName = "A"\n extClass = ".A" }'), 'custom');
  assert.equal(parseTheme(''), 'custom');
  assert.equal(parseTheme('// theme = "madara"'), 'custom', 'a comment is not a declaration');
  assert.equal(parseTheme('theme = "../../etc"'), 'custom', 'a value that is not a plain word is not taken');
});

test('the folder of an extension is built only from a package shaped like one', () => {
  assert.equal(themeFolder('eu.kanade.tachiyomi.extension.en.alpha'), 'en/alpha');
  for (const bad of ['', undefined, '../x', 'eu.kanade.tachiyomi.extension.en.a/../b', 'eu.kanade.tachiyomi.extension.en.', 'com.example.en.alpha']) assert.equal(themeFolder(bad), '', String(bad));
});

function themeRig({ answers = {}, now = () => Date.now() } = {}) {
  const asked = [];
  const cache = createTtlDiskCache();
  const resolver = createThemeResolver({
    baseUrl: 'https://raw.example/src/',
    cache,
    ttlMs: 1000,
    retryMs: 100,
    maxBytes: 1000,
    fetchText: async (url) => {
      asked.push(url);
      const answer = answers[url];
      if (answer instanceof Error) throw answer;
      return answer || { status: 404, text: '' };
    },
  });
  return { asked, cache, resolver, now };
}

test('a build file is read once and remembered; a missing file is an answer ("unknown"), not a failure', async () => {
  const { asked, resolver } = themeRig({ answers: { 'https://raw.example/src/en/alpha/build.gradle.kts': { status: 200, text: 'theme = "madara"' } } });
  assert.deepEqual(await resolver.resolve('eu.kanade.tachiyomi.extension.en.alpha'), { theme: 'madara', ok: true });
  assert.deepEqual(await resolver.known('eu.kanade.tachiyomi.extension.en.alpha'), { theme: 'madara', ok: true });
  assert.deepEqual(await resolver.resolve('eu.kanade.tachiyomi.extension.en.beta'), { theme: 'unknown', ok: true });
  assert.equal(asked.length, 2);
  assert.deepEqual(await resolver.resolve('../etc'), { theme: 'unknown', ok: true });
  assert.equal(asked.length, 2, 'a package that is not shaped like one asks nothing');
});

test('a failed read is remembered as a failure for a short while only', async () => {
  const url = 'https://raw.example/src/en/alpha/build.gradle.kts';
  const { cache, resolver } = themeRig({ answers: { [url]: new Error('offline') } });
  assert.deepEqual(await resolver.resolve('eu.kanade.tachiyomi.extension.en.alpha'), { theme: 'unknown', ok: false });
  assert.deepEqual(resolver.peek('eu.kanade.tachiyomi.extension.en.alpha'), { theme: 'unknown', ok: false }, 'known right after');
  await new Promise((resolve) => { setTimeout(resolve, 130); });
  assert.equal(resolver.peek('eu.kanade.tachiyomi.extension.en.alpha'), null, 'asked again after the retry time, long before the week');
  assert.ok(cache.getFresh('eu.kanade.tachiyomi.extension.en.alpha', 1000), 'the entry itself is still kept');
  const server = themeRig({ answers: { [url]: { status: 503, text: '' } } });
  assert.deepEqual(await server.resolver.resolve('eu.kanade.tachiyomi.extension.en.alpha'), { theme: 'unknown', ok: false }, 'a server error is a failure too');
});

// ── Cloudflare ────────────────────────────────────────────────────────────

test('a published list is read line by line and only address ranges are kept', () => {
  assert.deepEqual(parseRanges('173.245.48.0/20\r\n103.21.244.0/22\n\n<html>\n999.1.1.1/8\n10.0.0.0/40\n1.2.3.4', 'ipv4'), ['173.245.48.0/20', '103.21.244.0/22']);
  assert.deepEqual(parseRanges('2400:cb00::/32\n2606:4700::/32\n1.1.1.0/24', 'ipv6'), ['2400:cb00::/32', '2606:4700::/32']);
});

function cloudflareRig({ ranges = null, table = {} } = {}) {
  const asked = [];
  const cache = createTtlDiskCache();
  const check = createCloudflareCheck({
    urls: { v4: 'https://cf.example/v4', v6: 'https://cf.example/v6' },
    cache,
    ttlMs: 10_000,
    dnsTtlMs: 10_000,
    maxBytes: 1000,
    fetchText: async (url) => {
      asked.push(url);
      if (!ranges) throw new Error('offline');
      return { status: 200, text: url.endsWith('v4') ? ranges.v4 : ranges.v6 };
    },
    resolver: {
      resolve4: async (host) => { asked.push(`dns4:${host}`); const e = table[host]; if (e === 'nx') throw new Error('ENOTFOUND'); return (e && e.v4) || []; },
      resolve6: async (host) => { asked.push(`dns6:${host}`); const e = table[host]; if (e === 'nx') throw new Error('ENOTFOUND'); return (e && e.v6) || []; },
    },
  });
  return { check, asked, cache };
}

const PUBLISHED = { v4: FALLBACK_V4.join('\n'), v6: FALLBACK_V6.join('\n') };

test('a site is behind Cloudflare when its name answers an address in the published ranges (IPv4 or IPv6)', async () => {
  const { check } = cloudflareRig({ ranges: PUBLISHED, table: {
    'cf.example.org': { v4: ['104.16.1.1'] },
    'cf6.example.org': { v6: ['2606:4700::1'] },
    'plain.example.org': { v4: ['93.184.216.34'] },
    'mixed.example.org': { v4: ['93.184.216.34', '172.67.1.1'] },
  } });
  assert.equal(await check.check('cf.example.org'), 'yes');
  assert.equal(await check.check('cf6.example.org'), 'yes');
  assert.equal(await check.check('plain.example.org'), 'no');
  assert.equal(await check.check('mixed.example.org'), 'yes', 'one address in the ranges is enough');
});

test('a name that does not answer is "unknown"; a literal address, localhost and a bare word are never looked up', async () => {
  const { check, asked } = cloudflareRig({ ranges: PUBLISHED, table: { 'gone.example.org': 'nx' } });
  assert.equal(await check.check('gone.example.org'), 'unknown');
  for (const host of ['127.0.0.1', '::1', 'localhost', 'intranet', '', undefined]) assert.equal(await check.check(host), 'unknown', String(host));
  assert.deepEqual(asked.filter((entry) => entry.startsWith('dns')), ['dns4:gone.example.org', 'dns6:gone.example.org']);
});

test('an answer is remembered: the DNS is not asked again for the same name', async () => {
  const { check, asked } = cloudflareRig({ ranges: PUBLISHED, table: { 'cf.example.org': { v4: ['104.16.1.1'] } } });
  await check.check('cf.example.org');
  await check.check('CF.example.org');
  assert.equal(asked.filter((entry) => entry.startsWith('dns4')).length, 1);
  assert.equal(check.peek('cf.example.org'), 'yes');
  assert.equal(check.peek('other.example.org'), null);
});

test('when the published ranges cannot be fetched, or come back half empty, the ranges known when this was written are used', async () => {
  const offline = cloudflareRig({ ranges: null, table: { 'cf.example.org': { v4: ['104.16.1.1'] }, 'plain.example.org': { v4: ['93.184.216.34'] } } });
  assert.equal(await offline.check.check('cf.example.org'), 'yes');
  assert.equal(await offline.check.check('plain.example.org'), 'no');
  const empty = cloudflareRig({ ranges: { v4: '<html>error</html>', v6: '' }, table: { 'cf.example.org': { v4: ['104.16.1.1'] } } });
  assert.equal(await empty.check.check('cf.example.org'), 'yes', 'an empty list is not trusted');
});

test('a fresh published list replaces the known one', async () => {
  const { check } = cloudflareRig({
    ranges: { v4: ['198.51.100.0/24', '10.1.0.0/16', '10.2.0.0/16', '10.3.0.0/16', '10.4.0.0/16'].join('\n'), v6: ['2001:db8::/32', '2001:db9::/32', '2001:dba::/32'].join('\n') },
    table: { 'new.example.org': { v4: ['198.51.100.7'] }, 'old.example.org': { v4: ['104.16.1.1'] } },
  });
  assert.equal(await check.check('new.example.org'), 'yes');
  assert.equal(await check.check('old.example.org'), 'no', 'the published list is the one in use, not the old one');
});

// ── the queue ─────────────────────────────────────────────────────────────

const queueOf = (over = {}) => createWorkQueue({ concurrency: 2, spacingMs: 0, breakerCount: 3, breakerMs: 1000, sleep: tick, ...over });

test('the queue runs a few jobs at a time and one job per key', async () => {
  const queue = queueOf();
  let running = 0;
  let peak = 0;
  const done = [];
  const job = (name) => async () => { running += 1; peak = Math.max(peak, running); await tick(); await tick(); running -= 1; done.push(name); };
  const added = ['a', 'b', 'c', 'd', 'a', 'b'].map((name) => queue.add(name, job(name)));
  assert.deepEqual(added, [true, true, true, true, false, false], 'a key that is waiting is not queued twice');
  await until(() => queue.size() === 0);
  assert.deepEqual(done.sort(), ['a', 'b', 'c', 'd']);
  assert.equal(peak, 2);
  assert.equal(queue.add('a', job('a')), true, 'a key that has finished can be queued again');
  await until(() => queue.size() === 0);
});

test('after several failures in a row the queue stops starting jobs for a while, then goes on', async () => {
  let clock = 0;
  const queue = queueOf({ now: () => clock, concurrency: 1 });
  const ran = [];
  for (const name of ['f1', 'f2', 'f3']) queue.add(name, async () => { ran.push(name); throw new Error('down'); });
  await until(() => ran.length === 3 && queue.size() === 0);
  assert.equal(queue.paused(), true);
  queue.add('later', async () => { ran.push('later'); });
  for (let i = 0; i < 20; i += 1) await tick();
  assert.ok(!ran.includes('later'), 'nothing starts while the breaker is open');
  clock = 5000;
  await until(() => ran.includes('later'));
  assert.equal(queue.paused(), false);
});

test('a success in between resets the count of failures, and a job that throws never reaches the caller', async () => {
  const queue = queueOf({ concurrency: 1 });
  const ran = [];
  const outcomes = [false, false, true, false, false, true];
  outcomes.forEach((ok, i) => queue.add(`j${i}`, async () => { ran.push(i); if (!ok) throw new Error('x'); }));
  await until(() => ran.length === outcomes.length && queue.size() === 0);
  assert.equal(queue.paused(), false);
  queue.add('boom', () => { throw new Error('sync throw'); });
  await until(() => queue.size() === 0);
});

test('clear drops what has not started', async () => {
  const queue = queueOf({ concurrency: 1 });
  const ran = [];
  const gate = [];
  queue.add('first', () => new Promise((resolve) => { gate.push(resolve); }));
  for (const name of ['x', 'y']) queue.add(name, async () => { ran.push(name); });
  await until(() => gate.length === 1);
  queue.clear();
  gate[0]();
  await until(() => queue.size() === 0);
  assert.deepEqual(ran, []);
  assert.equal(queue.has('x'), false);
});
