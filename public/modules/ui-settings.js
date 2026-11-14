// ============================================================================
// SETTINGS MANAGEMENT
// ============================================================================

// Expose settings functions globally for non-module scripts
window.saveSettings = saveSettings;
window.loadSettings = loadSettings;
window.resetSettingsSection = resetSettingsSection;

// 2: AnimeParadise joined the default anime providers (a one-time upgrade of the old default, see
// sanitizeSettings). 3: AnimePahe left them (same kind of upgrade). The number is what makes each upgrade run
// once instead of on every load.
const SETTINGS_VERSION = 3;

const DEFAULT_SETTINGS = {
  _version: SETTINGS_VERSION,
  language: "en",
  readingMode: "ltr",
  libraryDefaultStatusFilter: "all",
  libraryBookshelf3d: false,
  bookshelfStripeUseSourceColor: false,
  skipReadChapters: false,
  skipDuplicates: true,
  panWideImages: false,
  lineSharpness: 0,
  hideNsfw: typeof window !== "undefined" && !!window.SCROLLSCAPE_EDITION && window.SCROLLSCAPE_EDITION.hideNsfwDefault === true, // the edition without sources starts with it on (edition.js)
  showHomeSearch: true,
  homeMode: 'manga',
  historyMode: 'manga',
  calendarMode: 'manga',
  libraryMode: 'manga',
  advancedSearchMode: 'manga',
  homeSourceMode: 'all',
  homeSelectedSourceIds: [],
  showLibrarySourceBadge: true,
  showChaptersLeft: false,
  statusBadgeLocation: 'cover',
  anilistAutoSync: true,
  anilistShowTrackerOnAdd: true,
  anilistAutoImportOnConnect: false,
  anilistAutoCategorize: true,
  anilistImportCategoryId: '',
  anilistKeepCover: false,
  autoWebtoonDetect: true,
  pageFlipAnimation: true,
  displayMode: 'detailed',
  showCompactInfo: false,
  hideLibraryStatusAndChapters: false,
  mangasPerRow: 6,
  overlays: { downloaded: true, unread: true, local: true },
  showBookSpine: true,
  readerBackground: 'black',
  webtoonTurnButtonsEnabled: true,
  webtoonTurnButtonPlacement: 'corners',
  autoLoadNextChapter: false,
  readerNoiseEnabled: false,
  readerNoiseIntensity: 50,
  readerNoiseSource: 'generated',
  readerNoiseGifFile: '',
  autoScrollPointSpeeds: [0.2, 0.5, 1.0, 2.0, 3.5],
  genreBlacklist: [],
  disabledSourceIds: [],
  // Mirrors state.js's inline default — sanitizeSettings()'s deepMerge()
  // below drops any saved key that isn't already present on THIS object
  // ("Drop orphan keys"), so a default only added to state.js's own
  // settings object (not here) silently gets wiped back out by
  // loadSettings() on every reload, even though it was saved correctly.
  // Confirmed live: mangaTitleLanguage worked for the rest of the same
  // session but reverted to undefined after a refresh until this was added.
  mangaTitleLanguage: 'original',
  // Matches ui-anime-test.js's DEFAULT_VISIBLE_ANIME_PROVIDERS — zokoanime is
  // deliberately excluded (see that constant's own TODO(security) comment:
  // it resolves through a rotating pool of third-party CDNs, one confirmed
  // flagged as malicious by a real threat-detection tool). This default and
  // sanitizeSettings()'s fallback below run BEFORE ui-anime-test.js's own
  // fallback ever gets a chance to apply — leaving this array here as
  // ['zokoanime', 'animepahe'] silently defeated that fix for every new
  // install and every existing user who never touched this setting, since
  // it's never actually empty by the time the "safe" fallback checks it.
  // AnimeParadise was added on 2026-10-26 (the order is the fallback order): the app only talks to its own two
  // hosts, api./stream.animeparadise.moe, and it needs no hidden browser; see the comment on
  // DEFAULT_VISIBLE_ANIME_PROVIDERS in ui-anime-test.js. AnimePahe was taken out again the next day: its video
  // host (Kwik) refuses the connection on at least one real network (the title resolves, the video never opens),
  // and it needs the hidden browser and takes a minute to fail. It stays one tick away in Settings > Anime Sources.
  visibleAnimeProviders: ['anizone', 'animeparadise']
};

function deepMerge(target, source) {
  for (const key in source) {
    if (!target.hasOwnProperty(key)) continue; // Drop orphan keys

    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object'
    ) {
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

function sanitizeSettings(rawSettings) {
  const sanitized = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!rawSettings || typeof rawSettings !== 'object') return sanitized;

  const savedVersion = Number(rawSettings._version) || 0;
  deepMerge(sanitized, rawSettings);
  
  // Migration & Validation Rules
  if (sanitized.displayMode === 'comfortable') sanitized.displayMode = 'detailed';
  if (typeof sanitized.showCompactInfo !== 'boolean') sanitized.showCompactInfo = false;
  if (typeof sanitized.hideLibraryStatusAndChapters !== 'boolean') sanitized.hideLibraryStatusAndChapters = false;
  if (typeof sanitized.mangasPerRow !== 'number' || sanitized.mangasPerRow < 3 || sanitized.mangasPerRow > 14) {
    sanitized.mangasPerRow = 6;
  }
  if (typeof sanitized.showHomeSearch !== 'boolean') sanitized.showHomeSearch = true;
  if (sanitized.homeMode !== 'anime') sanitized.homeMode = 'manga';
  if (sanitized.historyMode !== 'anime') sanitized.historyMode = 'manga';
  if (sanitized.calendarMode !== 'anime') sanitized.calendarMode = 'manga';
  if (sanitized.libraryMode !== 'anime') sanitized.libraryMode = 'manga';
  if (sanitized.advancedSearchMode !== 'anime') sanitized.advancedSearchMode = 'manga';
  if (sanitized.homeSourceMode !== 'selected') sanitized.homeSourceMode = 'all';
  if (!Array.isArray(sanitized.homeSelectedSourceIds)) sanitized.homeSelectedSourceIds = [];
  if (typeof sanitized.bookshelfStripeUseSourceColor !== 'boolean') sanitized.bookshelfStripeUseSourceColor = false;
  if (!Array.isArray(sanitized.disabledSourceIds)) sanitized.disabledSourceIds = [];
  if (!Array.isArray(sanitized.visibleAnimeProviders) || sanitized.visibleAnimeProviders.length === 0) {
    sanitized.visibleAnimeProviders = [...DEFAULT_SETTINGS.visibleAnimeProviders];
  } else if (sanitized.visibleAnimeProviders.length === 2
    && sanitized.visibleAnimeProviders.includes('zokoanime')
    && sanitized.visibleAnimeProviders.includes('animepahe')) {
    // One-time migration for installs that already got auto-seeded by this
    // exact fallback before the fix above existed — a non-empty array means
    // the empty-array branch never re-runs, so those installs would
    // otherwise stay stuck with the flagged source visible forever. Matched
    // narrowly (this precise 2-element set) specifically so it can't ever
    // fire on a genuinely deliberate re-enable via Settings > Anime Sources
    // — a manual toggle adds to whatever's already there, which after this
    // fix ships starts from ['anizone', 'animepahe'], so a real user choice
    // produces a 3-element array (or a different pair), never this one.
    sanitized.visibleAnimeProviders = [...DEFAULT_SETTINGS.visibleAnimeProviders];
  } else if (savedVersion < 2
    && sanitized.visibleAnimeProviders.length === 2
    && sanitized.visibleAnimeProviders.includes('anizone')
    && sanitized.visibleAnimeProviders.includes('animepahe')) {
    // One-time upgrade (settings version 2): this exact pair was the default until AnimeParadise joined it, so an
    // install that still holds it never chose it. It is tied to the version, not just matched, because this pair
    // CAN be a deliberate choice (untick AnimeParadise in Settings > Anime Sources): that choice is saved at the
    // new version and is left alone from then on.
    sanitized.visibleAnimeProviders = [...DEFAULT_SETTINGS.visibleAnimeProviders];
  } else if (savedVersion < 3
    && sanitized.visibleAnimeProviders.length === 3
    && ['anizone', 'animeparadise', 'animepahe'].every((id) => sanitized.visibleAnimeProviders.includes(id))) {
    // One-time upgrade (settings version 3): these three were the default until AnimePahe was taken out, so an
    // install that still holds exactly them (in any order: the checkboxes used to save in their own order) never
    // chose them. Tied to the version for the same reason as above: ticking AnimePahe again later is saved at
    // the new version and is left alone. A user who had deliberately kept all three before this upgrade is
    // indistinguishable from the default and is moved once too; one tick brings it back.
    sanitized.visibleAnimeProviders = [...DEFAULT_SETTINGS.visibleAnimeProviders];
  }

  const speedDefaults = DEFAULT_SETTINGS.autoScrollPointSpeeds;
  const savedSpeeds = Array.isArray(sanitized.autoScrollPointSpeeds) ? sanitized.autoScrollPointSpeeds : speedDefaults;
  sanitized.autoScrollPointSpeeds = speedDefaults.map((fallback, idx) => {
    const n = Number(savedSpeeds[idx]);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(12, Math.max(0.05, n));
  });

  sanitized._version = SETTINGS_VERSION;
  return sanitized;
}

function resetSettingsSection(keys) {
  if (!Array.isArray(keys)) keys = [keys];
  keys.forEach(key => {
    if (DEFAULT_SETTINGS[key] !== undefined) {
      // Create deep copy of default value to avoid reference issues
      state.settings[key] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS[key]));
    }
  });
  saveSettings();
  // The server keeps its own copy of the Disabled sources list (System Health skips those sources) and
  // start-up only ever adds to it, so a reset has to tell it too (ui-disabled-sources-sync.js).
  if (keys.includes('disabledSourceIds') && typeof pushDisabledSourcesToServer === 'function') {
    pushDisabledSourcesToServer(state.settings.disabledSourceIds);
  }
}

function loadSettings() {
  try {
    const saved = localStorage.getItem("scrollscapeSettings");
    if (saved) {
      state.settings = sanitizeSettings(JSON.parse(saved));
    } else {
      state.settings = sanitizeSettings(state.settings);
    }

    const readChaps = localStorage.getItem("scrollscapeReadChapters");
    if (readChaps) state.readChapters = new Set(JSON.parse(readChaps));

    const flaggedChaps = localStorage.getItem("scrollscapeFlaggedChapters");
    if (flaggedChaps) state.flaggedChapters = new Set(JSON.parse(flaggedChaps));

    const progress = localStorage.getItem("scrollscapeReadingProgress");
    if (progress) {
      const p = JSON.parse(progress);
      state.lastReadPages = p.pages || {};
      state.lastReadChapter = p.chapters || {};
      state.highestReadChapter = p.highestChapter || {};
      state.lastReadPageTotals = p.pageTotals || {};
    } else {
      state.lastReadPages = {};
      state.lastReadChapter = {};
      state.highestReadChapter = {};
      state.lastReadPageTotals = {};
    }
    const chCounts = localStorage.getItem("scrollscapeChapterCounts");
    if (chCounts) state.chapterCountCache = JSON.parse(chCounts);
  } catch (e) {
    dbg.warn(dbg.ERR_SETTINGS, 'Failed to load settings', e);
    state.lastReadPages = {};
    state.lastReadChapter = {};
    state.highestReadChapter = {};
    state.lastReadPageTotals = {};
  }
}

function saveSettings() {
  localStorage.setItem("scrollscapeSettings", JSON.stringify(state.settings));
  localStorage.setItem("scrollscapeChapterCounts", JSON.stringify(state.chapterCountCache));
  localStorage.setItem("scrollscapeReadChapters", JSON.stringify([...state.readChapters]));
  localStorage.setItem("scrollscapeFlaggedChapters", JSON.stringify([...state.flaggedChapters]));
  localStorage.setItem("scrollscapeReadingProgress", JSON.stringify({
    pages: state.lastReadPages,
    chapters: state.lastReadChapter,
    highestChapter: state.highestReadChapter,
    pageTotals: state.lastReadPageTotals
  }));
  // The progress is kept on the server too (progress-sync.js): this is the one place every change to it passes through.
  if (typeof progressSyncMarkDirty === 'function') progressSyncMarkDirty();
}

// Manually marking a chapter read (chapter-list context menu) skips the
// reader entirely, so unlike actually opening the chapter (loadChapter, see
// ui-add-to-list-modal.js), nothing else bumps highestReadChapter or tells a
// connected AniList tracker — without this, "Mark as Read" would silently
// desync progress from AniList. Only acts when the chapter belongs to the
// manga currently open (state.currentManga) — that's the only case with a
// title/sourceId to sync with, and the only case any caller of this hits in
// practice (the chapter list shown is always for the open manga).
function _syncProgressForManuallyReadChapter(mangaId, chapter) {
  if (!chapter || String(mangaId || '') !== String(state.currentManga?.id || '')) return;
  const chapterNum = typeof _parseChapterNumber === 'function' ? _parseChapterNumber(chapter) : null;
  if (!chapterNum || chapterNum <= 0) return;

  if (!state.highestReadChapter) state.highestReadChapter = {};
  state.highestReadChapter[mangaId] = Math.max(state.highestReadChapter[mangaId] || 0, chapterNum);

  const mangaTitle = String(state.currentManga?.title || '').trim();
  if (!mangaTitle || typeof anilistSyncProgress !== 'function') return;
  // The person marked this by hand and expects AniList to follow: say when it did not (a failure used to be swallowed, and the tracker kept the old number).
  // An off auto-sync or a missing login stays quiet: that is a choice, not a failure.
  anilistSyncProgress(mangaTitle, chapterNum, { mangaId, sourceId: state.currentSourceId }).then((res) => {
    if (!res || typeof showToast !== 'function') return;
    if (res.error) showToast('AniList', "Couldn't update AniList (" + ((res.error && res.error.message) || 'no answer') + '). It is kept and sent again the next time the app starts.', 'warning');
    else if (res.skipped && res.reason === 'missing-media-id') showToast('AniList', "Couldn't find this title on AniList, so its progress was not sent.", 'warning');
    else if (res.ok && res.localProgress > res.remoteProgress) showToast('AniList', 'Progress set to chapter ' + res.localProgress + '.', 'success');
  }).catch(() => {});
}

function markChapterAsRead(mangaId, chapterId) {
  state.readChapters.add(`${mangaId}:${chapterId}`);
  const chapter = (state.allChapters || []).find(ch => String(ch?.id) === String(chapterId));
  _syncProgressForManuallyReadChapter(mangaId, chapter);
  saveSettings();
}

function unmarkChapterAsRead(mangaId, chapterId) {
  state.readChapters.delete(`${mangaId}:${chapterId}`);
  saveSettings();
}

function isChapterRead(mangaId, chapterId) {
  return state.readChapters.has(`${mangaId}:${chapterId}`);
}

function toggleFlagChapter(mangaId, chapterId) {
  const key = `${mangaId}:${chapterId}`;
  if (state.flaggedChapters.has(key)) state.flaggedChapters.delete(key);
  else state.flaggedChapters.add(key);
  saveSettings();
}

function showChapterContextMenu(e, chapterId, mangaId, options = {}) {
  document.querySelectorAll(".chapter-ctx-menu").forEach(m => m.remove());

  const chapterIds = Array.isArray(options.chapterIds) && options.chapterIds.length
    ? [...new Set(options.chapterIds.map(id => String(id)))]
    : [String(chapterId)];
  const isBulk = chapterIds.length > 1;
  const allFlagged = chapterIds.every(id => state.flaggedChapters.has(`${mangaId}:${id}`));
  const canSaveOffline = !!options.canSaveOffline;
  const chapterEntries = Array.isArray(options.chapterEntries) && options.chapterEntries.length
    ? options.chapterEntries
    : chapterIds.map(id => ({ id, name: `Chapter ${id}` }));

  const _afterAction = () => {
    if (typeof options.onAction === 'function') options.onAction();
    else loadChapters();
  };

  const menu = document.createElement("div");
  menu.className = "context-menu chapter-ctx-menu";
  menu.innerHTML = `
    <button class="context-item" id="ctxMarkRead">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
      ${isBulk ? 'Mark Selected as Read' : 'Mark as Read'}
    </button>
    <div class="context-divider"></div>
    <button class="context-item" id="ctxMarkUnread">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      ${isBulk ? 'Mark Selected as Unread' : 'Mark as Unread'}
    </button>
    <div class="context-divider"></div>
    <button class="context-item" id="ctxFlag">
      &#x1F6A9; ${allFlagged ? (isBulk ? 'Remove Flag from Selected' : 'Remove Flag') : (isBulk ? 'Add Flag to Selected' : 'Add Flag')}
    </button>
    ${canSaveOffline ? `<div class="context-divider"></div>
    <button class="context-item" id="ctxSaveOffline">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v14a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      ${isBulk ? 'Save Selected Offline' : 'Save Offline'}
    </button>` : ''}
  `;

  document.body.appendChild(menu);
  const { clientX: x, clientY: y } = e;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = (x + mw > window.innerWidth  ? window.innerWidth  - mw - 8 : x) + "px";
  menu.style.top  = (y + mh > window.innerHeight ? window.innerHeight - mh - 8 : y) + "px";

  menu.querySelector("#ctxMarkRead").onclick = () => {
    if (typeof options.markReadBackwards === 'function') {
      for (const id of chapterIds) options.markReadBackwards(id);
    } else {
      for (const id of chapterIds) markChapterAsRead(mangaId, id);
    }
    menu.remove();
    _afterAction();
  };

  menu.querySelector("#ctxMarkUnread").onclick = () => {
    for (const id of chapterIds) unmarkChapterAsRead(mangaId, id);
    menu.remove();
    _afterAction();
  };
  menu.querySelector("#ctxFlag").onclick = () => {
    for (const id of chapterIds) {
      const key = `${mangaId}:${id}`;
      if (allFlagged) state.flaggedChapters.delete(key);
      else state.flaggedChapters.add(key);
    }
    saveSettings();
    menu.remove();
    _afterAction();
  };

  const saveBtn = menu.querySelector("#ctxSaveOffline");
  if (saveBtn) {
    saveBtn.onclick = async () => {
      menu.remove();
      if (chapterEntries.length > 1) {
        await saveBulkOffline(chapterEntries.map(ch => ({ id: String(ch.id), name: String(ch.name || `Chapter ${ch.id}`) })));
      } else {
        const ch = chapterEntries[0];
        if (ch?.id) await saveChapterOffline(String(ch.id), String(ch.name || `Chapter ${ch.id}`));
      }
      _afterAction();
    };
  }

  const dismiss = (ev) => {
    if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("click", dismiss, true); }
  };
  setTimeout(() => document.addEventListener("click", dismiss, true), 0);
}

function updateReadingProgress(mangaId, chapterId, pageIndex) {
  if (!mangaId || !chapterId) return;
  if (state.incognitoReading) return; // no resume position saved while incognito
  const key = `${mangaId}:${chapterId}`;
  state.lastReadPages[key] = pageIndex;
  state.lastReadChapter[mangaId] = chapterId;
  const total = Number(state.currentChapter?.pages?.length || 0);
  if (Number.isFinite(total) && total > 0) state.lastReadPageTotals[key] = total;
  saveSettings();
}

