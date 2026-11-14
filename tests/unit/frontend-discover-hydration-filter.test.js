'use strict';

// A list row of a source is often lean: no genres. The home rows filter by Hide NSFW and by the genre blacklist when the list arrives, so they could not
// judge such a row, and the genres that the card hydration read afterwards were only painted. A card those filters exclude now goes away once its real
// genres are known. The decision is a pure function of the settings and the genres, tested here with the real files; the rest checks it is called in the
// hydration, before anything is painted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', ...p), 'utf8').replace(/\r\n/g, '\n');

function load(settings) {
  const ctx = { console, state: { settings, installedSources: {} } };
  vm.createContext(ctx);
  const utils = read('modules', 'utils.js');
  const start = utils.indexOf('const NSFW_TAGS = new Set([');
  const end = utils.indexOf('// ── Webtoon / Manhwa / Manhua auto-detection');
  assert.ok(start > 0 && end > start, 'the NSFW functions are where the test expects them');
  vm.runInContext(`${utils.slice(start, end)}\nthis.isNsfwManga = isNsfwManga;`, ctx, { filename: 'utils.js' });
  const discover = read('modules', 'ui-discover.js');
  const from = discover.indexOf('function _mangaExcludedBySettings(');
  const to = discover.indexOf('// How many hydrations are running');
  assert.ok(from > 0 && to > from, 'the function is in ui-discover.js');
  vm.runInContext(`${discover.slice(from, to)}\nthis.hidden = _hiddenByGenres; this.excluded = _mangaExcludedBySettings;`, ctx, { filename: 'ui-discover.js' });
  return ctx.hidden;
}

function loadExcluded(settings) {
  const ctx = { console, state: { settings, installedSources: {} } };
  vm.createContext(ctx);
  const utils = read('modules', 'utils.js');
  vm.runInContext(`${utils.slice(utils.indexOf('const NSFW_TAGS = new Set(['), utils.indexOf('// ── Webtoon / Manhwa / Manhua auto-detection'))}
this.isNsfwManga = isNsfwManga;`, ctx);
  const discover = read('modules', 'ui-discover.js');
  vm.runInContext(`${discover.slice(discover.indexOf('function _mangaExcludedBySettings('), discover.indexOf('// How many hydrations are running'))}
this.excluded = _mangaExcludedBySettings;`, ctx);
  return ctx.excluded;
}

test('with Hide NSFW on, a title whose genres turn out to include an adult one is hidden, even when it is not among the three shown', () => {
  const hidden = load({ hideNsfw: true, genreBlacklist: [] });
  assert.equal(hidden(['Drama', 'Fantasy', 'Romance', 'Adult'], 'a', 'src'), true, 'the fourth genre counts');
  assert.equal(hidden(['Adult', 'Drama', 'Fantasy'], 'a', 'src'), true);
  assert.equal(hidden(['Drama', 'Fantasy'], 'a', 'src'), false, 'a general-audience title stays');
  assert.equal(hidden([], 'a', 'src'), false, 'no genres: nothing to judge');
  assert.equal(hidden(undefined, 'a', 'src'), false);
});

test('with Hide NSFW off an adult genre is not a reason to hide', () => {
  assert.equal(load({ hideNsfw: false, genreBlacklist: [] })(['Adult', 'Drama'], 'a', 'src'), false);
});

test('a blacklisted genre hides the title in any case, compared without case', () => {
  const hidden = load({ hideNsfw: false, genreBlacklist: ['boys love', 'yaoi'] });
  assert.equal(hidden(['Drama', 'Boys Love'], 'a', 'src'), true);
  assert.equal(hidden(['Drama', 'Fantasy'], 'a', 'src'), false);
  assert.equal(load({ hideNsfw: false })(['Boys Love'], 'a', 'src'), false, 'no blacklist in the settings is no blacklist');
});

test('the hydration judges the genres it read before painting them, with all of them and not only the three shown', () => {
  const source = read('modules', 'ui-discover.js');
  assert.match(source, /const allGenres = _extractGenresFromDetails\(details, 50\);/);
  assert.match(source, /genres: allGenres\.slice\(0, 3\),\s*allGenres,/);
  const judged = source.indexOf('_hiddenByGenres(data.allGenres || data.genres, mangaId, sourceId)');
  const painted = source.indexOf("genreBox.removeAttribute('data-missing-genres');");
  assert.ok(judged > 0 && painted > judged, 'the check comes before the genres are painted');
  assert.match(source.slice(judged, painted), /card\.remove\(\);\s*continue;/);
});

test('one rule for every list drawn from a source: Hide NSFW and the blacklist, from the genres the list carries', () => {
  const excluded = loadExcluded({ hideNsfw: true, genreBlacklist: ['yaoi'] });
  assert.equal(excluded({ id: 'a', sourceId: 'comizy', title: 'Contradict', genres: ['Yaoi', 'Romance', 'Smut'] }), true);
  assert.equal(excluded({ id: 'b', sourceId: 'comizy', title: 'Plain', genres: ['Comedy', 'Romance'] }), false);
  assert.equal(excluded(null), false);
  assert.equal(loadExcluded({ hideNsfw: false, genreBlacklist: ['yaoi'] })({ id: 'a', sourceId: 'x', title: 'T', genres: ['Yaoi'] }), true, 'the blacklist alone is enough');
  assert.equal(loadExcluded({ hideNsfw: true, genreBlacklist: [] })({ id: 'a', sourceId: 'x', title: 'T', genres: ['Yaoi'] }), true, 'and so is Hide NSFW alone');
  assert.equal(loadExcluded({ hideNsfw: false, genreBlacklist: [] })({ id: 'a', sourceId: 'x', title: 'T', genres: ['Yaoi'] }), false);
});

test('the author search and the recommendations use that rule (the blacklist only lowered a recommendation, and the author search ignored both)', () => {
  const author = read('modules', 'ui-genre-author-navigation.js');
  assert.match(author, /_mangaExcludedBySettings\(m\)\) continue;/);
  const calendar = read('modules', 'ui-calendar.js');
  assert.match(calendar, /filtered = filtered\.filter\(m => !_mangaExcludedBySettings\(m\)\);/);
});

test('changing Hide NSFW or the blacklist draws the home rows again, the recommended row and Continue Reading included, and an emptied recommended row does not stay', () => {
  const modal = read('modules', 'ui-settings-modal.js');
  const nsfw = modal.slice(modal.indexOf('hideNsfwToggle.onchange'), modal.indexOf('hideNsfwToggle.onchange') + 2400);
  assert.match(nsfw, /loadRecommendations\(\)/);
  assert.match(nsfw, /renderContinueReading\(\)/);
  const black = modal.slice(modal.indexOf('genreBlacklistInput.onchange'), modal.indexOf('genreBlacklistInput.onchange') + 1200);
  for (const name of ['loadPopularToday', 'loadRecentlyAdded', 'loadLatestUpdates', 'loadRecommendations']) assert.match(black, new RegExp(name), `the blacklist redraws ${name}`);
  const calendar = read('modules', 'ui-calendar.js');
  assert.match(calendar, /if \(!list\.length\) \{[^}]*section\.style\.display = "none";\s*row\.innerHTML = '';/);
});
