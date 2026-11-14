'use strict';

const limits = require('../../config/limits');
const { DEFAULT_FLARESOLVERR_URL, MESSAGES } = require('../../config/solver');
const { isSafeUrl } = require('../common/sanitize');
const { hostKeyOf, isLoopbackUrl } = require('../common/host-utils');
const { declaredRefererForHost } = require('../common/source-ui');
const { safeFetch, assertPublicUrl } = require('./safe-fetch');
const lifecycle = require('./flaresolverr-lifecycle');
const { createSolverPool } = require('./solver-pool');
const { CALLER_ERROR_CODES } = require('./solver/errors');
const { getSolverContext } = require('./solver-context');
const { createSingleFlight } = require('./single-flight');
const { createSolverCaller } = require('./solver-call');
const { createWedgeMemory } = require('./solver/wedge-memory');
const { createUserProxyProvider } = require('./solver-wiring');
const { isRelayImage, fetchRelayImage } = require('../suwayomi/relay-image');
const { noteFlaresolverrUsed, recoverFromHang } = lifecycle;
const IMG_FETCH_TIMEOUT = limits.sourceCallTimeoutMs;

// Size: still over the 450-line guideline. The solver itself lives in solver-call.js, single-flight.js,
// solver-wiring.js and solver-pool.js; the saved cookies, the challenge detectors, the image helpers and fetchText's retry loop are left to move out.

// The one spoofed desktop-Chrome UA string every source and network helper
// in the project sends — used to be typed out independently in a dozen-plus
// places (with three different, undocumented Chrome version numbers between
// them). Exported so sources and other server modules can import this
// instead of hand-rolling their own copy.
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function fetchJson(url, retries = 2) {
  // SSRF guard: reject private/loopback/link-local targets before any network call.
  if (!isSafeUrl(url)) throw new Error('Blocked unsafe URL');

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await safeFetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(limits.fetchTimeoutMs),
        headers: { 'User-Agent': 'ScrollScape/1.0' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      // A blocked target is a verdict, not a blip: retrying it only adds back-off.
      if (err.code === CALLER_ERROR_CODES.UNSAFE_URL) throw err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt)));
        continue;
      }
      throw err;
    }
  }
}

// Defaults to this project's own store for drop-in behavior in server.js's
// normal boot, but lifting this module into another project (it's a
// generic HTTP/Cloudflare-bypass helper, arguably the most reusable one in
// the whole server/) shouldn't require dragging server/store.js along —
// call configure({ readStore }) to point it at a different store, or at a
// stub that just returns a fixed flaresolverrUrl.
let _readStore = null;

function configure({ readStore } = {}) {
  if (typeof readStore === 'function') _readStore = readStore;
}

// Where FlareSolverr listens when the person has not typed an address in Settings. In Docker it is another container (the compose file sets
// FLARESOLVERR_URL=http://flaresolverr:8191/v1), which would otherwise have to be typed into Settings on every fresh data folder. It is the
// operator's own environment, so it only has to be an http(s) address; a value that is not one is ignored.
function flaresolverrUrlFromEnv(env = process.env) {
  const value = String(env.FLARESOLVERR_URL || '').trim();
  return /^https?:\/\/\S+$/i.test(value) ? value : '';
}

// The address typed in Settings wins, then the environment, then the local default, with one exception: an address in Settings that points
// at THIS computer (127.0.0.1, localhost) gives way to an environment address on another host. The library's data/ folder is shared between
// a PC and a container (a CasaOS box): the 127.0.0.1 the PC saved means "the container itself" there, where nothing listens, so the
// FlareSolverr container the operator named in FLARESOLVERR_URL was never used and System Health said "Off".
function pickFlaresolverrUrl(saved, fromEnv) {
  if (saved && fromEnv && isLoopbackUrl(saved) && !isLoopbackUrl(fromEnv)) return fromEnv;
  return saved || fromEnv || DEFAULT_FLARESOLVERR_URL;
}

async function getFlaresolverrUrl() {
  try {
    if (!_readStore) _readStore = require('../../store').readStore;
    const store = await _readStore();
    return pickFlaresolverrUrl(store?.settings?.flaresolverrUrl, flaresolverrUrlFromEnv());
  } catch {
    return flaresolverrUrlFromEnv() || DEFAULT_FLARESOLVERR_URL;
  }
}

// Optional proxy for FlareSolverr's own browser to go through (Settings >
// Proxy URL) — FlareSolverr's `/v1` API accepts a `proxy` object per
// request (url + optional username/password), which it hands straight to
// the underlying Chrome instance. Resolves null when unset so the payload omits the field entirely,
// and rejects when the setting cannot be read: "unset" and "unreadable" are different answers, and
// the pool (solver-wiring.js) needs to tell them apart.
async function readProxyConfig() {
  if (!_readStore) _readStore = require('../../store').readStore;
  const store = await _readStore();
  const url = store?.settings?.proxyUrl;
  if (!url) return null;
  const proxy = { url };
  if (store.settings.proxyUsername) proxy.username = store.settings.proxyUsername;
  if (store.settings.proxyPassword) proxy.password = store.settings.proxyPassword;
  return proxy;
}

// For everyone who only wants the proxy if there is one: a setting that cannot be read means none.
const getProxyConfig = () => readProxyConfig().catch(() => null);

const domainSessions = new Map();

// The keys a site's saved cookies live under: its host without www, and the site that host
// belongs to (hostKeyOf). The site used to be "the last two labels", which gave every site
// under co.uk (and the like) the one key "co.uk" and let them share each other's cookies.
function sessionKeysOf(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    return [...new Set([host, hostKeyOf(url)])].filter((key) => key && key !== 'default');
  } catch (_) {
    return [];
  }
}

function saveDomainSession(targetUrl, cookies = [], userAgent = '') {
  try {
    const keys = sessionKeysOf(targetUrl);

    const cookieHeader = Array.isArray(cookies)
      ? cookies.map(c => `${c.name}=${c.value}`).join('; ')
      : '';

    const session = {
      cookieHeader,
      userAgent: userAgent || DEFAULT_USER_AGENT,
      timestamp: Date.now()
    };

    for (const key of keys) domainSessions.set(key, session);
  } catch (_) {}
}

function getDomainSession(targetUrl, refererUrl) {
  const candidates = [
    ...(refererUrl ? sessionKeysOf(refererUrl) : []),
    ...(targetUrl ? sessionKeysOf(targetUrl) : []),
  ];

  for (const d of candidates) {
    if (domainSessions.has(d)) {
      return domainSessions.get(d);
    }
  }
  return null;
}

// Error messages below are user-facing (batcave.js re-throws err.message
// as-is) and this helper is now shared across multiple scraped sites, so the
// site name must come from the actual URL rather than being hardcoded.
function siteLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return 'O site';
  }
}

function isBotChallengePage(html) {
  // Some sites (e.g. BatCave) serve a 200 OK "verifying your browser" shell on
  // individual content pages even when a cookie session from an earlier
  // (different) page is reused. It never resolves client-side without a real
  // browser, so treat it the same as a hard challenge and re-solve via
  // FlareSolverr instead of caching/returning it as valid content.
  if (html.includes('cdp_flags')) return true;
  // BatCave's own site-side "DLE Guard" - a SECOND automation check behind
  // Cloudflare's own challenge, redirecting to /_c?t=...&u=... . Confirmed
  // live: even FlareSolverr's own browser can land on this shell (it
  // fingerprints navigator.webdriver, which FlareSolverr doesn't always hide),
  // and since the shell is a normal 200 OK with real HTML - not a 403, not
  // "Just a moment..." - none of the other checks here catch it. Left
  // undetected, it gets treated as valid content and CACHED as such
  // (data/sources/batcave.js's own htmlCache), so every request in that
  // cache window "succeeds" with a page that parses to zero real results.
  // This exact phrase is from that shell's own JS and distinctive enough
  // not to appear on a real page.
  if (html.includes('webdriver: navigator.webdriver===true')) return true;
  return false;
}

function isChromeErrorPage(html) {
  // Detect Chrome/FlareSolverr browser error pages.
  // Chrome error pages embed Google-specific CSS variables and metadata that never appear on real sites.
  if (html.includes('This page isn\'t working') ||
      html.includes('ERR_CONNECTION_TIMED_OUT') ||
      html.includes('ERR_CONNECTION_REFUSED') ||
      html.includes('ERR_NAME_NOT_RESOLVED') ||
      html.includes('ERR_TIMED_OUT') ||
      // The proxy Chrome was pointed at refused the connection or could not be reached: what comes
      // back is Chrome's error page, not the site (it used to be returned as the site's content).
      html.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
      html.includes('ERR_PROXY_CONNECTION_FAILED') ||
      html.includes('chrome-error://')) {
    return true;
  }
  // Chrome connection error pages always embed these Google-specific CSS variables
  if (html.includes('--google-blue-600') && html.includes('--google-gray-700') &&
      html.includes('name="color-scheme"')) {
    return true;
  }
  return false;
}

// A page the plain request got that is not the real page yet: nothing at all, a proof-of-work
// interstitial, Cloudflare's "Just a moment...", or a site's own bot-check shell.
function needsChallengeSolve(text) {
  return !text ||
    !text.trim() ||
    (text.includes('/_v') && (text.includes('powNonce') || text.includes('pow_hash'))) ||
    text.includes('Just a moment...') ||
    isBotChallengePage(text);
}

// Every call to FlareSolverr's browser goes through this one pool. The pool and the registry of calls
// in flight are built here, at module scope, and solver-call.js / single-flight.js keep no state of
// their own, so a fresh copy of this module (a unit test deletes it from the require cache) is a
// fresh pool. Until server.js tells it the settings (solver-wiring.js applySolverSettings) the pool
// is OFF and every call is the plain one-off request the app always made, which is also what the
// settings switch and the environment switch give back.
const solverPool = createSolverPool({
  getSolverProxy: createUserProxyProvider(readProxyConfig),
  hooks: {
    noteUsed: noteFlaresolverrUsed,
    recoverFromHang,
    // A user who switched FlareSolverr off on purpose is not told it is not reachable (and System Health says the browser waits for it).
    isOffByChoice: () => lifecycle.isDisabled?.() === true,
    // The pool pauses itself while FlareSolverr restarts. The lifecycle stand-in of a unit test has
    // no registry, so the call is optional.
    onRestart: (listener) => lifecycle.registerRestartListener?.(listener),
  },
});

// Solves `targetUrl` with FlareSolverr and returns the page's HTML (see solver-call.js for everything
// around the call). `cookies` lets a caller (e.g. a source needing the user's own logged-in session)
// have the solved page reflect that account instead of an anonymous visitor: they go to a one-off
// browser of their own, never into a browser later calls share.
const executeFlareSolverr = createSolverCaller({
  pool: solverPool,
  flights: createSingleFlight(),
  // Remembers a site that keeps leaving the solver without an answer and pauses it, with or without the pool.
  wedges: createWedgeMemory({ log: (message) => console.warn(`[SolverWedge] ${message}`) }),
  assertPublicUrl,
  getSolverContext,
  noteUsed: noteFlaresolverrUsed,
  recoverFromHang,
  saveDomainSession,
  getDomainSession,
  safeFetch,
  isChromeErrorPage,
  isBotChallengePage,
  needsChallengeSolve,
  siteLabel,
  userAgent: DEFAULT_USER_AGENT,
});

function getSolverPool() {
  return solverPool;
}

// Solves `url` via FlareSolverr and validates the result. Returns the solved
// HTML, or null when no solver is configured. Throws when the solver itself
// only produced a known error/interstitial page (never caches those upstream).
async function resolveViaSolver(url, cookies) {
  const solverUrl = await getFlaresolverrUrl();
  if (!solverUrl) return null;

  const html = await executeFlareSolverr(url, solverUrl, cookies);
  if (isChromeErrorPage(html)) {
    throw new Error(MESSAGES.navigation(siteLabel(url)));
  }
  if (html.includes('Connection timed out') || html.includes('Error code 522') || html.includes('Error code 520')) {
    throw new Error(`${siteLabel(url)} server temporarily unavailable (Cloudflare Error 522). Try again in a moment.`);
  }
  if (isBotChallengePage(html)) {
    // FlareSolverr itself got served the bot-check shell instead of real
    // content — surface this as a retryable failure rather than caching it.
    throw new Error(`${siteLabel(url)} unavailable (anti-bot check not resolved). Try again in a moment.`);
  }
  return html;
}

// Per-hostname cooldown + spacing, same shape as fetchImageBuffer's below —
// this is the shared GET/HTML fetch every scraped source's search() and
// chapter/page lookups go through, so a burst across many items (a bulk
// migrate scan, a multi-page search) hits the same host repeatedly with no
// shared state telling later calls to back off. A 429 here still gets the
// existing FlareSolverr escape hatch a chance to recover THIS call (some
// challenges resolve via a real browser even when the plain fetch was
// blocked), but the cooldown is set regardless so subsequent calls to an
// already-flagged host fail fast instead of repeating the same slow
// solver attempt. See GUIDELINES.md's "Rate limiting for external services".
const _textHostState = new Map(); // hostname -> { cooldownUntil, lastRequestAt }
const TEXT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const TEXT_MIN_REQUEST_SPACING_MS = 300;

function _getTextHostState(hostname) {
  let s = _textHostState.get(hostname);
  if (!s) { s = { cooldownUntil: 0, lastRequestAt: 0 }; _textHostState.set(hostname, s); }
  return s;
}

// The headers of fetchText's plain GET. The cookie a solve saved for the site is read when the request
// is made, not when fetchText was called: a call that waited out the host's spacing (or retries) must
// carry the cookie a solve saved meanwhile, or it meets a challenge that solve already got past.
function textRequestHeaders(url, opts) {
  const session = getDomainSession(url);
  const headers = {
    'User-Agent': session?.userAgent || DEFAULT_USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (session?.cookieHeader) headers['Cookie'] = session.cookieHeader;
  // A caller-supplied cookie (the user's own logged-in session for an account-specific source) always
  // wins over the anonymous one FlareSolverr cached for the domain.
  if (opts.cookieHeader) headers['Cookie'] = opts.cookieHeader;
  // e.g. a source attaching the user's own Authorization: Bearer header: merged last, so it cannot be shadowed.
  if (opts.extraHeaders) Object.assign(headers, opts.extraHeaders);
  return headers;
}

async function fetchText(url, retries = 2, opts = {}) {
  // SSRF guard: reject private/loopback/link-local targets before any network call.
  if (!isSafeUrl(url)) throw new Error('Blocked unsafe URL');

  const hostname = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
  const hostState = _getTextHostState(hostname);
  if (Date.now() < hostState.cooldownUntil) {
    const err = new Error(`${hostname} is rate-limited, cooling down`);
    err.rateLimited = true;
    throw err;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Was the solver called for a genuine challenge on this attempt? Only then is "FlareSolverr is
    // not reachable" final. A 503, a 429 or an empty 200 can be a blip that the next attempt
    // clears (the retry that this loop always gave), and a closed solver port must not take that
    // retry away from a user who switched FlareSolverr off.
    let challenged = true;
    try {
      const sinceLastMs = Date.now() - hostState.lastRequestAt;
      if (sinceLastMs < TEXT_MIN_REQUEST_SPACING_MS) {
        await new Promise((r) => setTimeout(r, TEXT_MIN_REQUEST_SPACING_MS - sinceLastMs));
      }
      hostState.lastRequestAt = Date.now();

      const res = await safeFetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(limits.fetchTimeoutMs),
        headers: textRequestHeaders(url, opts)
      });

      if (!res.ok) {
        if (res.status === 429) {
          hostState.cooldownUntil = Date.now() + TEXT_RATE_LIMIT_COOLDOWN_MS;
        }
        if (res.status === 403 || res.status === 503 || res.status === 429) {
          // FlareSolverr's request.get command has no way to carry a custom header
          // (Authorization, etc.) into its browser navigation — only cookies. A
          // caller relying on an auth header here (a source's API key or the
          // user's own bearer token) would silently lose it if this fell through to the
          // solver, likely surfacing as a confusing auth error instead of the
          // real "this host is Cloudflare-challenged" one — skip the solver
          // attempt entirely in that case and let the original error propagate.
          // Cookie-based auth (opts.cookieHeader/opts.cookies) is unaffected —
          // those ARE carried through to the solver correctly.
          if (!opts.extraHeaders || !Object.keys(opts.extraHeaders).length) {
            challenged = res.status === 403;
            const html = await resolveViaSolver(url, opts.cookies);
            if (html !== null) return html;
          }
        }
        const err = new Error(`HTTP ${res.status}`);
        if (res.status === 429) err.rateLimited = true;
        throw err;
      }

      const text = await res.text();
      // A cookie session saved from a previously-solved page can still get a
      // 200 OK on a *different* page while only serving a bot-check shell
      // (no 403 raised) — treat that the same as an explicit challenge.
      if (needsChallengeSolve(text)) {
        // same reasoning as above
        if (!opts.extraHeaders || !Object.keys(opts.extraHeaders).length) {
          challenged = text.trim() !== '';
          const html = await resolveViaSolver(url, opts.cookies);
          if (html !== null) return html;
        }
      }

      if (isChromeErrorPage(text)) {
        throw new Error(MESSAGES.navigation(siteLabel(url)));
      }

      if (text.includes('Connection timed out') && text.includes('Error code 522')) {
        throw new Error(`${siteLabel(url)} server temporarily unavailable (Cloudflare Error 522). Try again in a moment.`);
      }

      return text;
    } catch (err) {
      // A confirmed 429 already set the cooldown above — no point burning
      // through the remaining internal retries against a host we just
      // marked as blocked, so bail out immediately instead of waiting on
      // the exponential backoff below. The same goes for a refusal of the
      // solver pool that a retry within seconds cannot fix (its queue is
      // full or timed out, it is restarting): err.noRetry.
      if (err.rateLimited || err.noRetry) throw err;
      if (err.code === CALLER_ERROR_CODES.UNSAFE_URL || (err.code === CALLER_ERROR_CODES.UNAVAILABLE && challenged)) throw err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt)));
        continue;
      }
      throw err;
    }
  }
}

// Unlike fetchText() above (retries + a FlareSolverr escape hatch on
// 403/503/429), this used to be a single bare attempt with zero rate-limit
// awareness — and it's the one hit hardest in a burst: bulk CBZ downloads
// and offline-save jobs (server/modules/downloads/service.js,
// server/modules/local/offline-downloads.js) fetch every page of every
// chapter in a job through here, concurrency=6, sequentially across
// chapters. If a source's image CDN 429s mid-job, every one of those
// concurrent/queued page fetches independently kept trying at full
// concurrency with no shared state telling the others to back off — the
// same "burst triggers a block, keep hammering through it" shape that got
// this project's own IP blocked by Brave Search (see cover-search/index.js
// and GUIDELINES.md's "Rate limiting for external services"). Same
// pattern here, scoped per-hostname, local to this module.
const _imageHostState = new Map(); // hostname -> { cooldownUntil, lastRequestAt }
const IMAGE_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const IMAGE_MIN_REQUEST_SPACING_MS = 400;

// A momentary blip (a 502/503/520 that clears itself, or a single 429) used
// to permanently drop that one page from a bulk/local CBZ download — the
// live-reading path (proxy/service.js's fetchProxyImage) already retries
// these same statuses with a short backoff, but this lower-level function
// (bulk downloads, OPDS's on-demand CBZ, local/offline-downloads.js) never
// got the same treatment, so a page could vanish from an export for a
// failure that would have quietly succeeded a second later while actually
// reading the same chapter. Same status set/delays as that existing retry,
// kept local here rather than imported, since proxy/service.js's copy isn't
// exported and this module sits lower in the dependency graph.
const IMAGE_RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);
const IMAGE_RETRY_DELAYS_MS = [300, 900];

function _getImageHostState(hostname) {
  let s = _imageHostState.get(hostname);
  if (!s) { s = { cooldownUntil: 0, lastRequestAt: 0 }; _imageHostState.set(hostname, s); }
  return s;
}

async function fetchImageBuffer(url, referer = 'https://mangadex.org/') {
  // An image of a source that reads through the person's own Suwayomi-Server is this app's own relay path, not an address on the internet.
  if (isRelayImage(url)) return fetchRelayImage(url);
  // Same SSRF guard fetchJson/fetchText apply internally — every caller
  // today happens to pre-filter through resolvePageUrl() first, but that's
  // caller discipline, not a guarantee; enforcing it here too means a future
  // direct call can't silently skip it.
  if (!isSafeUrl(url)) throw new Error('Blocked unsafe URL');

  const hostname = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
  const hostState = _getImageHostState(hostname);

  if (Date.now() < hostState.cooldownUntil) {
    const err = new Error(`${hostname} is rate-limited, cooling down`);
    err.rateLimited = true;
    throw err;
  }

  const sinceLastMs = Date.now() - hostState.lastRequestAt;
  if (sinceLastMs < IMAGE_MIN_REQUEST_SPACING_MS) {
    await new Promise((r) => setTimeout(r, IMAGE_MIN_REQUEST_SPACING_MS - sinceLastMs));
  }
  hostState.lastRequestAt = Date.now();

  let resp;
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), IMG_FETCH_TIMEOUT);
    try {
      resp = await safeFetch(url, {
        signal: controller.signal,
        headers: {
          Referer: referer,
          'User-Agent': DEFAULT_USER_AGENT,
        },
      });
    } catch (e) {
      if (e && e.code === CALLER_ERROR_CODES.UNSAFE_URL) throw e;
      // Network-level failure (timeout, DNS, connection reset) — retryable
      // the same as a bad status, up to the same attempt budget.
      if (attempt < IMAGE_RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, IMAGE_RETRY_DELAYS_MS[attempt]));
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timerId);
    }

    if (resp.status === 429) {
      hostState.cooldownUntil = Date.now() + IMAGE_RATE_LIMIT_COOLDOWN_MS;
    }
    if (IMAGE_RETRYABLE_STATUSES.has(resp.status) && attempt < IMAGE_RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, IMAGE_RETRY_DELAYS_MS[attempt]));
      continue;
    }
    break;
  }

  if (resp.status === 429) {
    const err = new Error(`${hostname} returned 429`);
    err.rateLimited = true;
    throw err;
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// Per-host Referer rules for sources whose CDN enforces hotlink protection.
// Single source of truth for proxy/service.js's live-reading fetches AND
// resolvePageUrl()'s callers (offline-save, bulk CBZ download) below — those
// download paths used to fall back to fetchImageBuffer()'s own hardcoded
// MangaDex-only default whenever a page's URL had no `ref` query param
// (e.g. every MangaPill page), which every non-MangaDex CDN's hotlink check
// then rejected with a 403 — silently, since the page-loop only warns and
// skips a failed page rather than surfacing it. Confirmed live: an
// MangaPill/readdetectiveconan.com image request 403s with a MangaDex
// referer and 200s with a mangapill.com one.
function inferRefererForUrl(url) {
  try {
    const parsed = new URL(url);
    if (/vortexscans\.org$/i.test(parsed.hostname) || /storage\.vortexscans\.org$/i.test(parsed.hostname)) {
      return 'https://vortexscans.org';
    }
    if (/kingofshojo\.com$/i.test(parsed.hostname) || /cdn\.kingofshojo\.com$/i.test(parsed.hostname)) {
      return 'https://kingofshojo.com';
    }
    if (/readdetectiveconan\.com$/i.test(parsed.hostname) || /mangapill\.com$/i.test(parsed.hostname)) {
      return 'https://mangapill.com';
    }
    if (/mangakatana\.com$/i.test(parsed.hostname)) {
      return 'https://mangakatana.com';
    }
    if (/batcave\.biz$/i.test(parsed.hostname)) {
      return 'https://batcave.biz/';
    }
    if (/\.2xstorage\.com$/i.test(parsed.hostname) || /\.waitst\.com$/i.test(parsed.hostname)) {
      return 'https://www.manganato.gg/';
    }
    // fmcdn.mfcdn.net (covers) rejects its own origin as referer - confirmed
    // live, unlike zjcdn.mangafox.me (page images), which accepts either.
    // Both get the explicit site referer for consistency.
    if (/\.mfcdn\.net$/i.test(parsed.hostname) || /mangafox\.me$/i.test(parsed.hostname)) {
      return 'https://fanfox.net/';
    }
    // cmzcdn.org (Comizy's page-image CDN) 403s with no Referer or its own
    // origin as Referer — confirmed live it needs the main site's origin
    // specifically. rx.comizy.io (covers) has no such check, so it's left
    // out here and just falls through to the default self-origin case below.
    if (/cmzcdn\.org$/i.test(parsed.hostname)) {
      return 'https://comizy.io/';
    }
    // manhwato.com's CDN subdomains (cdn./media./stmedia.) all return HTTP
    // 520 with no Referer or a self-origin one — confirmed live with an
    // isolated fetch() against stmedia (covers/thumbs): identical request,
    // only the Referer changed, 520 both with no Referer and with the
    // image's own origin as Referer, 200 with manhwato.com's origin. The
    // "covers/thumbs have no such check" claim this comment used to make
    // was wrong — same rule needed for all three subdomains.
    if (/\.manhwato\.com$/i.test(parsed.hostname) || /^manhwato\.com$/i.test(parsed.hostname)) {
      return 'https://manhwato.com/';
    }
    // A Referer a loaded source asked for in meta.ui.imageReferers (validated against the hosts its own code names, see
    // common/source-ui.js). The rules above stay first: a declaration cannot change a host that already has a rule.
    const declared = declaredRefererForHost(parsed.hostname);
    if (declared) return `${declared}/`;
    return parsed.origin;
  } catch (_) {
    return 'https://mangadex.org/';
  }
}

function createPageUrlResolver({ isSafeUrl }) {
  function resolvePageUrl(page) {
    const raw = typeof page === 'string' ? page : page?.img;
    if (!raw) return null;
    if (isRelayImage(raw)) return { url: raw, referer: '' };
    try {
      const url = new URL(raw, 'http://localhost');
      if (url.pathname === '/api/proxy-image') {
        const inner = url.searchParams.get('url');
        const ref = url.searchParams.get('ref');
        if (inner && isSafeUrl(inner)) {
          return { url: inner, referer: ref ? decodeURIComponent(ref) : inferRefererForUrl(inner) };
        }
        return null;
      }
    } catch {
      // fall through
    }
    if (isSafeUrl(raw)) return { url: raw, referer: inferRefererForUrl(raw) };
    return null;
  }

  return { resolvePageUrl };
}

// A challenge-solved response for a JSON endpoint (fetchText/resolveViaSolver
// having gone through FlareSolverr, a real browser) usually comes back as
// the raw JSON wrapped in <html>...<pre>...</pre>...</html> — a browser's
// own default rendering for navigating straight to a JSON response. Two
// sources reimplement the unwrap step inline (each in its own JSON helper)
// — both missed that the browser ALSO HTML-escapes
// the text it puts inside that <pre> (since it's being inserted as page
// text content), so a URL value containing a literal "&" comes back through
// as "&amp;" and silently corrupts anything downstream that treats it as a
// real query-string separator. Confirmed live: a video file URL,
// round-tripped through exactly this path, had every "&" between query
// params replaced with "&amp;", which the *next* API hop then rejected
// outright (a validation error on the mangled "hash" field) rather than
// just misbehaving quietly.
function unwrapSolverJson(text) {
  let clean = String(text || '').trim();
  if (clean.includes('<pre>')) {
    const match = clean.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (match) clean = match[1].trim();
  } else if (clean.startsWith('<')) {
    clean = clean.replace(/<[^>]+>/g, '').trim();
  }
  clean = clean
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&amp;/g, '&'); // must be last - the others' own replacements can't introduce a fresh "&amp;"
  return JSON.parse(clean);
}

module.exports = {
  DEFAULT_USER_AGENT,
  configure,
  fetchJson,
  fetchText,
  fetchImageBuffer,
  createPageUrlResolver,
  inferRefererForUrl,
  saveDomainSession,
  getDomainSession,
  executeFlareSolverr,
  getSolverPool,
  isChromeErrorPage,
  getFlaresolverrUrl,
  getProxyConfig,
  resolveViaSolver,
  unwrapSolverJson,
};