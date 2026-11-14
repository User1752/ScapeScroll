// ============================================================================
// FULL LIBRARY BACKUP / RESTORE
//
// The app's user data is split across two places: the server-side store
// (library, history, custom lists, achievements, AniList sync stats,
// settings — everything server/routes/backup.js can read) and a handful of
// browser-only localStorage keys (reading progress, per-manga spine/cover
// choices, bookshelf ordering, the AniList link map, purchased-theme cache).
// A useful backup needs both, so this module fetches the server half and
// merges it with a snapshot of the known localStorage keys into one file.
// ============================================================================

// Keep this list in sync whenever a new localStorage key is introduced —
// anything not listed here is silently left out of backups.
const BACKUP_LOCALSTORAGE_KEYS = [
  'bookshelfCustomOrder',
  'genreFilterCollapsed',
  'language',
  'scrollscape_analytics_heatmap_range',
  'scrollscape.libraryCardSettings',
  'scrollscape.librarySpineColors',
  'scrollscape.selectedMangaSpines',
  'scrollscapeChapterCounts',
  'scrollscapeFlaggedChapters',
  'scrollscapeReadChapters',
  'scrollscapeReadingProgress',
  'scrollscapeSettings',
  'scrollscapeTheme',
  'scrollscape_active_theme',
  'scrollscape_al_attempted',
  'scrollscape_al_links',
  'scrollscape_anilist_clientid',
  'scrollscape_anilist_user',
  'scrollscape_ap_bonus',
  'scrollscape_ap_spent',
  'scrollscape_purchased_themes',
  // scrollscape_anilist_token is deliberately excluded: it's a live OAuth
  // credential, not app data, and shouldn't end up in a file the user might
  // store or share. Reconnecting AniList after a restore is one click.
];

async function exportBackup() {
  try {
    const resp = await fetch('/api/backup/export');
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || 'Export failed');

    const localStorageSnapshot = {};
    for (const key of BACKUP_LOCALSTORAGE_KEYS) {
      const val = localStorage.getItem(key);
      if (val !== null) localStorageSnapshot[key] = val;
    }

    const backup = {
      app: 'ScrollScape',
      backupVersion: 1,
      exportedAt: new Date().toISOString(),
      store: data.store,
      localStorage: localStorageSnapshot,
    };

    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scrollscape-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showToast('Backup', 'Backup file downloaded.', 'success');
  } catch (e) {
    dbg.warn(dbg.ERR_SETTINGS, 'Backup export failed', e);
    showToast('Error', `Failed to export backup: ${e.message}`, 'error');
  }
}

function _csvCell(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Human-readable spreadsheet export — distinct from exportBackup() (a JSON
// restore file) and exportMihonBackupFile() (for other apps): this one is
// for opening in Excel/Sheets/Numbers to sort, filter or archive the list.
function exportLibraryCsv() {
  try {
    const favs = (state.favorites || []).filter((m) => m && m.id && (m.title || m.name));
    // state.readChapters (per-chapter "flagged read" markers) is not a
    // reliable progress signal — most libraries never populate it densely
    // (imports/AniList sync set status and position, not per-chapter flags).
    // state.history has one upserted entry per manga with the real last-read
    // chapter and timestamp, matching what "Continue Reading" shows.
    const historyMap = new Map((state.history || []).map((h) => [h.id, h]));
    const sourceName = (m) => {
      const sid = m.sourceId || '';
      if (sid === 'local') return 'Local';
      return state.installedSources[sid]?.name || sid || 'Unknown';
    };

    const header = ['Title', 'Source', 'Status', 'Last Read Chapter', 'Total Chapters', 'Last Read Date', 'Tags', 'AniList ID'];
    const rows = favs.map((m) => {
      const status = state.readingStatus[_libStatusKey(m.id, m.sourceId)]?.status || '';
      const totalChapters = Number(m.lastKnownChapterCount) || Number(state.chapterCountCache?.[m.id]) || '';
      const tags = getMangaTags(m.id, m.sourceId).join('; ');
      const hist = historyMap.get(m.id);
      return [
        m.title || m.name || '', sourceName(m), status,
        hist?.chapterName || '', totalChapters, hist?.readAt ? hist.readAt.slice(0, 10) : '',
        tags, m.anilistId || '',
      ];
    });

    const csv = [header, ...rows].map((r) => r.map(_csvCell).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scrollscape-library-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showToast('Export', `Exported ${favs.length} manga to CSV.`, 'success');
  } catch (e) {
    dbg.warn(dbg.ERR_SETTINGS, 'CSV export failed', e);
    showToast('Error', `Failed to export CSV: ${e.message}`, 'error');
  }
}

async function importBackupFile(file) {
  try {
    const text = await file.text();
    let backup;
    try {
      backup = JSON.parse(text);
    } catch (_) {
      throw new Error('That file is not valid JSON.');
    }
    if (!backup || typeof backup !== 'object' || !backup.store || typeof backup.store !== 'object') {
      throw new Error('That file does not look like a ScrollScape backup.');
    }

    const favCount     = Array.isArray(backup.store.favorites)    ? backup.store.favorites.length    : 0;
    const listCount    = Array.isArray(backup.store.customLists)  ? backup.store.customLists.length  : 0;
    const historyCount = Array.isArray(backup.store.history)      ? backup.store.history.length      : 0;
    const exportedAt   = backup.exportedAt ? new Date(backup.exportedAt).toLocaleString() : 'an unknown date';

    const confirmed = confirm(
      `This backup was exported on ${exportedAt} and contains ${favCount} library manga, ` +
      `${listCount} custom lists and ${historyCount} history entries.\n\n` +
      `Restoring will REPLACE your current library, settings and history. This cannot be undone. Continue?`
    );
    if (!confirmed) return;

    const resp = await fetch('/api/backup/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store: backup.store }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || 'Import failed');

    if (backup.localStorage && typeof backup.localStorage === 'object') {
      for (const key of BACKUP_LOCALSTORAGE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(backup.localStorage, key)) {
          localStorage.setItem(key, backup.localStorage[key]);
        }
      }
    }

    // The progress that came with the file is what the person restored: on the next start it replaces the server's copy.
    if (backup.localStorage && Object.prototype.hasOwnProperty.call(backup.localStorage, 'scrollscapeReadChapters') && typeof progressSyncForceUploadOnNextStart === 'function') {
      progressSyncForceUploadOnNextStart();
    }

    showToast('Backup', 'Library restored. Reloading...', 'success');
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    dbg.warn(dbg.ERR_SETTINGS, 'Backup import failed', e);
    showToast('Error', `Failed to import backup: ${e.message}`, 'error');
  }
}

async function importMihonBackupFile(file) {
  const confirmed = confirm(
    `Import "${file.name}" from Tachiyomi/Mihon/Komikku?\n\n` +
    `This ADDS to your current library (won't remove anything). Manga you already have ` +
    `here (matched by exact title) get their reading status/categories merged in rather ` +
    `than duplicated. Anything new from a source ScrollScape doesn't recognise imports as ` +
    `metadata only — use Migrate afterward to re-link it. Continue?`
  );
  if (!confirmed) return;

  try {
    const formData = new FormData();
    formData.append('file', file);

    const resp = await fetch('/api/import/mihon', { method: 'POST', body: formData });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || 'Import failed');

    showToast(
      'Tachiyomi/Mihon/Komikku Import',
      `Imported ${data.imported} of ${data.totalInBackup} manga` +
      (data.matchedExisting ? ` (${data.matchedExisting} merged into manga you already had)` : '') +
      (data.unresolvedSource ? ` (${data.unresolvedSource} as metadata-only — use Migrate to re-link)` : '') +
      (data.categoriesCreated ? `. Created ${data.categoriesCreated} new categories.` : '.'),
      'success'
    );
    await refreshState();
  } catch (e) {
    dbg.warn(dbg.ERR_SETTINGS, 'Mihon import failed', e);
    showToast('Error', `Failed to import Tachiyomi/Mihon/Komikku backup: ${e.message}`, 'error');
  }
}

async function exportMihonBackupFile() {
  try {
    // Per-chapter read state only ever lived in this browser's own
    // localStorage (state.readChapters) — the server has no copy of it to
    // build from on its own, so it has to be sent along with the request.
    const readChapters = [...(state.readChapters || [])];

    const resp = await fetch('/api/export/mihon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ readChapters }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Export failed (HTTP ${resp.status})`);
    }

    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scrollscape-library-${new Date().toISOString().slice(0, 10)}.tachibk`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showToast('Tachiyomi/Mihon/Komikku Export', 'Library exported. Import the downloaded .tachibk file from that app\'s own backup/restore screen.', 'success');
  } catch (e) {
    dbg.warn(dbg.ERR_SETTINGS, 'Mihon export failed', e);
    showToast('Error', `Failed to export Tachiyomi/Mihon/Komikku backup: ${e.message}`, 'error');
  }
}
