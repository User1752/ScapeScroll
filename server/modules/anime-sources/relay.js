'use strict';

const { safeFetch, assertPublicUrl } = require('../network/safe-fetch');

// The relay for a source that declares `meta.stream` (contract.js) instead of writing its own. The browser cannot read a video
// host's playlists and segments (CORS, a Referer the host wants), so they come back through this app: the source says which hosts its
// video lives on, and this fetches from those hosts only. Every request is checked on its own, because the player asks for each
// segment separately: the host of the first request, and of every redirect it makes, must be one the source declared and must
// resolve to a public address.
//
// What goes to the player is what the routes already restrict for every relay (http/untrusted-content.js: media types only, nosniff,
// a sandboxing CSP).

// Loaded when the first resource is asked for: fetch-utils starts the hidden-browser caller as it loads, and the app (and a test) that
// only registers sources should not pay for that.
const userAgent = () => require('../network/fetch-utils').DEFAULT_USER_AGENT;

const FETCH_TIMEOUT_MS = 20_000;
const MAX_PLAYLIST_BYTES = 2_000_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_REFERER_CHARS = 300;

const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
const looksLikePlaylist = (url, contentType) => /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(contentType);

const hostOf = (raw) => { try { return new URL(raw).hostname.toLowerCase(); } catch (_) { return ''; } };
const hostAllowed = (host, hosts) => !!host && hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));

/**
 * The body of a response, read as it arrives and abandoned the moment it passes `max` bytes. A host that sends more than it said (or a
 * stream with no end) must not be able to fill the memory of this process: the size of a body is judged while it is read, not after.
 */
async function readCapped(res, max, what) {
  const tooLarge = () => Object.assign(new Error(`The ${what} is too large`), { statusCode: 413 });
  if (!res.body || typeof res.body.getReader !== 'function') {
    const whole = Buffer.from(await res.arrayBuffer());
    if (whole.length > max) throw tooLarge();
    return whole;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** A Referer taken from a link: https only, short, or nothing. */
function cleanReferer(raw) {
  try {
    const url = new URL(String(raw || ''));
    return url.protocol === 'https:' ? url.href.slice(0, MAX_REFERER_CHARS) : '';
  } catch (_) { return ''; }
}

/**
 * @param {{ id: string, stream: { hosts: string[], referer: string, refererFromLink: boolean } }} source
 * @param {{ fetchImpl?: Function, assertPublic?: Function }} [deps]  replaced in tests
 */
function createStreamRelay({ id, stream }, deps = {}) {
  const { fetchImpl = fetch, assertPublic = assertPublicUrl, maxBodyBytes = MAX_BODY_BYTES, maxPlaylistBytes = MAX_PLAYLIST_BYTES } = deps;

  const allowed = (url) => hostAllowed(hostOf(url), stream.hosts);

  /** The address the player asks this app for, for the real address `absoluteUrl`. */
  function proxyUrl(absoluteUrl, referer) {
    const ref = stream.refererFromLink && referer ? `&ref=${encodeURIComponent(referer)}` : '';
    return `/api/anime/${id}/hls-proxy?url=${encodeURIComponent(absoluteUrl)}${ref}`;
  }

  function rewritePlaylist(text, baseUrl, referer) {
    const through = (uri) => { try { return proxyUrl(new URL(uri, baseUrl).href, referer); } catch (_) { return uri; } };
    return text.split('\n').map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      // Tags that point at other files (keys, init segments, subtitle and audio playlists) carry the address in URI="…".
      if (trimmed.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${through(uri)}"`);
      return through(trimmed);
    }).join('\n');
  }

  /** @returns {Promise<{ contentType: string, body: Buffer|string, isPlaylist: boolean }>} */
  async function fetchResource(targetUrl, linkReferer) {
    let url;
    try { url = new URL(String(targetUrl)); } catch (_) { throw Object.assign(new Error('url is not a web address'), { statusCode: 400 }); }
    if (url.protocol !== 'https:') throw Object.assign(new Error('Only https addresses are relayed'), { statusCode: 400 });
    if (!allowed(url.href)) throw Object.assign(new Error('That host is not one this source declared'), { statusCode: 403 });

    // The Referer of the link travels on to every address the playlist names, so the player's next request carries it too.
    const fromLink = stream.refererFromLink ? cleanReferer(linkReferer) : '';
    const referer = stream.referer || fromLink;
    const headers = { 'User-Agent': userAgent(), ...(referer ? { Referer: referer } : {}) };
    const res = await safeFetch(url.href, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }, {
      fetchImpl,
      // Every hop, not only the first: a redirect to a host the source did not declare stops here.
      assertUrl: async (next) => {
        if (!allowed(next)) throw Object.assign(new Error('Redirected to a host the source did not declare'), { statusCode: 403 });
        await assertPublic(next);
      },
    });
    if (!res.ok) throw new Error(`Upstream HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') || '';
    if (looksLikePlaylist(url.href, contentType)) {
      const text = (await readCapped(res, maxPlaylistBytes, 'playlist')).toString('utf8');
      return { contentType: PLAYLIST_TYPE, body: rewritePlaylist(text, url.href, fromLink), isPlaylist: true };
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBodyBytes) throw Object.assign(new Error('The resource is too large'), { statusCode: 413 });
    const body = await readCapped(res, maxBodyBytes, 'resource');
    return { contentType: contentType || 'application/octet-stream', body, isPlaylist: false };
  }

  return { allowed, proxyUrl, fetchResource };
}

module.exports = { createStreamRelay, hostAllowed, cleanReferer };
