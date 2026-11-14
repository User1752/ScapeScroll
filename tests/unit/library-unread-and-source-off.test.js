'use strict';

// Two things in the library: "Mark as Unread" on a manga must clear what was read (not only the status), and a manga opened
// from the library whose source is turned off or not installed must say so. The helpers are run on their real text; the
// closures that call them (the context menu's setStatus, loadMangaDetails) are guarded by their source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (file) => fs.readFileSync(path.join(MODULES, file), 'utf8');

function functionText(file, name) {
  const text = read(file);
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in ${file}`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return assert.fail(`${name} is not closed`);
}

// ── Mark as Unread clears what was read ────────────────────────────────────

function readContext() {
  const context = {
    state: {
      readChapters: new Set(['m1:c1', 'm1:c2', 'm12:c1', 'm2:c1', 'm1x:c9']),
      lastReadChapter: { m1: 'c2', m2: 'c1', m12: 'c1' },
      lastReadPages: { 'm1:c1': 4, 'm1:c2': 0, 'm2:c1': 7, 'm12:c1': 3 },
      lastReadPageTotals: { 'm1:c1': 20, 'm2:c1': 18, 'm12:c1': 9 },
    },
  };
  vm.createContext(context);
  vm.runInContext(functionText('ui-library-context-menu.js', '_clearMangaReadState'), context);
  return context;
}

test('unread forgets the read chapters and the resume position of that manga only', () => {
  const ctx = readContext();
  vm.runInContext("_clearMangaReadState('m1')", ctx);
  assert.deepEqual([...ctx.state.readChapters].sort(), ['m12:c1', 'm1x:c9', 'm2:c1'], 'a manga whose id only starts the same is left alone');
  assert.deepEqual({ ...ctx.state.lastReadChapter }, { m2: 'c1', m12: 'c1' });
  assert.deepEqual({ ...ctx.state.lastReadPages }, { 'm2:c1': 7, 'm12:c1': 3 });
  assert.deepEqual({ ...ctx.state.lastReadPageTotals }, { 'm2:c1': 18, 'm12:c1': 9 });
});

test('unread on a manga that was never read, or when the maps are missing, does nothing and does not throw', () => {
  const ctx = readContext();
  vm.runInContext("_clearMangaReadState('never-opened')", ctx);
  assert.equal(ctx.state.readChapters.size, 5);
  const bare = { state: { readChapters: new Set(['a:1']) } };
  vm.createContext(bare);
  vm.runInContext(functionText('ui-library-context-menu.js', '_clearMangaReadState'), bare);
  vm.runInContext("_clearMangaReadState('a')", bare);
  assert.equal(bare.state.readChapters.size, 0);
});

test('the context menu clears the read state only for "unread", saves once and says so', () => {
  const text = read('ui-library-context-menu.js');
  const setStatus = text.slice(text.indexOf('const setStatus = async (status) => {'), text.indexOf("menu.querySelector('#ctxMarkCompleted')"));
  assert.ok(setStatus.length > 200, 'setStatus was found');
  assert.match(setStatus, /if \(status === 'none'\) _clearMangaReadState\(item\.id\);/, 'only for unread, per manga');
  assert.match(setStatus, /if \(status === 'none' && ok > 0 && typeof saveSettings === 'function'\) saveSettings\(\);/, 'saved once for the whole batch');
  assert.match(setStatus, /set to unread, read chapters cleared/);
  assert.ok(setStatus.indexOf('_clearMangaReadState') > setStatus.indexOf("api('/api/user/status'"), 'after the status was really set');
});

// ── A manga whose source is off says so ────────────────────────────────────

function noticeContext({ installed, disabled = [] }) {
  const strings = {
    'manga.sourceOff': 'Source turned off',
    'manga.sourceOffHint': '{name} is turned off in Settings.',
    'manga.sourceMissing': 'Source not installed',
    'manga.sourceMissingHint': '{name} is not installed.',
  };
  const context = {
    state: { installedSources: installed, settings: { disabledSourceIds: disabled } },
    t: (key) => strings[key] || key,
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
  };
  vm.createContext(context);
  vm.runInContext(functionText('ui-search.js', '_sourceOffNoticeHtml'), context);
  return context;
}

test('a source that is turned off gets the warning, with its name', () => {
  const ctx = noticeContext({ installed: { alpha: { id: 'alpha', name: 'Alpha Reader' }, beta: { id: 'beta', name: 'Beta' } }, disabled: ['alpha'] });
  const html = vm.runInContext("_sourceOffNoticeHtml('alpha')", ctx);
  assert.match(html, /class="source-off-notice"/);
  assert.match(html, /<svg/, 'with its warning icon');
  assert.match(html, /Source turned off/);
  assert.match(html, /Alpha Reader is turned off in Settings\./);
  assert.equal(vm.runInContext("_sourceOffNoticeHtml('beta')", ctx), '', 'an active source gets nothing');
});

test('a source that is not installed gets its own warning', () => {
  const ctx = noticeContext({ installed: { beta: { id: 'beta', name: 'Beta' } } });
  const html = vm.runInContext("_sourceOffNoticeHtml('gone-source')", ctx);
  assert.match(html, /Source not installed/);
  assert.match(html, /gone-source is not installed\./, 'the id stands in for a name it no longer has');
});

test('no warning for the local library, for no source, or before the installed sources have loaded', () => {
  const ctx = noticeContext({ installed: { beta: { id: 'beta' } }, disabled: ['local'] });
  assert.equal(vm.runInContext("_sourceOffNoticeHtml('local')", ctx), '');
  assert.equal(vm.runInContext("_sourceOffNoticeHtml('')", ctx), '');
  assert.equal(vm.runInContext('_sourceOffNoticeHtml(undefined)', ctx), '');
  const early = noticeContext({ installed: {} });
  assert.equal(vm.runInContext("_sourceOffNoticeHtml('anything')", early), '', 'an empty list means "not loaded yet", not "missing"');
});

test('a name with markup in it is shown as text', () => {
  const ctx = noticeContext({ installed: { x: { id: 'x', name: '<img src=x onerror=alert(1)>' } }, disabled: ['x'] });
  const html = vm.runInContext("_sourceOffNoticeHtml('x')", ctx);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&#60;img/);
});

test('the details of a manga show the warning right under the title, and both languages have its four texts', () => {
  const text = read('ui-search.js');
  assert.match(text, /<h2 class="manga-title">\$\{escapeHtml\(getDisplayMangaTitle\(result\)\)\}<\/h2>\s*\$\{_sourceOffNoticeHtml\(state\.currentSourceId\)\}/);
  for (const file of ['en-GB.js', 'pt-PT.js']) {
    const locale = read(path.join('i18n', 'locales', file));
    for (const key of ['manga.sourceOff', 'manga.sourceMissing']) assert.match(locale, new RegExp(`"${key.replace('.', '\\.')}": "[^"]+"`), `${file} has ${key}`);
    for (const key of ['manga.sourceOffHint', 'manga.sourceMissingHint']) assert.match(locale, new RegExp(`"${key.replace('.', '\\.')}": "[^"]*\\{name\\}[^"]*"`), `${file}: ${key} carries {name}`);
  }
  const css = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css-modules', 'manga-details-page.css'), 'utf8');
  assert.match(css, /\.source-off-notice\s*\{/);
});
