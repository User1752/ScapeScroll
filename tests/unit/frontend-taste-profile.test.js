'use strict';

// The taste profile from the AniList statistics (public/modules/ui-taste-profile.js), which the "Recommended For You" row uses. What must hold:
//  - a genre's weight comes from how much of it the person has AND the score they gave it, so "read a lot and loved" outranks "read a lot and rated low";
//  - a genre with too few titles is noise, an unrated genre is neutral, and nothing to learn from is no profile at all;
//  - a candidate that shares genres with the profile gains up to the 45 points the count-based rule had, one that shares only genres the person rates low loses some;
//  - the genres asked of the sources are the liked ones, never a disliked, blacklisted or (with Hide NSFW) adult one;
//  - the profile is read only with an AniList account connected, kept twelve hours per account, a failed attempt is not repeated at once, an older answer
//    beats none, and a request that does not answer in time does not hold the row.
// The real module runs in a vm sandbox with a fake AniList.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (name) => fs.readFileSync(path.join(MODULES, name), 'utf8').replace(/\r\n/g, '\n');

function memoryStorage() {
  const data = {};
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}

function sandbox({ token = 'tok', user = { id: 7 }, graphql, timeoutFires = false } = {}) {
  const calls = [];
  const storage = memoryStorage();
  const ctx = {
    console, JSON, Math, Number, String, Object, Array, Set, Date, Promise,
    localStorage: storage,
    _alToken: () => token,
    _alUser: () => user,
    anilistGQL: graphql ? async (query, variables) => { calls.push({ query, variables }); return graphql(query, variables); } : undefined,
    setTimeout: (fn) => { if (timeoutFires) fn(); return 0; },
    window: {},
  };
  vm.createContext(ctx);
  const utils = read('utils.js');
  vm.runInContext(`${utils.slice(utils.indexOf('const NSFW_TAGS = new Set(['), utils.indexOf('// ── Webtoon / Manhwa / Manhua auto-detection'))}\nthis.isNsfwTag = isNsfwTag;`, ctx);
  vm.runInContext(`${read('ui-taste-profile.js')}\nthis.TASTE = TASTE;`, ctx, { filename: 'ui-taste-profile.js' });
  return { ctx, calls, storage };
}

const STATS = {
  count: 200, meanScore: 70, standardDeviation: 10,
  genres: [
    { genre: 'Action', count: 100, meanScore: 80 },   // read most and loved: the top
    { genre: 'Drama', count: 64, meanScore: 60 },     // read a lot and rated below the person's own average
    { genre: 'Romance', count: 9, meanScore: 50 },    // a little, rated low: disliked
    { genre: 'Comedy', count: 25, meanScore: 0 },     // not scored: neither better nor worse than usual
    { genre: 'Mahou Shoujo', count: 2, meanScore: 90 }, // too few
  ],
};

// ── the profile ─────────────────────────────────────────────────────────────

test('a genre weighs by how much of it and by the score given: the most read and loved is the top, a lot rated low is below it, too few is noise', () => {
  const { ctx } = sandbox();
  const taste = ctx.tasteFromStatistics(STATS);
  const g = taste.genres;
  assert.deepEqual(Object.keys(g).sort(), ['action', 'comedy', 'drama', 'romance'], 'two titles are noise');
  assert.equal(g.action.affinity, 1);
  assert.ok(g.drama.affinity < g.comedy.affinity, 'read a lot but rated low is below an unscored genre of the same order');
  assert.ok(g.comedy.affinity < g.action.affinity);
  assert.deepEqual([g.action.disliked, g.drama.disliked, g.romance.disliked, g.comedy.disliked], [false, true, true, false]);
  assert.deepEqual([taste.total, taste.mean], [200, 70]);
  assert.equal(g.drama.mean, 60);
  for (const entry of Object.values(g)) assert.ok(entry.affinity >= 0 && entry.affinity <= 1);
});

test('the same amount of a genre weighs more when it was rated higher; with nothing to learn from there is no profile', () => {
  const { ctx } = sandbox();
  // against a genre of the same size rated at the person's own average (affinities are relative to the best one)
  const one = (meanScore) => { const g = ctx.tasteFromStatistics({ count: 50, meanScore: 70, standardDeviation: 10, genres: [{ genre: 'a', count: 30, meanScore }, { genre: 'b', count: 30, meanScore: 70 }] }).genres; return g.a.affinity / g.b.affinity; };
  assert.ok(one(85) > one(70) && one(70) > one(55), 'higher score, higher affinity');
  assert.equal(one(70), 1, 'rated at the average: the same as the other');
  for (const bad of [null, undefined, {}, { genres: [] }, { genres: [{ genre: 'x', count: 1, meanScore: 90 }] }, { genres: 'nope' }, { genres: [null, {}, { genre: '', count: 9 }] }]) assert.equal(ctx.tasteFromStatistics(bad), null);
  const flat = ctx.tasteFromStatistics({ count: 10, meanScore: 0, genres: [{ genre: 'a', count: 5, meanScore: 0 }] });
  assert.equal(flat.genres.a.affinity, 1);
  assert.equal(flat.genres.a.disliked, false, 'no scores given: not disliked');
});

// ── the score of a candidate ────────────────────────────────────────────────

test('a candidate gains up to the 45 points from the genres the person likes, needs several known genres for the full mark, and loses some for a disliked one', () => {
  const { ctx } = sandbox();
  const taste = ctx.tasteFromStatistics(STATS);
  const score = (genres) => ctx.tasteScoreForManga({ genres }, taste);
  assert.equal(score(['Action']).add, Math.round(45 * 1 * (0.4 + 0.2)), 'one known genre: 60% of the best affinity');
  assert.deepEqual([...score(['Action']).reasons], ['taste']);
  const three = score(['action', 'comedy', 'DRAMA']);
  assert.ok(score(['Action', 'Comedy']).add > score(['Drama']).add, 'what is liked beats what is rated low');
  assert.ok(three.reasons.includes('dislikedGenre'), 'a disliked genre among them is said');
  assert.ok(score(['Drama']).add < score(['Comedy']).add);
  assert.equal(ctx.tasteScoreForManga({ genres: ['Unknown'] }, taste), null, 'no genre known: the count-based rule judges');
  for (const bad of [null, { genres: 'Action' }, {}, { genres: [] }]) assert.equal(ctx.tasteScoreForManga(bad, taste), null);
  assert.equal(ctx.tasteScoreForManga({ genres: ['Action'] }, null), null);
  const heavy = ctx.tasteFromStatistics({ count: 100, meanScore: 70, standardDeviation: 10, genres: ['a', 'b', 'c', 'd'].map((genre) => ({ genre, count: 20, meanScore: 40 })).concat([{ genre: 'z', count: 90, meanScore: 90 }]) });
  const cost = ctx.tasteScoreForManga({ genres: ['a', 'b', 'c', 'd'] }, heavy);
  const without = Math.round(45 * (['a', 'b', 'c', 'd'].reduce((s, k) => s + heavy.genres[k].affinity, 0) / 4) * 1);
  assert.equal(cost.add, without - 30, 'the cost of disliked genres is capped at 30');
});

test('the genres asked of the sources: the liked ones first, never a disliked, blacklisted or adult one', () => {
  const { ctx } = sandbox();
  const taste = ctx.tasteFromStatistics({
    count: 100, meanScore: 70, standardDeviation: 10,
    genres: [
      { genre: 'Action', count: 90, meanScore: 85 }, { genre: 'Ecchi', count: 80, meanScore: 80 }, { genre: 'Fantasy', count: 60, meanScore: 78 },
      { genre: 'Boys Love', count: 50, meanScore: 76 }, { genre: 'Drama', count: 40, meanScore: 50 }, { genre: 'Comedy', count: 30, meanScore: 70 },
    ],
  });
  assert.deepEqual([...ctx.tasteTopGenres(taste, 3)], ['action', 'ecchi', 'fantasy']);
  assert.deepEqual([...ctx.tasteTopGenres(taste, 3, { hideNsfw: true })], ['action', 'fantasy', 'boys love'], 'Ecchi is an adult genre');
  assert.deepEqual([...ctx.tasteTopGenres(taste, 3, { hideNsfw: true, blacklist: ['boys love'] })], ['action', 'fantasy', 'comedy'], 'and the blacklist, and Drama (rated low) is never asked');
  assert.equal(ctx.tasteTopGenres(null).length, 0);
  assert.equal(ctx.tasteTopGenres(taste, 1).length, 1);
});

// ── reading it ──────────────────────────────────────────────────────────────

const viewer = () => ({ data: { Viewer: { id: 7, statistics: { manga: STATS } } } });

test('it is read only with an AniList account connected, once for half a day, and per account', async () => {
  const off = sandbox({ token: null, graphql: viewer });
  assert.equal(await off.ctx.tasteLoad(), null);
  assert.equal(off.calls.length, 0, 'no account, no request');
  assert.equal(await sandbox({ graphql: undefined }).ctx.tasteLoad(), null, 'and no AniList helper, no profile');

  const s = sandbox({ graphql: viewer });
  const first = await s.ctx.tasteLoad();
  assert.equal(first.genres.action.affinity, 1);
  assert.match(s.calls[0].query, /Viewer/);
  assert.match(s.calls[0].query, /statistics/);
  assert.match(s.calls[0].query, /genres\(limit: 30, sort: COUNT_DESC\)/);
  await s.ctx.tasteLoad();
  assert.equal(s.calls.length, 1, 'the kept answer is used');
  const kept = JSON.parse(s.storage.data[s.ctx.TASTE.cacheKey]);
  kept.at = Date.now() - s.ctx.TASTE.ttlMs - 1;
  s.storage.data[s.ctx.TASTE.cacheKey] = JSON.stringify(kept);
  await s.ctx.tasteLoad();
  assert.equal(s.calls.length, 2, 'asked again after twelve hours');
  // another account is another profile
  const other = sandbox({ user: { id: 99 }, graphql: viewer });
  other.storage.data[other.ctx.TASTE.cacheKey] = s.storage.data[s.ctx.TASTE.cacheKey];
  await other.ctx.tasteLoad();
  assert.equal(other.calls.length, 1, 'the profile of the other account is not used');
});

test('a failure is not repeated at once, an older answer beats none, and an account with nothing to learn from is not asked again at once', async () => {
  let fail = true;
  const s = sandbox({ graphql: () => { if (fail) throw new Error('AniList down'); return viewer(); } });
  assert.equal(await s.ctx.tasteLoad(), null);
  assert.equal(await s.ctx.tasteLoad(), null);
  assert.equal(s.calls.length, 1, 'the failure is remembered for a while');
  const stale = JSON.parse(s.storage.data[s.ctx.TASTE.cacheKey]);
  stale.failedAt = Date.now() - s.ctx.TASTE.failedRetryMs - 1;
  s.storage.data[s.ctx.TASTE.cacheKey] = JSON.stringify(stale);
  fail = false;
  assert.ok(await s.ctx.tasteLoad(), 'asked again after the pause, and it answered');
  // later it fails after the answer expired: the older answer is used
  const expired = JSON.parse(s.storage.data[s.ctx.TASTE.cacheKey]);
  expired.at = Date.now() - s.ctx.TASTE.ttlMs - 1;
  s.storage.data[s.ctx.TASTE.cacheKey] = JSON.stringify(expired);
  fail = true;
  const old = await s.ctx.tasteLoad();
  assert.equal(old.genres.action.affinity, 1, 'an older answer is better than none');

  const empty = sandbox({ graphql: () => ({ data: { Viewer: { id: 7, statistics: { manga: { count: 0, genres: [] } } } } }) });
  assert.equal(await empty.ctx.tasteLoad(), null);
  assert.equal(await empty.ctx.tasteLoad(), null);
  assert.equal(empty.calls.length, 1, 'nothing to learn from yet is not asked again at once');
  const noViewer = sandbox({ graphql: () => ({ errors: [{ message: 'Invalid token' }] }) });
  assert.equal(await noViewer.ctx.tasteLoad(), null);
});

test('a request that does not answer in time does not hold the row, and a blocked store is no error', async () => {
  const slow = sandbox({ graphql: () => new Promise(() => {}), timeoutFires: true });
  assert.equal(await slow.ctx.tasteLoad(), null);
  const blocked = sandbox({ graphql: viewer });
  blocked.ctx.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.ok(await blocked.ctx.tasteLoad(), 'it answers without the store');
});

// ── the wiring ──────────────────────────────────────────────────────────────

test('it is wired: the score uses it before the count-based rule, the row asks for the liked genres, and the script is on the page', () => {
  const discover = read('ui-discover.js');
  const used = discover.indexOf('tasteScoreForManga(manga, profile.taste)');
  const counted = discover.indexOf('score += Math.min(45, tagScore * 5); // cap at 45');
  assert.ok(used > 0 && counted > used, 'the taste is tried first, the count-based rule is the fallback');
  const calendar = read('ui-calendar.js');
  assert.match(calendar, /const taste = profile && typeof tasteLoad === 'function' \? await tasteLoad\(\) : null;/);
  assert.match(calendar, /if \(profile && taste\) profile\.taste = taste;/);
  assert.match(calendar, /tasteTopGenres\(taste, 3, \{ hideNsfw: state\.settings\.hideNsfw === true, blacklist: state\.settings\.genreBlacklist \|\| \[\] \}\)/);
  const html = fs.readFileSync(path.join(MODULES, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('modules/ui-taste-profile.js') > html.indexOf('modules/ui-similar-anilist.js'));
  assert.ok(read('ui-taste-profile.js').split('\n').length < 450);
});
