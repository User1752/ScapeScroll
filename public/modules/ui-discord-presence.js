// ============================================================================
// DISCORD RICH PRESENCE — frontend hooks
// ============================================================================
// This module never talks to Discord directly — it can't; a browser tab has
// no access to the local named-pipe/socket Discord's RPC listens on. It only
// talks to ScrollScape's own server (/api/discord-presence/*), which owns
// the actual RPC connection — see server/modules/discord-rpc/service.js's
// top comment for the full reasoning. Every call here is fire-and-forget:
// the server no-ops cleanly whenever the feature is off, unconfigured, or
// Discord isn't running, so there's nothing for the frontend to branch on
// beyond "don't let a failed fetch surface anywhere".
//
// ALWAYS ACTIVE, ONE STATUS PER "ABA": unlike the first version of this
// feature (which only reported anything while a chapter/episode was open,
// and fully cleared the rest of the time), presence now reflects whatever
// section of the app is on screen — Library, Advanced Search (mode-aware:
// "Searching Manga" vs "Searching Anime"), Analytics, etc. — same as any
// other Discord Rich Presence integration that's always showing *something*.
// The specific "Reading X"/"Watching X" states (with real cover art and the
// manga_icon/anime_icon badge) are just a more specific case of the same
// mechanism, reported directly from the reader/player open points below and
// overriding whatever generic view-label was showing, until that reading/
// watching session ends and the underlying view's label takes back over.
//
// Call sites:
//   - Any view change: setView() (ui-view-management.js) via
//     discordReportForView(), which resolves DISCORD_VIEW_LABELS below.
//   - manga (paged/webtoon/3D-flip reader): showReader()/hideReader() in
//     ui-reader-page-rendering.js
//   - manga (EPUB): openEpubReader()/closeEpubReader() in ui-epub-reader.js
//   - anime: _animeTestPlayEpisode() in ui-anime-test.js (report only — an
//     episode switch within the same show updates the presence, it doesn't
//     flicker it off/on)

let _discordPresenceHeartbeatTimer = null;
const DISCORD_PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;

// The last real (non-"Sleeping") report — lets discordPresenceWake() resume
// exactly what was showing before sleep (e.g. "Reading X / Chapter 12")
// instead of falling back to a generic view label, which would be a
// downgrade if the user was mid-chapter when they tabbed away.
let _lastDiscordReport = null;
let _discordIsSleeping = false;

function _discordPresencePost(path, body) {
  fetch(`/api/discord-presence/${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => {});
}

function _discordPresenceStartHeartbeat() {
  if (_discordPresenceHeartbeatTimer) return;
  // Tells the server "still here" every 30s — see service.js's idle
  // watchdog. There's no reliable server-side "the tab closed" signal (a
  // crashed tab, a force-quit browser, or the user's machine sleeping all
  // skip any frontend cleanup path), so the server clears the presence
  // itself if this stops arriving instead of trusting it to persist
  // forever. Started on the very first report and left running for the
  // rest of the session — "always active" means there's always something
  // to keep alive, unlike the old start/stop-per-reading-session model.
  _discordPresenceHeartbeatTimer = setInterval(() => {
    _discordPresencePost("heartbeat");
  }, DISCORD_PRESENCE_HEARTBEAT_INTERVAL_MS);
}

/**
 * Report the app's current status. `details` is the exact first line of
 * text Discord shows (the caller decides the wording — "Reading X",
 * "Searching Manga", etc.), not synthesized server-side.
 * @param {{details:string, subtitle?:string, cover?:string, iconKind?:'manga'|'anime', largeText?:string}} info
 */
function discordPresenceReport(info) {
  const details = info && info.details;
  if (!details) return;
  // Sleeping is reported through this same function (see
  // discordPresenceEnterSleep below) but must never become the thing wake()
  // resumes into — only remember genuine app-state reports.
  if (!_discordIsSleeping) _lastDiscordReport = info;
  _discordPresencePost("update", {
    details,
    subtitle: (info && info.subtitle) || "",
    cover: (info && info.cover) || "",
    iconKind: (info && info.iconKind) || null,
    largeText: (info && info.largeText) || "",
  });
  _discordPresenceStartHeartbeat();
}

/**
 * Reports "Reading {manga} / {chapter}" (with cover art) the same way the
 * reader/EPUB open points always have — UNLESS incognito reading
 * (state.incognitoReading, ui-reader-page-rendering.js) is on, in which case
 * it falls back to the current view's generic label instead. Discord
 * presence is the most *public* trace of all the things incognito mode
 * suppresses (history, analytics, AniList sync) — it's live, visible to
 * anyone who can see the user's Discord status, with the real cover art and
 * title — so it has to respect the same flag, not just the local/server
 * bookkeeping. Used by both reader open points (showReader(), EPUB's
 * openEpubReader()) and by toggleIncognitoReading() itself, so flipping the
 * toggle mid-chapter updates Discord immediately instead of waiting for the
 * next chapter switch.
 */
function discordReportReadingState(chapterLabel) {
  if (typeof state !== 'undefined' && state.incognitoReading) {
    if (typeof navigationManager !== 'undefined') discordReportForView(navigationManager.currentView);
    return;
  }
  discordPresenceReport({
    details: `Reading ${state.currentManga?.title || ''}`,
    subtitle: chapterLabel || '',
    cover: state.currentManga?.cover || '',
    iconKind: 'manga',
    largeText: state.currentManga?.title || '',
  });
}

/**
 * Switches the presence to "Sleeping" — called by ui-activity-tracker.js
 * once the tab has been unfocused long enough. Idempotent (a second call
 * while already sleeping is a no-op) so the activity tracker doesn't need
 * to track this module's own state.
 */
function discordPresenceEnterSleep() {
  if (_discordIsSleeping) return;
  _discordIsSleeping = true;
  _discordPresencePost("update", { details: "Sleeping", subtitle: "", cover: "", iconKind: null, largeText: "" });
  _discordPresenceStartHeartbeat();
}

/**
 * Resumes whatever was showing before discordPresenceEnterSleep() — the
 * exact last real report if there was one (so a chapter/episode in
 * progress reappears with its own text/cover, not a generic view label),
 * otherwise falls back to the current view's own label.
 */
function discordPresenceWake() {
  if (!_discordIsSleeping) return;
  _discordIsSleeping = false;
  if (_lastDiscordReport) {
    discordPresenceReport(_lastDiscordReport);
  } else if (typeof discordReportForView === 'function' && typeof navigationManager !== 'undefined') {
    discordReportForView(navigationManager.currentView);
  }
}

// One label per top-level "aba" (ALL_VIEWS in ui-view-management.js) — kept
// as simple functions rather than static strings since several views are
// mode-aware (manga vs anime), reusing the same state.settings.*Mode flags
// each view's own UI already switches on (homeMode, libraryMode, etc.), so
// this never needs its own separate manga/anime tracking.
const DISCORD_VIEW_LABELS = {
  discover: () => `Browsing ${state.settings.homeMode === 'anime' ? 'Anime' : 'Manga'}`,
  library: () => `In ${state.settings.libraryMode === 'anime' ? 'Anime' : 'Manga'} Library`,
  "manga-details": () => "Viewing a manga's details",
  "anime-details": () => "Viewing an anime's details",
  "advanced-search": () => `Searching ${state.settings.advancedSearchMode === 'anime' ? 'Anime' : 'Manga'}`,
  analytics: () => "Viewing Analytics",
  history: () => `Browsing ${state.settings.historyMode === 'anime' ? 'Watch' : 'Reading'} History`,
  achievements: () => "Viewing Achievements",
  themes: () => "Customizing Themes",
  shop: () => "Browsing the Shop",
  customize: () => "Customizing Library",
  calendar: () => "Checking the Calendar",
  "system-health": () => "Checking System Health",
  updates: () => "Checking for Updates",
  seasons: () => "Browsing Seasonal Anime",
};

/**
 * Reports a generic "browsing this aba" status for the given view — the
 * baseline presence whenever nothing more specific (an actively open
 * chapter/episode) is overriding it. Called from setView() on every
 * navigation, and from the reader/EPUB close paths to fall back to
 * whatever view is left showing underneath once the reader closes.
 */
function discordReportForView(view) {
  const labelFn = DISCORD_VIEW_LABELS[view];
  discordPresenceReport({ details: labelFn ? labelFn() : "Using ScrollScape" });
}

window.discordPresenceReport = discordPresenceReport;
window.discordReportReadingState = discordReportReadingState;
window.discordReportForView = discordReportForView;
window.discordPresenceEnterSleep = discordPresenceEnterSleep;
window.discordPresenceWake = discordPresenceWake;
