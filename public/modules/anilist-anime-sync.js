// ============================================================================
// modules/anilist-anime-sync.js — AniList integration for anime, split out of
// modules/anilist.js (which stayed manga-focused) to keep the two trackers
// isolated, since anime's data model already differs enough from manga's
// (anime.anilistId captured directly at favorite-time, no separate
// mangaId->AniList link cache, no local review/rating mirror, explicit
// status mirrors locally but episode progress never does — see inline notes
// below) that most of this code has no manga counterpart to share with.
//
// Depends on (loaded before this file by index.html):
//   modules/api.js      → api()
//   modules/state.js    → state
//   modules/utils.js    → $(), escapeHtml(), showToast(), normalizeImageUrl()
//   modules/anilist.js  → anilistGQL(), _alToken(), _sleep()
//
// References at call-time (from ui-anime-test.js, loaded after):
//   _animeTestCurrent, _animeTestRefreshFavoriteButton, renderAnimeLibrary,
//   _animeLibraryFavorites, _animeTestFavoriteEntry, _fetchAnimeFavorites
// ============================================================================

let _alStartupAnimeProgressSyncRunning = false;
let _alStartupAnimeProgressSyncDone = false;

// ── Anime progress sync (ui-anime-test.js) ──────────────────────────────────
// Simpler than the manga path in anilist.js: an anime favorite already
// carries AniList's own id directly (picked from the AniList search result
// at favorite-time — see server/modules/store/schema.js's animeFavorites),
// so there's no title-search resolution step needed. anilist.js's own
// _anilistWriteProgressByMediaId doesn't hardcode a media type
// (SaveMediaListEntry infers it from the id), so it's reused as-is; only the
// read side needs its own ANIME-typed query.

// Progress and whether the entry exists (the shared writer only creates a title as CURRENT when it has no entry yet).
async function _anilistReadAnimeEntryByMediaId(mediaId) {
  return _anilistReadEntryByMediaId(mediaId, 'ANIME');
}

/**
 * Pushes local watched-episode progress up to AniList when it's ahead of
 * what AniList already has — same "only write if local > remote" guard as
 * the manga path, so this can be called freely (e.g. once per episode
 * completion) without risking clobbering a higher count set from another
 * device.
 *
 * Two-directional, matching manga's _syncLocalUpToAniListIfHigher
 * counterpart — this used to only push local progress UP to AniList,
 * never pull a higher remote count back down, on the reasoning that "which
 * position within that episode would it resume at?" has no clean answer.
 * That reasoning only applies to the RESUME POSITION within an episode
 * (lastPositionSeconds), not to the episode COUNT itself — catching up
 * lastWatchedEpisode to a higher remote value is exactly as meaningful as
 * manga's chapter catch-up, it just can't also guess a mid-episode replay
 * position, so it resets to the start of that episode (position 0) instead
 * of leaving the whole catch-up undone. Confirmed live as a real gap: a
 * show watched further on AniList directly (or via another AniList-synced
 * app) than ScrollApe's own local record never caught up, requiring the
 * user to manually re-track it after every restart.
 * idMal: needed only for the remote-ahead direction (to know which local
 * favorite to update) — omit it and this silently stays one-directional
 * for that call, same as before.
 */
async function anilistReconcileAnimeProgress({ anilistId, localEpisode, idMal }) {
  if (!_alToken() || !state.settings.anilistAutoSync) return { ok: false, skipped: true };
  const mediaId = Number(anilistId || 0);
  if (!mediaId) return { ok: false, skipped: true, reason: 'missing-media-id' };

  const local = _normalizeProgressNumber(localEpisode);
  const entry = await _anilistReadAnimeEntryByMediaId(mediaId);
  const remote = entry.progress;
  const merged = Math.max(local, remote);

  if (local > remote) {
    await _anilistWriteProgressByMediaId(mediaId, merged, { newEntry: !entry.exists });
  } else if (remote > local && idMal) {
    await _syncAnimeTrackerProgressToLocal(idMal, remote);
  }

  return { ok: true, mediaId, local, remote, merged };
}

async function _syncAnimeTrackerProgressToLocal(idMal, episode) {
  const target = Number(episode);
  if (!idMal || !Number.isFinite(target) || target <= 0) return { updated: 0 };
  try {
    await api('/api/anime/progress-sync', {
      method: 'POST',
      body: JSON.stringify({ idMal, episode: target }),
    });
    // Keep in-memory state consistent so the UI reflects this without
    // needing a full reload — mirrors the two places a favorite's fields
    // are cached client-side (the library grid's own list, and whichever
    // one is currently open on the watch page).
    const libFav = (typeof _animeLibraryFavorites !== 'undefined' ? _animeLibraryFavorites : []).find(f => f.idMal === idMal);
    if (libFav && target > (Number(libFav.lastWatchedEpisode) || 0)) {
      libFav.lastWatchedEpisode = target;
      libFav.lastPositionSeconds = 0;
    }
    if (typeof _animeTestFavoriteEntry !== 'undefined' && _animeTestFavoriteEntry?.idMal === idMal
      && target > (Number(_animeTestFavoriteEntry.lastWatchedEpisode) || 0)) {
      _animeTestFavoriteEntry.lastWatchedEpisode = target;
      _animeTestFavoriteEntry.lastPositionSeconds = 0;
    }
    return { updated: 1 };
  } catch (e) {
    dbg.warn(dbg.ERR_ANILIST, 'Could not pull AniList progress down to local anime favorite', e);
    return { updated: 0 };
  }
}

// Anime's counterpart to anilist.js's anilistStartupReconcileProgress — this
// simply didn't exist before, at all, which was the actual bug behind "I
// had to manually re-track One Piece after every restart, its progress
// never caught up to what AniList already had": manga favorites got this
// startup catch-up automatically, anime favorites got nothing, ever, no
// matter how far ahead the remote progress was. Same serialized-with-a-gap
// pacing as the manga version, same reasoning (this runs unattended on
// every app open, nothing here needs to be fast enough to risk the shared
// AniList rate budget).
async function anilistStartupReconcileAnimeProgress() {
  if (_alStartupAnimeProgressSyncRunning || _alStartupAnimeProgressSyncDone) return;
  if (!_alToken() || !state.settings.anilistAutoSync) return;

  let favorites;
  try {
    favorites = await _fetchAnimeFavorites();
  } catch (e) {
    dbg.warn(dbg.ERR_ANILIST, 'Startup anime progress sync: could not load favorites', e);
    _alStartupAnimeProgressSyncDone = true;
    return;
  }

  const targets = favorites.filter(f => f?.idMal && f?.anilistId);
  if (!targets.length) {
    _alStartupAnimeProgressSyncDone = true;
    return;
  }

  _alStartupAnimeProgressSyncRunning = true;
  try {
    let idx = 0;
    async function worker() {
      while (idx < targets.length) {
        const cur = targets[idx++];
        try {
          await anilistReconcileAnimeProgress({
            anilistId: cur.anilistId,
            localEpisode: cur.lastWatchedEpisode,
            idMal: cur.idMal,
          });
        } catch (e) {
          dbg.warn(dbg.ERR_ANILIST, 'Startup anime progress sync failed for one show', e);
        }
        await _sleep(2000);
      }
    }
    await worker();
    _alStartupAnimeProgressSyncDone = true;
  } finally {
    _alStartupAnimeProgressSyncRunning = false;
  }
}

// ── Anime AniList Tracker — same modal shape as anilist.js's own
// showTrackerModal (manga), but genuinely simpler in a few places rather
// than a forced generalization of it, because anime's own data model
// already differs:
//  - An anime favorite already carries AniList's own id directly
//    (anime.anilistId, captured at favorite-time) instead of needing the
//    separate mangaId->AniList sidecar cache manga's _alGetLink/_alSetLink
//    maintain — so this skips straight to the linked entry whenever
//    possible, only falling back to search when anilistId is missing/stale.
//  - No local review/rating system exists for anime (unlike manga's
//    api('/api/reviews', ...) mirroring), so a saved score only ever writes
//    to AniList itself.
//  - Episode progress also only ever writes to AniList, not mirrored into
//    the favorite's own lastWatchedEpisode: the only server route that
//    updates that field (/api/anime/progress) also unconditionally logs a
//    watch-history entry and touches analytics — correct for "the user just
//    watched an episode", wrong for "the user typed a number into a form",
//    so reusing it here would fabricate a watch session that didn't happen.
//  - Explicit status DOES mirror locally, into animeWatchStatus via the
//    existing POST /api/anime/status (same REPEATING -> 'watching' mapping
//    manga's REPEATING -> 'reading' already uses) — that route's only
//    purpose is exactly this, no unwanted side effects to avoid.
async function showAnimeTrackerModal(anime) {
  document.querySelector('.tracker-modal')?.remove();

  anime = anime || _animeTestCurrent;
  if (!anime?.idMal || !anime?.title) {
    showToast('Tracker', 'Could not detect the current anime.', 'warning');
    return;
  }

  const AL_STATUSES = [
    ['CURRENT',   'Watching'],
    ['COMPLETED', 'Completed'],
    ['PAUSED',    'On Hold'],
    ['DROPPED',   'Dropped'],
    ['PLANNING',  'Plan to Watch'],
    ['REPEATING', 'Rewatching'],
  ];

  const modal = document.createElement('div');
  modal.className = 'tracker-modal';
  const closeModal = () => { modal.remove(); };
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
  document.body.appendChild(modal);

  const currentCover = anime.cover || '';
  modal.innerHTML = `
    <div class="tracker-content">
      <div class="tracker-header">
        <h3 class="tracker-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="vertical-align:middle;margin-right:7px"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>AniList Tracker
        </h3>
        <button class="btn secondary tracker-close" id="closeAnimeTrackerBtn">&#x2715;</button>
      </div>
      <div class="tracker-layout">
        <div class="tracker-sidebar">
          <div class="tracker-sidebar-cover">
            ${currentCover
              ? `<img src="${escapeHtml(normalizeImageUrl(currentCover))}" alt="${escapeHtml(anime.title)}" loading="lazy">`
              : `<div class="tracker-sidebar-no-cover">?</div>`}
          </div>
          <p class="tracker-sidebar-title">${escapeHtml(anime.title)}</p>
          <p class="tracker-sidebar-hint">Find on AniList &rarr;</p>
        </div>
        <div class="tracker-main" id="animeTrackerMain">
          <div class="muted" style="padding:2rem 0;text-align:center">Loading…</div>
        </div>
      </div>
    </div>`;
  modal.querySelector('#closeAnimeTrackerBtn').onclick = () => closeModal();

  const render = (html) => {
    document.getElementById('animeTrackerMain').innerHTML = html;
  };

  if (!_alToken()) {
    render(`<p class="tracker-info-msg">Connect your AniList account in <strong>Settings &rarr; Tracking</strong> to use this feature.</p>`);
    return;
  }

  const fmtDate = (fd) => {
    if (!fd?.year) return '';
    const m = String(fd.month || 1).padStart(2, '0');
    const d = String(fd.day  || 1).padStart(2, '0');
    return `${fd.year}-${m}-${d}`;
  };
  const parseDate = (str) => {
    if (!str) return null;
    const [y, mo, d] = str.split('-').map(Number);
    return { year: y || null, month: mo || null, day: d || null };
  };

  const SEARCH_QUERY = `query ($s: String) {
    Page(perPage: 16) {
      media(search: $s, type: ANIME, sort: SEARCH_MATCH) {
        id
        title { romaji english native }
        coverImage { extraLarge large medium }
        format
        status
        startDate { year }
      }
    }
  }`;

  const ENTRY_QUERY = `query ($id: Int) {
    Media(id: $id, type: ANIME) {
      id
      title { romaji english }
      mediaListEntry {
        id status progress score(format: POINT_10_DECIMAL)
        startedAt   { year month day }
        completedAt { year month day }
      }
    }
  }`;

  const buildPickerHtml = (results, searchTitle) => {
    const noResultsMsg = !results.length
      ? `<p class="tracker-info-msg">No results for "${escapeHtml(searchTitle)}".</p>`
      : '';
    return `
      <div class="tracker-search-bar">
        <input type="text" id="atrRetryInput" class="input" value="${escapeHtml(searchTitle)}" placeholder="Search AniList…">
        <button class="btn primary" id="atrRetryBtn">Search</button>
      </div>
      ${noResultsMsg}
      ${results.length ? `<div class="tracker-picker" id="animeTrackerPicker">
        ${results.map(m => {
          // Romaji-first for anime, at the user's explicit request — see
          // ui-anime-discover.js's _animeMediaTitle for the same preference
          // applied everywhere else anime titles are shown.
          const title = m.title?.romaji || m.title?.english || m.title?.native || '';
          const fmt   = m.format ? m.format.replace(/_/g, ' ') : '';
          const yr    = m.startDate?.year || '';
          const cover = m.coverImage?.extraLarge || m.coverImage?.large || m.coverImage?.medium || '';
          return `<button class="tracker-pick-item" data-id="${m.id}" title="${escapeHtml(title)}">
            <div class="tracker-pick-cover">${cover
              ? `<img src="${escapeHtml(normalizeImageUrl(cover))}" alt="" loading="lazy">`
              : '<div class="tracker-pick-no-cover">?</div>'}
            </div>
            <div class="tracker-pick-info">
              <span class="tracker-pick-title">${escapeHtml(title)}</span>
              <span class="tracker-pick-meta">${[fmt, yr].filter(Boolean).join(' · ')}</span>
            </div>
          </button>`;
        }).join('')}
      </div>` : ''}`;
  };

  const buildFormHtml = (media) => {
    const entry = media.mediaListEntry;
    const displayTitle = media.title?.romaji || media.title?.english || anime.title;
    const progressValue = Math.max(entry?.progress ?? 0, Number(anime.lastWatchedEpisode) || 0) || '';
    return `
      <button type="button" class="btn secondary tracker-back-btn" id="atrBackBtn">&#8592; Back to results</button>
      <div class="tracker-media-title">${escapeHtml(displayTitle)}</div>
      <form class="tracker-form" id="animeTrackerForm" onsubmit="return false">
        <div class="tracker-field">
          <label class="tracker-label">Status</label>
          <select id="atrStatus" class="input tracker-select">
            <option value="">— Not tracked —</option>
            ${AL_STATUSES.map(([v, l]) =>
              `<option value="${v}"${entry?.status === v ? ' selected' : ''}>${l}</option>`
            ).join('')}
          </select>
        </div>
        <div class="tracker-field">
          <label class="tracker-label">Episode Progress</label>
          <input type="number" id="atrProgress" class="input" min="0" step="1"
            value="${progressValue}" placeholder="0">
        </div>
        <div class="tracker-field">
          <label class="tracker-label">Score (0 – 10)</label>
          <input type="number" id="atrScore" class="input" min="0" max="10" step="0.5"
            value="${entry?.score ?? ''}" placeholder="0">
        </div>
        <div class="tracker-dates">
          <div class="tracker-field">
            <label class="tracker-label">Start Date</label>
            <input type="date" id="atrStart" class="input" value="${fmtDate(entry?.startedAt)}">
          </div>
          <div class="tracker-field">
            <label class="tracker-label">End Date</label>
            <input type="date" id="atrEnd" class="input" value="${fmtDate(entry?.completedAt)}">
          </div>
        </div>
        <div class="tracker-footer">
          <div class="tracker-footer-left">
            ${entry ? `<button type="button" class="btn tracker-remove-btn" id="atrRemoveBtn">Remove</button>` : ''}
          </div>
          <div class="tracker-footer-right">
            <p class="tracker-msg" id="atrMsg"></p>
            <button type="submit" class="btn primary" id="atrSaveBtn">Save to AniList</button>
          </div>
        </div>
      </form>`;
  };

  const wireForm = (media, results, searchTitle) => {
    document.getElementById('atrBackBtn')?.addEventListener('click', () => {
      render(buildPickerHtml(results, searchTitle));
      wirePicker(results, searchTitle, media.id);
    });
    const entry = media.mediaListEntry;
    document.getElementById('atrStatus').onchange = () => {
      const st = document.getElementById('atrStatus').value;
      const startEl = document.getElementById('atrStart');
      if ((st === 'CURRENT' || st === 'REPEATING') && !startEl.value) startEl.value = new Date().toISOString().slice(0, 10);
      if (st === 'COMPLETED') { const endEl = document.getElementById('atrEnd'); if (!endEl.value) endEl.value = new Date().toISOString().slice(0, 10); }
    };
    document.getElementById('atrSaveBtn').onclick = async () => {
      const status = document.getElementById('atrStatus').value;
      if (!status) { document.getElementById('atrMsg').textContent = 'Choose a status first.'; return; }
      const progress    = parseInt(document.getElementById('atrProgress').value, 10) || 0;
      const scoreRaw    = String(document.getElementById('atrScore').value || '').trim();
      const score       = parseFloat(scoreRaw.replace(',', '.')) || 0;
      const startedAt   = parseDate(document.getElementById('atrStart').value);
      const completedAt = parseDate(document.getElementById('atrEnd').value);
      const saveBtn = document.getElementById('atrSaveBtn');
      saveBtn.disabled = true;
      document.getElementById('atrMsg').textContent = 'Saving…';
      document.getElementById('atrMsg').className = 'tracker-msg';
      try {
        const saveRes = await anilistGQL(
          `mutation ($m: Int, $st: MediaListStatus, $prog: Int, $sc: Float, $start: FuzzyDateInput, $end: FuzzyDateInput) {
            SaveMediaListEntry(mediaId: $m, status: $st, progress: $prog, score: $sc, startedAt: $start, completedAt: $end) { id }
          }`,
          { m: media.id, st: status, prog: progress, sc: score, start: startedAt, end: completedAt }
        );
        if (saveRes?.errors?.length) throw new Error(saveRes.errors[0].message);

        const localStatusMap = {
          CURRENT: 'watching',
          COMPLETED: 'completed',
          PAUSED: 'on_hold',
          DROPPED: 'dropped',
          PLANNING: 'plan_to_watch',
          REPEATING: 'watching',
        };
        const localStatus = localStatusMap[status] || null;
        if (localStatus) {
          try {
            await api('/api/anime/status', {
              method: 'POST',
              body: JSON.stringify({ idMal: anime.idMal, status: localStatus }),
            });
          } catch (_) {}
        }

        try { if (typeof _animeTestRefreshFavoriteButton === 'function') await _animeTestRefreshFavoriteButton(); } catch (_) {}
        try { if (typeof renderAnimeLibrary === 'function') renderAnimeLibrary(); } catch (_) {}

        const _atBtn = document.getElementById('animeTrackerBtn');
        if (_atBtn) { _atBtn.innerHTML = 'Tracker ✓'; _atBtn.classList.add('btn-tracker--tracked'); }
        document.getElementById('atrMsg').textContent = '✓ Saved!';
        document.getElementById('atrMsg').className = 'tracker-msg tracker-msg-ok';
        setTimeout(() => closeModal(), 900);
      } catch (err) {
        document.getElementById('atrMsg').textContent = `Error: ${err.message}`;
        document.getElementById('atrMsg').className = 'tracker-msg tracker-msg-err';
        saveBtn.disabled = false;
      }
    };
    if (entry) {
      document.getElementById('atrRemoveBtn').onclick = async () => {
        if (!confirm('Remove this anime from your AniList?')) return;
        document.getElementById('atrRemoveBtn').disabled = true;
        try {
          await anilistGQL(`mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`, { id: entry.id });
          showToast('AniList', 'Removed from list.', 'info');
          closeModal();
        } catch (err) {
          showToast('AniList Error', err.message, 'error');
          document.getElementById('atrRemoveBtn').disabled = false;
        }
      };
    }
  };

  const wirePicker = (results, searchTitle, selectedId = null) => {
    const retryBtn = document.getElementById('atrRetryBtn');
    const retryInput = document.getElementById('atrRetryInput');
    if (retryBtn) retryBtn.onclick = () => { const v = retryInput?.value.trim(); if (v) searchAndPick(v); };
    if (retryInput) retryInput.onkeydown = (e) => { if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) searchAndPick(v); } };
    document.getElementById('animeTrackerPicker')?.querySelectorAll('.tracker-pick-item').forEach(btn => {
      if (String(selectedId) === btn.dataset.id) btn.classList.add('tracker-pick-item--selected');
      btn.onclick = async () => {
        const id = parseInt(btn.dataset.id, 10);
        document.querySelectorAll('.tracker-pick-item').forEach(b => b.classList.remove('tracker-pick-item--selected'));
        btn.classList.add('tracker-pick-item--selected');
        render(`<div class="muted" style="padding:2rem 0;text-align:center">Loading…</div>`);
        try {
          const r = await anilistGQL(ENTRY_QUERY, { id });
          const m = r?.data?.Media;
          if (m) { render(buildFormHtml(m)); wireForm(m, results, searchTitle); }
          else render(`<p class="tracker-info-msg">Could not load entry.</p>`);
        } catch (err) { render(`<p class="tracker-info-msg">Error: ${escapeHtml(err.message)}</p>`); }
      };
    });
  };

  const searchAndPick = async (searchTitle) => {
    render(`<div class="muted" style="padding:2rem 0;text-align:center">Searching AniList…</div>`);
    try {
      const gqlResult = await anilistGQL(SEARCH_QUERY, { s: searchTitle });
      const results = gqlResult?.data?.Page?.media || [];
      render(buildPickerHtml(results, searchTitle));
      wirePicker(results, searchTitle);
    } catch (err) {
      render(`<p class="tracker-info-msg">Error: ${escapeHtml(err.message)}</p>
        <div class="tracker-search-bar" style="margin-top:.5rem">
          <input type="text" id="atrRetryInput" class="input" value="${escapeHtml(searchTitle)}" placeholder="Search AniList…">
          <button class="btn primary" id="atrRetryBtn">Search</button>
        </div>`);
      document.getElementById('atrRetryBtn').onclick = () => { const v = document.getElementById('atrRetryInput').value.trim(); if (v) searchAndPick(v); };
    }
  };

  try {
    // Anime already carries its own AniList id directly (captured at
    // favorite-time) — skip straight to the linked entry instead of
    // manga's separate sidecar-lookup step, only falling back to search
    // when there's no id at all or it turns out to be stale.
    const mediaId = Number(anime.anilistId || 0);
    if (mediaId) {
      const r = await anilistGQL(ENTRY_QUERY, { id: mediaId });
      const m = r?.data?.Media;
      if (m) { render(buildFormHtml(m)); wireForm(m, [], anime.title); }
      else {
        const gqlResult = await anilistGQL(SEARCH_QUERY, { s: anime.title });
        const results = gqlResult?.data?.Page?.media || [];
        render(buildPickerHtml(results, anime.title));
        wirePicker(results, anime.title);
      }
    } else {
      const gqlResult = await anilistGQL(SEARCH_QUERY, { s: anime.title });
      const results = gqlResult?.data?.Page?.media || [];
      render(buildPickerHtml(results, anime.title));
      wirePicker(results, anime.title);
    }
  } catch (err) {
    render(`<p class="tracker-info-msg">Error: ${escapeHtml(err.message)}</p>`);
  }
}

// Same AniList enum values as anilist.js's AL_BULK_STATUSES, anime-
// appropriate wording — module-level so ui-anime-library-context-menu.js
// can reach it too. That file used to reuse AL_BULK_STATUSES directly since
// it was the only status-label list actually in scope there, which showed
// manga wording ("Reading"/"Plan to Read"/"Rereading") on an anime card's
// own context menu.
const AL_BULK_ANIME_STATUSES = [
  ['CURRENT',   'Watching'],
  ['COMPLETED', 'Completed'],
  ['PAUSED',    'On Hold'],
  ['DROPPED',   'Dropped'],
  ['PLANNING',  'Plan to Watch'],
  ['REPEATING', 'Rewatching'],
];

// ── AniList status change for a single anime (library card context menu) ───
// Unlike manga's anilistBulkSetStatus, there's no _anilistResolveMediaId
// step: every anime favorite already stores anilistId directly, captured at
// favorite-time (routes/anime.js's /favorites/toggle) — no link cache or
// title-search fallback needed. A favorite predating that field (rare) has
// no anilistId and is reported unmatched rather than guessed at.
const ANIME_AL_LOCAL_STATUS_MAP = {
  CURRENT: 'watching', COMPLETED: 'completed', PAUSED: 'on_hold',
  DROPPED: 'dropped', PLANNING: 'plan_to_watch', REPEATING: 'watching',
};

async function anilistSetAnimeStatus(anime, status) {
  const mediaId = Number(anime?.anilistId || 0);
  if (!mediaId) return { ok: false, unmatched: true };

  const saveRes = await anilistGQL(
    `mutation ($m: Int, $st: MediaListStatus) { SaveMediaListEntry(mediaId: $m, status: $st) { id } }`,
    { m: mediaId, st: status }
  );
  if (saveRes?.errors?.length) throw new Error(saveRes.errors[0].message);

  const localStatus = ANIME_AL_LOCAL_STATUS_MAP[status] || null;
  if (localStatus) {
    await api('/api/anime/status', {
      method: 'POST',
      body: JSON.stringify({ idMal: anime.idMal, status: localStatus }),
    });
  }
  return { ok: true, unmatched: false, localStatus };
}
