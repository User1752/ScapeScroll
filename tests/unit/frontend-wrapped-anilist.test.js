'use strict';

// The AniList view of the Wrapped tab (public/modules/wrapped-anilist.js + ui-analytics-wrapped-anilist.js). Three things matter:
//  - the numbers: what counts as read, what a "year" is when AniList does not know the day of a chapter, what hiding adult / hidden titles
//    removes from EVERY figure (the people behind the titles included), and that a title on several custom lists is counted once;
//  - the reading of the list: it pages through the chunks, keeps a copy for a few minutes, never fails because the people statistics
//    did, and says "not connected" with a code the page can recognise;
//  - the page: nothing from AniList can become markup, and the share card is made from the same object.
// The real modules run in a vm sandbox with a fake AniList.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (f) => fs.readFileSync(path.join(MODULES, f), 'utf8');
function locale(lang) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read(`i18n/locales/${lang}.js`), ctx);
  return ctx.window.ScrollScapeI18nLocales[lang];
}
const EN = locale('en-GB');

function sandbox({ token = 'tok', user = { id: 7 }, pages = [], failPeople = false, stored = {} } = {}) {
  const store = { ...stored };
  const queries = [];
  const context = {
    console, JSON, Number, String, Object, Array, Math, Date, Set, Map, URLSearchParams, Error,
    state: { settings: {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    document: { getElementById: () => null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    dbg: new Proxy({ ERR_ANILIST: 'x' }, { get: (o, k) => (k in o ? o[k] : () => {}) }),
    currentLanguage: 'en-GB',
    api: async () => ({}), $: () => null, showToast() {},
    _alToken: () => token,
    _alUser: () => user,
    anilistFetchViewer: async () => ({ id: 99 }),
    anilistGQL: async (query, variables) => {
      queries.push({ query, variables });
      if (query.includes('MediaListCollection')) {
        const page = pages[variables.chunk - 1] || { lists: [], hasNext: false };
        return { data: { MediaListCollection: { hasNextChunk: page.hasNext === true, lists: page.lists } } };
      }
      if (failPeople) throw new Error('boom');
      return { data: { User: { statistics: { manga: { staff: [{ mediaIds: [1, 2, 3], staff: { name: { full: 'Hara Yasuhisa' } } }, { mediaIds: [3], staff: { name: { full: 'Only In Hidden' } } }] }, anime: { studios: [{ mediaIds: [10], studio: { name: 'Madhouse', isAnimationStudio: true } }, { mediaIds: [10], studio: { name: 'A Publisher', isAnimationStudio: false } }] } } } } };
    },
  };
  vm.createContext(context);
  vm.runInContext(read('utils.js'), context, { filename: 'utils.js' });
  context.t = (key) => EN[key] ?? key;
  for (const f of ['ui-analytics-wrapped.js', 'wrapped-anilist.js', 'ui-analytics-wrapped-anilist.js', 'wrapped-share-cards.js']) vm.runInContext(read(f), context, { filename: f });
  return { ctx: context, store, queries };
}

const entry = (id, title, o = {}) => ({
  mediaId: id, status: 'CURRENT', progress: 10, progressVolumes: 0, score: 0, completedAt: null,
  media: { id, format: 'MANGA', chapters: 100, episodes: 12, duration: 24, isAdult: false, genres: ['Action'], title: { userPreferred: title, romaji: title, english: null, native: null }, coverImage: { large: `https://s4.anilist.co/${id}.jpg` } },
  ...o,
});
const done = (year, month = 6) => ({ year, month, day: 15 });
// the page's own state, which lives in the sandbox's script scope (a top-level const is not a property of the context)
const page = (ctx) => vm.runInContext('_wrapped', ctx);

const LIST = [
  entry(1, 'Kingdom', { progress: 343, status: 'CURRENT', score: 9, progressVolumes: 40, media: { ...entry(1, 'Kingdom').media, genres: ['Action', 'Drama'], title: { userPreferred: 'Kingdom', romaji: 'Kingdom', english: 'Kingdom', native: 'キングダム' } } }),
  entry(2, 'Bleach', { progress: 16, status: 'COMPLETED', score: 8, completedAt: done(2026, 3) }),
  entry(3, '<img src=x onerror=PWN(1)>', { progress: 5, status: 'COMPLETED', score: 6.5, completedAt: done(2025, 12) }),
  entry(4, 'Planned', { progress: 0, status: 'PLANNING' }),
  entry(5, 'Completed Without Number', { progress: 0, status: 'COMPLETED', completedAt: done(2026, 5), media: { ...entry(5, 'x').media, chapters: 30, title: { userPreferred: 'Completed Without Number' } } }),
  entry(6, 'Some Doujin', { progress: 50, status: 'CURRENT', media: { ...entry(6, 'x').media, isAdult: true, genres: ['Hentai', 'Comedy'], title: { userPreferred: 'Some Doujin' } } }),
  entry(1, 'Kingdom'), // the same title again, from a custom list
];

test('what counts: progress, a completed title with no number, never a planned one, and a title only once', () => {
  const { ctx } = sandbox();
  const w = ctx.wrappedAniListBuild({ entries: LIST, people: [] }, { kind: 'manga', period: 'all' });
  assert.equal(w.al.units, 343 + 16 + 5 + 30 + 50);
  assert.equal(w.al.titles, 5, 'Planned is not counted, Kingdom twice is one');
  assert.equal(w.al.completed, 3);
  assert.equal(w.al.volumes, 40);
  assert.equal(w.al.meanScore, 7.8, '(9 + 8 + 6.5) / 3, only the titles with a score');
  assert.equal(w.al.statuses.PLANNING, 1, 'the status split does count what is planned');
  assert.equal(w.al.top[0].title, 'Kingdom');
  assert.equal(w.hero.number, w.al.units);
  assert.equal(w.source, 'anilist');
});

test('a year is the titles FINISHED that year, and says so; the months are listed', () => {
  const { ctx } = sandbox();
  const w = ctx.wrappedAniListBuild({ entries: LIST, people: [] }, { kind: 'manga', period: 'year', year: 2026 });
  assert.equal(w.al.titles, 2, 'Bleach and the completed title with no number: the ones finished in 2026');
  assert.equal(w.al.units, 16 + 30);
  assert.deepEqual([...w.al.years], [2026, 2025]);
  assert.equal(w.al.finishedBy.length, 12);
  assert.equal(w.al.finishedBy[2].count, 1, 'March');
  assert.equal(Object.keys(w.al.statuses).length, 0, 'no status split for a year: it would not be about that year');
  assert.equal(w.period.label, '2026');
  assert.equal(w.hero.unit, 'chapters in titles finished');
});

test('all time lists the years something was finished, oldest first', () => {
  const { ctx } = sandbox();
  const w = ctx.wrappedAniListBuild({ entries: LIST, people: [] }, { kind: 'manga', period: 'all' });
  assert.deepEqual(JSON.parse(JSON.stringify(w.al.finishedBy)), [{ key: '2025', count: 1 }, { key: '2026', count: 2 }]);
});

test('the years between the first and the last finished are all there, even one with nothing', () => {
  const { ctx } = sandbox();
  const list = [entry(1, 'A', { status: 'COMPLETED', completedAt: done(2020) }), entry(2, 'B', { status: 'COMPLETED', completedAt: done(2024) })];
  const w = ctx.wrappedAniListBuild({ entries: list, people: [] }, { kind: 'manga', period: 'all' });
  assert.deepEqual(JSON.parse(JSON.stringify(w.al.finishedBy.map((x) => [x.key, x.count]))), [['2020', 1], ['2021', 0], ['2022', 0], ['2023', 0], ['2024', 1]]);
});

test('the page puts the people and the library in one stacked cell, and every card is optional', () => {
  const { ctx } = sandbox();
  const full = ctx._wrappedAniListHtml(ctx.wrappedAniListBuild({ entries: LIST, people: [{ name: 'Hara', mediaIds: [1] }] }, { kind: 'manga', period: 'all' }));
  assert.match(full, /wrapped-grid wrapped-grid--even/);
  assert.match(full, /<div class="wrapped-stack"><section class="wrapped-card"><h3>Top authors<\/h3>.*<section class="wrapped-card"><h3>Library<\/h3>/s);
  const noPeople = ctx._wrappedAniListHtml(ctx.wrappedAniListBuild({ entries: LIST, people: [] }, { kind: 'manga', period: 'all' }));
  assert.ok(!noPeople.includes('Top authors'));
  assert.match(noPeople, /<div class="wrapped-stack"><section class="wrapped-card"><h3>Library/, 'the library stands alone in the cell');
});

test('hiding adult titles removes them from every number and from the genres; hidden titles go by any of their names', () => {
  const { ctx } = sandbox();
  const attack = entry(7, 'Shingeki no Kyojin', { progress: 20, media: { ...entry(7, 'x').media, title: { userPreferred: 'Shingeki no Kyojin', romaji: 'Shingeki no Kyojin', english: 'Attack on Titan', native: '進撃の巨人' } } });
  const list = [...LIST, attack];
  const shown = ctx.wrappedAniListBuild({ entries: list, people: [] }, { kind: 'manga', period: 'all' });
  assert.ok(shown.al.genres.some((g) => g.genre === 'Hentai'));
  const w = ctx.wrappedAniListBuild({ entries: list, people: [] }, { kind: 'manga', period: 'all', hideNsfw: true, excludeTitles: [ctx.wrappedTitleKey('Attack on Titan')] });
  assert.equal(w.filters.hidden.nsfw, 1);
  assert.equal(w.filters.hidden.excluded, 1, 'hidden by its English name, though the list shows the romaji one');
  assert.equal(w.al.units, 343 + 16 + 5 + 30);
  assert.ok(!w.al.top.some((x) => /Some Doujin|Shingeki/.test(x.title)));
  assert.ok(!w.al.genres.some((g) => /hentai/i.test(g.genre)));
  const blocked = ctx.wrappedAniListBuild({ entries: LIST, people: [] }, { kind: 'manga', period: 'all', excludeGenres: ['drama'] });
  assert.ok(!blocked.al.genres.some((g) => g.genre === 'Drama'), 'the genre blacklist leaves the genre out of the chart');
});

test('the people behind the titles are re-ranked on the titles that are shown', () => {
  const { ctx } = sandbox();
  const people = [{ name: 'Hara Yasuhisa', mediaIds: [1, 2, 3] }, { name: 'Only In Hidden', mediaIds: [6] }];
  const hideAdult = ctx.wrappedAniListBuild({ entries: LIST, people }, { kind: 'manga', period: 'all', hideNsfw: true });
  assert.deepEqual(JSON.parse(JSON.stringify(hideAdult.al.people)), [{ name: 'Hara Yasuhisa', units: 343 + 16 + 5, titles: 3 }], 'a person whose only title is hidden disappears');
  const shown = ctx.wrappedAniListBuild({ entries: LIST, people }, { kind: 'manga', period: 'all' });
  assert.equal(shown.al.people.length, 2);
});

test('anime: episodes, minutes by the length of an episode, and the anime wording', () => {
  const { ctx } = sandbox();
  const list = [entry(10, 'Frieren', { progress: 28, status: 'COMPLETED', score: 10, completedAt: done(2026, 2), media: { ...entry(10, 'x').media, format: 'TV', duration: 24, title: { userPreferred: 'Frieren' } } })];
  const w = ctx.wrappedAniListBuild({ entries: list, people: [{ name: 'Madhouse', mediaIds: [10] }] }, { kind: 'anime', period: 'all' });
  assert.equal(w.al.minutes, 28 * 24);
  assert.equal(w.hero.unit, 'episodes watched');
  assert.equal(w.al.people[0].name, 'Madhouse');
  assert.equal(w.card.peopleTitle, 'Top studios');
  assert.deepEqual(JSON.parse(JSON.stringify(w.al.formats)), [{ format: 'TV', count: 1 }]);
});

test('the list is read chunk by chunk, a title on a custom list is kept once, and the people are asked for apart', async () => {
  const { ctx, queries } = sandbox({ pages: [{ hasNext: true, lists: [{ entries: [entry(1, 'A'), entry(2, 'B')] }] }, { hasNext: false, lists: [{ entries: [entry(2, 'B'), entry(3, 'C'), { mediaId: 9, media: null }] }] }] });
  const raw = await ctx.wrappedAniListFetch('manga', { force: true });
  assert.deepEqual(JSON.parse(JSON.stringify(raw.entries.map((e) => e.mediaId))), [1, 2, 3]);
  const listCalls = queries.filter((q) => q.query.includes('MediaListCollection'));
  assert.deepEqual(listCalls.map((q) => q.variables.chunk), [1, 2]);
  assert.ok(listCalls.every((q) => q.variables.userId === 7 && q.variables.type === 'MANGA'));
  assert.equal(raw.people[0].name, 'Hara Yasuhisa');
  assert.equal(raw.cut, false);
});

test('a list is read once for a few minutes; Refresh reads it again', async () => {
  const { ctx, queries } = sandbox({ pages: [{ hasNext: false, lists: [{ entries: [entry(1, 'A')] }] }] });
  await ctx.wrappedAniListFetch('manga');
  const first = queries.length;
  await ctx.wrappedAniListFetch('manga');
  assert.equal(queries.length, first, 'the second call used the copy');
  await ctx.wrappedAniListFetch('manga', { force: true });
  assert.ok(queries.length > first);
  await ctx.wrappedAniListFetch('anime');
  assert.ok(queries.some((q) => q.variables && q.variables.type === 'ANIME'), 'manga and anime are kept apart');
});

test('the people statistics failing does not take the page down', async () => {
  const { ctx } = sandbox({ failPeople: true, pages: [{ hasNext: false, lists: [{ entries: [entry(1, 'A')] }] }] });
  const raw = await ctx.wrappedAniListFetch('manga', { force: true });
  assert.equal(raw.entries.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(raw.people)), []);
});

test('without a token it says "not connected" and asks AniList nothing', async () => {
  const { ctx, queries } = sandbox({ token: null });
  await assert.rejects(() => ctx.wrappedAniListFetch('manga', { force: true }), (e) => e.code === 'not-connected');
  assert.equal(queries.length, 0);
});

test('an error from AniList is an error with its own message, and a list that never ends is cut', async () => {
  const bad = sandbox();
  bad.ctx.anilistGQL = async () => ({ errors: [{ message: 'Too Many Requests.' }] });
  await assert.rejects(() => bad.ctx.wrappedAniListFetch('manga', { force: true }), /Too Many Requests/);

  const endless = sandbox({ user: null, pages: Array.from({ length: 30 }, (_, i) => ({ hasNext: true, lists: [{ entries: [entry(i + 1, `T${i}`)] }] })) });
  const raw = await endless.ctx.wrappedAniListFetch('manga', { force: true });
  assert.equal(raw.cut, true);
  assert.equal(raw.entries.length, 20, 'twenty chunks, then it stops and says so');
  assert.ok(endless.queries.every((q) => !q.variables || q.variables.userId === 99), 'with no saved user it asks AniList who the viewer is');
});

test('the page draws the numbers, says what AniList cannot know, and a title can never become markup', () => {
  const { ctx } = sandbox();
  const w = ctx.wrappedAniListBuild({ entries: LIST, people: [{ name: 'Hara <b>Yasuhisa</b>', mediaIds: [1] }] }, { kind: 'manga', period: 'all' });
  const html = ctx._wrappedAniListHtml(w);
  assert.match(html, /wrapped-hero-number">444<small>chapters read/);
  assert.match(html, /AniList does not record when each chapter or episode was read/);
  assert.ok(!html.includes('<img src=x'), 'the hostile title is escaped');
  assert.ok(html.includes('&lt;img src=x onerror=PWN(1)&gt;'));
  assert.ok(html.includes('Hara &lt;b&gt;Yasuhisa&lt;/b&gt;'));
  assert.match(html, /data-wrapped-action="hide" data-key="kingdom"/);
  assert.ok(!/By weekday|Longest streak|Best day/.test(html), 'nothing that needs the day something was read');
  const attributeNames = html.replace(/="[^"]*"/g, '=""');
  assert.ok(!/<[a-z][^>]*\son[a-z]+=/i.test(attributeNames), 'no inline handlers');
  assert.match(html, /By status/);
  assert.match(html, /Your scores/);
});

test('a year says it shows the titles finished that year; an empty view is a message, not zeros', () => {
  const { ctx } = sandbox();
  const year = ctx._wrappedAniListHtml(ctx.wrappedAniListBuild({ entries: LIST, people: [] }, { kind: 'manga', period: 'year', year: 2026 }));
  assert.match(year, /2026 shows the titles you finished that year/);
  assert.match(year, /Finished by month/);
  const none = ctx._wrappedAniListHtml(ctx.wrappedAniListBuild({ entries: LIST, people: [] }, { kind: 'manga', period: 'year', year: 1999 }));
  assert.match(none, /Nothing on your AniList list for this view yet\./);
  assert.ok(!none.includes('wrapped-hero'));
});

test('the toolbar: AniList has no last-7-days, offers manga or anime, and the year picker lists the years there is something for', () => {
  const { ctx } = sandbox();
  ctx._wrappedLoadPrefs();
  page(ctx).source = 'anilist';
  page(ctx).period = 'week'; // left over from the other view
  const w = ctx.wrappedAniListBuild({ entries: LIST, people: [] }, { kind: 'manga', period: 'all' });
  const html = ctx._wToolbarHtml(w);
  assert.ok(!html.includes('data-period="week"') && !html.includes('data-period="month"'));
  assert.match(html, /data-period="all"[^>]*>All time/);
  assert.match(html, /class="wrapped-period active" data-wrapped-action="period" data-period="all"/, 'a period AniList does not have falls back to all time');
  assert.match(html, /data-kind="anime"/);
  assert.match(html, /data-wrapped-action="al-refresh"/);
  page(ctx).period = 'year';
  assert.match(ctx._wToolbarHtml(w), /<option value="2025"/, 'the year of the oldest finished title');
  page(ctx).source = 'app';
  const appHtml = ctx._wToolbarHtml(w);
  assert.ok(!appHtml.includes('data-kind='), 'the app view has no manga/anime switch');
  assert.ok(appHtml.includes('data-period="week"'));
});

test('the buttons: the source and the kind are remembered and redraw; anything else is ignored', () => {
  const { ctx, store } = sandbox();
  let renders = 0;
  ctx.renderWrappedTab = () => { renders++; };
  ctx._wrappedLoadPrefs();
  ctx._wrappedAction({ wrappedAction: 'source', source: 'anilist' });
  ctx._wrappedAction({ wrappedAction: 'kind', kind: 'anime' });
  assert.equal(store.scrollscape_wrapped_source, 'anilist');
  assert.equal(store.scrollscape_wrapped_kind, 'anime');
  ctx._wrappedAction({ wrappedAction: 'source', source: 'myanimelist' });
  ctx._wrappedAction({ wrappedAction: 'kind', kind: 'novels' });
  assert.equal(store.scrollscape_wrapped_source, 'anilist');
  assert.equal(store.scrollscape_wrapped_kind, 'anime');
  ctx._wrappedAction({ wrappedAction: 'al-refresh' });
  assert.equal(page(ctx).alForce, true);
  assert.equal(renders, 3);
});

test('the share card is made from the same object, in words, with the AniList marks', () => {
  const { ctx } = sandbox();
  const w = ctx.wrappedAniListBuild({ entries: LIST, people: [{ name: 'Hara Yasuhisa', mediaIds: [1] }] }, { kind: 'manga', period: 'year', year: 2026 });
  const model = ctx.wrappedCardModel(w, { variant: 'recap', size: 'square' });
  assert.equal(model.number, '46');
  assert.equal(model.period, '2026 · AniList');
  assert.equal(model.empty, false);
  assert.equal(model.stats.length, 3);
  assert.equal(model.sections[0].title, 'Top manga');
  assert.match(model.sections[0].rows[0].cover, /^\/api\/proxy-image\?url=https%3A%2F%2Fs4\.anilist\.co/);
  assert.match(ctx.wrappedCardFileName(w, { variant: 'recap', size: 'story' }), /^scrollscape-wrapped-anilist-manga-2026-recap-story\.png$/);
});

test('every string the AniList view uses exists in English and in Portuguese', () => {
  const src = read('ui-analytics-wrapped-anilist.js') + read('wrapped-anilist.js') + read('ui-analytics-wrapped.js');
  const keys = new Set([...src.matchAll(/\b(?:t|_wt|_walT)\('((?:wrapped|analytics)\.[A-Za-z.]+)'/g)].map((m) => m[1]));
  for (const kind of ['manga', 'anime']) for (const s of ['CURRENT', 'REPEATING', 'COMPLETED', 'PAUSED', 'DROPPED', 'PLANNING']) keys.add(`wrapped.al.status.${kind}.${s}`);
  for (const k of ['wrapped.card.watchTime', 'wrapped.card.volumes', 'wrapped.card.meanScore', 'wrapped.card.topStudios', 'wrapped.card.topAnime', 'wrapped.card.topManga', 'wrapped.card.periodAniList', 'wrapped.al.heroFinishedEpisodes', 'wrapped.heroEpisodes']) keys.add(k);
  assert.ok(keys.size > 40, `${keys.size} keys found`);
  for (const lang of ['en-GB', 'pt-PT']) {
    const table = locale(lang);
    const missing = [...keys].filter((k) => typeof table[k] !== 'string' || !table[k]);
    assert.deepEqual(missing, [], `${lang} is missing ${missing.join(', ')}`);
  }
});

test('the scripts are on the page, in an order that works, and Wrapped never writes to AniList', () => {
  const html = fs.readFileSync(path.join(MODULES, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  const order = ['ui-analytics-wrapped.js', 'wrapped-anilist.js', 'ui-analytics-wrapped-anilist.js', 'wrapped-share-cards.js'].map((f) => html.indexOf(`modules/${f}`));
  assert.ok(order.every((i) => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]));
  const code = read('wrapped-anilist.js') + read('ui-analytics-wrapped-anilist.js');
  assert.ok(!/mutation|SaveMediaListEntry|DeleteMediaListEntry|Authorization/i.test(code), 'only queries, and the token is the proxy helper\'s business');
});

// ── names that open the title, the author and the anime ────────────────────────

test('the ids of a title travel with it, so a name can be matched to the library', () => {
  const { ctx } = sandbox();
  const list = [entry(1, 'Kingdom', { progress: 343, media: { ...entry(1, 'x').media, idMal: 8888, title: { userPreferred: 'Kingdom' } } })];
  const w = ctx.wrappedAniListBuild({ entries: list, people: [] }, { kind: 'manga', period: 'all' });
  assert.equal(w.al.top[0].mediaId, 1);
  assert.equal(w.al.top[0].idMal, 8888);
});

test('a manga in the library is a button that opens it; one that is not is plain text; a manga author always opens the author search', () => {
  const { ctx } = sandbox();
  const w = ctx.wrappedAniListBuild({ entries: LIST, people: [{ name: 'Hara <b>Y</b>', mediaIds: [1] }] }, { kind: 'manga', period: 'all' });
  const library = new Map([['al:1', { id: 'kingdom', title: 'Kingdom', sourceId: 'comizy' }]]);
  const html = ctx._wrappedAniListHtml(w, library);
  assert.match(html, /<button type="button" class="wrapped-open" data-wrapped-action="open-manga" data-id="kingdom" data-source="comizy"[^>]*>Kingdom<\/button>/);
  assert.ok(!/open-manga" data-id="[^"]*"[^>]*>Bleach/.test(html), 'Bleach is not in the library: plain text');
  assert.ok(html.includes('<b>Bleach</b>'));
  assert.match(html, /data-wrapped-action="open-author" data-name="Hara &lt;b&gt;Y&lt;\/b&gt;"/, 'the author name is escaped in the attribute');
  const bare = ctx._wrappedAniListHtml(w);
  assert.ok(!bare.includes('open-manga'), 'with no library nothing is a link');
  const anime = ctx.wrappedAniListBuild({ entries: [entry(10, 'Frieren', { progress: 28, status: 'COMPLETED', media: { ...entry(10, 'x').media, title: { userPreferred: 'Frieren' } } })], people: [{ name: 'Madhouse', mediaIds: [10] }] }, { kind: 'anime', period: 'all' });
  const animeHtml = ctx._wrappedAniListHtml(anime, new Map([['al:10', { idMal: '52991', title: 'Frieren' }]]));
  assert.match(animeHtml, /data-wrapped-action="open-anime" data-id="52991"/);
  assert.ok(!animeHtml.includes('open-author'), 'a studio is not an author');
});

test('the library is looked up by AniList id for manga (saved or linked) and by MyAnimeList or AniList id for anime', async () => {
  const { ctx } = sandbox();
  ctx.state.favorites = [{ id: 'a', anilistId: '5', title: 'A' }, { id: 'b', title: 'B' }, { id: 'c', title: 'C' }];
  ctx._alGetAllLinks = () => ({ b: '6' });
  const manga = await ctx._wAlLibraryIndex('manga');
  assert.equal(manga.get('al:5').id, 'a', 'the id saved on the favourite');
  assert.equal(manga.get('al:6').id, 'b', 'the id the Tracker linked it to');
  assert.equal(manga.size, 2, 'C has neither: it is not matched');
  ctx._fetchAnimeFavorites = async () => [{ idMal: '1', anilistId: '10', title: 'X' }, { idMal: '2', title: 'Y' }];
  const anime = await ctx._wAlLibraryIndex('anime');
  assert.equal(anime.get('mal:2').title, 'Y');
  assert.equal(anime.get('al:10').title, 'X');
  ctx._fetchAnimeFavorites = async () => { throw new Error('offline'); };
  assert.equal((await ctx._wAlLibraryIndex('anime')).size, 0, 'a library that cannot be read means no links, not a broken page');
});

test('clicking a name: the manga opens like from the library (its source first), the anime on its page, the author in the author search', async () => {
  const { ctx } = sandbox();
  const calls = [];
  ctx.loadMangaDetails = async (...args) => { calls.push(['manga', ...args]); };
  ctx.renderSourceSelect = () => calls.push(['select']);
  ctx._animeGoToDetails = (show, resume) => calls.push(['anime', show, resume]);
  ctx.searchByAuthor = async (name) => { calls.push(['author', name]); };
  ctx.state.currentSourceId = 'mangadex';
  page(ctx).alLibrary = new Map([['al:1', { id: 'kingdom', title: 'Kingdom', sourceId: 'comizy' }], ['mal:7', { idMal: '7', anilistId: '70', title: 'Frieren', cover: 'c', totalEpisodes: 28 }]]);

  await ctx.wrappedOpenItem({ wrappedAction: 'open-manga', id: 'kingdom', source: 'comizy' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.slice(0, 2))), [['select'], ['manga', 'kingdom', 'library', 'Kingdom', false, 'comizy']]);
  assert.equal(ctx.state.currentSourceId, 'comizy');
  await ctx.wrappedOpenItem({ wrappedAction: 'open-anime', id: '7' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2])), ['anime', { idMal: '7', anilistId: '70', title: 'Frieren', cover: 'c', episodes: 28 }, null]);
  await ctx.wrappedOpenItem({ wrappedAction: 'open-author', name: 'Hara Yasuhisa' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[3])), ['author', 'Hara Yasuhisa']);
  const before = calls.length;
  await ctx.wrappedOpenItem({ wrappedAction: 'open-manga', id: 'not-in-the-library' });
  assert.equal(calls.length, before, 'an id that was not drawn on the page opens nothing');
});

test('every bar shows its number above it, a zero shows none, and the blocks of the page have the same space as the cards', () => {
  const { ctx } = sandbox();
  const html = ctx._wColumns([0, 3, 1200], ['a', 'b', 'c'], (i, v) => `${i}:${v}`);
  assert.match(html, /<i style="height:0%"><\/i>/, 'nothing above an empty bar');
  assert.match(html, /<i style="height:\d+%" data-value="3"><\/i>/);
  assert.match(html, /data-value="1,200"/, 'the number is written the way the page writes numbers');
  const css = read('../css-modules/analytics-wrapped.css');
  assert.match(css, /\.wrapped-column i\[data-value\]::before \{ content: attr\(data-value\)/);
  assert.match(css, /\.wrapped-body \{ display: flex; flex-direction: column; gap: 1rem; \}/);
  assert.match(css, /\.wrapped-grid \{[^}]*gap: 1rem;/);
  assert.match(css, /\.wrapped-kpis \{[^}]*gap: 1rem;/);
});
