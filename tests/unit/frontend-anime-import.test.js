'use strict';

// The Manga | Anime switch of the Import card (public/modules/ui-settings-anime-import.js), run in the same vm sandbox as the card's
// other tests (tests/helpers/source-import-rig.js). What matters: in anime mode the card's own requests go to the anime routes and
// only those three; what the other kind owns is hidden; the anime list shows only what was imported, as text; a source that was just
// installed is switched on after the others; and the card works with or without this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rig = require('../helpers/source-import-rig');

const SCRIPTS = [...rig.SCRIPTS, 'ui-settings-anime-import.js'];
const FILE = path.join(rig.MODULES_DIR, 'ui-settings-anime-import.js');
const env = (apiImpl) => rig.makeEnv({ apiImpl, scripts: SCRIPTS });
const providers = (...imported) => ({ ok: true, providers: [{ id: 'anizone', name: 'AniZone', origin: 'bundled' }, ...imported.map((id) => ({ id, name: `Name ${id}`, origin: 'imported' }))] });

// ── Which route a request goes to ─────────────────────────────────────────

test('in anime mode the four routes of the card go to their anime twins; in manga mode nothing changes; other routes are never touched', async () => {
  const e = env(async () => ({ ok: true }));
  const attrs = { 'data-source-kind': 'manga' };
  const card = { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
  const request = e.ctx.animeSourceRequest(card, e.ctx.api);
  const routes = ['/api/sources/import/preview', '/api/sources/import/install', '/api/sources/uninstall', '/api/sources/import/test', '/api/sources/import/link'];
  for (const route of routes) await request(route, { method: 'POST', body: '{}' });
  assert.deepEqual(e.calls.map((c) => c.route), routes, 'manga mode: every route as it was');
  e.calls.length = 0;
  attrs['data-source-kind'] = 'anime';
  for (const route of routes) await request(route, { method: 'POST', body: '{}' });
  assert.deepEqual(e.calls.map((c) => c.route), [
    '/api/anime/sources/import/preview', '/api/anime/sources/import/install', '/api/anime/sources/uninstall', '/api/anime/sources/import/test', '/api/sources/import/link',
  ], 'the Check, Install, Uninstall and Test of the card are changed; the link block is manga only and never asked in this mode');
  attrs['data-source-kind'] = 'bogus';
  e.calls.length = 0;
  await request('/api/sources/import/preview');
  assert.equal(e.calls[0].route, '/api/sources/import/preview', 'an unknown kind is manga');
});

// ── What is listed and shown ──────────────────────────────────────────────

test('only imported anime sources with a valid id are listed, and a name is only ever text', () => {
  const e = env();
  const list = rig.plain(e.ctx.animeSourceNormalizeImported({ providers: [
    { id: 'anizone', name: 'AniZone', origin: 'bundled' },
    { id: 'mine', name: 'Mine', origin: 'imported' },
    { id: '../bad', name: 'Bad id', origin: 'imported' },
    { id: 'Upper', name: 'Upper', origin: 'imported' },
    { id: 'long', name: 'x'.repeat(200), origin: 'imported' },
    { id: 'noname', origin: 'imported' },
    null, 'x', { id: 5, origin: 'imported' },
  ] }));
  assert.deepEqual(list.map((s) => s.id), ['mine', 'long', 'noname']);
  assert.equal(list[1].name.length, 80);
  assert.equal(list[2].name, 'noname');
  for (const junk of [null, undefined, 'x', {}, { providers: 'x' }, []]) assert.deepEqual(rig.plain(e.ctx.animeSourceNormalizeImported(junk)), []);

  for (const hostile of rig.HOSTILE) {
    const html = e.ctx.buildAnimeInstalledHtml([{ id: 'ok', name: hostile }]);
    const $ = rig.markup(html);
    assert.equal($('img, script, svg, iframe').length, 0, hostile);
    assert.equal($('[onerror], [onfocus], [onload]').length, 0, hostile);
  }
  const $ = rig.markup(e.ctx.buildAnimeInstalledHtml([{ id: 'mine', name: 'Mine' }]));
  const button = $('button[data-si-action="uninstall"]');
  assert.equal(button.attr('data-source-id'), 'mine', 'the card\'s own Uninstall: its delegated listener handles it');
  assert.match(rig.markup(e.ctx.buildAnimeInstalledHtml([])).root().text(), /No anime source imported yet/);
});

test('the switch has a Manga and an Anime button, the note says what an anime source must do, and both languages carry every string', () => {
  const e = env();
  const $ = rig.markup(e.ctx.buildAnimeSourceModeHtml());
  assert.deepEqual($('[data-source-kind-btn]').map((_, b) => $(b).attr('data-source-kind-btn')).get(), ['manga', 'anime']);
  assert.equal($('[data-source-kind-btn="manga"]').attr('aria-pressed'), 'true');
  assert.equal($('[data-source-kind-btn="anime"]').attr('aria-pressed'), 'false');
  assert.ok($('#sourceAnimeNote').attr('hidden') !== undefined, 'the note is for anime mode');
  assert.match($('#sourceAnimeNote').text(), /stream\.hosts/);
  const keys = (strings) => Object.keys(strings).filter((k) => k.startsWith('settings.sourceAnime.')).sort();
  assert.ok(keys(rig.EN).length >= 6);
  assert.deepEqual(keys(rig.PT), keys(rig.EN));
  for (const key of keys(rig.EN)) assert.ok(rig.EN[key] && rig.PT[key], key);
});

test('a Check of an anime source does not show the manga declaration section; a manga one still does', () => {
  const e = env();
  const text = (kind) => rig.markup(e.ctx.buildSourceImportReportHtml(rig.report({ kind }))).root().text();
  assert.match(text('manga'), /How the app will use it/);
  assert.doesNotMatch(text('anime'), /How the app will use it/);
  assert.equal(rig.plain(e.ctx.sourceImportNormalizeReport(rig.report({ kind: 'anime' }))).kind, 'anime');
  assert.equal(rig.plain(e.ctx.sourceImportNormalizeReport(rig.report({ kind: 'weird' }))).kind, 'manga');
  assert.equal(rig.plain(e.ctx.sourceImportNormalizeReport(rig.report())).kind, 'manga');
});

// ── Switching a new source on ─────────────────────────────────────────────

test('a source just installed is switched on after the ones already on; nothing changes when there is nothing new', () => {
  const e = env();
  let saved = 0;
  e.ctx.saveSettings = () => { saved += 1; };
  e.ctx.DEFAULT_VISIBLE_ANIME_PROVIDERS = ['anizone', 'animeparadise'];
  e.ctx.animeSourceSwitchOn([]);
  assert.deepEqual([saved, e.ctx.state.settings.visibleAnimeProviders], [0, undefined]);
  e.ctx.animeSourceSwitchOn(['mine']);
  assert.deepEqual(rig.plain(e.ctx.state.settings.visibleAnimeProviders), ['anizone', 'animeparadise', 'mine'], 'after the defaults, so the first source tried does not change');
  e.ctx.animeSourceSwitchOn(['mine', 'other']);
  assert.deepEqual(rig.plain(e.ctx.state.settings.visibleAnimeProviders), ['anizone', 'animeparadise', 'mine', 'other'], 'never twice');
  assert.equal(saved, 2);
  e.ctx.state.settings.visibleAnimeProviders = ['animeparadise'];
  e.ctx.animeSourceSwitchOn(['mine']);
  assert.deepEqual(rig.plain(e.ctx.state.settings.visibleAnimeProviders), ['animeparadise', 'mine'], 'a choice the person made is kept');
  assert.deepEqual(e.ctx.animeSourceNewIds(new Set(['a']), [{ id: 'a' }, { id: 'b' }]), ['b']);
});

// ── On the card ───────────────────────────────────────────────────────────

function cardOver(apiImpl) {
  const e = env(apiImpl);
  const made = (id) => ({ hidden: false, innerHTML: '', id });
  const els = { sourceLinkBlock: made('sourceLinkBlock'), sourceImportImported: made('sourceImportImported') };
  els.sourceImportImported.parentElement = { hidden: false };
  const buttons = ['manga', 'anime'].map((kind) => { const b = rig.fakeElement({ 'data-source-kind-btn': kind, 'aria-pressed': kind === 'manga' ? 'true' : 'false' }); b.className = 'btn'; return b; });
  // What the module adds exists only after it has added it, as in the page.
  const notice = { insertAdjacentHTML: () => { els.sourceAnimeNote = els.sourceAnimeNote || made('sourceAnimeNote'); els.sourceAnimeInstalled = els.sourceAnimeInstalled || { ...made('sourceAnimeInstalled'), hidden: true }; } };
  const card = rig.fakeElement();
  card.querySelector = (selector) => (selector === '.source-import-notice' ? notice : (els[selector.slice(1)] || null));
  card.querySelectorAll = (selector) => (selector === '[data-source-kind-btn]' ? buttons : []);
  const cancelled = [];
  const controller = { cancel: () => cancelled.push(true) };
  const click = (kind) => card.fire('click', { target: { closest: (s) => (s === '[data-source-kind-btn]' ? { getAttribute: () => kind } : null) } });
  return { e, els, buttons, card, controller, cancelled, click };
}

test('on the card: the switch changes what is shown, drops a report that was about the other kind, and is ignored while the card works', async () => {
  const c = cardOver(async () => providers('mine'));
  c.e.ctx.mountAnimeSourceMode(c.card, c.controller);
  await rig.settle();
  assert.equal(c.e.calls[0].route, '/api/anime/providers', 'the imported sources are read when the switch is added');
  assert.match(c.els.sourceAnimeInstalled.innerHTML, /data-source-id="mine"/);
  assert.equal(c.e.ctx.mountAnimeSourceMode(c.card, c.controller), null, 'not added twice');

  await c.click('anime');
  assert.equal(c.card.getAttribute('data-source-kind'), 'anime');
  assert.deepEqual([c.els.sourceAnimeNote.hidden, c.els.sourceAnimeInstalled.hidden, c.els.sourceLinkBlock.hidden, c.els.sourceImportImported.parentElement.hidden], [false, false, true, true]);
  assert.deepEqual(c.buttons.map((b) => b.getAttribute('aria-pressed')), ['false', 'true']);
  assert.equal(c.cancelled.length, 1);

  c.card.setAttribute('aria-busy', 'true');
  await c.click('manga');
  assert.equal(c.card.getAttribute('data-source-kind'), 'anime', 'while the card checks, installs or tests, the switch waits');
  c.card.setAttribute('aria-busy', 'false');
  await c.click('manga');
  assert.deepEqual([c.els.sourceAnimeNote.hidden, c.els.sourceAnimeInstalled.hidden, c.els.sourceLinkBlock.hidden, c.els.sourceImportImported.parentElement.hidden], [true, true, false, false]);
  assert.equal(c.cancelled.length, 2);
});

test('after an install the new anime source is switched on and the player\'s list is read again; what was already there is not announced', async () => {
  let imported = ['old'];
  const c = cardOver(async () => providers(...imported));
  const reloaded = [];
  c.e.ctx._animeLoadProviders = () => reloaded.push(true);
  c.e.ctx.saveSettings = () => {};
  c.e.ctx.DEFAULT_VISIBLE_ANIME_PROVIDERS = ['anizone'];
  c.e.ctx.mountAnimeSourceMode(c.card, c.controller);
  await rig.settle();
  assert.deepEqual([c.e.ctx.state.settings.visibleAnimeProviders, reloaded.length], [undefined, 0], 'the first look announces nothing');

  imported = ['old', 'fresh'];
  await c.e.ctx.refreshAnimeSourceList(c.card);
  assert.deepEqual(rig.plain(c.e.ctx.state.settings.visibleAnimeProviders), ['anizone', 'fresh']);
  assert.equal(reloaded.length, 1);
  assert.match(c.els.sourceAnimeInstalled.innerHTML, /data-source-id="fresh"/);

  imported = ['old'];
  await c.e.ctx.refreshAnimeSourceList(c.card);
  assert.deepEqual(rig.plain(c.e.ctx.state.settings.visibleAnimeProviders), ['anizone'], 'an uninstall takes the source out of the saved list, and switches nothing on');
  assert.doesNotMatch(c.els.sourceAnimeInstalled.innerHTML, /data-source-id="fresh"/);

  const down = cardOver(async () => { throw rig.httpError(403, { ok: false, code: 'LOCAL_ONLY', error: 'x' }); });
  down.e.ctx.mountAnimeSourceMode(down.card, down.controller);
  await rig.settle();
  assert.equal(down.els.sourceAnimeInstalled.innerHTML, '', 'a list that cannot be read leaves the box as it was');
});

test('the card asks the switch for its requests and its list, only when it is there; the page loads it after the card\'s own script', () => {
  const logic = fs.readFileSync(rig.LOGIC_FILE, 'utf8');
  assert.match(logic, /typeof animeSourceRequest === 'function' \? animeSourceRequest\(card, api\) : api/);
  assert.match(logic, /typeof mountAnimeSourceMode === 'function'\) mountAnimeSourceMode\(card, controller\)/);
  assert.match(logic, /typeof refreshAnimeSourceList === 'function'\) refreshAnimeSourceList\(card\)/);
  const index = fs.readFileSync(path.join(rig.PUBLIC_DIR, 'index.html'), 'utf8');
  const at = (name) => index.indexOf(`modules/${name}.js`);
  assert.ok(at('ui-settings-anime-import') > at('ui-settings-source-import'));
  assert.ok(at('ui-settings-anime-import') < at('ui-settings-modal'), 'before the modal that mounts the card');
  assert.ok(rig.lines(FILE).length <= 450);
});

// ── The Test of an anime source ───────────────────────────────────────────

test('each imported anime source has the card\'s own Test button and a box for its result, and says nothing is played', () => {
  const e = env();
  const $ = rig.markup(e.ctx.buildAnimeInstalledHtml([{ id: 'mine', name: 'Mine' }]));
  const test = $('button[data-si-action="test"]');
  assert.deepEqual([test.attr('data-source-id'), test.attr('data-depth')], ['mine', 'basic'], 'one depth: there is no "full" for video');
  assert.equal($('[data-test-for="mine"]').length, 1);
  assert.match(test.attr('title'), /no sound/i);
  assert.ok(rig.PT['settings.sourceAnime.testHint'].length > 20 && /som/.test(rig.PT['settings.sourceAnime.testHint']));
});

test('pressing Test in anime mode sends the id to the anime route and shows the answer in the box of that row', async () => {
  const e = env(async () => ({ ok: true, verified: true, depth: 'basic', counts: { pass: 6, fail: 0, warn: 0, skip: 1 }, calls: 6, images: 0, durationMs: 2300, checks: [{ id: 'anime-stream', status: 'pass', detail: 'ok' }] }));
  const attrs = { 'data-source-kind': 'anime' };
  const card = { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
  const view = rig.fakeView();
  const controller = e.ctx.createSourceImportController({ api: e.ctx.animeSourceRequest(card, e.ctx.api), view, onChanged: () => {} });
  assert.equal(await controller.test('mine', 'basic'), true);
  assert.equal(e.calls[0].route, '/api/anime/sources/import/test');
  assert.deepEqual(e.calls[0].body, { id: 'mine', depth: 'basic' });
  assert.equal(view.last('showTest')[1], 'mine');
  const html = e.ctx.buildSourceImportTestHtml(view.last('showTest')[2]);
  assert.match(rig.markup(html).root().text(), /A stream for an episode/, 'the check has its own title');
});

test('asking the list again after a test leaves what is shown in it alone, and a change of sources rewrites it', async () => {
  let imported = ['mine'];
  const c = cardOver(async () => providers(...imported));
  c.e.ctx.mountAnimeSourceMode(c.card, c.controller);
  await rig.settle();
  c.els.sourceAnimeInstalled.innerHTML = '<p>a test result is here</p>';
  await c.e.ctx.refreshAnimeSourceList(c.card);
  assert.equal(c.els.sourceAnimeInstalled.innerHTML, '<p>a test result is here</p>', 'the card asks after every test: nothing changed, nothing is rewritten');
  imported = ['mine', 'other'];
  await c.e.ctx.refreshAnimeSourceList(c.card);
  assert.match(c.els.sourceAnimeInstalled.innerHTML, /data-source-id="other"/);
});
