'use strict';

const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { isSafeUrl } = require('../helpers');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { applyUntrustedContentHeaders } = require('../modules/http/untrusted-content');
const { createProxyService } = require('../modules/proxy/service');

const asyncHandler = createAsyncHandler('PROXY');
const proxyService = createProxyService({ isSafeUrl });

// What a stream reports when the browser dropped the request (an image scrolled out of view, a tab closed). An upstream failure
// has none of these codes, so it is still thrown and logged.
const CLIENT_GONE_CODES = new Set(['ERR_STREAM_UNABLE_TO_PIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED', 'ECONNRESET', 'ECONNABORTED', 'EPIPE']);

async function sendProxyImageResponse(res, { contentType, cacheControl, contentLength, body } = {}) {
  // The type here is already restricted to images by fetchProxyImage(), but
  // image/svg+xml is an image type that is also a script-capable document —
  // so this response gets the untrusted-content headers like every relay.
  applyUntrustedContentHeaders(res);
  res.set('Content-Type', contentType);
  res.set('Cache-Control', cacheControl);

  if (Number.isFinite(Number(contentLength)) && Number(contentLength) >= 0) {
    res.set('Content-Length', String(contentLength));
  }

  if (Buffer.isBuffer(body)) {
    res.end(body);
    return;
  }

  const nodeStream = Readable.fromWeb(body);
  // pipeline() turns a destroyed `res` down (the browser dropped the request) before it listens to the source, and the
  // fetch's own timeout would later fire on that source as an unhandled 'error' that ends the whole process.
  nodeStream.on('error', () => {});
  try {
    await pipeline(nodeStream, res);
  } catch (err) {
    nodeStream.destroy();
    if (res.destroyed && CLIENT_GONE_CODES.has(err?.code)) return; // the browser went away: nothing to answer, nothing wrong on our side
    throw err;
  }
}

/**
 * @param {import('express').Router} router
 */
function registerProxyRoutes(router) {
  // ── POST /api/anilist ────────────────────────────────────────────────────────
  // Proxies AniList GraphQL requests from the browser to avoid CORS issues.
  router.post('/api/anilist', asyncHandler(async (req, res) => {
    const result = await proxyService.proxyAniList(req.body || {}, req.headers?.authorization);
    res.status(result.status).json(result.data);
  }));

  // ── GET /api/proxy-image ──────────────────────────────────────────────────────
  router.get('/api/proxy-image', asyncHandler(async (req, res) => {
    const result = await proxyService.fetchProxyImage(req.query || {});
    await sendProxyImageResponse(res, result);
  }));
}

module.exports = { registerProxyRoutes, sendProxyImageResponse };
