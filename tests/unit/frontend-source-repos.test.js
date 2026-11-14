'use strict';

// The repositories block of the source catalog (public/modules/ui-settings-source-repos.js) and the catalog's row for a site of an added repository, run in the
// same vm sandbox as the card's other tests (tests/helpers/source-import-rig.js). What matters: every value of an answer is only ever shown as text, nothing is
// asked until the block is opened, an address is sent as typed (the server judges it) and nothing else is, a refusal is shown as the sentence the server gave,
// the catalog is read again when the list changes, a site of an added repository has "Check this site" and the name of its repository, and both languages
// carry every string.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rig = require('../helpers/source-import-rig');

const SCRIPTS = [...rig.SCRIPTS, 'ui-settings-source-link.js', 'ui-settings-source-repos.js', 'ui-settings-source-catalog-html.js', 'ui-settings-source-catalog.js'];
const env = (apiImpl) => rig.makeEnv({ apiImpl, scripts: SCRIPTS });
const KEY = 'eu.kanade.tachiyomi.extension.en.alpha#0';

const repo = (over = {}) => ({ url: 'https://repo.example/x/index.min.json', name: 'repo.example', ok: true, count: 12, ...over });

// ── answers become plain values ───────────────────────────────────────────

test('an answer is cut to plain values: an address that is not https is dropped, text is capped, the flags are three-valued, the list is capped', () => {
  const { ctx } = env();
  const out = rig.plain(ctx.sourceReposNormalize({
    max: '5',
    repos: [repo(), repo({ url: 'http://insecure.example/index.json' }), repo({ url: 'javascript:alert(1)' }), repo({ url: 'https://x.example/a b' }), null, 'text', repo({ name: 'N'.repeat(300), ok: 'yes', count: -4 }), repo({ ok: false, count: '7' }), repo({ ok: null })],
  }));
  assert.equal(out.max, 5);
  assert.equal(out.repos.length, 4);
  assert.deepEqual(out.repos[1], { url: 'https://repo.example/x/index.min.json', name: 'N'.repeat(60), ok: null, count: 0, isDefault: false });
  assert.deepEqual([out.repos[2].ok, out.repos[2].count, out.repos[3].ok], [false, 7, null]);
  assert.deepEqual(rig.plain(ctx.sourceReposNormalize(null)), { max: 8, repos: [] });
  assert.equal(ctx.sourceReposNormalize({ repos: Array.from({ length: 200 }, () => repo()) }).repos.length, 20);
});

test('a hostile name or address is only ever text in the markup', () => {
  const { ctx } = env();
  for (const evil of rig.HOSTILE) {
    const html = ctx.buildSourceReposRowsHtml(ctx.sourceReposNormalize({ repos: [repo({ name: evil })] }));
    const $ = rig.markup(html);
    assert.equal($('img, script, svg').length, 0, evil);
    assert.equal($('[onerror], [onfocus], [onload]').length, 0, evil);
    assert.equal($('.source-catalog-repo-name').eq(0).text(), evil.slice(0, 60), 'the name is text');
  }
});

test('the list has a row with Remove for each repository, the default one too (marked as such); one that could not be read says so', () => {
  const { ctx } = env();
  const none = rig.markup(ctx.buildSourceReposRowsHtml(ctx.sourceReposNormalize({ repos: [] })));
  assert.equal(none('li.source-catalog-repo').length, 0);
  assert.equal(none('button').length, 0);
  assert.match(none('.source-catalog-repo-none').text(), /No repository/);
  const rows = rig.markup(ctx.buildSourceReposRowsHtml(ctx.sourceReposNormalize({ repos: [repo(), repo({ url: 'https://bad.example/index.json', name: 'bad', ok: false })] })));
  assert.equal(rows('button[data-repo-remove]').length, 2);
  assert.equal(rows('button').eq(0).attr('data-repo-remove'), 'https://repo.example/x/index.min.json');
  assert.equal(rows('button').eq(0).attr('aria-label'), 'Remove repo.example');
  assert.match(rows('.source-catalog-repo-status').eq(0).text(), /12 extensions/);
  assert.match(rows('.source-catalog-repo-status.is-bad').text(), /Could not be read/);
  assert.equal(rows('code').eq(0).text(), 'repo.example/x/index.min.json');
  assert.equal(rows('.source-catalog-repo-tag').length, 0, 'an added repository carries no "default" tag');
  const withDefault = rig.markup(ctx.buildSourceReposRowsHtml(ctx.sourceReposNormalize({ repos: [repo({ url: 'https://github.com/o/n/raw/repo/index.json', name: 'o/n', default: true }), repo()] })));
  assert.equal(withDefault('li.is-default').length, 1);
  assert.equal(withDefault('li.is-default .source-catalog-repo-tag').text(), 'Default repository');
  assert.equal(withDefault('button[data-repo-remove]').length, 2, 'the default repository can be removed like the others');
  assert.equal(withDefault('li.is-default button').attr('data-repo-remove'), 'https://github.com/o/n/raw/repo/index.json');
});

test('the block has a box that takes an address, an Add button and a line for what happened, with the ids of the block it is in', () => {
  const { ctx } = env();
  const $ = rig.markup(ctx.buildSourceReposBlockHtml('advancedCatalog'));
  assert.deepEqual(['#advancedCatalogRepos', '#advancedCatalogRepoList', '#advancedCatalogRepoInput', '#advancedCatalogRepoAdd', '#advancedCatalogRepoMsg'].map((s) => $(s).length), [1, 1, 1, 1, 1]);
  assert.equal($('input').attr('maxlength'), '300');
  assert.equal($('input').attr('type'), 'url');
  assert.equal(rig.markup(ctx.buildSourceReposBlockHtml('<img src=x>'))('#sourceCatalogRepos').length, 1, 'a prefix that is not a plain word falls back to the default one');
  const catalog = rig.markup(ctx.buildSourceCatalogHtml('sourceCatalog', true));
  assert.equal(catalog('#sourceCatalogRepos').length, 1, 'the catalog block carries it');
});

// ── the behaviour ─────────────────────────────────────────────────────────

function fakeRoot(prefix, e) {
  const html = e.ctx.buildSourceReposBlockHtml(prefix);
  const root = rig.fakeCard();
  root.innerHTML = html;
  const block = root.querySelector(`#${prefix}Repos`);
  block.open = false;
  const input = root.querySelector(`#${prefix}RepoInput`);
  const list = root.querySelector(`#${prefix}RepoList`);
  list.closest = () => null;
  return { root, block, input, list, add: root.querySelector(`#${prefix}RepoAdd`), message: root.querySelector(`#${prefix}RepoMsg`) };
}

function mount(answers = {}) {
  const calls = [];
  let changed = 0;
  const e = env();
  const view = fakeRoot('sourceCatalog', e);
  view.message.classList = { toggled: [], toggle(name, on) { this.toggled.push([name, on]); } };
  const request = async (route, opts = {}) => {
    calls.push({ route, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const answer = answers[`${opts.method || 'GET'}`];
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(opts) : answer;
  };
  const control = e.ctx.mountSourceRepos(view.root, 'sourceCatalog', { request, onChanged: () => { changed += 1; } });
  return { e, view, calls, control, changed: () => changed };
}

test('nothing is asked until the block is opened, and opening it again does not ask again', async () => {
  const m = mount({ GET: { ok: true, max: 8, repos: [repo()] } });
  await rig.settle();
  assert.deepEqual(m.calls, []);
  m.view.block.open = true;
  await m.view.block.fire('toggle');
  await rig.settle();
  assert.deepEqual(m.calls.map((c) => [c.route, c.method]), [['/api/sources/catalog/repos', 'GET']]);
  assert.match(m.view.list.innerHTML, /data-repo-remove="https:\/\/repo\.example\/x\/index\.min\.json"/);
  await m.view.block.fire('toggle');
  assert.equal(m.calls.length, 1);
});

test('adding sends the address as typed and nothing else, shows how many extensions it holds, reads the list again and tells the catalog; an empty box sends nothing', async () => {
  const m = mount({ POST: { ok: true, repo: { url: 'https://repo.example/x/index.min.json', name: 'repo.example', count: 12, sites: 30 } }, GET: { ok: true, repos: [repo()] } });
  await m.view.add.fire('click');
  assert.deepEqual(m.calls, [], 'an empty box sends nothing');
  m.view.input.value = '  https://github.com/owner/name  ';
  await m.view.add.fire('click');
  await rig.settle();
  assert.deepEqual(m.calls.map((c) => [c.method, c.body]), [['POST', { input: 'https://github.com/owner/name' }], ['GET', undefined]]);
  assert.equal(m.view.input.value, '', 'the box is cleared');
  assert.equal(m.view.message.textContent, 'Added: 12 extensions.');
  assert.equal(m.changed(), 1);
  assert.equal(m.view.add.disabled, false, 'the button is free again');
  m.view.input.value = `https://x.example/${'a'.repeat(900)}`;
  await m.view.add.fire('click');
  assert.equal(m.calls.find((c) => c.method === 'POST' && c.body.input.length > 400), undefined, 'what is sent is cut to the length the server takes');
});

test('a refusal of the server is shown as the sentence it gave, nothing changes, and Enter in the box adds like the button', async () => {
  const m = mount({ POST: rig.httpError(422, { ok: false, error: 'No list of extensions was found there (it answered 404).' }) });
  m.view.input.value = 'https://nothing.example/';
  await m.view.input.fire('keydown', { key: 'Enter', preventDefault() {} });
  await rig.settle();
  assert.equal(m.calls.filter((c) => c.method === 'POST').length, 1, 'Enter adds');
  assert.match(m.view.message.textContent, /No list of extensions was found there/);
  assert.equal(m.changed(), 0, 'the catalog is not read again for a refusal');
  assert.equal(m.view.add.disabled, false);
  assert.equal(m.view.message.classList.toggled.at(-1)[1], true, 'it is shown as an error');
  await m.view.input.fire('keydown', { key: 'a', preventDefault() {} });
  assert.equal(m.calls.filter((c) => c.method === 'POST').length, 1, 'another key does nothing');
});

test('removing sends the address of the row that was clicked, reads the list again and tells the catalog; a click elsewhere does nothing', async () => {
  const m = mount({ DELETE: { ok: true, removed: true }, GET: { ok: true, repos: [] } });
  const clickOn = (attr) => m.view.list.fire('click', { target: { closest: (s) => (s === '[data-repo-remove]' ? { disabled: false, getAttribute: () => attr } : null) } });
  await m.view.list.fire('click', { target: { closest: () => null } });
  assert.deepEqual(m.calls, []);
  await clickOn('https://repo.example/x/index.min.json');
  await rig.settle();
  assert.deepEqual(m.calls.map((c) => [c.method, c.body]), [['DELETE', { url: 'https://repo.example/x/index.min.json' }], ['GET', undefined]]);
  assert.equal(m.view.message.textContent, 'Removed.');
  assert.equal(m.changed(), 1);
});

// ── the catalog's row ─────────────────────────────────────────────────────

const row = (over = {}) => ({ key: KEY, name: 'Omega Site', host: 'omega.example', lang: 'en', warning: 'SAFE', engine: 'unknown', via: 'check', cloudflare: 'n/a', installed: false, installedId: '', blocked: false, repo: 'repo.example', ...over });

test('a site of an added repository has "Check this site" and the name of its repository, and no "Unknown" badge; the others are as they were', () => {
  const { ctx } = env();
  const $ = rig.markup(ctx.buildSourceCatalogRowHtml(ctx.sourceCatalogNormalize({ rows: [row()] }).rows[0]));
  const button = $('button[data-catalog-add]');
  assert.equal(button.length, 1, 'it goes through the same flow as Add');
  assert.equal(button.text(), 'Check this site');
  assert.equal(button.attr('aria-label'), 'Check Omega Site and add it if a source can be written');
  assert.match(button.attr('title'), /from a repository you added/);
  assert.equal(button.attr('disabled'), undefined);
  assert.equal($('.source-catalog-badge.is-repo').text(), 'repo.example');
  assert.equal($('.source-catalog-badge.is-engine').length, 0, 'it is not called "Unknown": it has not been looked at yet');
  const native = rig.markup(ctx.buildSourceCatalogRowHtml(ctx.sourceCatalogNormalize({ rows: [row({ engine: 'ready', via: 'native', repo: '' })] }).rows[0]));
  assert.equal(native('button').text(), 'Add');
  assert.equal(native('.source-catalog-badge.is-repo').length, 0);
  const failed = rig.markup(ctx.buildSourceCatalogRowHtml(ctx.sourceCatalogNormalize({ rows: [row({ engine: 'failed', via: '' })] }).rows[0]));
  assert.notEqual(failed('button').attr('disabled'), undefined, 'a site that could not be added is not offered again');
  assert.equal(failed('.source-catalog-badge.is-engine').length, 1);
  const hostile = rig.markup(ctx.buildSourceCatalogRowHtml(ctx.sourceCatalogNormalize({ rows: [row({ repo: '<img src=x onerror=PWN(1)>' })] }).rows[0]));
  assert.equal(hostile('img').length, 0);
  assert.equal(ctx.sourceCatalogNormalize({ rows: [row({ via: 'bogus' })] }).rows[0].via, '', 'an unknown way to add is not one');
});

test('the page loads the repositories before the catalog block that puts them in, and both languages carry every string', () => {
  const page = fs.readFileSync(path.join(rig.PUBLIC_DIR, 'index.html'), 'utf8');
  const at = (name) => page.indexOf(`/modules/${name}`);
  assert.ok(at('ui-settings-source-repos.js') > 0 && at('ui-settings-source-repos.js') < at('ui-settings-source-catalog-html.js') && at('ui-settings-source-repos.js') < at('ui-settings-source-catalog.js'));
  const source = fs.readFileSync(path.join(rig.MODULES_DIR, 'ui-settings-source-repos.js'), 'utf8');
  const keys = [...source.matchAll(/'(settings\.sourceRepos\.[A-Za-z]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 10);
  for (const key of [...new Set(keys), 'settings.sourceCatalog.check', 'settings.sourceCatalog.checkLabel', 'settings.sourceCatalog.checkHint']) {
    assert.ok(rig.EN[key] && rig.PT[key], key);
  }
  assert.ok(!/\bon(click|change|error|load)\s*=/.test(source), 'no inline event handlers');
  assert.ok(source.split('\n').length <= 450);
});
