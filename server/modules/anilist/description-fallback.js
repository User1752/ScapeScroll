'use strict';

const { withTimeout } = require('../common/async-utils');

// Some manga-aggregator sources only have a non-English synopsis for a
// given title (confirmed live: MangaHub genuinely serves an Indonesian-only
// description for some entries — every other sampled title came back
// English fine, so this isn't a scraper bug, just a per-title gap in that
// site's own data). AniList almost always has a real English description
// for anything with a real audience, so this swaps in AniList's version
// when the source's own one doesn't look like English, with MangaUpdates as
// a second tier for the titles obscure enough that even AniList has
// nothing — falling back silently to whatever the source already had if
// neither has a confident match or a lookup fails/times out. Never blocks
// or breaks the main mangaDetails response over this.
//
// Deliberately not machine translation: an external translate API is a
// paid, ongoing third-party dependency, and generic translation is a poor
// fit for manga-specific terms/names anyway — AniList's own curated
// English synopsis is both free (already-integrated infra) and more
// reliable than a translated one would be.

const ENGLISH_STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'was', 'were', 'are', 'and', 'to', 'of', 'in', 'on', 'at', 'with',
  'his', 'her', 'he', 'she', 'they', 'their', 'it', 'its', 'that', 'this', 'as', 'but',
  'for', 'from', 'has', 'have', 'had', 'not', 'who', 'when', 'where', 'why', 'how',
  'you', 'your', 'i', 'we', 'our', 'be', 'been', 'will', 'would', 'can', 'could', 'by',
]);

// Indonesian (and most other languages sharing the Latin alphabet) share no
// meaningful overlap with these — real English prose clears this ratio
// easily, unrelated languages don't, so this doesn't need real language
// detection to tell them apart.
function looksLikeEnglish(text) {
  const words = String(text || '').toLowerCase().match(/[a-z']+/g) || [];
  if (words.length < 15) return true; // too short to judge reliably — don't risk a wrong override
  const hits = words.filter((w) => ENGLISH_STOPWORDS.has(w)).length;
  return (hits / words.length) >= 0.08;
}

const DESCRIPTION_QUERY = `query ($search: String) {
  Media(search: $search, type: MANGA) {
    description(asHtml: false)
  }
}`;

// searchMangaUpdatesDescription is optional — a SECOND tier tried only when
// AniList comes back empty. Confirmed live: AniList's own search 404s
// outright for some genuinely obscure titles (a niche isekai web novel
// adaptation, "Telepathic Aristocrat ~Villainous Young Noble...~") that
// MangaUpdates does carry, just not usually as its own #1 search result —
// server/modules/mangaupdates/service.js's searchDescriptionByTitle()
// already does its own title-confidence check before ever returning
// anything, so a null/failed result here is treated exactly like AniList
// having nothing: keep the original description rather than guess.
function createAniListDescriptionFallback({ proxyAniList, searchMangaUpdatesDescription }) {
  async function fetchFromAniList(title) {
    try {
      const { data } = await withTimeout(
        proxyAniList({ query: DESCRIPTION_QUERY, variables: { search: title } }),
        8000,
        'AniList description lookup timeout'
      );
      return data?.data?.Media?.description || null;
    } catch (_) {
      return null; // No match, AniList unreachable, or timed out.
    }
  }

  async function fetchFromMangaUpdates(title) {
    if (typeof searchMangaUpdatesDescription !== 'function') return null;
    try {
      return await withTimeout(searchMangaUpdatesDescription(title), 8000, 'MangaUpdates description lookup timeout');
    } catch (_) {
      return null;
    }
  }

  async function maybeReplaceDescription(details) {
    if (!details?.description || !details?.title) return details;
    if (looksLikeEnglish(details.description)) return details;

    const fromAniList = await fetchFromAniList(details.title);
    if (fromAniList && looksLikeEnglish(fromAniList)) {
      return { ...details, description: fromAniList.replace(/<br\s*\/?>/gi, '\n').trim() };
    }

    const fromMangaUpdates = await fetchFromMangaUpdates(details.title);
    if (fromMangaUpdates && looksLikeEnglish(fromMangaUpdates)) {
      return { ...details, description: fromMangaUpdates.replace(/<br\s*\/?>/gi, '\n').trim() };
    }

    return details;
  }

  return { maybeReplaceDescription, looksLikeEnglish };
}

module.exports = { createAniListDescriptionFallback };
