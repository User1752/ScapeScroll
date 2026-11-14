'use strict';

// The home page with no source installed (public/modules/ui-empty-sources.js). What must hold:
//  - a notice is at the top of the manga home while no source is installed, and not otherwise; it is added once and goes away by itself;
//  - it says what to do, with a button to the source catalog (Settings -> Advanced) and one to "add from a link" (Settings -> Sources), and only those two tabs
//    can be opened from it;
//  - it is text only, comes in both languages, and the places that change the sources ask for it again.
// The real module runs in a vm sandbox with a fake page.

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

function sandbox({ installed = {}, hasHost = true } = {}) {
  const opened = [];
  const clicks = [];
  const listeners = [];
  const host = { children: [], prepend(el) { host.children.unshift(el); el.connected = true; } };
  const makeBox = () => ({
    id: '', className: '', innerHTML: '', attrs: {}, connected: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { listeners.push([type, fn]); },
    remove() { this.connected = false; host.children = host.children.filter((c) => c !== this); },
  });
  const nav = (id) => ({ click: () => clicks.push(id) });
  const ctx = {
    console, Object, String, Array,
    window: {},
    state: { installedSources: installed },
    t: (key) => EN[key] ?? key,
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    showSettings: () => opened.push('settings'),
    document: {
      createElement: () => makeBox(),
      getElementById: (id) => (id === 'discoverMangaContent' && hasHost ? host : (id === 'noSourcesNotice' ? host.children.find((c) => c.id === id) || null : null)),
      querySelector: (sel) => { const m = /data-tab="([^"]+)"/.exec(sel); return m ? nav(m[1]) : null; },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(read('ui-empty-sources.js'), ctx, { filename: 'ui-empty-sources.js' });
  return { ctx, host, opened, clicks, listeners };
}

test('the notice is on the home page while no source is installed, once, and goes away when one is', () => {
  const s = sandbox({ installed: {} });
  s.ctx.renderNoSourcesNotice();
  assert.equal(s.host.children.length, 1);
  const box = s.host.children[0];
  assert.equal(box.id, 'noSourcesNotice');
  assert.equal(box.className, 'no-sources-notice');
  assert.equal(box.attrs.role, 'status');
  s.ctx.renderNoSourcesNotice();
  s.ctx.renderNoSourcesNotice();
  assert.equal(s.host.children.length, 1, 'asked again, it is not added again');
  assert.equal(s.listeners.length, 1, 'with one listener');
  s.ctx.state.installedSources = { mangadex: { id: 'mangadex' } };
  s.ctx.renderNoSourcesNotice();
  assert.equal(s.host.children.length, 0, 'a source is installed: the notice goes');
  s.ctx.renderNoSourcesNotice();
  assert.equal(s.host.children.length, 0, 'and does not come back');
  s.ctx.state.installedSources = {};
  s.ctx.renderNoSourcesNotice();
  assert.equal(s.host.children.length, 1, 'all removed: it comes back');
});

test('it is only for a known empty list: not before the state is known, and not on a page without the home', () => {
  const s = sandbox({ installed: {} });
  s.ctx.state.installedSources = undefined;
  s.ctx.renderNoSourcesNotice();
  assert.equal(s.host.children.length, 0, 'sources not read yet is not "none"');
  assert.equal(sandbox({ installed: {}, hasHost: false }).ctx.renderNoSourcesNotice(), undefined, 'no home, no error');
  assert.equal(s.ctx.emptySourcesNone(), false);
  s.ctx.state.installedSources = {};
  assert.equal(s.ctx.emptySourcesNone(), true);
  s.ctx.state.installedSources = { a: {} };
  assert.equal(s.ctx.emptySourcesNone(), false);
});

test('it says what to do, with a button for the catalog and one for a link, and the buttons open those two tabs and no other', () => {
  const s = sandbox({ installed: {} });
  s.ctx.renderNoSourcesNotice();
  const html = s.host.children[0].innerHTML;
  assert.match(html, /No source yet/);
  assert.match(html, /Open the source catalog/);
  assert.match(html, /Add a source from a link/);
  assert.match(html, /data-no-sources-tab="tab-advanced"/);
  assert.match(html, /data-no-sources-tab="tab-sources"/);
  const handler = s.listeners[0][1];
  const click = (tab) => handler({ target: { closest: (sel) => (sel === '[data-no-sources-tab]' ? { getAttribute: () => tab } : null) } });
  click('tab-advanced');
  click('tab-sources');
  assert.deepEqual([...s.opened], ['settings', 'settings']);
  assert.deepEqual([...s.clicks], ['tab-advanced', 'tab-sources']);
  click('tab-security');
  click('"><img>');
  handler({ target: { closest: () => null } });
  handler({ target: null });
  assert.equal(s.opened.length, 2, 'any other tab, and a click elsewhere, does nothing');
  assert.deepEqual([...s.ctx.emptySourcesOpenTab('tab-data') ?? []], [], 'asked directly it refuses too');
  assert.equal(s.opened.length, 2);
});

test('it is wired: the home asks for it when the state is read and when a source is installed or removed, the script is on the page, and the words exist in both languages', () => {
  assert.match(read('ui-state.js'), /state\.repos = data\.repos \|\| \[\];\s*\/\/ With no source installed[^\n]*\n\s*if \(typeof renderNoSourcesNotice === 'function'\) renderNoSourcesNotice\(\);/);
  assert.match(read('ui-settings-modal.js'), /state\.repos = data\.repos \|\| \[\];\s*if \(typeof renderNoSourcesNotice === 'function'\) renderNoSourcesNotice\(\);/);
  const html = fs.readFileSync(path.join(MODULES, '..', 'index.html'), 'utf8');
  assert.match(html, /modules\/ui-empty-sources\.js/);
  assert.match(fs.readFileSync(path.join(MODULES, '..', 'css-modules', 'recommended-section.css'), 'utf8'), /\.no-sources-notice \{/);
  for (const lang of ['en-GB', 'pt-PT']) {
    const table = locale(lang);
    for (const key of ['home.noSources.title', 'home.noSources.text', 'home.noSources.catalog', 'home.noSources.link']) assert.ok(typeof table[key] === 'string' && table[key], `${lang} ${key}`);
  }
  const source = read('ui-empty-sources.js');
  assert.ok(!/innerHTML\s*=\s*[^;]*\$\{(?!text\(|EMPTY_SOURCES_TABS)/.test(source.replace(/`[\s\S]*?`/g, '')), 'no text but the translations is put in markup');
});
