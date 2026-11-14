'use strict';

// Normalizes a scraped, free-text publication-status label (e.g. "Releasing",
// "On Hiatus", "Complete") into one of the app's fixed status values. Falls
// back to the original (lowercased) text rather than a generic "unknown" —
// that raw text is what actually reaches the status badge in ui-search.js,
// so an unrecognized label still shows something meaningful instead of
// nothing.
function normalizeStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('ongoing') || s.includes('publishing') || s.includes('releas')) return 'ongoing';
  if (s.includes('complet') || s.includes('finish')) return 'completed';
  if (s.includes('hiatus')) return 'hiatus';
  if (s.includes('cancel')) return 'cancelled';
  return s || 'unknown';
}

// Some scan-aggregator sites reuse the same label/value list layout for
// every field on a manga's page — a title missing a real "Author" entry can
// end up with a status word (e.g. "Updating") landing in that slot instead,
// picked up by a generic label-matching scraper that has no way to know the
// site's own data is wrong. Used both to guard a source's own scrape (blank
// it out rather than display it) and to decide when the AniList author
// fallback (server/modules/anilist/author-fallback.js) should kick in.
const NON_AUTHOR_STATUS_WORDS = new Set([
  'updating', 'ongoing', 'releasing', 'publishing', 'complete', 'completed',
  'finished', 'hiatus', 'on hiatus', 'cancelled', 'canceled', 'dropped',
  'unknown', 'n/a', 'na', 'tbd', '-', '—',
]);

function looksLikeStatusWord(value) {
  const s = String(value || '').trim().toLowerCase();
  return s.length > 0 && NON_AUTHOR_STATUS_WORDS.has(s);
}

module.exports = { normalizeStatus, looksLikeStatusWord };
