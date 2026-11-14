'use strict';

const limits = require('../../config/limits');
const { MANGAUPDATES_REQUEST_FAILED } = require('../errors/error-codes');

function createMangaUpdatesService() {
  async function searchByTitle({ title } = {}) {
    if (!title || typeof title !== 'string') {
      const err = new Error('title (string) required');
      err.statusCode = 400;
      throw err;
    }

    const safeTitle = title.trim().slice(0, 200);

    const searchRes = await fetch('https://api.mangaupdates.com/v1/series/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ search: safeTitle, perpage: 5 }),
      signal: AbortSignal.timeout(limits.fetchTimeoutMs),
    });

    if (!searchRes.ok) {
      const err = new Error(`MangaUpdates search error: ${searchRes.status}`);
      err.statusCode = 502;
      err.code = MANGAUPDATES_REQUEST_FAILED;
      throw err;
    }

    const searchData = await searchRes.json();
    const results = searchData.results || [];
    if (!results.length) {
      return { found: false, message: 'No results found on MangaUpdates' };
    }

    const seriesId = Number(results[0].record?.series_id);
    if (!Number.isFinite(seriesId) || seriesId <= 0) {
      const err = new Error('Invalid series_id in MangaUpdates response');
      err.statusCode = 502;
      throw err;
    }

    const detailRes = await fetch(`https://api.mangaupdates.com/v1/series/${seriesId}`, {
      signal: AbortSignal.timeout(limits.fetchTimeoutMs),
    });

    if (!detailRes.ok) {
      const err = new Error(`MangaUpdates detail error: ${detailRes.status}`);
      err.statusCode = 502;
      err.code = MANGAUPDATES_REQUEST_FAILED;
      throw err;
    }

    const details = await detailRes.json();

    return {
      found: true,
      seriesId,
      title: results[0].record.title,
      latestChapter: details.latest_chapter || null,
      status: details.status || 'Unknown',
      year: details.year || 'Unknown',
      genres: (details.genres || []).map(g => g.genre),
      url: `https://www.mangaupdates.com/series/${seriesId}`,
    };
  }

  // Second-tier description fallback (see server/modules/anilist/
  // description-fallback.js, which tries AniList first) for titles obscure
  // enough that AniList has no listing at all — confirmed live: a niche
  // isekai web novel adaptation ("Telepathic Aristocrat ~Villainous Young
  // Noble...~") that AniList's own search returns a flat 404 for is
  // findable on MangaUpdates, just usually not as the #1 search hit — their
  // search seems to rank on the native/romaji title, not the English fan
  // title we're searching with, so "Telepathic Aristocrat" alone surfaced
  // five completely unrelated series as top result. Checking each
  // candidate's associated-titles list (which DOES carry the English title)
  // is what actually finds the real match; trusting result[0] the way
  // searchByTitle above does would have attached a wrong series' synopsis —
  // worse than leaving the original description alone.
  function normalizeForMatch(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  async function searchDescriptionByTitle(title) {
    const safeTitle = String(title || '').trim().slice(0, 200);
    if (!safeTitle) return null;
    const target = normalizeForMatch(safeTitle);
    if (!target) return null;

    let searchData;
    try {
      const searchRes = await fetch('https://api.mangaupdates.com/v1/series/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ search: safeTitle, perpage: 5 }),
        signal: AbortSignal.timeout(limits.fetchTimeoutMs),
      });
      if (!searchRes.ok) return null;
      searchData = await searchRes.json();
    } catch (_) {
      return null;
    }

    const candidates = (searchData?.results || [])
      .map((r) => Number(r?.record?.series_id))
      .filter((id) => Number.isFinite(id) && id > 0)
      .slice(0, 3);

    for (const seriesId of candidates) {
      let details;
      try {
        const detailRes = await fetch(`https://api.mangaupdates.com/v1/series/${seriesId}`, {
          signal: AbortSignal.timeout(limits.fetchTimeoutMs),
        });
        if (!detailRes.ok) continue;
        details = await detailRes.json();
      } catch (_) {
        continue;
      }

      const candidateTitles = [
        details?.title,
        ...(Array.isArray(details?.associated) ? details.associated.map((a) => a?.title) : []),
      ];
      const isConfidentMatch = candidateTitles.some((t) => normalizeForMatch(t) === target);
      if (isConfidentMatch && details?.description) {
        return details.description;
      }
    }
    return null;
  }

  return {
    searchByTitle,
    searchDescriptionByTitle,
  };
}

module.exports = { createMangaUpdatesService };