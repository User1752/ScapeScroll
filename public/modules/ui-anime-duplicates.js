// ============================================================================
// ANIME DUPLICATE SCANNER
// Mirrors ui-duplicates.js, but scoped to what can actually happen for
// anime: idMal is a hard unique key server-side (server/routes/anime.js's
// /favorites/toggle does a findIndex before every push), so a favorite can
// never literally duplicate itself. The only real scenario is two
// *different* idMal values that are actually the same show — e.g. a title
// search landed on two separate AniList entries. Reuses ui-migrate.js's
// _titleSimilarity — it's plain-string, no manga coupling.
// ============================================================================

const ANIME_DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

function _findAnimeDuplicateGroups() {
  const favs = (_animeLibraryFavorites || []).filter(f => f?.idMal && f?.title);
  const used = new Array(favs.length).fill(false);
  const groups = [];

  for (let i = 0; i < favs.length; i++) {
    if (used[i]) continue;
    const group = [favs[i]];
    for (let j = i + 1; j < favs.length; j++) {
      if (used[j]) continue;
      if (_titleSimilarity(favs[i].title, favs[j].title) >= ANIME_DUPLICATE_SIMILARITY_THRESHOLD) {
        group.push(favs[j]);
        used[j] = true;
      }
    }
    if (group.length > 1) {
      used[i] = true;
      groups.push(group);
    }
  }
  return groups;
}

function showAnimeDuplicateScanModal() {
  document.querySelector('.anime-duplicate-scan-modal')?.remove();

  const groups = _findAnimeDuplicateGroups();

  const modal = document.createElement('div');
  modal.className = 'settings-modal anime-duplicate-scan-modal';

  const renderGroup = (group, gi) => `
    <div class="setting-group dup-group" data-group-idx="${gi}">
      <p class="setting-description" style="margin-top:0">Possible duplicate — ${group.length} entries match "${escapeHtml(group[0].title)}"</p>
      <div class="dup-entries">
        ${group.map((f, ei) => `
          <label class="dup-entry">
            <input type="radio" name="anime-dup-keep-${gi}" value="${ei}" ${ei === 0 ? 'checked' : ''}>
            ${f.cover ? `<img src="${escapeHtml(normalizeImageUrl(f.cover))}" alt="">` : '<div class="dup-entry-nocover"></div>'}
            <div class="dup-entry-info">
              <div class="dup-entry-title">${escapeHtml(f.title)}</div>
              <div class="dup-entry-chapters">${f.format === 'MOVIE' ? 'Movie' : `Ep ${f.lastWatchedEpisode || 0}${f.totalEpisodes ? ` / ${f.totalEpisodes}` : ''}`}</div>
            </div>
          </label>`).join('')}
      </div>
      <div class="dup-group-actions">
        <button class="btn primary dup-merge-btn" data-group-idx="${gi}">Keep selected, remove others</button>
        <button class="btn secondary dup-dismiss-btn" data-group-idx="${gi}">Not a duplicate</button>
      </div>
    </div>`;

  modal.innerHTML = `
    <div class="settings-content" style="max-width:640px;max-height:82vh;overflow-y:auto">
      <div class="settings-header">
        <h2>Duplicate Scan</h2>
        <button class="btn secondary" id="closeAnimeDupScan">&#x2715;</button>
      </div>
      <div class="settings-body">
        ${groups.length === 0
          ? `<p class="muted" style="text-align:center;padding:2rem 0">No likely duplicates found.</p>`
          : `<p class="setting-description" style="margin-top:0">Found ${groups.length} possible duplicate group${groups.length === 1 ? '' : 's'} by title similarity. Keeping an entry removes the others from My Anime; if a removed entry was further along, its progress is copied to the one you keep first.</p>
             <div id="animeDupGroupsList">${groups.map((g, gi) => renderGroup(g, gi)).join('')}</div>`}
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  $('closeAnimeDupScan').onclick = () => modal.remove();

  modal.querySelectorAll('.dup-dismiss-btn').forEach(btn => {
    btn.onclick = () => {
      modal.querySelector(`.dup-group[data-group-idx="${btn.dataset.groupIdx}"]`)?.remove();
    };
  });

  modal.querySelectorAll('.dup-merge-btn').forEach(btn => {
    btn.onclick = async () => {
      const gi = Number(btn.dataset.groupIdx);
      const group = groups[gi];
      const groupEl = modal.querySelector(`.dup-group[data-group-idx="${gi}"]`);
      const keepIdx = Number(groupEl.querySelector(`input[name="anime-dup-keep-${gi}"]:checked`)?.value ?? 0);
      const keep = group[keepIdx];
      const others = group.filter((_, i) => i !== keepIdx);

      btn.disabled = true;
      try {
        const furthestOther = others.reduce((best, o) =>
          (o.lastWatchedEpisode || 0) > (best?.lastWatchedEpisode || 0) ? o : best, null);
        if (furthestOther && (furthestOther.lastWatchedEpisode || 0) > (keep.lastWatchedEpisode || 0)) {
          await api('/api/anime/progress', {
            method: 'POST',
            body: JSON.stringify({
              idMal: keep.idMal,
              episode: furthestOther.lastWatchedEpisode,
              positionSeconds: furthestOther.lastPositionSeconds || 0,
              durationSeconds: furthestOther.lastDurationSeconds || 0,
            }),
          });
        }
        for (const o of others) {
          await api('/api/anime/favorites/toggle', {
            method: 'POST',
            body: JSON.stringify({ idMal: o.idMal, title: o.title }),
          });
        }
        await renderAnimeLibrary();
        groupEl.remove();
        showToast('Duplicates', `Kept "${keep.title}".`, 'success');
      } catch (err) {
        showToast('Error', err.message || 'Could not merge.', 'error');
        btn.disabled = false;
      }
    };
  });
}
