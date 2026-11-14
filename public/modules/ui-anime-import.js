// ============================================================================
// IMPORT LOCAL (My Anime panel) — imports an Anikku .tachibk backup.
// "Import Local" here does not mean local video files: anime favorites have
// no local-file concept anywhere in this app (streaming is always via a
// remote provider — see server/modules/anime/). The meaningful "import" is
// the reverse of the existing "Export (Anikku)" button
// (_animeExportAnikku, POST-ed to /api/anime/import/anikku, decoded by
// server/modules/anime/anikku-export.js's importAnikkuBackup).
// ============================================================================

let _animeImportFile = null;

function showImportAnikkuModal() {
  document.querySelector('.anime-import-modal')?.remove();
  _animeImportFile = null;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay anime-import-modal';
  modal.innerHTML = `
    <div class="import-modal-box" style="max-width:440px">
      <div class="modal-header">
        <h3>Import Anikku Backup</h3>
        <button class="btn-close-modal" id="closeAnimeImportModal">&times;</button>
      </div>
      <div class="modal-body">
        <p class="setting-description" style="margin-top:0">Pick a <code>.tachibk</code> file exported from Anikku (or a previous "Export (Anikku)" from this app). Aniyomi backups aren't supported here — different, incompatible format.</p>
        <input type="file" id="animeImportFileInput" accept=".tachibk">
        <div id="animeImportFileName" class="hidden muted" style="margin-top:6px;font-size:0.85rem"></div>
        <div id="animeImportError" class="hidden" style="margin-top:8px;color:var(--danger,#e74c3c);font-size:0.85rem"></div>
        <div id="animeImportResult" class="hidden" style="margin-top:10px;font-size:0.85rem"></div>
      </div>
      <div class="modal-footer">
        <button class="btn secondary" id="cancelAnimeImportModal">Cancel</button>
        <button class="btn primary" id="submitAnimeImportBtn" disabled>Import</button>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  modal.querySelector('#closeAnimeImportModal').onclick = () => modal.remove();
  modal.querySelector('#cancelAnimeImportModal').onclick = () => modal.remove();

  const fileInput = modal.querySelector('#animeImportFileInput');
  const submitBtn = modal.querySelector('#submitAnimeImportBtn');
  fileInput.onchange = () => {
    const file = fileInput.files[0];
    _animeImportFile = file || null;
    const nameEl = modal.querySelector('#animeImportFileName');
    if (file) {
      nameEl.textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)`;
      nameEl.classList.remove('hidden');
      submitBtn.disabled = false;
    } else {
      nameEl.classList.add('hidden');
      submitBtn.disabled = true;
    }
  };

  submitBtn.onclick = async () => {
    if (!_animeImportFile) return;
    const errorEl = modal.querySelector('#animeImportError');
    const resultEl = modal.querySelector('#animeImportResult');
    errorEl.classList.add('hidden');
    resultEl.classList.add('hidden');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Importing...';
    try {
      const formData = new FormData();
      formData.append('file', _animeImportFile);
      const resp = await fetch('/api/anime/import/anikku', { method: 'POST', body: formData });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || 'Import failed');

      const unresolvedHtml = data.unresolved?.length
        ? `<div style="margin-top:6px">Couldn't resolve ${data.unresolved.length}: ${data.unresolved.map(escapeHtml).join(', ')}</div>`
        : '';
      resultEl.innerHTML = `<div>Imported ${data.imported}, updated ${data.updated}, skipped ${data.skipped} (of ${data.totalInBackup}).</div>${unresolvedHtml}`;
      resultEl.classList.remove('hidden');

      await renderAnimeLibrary();
      showToast('Import', 'Anikku backup imported.', 'success');
    } catch (err) {
      errorEl.textContent = err.message || 'Import failed.';
      errorEl.classList.remove('hidden');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Import';
    }
  };
}
