// ============================================================================
// ANIME HOME PAGE (Discover view, anime mode)
//
// The Discover view now has two content modes sharing one page: manga
// (unchanged, in #discoverMangaContent) and anime (#discoverAnimeContent,
// this file). A topbar icon (#homeModeToggleBtn) swaps between them and
// persists the choice in state.settings.homeMode — see state.js. When
// homeMode is 'anime', ui-discover.js's/ui-calendar.js's manga row loaders
// early-return (guard added at their top) so this file owns all of Discover's
// actual content in that mode.
//
// Continue Watching and the favorite-card renderer are NOT duplicated here —
// they reuse _fetchAnimeFavorites()/_animeFavoriteCardHTML()/
// _bindAnimeFavoriteCardClicks() from ui-anime-test.js directly, same data,
// same click-to-details behavior as My Anime's own library/history pages.
//
// Popular / Current Season / New Episodes come from ONE combined AniList
// query (three aliased Page fields in a single request) rather than three
// separate round-trips — this app's AniList budget has been exhausted by
// far less before (see ui-anime-test.js's own doc comment on that history).
// Recommended For You is computed client-side by scoring that same
// popular+season pool against the user's favorited genres (captured at
// favorite-time, see routes/anime.js), so it costs zero extra AniList calls.
// ============================================================================

function _currentAniListSeason(date = new Date()) {
  const month = date.getUTCMonth() + 1; // 1-12
  const year = date.getUTCFullYear();
  if (month === 12) return { season: 'WINTER', year: year + 1 };
  if (month <= 2) return { season: 'WINTER', year };
  if (month <= 5) return { season: 'SPRING', year };
  if (month <= 8) return { season: 'SUMMER', year };
  return { season: 'FALL', year };
}

// Romaji-first for anime (e.g. "Koe no Katachi", not "A Silent Voice") —
// deliberate, at the user's request. AniList's own search still matches an
// English query against the same media regardless of which title variant is
// shown (see animeAdvancedSearch/_loadAnimeHomeDiscovery's search calls),
// so switching display preference here doesn't cost any find-by-English-name
// capability.
function _animeMediaTitle(m) {
  return m.title?.romaji || m.title?.english || (m.idMal ? `MAL#${m.idMal}` : `AniList #${m.id}`);
}

// Shared by Popular / Season / New Episodes / home Search results — clicking
// always just opens the details page (favoriting happens from there), same
// pattern as every other anime card in this app.
function _animeDiscoverCardHTML(m, badge) {
  const title = _animeMediaTitle(m);
  // extraLarge before large — see ANIME_DISCOVER_MEDIA_FIELDS's comment
  // below for why "large" alone isn't actually AniList's large image.
  const cover = m.coverImage?.extraLarge || m.coverImage?.large || "";
  const epBadge = badge || (m.episodes ? `${m.episodes} ep` : (m.status === "RELEASING" ? "Airing" : ""));
  // No status badge here — these are catalog results, not library items, so
  // there's no watchStatus to show (only My Anime library cards have one).
  // Genres double as "tags" for the same showTags toggle (Settings > Anime
  // > Library Card) since AniList catalog entries have no user-set tags
  // either — genres are the closest equivalent this card actually has.
  const cardSettings = typeof loadAnimeLibraryCardSettings === 'function' ? loadAnimeLibraryCardSettings() : {};
  const genres = (m.genres || []).slice(0, 3);
  return `<div class="manga-card" data-idmal="${m.idMal || ''}" data-anilist-id="${m.id || ''}" data-title="${escapeHtml(title)}" data-cover="${escapeHtml(cover)}" data-episodes="${m.episodes || ''}" data-genres="${escapeHtml((m.genres || []).join('|'))}">
    <div class="manga-card-cover">
      ${cover ? `<img src="${escapeHtml(cover)}" alt="${escapeHtml(title)}" loading="lazy">` : `<div class="no-cover">?</div>`}
      ${epBadge ? `<span class="all-pop-source-badge">${escapeHtml(epBadge)}</span>` : ""}
    </div>
    <div class="manga-card-info">
      <div class="manga-card-title">${escapeHtml(title)}</div>
      ${m.idMal ? '' : '<div class="manga-card-author">No MAL id — unplayable</div>'}
      ${cardSettings.showTags && genres.length ? `<div class="library-card-tags">${genres.map(g => `<span class="tag">${escapeHtml(g)}</span>`).join("")}</div>` : ""}
    </div>
  </div>`;
}

function _bindAnimeDiscoverCards(container) {
  container.querySelectorAll("[data-idmal]").forEach(card => {
    card.onclick = () => {
      const idMal = card.dataset.idmal;
      if (!idMal) {
        showToast("Anime", "This title has no MyAnimeList id — it can't be looked up without one.", "error");
        return;
      }
      _animeGoToDetails({
        idMal,
        anilistId: card.dataset.anilistId,
        title: card.dataset.title,
        cover: card.dataset.cover,
        episodes: parseInt(card.dataset.episodes, 10) || 0,
        genres: (card.dataset.genres || '').split('|').filter(Boolean),
      });
    };
  });
}

// ── Continue Watching ─────────────────────────────────────────────────────
// Sourced from animeHistory (via _fetchAnimeHistory, ui-anime-test.js), NOT
// animeFavorites — same parity fix as ui-discover.js's renderContinueReading
// pulling from state.history rather than state.favorites: history is
// independent of favoriting (see routes/anime.js's POST /api/anime/progress
// and the Dragon Ball GT bug this session already fixed for the History
// page itself), so a show watched without ever hitting "Add to My Anime"
// still shows up here instead of silently having no "continue" entry point
// on Home. _animeFavoriteCardHTML only reads fields animeHistory entries
// already carry (idMal/title/cover/lastWatchedEpisode/totalEpisodes/
// lastPositionSeconds/lastDurationSeconds/anilistId), so it renders either
// shape unchanged.
async function renderAnimeHomeContinueWatching() {
  const section = $("animeHomeContinueSection");
  const row = $("animeHomeContinueRow");
  if (!section || !row) return;

  const history = await _fetchAnimeHistory();
  const entries = history.slice(0, 12); // already sorted newest-first by the server

  if (!entries.length) {
    section.classList.add('hidden');
    row.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');
  row.innerHTML = entries.map(_animeFavoriteCardHTML).join('');
  _bindAnimeFavoriteCardClicks(row);
  initRowAutoScroll(row, _bindAnimeFavoriteCardClicks);
}

// ── Recommended For You (client-side scoring, no extra AniList call) ──────

function _animeBuildGenreProfile(favorites) {
  const genreWeights = new Map();
  const favoredIdMals = new Set();
  for (const f of favorites) {
    favoredIdMals.add(String(f.idMal));
    const weight = f.lastWatchedEpisode > 0 ? 2 : 1; // actively watched counts more than just planned
    for (const g of (f.genres || [])) {
      const key = String(g).toLowerCase();
      genreWeights.set(key, (genreWeights.get(key) || 0) + weight);
    }
  }
  return { genreWeights, favoredIdMals };
}

function _animeRecommendationScore(m, profile) {
  let score = 0;
  for (const g of (m.genres || [])) {
    score += profile.genreWeights.get(String(g).toLowerCase()) || 0;
  }
  if (m.averageScore >= 80) score += 5;
  return score;
}

// ── Combined discovery query: Popular + Current Season + New Episodes ─────

// AniList's "large" coverImage field is, confusingly, their own *medium*-
// resolution file (compare the CDN paths: large → .../cover/medium/...,
// extraLarge → .../cover/large/...) — every anime cover query across this
// app was requesting just "large" alone, so every anime cover shown
// anywhere (library cards, discover cards, the details page hero image)
// was rendering at medium resolution. Requesting extraLarge too and
// preferring it (see _animeDiscoverCardHTML above) fixes that everywhere
// this shared query feeds: Popular/Season/New Episodes/Recommended/search.
const ANIME_DISCOVER_MEDIA_FIELDS = `id idMal episodes format status averageScore genres isAdult
      title { romaji english }
      coverImage { extraLarge large }`;

async function _loadAnimeHomeDiscovery() {
  const popularRow = $("animeHomePopularRow");
  const seasonRow = $("animeHomeSeasonRow");
  const newEpRow = $("animeHomeNewEpisodesRow");
  const recSection = $("animeHomeRecommendedSection");
  const recRow = $("animeHomeRecommendedRow");
  if (popularRow) popularRow.innerHTML = `<div class="muted">Loading...</div>`;
  if (seasonRow) seasonRow.innerHTML = `<div class="muted">Loading...</div>`;
  if (newEpRow) newEpRow.innerHTML = `<div class="muted">Loading...</div>`;

  const { season, year } = _currentAniListSeason();
  const seasonTitleEl = $("animeHomeSeasonTitle");
  if (seasonTitleEl) {
    const label = season.charAt(0) + season.slice(1).toLowerCase();
    seasonTitleEl.textContent = `${label} ${year} Anime`;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const airGt = nowSec - 3 * 24 * 3600;

  const query = `query ($season: MediaSeason, $year: Int, $airGt: Int, $airLt: Int) {
        popular: Page(page: 1, perPage: 20) {
          media(type: ANIME, sort: TRENDING_DESC) { ${ANIME_DISCOVER_MEDIA_FIELDS} }
        }
        season: Page(page: 1, perPage: 20) {
          media(type: ANIME, season: $season, seasonYear: $year, sort: POPULARITY_DESC) { ${ANIME_DISCOVER_MEDIA_FIELDS} }
        }
        newEpisodes: Page(page: 1, perPage: 30) {
          airingSchedules(airingAt_greater: $airGt, airingAt_lesser: $airLt, sort: TIME_DESC) {
            episode
            airingAt
            media { ${ANIME_DISCOVER_MEDIA_FIELDS} }
          }
        }
      }`;
  const variables = { season, year, airGt, airLt: nowSec };

  try {
    // Same AniList rate-limit flakiness as everywhere else in this feature
    // (this app's shared budget gets exhausted easily) — one retry after a
    // short delay before giving up and showing a real retry option.
    let data = await anilistGQL(query, variables);
    if (data?.errors?.some(e => /rate limit|too many requests/i.test(e.message || ''))) {
      await new Promise(r => setTimeout(r, 3000));
      data = await anilistGQL(query, variables);
    }
    if (data?.errors?.length) throw new Error(data.errors[0]?.message || "AniList request failed");

    const hideNsfw = !!state.settings.hideNsfw;
    const notAdult = (m) => !hideNsfw || !m.isAdult;

    const popular = (data?.data?.popular?.media || []).filter(notAdult);
    const seasonList = (data?.data?.season?.media || []).filter(notAdult);

    const seenEpisodeMedia = new Set();
    const newEpisodes = [];
    for (const sched of (data?.data?.newEpisodes?.airingSchedules || [])) {
      const m = sched.media;
      if (!m || !notAdult(m) || seenEpisodeMedia.has(m.id)) continue;
      seenEpisodeMedia.add(m.id);
      newEpisodes.push({ media: m, episode: sched.episode });
    }

    if (popularRow) {
      popularRow.innerHTML = popular.length
        ? popular.map(m => _animeDiscoverCardHTML(m)).join('')
        : `<div class="muted">No data available.</div>`;
      _bindAnimeDiscoverCards(popularRow);
      initRowAutoScroll(popularRow, _bindAnimeDiscoverCards);
    }
    if (seasonRow) {
      seasonRow.innerHTML = seasonList.length
        ? seasonList.map(m => _animeDiscoverCardHTML(m)).join('')
        : `<div class="muted">No data available.</div>`;
      _bindAnimeDiscoverCards(seasonRow);
    }
    if (newEpRow) {
      newEpRow.innerHTML = newEpisodes.length
        ? newEpisodes.map(({ media, episode }) => _animeDiscoverCardHTML(media, `EP ${episode}`)).join('')
        : `<div class="muted">No recent episodes found.</div>`;
      _bindAnimeDiscoverCards(newEpRow);
    }

    // Recommended For You — score the popular+season pool against the
    // user's favorited genres; hidden entirely if there's no library data
    // or none of it has genres yet (older favorites predate genre capture).
    if (recSection && recRow) {
      const favorites = await _fetchAnimeFavorites();
      const profile = _animeBuildGenreProfile(favorites);
      if (profile.genreWeights.size === 0) {
        recSection.style.display = 'none';
        recRow.innerHTML = '';
      } else {
        const seen = new Set();
        const pool = [...popular, ...seasonList].filter(m => {
          if (!m.idMal || profile.favoredIdMals.has(String(m.idMal)) || seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
        const scored = pool
          .map(m => ({ m, score: _animeRecommendationScore(m, profile) }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 20);
        if (scored.length) {
          recSection.style.display = '';
          recRow.innerHTML = scored.map(x => _animeDiscoverCardHTML(x.m)).join('');
          _bindAnimeDiscoverCards(recRow);
          initRowAutoScroll(recRow, _bindAnimeDiscoverCards);
        } else {
          recSection.style.display = 'none';
          recRow.innerHTML = '';
        }
      }
    }
  } catch (e) {
    dbg.error(dbg.ERR_SOURCE, 'Error loading anime home discovery rows', e);
    const errorHTML = `<div class="muted">Error loading anime. <a href="#" class="anime-home-discovery-retry" style="color:var(--primary);text-decoration:underline;">Retry</a></div>`;
    if (popularRow) popularRow.innerHTML = errorHTML;
    if (seasonRow) seasonRow.innerHTML = errorHTML;
    if (newEpRow) newEpRow.innerHTML = errorHTML;
    document.querySelectorAll('.anime-home-discovery-retry').forEach(link => {
      link.onclick = (ev) => { ev.preventDefault(); _loadAnimeHomeDiscovery(); };
    });
  }
}

function refreshAnimeHome() {
  renderAnimeHomeContinueWatching();
  _loadAnimeHomeDiscovery();
}
window.refreshAnimeHome = refreshAnimeHome;

// ── Home search (mirrors ui-anime-test.js's _animeTestSearch, targeting the
// Discover-page search box instead of the dedicated Anime Beta page) ──────

async function _animeHomeSearch() {
  const input = $("animeHomeSearchInput");
  const status = $("animeHomeSearchStatus");
  const resultsEl = $("animeHomeSearchResults");
  const query = (input?.value || "").trim();
  if (!query) return;

  status.textContent = "Searching AniList...";
  resultsEl.innerHTML = "";

  try {
    const data = await anilistGQL(
      `query ($s: String) {
        Page(page: 1, perPage: 18) {
          media(search: $s, type: ANIME) { ${ANIME_DISCOVER_MEDIA_FIELDS} }
        }
      }`,
      { s: query }
    );
    if (data?.errors?.length) throw new Error(data.errors[0]?.message || "AniList search failed");
    const hideNsfw = !!state.settings.hideNsfw;
    const results = (data?.data?.Page?.media || []).filter(m => !hideNsfw || !m.isAdult);
    if (!results.length) {
      status.textContent = "No results.";
      return;
    }
    status.textContent = `${results.length} result(s)`;
    resultsEl.innerHTML = results.map(m => _animeDiscoverCardHTML(m)).join("");
    _bindAnimeDiscoverCards(resultsEl);
  } catch (e) {
    status.textContent = `Search failed: ${e.message}`;
    dbg.warn(dbg.ERR_SOURCE, "Anime home search failed", e);
  }
}

function _initAnimeHomeSearch() {
  const btn = $("animeHomeSearchBtn");
  const input = $("animeHomeSearchInput");
  if (btn) btn.onclick = _animeHomeSearch;
  if (input) input.onkeydown = (e) => { if (e.key === "Enter") _animeHomeSearch(); };
}

// ── Mode toggle ─────────────────────────────────────────────────────────

// Views whose own manga/anime toggle now lives entirely in the shared
// #homeModeToggleBtn (top bar) instead of a page-local button — each used to
// have its own, which looked like a pile of redundant duplicates of this one
// button. Rather than merging all their settings into one (which would mean,
// e.g., an anime's genre-pill deep-link into Advanced Search — see
// ui-anime-test.js's genrePillsEl handler — silently flipping what Home
// shows too), the button now acts on whichever mode belongs to the view
// actually on screen, while every view's own setting stays independent
// under the hood. See applyLibraryMode/applyHistoryMode/applyCalendarMode/
// applyAdvancedSearchMode, each guarded the same way applyHomeMode is below.
const _OTHER_MODE_TOGGLE_VIEWS = ['advanced-search', 'library', 'history', 'calendar'];

// Label-only resync for the shared button, used when navigating to a view
// that doesn't own it (see ui-view-management.js's setView) — deliberately
// NOT the full applyHomeMode(), which also re-fetches every Home row
// (Popular Today, Recently Added, Latest Updates, Recommendations). Calling
// that on every plain navigation back to a page other than Home would waste
// a full reload's worth of requests on content nobody asked to refresh.
function _syncSharedModeToggleToHome() {
  const btn = $("homeModeToggleBtn");
  if (!btn) return;
  const resolved = state.settings.homeMode === 'anime' ? 'anime' : 'manga';
  btn.textContent = resolved === 'anime' ? "Manga" : "Anime";
  btn.title = resolved === 'anime' ? "Switch home page to Manga" : "Switch home page to Anime";
}

function applyHomeMode(mode, { persist = true } = {}) {
  const resolved = mode === 'anime' ? 'anime' : 'manga';
  state.settings.homeMode = resolved;
  if (persist) saveSettings();

  const mangaEl = $("discoverMangaContent");
  const animeEl = $("discoverAnimeContent");
  if (mangaEl) mangaEl.classList.toggle("hidden", resolved === 'anime');
  if (animeEl) animeEl.classList.toggle("hidden", resolved !== 'anime');

  // Skip the shared header button's label while another view owns it right
  // now (see _OTHER_MODE_TOGGLE_VIEWS above) — this can run in the
  // background while looking at a different view (e.g. the Settings modal's
  // "default home mode" dropdown, ui-settings-modal.js), and must not stomp
  // a label that's currently showing that other view's own mode instead.
  const btn = $("homeModeToggleBtn");
  if (btn && !_OTHER_MODE_TOGGLE_VIEWS.includes(navigationManager.currentView)) {
    // Label is the destination, not the current state — "tap to switch to X".
    btn.textContent = resolved === 'anime' ? "Manga" : "Anime";
    btn.title = resolved === 'anime' ? "Switch home page to Manga" : "Switch home page to Anime";
  }

  if (resolved === 'anime') {
    refreshAnimeHome();
  } else {
    if (window._homeSeenManga) window._homeSeenManga.clear();
    if (typeof renderContinueReading === 'function') renderContinueReading();
    if (typeof loadPopularToday === 'function') loadPopularToday();
    if (typeof loadRecentlyAdded === 'function') loadRecentlyAdded();
    if (typeof loadLatestUpdates === 'function') loadLatestUpdates();
    if (typeof loadRecommendations === 'function') loadRecommendations();
  }

  // Discord Rich Presence: see applyAdvancedSearchMode's identical comment
  // (ui-anime-advanced-search.js) — this toggle doesn't re-navigate, so
  // without this the status would freeze on whichever mode was active when
  // the page first opened.
  if (navigationManager.currentView === 'discover' && typeof discordReportForView === 'function') {
    discordReportForView('discover');
  }
}
window.applyHomeMode = applyHomeMode;

function _initHomeModeToggle() {
  const btn = $("homeModeToggleBtn");
  if (btn) {
    // See _OTHER_MODE_TOGGLE_VIEWS above — dispatches to whichever view's
    // own apply*Mode function actually owns the button right now, falling
    // back to Home for every view that doesn't have its own mode.
    btn.onclick = () => {
      const view = navigationManager.currentView;
      if (view === 'advanced-search' && typeof applyAdvancedSearchMode === 'function') {
        applyAdvancedSearchMode(state.settings.advancedSearchMode === 'anime' ? 'manga' : 'anime');
      } else if (view === 'library' && typeof applyLibraryMode === 'function') {
        applyLibraryMode(state.settings.libraryMode === 'anime' ? 'manga' : 'anime');
      } else if (view === 'history' && typeof applyHistoryMode === 'function') {
        applyHistoryMode(state.settings.historyMode === 'anime' ? 'manga' : 'anime');
      } else if (view === 'calendar' && typeof applyCalendarMode === 'function') {
        applyCalendarMode(state.settings.calendarMode === 'anime' ? 'manga' : 'anime');
      } else {
        applyHomeMode(state.settings.homeMode === 'anime' ? 'manga' : 'anime');
      }
    };
  }
  _initAnimeHomeSearch();
  // Deliberately NOT syncing button label/container visibility here from
  // state.settings.homeMode — this runs on DOMContentLoaded, which fires
  // as soon as every deferred script's own top-level code has run, but
  // ui-initialization.js's loadSettings() call sits behind an earlier
  // `await checkAuthGate()` in its own async IIFE, so it hasn't
  // necessarily populated state.settings from localStorage yet at this
  // point — confirmed live: this used to read the in-memory default
  // ('manga') instead of a real persisted 'anime' choice, showing the
  // manga container while ui-state.js's later, correctly-timed
  // refreshState() had already decided (correctly) that anime mode was
  // active and skipped loading manga rows into it — a visible container
  // that could never populate. applyHomeMode() below (called from
  // ui-state.js, well after loadSettings() has actually run) is now the
  // single place that does this sync, exactly once, with real data.
}

document.addEventListener("DOMContentLoaded", _initHomeModeToggle);
