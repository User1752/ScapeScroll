// ============================================================================
// DUPLICATE SCANNER
// Finds library entries (favorites + local manga) that are probably the same
// work added more than once — e.g. favorited from two different sources by
// accident, or a local import of something already tracked online. Reuses
// ui-migrate.js's fuzzy title matching (_titleSimilarity) and its existing
// merge machinery (POST /api/library/migrate + _migrateRemapLocalStorage)
// instead of building a second, parallel merge path.
//
// Also groups by a shared AniList link (_alGetLink, anilist.js) alongside
// title similarity — the same manga favorited from a romanized-title source
// and a native-script one can score well under the similarity threshold on
// title text alone, but if both already got linked to the same AniList
// entry (via the tracker or an earlier migrate), that's a far more reliable
// "these are the same work" signal than any string comparison. A group can
// therefore form from either signal; matchedBy on the group records which
// one(s) actually fired, so the modal can say why two differently-titled
// entries ended up together instead of just asserting it.
// ============================================================================

const DUPLICATE_SIMILARITY_THRESHOLD = 0.6;

function _findDuplicateGroups() {
  const allManga = [...(state.favorites || []), ...(state.localManga || [])]
    .filter(m => m?.id && m?.title)
    .map(m => ({ ...m, sourceId: m.sourceId || 'local' }));

  const anilistIdOf = (m) => (typeof _alGetLink === 'function' ? _alGetLink(m.id) : null) || null;

  const used = new Array(allManga.length).fill(false);
  const groups = [];

  for (let i = 0; i < allManga.length; i++) {
    if (used[i]) continue;
    const group = [allManga[i]];
    const matchedBy = new Set();
    const iAnilistId = anilistIdOf(allManga[i]);
    for (let j = i + 1; j < allManga.length; j++) {
      if (used[j]) continue;
      const titleMatch = _titleSimilarity(allManga[i].title, allManga[j].title) >= DUPLICATE_SIMILARITY_THRESHOLD;
      const jAnilistId = anilistIdOf(allManga[j]);
      const trackerMatch = !!iAnilistId && iAnilistId === jAnilistId;
      if (!titleMatch && !trackerMatch) continue;
      if (titleMatch) matchedBy.add('title');
      if (trackerMatch) matchedBy.add('tracker');
      group.push(allManga[j]);
      used[j] = true;
    }
    if (group.length > 1) {
      used[i] = true;
      groups.push({ entries: group, matchedBy });
    }
  }
  return groups;
}

function showDuplicateScanModal() {
  document.querySelector('.duplicate-scan-modal')?.remove();

  const groups = _findDuplicateGroups();

  const modal = document.createElement('div');
  modal.className = 'settings-modal duplicate-scan-modal';

  const matchReasonLabel = (matchedBy, group) => {
    const byTitle = matchedBy.has('title');
    const byTracker = matchedBy.has('tracker');
    if (byTracker && !byTitle) {
      // Titles didn't score as similar text — the only reason these are
      // grouped is a shared AniList link, so naming one entry's title as
      // "the" match would misrepresent why they're together.
      return `linked to the same AniList entry, titles differ`;
    }
    const suffix = byTracker ? ' (title &amp; AniList link agree)' : '';
    return `match "${escapeHtml(group[0].title)}"${suffix}`;
  };

  const renderGroup = ({ entries: group, matchedBy }, gi) => `
    <div class="setting-group dup-group" data-group-idx="${gi}">
      <p class="setting-description" style="margin-top:0">Possible duplicate — ${group.length} entries ${matchReasonLabel(matchedBy, group)}</p>
      <div class="dup-entries">
        ${group.map((m, ei) => `
          <label class="dup-entry">
            <input type="radio" name="dup-keep-${gi}" value="${ei}" ${ei === 0 ? 'checked' : ''}>
            ${m.cover ? `<img src="${escapeHtml(normalizeImageUrl(m.cover))}" alt="">` : '<div class="dup-entry-nocover"></div>'}
            <div class="dup-entry-info">
              <div class="dup-entry-title">${escapeHtml(m.title)}</div>
              <div class="dup-entry-source">${m.sourceId === 'local' ? 'Local' : escapeHtml(state.installedSources?.[m.sourceId]?.name || m.sourceId)}</div>
              <div class="dup-entry-chapters" id="dupChap-${gi}-${ei}">Loading chapters…</div>
            </div>
          </label>`).join('')}
      </div>
      <div class="dup-group-actions">
        <button class="btn primary dup-merge-btn" data-group-idx="${gi}">Merge (keep selected)</button>
        <button class="btn secondary dup-dismiss-btn" data-group-idx="${gi}">Not a duplicate</button>
      </div>
    </div>`;

  modal.innerHTML = `
    <div class="settings-content" style="max-width:640px;max-height:82vh;overflow-y:auto">
      <div class="settings-header">
        <h2>Duplicate Scan</h2>
        <button class="btn secondary" id="closeDupScan">&#x2715;</button>
      </div>
      <div class="settings-body">
        ${groups.length === 0
          ? `<p class="muted" style="text-align:center;padding:2rem 0">No likely duplicates found.</p>`
          : `<p class="setting-description" style="margin-top:0">Found ${groups.length} possible duplicate group${groups.length === 1 ? '' : 's'} by title similarity or a shared AniList link. Merging keeps the selected entry's reading progress/reviews/categories and folds the others into it — works between favorites; local manga in a group needs manual removal for now.</p>
             <div id="dupGroupsList">${groups.map((g, gi) => renderGroup(g, gi)).join('')}</div>`}
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  $('closeDupScan').onclick = () => modal.remove();

  // Lazy chapter-count fetch per entry — only for groups actually rendered,
  // never a blanket pass over the whole library (that's the expensive part,
  // not the title comparison — see ui-migrate.js's _chapCount for precedent).
  groups.forEach(({ entries: group }, gi) => {
    group.forEach((m, ei) => {
      _sourceChaptersCount(m.sourceId, m.id).then(count => {
        const el = document.getElementById(`dupChap-${gi}-${ei}`);
        if (el) el.textContent = count != null ? `${count} chapters` : 'Chapter count unknown';
      });
    });
  });

  modal.querySelectorAll('.dup-dismiss-btn').forEach(btn => {
    btn.onclick = () => {
      modal.querySelector(`.dup-group[data-group-idx="${btn.dataset.groupIdx}"]`)?.remove();
    };
  });

  modal.querySelectorAll('.dup-merge-btn').forEach(btn => {
    btn.onclick = async () => {
      const gi = Number(btn.dataset.groupIdx);
      const group = groups[gi].entries;
      const groupEl = modal.querySelector(`.dup-group[data-group-idx="${gi}"]`);
      const keepIdx = Number(groupEl.querySelector(`input[name="dup-keep-${gi}"]:checked`)?.value ?? 0);
      const keep = group[keepIdx];
      const others = group.filter((_, i) => i !== keepIdx);
      const localOthers = others.filter(o => o.sourceId === 'local');
      const favOthers = others.filter(o => o.sourceId !== 'local');

      if (keep.sourceId === 'local' && favOthers.length) {
        showToast('Duplicates', "Merging into a local entry isn't supported yet — pick a non-local entry to keep, or remove the extras manually.", 'warning');
        return;
      }

      btn.disabled = true;
      try {
        if (favOthers.length) {
          const migrations = favOthers.map(o => ({
            fromMangaId: o.id,
            fromSourceId: o.sourceId,
            toMangaId: keep.id,
            toSourceId: keep.sourceId,
            title: keep.title,
            cover: keep.cover || '',
          }));
          const res = await api('/api/library/migrate', { method: 'POST', body: JSON.stringify({ migrations }) });
          if (Array.isArray(res.migrations) && res.migrations.length) {
            await _migrateRemapLocalStorage(res.migrations);
          }
        }
        if (localOthers.length) {
          showToast('Duplicates', `${localOthers.length} local entr${localOthers.length === 1 ? 'y' : 'ies'} in this group still need manual removal — local manga can't be auto-merged yet.`, 'info');
        }
        await refreshState();
        groupEl.remove();
        showToast('Duplicates', `Merged into "${keep.title}".`, 'success');
      } catch (err) {
        showToast('Error', err.message || 'Could not merge.', 'error');
        btn.disabled = false;
      }
    };
  });
}
