// ============================================================================
// TASTE PROFILE FROM THE ANILIST STATISTICS (for the "Recommended For You" row)
// ============================================================================
// The row used to learn what the person likes only by counting the genres of what is in the library and the history. A count says what was read, not what
// was liked, and for a big library it saturates: every genre has "a lot", so every candidate that shares any genre gets the same top mark. AniList keeps, for
// the account, how many titles of each genre the person has AND the mean score they gave them. Putting the two together tells "read a lot and loved" from
// "read a lot and rated low" and from "read little, rated high":
//
//   volume   = sqrt(count / the largest count)                      0..1   (a square root, so one huge genre does not flatten the rest)
//   relative = (the genre's mean score - the account's mean) / the spread, within -1.5..1.5   (how much better or worse than usual)
//   affinity = volume * (1 + 0.5 * relative), then divided by the largest of them   0..1
//   disliked = read at least five and rated clearly below the person's own average
//
// It is only read when an AniList account is connected (the token is the person's own, the request goes through the same proxy as every AniList call), kept for
// half a day in the browser, and never blocks the row for long: with no answer the row is built the old way. The decision is pure functions
// (tasteFromStatistics, tasteScoreForManga, tasteTopGenres), tested without a page.

const TASTE = Object.freeze({
  cacheKey: 'scrollscape_al_taste_v1',
  ttlMs: 12 * 60 * 60 * 1000,
  failedRetryMs: 10 * 60 * 1000,
  timeoutMs: 5000,
  minCount: 3,          // a genre with fewer titles than this is noise
  dislikedMinCount: 5,
  dislikedBelow: -0.75, // relative score at or under this, with enough titles, is "disliked"
  tagPoints: 45,        // what a perfect match is worth in the recommendation score (the same 45 the count-based rule had)
});

const TASTE_QUERY = `query { Viewer { id statistics { manga {
  count meanScore standardDeviation
  genres(limit: 30, sort: COUNT_DESC) { genre count meanScore }
} } } }`;

const _tasteClamp = (value, low, high) => Math.max(low, Math.min(high, value));
const _tasteNum = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/**
 * The taste profile from the manga statistics AniList gives for an account.
 * @param {{ count?: number, meanScore?: number, standardDeviation?: number, genres?: Array<{ genre: string, count: number, meanScore: number }> }} stats
 * @returns {{ total: number, mean: number, genres: Object<string, { affinity: number, disliked: boolean, count: number, mean: number }> } | null} null when there is nothing to learn from
 */
function tasteFromStatistics(stats) {
  const list = (Array.isArray(stats && stats.genres) ? stats.genres : [])
    .map((g) => ({ genre: String((g && g.genre) || '').trim().toLowerCase().slice(0, 40), count: Math.max(0, Math.floor(_tasteNum(g && g.count))), mean: _tasteNum(g && g.meanScore) }))
    .filter((g) => g.genre && g.count >= TASTE.minCount);
  if (!list.length) return null;
  const mean = _tasteNum(stats.meanScore);
  const spread = Math.max(5, _tasteNum(stats.standardDeviation) || 10);
  const maxCount = Math.max(...list.map((g) => g.count));
  const raw = list.map((g) => {
    // A genre whose titles carry no score (mean 0) says nothing about liking it: neither better nor worse than usual.
    const relative = g.mean > 0 && mean > 0 ? _tasteClamp((g.mean - mean) / spread, -1.5, 1.5) : 0;
    return { ...g, relative, value: Math.sqrt(g.count / maxCount) * (1 + 0.5 * relative) };
  });
  const top = Math.max(...raw.map((g) => g.value), 0.0001);
  const genres = {};
  for (const g of raw) {
    genres[g.genre] = {
      affinity: Math.round(_tasteClamp(g.value / top, 0, 1) * 1000) / 1000,
      disliked: g.count >= TASTE.dislikedMinCount && g.relative <= TASTE.dislikedBelow,
      count: g.count,
      mean: g.mean,
    };
  }
  return { total: Math.max(0, Math.floor(_tasteNum(stats.count))), mean, genres };
}

/**
 * What the taste profile adds to (or takes from) the recommendation score of a candidate, from its genres.
 * @returns {{ add: number, reasons: string[] } | null} null when no genre of the candidate is known to the profile (the old rule then judges)
 */
function tasteScoreForManga(manga, taste) {
  if (!taste || !taste.genres || !manga || !Array.isArray(manga.genres)) return null;
  const known = [];
  for (const g of manga.genres) {
    const entry = typeof g === 'string' ? taste.genres[g.toLowerCase()] : null;
    if (entry) known.push(entry);
  }
  if (!known.length) return null;
  const average = known.reduce((sum, e) => sum + e.affinity, 0) / known.length;
  // One matching genre is a weaker signal than several: the full mark needs three that are known.
  const reach = Math.min(1, 0.4 + known.length * 0.2);
  let add = Math.round(TASTE.tagPoints * average * reach);
  const reasons = ['taste'];
  const disliked = known.filter((e) => e.disliked).length;
  if (disliked) {
    add -= Math.min(30, 12 * disliked);
    reasons.push('dislikedGenre');
  }
  return { add, reasons };
}

/** The genres to ask the sources for, best first: the most liked, none the person rates low, none their settings hide. */
function tasteTopGenres(taste, max = 3, { hideNsfw = false, blacklist = [] } = {}) {
  if (!taste || !taste.genres) return [];
  return Object.entries(taste.genres)
    .filter(([name, e]) => !e.disliked && !blacklist.includes(name) && !(hideNsfw && isNsfwTag(name)))
    .sort((a, b) => b[1].affinity - a[1].affinity || b[1].count - a[1].count)
    .slice(0, max)
    .map(([name]) => name);
}

// ── the kept answer ─────────────────────────────────────────────────────────

function _tasteUserId() {
  try {
    const user = typeof _alUser === 'function' ? _alUser() : null;
    return user && user.id ? String(user.id) : '';
  } catch (_) {
    return '';
  }
}

function _tasteRead() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TASTE.cacheKey) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function _tasteWrite(value) {
  try { localStorage.setItem(TASTE.cacheKey, JSON.stringify(value)); } catch (_) { /* asked again next time */ }
}

/**
 * The taste profile of the connected AniList account, or null (not connected, nothing to learn from, no answer in time).
 * Kept twelve hours per account; a failed attempt is not repeated for ten minutes.
 */
async function tasteLoad() {
  const token = typeof _alToken === 'function' ? _alToken() : null;
  if (!token || typeof anilistGQL !== 'function') return null;
  const userId = _tasteUserId();
  const kept = _tasteRead();
  const now = Date.now();
  const sameAccount = !!kept && (!userId || kept.userId === userId);
  if (sameAccount) {
    if (kept.taste && now - Number(kept.at || 0) < TASTE.ttlMs) return kept.taste;
    if (!kept.taste && now - Number(kept.failedAt || 0) < TASTE.failedRetryMs) return null;
  }
  try {
    const body = await Promise.race([
      anilistGQL(TASTE_QUERY),
      new Promise((_, reject) => { setTimeout(() => reject(new Error('timed out')), TASTE.timeoutMs); }),
    ]);
    const viewer = body && body.data && body.data.Viewer;
    const taste = viewer ? tasteFromStatistics(viewer.statistics && viewer.statistics.manga) : null;
    if (!viewer) throw new Error('no viewer');
    _tasteWrite({ userId: userId || String(viewer.id || ''), at: now, taste, ...(taste ? {} : { failedAt: now }) }); // nothing to learn from yet: not asked again at once
    return taste;
  } catch (_) {
    // An older answer of this account is better than none; else remember the failure for a while.
    if (sameAccount && kept.taste) return kept.taste;
    _tasteWrite({ userId, failedAt: now, taste: null });
    return null;
  }
}

window.tasteFromStatistics = tasteFromStatistics;
window.tasteScoreForManga = tasteScoreForManga;
window.tasteTopGenres = tasteTopGenres;
window.tasteLoad = tasteLoad;
