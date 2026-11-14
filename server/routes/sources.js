/**
 * routes/sources.js — Source install / uninstall + generic source method dispatcher
 *
 * Endpoints:
 *   POST /api/sources/install      — Download and register a remote JS source
 *   POST /api/sources/uninstall    — Remove a registered source
 *   POST /api/source/:id/:method   — Dispatch a method call to a source module
 *   GET  /api/popular-all          — Aggregate trending results from all sources
 *
 * Security:
 *  • Source IDs are validated with safeId() on every endpoint.
 *  • Install: the codeUrl is SSRF-guarded with isSafeUrl() before fetching.
 *  • Dispatch: accepted methods are whitelisted; arbitrary method names are
 *    rejected with 400.
 *  • Per-source call timeout: each source method call is wrapped in a
 *    Promise.race with a 30-second timeout helper so a hung scraper
 *    cannot stall the server process indefinitely.
 *
 * Performance:
 *  • popular-all uses a 60-second in-memory TTL to avoid hammering all
 *    installed sources on every home-screen render.
 *  • Results are merged by interleaving source buckets (zip), de-duplicated
 *    by title (case-insensitive), and capped at 40 items.
 */

'use strict';

const { safeId } = require('../helpers');
const { readStore, writeStore } = require('../store');
const {
  sourcePath,
  builtinSourcePath,
  loadSourceFromFile,
  clearSourceCache,
  listAvailableSourcesFromRepos,
} = require('../sourceLoader');
const { createSourceDispatchService } = require('../modules/sources/dispatch-service');
const { createPopularAllService } = require('../modules/sources/popular-all');
const { createSourceLifecycleService } = require('../modules/sources/lifecycle');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { withTimeout: raceWithTimeout } = require('../modules/common/async-utils');
const { createProxyService } = require('../modules/proxy/service');
const { createAniListDescriptionFallback } = require('../modules/anilist/description-fallback');
const { createAniListAuthorFallback } = require('../modules/anilist/author-fallback');
const { createMangaUpdatesService } = require('../modules/mangaupdates/service');
const { isSafeUrl } = require('../helpers');
const limits = require('../config/limits');

// A floor, not just the configured default — confirmed live that BatCave's
// multi-native-page stitch (browse-all, genre browsing) combined with a
// single retry on an unlucky first attempt (see data/sources/batcave.js's
// getHtmlRetrying) routinely lands at 30-31s, right on top of the plain
// 30s default. That's not a hang, just legitimately slow, but the old
// shared default gave it no room to ever finish before both this dispatch-
// level race AND the outer HTTP apiTimeout middleware (server.js) cut it
// off at the exact same instant. Only affects this file's own dispatchers
// (popularAllService/sourceDispatchService below) - fast sources return in
// a couple seconds regardless of how high the ceiling is.
const SOURCE_CALL_TIMEOUT = Math.max(limits.sourceCallTimeoutMs || 30000, 45000);

const LIST_METHODS = new Set([
  'search',
  'trending',
  'recentlyAdded',
  'latestUpdates',
  'popularAllTime',
  'byGenres',
  'authorSearch',
]);

function isTransientSourceError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('timed out')
    || msg.includes('timeout')
    || msg.includes('rate limited')
    || msg.includes('temporarily unavailable')
    || msg.includes('cloudflare')
    || msg.includes('challenge')
    || msg.includes('econnreset')
    || msg.includes('etimedout');
}

// Delegates to the shared, leak-free race in modules/common/async-utils.js
// (this used to reimplement the same Promise.race here without ever
// clearing its own setTimeout when the source call won the race first —
// one leaked timer per call) while keeping this file's own labeled message
// format, since isTransientSourceError() above and callers elsewhere match
// on "... timed out after Nms" verbatim.
function withTimeout(promise, ms = SOURCE_CALL_TIMEOUT, label = 'source call') {
  return raceWithTimeout(promise, ms, `${label} timed out after ${ms}ms`);
}

const asyncHandler = createAsyncHandler('SOURCES');

const popularAllService = createPopularAllService({
  readStore,
  loadSourceFromFile,
  withTimeout,
  timeoutMs: SOURCE_CALL_TIMEOUT,
});

const sourceLifecycleService = createSourceLifecycleService({
  readStore,
  writeStore,
  sourcePath,
  builtinSourcePath,
  loadSourceFromFile,
  clearSourceCache,
  listAvailableSourcesFromRepos,
  invalidatePopularAll: () => popularAllService.invalidate(),
});

const sourceDispatchService = createSourceDispatchService({
  safeId,
  loadSourceFromFile,
  withTimeout,
  timeoutMs: SOURCE_CALL_TIMEOUT,
});

// Reused just for its generic AniList GraphQL passthrough — not the same
// concern as image proxying, but proxyAniList() already lives there and
// this avoids standing up a second AniList-calling instance.
const { proxyAniList } = createProxyService({ isSafeUrl });
const mangaUpdatesServiceForFallback = createMangaUpdatesService();
const aniListDescriptionFallback = createAniListDescriptionFallback({
  proxyAniList,
  searchMangaUpdatesDescription: mangaUpdatesServiceForFallback.searchDescriptionByTitle,
});
const aniListAuthorFallback = createAniListAuthorFallback({ proxyAniList });

const { requireValidIdParam } = require('../middleware/validation');

/**
 * @param {import('express').Router} router
 */
function registerSourceRoutes(router) {
  // ── POST /api/sources/install ──────────────────────────────────────────────
  router.post('/api/sources/install', asyncHandler(async (req, res) => {
    // ID comes in body, sourceLifecycleService.installById validates internally
    const result = await sourceLifecycleService.installById(req.body?.id);
    res.json(result);
  }));

  // ── POST /api/sources/uninstall ────────────────────────────────────────────
  router.post('/api/sources/uninstall', asyncHandler(async (req, res) => {
    // ID comes in body, sourceLifecycleService.uninstallById validates internally
    const result = await sourceLifecycleService.uninstallById(req.body?.id);
    res.json(result);
  }));

  // ── POST /api/source/:id/:method ────────────────────────────────────────────
  // Whitelisted methods only — arbitrary method names are rejected.
  router.post('/api/source/:id/:method', requireValidIdParam('id'), asyncHandler(async (req, res) => {
    // Matches SOURCE_CALL_TIMEOUT above (with a little extra margin so that
    // timeout - not this route's own HTTP-level ceiling - is what actually
    // fires and produces the clean "timed out after Nms" message) - without
    // this override, the blanket 30s apiTimeout middleware (server.js) cuts
    // every request off before a legitimately-slow-but-working source call
    // (confirmed live: BatCave's browse/genre pages) ever gets the extra
    // room SOURCE_CALL_TIMEOUT above was just given.
    req.setTimeout(50_000);
    res.setTimeout(50_000);
    const { id, method } = req.params;
    const body = req.body || {};

    const { getLocalService } = require('./local');
    const localService = getLocalService ? getLocalService() : null;

    // Prefer offline pages if downloaded
    if (localService && method === 'pages' && body.mangaId && body.chapterId) {
      const offlinePages = await localService.getOfflinePages(id, body.mangaId, body.chapterId);
      if (offlinePages) return res.json(offlinePages);
    }

    try {
      let result = await sourceDispatchService.dispatch({ id, method, body });
      if (method === 'mangaDetails') {
        // Swaps in AniList's description when the source's own one doesn't
        // look like English (see description-fallback.js) — a no-op for
        // the common case, so this never slows down a normal response.
        result = await aniListDescriptionFallback.maybeReplaceDescription(result);
        // Same idea for a missing/visibly-wrong author (see author-fallback.js).
        result = await aniListAuthorFallback.maybeReplaceAuthor(result);
      }
      if (res.headersSent) return;
      res.json(result);
    } catch (e) {
      if (res.headersSent) return;
      if (LIST_METHODS.has(method) && isTransientSourceError(e)) {
        return res.json({
          results: [],
          hasNextPage: false,
          temporarilyUnavailable: true,
          error: e.message,
        });
      }

      if (localService && body.mangaId) {
        if (method === 'mangaDetails') {
          const synthetic = await localService.getSyntheticMangaDetails(id, body.mangaId);
          if (synthetic) return res.json(synthetic);
        } else if (method === 'chapters') {
          const synthetic = await localService.getSyntheticChapters(id, body.mangaId);
          if (synthetic) return res.json(synthetic);
        }
      }
      throw e;
    }
  }));

  // ── GET /api/popular-all ───────────────────────────────────────────────────
  router.get('/api/popular-all', asyncHandler(async (req, res) => {
    const response = await popularAllService.getPopularAll();
    res.json(response);
  }));
}

// Allow other modules (e.g. sourceLoader) to invalidate the popular-all cache.
function invalidatePopularCache() {
  popularAllService.invalidate();
}

module.exports = { registerSourceRoutes, invalidatePopularCache };
