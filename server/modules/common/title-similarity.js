'use strict';

// Shared server-side title-matching logic — previously an inline, non-
// exported closure inside service.js's importAniListLibrary(). Extracted
// so the cover-candidate lookup (server/modules/library/cover-candidate.js)
// can reuse the exact same scoring instead of a second copy-paste, the same
// reasoning ui-duplicates.js's own comment already gives for why this kind
// of "same title, different text" scorer belongs as one shared primitive,
// not one per feature that happens to need it.
//
// Same word-overlap/substring scoring as the client-side scanners
// (public/modules/ui-migrate.js's _titleSimilarity, ui-duplicates.js's
// ported copy) — normalize (lowercase, strip accents/punctuation), exact
// match wins outright, one title containing the other scores high but not
// max, otherwise word-set overlap.

function normalizeTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilarity(a, b) {
  const aa = normalizeTitle(a);
  const bb = normalizeTitle(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) return 0.9;
  const sa = new Set(aa.split(' '));
  const sb = new Set(bb.split(' '));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

module.exports = { normalizeTitle, titleSimilarity };
