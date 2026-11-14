'use strict';

const path = require('path');
const { isSafeUrl } = require('../../helpers');
const { createTtlDiskCache } = require('../common/ttl-disk-cache');
const { DEFAULT_USER_AGENT, resolveViaSolver } = require('../network/fetch-utils');
const { withTimeout } = require('../common/async-utils');
const { safeFetch } = require('../network/safe-fetch');
const { runWithSolverContext } = require('../network/solver-context');
const { CALLER_PATIENCE } = require('../../config/solver');

const DEFAULT_FETCH_HEADERS = {
  'User-Agent': DEFAULT_USER_AGENT,
  'Cache-Control': 'no-cache',
};

function safeQuery(v) {
  return String(v || '').trim().slice(0, 120);
}

function safeInt(v, fallback, min, max) {
  const n = Number.parseInt(String(v || ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// Brave/Google link straight to whatever size the source page happened to
// embed, which for a couple of very common image-hosting CDNs is a small
// thumbnail rather than the real photo — confirmed live for a manga-cover
// search returning mostly Etsy/Pinterest results: Etsy's "il_300x300"/
// "il_340x270" thumbnail was 300x300px (40KB) while the same listing's
// "il_fullxfull" was 1024x1024px (156KB); Pinterest's "/236x/" path was
// 236x295px (22KB) while "/originals/" was 1080x1350px (167KB). Both
// rewrites are documented, stable patterns on their own CDN (not a hack —
// Etsy and Pinterest serve the same image at multiple fixed sizes from
// predictable URL variants), so upgrading them costs nothing when it
// doesn't apply and meaningfully improves quality when it does. Reddit's
// preview.redd.it is deliberately NOT handled here — confirmed live its
// width param is tied to a per-width signed hash (`s=`), so changing the
// width without recomputing that signature 403s instead of upgrading.
//
// Naver's comic-thumbnail CDN and mrblue.com were added after the manga
// title-language toggle started sending native-script queries to Brave —
// those surface Korean-hosted results (which barely showed up for
// English-only queries before) far more often, and both CDNs turned out to
// have the exact same thumbnail-vs-original split as Etsy/Pinterest.
// Confirmed live: pstatic's own "?type=m260" param controls the size —
// dropping the whole query string returned the same image at 265KB instead
// of 26.7KB (~10x). mrblue's cover_w<N>.jpg only serves a handful of fixed
// widths (720 confirmed the largest available — 800+ all 404), so unlike
// the others this rewrites to a known-good tier rather than stripping a
// param.
function upgradeThumbnailUrl(url) {
  if (/^https?:\/\/i\.etsystatic\.com\//i.test(url)) {
    return url.replace(/il_\d+x\d+\./i, 'il_fullxfull.');
  }
  if (/^https?:\/\/i\.pinimg\.com\//i.test(url)) {
    return url.replace(/\/\d+x\d*\//, '/originals/');
  }
  if (/^https?:\/\/comicthumb-phinf\.pstatic\.net\//i.test(url)) {
    return url.replace(/\?.*$/, '');
  }
  if (/^https?:\/\/img\.mrblue\.com\//i.test(url)) {
    return url.replace(/_w\d+\.jpg(\?.*)?$/i, '_w720.jpg');
  }
  return url;
}

function dedupeUrls(urls, limit) {
  const out = [];
  const seen = new Set();
  for (const raw of urls) {
    const url = String(raw || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= limit) break;
  }
  return out;
}

// Brave/Google are scraped here, not an official API — no key, but also no
// guaranteed request budget. This app's own cover-search fallback chain
// (ui-cover-picker.js) can fire several queries back-to-back for a single
// cover pick, and confirmed live: a burst like that trips a real 429 from
// Brave, after which even a single request run alone still 429s for a
// while — retrying immediately just extends the block instead of clearing
// it. Three guards below, all keyed per-hostname so Google and Brave don't
// share a cooldown they didn't each individually earn:
//  - a cooldown once a 429 is actually seen, so a whole fallback chain
//    doesn't keep hammering an already-blocked host
//  - a minimum spacing between real requests to the same host, since the
//    429 above was triggered by burstiness, not just raw volume
//  - a short-lived result cache, so re-searching the exact same query (this
//    app's own testing, or a user reopening the same manga's cover picker)
//    doesn't cost a second real request at all
const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;
const MIN_REQUEST_SPACING_MS = 1500;
const RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const RESULT_CACHE_MAX = 200;
// One Brave images page already holds about 200 results (measured), so "load more" is served from that one list and never makes a second request
// (every request opens a browser, and a run of them is what makes Brave ask for a bot check). The list is kept at most this long.
const BRAVE_MAX_RESULTS = 200;
// After Brave answers with its bot check the host is left alone, browser or not: asking again only keeps the check going. How long Brave keeps a client
// flagged is not published and varies, so the pause is a guess that grows: it doubles each time the check comes back right after a pause, up to a limit,
// and starts over after a good search or after a long quiet time. The wait and the strike count are kept on disk: a restart used to clear the pause and the
// app went straight back to asking Brave.
const BOT_CHECK_COOLDOWN_MS = 10 * 60 * 1000;
const BOT_CHECK_COOLDOWN_MAX_MS = 2 * 3_600_000;
const BOT_CHECK_FORGET_MS = 6 * 3_600_000;
const BRAVE_HOST = 'search.brave.com';
// The list of a search is kept a day, on disk: looking at the same title again, or after a restart, costs Brave nothing. Capped, a list is about 20 KB.
const BRAVE_LIST_TTL_MS = 24 * 3_600_000;
const BRAVE_LIST_MAX = 60;

const _hostState = new Map(); // hostname -> { cooldownUntil (plain requests refused), blockedUntil (bot check), lastRequestAt }
function _getHostState(hostname) {
  let s = _hostState.get(hostname);
  if (!s) { s = { cooldownUntil: 0, blockedUntil: 0, lastRequestAt: 0, lastSearchAt: 0 }; _hostState.set(hostname, s); }
  return s;
}

// Wiring from server.js (the module works without it, in memory only, which is what the tests use).
let _braveLists = createTtlDiskCache({ maxEntries: BRAVE_LIST_MAX }); // "brave:safe|raw:query" -> list of results
let _botState = createTtlDiskCache(); // 'brave' -> { until, strikes }
let _searchSpacingMs = 0;
let _ready = null; // the disk caches are read once, and the pause that was running is put back
let _botStrikes = 0;
let _botUntil = 0;

function configure({ cacheDir, searchSpacingMs = 0, saveDebounceMs } = {}) {
  _searchSpacingMs = searchSpacingMs;
  if (!cacheDir) return;
  const opts = saveDebounceMs === undefined ? {} : { saveDebounceMs };
  _braveLists = createTtlDiskCache({ ...opts, maxEntries: BRAVE_LIST_MAX });
  _botState = createTtlDiskCache(opts);
  _braveLists.configure({ cacheFilePath: path.join(cacheDir, 'cover-search.json') });
  _botState.configure({ cacheFilePath: path.join(cacheDir, 'cover-search-state.json') });
  _ready = null;
}

function _whenReady() {
  if (!_ready) {
    _ready = (async () => {
      await Promise.all([_braveLists.ensureLoaded(), _botState.ensureLoaded()]);
      const saved = _botState.getFresh('brave', Infinity);
      if (saved) {
        _botStrikes = saved.strikes || 0;
        _botUntil = saved.until || 0;
        const s = _getHostState(BRAVE_HOST);
        s.blockedUntil = Math.max(s.blockedUntil, _botUntil);
      }
    })();
  }
  return _ready;
}

// Brave asked for its bot check: pause, for longer each time it comes back soon after the last pause.
function _noteBotCheck() {
  const now = Date.now();
  if (now - _botUntil > BOT_CHECK_FORGET_MS) _botStrikes = 0;
  _botStrikes += 1;
  const waitMs = Math.min(BOT_CHECK_COOLDOWN_MS * 2 ** (_botStrikes - 1), BOT_CHECK_COOLDOWN_MAX_MS);
  _botUntil = now + waitMs;
  _getHostState(BRAVE_HOST).blockedUntil = _botUntil;
  _botState.set('brave', { until: _botUntil, strikes: _botStrikes });
}

// A good search ends the run of checks.
function _noteBraveWorked() {
  if (!_botStrikes) return;
  _botStrikes = 0;
  _botState.set('brave', { until: _botUntil, strikes: 0 });
}

// How long until the host may be asked again, for the person to see (relative, so a clock that differs between the server and the page does not matter).
function _retryInMs() {
  const s = _getHostState(BRAVE_HOST);
  return Math.max(0, Math.max(s.blockedUntil, s.cooldownUntil) - Date.now());
}

const _resultCache = new Map(); // "engine:query:page" -> { urls, expiresAt }
function _cacheGet(key) {
  const hit = _resultCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { _resultCache.delete(key); return null; }
  return hit.urls;
}
function _cacheSet(key, urls) {
  if (!urls.length) return;
  if (_resultCache.size >= RESULT_CACHE_MAX) {
    const oldestKey = _resultCache.keys().next().value; // Map preserves insertion order
    if (oldestKey !== undefined) _resultCache.delete(oldestKey);
  }
  _resultCache.set(key, { urls, expiresAt: Date.now() + RESULT_CACHE_TTL_MS });
}

// since: when the search began, if it already waited for its turn: that wait comes out of the browser's time, so the whole search stays inside what the API allows.
async function fetchSearchHtml(url, acceptLanguage, { since } = {}) {
  const hostname = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
  const hostState = _getHostState(hostname);
  const startedAt = since || Date.now();

  if (Date.now() < hostState.blockedUntil) {
    const err = new Error(`${hostname} asked for a bot check, leaving it alone for a while`);
    err.rateLimited = true;
    throw err;
  }

  const sinceLastMs = Date.now() - hostState.lastRequestAt;
  if (sinceLastMs < MIN_REQUEST_SPACING_MS) {
    await new Promise((r) => setTimeout(r, MIN_REQUEST_SPACING_MS - sinceLastMs));
  }
  hostState.lastRequestAt = Date.now();
  // Google (and Brave) increasingly hydrate image results via JS rather
  // than embedding them in the initial response — a bare fetch() often
  // gets a shell with nothing the regexes below can find, which is why
  // this search used to fail unpredictably. Playnite's own Google Images
  // picker sidesteps the same problem by rendering the page in a real
  // (headless) browser instead of parsing raw HTML; FlareSolverr already
  // gives this app that same capability (a real headless-Chromium proxy,
  // already used by BatCave/AniZone/etc. for their own anti-bot pages), so
  // try it first here too — falling back to the plain fetch below when
  // it's not configured/reachable rather than failing the search outright.
  // Bounded to CALLER_PATIENCE.coverTryMs rather than resolveViaSolver's own ~40s budget (needed elsewhere for genuinely slow Cloudflare
  // challenges). That is 24 s because the Brave images page was MEASURED at 12 s with a cold browser and 7 s with a warm one: the 8 s it used to
  // be gave up just before the page arrived on every search. An install with no FlareSolverr fails this step at once (nothing listens), so
  // it does not wait at all.
  // The 429 cooldown is NOT checked before this: it comes from the PLAIN request below, which Brave refuses, and it used to stop the
  // browser too, so one refused plain request made every search fail for five minutes although the browser path works.
  // oneOff: Google and Brave keep SafeSearch in cookies as well as in the URL, and a shared session would carry the cookie of a search
  // made with "Hide NSFW" off into the next one that asked for the filter, so each search gets a browser of its own, as before the pool.
  const tryMs = since ? Math.max(5_000, CALLER_PATIENCE.coverTryMs - (Date.now() - since)) : CALLER_PATIENCE.coverTryMs;
  try {
    const solved = await withTimeout(
      runWithSolverContext({ priority: 'background', deadlineAt: Date.now() + tryMs - CALLER_PATIENCE.coverGiveUpMarginMs, oneOff: true }, () => resolveViaSolver(url)),
      tryMs,
      'FlareSolverr timed out',
    );
    if (solved) return solved;
  } catch (_) {
    // Not configured, unreachable, too slow, or failed to solve — fall through.
  }

  // The plain request is what a host rate-limits: the cooldown stops it, and it only gets what is left of the search's total time.
  if (Date.now() < hostState.cooldownUntil) {
    const err = new Error(`${hostname} is rate-limited, cooling down`);
    err.rateLimited = true;
    throw err;
  }
  const left = CALLER_PATIENCE.coverTotalMs - (Date.now() - startedAt);
  const response = await safeFetch(url, {
    headers: {
      ...DEFAULT_FETCH_HEADERS,
      'Accept-Language': acceptLanguage,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(Math.max(3_000, Math.min(12_000, left))),
  });

  if (response.status === 429) {
    hostState.cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
    const err = new Error(`${hostname} returned 429`);
    err.rateLimited = true;
    throw err;
  }

  if (!response.ok) return null;
  return response.text();
}

function extractGoogleImageUrls(html) {
  const picked = [];
  const raw = String(html || '');
  const normalized = raw
    .replace(/\\u003d/gi, '=')
    .replace(/\\u0026/gi, '&')
    .replace(/\\x3d/gi, '=')
    .replace(/\\x26/gi, '&');

  const addCandidate = (value) => {
    const cleaned = String(value || '')
      .replace(/\\\//g, '/')
      .replace(/&amp;/g, '&')
      .trim();
    if (!isSafeUrl(cleaned)) return;
    if (/google\.(?:com|[a-z]{2,})\/images\/branding/i.test(cleaned)) return;
    picked.push(upgradeThumbnailUrl(cleaned));
  };

  const imgUrlRe = /[?&]imgurl=([^&"'\s>]+)/gi;
  const imgUrlEscapedRe = /imgurl=(https?:\\\/\\\/[^&"'\s>]+)/gi;
  let m;
  while ((m = imgUrlRe.exec(normalized)) !== null) {
    try {
      addCandidate(decodeURIComponent(m[1]));
    } catch {
      // Ignore malformed URL fragments.
    }
  }

  while ((m = imgUrlEscapedRe.exec(normalized)) !== null) {
    try {
      addCandidate(decodeURIComponent(m[1]));
    } catch {
      // Ignore malformed URL fragments.
    }
  }

  const jsonUrlRes = [
    /"ou":"(https?:\\\/\\\/[^"\\]+)"/gi,
    /"murl":"(https?:\\\/\\\/[^"\\]+)"/gi,
    /"imgurl":"(https?:\\\/\\\/[^"\\]+)"/gi,
  ];
  for (const re of jsonUrlRes) {
    while ((m = re.exec(raw)) !== null) addCandidate(m[1]);
  }

  const escapedThumbRe = /https?:\\\/\\\/(?:encrypted-tbn0\.gstatic\.com|[^"'\s<>]+)\\\/[^"'\s<>]+/gi;
  while ((m = escapedThumbRe.exec(raw)) !== null) addCandidate(m[0]);

  if (picked.length === 0) {
    const imgSrcRe = /<img[^>]+src=["'](https?:\/\/[^"']+)["']/gi;
    while ((m = imgSrcRe.exec(normalized)) !== null) {
      addCandidate(m[1]);
    }
  }

  return dedupeUrls(picked, 40);
}

// Brave's own result title travels with each image (a JS object literal
// per result, not valid JSON: {title:"...",url:"...",...,thumbnail:{...,
// original:"https://...",...}). Pairing title with image, instead of just
// pulling every "original:" URL in isolation, matters because Brave's own
// indexed data can genuinely mismatch the two — confirmed live on a niche
// manhua search: a result whose title read "Book cover Gushing over
// Magical Girls" pointed at an Amazon image for a completely unrelated
// book. That's Brave/Amazon's own data, not something this scraper can
// correct, but surfacing the real per-result title (instead of the search
// query repeated under every card, which is what the caller used to fall
// back to) at least makes a mismatch like that visible to the user
// choosing a cover, rather than presented as if every card were a
// confirmed match.
// Brave's own "Verifying you're not a bot" page: what it sends to a client it finds suspicious (measured 2026-11-01, after a few searches in a row).
function isBraveBotCheck(html) {
  return /Verifying you(?:'|&#x27;|&#39;|’)re not a bot|decided to schedule a captcha/i.test(String(html || '').slice(0, 200_000));
}

function extractBraveImageResults(html) {
  const raw = String(html || '');
  const picked = [];
  const seen = new Set();

  const addCandidate = (url, title) => {
    const cleanedUrl = String(url || '').replace(/\\\//g, '/').replace(/&amp;/g, '&').trim();
    if (!isSafeUrl(cleanedUrl)) return;
    if (/search\.brave\.com\//i.test(cleanedUrl)) return;
    if (/\/icons?\//i.test(cleanedUrl)) return;
    // Dedupe on the URL actually being stored/returned, not the raw one —
    // upgradeThumbnailUrl can map two different raw URLs (e.g. Pinterest's
    // /236x/ and /474x/ size variants of the same pin) to the identical
    // final URL; deduping on the pre-upgrade string let both through.
    const upgradedUrl = upgradeThumbnailUrl(cleanedUrl);
    if (seen.has(upgradedUrl)) return;
    seen.add(upgradedUrl);
    const cleanedTitle = String(title || '')
      .replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/&amp;/g, '&').trim();
    picked.push({ url: upgradedUrl, title: cleanedTitle });
  };

  // Non-greedy gap between title and original never crosses into the next
  // result in practice (each result's own original field appears well
  // before the next result's title in Brave's payload), so this reliably
  // pairs the two without needing a full (non-JSON-valid) parse. Capped
  // generously (2000, not a tighter bound closer to the ~550 chars a real
  // result was confirmed to use) so a result carrying more metadata than
  // usual before its own `original` field — a longer description, an
  // inlined thumbnail — doesn't make the match skip ahead and pair this
  // title with a later, unrelated result's image instead of failing closed.
  const pairRe = /title:"((?:[^"\\]|\\.)*)"[\s\S]{0,2000}?original:"(https?:\/\/[^"\\]+)"/g;
  let m;
  while ((m = pairRe.exec(raw)) !== null) addCandidate(m[2], m[1]);

  if (picked.length === 0) {
    // Fallback for whenever Brave's payload shape doesn't match the above
    // (page structure change) — same URL-only extraction as before, title
    // left blank so the caller falls back to the query text.
    const originalRe = /original:"(https?:\/\/[^"\\]+)"/gi;
    while ((m = originalRe.exec(raw)) !== null) addCandidate(m[1], '');
    if (picked.length === 0) {
      const imageFieldRe = /(?:url|resized):"(https?:\/\/[^"\\]+)"/gi;
      while ((m = imageFieldRe.exec(raw)) !== null) addCandidate(m[1], '');
    }
  }

  return picked.slice(0, BRAVE_MAX_RESULTS);
}

// SafeSearch is OFF by default (a manga cover search routinely needs ecchi-ish
// results the filters drop), but the caller can ask for it ON — the cover
// picker does exactly that whenever the user has "Hide NSFW" enabled, so that
// setting also covers what a web image search puts on screen. The genre
// blacklist/Hide NSFW heuristics only ever see library/source items, never
// the raw results of an image search, so without this the toggle would hide
// everything EXCEPT the one place that can show an unfiltered image grid.
function buildGoogleImageSearchUrl({ q, start, hl, gl, safe }) {
  return `https://www.google.com/search?tbm=isch&safe=${safe ? 'active' : 'off'}&ijn=0&q=${encodeURIComponent(q)}&start=${start}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`;
}

function buildBraveImageSearchUrl({ q, page, safe }) {
  return `https://search.brave.com/images?q=${encodeURIComponent(q)}&page=${page}&source=web&safesearch=${safe ? 'strict' : 'off'}`;
}

async function searchGoogleImageUrls({ q, start, hl, gl, safe }) {
  // The flag is part of the cache key: a result list fetched unfiltered must
  // never be replayed to a request that asked for the filtered one.
  const cacheKey = `google:${safe ? 'safe' : 'raw'}:${q}:${start}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return { urls: cached, rateLimited: false };

  const url = buildGoogleImageSearchUrl({ q, start, hl, gl, safe });
  try {
    const html = await fetchSearchHtml(url, `${hl},en;q=0.9`);
    if (!html) return { urls: [], rateLimited: false };
    const urls = extractGoogleImageUrls(html);
    _cacheSet(cacheKey, urls);
    return { urls, rateLimited: false };
  } catch (e) {
    return { urls: [], rateLimited: !!e.rateLimited };
  }
}

// One real Brave search at a time, one after the other: two searches that overlap are what looks like a bot.
let _braveTail = Promise.resolve();
function _braveTurn(task) {
  const run = _braveTail.then(task, task);
  _braveTail = run.catch(() => {});
  return run;
}

async function searchBraveImageUrls({ q, start, count, safe }) {
  await _whenReady();
  // The list of a query is cached WHOLE (safe flag in the key: a list fetched unfiltered is never replayed to a request that asked for the
  // filter) and a page is a slice of it: "load more" finds the list already here and makes no request.
  const cacheKey = `brave:${safe ? 'safe' : 'raw'}:${q}`;
  const slice = (list) => list.slice(start, start + count);
  const have = () => _braveLists.getFresh(cacheKey, BRAVE_LIST_TTL_MS);
  const limited = () => ({ results: [], rateLimited: true, retryInMs: _retryInMs() });
  const known = have();
  if (known) return { results: slice(known), rateLimited: false, retryInMs: 0 };

  return _braveTurn(async () => {
    const twin = have(); // the same search, queued ahead of this one, may have brought the list
    if (twin) return { results: slice(twin), rateLimited: false, retryInMs: 0 };
    const hostState = _getHostState(BRAVE_HOST);
    if (Date.now() < hostState.blockedUntil) return limited();

    const startedAt = Date.now();
    const sinceLast = Date.now() - hostState.lastSearchAt;
    if (hostState.lastSearchAt && sinceLast < _searchSpacingMs) {
      await new Promise((resolve) => { setTimeout(resolve, _searchSpacingMs - sinceLast); });
    }

    // safesearch=off unless the caller asked for the filter (see buildGoogleImageSearchUrl above). It was off for Brave too from the
    // start, because left unset Brave silently applied its default (moderate) filter the whole time Brave has been the real, working provider.
    const url = buildBraveImageSearchUrl({ q, page: 1, safe });
    try {
      const html = await fetchSearchHtml(url, 'en-US,en;q=0.9', { since: startedAt });
      if (!html) return { results: [], rateLimited: false, retryInMs: 0 };
      if (isBraveBotCheck(html)) {
        _noteBotCheck();
        return limited();
      }
      const list = extractBraveImageResults(html);
      if (list.length) { _braveLists.set(cacheKey, list); _noteBraveWorked(); }
      return { results: slice(list), rateLimited: false, retryInMs: 0 };
    } catch (e) {
      return e.rateLimited ? limited() : { results: [], rateLimited: false, retryInMs: 0 };
    } finally {
      hostState.lastSearchAt = Date.now();
    }
  });
}

/**
 * Resolves cover candidates via Brave (the real, working provider — see
 * below). Keeps endpoint behavior stable while isolating provider logic.
 *
 * Google used to be tried first here, with Brave as the fallback. Confirmed
 * live that Google no longer works at all: its Images page has moved to
 * full JS-hydration with zero image data in the raw HTML (checked every
 * extraction pattern this file knows plus a broad "any .jpg/.png/.webp URL"
 * sweep — all zero matches on a real, complete 90KB+ response), and the
 * FlareSolverr real-browser fallback meant to handle exactly that case
 * doesn't just take a while on this page, it hangs completely (confirmed
 * 90+ seconds, no response). So every search was *already* silently falling
 * through to Brave 100% of the time — just after burning the 8s FlareSolverr
 * budget first, and while still telling the frontend "Google Images" was
 * the provider by default. Brave is now the real, honest primary: tried
 * first, no wasted attempt on a path confirmed dead, and its own name in
 * the `provider` field the whole time. Google is kept available behind an
 * explicit `engine=google` request only, in case its page structure or
 * FlareSolverr's behavior on it ever changes back.
 */
async function searchCoverImages(rawQuery) {
  const q = safeQuery(rawQuery.q);
  if (!q) {
    const err = new Error('Missing query');
    err.statusCode = 400;
    throw err;
  }

  const start = safeInt(rawQuery.start, 0, 0, 200);
  const count = safeInt(rawQuery.count, 12, 1, 30);
  const gl = String(rawQuery.gl || 'us').slice(0, 8);
  const hl = String(rawQuery.hl || 'en').slice(0, 8);
  const requestedEngine = String(rawQuery.engine || '').trim().toLowerCase();
  const safe = /^(1|true|on)$/i.test(String(rawQuery.safe || '').trim());

  let results = []; // {url, title}
  let provider = 'Brave Images';
  let rateLimited = false;
  let retryInMs = 0;

  if (requestedEngine === 'google') {
    provider = 'Google Images';
    const google = await searchGoogleImageUrls({ q, start, hl, gl, safe });
    results = google.urls.map((url) => ({ url, title: '' }));
    rateLimited = google.rateLimited;
    if (results.length === 0) provider = 'Brave Images';
  }

  // Once Google's own attempt is already rate-limited, don't immediately
  // burn a second request against Brave too — that's the same "just tried
  // and got blocked, retrying right now only makes it worse" situation
  // this whole cache/cooldown/spacing setup exists to avoid.
  if (results.length === 0 && !rateLimited) {
    provider = 'Brave Images';
    const brave = await searchBraveImageUrls({ q, start, count, safe });
    results = brave.results;
    rateLimited = brave.rateLimited;
    retryInMs = brave.retryInMs;
  }

  const limited = results.slice(0, count);
  const items = limited.map((r, idx) => ({
    id: `${provider === 'Brave Images' ? 'brave' : 'google'}-${start + idx}`,
    // The real per-result title Brave associated with this specific image
    // when available — falls back to the search query only when extraction
    // couldn't find one (Google's path, or Brave's own URL-only fallback).
    // Showing the real title matters: Brave's own indexed data can pair a
    // title with an unrelated image (confirmed live), and repeating the
    // query under every card hid that instead of surfacing it.
    title: r.title || q,
    cover: r.url,
    provider,
    sourceId: 'google-images',
  }));

  return {
    items,
    hasNextPage: limited.length >= count,
    rateLimited,
    retryInMs: rateLimited ? retryInMs : 0,
  };
}

module.exports = {
  configure,
  searchCoverImages,
  buildGoogleImageSearchUrl,
  buildBraveImageSearchUrl,
};
