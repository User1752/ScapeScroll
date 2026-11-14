'use strict';

const { seededHash, analyseIntervals } = require('./prediction-math');
const { createNativeDatesService } = require('./native-dates');
const { fetchOtakuCalendarReleases } = require('./otaku-calendar');
const { withTimeout } = require('../common/async-utils');
const { sourceHasNativeDates } = require('../common/source-ui');

const EXCLUDED_USER_STATUSES = new Set(['completed', 'on_hold', 'dropped']);
const RELEASING_STATUSES = new Set([
  'ongoing', 'publishing', 'releasing', 'serializing', 'new', 'active', 'in progress',
]);

const DAY_MS = 86_400_000;
const MAX_PREDICTIONS = 8;
const MIN_INTERVAL_HOURS = 12;

// Sources whose own chapters() response carries a real date per chapter say so themselves (meta.ui.nativeDates, see common/source-ui.js).
// A manga of any other source gets no calendar entry of its own and lands in noSchedule.
const NATIVE_DATE_SOURCES = new Set([]);

// How many favorites with no stored publication status to resolve
// concurrently (see backfillMissingStatuses below) — capped rather than
// firing them all at once, since a favorite-heavy library can easily have
// 50+ of these on a first calendar load and several sources in this app
// have already hit real rate-limit trouble under unthrottled concurrent
// load elsewhere this session.
const STATUS_BACKFILL_CONCURRENCY = 6;
const STATUS_BACKFILL_TIMEOUT_MS = 12_000;
// Hard cap on how long the calendar response itself waits on this — a
// favorite-heavy library can have 50+ empty-status entries, and even at
// STATUS_BACKFILL_CONCURRENCY that's easily a minute-plus if awaited in
// full. Whatever doesn't finish within budget keeps resolving in the
// background (see the tail of backfillMissingStatuses) so the fix still
// converges over the next couple of loads instead of hanging this one.
const STATUS_BACKFILL_BUDGET_MS = 8_000;

function createCalendarService({ readStore, writeStore, loadSourceFromFile }) {
  // No outside service is asked for release dates: only the dates the sources carry.
  const resolveOutsideId = async () => null;
  const fetchBatchMangaChapters = async () => new Map();
  const { fetchNativeDatedChaptersBatch, fetchSourceLatestChapNum } = createNativeDatesService({ loadSourceFromFile });

  // Favorites can carry a permanently empty `status` — not because the
  // source doesn't know it (confirmed live: mangakatana/allmanga's own
  // mangaDetails() DOES return a real 'completed'/'ongoing' value), but
  // because the record was captured at favorite-time from a lighter
  // object (e.g. a search-result card) that never carried one. The
  // releasing-filter below treats an empty status as "assume releasing",
  // which is exactly backwards for an actually-finished series (Bleach,
  // GANTZ, ...) — it just means "we've never actually checked". Resolve
  // the real status once here and persist it back onto the favorite so
  // later calendar loads don't need to repeat this.
  // Mutates the favorite objects in `store.favorites` in place (they're the
  // same object references the caller's `store` holds) and persists the
  // WHOLE store back — never a partial object, which would wipe every
  // other store.json key (customLists, animeFavorites, readingStatus, ...).
  async function resolveStatusFor(m) {
    try {
      const src = loadSourceFromFile(m.sourceId);
      const details = await withTimeout(src.mangaDetails(m.id), STATUS_BACKFILL_TIMEOUT_MS, 'timeout');
      const realStatus = String(details?.status || '').trim().toLowerCase();
      if (realStatus && realStatus !== 'unknown') {
        m.status = realStatus;
        return true;
      }
    } catch (_) {
      // Couldn't resolve it (source down/timeout/no such method) — leave
      // status empty, same "assume releasing" fallback as before for this
      // one entry, rather than failing the whole calendar.
    }
    return false;
  }

  async function backfillMissingStatuses(store) {
    const favorites = store.favorites || [];
    const targets = favorites.filter(m => m?.id && m?.sourceId && !String(m.status || '').trim());
    if (!targets.length) return;

    const deadline = Date.now() + STATUS_BACKFILL_BUDGET_MS;
    let changed = false;
    let idx = 0;
    while (idx < targets.length && Date.now() < deadline) {
      const batch = targets.slice(idx, idx + STATUS_BACKFILL_CONCURRENCY);
      idx += batch.length;
      const results = await Promise.all(batch.map(resolveStatusFor));
      if (results.some(Boolean)) changed = true;
    }
    if (changed && typeof writeStore === 'function') await writeStore(store);

    // Whatever didn't fit in budget keeps resolving in the background —
    // this request's response doesn't wait on it, but the store still
    // converges toward fully-backfilled statuses over the next load or two
    // instead of needing the same slow first-load every time.
    if (idx < targets.length && typeof writeStore === 'function') {
      const remaining = targets.slice(idx);
      (async () => {
        let bgChanged = false;
        for (let i = 0; i < remaining.length; i += STATUS_BACKFILL_CONCURRENCY) {
          const batch = remaining.slice(i, i + STATUS_BACKFILL_CONCURRENCY);
          const results = await Promise.all(batch.map(resolveStatusFor));
          if (results.some(Boolean)) bgChanged = true;
        }
        if (bgChanged) await writeStore(store).catch(() => {});
      })();
    }
  }

  async function getCalendar(query = {}) {
    const now = new Date();
    const year = parseInt(query.year, 10) || now.getFullYear();
    const month = parseInt(query.month, 10) || (now.getMonth() + 1);

    if (!Number.isFinite(year) || year < 2000 || year > 2100 ||
        !Number.isFinite(month) || month < 1 || month > 12) {
      const err = new Error('Invalid year or month');
      err.statusCode = 400;
      throw err;
    }

    const store = await readStore();
    await backfillMissingStatuses(store);
    const favorites = store.favorites || [];
    const readingStatus = store.readingStatus || {};

    const releasing = favorites.filter(m => {
      // Guards against corrupted/legacy favorite records that are missing
      // required fields (e.g. saved before addToLibrary/toggleFavorite
      // validated payloads) — skip them instead of crashing the whole page.
      if (!m || !m.id || !m.title) return false;
      const userStatus = readingStatus[`${m.id}:${m.sourceId}`]?.status;
      if (EXCLUDED_USER_STATUSES.has(userStatus)) return false;
      const pub = (m.status || '').toLowerCase().trim();
      return pub === '' || RELEASING_STATUSES.has(pub);
    });

    const monthStartDate = new Date(Date.UTC(year, month - 1, 1));
    const monthEndDate = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
    const MIN_MS = MIN_INTERVAL_HOURS * 3_600_000;
    const days = {};

    const resolved = await Promise.all(
      releasing.map(async (manga) => {
        const mdId = await resolveOutsideId(manga.title);
        // Without an outside date — fall back to the manga's own source
        // history if (and only if) that source is known to carry real
        // chapter dates (see NATIVE_DATE_SOURCES).
        // A source can also say so itself (meta.ui.nativeDates, see common/source-ui.js): no edit of this list needed.
        const useNative = mdId === null && (NATIVE_DATE_SOURCES.has(manga.sourceId) || sourceHasNativeDates(manga.sourceId));
        return { manga, mdId, useNative };
      })
    );
    // Manga with neither an outside dates service match nor a native-date source have no
    // date data anywhere to build a calendar entry from — they still end
    // up in noSchedule below, same as before.
    const processable = resolved.filter(e => e.mdId !== null || e.useNative);

    const [chaptersMap, nativeChaptersMap, sourceChapResults, otakuReleasesByDay] = await Promise.all([
      fetchBatchMangaChapters(processable.filter(e => e.mdId !== null).map(e => e.mdId)),
      fetchNativeDatedChaptersBatch(processable.filter(e => e.useNative).map(e => e.manga)),
      Promise.all(processable.map(({ manga, useNative }) => (
        // Only meaningful for the outside dates service path, to correct for that service's
        // chapter numbering lagging behind the real source (see chapOffset
        // below) — native entries already use the source's own numbering.
        (!useNative) ? fetchSourceLatestChapNum(manga) : Promise.resolve(null)
      ))),
      fetchOtakuCalendarReleases(year, month, releasing),
    ]);

    // Merge OtakuCalendar volumes into the days object early
    for (const [dayStr, volReleases] of Object.entries(otakuReleasesByDay)) {
      const d = parseInt(dayStr, 10);
      if (!days[d]) days[d] = [];
      days[d].push(...volReleases);
    }

    for (let i = 0; i < processable.length; i++) {
      const { manga, mdId, useNative } = processable[i];
      const dated = useNative
        ? (nativeChaptersMap.get(`${manga.sourceId}:${manga.id}`) || [])
        : (chaptersMap.get(mdId) || []);
      const sourceLatestChap = sourceChapResults[i];

      if (!dated.length) continue;

      const mdLastChapNum = parseFloat(dated[dated.length - 1].chapter);
      let chapOffset = 0;
      if (!useNative && sourceLatestChap !== null && isFinite(sourceLatestChap) &&
          isFinite(mdLastChapNum) && sourceLatestChap > mdLastChapNum) {
        chapOffset = Math.round(sourceLatestChap - mdLastChapNum);
      }

      const applyOffset = (chapStr) => {
        if (!chapOffset) return chapStr;
        const n = parseFloat(chapStr);
        return isFinite(n) ? String(Math.round(n + chapOffset)) : chapStr;
      };

      const actualByDay = new Map();
      for (const c of dated) {
        if (c.date < monthStartDate || c.date > monthEndDate) continue;
        const day = c.date.getUTCDate();
        if (!actualByDay.has(day) || parseFloat(c.chapter) > parseFloat(actualByDay.get(day).chapter)) {
          actualByDay.set(day, c);
        }
      }
      for (const [day, c] of actualByDay) {
        if (!days[day]) days[day] = [];
        if (!days[day].some(e => e.manga?.id === manga.id)) {
          days[day].push({
            chapterId: c.id,
            chapter: applyOffset(c.chapter),
            publishAt: c.date.toISOString(),
            predicted: false,
            manga: { id: manga.id, title: manga.title, cover: manga.cover, sourceId: manga.sourceId },
          });
        }
      }

      const intervals = [];
      for (let j = 1; j < dated.length; j++) {
        const diff = dated[j].date - dated[j - 1].date;
        if (diff >= MIN_MS) intervals.push(diff);
      }
      const { intervalMs, cadence, confidence } = analyseIntervals(intervals);
      if (!intervalMs || intervalMs <= 0) continue;

      const lastEntry = dated[dated.length - 1];
      const lastChapNum = isFinite(mdLastChapNum) ? mdLastChapNum + chapOffset : NaN;
      let nextDate = new Date(lastEntry.date.getTime() + intervalMs);

      let predOffset = 0;
      while (nextDate < monthStartDate) {
        predOffset++;
        nextDate = new Date(nextDate.getTime() + intervalMs);
      }

      let count = 0;
      const jitterRange = cadence === 'weekly' ? 1 : cadence === 'biweekly' ? 2 : cadence === 'monthly' ? 4 : 3;
      const breakMod = confidence === 'low' ? 5 : confidence === 'medium' ? 10 : 0;

      while (nextDate <= monthEndDate && count < MAX_PREDICTIONS) {
        predOffset++;
        const seed = `${manga.id}:${predOffset}`;

        if (breakMod > 0 && seededHash(seed + ':break') % breakMod === 0) {
          nextDate = new Date(nextDate.getTime() + intervalMs);
          continue;
        }

        const jitterDays = (seededHash(seed + ':jitter') % (2 * jitterRange + 1)) - jitterRange;
        const displayDate = new Date(nextDate.getTime() + jitterDays * DAY_MS);
        if (displayDate < monthStartDate || displayDate > monthEndDate) {
          nextDate = new Date(nextDate.getTime() + intervalMs);
          continue;
        }

        const day = displayDate.getUTCDate();
        if (!actualByDay.has(day)) {
          if (!days[day]) days[day] = [];
          if (!days[day].some(e => e.manga?.id === manga.id)) {
            const chapNum = isFinite(lastChapNum)
              ? String(Math.round(lastChapNum + count + 1))
              : (sourceLatestChap ? String(Math.round(sourceLatestChap + count + 1)) : null);
            days[day].push({
              chapterId: null,
              chapter: chapNum || '~',
              publishAt: displayDate.toISOString(),
              predicted: true,
              cadence,
              confidence,
              manga: { id: manga.id, title: manga.title, cover: manga.cover, sourceId: manga.sourceId },
            });
            count++;
          }
        }
        nextDate = new Date(nextDate.getTime() + intervalMs);
      }
    }

    const coveredIds = new Set();
    for (const entries of Object.values(days)) for (const e of entries) if (e.manga?.id) coveredIds.add(e.manga.id);

    const noSchedule = releasing
      .filter(m => !coveredIds.has(m.id))
      .map(m => ({ id: m.id, title: m.title, cover: m.cover, status: m.status, sourceId: m.sourceId }));

    return { year, month, days, noSchedule, releasingCount: releasing.length };
  }

  return { getCalendar };
}

module.exports = { createCalendarService };
