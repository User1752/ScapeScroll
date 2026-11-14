'use strict';

// Which edition the app is (server/config/edition.js): the standard one, or the one WITHOUT SOURCES, which is the same code built with no source bundled, an
// empty catalog and Hide NSFW on by default. What must hold:
//  - it is named only by edition.json (written by the build) or SCROLLSCAPE_EDITION, and anything that is not a known name is the standard edition, so a typo
//    or a hostile value can never loosen a thing;
//  - the page is told what it needs (the Hide NSFW default) by /edition.js, as a frozen object it cannot be talked out of;
//  - the catalog config and the repository registry follow the edition: the default repository is off until chosen, the content cap is the edition's own, and
//    "put back" is a choice that is kept (so that "nothing chosen yet" and "on" are not the same thing).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const { readEdition, editionScript, EDITIONS } = require('../../server/config/edition');
const { createRepoRegistry } = require('../../server/modules/source-catalog/repos');

const fileOf = (content) => (file) => {
  if (!/edition\.json$/.test(file)) throw new Error(`unexpected read of ${file}`);
  if (content instanceof Error) throw content;
  return content;
};

test('the edition is named by SCROLLSCAPE_EDITION first, then by edition.json; no name, no file, a broken file or an unknown name is the standard edition', () => {
  const read = (env, content) => readEdition({ env, rootDir: ROOT, readFile: fileOf(content) }).id;
  assert.equal(read({}, JSON.stringify({ edition: 'sourceless' })), 'sourceless');
  assert.equal(read({}, JSON.stringify({ edition: '  SourceLess ' })), 'sourceless', 'case and spaces do not matter');
  assert.equal(read({ SCROLLSCAPE_EDITION: 'sourceless' }, JSON.stringify({ edition: 'standard' })), 'sourceless', 'the environment wins');
  assert.equal(read({ SCROLLSCAPE_EDITION: 'standard' }, JSON.stringify({ edition: 'sourceless' })), 'standard', 'and can say standard');
  for (const bad of [new Error('ENOENT'), '{not json', '[]', 'null', JSON.stringify({}), JSON.stringify({ edition: 5 }), JSON.stringify({ edition: 'complete' }), JSON.stringify({ edition: 'sourceless;' }), JSON.stringify({ edition: '__proto__' }), JSON.stringify({ edition: 'constructor' }), JSON.stringify({ edition: 'toString' })]) {
    assert.equal(read({}, bad), 'standard', String(bad));
  }
  assert.equal(read({ SCROLLSCAPE_EDITION: '__proto__' }, JSON.stringify({ edition: 'sourceless' })), 'standard', 'an unknown name in the environment is not overridden by the file: it is simply standard');
});

test('the two editions differ in exactly what the edition without sources is for, and are frozen', () => {
  const s = EDITIONS.standard;
  const n = EDITIONS.sourceless;
  assert.deepEqual([s.sourceless, s.hideNsfwDefault, s.defaultRepoOn, s.catalogWarnings, s.extensionEngine], [false, false, true, null, null], 'standard changes nothing');
  assert.deepEqual([n.sourceless, n.hideNsfwDefault, n.defaultRepoOn, n.extensionEngine], [true, true, false, false]);
  assert.deepEqual([...n.catalogWarnings], ['SAFE', 'MIXED', 'NSFW']);
  for (const e of [s, n]) assert.ok(Object.isFrozen(e));
  assert.ok(Object.isFrozen(n.catalogWarnings));
  assert.equal(fs.existsSync(path.join(ROOT, 'edition.json')), true);
});

test('/edition.js tells the page its edition as a frozen object, and only what the page needs', () => {
  for (const [name, hide] of [['standard', false], ['sourceless', true]]) {
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(editionScript(EDITIONS[name]), ctx);
    const e = ctx.window.SCROLLSCAPE_EDITION;
    assert.deepEqual({ id: e.id, sourceless: e.sourceless, hideNsfwDefault: e.hideNsfwDefault }, { id: name, sourceless: name === 'sourceless', hideNsfwDefault: hide });
    assert.deepEqual(Object.keys(e).sort(), ['hideNsfwDefault', 'id', 'sourceless'], 'nothing else of the config is sent');
    assert.ok(Object.isFrozen(e));
  }
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(editionScript(undefined), ctx);
  assert.equal(ctx.window.SCROLLSCAPE_EDITION.id, 'standard', 'no edition given is standard');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const route = server.indexOf("app.get('/edition.js'");
  assert.ok(route > 0 && route < server.indexOf("app.use('/', express.static("), 'served before the static files');
  assert.match(server, /application\/javascript/);
  assert.match(server, /Cache-Control', 'no-cache'/);
});

test('the catalog config follows the edition: the content cap, the default repository and the engine', () => {
  const load = (name) => {
    const keep = process.env.SCROLLSCAPE_EDITION;
    const paths = ['../../server/config/edition', '../../server/config/catalog'].map((p) => require.resolve(p));
    const saved = paths.map((p) => require.cache[p]);
    try {
      if (name) process.env.SCROLLSCAPE_EDITION = name; else delete process.env.SCROLLSCAPE_EDITION;
      paths.forEach((p) => { delete require.cache[p]; });
      return require('../../server/config/catalog');
    } finally {
      if (keep === undefined) delete process.env.SCROLLSCAPE_EDITION; else process.env.SCROLLSCAPE_EDITION = keep;
      paths.forEach((p, i) => { if (saved[i]) require.cache[p] = saved[i]; else delete require.cache[p]; });
    }
  };
  const standard = load('standard');
  assert.equal(standard.defaultRepoOn, true);
  assert.equal(standard.extensionEngine, true, 'this code line has the engine');
  assert.deepEqual([...standard.allowedWarnings], ['SAFE', 'MIXED', 'NSFW'], 'and its own cap');
  const sourceless = load('sourceless');
  assert.equal(sourceless.defaultRepoOn, false);
  assert.equal(sourceless.extensionEngine, false);
  assert.deepEqual([...sourceless.allowedWarnings], ['SAFE', 'MIXED', 'NSFW']);
  assert.equal(load('nonsense').defaultRepoOn, true, 'an unknown name changes nothing');
  assert.ok(Object.isFrozen(sourceless));
});

test('the default repository starts off in the edition without sources until the person puts it back, and the choice is kept either way', async () => {
  const index = JSON.stringify({ name: 'R', extensionList: { extensions: [{ name: 'a', packageName: 'eu.kanade.tachiyomi.extension.en.alpha', versionName: '1.0', contentWarning: 'CONTENT_WARNING_SAFE', sources: [{ id: '1000000000000000001', name: 'A', language: 'en', homeUrl: 'https://a.example' }] }] } });
  const baseConfig = require('../../server/config/catalog');
  const make = (defaultRepoOn, settings = {}) => {
    const data = { settings: { ...settings } };
    const store = { readStore: async () => data, writeStore: async () => {}, flushNow() {} };
    return { data, registry: createRepoRegistry({ store, fetchText: async () => ({ status: 200, text: index }), config: { ...baseConfig, defaultRepoOn } }) };
  };
  const on = make(true);
  assert.equal(await on.registry.defaultOn(), true, 'standard: on until removed');
  const off = make(false);
  assert.equal(await off.registry.defaultOn(), false, 'sourceless: off until put back');
  assert.equal(await off.registry.remove(baseConfig.repoIndexUrl), false, 'there is nothing to remove');
  const back = await off.registry.add(baseConfig.repoIndexUrl);
  assert.equal(back.default, true);
  assert.equal(await off.registry.defaultOn(), true);
  assert.equal(off.data.settings.catalogDefaultOff, false, 'a choice, kept');
  assert.equal(await off.registry.remove(baseConfig.repoIndexUrl), true);
  assert.equal(off.data.settings.catalogDefaultOff, true);
  assert.equal(await off.registry.defaultOn(), false);
  // what the person chose beats the edition's default, both ways
  assert.equal(await make(false, { catalogDefaultOff: false }).registry.defaultOn(), true);
  assert.equal(await make(true, { catalogDefaultOff: true }).registry.defaultOn(), false);
  assert.equal(await make(true, { catalogDefaultOff: 'yes' }).registry.defaultOn(), true, 'only a true boolean counts as a choice');
});

test('the page takes its Hide NSFW default from the edition, and loads /edition.js before the scripts that read it', () => {
  const read = (...p) => fs.readFileSync(path.join(ROOT, 'public', ...p), 'utf8').replace(/\r\n/g, '\n');
  const expression = (file, pattern) => {
    const line = read('modules', file).split('\n').find((l) => pattern.test(l));
    assert.ok(line, `${file} has the default`);
    return line.slice(line.indexOf('hideNsfw:') + 'hideNsfw:'.length, line.indexOf(', //')).trim();
  };
  for (const [file, pattern] of [['state.js', /^\s+hideNsfw:/], ['ui-settings.js', /^\s+hideNsfw:/]]) {
    const expr = expression(file, pattern);
    const run = (window) => vm.runInNewContext(`(${expr})`, window === undefined ? {} : { window });
    assert.equal(run(undefined), false, `${file}: no window`);
    assert.equal(run({}), false, `${file}: no edition`);
    assert.equal(run({ SCROLLSCAPE_EDITION: { hideNsfwDefault: false } }) , false);
    assert.equal(run({ SCROLLSCAPE_EDITION: { hideNsfwDefault: true } }), true, `${file}: the edition without sources starts with it on`);
    assert.equal(run({ SCROLLSCAPE_EDITION: { hideNsfwDefault: 'true' } }), false, `${file}: only a true boolean`);
  }
  const html = read('index.html');
  const script = html.indexOf('<script src="./edition.js"');
  assert.ok(script > 0 && script < html.indexOf('modules/state.js') && script < html.indexOf('modules/ui-settings.js'));
});

test('the edition without sources has no Suwayomi tab, and its catalog says no scraper of its own can be added; the standard one keeps both', () => {
  const read = (...p) => fs.readFileSync(path.join(ROOT, 'public', ...p), 'utf8').replace(/\r\n/g, '\n');
  const modalHtml = (window) => {
    const ctx = { t: () => 'THEME', console, ...(window === undefined ? {} : { window }) };
    vm.createContext(ctx);
    vm.runInContext(read('modules', 'ui-settings-modal-html.js'), ctx);
    for (const name of ['settingsCardSuwayomiBridge', 'settingsCardSources', 'settingsCardCommands']) ctx[name] = () => `<div data-card="${name}"></div>`;
    return vm.runInContext('buildSettingsModalHtml()', ctx);
  };
  const tabIds = (html) => [...html.matchAll(/class="settings-nav-item(?: active)?" data-tab="(tab-[a-z]+)"/g)].map((m) => m[1]);
  assert.ok(tabIds(modalHtml(undefined)).includes('tab-suwayomi'), 'no edition named: the tab is there');
  assert.ok(tabIds(modalHtml({})).includes('tab-suwayomi'));
  assert.ok(tabIds(modalHtml({ SCROLLSCAPE_EDITION: { sourceless: false } })).includes('tab-suwayomi'), 'standard');
  const without = modalHtml({ SCROLLSCAPE_EDITION: { sourceless: true } });
  assert.ok(!tabIds(without).includes('tab-suwayomi'), 'sourceless: no tab in the sidebar');
  assert.ok(!without.includes('id="tab-suwayomi"') && !without.includes('settingsCardSuwayomiBridge'), 'and no panel');
  assert.equal(tabIds(without).length, tabIds(modalHtml(undefined)).length - 1, 'only that tab is missing');
  assert.ok(modalHtml({ SCROLLSCAPE_EDITION: { sourceless: 'true' } }).includes('data-tab="tab-suwayomi"'), 'only a true boolean counts as sourceless');
  const catalog = read('modules', 'ui-settings-source-catalog-html.js');
  assert.match(catalog, /SCROLLSCAPE_EDITION\.sourceless === true \? 'settings\.sourceCatalog\.descriptionNoEngine' : 'settings\.sourceCatalog\.description'/);
  for (const lang of ['en-GB', 'pt-PT']) {
    const text = fs.readFileSync(path.join(ROOT, 'public', 'modules', 'i18n', 'locales', `${lang}.js`), 'utf8');
    assert.match(text, /"settings\.sourceCatalog\.descriptionNoEngine": "[^"]+"/, lang);
    assert.ok(!/descriptionNoEngine": "[^"]*Suwayomi/.test(text), `${lang}: the text of the edition without the engine does not send the person to one`);
  }
  assert.ok(!read('modules', 'ui-settings-cards-sources.js').includes('Suwayomi Bridge'), 'a source that no longer exists is not named');
});
