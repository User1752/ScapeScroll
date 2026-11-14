'use strict';

const { dayKeyOf, recordMangaSession, recordAnimeEntry } = require('./ledger');
const { computeWrapped } = require('./wrapped');

function createAnalyticsService({ readStore, writeStore }) {
  async function getAnalytics() {
    const store = await readStore();

    const dist = { reading: 0, completed: 0, on_hold: 0, plan_to_read: 0, dropped: 0 };
    for (const s of Object.values(store.readingStatus)) {
      if (dist[s.status] !== undefined) dist[s.status]++;
    }

    let ratingSum = 0;
    let ratingCount = 0;
    let totalReviews = 0;
    for (const arr of Object.values(store.reviews)) {
      totalReviews += arr.length;
      const r = arr[0]?.rating;
      if (typeof r === 'number' && r > 0) {
        ratingSum += r;
        ratingCount++;
      }
    }

    const meanScore = ratingCount ? Math.round((ratingSum / ratingCount) * 100) / 100 : null;

    return {
      analytics: store.analytics,
      statusDistribution: dist,
      totalFavorites: store.favorites.length,
      totalReviews,
      totalLists: store.customLists.length,
      meanScore,
    };
  }

  // Shared by recordSession (chapters) and recordAnimeSession (episodes):
  // totalTimeSpent/dailyStreak/lastReadDate/dailyChapterCounts are
  // genuinely medium-agnostic "engaged with the library today" signals —
  // bumping them from one place keeps the day-boundary/streak math
  // identical for both instead of two copies drifting apart.
  function _bumpDailyActivity(a, { minutes, activityCount }) {
    a.totalTimeSpent = (a.totalTimeSpent || 0) + minutes;

    const now = new Date();
    const todayStr = now.toDateString();
    const yesterdayStr = new Date(Date.now() - 86_400_000).toDateString();

    if (a.lastReadDate !== todayStr) {
      if (a.lastReadDate === yesterdayStr) {
        a.dailyStreak = (a.dailyStreak || 0) + 1;
      } else {
        a.dailyStreak = 1;
      }
      a.lastReadDate = todayStr;
    }

    // Per-day totals for the reading-activity heatmap — kept separate from
    // readingSessions/watchSessions (each capped at 200 entries) so the
    // heatmap's history doesn't silently go blank once that cap is hit;
    // this map isn't capped since even years of daily entries stay tiny
    // (one small number per calendar day). Counts chapters read AND
    // episodes watched together (see the schema.js comment on
    // totalEpisodesWatched) — it's a heatmap of activity, not reading
    // specifically.
    a.dailyChapterCounts = a.dailyChapterCounts || {};
    const dayKey = dayKeyOf(now);
    a.dailyChapterCounts[dayKey] = (a.dailyChapterCounts[dayKey] || 0) + activityCount;
    return dayKey; // the ledger (ledger.js) is kept per this same day
  }

  async function recordSession({ mangaId, mangaTitle, chapterId, chapterName, chapterNumber, chaptersRead, duration, sourceId, cover, author, genres, nsfw } = {}) {
    const safeMid = String(mangaId ?? '').slice(0, 200);
    const safeTitle = String(mangaTitle ?? '').slice(0, 300);
    const safeCid = String(chapterId ?? '').slice(0, 200);
    const safeCName = String(chapterName ?? '').slice(0, 300);
    const safeCNum = String(chapterNumber ?? '').slice(0, 60);
    const safeReadCount = Math.max(1, Math.min(500, Number(chaptersRead) || 1));

    const store = await readStore();
    const a = store.analytics;

    const mins = Math.min(1440, Math.max(0, Number(duration) || 0));
    a.totalChaptersRead = (a.totalChaptersRead || 0) + 1;
    // Split out from the shared totalTimeSpent _bumpDailyActivity already
    // maintains (that one stays deliberately medium-agnostic, per its own
    // comment, for the streak/heatmap math) — this is purely for the
    // Statistics page's own "time reading" vs "time watching anime" cards,
    // a running lifetime total rather than summing readingSessions (capped
    // at 200 entries, would silently undercount for an active library).
    a.totalTimeReading = (a.totalTimeReading || 0) + mins;
    const dayKey = _bumpDailyActivity(a, { minutes: mins, activityCount: safeReadCount });
    recordMangaSession(a, { dayKey, mangaId: safeMid, title: safeTitle, chapters: safeReadCount, minutes: mins, meta: { sourceId, cover, author, genres, nsfw } });

    a.readingSessions = a.readingSessions || [];
    a.readingSessions.unshift({
      mangaId: safeMid,
      mangaTitle: safeTitle,
      chapterId: safeCid,
      chapterName: safeCName,
      chapterNumber: safeCNum,
      chaptersRead: safeReadCount,
      duration: mins,
      date: new Date().toISOString(),
    });
    a.readingSessions = a.readingSessions.slice(0, 200);

    await writeStore(store);
    return { ok: true, analytics: store.analytics };
  }

  async function recordAnimeSession({ idMal, title, episode, duration } = {}) {
    const safeIdMal = String(idMal ?? '').slice(0, 50);
    const safeTitle = String(title ?? '').slice(0, 300);
    const safeEpisode = Math.max(0, Math.min(100_000, Number(episode) || 0));

    const store = await readStore();
    const a = store.analytics;

    const mins = Math.min(1440, Math.max(0, Number(duration) || 0));
    a.totalEpisodesWatched = (a.totalEpisodesWatched || 0) + 1;
    // See recordSession's identical totalTimeReading comment above.
    a.totalTimeWatching = (a.totalTimeWatching || 0) + mins;
    const dayKey = _bumpDailyActivity(a, { minutes: mins, activityCount: 1 });
    recordAnimeEntry(a, { dayKey, idMal: safeIdMal, title: safeTitle, episodes: 1, minutes: mins });

    a.watchSessions = a.watchSessions || [];
    a.watchSessions.unshift({
      idMal: safeIdMal,
      title: safeTitle,
      episode: safeEpisode,
      duration: mins,
      date: new Date().toISOString(),
    });
    a.watchSessions = a.watchSessions.slice(0, 200);

    await writeStore(store);
    return { ok: true, analytics: store.analytics };
  }

  // Fed by public/modules/ui-activity-tracker.js, which flushes accumulated
  // unfocused-tab time every ~30s (and once more on tab close) rather than
  // one request per second of AFK time — "AFK" here means the tab isn't
  // visible/focused, not "the mouse hasn't moved": someone reading a long
  // chapter without touching the mouse is normal, not away, so this is
  // deliberately NOT wired into any reading/watching session recording.
  // Doesn't touch _bumpDailyActivity (streak/heatmap) on purpose — being
  // AFK isn't "engaged with the library today" activity.
  // The numbers of a period for the Wrapped tab (analytics/wrapped.js). `query` comes from the URL: every field is checked there.
  async function getWrapped(query = {}) {
    const store = await readStore();
    const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200) : []);
    const year = Number.parseInt(query.year, 10);
    return computeWrapped({
      analytics: store.analytics,
      favorites: store.favorites,
      history: store.history,
      animeFavorites: store.animeFavorites,
      readingStatus: store.readingStatus,
      reviews: store.reviews,
      nsfwOverrides: store.nsfwOverrides,
    }, {
      period: query.period,
      year: Number.isInteger(year) ? year : undefined,
      top: Number.parseInt(query.top, 10) || undefined,
      hideNsfw: query.hideNsfw === '1' || query.hideNsfw === 'true',
      excludeGenres: list(query.excludeGenres),
      excludeTitles: list(query.excludeTitles),
    });
  }

  async function recordAfkTime({ minutes } = {}) {
    const mins = Math.min(1440, Math.max(0, Number(minutes) || 0));
    const store = await readStore();
    const a = store.analytics;
    if (!mins) return { ok: true, totalTimeAfk: a.totalTimeAfk || 0 };

    a.totalTimeAfk = (a.totalTimeAfk || 0) + mins;
    await writeStore(store);
    return { ok: true, totalTimeAfk: a.totalTimeAfk };
  }

  return {
    getAnalytics,
    recordSession,
    recordAnimeSession,
    getWrapped,
    recordAfkTime,
  };
}

module.exports = { createAnalyticsService };