// ============================================================================
// READER & PAGE RENDERING
// ============================================================================

let _readerArrowProximityListener = null;

function _bindReaderArrowProximity(readerEl) {
  if (!readerEl || _readerArrowProximityListener) return;
  _readerArrowProximityListener = (e) => {
    const arrow = $("readerSidebarToggle");
    if (!arrow) return;
    const r = arrow.getBoundingClientRect();
    const expand = 78;
    const nearArrow = (
      e.clientX >= (r.left - expand) &&
      e.clientX <= (r.right + expand) &&
      e.clientY >= (r.top - expand) &&
      e.clientY <= (r.bottom + expand)
    );
    readerEl.classList.toggle("reader-arrow-visible", nearArrow);
  };
  readerEl.addEventListener("mousemove", _readerArrowProximityListener);
}

function _unbindReaderArrowProximity(readerEl) {
  if (!readerEl || !_readerArrowProximityListener) return;
  readerEl.removeEventListener("mousemove", _readerArrowProximityListener);
  _readerArrowProximityListener = null;
}

function applyReaderBackground() {
  const colours = {
    black:  '#000000',
    dark:   '#111318',
    gray:   '#2a2a2e',
    sepia:  '#1e160c',
    white:  '#ffffff',
  };
  const bg = colours[state.settings.readerBackground] || colours.black;
  $('reader').style.backgroundColor = bg;
}

function applyReaderTurnButtonLayout(mode = state.settings.readingMode) {
  const readerEl = $("reader");
  if (!readerEl) return;
  const isWebtoon = mode === "webtoon";
  const buttonsEnabled = state.settings.webtoonTurnButtonsEnabled !== false;
  const showButtons = isWebtoon && buttonsEnabled;
  const placement = (state.settings.webtoonTurnButtonPlacement === "bottom") ? "bottom" : "corners";
  readerEl.classList.toggle("reader-webtoon-nav-visible", showButtons);
  readerEl.classList.toggle("reader-webtoon-nav-bottom", showButtons && placement === "bottom");
  readerEl.classList.toggle("reader-webtoon-nav-corners", showButtons && placement === "corners");
}

function showReader() {
  const readerEl = $("reader");
  readerEl.classList.remove("hidden");
  document.documentElement.classList.add("reader-open");
  document.body.classList.add("reader-open");
  applyReaderBackground();
  if (typeof applyReaderNoiseSetting === 'function') applyReaderNoiseSetting();
  const mode = state.settings.readingMode;
  // Do not reset zoom level when opening reader or changing chapters; preserve user zoom.
  const chapterMeta = state.allChapters?.[state.currentChapterIndex];
  const chapterNumber = chapterMeta?.chapter;
  const chapterName = state.currentChapter?.name || "";
  const chapterLabel = chapterNumber ? `Chapter ${chapterNumber}` : (chapterName || "Chapter");
  $("readerTitle").textContent = `${state.currentManga?.title || ""} - ${chapterLabel}`;
  syncIncognitoReaderUI();
  updateZoomUI();
  applyReaderTurnButtonLayout(mode);
  _bindReaderArrowProximity(readerEl);
  _initReaderImageFailureDetection(readerEl);

  // Discord Rich Presence: report every chapter open (including switching
  // chapters within the same manga), not just the very first one — the
  // server treats each call as "this is what's showing now", so re-reporting
  // on chapter nav is what makes the presence text (e.g. "Chapter 12")
  // actually update instead of freezing on whatever chapter was opened first.
  // Respects incognito reading — see discordReportReadingState's own comment
  // (ui-discord-presence.js).
  if (typeof discordReportReadingState === 'function') discordReportReadingState(chapterLabel);
}

// ============================================================================
// BROKEN PAGE-IMAGE DETECTION
// A source's pages() call can succeed (return a non-empty URL list) while the
// individual image files behind those URLs are dead — confirmed live with
// ComicHubFree (404s on every page) and it's a real, silent failure: the
// reader opens normally, loadChapter()'s own error handling never triggers
// (no exception was thrown — pages() genuinely succeeded), and the user just
// sees broken-image icons with no explanation.
//
// One capturing listener on #reader catches it for every current and future
// rendering mode (paged/.page-img, webtoon/.webtoon-page, RTL+LTR 3D
// flip/.book-page-img) without each needing its own fix — the DOM 'error'
// event on <img> doesn't bubble, but capture-phase listeners on an ancestor
// still see it regardless, since capturing happens on the way down to the
// target before bubbling would even start.
// ============================================================================
const _readerImageFailures = new Set();
let _readerImageFailureWarnTimer = null;

function _initReaderImageFailureDetection(readerEl) {
  if (!readerEl || readerEl._imgFailureListenerBound) return;
  readerEl._imgFailureListenerBound = true;
  readerEl.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    if (!img.matches('.page-img, .webtoon-page, .book-page-img')) return;
    if (_readerImageFailures.has(img.src)) return;
    _readerImageFailures.add(img.src);
    // Debounced rather than shown on the first failure: page <img> tags for
    // a broken chapter fail in a burst (all around the same time), and one
    // summary toast ("6 of 6 pages...") is far more useful than the first
    // of a dozen near-identical ones.
    if (_readerImageFailureWarnTimer) clearTimeout(_readerImageFailureWarnTimer);
    _readerImageFailureWarnTimer = setTimeout(_showReaderImageFailureWarning, 500);
  }, true);
}

function _resetReaderImageFailureTracking() {
  _readerImageFailures.clear();
  if (_readerImageFailureWarnTimer) {
    clearTimeout(_readerImageFailureWarnTimer);
    _readerImageFailureWarnTimer = null;
  }
}

function _showReaderImageFailureWarning() {
  const failed = _readerImageFailures.size;
  if (failed === 0) return;
  const total = state.currentChapter?.pages?.length || failed;
  const template = typeof t === 'function'
    ? (t('reader.pagesPartialFail') || "{failed} of {total} page image(s) couldn't load from this source. Try Migrate (above) to switch this manga to a different source.")
    : "{failed} of {total} page image(s) couldn't load from this source. Try Migrate (above) to switch this manga to a different source.";
  const msg = template.replace('{failed}', failed).replace('{total}', total);
  showToast('Broken Pages', msg, 'error');
  dbg.warn(dbg.ERR_SOURCE, 'Reader page images failed to load', { sourceId: state.currentSourceId, chapterId: state.currentChapter?.id, failed, total });
}

async function hideReader() {
  if (typeof stopReaderNoise === 'function') stopReaderNoise();
  stopAutoScroll();
  if (typeof _unbindWebtoonAutoNext === "function") _unbindWebtoonAutoNext();
  // Falls back to whatever view is left showing underneath (manga-details,
  // normally) rather than clearing to nothing — presence stays "always
  // active" per the feature's own design (see ui-discord-presence.js).
  if (typeof discordReportForView === 'function') discordReportForView(navigationManager.currentView);
  await recordReadingSession();
  // Restore reading mode if it was auto-overridden by webtoon detection
  if (state._preAutoReadingMode != null) {
    state.settings.readingMode = state._preAutoReadingMode;
    state._preAutoReadingMode = null;
  }
  const readerEl = $("reader");
  readerEl.classList.add("hidden");
  document.documentElement.classList.remove("reader-open");
  document.body.classList.remove("reader-open");
  readerEl.classList.remove("reader-sidebar-collapsed", "reader-arrow-visible");
  _unbindReaderArrowProximity(readerEl);
}

// ============================================================================
// AUTO-SCROLL & PAGE RENDERING (Consolidated from ui-autoscroll-1.js)
// ============================================================================

let _autoScrollRAF = null;
let _autoScrollCarry = 0;
const READER_PREFETCH_AHEAD = 6;
const READER_PREFETCH_BEHIND = 1;
const READER_PREFETCH_MAX_CACHE = 36;
const _readerPrefetchCache = new Map();
const WEBTOON_AUTO_NEXT_THRESHOLD = 120;

function getAutoScrollPointSpeeds() {
  const defaults = [0.2, 0.5, 1.0, 2.0, 3.5];
  const saved = Array.isArray(state.settings?.autoScrollPointSpeeds)
    ? state.settings.autoScrollPointSpeeds
    : defaults;
  return defaults.map((fallback, idx) => {
    const n = Number(saved[idx]);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(12, Math.max(0.05, n));
  });
}

let _webtoonAutoNextHandler = null;
let _webtoonAutoNextLoading = false;
let _webtoonAutoNextLastFromIndex = -1;
let _webtoonAutoNextCooldownUntil = 0;

function _unbindWebtoonAutoNext() {
  const wrap = $("pageWrap");
  if (wrap && _webtoonAutoNextHandler) {
    wrap.removeEventListener("scroll", _webtoonAutoNextHandler);
  }
  _webtoonAutoNextHandler = null;
  _webtoonAutoNextLoading = false;
  _unbindWebtoonProgress();
}

// ── webtoon position ────────────────────────────────────────────────────────
// A webtoon chapter is one long scroll, so the page that is remembered is the image at the top of the view: written as the person scrolls (one look per
// frame, and only when the image changes), and scrolled back to when the chapter is opened again. Until that scroll-back is done, or the person has
// scrolled by hand, nothing is written: the first draw must not store the top of the chapter over the place that was saved.
let _webtoonProgressHandler = null;
let _webtoonProgressFrame = 0;
let _webtoonRestoring = false;
let _webtoonRestoreCancel = null;

function _unbindWebtoonProgress() {
  const wrap = $("pageWrap");
  if (wrap && _webtoonProgressHandler) wrap.removeEventListener("scroll", _webtoonProgressHandler);
  if (_webtoonProgressFrame) cancelAnimationFrame(_webtoonProgressFrame);
  if (_webtoonRestoreCancel) _webtoonRestoreCancel();
  _webtoonProgressHandler = null;
  _webtoonProgressFrame = 0;
  _webtoonRestoring = false;
  _webtoonRestoreCancel = null;
}

function _bindWebtoonProgress(wrap) {
  _webtoonProgressHandler = () => {
    if (_webtoonRestoring || _webtoonProgressFrame) return;
    _webtoonProgressFrame = requestAnimationFrame(() => {
      _webtoonProgressFrame = 0;
      const imgs = [...wrap.querySelectorAll(".webtoon-page")];
      if (!imgs.length) return;
      const wrapTop = wrap.getBoundingClientRect().top;
      const idx = webtoonPageAtTop(imgs.map((img) => ({ idx: Number(img.dataset.idx), top: img.getBoundingClientRect().top })), wrapTop);
      if (idx === state.currentPageIndex) return;
      state.currentPageIndex = idx;
      updateReadingProgress(state.currentManga?.id, state.currentChapter?.id, idx);
    });
  };
  wrap.addEventListener("scroll", _webtoonProgressHandler, { passive: true });
}

// Scrolls to the image that was saved, once the images above it have a size (before that the place it is at keeps moving). The person scrolling by hand,
// or the chapter being drawn again, ends it.
function _restoreWebtoonPosition(wrap, targetIdx) {
  if (!(targetIdx > 0)) return;
  const imgs = [...wrap.querySelectorAll(".webtoon-page")];
  const target = imgs.find((img) => Number(img.dataset.idx) >= targetIdx);
  if (!target) return;
  _webtoonRestoring = true;
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) wrap.removeEventListener(type, stop);
    document.removeEventListener("keydown", stop);
    if (_webtoonRestoreCancel === stop) _webtoonRestoreCancel = null;
    _webtoonRestoring = false;
  };
  _webtoonRestoreCancel = stop;
  for (const type of ["wheel", "touchstart", "pointerdown"]) wrap.addEventListener(type, stop, { once: true, passive: true });
  document.addEventListener("keydown", stop, { once: true });

  const above = imgs.slice(0, imgs.indexOf(target));
  const sized = above.map((img) => (img.complete ? Promise.resolve() : new Promise((resolve) => {
    img.addEventListener("load", resolve, { once: true });
    img.addEventListener("error", resolve, { once: true });
  })));
  const patience = new Promise((resolve) => { setTimeout(resolve, 10_000); });
  Promise.race([Promise.all(sized), patience]).then(() => {
    if (cancelled || !target.isConnected) return;
    wrap.scrollTop += target.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
    // the scroll event this causes is still on its way: let it pass before position tracking starts
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!cancelled) stop(); }));
  });
}

function _bindWebtoonAutoNext() {
  const wrap = $("pageWrap");
  if (!wrap) return;

  _unbindWebtoonAutoNext();

  _webtoonAutoNextHandler = () => {
    if (state.settings.autoLoadNextChapter !== true) return;
    if (_webtoonAutoNextLoading) return;
    if (Date.now() < _webtoonAutoNextCooldownUntil) return;

    const nearBottom = (wrap.scrollTop + wrap.clientHeight) >= (wrap.scrollHeight - WEBTOON_AUTO_NEXT_THRESHOLD);
    if (!nearBottom) return;

    if (state.currentChapterIndex === _webtoonAutoNextLastFromIndex) return;

    const nextIdx = getNextChapterIndex(state.currentChapterIndex);
    const total = state.allChapters?.length || 0;
    if (nextIdx < 0 || nextIdx >= total) return;

    const fromIndex = state.currentChapterIndex;
    _webtoonAutoNextLastFromIndex = fromIndex;
    _webtoonAutoNextLoading = true;
    Promise.resolve(goToNextChapter()).finally(() => {
      _webtoonAutoNextLoading = false;
      _webtoonAutoNextCooldownUntil = Date.now() + 1200;
      if (state.currentChapterIndex === fromIndex) {
        _webtoonAutoNextLastFromIndex = -1;
      }
    });
  };

  wrap.addEventListener("scroll", _webtoonAutoNextHandler, { passive: true });
}

function _prefetchReaderImage(src) {
  if (!src || _readerPrefetchCache.has(src)) return;

  const img = new Image();
  img.decoding = "async";
  img.src = src;
  _readerPrefetchCache.set(src, img);

  while (_readerPrefetchCache.size > READER_PREFETCH_MAX_CACHE) {
    const oldestKey = _readerPrefetchCache.keys().next().value;
    _readerPrefetchCache.delete(oldestKey);
  }

  if (typeof img.decode === "function") {
    img.decode().catch(() => {});
  }
}

function prefetchReaderPages(pages, currentIdx) {
  if (!Array.isArray(pages) || !pages.length) return;

  const start = Math.max(0, currentIdx - READER_PREFETCH_BEHIND);
  const end = Math.min(pages.length - 1, currentIdx + READER_PREFETCH_AHEAD);
  for (let i = start; i <= end; i++) {
    const src = pages[i]?.img;
    if (src) _prefetchReaderImage(src);
  }
}

function startAutoScroll() {
  stopAutoScroll();
  const pageWrap = $("pageWrap");
  if (!pageWrap) return;
  _autoScrollCarry = 0;

  function tick() {
    const speeds = getAutoScrollPointSpeeds();
    const speedPx = speeds[state.autoScroll.speed - 1] || speeds[1] || 1.5;
    _autoScrollCarry += speedPx;
    const delta = Math.trunc(_autoScrollCarry);
    if (delta > 0) {
      pageWrap.scrollTop += delta;
      _autoScrollCarry -= delta;
    }
    _autoScrollRAF = requestAnimationFrame(tick);
  }
  _autoScrollRAF = requestAnimationFrame(tick);
}

function stopAutoScroll() {
  if (_autoScrollRAF !== null) {
    cancelAnimationFrame(_autoScrollRAF);
    _autoScrollRAF = null;
  }
  _autoScrollCarry = 0;
}

// Incognito reading: a runtime-only mode (state.incognitoReading, never
// persisted — see state.js) that stays on across chapters/manga until
// turned off again, same as a browser's private-browsing toggle. The
// buttons in both reader sidebars (#readerIncognitoToggle, #epubIncognitoToggle)
// and the topbar badges share this one flag — flipping it in either reader
// affects both, since it's read straight from state wherever a chapter/page
// actually gets recorded (loadChapter, updateReadingProgress,
// recordReadingSession, _saveEpubProgress).
function toggleIncognitoReading() {
  state.incognitoReading = !state.incognitoReading;
  syncIncognitoReaderUI();
  _refreshDiscordForOpenReader();
  showToast(
    state.incognitoReading ? "Incognito Reading" : "Incognito Reading Off",
    state.incognitoReading
      ? "History, analytics, Discord status and AniList sync are paused until you turn this off."
      : "Reading progress is being tracked normally again.",
    "info"
  );
}

// Re-reports Discord presence immediately when incognito is toggled
// mid-chapter (not just on the next chapter switch/reader open, which
// already goes through discordReportReadingState on their own) — otherwise
// turning incognito on while already sitting on an open chapter would leave
// the "Reading X / Chapter Y" status showing on Discord until you turned a
// page. A no-op when neither reader is currently open.
function _refreshDiscordForOpenReader() {
  if (typeof discordReportReadingState !== 'function') return;
  const readerOpen = $("reader") && !$("reader").classList.contains("hidden");
  if (readerOpen) {
    const chapterMeta = state.allChapters?.[state.currentChapterIndex];
    const chapterNumber = chapterMeta?.chapter;
    const chapterName = state.currentChapter?.name || "";
    const chapterLabel = chapterNumber ? `Chapter ${chapterNumber}` : (chapterName || "Chapter");
    discordReportReadingState(chapterLabel);
    return;
  }
  const epubOpen = $("epubReader") && !$("epubReader").classList.contains("hidden");
  if (epubOpen) discordReportReadingState(state.currentChapter?.name || '');
}

function syncIncognitoReaderUI() {
  const on = !!state.incognitoReading;
  document.querySelectorAll('#readerIncognitoToggle, #epubIncognitoToggle').forEach((btn) => {
    btn.classList.toggle("active", on);
    btn.title = on
      ? "Incognito reading is on — click to resume saving history, analytics and AniList sync"
      : "Read without saving history, analytics, or AniList sync";
  });
  $("reader")?.classList.toggle("reader-incognito-active", on);
  $("epubReader")?.classList.toggle("reader-incognito-active", on);
}

function toggleAutoScroll() {
  state.autoScroll.enabled = !state.autoScroll.enabled;
  const btn   = $("autoScrollToggle");
  const bar   = $("autoScrollBar");
  if (btn) {
    btn.classList.toggle("active", state.autoScroll.enabled);
    btn.title = state.autoScroll.enabled ? "Stop AutoScroll" : "Start AutoScroll";
  }
  if (bar) bar.classList.toggle("is-disabled", !state.autoScroll.enabled);
  if (state.autoScroll.enabled) startAutoScroll();
  else stopAutoScroll();
}

function renderPage() {
  if (!state.currentChapter?.pages) return;

  if (state.currentChapter.isPDF && state.pdfDocument) {
    const _mode = state.settings.readingMode;
    if (_mode === 'webtoon')    renderPDFWebtoon();
    else if (_mode === 'rtl')   renderPDFSpread(true);
    else if (_mode === 'ltr')   renderPDFSpread(false);
    else                        renderPDFPageToCanvas(state.currentPageIndex + 1);
    return;
  }

  const pages   = state.currentChapter.pages;
  const pageWrap = $("pageWrap");
  const idx     = state.currentPageIndex;
  const mode    = state.settings.readingMode;

  if (typeof applyReaderTurnButtonLayout === "function") {
    applyReaderTurnButtonLayout(mode);
  }

  const zoomStyle = state.zoomLevel !== 1.0 ? `style="transform:scale(${state.zoomLevel});transform-origin:top center;"` : "";

  if (mode === "webtoon") {
    pageWrap.className = "reader-content reading-mode-webtoon";
    const validPages = pages.filter(p => p.img);
    if (validPages.length === 0) {
      // Every page came back without a usable image URL (e.g. a source's
      // scraper picked up a lazy-load placeholder instead of the real page
      // image). Previously this fell through to render an almost-empty
      // wrap — a blank, still-scrollable page with no indication of what
      // went wrong. Show the same friendly message loadChapter() already
      // uses for a fully-failed chapter load, and stop auto-advancing so
      // it doesn't just keep landing here on the next chapter too.
      const friendlyMsg = typeof t === 'function' ? t('reader.pagesLoadFailed') : "Couldn't load this chapter from the current source. Try Migrate (above) to switch this manga to a different source, or try again later.";
      pageWrap.innerHTML = `<div class="chapter-end-wrap"><p class="chapter-end-label">${escapeHtml(friendlyMsg)}</p></div>`;
      $("pageCounter").textContent = "";
      $("prevPage").style.display = "none";
      $("nextPage").style.display = "none";
      _unbindWebtoonAutoNext();
      return;
    }
    const nextWIdx = getNextChapterIndex(state.currentChapterIndex);
    const nextWCh  = (nextWIdx >= 0 && nextWIdx < (state.allChapters?.length || 0)) ? state.allChapters[nextWIdx] : null;
    const nextWLabel = nextWCh ? (nextWCh.name || `Chapter ${nextWCh.chapter || nextWIdx + 1}`) : null;
    pageWrap.innerHTML = `
      <div class="page-zoom-wrap webtoon-wrap" ${zoomStyle}>
        ${validPages.map((p, i) => `<img src="${escapeHtml(p.img)}" alt="Page ${i + 1}" class="webtoon-page" data-idx="${pages.indexOf(p)}" loading="eager">`).join("")}
      </div>
      <div class="chapter-end-wrap">
        ${nextWLabel
          ? `<p class="chapter-end-label">Next Chapter</p>
             <p class="chapter-end-name">${escapeHtml(nextWLabel)}</p>
             <button class="btn chapter-next-btn" onclick="goToNextChapter()">Read Next →</button>`
          : `<p class="chapter-end-label">You've reached the last chapter!</p>`}
      </div>`;
    pageWrap.scrollTop = 0;
    $("pageCounter").textContent = `Webtoon Mode — ${validPages.length} pages`;
    $("prevPage").style.display = "none";
    $("nextPage").style.display = "none";
    _bindWebtoonAutoNext();
    _bindWebtoonProgress(pageWrap);
    // the place the chapter was opened at (0 for a chapter that is started): written as it is, never as 0 over a saved place
    updateReadingProgress(state.currentManga?.id, state.currentChapter?.id, idx);
    _restoreWebtoonPosition(pageWrap, idx);
  } else if (mode === "rtl") {
    _unbindWebtoonAutoNext();
    renderBookSpread();
    return;
  } else if (mode === "ltr") {
    _unbindWebtoonAutoNext();
    renderLTRSpread();
    return;
  } else {
    _unbindWebtoonAutoNext();
    pageWrap.className = "reader-content";
    if (idx < 0 || idx >= pages.length) return;
    prefetchReaderPages(pages, idx);
    const page     = pages[idx];
    const isLast   = idx === pages.length - 1;
    const imgClass = state.settings.panWideImages ? "page-img pannable" : "page-img";
    const nextIdx  = isLast ? getNextChapterIndex(state.currentChapterIndex) : -1;
    const nextCh   = (isLast && nextIdx >= 0 && nextIdx < (state.allChapters?.length || 0)) ? state.allChapters[nextIdx] : null;
    const nextLabel = nextCh ? (nextCh.name || `Chapter ${nextCh.chapter || nextIdx + 1}`) : null;
    const endBanner = isLast ? `
      <div class="chapter-end-wrap">
        <div class="chapter-end-divider"></div>
        ${nextLabel
          ? `<p class="chapter-end-label">Next Chapter</p>
             <p class="chapter-end-name">${escapeHtml(nextLabel)}</p>
             <button class="btn chapter-next-btn" onclick="goToNextChapter()">Read Next →</button>`
          : `<p class="chapter-end-label">Last chapter reached!</p>`}
      </div>` : "";
    pageWrap.innerHTML = page.img
      ? `<div class="page-zoom-wrap" ${zoomStyle}><img src="${escapeHtml(page.img)}" alt="Page ${idx + 1}" class="${imgClass}"></div>${endBanner}`
      : `<div class="muted">Page not available</div>`;
    if (!isLast) pageWrap.scrollTop = 0;
    else pageWrap.scrollTo({ top: 0, behavior: "smooth" });

    $("pageCounter").textContent = `${idx + 1} / ${pages.length}`;
    $("prevPage").disabled = false;
    $("nextPage").disabled = false;
    $("prevPage").style.display = "block";
    $("nextPage").style.display = "block";
    updateReadingProgress(state.currentManga?.id, state.currentChapter?.id, idx);
  }
}

