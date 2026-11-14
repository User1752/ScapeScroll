'use strict';

// How Settings is laid out: ui-settings-modal-html.js lays the cards (one builder function each, in ui-settings-cards-*.js) out in tabs. Nothing
// here renders a card: the composer runs in a vm sandbox with stub builders, and the real files are read for what they declare. What it guards: the
// agreed tab map, a builder that exists once and is used once, the two cards the app adds after the markup (Protected sites, Import a source) finding
// their tab and their neighbour, and the places that open a tab by id.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (name) => fs.readFileSync(path.join(MODULES, name), 'utf8');
const CARD_FILES = fs.readdirSync(MODULES).filter((f) => /^ui-settings-cards-[a-z-]+\.js$/.test(f));

// What the map says, tab by tab.
const MAP = [
  ['tab-reading', 'Reading', ['ReadingMode', 'ChapterBehaviour', 'AutoScroll', 'ReaderAppearance']],
  ['tab-library', 'Library', ['GridAppearance', 'LibraryAppearance', 'LibrarySync', 'Defaults', 'HomePage']],
  ['tab-anime', 'Anime', ['AnimeLibraryCard', 'AnimeLibrarySync']],
  ['tab-appearance', 'THEME', ['UiTheme']],
  ['tab-tracking', 'Tracking', ['AniList']],
  ['tab-sources', 'Sources', ['Sources', 'AnimeSources']],
  ['tab-suwayomi', 'Suwayomi', ['SuwayomiBridge']],
  ['tab-filters', 'Filters', ['ContentFilters', 'GenreBlacklist']],
  ['tab-network', 'Network & Anti-Bot', ['NetworkAntiBot']],
  ['tab-accounts', 'Accounts', ['DiscordPresence']],
  ['tab-security', 'Security', ['AccessPassword', 'FactoryReset']],
  ['tab-data', 'Data & Backup', ['BackupRestore', 'OpdsCatalog', 'MihonImport', 'ClearReadingHistory']],
  ['tab-advanced', 'Advanced', ['SourceCatalog', 'Commands']],
];

const declared = () => CARD_FILES.flatMap((file) => [...read(file).matchAll(/^function (settingsCard\w+)\(/gm)].map((m) => ({ name: m[1], file })));

// The composer with a stub for every builder it asks for; `present` says which builders exist.
function compose(present) {
  const context = { t: () => 'THEME', console };
  vm.createContext(context);
  vm.runInContext(read('ui-settings-modal-html.js'), context, { filename: 'ui-settings-modal-html.js' });
  for (const name of present) context[name] = () => `<div class="settings-section-card" data-card="${name}"></div>`;
  return { context, html: vm.runInContext('buildSettingsModalHtml()', context) };
}

const tabsOf = (html) => [...html.matchAll(/<div class="settings-tab(?: active)?(?: settings-tab-wide)?" id="(tab-[a-z]+)">([\s\S]*?)\n {10}<\/div>/g)]
  .map((m) => ({ id: m[1], cards: [...m[2].matchAll(/data-card="settingsCard(\w+)"/g)].map((c) => c[1]) }));

test('the tabs are the agreed ones, in the order of the sidebar, with the cards the map gives each (the first tab is the active one)', () => {
  const { html } = compose(declared().map((d) => d.name));
  const nav = [...html.matchAll(/<button class="settings-nav-item(?: active)?" data-tab="(tab-[a-z]+)">([^<]*)<\/button>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(nav, MAP.map(([id, label]) => [id, label]));
  assert.match(html, /<button class="settings-nav-item active" data-tab="tab-reading">/);
  assert.match(html, /<div class="settings-tab active" id="tab-reading">/);
  assert.equal(html.split('settings-tab active').length - 1, 1, 'one active panel');
  assert.deepEqual(tabsOf(html).map((t) => [t.id, t.cards]), MAP.map(([id, , cards]) => [id, cards]));
});

test('every builder is declared once, used by exactly one tab, and the files hold nothing but builders and the sources helpers', () => {
  const names = declared().map((d) => d.name);
  assert.equal(new Set(names).size, names.length, 'no builder twice');
  const used = MAP.flatMap(([, , cards]) => cards.map((c) => `settingsCard${c}`));
  assert.equal(new Set(used).size, used.length, 'no card in two tabs');
  assert.deepEqual(used.filter((n) => !names.includes(n)), [], 'a tab asks for a card that nobody builds');
  assert.deepEqual(names.filter((n) => !used.includes(n)), [], 'a card that no tab shows');
  for (const file of CARD_FILES) {
    const text = read(file).split(/\r?\n/);
    assert.ok(text.length <= 450, `${file} is ${text.length} lines`);
    const stray = text.filter((l) => /^(let|var)\s/.test(l));
    assert.deepEqual(stray, [], `${file} keeps no state of its own`);
  }
});

test('the cards added after the markup find their tab and their neighbour: Protected sites after the first card of Network, Import a source after the Anime Sources card', () => {
  assert.match(read('ui-settings-solver.js'), /const SOLVER_CARD_TAB_ID = 'tab-network';/);
  const network = MAP.find(([id]) => id === 'tab-network')[2];
  assert.equal(network[0], 'NetworkAntiBot', 'the solver card is inserted after the first card of its tab');
  assert.match(read('ui-settings-source-import.js'), /const SOURCE_IMPORT_TAB_ID = 'tab-sources';/);
  const sources = MAP.find(([id]) => id === 'tab-sources')[2];
  assert.ok(sources.includes('AnimeSources'), 'the import card is inserted after the card that holds SOURCE_IMPORT_ANCHOR_ID');
  assert.ok(!sources.includes('SourceRepositories'), 'the old repositories card is gone: the catalog has the repositories now');
  const anchor = read('ui-settings-source-import.js').match(/SOURCE_IMPORT_ANCHOR_ID\s*=\s*'([^']+)'/);
  assert.ok(anchor, 'the anchor id is declared');
  assert.ok(read('ui-settings-cards-sources.js').includes(`id="${anchor[1]}"`), 'and it is in the sources cards');
});

test('whatever opens a tab by id opens one that exists', () => {
  const ids = new Set(MAP.map(([id]) => id));
  const asked = [];
  for (const file of fs.readdirSync(MODULES).filter((f) => f.endsWith('.js'))) {
    for (const m of read(file).matchAll(/data-tab="(tab-[a-z]+)"\]/g)) asked.push([file, m[1]]);
  }
  assert.ok(asked.length >= 2);
  for (const [file, id] of asked) assert.ok(ids.has(id), `${file} opens ${id}`);
  // after "Reset All Settings" the person is brought back to where that button is
  const security = MAP.find(([id]) => id === 'tab-security')[2];
  assert.ok(security.includes('FactoryReset'));
  assert.match(read('ui-settings-modal.js'), /\.settings-nav-item\[data-tab="tab-security"\]/);
  assert.ok(read('ui-settings-cards-system.js').includes('id="btnResetAllSettings"'));
});

test('the page loads every cards file before the composer, the composer before the modal', () => {
  const page = fs.readFileSync(path.join(MODULES, '..', 'index.html'), 'utf8');
  const at = (name) => page.indexOf(`/modules/${name}`);
  for (const file of CARD_FILES) assert.ok(at(file) > 0 && at(file) < at('ui-settings-modal-html.js'), file);
  assert.ok(at('ui-settings-modal-html.js') < at('ui-settings-modal.js'));
});
