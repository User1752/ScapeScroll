'use strict';

const fs = require('fs');
const nodeCrypto = require('crypto');

// A small file left next to a source (data/sources/<id>.js.import.json) that says "this file was put here by an import, and
// this is the file that was imported": its sha256 and when. It is how a source installed from the command line
// (tools/source-lab.js install, which never touches data/store.json, because the app may be running and its own copy of the
// store would overwrite it) is registered as an IMPORTED source the next time the app scans the folder, so the Import card
// lists it with Test and Uninstall like one installed from the card.
//
// The marker only counts while it still matches the file: a file edited by hand afterwards is a plain local source again,
// because what was imported is not what is there. Nothing here throws: a missing, unreadable or malformed marker is "no marker".

const MARKER_SUFFIX = '.import.json';

const markerPathFor = (filePath) => `${filePath}${MARKER_SUFFIX}`;
const sha256OfText = (text) => nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex');

/** Records that `filePath` (whose text is `text`) was imported now. Throws only if the marker cannot be written. */
function writeImportMarker(filePath, text, { now = Date.now, fsImpl = fs } = {}) {
  const marker = { sha256: sha256OfText(text), importedAt: new Date(now()).toISOString() };
  fsImpl.writeFileSync(markerPathFor(filePath), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  return marker;
}

/** The marker of `filePath` when it names the very text now in the file, else null. */
function readValidImportMarker(filePath, { fsImpl = fs } = {}) {
  try {
    const raw = JSON.parse(fsImpl.readFileSync(markerPathFor(filePath), 'utf8'));
    if (!raw || typeof raw !== 'object' || !/^[0-9a-f]{64}$/.test(String(raw.sha256))) return null;
    const current = sha256OfText(fsImpl.readFileSync(filePath, 'utf8'));
    return current === raw.sha256 ? { sha256: raw.sha256, importedAt: Number.isFinite(Date.parse(raw.importedAt)) ? new Date(raw.importedAt).toISOString() : '' } : null;
  } catch (_) {
    return null;
  }
}

/** Removes the marker of `filePath`, if there is one. */
async function removeImportMarker(filePath, { fsImpl = fs } = {}) {
  await fsImpl.promises.unlink(markerPathFor(filePath)).catch(() => {});
}

module.exports = { writeImportMarker, readValidImportMarker, removeImportMarker, markerPathFor, sha256OfText, MARKER_SUFFIX };
