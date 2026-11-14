'use strict';

// The "Import a source" card in Settings > Advanced, last third: the DOM glue over the card's real markup, the hook and
// the shared refresh in ui-settings-modal.js (including the "Disabled sources" list that is redrawn with it), and the
// error api() throws. The markup and static guards are in frontend-source-import-markup.test.js, the controller in
// frontend-source-import-controller.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const limits = require('../../server/config/limits');
const rig = require('../helpers/source-import-rig');

const { MODULES_DIR, SHA, HOSTILE, EN, plain, settle, deferred, lines, report, httpError, makeEnv, markup, okInstall, routeOf, click, fakeModal, mounted } = rig;

const previewOrInstall = routeOf(async (route, body) => (route.endsWith('preview') ? report({ id: (body && body.id) || 'demo' }) : okInstall()));

test('the card is added right after the Anime Sources card, once, and nothing is added without an Advanced tab', () => {
  const { modal, result } = mounted(routeOf(async () => report()));
  assert.equal(modal.added.length, 1);
  assert.equal(modal.added[0][0], 'afterend');
  assert.equal(modal.added[0][1], result.card);
  assert.equal(result.card.id, 'sourceImportCard');
  assert.match(result.card.className, /settings-section-card/);
  const none = makeEnv({ apiImpl: routeOf(async () => report()) });
  assert.equal(none.ctx.mountSourceImportCard(fakeModal({ withTab: false }), undefined), null);
  assert.equal(none.ctx.mountSourceImportCard(null, undefined), null);
  const appended = fakeModal({ withAnchor: false });
  assert.ok(none.ctx.mountSourceImportCard(appended, undefined));
  assert.equal(appended.added[0][0], 'end');
  assert.equal(none.ctx.mountSourceImportCard(modal, undefined), null, 'a second mount of the same modal does nothing');
});

test('end to end through the card: choose a file, check, install, and the form and lists are refreshed', async () => {
  let changed = 0;
  const rig1 = mounted(previewOrInstall, { onChanged: async () => { changed += 1; } });
  const { env, byId, card } = rig1;
  const file = byId('sourceImportFile');
  file.files = [{ name: 'My Site (1).js', size: 20, text: async () => 'exports.meta = {};' }];
  await file.fire('change');
  assert.equal(byId('sourceImportCode').value, 'exports.meta = {};');
  assert.equal(byId('sourceImportId').value, '', 'a file name is not an id: the box stays empty and the server reads meta.id');

  await click(card, 'choose-file');
  assert.equal(file.clicked, 1, 'the visible button opens the hidden picker');

  await click(card, 'check');
  assert.deepEqual(env.calls.map((c) => c.route), ['/api/sources/import/preview']);
  assert.deepEqual(plain(env.calls[0].body), { code: 'exports.meta = {};' }, 'no id in the request: the server finds the one inside the file');
  assert.equal(markup(byId('sourceImportReport').innerHTML)('[data-si-action="install"]').length, 1);

  await click(card, 'install');
  assert.deepEqual(env.calls.map((c) => c.route), ['/api/sources/import/preview', '/api/sources/import/install']);
  assert.deepEqual(plain(env.calls[1].body), { sha256: SHA, id: 'demo' }, 'the id the server reported for the checked text');
  assert.deepEqual(env.toasts, [[EN['settings.sourceImport.toastTitle'], 'Demo installed.', 'success']]);
  assert.equal(byId('sourceImportCode').value, '');
  assert.equal(byId('sourceImportId').value, '');
  assert.equal(byId('sourceImportReport').innerHTML, '');
  assert.equal(changed, 1);
});

test('typing after a check removes the report and says to check again; choosing a file never overwrites an id that was typed', async () => {
  const { byId, card } = mounted(routeOf(async () => report()));
  byId('sourceImportCode').value = 'text';
  byId('sourceImportId').value = 'typed';
  await click(card, 'check');
  assert.ok(byId('sourceImportReport').innerHTML.includes('data-si-action="install"'));
  byId('sourceImportCode').value = 'text, edited';
  await byId('sourceImportCode').fire('input');
  assert.ok(!byId('sourceImportReport').innerHTML.includes('data-si-action="install"'));
  assert.ok(byId('sourceImportReport').innerHTML.includes(EN['settings.sourceImport.invalidated']));

  const file = byId('sourceImportFile');
  file.files = [{ name: 'other.js', size: 5, text: async () => 'new' }];
  await file.fire('change');
  assert.equal(byId('sourceImportId').value, 'typed');
});

test('choosing the same file twice reloads it: the picker is opened with its value already cleared', async () => {
  const { byId, card } = mounted(routeOf(async () => report()));
  const file = byId('sourceImportFile');
  file.value = 'C:\\fakepath\\mysite.js'; // what the browser keeps after a first choice, and why a second choice fires no change
  await click(card, 'choose-file');
  assert.deepEqual(file.valueWhenClicked, ['']);
  await click(card, 'choose-file');
  assert.deepEqual(file.valueWhenClicked, ['', '']);
});

test('a file over the cap is not read, and a file that cannot be read says so', async () => {
  const { byId } = mounted(routeOf(async () => report()));
  const file = byId('sourceImportFile');
  let read = 0;
  file.files = [{ name: 'big.js', size: limits.sourceImportMaxBytes + 1, text: async () => { read += 1; return 'x'; } }];
  await file.fire('change');
  assert.equal(read, 0);
  assert.ok(byId('sourceImportError').textContent.includes(String(limits.sourceImportMaxBytes + 1)));
  file.files = [{ name: 'broken.js', size: 3, text: async () => { throw new Error('denied'); } }];
  await file.fire('change');
  assert.equal(byId('sourceImportError').textContent, EN['settings.sourceImport.readFailed']);
  file.files = [];
  await file.fire('change');
});

test('an error from the server is put on the page as text, with its reasons as separate lines', async () => {
  const rigError = mounted(async (route) => {
    if (route.endsWith('preview')) return report();
    throw httpError(400, { ok: false, error: HOSTILE[0], errors: [HOSTILE[1], 'pages() is missing'] });
  });
  const { byId, card } = rigError;
  byId('sourceImportCode').value = 'text';
  await click(card, 'check');
  await click(card, 'install');
  const error = byId('sourceImportError');
  assert.equal(error.textContent, HOSTILE[0], 'set as textContent, so it can only be text');
  assert.deepEqual(error.children.map((child) => [child.className, child.textContent]), [['source-import-error-line', HOSTILE[1]], ['source-import-error-line', 'pages() is missing']]);
  await byId('sourceImportCode').fire('input');
  assert.equal(rigError.env.pwn.length, 0);
});

test('a failure is brought into view next to the button that was pressed; a success and an empty error are not', async () => {
  let failInstall = true;
  const { byId, card } = mounted(async (route) => {
    if (route.endsWith('preview')) return report();
    if (failInstall) throw httpError(400, { ok: false, error: 'The file does not follow the source contract.', errors: ['pages() is missing'] });
    return okInstall();
  });
  const scrolled = [];
  byId('sourceImportError').scrollIntoView = (options) => { scrolled.push(options); };
  byId('sourceImportCode').value = 'text';
  await click(card, 'check');
  assert.deepEqual(plain(scrolled), [], 'nothing to show yet: the error line was emptied, not announced');
  await click(card, 'install');
  assert.deepEqual(plain(scrolled), [{ block: 'nearest' }], 'the contract refusal and its reasons are scrolled to');
  assert.equal(byId('sourceImportError').textContent, 'The file does not follow the source contract.');
  failInstall = false;
  await click(card, 'install');
  assert.deepEqual(plain(scrolled), [{ block: 'nearest' }], 'a success adds no scroll');
});

test('a failed install whose checked file is gone (404) removes the report and its Install button and keeps the text', async () => {
  const { byId, card, env } = mounted(async (route) => {
    if (route.endsWith('preview')) return report();
    throw httpError(404, { ok: false, error: 'The checked file is no longer available: choose it again.' });
  });
  byId('sourceImportCode').value = 'my source';
  await click(card, 'check');
  assert.ok(byId('sourceImportReport').innerHTML.includes('data-si-action="install"'));
  await click(card, 'install');
  assert.equal(byId('sourceImportReport').innerHTML, '');
  assert.equal(byId('sourceImportError').textContent, 'The checked file is no longer available: choose it again.');
  assert.equal(byId('sourceImportCode').value, 'my source');
  await click(card, 'install'); // the button is gone; a stray click on nothing sends nothing
  assert.deepEqual(env.calls.map((c) => c.route), ['/api/sources/import/preview', '/api/sources/import/install']);
});

test('while a request runs the keyboard cannot start anything either: Cancel, Uninstall and the rest do nothing until it ends', async () => {
  const slow = deferred();
  const installed = { demo: { id: 'demo', name: 'Demo', installedVia: 'imported' } };
  const { byId, card, env } = mounted(async (route) => (route.endsWith('preview') ? report({ detectedId: 'other' }) : slow.promise), { installed });
  byId('sourceImportCode').value = 'text';
  await click(card, 'check');
  const installing = click(card, 'install');
  await settle();
  assert.equal(card.getAttribute('aria-busy'), 'true');
  for (const action of ['cancel', 'adopt-id', 'check', 'install', 'choose-file']) await click(card, action);
  await click(card, 'uninstall', 'demo');
  assert.equal(env.confirms.length, 0, 'no question is asked for an action that cannot start');
  assert.deepEqual(env.calls.map((c) => c.route), ['/api/sources/import/preview', '/api/sources/import/install'], 'no request was added');
  assert.equal(byId('sourceImportFile').clicked, 0);
  assert.ok(byId('sourceImportReport').innerHTML.includes('data-si-action="install"'), 'Cancel did not remove the report');
  slow.resolve(okInstall());
  await installing;
  assert.equal(card.getAttribute('aria-busy'), 'false');
  await click(card, 'uninstall', 'demo');
  assert.equal(env.confirms.length, 1, 'the same click works once the request has ended');
});

test('the imported list shows the store\'s imported sources, and Uninstall asks first, then removes one and redraws the list', async () => {
  const installed = { demo: { id: 'demo', name: 'Demo', version: '1.0.0', installedVia: 'imported' }, other: { id: 'other', name: 'Other', installedVia: 'repo' } };
  let changed = 0;
  const { byId, card, env } = mounted(routeOf(async () => ({ ok: true })), { installed, onChanged: async () => { delete installed.demo; changed += 1; } });
  const list = markup(card.innerHTML);
  assert.deepEqual(list('li').toArray().map((li) => list(li).find('.toggle-text').text().trim()), ['Demo v1.0.0 Not tested']);
  await click(card, 'uninstall', 'demo');
  assert.equal(env.confirms.length, 1, 'the person is asked first');
  assert.ok(env.confirms[0].includes('Demo') && env.confirms[0].includes('data/sources') && env.confirms[0].includes('.bak'), env.confirms[0]);
  assert.deepEqual(env.calls.map((c) => [c.route, plain(c.body)]), [['/api/sources/uninstall', { id: 'demo' }]]);
  assert.equal(changed, 1);
  assert.equal(byId('sourceImportImported').innerHTML.includes(EN['settings.sourceImport.importedNone']), true, 'the list was redrawn from the refreshed state');
  assert.deepEqual(env.toasts[0].slice(1), [EN['settings.sourceImport.uninstalled'], 'success']);
  await click(card, 'uninstall', '"><img src=x>');
  assert.equal(env.calls.length, 1, 'something that is not an id is not sent');
});

test('declining the question removes nothing and sends nothing', async () => {
  const installed = { demo: { id: 'demo', name: 'Demo', installedVia: 'imported' } };
  const { env, card } = mounted(routeOf(async () => ({ ok: true })), { installed, confirmAnswer: false });
  await click(card, 'uninstall', 'demo');
  assert.equal(env.confirms.length, 1);
  assert.equal(env.calls.length, 0);
  assert.equal(env.toasts.length, 0);
});

test('the question names the source from the store, and falls back to the id; it is in the language of the page', async () => {
  const installed = { a: { id: 'a', name: 'Alpha', installedVia: 'imported' } };
  const { env, card } = mounted(routeOf(async () => ({ ok: true })), { installed });
  env.ctx.setLanguage('pt');
  await click(card, 'uninstall', 'a');
  assert.ok(env.confirms[0].startsWith('Desinstalar Alpha?'), env.confirms[0]);
  await click(card, 'uninstall', 'not-in-the-store');
  assert.ok(env.confirms[1].startsWith('Desinstalar not-in-the-store?'), env.confirms[1]);
});

test('Cancel in the report discards it but keeps the text and the id; a click on a disabled button or on nothing does nothing', async () => {
  const { byId, card, env } = mounted(routeOf(async () => report()));
  byId('sourceImportCode').value = 'my only copy';
  byId('sourceImportId').value = 'mine';
  await click(card, 'check');
  assert.ok(byId('sourceImportReport').innerHTML.includes('data-si-action="install"'));
  await click(card, 'cancel');
  assert.equal(byId('sourceImportCode').value, 'my only copy');
  assert.equal(byId('sourceImportId').value, 'mine');
  assert.equal(byId('sourceImportReport').innerHTML, '');
  await card.fire('click', { target: { closest: () => null } });
  await card.fire('click', { target: { closest: () => ({ disabled: true, getAttribute: () => 'install' }) } });
  await card.fire('click', {});
  assert.equal(env.calls.length, 1);
});

test('while a request runs the check and file buttons are disabled and the card is marked busy', async () => {
  const slow = deferred();
  const { byId, card } = mounted(async () => slow.promise);
  byId('sourceImportCode').value = 'text';
  const running = click(card, 'check');
  await settle();
  assert.equal(byId('sourceImportCheckBtn').disabled, true);
  assert.equal(byId('sourceImportFileBtn').disabled, true);
  assert.equal(card.getAttribute('aria-busy'), 'true');
  slow.resolve(report());
  await running;
  assert.equal(byId('sourceImportCheckBtn').disabled, false);
  assert.equal(card.getAttribute('aria-busy'), 'false');
});

// ── the hook and the shared refresh in ui-settings-modal.js ─────────────────

const MODAL_FILE = path.join(MODULES_DIR, 'ui-settings-modal.js');

test('the hook in showSettings() is one guarded line, runs with the file missing, and uses the shared refresh', () => {
  const hooks = lines(MODAL_FILE).filter((line) => line.includes('mountSourceImportCard'));
  assert.equal(hooks.length, 1);
  assert.match(hooks[0], /^\s*if \(typeof mountSourceImportCard === 'function'\) mountSourceImportCard\(modal, refreshSourceReposSection\);$/);
  assert.doesNotThrow(() => vm.runInNewContext(hooks[0], { modal: {}, refreshSourceReposSection: () => {} }));
  const seen = [];
  vm.runInNewContext(hooks[0], { modal: 'm', refreshSourceReposSection: 'r', mountSourceImportCard: (...args) => seen.push(args) });
  assert.deepEqual(seen, [['m', 'r']]);

  const source = fs.readFileSync(MODAL_FILE, 'utf8');
  const defined = source.indexOf('const refreshSourceReposSection = async () => {');
  assert.ok(defined > 0 && source.indexOf('const refreshSourceReposSection', defined + 1) === -1, 'defined once');
  assert.ok(defined < source.indexOf(hooks[0].trim()), 'before the hook, outside any block');
  assert.ok(defined < source.indexOf(hooks[0].trim()), 'before the hook');
});

test('the shared refresh re-reads the state, redraws the Disabled sources list and the pickers, and says out loud when it fails', () => {
  const source = fs.readFileSync(MODAL_FILE, 'utf8');
  const start = source.indexOf('const refreshSourceReposSection = async () => {');
  const body = source.slice(start, source.indexOf('const fsInput', start));
  assert.match(body, /state\.installedSources = data\.installedSources \|\| \{\};/);
  assert.doesNotMatch(body, /sourceReposCardBody|buildSourceReposCardBodyHtml/, 'the old repositories card is gone: nothing to redraw');
  assert.match(body, /\$\("disabledSourcesList"\)/);
  assert.match(body, /disabledSourcesList\.innerHTML = buildDisabledSourcesListHtml\(\);\s*bindDisabledSourceToggles\(\);/, 'redrawn, then its toggles bound again');
  assert.match(body, /renderSourceSelect\(\)/, 'the pickers are redrawn');
  assert.match(body, /try \{[\s\S]*await api\("\/api\/state"\)[\s\S]*\} catch \(err\) \{[\s\S]*showToast\('Error', err\.message, 'error'\);/, 'a failed refresh is shown, not swallowed');
});

test('the Disabled sources toggles are bound by one function, at start-up and after every redraw, with the same handler as before', () => {
  const source = fs.readFileSync(MODAL_FILE, 'utf8');
  assert.equal(source.split('const bindDisabledSourceToggles = () => {').length - 1, 1, 'defined once');
  assert.equal(source.split("querySelectorAll('.disabledSourceToggle')").length - 1, 1, 'bound in one place only');
  assert.ok(source.indexOf('const bindDisabledSourceToggles') < source.indexOf('const refreshSourceReposSection'), 'defined before its first caller');
  assert.equal(lines(MODAL_FILE).filter((line) => line === '  bindDisabledSourceToggles();').length, 1, 'called once at start-up (the other call is inside the refresh), on the list as first drawn');
  assert.equal(lines(MODAL_FILE).filter((line) => line.trim() === 'bindDisabledSourceToggles();').length, 2, 'and once after every redraw');
  const handler = source.slice(source.indexOf("querySelectorAll('.disabledSourceToggle')"), source.indexOf('const refreshSourceReposSection'));
  for (const piece of ['if (initializingSettingsModal) return;', 'state.settings.disabledSourceIds = [...list];', 'saveSettings();',
    "pushDisabledSourcesToServer(state.settings.disabledSourceIds)", 'renderSourceSelect();', 'loadPopularToday()', 'loadRecentlyAdded()', 'loadLatestUpdates()']) {
    assert.ok(handler.includes(piece), piece);
  }
});

test('the Disabled sources list is one builder: its markup has a toggle per installed source, checked when disabled, and escapes names', () => {
  const env = makeEnv({ scripts: ['i18n/locales/en-GB.js', 'i18n/locales/pt-PT.js', 'i18n/index.js', 'utils.js', 'ui-settings-cards-sources.js'], installed: {} });
  const { ctx } = env;
  assert.ok(ctx.buildDisabledSourcesListHtml().includes('No sources installed.'));
  ctx.state.installedSources = { a: { id: 'a', name: 'Alpha' }, b: { id: 'b', name: HOSTILE[0] }, c: { id: 'c' } };
  ctx.state.settings = { disabledSourceIds: ['b'] };
  const $ = markup(ctx.buildDisabledSourcesListHtml());
  assert.deepEqual($('.disabledSourceToggle').toArray().map((n) => [n.attribs['data-source-id'], n.attribs.checked !== undefined]), [['a', false], ['b', true], ['c', false]]);
  assert.equal($('.toggle-text').toArray().map((n) => $(n).text())[2], 'c', 'the id when there is no name');
  assert.equal($('img, script').length, 0);
  assert.deepEqual(env.pwn, []);
  const page = fs.readFileSync(path.join(MODULES_DIR, 'ui-settings-cards-sources.js'), 'utf8');
  assert.equal(page.split('buildDisabledSourcesListHtml()').length - 1, 2, 'declared once, used once, inside the list\'s container');
  assert.match(page, /<div id="disabledSourcesList"[^>]*>\s*\$\{buildDisabledSourcesListHtml\(\)\}\s*<\/div>/);
});

test('api() puts the status and the parsed body on the error it throws, and keeps the message as it was', async () => {
  const bodies = [
    [409, JSON.stringify({ ok: false, code: 'ERROR-021', error: 'nope', errors: ['a'] })],
    [502, '<html>bad gateway</html>'],
    [500, ''],
  ];
  const outcomes = [];
  for (const [status, text] of bodies) {
    const sandbox = { fetch: async () => ({ ok: false, status, text: async () => text }) };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(MODULES_DIR, 'api.js'), 'utf8').replace(/^\uFEFF/, ''), sandbox);
    try { await vm.runInContext("api('/x')", sandbox); } catch (err) { outcomes.push({ message: err.message, status: err.status, data: plain(err.data) }); }
  }
  assert.deepEqual(outcomes, [
    { message: 'nope', status: 409, data: { ok: false, code: 'ERROR-021', error: 'nope', errors: ['a'] } },
    { message: 'HTTP 502', status: 502, data: { raw: '<html>bad gateway</html>' } },
    { message: 'HTTP 500', status: 500, data: null },
  ]);
  const ok = { fetch: async () => ({ ok: true, status: 200, text: async () => '{"a":1}' }) };
  vm.createContext(ok);
  vm.runInContext(fs.readFileSync(path.join(MODULES_DIR, 'api.js'), 'utf8').replace(/^\uFEFF/, ''), ok);
  assert.deepEqual(plain(await vm.runInContext("api('/x')", ok)), { a: 1 });
});
