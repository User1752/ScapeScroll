// ============================================================================
// ADD TO LIST MODAL
// ============================================================================
// CHAPTERS MANAGEMENT
// ============================================================================

const _chapterPrefetchCache = new Map();
const _chapterPrefetchInFlight = new Set();

// Persisted chapter-list cache, keyed by "sourceId::mangaId" (same composite
// key shape used elsewhere for source-scoped manga identity, e.g.
// favoriteIdsBySource in loadSimilarManga). Unlike the "You might also
// like" cache this one is never trusted on its own — chapter counts/read
// state must stay correct, so a hit only paints the list instantly while
// loadChapters() still always fetches live in the background and repaints
// with the authoritative result. No TTL: staleness is bounded by "until
// the live fetch that always follows finishes", not by wall-clock time.
const CHAPTERS_CACHE_KEY = 'scrollscape_chapters_cache';
const CHAPTERS_CACHE_MAX_ENTRIES = 300;

function _chaptersCacheKey(sourceId, mangaId) {
  return `${sourceId}::${mangaId}`;
}

function _loadChaptersCacheEntry(key) {
  try {
    const all = JSON.parse(localStorage.getItem(CHAPTERS_CACHE_KEY) || '{}');
    const entry = all[key];
    if (!entry || !Array.isArray(entry.chapters) || !entry.chapters.length) return null;
    return entry.chapters;
  } catch (_) {
    return null;
  }
}

function _saveChaptersCacheEntry(key, chapters) {
  try {
    const all = JSON.parse(localStorage.getItem(CHAPTERS_CACHE_KEY) || '{}');
    all[key] = { chapters, cachedAt: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > CHAPTERS_CACHE_MAX_ENTRIES) {
      keys.sort((a, b) => (all[a].cachedAt || 0) - (all[b].cachedAt || 0));
      for (const k of keys.slice(0, keys.length - CHAPTERS_CACHE_MAX_ENTRIES)) delete all[k];
    }
    localStorage.setItem(CHAPTERS_CACHE_KEY, JSON.stringify(all));
  } catch (_) {
    // Quota exceeded or localStorage unavailable — chapters just refetch
    // live every time instead of persisting, never fatal.
  }
}

function _ensureChapterSelectionState() {
  if (!state._chapterSelection || state._chapterSelectionMangaId !== state.currentManga?.id) {
    state._chapterSelection = new Set();
    state._chapterSelectionMangaId = state.currentManga?.id || null;
    state._chapterSelectionAnchorId = null;
  }
}

function _chaptersOldestFirst(chapters) {
  const list = Array.isArray(chapters) ? chapters.filter(ch => ch?.id) : [];
  if (list.length <= 1) return list;

  const parseNum = (ch) => {
    const raw = String(ch?.chapter ?? ch?.name ?? '').trim();
    if (!raw) return null;
    const m = raw.match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  };

  const rows = list.map((c, i) => ({ c, i, n: parseNum(c) }));
  const numeric = rows.filter(r => r.n !== null).length;
  const mostlyNumeric = numeric >= Math.max(2, Math.floor(list.length * 0.5));

  if (mostlyNumeric) {
    return rows
      .sort((a, b) => (a.n - b.n) || (a.i - b.i))
      .map(r => r.c);
  }
  return list.reverse();
}

function _isNewestFirstByIndex(chapters) {
  const list = Array.isArray(chapters) ? chapters : [];
  if (list.length < 2) return true;

  const parseNum = (ch) => {
    const raw = String(ch?.chapter ?? ch?.name ?? '').trim();
    if (!raw) return null;
    const m = raw.match(/\d+(?:\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  };

  const firstNum = parseNum(list[0]);
  const lastNum = parseNum(list[list.length - 1]);
  if (firstNum !== null && lastNum !== null) {
    return firstNum >= lastNum;
  }
  // Most adapters return newest-first.
  return true;
}

function _markReadBackwardsToChapterIndex(mangaId, chapterIndex, chapterIdFallback = null) {
  const list = Array.isArray(state.allChapters) ? state.allChapters.filter(ch => ch?.id) : [];
  if (!list.length || !Number.isInteger(chapterIndex) || chapterIndex < 0 || chapterIndex >= list.length) {
    if (chapterIdFallback) markChapterAsRead(mangaId, chapterIdFallback);
    return;
  }

  const newestFirst = _isNewestFirstByIndex(list);
  if (newestFirst) {
    // Newest -> oldest: everything after current index is older.
    for (let i = chapterIndex; i < list.length; i++) {
      state.readChapters.add(`${mangaId}:${list[i].id}`);
    }
  } else {
    // Oldest -> newest: everything before current index is older.
    for (let i = 0; i <= chapterIndex; i++) {
      state.readChapters.add(`${mangaId}:${list[i].id}`);
    }
  }

  const curr = list[chapterIndex];
  if (curr?.id) state.lastReadChapter[mangaId] = curr.id;
  _syncProgressForManuallyReadChapter(mangaId, curr);
  saveSettings();
}

function _markReadBackwardsToChapterId(mangaId, chapterId) {
  const idx = (state.allChapters || []).findIndex(ch => String(ch?.id) === String(chapterId));
  if (idx >= 0) {
    _markReadBackwardsToChapterIndex(mangaId, idx, chapterId);
    return;
  }

  // Fallback for stale/partial chapter lists.
  const oldest = _chaptersOldestFirst(state.allChapters || []);
  if (!oldest.length || !chapterId) {
    markChapterAsRead(mangaId, chapterId);
    return;
  }
  const oldIdx = oldest.findIndex(ch => String(ch.id) === String(chapterId));
  if (oldIdx < 0) {
    markChapterAsRead(mangaId, chapterId);
    return;
  }
  for (let i = 0; i <= oldIdx; i++) state.readChapters.add(`${mangaId}:${oldest[i].id}`);
  state.lastReadChapter[mangaId] = chapterId;
  _syncProgressForManuallyReadChapter(mangaId, oldest[oldIdx]);
  saveSettings();
}

// Warms the actual image BYTES (not just the page-list JSON already cached
// above) for a chapter's first few pages — was previously only done for the
// RTL/LTR book-flip engine specifically (preloadBookPages/
// _preloadNextChapterLeadPages in ui-book-reader-rtl-double-page-spread-
// with-3d-page-flip.js, only ever called from that engine's own page-turn
// handlers), so Webtoon and plain single-page mode never got it — landing
// on a freshly-prefetched next chapter still had to wait on a fresh image
// fetch, the exact flash/flicker the book engine's version exists to avoid.
// Called for every mode uniformly right where the chapter's page list
// actually arrives, rather than reactively on a page-turn event only the
// book engine has.
function _warmChapterLeadImages(pages) {
  if (!Array.isArray(pages) || !pages.length) return;
  pages.slice(0, 3).forEach(p => {
    const src = p?.img ? (typeof normalizeImageUrl === 'function' ? normalizeImageUrl(p.img) : p.img) : null;
    if (!src) return;
    if (typeof _warmImage === 'function') {
      // Book-flip engine's own helper (new Image() + async decode) — reused
      // as-is rather than reimplemented, it has no book-mode-specific
      // behavior of its own beyond what its caller does in onReady, and
      // this caller does nothing there.
      _warmImage(src, () => {});
    } else {
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
    }
  });
}

function prefetchNextReaderChapters(ahead = 2) {
  const total = state.allChapters?.length || 0;
  if (!total || !state.currentSourceId) return;

  let idx = state.currentChapterIndex;
  for (let i = 0; i < ahead; i++) {
    idx = getNextChapterIndex(idx);
    if (idx < 0 || idx >= total) break;
    const ch = state.allChapters[idx];
    if (!ch?.id) continue;
    if (_chapterPrefetchCache.has(ch.id) || _chapterPrefetchInFlight.has(ch.id)) continue;

    _chapterPrefetchInFlight.add(ch.id);
    api(`/api/source/${state.currentSourceId}/pages`, {
      method: "POST",
      body: JSON.stringify({ chapterId: ch.id })
    }).then((result) => {
      if (result) {
        _chapterPrefetchCache.set(ch.id, result);
        // Only the immediately-next chapter's lead pages — that's what's
        // actually shown the instant the reader lands there (loadChapter
        // defaults to startPageIndex 0); warming pages 2 chapters ahead
        // spends bandwidth on images that might never be reached.
        if (i === 0) _warmChapterLeadImages(result.pages);
      }
    }).catch(() => {
      // Ignore prefetch errors; normal load path still works.
    }).finally(() => {
      _chapterPrefetchInFlight.delete(ch.id);
      while (_chapterPrefetchCache.size > 6) {
        const oldest = _chapterPrefetchCache.keys().next().value;
        _chapterPrefetchCache.delete(oldest);
      }
    });
  }
}

async function loadChapters() {
  if (!state.currentManga) return;
  const chapDiv = $("chapters");

  // A request can outlive the manga/source it was fired for (the user
  // navigates elsewhere while a slow source is still answering) — every
  // apply-the-result step below re-checks this instead of trusting the
  // closure's captured values, so a late response never clobbers whatever
  // is now on screen.
  const requestMangaId = state.currentManga.id;
  const requestSourceId = state.currentSourceId;
  const isStale = () => state.currentManga?.id !== requestMangaId || state.currentSourceId !== requestSourceId;

  const cacheKey = _chaptersCacheKey(requestSourceId, requestMangaId);
  const cached = _loadChaptersCacheEntry(cacheKey);

  if (cached) {
    // Instant paint from the last known-good chapter list — this is what
    // actually fixes "always shows Loading chapters..." for manga that
    // are already in the library. It's never trusted as final: the live
    // fetch below still always runs and repaints with the real result,
    // this only removes the blank/loading wait while that happens.
    state.allChapters = cached;
    state.chaptersReversed = false;
    renderChaptersList();
  } else {
    chapDiv.innerHTML = `<div class="muted">Loading chapters...</div>`;
  }

  try {
    const result = await api(`/api/source/${requestSourceId}/chapters`, {
      method: "POST",
      body: JSON.stringify({ mangaId: requestMangaId })
    });

    const offlineResult = await api(`/api/local/offline-chapters`, {
      method: "POST",
      body: JSON.stringify({ sourceId: requestSourceId, mangaId: requestMangaId })
    }).catch(() => ({ chapters: [] }));
    if (isStale()) return;

    state.offlineChapters = new Set(offlineResult.chapters || []);
    state.allChapters = result.chapters || [];
    _repairMangaChapterProgressIfNeeded(requestMangaId, state.allChapters);
    state.chapterCountCache[requestMangaId] = state.allChapters.length;
    saveSettings();
    state.chaptersReversed = false;
    renderChaptersList();
    if (state.allChapters.length) _saveChaptersCacheEntry(cacheKey, state.allChapters);
  } catch (e) {
    if (isStale()) return;

    // Already showing a usable (if slightly stale) cached list — a failed
    // live refresh isn't worth replacing working data with an error state.
    if (cached) return;

    const isLibraryOrHistory = (state.favorites || []).some(m => String(m.id) === String(requestMangaId) && String(m.sourceId) === String(requestSourceId))
                            || (state.history || []).some(m => String(m.id) === String(requestMangaId) && String(m.sourceId) === String(requestSourceId));
    if (isLibraryOrHistory) {
      try {
        const offlineResult = await api(`/api/local/offline-chapters`, {
          method: "POST",
          body: JSON.stringify({ sourceId: requestSourceId, mangaId: requestMangaId })
        });
        if (isStale()) return;
        state.offlineChapters = new Set(offlineResult.chapters || []);
        const syntheticResult = await api(`/api/source/${requestSourceId}/chapters`, {
          method: "POST",
          body: JSON.stringify({ mangaId: requestMangaId })
        }).catch(() => ({ chapters: [] }));
        if (isStale()) return;
        state.allChapters = syntheticResult.chapters || [];
      } catch (_) {
        if (isStale()) return;
        state.offlineChapters = new Set();
        state.allChapters = [];
      }
      state.chaptersReversed = false;
      renderChaptersList();
    } else {
      chapDiv.innerHTML = `<div class="muted">Error: ${e.message}</div>`;
    }
  }
}

function _repairMangaChapterProgressIfNeeded(mangaId, chapters) {
  try {
    const list = Array.isArray(chapters) ? chapters.filter(ch => ch?.id) : [];
    if (!mangaId || list.length === 0) return;

    const valid = new Set(list.map(ch => String(ch.id)));
    const readKeys = [...(state.readChapters || new Set())].filter(k => String(k).startsWith(`${mangaId}:`));
    const readIds = readKeys.map(k => String(k).slice(String(mangaId).length + 1));
    const validRead = readIds.filter(id => valid.has(String(id))).length;
    const invalidRead = readIds.length - validRead;

    const lastId = state.lastReadChapter?.[mangaId];
    const lastIsInvalid = !!lastId && !valid.has(String(lastId));
    if (!lastIsInvalid && invalidRead === 0) return;

    const parseNum = (ch) => {
      const raw = String(ch?.chapter ?? ch?.name ?? '').trim();
      const m = raw.match(/\d+(?:\.\d+)?/);
      if (!m) return null;
      const n = Number(m[0]);
      return Number.isFinite(n) ? n : null;
    };
    const rows = list.map((c, i) => ({ c, i, n: parseNum(c) }));
    const numeric = rows.filter(r => r.n !== null).length;
    const mostlyNumeric = numeric >= Math.max(2, Math.floor(rows.length * 0.5));
    const oldest = mostlyNumeric
      ? rows.sort((a, b) => (a.n - b.n) || (a.i - b.i)).map(r => r.c)
      : [...list].reverse();

    // How many chapters were read is how many were marked, nothing else. highestReadChapter is a chapter NUMBER (an AniList value, a
    // chapter 300 of a list that numbers 963 chapters), and it was used here as a COUNT: a manga whose chapter ids changed got its first
    // N chapters marked read for whatever that number was. Without a single chapter marked there is nothing to rebuild: only a last-read
    // id that no longer exists is dropped, and the number is left alone.
    if (readKeys.length === 0) {
      if (lastIsInvalid) delete state.lastReadChapter[mangaId];
      return;
    }
    const clamped = Math.max(0, Math.min(readKeys.length, oldest.length));

    for (const key of readKeys) state.readChapters.delete(key);
    for (let i = 0; i < clamped; i++) {
      state.readChapters.add(`${mangaId}:${oldest[i].id}`);
    }

    for (const k of Object.keys(state.lastReadPages || {})) {
      if (k.startsWith(`${mangaId}:`)) delete state.lastReadPages[k];
    }
    if (clamped > 0) {
      const lastMapped = oldest[clamped - 1];
      state.lastReadChapter[mangaId] = lastMapped.id;
      state.lastReadPages[`${mangaId}:${lastMapped.id}`] = 0;
    } else {
      delete state.lastReadChapter[mangaId];
    }
  } catch (_) {
    // Keep UI responsive; repair is best-effort.
  }
}

function normalizeChapterMetadata(chapter, index, fallbackLabel) {
  const ch = chapter || {};
  let title = String(ch.title || ch.name || ch.chapterTitle || ch.label || '').trim();
  let number = String(ch.number || ch.chapter || '').trim();
  
  if (!number && title && title.match(/chapter\s+(\d+(?:\.\d+)?)/i)) {
    number = title.match(/chapter\s+(\d+(?:\.\d+)?)/i)[1];
  }
  
  // Clean up title
  if (title.toLowerCase() === `chapter ${number}`.toLowerCase() || title === number || title === `ch. ${number}`) {
    title = '';
  }
  if (number && title.toLowerCase().startsWith(`chapter ${number} - `)) {
    title = title.substring(`chapter ${number} - `.length).trim();
  }
  if (number && title.toLowerCase().startsWith(`chapter ${number} — `)) {
    title = title.substring(`chapter ${number} — `.length).trim();
  }
  if (number && title.toLowerCase().startsWith(`chapter ${number}: `)) {
    title = title.substring(`chapter ${number}: `.length).trim();
  }
  // Some sources give every chapter a bare "Chapter N" raw title with no
  // real episode name — often using the source's OWN internal numbering,
  // which doesn't always match this app's own `number` (confirmed live: a
  // chapter this app numbered 930 had a raw title of just "Chapter 856",
  // the source's separate count) — so the exact-match cleanup above never
  // catches it. A title that's nothing but "Chapter" + a number carries no
  // more information than the number alone, regardless of which number it
  // is, so drop it the same as the exact-match case rather than showing
  // "Chapter 930 — Chapter 856", which reads as a meaningless duplicate
  // instead of the useful volume/episode-name supplement this format is
  // meant for (e.g. "Chapter 348 — Vol.29 Chapter 314: Deciding The Strongest").
  if (title && /^chapter\s+\d+(?:\.\d+)?$/i.test(title)) {
    title = '';
  }

  const numLabel = number ? `Chapter ${number}` : fallbackLabel;
  const displayTitle = title && title !== numLabel ? `${numLabel} — ${title}` : numLabel;

  // Dates
  let rawDate = ch.publishAt || ch.publishedAt || ch.releaseDate || ch.updatedAt || ch.date || ch.sourceUpdatedAt;
  let dateType = ch.publishAt || ch.publishedAt || ch.releaseDate ? 'published' : (ch.updatedAt || ch.date ? 'updated' : (ch.sourceUpdatedAt ? 'sourceUpdated' : null));
  
  let displayDateLabel = '';
  let displayDate = '';

  if (rawDate) {
    const d = new Date(rawDate);
    if (!isNaN(d.getTime())) {
      const opts = { day: "2-digit", month: "short", year: "numeric" };
      try {
        const lang = (typeof currentLanguage !== 'undefined' && currentLanguage === 'pt') ? 'pt-PT' : 'en-US';
        displayDate = new Intl.DateTimeFormat(lang, opts).format(d);
        if (dateType === 'published') displayDateLabel = typeof t === 'function' ? t('chapter.published') : 'Published';
        else if (dateType === 'updated') displayDateLabel = typeof t === 'function' ? t('chapter.updated') : 'Updated';
        else if (dateType === 'sourceUpdated') displayDateLabel = typeof t === 'function' ? t('chapter.sourceUpdated') : 'Source updated';
      } catch (e) {
        // Ignore parsing errors and omit date
      }
    }
  }

  return {
    number,
    title,
    displayTitle,
    displayDateLabel,
    displayDate,
    raw: ch
  };
}

function renderChaptersList() {
  if (!state.currentManga) return;
  const chapDiv = $("chapters");
  _ensureChapterSelectionState();

  let displayChapters = state.allChapters;
  if (state.settings.skipReadChapters) {
    displayChapters = state.allChapters.filter(ch => !isChapterRead(state.currentManga.id, ch.id));
  }
  if (state.chaptersReversed) {
    displayChapters = [...displayChapters].reverse();
  }

  if (!displayChapters.length) {
    chapDiv.innerHTML = `<div class="muted">${state.settings.skipReadChapters ? "All chapters read" : "No chapters found"}</div>`;
    return;
  }

  const reverseIcon = state.chaptersReversed
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`;

  chapDiv.innerHTML = `
    <div class="chapters-header">
      <strong>${displayChapters.length} Chapter${displayChapters.length !== 1 ? "s" : ""} ${state.settings.skipReadChapters ? "Unread" : "Available"}</strong>
      <div class="chapters-header-actions">
        <span class="chapter-selected-count" id="chapterSelectedCount">${state._chapterSelection.size} selected</span>
        <button class="btn-reverse-chapters ${state.chaptersReversed ? 'btn-reverse-active' : ''}" id="reverseChaptersBtn" title="${state.chaptersReversed ? 'Oldest first (reversed)' : 'Newest first (default)'}">
          ${reverseIcon}
          ${state.chaptersReversed ? "Oldest First" : "Newest First"}
        </button>
        <button class="btn-check-integrity" id="checkIntegrityBtn" title="Check Chapter Integrity">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          Check Integrity
        </button>
        ${state.currentSourceId !== 'local' ? `<button class="btn-check-integrity" id="refreshMangaBtn" title="Refresh this manga's chapters and info">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Refresh
        </button>` : ''}
        ${state.currentSourceId !== 'local' ? `<button class="btn-download-bulk" id="downloadBulkBtn" title="Save chapters for offline reading">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v14a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Save Offline
        </button>
        <button class="btn-delete-offline" id="deleteOfflineBtn" title="Delete offline chapters" style="display: none; background: var(--color-danger, #d32f2f); color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer; align-items: center; gap: 4px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          Delete Offline
        </button>` : ''}
      </div>
    </div>
    <div id="integrityReport"></div>
    <div class="chapters-list">
      ${displayChapters.map((ch, i) => {
        const lastReadId = String(state.lastReadChapter?.[state.currentManga.id] || '');
        const isRead    = isChapterRead(state.currentManga.id, ch.id);
        const realIndex = state.allChapters.findIndex(c => c.id === ch.id);
        const isFlagged = state.flaggedChapters.has(`${state.currentManga.id}:${ch.id}`);
        const isSelected = state._chapterSelection.has(String(ch.id));
        const isCurrentProgress = lastReadId && String(ch.id) === lastReadId;
        const isOffline = state.offlineChapters && state.offlineChapters.has(String(ch.id));
        const progressKey = `${state.currentManga.id}:${ch.id}`;
        const rawSavedPage = Number(state.lastReadPages?.[progressKey]);
        const savedPage = Number.isFinite(rawSavedPage) && rawSavedPage >= 0 ? (Math.floor(rawSavedPage) + 1) : 1;
        const totalPages = Number(state.lastReadPageTotals?.[progressKey] || 0);
        const fallbackLabel = `Chapter ${i + 1}`;
        const meta = normalizeChapterMetadata(ch, i, fallbackLabel);
        
        const progressLabel = totalPages > 0 ? `${savedPage}/${totalPages}` : String(savedPage);
        return `
          <div class="chapter-item ${isRead ? 'chapter-read' : ''} ${isFlagged ? 'chapter-flagged' : ''} ${isSelected ? 'chapter-selected' : ''} ${isCurrentProgress ? 'chapter-current-progress' : ''}" data-chapter-id="${escapeHtml(ch.id)}" data-chapter-index="${realIndex}" data-display-index="${i}" data-chapter-name="${escapeHtml(meta.displayTitle)}">
            <div class="chapter-info">
              <div class="chapter-name">
                ${isFlagged ? '<span class="chapter-flag-icon">&#x1F6A9;</span> ' : ''}
                ${isOffline ? '<img src="https://cdn-icons-png.flaticon.com/512/0/532.png" width="14" height="14" title="Downloaded for offline reading" style="margin-right: 4px; vertical-align: text-bottom; filter: invert(0.5) sepia(1) saturate(5) hue-rotate(var(--theme-hue-rotate, 0deg));" alt="offline" />' : ''}
                ${escapeHtml(meta.displayTitle)}
              </div>
              ${meta.displayDate ? `<div class="chapter-date">${escapeHtml(meta.displayDateLabel)}: ${escapeHtml(meta.displayDate)}</div>` : ""}
              ${isCurrentProgress ? `<div class="chapter-progress-page">${typeof tr === 'function' ? tr('reader.stoppedAtPage', 'Stopped at page') : 'Stopped at page'} ${progressLabel}</div>` : ""}
            </div>
            <div class="chapter-action">
              ${isRead ? `<span class="read-badge">&#x2713;</span>` : ""}
              ${state.currentSourceId !== 'local' ? `<button class="btn-save-offline" data-chapter-id="${escapeHtml(ch.id)}" data-chapter-name="${escapeHtml(ch.name || `Chapter ${ch.chapter || i + 1}`)}" title="Save for offline reading" onclick="event.stopPropagation();"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v14a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg></button>` : ''}
              <button class="btn-open-chapter" data-chapter-id="${escapeHtml(ch.id)}" data-chapter-index="${realIndex}" data-chapter-name="${escapeHtml(ch.name || `Chapter ${ch.chapter || i + 1}`)}" title="Open chapter" onclick="event.stopPropagation();">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
              </button>
            </div>
          </div>`;
      }).join("")}
    </div>`;

  const _updateSelectedCount = () => {
    const countEl = $("chapterSelectedCount");
    if (countEl) countEl.textContent = `${state._chapterSelection.size} selected`;

    const delBtn = $("deleteOfflineBtn");
    if (delBtn) {
      const hasOfflineSelected = Array.from(state._chapterSelection).some(id => state.offlineChapters && state.offlineChapters.has(id));
      delBtn.style.display = hasOfflineSelected ? "inline-flex" : "none";
    }
  };

  const _displayIndexById = new Map((displayChapters || []).map((ch, i) => [String(ch.id), i]));

  const _selectChapterRange = (fromId, toId) => {
    const from = _displayIndexById.get(String(fromId));
    const to = _displayIndexById.get(String(toId));
    if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let i = lo; i <= hi; i++) {
      const ch = displayChapters[i];
      if (ch?.id) state._chapterSelection.add(String(ch.id));
    }
    return true;
  };

  chapDiv.querySelectorAll(".chapter-item[data-chapter-id]").forEach(el => {
    el.onclick = (ev) => {
      const id = String(el.dataset.chapterId || '');
      if (!id) return;

      if (ev.shiftKey && state._chapterSelectionAnchorId) {
        _selectChapterRange(state._chapterSelectionAnchorId, id);
      } else if (ev.ctrlKey || ev.metaKey) {
        if (state._chapterSelection.has(id)) state._chapterSelection.delete(id);
        else state._chapterSelection.add(id);
        state._chapterSelectionAnchorId = id;
      } else {
        if (state._chapterSelection.has(id)) state._chapterSelection.delete(id);
        else state._chapterSelection.add(id);
        state._chapterSelectionAnchorId = id;
      }

      chapDiv.querySelectorAll('.chapter-item[data-chapter-id]').forEach(node => {
        const nodeId = String(node.dataset.chapterId || '');
        node.classList.toggle('chapter-selected', state._chapterSelection.has(nodeId));
      });
      _updateSelectedCount();
    };
    el.ondblclick = () => loadChapter(
      el.dataset.chapterId,
      el.dataset.chapterName,
      parseInt(el.dataset.chapterIndex),
      _chapterListStartPage(el.dataset.chapterId)
    );
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const clickedId = String(el.dataset.chapterId || '');
      if (!state._chapterSelection.has(clickedId)) {
        state._chapterSelection.clear();
        state._chapterSelection.add(clickedId);
        state._chapterSelectionAnchorId = clickedId;
        chapDiv.querySelectorAll('.chapter-item.chapter-selected').forEach(n => n.classList.remove('chapter-selected'));
        el.classList.add('chapter-selected');
      }
      _updateSelectedCount();

      const selectedIds = [...state._chapterSelection];
      const selectedEntries = (state.allChapters || [])
        .filter(ch => selectedIds.includes(String(ch.id)))
        .map(ch => ({ id: String(ch.id), name: ch.name || `Chapter ${ch.chapter || '?'}` }));

      showChapterContextMenu(e, clickedId, state.currentManga?.id, {
        chapterIds: selectedIds,
        chapterEntries: selectedEntries,
        canSaveOffline: state.currentSourceId !== 'local',
        markReadBackwards: (chapterId) => _markReadBackwardsToChapterId(state.currentManga.id, chapterId),
        onAction: () => {
          state._chapterSelection.clear();
          loadChapters();
        }
      });
    });
  });

  chapDiv.querySelectorAll(".btn-open-chapter").forEach(btn => {
    btn.onclick = () => loadChapter(
      btn.dataset.chapterId,
      btn.dataset.chapterName,
      parseInt(btn.dataset.chapterIndex),
      _chapterListStartPage(btn.dataset.chapterId)
    );
  });

  // Save individual chapters for offline reading
  chapDiv.querySelectorAll(".btn-save-offline").forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      await saveChapterOffline(btn.dataset.chapterId, btn.dataset.chapterName);
    };
  });

  // Reverse order button
  const reverseBtn = $("reverseChaptersBtn");
  if (reverseBtn) {
    reverseBtn.onclick = () => {
      state.chaptersReversed = !state.chaptersReversed;
      renderChaptersList();
    };
  }

  // Bulk download button
  const bulkBtn = $("downloadBulkBtn");
  if (bulkBtn) {
    bulkBtn.onclick = () => showBulkDownloadModal(displayChapters);
  }

  // Check integrity button
  const integrityBtn = $("checkIntegrityBtn");
  if (integrityBtn) {
    integrityBtn.onclick = () => checkChapterIntegrity(state.allChapters);
  }

  // Refresh button — re-fetches this manga's chapters/details in one go and
  // reports whether new chapters were found (see /api/library/refresh-item).
  const refreshBtn = $("refreshMangaBtn");
  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      const mangaId = state.currentManga?.id;
      const sourceId = state.currentSourceId;
      if (!mangaId || !sourceId) return;
      const prevHtml = refreshBtn.innerHTML;
      refreshBtn.disabled = true;
      refreshBtn.textContent = "Refreshing...";
      try {
        const result = await api("/api/library/refresh-item", {
          method: "POST",
          body: JSON.stringify({ mangaId, sourceId })
        });
        if (result.ok === false) {
          showToast("Refresh unavailable", result.error || "Source is temporarily unavailable — try again shortly.", "warning");
          refreshBtn.disabled = false;
          refreshBtn.innerHTML = prevHtml;
          return;
        } else if (result.isUpdate) {
          showToast("New chapters!", `${result.newChapters} new chapter${result.newChapters !== 1 ? "s" : ""} found.`, "success");
        } else {
          showToast("Refreshed", "No new chapters — you're up to date.", "info");
        }
        // Re-fetch chapters so the visible list reflects the refresh immediately.
        const cr = await api(`/api/source/${sourceId}/chapters`, {
          method: "POST",
          body: JSON.stringify({ mangaId })
        });
        // Two awaits above mean the user can navigate to a different
        // manga's details page before this resolves — same class of race
        // loadChapters()'s own isStale() guards against, needed here too
        // since this handler writes state.allChapters/renderChaptersList()
        // unconditionally otherwise (confirmed: without this, a slow
        // refresh started on manga A splices A's chapters into B's page if
        // the user navigates to B before it settles).
        if (state.currentManga?.id !== mangaId || state.currentSourceId !== sourceId) return;
        state.allChapters = cr.chapters || [];
        state.chapterCountCache[mangaId] = state.allChapters.length;
        saveSettings();
        renderChaptersList();
        // Keep the persisted cache in sync too — otherwise the next time
        // this manga's details page opens, loadChapters() instant-paints
        // the pre-refresh list for a moment before its own live fetch
        // corrects it, a needless flash of stale data right after the user
        // just explicitly refreshed.
        if (state.allChapters.length) _saveChaptersCacheEntry(_chaptersCacheKey(sourceId, mangaId), state.allChapters);
      } catch (err) {
        showToast("Refresh failed", err.message, "error");
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = prevHtml;
      }
    };
  }

  // Delete offline button
  const delBtn = $("deleteOfflineBtn");
  if (delBtn) {
    delBtn.onclick = async () => {
      if (!confirm("Are you sure you want to delete the selected offline chapters?")) return;
      const selectedIds = Array.from(state._chapterSelection).filter(id => state.offlineChapters && state.offlineChapters.has(id));
      if (!selectedIds.length) return;
      
      const prevHtml = delBtn.innerHTML;
      delBtn.innerHTML = "Deleting...";
      try {
        await api("/api/local/delete-offline-chapters", {
          method: "POST",
          body: JSON.stringify({
            sourceId: state.currentSourceId,
            mangaId: state.currentManga.id,
            chapterIds: selectedIds
          })
        });
        selectedIds.forEach(id => state.offlineChapters.delete(id));
        state._chapterSelection.clear();
        renderChaptersList();
        showToast("Deleted", "Offline chapters removed.", "success");
      } catch(e) {
        dbg.error(dbg.ERR_SOURCE, 'Failed to delete offline chapters', e);
        showToast("Error", "Failed to delete offline chapters.", "error");
        delBtn.innerHTML = prevHtml;
      }
    };
  }
}

// The page a chapter opened from the chapter list starts at: where the manga was left, if this is the chapter it was left in and it was not finished.
function _chapterListStartPage(chapterId) {
  const mangaId = state.currentManga?.id;
  if (!mangaId || state.incognitoReading) return 0;
  const key = `${mangaId}:${chapterId}`;
  return chapterStartPage({
    saved: state.lastReadPages?.[key],
    total: state.lastReadPageTotals?.[key],
    isLastRead: String(state.lastReadChapter?.[mangaId] || '') === String(chapterId),
  });
}

async function loadChapter(chapterId, chapterName, chapterIndex, startPageIndex = 0) {
  _bookFlipAnimating = false;
  _ltrFlipAnimating  = false;
  if (typeof _resetReaderImageFailureTracking === 'function') _resetReaderImageFailureTracking();
  $("searchStatus").textContent = "Loading chapter...";
  try {
    let result = _chapterPrefetchCache.get(chapterId);
    if (result) {
      _chapterPrefetchCache.delete(chapterId);
    } else {
      result = await api(`/api/source/${state.currentSourceId}/pages`, {
        method: "POST",
        body: JSON.stringify({ chapterId })
      });
    }
    // Some CDNs (e.g. img.batcave.biz) reject a direct <img> hotlink without
    // a Referer header. Normalise once here so every reader view (webtoon,
    // paged, 3D flip) gets an already-safe URL without needing its own fix.
    if (Array.isArray(result?.pages)) {
      result.pages = result.pages.map(p => (p && p.img ? { ...p, img: normalizeImageUrl(p.img) } : p));
    }

    // Validate before committing to state — otherwise a chapter that turns
    // out to have no pages leaves state.currentChapter/currentChapterIndex
    // pointing at a broken chapter while the DOM still shows the old one,
    // desyncing navigation (and defeating the webtoon auto-next retry guard)
    // even though nothing visibly changed for the user yet.
    if (!result?.isPDF && !result?.isEpub && (!Array.isArray(result?.pages) || result.pages.length === 0)) {
      throw new Error("This chapter has no public pages (it may be locked on the source).");
    }

    state.currentChapter      = result;
    state.currentChapter.name = chapterName;
    state.currentChapter.id   = chapterId;
    // Which manga this chapter belongs to: what lets the AniList tracker tell a chapter that is open from one left over from another manga.
    state.currentChapter.mangaId = state.currentManga?.id || '';
    state.currentChapterIndex = chapterIndex;

    // PDF: load via PDF.js to get page count, build synthetic pages array
    if (result.isPDF && result.pdfUrl) {
      await initPDFChapter(result.pdfUrl);
    }

    const maxIndex = Math.max((state.currentChapter.pages?.length || 1) - 1, 0);
    state.currentPageIndex = Math.min(Math.max(startPageIndex, 0), maxIndex);
    // Keep zoom level between chapters — only reset if it was never set

    // Track highest chapter number read (for AniList progress auto-fill) —
    // and everything else that leaves a trace of *what* was read (history,
    // read markers, AniList sync auto-fill) — skipped entirely in incognito
    // reading (state.incognitoReading, toggled in the reader sidebar): the
    // whole point is that opening a chapter while it's on leaves nothing
    // behind to find later, not just that the read stays unsynced.
    if (!state.incognitoReading) {
      const chNum = state.allChapters?.[chapterIndex]?.chapter;
      const chNumText = String(chNum ?? '').trim();
      const chNumParsed = Number.isFinite(Number(chNumText))
        ? Number(chNumText)
        : (() => {
            const m = chNumText.match(/(\d+(?:\.\d+)?)/);
            return m ? Number(m[1]) : NaN;
          })();
      if (Number.isFinite(chNumParsed) && chNumParsed > 0) {
        const _mId = state.currentManga.id;
        state.highestReadChapter[_mId] = Math.max(state.highestReadChapter[_mId] || 0, chNumParsed);
      }
      _markReadBackwardsToChapterIndex(state.currentManga.id, chapterIndex, chapterId);
    }
    state.readerSessionStart = Date.now();
    if (typeof maybeShowRereadPrompt === 'function') {
      maybeShowRereadPrompt(state.currentManga.id, state.currentSourceId, state.currentManga.title || '');
    }

    // AniList sync now runs when a reading session is finalized (chapter switch/close).

    if (!state.incognitoReading) {
      api("/api/history/add", {
        method: "POST",
        body: JSON.stringify({
          mangaId: state.currentManga.id,
          sourceId: state.currentSourceId,
          manga: state.currentManga,
          chapterId,
          chapterName
        })
      }).then(() => {
        // Keep in-memory history in sync (with full manga object including genres)
        const existing = state.history.findIndex(
          m => m.id === state.currentManga.id && m.sourceId === state.currentSourceId
        );
        const entry = { ...state.currentManga, sourceId: state.currentSourceId, chapterId, chapterName, readAt: new Date().toISOString() };
        if (existing >= 0) state.history.splice(existing, 1);
        state.history.unshift(entry);
        state.history = state.history.slice(0, 100);
        // Refresh recommendations so "Based on:" label reflects updated consumption
        loadRecommendations();
      }).catch(() => {});
    }

    // EPUB: reflowable text has no discrete page images, so it gets its own
    // epub.js-backed view (ui-epub-reader.js) instead of the page-counter/
    // spread/webtoon rendering engine built for fixed page images below.
    if (result.isEpub && result.epubUrl) {
      await openEpubReader(result.epubUrl);
      $("searchStatus").textContent = "";
      loadChapters();
      return;
    }

    showReader();
    // Auto-detect manhwa/manhua and switch to webtoon mode for this session
    if (state.settings.autoWebtoonDetect && state.currentManga) {
      if (isWebtoonFormat(state.currentManga)) {
        if (state.settings.readingMode !== 'webtoon') {
          state._preAutoReadingMode = state.settings.readingMode;
          state.settings.readingMode = 'webtoon';
        }
      } else if (state._preAutoReadingMode != null) {
        // Restore if we moved to a non-webtoon manga
        state.settings.readingMode = state._preAutoReadingMode;
        state._preAutoReadingMode = null;
      }
    }
    if (typeof syncReaderQuickModeButtons === 'function') syncReaderQuickModeButtons();
    renderPage();
    prefetchNextReaderChapters(2);
    $("searchStatus").textContent = "";
    loadChapters();
  } catch (e) {
    // A raw error message here (e.g. an upstream API's own internal error
    // code) means nothing to a user and gives them no next step. Point at
    // the Migrate button that's already visible on this same page — it's
    // the app's existing fix for "this source can't serve this manga
    // anymore", so a source-level pages() failure is exactly its use case.
    // A site that puts a CAPTCHA in front of its chapters says so with a code ending in NEED_CAPTCHA, and its message already tells the person what
    // to do (read it on the site, or use another source): that is the real reason, and the generic text would hide it.
    const captchaWall = /(?:^|_)NEED_CAPTCHA$/.test(String(e?.data?.code || ''));
    const friendlyMsg = captchaWall && e.message
      ? e.message
      : (typeof t === 'function' ? t('reader.pagesLoadFailed') : "Couldn't load this chapter from the current source. Try Migrate (above) to switch this manga to a different source, or try again later.");
    $("searchStatus").textContent = friendlyMsg;
    showToast('Chapter Failed', friendlyMsg, 'error');
    dbg.warn(dbg.ERR_SOURCE, 'loadChapter failed', { chapterId, sourceId: state.currentSourceId, error: e.message });
  }
}

