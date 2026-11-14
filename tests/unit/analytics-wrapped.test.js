'use strict';

// The numbers of a period (analytics/wrapped.js). A fixed "now" and a small invented library, so every figure can be checked by hand.
// What matters most: the same manga on two sources is ONE title; a period that reaches before the title-level history says so instead
// of passing a partial top as the whole; what is hidden (adult titles, genres, titles the person excluded) is not counted anywhere; and
// bad data never throws.

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeWrapped, resolvePeriod, titleKey } = require('../../server/modules/analytics/wrapped');
const { createAnalyticsService } = require('../../server/modules/analytics/service');

const NOW = new Date(2026, 9, 31, 16, 0, 0); // Saturday 2026-10-31

// the ledger: kingdom is read on two sources (two ids, one title); ippo has a cover and genres in the ledger; secret is adult
const ledger = {
  version: 1,
  since: '2026-07-09',
  manga: {
    '2026-10-31': { 'k-comizy': { c: 3, m: 12, s: 2 } },
    '2026-10-30': { 'k-comizy': { c: 2, m: 8, s: 1 }, ippo: { c: 1, m: 4, s: 1 } },
    '2026-10-29': { 'k-other': { c: 5, m: 20, s: 3 }, secret: { c: 9, m: 30, s: 4 } },
    '2026-08-24': { ippo: { c: 4, m: 16, s: 2 } },
    '2026-07-10': { orphan: { c: 1, m: 2, s: 1 } },
  },
  anime: {
    '2026-10-30': { 21: { e: 2, m: 44, s: 2 } },
    '2026-08-24': { 21: { e: 1, m: 22, s: 1 }, 99: { e: 1, m: 24, s: 1 } },
  },
  titles: {
    manga: { 'k-comizy': 'Kingdom', 'k-other': 'KINGDOM', ippo: 'Hajime no Ippo', secret: 'Secret Doujin', orphan: 'Unknown One' },
    anime: { 21: 'ONE PIECE', 99: 'Ghost in the Shell' },
  },
  meta: { manga: { ippo: { cover: '/api/proxy-image?url=x', author: 'George Morikawa', genres: ['Sports', 'Drama'], sourceId: 'comizy', nsfw: false }, secret: { genres: ['Adult', 'Comedy'], nsfw: true, author: 'Updating' } } },
};
const dailyChapterCounts = {
  '2026-05-13': 4, '2026-10-26': 1, '2026-10-27': 2, '2026-10-28': 3, '2026-10-29': 14, '2026-10-30': 5, '2026-10-31': 3, '2026-08-24': 7, '2026-07-10': 1,
};

const data = () => ({
  analytics: { totalChaptersRead: 695, totalEpisodesWatched: 64, totalTimeReading: 130.4, totalTimeWatching: 32.6, ledger: JSON.parse(JSON.stringify(ledger)), dailyChapterCounts: { ...dailyChapterCounts } },
  favorites: [
    { id: 'k-comizy', title: 'Kingdom', cover: 'https://img/kingdom.jpg', author: 'Hara Yasuhisa', genres: ['Action', 'Drama', 'Adult'], sourceId: 'comizy' },
    { id: 'zzz', title: 'Kingdom!', cover: 'https://img/other.jpg', author: 'Someone Else', genres: ['Comedy'], sourceId: 'x' },
  ],
  history: [{ id: 'orphan', title: 'Unknown One', cover: 'https://img/orphan.jpg', author: 'Updating', genres: ['Mystery'] }],
  animeFavorites: [{ idMal: '21', title: 'ONE PIECE', cover: 'https://img/op.jpg', genres: ['Adventure'] }],
  readingStatus: {
    'k-comizy:comizy': { status: 'reading', updatedAt: '2026-10-01T10:00:00Z' },
    'done-1:src': { status: 'completed', updatedAt: '2026-10-15T10:00:00Z', manga: { title: 'Finished Thing' } },
    ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`imp-${i}:src`, { status: 'completed', updatedAt: '2026-08-10T12:00:00Z', manga: { title: `Imported ${i}` } }])),
  },
  reviews: { ippo: [{ rating: 9, text: '', date: '2026-10-20T10:00:00Z' }], 'k-comizy': [{ rating: 10, text: '', date: '2026-02-01T10:00:00Z' }] },
  nsfwOverrides: {},
});

const wrap = (options = {}, d = data()) => computeWrapped(d, { now: NOW, ...options });

test('the periods: 7 days and 30 days ending today, a calendar year, and everything', () => {
  assert.deepEqual([resolvePeriod('week', NOW).start, resolvePeriod('week', NOW).end], ['2026-10-25', '2026-10-31']);
  assert.equal(resolvePeriod('month', NOW).start, '2026-10-02');
  assert.deepEqual(resolvePeriod('year', NOW), { id: 'year', year: 2026, label: '2026', start: '2026-01-01', end: '2026-10-31' });
  assert.deepEqual([resolvePeriod('year', NOW, { year: 2025 }).start, resolvePeriod('year', NOW, { year: 2025 }).end], ['2025-01-01', '2025-12-31']);
  assert.equal(resolvePeriod('all', NOW, { firstDay: '2026-05-13' }).start, '2026-05-13');
  assert.equal(wrap({ period: 'nonsense' }).period.id, 'year', 'an unknown period is the year');
  assert.equal(wrap({ period: 'week' }).period.days, 7);
});

test('the same manga on two sources is one title: merged by title, with the sources\' chapters added', () => {
  const w = wrap({ period: 'year' });
  const kingdom = w.reading.topManga.find((m) => m.key === titleKey('Kingdom'));
  assert.equal(kingdom.chapters, 10, '3 + 2 on one id and 5 on the other');
  assert.equal(kingdom.minutes, 40);
  assert.equal(kingdom.sessions, 6);
  assert.equal(kingdom.activeDays, 3);
  assert.equal(w.reading.topManga.filter((m) => /kingdom/i.test(m.title)).length, 1);
});

test('totals and the order of the top: most chapters, then minutes, then title', () => {
  const w = wrap({ period: 'year' });
  assert.deepEqual(w.reading.topManga.map((m) => [m.title, m.chapters]), [['Kingdom', 10], ['Secret Doujin', 9], ['Hajime no Ippo', 5], ['Unknown One', 1]]);
  assert.equal(w.reading.chapters, 25);
  assert.equal(w.reading.minutes, 92);
  assert.equal(w.reading.titles, 4);
  assert.equal(w.reading.activeDays, 5);
  assert.equal(w.reading.avgChaptersPerActiveDay, 5);
  assert.equal(wrap({ period: 'week', top: 2 }).reading.topManga.length, 2);
});

test('a period that reaches before the title-level history says so; one inside it does not', () => {
  assert.deepEqual(wrap({ period: 'year' }).coverage, { detailedSince: '2026-07-09', partial: true, activityFrom: '2026-05-13' });
  assert.equal(wrap({ period: 'all' }).coverage.partial, true);
  assert.equal(wrap({ period: 'month' }).coverage.partial, false);
  assert.equal(wrap({ period: 'week' }).coverage.partial, false);
});

test('cover, author, genres, status and rating come from what was read, then from the library by id, then by title (another source)', () => {
  const m = Object.fromEntries(wrap({ period: 'year' }).reading.topManga.map((x) => [x.title, x]));
  assert.equal(m['Hajime no Ippo'].cover, '/api/proxy-image?url=x', 'what the session sent');
  assert.equal(m['Hajime no Ippo'].author, 'George Morikawa');
  assert.equal(m['Hajime no Ippo'].rating, 9);
  assert.equal(m.Kingdom.cover, 'https://img/kingdom.jpg', 'by id');
  assert.equal(m.Kingdom.author, 'Hara Yasuhisa');
  assert.equal(m.Kingdom.status, 'reading');
  assert.equal(m.Kingdom.rating, 10);
  assert.equal(m['Unknown One'].cover, 'https://img/orphan.jpg', 'by id from the history');
});

test('genres: the share of the chapters read in titles with the genre; a title without genres is not in the base', () => {
  const w = wrap({ period: 'year' });
  const by = Object.fromEntries(w.reading.topGenres.map((g) => [g.genre, g]));
  // titles with genres: Kingdom (10: Action, Drama, Adult), Secret (9: Adult, Comedy), Ippo (5: Sports, Drama), Unknown One (1: Mystery) = 25
  assert.equal(by.Drama.chapters, 15);
  assert.equal(by.Drama.share, 0.6);
  assert.equal(by.Adult.chapters, 19);
  assert.deepEqual(w.reading.genreCoverage, { titlesWithGenres: 4, titles: 4 });
});

test('hideNsfw: adult titles and adult tags disappear and are NOT counted anywhere; the count of what was hidden is told', () => {
  const w = wrap({ period: 'year', hideNsfw: true });
  assert.ok(!w.reading.topManga.some((m) => m.title === 'Secret Doujin'));
  assert.equal(w.reading.chapters, 16, '25 - 9');
  assert.equal(w.reading.titles, 3);
  assert.equal(w.filters.hidden.nsfw, 1);
  assert.ok(!w.reading.topGenres.some((g) => g.genre === 'Adult'), 'the tag Adult is not shown as a genre either');
  assert.equal(w.reading.daily['2026-10-29'], 5, 'nor in the day it was read');
  assert.equal(w.reading.byWeekday.reduce((a, b) => a + b, 0), 16);
  assert.equal(Object.values(w.reading.byMonth).reduce((a, b) => a + b, 0), 16);
  assert.equal(wrap({ period: 'year' }).filters.hidden.nsfw, 0, 'without the option nothing is hidden');
});

test('a title the person marked as adult or not wins over what the session said', () => {
  const d = data();
  d.nsfwOverrides = { 'secret:comizy': false, 'ippo:comizy': true };
  d.analytics.ledger.meta.manga.secret.sourceId = 'comizy';
  const w = computeWrapped(d, { now: NOW, period: 'year', hideNsfw: true });
  assert.ok(w.reading.topManga.some((m) => m.title === 'Secret Doujin'), 'marked "not adult"');
  assert.ok(!w.reading.topManga.some((m) => m.title === 'Hajime no Ippo'), 'marked "adult"');
});

test('excluded genres and titles are left out of the genres and of every total', () => {
  const g = wrap({ period: 'year', excludeGenres: ['drama', ' ACTION '] });
  assert.ok(!g.reading.topGenres.some((x) => ['Drama', 'Action'].includes(x.genre)));
  assert.ok(g.filters.excludeGenres.includes('drama'));
  const t = wrap({ period: 'year', excludeTitles: [titleKey('Kingdom'), 'not-a-title'] });
  assert.ok(!t.reading.topManga.some((m) => m.title === 'Kingdom'));
  assert.equal(t.reading.chapters, 15);
  assert.equal(t.filters.hidden.excluded, 1);
});

test('activity comes from the heatmap\'s numbers (further back than the titles): active days, best day, streaks', () => {
  const w = wrap({ period: 'year' });
  assert.equal(w.activity.activeDays, 9);
  assert.deepEqual(w.activity.bestDay, { day: '2026-10-29', count: 14 });
  assert.equal(w.activity.longestStreak, 6, '26, 27, 28, 29, 30, 31 of October');
  assert.equal(w.activity.currentStreak, 6);
  assert.equal(w.activity.daily['2026-05-13'], 4, 'May is there although the titles start in July');
});

test('the current streak counts from yesterday when today has nothing yet, and is null for a period that ended', () => {
  const d = data();
  delete d.analytics.dailyChapterCounts['2026-10-31'];
  assert.equal(computeWrapped(d, { now: NOW, period: 'year' }).activity.currentStreak, 5);
  d.analytics.dailyChapterCounts['2026-10-30'] = 0;
  assert.equal(computeWrapped(d, { now: NOW, period: 'year' }).activity.currentStreak, 0);
  assert.equal(wrap({ period: 'year', year: 2025 }).activity.currentStreak, null);
});

test('by weekday (Monday first) and by month, from the visible titles', () => {
  const w = wrap({ period: 'year' });
  // Monday 08-24: 4 | Thursday 10-29: 5 + 9 | Friday 10-30: 2 + 1, and 07-10: 1 | Saturday 10-31: 3
  assert.deepEqual(w.reading.byWeekday, [4, 0, 0, 14, 4, 3, 0]);
  assert.deepEqual(w.reading.byMonth, { '2026-07': 1, '2026-08': 4, '2026-10': 20 });
});

test('anime: episodes, minutes and a top, merged by title, with the cover from My Anime', () => {
  const w = wrap({ period: 'year' });
  assert.equal(w.anime.episodes, 4);
  assert.equal(w.anime.minutes, 90);
  assert.equal(w.anime.titles, 2);
  assert.equal(w.anime.activeDays, 2);
  assert.deepEqual(w.anime.topAnime.map((a) => [a.title, a.episodes]), [['ONE PIECE', 3], ['Ghost in the Shell', 1]]);
  assert.equal(w.anime.topAnime[0].cover, 'https://img/op.jpg');
  assert.equal(wrap({ period: 'week' }).anime.episodes, 2);
});

test('authors: a placeholder a source puts there is not an author', () => {
  const w = wrap({ period: 'year' });
  assert.deepEqual(w.reading.topAuthors.map((a) => [a.author, a.chapters]), [['Hara Yasuhisa', 10], ['George Morikawa', 5]]);
});

test('finished and rated: a day with many status changes is an import and is not counted as finished that day', () => {
  const w = wrap({ period: 'year' });
  assert.equal(w.library.finished.count, 1);
  assert.deepEqual(w.library.finished.titles, [{ title: 'Finished Thing', day: '2026-10-15' }]);
  assert.deepEqual(w.library.finished.ignoredBulkDays, ['2026-08-10']);
  assert.equal(w.library.rated.count, 2, 'a 9 in October and a 10 in February: both are in 2026');
  assert.equal(w.library.rated.average, 9.5);
  assert.deepEqual(w.library.rated.top.map((r) => [r.title, r.rating]), [['Kingdom', 10], ['Hajime no Ippo', 9]]);
  assert.equal(wrap({ period: 'month' }).library.rated.count, 1, 'only the one from October is in the last 30 days');
});

test('lifetime totals are always there, whatever the period', () => {
  assert.deepEqual(wrap({ period: 'week' }).lifetime, { chapters: 695, episodes: 64, minutesReading: 130, minutesWatching: 33 });
});

test('a ledger that is missing is built from the sessions; empty or broken data never throws', () => {
  const d = { analytics: { readingSessions: [{ mangaId: 'a', mangaTitle: 'A', chaptersRead: 2, duration: 5, date: new Date(2026, 9, 30, 12).toISOString() }], watchSessions: [] } };
  assert.equal(computeWrapped(d, { now: NOW, period: 'week' }).reading.chapters, 2);
  for (const bad of [undefined, null, {}, { analytics: null }, { analytics: { ledger: 'x', dailyChapterCounts: [] }, favorites: 'x', reviews: [], readingStatus: 5 }]) {
    const w = computeWrapped(bad, { now: NOW, period: 'all' });
    assert.equal(typeof w.reading.chapters, 'number');
    assert.deepEqual(w.reading.topManga, []);
  }
});

// ── through the service (what the route calls) ──────────────────────────────

test('the service reads the query from the URL: bad values are ignored, lists are split, the flags are strict', async () => {
  const d = data();
  const store = { ...d, analytics: d.analytics };
  const svc = createAnalyticsService({ readStore: async () => store, writeStore: async () => {} });
  const w = await svc.getWrapped({ period: 'year', hideNsfw: '1', excludeGenres: 'drama, action ,,', excludeTitles: titleKey('Kingdom'), top: '2', year: 'abc' });
  assert.equal(w.period.year, new Date().getFullYear(), 'a year that is not a number is the current one');
  assert.equal(w.filters.hideNsfw, true);
  assert.deepEqual(w.filters.excludeGenres.filter((g) => ['drama', 'action'].includes(g)), ['drama', 'action']);
  assert.ok(w.reading.topManga.length <= 2);
  assert.equal((await svc.getWrapped({ hideNsfw: 'yes' })).filters.hideNsfw, false, 'only 1 or true turn it on');
  assert.equal((await svc.getWrapped({})).period.id, 'year');
  assert.equal((await svc.getWrapped({ period: 'week', excludeGenres: ['not', 'a', 'string'] })).filters.excludeGenres.length, 0);
});

test('the route is registered', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'routes', 'analytics.js'), 'utf8');
  assert.match(src, /router\.get\('\/api\/analytics\/wrapped'/);
  assert.match(src, /analyticsService\.getWrapped\(/);
});
