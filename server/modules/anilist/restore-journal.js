'use strict';

/**
 * server/modules/anilist/restore-journal.js — the undo record of "Reset AniList statuses from ScrollScape"
 *
 * Before that tool writes anything to the person's AniList, the status each title HAS there is kept here (store.anilistRestoreUndo),
 * so the last reset can be taken back. It holds only AniList ids, titles and statuses, and only the last reset: a new one replaces it.
 * The record comes from the browser, so it is rebuilt field by field: nothing else the client sends is kept.
 */

const STATUSES = Object.freeze(['CURRENT', 'PAUSED', 'COMPLETED', 'DROPPED', 'PLANNING', 'REPEATING']);
const MAX_CHANGES = 2000;
const MAX_TITLE = 200;

function sanitizeRestoreJournal(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = Array.isArray(input.changes) ? input.changes.slice(0, MAX_CHANGES) : [];
  const seen = new Set();
  const changes = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const mediaId = Number(c.mediaId);
    if (!Number.isInteger(mediaId) || mediaId <= 0 || seen.has(mediaId)) continue;
    const from = String(c.from || '').toUpperCase();
    const to = String(c.to || '').toUpperCase();
    if (!STATUSES.includes(from) || !STATUSES.includes(to)) continue;
    seen.add(mediaId);
    changes.push({ mediaId, title: String(c.title || '').slice(0, MAX_TITLE), from, to });
  }
  if (!changes.length) return null;
  const when = new Date(input.createdAt);
  return { createdAt: Number.isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString(), changes };
}

module.exports = { sanitizeRestoreJournal, STATUSES, MAX_CHANGES };
