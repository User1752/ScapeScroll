'use strict';

/**
 * Helpers for the routes that relay a third party's bytes through this
 * server (HLS playlists/segments, cover images, Suwayomi thumbnails).
 *
 * Why this matters: those responses are served from the APP'S OWN ORIGIN. If
 * one is delivered with the upstream's Content-Type unchanged, an attacker
 * who can choose the upstream URL (`/api/anime/hls-proxy?url=https://evil/x`
 * is a plain GET, so a link on any web page is enough) gets text/html — and
 * therefore script — running as the app: it can then call every /api route
 * the victim's browser can, including the ones that install code. So the
 * relayed type is restricted to what the app's own players actually consume,
 * and every relayed response carries headers that stop it ever being
 * interpreted as a document even if something slips through.
 */

// Media and image types the players/<img> tags consume, plus the HLS
// playlist/segment/subtitle types. image/svg+xml is deliberately NOT here:
// an SVG is a document that can carry script.
const RELAYABLE_TYPE = /^(?:video|audio)\/|^image\/(?!svg)|^text\/(?:vtt|plain)$|^application\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl|octet-stream|mp2t|mp4|x-subrip)$/i;

/**
 * @param {string|null|undefined} upstreamContentType raw Content-Type header from the upstream
 * @returns {string} the upstream's media type when it is on the allow-list, otherwise application/octet-stream
 */
function safeRelayContentType(upstreamContentType) {
  const mediaType = String(upstreamContentType || '').split(';')[0].trim().toLowerCase();
  return RELAYABLE_TYPE.test(mediaType) ? mediaType : 'application/octet-stream';
}

/**
 * Headers that make a relayed response inert if a browser is ever pointed at
 * it directly: no MIME sniffing, and a CSP `sandbox` (no allow-scripts, no
 * allow-same-origin) so even HTML/SVG that got through runs as a scriptless
 * document on an opaque origin. XHR/fetch/<video>/<img> consumers ignore a
 * response's CSP, so the app's own players are unaffected.
 *
 * @param {import('express').Response} res
 */
function applyUntrustedContentHeaders(res) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "sandbox; default-src 'none'");
}

/**
 * Sends a fully buffered relayed resource with a safe type and the
 * untrusted-content headers.
 *
 * @param {import('express').Response} res
 * @param {string|null|undefined} upstreamContentType
 * @param {Buffer|string} body
 */
function sendRelayedResource(res, upstreamContentType, body) {
  applyUntrustedContentHeaders(res);
  res.set('Content-Type', safeRelayContentType(upstreamContentType));
  res.set('Cache-Control', 'no-store');
  res.send(body);
}

module.exports = { safeRelayContentType, applyUntrustedContentHeaders, sendRelayedResource };
