/**
 * leagueofcomicgeeks/service.js — Fallback cover/publisher lookup for Western
 * comics (e.g. BatCave) against League of Comic Geeks, used only when
 * ComicVine (the primary source) has no confident match.
 *
 * LOCG has no public API, so this scrapes its search results page. Unlike
 * ComicVine, LOCG sits behind Cloudflare, so requests go through fetchText()
 * — the same FlareSolverr-backed helper BatCave itself uses — which
 * transparently solves the challenge once per domain and reuses the session
 * cookie for subsequent lookups.
 *
 * Matching carries the same risk as the ComicVine lookup (a mismatch would
 * silently attach the WRONG comic's cover), so it reuses the exact same
 * exact-name + year-disambiguation rule — see comics-metadata/title-matching.
 */

'use strict';

const cheerio = require('cheerio');
const { fetchText } = require('../network/fetch-utils');
const { parseTitle, pickBestMatch } = require('../comics-metadata/title-matching');
const { withTimeout } = require('../common/async-utils');
const { LOCG_REQUEST_FAILED } = require('../errors/error-codes');
const { recordError } = require('../error-logger');
const { createTtlDiskCache } = require('../common/ttl-disk-cache');
const { runWithSolverContext } = require('../network/solver-context');

const SEARCH_URL = 'https://leagueofcomicgeeks.com/search';
// Part of every cache key. Bumped to 'v2' when the FlareSolverr helper stopped handing one
// lookup the page of another (its per-domain lock did): a "no match" written before then is
// kept for up to CACHE_TTL_MS and can be wrong, so those entries are simply never read again.
const CACHE_KEY_VERSION = 'v2';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // cover/publisher data rarely changes
const SAVE_DEBOUNCE_MS = 2_000;

// fetchText() here goes through FlareSolverr (LOCG sits behind Cloudflare),
// and a cold solve can take ~15-20s — unlike ComicVine's plain API call,
// which is already safely bounded by its own 10s REQUEST_TIMEOUT_MS. Without
// a cap here, a cold lookup plus BatCave's own page fetch can together
// exceed the app's global 30s API timeout (limits.sourceCallTimeoutMs) and
// fail the whole search instead of just this optional enrichment step.
// Giving up early and returning null (BatCave's own cover) is always safe;
// the FlareSolverr session still finishes warming up in the background, so
// the next lookup is fast. That stays true under the session pool because
// the deadline declared below only drops a lookup that is still WAITING for
// the browser (boundSolve is not set): one that is already solving carries
// on to the end and saves the cookie.
const LOOKUP_TIMEOUT_MS = 12_000;

// A FAILED lookup (timeout, Cloudflare block, parse error) used to be
// forgotten immediately, so every repeat of the same title waited out the
// full LOOKUP_TIMEOUT_MS again and logged another ERROR-018 — confirmed
// live: one title had failed 32 times since early September, mostly from
// System Health probing BatCave on every page load. Remembering the failure
// briefly stops that without giving up the "next attempt is fast once
// FlareSolverr has warmed up" benefit described above, which is why this is
// minutes, not the 24h a real answer (including "no match") is kept for.
const FAILURE_TTL_MS = 10 * 60 * 1000;
const FAILED_LOOKUP = Object.freeze({ lookupFailed: true });

// Same rationale as comicvine/service.js: restarts are frequent during
// development, and every lookup here also costs a lot more than a ComicVine
// call when it can't reuse a warm FlareSolverr session — persisting to disk
// keeps that cost from being repaid on every restart.
const ttlCache = createTtlDiskCache({ saveDebounceMs: SAVE_DEBOUNCE_MS });

/**
 * @param {{ cacheFilePath: string }} options
 */
function configure({ cacheFilePath } = {}) {
  ttlCache.configure({ cacheFilePath });
}

/**
 * Parses LOCG's /search results page into series-level candidates.
 * Each result <li> carries the series title/link, a cover <img> (lazy-loaded
 * via data-src, falling back to src for already-loaded images), and a
 * "Publisher · Year[ - Year|- Present]" meta line.
 */
function parseSearchResults(html) {
  const $ = cheerio.load(html);
  const candidates = [];

  $('li').each((_, el) => {
    const titleLink = $(el).find('.title a.link-collection-series').first();
    if (!titleLink.length) return;
    const name = titleLink.text().replace(/\s+/g, ' ').trim();
    if (!name) return;

    const img = $(el).find('.cover img').first();
    const cover = img.attr('data-src') || img.attr('src') || '';

    const metaText = $(el).find('.copy-really-small').first().text().replace(/\s+/g, ' ').trim();
    const metaMatch = metaText.match(/^(.+?)\s*·\s*(\d{4})/);

    candidates.push({
      name,
      cover,
      publisher: metaMatch ? metaMatch[1].trim() : '',
      year: metaMatch ? Number(metaMatch[2]) : null,
    });
  });

  return candidates;
}

/**
 * Looks up a comic series on League of Comic Geeks by title.
 *
 * @param {{ title: string, year?: number }} args `year`, when given,
 *   overrides whatever parseTitle() would otherwise guess from the title
 *   string itself — see comicvine/service.js's lookupCover for why.
 * @returns {Promise<{ cover: string, publisher: string } | null>}
 *   null when lookup fails or has no confident match.
 */
async function lookupCover({ title, year: explicitYear } = {}) {
  const { cleanTitle, year: titleYear } = parseTitle(title);
  const year = explicitYear ?? titleYear;
  if (!cleanTitle) return null;

  await ttlCache.ensureLoaded();

  const cacheKey = `${CACHE_KEY_VERSION}|${cleanTitle.toLowerCase()}|${year || ''}`;
  const cached = ttlCache.getFresh(cacheKey, CACHE_TTL_MS);
  if (cached !== undefined) {
    if (!cached?.lookupFailed) return cached;
    // A remembered failure only counts for FAILURE_TTL_MS; past that, fall
    // through and try the network again.
    if (ttlCache.getFresh(cacheKey, FAILURE_TTL_MS) !== undefined) return null;
  }

  try {
    const url = `${SEARCH_URL}?keyword=${encodeURIComponent(cleanTitle)}`;
    const html = await withTimeout(
      runWithSolverContext({ priority: 'background', deadlineAt: Date.now() + LOOKUP_TIMEOUT_MS }, () => fetchText(url)),
      LOOKUP_TIMEOUT_MS,
      `LOCG lookup exceeded ${LOOKUP_TIMEOUT_MS}ms`,
    );
    const candidates = parseSearchResults(html);

    const match = pickBestMatch(candidates, cleanTitle, year, c => c.name, c => c.year);
    const cover = match && /^https?:\/\//.test(match.cover) ? match.cover : '';
    const result = cover ? { cover, publisher: match.publisher || '' } : null;

    ttlCache.set(cacheKey, result);
    return result;
  } catch (err) {
    ttlCache.set(cacheKey, FAILED_LOOKUP);
    await recordError({
      code: LOCG_REQUEST_FAILED,
      area: 'leagueofcomicgeeks',
      message: err.message,
      details: { title: cleanTitle },
    }).catch(() => {});
    return null;
  }
}

module.exports = { configure, lookupCover };
