// ============================================================================
// STATE & RENDERING
// ============================================================================

async function refreshState() {
  try {
    const data = await api("/api/state");
    state.installedSources = data.installedSources || {};
    state.availableSources = data.availableSources || [];
    state.repos = data.repos || [];
    // With no source installed the home page says what to do (ui-empty-sources.js).
    if (typeof renderNoSourcesNotice === 'function') renderNoSourcesNotice();

    const [libData, statusData] = await Promise.all([
      api("/api/library"),
      api("/api/user/status")
    ]);

    state.favorites     = libData.favorites || [];
    state.history       = libData.history   || [];
    state.coverOverrides = libData.coverOverrides || {};
    state.mangaTags      = libData.mangaTags || {};
    state.nsfwOverrides  = libData.nsfwOverrides || {};
    state.readingStatus = statusData.readingStatus || {};

    // Load custom lists (categories) and AniList sync metadata
    try {
      const listsData = await api('/api/lists');
      state.customLists = listsData.lists || [];
    } catch (_) { state.customLists = []; }

    try {
      const syncMeta = await api('/api/anilist/sync-meta');
      state.anilistSync = syncMeta;
    } catch (_) { state.anilistSync = null; }

    try {
      const localData = await api("/api/local/list");
      state.localManga = localData.localManga || [];
      // Generate covers for any PDF/EPUB manga that still has a raw-file cover
      generateMissingPDFCovers();
      generateMissingEpubCovers();
    } catch (_) { state.localManga = []; }

    try {
      const ratingsData = await api("/api/ratings");
      state.ratings = ratingsData.ratings || {};
    } catch (_) { state.ratings = {}; }

    renderSourceSelect();
    if (typeof syncProgressionWithServer === 'function') syncProgressionWithServer();
    if (typeof applyHomeSearchVisibility === 'function') applyHomeSearchVisibility();
    if (window._homeSeenManga) window._homeSeenManga.clear();
    if (typeof renderContinueReading === 'function') renderContinueReading();
    await Promise.all([
      loadPopularToday(),
      loadRecentlyAdded(),
      loadLatestUpdates()
    ]);
    await updateStats();
    renderLibrary();

    // Trigger recommendations if there's any reading history or library content
    if (state.favorites.length > 0 || state.history.length > 0) loadRecommendations();

    // Syncs the home-mode container visibility/button label now that
    // loadSettings() has definitely run — this can't safely happen on
    // DOMContentLoaded (see ui-anime-discover.js's _initHomeModeToggle):
    // that fires as soon as deferred scripts finish their own top-level
    // code, but loadSettings() itself sits behind an earlier `await` in
    // ui-initialization.js's async main(), so it isn't guaranteed to have
    // run yet — confirmed live, this produced a page permanently stuck
    // showing the manga container with empty rows, because the loaders
    // above had (correctly, by then) already seen homeMode:'anime' and
    // skipped populating it, while the visible container had been synced
    // moments earlier from the stale in-memory default of 'manga'.
    const resolvedHomeMode = state.settings.homeMode === 'anime' ? 'anime' : 'manga';
    const mangaContentEl = $('discoverMangaContent');
    const animeContentEl = $('discoverAnimeContent');
    if (mangaContentEl) mangaContentEl.classList.toggle('hidden', resolvedHomeMode === 'anime');
    if (animeContentEl) animeContentEl.classList.toggle('hidden', resolvedHomeMode !== 'anime');
    const homeModeBtn = $('homeModeToggleBtn');
    if (homeModeBtn) {
      homeModeBtn.textContent = resolvedHomeMode === 'anime' ? 'Manga' : 'Anime';
      homeModeBtn.title = resolvedHomeMode === 'anime' ? 'Switch home page to Manga' : 'Switch home page to Anime';
    }
    // The manga loaders above already correctly no-op'd if we're actually
    // in anime mode (see their own homeMode guards) — this is what
    // actually populates the page in that case.
    if (resolvedHomeMode === 'anime' && typeof refreshAnimeHome === 'function') refreshAnimeHome();
  } catch (e) {
    dbg.error(dbg.ERR_STATE, 'Failed to load state', e);
  }
}

// The sources a user can pick a *new* source from: every installed one that is not disabled. (There used to be a "Show beta sources" switch that
// hid the sources flagged meta.beta; it is gone, and a beta flag no longer hides anything.)
function getSelectableSources() {
  const all = Object.values(state.installedSources || {});
  const disabled = new Set(state.settings?.disabledSourceIds || []);
  return disabled.size ? all.filter(s => !disabled.has(s.id)) : all;
}
function getSelectableSourceIds() {
  return getSelectableSources().map(s => s.id);
}
window.getSelectableSources = getSelectableSources;
window.getSelectableSourceIds = getSelectableSourceIds;

function renderSourceSelect() {
  const selectors = [$("sourceSelect"), $("advancedSourceSelect")];
  const installed = getSelectableSources();

  for (const sel of selectors) {
    if (!sel) continue;
    sel.innerHTML = "";
    if (installed.length === 0) {
      sel.innerHTML = `<option value="">(Install a source first)</option>`;
      continue;
    }
    for (const s of installed) {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      sel.appendChild(opt);
    }
    if (!state.currentSourceId || !installed.some(s => s.id === state.currentSourceId)) {
      state.currentSourceId = installed[0].id;
    }
    sel.value = state.currentSourceId;
    sel.onchange = () => { 
      state.currentSourceId = sel.value;
      state._advAcc = null; // invalidate filter accumulator on source change
      if (typeof updateAdvancedSearchFilterVisibility === 'function') {
        updateAdvancedSearchFilterVisibility(sel.value);
      }
      // Keep both selectors in sync
      for (const other of selectors) { if (other && other !== sel) other.value = sel.value; }
      if (state.currentView !== 'advanced-search') {
        // Reload homepage content when source changes
        if (window._homeSeenManga) window._homeSeenManga.clear();
        loadPopularToday();
        loadRecentlyAdded();
        loadLatestUpdates();
      }
      // In advanced-search: user changes source manually and clicks search themselves
    };
  }

  if (typeof updateAdvancedSearchFilterVisibility === 'function') {
    updateAdvancedSearchFilterVisibility(state.currentSourceId);
  }
}

