// ============================================================================
// INITIALIZATION
// ============================================================================

(async function main() {
  await checkAuthGate();

  initTheme();
  applyTranslations();
  loadSettings();
  // The reading progress is kept on the server: take it (and send what this browser has that it lacks) while the rest starts.
  const progressSyncStarted = typeof progressSyncInit === 'function' ? progressSyncInit() : Promise.resolve();
  // Fire and forget: tells the server about sources this browser turned off that it does not know yet.
  if (typeof syncDisabledSourcesAtStart === 'function') syncDisabledSourcesAtStart();
  // The covers the server keeps for the library's titles (utils.js): asked for now so every page that draws a cover can use them.
  if (typeof loadLibraryCovers === 'function') loadLibraryCovers({ force: true });
  var activeCustom = getActiveCustom();
  var activeTheme = getActiveTheme();
  if (activeCustom && activeTheme !== 'default') {
    // Not setActiveTheme('default') here on purpose: this branch resets only
    // the base theme underneath an already-active custom overlay, and
    // setActiveTheme()'s own side effect is to clear that overlay — exactly
    // the state this is trying to preserve. Still needs the same server push
    // setActiveTheme() would have done, or the server-side record silently
    // drifts from what's actually active in this browser.
    localStorage.setItem('scrollscape_active_theme', 'default');
    _pushProgressionToServer({ activeTheme: 'default' });
    activeTheme = 'default';
  }
  applyTheme(activeTheme);
  applyCustomization(activeCustom);

  // Handle AniList OAuth redirect (token arrives in the URL hash after login)
  await anilistHandleCallback();

  // Load achievements from JSON
  try {
    await achievementManager.loadAchievements();
  } catch (err) {
    dbg.error(dbg.ERR_ACHIEVE, 'Failed to load achievements', err);
  }

  // Starts the tab focus/visibility tracking behind totalTimeAfk and
  // Discord's "Sleeping" state — no dependency on any of the network/theme
  // setup above, so it starts as early as possible rather than waiting on
  // refreshState() below.
  if (typeof initActivityTracker === 'function') initActivityTracker();

  // Wire up navigation and open the initial route *before* refreshState(),
  // which fans out network calls to every installed source (some, like a
  // Cloudflare-protected source under load, can take several seconds). Each
  // view already fetches/renders its own data independently, so there's no
  // need to make the whole app wait on refreshState() before nav works.
  bindUI();
  if (typeof routerRestoreInitialRoute === 'function') routerRestoreInitialRoute();

  // Initialize Feather icons for static HTML
  if (typeof feather !== 'undefined') {
    feather.replace();
  }

  await refreshState();

  // The AniList reconcile below starts from the progress the server has, but never waits long for it.
  await Promise.race([progressSyncStarted, new Promise((resolve) => setTimeout(resolve, 4000))]);

  // Reconcile chapter progress with AniList at startup in background: what was read HERE and AniList lacks is sent up (a higher
  // number on AniList is not copied down into the library: see _reconcileAniListProgress).
  anilistStartupReconcileProgress().catch((e) => {
    dbg.warn(dbg.ERR_ANILIST, 'Startup progress reconcile failed', e);
  });
  // Same reconciliation for anime — this used to not exist at all, which
  // was the actual bug behind anime progress never catching up to AniList
  // after a restart (see anilistStartupReconcileAnimeProgress's own
  // comment).
  anilistStartupReconcileAnimeProgress().catch((e) => {
    dbg.warn(dbg.ERR_ANILIST, 'Startup anime progress reconcile failed', e);
  });
  // Only when the user actually turned this on in a previous session —
  // resolveMangaTitleVariants() itself is a no-op for a library with
  // nothing stale/uncached, but there's no reason to even check when the
  // setting is 'original' and nothing will use the result.
  if (state.settings.mangaTitleLanguage && state.settings.mangaTitleLanguage !== 'original') {
    mangaTitleVariantsBackgroundResolve().catch((e) => {
      dbg.warn(dbg.ERR_ANILIST, 'Startup manga title variants resolve failed', e);
    });
  }

  // Check achievements on startup based on existing data
  await checkAndUnlockAchievements();
})();
