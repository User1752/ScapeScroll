'use strict';

/**
 * server/modules/analytics/wrapped.js — the numbers of a period of reading and watching (the "Wrapped" tab in Analytics)
 *
 * A pure function: what the store holds goes in, with a date, and the numbers of a period come out. The page and the share cards only
 * draw them. Where the numbers come from, and what that means for how far back they can go:
 *
 *   ledger (analytics/ledger.js)   per day and per title: chapters, minutes, sessions. Everything about WHICH titles. It starts at
 *                                  `ledger.since` (seeded from the 200 sessions that were kept, then kept without a cap).
 *   analytics.dailyChapterCounts   a number per day, without a title, but further back (the heatmap's data): the streaks, the best
 *                                  day and the active days come from here, so they are not cut at ledger.since.
 *   favorites / history / animeFavorites   the cover, author and genres of a title the ledger has no meta for (older sessions, or a
 *                                  title that is in the library); readingStatus and reviews for the status and the rating.
 *
 * `coverage` says whether the period reaches before the title-level history: the page has to say "detailed since <date>" then, and not
 * pass a partial top as the whole year.
 *
 * The same manga on two sources has two ids, so titles are merged by a normalised title, never by id.
 */

const { dayKeyOf, isLedger, seed } = require('./ledger');

const PERIODS = Object.freeze(['week', 'month', 'year', 'all']);
const DEFAULT_TOP = 10;
const MAX_TOP = 25;
const BULK_STATUS_DAY = 20; // a day with this many status changes is an import, not a decision: it is not counted as "finished that day"
const DAY_MS = 86_400_000;
// With hideNsfw the adult tags are not shown as genres either (the project's line: ecchi is fine, anything beyond is not).
const NSFW_GENRES = Object.freeze(['adult', 'hentai', 'smut', 'erotica', 'pornographic', 'explicit', 'doujinshi', 'lolicon', 'shotacon']);
// What some sources put where the author should be.
const JUNK_AUTHORS = Object.freeze(['updating', 'unknown', 'n/a', 'na', 'none', 'null', '-', '--', '?', 'various', 'anonymous']);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const round1 = (n) => Math.round(n * 10) / 10;
const titleKey = (t) => String(t ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

const parseDay = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d, 12); }; // noon: a DST change cannot move the date
const addDays = (key, n) => dayKeyOf(new Date(parseDay(key).getTime() + n * DAY_MS));
const dayOfIso = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : dayKeyOf(d); };
const weekdayMondayFirst = (key) => (parseDay(key).getDay() + 6) % 7;
// The reading-status and NSFW sidecars are keyed "<mangaId>:<sourceId>", with anything outside [a-z0-9:_-] turned into "_" (the client's _statusStoreKey).
const storeKeyPart = (v) => String(v ?? '').replace(/[^a-z0-9:_-]/gi, '_');
const sidecarKeys = (id, source) => [`${id}:${source}`, `${storeKeyPart(id)}:${storeKeyPart(source || 'unknown')}`];

function resolvePeriod(period, now, { year, firstDay } = {}) {
  const today = dayKeyOf(now);
  if (period === 'week') return { id: 'week', label: 'Last 7 days', start: addDays(today, -6), end: today };
  if (period === 'month') return { id: 'month', label: 'Last 30 days', start: addDays(today, -29), end: today };
  if (period === 'year') {
    const y = Number.isInteger(year) && year >= 2000 && year <= 2200 ? year : now.getFullYear();
    return { id: 'year', year: y, label: String(y), start: `${y}-01-01`, end: y === now.getFullYear() ? today : `${y}-12-31` };
  }
  return { id: 'all', label: 'All time', start: firstDay && firstDay < today ? firstDay : today, end: today };
}

const inRange = (day, p) => day >= p.start && day <= p.end;

function streaks(dayCounts, p, today) {
  let longest = 0;
  let run = 0;
  for (let d = p.start; d <= p.end; d = addDays(d, 1)) {
    if (dayCounts[d] > 0) { run++; if (run > longest) longest = run; } else run = 0;
  }
  let current = null; // only meaningful for a period that ends today
  if (p.end === today) {
    let d = dayCounts[today] > 0 ? today : addDays(today, -1);
    current = 0;
    while (d >= p.start && dayCounts[d] > 0) { current++; d = addDays(d, -1); }
  }
  return { longest, current };
}

// What is known of a title outside the ledger: by id first, then by title (the same manga in the library under another source).
function lookup(list, ids, key) {
  return list.find((f) => ids.has(String(f?.id))) || list.find((f) => titleKey(f?.title) === key) || null;
}

function enrichManga(group, { ledger, favorites, history, readingStatus, reviews, nsfwOverrides }) {
  const ids = [...group.ids];
  const metas = ids.map((id) => ledger.meta?.manga?.[id]).filter(isObject);
  const meta = Object.assign({}, ...metas); // several ids of one title: the fields that exist
  const fav = lookup(favorites, group.ids, group.key) || lookup(history, group.ids, group.key);
  const cover = meta.cover || fav?.cover || null;
  const author = meta.author || fav?.author || null;
  const genres = (meta.genres && meta.genres.length ? meta.genres : fav?.genres) || [];
  const sourceId = meta.sourceId || fav?.sourceId || null;

  let nsfw = null; // null = not known
  for (const id of ids) {
    for (const k of sidecarKeys(id, sourceId || fav?.sourceId)) if (typeof nsfwOverrides[k] === 'boolean') nsfw = nsfwOverrides[k];
  }
  if (nsfw === null && typeof meta.nsfw === 'boolean') nsfw = meta.nsfw;

  let status = null;
  for (const id of ids) {
    for (const k of sidecarKeys(id, sourceId || fav?.sourceId)) if (readingStatus[k]?.status) status = readingStatus[k].status;
  }
  let rating = null;
  for (const id of ids) { const r = reviews[id]?.[0]?.rating; if (typeof r === 'number' && r > 0) rating = r; }
  return { cover, author, genres: Array.isArray(genres) ? genres : [], sourceId, nsfw, status, rating };
}

function computeWrapped(input, opts) {
  const data = isObject(input) ? input : {};
  const options = isObject(opts) ? opts : {};
  const now = options.now || new Date();
  const analytics = isObject(data.analytics) ? data.analytics : {};
  const favorites = Array.isArray(data.favorites) ? data.favorites : [];
  const history = Array.isArray(data.history) ? data.history : [];
  const animeFavorites = Array.isArray(data.animeFavorites) ? data.animeFavorites : [];
  const readingStatus = isObject(data.readingStatus) ? data.readingStatus : {};
  const reviews = isObject(data.reviews) ? data.reviews : {};
  const nsfwOverrides = isObject(data.nsfwOverrides) ? data.nsfwOverrides : {};
  const ledger = isLedger(analytics.ledger) ? analytics.ledger : seed(analytics, now);
  const dailyCounts = isObject(analytics.dailyChapterCounts) ? analytics.dailyChapterCounts : {};

  const period = PERIODS.includes(options.period) ? options.period : 'year';
  const top = Math.max(1, Math.min(MAX_TOP, Number(options.top) || DEFAULT_TOP));
  const hideNsfw = options.hideNsfw === true;
  const excludeGenres = new Set([...(options.excludeGenres || []), ...(hideNsfw ? NSFW_GENRES : [])].map((g) => String(g).trim().toLowerCase()).filter(Boolean));
  const excludeTitles = new Set((options.excludeTitles || []).map(String));

  const firstActive = Object.keys(dailyCounts).sort()[0];
  const firstDay = [ledger.since, firstActive].filter(Boolean).sort()[0];
  const p = resolvePeriod(period, now, { year: options.year, firstDay });
  const today = dayKeyOf(now);

  // ── manga, merged by title ────────────────────────────────────────────────
  const groups = new Map();
  for (const [day, entries] of Object.entries(ledger.manga)) {
    if (!inRange(day, p) || !isObject(entries)) continue;
    for (const [id, e] of Object.entries(entries)) {
      if (!isObject(e)) continue;
      const title = ledger.titles.manga[id] || id;
      const key = titleKey(title) || id;
      const g = groups.get(key) || { key, title, ids: new Set(), chapters: 0, minutes: 0, sessions: 0, days: new Set(), lastDay: '' };
      g.ids.add(id);
      g.chapters += Number(e.c) || 0;
      g.minutes += Number(e.m) || 0;
      g.sessions += Number(e.s) || 0;
      g.days.add(day);
      if (day >= g.lastDay) { g.lastDay = day; g.title = title; }
      groups.set(key, g);
    }
  }

  const hidden = { nsfw: 0, excluded: 0 };
  const manga = [];
  for (const g of groups.values()) {
    const info = enrichManga(g, { ledger, favorites, history, readingStatus, reviews, nsfwOverrides });
    if (excludeTitles.has(g.key)) { hidden.excluded++; continue; }
    if (hideNsfw && info.nsfw === true) { hidden.nsfw++; continue; }
    manga.push({ ...g, ...info });
  }
  manga.sort((a, b) => b.chapters - a.chapters || b.minutes - a.minutes || a.title.localeCompare(b.title));

  const readingDays = new Set();
  const weekday = [0, 0, 0, 0, 0, 0, 0];
  const byMonth = {};
  let chapters = 0;
  let minutes = 0;
  let sessions = 0;
  const perDayChapters = {};
  for (const g of manga) {
    chapters += g.chapters; minutes += g.minutes; sessions += g.sessions;
    for (const d of g.days) readingDays.add(d);
  }
  // chapters per day / weekday / month only for what is visible (a title that is hidden is not counted anywhere)
  const visibleKeys = new Set(manga.map((g) => g.key));
  for (const [day, entries] of Object.entries(ledger.manga)) {
    if (!inRange(day, p) || !isObject(entries)) continue;
    for (const [id, e] of Object.entries(entries)) {
      const key = titleKey(ledger.titles.manga[id] || id) || id;
      if (!visibleKeys.has(key)) continue;
      const c = Number(e.c) || 0;
      perDayChapters[day] = (perDayChapters[day] || 0) + c;
      weekday[weekdayMondayFirst(day)] += c;
      byMonth[day.slice(0, 7)] = (byMonth[day.slice(0, 7)] || 0) + c;
    }
  }

  // genres: the share of the chapters read that were in a title tagged with the genre (a title has several, so they do not add up to 100)
  const genreTotals = new Map();
  let genreBase = 0;
  let titlesWithGenres = 0;
  for (const g of manga) {
    const names = new Map();
    for (const raw of g.genres) { const n = String(raw).trim(); if (n && !excludeGenres.has(n.toLowerCase())) names.set(n.toLowerCase(), n); }
    if (!names.size) continue;
    titlesWithGenres++;
    genreBase += g.chapters;
    for (const [lower, shown] of names) {
      const t = genreTotals.get(lower) || { genre: shown, chapters: 0, titles: 0 };
      t.chapters += g.chapters; t.titles++;
      genreTotals.set(lower, t);
    }
  }
  const topGenres = [...genreTotals.values()]
    .sort((a, b) => b.chapters - a.chapters || b.titles - a.titles || a.genre.localeCompare(b.genre))
    .slice(0, 8)
    .map((t) => ({ ...t, share: genreBase ? Math.round((t.chapters / genreBase) * 1000) / 1000 : 0 }));

  const authors = new Map();
  for (const g of manga) {
    if (!g.author || JUNK_AUTHORS.includes(g.author.trim().toLowerCase())) continue;
    const a = authors.get(g.author.toLowerCase()) || { author: g.author, chapters: 0, titles: 0 };
    a.chapters += g.chapters; a.titles++;
    authors.set(g.author.toLowerCase(), a);
  }
  const topAuthors = [...authors.values()].sort((a, b) => b.chapters - a.chapters || a.author.localeCompare(b.author)).slice(0, 5);

  // ── anime ─────────────────────────────────────────────────────────────────
  const animeGroups = new Map();
  for (const [day, entries] of Object.entries(ledger.anime)) {
    if (!inRange(day, p) || !isObject(entries)) continue;
    for (const [id, e] of Object.entries(entries)) {
      if (!isObject(e)) continue;
      const title = ledger.titles.anime[id] || id;
      const key = titleKey(title) || id;
      if (excludeTitles.has(key)) continue;
      const g = animeGroups.get(key) || { key, title, ids: new Set(), episodes: 0, minutes: 0, sessions: 0, days: new Set() };
      g.ids.add(id);
      g.episodes += Number(e.e) || 0; g.minutes += Number(e.m) || 0; g.sessions += Number(e.s) || 0; g.days.add(day);
      animeGroups.set(key, g);
    }
  }
  const anime = [...animeGroups.values()].map((g) => {
    const fav = animeFavorites.find((f) => g.ids.has(String(f?.idMal))) || animeFavorites.find((f) => titleKey(f?.title) === g.key) || null;
    return { key: g.key, title: g.title, episodes: g.episodes, minutes: Math.round(g.minutes), sessions: g.sessions, activeDays: g.days.size, cover: fav?.cover || null, genres: fav?.genres || [] };
  }).sort((a, b) => b.episodes - a.episodes || b.minutes - a.minutes || a.title.localeCompare(b.title));
  const animeDays = new Set();
  for (const g of animeGroups.values()) for (const d of g.days) animeDays.add(d);

  // ── activity: the heatmap's own numbers, which go back further than the titles ──
  const daily = {};
  let activeTotal = 0;
  let bestDay = null;
  for (const [day, n] of Object.entries(dailyCounts)) {
    if (!inRange(day, p) || !(n > 0)) continue;
    daily[day] = n;
    activeTotal++;
    if (!bestDay || n > bestDay.count) bestDay = { day, count: n };
  }
  const run = streaks(daily, p, today);

  // ── the library: what was finished, and what was rated, in the period ────
  const statusByDay = {};
  for (const s of Object.values(readingStatus)) { const d = s?.updatedAt ? dayOfIso(s.updatedAt) : null; if (d) statusByDay[d] = (statusByDay[d] || 0) + 1; }
  const bulkDays = Object.keys(statusByDay).filter((d) => statusByDay[d] >= BULK_STATUS_DAY && inRange(d, p)).sort();
  const finished = [];
  for (const s of Object.values(readingStatus)) {
    const d = s?.updatedAt ? dayOfIso(s.updatedAt) : null;
    if (s?.status !== 'completed' || !d || !inRange(d, p) || statusByDay[d] >= BULK_STATUS_DAY) continue;
    const title = s.manga?.title || '';
    if (!title || excludeTitles.has(titleKey(title))) continue;
    finished.push({ title, day: d });
  }
  finished.sort((a, b) => b.day.localeCompare(a.day));

  const rated = [];
  for (const [id, list] of Object.entries(reviews)) {
    const r = Array.isArray(list) ? list[0] : null;
    const d = r?.date ? dayOfIso(r.date) : null;
    if (!r || !(r.rating > 0) || !d || !inRange(d, p)) continue;
    const title = ledger.titles.manga[id] || favorites.find((f) => String(f?.id) === id)?.title || history.find((f) => String(f?.id) === id)?.title || '';
    if (!title || excludeTitles.has(titleKey(title))) continue;
    rated.push({ title, rating: r.rating, day: d });
  }
  rated.sort((a, b) => b.rating - a.rating || b.day.localeCompare(a.day));

  const activeDays = readingDays.size;
  return {
    generatedAt: now.toISOString(),
    period: { ...p, days: Math.round((parseDay(p.end) - parseDay(p.start)) / DAY_MS) + 1 },
    coverage: {
      detailedSince: ledger.since || null,
      partial: !!ledger.since && p.start < ledger.since,
      activityFrom: firstActive || null,
    },
    filters: { hideNsfw, excludeGenres: [...excludeGenres], hidden },
    reading: {
      chapters,
      minutes: Math.round(minutes),
      sessions,
      titles: manga.length,
      activeDays,
      avgChaptersPerActiveDay: activeDays ? round1(chapters / activeDays) : 0,
      avgMinutesPerActiveDay: activeDays ? round1(minutes / activeDays) : 0,
      topManga: manga.slice(0, top).map((g) => ({
        title: g.title, key: g.key, chapters: g.chapters, minutes: Math.round(g.minutes), sessions: g.sessions, activeDays: g.days.size,
        cover: g.cover, author: g.author, genres: g.genres, status: g.status, rating: g.rating, nsfw: g.nsfw,
      })),
      topGenres,
      genreCoverage: { titlesWithGenres, titles: manga.length },
      topAuthors,
      byWeekday: weekday,
      byMonth,
      daily: perDayChapters,
    },
    anime: {
      episodes: anime.reduce((n, a) => n + a.episodes, 0),
      minutes: anime.reduce((n, a) => n + a.minutes, 0),
      sessions: anime.reduce((n, a) => n + a.sessions, 0),
      titles: anime.length,
      activeDays: animeDays.size,
      topAnime: anime.slice(0, top),
    },
    activity: {
      source: 'dailyChapterCounts',
      daily,
      activeDays: activeTotal,
      bestDay,
      longestStreak: run.longest,
      currentStreak: run.current,
    },
    library: {
      finished: { count: finished.length, titles: finished.slice(0, 10), ignoredBulkDays: bulkDays },
      rated: { count: rated.length, average: rated.length ? round1(rated.reduce((n, r) => n + r.rating, 0) / rated.length) : null, top: rated.slice(0, 5) },
    },
    lifetime: {
      chapters: Number(analytics.totalChaptersRead) || 0,
      episodes: Number(analytics.totalEpisodesWatched) || 0,
      minutesReading: Math.round(Number(analytics.totalTimeReading) || 0),
      minutesWatching: Math.round(Number(analytics.totalTimeWatching) || 0),
    },
  };
}

module.exports = { computeWrapped, resolvePeriod, titleKey, PERIODS, MAX_TOP };
