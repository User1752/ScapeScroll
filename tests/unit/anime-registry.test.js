'use strict';

// The anime source registry (server/modules/anime-sources/): the contract a source is judged against, the registry that holds the
// five that ship with the app, the generic relay for a source that only declares the hosts its video lives on, and the routes that
// now ask the registry instead of naming a provider. The network is replaced; nothing here reaches a real site.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { checkAnimeSource } = require('../../server/modules/anime-sources/contract');
const { createAnimeRegistry } = require('../../server/modules/anime-sources/registry');
const { registerBundled } = require('../helpers/fake-bundled');
const { createStreamRelay, hostAllowed, cleanReferer } = require('../../server/modules/anime-sources/relay');

const goodSource = (over = {}) => ({
  meta: { id: 'mysite', name: 'My Site', keyedBy: 'title', ...(over.meta || {}) },
  getStreamSources: async () => ({ src: 'https://own.example/p.m3u8', subtitles: [] }),
  fetchHlsResource: async (url) => ({ contentType: 'video/mp4', body: Buffer.from(`own:${url}`) }),
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'meta')),
});
const streamSource = (stream = { hosts: ['cdn.example'] }, over = {}) => {
  const rest = goodSource(over);
  delete rest.fetchHlsResource;
  return { ...rest, meta: { ...rest.meta, stream } };
};

// ── The contract ──────────────────────────────────────────────────────────

test('a source that follows the contract is accepted, with the defaults filled in', () => {
  const verdict = checkAnimeSource(goodSource());
  assert.equal(verdict.ok, true, verdict.problems.join(' '));
  assert.deepEqual(verdict.meta, { id: 'mysite', name: 'My Site', version: '1.0.0', author: '', keyedBy: 'title', features: { dub: false, quality: false, format: false }, warning: '', health: true, stream: null });
  const featured = checkAnimeSource(goodSource({ meta: { features: { dub: true, quality: 'yes', other: true }, health: false, warning: 'Careful.\n\n  Read this.' } })).meta;
  assert.deepEqual(featured.features, { dub: true, quality: false, format: false }, 'only a literal true turns a feature on, and unknown ones are dropped');
  assert.equal(featured.health, false);
  assert.equal(featured.warning, 'Careful. Read this.');
});

test('what is wrong with a source is said, one problem at a time', () => {
  const problems = (mod) => checkAnimeSource(mod).problems.join(' | ');
  assert.match(problems(null), /does not export meta/);
  assert.match(problems(goodSource({ meta: { id: 'Bad Id' } })), /meta\.id/);
  assert.match(problems(goodSource({ meta: { id: 'x' } })), /meta\.id/, 'too short');
  assert.match(problems(goodSource({ meta: { name: '  ' } })), /meta\.name/);
  assert.match(problems(goodSource({ meta: { keyedBy: 'imdb' } })), /keyedBy/);
  assert.match(problems(goodSource({ getStreamSources: undefined })), /getStreamSources/);
  assert.match(problems(goodSource({ healthCheck: 5 })), /healthCheck/);
  const noRelay = goodSource();
  delete noRelay.fetchHlsResource;
  assert.match(problems(noRelay), /either fetchHlsResource\(\) or meta\.stream/);
  assert.match(problems({ ...goodSource(), meta: { ...goodSource().meta, stream: { hosts: ['cdn.example'] } } }), /not both/);
});

test('the hosts and the Referer a source declares are checked: names only, https only, a few', () => {
  const stream = (s) => checkAnimeSource(streamSource(s));
  assert.equal(stream({ hosts: ['cdn.example', 'CDN.Example', 'v.cdn.example'] }).meta.stream.hosts.length, 2, 'lower-cased and de-duplicated');
  for (const hosts of [[], undefined, ['https://cdn.example'], ['cdn.example/path'], ['cdn.example:8080'], ['localhost'], ['127.0.0.1'], ['a b.example'], Array.from({ length: 13 }, (_, i) => `h${i}.example`)]) {
    assert.equal(stream({ hosts }).ok, false, JSON.stringify(hosts));
  }
  assert.equal(stream({ hosts: ['cdn.example'], referer: 'http://site.example/' }).ok, false, 'a Referer is https');
  assert.equal(stream({ hosts: ['cdn.example'], referer: 'https://site.example/' }).meta.stream.referer, 'https://site.example/');
  assert.equal(stream({ hosts: ['cdn.example'], refererFromLink: true }).meta.stream.refererFromLink, true);
  assert.equal(checkAnimeSource(streamSource('cdn.example')).ok, false);
});

// ── The registry and the five that ship ───────────────────────────────────

const shipped = () => registerBundled(createAnimeRegistry());

test('a source is added once; an imported one can be replaced and removed, one that ships cannot', () => {
  const registry = shipped();
  registry.register(goodSource());
  assert.equal(registry.has('mysite'), true);
  assert.equal(registry.list().at(-1).id, 'mysite');
  assert.equal(registry.list().at(-1).origin, 'imported');
  assert.throws(() => registry.register(goodSource()), (e) => e.statusCode === 409);
  registry.register(goodSource({ meta: { name: 'My Site 2' } }), { replace: true });
  assert.equal(registry.list().find((s) => s.id === 'mysite').name, 'My Site 2');
  assert.throws(() => registry.register(goodSource({ meta: { id: 'shipped-a' } }), { replace: true }), (e) => e.statusCode === 409, 'a bundled id is never taken over');
  assert.throws(() => registry.unregister('shipped-a'), (e) => e.statusCode === 409);
  assert.equal(registry.unregister('mysite'), true);
  assert.equal(registry.unregister('mysite'), false);
  assert.throws(() => registry.register({ meta: { id: 'x' } }), (e) => e.statusCode === 400 && /not an anime source/.test(e.message));
});

// ── Finding a stream ──────────────────────────────────────────────────────

test('a request is checked against what the source is keyed by, and only what it understands is passed on', async () => {
  const seen = [];
  const registry = createAnimeRegistry();
  registry.register({ ...goodSource({ meta: { id: 'bytitle' } }), getStreamSources: async (r) => { seen.push(r); return { src: 'https://own.example/a.m3u8' }; } });
  registry.register({ ...goodSource({ meta: { id: 'bymal', keyedBy: 'mal', features: { dub: true } } }), getStreamSources: async (r) => { seen.push(r); return { src: 'https://own.example/b.m3u8' }; } });

  await assert.rejects(registry.resolveStream('bytitle', { episode: 1 }), (e) => e.statusCode === 400 && /title is required for the bytitle provider/.test(e.message));
  await assert.rejects(registry.resolveStream('bymal', { episode: 1, title: 'x' }), (e) => e.statusCode === 400 && /malId is required for the bymal provider/.test(e.message));
  await assert.rejects(registry.resolveStream('bymal', { malId: 1 }), (e) => e.statusCode === 400 && /episode is required/.test(e.message));
  await assert.rejects(registry.resolveStream('nope', { episode: 1 }), (e) => e.statusCode === 404);
  await assert.rejects(registry.resolveStream('__proto__', { episode: 1 }), (e) => e.statusCode === 404);

  await registry.resolveStream('bytitle', { title: 'T', episode: 3, dub: true, quality: '720', format: 'MOVIE', malId: 5 });
  await registry.resolveStream('bymal', { malId: 5, episode: 2, dub: true, quality: '720', format: 'TV' });
  assert.deepEqual(seen[0], { malId: 5, title: 'T', episode: 3, dub: false, quality: undefined, format: undefined }, 'a source that does not understand dub, quality or format never sees them');
  assert.deepEqual([seen[1].dub, seen[1].quality, seen[1].format], [true, undefined, undefined]);
});

test('the answer always has subtitles and qualities as lists, keeps what a source adds, and refuses an answer with no video', async () => {
  const registry = createAnimeRegistry();
  registry.register({ ...goodSource({ meta: { id: 'aa' } }), getStreamSources: async () => ({ src: '/api/anime/aa/hls-proxy?url=x', quality: '720', extra: 1 }) });
  registry.register({ ...goodSource({ meta: { id: 'bb' } }), getStreamSources: async () => ({ src: '' }) });
  registry.register({ ...goodSource({ meta: { id: 'cc' } }), getStreamSources: async () => null });
  const out = await registry.resolveStream('aa', { title: 'T', episode: 1 });
  assert.deepEqual(out, { src: '/api/anime/aa/hls-proxy?url=x', quality: '720', extra: 1, subtitles: [], availableQualities: [] });
  await assert.rejects(registry.resolveStream('bb', { title: 'T', episode: 1 }), /did not return a video address/);
  await assert.rejects(registry.resolveStream('cc', { title: 'T', episode: 1 }), /did not return a video address/);
});

test('a source that declares its hosts returns real addresses, which come back through this app; others are refused or dropped', async () => {
  const registry = createAnimeRegistry();
  const answer = { src: 'https://v.cdn.example/1/master.m3u8', referer: 'https://site.example/watch/1', subtitles: [{ lang: 'en', label: 'English', default: true, src: 'https://cdn.example/s/en.vtt' }, { lang: 'xx', label: 'Elsewhere', src: 'https://elsewhere.example/s.vtt' }, { lang: 'yy', label: 'Empty' }] };
  registry.register({ ...streamSource({ hosts: ['cdn.example'], refererFromLink: true }, { meta: { id: 'declared' } }), getStreamSources: async () => answer });
  const out = await registry.resolveStream('declared', { title: 'T', episode: 1 });
  assert.equal(out.src, `/api/anime/declared/hls-proxy?url=${encodeURIComponent(answer.src)}&ref=${encodeURIComponent(answer.referer)}`);
  assert.deepEqual(out.subtitles.map((s) => s.lang), ['en'], 'a subtitle on another host is dropped, one with no address too');
  assert.match(out.subtitles[0].src, /^\/api\/anime\/declared\/hls-proxy\?url=/);
  assert.equal(out.referer, undefined, 'the Referer is in the links, not repeated');

  registry.register({ ...streamSource({ hosts: ['cdn.example'] }, { meta: { id: 'wrong' } }), getStreamSources: async () => ({ src: 'https://evil.example/x.m3u8' }) });
  await assert.rejects(registry.resolveStream('wrong', { title: 'T', episode: 1 }), /outside the hosts it declares/);
  registry.register({ ...streamSource({ hosts: ['cdn.example'] }, { meta: { id: 'plain' } }), getStreamSources: async () => ({ src: 'http://cdn.example/x.m3u8' }) });
  assert.match((await registry.resolveStream('plain', { title: 'T', episode: 1 })).src, /^\/api\/anime\/plain\/hls-proxy/, 'the address the player gets is always this app\'s own');
});

test('a source with its own relay is relayed by that relay, and one without a relay has none to ask', async () => {
  const registry = createAnimeRegistry();
  registry.register(goodSource());
  const out = await registry.relay('mysite', 'https://own.example/seg.ts', 'https://ref.example/');
  assert.equal(out.body.toString(), 'own:https://own.example/seg.ts');
  await assert.rejects(registry.relay('nope', 'https://x.example/'), (e) => e.statusCode === 404);
});

// ── The generic relay ─────────────────────────────────────────────────────

function relayOver(responder, stream = { hosts: ['cdn.example'], referer: '', refererFromLink: false }) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, headers: init.headers }); return responder(url, init); };
  const relay = createStreamRelay({ id: 'x', stream }, { fetchImpl, assertPublic: async () => {} });
  return { relay, calls };
}
const PLAYLIST = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subs/en.vtt"\n\nhttps://cdn.example/abs/seg.ts\n';

test('only the hosts a source declared are relayed: a lookalike, another scheme or a redirect elsewhere is refused', async () => {
  assert.equal(hostAllowed('cdn.example', ['cdn.example']), true);
  assert.equal(hostAllowed('v1.cdn.example', ['cdn.example']), true);
  assert.equal(hostAllowed('evilcdn.example', ['cdn.example']), false);
  assert.equal(hostAllowed('cdn.example.evil.com', ['cdn.example']), false);
  assert.equal(hostAllowed('', ['cdn.example']), false);

  const { relay, calls } = relayOver(async () => new Response('x', { status: 200, headers: { 'content-type': 'video/mp2t' } }));
  for (const bad of ['https://evil.example/a.ts', 'https://evilcdn.example/a.ts', 'https://cdn.example.evil.com/a.ts']) {
    await assert.rejects(relay.fetchResource(bad), (e) => e.statusCode === 403, bad);
  }
  await assert.rejects(relay.fetchResource('http://cdn.example/a.ts'), (e) => e.statusCode === 400);
  await assert.rejects(relay.fetchResource('not a url'), (e) => e.statusCode === 400);
  assert.equal(calls.length, 0, 'a refused address asked nobody for anything');

  const hop = relayOver(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }));
  await assert.rejects(hop.relay.fetchResource('https://cdn.example/a.ts'), (e) => e.statusCode === 403 && /Redirected to a host/.test(e.message));
  assert.equal(hop.calls.length, 1, 'the redirect was not followed');
});

test('a playlist comes back with every address, including keys and subtitle files, pointing at this app', async () => {
  const { relay } = relayOver(async () => new Response(PLAYLIST, { status: 200, headers: { 'content-type': 'text/plain' } }));
  const out = await relay.fetchResource('https://cdn.example/v/master.m3u8');
  assert.equal(out.isPlaylist, true);
  assert.equal(out.contentType, 'application/vnd.apple.mpegurl');
  const via = (abs) => `/api/anime/x/hls-proxy?url=${encodeURIComponent(abs)}`;
  assert.equal(out.body, `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${via('https://cdn.example/v/key.bin')}"\n#EXT-X-STREAM-INF:BANDWIDTH=1\n${via('https://cdn.example/v/low/index.m3u8')}\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="${via('https://cdn.example/v/subs/en.vtt')}"\n\n${via('https://cdn.example/abs/seg.ts')}\n`);
});

test('the Referer is the one the source declared, or the one in the link (https, short), and it travels on to every address of a playlist', async () => {
  const fixed = relayOver(async () => new Response('x', { status: 200 }), { hosts: ['cdn.example'], referer: 'https://site.example/', refererFromLink: false });
  await fixed.relay.fetchResource('https://cdn.example/a.ts', 'https://other.example/ignored');
  assert.equal(fixed.calls[0].headers.Referer, 'https://site.example/');

  const linked = relayOver(async () => new Response(PLAYLIST, { status: 200, headers: { 'content-type': 'application/x-mpegurl' } }), { hosts: ['cdn.example'], referer: '', refererFromLink: true });
  const out = await linked.relay.fetchResource('https://cdn.example/v/master.m3u8', 'https://embed.example/p/1');
  assert.equal(linked.calls[0].headers.Referer, 'https://embed.example/p/1');
  assert.match(out.body, /&ref=https%3A%2F%2Fembed\.example%2Fp%2F1/, 'the next request carries it too');

  const none = relayOver(async () => new Response('x', { status: 200 }), { hosts: ['cdn.example'], referer: '', refererFromLink: false });
  await none.relay.fetchResource('https://cdn.example/a.ts', 'https://embed.example/');
  assert.equal(none.calls[0].headers.Referer, undefined, 'a source that does not take one from the link sends none');

  assert.equal(cleanReferer('http://insecure.example/'), '');
  assert.equal(cleanReferer('javascript:alert(1)'), '');
  assert.equal(cleanReferer(`https://e.example/${'a'.repeat(400)}`).length, 300);
  assert.equal(cleanReferer(undefined), '');
});

test('a segment comes back as bytes with its type, a bad answer is an error, and a huge one is refused', async () => {
  const ok = relayOver(async () => new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'content-type': 'video/mp2t' } }));
  const seg = await ok.relay.fetchResource('https://cdn.example/a.ts');
  assert.deepEqual([seg.isPlaylist, seg.contentType, [...seg.body]], [false, 'video/mp2t', [1, 2, 3]]);
  const missing = relayOver(async () => new Response('no', { status: 404 }));
  await assert.rejects(missing.relay.fetchResource('https://cdn.example/a.ts'), /Upstream HTTP 404/);
  const huge = relayOver(async () => new Response('x', { status: 200, headers: { 'content-length': String(500 * 1024 * 1024) } }));
  await assert.rejects(huge.relay.fetchResource('https://cdn.example/a.ts'), /too large/);
  const bigList = relayOver(async () => new Response(`#EXTM3U\n${'#x\n'.repeat(1_000_000)}`, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }));
  await assert.rejects(bigList.relay.fetchResource('https://cdn.example/m.m3u8'), /playlist is too large/);
});

// ── The routes ────────────────────────────────────────────────────────────

const { getAnimeRegistry } = require('../../server/modules/anime-sources');
const animeRoutes = require('../../server/routes/anime');

async function startServer(t) {
  const app = express();
  app.use(express.json());
  animeRoutes.configure({ upload: { single: () => (req, res, next) => next() } });
  animeRoutes.registerAnimeRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  return (method, path, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('a source that declares its hosts cannot be made to relay another host, through the route either', async (t) => {
  const registry = getAnimeRegistry();
  registry.register({ meta: { id: 'declaredroute', name: 'Declared', keyedBy: 'title', stream: { hosts: ['cdn.example'] } }, getStreamSources: async () => ({ src: 'https://cdn.example/m.m3u8' }) });
  t.after(() => registry.unregister('declaredroute'));
  const call = await startServer(t);
  const refused = await call('GET', `/api/anime/declaredroute/hls-proxy?url=${encodeURIComponent('https://evil.example/x.ts')}`);
  assert.equal(refused.status, 403);
  const stream = await call('POST', '/api/anime/stream', { provider: 'declaredroute', title: 'T', episode: 1 });
  assert.match(stream.json.src, /^\/api\/anime\/declaredroute\/hls-proxy\?url=https%3A%2F%2Fcdn\.example%2Fm\.m3u8/);
});

// ── A hostile or broken video host ────────────────────────────────────────

// A response whose body arrives in `count` chunks of `size` bytes with NO Content-Length, and counts how many chunks were pulled.
function endlessBody(size, count) {
  const pulled = { chunks: 0 };
  const body = new ReadableStream({
    pull(controller) {
      pulled.chunks += 1;
      if (pulled.chunks > count) controller.close(); else controller.enqueue(new Uint8Array(size).fill(7));
    },
  });
  return { pulled, response: (type) => new Response(body, { status: 200, headers: { 'content-type': type } }) };
}

test('a body is judged while it is read: a host that sends more than allowed is cut off early, without a Content-Length to warn of it', async () => {
  const hostile = endlessBody(1000, 10_000);
  const relay = createStreamRelay({ id: 'x', stream: { hosts: ['cdn.example'], referer: '', refererFromLink: false } }, { fetchImpl: async () => hostile.response('video/mp2t'), assertPublic: async () => {}, maxBodyBytes: 10_000 });
  await assert.rejects(relay.fetchResource('https://cdn.example/a.ts'), (e) => e.statusCode === 413 && /resource is too large/.test(e.message));
  assert.ok(hostile.pulled.chunks <= 12, `it stopped reading after ${hostile.pulled.chunks} of 10000 chunks`);

  const list = endlessBody(1000, 10_000);
  const listRelay = createStreamRelay({ id: 'x', stream: { hosts: ['cdn.example'], referer: '', refererFromLink: false } }, { fetchImpl: async () => list.response('application/vnd.apple.mpegurl'), assertPublic: async () => {}, maxPlaylistBytes: 5_000 });
  await assert.rejects(listRelay.fetchResource('https://cdn.example/m.m3u8'), (e) => e.statusCode === 413 && /playlist is too large/.test(e.message));
  assert.ok(list.pulled.chunks <= 7);

  const fine = endlessBody(1000, 5);
  const okRelay = createStreamRelay({ id: 'x', stream: { hosts: ['cdn.example'], referer: '', refererFromLink: false } }, { fetchImpl: async () => fine.response('video/mp2t'), assertPublic: async () => {}, maxBodyBytes: 10_000 });
  assert.equal((await okRelay.fetchResource('https://cdn.example/a.ts')).body.length, 5000, 'a body under the limit comes whole');
});

test('what a playlist points at is only ever fetched later, and then judged again: another host and a data address are refused', async () => {
  const playlist = '#EXTM3U\n#EXT-X-MAP:URI="https://evil.example/init.mp4"\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"\n#EXTINF:4,\nhttps://evil.example/s.ts\n';
  const calls = [];
  const relay = createStreamRelay({ id: 'x', stream: { hosts: ['cdn.example'], referer: '', refererFromLink: false } }, {
    fetchImpl: async (url) => { calls.push(url); return new Response(playlist, { status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' } }); },
    assertPublic: async () => {},
  });
  const out = await relay.fetchResource('https://cdn.example/m.m3u8');
  assert.deepEqual(calls, ['https://cdn.example/m.m3u8'], 'reading a playlist asks nobody else for anything');
  const links = [...out.body.matchAll(/\/api\/anime\/x\/hls-proxy\?url=([^"\s]+)/g)].map((m) => decodeURIComponent(m[1]));
  assert.deepEqual(links, ['https://evil.example/init.mp4', 'data:text/plain;base64,AAAA', 'https://evil.example/s.ts']);
  await assert.rejects(relay.fetchResource(links[0]), (e) => e.statusCode === 403);
  await assert.rejects(relay.fetchResource(links[1]), (e) => e.statusCode === 400);
  await assert.rejects(relay.fetchResource(links[2]), (e) => e.statusCode === 403);
  assert.equal(calls.length, 1, 'none of them was fetched');
});
