// ============================================================================
// COVER SCAN
// Finds manga with a missing or under-quality cover and offers an AniList
// candidate for each — reviewed and applied manually, same "nothing changes
// without you picking it" shape as Migrate, never automatic. The write path
// (POST /api/library/cover) is the exact one the manual cover-picker
// (ui-cover-picker.js) already uses; this only adds the discovery/review
// step in front of it.
// ============================================================================

const COVER_SCAN_CONCURRENCY = 4;

function _coverScanEligibleFavorites() {
  // Anime has its own separate cover-override mechanism; local manga has no
  // AniList-comparable identity to search for.
  return (state.favorites || []).filter((m) => m && m.id && m.sourceId && m.sourceId !== 'local');
}

function _coverScanSourceName(sourceId) {
  const sid = sourceId || '';
  if (!sid) return 'No source';
  if (sid === 'anilist') return 'AniList';
  if (sid === 'local') return 'Local';
  return state.installedSources[sid]?.name || sid;
}

function _coverScanMatchLabel(matchType) {
  if (matchType === 'source-original') return { text: 'Original (same source)', color: 'var(--color-success)' };
  if (matchType === 'exact') return { text: 'AniList (linked)', color: 'var(--color-success)' };
  return { text: 'AniList (matched)', color: 'var(--text-muted)' };
}

// Two covers can share the exact same artwork (a source's own thumbnail vs
// its original) and render visually identical at review-thumbnail size
// despite a large resolution gap — confirmed live with a real 256x364 vs
// 1800x2560 pair that looked like "nothing changed" side by side. Showing
// the real pixel dimensions makes that difference legible even when the
// crop looks the same.
function _coverScanDimsLabel(dims) {
  return dims?.width && dims?.height ? `${dims.width}×${dims.height}px` : '';
}

async function showCoverScanModal() {
  const favorites = _coverScanEligibleFavorites();

  const modal = document.createElement('div');
  modal.className = 'settings-modal cover-scan-modal';
  modal.innerHTML = `
    <div class="settings-content" style="width:min(97vw, 1560px);max-width:1560px;max-height:94vh">
      <div class="settings-header">
        <h2 style="font-size:1.4rem">Cover Scan</h2>
        <div style="display:flex;align-items:center;gap:0.75rem">
          <span id="coverScanCorner" style="font-size:0.85rem;color:var(--text-muted)">Scanning… 0/${favorites.length}</span>
          <button class="btn secondary" id="coverScanClose">&#x2715;</button>
        </div>
      </div>
      <div class="settings-body" style="padding-bottom:0">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:0.75rem">
          <p style="font-size:0.95rem;color:var(--text-muted);margin:0">Only manga with a missing or low-quality cover show up here — nothing is pre-selected, pick what to apply.</p>
          <button class="btn secondary" id="coverScanSelectAll" style="white-space:nowrap;padding:6px 14px;font-size:0.85rem">Select All</button>
        </div>
        <div style="display:flex;gap:1.25rem;align-items:flex-start">
          <div id="coverScanRows" style="flex:1;min-width:0;min-height:55vh;max-height:78vh;overflow-y:auto;border:1px solid color-mix(in srgb, var(--primary) 16%, transparent);border-radius:10px">
            <p id="coverScanEmptyHint" class="muted" style="text-align:center;margin:2rem 0">Scanning…</p>
          </div>
          <div id="coverScanPreviewPane" style="width:400px;flex-shrink:0;position:sticky;top:0">
            <p style="font-size:0.8rem;color:var(--text-muted);text-align:center;margin:0 0 0.6rem;text-transform:uppercase;letter-spacing:0.04em">Preview</p>
            <div id="coverScanPreviewCard"></div>
          </div>
        </div>
      </div>
      <div style="padding:0.9rem 1.2rem;border-top:1px solid color-mix(in srgb, var(--primary) 15%, transparent);display:flex;justify-content:space-between;align-items:center">
        <span id="coverScanChoiceCount" style="font-size:1rem;color:var(--text-muted)">0 selected</span>
        <button class="btn primary" id="coverScanApply" disabled>Apply Selected</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.getElementById('coverScanClose').onclick = () => modal.remove();

  if (!favorites.length) {
    document.getElementById('coverScanEmptyHint').textContent = 'No manga in your library.';
    return;
  }

  const rowsContainer = document.getElementById('coverScanRows');
  const cornerEl = document.getElementById('coverScanCorner');
  const previewCardEl = document.getElementById('coverScanPreviewCard');
  const selected = new Map(); // rowKey -> { mangaId, sourceId, cover }
  const rowKeyFor = (m) => `${m.id}::${m.sourceId}`;

  const updateChoiceCount = () => {
    const n = selected.size;
    document.getElementById('coverScanChoiceCount').textContent = `${n} selected`;
    document.getElementById('coverScanApply').disabled = n === 0;
  };

  document.getElementById('coverScanSelectAll').onclick = () => {
    const boxes = [...rowsContainer.querySelectorAll('.cover-scan-chk')];
    const allChecked = boxes.length > 0 && boxes.every((c) => c.checked);
    boxes.forEach((chk) => {
      chk.checked = !allChecked;
      chk.onchange();
    });
  };

  // Renders the exact library.css .library-card markup (same classes the
  // real Library grid uses) with the candidate cover swapped in, so this is
  // a real preview of how the card will actually look — not a mockup — and
  // the user can judge the image on its own before deciding to apply it.
  function showPreview(manga, candidateCover, matchType, chk, currentDims, candidateDims) {
    const sourceName = _coverScanSourceName(manga.sourceId);
    const matchLabel = _coverScanMatchLabel(matchType);
    const curLabel = _coverScanDimsLabel(currentDims);
    const candLabel = _coverScanDimsLabel(candidateDims);
    const dimsLine = (curLabel || candLabel)
      ? `<p style="font-size:0.8rem;color:var(--text-muted);text-align:center;margin:0.5rem 0 0">${curLabel ? `Current: ${curLabel}` : ''}${curLabel && candLabel ? ' → ' : ''}${candLabel ? `<span style="color:var(--color-success)">${candLabel}</span>` : ''}</p>`
      : '';
    previewCardEl.innerHTML = `
      <div class="library-card" style="height:auto;cursor:default">
        <div class="library-card-cover">
          <img src="${escapeHtml(normalizeImageUrl(candidateCover))}" alt="${escapeHtml(manga.title || '')}" loading="lazy">
          <span class="library-source-badge" style="font-size:0.8rem;padding:0.3rem 0.7rem">${escapeHtml(sourceName)}</span>
        </div>
        <div class="library-card-info">
          <h3 class="library-card-title" style="font-size:1.15rem">${escapeHtml(manga.title || manga.id)}</h3>
          <p class="library-card-author" style="font-size:0.85rem;color:${matchLabel.color}">${matchLabel.text}</p>
        </div>
      </div>
      ${dimsLine}
      <label style="display:flex;align-items:center;justify-content:center;gap:0.5rem;margin-top:0.6rem;font-size:1rem;font-weight:600;cursor:pointer">
        <input type="checkbox" id="coverScanPreviewChk" style="width:20px;height:20px;cursor:pointer">
        Use this cover
      </label>`;
    const previewChk = document.getElementById('coverScanPreviewChk');
    previewChk.checked = chk.checked;
    previewChk.onchange = () => {
      chk.checked = previewChk.checked;
      chk.dispatchEvent(new Event('change'));
    };
  }

  const appendRow = (manga, candidateCover, matchType, currentDims, candidateDims) => {
    document.getElementById('coverScanEmptyHint')?.remove();
    const rowKey = rowKeyFor(manga);
    const matchLabel = _coverScanMatchLabel(matchType);
    const curDimsLabel = _coverScanDimsLabel(currentDims);
    const candDimsLabel = _coverScanDimsLabel(candidateDims);
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="cover-scan-row" style="display:flex;align-items:center;gap:1.25rem;padding:1.1rem;border-bottom:1px solid color-mix(in srgb, var(--primary) 8%, transparent);cursor:pointer;transition:background 0.15s">
        <input type="checkbox" class="cover-scan-chk" style="width:22px;height:22px;flex-shrink:0;cursor:pointer">
        <div style="width:190px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:0.35rem">
          ${manga.cover
            ? `<img class="cover-scan-current-img" src="${escapeHtml(normalizeImageUrl(manga.cover))}" style="width:110px;height:156px;object-fit:cover;border-radius:8px;border:2px solid transparent" loading="lazy" onerror="this.style.display='none'">`
            : '<div style="width:110px;height:156px;border-radius:8px;background:var(--bg-tertiary);display:flex;align-items:center;justify-content:center;color:var(--text-muted);font-size:1.8rem">?</div>'}
          <span style="font-size:0.82rem;color:var(--text-muted)">Current${curDimsLabel ? ` · ${curDimsLabel}` : ''}</span>
        </div>
        <span style="font-size:1.6rem;color:var(--text-muted);flex-shrink:0">&rarr;</span>
        <div style="width:190px;flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:0.35rem">
          <img class="cover-scan-candidate-img" src="${escapeHtml(normalizeImageUrl(candidateCover))}" style="width:110px;height:156px;object-fit:cover;border-radius:8px;border:2px solid transparent" loading="lazy">
          <span style="font-size:0.82rem;color:${matchLabel.color}">${matchLabel.text}${candDimsLabel ? ` · ${candDimsLabel}` : ''}</span>
        </div>
        <span style="font-size:1.1rem;font-weight:600;overflow-wrap:anywhere;flex:1">${escapeHtml(manga.title || manga.id)}</span>
      </div>`;
    const rowEl = wrap.firstElementChild;
    rowsContainer.appendChild(rowEl);
    const chk = rowEl.querySelector('.cover-scan-chk');
    const candidateImg = rowEl.querySelector('.cover-scan-candidate-img');

    const syncSelectedLook = () => {
      rowEl.style.background = chk.checked ? 'color-mix(in srgb, var(--color-success) 12%, transparent)' : '';
      candidateImg.style.borderColor = chk.checked ? 'var(--color-success)' : 'transparent';
      // Keep the preview panel's own checkbox in sync when its row is the
      // one currently shown there (e.g. toggled from the row itself while
      // already being previewed).
      const previewChk = document.getElementById('coverScanPreviewChk');
      if (previewChk && previewCardEl.dataset.rowKey === rowKey) previewChk.checked = chk.checked;
    };
    chk.onchange = () => {
      if (chk.checked) selected.set(rowKey, { mangaId: manga.id, sourceId: manga.sourceId, cover: candidateCover });
      else selected.delete(rowKey);
      updateChoiceCount();
      syncSelectedLook();
    };
    // Clicking anywhere on the row (the covers especially — the checkbox
    // alone is a small target next to images this size) toggles the same
    // selection the checkbox does, so picking a row is a one-click action.
    rowEl.onclick = (e) => {
      if (e.target === chk) return; // checkbox already handles its own click
      chk.checked = !chk.checked;
      chk.dispatchEvent(new Event('change'));
    };
    // Hovering (not just clicking) shows the real card preview on the right
    // — a non-committal way to look closely at the candidate before
    // deciding whether to check the row at all.
    rowEl.addEventListener('mouseenter', () => {
      previewCardEl.dataset.rowKey = rowKey;
      showPreview(manga, candidateCover, matchType, chk, currentDims, candidateDims);
    });
  };

  // AniList's own rate limit turned out to be the binding constraint here —
  // confirmed live that a library with ~60 favorites genuinely needing a
  // better cover trips it well before the pass finishes, even with the
  // 150ms global request spacing proxy/service.js already enforces for
  // every AniList call app-wide. Rather than silently drop those rows (the
  // bug this whole anilistUnavailable plumbing exists to fix) or force a
  // full library re-scan just to recheck a handful, skipped favorites are
  // kept around so "Retry Skipped" can recheck only those once AniList's
  // cooldown clears, without re-touching titles already resolved.
  let skipNoteWrap = null;

  function renderSkipNote(skippedFavorites) {
    skipNoteWrap?.remove();
    skipNoteWrap = null;
    if (!skippedFavorites.length) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'text-align:center;padding:0.6rem 0 0;display:flex;flex-direction:column;align-items:center;gap:0.4rem';
    wrap.innerHTML = `
      <p class="muted" style="font-size:0.8rem;margin:0;color:var(--color-warning, #e0a030)">${skippedFavorites.length} manga couldn't be checked — AniList was unavailable/rate-limited.</p>
      <button class="btn secondary" id="coverScanRetrySkipped" style="padding:4px 12px;font-size:0.8rem">Retry Skipped (${skippedFavorites.length})</button>`;
    // rowsContainer itself is a flex item (sitting next to the 400px-wide
    // preview pane) — inserting after ITS parent instead places this banner
    // as a full-width block below both, matching its centered-column CSS,
    // rather than squeezed in as a third item in that same flex row.
    rowsContainer.parentElement.after(wrap);
    skipNoteWrap = wrap;
    // Disables itself on click (unlike a re-enable, which isn't needed —
    // a finished retry pass either removes this button via the empty-list
    // check above, or renderSkipNote replaces it with a fresh one) so a
    // double-click can't launch two concurrent runScan() passes over the
    // same skipped list, which would append duplicate rows for any manga
    // both passes resolve.
    document.getElementById('coverScanRetrySkipped').onclick = (e) => {
      e.currentTarget.disabled = true;
      runScan(skippedFavorites, true);
    };
  }

  async function runScan(list, isRetry) {
    let done = 0;
    let cursor = 0;
    const skipped = [];
    const setProgress = () => {
      cornerEl.textContent = done < list.length
        ? `${isRetry ? 'Rechecking' : 'Scanning'}… ${done}/${list.length}`
        : `Done — ${list.length} ${isRetry ? 'rechecked' : 'checked'}`;
    };
    setProgress();

    async function worker() {
      while (cursor < list.length) {
        const manga = list[cursor++];
        try {
          const result = await api('/api/library/cover-candidate', {
            method: 'POST',
            body: JSON.stringify({ mangaId: manga.id, sourceId: manga.sourceId }),
          });
          if (result.needsUpgrade && result.candidateCover) {
            appendRow(manga, result.candidateCover, result.matchType, result.currentDims, result.candidateDims);
          } else if (result.needsUpgrade && result.anilistUnavailable) {
            skipped.push(manga);
          }
        } catch (_) {
          // One bad manga (network hiccup, no AniList match) never stops the rest of the scan.
        }
        done++;
        setProgress();
      }
    }
    await Promise.all(Array.from({ length: Math.min(COVER_SCAN_CONCURRENCY, list.length) }, worker));
    renderSkipNote(skipped);

    if (!rowsContainer.querySelector('.cover-scan-row')) {
      rowsContainer.innerHTML = '<p id="coverScanEmptyHint" class="muted" style="text-align:center;margin:2rem 0">No cover issues found.</p>';
    } else if (!previewCardEl.innerHTML) {
      // Nothing hovered yet — preview the first row by default so the panel
      // isn't just an empty gap on modal open.
      rowsContainer.querySelector('.cover-scan-row').dispatchEvent(new Event('mouseenter'));
    }
  }

  // Wired before the scan runs, not after — rows (with working checkboxes)
  // start appearing via appendRow the moment the scan's worker pool finds
  // its first candidate, well before the whole scan finishes, so the
  // button can already be enabled and clicked mid-scan. Attaching the
  // handler only after `await runScan(...)` resolves left an early click
  // silently swallowed (no handler yet, no error, no feedback) until the
  // scan finally finished.
  document.getElementById('coverScanApply').onclick = async () => {
    const btn = document.getElementById('coverScanApply');
    btn.disabled = true;
    btn.textContent = 'Applying…';

    let applied = 0, failed = 0;
    for (const { mangaId, sourceId, cover } of selected.values()) {
      try {
        await api('/api/library/cover', {
          method: 'POST',
          body: JSON.stringify({ mangaId, sourceId, cover }),
        });
        applied++;
      } catch (_) {
        failed++;
      }
    }

    try {
      const libData = await api('/api/library');
      state.favorites = libData.favorites || state.favorites;
      state.history = libData.history || state.history;
      state.coverOverrides = libData.coverOverrides || state.coverOverrides;
    } catch (_) { /* covers already applied server-side even if this refresh fails */ }
    if (typeof renderLibrary === 'function') renderLibrary();

    showToast('Cover Scan', `${applied} cover(s) updated${failed ? `, ${failed} failed` : ''}.`, failed ? 'warning' : 'success');
    modal.remove();
  };

  await runScan(favorites, false);
}
window.showCoverScanModal = showCoverScanModal;
