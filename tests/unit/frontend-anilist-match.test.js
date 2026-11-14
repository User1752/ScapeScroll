'use strict';

// Which AniList title a manga is (public/modules/ui-anilist-match.js), and the places that used to take AniList's first text answer. What must hold:
//  - a candidate is accepted only if it is CLEARLY the same title: a name alike enough, a year within one when both are known; the author raises or lowers a
//    candidate but never rules on its own; between equals the more popular wins; no clear candidate is "0", never a guess;
//  - "Sugar" (2001, Arai Hideki) is not "SUG*R" (2025) or a one-shot of 2012, however AniList ranks them;
//  - the cover's link opens the AniList page of that title, or AniList's own search when none is clear, and a link between the manga and an AniList entry
//    (which decides where the progress is written) is written only for a title that is clearly this one.
// The real module runs in a vm sandbox; the call sites are cut out of their files and run against fakes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (name) => fs.readFileSync(path.join(MODULES, name), 'utf8').replace(/\r\n/g, '\n');

function sandbox({ graphql, links = {}, hints = {}, similarity } = {}) {
  const calls = [];
  const ctx = {
    console, JSON, Math, Number, String, Object, Array, Set, Date, Promise,
    window: {},
    anilistGQL: graphql ? async (query, variables) => { calls.push({ query, variables }); return graphql(query, variables); } : undefined,
    _alGetLink: (id) => links[id] || null,
    similarAlHintFor: (sourceId, id) => hints[`${sourceId}::${id}`] || 0,
  };
  if (similarity) ctx._titleSimilarity = similarity;
  vm.createContext(ctx);
  vm.runInContext(read('ui-anilist-match.js'), ctx, { filename: 'ui-anilist-match.js' });
  return { ctx, calls };
}

const person = (full, native = null) => ({ name: { full, native } });
const cand = (id, romaji, over = {}) => ({ id, title: { romaji, english: null, native: null }, synonyms: [], popularity: 0, startDate: { year: 2000 }, staff: { nodes: [] }, ...over });
// the three AniList candidates of the search for "Sugar" that the Tracker showed
const SUGAR = [
  cand(1, 'SUG★R', { startDate: { year: 2025 }, staff: { nodes: [person('Toranosuke Shimada')] }, popularity: 17 }),
  cand(2, 'Sugar', { startDate: { year: 2012 }, staff: { nodes: [person('Someone Else')] }, popularity: 400 }),
  cand(3, 'Sugar', { startDate: { year: 2001 }, staff: { nodes: [person('Hideki Arai', '新井英樹')] }, popularity: 2500 }),
  cand(4, 'Sugar Trap', { startDate: { year: 2024 } }),
];

// ── the author ──────────────────────────────────────────────────────────────

test('an author is the same person written in either order, one of several, or by the native name the page has; unknown when it cannot be told', () => {
  const { ctx } = sandbox();
  const staff = [person('Hideki Arai', '新井英樹'), person('Toranosuke Shimada')];
  assert.equal(ctx.anilistSameAuthor('Arai Hideki', staff), true, 'the order of the words does not matter');
  assert.equal(ctx.anilistSameAuthor('hideki ARAI', staff), true);
  assert.equal(ctx.anilistSameAuthor('Shimada Toranosuke, Someone Else', staff), true, 'one of several');
  assert.equal(ctx.anilistSameAuthor('Nobody Known', staff), false);
  assert.equal(ctx.anilistSameAuthor('Arai', [person('Hideki Arai')]), false, 'a surname alone is not enough for a person with a name of two words: too many people share one');
  assert.equal(ctx.anilistSameAuthor('Imai', [person('Imai')]), true, 'a one-word name is the one-word name');
  assert.equal(ctx.anilistSameAuthor('Yuu Imai', [person('Imai Kazuo'), person('Yuu Imai')]), true, 'the right one of several people is found');
  assert.equal(ctx.anilistSameAuthor('Takehiko Inoue', [person('Takehiko Inoue Jr')]), true, 'all the page words are in the name');
  assert.equal(ctx.anilistSameAuthor('Who', [person('Hideki Arai', '新井英樹')], ['x (新井英樹)']), true, 'the native name is in the page\'s alternative title');
  assert.equal(ctx.anilistSameAuthor('', staff), null, 'no author');
  assert.equal(ctx.anilistSameAuthor('Arai Hideki', []), null, 'AniList lists nobody');
  assert.equal(ctx.anilistSameAuthor('Arai Hideki', undefined), null);
  assert.equal(ctx.anilistSameAuthor(undefined, undefined), null);
  assert.equal(ctx.anilistSameAuthor('Arai Hideki', [null, {}, { name: {} }]), null, 'entries with no name are nobody');
});

// ── the pick ────────────────────────────────────────────────────────────────

test('"Sugar" of 2001 by Arai Hideki is picked, not "SUG*R" of 2025 or the one-shot of 2012, with or without the year and the author', () => {
  const { ctx } = sandbox();
  assert.equal(ctx.anilistMatchPick(SUGAR, ['Sugar', 'シュガー (新井英樹)'], { year: 2002, author: 'Arai Hideki' }), 3, 'with all the page knows');
  assert.equal(ctx.anilistMatchPick(SUGAR, ['Sugar'], { year: 2002 }), 3, 'the year alone: the others are too far in time');
  assert.equal(ctx.anilistMatchPick(SUGAR, ['Sugar'], { author: 'Arai Hideki' }), 3, 'the author alone');
  assert.equal(ctx.anilistMatchPick(SUGAR, ['Sugar']), 3, 'the name alone: the more popular of the two that are called Sugar');
  assert.equal(ctx.anilistMatchPick(SUGAR, ['SUG★R'], { year: 2025 }), 1, 'and the title that really is SUG*R is found when asked for');
  assert.equal(ctx.anilistMatchPick(SUGAR.filter((c) => c.id !== 3), ['Sugar'], { year: 2002, author: 'Arai Hideki' }), 0, 'with the right one missing nothing else is taken for it');
});

test('the author raises or lowers a candidate but is only one signal, and the more popular wins between equals', () => {
  const { ctx } = sandbox();
  const same = (id, name, staff, popularity) => cand(id, name, { staff: { nodes: staff }, popularity });
  const pair = [same(10, 'Real', [person('Wrong Person')], 99999), same(11, 'Real', [person('Takehiko Inoue')], 5)];
  assert.equal(ctx.anilistMatchPick(pair, ['Real'], { author: 'Inoue Takehiko' }), 11, 'the author of the page beats popularity between equal names');
  assert.equal(ctx.anilistMatchPick(pair, ['Real']), 10, 'no author known: the more popular');
  assert.equal(ctx.anilistMatchPick([same(12, 'Real', [], 1), same(13, 'Real', [person('Takehiko Inoue')], 5)], ['Real'], { author: 'Inoue Takehiko' }), 13, 'a candidate whose author is known and is the same is over one with no staff');
  // a different author lowers a candidate, but a name that is clearly better still wins
  const exact = same(14, 'Real', [person('Other Person')], 10);
  const looser = same(15, 'Real Estate Stories', [person('Takehiko Inoue')], 10);
  assert.equal(ctx.anilistMatchPick([exact, looser], ['Real'], { author: 'Inoue Takehiko' }), 14, 'the author does not make a different name the same title');
  // the name decides before anything: nothing alike enough is nothing
  assert.equal(ctx.anilistMatchPick([same(16, 'Completely Different', [person('Takehiko Inoue')], 1e6)], ['Real'], { author: 'Inoue Takehiko' }), 0, 'the right author and the wrong name is not a match');
  assert.equal(ctx.anilistMatchPick(null, ['x']), 0);
  assert.equal(ctx.anilistMatchPick([cand(0, 'x'), cand('a', 'x'), null, {}], ['x']), 0);
  assert.equal(ctx.anilistMatchPick([cand(1, 'x')], []), 0, 'no name to compare');
});

test('the years must be within one of each other when both are known, and a missing year decides nothing', () => {
  const { ctx } = sandbox();
  const at = (id, year) => cand(id, 'Rocky', { startDate: year === null ? null : { year } });
  assert.equal(ctx.anilistMatchPick([at(1, 1998), at(2, 2007)], ['Rocky'], { year: 2007 }), 2);
  assert.equal(ctx.anilistMatchPick([at(1, 2006)], ['Rocky'], { year: 2007 }), 1, 'a year of difference is fine (sources date a title by its volumes, AniList by its first chapter)');
  assert.equal(ctx.anilistMatchPick([at(1, 2005)], ['Rocky'], { year: 2007 }), 0, 'two years is another title');
  assert.equal(ctx.anilistMatchPick([at(1, null)], ['Rocky'], { year: 2007 }), 1, 'AniList has no year: the name decides');
  assert.equal(ctx.anilistMatchPick([at(1, 1998)], ['Rocky']), 1, 'the page has none: the name decides');
  assert.equal(ctx.anilistMatchPick([at(1, 1998)], ['Rocky'], { year: '2007' }), 0, 'a year given as text counts');
});

// ── asking ──────────────────────────────────────────────────────────────────

const pageAnswer = (media) => ({ data: { Page: { media } } });

test('the candidates are asked for (the title, then the alternative title), a clear one stops the search, and nothing clear is 0', async () => {
  const s = sandbox({ graphql: (q, v) => pageAnswer(v.search === 'Sugar' ? [cand(2, 'Sugar', { startDate: { year: 2012 } })] : SUGAR) });
  const id = await s.ctx.anilistFindMediaId({ names: ['Sugar', 'Shugaa', 'Sugar'], year: 2002, author: 'Arai Hideki' });
  assert.equal(id, 3, 'the first search found only the one of 2012, too far: the second finds the right one');
  assert.deepEqual(s.calls.map((c) => c.variables.search), ['Sugar', 'Shugaa'], 'at most the two different names, in order');
  assert.match(s.calls[0].query, /Page\(perPage: 8\)/);
  for (const field of ['synonyms', 'popularity', 'startDate { year }', 'staff(perPage: 4)', 'native']) assert.ok(s.calls[0].query.includes(field), field);
  const clear = sandbox({ graphql: () => pageAnswer(SUGAR) });
  assert.equal(await clear.ctx.anilistFindMediaId({ names: ['Sugar', 'Other'], year: 2002 }), 3);
  assert.equal(clear.calls.length, 1, 'a clear match stops the search');
  const none = sandbox({ graphql: () => pageAnswer([cand(9, 'Unrelated')]) });
  assert.equal(await none.ctx.anilistFindMediaId({ names: ['Sugar', 'Shugaa'] }), 0);
  assert.equal(none.calls.length, 2);
  assert.equal(await sandbox({ graphql: () => pageAnswer(null) }).ctx.anilistFindMediaId({ names: ['x'] }), 0);
  assert.equal(await sandbox({ graphql: () => ({ errors: [{}] }) }).ctx.anilistFindMediaId({ names: ['x'] }), 0);
  assert.equal(await sandbox().ctx.anilistFindMediaId({ names: ['x'] }), 0, 'without the AniList helper');
  assert.equal(await clear.ctx.anilistFindMediaId({ names: ['', '  ', null] }), 0, 'no name, no request');
  assert.equal(await clear.ctx.anilistFindMediaId(), 0);
});

test('the id of a manga is what the library linked it to, else what the card that opened it said, else the checked match', async () => {
  const s = sandbox({ graphql: () => pageAnswer(SUGAR), links: { linked: 777 }, hints: { 'mangadex::hinted': 888 } });
  assert.equal(await s.ctx.anilistMediaIdForManga({ id: 'linked', sourceId: 'mangadex', title: 'Sugar' }), 777);
  assert.equal(await s.ctx.anilistMediaIdForManga({ id: 'hinted', sourceId: 'mangadex', title: 'Sugar' }), 888);
  assert.equal(s.calls.length, 0, 'neither asked AniList anything');
  assert.equal(await s.ctx.anilistMediaIdForManga({ id: 'new', sourceId: 'mangadex', title: 'Sugar', altTitle: 'Shugaa', year: 2002, author: 'Arai Hideki' }), 3);
  assert.equal(await s.ctx.anilistMediaIdForManga('Sugar'), 3, 'a bare title is accepted');
  assert.equal(await s.ctx.anilistMediaIdForManga(null), 0);
});

// ── the places that used to take the first answer ───────────────────────────

test('the cover opens the AniList page of the title that is clearly this one, or AniList\'s own search, and says when pop-ups are blocked', async () => {
  const source = read('ui-cover-picker.js');
  const from = source.indexOf('async function openAniListForManga(input) {');
  const to = source.indexOf('window.openAniListForManga = openAniListForManga;');
  assert.ok(from > 0 && to > from);
  const run = async (input, { resolve, popup = true } = {}) => {
    const tab = { document: { write() {} }, location: { href: '' } };
    const asked = [];
    const toasts = [];
    const ctx = { window: { open: () => (popup ? tab : null) }, showToast: (...a) => toasts.push(a), encodeURIComponent, String, anilistMediaIdForManga: resolve ? async (m) => { asked.push(m); return resolve(m); } : undefined };
    vm.createContext(ctx);
    vm.runInContext(`${source.slice(from, to)}\nthis.open = openAniListForManga;`, ctx);
    await ctx.open(input);
    return { href: tab.location.href, asked, toasts };
  };
  const page = { id: 'abc', sourceId: 'mangadex', title: 'Sugar', altTitle: 'Shugaa', year: 2002, author: 'Arai Hideki' };
  const found = await run(page, { resolve: () => 45427 });
  assert.equal(found.href, 'https://anilist.co/manga/45427');
  assert.deepEqual(JSON.parse(JSON.stringify(found.asked[0])), page, 'what the page knows is what the lookup is given');
  const unclear = await run(page, { resolve: () => 0 });
  assert.equal(unclear.href, 'https://anilist.co/search/manga?search=Sugar', 'no clear title: AniList\'s own search, the person chooses');
  const bare = await run('A Title', { resolve: () => 0 });
  assert.equal(bare.href, 'https://anilist.co/search/manga?search=A%20Title');
  assert.deepEqual(JSON.parse(JSON.stringify(bare.asked[0])), { title: 'A Title' }, 'a bare title is accepted');
  const thrown = await run(page, { resolve: () => { throw new Error('down'); } });
  assert.equal(thrown.href, 'https://anilist.co/search/manga?search=Sugar', 'a failure is the search too');
  assert.equal((await run(page, { resolve: undefined })).href, 'https://anilist.co/search/manga?search=Sugar', 'without the lookup it is the search');
  const blocked = await run(page, { resolve: () => 1, popup: false });
  assert.equal(blocked.toasts[0][0], 'Pop-up Blocked');
  const details = read('ui-search.js');
  assert.match(details, /window\.openAniListForManga\(\{ id: result\.id, sourceId: state\.currentSourceId, title: result\.title, altTitle: result\.altTitle, year: result\.year, author: result\.author \}\);/);
  assert.ok(!/Page\(page: 1, perPage: 1\)/.test(source), 'the first-answer query is gone');
});

test('the link between a manga and an AniList entry is written only for a title that is clearly this one, with what the app knows of the manga', async () => {
  const source = read('anilist.js');
  const grab = (startMarker, endMarker) => source.slice(source.indexOf(startMarker), source.indexOf(endMarker));
  const body = `${grab('async function anilistSearchMedia(', 'let _alStartupProgressSyncRunning')}\n${grab('async function _resolveAniListMediaIdForManga(', '// Pushes that could not be sent')}\nthis.resolve = _resolveAniListMediaIdForManga; this.search = anilistSearchMedia;`;
  const make = ({ links = {}, found = 0, current = null, favorites = [] } = {}) => {
    const written = [];
    const asked = [];
    const ctx = {
      links, written, asked,
      _alGetLink: (id) => links[id] || null,
      _alSetLink: (id, ai) => written.push([id, ai]),
      anilistFindMediaId: async (q) => { asked.push(q); return found; },
      state: { currentManga: current, favorites },
      Number,
    };
    vm.createContext(ctx);
    vm.runInContext(body, ctx);
    return ctx;
  };
  const linked = make({ links: { m1: 321 }, found: 5 });
  assert.equal(await linked.resolve('m1', 'Sugar'), 321);
  assert.equal(linked.asked.length, 0, 'a link already made is used, nothing is searched');
  const open = make({ found: 45427, current: { id: 'm2', altTitle: 'Shugaa', year: 2002, author: 'Arai Hideki' } });
  assert.equal(await open.resolve('m2', 'Sugar'), 45427);
  assert.deepEqual(JSON.parse(JSON.stringify(open.asked[0])), { names: ['Sugar', 'Shugaa'], year: 2002, author: 'Arai Hideki' }, 'the open manga tells titles of one name apart');
  assert.deepEqual(JSON.parse(JSON.stringify(open.written)), [['m2', 45427]], 'and the link is written');
  const owned = make({ found: 9, favorites: [{ id: 'm3', year: 1999, author: 'A B' }] });
  await owned.resolve('m3', 'Real');
  assert.deepEqual([owned.asked[0].year, owned.asked[0].author], [1999, 'A B'], 'the library\'s copy is the next place to look');
  const unclear = make({ found: 0 });
  assert.equal(await unclear.resolve('m4', 'Sugar'), 0);
  assert.equal(unclear.written.length, 0, 'no clear title: no link, so the progress goes nowhere rather than to another title');
  assert.equal(await unclear.resolve('', 'Sugar'), 0);
  assert.equal(await make({ found: 12 }).search('Sugar'), 12);
  assert.equal(await unclear.search('Sugar'), null, 'a simple search with no clear title is null');
  assert.ok(!/Media\(search: \$s, type: MANGA\) \{ id \}/.test(source), 'the first-answer query is gone from the tracker too');
});

test('it is wired: the script is on the page after the one that remembers hints, with the call sites after it, and stays under the size limit', () => {
  const html = fs.readFileSync(path.join(MODULES, '..', 'index.html'), 'utf8');
  assert.ok(html.indexOf('modules/ui-anilist-match.js') > html.indexOf('modules/ui-similar-anilist.js'));
  assert.ok(read('ui-anilist-match.js').split('\n').length < 450);
  const similar = read('ui-similar-anilist.js');
  assert.match(similar, /anilistFindMediaId\(\{ names:/);
  assert.ok(!/function similarAlPickMatch|_similarAlNameForms/.test(similar), 'the matcher is in one place');
});
