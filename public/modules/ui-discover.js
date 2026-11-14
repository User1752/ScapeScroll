// ============================================================================
// POPULAR TODAY / RECENTLY ADDED / LATEST UPDATES
// ============================================================================

// Keyed "sourceId:mangaId" -> {genres, cover}. Started out genre-only; now
// also carries the cover a card's own listing entry omitted, filled from
// the exact same mangaDetails() fetch below rather than a second request —
// list/search endpoints on most sources return a lean row (title/id, often
// no cover), while the detail endpoint returns the full record.
const _genreHydrationCache = new Map();
const _genreHydrationRequestQueue = [];
const _genreHydrationInFlight = new Map();
// Keyed by (lowercased) title -> in-flight Promise<string>. Module-level,
// not local to _hydrateMissingGenres, because the reentrant case this
// exists to guard against is two SEPARATE calls to _hydrateMissingGenres
// (e.g. a row's own render-time call and ui-autoscroll.js's post-clone
// re-hydration call) racing on the same still-unresolved card — a
// function-local Map would reset on every call and never see the other
// call's in-flight request.
const _anilistCoverFallbackInFlight = new Map();
let _genreHydrationActive = 0;
const GENRE_HYDRATION_MAX_CONCURRENT = 2;
const _homeRowRequestSeq = {
  popularToday: 0,
  recentlyAdded: 0,
  latestUpdates: 0,
};

window._homeSeenManga = new Set();

// getMangaKey() lives in state.js — it loads first and every other copy of
// this function that used to shadow it here and in ui-library.js had
// silently drifted to a slightly different body (see docs/manual for the
// audit that caught it). Deleted rather than kept as a second definition.

function getUserReadingProfile() {
  const profile = {
    genres: new Map(),
    sources: new Map(),
    statuses: new Map(),
    avgChapterCount: 0,
    totalCount: 0,
    readIds: new Set(),
    completedIds: new Set(),
    recentlyReadIds: new Set(),
    recentTags: new Set(),
    recentSources: new Set(),
    recentAuthors: new Set()
  };

  const add = (m, weight, isRecent = false) => {
    profile.totalCount++;
    const key = getMangaKey(m);
    
    (m.genres || []).forEach(g => {
      if (typeof g === 'string') {
        const lowerG = g.toLowerCase();
        profile.genres.set(lowerG, (profile.genres.get(lowerG) || 0) + weight);
        if (isRecent) profile.recentTags.add(lowerG);
      }
    });
    
    if (m.sourceId) {
      profile.sources.set(m.sourceId, (profile.sources.get(m.sourceId) || 0) + weight);
      if (isRecent) profile.recentSources.add(m.sourceId);
    }
    
    if (m.status) profile.statuses.set(m.status, (profile.statuses.get(m.status) || 0) + weight);
    
    if (isRecent && m.author) profile.recentAuthors.add(String(m.author).toLowerCase());
    
    const cc = state.chapterCountCache?.[key] || state.chapterCountCache?.[m.id] || 0;
    if (cc > 0) profile.avgChapterCount += (cc - profile.avgChapterCount) / profile.totalCount;
    
    profile.readIds.add(key);
    profile.readIds.add(m.id); // Also add legacy ID to ensure overlap checks work
    
    // Check if fully read
    const readKeyPrefix = `${key}:`;
    const readKeyLegacyPrefix = `${m.id}:`;
    const readCount = [...(state.readChapters || [])].filter(k => k.startsWith(readKeyPrefix) || k.startsWith(readKeyLegacyPrefix)).length;
    if (cc > 0 && readCount >= cc) profile.completedIds.add(key);
  };

  (state.history || []).forEach(m => {
    add(m, 2, true);
    profile.recentlyReadIds.add(getMangaKey(m));
  });
  (state.favorites || []).forEach(m => add(m, 1, false));
  
  return profile;
}

function getHomepageRecommendationScore(manga, profile, isDuplicate = false) {
  let score = 0;
  const reasons = [];
  const key = getMangaKey(manga);

  // Up to +45 for the genres: from what the person LIKED when an AniList account is connected (ui-taste-profile.js: how much of each genre, and the score they
  // gave it; a genre they rate low takes points away), else from a count of what is in the library and the history. The count saturates for a big library:
  // every genre has "a lot", so any shared genre got the full mark.
  const taste = profile.taste && typeof tasteScoreForManga === 'function' ? tasteScoreForManga(manga, profile.taste) : null;
  if (taste) {
    score += taste.add;
    reasons.push(...taste.reasons);
  } else {
    let tagScore = 0;
    if (Array.isArray(manga.genres)) {
      manga.genres.forEach(g => {
        if (typeof g === 'string' && profile.genres.has(g.toLowerCase())) {
          tagScore += profile.genres.get(g.toLowerCase());
        }
      });
      if (tagScore > 0) {
        score += Math.min(45, tagScore * 5); // cap at 45
        reasons.push('tags');
      }
    }
  }

  // +30 same preferred source
  if (manga.sourceId && profile.sources.has(manga.sourceId)) {
    score += Math.min(30, profile.sources.get(manga.sourceId) * 5);
    reasons.push('source');
  }

  // +25 unread chapters available
  const readKeyPrefix = `${manga.id}:`;
  const readCount = [...(state.readChapters || [])].filter(k => k.startsWith(readKeyPrefix)).length;
  const totalChapters = state.chapterCountCache?.[manga.id] || 0;
  if (totalChapters > readCount && readCount > 0) {
    score += 25;
    reasons.push('unread');
  }

  // +20 recently read similar manga
  // Candidate gets points if it overlaps with recently read manga, but isn't itself recently read
  if (!profile.recentlyReadIds.has(key)) {
    let similarScore = 0;
    if (manga.sourceId && profile.recentSources.has(manga.sourceId)) similarScore += 5;
    if (manga.author && profile.recentAuthors.has(String(manga.author).toLowerCase())) similarScore += 10;
    if (Array.isArray(manga.genres)) {
      const tagOverlap = manga.genres.filter(g => typeof g === 'string' && profile.recentTags.has(g.toLowerCase())).length;
      if (tagOverlap > 0) similarScore += Math.min(10, tagOverlap * 3);
    }
    if (similarScore > 0) {
      score += Math.min(20, similarScore);
      reasons.push('recentlyReadSimilar');
    }
  }

  // +15 high rating if available
  if (manga.rating && parseFloat(manga.rating) >= 8.0) {
    score += 15;
    reasons.push('rating');
  }

  // +15 matching preferred status
  if (manga.status && profile.statuses.has(manga.status)) {
    score += 15;
    reasons.push('status');
  }

  // +10 chapter count matches user pattern
  if (totalChapters > 0 && profile.avgChapterCount > 0 && Math.abs(totalChapters - profile.avgChapterCount) < 50) {
    score += 10;
    reasons.push('chapters');
  }

  // +10 recently added to library (if in favorites but not completed)
  if ((profile.readIds.has(key) || profile.readIds.has(manga.id)) && !profile.completedIds.has(key) && !profile.completedIds.has(manga.id)) {
    score += 10;
    reasons.push('library');
  }

  // Penalties
  // -50 hidden/removed/blacklisted
  if (state.settings?.genreBlacklist?.some(b => (manga.genres || []).map(g=>typeof g === 'string' ? g.toLowerCase() : '').includes(b))) {
    score -= 50;
    reasons.push('blacklisted');
  }

  // -35 already fully read
  if (profile.completedIds.has(key) || profile.completedIds.has(manga.id)) {
    score -= 35;
    reasons.push('completed');
  }

  // -25 duplicate across homepage sections
  if (isDuplicate || window._homeSeenManga.has(key)) {
    score -= 25;
    reasons.push('duplicate');
  }

  manga._debugScore = score;
  manga._debugReasons = reasons;
  return score;
}

const HOME_SOURCE_TIMEOUT_MS = 3500;

function _homeRequestTimeout() {
  return new Promise(resolve => setTimeout(() => resolve(null), HOME_SOURCE_TIMEOUT_MS));
}

function _pumpGenreHydrationQueue() {
  while (_genreHydrationActive < GENRE_HYDRATION_MAX_CONCURRENT && _genreHydrationRequestQueue.length > 0) {
    const task = _genreHydrationRequestQueue.shift();
    _genreHydrationActive++;
    Promise.resolve()
      .then(task)
      .finally(() => {
        _genreHydrationActive = Math.max(0, _genreHydrationActive - 1);
        _pumpGenreHydrationQueue();
      });
  }
}

function _queueMangaDetailsFetch(sourceId, mangaId) {
  const key = `${sourceId}:${mangaId}`;
  if (_genreHydrationInFlight.has(key)) return _genreHydrationInFlight.get(key);

  const p = new Promise((resolve) => {
    _genreHydrationRequestQueue.push(async () => {
      try {
        const details = await api(`/api/source/${sourceId}/mangaDetails`, {
          method: 'POST',
          body: JSON.stringify({ mangaId })
        });
        resolve(details);
      } catch (_) {
        resolve(null);
      } finally {
        _genreHydrationInFlight.delete(key);
      }
    });
    _pumpGenreHydrationQueue();
  });

  _genreHydrationInFlight.set(key, p);
  return p;
}

function _normalizeGenres(raw, max = 3) {
  if (Array.isArray(raw)) {
    return raw
      .map(g => String(g || '').trim())
      .filter(Boolean)
      .slice(0, max);
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[|,\/]/)
      .map(g => g.trim())
      .filter(Boolean)
      .slice(0, max);
  }
  return [];
}

function _extractGenresFromDetails(details, max = 3) {
  const candidates = [
    details?.genres,
    details?.genre,
    details?.tags,
    details?.tag,
    details?.categories,
  ];
  for (const c of candidates) {
    const parsed = _normalizeGenres(c, max);
    if (parsed.length) return parsed;
  }
  return [];
}

/** Whether the person's Hide NSFW or genre blacklist excludes a title of a list (its genres are those the list carries). One rule for every list drawn from a source. */
function _mangaExcludedBySettings(manga) {
  if (!manga) return false;
  if (state.settings.hideNsfw && isNsfwManga(manga)) return true;
  const blacklist = state.settings.genreBlacklist || [];
  if (blacklist.length > 0 && Array.isArray(manga.genres)) {
    const lower = manga.genres.map((g) => (typeof g === 'string' ? g.toLowerCase() : ''));
    if (lower.some((g) => blacklist.includes(g))) return true;
  }
  return false;
}

/** Whether the person's Hide NSFW or genre blacklist excludes a title whose genres have just been read. */
function _hiddenByGenres(genres, mangaId, sourceId) {
  const list = Array.isArray(genres) ? genres : [];
  if (!list.length) return false;
  if (state.settings.hideNsfw && isNsfwManga({ id: mangaId, sourceId, genres: list })) return true;
  const blacklist = state.settings.genreBlacklist || [];
  if (blacklist.length > 0) {
    const lower = list.map((g) => (typeof g === 'string' ? g.toLowerCase() : ''));
    if (lower.some((g) => blacklist.includes(g))) return true;
  }
  return false;
}

// How many hydrations are running; the home page's cover ring (ui-library-cover-progress.js) counts a card with no cover as waiting only while this is above zero.
let _hydrationsRunning = 0;
window.homeHydrationActive = () => _hydrationsRunning;

async function _hydrateMissingGenres(container) {
  _hydrationsRunning++;
  try {
    await _hydrateMissingGenresRun(container);
  } finally {
    _hydrationsRunning--;
  }
}

async function _hydrateMissingGenresRun(container) {
  if (!container) return;
  const cards = [...container.querySelectorAll('.manga-card')];
  if (!cards.length) return;

  const targets = cards.filter(card => {
    const genreBox = card.querySelector('.manga-card-genres[data-missing-genres="1"]');
    const coverBox = card.querySelector('.no-cover[data-missing-cover="1"]');
    if (!genreBox && !coverBox) return false;
    const mangaId = card.dataset.mangaId || '';
    const sourceId = card.dataset.sourceId || state.currentSourceId || '';
    return !!(mangaId && sourceId);
  });
  if (!targets.length) return;

  let cursor = 0;
  // Keep hydration gentle: some sources (e.g. KingOfShojo) throttle bursts.
  const workers = Math.min(2, targets.length);

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  async function fetchCardData(sourceId, mangaId) {
    const details = await _queueMangaDetailsFetch(sourceId, mangaId);
    // The badges show three, but Hide NSFW and the genre blacklist have to judge all of them ("Adult" can be the fourth).
    const allGenres = _extractGenresFromDetails(details, 50);
    return {
      genres: allGenres.slice(0, 3),
      allGenres,
      cover: String(details?.cover || '').trim(),
    };
  }

  // Same source's own listing AND detail endpoints can both genuinely have
  // no cover for a title (confirmed live — a real MangaHub entry where
  // mangaDetails() itself returns cover:""), not just the listing being
  // lean. Only reached when a card actually needs a cover (never spent on
  // cards only missing genres) — goes through the shared anilistGQL()
  // helper, which funnels into proxy/service.js's now-serialized,
  // properly-spaced AniList queue, so hydrating many cards at once here
  // queues safely instead of bursting past AniList's rate limit again.
  //
  // 0.6, not Cover Scan's 0.8 — confirmed live that a real match got
  // rejected at 0.8 purely from a one-word romanization difference
  // ("Gakusha to Karyuudo" vs AniList's "Gakusha to Kariudo", same manga,
  // scoring 0.667 on the shared word-overlap scorer). Cover Scan's stricter
  // bar exists because it WRITES a cover into a stored favorite — a wrong
  // match there persists until someone notices. This only ever affects a
  // temporary, unpersisted card in a browse view (never a stored favorite,
  // capped to the eligible-card filter in _hydrateMissingGenres itself, and
  // re-computed fresh every render) — the cost of an occasional loose match
  // is a mismatched thumbnail while browsing, not corrupted library data, so
  // the same lower bar the manual "Find Dupes" scanner already uses for
  // exactly this reason (a human isn't confirming this one match either, but
  // nothing is being written) is the right trade here.
  const ANILIST_COVER_FALLBACK_MIN_SIM = 0.6;
  async function fetchAniListFallbackCover(title) {
    if (!title || typeof anilistGQL !== 'function') return '';
    // Mirrors _queueMangaDetailsFetch's own in-flight dedup above — without
    // it, two overlapping hydration passes over the same still-unresolved
    // card (e.g. a row's render-time call and ui-autoscroll.js's post-clone
    // re-hydration call, which isn't awaited relative to the first) can
    // each independently fire the identical AniList search for the same
    // title before either has a result to share.
    const inFlightKey = title.trim().toLowerCase();
    if (_anilistCoverFallbackInFlight.has(inFlightKey)) {
      return _anilistCoverFallbackInFlight.get(inFlightKey);
    }
    const p = (async () => {
      try {
        const body = await anilistGQL(
          `query ($search: String) { Media(search: $search, type: MANGA) { title { romaji english } coverImage { extraLarge large } } }`,
          { search: title }
        );
        const media = body?.data?.Media;
        if (!media) return '';
        const candidateTitle = media.title?.english || media.title?.romaji || '';
        if (typeof _titleSimilarity === 'function' && _titleSimilarity(title, candidateTitle) < ANILIST_COVER_FALLBACK_MIN_SIM) return '';
        return media.coverImage?.extraLarge || media.coverImage?.large || '';
      } catch (_) {
        return '';
      }
    })();
    _anilistCoverFallbackInFlight.set(inFlightKey, p);
    try {
      return await p;
    } finally {
      _anilistCoverFallbackInFlight.delete(inFlightKey);
    }
  }

  // Deliberately no third tier beyond this. Brave Images was tried and
  // pulled back out — it has no official API (this is HTML scraping), no
  // real request budget, and shares its rate-limit/cooldown state with the
  // manual "Search Brave Images" picker (server/modules/cover-search).
  // Confirmed live: testing this automatic path alone was enough to trip
  // Brave's 5-minute cooldown — an automatic background sweep that runs on
  // every page view is a fundamentally different load pattern than an
  // occasional manual click, and degrading the manual picker's own budget
  // as a side effect of a background convenience feature isn't a good
  // trade. A title neither the source nor AniList has stays "?" here; the
  // manual cover picker (with its own Brave search, user-triggered and
  // reviewed) is still the right place to chase down a genuinely obscure
  // cover by hand.

  async function worker() {
    while (cursor < targets.length) {
      const idx = cursor++;
      const card = targets[idx];
      const mangaId = card.dataset.mangaId || '';
      const sourceId = card.dataset.sourceId || state.currentSourceId || '';
      const key = `${sourceId}:${mangaId}`;
      const genreBox = card.querySelector('.manga-card-genres[data-missing-genres="1"]');
      // Search results have their own no-cover markup that this same pass
      // shouldn't touch (a source can legitimately have a cover it just
      // hasn't loaded yet vs. one confirmed to have none at all).
      const coverBox = card.querySelector('.no-cover[data-missing-cover="1"]');
      if (!genreBox && !coverBox) continue;

      try {
        // List/search endpoints on most sources return a lean row (often no
        // cover, sometimes no genres); the detail endpoint has the full
        // record — one fetch here backfills both, instead of a second
        // separate request per card just for the cover.
        //
        // Whether to (re)fetch is judged per-field, not by ORing genres and
        // cover together — a card only missing genres (coverBox is null,
        // its cover was already fine) doesn't need data.cover to be empty
        // to justify a retry; the detail response's cover field is almost
        // always already non-empty for that card (it's the same cover
        // already showing), which used to make an empty-genre result look
        // "resolved enough" on the very first try and skip the intentional
        // retry below entirely.
        let data = _genreHydrationCache.get(key);
        const needsGenres = !!genreBox && (!data || !data.genres.length);
        const needsCover = !!coverBox && (!data || !data.cover);
        if (!data || needsGenres || needsCover) {
          data = await fetchCardData(sourceId, mangaId);
          if ((needsGenres && !data.genres.length) || (needsCover && !data.cover)) {
            // One quick retry helps when the source temporarily rate-limits.
            await sleep(180);
            data = await fetchCardData(sourceId, mangaId);
          }

          // Cache only a successful, non-empty hydration so transient failures can retry.
          if (data.genres.length > 0 || data.cover) {
            _genreHydrationCache.set(key, data);
          } else {
            _genreHydrationCache.delete(key);
          }
        }

        if (coverBox && !data.cover) {
          const title = card.querySelector('.manga-card-title')?.textContent || '';
          const fallbackCover = await fetchAniListFallbackCover(title);
          if (fallbackCover) {
            data = { ...data, cover: fallbackCover };
            _genreHydrationCache.set(key, data);
          }
        }

        // A lean list row has no genres, so the Hide NSFW and genre-blacklist filters of the list could not judge it when it was drawn: the
        // real genres only arrive here. A card they now exclude goes away, as it would have if the list row had carried them.
        if (_hiddenByGenres(data.allGenres || data.genres, mangaId, sourceId)) {
          card.remove();
          continue;
        }

        if (genreBox && data.genres.length > 0) {
          genreBox.removeAttribute('data-missing-genres');
          genreBox.innerHTML = data.genres.map(g => `<span class="manga-card-genre">${escapeHtml(g)}</span>`).join('');
        }
        if (coverBox && data.cover) {
          const coverUrl = normalizeImageUrl(data.cover);
          if (coverUrl && !coverUrl.endsWith('.pdf') && !coverUrl.endsWith('.epub')) {
            const img = document.createElement('img');
            img.src = coverUrl;
            img.alt = card.querySelector('.manga-card-title')?.textContent || '';
            img.loading = 'lazy';
            img.decoding = 'async';
            img.referrerPolicy = 'no-referrer';
            coverBox.replaceWith(img);
          }
        }

        await sleep(120);
      } catch (_) {
        _genreHydrationCache.delete(key);
        // Keep fallback label/placeholder when detail lookup fails.
      }
    }
  }

  await Promise.all(Array.from({ length: workers }, worker));
}

function genreBadgesHTML(rawGenres, max = 3, fallbackTag = '', sourceId = '') {
  const genres = _normalizeGenres(rawGenres, max);
  const sid = String(sourceId || '').toLowerCase();

  // For KingOfShojo, card/list pages often only provide a generic type badge
  // (e.g. "Manhwa"). Keep showing it, but still mark for async hydration.
  const isGenericSingle = genres.length === 1 && ['manhwa', 'manhua', 'manga', 'webtoon'].includes(String(genres[0]).toLowerCase());
  const shouldHydrate = !genres.length || (sid === 'kingofshojo' && isGenericSingle);

  if (shouldHydrate) {
    const tag = fallbackTag || genres[0] || '';
    if (!tag) {
      return `<div class="manga-card-genres" data-missing-genres="1"></div>`;
    }
    return `<div class="manga-card-genres" data-missing-genres="1"><span class="manga-card-genre">${escapeHtml(tag)}</span></div>`;
  }

  return `<div class="manga-card-genres">${genres.map(g => `<span class="manga-card-genre">${escapeHtml(g)}</span>`).join("")}</div>`;
}

function _getHomeSourceIds() {
  const installedIds = getSelectableSourceIds();
  if (!installedIds.length) return [];

  if (state.settings.homeSourceMode !== 'selected') return installedIds;

  const selected = Array.isArray(state.settings.homeSelectedSourceIds)
    ? state.settings.homeSelectedSourceIds.filter(id => installedIds.includes(id))
    : [];

  return selected.length ? selected : installedIds;
}

function _sourceSupportsMethod(sourceId, method) {
  const caps = state.installedSources?.[sourceId]?.capabilities;
  if (!caps || typeof caps !== 'object') {
    if (method === 'recentlyAdded' && sourceId === 'allmanga') return false;
    return true;
  }
  if (!(method in caps)) return true;
  return caps[method] !== false;
}

function applyHomeSearchVisibility() {
  const section = $("homeSearchSection") || document.querySelector('#view-discover .search-section');
  if (!section) return;
  section.style.display = state.settings.showHomeSearch === false ? 'none' : '';
}

async function _loadMultiSourceHomeList(method, perSourceLimit = 7, totalLimit = 24) {
  const sourceIds = _getHomeSourceIds().filter(sid => _sourceSupportsMethod(sid, method));
  if (!sourceIds.length) return [];

  const settled = await Promise.allSettled(sourceIds.map(async (sid) => {
    try {
      const result = await Promise.race([
        api(`/api/source/${sid}/${method}`, {
        method: "POST",
        body: JSON.stringify({})
        }),
        _homeRequestTimeout(),
      ]);
      if (!result) return [];
      const blacklist = state.settings.genreBlacklist || [];
      return (result.results || [])
        .filter(m => {
          if (state.settings.hideNsfw && isNsfwManga(m)) return false;
          if (blacklist.length > 0 && Array.isArray(m.genres)) {
            const lowerGenres = m.genres.map(g => typeof g === 'string' ? g.toLowerCase() : '');
            if (lowerGenres.some(g => blacklist.includes(g))) return false;
          }
          return true;
        })
        .slice(0, perSourceLimit)
        .map(m => ({
          ...m,
          sourceId: sid,
          sourceName: state.installedSources?.[sid]?.name || sid,
        }));
    } catch (_) {
      return [];
    }
  }));

  const buckets = settled
    .filter(s => s.status === 'fulfilled')
    .map(s => s.value);

  const seen = new Set();
  const merged = [];
  const maxLen = Math.max(...buckets.map(b => b.length), 0);

  const profile = typeof getUserReadingProfile === 'function' ? getUserReadingProfile() : null;

  for (let i = 0; i < maxLen; i++) {
    for (const bucket of buckets) {
      if (i >= bucket.length) continue;
      const m = bucket[i];
      const key = String(m.title || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);

      if (profile && typeof getHomepageRecommendationScore === 'function') {
        const key = typeof getMangaKey === 'function' ? getMangaKey(m) : m.id;
        const isDuplicate = window._homeSeenManga && window._homeSeenManga.has(key);
        m._score = getHomepageRecommendationScore(m, profile, isDuplicate);
        if (!isDuplicate && m._score > -25 && window._homeSeenManga) window._homeSeenManga.add(key);
      } else {
        m._score = 0;
      }
      merged.push(m);
    }
  }

  // Sort by the newly calculated score, but ensure minimum limit is satisfied if possible
  merged.sort((a, b) => b._score - a._score);
  
  if (window.SCROLLSCAPE_DEBUG_RECOMMENDATIONS) {
    console.log(`[${method}] Top chosen:`, merged.slice(0, 5).map(m => `${m.title} (${m._score}) - ${m._debugReasons?.join(',')}`));
  }

  return merged.slice(0, totalLimit);
}

window.loadPopularToday = async function loadPopularToday() {
  if (state.settings.homeMode === 'anime') return; // home page is showing anime content — see ui-anime-discover.js
  const reqSeq = ++_homeRowRequestSeq.popularToday;
  const row = $("popularRow");
  if (!row) return;
  const section = row.closest('.popular-section');
  const enabledSourceIds = _getHomeSourceIds().filter(sid => _sourceSupportsMethod(sid, 'trending'));
  if (!enabledSourceIds.length) {
    if (section) section.style.display = 'none';
    row.innerHTML = '';
    return;
  }
  if (section) section.style.display = '';
  row.innerHTML = `<div class="muted">Loading...</div>`;
  try {
    const list = await _loadMultiSourceHomeList('trending', 26, 28);
    if (reqSeq !== _homeRowRequestSeq.popularToday) return;

    if (!list.length) {
      if (section) section.style.display = 'none';
      row.innerHTML = '';
      return;
    }
    if (section) section.style.display = '';
    row.innerHTML = list.map(m => mangaCardHTML(m)).join("");
    bindMangaCards(row);
    _hydrateMissingGenres(row);
    initRowAutoScroll(row);
  } catch (e) {
    if (reqSeq !== _homeRowRequestSeq.popularToday) return;
    dbg.error(dbg.ERR_SOURCE, 'Error loading popular manga', e);
    row.innerHTML = `<div class="muted">Error loading manga.</div>`;
  }
}

// ── Continue Reading ────────────────────────────────────────────────────
function _timeAgo(dateStr) {
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return '';
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function renderContinueReading() {
  if (state.settings.homeMode === 'anime') return; // home page is showing anime content — see ui-anime-discover.js
  const section = $("continueReadingSection");
  const row = $("continueReadingRow");
  if (!section || !row) return;

  const entries = (state.history || [])
    .filter(m => m && m.id && !(state.settings.hideNsfw && isNsfwManga(m)))
    .slice(0, 12);

  if (!entries.length) {
    section.classList.add('hidden');
    row.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');

  const readCountMap = typeof _buildReadCountMap === 'function' ? _buildReadCountMap() : new Map();

  row.innerHTML = entries.map(m => {
    const resolvedSourceId = m.sourceId || state.currentSourceId || "";
    const coverUrl = normalizeImageUrl(m.cover);
    const chapterLabel = String(m.chapterName || '').trim() || (m.chapterId ? `Chapter ${escapeHtml(String(m.chapterId))}` : '');
    const total = Number(state.chapterCountCache?.[m.id]) || 0;
    const read = readCountMap.get(m.id) || 0;
    const pct = total > 0 ? Math.min(100, Math.round((read / total) * 100)) : null;

    return `
      <div class="continue-card" data-manga-id="${escapeHtml(m.id)}" data-source-id="${escapeHtml(resolvedSourceId)}">
        <div class="continue-card-cover">
          ${coverUrl && !coverUrl.endsWith('.pdf') && !coverUrl.endsWith('.epub')
            ? `<img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(m.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
            : `<div class="no-cover">&#128196;</div>`}
          <div class="continue-card-play">&#9654;</div>
          ${pct != null ? `<div class="continue-card-progress"><div class="continue-card-progress-fill" style="width:${pct}%"></div></div>` : ''}
        </div>
        <div class="continue-card-info">
          <h4 class="continue-card-title">${escapeHtml(m.title || '')}</h4>
          <p class="continue-card-meta">${escapeHtml(chapterLabel)}${chapterLabel ? ' · ' : ''}${_timeAgo(m.readAt)}</p>
        </div>
      </div>`;
  }).join('');

  bindContinueCards(row);
  initRowAutoScroll(row, bindContinueCards);
}

function bindContinueCards(container) {
  container.querySelectorAll('.continue-card').forEach(card => {
    card.onclick = () => continueReading(card.dataset.mangaId, card.dataset.sourceId);
  });
}

window.loadRecentlyAdded = async function loadRecentlyAdded() {
  if (state.settings.homeMode === 'anime') return; // home page is showing anime content — see ui-anime-discover.js
  const reqSeq = ++_homeRowRequestSeq.recentlyAdded;
  const row = $("recentlyAddedRow");
  if (!row) return;
  const section = row.closest('.recent-section');
  const enabledSourceIds = _getHomeSourceIds().filter(sid => _sourceSupportsMethod(sid, 'recentlyAdded'));
  if (!enabledSourceIds.length) {
    if (section) section.style.display = 'none';
    row.innerHTML = '';
    return;
  }
  if (section) section.style.display = '';
  row.innerHTML = `<div class="muted">Loading...</div>`;
  try {
    const list = await _loadMultiSourceHomeList('recentlyAdded', 26, 40);
    if (reqSeq !== _homeRowRequestSeq.recentlyAdded) return;
    if (!list.length) { row.innerHTML = `<div class="muted">No manga found.</div>`; return; }
    row.innerHTML = list.map(m => mangaCardHTML(m)).join("");
    bindMangaCards(row);
    _hydrateMissingGenres(row);
    initRowAutoScroll(row);
  } catch (e) {
    if (reqSeq !== _homeRowRequestSeq.recentlyAdded) return;
    dbg.error(dbg.ERR_SOURCE, 'Error loading recently added', e);
    row.innerHTML = `<div class="muted">Error loading manga.</div>`;
  }
}

window.loadLatestUpdates = async function loadLatestUpdates() {
  if (state.settings.homeMode === 'anime') return; // home page is showing anime content — see ui-anime-discover.js
  const reqSeq = ++_homeRowRequestSeq.latestUpdates;
  const row = $("latestUpdatesRow");
  if (!row) return;
  row.innerHTML = `<div class="muted">Loading...</div>`;
  try {
    const list = await _loadMultiSourceHomeList('latestUpdates', 26, 28);
    if (reqSeq !== _homeRowRequestSeq.latestUpdates) return;
    if (!list.length) { row.innerHTML = `<div class="muted">No manga found.</div>`; return; }
    row.innerHTML = list.map(m => mangaCardHTML(m)).join("");
    bindMangaCards(row);
    _hydrateMissingGenres(row);
    initRowAutoScroll(row);
  } catch (e) {
    if (reqSeq !== _homeRowRequestSeq.latestUpdates) return;
    dbg.error(dbg.ERR_SOURCE, 'Error loading latest updates', e);
    row.innerHTML = `<div class="muted">Error loading manga.</div>`;
  }
}

/**
 * Renders a value as a JavaScript string literal that is safe to paste into a
 * double-quoted inline handler attribute: onclick="fn(${inlineJsArg(value)})".
 *
 * escapeHtml() alone is NOT enough there. The browser decodes the attribute
 * (&#39; becomes ') BEFORE it hands the text to the JS parser, so a value
 * written as '${escapeHtml(v)}' can still close the string it sits in
 * (v = x',alert(1),'), and the old hand-rolled .replace(/'/g, "\\'") fix is
 * defeated by a value that already holds a backslash before its quote
 * (the injected \ cancels the one the replace adds). JSON.stringify produces a
 * literal that cannot be closed from the inside (it escapes \ ' " and
 * newlines); escapeHtml then protects the attribute itself (" < > &).
 *
 * Every inline handler in public/ that carries data must go through this
 * (tests/unit/frontend-inline-handlers.test.js fails the build otherwise).
 * Shared by ui-search.js, ui-shop-view.js and ui-ui-binding.js: it lives here
 * because this is the first of those scripts to load.
 *
 * @param {*} value - coerced to string; null/undefined become ""
 * @returns {string} e.g. "Don't \"x\"" (quotes included), ready for an attribute
 */
function inlineJsArg(value) {
  return escapeHtml(
    JSON.stringify(value == null ? "" : String(value))
      // Valid inside a string literal since ES2019, but older parsers treat
      // them as line terminators and throw; costs nothing to escape.
      .replace(new RegExp("\\u2028", "g"), "\\u2028")
      .replace(new RegExp("\\u2029", "g"), "\\u2029")
  );
}

function mangaCardHTML(m) {
  const resolvedSourceId = m.sourceId || state.currentSourceId || "";
  const fallbackTag = resolvedSourceId === 'kingofshojo' ? 'Manhwa' : '';
  const sourceAttr = resolvedSourceId ? ` data-source-id="${escapeHtml(resolvedSourceId)}"` : "";
  const sourceLabel = m.sourceName || (resolvedSourceId ? (state.installedSources?.[resolvedSourceId]?.name || resolvedSourceId) : "");
  const coverUrl = normalizeImageUrl(m.cover);
  const inLibrary = isMangaInLibrary(m, resolvedSourceId);
  return `
    <div class="manga-card" data-manga-id="${escapeHtml(m.id)}"${sourceAttr}>
      <div class="manga-card-cover">
        ${coverUrl && !coverUrl.endsWith('.pdf') && !coverUrl.endsWith('.epub')
          ? `<img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(m.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
          : (m.cover ? '<div class="no-cover">&#128196;</div>' : '<div class="no-cover" data-missing-cover="1">?</div>')}
        ${sourceLabel ? `<span class="all-pop-source-badge">${escapeHtml(sourceLabel)}</span>` : ""}
        <button class="manga-card-library-btn${inLibrary ? ' in-library' : ''}"
          data-library-manga-id="${escapeHtml(m.id)}"
          data-source-id="${escapeHtml(resolvedSourceId)}"
          data-title="${escapeHtml(m.title)}"
          data-cover="${escapeHtml(m.cover || '')}"
          data-url="${escapeHtml(m.url || '')}"
          onclick="event.stopPropagation(); toggleCardLibrary(this)"
          title="${inLibrary ? 'Remove from Library' : 'Add to Library'}">
          <span class="icon-plus">+</span>
          <span class="icon-check">&#10003;</span>
          <span class="icon-minus">&minus;</span>
        </button>
      </div>
      <div class="manga-card-info">
        <h3 class="manga-card-title">${escapeHtml(getDisplayMangaTitle(m))}</h3>
        <p class="manga-card-author">${escapeHtml(m.author || "")}</p>
        ${genreBadgesHTML(m.genres, 3, fallbackTag, resolvedSourceId)}
        <button class="btn-start-reading" onclick="event.stopPropagation(); startReading(${inlineJsArg(m.id)}, ${inlineJsArg(resolvedSourceId)})">▶ Start Reading</button>
      </div>
    </div>
  `;
}

async function toggleCardLibrary(btn) {
  if (btn.disabled) return;
  const mangaId = btn.dataset.libraryMangaId;
  const sourceId = btn.dataset.sourceId;
  const wasInLibrary = btn.classList.contains('in-library');

  btn.disabled = true;
  try {
    if (wasInLibrary) {
      await ensureMangaNotInLibrary(mangaId, sourceId);
      btn.classList.remove('in-library');
      btn.title = 'Add to Library';
    } else {
      const manga = {
        id: mangaId,
        mangaId,
        sourceId,
        title: btn.dataset.title,
        cover: btn.dataset.cover,
        url: btn.dataset.url
      };
      const added = await ensureMangaInLibrary(manga, sourceId);
      if (added) {
        btn.classList.add('in-library');
        btn.title = 'Remove from Library';
      }
    }
  } finally {
    btn.disabled = false;
  }
}
window.toggleCardLibrary = toggleCardLibrary;

async function startReading(mangaId, sourceId = "") {
  if (sourceId && state.installedSources[sourceId] && sourceId !== state.currentSourceId) {
    state.currentSourceId = sourceId;
    renderSourceSelect();
  }
  if (!state.currentSourceId) { showToast("Select a source first", "", "warning"); return; }
  await loadMangaDetails(mangaId);
  if (!state.allChapters?.length) { showToast("No chapters found", "", "info"); return; }
  // Chapters are sorted newest-first; last index = chapter 1
  const firstIdx = state.allChapters.length - 1;
  const ch = state.allChapters[firstIdx];
  await loadChapter(ch.id, ch.name || `Chapter ${ch.chapter || 1}`, firstIdx);
}

async function continueReading(mangaId, sourceId) {
  if (!mangaId) return;
  // Switch source if needed
  if (sourceId && state.installedSources[sourceId] && sourceId !== state.currentSourceId) {
    state.currentSourceId = sourceId;
    renderSourceSelect();
  }
  if (!state.currentSourceId) { showToast("Select a source first", "", "warning"); return; }

  const lastChapterId = state.lastReadChapter?.[mangaId];
  if (!lastChapterId) {
    // No progress yet — fall back to start reading
    await startReading(mangaId);
    return;
  }

  const lastPageIndex = state.lastReadPages?.[`${mangaId}:${lastChapterId}`] || 0;
  try {
    showToast("Resuming...", "", "info");
    const result = await api(`/api/source/${state.currentSourceId}/mangaDetails`, {
      method: "POST",
      body: JSON.stringify({ mangaId })
    });
    state.currentManga = result;
    const cr = await api(`/api/source/${state.currentSourceId}/chapters`, {
      method: "POST",
      body: JSON.stringify({ mangaId })
    });
    state.allChapters = cr.chapters || [];
    state.chapterCountCache[mangaId] = state.allChapters.length;
    saveSettings();
    const idx = state.allChapters.findIndex(c => c.id === lastChapterId);
    if (idx >= 0) {
      const ch = state.allChapters[idx];
      await loadChapter(lastChapterId, ch.name || `Chapter ${ch.chapter || idx + 1}`, idx, lastPageIndex);
    } else {
      await loadMangaDetails(mangaId);
    }
  } catch (err) {
    dbg.error(dbg.ERR_SOURCE, 'Error continuing reading', err);
    showToast("Error", "Could not continue reading.", "error");
  }
}
