// ── My Anime library right-click context menu ─────────────────────────────
// Structurally mirrors ui-library-context-menu.js's showLibraryContextMenu,
// scoped down for what actually applies to anime (see the plan this was
// built from): no Download All (anime is streaming-only, no local files),
// no bulk-selection (anime library has no multi-select mechanism to hook
// into), no bookshelf-3D spine-picker branch (no spine concept for anime
// cards). Categories reuse the exact same store.customLists/animeItems
// endpoints the details-page panel already uses (_animeTestSaveCategories,
// same file) — just with an explicit Save button instead of save-on-check,
// to match the manga context menu's UX.
// ============================================================================

function _closeAnimeLibraryContextMenu() {
  document.getElementById('animeLibraryContextMenu')?.remove();
  document.removeEventListener('click', _animeCtxDocClickHandler, true);
  document.removeEventListener('keydown', _animeCtxMenuKeyHandler);
}

function _animeCtxMenuKeyHandler(e) {
  if (e.key === 'Escape') _closeAnimeLibraryContextMenu();
}

function _animeCtxDocClickHandler(e) {
  if (e?.target?.closest && e.target.closest('#animeLibraryContextMenu')) return;
  _closeAnimeLibraryContextMenu();
}

const ANIME_CTX_STATUSES = [
  ['watching', 'Watching'],
  ['completed', 'Completed'],
  ['on_hold', 'On Hold'],
  ['plan_to_watch', 'Plan to Watch'],
  ['dropped', 'Dropped'],
];

async function showAnimeLibraryContextMenu(pointOrEvent, anime) {
  _closeAnimeLibraryContextMenu();
  if (!anime?.idMal) return;

  const currentStatus = _animeComputeStatus(anime);
  const hasAniList = typeof _alToken === 'function' && _alToken() && anime.anilistId;

  let serverCatIds = [];
  try {
    const d = await api(`/api/lists/anime/${encodeURIComponent(anime.idMal)}/categories`);
    serverCatIds = d.categoryIds || [];
  } catch (_) {}

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'animeLibraryContextMenu';

  const _ico = (path) => `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${path}</svg>`;

  const categoriesSection = (state.customLists || []).length > 0
    ? `<div class="context-divider"></div>
       <div class="ctx-categories-header">Categories</div>
       <div class="ctx-categories-list">
         ${(state.customLists || []).map(l => `
           <label class="ctx-cat-label">
             <input type="checkbox" class="ctx-anime-cat-cb" value="${escapeHtml(l.id)}" ${serverCatIds.includes(l.id) ? 'checked' : ''}>
             <span>${escapeHtml(l.name)}</span>
           </label>`).join('')}
       </div>
       <div style="padding:0.35rem 0.55rem 0.6rem">
         <button class="btn primary ctx-anime-save-cats-btn" style="width:100%;font-size:0.82rem;padding:0.42rem 0.75rem">Save Categories</button>
       </div>`
    : `<div class="context-divider"></div>
       <div class="ctx-categories-header" style="opacity:0.5;font-style:italic;padding-bottom:0.5rem">No categories — create one in the Library page</div>`;

  menu.innerHTML = `
    <div class="ctx-categories-header" style="padding-top:0.55rem;padding-bottom:0.35rem">Anime actions</div>
    <button class="context-item" id="ctxAnimeEditTags">${_ico('<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>')} Edit Tags</button>
    <div class="context-divider"></div>
    <button class="context-item" id="ctxAnimeChangeCover">${_ico('<rect x="3" y="5" width="18" height="14" rx="2" ry="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>')} Change Cover</button>
    <div class="context-divider"></div>
    ${ANIME_CTX_STATUSES.map(([val, label]) => `
      <button class="context-item ${currentStatus === val ? 'ctx-item-active' : ''}" data-status="${val}" id="ctxAnimeMark_${val}">${_ico('<polyline points="20 6 9 17 4 12"/>')} Mark as ${label}</button>
    `).join('')}
    <button class="context-item ${currentStatus === 'not-started' ? 'ctx-item-active' : ''}" id="ctxAnimeMarkUnwatched">${_ico('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>')} Mark as Unwatched</button>
    <div class="context-divider"></div>
    <button class="context-item" id="ctxAnimeRemove">${_ico('<path d="M3 6h18M9 6v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V6"/><path d="M10 11v6M14 11v6"/>')} Remove from Library</button>
    ${hasAniList
      ? `<div class="context-divider"></div>
         <div class="ctx-categories-header">AniList Status</div>
         <div style="padding:0.3rem 0.55rem 0.5rem">
           <select id="ctxAnimeAnilistStatus" class="input" style="width:100%;font-size:0.82rem">
             ${AL_BULK_ANIME_STATUSES.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('')}
           </select>
         </div>
         <div style="padding:0 0.55rem 0.6rem">
           <button class="btn primary ctx-anime-anilist-status-btn" style="width:100%;font-size:0.82rem;padding:0.42rem 0.75rem">Apply AniList Status</button>
         </div>`
      : `<div class="context-divider"></div>
         <div class="ctx-categories-header" style="opacity:0.5;font-style:italic;padding-bottom:0.5rem">${!anime.anilistId ? 'No AniList link for this title' : 'Connect AniList in Settings to change status there too'}</div>`}
    ${categoriesSection}`;

  document.body.appendChild(menu);

  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = 240, mh = menu.offsetHeight || 300;
  let { x, y } = getContextMenuPoint(pointOrEvent);
  if (x + mw > vw - 8) x = vw - mw - 8;
  if (y + mh > vh - 8) y = vh - mh - 8;
  if (y < 8) y = 8;
  if (x < 8) x = 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  // Also used from the anime watch/details page's own "More Actions" button
  // (see ui-anime-test.js's _initAnimeTestView) — when that's where this menu
  // was opened from, refresh the details-page favorite state too, not just
  // the library grid (which is a no-op there anyway, its own $() call bails
  // out when #animeLibraryGrid isn't in the DOM).
  const refreshAfterChange = () => {
    if (typeof renderAnimeLibrary === 'function') renderAnimeLibrary();
    if (typeof _animeTestCurrent !== 'undefined' && _animeTestCurrent?.idMal === anime.idMal && typeof _animeTestRefreshFavoriteButton === 'function') {
      _animeTestRefreshFavoriteButton();
    }
  };

  menu.querySelector('#ctxAnimeEditTags').onclick = () => {
    _closeAnimeLibraryContextMenu();
    showEditAnimeTagsModal(anime);
  };

  menu.querySelector('#ctxAnimeChangeCover').onclick = () => {
    _closeAnimeLibraryContextMenu();
    openAnimeCoverPicker(anime);
  };

  const setStatus = async (status) => {
    _closeAnimeLibraryContextMenu();
    try {
      await api('/api/anime/status', { method: 'POST', body: JSON.stringify({ idMal: anime.idMal, status }) });
      refreshAfterChange();
      showToast('Status', status === 'none' ? 'Marked as unwatched.' : `Marked as ${status.replace(/_/g, ' ')}.`, 'success');
    } catch (e) {
      showToast('Error', e.message, 'error');
    }
  };
  ANIME_CTX_STATUSES.forEach(([val]) => {
    menu.querySelector(`#ctxAnimeMark_${val}`).onclick = () => setStatus(val);
  });
  menu.querySelector('#ctxAnimeMarkUnwatched').onclick = () => setStatus('none');

  menu.querySelector('#ctxAnimeRemove').onclick = async () => {
    if (!confirm('Remove this anime from your library?')) return;
    _closeAnimeLibraryContextMenu();
    try {
      await api('/api/anime/favorites/toggle', { method: 'POST', body: JSON.stringify({ idMal: anime.idMal, title: anime.title }) });
      refreshAfterChange();
      showToast('Removed', 'Removed from My Anime.', 'info');
    } catch (e) {
      showToast('Error', e.message, 'error');
    }
  };

  const anilistBtn = menu.querySelector('.ctx-anime-anilist-status-btn');
  if (anilistBtn) {
    anilistBtn.onclick = async () => {
      const status = menu.querySelector('#ctxAnimeAnilistStatus')?.value;
      if (!status) return;
      anilistBtn.disabled = true;
      anilistBtn.textContent = 'Applying…';
      try {
        const res = await anilistSetAnimeStatus(anime, status);
        _closeAnimeLibraryContextMenu();
        if (res.unmatched) {
          showToast('AniList Status', 'This title has no AniList link.', 'warning');
        } else {
          refreshAfterChange();
          showToast('AniList Status', 'Updated on AniList.', 'success');
        }
      } catch (err) {
        showToast('AniList Error', err.message || 'Could not update AniList status.', 'error');
        anilistBtn.disabled = false;
        anilistBtn.textContent = 'Apply AniList Status';
      }
    };
  }

  const saveCatsBtn = menu.querySelector('.ctx-anime-save-cats-btn');
  if (saveCatsBtn) {
    saveCatsBtn.onclick = async (ev) => {
      ev.stopPropagation();
      const checked = [...menu.querySelectorAll('.ctx-anime-cat-cb:checked')].map(cb => cb.value);
      saveCatsBtn.disabled = true;
      try {
        await api('/api/lists/anime-categories', {
          method: 'PUT',
          body: JSON.stringify({
            idMal: anime.idMal,
            categoryIds: checked,
            animeData: { title: anime.title, cover: anime.cover },
          }),
        });
        const d = await api('/api/lists');
        state.customLists = d.lists || state.customLists;
        _closeAnimeLibraryContextMenu();
        refreshAfterChange();
        showToast('Categories', 'Updated.', 'success');
      } catch (err) {
        showToast('Error', err.message, 'error');
        saveCatsBtn.disabled = false;
      }
    };
  }

  menu.querySelectorAll('.ctx-anime-cat-cb').forEach(cb => cb.addEventListener('click', e => e.stopPropagation()));
  menu.querySelectorAll('.ctx-cat-label').forEach(lbl => lbl.addEventListener('click', e => e.stopPropagation()));

  setTimeout(() => {
    document.addEventListener('click', _animeCtxDocClickHandler, true);
    document.addEventListener('keydown', _animeCtxMenuKeyHandler);
  }, 0);
}
