'use strict';

const { repairSolverSettings } = require('../common/solver-settings');
const { parseDisabledSourceIds } = require('../sources/disabled-sources');
const { ensureLedger } = require('../analytics/ledger');

function normaliseStore(store) {
  if (!store || typeof store !== 'object') return;

  store.repos = Array.isArray(store.repos)
    ? store.repos.map(repo => ({ ...repo, kind: repo.kind || 'jsrepo', name: repo.name || repo.url }))
    : [];

  store.installedSources = store.installedSources || {};
  store.history = store.history || [];
  store.favorites = store.favorites || [];
  // Separate from `favorites` (which is manga-shaped throughout the app —
  // every rebuild of it goes through safeManga()'s fixed allow-list) rather
  // than mixed in with a mediaType flag: an anime entry's natural shape
  // (idMal, totalEpisodes, lastWatchedEpisode/lastPositionSeconds instead of
  // a chapter list) doesn't fit that allow-list, and stretching it would
  // ripple through every manga-card/library function that assumes one.
  // Unifying the two into one browsable list later is a UI-level concern
  // (render both, tag each 'manga'/'anime', filter/merge) — it doesn't need
  // them to share a physical array.
  store.animeFavorites = Array.isArray(store.animeFavorites) ? store.animeFavorites : [];
  // Same sidecar-dict pattern as coverOverrides above, keyed by idMal.
  store.animeCoverOverrides = (store.animeCoverOverrides && typeof store.animeCoverOverrides === 'object') ? store.animeCoverOverrides : {};
  // Mirrors manga's store.history: watch activity independent of
  // favoriting (see routes/anime.js's POST /api/anime/progress) — a show
  // watched without ever clicking "Add to My Anime" still shows up here,
  // same as reading a manga chapter without favoriting it already does.
  store.animeHistory = Array.isArray(store.animeHistory) ? store.animeHistory : [];
  // Keyed by idMal alone (simpler than manga's mangaTags, which needs
  // "mangaId:sourceId" since a manga favorite's identity includes its
  // source — an anime favorite's doesn't). Same reason as mangaTags: kept
  // outside the favorite record itself so it survives independently of
  // however that record gets rebuilt.
  store.animeTags = (store.animeTags && typeof store.animeTags === 'object') ? store.animeTags : {};
  // Mirrors store.readingStatus: a pure user-set flag, independent of
  // lastWatchedEpisode/totalEpisodes — see routes/anime.js's POST
  // /api/anime/status. _animeComputeStatus() (ui-anime-test.js) prefers
  // this when set, falling back to its episode-derived guess otherwise.
  store.animeWatchStatus = (store.animeWatchStatus && typeof store.animeWatchStatus === 'object') ? store.animeWatchStatus : {};
  store.readingStatus = store.readingStatus || {};
  // Bulk-download completions (server/modules/downloads/service.js), newest
  // first, capped there at DOWNLOAD_HISTORY_CAP — separate from the
  // in-memory bulkJobs map (which only lives for JOB_TTL after a job
  // finishes and resets on restart) so a "downloads made" view survives
  // both, the way store.history already does for manga read activity.
  store.downloadHistory = Array.isArray(store.downloadHistory) ? store.downloadHistory : [];
  store.reviews = store.reviews || {};
  
  store.settings = store.settings || {};
  store.settings.flaresolverrUrl = store.settings.flaresolverrUrl || '';
  // Routes FlareSolverr's own browser through a proxy (see fetch-utils.js's
  // getProxyConfig/executeFlareSolverr) — needed for sources whose
  // Cloudflare tier blocks by IP reputation rather than just checking for a
  // real browser (confirmed on miruro.js's /api/secure/pipe: FlareSolverr's
  // own real Chrome still got rejected with "IP is banned", not a solvable
  // challenge). Only affects that one resolution step, never the actual
  // video stream after — see miruro.js's header comment. Empty by default;
  // ScrollScape never routes through a proxy without one explicitly set.
  store.settings.proxyUrl = store.settings.proxyUrl || '';
  store.settings.proxyUsername = store.settings.proxyUsername || '';
  store.settings.proxyPassword = store.settings.proxyPassword || '';
  store.settings.comicVineApiKey = store.settings.comicVineApiKey || '';
  // Discord Rich Presence — server-authoritative (unlike most toggles, which
  // live client-side in localStorage) because the RPC connection is driven
  // from this Node process, not the browser tab; see server/modules/
  // discord-rpc/service.js's top comment for the full "why". Off by
  // default — this broadcasts reading/watching activity to Discord friends,
  // a real privacy-relevant behavior change that shouldn't turn on silently.
  store.settings.discordRichPresenceEnabled = !!store.settings.discordRichPresenceEnabled;
  store.settings.discordClientId = store.settings.discordClientId || '';
  // The FlareSolverr session pool (server/modules/network/solver-pool.js) runs in this
  // process, so its three settings are server-authoritative like Discord's. An import or a
  // hand edit that puts junk here (a pool of 1e9 browsers) is removed, so the default applies
  // instead of the junk reaching the pool. The defaults themselves are NOT written here: they are
  // applied when the settings are read (normalizeSolverSettings), so a default that changes later
  // reaches every library that never set the key, and a stored value is always a choice.
  // Any other key is left exactly as it is.
  repairSolverSettings(store.settings);
  // The sources the user switched off, as the browser last told the server (POST /api/settings). The
  // live probes of System Health skip them (sources/disabled-sources.js); a list that is not a list of
  // source ids is repaired here, so the probes never see junk.
  store.settings.disabledSourceIds = parseDisabledSourceIds(store.settings.disabledSourceIds);
  // mangaTags is a sidecar dict (mirrors coverOverrides): { "mangaId:sourceId": ["artist:oda", ...] }.
  // Kept separate from the favorite/local-manga object itself rather than a field
  // on it, since every place that rebuilds a favorite spreads it through
  // safeManga()'s fixed allow-list (server/modules/common/sanitize.js) and would
  // otherwise silently drop an unlisted field the next time that manga is
  // re-added, migrated, or resynced from AniList.
  store.mangaTags = (store.mangaTags && typeof store.mangaTags === 'object') ? store.mangaTags : {};
  // coverOverrides is the same sidecar-dict pattern as mangaTags above, same
  // reason it lives outside the favorite object — it was just never added
  // here, so every reader (content-service.js, local/service.js) has always
  // had to fall back to `|| {}` at the point of use instead of trusting it.
  store.coverOverrides = (store.coverOverrides && typeof store.coverOverrides === 'object') ? store.coverOverrides : {};
  // nsfwOverrides is the same sidecar-dict pattern as mangaTags/coverOverrides
  // above: { "mangaId:sourceId": true|false }. A tri-state manual override —
  // true/false is an explicit choice made via the library's "Add to
  // NSFW"/"Remove from NSFW" toggle (ui-library-context-menu.js), a missing
  // key means "never touched" — for isNsfwManga() (public/modules/utils.js)
  // to consult ahead of its own automatic check (genre/tag/title heuristic).
  // Explicit `false`
  // entries matter as much as `true` ones here: they're the only way to pull
  // a manga back OUT of NSFW when one of those automatic checks would
  // otherwise still flag it (a source with no usable genre metadata tagged
  // manually, or an entry the user wants visible regardless).
  store.nsfwOverrides = (store.nsfwOverrides && typeof store.nsfwOverrides === 'object') ? store.nsfwOverrides : {};
  // Keyed by sourceId: { mangaId, chapterId, coverBytes, pageBytes, sampledAt }
  // — the last known-good image sizes System Health's image-quality check
  // (server/modules/system-health/image-quality-health.js) compares each
  // run against, so a source silently switching to lower-quality images
  // keeps failing that check until quality actually recovers, rather than
  // just reporting "reachable" forever like every other health probe would.
  store.imageHealthBaseline = (store.imageHealthBaseline && typeof store.imageHealthBaseline === 'object') ? store.imageHealthBaseline : {};

  store.customLists = (Array.isArray(store.customLists) ? store.customLists : []).map(l => ({
    ...l,
    isDynamic: l.isDynamic === true,
    filterQuery: l.isDynamic === true && l.filterQuery && typeof l.filterQuery === 'object' ? l.filterQuery : null,
    mangaItems: Array.isArray(l.mangaItems) ? l.mangaItems : [],
    // Same category, shared across both media types (one "Currently
    // Watching" list can hold manga AND anime) rather than a parallel
    // category system — animeItems just tracks membership the same way
    // mangaItems does, keyed by idMal alone (no sourceId: unlike manga,
    // an anime favorite only ever has the one provider right now).
    animeItems: Array.isArray(l.animeItems) ? l.animeItems : [],
  }));
  store.achievements = Array.isArray(store.achievements) ? store.achievements : [];

  // Achievement Points wallet, purchased shop themes, and active theme —
  // previously localStorage-only, which meant clearing browser data (or
  // switching profile) silently wiped a user's AP/themes while the library
  // and history (already stored here) survived untouched. Consolidated
  // into the same server-side store so everything lives in one place.
  store.ap = store.ap && typeof store.ap === 'object' ? store.ap : {};
  store.ap.bonus = Number.isFinite(store.ap.bonus) ? store.ap.bonus : 0;
  store.ap.spent = Number.isFinite(store.ap.spent) ? store.ap.spent : 0;
  store.purchasedThemes = Array.isArray(store.purchasedThemes) ? store.purchasedThemes : ['default'];
  store.activeTheme = typeof store.activeTheme === 'string' && store.activeTheme ? store.activeTheme : 'default';

  // The undo record of "Reset AniList statuses from ScrollScape" (modules/anilist/restore-journal.js); null when there is none.
  store.anilistRestoreUndo = (store.anilistRestoreUndo && typeof store.anilistRestoreUndo === 'object') ? store.anilistRestoreUndo : null;
  store.anilistSync = store.anilistSync || {
    lastImportAt: null,
    importedCount: 0,
    overwriteCount: 0,
    skippedCount: 0,
    failedCount: 0,
  };

  store.analytics = store.analytics || {
    totalChaptersRead: 0,
    totalTimeSpent: 0,
    readingSessions: [],
    dailyStreak: 0,
    lastReadDate: null,
  };
  // totalEpisodesWatched/watchSessions are anime's counterparts to
  // totalChaptersRead/readingSessions above (see recordAnimeSession() in
  // server/modules/analytics/service.js) — kept as separate counters so
  // "chapters read" and "episodes watched" never get conflated, even
  // though both feed the SAME totalTimeSpent/dailyStreak/dailyChapterCounts
  // below: those three are genuinely medium-agnostic "did the user engage
  // with their library today" signals, so an anime-only user still builds
  // a real streak and heatmap instead of both silently requiring manga
  // activity to ever move.
  store.analytics.totalEpisodesWatched = Number.isFinite(store.analytics.totalEpisodesWatched) ? store.analytics.totalEpisodesWatched : 0;
  store.analytics.watchSessions = Array.isArray(store.analytics.watchSessions) ? store.analytics.watchSessions : [];

  // Reading/watching time split out from the merged totalTimeSpent above —
  // running lifetime totals (see analytics/service.js's recordSession/
  // recordAnimeSession), not derived from readingSessions/watchSessions,
  // since both of those are capped at 200 entries and would undercount for
  // an active library. totalTimeAfk is unrelated to either — it's tab
  // focus/visibility time, not reading/watching time (see
  // ui-activity-tracker.js and its recordAfkTime() server counterpart).
  store.analytics.totalTimeReading = Number.isFinite(store.analytics.totalTimeReading) ? store.analytics.totalTimeReading : 0;
  store.analytics.totalTimeWatching = Number.isFinite(store.analytics.totalTimeWatching) ? store.analytics.totalTimeWatching : 0;
  store.analytics.totalTimeAfk = Number.isFinite(store.analytics.totalTimeAfk) ? store.analytics.totalTimeAfk : 0;

  // dailyChapterCounts backs the reading-activity heatmap with per-day
  // totals that persist independently of readingSessions' 200-entry cap
  // (see analytics/service.js's recordSession) — added after
  // readingSessions already existed, so backfill it once from whatever
  // session history survived the cap instead of starting existing users
  // off with an empty chart.
  if (!store.analytics.dailyChapterCounts || typeof store.analytics.dailyChapterCounts !== 'object') {
    const counts = {};
    for (const s of (store.analytics.readingSessions || [])) {
      const d = new Date(s.date);
      if (isNaN(d)) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      counts[key] = (counts[key] || 0) + (Number(s.chaptersRead) || 1);
    }
    store.analytics.dailyChapterCounts = counts;
  }

  // What was read and watched per day and per title (analytics/ledger.js): seeded once from the sessions that survived the 200 cap,
  // so the history a year-in-review needs starts as far back as the sessions go and is kept from now on without a cap.
  ensureLedger(store.analytics);
}

module.exports = { normaliseStore };