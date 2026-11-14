// ============================================================================
// VIEW MANAGEMENT
// ============================================================================

function setView(view, context = {}, replace = false) {
  // Captured before navigateTo() overwrites it — used below to hand the
  // shared #homeModeToggleBtn back to reflecting Home's mode when leaving a
  // view that was borrowing it (see ui-anime-discover.js's
  // _OTHER_MODE_TOGGLE_VIEWS) for one that doesn't have its own mode at all
  // (manga-details, settings, etc.) — those don't call an apply*Mode of
  // their own below to reclaim it.
  const _previousView = navigationManager.currentView;

  // Flush any open anime watch-session (streak/heatmap/AP analytics) before
  // leaving the anime-details page — _animeTestPlayEpisode already flushes
  // on switching episodes within the page, but the user can also just
  // navigate away entirely (sidebar link, back button) without ever
  // switching episodes, which needs this second flush point to not lose
  // that last session. See _animeTestFlushWatchSession's own comment.
  if (view !== "anime-details" && typeof _animeTestFlushWatchSession === 'function') {
    _animeTestFlushWatchSession();
  }
  // Discord Rich Presence: reports a generic status for whichever "aba" is
  // being entered — always active, not just while actively reading/
  // watching (see ui-discord-presence.js's DISCORD_VIEW_LABELS). Entering
  // anime-details itself just gets its own generic label here; the moment
  // the user actually presses play, _animeTestPlayEpisode's own report
  // (called after this, further down the same navigation) overrides it
  // with "Watching X" — no special-casing needed, whichever call happens
  // last simply wins.
  //
  // Exception: a manga/EPUB reader can stay open while something reloads
  // the details view underneath it in the background (e.g. router.js's
  // popstate handler re-running loadMangaDetails(), which calls setView()
  // once its fetch resolves — no guarantee that resolves before the reader
  // is already open and showing "Reading X"). Confirmed live: this stomped
  // an in-progress "Reading X / Chapter 114" report back down to the
  // generic "Viewing a manga's details" label, minutes into an actual
  // reading session. The reader takes presence precedence over whatever
  // view is loading underneath it until it actually closes (hideReader()/
  // closeEpubReader() call discordReportForView themselves at that point).
  const readerCurrentlyOpen = document.body.classList.contains('reader-open');
  if (typeof discordReportForView === 'function' && !readerCurrentlyOpen) {
    discordReportForView(view);
  }

  // Widens .main-container past its normal 1220px cap only for this one
  // view — its 3-column layout (info card / player / episode list, see
  // anime-watch.css) needs real room per column. Same reader-open/
  // cover-picker-open pattern used elsewhere for a page-scoped CSS hook.
  document.body.classList.toggle("anime-watch-open", view === "anime-details");

  // Update navigation manager
  navigationManager.navigateTo(view, context, replace);

  if (
    typeof _OTHER_MODE_TOGGLE_VIEWS !== 'undefined' &&
    _OTHER_MODE_TOGGLE_VIEWS.includes(_previousView) &&
    !_OTHER_MODE_TOGGLE_VIEWS.includes(view) &&
    typeof _syncSharedModeToggleToHome === 'function'
  ) {
    _syncSharedModeToggleToHome();
  }

  const ALL_VIEWS = ["discover", "library", "manga-details", "advanced-search", "analytics", "history", "achievements", "themes", "shop", "customize", "calendar", "system-health", "anime-details", "updates", "seasons"];
  for (const v of ALL_VIEWS) {
    const el = $(`view-${v}`);
    if (el) el.classList.toggle("hidden", v !== view);
  }

  // Sync sidebar active state
  document.querySelectorAll(".nav-link").forEach(link => {
    const linkView = link.dataset.view;
    link.classList.toggle("active", linkView === view);
  });

  // On-enter actions per view — both side panels get "active" whenever the
  // (now merged) library view is entered; each one's actual visibility
  // still cascades from its own content wrapper's hidden state (see
  // applyLibraryMode), so having both "active" simultaneously is harmless.
  const libSideActions = $("librarySideActions");
  if (libSideActions) libSideActions.classList.toggle("active", view === "library");
  const animeLibSideActions = $("animeLibrarySideActions");
  if (animeLibSideActions) animeLibSideActions.classList.toggle("active", view === "library");

  if (view === "library") {
    if (typeof applyLibraryMode === 'function') applyLibraryMode(state.settings.libraryMode, { persist: false });
    else renderLibrary();
  } else if (view === "advanced-search") {
    // Unlike library/history/calendar, neither side auto-searches on
    // entry (matches manga's existing behaviour — the user types/picks
    // filters and clicks Search themselves) — this only syncs which
    // content block and toggle label are showing.
    if (typeof applyAdvancedSearchMode === 'function') applyAdvancedSearchMode(state.settings.advancedSearchMode, { persist: false });
  } else if (view === "analytics") {
    renderAnalyticsView();
  } else if (view === "history") {
    if (typeof applyHistoryMode === 'function') applyHistoryMode(state.settings.historyMode, { persist: false });
    else renderHistoryView();
  } else if (view === "achievements") {
    renderAchievementsView();
  } else if (view === "themes") {
    renderThemesView();
  } else if (view === "shop") {
    renderShopView();
  } else if (view === "customize") {
    renderCustomizeView();
  } else if (view === "calendar") {
    if (typeof applyCalendarMode === 'function') applyCalendarMode(state.settings.calendarMode, { persist: false });
    else renderCalendarView();
  } else if (view === "system-health") {
    if (typeof renderSystemHealthPage === 'function') renderSystemHealthPage();
  } else if (view === "updates") {
    if (typeof renderUpdatesView === 'function') renderUpdatesView();
  } else if (view === "seasons") {
    if (typeof renderSeasonsView === 'function') renderSeasonsView();
  } else if (view === "anime-details") {
    window.scrollTo({ top: 0, behavior: "instant" });
    const ctx = navigationManager.getContext();
    if (ctx.show && typeof _animeTestSelectShow === 'function') {
      _animeTestSelectShow(ctx.show, ctx.resume);
    }
  } else if (view === "manga-details") {
    window.scrollTo({ top: 0, behavior: "instant" });
    // Restore context if available
    const ctx = navigationManager.getContext();
    if (ctx.mangaId && ctx.sourceId) {
      // Context is already set, renderMangaDetails will use it
    }
  }

  if (typeof syncUrlForView === 'function') syncUrlForView(view, navigationManager.getContext());
}

