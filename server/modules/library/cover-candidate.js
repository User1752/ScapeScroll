'use strict';

// server/modules/library/cover-candidate.js — per-manga "does this cover
// need upgrading, and if so what's a better one" lookup for the Cover Scan
// feature (public/modules/ui-cover-scan.js). Deliberately one manga at a
// time, not a bulk sweep — the client drives a worker pool over the whole
// library and streams results into a review table as each one resolves,
// the same shape ui-migrate.js's own comparison step already uses.
//
// Never writes anything back to the store — this is read-only discovery.
// Applying a chosen cover reuses the existing POST /api/library/cover route
// (content-service.js's updateLibraryCover) unchanged.

const { titleSimilarity } = require('../common/title-similarity');
const { readImageSize } = require('../common/image-dimensions');
const { parseProxiedUrl, MIN_ACCEPTABLE_BYTES } = require('../system-health/image-quality-health');

// Same reasoning as service.js's importAniListLibrary FUZZY_MERGE_THRESHOLD:
// no human confirms a title-search match before it's offered as a
// candidate here, so it needs to clear a high bar, not just "looks close".
const TITLE_MATCH_MIN_SIM = 0.8;

// A cleanly-compressed thumbnail can clear MIN_ACCEPTABLE_BYTES on file size
// alone while still being genuinely low-res (confirmed live: a 225x348 webp
// cover weighing 23KB, well above that floor). Width is the binding
// dimension for the portrait covers this app deals in, so it alone is
// enough — no need to also reason about aspect ratio. Chosen to sit above
// AniList's own "medium" cover tier (~230px wide, confirmed to be exactly
// what a couple of real undersized covers turned out to use) and below its
// "large"/"extraLarge" tiers, so a genuine upgrade is available above it.
const MIN_ACCEPTABLE_WIDTH = 300;

// MangaDex's own scraper (data/sources/mangadex.js) deliberately requests a
// downsized thumbnail — a ".256.jpg"/".512.jpg" suffix on top of the real
// filename — but the full original lives at that exact same path with the
// suffix stripped. Confirmed live: a real stored cover was 256x370 at its
// stored URL and 350x506 with the suffix removed — same file, same art,
// just MangaDex's own resize tier. Tried before ever reaching out to
// AniList: same source as what's already showing, so there's no identity
// risk to verify, unlike a cross-service AniList match.
const MANGADEX_THUMB_SUFFIX_RE = /^(https:\/\/uploads\.mangadex\.org\/covers\/[^/]+\/.+\.jpg)\.\d+\.jpg$/i;

const CANDIDATE_QUERY_BY_ID = `query ($id: Int) {
  Media(id: $id, type: MANGA) {
    coverImage { extraLarge large }
  }
}`;

const CANDIDATE_QUERY_BY_SEARCH = `query ($search: String) {
  Media(search: $search, type: MANGA) {
    title { romaji english }
    coverImage { extraLarge large }
  }
}`;

// Short-lived result cache for repeat AniList lookups — GUIDELINES.md's
// "Rate limiting for external services" section requires this for any bulk
// job that queries the same host repeatedly, and names cover-search/
// index.js's _resultCache as the pattern to copy. Without it, re-opening
// Cover Scan (or clicking "Retry Skipped") shortly after a scan re-queries
// AniList from scratch for every title just checked, instead of reusing
// the still-fresh result.
const ANILIST_RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const _anilistResultCache = new Map(); // "id:123" | "search:title" -> { data, expiresAt }
function _cacheGet(key) {
  const hit = _anilistResultCache.get(key);
  if (!hit) return undefined;
  if (Date.now() > hit.expiresAt) { _anilistResultCache.delete(key); return undefined; }
  return hit.data;
}
function _cacheSet(key, data) {
  _anilistResultCache.set(key, { data, expiresAt: Date.now() + ANILIST_RESULT_CACHE_TTL_MS });
}

function createCoverCandidateService({ readStore, proxyAniList, fetchProxyImage }) {
  // Missing, or measured (same fetchProxyImage({measureBytes:true}) path
  // and MIN_ACCEPTABLE_BYTES threshold the System Health image-quality
  // check already uses) under that size — anything else is left alone.
  // Returns {needsUpgrade, dims}. dims travels back up to the client so a
  // "current 256x364 -> candidate 1800x2560" pair can be labeled with real
  // numbers — confirmed live that two covers sharing the exact same
  // artwork (a source's own thumbnail vs its original) render visually
  // identical at review-thumbnail size despite a 7x resolution gap, which
  // reads as "this didn't actually change anything" without the numbers.
  async function currentCoverNeedsUpgrade(cover) {
    if (!cover) return { needsUpgrade: true, dims: null };
    const parsed = parseProxiedUrl(cover);
    if (!parsed) return { needsUpgrade: true, dims: null }; // not a resolvable URL at all — treat as needing help
    try {
      const result = await fetchProxyImage({ ...parsed, measureBytes: true });
      const size = typeof result?.contentLength === 'number' ? result.contentLength : null;
      const dims = result.body ? readImageSize(result.body, result.contentType) : null;
      if (size == null || size < MIN_ACCEPTABLE_BYTES) return { needsUpgrade: true, dims };
      // Byte size alone can't catch a small-but-well-compressed image, so
      // also check the real pixel width — same buffer already in hand from
      // the measureBytes fetch above, no extra request needed.
      if (dims && dims.width < MIN_ACCEPTABLE_WIDTH) return { needsUpgrade: true, dims };
      return { needsUpgrade: false, dims };
    } catch (_) {
      return { needsUpgrade: true, dims: null }; // couldn't even fetch the current cover — needs help
    }
  }

  // AniList's own extraLarge/large fields can both silently point at the
  // exact same small "medium" file when a niche entry never had a bigger
  // asset uploaded (confirmed live — a real entry where extraLarge, large,
  // AND medium all resolved to the same 230x322 image). Requesting the
  // largest-named field is not the same as getting a large image, so the
  // fetched candidate needs its own dimensions verified before it's ever
  // offered — otherwise this would happily swap one small cover for
  // another equally small one and call it an upgrade.
  async function verifyCandidateCover(cover, matchType) {
    try {
      const result = await fetchProxyImage({ url: cover, measureBytes: true });
      const dims = result.body ? readImageSize(result.body, result.contentType) : null;
      if (dims && dims.width < MIN_ACCEPTABLE_WIDTH) return null;
      return { candidateCover: cover, matchType, dims };
    } catch (_) {
      return null;
    }
  }

  async function findSourceOriginalCover(cover) {
    const parsed = parseProxiedUrl(cover);
    if (!parsed) return null;
    const match = MANGADEX_THUMB_SUFFIX_RE.exec(parsed.url);
    if (!match) return null;
    return verifyCandidateCover(match[1], 'source-original');
  }

  async function findCandidateCover(favorite) {
    const sourceOriginal = await findSourceOriginalCover(favorite.cover);
    if (sourceOriginal) return sourceOriginal;

    // A rate-limited/failed AniList call and "AniList genuinely has nothing
    // better" both used to fall through to the same empty result — which
    // silently hid a real bad cover from the review list whenever AniList
    // happened to be throttled during the scan (confirmed live: a real
    // undersized cover vanished from a run that coincided with a 429).
    // Track failures separately so the caller can tell "checked, nothing
    // better" apart from "couldn't check" and surface the latter instead of
    // swallowing it.
    let anilistUnavailable = false;
    async function queryAniList(query, variables) {
      const cacheKey = `${query === CANDIDATE_QUERY_BY_ID ? 'id' : 'search'}:${variables.id ?? variables.search}`;
      const cached = _cacheGet(cacheKey);
      if (cached !== undefined) return cached;
      try {
        const { status, data } = await proxyAniList({ query, variables });
        if (status === 200) {
          const result = data?.data ?? null;
          _cacheSet(cacheKey, result);
          return result;
        }
        // AniList's Media(search:...) returns HTTP 404 with a GraphQL
        // "Not Found." error — not null — when nothing matches the search.
        // Confirmed live: a title containing a curly apostrophe ("She's" as
        // typed with U+2019) got zero hits and came back exactly this way.
        // That's a real, valid "no candidate" result, not an availability
        // problem — treating it as one made a deterministic non-match look
        // identical to a transient rate-limit failure, so "Retry Skipped"
        // could never resolve it (retrying a 404 just reproduces the 404).
        // Worth caching too — it's a stable outcome, not a failure.
        if (status === 404) { _cacheSet(cacheKey, null); return null; }
        anilistUnavailable = true;
        return null; // not cached — this is exactly what "Retry Skipped" needs to retry
      } catch (_) {
        anilistUnavailable = true;
        return null;
      }
    }

    // Exact match first — zero ambiguity when the favorite is already
    // linked. Falls through to a title search below if this doesn't yield
    // a *verified* cover (stale/invalid id, or AniList has nothing better
    // for this entry either), rather than giving up outright.
    if (favorite.anilistId) {
      const id = Number(favorite.anilistId);
      if (Number.isFinite(id) && id > 0) {
        const result = await queryAniList(CANDIDATE_QUERY_BY_ID, { id });
        const cover = result?.Media?.coverImage?.extraLarge || result?.Media?.coverImage?.large;
        if (cover) {
          const verified = await verifyCandidateCover(cover, 'exact');
          if (verified) return verified;
        }
      }
    }

    if (!favorite.title) return { candidateCover: null, matchType: null, anilistUnavailable };
    const result = await queryAniList(CANDIDATE_QUERY_BY_SEARCH, { search: favorite.title });
    const media = result?.Media;
    const cover = media?.coverImage?.extraLarge || media?.coverImage?.large;
    if (!cover) return { candidateCover: null, matchType: null, anilistUnavailable };
    const candidateTitle = media.title?.english || media.title?.romaji || '';
    if (titleSimilarity(favorite.title, candidateTitle) < TITLE_MATCH_MIN_SIM) {
      return { candidateCover: null, matchType: null, anilistUnavailable };
    }
    const verified = await verifyCandidateCover(cover, 'title');
    return verified || { candidateCover: null, matchType: null, anilistUnavailable };
  }

  async function getCoverCandidate({ mangaId, sourceId } = {}) {
    if (!mangaId || !sourceId) {
      const err = new Error('mangaId and sourceId required');
      err.statusCode = 400;
      throw err;
    }

    const store = await readStore();
    const favorite = (store.favorites || []).find(
      (m) => String(m.id) === String(mangaId) && String(m.sourceId) === String(sourceId)
    );
    if (!favorite) {
      const err = new Error('Favorite not found');
      err.statusCode = 404;
      throw err;
    }

    const current = await currentCoverNeedsUpgrade(favorite.cover);
    if (!current.needsUpgrade) return { needsUpgrade: false, candidateCover: null, matchType: null };

    const { candidateCover, matchType, dims, anilistUnavailable } = await findCandidateCover(favorite);
    return {
      needsUpgrade: true,
      candidateCover,
      matchType,
      anilistUnavailable: !!anilistUnavailable,
      currentDims: current.dims,
      candidateDims: dims || null,
    };
  }

  return { getCoverCandidate };
}

module.exports = { createCoverCandidateService };
