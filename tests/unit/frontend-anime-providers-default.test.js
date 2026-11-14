'use strict';

// AnimeParadise joined the providers offered by default (2026-10-26), and AnimePahe left them the day after (2026-10-27:
// its video host Kwik refuses the connection on at least one real network, and it needs the hidden browser). Checked before that: the server only ever
// talks to api.animeparadise.moe and stream.animeparadise.moe (playlists, segments and subtitles all on the second),
// the browser only gets same-origin relay URLs, and Cloudflare's malware-blocking resolver does not list the domain.
// It sits before AnimePahe in the fallback order: it answers in about a second and does not need the hidden browser.
// Existing installs hold the old default in localStorage, so a ONE-TIME migration, tied to the settings version,
// upgrades exactly that old default; a later choice (a user who ticks AnimePahe again) must stay.
// The real public/modules/ui-settings.js runs in a vm sandbox (no browser), like the other front-end tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const SETTINGS_FILE = path.join(MODULES, 'ui-settings.js');
const ANIME_FILE = path.join(MODULES, 'ui-anime-test.js');

const NEW_DEFAULT = ['anizone', 'animeparadise'];
const DEFAULT_V2 = ['anizone', 'animeparadise', 'animepahe']; // the default until settings version 3
const OLD_DEFAULT = ['anizone', 'animepahe']; // the default until settings version 2
const plain = (value) => JSON.parse(JSON.stringify(value));

function load() {
  const sandbox = {
    console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    state: { settings: {}, chapterCountCache: {}, readChapters: new Set(), flaggedChapters: new Set(), readingProgress: {}, installedSources: {} },
    document: { getElementById: () => null, documentElement: { dataset: {} } },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SETTINGS_FILE, 'utf8'), sandbox, { filename: SETTINGS_FILE });
  const sanitize = (raw) => plain(sandbox.sanitizeSettings(raw));
  return { sanitize, version: vm.runInContext('SETTINGS_VERSION', sandbox), defaults: plain(vm.runInContext('DEFAULT_SETTINGS', sandbox)) };
}

test('a new install is offered AniZone, then AnimeParadise; AnimePahe, zokoanime and Miruro stay off', () => {
  const { sanitize, defaults } = load();
  assert.deepEqual(defaults.visibleAnimeProviders, NEW_DEFAULT);
  for (const nothing of [undefined, null, {}, { visibleAnimeProviders: [] }, { visibleAnimeProviders: 'x' }]) {
    assert.deepEqual(sanitize(nothing).visibleAnimeProviders, NEW_DEFAULT, JSON.stringify(nothing));
  }
});

test('an install that still holds the old default is upgraded once, and the version moves on', () => {
  const { sanitize, version } = load();
  assert.ok(version >= 3, 'the settings version was raised, which is what makes the upgrade a one-time thing');
  const upgraded = sanitize({ _version: 1, visibleAnimeProviders: OLD_DEFAULT, mangasPerRow: 9 });
  assert.deepEqual(upgraded.visibleAnimeProviders, NEW_DEFAULT);
  assert.equal(upgraded._version, version);
  assert.equal(upgraded.mangasPerRow, 9, 'and nothing else is touched');
  assert.deepEqual(sanitize({ visibleAnimeProviders: OLD_DEFAULT }).visibleAnimeProviders, NEW_DEFAULT, 'settings saved before the version existed too');
});

test('a list the user chose on purpose is never touched, and a choice made after the upgrade sticks', () => {
  const { sanitize, version } = load();
  for (const chosen of [['anizone'], ['animepahe'], ['anizone', 'animepahe', 'zokoanime'], ['anizone', 'animeparadise'], ['animeparadise'], ['anizone', 'animeparadise', 'animepahe', 'zokoanime']]) {
    assert.deepEqual(sanitize({ _version: 2, visibleAnimeProviders: chosen }).visibleAnimeProviders, chosen, JSON.stringify(chosen));
  }
  // The user unticked AnimeParadise at settings version 2: the same two ids as the old default, but a choice, so it stays.
  assert.deepEqual(sanitize({ _version: 2, visibleAnimeProviders: OLD_DEFAULT }).visibleAnimeProviders, OLD_DEFAULT);
  // The user ticked AnimePahe again after the upgrade: the same three ids as the previous default, but already at the new version.
  const later = sanitize({ _version: version, visibleAnimeProviders: DEFAULT_V2 });
  assert.deepEqual(later.visibleAnimeProviders, DEFAULT_V2, 'not upgraded again');
  assert.deepEqual(sanitize(later).visibleAnimeProviders, DEFAULT_V2, 'and stable when loaded again');
});

test('every browser that still holds the previous default (AnimePahe included) loses AnimePahe once, whatever order it saved them in', () => {
  const { sanitize, version } = load();
  for (const saved of [DEFAULT_V2, ['anizone', 'animepahe', 'animeparadise'], ['animepahe', 'animeparadise', 'anizone']]) {
    for (const _version of [undefined, 1, 2]) {
      const upgraded = sanitize({ _version, visibleAnimeProviders: saved, mangasPerRow: 8 });
      assert.deepEqual(upgraded.visibleAnimeProviders, NEW_DEFAULT, JSON.stringify([saved, _version]));
      assert.equal(upgraded._version, version);
      assert.equal(upgraded.mangasPerRow, 8, 'and nothing else is touched');
    }
  }
  assert.deepEqual(sanitize(sanitize({ _version: 2, visibleAnimeProviders: DEFAULT_V2 })).visibleAnimeProviders, NEW_DEFAULT, 'stable when loaded again');
});

test('the old repair for installs seeded with zokoanime still lands on the safe default', () => {
  const { sanitize } = load();
  for (const seeded of [['zokoanime', 'animepahe'], ['animepahe', 'zokoanime']]) {
    assert.deepEqual(sanitize({ _version: 1, visibleAnimeProviders: seeded }).visibleAnimeProviders, NEW_DEFAULT, JSON.stringify(seeded));
  }
});


test('the empty-list fallback of the anime player is the same list, declared once (in ui-settings.js), and zokoanime is not in it', () => {
  const text = fs.readFileSync(ANIME_FILE, 'utf8');
  assert.match(text, /const DEFAULT_VISIBLE_ANIME_PROVIDERS = \[\.\.\.DEFAULT_SETTINGS\.visibleAnimeProviders\];/);
  assert.ok(!/DEFAULT_VISIBLE_ANIME_PROVIDERS\s*=\s*\[[^\]]*['"]/.test(text), 'no second literal list');
});

// _animeFallbackOrder is a plain function of the two lists around it, so it runs here with those lists.
function fallbackOrder() {
  const text = fs.readFileSync(ANIME_FILE, 'utf8');
  const block = /const ANIME_PROVIDERS = \[([\s\S]*?)\n\];/.exec(text);
  const fn = /function _animeFallbackOrder\(ids\) \{[\s\S]*?\n\}/.exec(text);
  assert.ok(block && fn, 'ANIME_PROVIDERS and _animeFallbackOrder are declared in ui-anime-test.js');
  const ids = [...block[1].matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);
  return vm.runInNewContext(`${fn[0]}; _animeFallbackOrder`, {
    DEFAULT_VISIBLE_ANIME_PROVIDERS: NEW_DEFAULT,
    ANIME_PROVIDERS: ids.map((id) => ({ id })),
  });
}

test('the fallback is tried in ONE priority order, whatever order a list was saved in', () => {
  const order = fallbackOrder();
  // The Settings checkboxes save in the order of the ANIME_PROVIDERS list: AnimePahe before AnimeParadise. AnimePahe,
  // when it is ticked, is tried after the default providers.
  assert.deepEqual(plain(order(['anizone', 'animepahe', 'animeparadise'])), DEFAULT_V2);
  assert.deepEqual(plain(order(['animepahe', 'animeparadise', 'anizone'])), DEFAULT_V2);
  assert.deepEqual(plain(order(['animeparadise', 'anizone'])), NEW_DEFAULT);
  // The providers that are not default come after the default ones, in the order of the list; an unknown id is last.
  assert.deepEqual(plain(order(['miruro', 'xyz', 'zokoanime', 'animepahe', 'anizone'])), ['anizone', 'animepahe', 'zokoanime', 'miruro', 'xyz']);
  const input = ['animepahe', 'anizone'];
  order(input);
  assert.deepEqual(input, ['animepahe', 'anizone'], 'the list that was passed is not reordered in place');
  assert.deepEqual(plain(order([])), []);
});

test('the player sends the format of the title and orders the fallback; the settings checkboxes save in that order', () => {
  const anime = fs.readFileSync(ANIME_FILE, 'utf8');
  assert.match(anime, /order = \[provider, \.\.\._animeFallbackOrder\(visible\)\.filter/);
  assert.match(anime, /format: format \|\| undefined/);
  assert.match(anime, /requestedQuality, _animeTestCurrent\.format/);
  const modal = fs.readFileSync(path.join(MODULES, 'ui-settings-modal.js'), 'utf8');
  assert.match(modal, /_animeFallbackOrder\(checked\)/);
});
