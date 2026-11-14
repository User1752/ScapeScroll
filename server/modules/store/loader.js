'use strict';

// Reads store.json at start-up, and refuses to guess.
//
// The library lives in this one file, and the first debounced flush after
// boot rewrites it from whatever is in memory. So the one thing start-up must
// never do is fall back to an empty store because the file was unreadable or
// unparsable *right now*: that blank store would silently replace the real
// library about 3 s later, with no backup. Realistic triggers are one EBUSY /
// EACCES from an antivirus or a sync client, a transient SMB error (data/
// often lives on a mapped network drive), a file truncated by a sync
// conflict, or a hand edit that left a UTF-8 BOM or a trailing comma.
//
// Outcomes:
//   ENOENT                    -> resolves null: first run, nothing to lose.
//   zero bytes / whitespace   -> resolves {} normalised: nothing left to lose.
//   readable, valid JSON      -> resolves the normalised object (BOM stripped).
//   any other read error      -> throws STORE_UNREADABLE, nothing touched.
//   not a JSON object         -> keeps a byte-faithful copy next to it as
//                                store.json.corrupt-<timestamp> (copied, never
//                                moved or deleted), then throws STORE_CORRUPT.
// Every throw leaves store.json exactly as it was; the caller must not start
// with an empty store and must not write over it (see StorageService).

const { COPYFILE_EXCL } = require('fs').constants;

function storeError(code, message, cause) {
  const err = new Error(message);
  err.code = code;
  if (cause) err.cause = cause;
  return err;
}

// Colons are illegal in Windows file names, so the ISO stamp swaps them out.
function corruptCopyPath(storePath, date) {
  return `${storePath}.corrupt-${date.toISOString().replace(/[:.]/g, '-')}`;
}

function createStoreLoader({ fs, fsp, normalise, now = () => new Date() }) {
  async function loadStoreFile(storePath) {
    let raw;
    try {
      raw = await fsp.readFile(storePath, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw storeError(
        'STORE_UNREADABLE',
        `Cannot read the library file ${storePath} (${(e && (e.code || e.message)) || 'unknown error'}). ` +
          'Nothing was changed. Close any program that may have it open (antivirus, a sync client, ' +
          'another copy of ScrollScape) and start again.',
        e,
      );
    }

    // Same rule as app-root.js readStoreInfo: Notepad and PowerShell 5.1's
    // Out-File / Set-Content -Encoding UTF8 can leave a BOM, which JSON.parse
    // rejects even though the library inside is fine.
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    if (raw.trim() === '') {
      const empty = {};
      normalise(empty);
      return empty;
    }

    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('the top level is not a JSON object');
      }
      normalise(parsed);
      return parsed;
    } catch (e) {
      const aside = corruptCopyPath(storePath, now());
      let kept;
      try {
        fs.copyFileSync(storePath, aside, COPYFILE_EXCL);
        kept = `A copy was kept as ${aside}.`;
      } catch (copyErr) {
        kept = `A copy could NOT be kept (${copyErr.code || copyErr.message}); the original was left untouched.`;
      }
      throw storeError(
        'STORE_CORRUPT',
        `${storePath} is not a valid library file (${e.message}). ${kept} ` +
          'Nothing was overwritten. Restore a backup, or fix or delete store.json, then start again.',
        e,
      );
    }
  }

  return { loadStoreFile };
}

module.exports = { createStoreLoader, corruptCopyPath };
