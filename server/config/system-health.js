'use strict';

const REQUIRED_STORE_KEYS = [
  'repos',
  'installedSources',
  'history',
  'favorites',
  'readingStatus',
  'reviews',
  'customLists',
  'achievements',
  'anilistSync',
  'analytics',
];

// Only files the app actually expects to find on real user disk
// (DATA_DIR) — store.json/error-log.json are read AND written there at
// runtime. achievements.json is a static, bundled reference file
// (pkg.assets) the app reads straight from the snapshot via a
// server.js-computed __dirname-based path — never copied to DATA_DIR, by
// design, so it was never reachable at this check's path and always
// reported as "missing" even on a perfectly healthy install.
// icon-mapping.json isn't read by any current code path at all (confirmed
// via a repo-wide search) — a leftover from an earlier icon system,
// checking for it doesn't validate anything real. Both used to be
// silently masked by a since-fixed bug in server/routes/system-health.js
// that pointed this whole check at the pkg snapshot instead of DATA_DIR
// (achievements.json happened to "pass" there only because it's a
// snapshot-readable asset) — fixing that bug is what surfaced these two
// as false "missing" reports, which is why they're removed here instead.
const REQUIRED_DATA_FILES = [
  'store.json',
  'error-log.json',
];

// How long an error-log entry keeps counting as "recent" for the source
// health warnings. error-log.json is only ever trimmed by count (50 entries)
// or by the manual "Clear Logs" button, so without a window a single
// long-gone upstream blip (confirmed live: an AllManga rate limit from five
// weeks earlier, on a source that was passing every live probe) held the
// whole page at "warning" forever. A source that is STILL failing shows up
// in the live probes regardless, so ageing out old log entries hides nothing
// current.
const RECENT_SOURCE_ERROR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// The same reasoning one step further: the records of a source that PASSES its live probe now stop counting
// once they are older than this. Seen live: MangaHub's "curl exit ENOENT" records of one night, after the cause
// was fixed and the source passed every probe, still held the whole page at "warning" for the rest of the 7
// days. A source that flaps (a failure a few hours ago) keeps counting; one that does not pass keeps every
// record of the window.
const RECOVERED_SOURCE_ERROR_AFTER_MS = 12 * 60 * 60 * 1000;

// ...but only for the calls the live probe really exercises: search (or healthCheck()) and the listing calls that
// reach the site the same way. A passing probe says nothing about chapters(), pages() or the details of a title,
// so a record of those keeps its whole window. The method is read from the record's own request path
// (/api/source/<id>/<method>); a record with no such path is never dropped.
const PROBE_COVERED_SOURCE_METHODS = new Set([
  'search', 'authorSearch', 'trending', 'popularAllTime', 'recentlyAdded', 'latestUpdates', 'byGenres',
]);

const MODULE_DEFINITIONS = [
  { id: 'discover', label: 'Discover', kind: 'frontend-file', relPath: 'public/modules/ui-discover.js' },
  { id: 'sources', label: 'Sources', kind: 'backend-route', relPath: 'server/routes/sources.js' },
  { id: 'library', label: 'Library', kind: 'backend-route', relPath: 'server/routes/library.js' },
  { id: 'local', label: 'Local Import', kind: 'backend-route', relPath: 'server/routes/local.js' },
  { id: 'downloads', label: 'Downloads', kind: 'backend-route', relPath: 'server/routes/downloads.js' },
  { id: 'analytics', label: 'Analytics', kind: 'backend-route', relPath: 'server/routes/analytics.js' },
  { id: 'history', label: 'History', kind: 'frontend-file', relPath: 'public/modules/ui-history.js' },
  { id: 'achievements', label: 'Achievements', kind: 'backend-route', relPath: 'server/routes/achievements.js' },
  { id: 'calendar', label: 'Calendar', kind: 'backend-route', relPath: 'server/routes/calendar.js' },
  { id: 'lists', label: 'Custom Lists', kind: 'backend-route', relPath: 'server/routes/lists.js' },
  { id: 'reviews', label: 'Reviews', kind: 'backend-route', relPath: 'server/routes/reviews.js' },
  { id: 'themePresets', label: 'Theme Presets', kind: 'backend-route', relPath: 'server/routes/theme-presets.js' },
  { id: 'coverSearch', label: 'Cover Search', kind: 'backend-route', relPath: 'server/routes/cover-search.js' },
  { id: 'mangaupdates', label: 'MangaUpdates', kind: 'backend-route', relPath: 'server/routes/mangaupdates.js' },
  { id: 'sourceHealth', label: 'Source Health', kind: 'backend-route', relPath: 'server/routes/health-check.js' },
];

const SOURCE_ERROR_TYPES = [
  {
    code: 'error-1',
    key: 'api_error',
    label: 'API error',
    patterns: ['api', 'http 500', 'http 502', 'http 503', 'gateway', 'service unavailable'],
    suggestedAction: 'Check endpoint availability and response codes.',
  },
  {
    code: 'error-2',
    key: 'site_maintenance',
    label: 'Site in maintenance',
    patterns: ['maintenance', 'manutencao', 'manutenção', 'temporarily unavailable', 'site down'],
    suggestedAction: 'Wait and retry later; avoid aggressive retries.',
  },
  {
    code: 'error-3',
    key: 'cloudflare_or_challenge',
    label: 'Cloudflare/challenge block',
    patterns: ['cloudflare', 'challenge', 'captcha', 'checking your browser'],
    suggestedAction: 'Adjust scraper strategy and headers; keep read-only fallback.',
  },
  {
    code: 'error-4',
    key: 'timeout_or_network',
    label: 'Timeout/network error',
    patterns: ['timeout', 'timed out', 'etimedout', 'econnreset', 'network error'],
    suggestedAction: 'Increase resilience and retry/backoff policy.',
  },
  {
    code: 'error-5',
    key: 'contract_or_parse',
    label: 'Parser/contract break',
    // 'listing returned no results' catches batcave.js's own healthCheck()
    // message (confirmed live: it was falling through to the generic
    // "Unknown error" bucket, which gives zero direction for a case that's
    // always the same fixed, recurring string). It fires only when a
    // fetch succeeded (no thrown/network error) but the listing parsed to
    // zero items — an otherwise-successful fetch parsing to nothing is
    // exactly this bucket's case (selector no longer matches current
    // markup, or an unrecognized challenge/interstitial slipped through
    // undetected). Deliberately narrower than a bare 'no results' would be
    // — that also matches unrelated, benign "no results for this specific
    // query" messages from several anime sources and image-quality-health.js's
    // own deliberately-ambiguous sample-pool message, which are normal empty
    // searches, not parser breaks, and must not be reclassified as one.
    patterns: ['did not return', 'missing', 'invalid', 'unexpected', 'parse', 'json', 'listing returned no results'],
    suggestedAction: 'Update source parser to match current site/API structure.',
  },
  {
    code: 'error-6',
    key: 'rate_limit',
    label: 'Rate limit',
    // 'limitar pedidos' catches a source's own Portuguese rate-limit
    // message (confirmed live: it was falling through to the generic
    // "Unknown error" bucket and suggesting "inspect raw logs" for what is
    // actually just the source's own expected, self-recovering throttle).
    // 'rate-limited' (hyphenated) catches the shared per-host cooldown
    // wording used by fetch-utils.js/proxy/service.js/cover-search's
    // "<host> is rate-limited, cooling down" fast-fail message — confirmed
    // live it was falling into the same "Unknown error" bucket as above
    // because it never contains the space-separated "rate limit" phrase.
    patterns: ['429', 'rate limit', 'rate-limited', 'too many requests', 'limitar pedidos'],
    suggestedAction: 'Throttle requests and increase cooldown between calls.',
  },
  {
    code: 'error-99',
    key: 'unknown',
    label: 'Unknown error',
    patterns: [],
    suggestedAction: 'Inspect raw logs and source module output for root cause.',
  },
];

module.exports = {
  REQUIRED_STORE_KEYS,
  REQUIRED_DATA_FILES,
  RECENT_SOURCE_ERROR_WINDOW_MS,
  RECOVERED_SOURCE_ERROR_AFTER_MS,
  PROBE_COVERED_SOURCE_METHODS,
  MODULE_DEFINITIONS,
  SOURCE_ERROR_TYPES,
};
