// ============================================================================
// ANIME ADVANCED SEARCH — same manga/anime toggle pattern as Discover/
// History/Calendar/Library (see ui-anime-discover.js's applyHomeMode and
// ui-library.js's applyLibraryMode), applied to the Advanced Search view.
//
// Unlike manga's advanced search (ui-advanced-search.js), there's no
// per-installed-source dispatch to manage here: anime search is always one
// AniList query, with AniList's own sort/genre/status filters, so this file
// is a lot smaller — no source-capability matrix, no client-side filtering
// fallback, no source dropdown.
// ============================================================================

const _animeAdvSearchLoadMore = createLoadMoreController("animeAdvancedSearchPagination");
// Lets animeAdvancedSearch() detect when a newer call has superseded an
// older, still-in-flight one (e.g. user changes a filter while a previous
// search/load-more is still awaiting AniList), so the older call can drop
// its results instead of overwriting resultsDiv with stale content.
let _animeAdvSearchGeneration = 0;
const ANIME_ADV_PER_PAGE = 30;

function applyAdvancedSearchMode(mode, { persist = true } = {}) {
  const resolved = mode === 'anime' ? 'anime' : 'manga';
  state.settings.advancedSearchMode = resolved;
  if (persist && typeof saveSettings === 'function') saveSettings();

  const mangaEl = $("advancedSearchMangaContent");
  const animeEl = $("advancedSearchAnimeContent");
  if (mangaEl) mangaEl.classList.toggle("hidden", resolved === 'anime');
  if (animeEl) animeEl.classList.toggle("hidden", resolved !== 'anime');

  // Shares #homeModeToggleBtn with Home instead of its own button (see
  // ui-anime-discover.js's _initHomeModeToggle) — only writes the label when
  // Advanced Search is actually the view on screen, so a background call
  // (persist:false, syncing state while some other page is open) can't
  // stomp a label that's currently showing Home's own mode instead.
  const btn = $("homeModeToggleBtn");
  if (btn && navigationManager.currentView === 'advanced-search') {
    btn.textContent = resolved === 'anime' ? "Manga" : "Anime";
    btn.title = resolved === 'anime' ? "Switch search to Manga" : "Switch search to Anime";
  }

  if (resolved === 'anime') {
    _animeApplyAdvancedSearchNsfwVisibility();
  }

  // Discord Rich Presence: setView() only reports on navigation — toggling
  // manga/anime *within* this page (the common case, via the button above)
  // never re-navigates, so without this the status line would freeze on
  // whichever mode was active when the page was first opened. Guarded by
  // "is this view actually on screen right now" so a Settings-modal-driven
  // call (persist:false, syncing a default while some other page is open)
  // doesn't hijack the presence for a page the user isn't even looking at.
  if (navigationManager.currentView === 'advanced-search' && typeof discordReportForView === 'function') {
    discordReportForView('advanced-search');
  }
}
window.applyAdvancedSearchMode = applyAdvancedSearchMode;

function _animeApplyAdvancedSearchNsfwVisibility() {
  const hideNsfw = state.settings.hideNsfw === true;
  const blacklist = state.settings.genreBlacklist || [];
  document.querySelectorAll('#animeGenreGrid .genre-check').forEach(label => {
    const cb = label.querySelector('input[type="checkbox"]');
    const isNsfw = label.dataset.nsfw === "1";
    const val = (cb?.value || "").toLowerCase();
    const isBlacklisted = blacklist.includes(val);
    const shouldHide = (hideNsfw && isNsfw) || isBlacklisted;
    label.style.display = shouldHide ? "none" : "";
    if (shouldHide && cb?.checked) cb.checked = false;
  });
}

// ── Tags — AniList's `genres` enum (above) is fixed at 19 values; `tags` is
// a much larger (300+), separately-queried taxonomy with its own filter arg
// (`tag_in`, not `genre_in`). Hand-typing a subset by name risks ones that
// don't actually exist verbatim in AniList's system (silently wrong/empty
// results) — so this fetches the real, current list from AniList itself
// once, cached for the session, instead of guessing. Adult and spoiler-
// flagged tags are dropped entirely rather than shown-then-hidden (unlike
// the NSFW genres above): there's no "reveal adult tags" toggle for this
// grid, by design. ──────────────────────────────────────────────────────
let _animeTagCollectionCache = null; // null = not fetched yet; [] = fetched, empty/failed

async function _fetchAnimeTagCollection() {
  if (_animeTagCollectionCache) return _animeTagCollectionCache;
  const gql = `query { MediaTagCollection { name category isAdult isGeneralSpoiler isMediaSpoiler } }`;
  try {
    let data = await anilistGQL(gql, {});
    if (data?.errors?.some(e => /rate limit|too many requests/i.test(e.message || ''))) {
      await new Promise(r => setTimeout(r, 3000));
      data = await anilistGQL(gql, {});
    }
    if (data?.errors?.length) throw new Error(data.errors[0]?.message || "AniList tag fetch failed");
    const tags = (data?.data?.MediaTagCollection || [])
      .filter(t => t?.name && !t.isAdult && !t.isGeneralSpoiler && !t.isMediaSpoiler)
      .map(t => t.name)
      .sort((a, b) => a.localeCompare(b));
    _animeTagCollectionCache = tags;
    return tags;
  } catch (e) {
    dbg.warn(dbg.ERR_SOURCE, "Failed to load AniList tag collection", e);
    return null; // distinct from "fetched, genuinely empty" — lets the caller offer Retry
  }
}

async function _animeRenderTagGrid() {
  const grid = $("animeTagGrid");
  if (!grid) return;
  const tags = await _fetchAnimeTagCollection();

  if (tags === null) {
    grid.innerHTML = `<div class="muted" style="padding:8px;">Couldn't load tags. <a href="#" id="animeTagGridRetry" style="color:var(--primary);text-decoration:underline;">Retry</a></div>`;
    const retryLink = $("animeTagGridRetry");
    if (retryLink) retryLink.onclick = (e) => { e.preventDefault(); _animeRenderTagGrid(); };
    return;
  }
  if (!tags.length) {
    grid.innerHTML = `<div class="muted" style="padding:8px;">No tags available.</div>`;
    return;
  }

  grid.innerHTML = tags.map(name =>
    `<label class="genre-check"><input type="checkbox" value="${escapeHtml(name)}"><span>${escapeHtml(name)}</span></label>`
  ).join("");
  grid.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => animeAdvancedSearch(1, false);
  });
}

async function animeAdvancedSearch(page = 1, isLoadMore = false) {
  const statusEl = $("animeAdvancedSearchStatus");
  const resultsDiv = $("animeAdvancedResults");
  if (!resultsDiv) return;
  const myGeneration = ++_animeAdvSearchGeneration;

  const query = $("animeAdvancedSearchInput")?.value.trim() || "";
  const sort = $("animeAdvancedSort")?.value || "SEARCH_MATCH";
  const status = $("animeAdvancedStatus")?.value || "";
  let genres = Array.from(document.querySelectorAll('#animeGenreGrid input[type="checkbox"]:checked')).map(cb => cb.value);
  if (state.settings.hideNsfw) {
    const nsfwSet = new Set(['ecchi', 'hentai']);
    genres = genres.filter(g => !nsfwSet.has(g.toLowerCase()));
  }
  const tags = Array.from(document.querySelectorAll('#animeTagGrid input[type="checkbox"]:checked')).map(cb => cb.value);

  if (!isLoadMore) statusEl.textContent = "Searching...";

  const gql = `query ($search: String, $page: Int, $perPage: Int, $sort: [MediaSort], $genre_in: [String], $tag_in: [String], $status: MediaStatus) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage }
      media(search: $search, type: ANIME, sort: $sort, genre_in: $genre_in, tag_in: $tag_in, status: $status) {
        idMal id episodes format status genres
        title { romaji english }
        coverImage { extraLarge large }
      }
    }
  }`;
  // AniList treats an empty genre_in/tag_in array or empty status string as
  // real (over-restrictive) filters rather than "unset" — only include them
  // in variables when the user actually picked something.
  const variables = { page, perPage: ANIME_ADV_PER_PAGE, sort: [sort] };
  if (query) variables.search = query;
  if (genres.length) variables.genre_in = genres;
  if (tags.length) variables.tag_in = tags;
  if (status) variables.status = status;

  const fetchOnce = () => anilistGQL(gql, variables);

  try {
    let data = await fetchOnce();
    if (data?.errors?.some(e => /rate limit|too many requests/i.test(e.message || ''))) {
      await new Promise(r => setTimeout(r, 3000));
      data = await fetchOnce();
    }
    if (data?.errors?.length) throw new Error(data.errors[0]?.message || "AniList search failed");

    // A newer call to animeAdvancedSearch() started after this one — its
    // result is stale and would overwrite resultsDiv with outdated content
    // if allowed to proceed; drop it instead.
    if (myGeneration !== _animeAdvSearchGeneration) return;

    const media = data?.data?.Page?.media || [];
    const hasNextPage = !!data?.data?.Page?.pageInfo?.hasNextPage;
    state.animeAdvSearchPage = page;

    if (!isLoadMore && !media.length) {
      resultsDiv.innerHTML = `<div class="muted">No results found</div>`;
      statusEl.textContent = "0 result(s) found";
      _animeAdvSearchLoadMore.show(hasNextPage, () => animeAdvancedSearch(page + 1, true));
      return;
    }

    if (!isLoadMore) {
      resultsDiv.innerHTML = media.map(m => _animeDiscoverCardHTML(m)).join("");
      _bindAnimeDiscoverCards(resultsDiv);
    } else if (media.length) {
      resultsDiv.insertAdjacentHTML("beforeend", media.map(m => _animeDiscoverCardHTML(m)).join(""));
      _bindAnimeDiscoverCards(resultsDiv);
    }
    statusEl.textContent = `${resultsDiv.querySelectorAll("[data-idmal]").length} result(s) loaded`;
    _animeAdvSearchLoadMore.show(hasNextPage, () => animeAdvancedSearch(page + 1, true));
  } catch (e) {
    if (!isLoadMore) {
      resultsDiv.innerHTML = `<div class="muted">Error: ${escapeHtml(e.message)} <a href="#" id="animeAdvSearchRetry" style="color:var(--primary);text-decoration:underline;">Retry</a></div>`;
      const retryLink = $("animeAdvSearchRetry");
      if (retryLink) retryLink.onclick = (ev) => { ev.preventDefault(); animeAdvancedSearch(1, false); };
    }
    statusEl.textContent = "";
    dbg.warn(dbg.ERR_SOURCE, "Anime advanced search failed", e);
  }
}

function _initAnimeAdvancedSearch() {
  // The mode toggle itself is now the shared #homeModeToggleBtn in the top
  // bar (see ui-anime-discover.js's _initHomeModeToggle) — this page no
  // longer has its own separate button/click handler.

  const searchBtn = $("animeAdvancedSearchBtn");
  if (searchBtn) searchBtn.onclick = () => animeAdvancedSearch(1, false);
  const searchInput = $("animeAdvancedSearchInput");
  if (searchInput) searchInput.onkeydown = (e) => { if (e.key === "Enter") animeAdvancedSearch(1, false); };
  const sortSel = $("animeAdvancedSort");
  if (sortSel) sortSel.onchange = () => animeAdvancedSearch(1, false);
  const statusSel = $("animeAdvancedStatus");
  if (statusSel) statusSel.onchange = () => animeAdvancedSearch(1, false);

  document.querySelectorAll('#animeGenreGrid input[type="checkbox"]').forEach(cb => {
    cb.onchange = () => animeAdvancedSearch(1, false);
  });

  // Genres and Tags share one collapsible section (index.html) even though
  // they're two separate AniList query args under the hood (genre_in vs
  // tag_in, see animeAdvancedSearch below) — Clear empties both grids at
  // once, and the section's own toggle lazy-fetches Tags (300+ entries)
  // only the first time it's actually expanded, same laziness the old
  // separate Tags section had.
  const clearBtn = $("animeClearGenresTagsBtn");
  if (clearBtn) clearBtn.onclick = (e) => {
    e.preventDefault();
    document.querySelectorAll('#animeGenreGrid input[type="checkbox"]:checked, #animeTagGrid input[type="checkbox"]:checked').forEach(cb => { cb.checked = false; });
    animeAdvancedSearch(1, false);
  };

  let _animeTagsLoaded = false;
  const genreTagToggle = $("animeGenreTagFilterToggle");
  const genreTagGroup = $("animeGenreTagFilterGroup");
  if (genreTagToggle && genreTagGroup) {
    genreTagToggle.onclick = (e) => {
      if (e.target.closest('#animeClearGenresTagsBtn')) return;
      genreTagGroup.classList.toggle("collapsed");
      if (!genreTagGroup.classList.contains("collapsed") && !_animeTagsLoaded) {
        _animeTagsLoaded = true;
        _animeRenderTagGrid();
      }
    };
  }

  // Same reasoning as ui-history.js's _initHistoryModeToggle: setView
  // always calls applyAdvancedSearchMode itself with the then-current
  // setting, so this only needs to wire click handlers.
}
document.addEventListener("DOMContentLoaded", _initAnimeAdvancedSearch);
