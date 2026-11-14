'use strict';

/**
 * server/modules/analytics/ledger.js — what was read and watched, per day and per title (store.analytics.ledger)
 *
 * The rest of analytics answers "how much" but not "of what, and when": readingSessions keeps only the last 200 sessions, and
 * dailyChapterCounts has a number per day without saying which manga. A year-in-review needs both ("your top manga of the year",
 * "your best week"), and a history that was not kept cannot be rebuilt later, so this is kept from the moment it exists, without a cap
 * on the days (one small entry per title per day: a year is about 70 KB).
 *
 *   ledger = {
 *     version: 1,
 *     since: 'YYYY-MM-DD',                         the first day this history covers (the oldest session it was seeded from, or the day it started)
 *     manga: { 'YYYY-MM-DD': { <mangaId>: { c: chapters, m: minutes, s: sessions } } },
 *     anime: { 'YYYY-MM-DD': { <idMal>:   { e: episodes, m: minutes, s: sessions } } },
 *     titles: { manga: { <mangaId>: title }, anime: { <idMal>: title } },     the title is kept once, not on every day
 *     meta:   { manga: { <mangaId>: { cover, author, genres, sourceId, nsfw } } },   what the reader knew of the title when it was read
 *   }
 *
 * `meta` is there because most of what is read is not in the library (so there is no favorite to take the cover, the author or the
 * genres from), and so that a title that is adult is known to be, at the time, for anything that is made to be shared. It only holds
 * what a session sends and that passes the checks below (a cover is an address of this app's image proxy or an http(s) one: never a
 * script).
 *
 * The day is the server's own calendar day, the same one dailyChapterCounts and the streak use, so the numbers agree with each other.
 * It is seeded once from the sessions that survived the 200 cap; after that the two record* functions add to it.
 */

const MAX_ID = 200;
const MAX_TITLE = 300;
const MAX_DAYS = 1500; // about four years: older days are dropped so the store cannot grow without limit
const MAX_CHAPTERS_PER_SESSION = 500;
const MAX_MINUTES_PER_SESSION = 1440;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pad = (n) => String(n).padStart(2, '0');
const round2 = (n) => Math.round(n * 100) / 100;

function dayKeyOf(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isLedger(l) {
  return isObject(l) && isObject(l.manga) && isObject(l.anime) && isObject(l.titles) && isObject(l.titles.manga) && isObject(l.titles.anime);
}

function emptyLedger(since) {
  return { version: 1, since, manga: {}, anime: {}, titles: { manga: {}, anime: {} } };
}

function bump(bucket, dayKey, id, delta) {
  const day = (bucket[dayKey] = isObject(bucket[dayKey]) ? bucket[dayKey] : {});
  const entry = (day[id] = isObject(day[id]) ? day[id] : {});
  for (const [k, v] of Object.entries(delta)) entry[k] = round2((Number(entry[k]) || 0) + v);
}

// Drops the oldest days beyond MAX_DAYS (the keys sort as dates).
function prune(ledger) {
  for (const bucket of [ledger.manga, ledger.anime]) {
    const days = Object.keys(bucket).sort();
    for (const day of days.slice(0, Math.max(0, days.length - MAX_DAYS))) delete bucket[day];
  }
}

const COVER_RE = /^(\/api\/proxy-image\?|https?:\/\/)/i;

// What of a session's `meta` is kept: each field only if it has the right shape.
function cleanMeta(meta) {
  const out = {};
  if (!isObject(meta)) return out;
  if (typeof meta.cover === 'string' && meta.cover.length <= 800 && COVER_RE.test(meta.cover)) out.cover = meta.cover;
  if (typeof meta.author === 'string' && meta.author.trim()) out.author = meta.author.trim().slice(0, 120);
  if (Array.isArray(meta.genres)) {
    const genres = meta.genres.filter((g) => typeof g === 'string').map((g) => g.trim().slice(0, 40)).filter(Boolean).slice(0, 12);
    if (genres.length) out.genres = genres;
  }
  if (typeof meta.sourceId === 'string' && meta.sourceId.trim()) out.sourceId = meta.sourceId.trim().slice(0, 60);
  if (typeof meta.nsfw === 'boolean') out.nsfw = meta.nsfw;
  return out;
}

function addManga(ledger, { dayKey, mangaId, title, chapters, minutes, meta }) {
  const id = String(mangaId ?? '').slice(0, MAX_ID);
  if (!id || !dayKey) return;
  bump(ledger.manga, dayKey, id, {
    c: Math.max(1, Math.min(MAX_CHAPTERS_PER_SESSION, Number(chapters) || 1)),
    m: Math.max(0, Math.min(MAX_MINUTES_PER_SESSION, Number(minutes) || 0)),
    s: 1,
  });
  const t = String(title ?? '').slice(0, MAX_TITLE);
  if (t) ledger.titles.manga[id] = t;
  const clean = cleanMeta(meta);
  if (Object.keys(clean).length) {
    if (!isObject(ledger.meta)) ledger.meta = {};
    if (!isObject(ledger.meta.manga)) ledger.meta.manga = {};
    ledger.meta.manga[id] = { ...(isObject(ledger.meta.manga[id]) ? ledger.meta.manga[id] : {}), ...clean }; // the latest read wins
  }
}

function addAnime(ledger, { dayKey, idMal, title, episodes, minutes }) {
  const id = String(idMal ?? '').slice(0, MAX_ID);
  if (!id || !dayKey) return;
  bump(ledger.anime, dayKey, id, {
    e: Math.max(1, Math.min(MAX_CHAPTERS_PER_SESSION, Number(episodes) || 1)),
    m: Math.max(0, Math.min(MAX_MINUTES_PER_SESSION, Number(minutes) || 0)),
    s: 1,
  });
  const t = String(title ?? '').slice(0, MAX_TITLE);
  if (t) ledger.titles.anime[id] = t;
}

// The ledger as the sessions that were kept would have built it (they are capped at 200, so this covers only their span).
function seed(a, now = new Date()) {
  const ledger = emptyLedger(dayKeyOf(now));
  let earliest = null;
  for (const s of (Array.isArray(a.readingSessions) ? a.readingSessions : [])) {
    const when = new Date(s?.date);
    if (!isObject(s) || Number.isNaN(when.getTime())) continue;
    const dayKey = dayKeyOf(when);
    addManga(ledger, { dayKey, mangaId: s.mangaId, title: s.mangaTitle, chapters: s.chaptersRead, minutes: s.duration });
    if (!earliest || dayKey < earliest) earliest = dayKey;
  }
  for (const s of (Array.isArray(a.watchSessions) ? a.watchSessions : [])) {
    const when = new Date(s?.date);
    if (!isObject(s) || Number.isNaN(when.getTime())) continue;
    const dayKey = dayKeyOf(when);
    addAnime(ledger, { dayKey, idMal: s.idMal, title: s.title, episodes: 1, minutes: s.duration });
    if (!earliest || dayKey < earliest) earliest = dayKey;
  }
  if (earliest) ledger.since = earliest;
  return ledger;
}

// The ledger of this analytics object: kept as it is when it is well formed, rebuilt from the sessions when it is missing or damaged.
function ensureLedger(a, now = new Date()) {
  if (!isObject(a)) return null;
  if (!isLedger(a.ledger)) a.ledger = seed(a, now);
  else {
    a.ledger.version = 1;
    if (typeof a.ledger.since !== 'string') a.ledger.since = dayKeyOf(now);
  }
  return a.ledger;
}

function recordMangaSession(a, entry, now = new Date()) {
  const ledger = ensureLedger(a, now);
  addManga(ledger, entry);
  prune(ledger);
}

function recordAnimeEntry(a, entry, now = new Date()) {
  const ledger = ensureLedger(a, now);
  addAnime(ledger, entry);
  prune(ledger);
}

module.exports = { dayKeyOf, ensureLedger, recordMangaSession, recordAnimeEntry, seed, isLedger, MAX_DAYS };
