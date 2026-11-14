'use strict';

// "Updates" section support (manga side — see server/modules/anime's
// equivalent for anime episodes). Detects when a favorite's chapter count
// has grown since the last time it was checked, without flooding the
// Updates feed the first time this ships for an existing library: a
// favorite with no prior lastKnownChapterCount just gets a baseline
// recorded, not flagged as "new" — there's no real "last check" to compare
// against yet, so there's nothing legitimately "new" to report.
function checkMangaChapterCount(fav, currentCount) {
  const hadBaseline = Number.isFinite(fav?.lastKnownChapterCount);
  const previous = hadBaseline ? fav.lastKnownChapterCount : currentCount;
  const isUpdate = hadBaseline && currentCount > previous;
  return {
    isUpdate,
    newChapters: isUpdate ? currentCount - previous : 0,
    lastKnownChapterCount: currentCount,
  };
}

// How many past "a new chapter actually appeared" timestamps to remember per
// favorite, purely to estimate that title's real release cadence — not a
// full history feature, just enough points for a stable average (a manga
// that drops 3 chapters at once still only logs one entry here, since this
// fires once per detected update, not once per new chapter).
const UPDATE_HISTORY_MAX_ENTRIES = 8;
const UPDATE_HISTORY_MIN_ENTRIES_FOR_PREDICTION = 2;

function recordUpdateHistoryEntry(fav, whenIso) {
  const history = Array.isArray(fav.updateHistory) ? fav.updateHistory.slice() : [];
  history.push(whenIso);
  if (history.length > UPDATE_HISTORY_MAX_ENTRIES) {
    history.splice(0, history.length - UPDATE_HISTORY_MAX_ENTRIES);
  }
  return history;
}

// The "Smart Update" idea from Mihon's own scheduler: instead of checking
// every favorite on the same flat cooldown regardless of how often it
// actually releases, estimate a per-title interval from its own real
// release history, and only start re-checking a bit before that interval
// has elapsed since the last detected update. A weekly-release title stops
// costing a request every few hours for nothing; a title with no history
// yet (new favorite, or fewer than two detected updates so far) simply
// returns null and the caller falls back to whatever flat cooldown it
// already used before this existed — there's nothing to predict from yet.
//
// LOOKAHEAD_BUFFER_DAYS starts the check window slightly before the
// predicted date rather than exactly on it, so a title releasing a little
// early isn't missed until the following sweep.
const LOOKAHEAD_BUFFER_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

function predictNextCheckWindow(history) {
  const times = (Array.isArray(history) ? history : [])
    .map((iso) => new Date(iso).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length < UPDATE_HISTORY_MIN_ENTRIES_FOR_PREDICTION) return null;

  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const avgIntervalMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (!Number.isFinite(avgIntervalMs) || avgIntervalMs <= 0) return null;

  const lastDetectedAt = times[times.length - 1];
  const windowStartMs = lastDetectedAt + avgIntervalMs - (LOOKAHEAD_BUFFER_DAYS * DAY_MS);
  return {
    intervalDays: Math.round((avgIntervalMs / DAY_MS) * 10) / 10,
    windowStartMs,
  };
}

module.exports = {
  checkMangaChapterCount,
  recordUpdateHistoryEntry,
  predictNextCheckWindow,
};
