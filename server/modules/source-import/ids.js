'use strict';

const { safeId } = require('../common/identity');
const { createFailure } = require('./failure');

const IMPORTED = 'imported';
// The virtual sources the library special-cases: 'local' (the Local library, routed before the generic source
// dispatcher), 'anilist' and 'unknown' (what an entry imported from a backup or tracked on AniList carries as its source).
const RESERVED_IDS = new Set(['local', 'anilist', 'unknown']);
// Names Windows keeps for devices: a file called con.js, nul.js or com1.js is the device, not a file.
const WINDOWS_DEVICE_NAME_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// The id a file names for itself: the first `id: '...'` INSIDE its meta object. A genre or filter table with
// `{ id: 'action' }` earlier in the file must not be taken for it.
const META_ID_RE = /(?:\bexports\.meta|\bmeta)\s*[:=]\s*\{[^{}]*?\bid\s*:\s*(['"])([A-Za-z0-9_-]{1,80})\1/;

function suggestId(code) {
  const match = META_ID_RE.exec(code);
  return match ? match[2] : '';
}

/** An id that may be installed as, or a failure saying why not. Never trusted as a path before this. */
function checkId(rawId) {
  const id = safeId(rawId);
  if (!id) throw createFailure('The id may only hold letters, digits, "_" and "-" (1 to 80 characters).');
  if (RESERVED_IDS.has(id.toLowerCase())) throw createFailure(`"${id}" is reserved and cannot be used as a source id.`);
  if (WINDOWS_DEVICE_NAME_RE.test(id)) throw createFailure(`"${id}" is a device name on Windows and cannot be used as a source id.`);
  // "constructor", "toString", "__proto__"... would read an inherited property off the store's plain object.
  if (id in Object.prototype) throw createFailure(`"${id}" is a reserved word and cannot be used as a source id.`);
  return id;
}

/**
 * The id a request asks for: the one typed, else the one the file names in meta. Never throws; a problem is a
 * sentence for the report's blockers.
 */
function chooseId(typed, code) {
  const given = typeof typed === 'string' ? typed.trim() : '';
  const detectedId = suggestId(code);
  const chosen = given || detectedId;
  if (!chosen) {
    return { id: '', idSource: 'none', detectedId, problem: 'No id found: type the id this source should be installed as (it must match meta.id inside the file).' };
  }
  try {
    return { id: checkId(chosen), idSource: given ? 'given' : 'detected', detectedId, problem: '' };
  } catch (err) {
    return { id: '', idSource: 'none', detectedId, problem: err.message };
  }
}

/**
 * Whether `id` can be installed: 'new', 'replaceable' (an earlier import with this tool) or 'blocked' with a reason.
 * A source that is installed another way, a file already in the sources folder, and an id that differs from an
 * installed one only in letter case are all blocked.
 */
function inspectExisting(id, store, { sourcePath, existsSync }) {
  const installed = (store && store.installedSources) || {};
  const clash = Object.keys(installed).find((key) => key !== id && key.toLowerCase() === id.toLowerCase());
  if (clash) {
    return { state: 'blocked', reason: `A source named "${clash}" is already installed and differs from this id only in letter case.` };
  }
  if (Object.hasOwn(installed, id)) {
    const entry = installed[id] || {};
    const info = { installedVia: entry.installedVia || 'bundled', name: entry.name || id, version: String(entry.version || '') };
    if (entry.installedVia === IMPORTED) return { state: 'replaceable', ...info };
    return { state: 'blocked', ...info, reason: 'A source with this id is already installed and was not imported with this tool, so it is not replaced.' };
  }
  let onDisk = false;
  try { onDisk = existsSync(sourcePath(id)); } catch { /* an id sourcePath refuses cannot be on disk */ }
  if (onDisk) return { state: 'blocked', reason: 'A file with this id already exists in the sources folder.' };
  return { state: 'new' };
}

module.exports = { IMPORTED, RESERVED_IDS, suggestId, checkId, chooseId, inspectExisting };
