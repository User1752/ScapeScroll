'use strict';

// The library's side column has a Tags button (it replaced Categories: managing the categories moved to a gear beside the category filter). The panel it
// opens filters the library by the genres each title carries and by the person's own tags. The decisions are pure functions, tested here with the real file;
// the rest checks that the page is wired to them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', ...p), 'utf8').replace(/\r\n/g, '\n');

function load() {
  const ctx = { console, localStorage: { getItem: () => null, setItem() {} }, document: { getElementById: () => null }, state: { settings: {} } };
  vm.createContext(ctx);
  // const declarations of a classic script are not properties of the context: the file is run with them exported
  vm.runInContext(read('modules', 'ui-library-tags.js') + '\nthis.__libraryTagFilter = libraryTagFilter; this.__animeTagFilter = animeTagFilter;', ctx, { filename: 'ui-library-tags.js' });
  return ctx;
}

test('a tag is compared without case or outer spaces, and each tag counts once per title', () => {
  const { libraryTagLabelsOf, libraryTagKey } = load();
  assert.equal(libraryTagKey('  Slice of Life '), 'slice of life');
  assert.equal(libraryTagKey(undefined), '');
  const labels = libraryTagLabelsOf(['Romance', 'romance ', { name: 'Comedy' }, '', null], ['Romance', 'artist:oda']);
  assert.deepEqual([...labels.map((t) => t.key)], ['romance', 'comedy', 'artist:oda']); // [...x]: an array made inside the vm is another realm's
  assert.equal(labels[0].label, 'Romance', 'the first spelling is kept');
  assert.equal(load().libraryTagLabelsOf(undefined, undefined).length, 0);
});

test('"match all" needs every picked tag, "match any" needs one, and nothing picked matches everything', () => {
  const { libraryTagsMatch } = load();
  const keys = new Set(['romance', 'comedy', 'harem']);
  assert.equal(libraryTagsMatch(keys, new Set(), 'all'), true);
  assert.equal(libraryTagsMatch(keys, undefined, 'any'), true);
  assert.equal(libraryTagsMatch(keys, new Set(['romance', 'comedy']), 'all'), true);
  assert.equal(libraryTagsMatch(keys, new Set(['romance', 'isekai']), 'all'), false);
  assert.equal(libraryTagsMatch(keys, new Set(['romance', 'isekai']), 'any'), true);
  assert.equal(libraryTagsMatch(keys, new Set(['isekai', 'ecchi']), 'any'), false);
  assert.equal(libraryTagsMatch(new Set(), new Set(['romance']), 'all'), false, 'a title with no tags never matches a pick');
});

test('the counts: how many titles have each tag, the most used first, spelled the way most titles spell it', () => {
  const { libraryTagCounts, libraryTagLabelsOf } = load();
  const lists = [
    libraryTagLabelsOf(['Romance', 'Comedy'], []),
    libraryTagLabelsOf(['romance'], []),
    libraryTagLabelsOf(['Romance', 'Isekai'], ['artist:oda']),
    libraryTagLabelsOf(['Comedy'], []),
  ];
  const counts = libraryTagCounts(lists);
  assert.deepEqual([...counts.map((c) => `${c.label}:${c.count}`)], ['Romance:3', 'Comedy:2', 'artist:oda:1', 'Isekai:1'], 'by count, then by name');
  assert.equal(libraryTagCounts([]).length, 0);
});

test('the filter starts empty in "match all", and is not active until a tag is picked', () => {
  const ctx = load();
  assert.equal(ctx.libraryTagFilterActive(), false);
  assert.equal(ctx.__libraryTagFilter.mode, 'all');
  ctx.__libraryTagFilter.selected.add('romance');
  assert.equal(ctx.libraryTagFilterActive(), true);
});

test('the side column has Tags, the gear for the categories sits beside the category filter, and the library applies the filter', () => {
  const html = read('index.html');
  assert.match(html, /id="btnLibraryTags" title="Filter by tags"/);
  assert.match(html, /<span class="lib-side-label">Tags<\/span>/);
  const side = html.slice(html.indexOf('id="librarySideActions"'), html.indexOf('id="btnMigrateLibrary"'));
  assert.doesNotMatch(side, /Categories/, 'the old button is gone from the column');
  const filter = html.indexOf('id="libraryCategoryFilter"');
  const gear = html.indexOf('id="btnManageCategories"');
  assert.ok(gear > filter && gear - filter < 600, 'the gear follows the category filter');
  assert.match(html, /ui-library-tags\.js/);
  assert.match(html, /library-tags\.css/);

  const binding = read('modules', 'ui-ui-binding.js');
  assert.match(binding, /\$\("btnManageCategories"\)[\s\S]{0,120}showManageCategoriesModal\(\)/);
  assert.match(binding, /\$\("btnLibraryTags"\)[\s\S]{0,120}showLibraryTagsPanel\(\)/);

  const lib = read('modules', 'ui-library.js');
  assert.match(lib, /libraryTagFilterActive\(\) && !libraryTagMatchesManga\(manga\)\) hideReason = 'Tag mismatch'/, 'favourites');
  assert.match(lib, /libraryTagMatchesManga\(manga, 'local'\)\) return false/, 'local manga');
});

test('the panel draws the library again only when the pick changed, and the tags of hidden titles are not offered', () => {
  const src = read('modules', 'ui-library-tags.js');
  assert.match(src, /if \(pickOf\(\) !== startedWith\) onApply\(\);/);
  assert.match(src, /onApply: \(\) => \{ if \(typeof renderLibrary === 'function'\) renderLibrary\(\); \},/, 'manga draws the library');
  assert.match(src, /onApply: \(\) => \{ if \(typeof _animeApplyLibraryFilters === 'function'\) _animeApplyLibraryFilters\(\); \},/, 'anime applies its own filters');
  assert.match(src, /hideNsfw && typeof _isNsfwEnriched === 'function' && _isNsfwEnriched\(m\)/);
  assert.match(src, /visibleSources !== null && m\.sourceId && !visibleSources\.includes\(m\.sourceId\)/);
});

// ── anime ───────────────────────────────────────────────────────────────────

test('an anime has the tags of its genres and its own tags, and the anime pick filters on them', () => {
  const ctx = load();
  const anime = { idMal: '1', genres: ['Comedy', 'Slice of Life'], tags: ['rewatch'] };
  assert.equal([...ctx.animeTagsOf(anime).map((t) => t.key)].join(','), 'comedy,slice of life,rewatch');
  assert.equal(ctx.animeTagsOf(undefined).length, 0);
  assert.equal(ctx.animeTagMatches(anime), true, 'nothing picked: everything');
  ctx.__animeTagFilter.selected.add('comedy');
  ctx.__animeTagFilter.selected.add('rewatch');
  assert.equal(ctx.animeTagMatches(anime), true);
  assert.equal(ctx.animeTagMatches({ genres: ['Comedy'] }), false, 'match all: both tags needed');
  ctx.__animeTagFilter.mode = 'any';
  assert.equal(ctx.animeTagMatches({ genres: ['Comedy'] }), true, 'match any: one is enough');
});

test('the two libraries pick separately but share the mode, and the anime pick does not touch the manga one', () => {
  const ctx = load();
  ctx.__animeTagFilter.selected.add('comedy');
  assert.equal(ctx.libraryTagFilterActive(), false);
  assert.equal(ctx.animeTagFilterActive(), true);
  ctx.__libraryTagFilter.mode = 'any';
  assert.equal(ctx.__animeTagFilter.mode, 'any', 'one mode for both');
  ctx.__animeTagFilter.mode = 'all';
  assert.equal(ctx.__libraryTagFilter.mode, 'all');
});

test('the anime side column has Tags, the gear sits beside its category filter, and the anime library applies the pick', () => {
  const html = read('index.html');
  assert.match(html, /id="btnAnimeLibraryTags" title="Filter by tags"/);
  assert.match(html, /id="animeLibTagsBadge"/);
  const side = html.slice(html.indexOf('id="animeLibrarySideActions"'), html.indexOf('id="btnScanAnimeDuplicates"'));
  assert.doesNotMatch(side, /Categories/, 'the old button is gone from the anime column');
  const filter = html.indexOf('id="animeLibraryCategoryFilter"');
  const gear = html.indexOf('id="btnManageAnimeCategories"');
  assert.ok(gear > filter && gear - filter < 400, 'the gear follows the anime category filter');

  const anime = read('modules', 'ui-anime-test.js');
  assert.match(anime, /\$\("btnAnimeLibraryTags"\)[\s\S]{0,60}\n?[\s\S]{0,80}showAnimeLibraryTagsPanel\(\)/);
  assert.match(anime, /btnManageAnimeCategories[\s\S]{0,200}showManageCategoriesModal\(\)/, 'the gear keeps the old handler');
  assert.match(anime, /typeof animeTagMatches === 'function' && !animeTagMatches\(f\)\) return false;/);
});

test('a failed anime push to AniList says so once, and keeps the episode recorded so it is not retried on every tick', () => {
  const anime = read('modules', 'ui-anime-test.js');
  const block = anime.slice(anime.indexOf('function _animeTestMaybeSyncAniList'), anime.indexOf('// ── Edit Page'));
  assert.match(block, /showToast\('AniList', "Couldn't update AniList with this episode/);
  assert.doesNotMatch(block, /_animeTestSyncedEpisodes\.delete/, 'the key stays: no toast and no request on every progress tick');
});
