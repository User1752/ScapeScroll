'use strict';

// "You might also like" on the manga page, from AniList's recommendations (public/modules/ui-similar-anilist.js). What must hold:
//  - AniList's answer is read as plain values: manga only, each title once, a title and an https cover or nothing, capped, nothing as markup;
//  - what the person's settings and library leave of it: the title itself and what the library has are not offered, Hide NSFW and the genre blacklist apply;
//  - the answer is kept a few days and read again after that, a broken store means asking again, and the store does not grow without end;
//  - the row is drawn only when there are enough to show, and otherwise the page keeps its genre-based row; a page left in the meantime is not drawn on;
//  - a click is handed to the lookup the author search already uses, from one listener on the row.
// The real module runs in a vm sandbox with a fake page and a fake AniList.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (name) => fs.readFileSync(path.join(MODULES, name), 'utf8').replace(/\r\n/g, '\n');

function locale(lang) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(MODULES, `i18n/locales/${lang}.js`), 'utf8'), ctx);
  return ctx.window.ScrollScapeI18nLocales[lang];
}
const EN = locale('en-GB');

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}

function sandbox({ settings = {}, favorites = [], links = {}, graphql, storage = memoryStorage() } = {}) {
  const calls = [];
  const opened = [];
  const toasts = [];
  const ctx = {
    console, JSON, Math, Number, String, Object, Array, Set, Date, Promise,
    localStorage: storage,
    state: { settings, favorites },
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    t: (key) => EN[key] ?? key,
    window: {},
    document: { createElement: () => { const el = { className: '', textContent: '', remove() {} }; return el; } },
    _alGetAllLinks: () => links,
    _alGetLink: (id) => links[id] || null,
    anilistGQL: graphql ? async (query, variables) => { calls.push({ query, variables }); return graphql(query, variables); } : undefined,
    _resolveAndOpenAuthorTitle: (title, id) => opened.push([title, id]),
    showToast: (...args) => toasts.push(args),
    initRowAutoScroll: () => {},
  };
  vm.createContext(ctx);
  const utils = read('utils.js');
  vm.runInContext(`${utils.slice(utils.indexOf('const NSFW_TAGS = new Set(['), utils.indexOf('// ── Webtoon / Manhwa / Manhua auto-detection'))}\nthis.isNsfwTag = isNsfwTag;`, ctx);
  vm.runInContext(read('ui-anilist-match.js'), ctx, { filename: 'ui-anilist-match.js' }); // which AniList title a name is: shared with every place that asks
  vm.runInContext(`${read('ui-similar-anilist.js')}\nthis.SIMILAR_AL = SIMILAR_AL;`, ctx, { filename: 'ui-similar-anilist.js' });
  return { ctx, calls, opened, toasts, storage };
}

const node = (id, over = {}, rating = 10) => ({
  rating,
  mediaRecommendation: { id, type: 'MANGA', format: 'MANGA', countryOfOrigin: 'JP', isAdult: false, genres: ['Action', 'Drama'], averageScore: 84, title: { romaji: `Romaji ${id}`, english: `English ${id}` }, coverImage: { large: `https://s4.anilist.co/c${id}.jpg` }, ...over },
});
const answer = (nodes, id = 777) => ({ data: { Media: { id, recommendations: { nodes } } } });

// ── what AniList says, as plain values ──────────────────────────────────────

test('the answer is read as plain values: manga only, each title once, a title and an https cover or nothing, capped', () => {
  const { ctx } = sandbox();
  const items = ctx.similarAlParse([
    node(1), node(1), node(2, { type: 'ANIME' }), node(3, { title: { romaji: '', english: '' } }), node(4, { coverImage: { large: 'javascript:alert(1)' } }),
    node(5, { averageScore: 250, genres: Array.from({ length: 30 }, (_, i) => `G${i}`), isAdult: true }), node(6, { title: { english: 'A'.repeat(500) } }), null, { rating: 3 }, { mediaRecommendation: null },
    node(7, { title: { romaji: '  Spaced \n  Out  ' } }),
  ]);
  assert.deepEqual([...items.map((i) => i.id)], [1, 4, 5, 6, 7], 'the repeat, the anime and the one with no title are out'); // [...x]: an array made inside the vm is another realm's
  assert.equal(items[1].cover, '', 'a cover that is not an https address is dropped');
  assert.deepEqual([items[2].score, items[2].genres.length, items[2].adult], [100, 12, true], 'score within 0-100, at most 12 genres');
  assert.equal(items[3].title.length, 120);
  assert.equal(items[4].title, 'Spaced Out');
  assert.equal(ctx.similarAlParse(undefined).length, 0);
  assert.equal(ctx.similarAlParse('x').length, 0);
});

// ── what the settings and the library leave ─────────────────────────────────

test('the title itself and what the library has are not offered; Hide NSFW and the blacklist apply', () => {
  const { ctx } = sandbox();
  const item = (id, genres = ['Action'], adult = false) => ({ id, title: `T${id}`, cover: '', genres, score: 80, votes: 1, adult });
  const items = [item(1), item(2), item(3, ['Ecchi']), item(4, ['Action'], true), item(5, ['Boys Love']), item(6, ['Drama'])];
  const ids = (settings, owned = [], self = 1) => [...ctx.similarAlVisible(items, settings, new Set(owned), self)].map((i) => i.id);
  assert.deepEqual(ids({}), [2, 3, 4, 5, 6], 'only the title itself is out');
  assert.deepEqual(ids({}, ['6']), [2, 3, 4, 5], 'and what the library has');
  assert.deepEqual(ids({ hideNsfw: true }), [2, 5, 6], 'the adult flag and an adult genre are out');
  assert.deepEqual(ids({ genreBlacklist: ['boys love'] }), [2, 3, 4, 6], 'the blacklist, compared without case');
  assert.deepEqual(ids({ hideNsfw: true, genreBlacklist: ['boys love'] }), [2, 6]);
  assert.deepEqual(ids(undefined), [2, 3, 4, 5, 6]);
});

test('the AniList ids the library has: those the Tracker linked and those on favorites', () => {
  const { ctx } = sandbox({ links: { a: 11, b: '22', c: 0 }, favorites: [{ anilistId: 33 }, { anilistId: '' }, null, {}] });
  assert.deepEqual([...ctx.similarAlOwnedIds()].sort(), ['11', '22', '33']);
});

// ── the kept answers ────────────────────────────────────────────────────────

test('the answer is kept for a few days, read again after that, a broken store means asking again, and the store is bounded', () => {
  const s = sandbox();
  const { ctx, storage } = s;
  assert.equal(ctx.similarAlCacheGet('id:1'), null);
  ctx.similarAlCacheSet('id:1', { id: 1, items: [{ id: 9 }] });
  assert.equal(ctx.similarAlCacheGet('id:1').items[0].id, 9);
  const kept = JSON.parse(storage.data[ctx.SIMILAR_AL.cacheKey]);
  kept['id:1'].at = Date.now() - ctx.SIMILAR_AL.ttlMs - 1000;
  storage.data[ctx.SIMILAR_AL.cacheKey] = JSON.stringify(kept);
  assert.equal(ctx.similarAlCacheGet('id:1'), null, 'too old');
  storage.data[ctx.SIMILAR_AL.cacheKey] = '{not json';
  assert.equal(ctx.similarAlCacheGet('id:1'), null);
  ctx.similarAlCacheSet('id:2', { id: 2, items: [] });
  assert.ok(ctx.similarAlCacheGet('id:2'), 'a store that was broken is written again');
  for (let i = 0; i < ctx.SIMILAR_AL.cacheMax + 20; i += 1) ctx.similarAlCacheSet(`id:x${i}`, { id: i, items: [] });
  assert.ok(Object.keys(JSON.parse(storage.data[ctx.SIMILAR_AL.cacheKey])).length <= ctx.SIMILAR_AL.cacheMax);
  const blocked = sandbox({ storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } });
  assert.doesNotThrow(() => blocked.ctx.similarAlCacheSet('k', { id: 1, items: [] }));
  assert.equal(blocked.ctx.similarAlCacheGet('k'), null);
});

// ── asking AniList ──────────────────────────────────────────────────────────

// a fake AniList: the search for candidates answers with the given ones, the request by id with the given recommendations
const fakeAniList = ({ candidates = [], recs = [node(1)] } = {}) => (query) => (/Page\(/.test(query) ? { data: { Page: { media: candidates } } } : answer(recs, 5));
const cand = (id, romaji, english = null, native = null, synonyms = []) => ({ id, title: { romaji, english, native }, synonyms });
// an AniList that knows the title by name (its one candidate has that name) and has these recommendations for it
const knowing = (name, recs) => (query) => (/Page\(/.test(query) ? { data: { Page: { media: [cand(777, name)] } } } : answer(recs, 777));

test('AniList is asked by the id when it is known; by the name only when one candidate is clearly the same title; no clear match is no answer', async () => {
  const known = sandbox({ graphql: fakeAniList() });
  const byId = await known.ctx.similarAlFetch(46765, 'Kingdom');
  assert.equal(known.calls.length, 1, 'with the id there is nothing to search');
  assert.match(known.calls[0].query, /Media\(id: \$id, type: MANGA\)/);
  assert.match(known.calls[0].query, /recommendations\(sort: RATING_DESC/);
  assert.deepEqual([known.calls[0].variables.id, byId.items.length], [46765, 1]);

  const byName = sandbox({ graphql: fakeAniList({ candidates: [cand(10, 'Kingdom Hearts'), cand(46765, 'Kingdom', 'Kingdom')] }) });
  const found = await byName.ctx.similarAlFetch(0, '  Kingdom  \n ');
  assert.equal(byName.calls.length, 2, 'the candidates, then the recommendations of the one that matches');
  assert.match(byName.calls[0].query, /Page\(perPage: 8\)/);
  assert.equal(byName.calls[0].variables.search, 'Kingdom');
  assert.equal(byName.calls[1].variables.id, 46765, 'the recommendations are those of the candidate that is the same title, not of the first one');
  assert.ok(found.items.length > 0);

  const other = sandbox({ graphql: fakeAniList({ candidates: [cand(77, 'Sweet Home'), cand(78, 'Hell City'), cand(79, 'Gangnam Sink')] }) });
  assert.equal(await other.ctx.similarAlFetch(0, ['RRR']), null, 'AniList found other titles for a short name: none of them is shown as this one');
  assert.equal(other.calls.length, 1, 'and no recommendations were asked for');
  const none = sandbox({ graphql: () => ({ data: { Page: { media: [] } } }) });
  assert.equal(await none.ctx.similarAlFetch(0, 'Nothing'), null);
  assert.equal(await sandbox().ctx.similarAlFetch(0, 'x'), null, 'without the AniList helper');
  assert.equal(await known.ctx.similarAlFetch(0, ['', '  ']), null, 'no name, no search');
});

test('the match is judged on every name: romaji, English, native and synonyms against the title and its alternative title', () => {
  const { ctx } = sandbox();
  const list = [cand(1, 'Something Else'), cand(2, 'Rock n Roll Ricky', null, 'ＲＲＲ', ['R.R.R'])];
  assert.equal(ctx.anilistMatchPick(list, ['RRR']), 2, 'full-width letters are folded: the native title ＲＲＲ is RRR');
  assert.equal(ctx.anilistMatchPick(list, ['R.R.R']), 2, 'and a synonym matches');
  assert.equal(ctx.anilistMatchPick([cand(8, 'RRR')], ['ＲＲＲ（ロックンロールリッキー）']), 8, 'a title with a parenthesis is compared without it too');
  assert.equal(ctx.anilistMatchPick([cand(3, 'Hajime no Ippo', 'Fighting Spirit')], ['Fighting Spirit!']), 3, 'case and punctuation do not matter');
  assert.equal(ctx.anilistMatchPick([cand(4, 'Hajime no Ippo')], ['Hajime no Ippo: The Fighting']), 0, 'a longer, different name is not the same title');
  assert.equal(ctx.anilistMatchPick([], ['x']), 0);
  assert.equal(ctx.anilistMatchPick(null, ['x']), 0);
  assert.equal(ctx.anilistMatchPick([cand(0, 'x'), cand('a', 'x'), null], ['x']), 0, 'a candidate with no usable id is not a match');
  // with the app's own title comparison (ui-migrate.js) the threshold decides
  const s2 = sandbox();
  s2.ctx._titleSimilarity = (a, b) => (a.toLowerCase() === b.toLowerCase() ? 1 : (b.toLowerCase().includes(a.toLowerCase()) ? 0.9 : 0.2));
  assert.equal(s2.ctx.anilistMatchPick([cand(5, 'Kingdom: The Anime Film')], ['kingdom']), 5);
  assert.equal(s2.ctx.anilistMatchPick([cand(6, 'Berserk')], ['kingdom']), 0);
});

test('a card that opened a title leaves a hint, and the page of that title uses it before any name search', async () => {
  const s = sandbox({ graphql: fakeAniList({ recs: Array.from({ length: 6 }, (_, i) => node(i + 20)) }) });
  assert.equal(s.ctx.similarAlHintFor('mangadex', 'rrr-id'), 0);
  s.ctx.similarAlRememberHint('mangadex', 'rrr-id', '31337');
  s.ctx.similarAlRememberHint('', 'x', 5);
  s.ctx.similarAlRememberHint('mangadex', 'y', 'nope');
  s.ctx.similarAlRememberHint('mangadex', 'z', -3);
  assert.equal(s.ctx.similarAlHintFor('mangadex', 'rrr-id'), 31337);
  assert.equal(s.ctx.similarAlHintFor('mangadex', 'y') + s.ctx.similarAlHintFor('mangadex', 'z') + s.ctx.similarAlHintFor('', 'x'), 0, 'nothing is kept for a bad hint');
  const p = page();
  assert.equal(await s.ctx.loadSimilarFromAniList({ id: 'rrr-id', title: 'RRR' }, 'mangadex', { section: p.section, row: p.row, isStale: () => false }), true);
  assert.equal(s.calls.length, 1, 'no search by name: the id of the hint was used');
  assert.equal(s.calls[0].variables.id, 31337);
  // the store of hints is bounded and a broken one is no error
  for (let i = 0; i < s.ctx.SIMILAR_AL.hintsMax + 30; i += 1) s.ctx.similarAlRememberHint('src', `m${i}`, i + 1);
  assert.ok(Object.keys(JSON.parse(s.storage.data[s.ctx.SIMILAR_AL.hintsKey])).length <= s.ctx.SIMILAR_AL.hintsMax);
  s.storage.data[s.ctx.SIMILAR_AL.hintsKey] = '{broken';
  assert.equal(s.ctx.similarAlHintFor('src', 'm1'), 0);
});

test('a short name that AniList answers with other titles leaves the page its own row (the case of "RRR" under another title\'s recommendations)', async () => {
  const s = sandbox({ graphql: fakeAniList({ candidates: [cand(77, 'Sweet Home'), cand(78, 'Hell City')], recs: Array.from({ length: 8 }, (_, i) => node(i + 40)) }) });
  const p = page();
  assert.equal(await s.ctx.loadSimilarFromAniList({ id: 'rrr-id', title: 'RRR', altTitle: 'ＲＲＲ（ロックンロールリッキー）' }, 'mangadex', { section: p.section, row: p.row, isStale: () => false }), false);
  assert.equal(p.row.innerHTML, '', 'nothing from the wrong title was drawn');
  assert.equal(s.calls.length, 2, 'the title and the alternative title were searched, and no recommendations were asked for');
  assert.ok(s.calls.every((c) => /Page\(/.test(c.query)));
});

test('two titles of one name are told apart by the year when the page knows it; a first search that finds nothing clear is followed by one with the alternative title', async () => {
  const { ctx } = sandbox();
  const old = { ...cand(1, 'Rocky'), startDate: { year: 1998 } };
  const fresh = { ...cand(2, 'Rocky'), startDate: { year: 2007 } };
  assert.equal(ctx.anilistMatchPick([old, fresh], ['Rocky'], { year: 2007 }), 2, 'the one of the same year');
  assert.equal(ctx.anilistMatchPick([old, fresh], ['Rocky'], { year: 2006 }), 2, 'within a year');
  assert.equal(ctx.anilistMatchPick([old], ['Rocky'], { year: 2007 }), 0, 'only the one of another year: not this title');
  assert.equal(ctx.anilistMatchPick([old], ['Rocky'], {}), 1, 'no year known: the name decides');
  assert.equal(ctx.anilistMatchPick([cand(3, 'Rocky')], ['Rocky'], { year: 2007 }), 3, 'the candidate has no year: the name decides');

  const s = sandbox({ graphql: (query, variables) => (/Page\(/.test(query)
    ? { data: { Page: { media: variables.search === 'RRR' ? [cand(77, 'Sweet Home')] : [cand(31337, 'RRR')] } } }
    : answer([node(1)], 31337)) });
  const found = await s.ctx.similarAlFetch(0, ['RRR', 'ＲＲＲ (Rock n Roll Ricky)'.replace('ＲＲＲ', 'RRR!')]);
  assert.equal(s.calls.filter((c) => /Page\(/.test(c.query)).length, 2, 'the alternative title was searched too');
  assert.equal(s.calls[s.calls.length - 1].variables.id, 31337);
  assert.ok(found);
  const once = sandbox({ graphql: fakeAniList({ candidates: [cand(5, 'Kingdom')] }) });
  await once.ctx.similarAlFetch(0, ['Kingdom', 'Kingdom']);
  assert.equal(once.calls.filter((c) => /Page\(/.test(c.query)).length, 1, 'the same name twice is searched once, and a clear match stops the search');
});

// ── the row ─────────────────────────────────────────────────────────────────

function page() {
  const section = { hiddenClass: true, classList: { add() {}, remove(c) { if (c === 'hidden') section.hiddenClass = false; } }, querySelector: () => null };
  const listeners = [];
  const row = { innerHTML: '', addEventListener: (type, fn) => listeners.push([type, fn]) };
  return { section, row, listeners };
}

test('the row is drawn from the recommendations that are left, once, with one listener; too few leaves the page its own row; a page left meanwhile is not drawn on', async () => {
  const many = Array.from({ length: 8 }, (_, i) => node(100 + i));
  const s = sandbox({ settings: {}, links: { 'manga-a': 500 }, graphql: () => answer([...many, node(500)], 500) });
  const p = page();
  const target = { section: p.section, row: p.row, isStale: () => false };
  assert.equal(await s.ctx.loadSimilarFromAniList({ id: 'manga-a', title: 'A' }, 'src', target), true);
  assert.equal((p.row.innerHTML.match(/similar-al-card"/g) || []).length, 8, 'the title itself is not among them');
  assert.equal(p.section.hiddenClass, false, 'the section is shown');
  assert.equal(p.listeners.length, 1, 'one listener on the row');
  assert.match(p.row.innerHTML, /AniList<\/span>/);
  // the second time nothing is asked
  const again = page();
  await s.ctx.loadSimilarFromAniList({ id: 'manga-a', title: 'A' }, 'src', { section: again.section, row: again.row, isStale: () => false });
  assert.equal(s.calls.length, 1, 'the kept answer is used');
  assert.equal(again.listeners.length, 1);

  const few = sandbox({ graphql: knowing('X', [node(1), node(2)]) });
  const q = page();
  assert.equal(await few.ctx.loadSimilarFromAniList({ id: 'x', title: 'X' }, 's', { section: q.section, row: q.row, isStale: () => false }), false, 'two are too few: the page keeps its own row');
  assert.equal(q.row.innerHTML, '');

  const left = sandbox({ graphql: knowing('X', many) });
  const r = page();
  assert.equal(await left.ctx.loadSimilarFromAniList({ id: 'x', title: 'X' }, 's', { section: r.section, row: r.row, isStale: () => true }), true, 'handled, so the page does not draw its own row over the new page');
  assert.equal(r.row.innerHTML, '');

  const down = sandbox({ graphql: () => { throw new Error('AniList down'); } });
  const u = page();
  assert.equal(await down.ctx.loadSimilarFromAniList({ id: 'x', title: 'X' }, 's', { section: u.section, row: u.row, isStale: () => false }), false, 'an error is no answer, and does not escape');
});

test('Hide NSFW and the blacklist apply to the row when it is drawn, also to an answer that was kept before they were set', async () => {
  const mixed = [node(1), node(2, { genres: ['Ecchi'] }), node(3, { isAdult: true }), node(4, { genres: ['Yaoi'] }), node(5), node(6), node(7), node(8)];
  const settings = { hideNsfw: true, genreBlacklist: [] };
  const s = sandbox({ settings, graphql: knowing('M', mixed) });
  const p = page();
  await s.ctx.loadSimilarFromAniList({ id: 'm', title: 'M' }, 's', { section: p.section, row: p.row, isStale: () => false });
  assert.equal((p.row.innerHTML.match(/similar-al-card"/g) || []).length, 5, 'Ecchi, adult and Yaoi are out: 8 - 3');
  settings.hideNsfw = false;
  settings.genreBlacklist = ['action'];
  const q = page();
  assert.equal(await s.ctx.loadSimilarFromAniList({ id: 'm', title: 'M' }, 's', { section: q.section, row: q.row, isStale: () => false }), false, 'with the blacklist on the shared genre nothing is left to show');
  assert.equal(s.calls.length, 2, 'the candidates and the recommendations were asked once, and not again for the second drawing');
});

test('a card is text only, whatever the title or cover says, and the whole card is the click', () => {
  const { ctx } = sandbox();
  const html = ctx.similarAlCardHtml({ id: 9, title: '"><img src=x onerror=PWN(1)>', cover: 'https://s4.anilist.co/c.jpg', genres: ['<b>Action</b>', 'Drama'], score: 84, votes: 3, adult: false });
  assert.ok(!/<img src=x/.test(html) && !/<b>Action/.test(html), 'nothing from AniList is markup');
  assert.match(html, /data-anilist-id="9"/);
  assert.match(html, /&#9733; 8\.4/);
  assert.match(html, /Find in my sources/);
  const none = ctx.similarAlCardHtml({ id: 1, title: 'T', cover: '', genres: [], score: 0, votes: 0, adult: false });
  assert.match(none, /no-cover/);
  assert.ok(!/similar-al-score/.test(none), 'no score, no pill');
});

test('a click on a card is handed to the lookup of the author search, with the title and the AniList id', async () => {
  const s = sandbox({ graphql: knowing('M', Array.from({ length: 6 }, (_, i) => node(i + 1))) });
  const p = page();
  await s.ctx.loadSimilarFromAniList({ id: 'm', title: 'M' }, 's', { section: p.section, row: p.row, isStale: () => false });
  const [type, handler] = p.listeners[0];
  assert.equal(type, 'click');
  const card = { dataset: { authorTitle: 'English 3', anilistId: '3' } };
  handler({ target: { closest: (sel) => (sel === '.similar-al-card' ? card : null) } });
  assert.deepEqual(s.opened, [['English 3', '3']]);
  assert.equal(s.toasts.length, 1, 'the person is told it is being looked for');
  handler({ target: { closest: () => null } });
  handler({ target: null });
  assert.equal(s.opened.length, 1, 'a click elsewhere does nothing');
});

// ── the wiring ──────────────────────────────────────────────────────────────

test('it is wired: the manga page asks AniList first and keeps its genre row as the fallback, the script is on the page, and the words exist in both languages', () => {
  const search = read('ui-search.js');
  const from = search.indexOf('async function loadSimilarManga(');
  const anilist = search.indexOf('loadSimilarFromAniList(result, sourceId', from);
  const genres = search.indexOf('const genres = (result?.genres || []).filter(Boolean);', from);
  assert.ok(from > 0 && anilist > from && genres > anilist, 'AniList is asked before the genre-based row');
  assert.match(search, /setTimeout\(\(\) => resolve\(false\), 8000\)/, 'and it does not hold the page for long');
  const html = fs.readFileSync(path.join(MODULES, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('modules/ui-similar-anilist.js') > html.indexOf('modules/ui-genre-author-navigation.js'), 'after the lookup it uses');
  for (const lang of ['en-GB', 'pt-PT']) {
    const table = locale(lang);
    for (const key of ['similar.anilistNote', 'similar.find', 'similar.findTitle']) assert.ok(typeof table[key] === 'string' && table[key], `${lang} ${key}`);
  }
  const source = read('ui-similar-anilist.js');
  assert.ok(source.split('\n').length < 450, 'under the size limit');
  assert.ok(!/\.innerHTML\s*=\s*[^;]*item\.title/.test(source), 'no title put into markup without escaping');
});

test('between titles with the very same name the one more people have is the one meant, whatever order AniList lists them in', () => {
  const { ctx } = sandbox();
  const doujinshi = { ...cand(1, 'Real'), popularity: 40 };
  const famous = { ...cand(2, 'Real'), popularity: 52000 };
  assert.equal(ctx.anilistMatchPick([doujinshi, famous], ['Real']), 2);
  assert.equal(ctx.anilistMatchPick([famous, doujinshi], ['Real']), 2, 'in the other order too');
  // a clearly better name wins over a more popular title of a worse name
  assert.equal(ctx.anilistMatchPick([{ ...cand(3, 'Real'), popularity: 5 }, { ...cand(4, 'Real Account'), popularity: 99999 }], ['Real']), 3, 'an exact name beats a longer name, however popular');
  assert.equal(ctx.anilistMatchPick([cand(5, 'Real')], ['Real']), 5, 'no popularity given: the first of equals');
});
