'use strict';

// The live Test of an anime source (server/modules/anime-sources/live-test.js): what makes an episode PLAY, followed through the relay of
// the app. The registry is simulated (or, in the last tests, the real registry and relay over a simulated network): nothing here reaches a
// real site, and nothing is ever played.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createAnimeLiveTest, CHECK_IDS, TITLES, targetOf, mediaKind } = require('../../server/modules/anime-sources/live-test');
const { CHECK_IDS: CARD_CHECK_IDS } = require('../../server/modules/source-import/live-test');
const { createAnimeRegistry } = require('../../server/modules/anime-sources/registry');
const { withTimeout } = require('../../server/modules/common/async-utils');
const animeImportRoutes = require('../../server/routes/anime-source-import');
const { isPrivilegedRoute } = require('../../server/middleware/local-only');

const sleep = async () => {};
const via = (id, url) => `/api/anime/${id}/hls-proxy?url=${encodeURIComponent(url)}`;
const TS = Buffer.concat([Buffer.from([0x47]), Buffer.alloc(187), Buffer.from([0x47]), Buffer.alloc(100)]);
const MASTER = (id) => `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n${via(id, 'https://cdn.example/v/low.m3u8')}\n`;
const MEDIA = (id, extra = '') => `#EXTM3U\n${extra}#EXTINF:4,\n${via(id, 'https://cdn.example/v/s0.ts')}\n#EXTINF:4,\n${via(id, 'https://cdn.example/v/s1.ts')}\n`;
const notFound = (message = 'not found') => Object.assign(new Error(message), { statusCode: 404 });

// A registry whose answers are the ones the test gives: `known` titles resolve (episode 1 only), everything else is a 404.
function fakeRegistry({ known = [TITLES[0].title], src, subtitles = [], resources = {}, resolveError, relayError } = {}) {
  const asked = [];
  return {
    asked,
    resolveStream: async (id, req) => {
      asked.push(`${req.title}#${req.episode}`);
      if (resolveError) throw resolveError;
      if (!known.includes(req.title) || req.episode !== 1) throw notFound(`no "${req.title}" episode ${req.episode}`);
      return { src: src || via(id, 'https://cdn.example/v/master.m3u8'), subtitles, availableQualities: [] };
    },
    relay: async (id, url) => {
      asked.push(`relay ${url}`);
      if (relayError) throw relayError;
      const hit = resources[url];
      if (hit === undefined) throw new Error('HTTP 404');
      return hit;
    },
  };
}
const goodResources = (id = 'demo', over = {}) => ({
  'https://cdn.example/v/master.m3u8': { contentType: 'application/vnd.apple.mpegurl', body: MASTER(id) },
  'https://cdn.example/v/low.m3u8': { contentType: 'application/vnd.apple.mpegurl', body: MEDIA(id) },
  'https://cdn.example/v/s0.ts': { contentType: 'video/mp2t', body: TS },
  ...over,
});
const runOver = (registry, limits) => createAnimeLiveTest({ registry, sleep, withTimeout, limits })({ id: 'demo' });
const statuses = (result) => Object.fromEntries(result.checks.map((c) => [c.id, c.status]));

test('a source whose stream plays passes every check, and is verified', async () => {
  const registry = fakeRegistry({ resources: goodResources() });
  const result = await runOver(registry);
  assert.deepEqual(statuses(result), { 'anime-stream': 'pass', 'anime-playlist': 'pass', 'anime-variant': 'pass', 'anime-segment': 'pass', 'anime-subtitles': 'skip', 'anime-bad-input': 'pass', 'anime-past-end': 'pass' });
  assert.equal(result.verified, true);
  assert.deepEqual([result.depth, result.aborted, result.counts], ['basic', '', { pass: 6, fail: 0, warn: 0, skip: 1 }]);
  assert.match(result.checks.find((c) => c.id === 'anime-segment').detail, /mpeg-ts/);
  assert.deepEqual(result.checks.map((c) => c.id), CHECK_IDS, 'every check, in order');
  assert.equal(result.calls, 6, 'one call per step that asks the source or the relay');
});

test('every check id has a translated title in the card (they are in its shared list)', () => {
  for (const id of CHECK_IDS) assert.ok(CARD_CHECK_IDS.includes(id), id);
  assert.equal(new Set(CARD_CHECK_IDS).size, CARD_CHECK_IDS.length);
});

test('a playlist that lists the segments directly skips the variant step; a title is tried until one resolves', async () => {
  const resources = goodResources('demo', { 'https://cdn.example/v/master.m3u8': { contentType: 'application/x-mpegurl', body: MEDIA('demo') } });
  const registry = fakeRegistry({ known: [TITLES[2].title], resources });
  const result = await runOver(registry);
  assert.equal(statuses(result)['anime-variant'], 'skip');
  assert.equal(statuses(result)['anime-segment'], 'pass');
  assert.deepEqual(registry.asked.filter((a) => /#1$/.test(a)).slice(0, 3), [`${TITLES[0].title}#1`, `${TITLES[1].title}#1`, `${TITLES[2].title}#1`], 'the first two were not in the catalogue');
  assert.equal(result.verified, true);
});

test('when no title resolves the stream check fails and says what was tried; the rest is not pretended', async () => {
  const result = await runOver(fakeRegistry({ known: [] }));
  const s = statuses(result);
  assert.equal(s['anime-stream'], 'fail');
  assert.match(result.checks[0].detail, /Sousou no Frieren: no "Sousou no Frieren" episode 1/);
  assert.deepEqual([s['anime-playlist'], s['anime-variant'], s['anime-segment'], s['anime-subtitles'], s['anime-past-end']], ['skip', 'skip', 'skip', 'skip', 'skip']);
  assert.equal(result.verified, false);
});

test('a playlist whose addresses bypass the app, a stream address that is not the app\'s, a page instead of video, and an empty segment all fail', async () => {
  const bypass = await runOver(fakeRegistry({ resources: goodResources('demo', { 'https://cdn.example/v/master.m3u8': { contentType: 'application/vnd.apple.mpegurl', body: '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://cdn.example/v/low.m3u8\n' } }) }));
  assert.match(bypass.checks.find((c) => c.id === 'anime-playlist').detail, /do not go through the app/);
  assert.equal(bypass.verified, false);

  const raw = await runOver(fakeRegistry({ src: 'https://cdn.example/v/master.m3u8', resources: goodResources() }));
  assert.match(raw.checks[0].detail, /not one of the app/);

  const html = await runOver(fakeRegistry({ resources: goodResources('demo', { 'https://cdn.example/v/s0.ts': { contentType: 'text/html', body: Buffer.from('<html><body>Access denied</body></html>') } }) }));
  assert.equal(statuses(html)['anime-segment'], 'fail');
  assert.match(html.checks.find((c) => c.id === 'anime-segment').detail, /not video/);

  const empty = await runOver(fakeRegistry({ resources: goodResources('demo', { 'https://cdn.example/v/s0.ts': { contentType: 'video/mp2t', body: Buffer.alloc(0) } }) }));
  assert.match(empty.checks.find((c) => c.id === 'anime-segment').detail, /empty/);

  const notList = await runOver(fakeRegistry({ resources: goodResources('demo', { 'https://cdn.example/v/master.m3u8': { contentType: 'text/html', body: '<html>blocked</html>' } }) }));
  assert.match(notList.checks.find((c) => c.id === 'anime-playlist').detail, /not an HLS playlist/);
});

test('an encrypted stream is checked as far as it can be without a player: the segment and its key (16 bytes, through the app) are fetched, nothing is decrypted', async () => {
  const encrypted = (keyUri, keyBody) => {
    const key = keyUri === undefined ? '#EXT-X-KEY:METHOD=AES-128\n' : `#EXT-X-KEY:METHOD=AES-128,URI="${keyUri}"\n`;
    return goodResources('demo', {
      'https://cdn.example/v/low.m3u8': { contentType: 'application/vnd.apple.mpegurl', body: MEDIA('demo', key) },
      'https://cdn.example/v/s0.ts': { contentType: 'video/mp2t', body: Buffer.alloc(500, 7) },
      'https://cdn.example/v/key.bin': { contentType: 'application/octet-stream', body: keyBody },
    });
  };
  const segment = async (keyUri, keyBody) => {
    const result = await runOver(fakeRegistry({ resources: encrypted(keyUri, keyBody) }));
    return result.checks.find((c) => c.id === 'anime-segment');
  };
  const good = await segment(via('demo', 'https://cdn.example/v/key.bin'), Buffer.alloc(16, 1));
  assert.equal(good.status, 'pass');
  assert.match(good.detail, /encrypted and was fetched.*its key \(16 bytes\).*not decrypted/);
  const small = await segment(via('demo', 'https://cdn.example/v/key.bin'), Buffer.alloc(5, 1));
  assert.equal(small.status, 'fail');
  assert.match(small.detail, /key is 5 bytes, not 16/);
  const raw = await segment('https://cdn.example/v/key.bin', Buffer.alloc(16, 1));
  assert.equal(raw.status, 'fail');
  assert.match(raw.detail, /the key is not an address of the app/);
  const none = await segment(undefined);
  assert.equal(none.status, 'warn');
  assert.match(none.detail, /names no key address/);
});

test('subtitles: WebVTT passes, ASS and anything else is a warning the player cannot show, none is skipped', async () => {
  const withSub = (body) => runOver(fakeRegistry({ subtitles: [{ lang: 'en', label: 'English', src: via('demo', 'https://cdn.example/s/en') }], resources: goodResources('demo', { 'https://cdn.example/s/en': { contentType: 'text/vtt', body } }) }));
  assert.equal(statuses(await withSub('WEBVTT\n\n00:00.000 --> 00:01.000\nHi'))['anime-subtitles'], 'pass');
  assert.equal(statuses(await withSub('﻿WEBVTT\n'))['anime-subtitles'], 'pass', 'a byte order mark is not a reason to refuse');
  const ass = await withSub('[Script Info]\nTitle: x');
  assert.equal(statuses(ass)['anime-subtitles'], 'warn');
  assert.match(ass.checks.find((c) => c.id === 'anime-subtitles').detail, /ASS/);
  assert.equal(statuses(await withSub('<html>'))['anime-subtitles'], 'warn');
  assert.equal(ass.verified, true, 'a warning does not unverify');
});

test('a title or an episode that does not exist must be refused; a source that answers anything gets a warning; a site that is not answering fails', async () => {
  const lax = fakeRegistry({ resources: goodResources() });
  const original = lax.resolveStream;
  lax.resolveStream = async (id, req) => (req.title === 'zzqx no such anime 7f3a91' || req.episode === 9999 ? { src: via(id, 'https://cdn.example/v/master.m3u8'), subtitles: [] } : original(id, req));
  const result = await runOver(lax);
  assert.deepEqual([statuses(result)['anime-bad-input'], statuses(result)['anime-past-end']], ['warn', 'warn']);
  assert.equal(result.verified, true);

  const down = fakeRegistry({ resources: goodResources() });
  const real = down.resolveStream;
  down.resolveStream = async (id, req) => { if (req.episode === 9999) throw new Error('HTTP 503'); return real(id, req); };
  assert.equal(statuses(await runOver(down))['anime-past-end'], 'fail');
});

test('it stops after three failures in a row, like the manga test, and what is left is not run', async () => {
  const result = await runOver(fakeRegistry({ resolveError: new Error('HTTP 503') }));
  assert.match(result.aborted, /3 calls failed in a row/);
  assert.equal(result.verified, false);
  assert.equal(result.calls, 3);
  assert.ok(result.checks.slice(1).every((c) => c.status === 'skip'));
  const slow = await runOver(fakeRegistry({ resources: goodResources() }), { maxCalls: 2 });
  assert.match(slow.aborted, /call budget/);
  assert.equal(slow.verified, false);
});

test('the small readers: where a link of the app points, and what the first bytes of a segment are', () => {
  assert.deepEqual(targetOf('/api/anime/x/hls-proxy?url=https%3A%2F%2Fa.example%2Fm.m3u8&ref=https%3A%2F%2Fr.example%2F'), { url: 'https://a.example/m.m3u8', ref: 'https://r.example/' });
  assert.equal(targetOf('https://a.example/m.m3u8'), null);
  assert.equal(targetOf('/other/path?url=x'), null);
  assert.equal(targetOf('/api/anime/x/hls-proxy'), null);
  assert.equal(targetOf(undefined), null);
  assert.equal(mediaKind(TS), 'mpeg-ts');
  assert.equal(mediaKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)])), 'mp4');
  assert.equal(mediaKind(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 5, 6, 7, 8])), 'webm');
  assert.equal(mediaKind(Buffer.from('<html><body>denied</body></html>')), '');
  assert.equal(mediaKind(Buffer.alloc(3)), '');
});

// ── The real registry and relay, over a simulated network, and the route ──

const STREAM_SOURCE = {
  meta: { id: 'demo', name: 'Demo', keyedBy: 'title', stream: { hosts: ['cdn.example'] } },
  getStreamSources: async ({ title, episode }) => {
    if (episode !== 1 || title !== TITLES[0].title) throw notFound('no such episode');
    return { src: 'https://cdn.example/v/master.m3u8', subtitles: [{ lang: 'en', label: 'English', default: true, src: 'https://cdn.example/s/en.vtt' }] };
  },
};
const SITE = {
  'https://cdn.example/v/master.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n'],
  'https://cdn.example/v/low.m3u8': ['application/vnd.apple.mpegurl', '#EXTM3U\n#EXTINF:4,\ns0.ts\n#EXTINF:4,\ns1.ts\n'],
  'https://cdn.example/v/s0.ts': ['video/mp2t', TS],
  'https://cdn.example/s/en.vtt': ['text/vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi'],
};
const fetchImpl = async (url) => {
  const hit = SITE[url];
  return hit ? new Response(hit[1], { status: 200, headers: { 'content-type': hit[0] } }) : new Response('no', { status: 404 });
};

test('end to end over the real relay: the playlists are rewritten, followed, and the whole checklist passes', async () => {
  const registry = createAnimeRegistry({ relayDeps: { fetchImpl, assertPublic: async () => {} } });
  registry.register(STREAM_SOURCE);
  const result = await createAnimeLiveTest({ registry, sleep, withTimeout })({ id: 'demo' });
  assert.deepEqual(statuses(result), { 'anime-stream': 'pass', 'anime-playlist': 'pass', 'anime-variant': 'pass', 'anime-segment': 'pass', 'anime-subtitles': 'pass', 'anime-bad-input': 'pass', 'anime-past-end': 'pass' });
  assert.equal(result.verified, true);
});

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-anime-livetest-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

async function startRoute(t, registry) {
  animeImportRoutes.configure({ stagingDir: path.join(root, 'staging'), sourcesDir: path.join(root, 'sources'), loadCandidate: () => ({}), registry, warn: () => {}, testDeps: { sleep } });
  const app = express();
  app.use(express.json());
  animeImportRoutes.registerAnimeSourceImportRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  return (body, headers = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/anime/sources/import/test', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('the route is on the guard list, local-only, rate limited, refuses what is not an anime source, and runs one test at a time', async (t) => {
  assert.equal(isPrivilegedRoute({ method: 'POST', originalUrl: '/api/anime/sources/import/TEST/' }), true);
  const registry = createAnimeRegistry({ relayDeps: { fetchImpl, assertPublic: async () => {} } });
  registry.register(STREAM_SOURCE);
  const send = await startRoute(t, registry);

  for (const headers of [{ Host: 'localhost.evil.example' }, { 'X-Forwarded-For': '203.0.113.9' }, { Origin: 'https://evil.example' }]) assert.equal((await send({ id: 'demo' }, headers)).status, 403, JSON.stringify(headers));
  assert.equal((await send({ id: 'nothere' })).status, 404);
  assert.equal((await send({})).status, 400);
  assert.equal((await send({ id: 5 })).status, 400);

  const ok = await send({ id: 'demo' });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.ok, ok.body.verified, ok.body.depth, ok.body.checks.length], [true, true, 'basic', 7]);
});

test('a second test while one runs is refused, and the limit is a few a minute', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const registry = createAnimeRegistry({ relayDeps: { fetchImpl, assertPublic: async () => {} } });
  registry.register({ ...STREAM_SOURCE, getStreamSources: async (r) => { await gate; return STREAM_SOURCE.getStreamSources(r); } });
  const send = await startRoute(t, registry);
  const first = send({ id: 'demo' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await send({ id: 'demo' });
  assert.equal(second.status, 409);
  release();
  assert.equal((await first).status, 200);
  const statusesSeen = [];
  for (let i = 0; i < 6; i += 1) statusesSeen.push((await send({ id: 'nothere' })).status);
  assert.ok(statusesSeen.includes(429), `got ${statusesSeen}`);
});

test('a resource that cannot be fetched is named in the failure, and it is one failed step, not the end of the run', async () => {
  const result = await runOver(fakeRegistry({ relayError: new Error('fetch failed') }));
  assert.equal(statuses(result)['anime-playlist'], 'fail');
  assert.match(result.checks.find((c) => c.id === 'anime-playlist').detail, /^the playlist could not be fetched: fetch failed/);
  assert.equal(result.verified, false);
  assert.equal(result.aborted, '', 'one failed resource is a failed step, not the end of the run');
});

test('a test that takes longer than the blanket /api timeout is not cut off with a 504: the route extends it', async (t) => {
  const { apiTimeout } = require('../../server/middleware/security');
  const registry = createAnimeRegistry({ relayDeps: { fetchImpl, assertPublic: async () => {} } });
  registry.register({ ...STREAM_SOURCE, getStreamSources: async (r) => { await new Promise((resolve) => setTimeout(resolve, 450)); return STREAM_SOURCE.getStreamSources(r); } });
  animeImportRoutes.configure({ stagingDir: path.join(root, 'staging'), sourcesDir: path.join(root, 'sources'), loadCandidate: () => ({}), registry, warn: () => {}, testDeps: { sleep } });
  const app = express();
  app.use(express.json());
  app.use('/api', apiTimeout(150)); // what server.js does, with 30 s; short here so the test is fast
  animeImportRoutes.registerAnimeSourceImportRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const answer = await new Promise((resolve, reject) => {
    const payload = JSON.stringify({ id: 'demo' });
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/anime/sources/import/test', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
  assert.equal(answer.status, 200, `got ${answer.status} ${JSON.stringify(answer.body).slice(0, 80)}`);
  assert.equal(answer.body.ok, true);
});

test('a run that stops on the site\'s bot protection says so plainly, not as a rate limit that hides it', async () => {
  const blocked = new Error('Cloudflare blocked the browser solver for this site; cooling down before the next try.');
  const cooling = Object.assign(new Error('This site is rate-limited, cooling down before the next try.'), { rateLimited: true });
  let n = 0;
  const registry = fakeRegistry({ resources: goodResources() });
  registry.resolveStream = async () => { n += 1; throw n === 1 ? blocked : cooling; };
  const result = await runOver(registry);
  assert.match(result.aborted, /^3 calls failed in a row: the site's bot protection refused the app's browser/);
  assert.match(result.aborted, /Not necessarily a ban of this IP/);
  assert.equal(result.verified, false);
  assert.ok(result.checks.every((c) => c.detail.length <= 300));
  const plain = await runOver(fakeRegistry({ resolveError: new Error('HTTP 503') }));
  assert.match(plain.aborted, /3 calls failed in a row \(HTTP 503\)/, 'any other failure keeps its own words');
});
