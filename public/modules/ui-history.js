// ============================================================================
// HISTORY VIEW
// ============================================================================

const _historyChapterNameCache = new Map();

async function _hydrateHistoryChapterNames(container) {
  if (!container) return;
  const rows = [...container.querySelectorAll('.history-item[data-manga-id][data-source-id][data-chapter-id]')];
  const targets = rows.filter(row => {
    const sid = String(row.dataset.sourceId || '').trim();
    const cid = String(row.dataset.chapterId || '').trim();
    const hasName = String(row.dataset.chapterName || '').trim();
    return !!(sid && cid && !hasName);
  });
  if (!targets.length) return;

  const buckets = new Map();
  for (const row of targets) {
    const key = `${row.dataset.sourceId}:${row.dataset.mangaId}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }

  for (const [key, group] of buckets.entries()) {
    const sep = key.indexOf(':');
    const sourceId = key.slice(0, sep);
    const mangaId = key.slice(sep + 1);
    try {
      let idToName = _historyChapterNameCache.get(key);
      if (!idToName) {
        const r = await api(`/api/source/${encodeURIComponent(sourceId)}/chapters`, {
          method: 'POST',
          body: JSON.stringify({ mangaId })
        });
        idToName = new Map((r?.chapters || []).map(ch => [String(ch.id), ch.name || `Chapter ${ch.chapter || '?'}`]));
        _historyChapterNameCache.set(key, idToName);
      }

      for (const row of group) {
        const cid = String(row.dataset.chapterId || '');
        const name = idToName.get(cid);
        if (!name) continue;
        row.dataset.chapterName = name;
        const label = row.querySelector('.history-last-chapter');
        if (label) label.textContent = `Stopped at: ${name}`;
      }
    } catch (_) {
      // Keep fallback text.
    }
  }
}

function renderHistoryView() {
  const container = $("historyList");
  if (!container) return;
  const history = (state.history || []).filter(m => !(state.settings.hideNsfw && isNsfwManga(m)));
  if (!history.length) {
    container.innerHTML = `<div class="muted" style="text-align:center;padding:3rem 0">No reading history yet.</div>`;
    return;
  }
  container.innerHTML = history.map(m => {
    const coverUrl = normalizeImageUrl(m.cover);
    const genres = (m.genres || []).slice(0, 3);
    const date   = m.readAt ? new Date(m.readAt).toLocaleDateString("en-GB", { day:"2-digit", month:"short", year:"numeric" }) : "";
    const chapterName = String(m.chapterName || '').trim();
    const chapterId = String(m.chapterId || '').trim();
    const chapterLabel = chapterName || (chapterId ? `Chapter ${chapterId}` : '');
    return `
      <div class="history-item" data-manga-id="${escapeHtml(m.id)}" data-source-id="${escapeHtml(m.sourceId || "")}" data-chapter-id="${escapeHtml(chapterId)}" data-chapter-name="${escapeHtml(chapterName)}">
        <div class="history-cover">
          ${coverUrl && !coverUrl.endsWith('.pdf') && !coverUrl.endsWith('.epub') ? `<img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(m.title)}" loading="lazy" decoding="async">` : (m.cover ? `<div class="no-cover">&#128196;</div>` : `<div class="no-cover">?</div>`) }
        </div>
        <div class="history-info">
          <h3 class="history-title">${escapeHtml(m.title)}</h3>
          ${m.author ? `<p class="history-author">${escapeHtml(m.author)}</p>` : ""}
          ${genres.length ? `<div class="history-genres">${genres.map(g => `<span class="manga-card-genre">${escapeHtml(g)}</span>`).join("")}</div>` : ""}
          ${chapterLabel ? `<p class="history-last-chapter">Stopped at: ${escapeHtml(chapterLabel)}</p>` : ""}
          ${date ? `<p class="history-date">${date}</p>` : ""}
        </div>
        <div class="history-actions">
          <button class="btn history-view-btn" data-mid="${escapeHtml(m.id)}" data-sid="${escapeHtml(m.sourceId || '')}">View Details</button>
          <button class="btn btn-start-reading-detail history-read-btn" data-mid="${escapeHtml(m.id)}" data-sid="${escapeHtml(m.sourceId || '')}">${state.lastReadChapter?.[m.id] ? '&#9654; Continue Reading' : '&#9654; Start Reading'}</button>
          <button class="history-delete-btn" title="Remove from history" data-mid="${escapeHtml(m.id)}" data-sid="${escapeHtml(m.sourceId || '')}">[x]</button>
        </div>
      </div>`;
  }).join("");

  container.querySelectorAll(".history-view-btn").forEach(btn => {
    btn.onclick = () => {
      const sid = btn.dataset.sid;
      if (sid && state.installedSources[sid]) {
        state.currentSourceId = sid;
        renderSourceSelect();
      }
      loadMangaDetails(btn.dataset.mid);
    };
  });
  container.querySelectorAll(".history-read-btn").forEach(btn => {
    btn.onclick = () => continueReading(btn.dataset.mid, btn.dataset.sid);
  });
  container.querySelectorAll(".history-delete-btn").forEach(btn => {
    btn.onclick = async () => {
      try {
        await api("/api/history/remove", {
          method: "POST",
          body: JSON.stringify({ mangaId: btn.dataset.mid, sourceId: btn.dataset.sid })
        });
        state.history = state.history.filter(m => !(m.id === btn.dataset.mid && m.sourceId === (btn.dataset.sid || m.sourceId)));
        renderHistoryView();
      } catch (e) { showToast("Error", e.message, "error"); }
    };
  });

  _hydrateHistoryChapterNames(container);
}

// ── Mode toggle (manga/anime) — same pattern as Discover's homeMode toggle
// (ui-anime-discover.js's applyHomeMode/#homeModeToggleBtn), persisted
// separately as state.settings.historyMode since a user might want one
// default for the home page and a different one here. ─────────────────────
function applyHistoryMode(mode, { persist = true } = {}) {
  const resolved = mode === 'anime' ? 'anime' : 'manga';
  state.settings.historyMode = resolved;
  if (persist && typeof saveSettings === 'function') saveSettings();

  const mangaEl = $("historyMangaContent");
  const animeEl = $("historyAnimeContent");
  if (mangaEl) mangaEl.classList.toggle("hidden", resolved === 'anime');
  if (animeEl) animeEl.classList.toggle("hidden", resolved !== 'anime');

  // Shares #homeModeToggleBtn with Home/Advanced Search/Library/Calendar
  // instead of its own button (see ui-anime-discover.js's
  // _OTHER_MODE_TOGGLE_VIEWS) — only writes the label while History is
  // actually the view on screen, so a background call (persist:false) can't
  // stomp a label currently showing a different view's own mode.
  const btn = $("homeModeToggleBtn");
  if (btn && navigationManager.currentView === 'history') {
    btn.textContent = resolved === 'anime' ? "Manga" : "Anime";
    btn.title = resolved === 'anime' ? "Switch history to Manga" : "Switch history to Anime";
  }

  if (resolved === 'anime') {
    if (typeof renderAnimeHistory === 'function') renderAnimeHistory();
  } else {
    renderHistoryView();
  }

  // Discord Rich Presence: see applyAdvancedSearchMode's identical comment
  // (ui-anime-advanced-search.js) — this toggle doesn't re-navigate, so
  // without this the status would freeze on whichever mode was active when
  // the page first opened.
  if (navigationManager.currentView === 'history' && typeof discordReportForView === 'function') {
    discordReportForView('history');
  }
}
window.applyHistoryMode = applyHistoryMode;

// The mode toggle click itself is now handled by the shared
// #homeModeToggleBtn in the top bar (see ui-anime-discover.js's
// _initHomeModeToggle) — History no longer has its own separate button.

