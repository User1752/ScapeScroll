'use strict';

// Some upstreams (e.g. AllManga's CDN, wp.youtube-anime.com) serve genuine
// images over a 200 response with NO Content-Type header at all — neither
// declaring nor lying about it. That's different from a server actively
// claiming a non-image type, which is the case fetchProxyImage's content-type
// check exists to catch (a redirect-to-homepage disguised as an image).
// When there's simply no signal either way, sniffing the real bytes is
// strictly more rigorous than trusting the URL's extension would be.
function sniffImageType(bytes) {
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return 'image/jpeg';
  }
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
      bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
    return 'image/png';
  }
  if (bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  return null;
}

const MAX_CONCURRENT_PROXY = 8;
let currentProxyRequests = 0;
const proxyQueue = [];

// Cloudflare edge/origin errors (520-526) and generic upstream 5xx/429 —
// worth a couple of quick retries since they're often just a momentary
// blip under a burst of concurrent requests, unlike a 403 bot-challenge
// (handled separately, via FlareSolverr) or a 404 (genuinely gone).
const RETRYABLE_UPSTREAM_STATUSES = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);
const UPSTREAM_RETRY_DELAYS_MS = [300, 900];

async function acquireProxyLock() {
  if (currentProxyRequests < MAX_CONCURRENT_PROXY) {
    currentProxyRequests++;
    return;
  }
  return new Promise(resolve => proxyQueue.push(resolve));
}

function releaseProxyLock() {
  if (proxyQueue.length > 0) {
    const next = proxyQueue.shift();
    next();
  } else {
    currentProxyRequests--;
  }
}

const { getDomainSession, getFlaresolverrUrl, executeFlareSolverr, DEFAULT_USER_AGENT, inferRefererForUrl } = require('../network/fetch-utils');
const { COVER_PROXY_FAILED } = require('../errors/error-codes');
const IMAGE_HOSTS = require('../../config/image-hosts');
const { safeFetch, assertPublicUrl } = require('../network/safe-fetch');
const { runWithSolverContext } = require('../network/solver-context');

// A reader waiting on a page image must not be held behind the browser for long: the call below
// sits inside acquireProxyLock, so a slow solve would also starve the other image slots.
const IMAGE_SOLVE_PATIENCE_MS = 15_000;

// Cooldown only, deliberately no minimum request spacing here — unlike a
// bulk background job, this path serves live page reads: a chapter can
// legitimately fire 8 concurrent requests (MAX_CONCURRENT_PROXY above) to
// the same CDN host as the reader prefetches pages, and artificial spacing
// between them would be felt directly as slower page loads. The existing
// concurrency cap already bounds burstiness; what was missing is a way for
// a confirmed-blocked host to short-circuit every one of those 8 requests
// instead of each independently retrying against it (see
// RETRYABLE_UPSTREAM_STATUSES below, which already treats a single 429 as
// possibly transient and retries twice before giving up — this only kicks
// in once a request has ALSO exhausted those retries and still failed with
// 429, meaning it's a real, sustained block, not a momentary blip).
const _proxyImageHostState = new Map(); // hostname -> { cooldownUntil }
const PROXY_IMAGE_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

function _getProxyImageHostState(hostname) {
  let s = _proxyImageHostState.get(hostname);
  if (!s) { s = { cooldownUntil: 0 }; _proxyImageHostState.set(hostname, s); }
  return s;
}

// AniList is a single external host, unlike per-source scraping where each
// site needs its own state — so one cooldown/spacing pair is enough, no
// per-hostname Map needed. Every client-side AniList call (anilist.js and
// ~9 other UI modules that each build their own queries — Tracker sync,
// migrate, cover picker, seasons/discover browsing, etc.) funnels through
// this one function via POST /api/anilist, so this is the single choke
// point where a rate-limit circuit breaker protects all of them at once
// instead of duplicating retry/backoff logic into each caller. See
// GUIDELINES.md's "Rate limiting for external services".
const ANILIST_RATE_LIMIT_COOLDOWN_MS = 90 * 1000;
// Confirmed live: a bulk caller (Cover Scan, checking ~60 favorites that
// each need an AniList candidate lookup) tripped a real 429 within about
// 10-15 seconds even at the old 150ms spacing — nowhere near the pace that
// number implies once concurrent callers are involved (see the queue below).
// 2s keeps sustained throughput around 30/min, comfortably under that.
const ANILIST_MIN_REQUEST_SPACING_MS = 2000;
let _anilistCooldownUntil = 0;
let _anilistLastRequestAt = 0;

// A plain "check the timestamp, maybe sleep" is racy under concurrent
// callers (e.g. Cover Scan's worker pool checking several favorites at
// once): two calls can both read _anilistLastRequestAt as the same stale
// value before either updates it, since the sleep is an await that yields
// control — letting bursts through well above the intended pace, which is
// exactly what happened above. Chaining every call onto one shared promise
// makes each wait for its actual turn instead of racing on a shared read.
let _anilistQueueTail = Promise.resolve();
function _waitForAniListTurn() {
  const turn = _anilistQueueTail.then(async () => {
    const sinceLastMs = Date.now() - _anilistLastRequestAt;
    if (sinceLastMs < ANILIST_MIN_REQUEST_SPACING_MS) {
      await new Promise((r) => setTimeout(r, ANILIST_MIN_REQUEST_SPACING_MS - sinceLastMs));
    }
    _anilistLastRequestAt = Date.now();
  });
  _anilistQueueTail = turn.catch(() => {}); // one caller's failure never wedges callers behind it
  return turn;
}

function createProxyService({ isSafeUrl }) {
  async function proxyAniList({ query, variables } = {}, authorizationHeader) {
    if (!query || typeof query !== 'string') {
      const err = new Error('Missing query');
      err.statusCode = 400;
      throw err;
    }

    // Fails fast with AniList's own error shape (an `errors` array) rather
    // than throwing, so every existing caller — which already expects a
    // {status, data} pair and reads data?.errors?.[0]?.message on failure —
    // handles this the same way it handles a real AniList-side error.
    if (Date.now() < _anilistCooldownUntil) {
      return { status: 429, data: { errors: [{ message: 'AniList is rate-limiting requests right now. Wait a bit and try again.' }] } };
    }

    await _waitForAniListTurn();

    // Re-check after the wait, not just before it — a call can pass this
    // gate while the cooldown is still inactive, then sit queued behind
    // other calls for seconds; if one of those sets the cooldown (a real
    // 429) before this call's turn comes up, firing anyway would send a
    // live request during the exact window the cooldown exists to block.
    if (Date.now() < _anilistCooldownUntil) {
      return { status: 429, data: { errors: [{ message: 'AniList is rate-limiting requests right now. Wait a bit and try again.' }] } };
    }

    const proxyHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    const authHeader = String(authorizationHeader || '');
    if (authHeader && /^Bearer [A-Za-z0-9\-._~+/]+=*$/.test(authHeader)) {
      proxyHeaders.Authorization = authHeader;
    }

    const aniRes = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: proxyHeaders,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });

    if (aniRes.status === 429) {
      // AniList sends a standard Retry-After header on its own 429s — honor
      // it when present instead of guessing, falling back to the default
      // only when it's missing or malformed.
      const retryAfterSec = Number(aniRes.headers.get('retry-after'));
      const cooldownMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? retryAfterSec * 1000
        : ANILIST_RATE_LIMIT_COOLDOWN_MS;
      _anilistCooldownUntil = Date.now() + cooldownMs;
    }

    const data = await aniRes.json();
    return { status: aniRes.status, data };
  }

  async function fetchProxyImage({ url, ref, measureBytes = false } = {}) {
    if (!url || !isSafeUrl(url)) {
      const err = new Error('Invalid image URL');
      err.statusCode = 400;
      throw err;
    }

    const hostname = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
    const hostState = _getProxyImageHostState(hostname);
    if (Date.now() < hostState.cooldownUntil) {
      const err = new Error(`${hostname} is rate-limited, cooling down`);
      err.statusCode = 429;
      err.code = COVER_PROXY_FAILED;
      throw err;
    }

    // The Referer is also what FlareSolverr's browser is sent to on a 403, so it
    // gets the same treatment as the image URL (literal host AND what it resolves
    // to): a name that points at 127.0.0.1 must not get that far.
    let safeRef;
    if (ref && isSafeUrl(ref)) {
      try {
        await assertPublicUrl(ref);
        safeRef = ref;
      } catch {
        safeRef = undefined;
      }
    }
    const refererHeader = safeRef || inferRefererForUrl(url);
    // The saved cookies are looked up for the image's OWN site only. `ref` comes from the client, so using the
    // referer's session here would send the cookies of any protected site to whatever host `url` names. An image on
    // a subdomain of the referer's site still finds them: they are saved under the registrable domain too.
    let session = getDomainSession(url);

    // A few hosts refuse the default request (see config/image-hosts.js): one that claims to be a browser, or one whose own address is the Referer.
    const sendsUserAgent = !IMAGE_HOSTS.withoutUserAgentHosts.some((re) => re.test(hostname));
    const sendsReferer = !!refererHeader && !IMAGE_HOSTS.withoutRefererHosts.some((re) => re.test(hostname));
    function buildHeaders(sess) {
      const headers = { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' };
      if (sendsReferer) headers.Referer = refererHeader;
      if (sendsUserAgent) headers['User-Agent'] = sess?.userAgent || DEFAULT_USER_AGENT;
      if (sess?.cookieHeader) {
        headers['Cookie'] = sess.cookieHeader;
      }
      return headers;
    }

    let imgRes;
    await acquireProxyLock();
    try {
      imgRes = await safeFetch(url, {
        signal: AbortSignal.timeout(30_000),
        headers: buildHeaders(session),
      });

      // If upstream rejects with 403 and FlareSolverr is available, try refreshing domain session
      if (imgRes.status === 403) {
        const solverUrl = await getFlaresolverrUrl();
        if (solverUrl) {
          try {
            await runWithSolverContext(
              { priority: 'interactive', deadlineAt: Date.now() + IMAGE_SOLVE_PATIENCE_MS },
              () => executeFlareSolverr(refererHeader, solverUrl),
            );
            session = getDomainSession(url);
            imgRes = await safeFetch(url, {
              signal: AbortSignal.timeout(30_000),
              headers: buildHeaders(session),
            });
          } catch (_) {}
        }
      } else if (RETRYABLE_UPSTREAM_STATUSES.has(imgRes.status)) {
        // A couple of short backoff retries for genuinely transient upstream
        // errors (a momentary blip, rate limiting). Not a fix for a
        // consistently-wrong Referer/hotlink rejection — that class of
        // failure needs a per-host inferRefererForUrl() rule instead (see
        // fetch-utils.js's manhwato.com entry for a confirmed example: a
        // wrong self-origin Referer 520s every single time, no amount of
        // retrying here would ever have fixed it).
        for (let attempt = 0; attempt < UPSTREAM_RETRY_DELAYS_MS.length && RETRYABLE_UPSTREAM_STATUSES.has(imgRes.status); attempt++) {
          await new Promise(r => setTimeout(r, UPSTREAM_RETRY_DELAYS_MS[attempt]));
          try {
            imgRes = await safeFetch(url, {
              signal: AbortSignal.timeout(30_000),
              headers: buildHeaders(session),
            });
          } catch (_) {
            break; // falls through to the !imgRes.ok handling below
          }
        }
        // Still 429 after exhausting the retries above — not a momentary
        // blip, a real sustained block. Cool this host down so the reader's
        // other concurrent page requests (and the next chapter's) fail fast
        // instead of each burning their own two retries against it.
        if (imgRes.status === 429) {
          hostState.cooldownUntil = Date.now() + PROXY_IMAGE_RATE_LIMIT_COOLDOWN_MS;
        }
      }
    } catch (e) {
      const err = new Error(`Upstream connection failed: ${e.message}`);
      err.statusCode = 502;
      err.code = COVER_PROXY_FAILED;
      throw err;
    } finally {
      releaseProxyLock();
    }

    if (!imgRes.ok) {
      const status = Number(imgRes.status) || 502;
      const message = status === 404
        ? 'Upstream image not found (404)'
        : `Upstream image request failed with ${status}`;
      const err = new Error(message);
      if (status === 404) err.expected = true;
      err.statusCode = imgRes.status;
      err.code = COVER_PROXY_FAILED;
      throw err;
    }



    let upstreamCt = imgRes.headers.get('content-type') || '';
    let finalCt = upstreamCt.split(';')[0].trim();
    const isImage = /^image\//i.test(finalCt);
    const isOctet = /octet-stream|binary/i.test(finalCt);

    // The upstream response is the source of truth. A redirect to an
    // unrelated page (e.g. a bad/expired image path bouncing to the site's
    // homepage) still resolves with HTTP 200, so trusting the *requested*
    // URL's file extension over what the server actually sent would let an
    // HTML error page through mislabeled as an image — it downloads fine
    // but can never render, and fails completely silently.
    if (isImage || isOctet) {
      // Upstream did send image (or ambiguous octet-stream) data — normalise
      // a vague/incorrect subtype using the URL's extension.
      if (/\.png([?#].*)?$/i.test(url)) finalCt = 'image/png';
      else if (/\.webp([?#].*)?$/i.test(url)) finalCt = 'image/webp';
      else if (/\.gif([?#].*)?$/i.test(url)) finalCt = 'image/gif';
      else if (/\.(jpe?g)([?#].*)?$/i.test(url)) finalCt = 'image/jpeg';

      if (!measureBytes) {
        // Already trust upstream's declared type, so there's no need to
        // sniff bytes first — stream the body straight through instead of
        // buffering the whole image in memory (matters for reader pages
        // with several large images loading concurrently).
        // Only a header that is really there, for a body that is passed through
        // as sent: Number(null) is 0, so a chunked response (no Content-Length)
        // used to be announced as 0 bytes followed by the whole image, and a
        // Content-Encoding means fetch() already decoded the body, so the
        // declared length no longer matches what is streamed.
        const declaredLen = imgRes.headers.get('content-length');
        const upstreamLen = declaredLen !== null && !imgRes.headers.get('content-encoding')
          ? Number(declaredLen)
          : NaN;
        return {
          contentType: finalCt,
          cacheControl: 'public, max-age=86400',
          contentLength: Number.isFinite(upstreamLen) ? upstreamLen : undefined,
          body: imgRes.body,
        };
      }

      const bytes = new Uint8Array(await imgRes.arrayBuffer());
      return {
        contentType: finalCt,
        cacheControl: 'public, max-age=86400',
        contentLength: bytes.byteLength,
        body: Buffer.from(bytes),
      };
    }

    // No Content-Type at all (as opposed to an explicit non-image one) —
    // some upstreams just don't send it for genuine images. Sniff the real
    // bytes rather than reject outright or trust the URL blindly — this
    // always needs the full body in memory first, unlike the fast path above.
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    const sniffed = finalCt === '' ? sniffImageType(bytes) : null;
    if (!sniffed) {
      console.warn('[proxy-image] 415 Unsupported:', url, '| Content-Type:', finalCt);
      const err = new Error('Unsupported upstream content type');
      err.statusCode = 415;
      err.code = COVER_PROXY_FAILED;
      throw err;
    }

    return {
      contentType: sniffed,
      cacheControl: 'public, max-age=86400',
      contentLength: bytes.byteLength,
      body: Buffer.from(bytes),
    };
  }

  return {
    proxyAniList,
    fetchProxyImage,
  };
}

module.exports = { createProxyService };