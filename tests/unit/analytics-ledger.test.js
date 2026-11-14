'use strict';

// The per-day, per-title history (analytics/ledger.js) that a year-in-review is built from. What has to hold: it starts from the sessions
// that were kept (once, never counted twice), it grows with every session on the SAME day the streak and the heatmap use, a bad value can
// not break or bloat it, and it cannot grow without limit.

const test = require('node:test');
const assert = require('node:assert/strict');
const { dayKeyOf, ensureLedger, recordMangaSession, recordAnimeEntry, seed, MAX_DAYS } = require('../../server/modules/analytics/ledger');
const { createAnalyticsService } = require('../../server/modules/analytics/service');
const { normaliseStore } = require('../../server/modules/store/schema');

const NOON = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);
const session = (day, over = {}) => ({ mangaId: 'kingdom', mangaTitle: 'Kingdom', chapterId: 'c', chaptersRead: 1, duration: 3, date: NOON(2026, 10, day).toISOString(), ...over });

test('the day is the server\'s own calendar day, zero-padded', () => {
  assert.equal(dayKeyOf(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(dayKeyOf(new Date(2026, 11, 31, 0, 1)), '2026-12-31');
});

test('it is seeded from the sessions that were kept: per day and per title, with the title kept once, since the oldest of them', () => {
  const a = {
    readingSessions: [session(30), session(30, { chaptersRead: 3, duration: 10 }), session(29, { mangaId: 'ippo', mangaTitle: 'Hajime no Ippo' })],
    watchSessions: [{ idMal: '21', title: 'ONE PIECE', episode: 1094, duration: 22, date: NOON(2026, 10, 29).toISOString() }],
  };
  const l = seed(a, NOON(2026, 10, 31));
  assert.deepEqual(l.manga['2026-10-30'].kingdom, { c: 4, m: 13, s: 2 });
  assert.deepEqual(l.manga['2026-10-29'].ippo, { c: 1, m: 3, s: 1 });
  assert.deepEqual(l.anime['2026-10-29']['21'], { e: 1, m: 22, s: 1 });
  assert.deepEqual(l.titles, { manga: { kingdom: 'Kingdom', ippo: 'Hajime no Ippo' }, anime: { 21: 'ONE PIECE' } });
  assert.equal(l.since, '2026-10-29');
});

test('with no sessions it starts today; sessions that are not usable are skipped', () => {
  assert.equal(seed({}, NOON(2026, 10, 31)).since, '2026-10-31');
  const l = seed({ readingSessions: [null, 'x', { mangaId: 'a', date: 'not a date' }, { mangaId: '', mangaTitle: 'No id', date: NOON(2026, 10, 1).toISOString() }, session(5)] }, NOON(2026, 10, 31));
  assert.deepEqual(Object.keys(l.manga), ['2026-10-05']);
});

test('ensureLedger seeds once and never counts the same sessions twice; a damaged one is rebuilt', () => {
  const a = { readingSessions: [session(30)], watchSessions: [] };
  const first = ensureLedger(a, NOON(2026, 10, 31));
  assert.equal(first.manga['2026-10-30'].kingdom.c, 1);
  ensureLedger(a, NOON(2026, 10, 31));
  ensureLedger(a, NOON(2026, 10, 31));
  assert.equal(a.ledger.manga['2026-10-30'].kingdom.c, 1, 'still 1');

  for (const damaged of [null, 'x', [], { manga: [] }, { manga: {}, anime: {}, titles: {} }]) {
    const b = { readingSessions: [session(30)], ledger: damaged };
    ensureLedger(b, NOON(2026, 10, 31));
    assert.equal(b.ledger.manga['2026-10-30'].kingdom.c, 1, JSON.stringify(damaged));
  }
});

test('a session adds to its day and title, in chapters, minutes and sessions', () => {
  const a = {};
  const now = NOON(2026, 10, 31);
  recordMangaSession(a, { dayKey: '2026-10-31', mangaId: 'kingdom', title: 'Kingdom', chapters: 2, minutes: 8.5 }, now);
  recordMangaSession(a, { dayKey: '2026-10-31', mangaId: 'kingdom', title: 'Kingdom', chapters: 1, minutes: 4 }, now);
  recordMangaSession(a, { dayKey: '2026-11-01', mangaId: 'kingdom', title: 'Kingdom', chapters: 1, minutes: 1 }, now);
  recordAnimeEntry(a, { dayKey: '2026-10-31', idMal: '21', title: 'ONE PIECE', episodes: 1, minutes: 22 }, now);
  assert.deepEqual(a.ledger.manga['2026-10-31'].kingdom, { c: 3, m: 12.5, s: 2 });
  assert.deepEqual(a.ledger.manga['2026-11-01'].kingdom, { c: 1, m: 1, s: 1 });
  assert.deepEqual(a.ledger.anime['2026-10-31']['21'], { e: 1, m: 22, s: 1 });
});

test('values are clamped and cut, and nothing without an id or a day is recorded', () => {
  const a = {};
  const now = NOON(2026, 10, 31);
  recordMangaSession(a, { dayKey: '2026-10-31', mangaId: 'x'.repeat(500), title: 'T'.repeat(900), chapters: 99999, minutes: 99999 }, now);
  const [[id, entry]] = Object.entries(a.ledger.manga['2026-10-31']);
  assert.equal(id.length, 200);
  assert.deepEqual(entry, { c: 500, m: 1440, s: 1 });
  assert.equal(a.ledger.titles.manga[id].length, 300);

  recordMangaSession(a, { dayKey: '2026-10-31', mangaId: 'neg', chapters: -5, minutes: -9 }, now);
  assert.deepEqual(a.ledger.manga['2026-10-31'].neg, { c: 1, m: 0, s: 1 }, 'a bad count is one chapter, never negative');
  recordMangaSession(a, { dayKey: '2026-10-31', mangaId: '', chapters: 1 }, now);
  recordMangaSession(a, { dayKey: '', mangaId: 'nodate', chapters: 1 }, now);
  assert.equal(Object.keys(a.ledger.manga['2026-10-31']).length, 2);
  assert.equal(a.ledger.manga[''], undefined);
});

test('the history does not grow for ever: the oldest days go beyond the limit', () => {
  const a = {};
  const now = NOON(2026, 10, 31);
  const start = new Date(2020, 0, 1, 12);
  for (let i = 0; i < MAX_DAYS + 20; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    recordMangaSession(a, { dayKey: dayKeyOf(d), mangaId: 'm', title: 'M', chapters: 1, minutes: 1 }, now);
  }
  const days = Object.keys(a.ledger.manga).sort();
  assert.equal(days.length, MAX_DAYS);
  assert.equal(days[0], dayKeyOf(new Date(start.getTime() + 20 * 86_400_000)), 'the 20 oldest are gone');
});

// ── what the reader knew of the title ───────────────────────────────────────

test('a session\'s meta is kept field by field, and a cover can only be an address of the image proxy or an http(s) one', () => {
  const a = {};
  const now = NOON(2026, 10, 31);
  const read = (meta) => { recordMangaSession(a, { dayKey: '2026-10-31', mangaId: 'm', title: 'M', chapters: 1, minutes: 1, meta }, now); return a.ledger.meta?.manga?.m; };
  assert.deepEqual(read({ cover: '/api/proxy-image?url=https%3A%2F%2Fx%2Fc.jpg', author: '  Hara Yasuhisa ', genres: ['Action', ' Drama ', 5, '', null], sourceId: 'comizy', nsfw: false, extra: 'dropped' }),
    { cover: '/api/proxy-image?url=https%3A%2F%2Fx%2Fc.jpg', author: 'Hara Yasuhisa', genres: ['Action', 'Drama'], sourceId: 'comizy', nsfw: false });
  for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '//evil/x.png', 'file:///c:/x', '/api/other?x', 'x'.repeat(900)]) {
    a.ledger.meta.manga.m.cover = '/api/proxy-image?ok';
    assert.equal(read({ cover: bad }).cover, '/api/proxy-image?ok', `a cover of ${bad.slice(0, 20)} is not stored (the one before stays)`);
  }
  assert.equal(read({ nsfw: 'yes' }).nsfw, false, 'only a boolean is an answer');
  assert.equal(read({ nsfw: true }).nsfw, true, 'and the latest read wins');
  assert.equal(read({ genres: new Array(40).fill('G') }).genres.length, 12);
});

test('a session with no meta (or an empty one) adds none', () => {
  const a = {};
  recordMangaSession(a, { dayKey: '2026-10-31', mangaId: 'm', title: 'M', chapters: 1, minutes: 1 }, NOON(2026, 10, 31));
  recordMangaSession(a, { dayKey: '2026-10-31', mangaId: 'm', title: 'M', chapters: 1, minutes: 1, meta: { cover: '', genres: [] } }, NOON(2026, 10, 31));
  assert.equal(a.ledger.meta, undefined);
});

test('recordSession passes what the browser knows of the title on, and the browser does send it', async () => {
  const { store, svc } = serviceOver(baseAnalytics());
  await svc.recordSession({ mangaId: 'k', mangaTitle: 'Kingdom', chapterId: 'c', chaptersRead: 1, duration: 2, sourceId: 'comizy', cover: '/api/proxy-image?url=a', author: 'Hara', genres: ['Action'], nsfw: false });
  assert.deepEqual(store.analytics.ledger.meta.manga.k, { cover: '/api/proxy-image?url=a', author: 'Hara', genres: ['Action'], sourceId: 'comizy', nsfw: false });
  const fs = require('node:fs');
  const path = require('node:path');
  const client = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'modules', 'ui-anime-film-adaptation-check-via-anilist-graphql.js'), 'utf8');
  const call = client.slice(client.indexOf('/api/analytics/session'), client.indexOf('/api/analytics/session') + 1400);
  for (const field of ['sourceId:', 'cover:', 'author:', 'genres:', 'nsfw:']) assert.ok(call.includes(field), `the reader sends ${field}`);
});

// ── through the service and the store ───────────────────────────────────────

function serviceOver(analytics) {
  const store = { analytics };
  return { store, svc: createAnalyticsService({ readStore: async () => store, writeStore: async () => {} }) };
}
const baseAnalytics = () => ({ totalChaptersRead: 0, totalTimeSpent: 0, readingSessions: [], watchSessions: [], dailyStreak: 0, lastReadDate: null, dailyChapterCounts: {} });

test('recordSession and recordAnimeSession feed the ledger on the same day as the heatmap', async () => {
  const { store, svc } = serviceOver(baseAnalytics());
  await svc.recordSession({ mangaId: 'kingdom', mangaTitle: 'Kingdom', chapterId: 'c1', chaptersRead: 2, duration: 6 });
  await svc.recordSession({ mangaId: 'kingdom', mangaTitle: 'Kingdom', chapterId: 'c2', chaptersRead: 1, duration: 3 });
  await svc.recordAnimeSession({ idMal: 21, title: 'ONE PIECE', episode: 1095, duration: 22 });

  const a = store.analytics;
  const today = dayKeyOf(new Date());
  assert.deepEqual(a.ledger.manga[today].kingdom, { c: 3, m: 9, s: 2 });
  assert.deepEqual(a.ledger.anime[today]['21'], { e: 1, m: 22, s: 1 });
  assert.equal(a.dailyChapterCounts[today], 4, 'the heatmap counts the chapters AND the episode: the same day key as the ledger');
  assert.equal(a.ledger.titles.manga.kingdom, 'Kingdom');
  assert.equal(a.readingSessions.length, 2, 'the sessions are still kept as before');
});

test('a store that has sessions and no ledger gets one when it is loaded, and loading it again changes nothing', () => {
  const store = { analytics: { ...baseAnalytics(), readingSessions: [session(30), session(29)] } };
  normaliseStore(store);
  assert.equal(store.analytics.ledger.manga['2026-10-30'].kingdom.c, 1);
  const before = JSON.stringify(store.analytics.ledger);
  normaliseStore(store);
  normaliseStore(store);
  assert.equal(JSON.stringify(store.analytics.ledger), before, 'a restart does not count the sessions again');
});

test('a ledger that came with a restored backup is kept, not rebuilt', () => {
  const ledger = { version: 1, since: '2025-01-01', manga: { '2025-01-01': { old: { c: 9, m: 30, s: 3 } } }, anime: {}, titles: { manga: { old: 'Old' }, anime: {} } };
  const store = { analytics: { ...baseAnalytics(), readingSessions: [session(30)], ledger } };
  normaliseStore(store);
  assert.equal(store.analytics.ledger.since, '2025-01-01');
  assert.deepEqual(store.analytics.ledger.manga['2025-01-01'].old, { c: 9, m: 30, s: 3 });
  assert.equal(store.analytics.ledger.manga['2026-10-30'], undefined, 'the sessions are not added on top of a history that already exists');
});
