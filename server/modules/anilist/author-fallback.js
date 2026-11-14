'use strict';

const { withTimeout } = require('../common/async-utils');
const { looksLikeStatusWord } = require('../common/manga-status');
const { titleSimilarity } = require('../common/title-similarity');

// Mirrors description-fallback.js's shape and reasoning: a source's own
// scrape sometimes has nothing useful in the author field — missing
// entirely, or (confirmed live on DemonicScans) a status word that leaked
// into the wrong slot on the site's own page. AniList's staff credits are
// free, already-integrated infra and cover almost anything with a real
// audience, so this fills the gap when the source came back empty or
// visibly wrong. Falls back silently to whatever the source already had
// (even if that's nothing) if AniList has no match or the lookup fails —
// never blocks or breaks the main mangaDetails response over this.

const STAFF_QUERY = `query ($search: String) {
  Media(search: $search, type: MANGA) {
    staff(perPage: 6, sort: RELEVANCE) {
      edges { role node { name { full } } }
    }
  }
}`;

// Prefers the writing credit ("Story", "Original Story", "Story & Art") as
// the single representative name — closest to what "author" conventionally
// means — falling back to whichever credit AniList ranked first (already
// sorted by RELEVANCE) when nothing reads as a writing role. Multiple
// same-tier names (e.g. two co-writers) are joined, not just the first.
//
// A plain exact-string Set only catches literal duplicates, not the same
// real person credited under different name variants — AniList's own staff
// database is community-edited and can carry duplicate/inconsistent name
// records for one person, and its RELEVANCE-sorted staff list has no
// guarantee those duplicates land adjacent to each other. Applying the same
// fix confirmed necessary in a sibling bug: a real manga's own source-level
// authors+artists merge (data/sources/comizy.js, gitignored, not in this
// repo) independently produced "George Morikawa", "Morikawa Jyoji", and
// "Morikawa George" as three separate credits for one mangaka, from the
// exact same exact-string-Set gap. Word-overlap similarity (the same scorer
// already shared for title matching) catches reordered names (they score
// 1.0, identical word sets) and a full-name-as-substring match (0.9)
// without merging two different people. 0.5 — a single shared word, e.g.
// just a surname — is deliberately NOT enough: two distinct real co-authors
// who happen to share a surname score exactly 0.5 too (verified:
// titleSimilarity('Jane Watanabe', 'Ken Watanabe') === 0.5), and unlike
// Cover Scan this result is written straight into the stored favorite with
// no human review, so a merge here has to be conservative — missing an
// occasional true duplicate (shown as two credits instead of one) is a far
// smaller cost than silently deleting a real co-author's credit.
const AUTHOR_DEDUPE_MIN_SIM = 0.75;
function pickAuthorFromStaff(edges) {
  if (!Array.isArray(edges) || edges.length === 0) return null;

  const storyNames = edges
    .filter((e) => /story/i.test(e?.role || '') && e?.node?.name?.full)
    .map((e) => e.node.name.full);
  if (storyNames.length > 0) {
    const unique = [];
    for (const name of storyNames) {
      if (!unique.some((seen) => titleSimilarity(seen, name) >= AUTHOR_DEDUPE_MIN_SIM)) {
        unique.push(name);
      }
    }
    return unique.join(', ');
  }

  const firstName = edges.find((e) => e?.node?.name?.full)?.node?.name?.full;
  return firstName || null;
}

function createAniListAuthorFallback({ proxyAniList }) {
  async function fetchFromAniList(title) {
    try {
      // 25s, not the original 8s — proxy/service.js now serializes every
      // AniList call behind one shared, 2s-per-turn queue (raised from
      // 150ms to survive Cover Scan's own bulk load), so a call made while
      // a bulk caller has a real backlog queued ahead of it can easily
      // wait several seconds for its turn alone, on top of the network
      // round-trip. An 8s budget could time this call out — and silently
      // drop the author it would have found — purely because of queue
      // depth, not because AniList itself was slow or unreachable.
      const { data } = await withTimeout(
        proxyAniList({ query: STAFF_QUERY, variables: { search: title } }),
        25_000,
        'AniList author lookup timeout'
      );
      return pickAuthorFromStaff(data?.data?.Media?.staff?.edges);
    } catch (_) {
      return null; // No match, AniList unreachable, or timed out.
    }
  }

  async function maybeReplaceAuthor(details) {
    const current = String(details?.author || '').trim();
    if (!details?.title) return details;
    if (current && !looksLikeStatusWord(current)) return details;

    const fromAniList = await fetchFromAniList(details.title);
    if (fromAniList) return { ...details, author: fromAniList };

    return details;
  }

  return { maybeReplaceAuthor };
}

module.exports = { createAniListAuthorFallback };
