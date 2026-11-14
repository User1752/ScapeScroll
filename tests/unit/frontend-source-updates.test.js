'use strict';

// The "Updates" block of the Suwayomi tab (public/modules/ui-settings-source-updates.js), run in the same vm sandbox as the card's other tests
// (tests/helpers/source-import-rig.js). What matters: every value of an answer is only ever shown as text (a changelog comes from a third party),
// the link of "what changed" can only be the history of an extension's folder in the project that builds them, nothing is updated unless the person
// confirmed, the check happens when the tab is opened and not again at once, and both languages carry every string.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rig = require('../helpers/source-import-rig');

const SCRIPTS = [...rig.SCRIPTS, 'ui-settings-source-link.js', 'ui-settings-source-updates.js'];
const FILE = path.join(rig.MODULES_DIR, 'ui-settings-source-updates.js');
const env = (apiImpl) => rig.makeEnv({ apiImpl, scripts: SCRIPTS });
const HISTORY = 'https://github.com/keiyoushi/extensions-source/commits/main/src/en/alpha';

const update = (over = {}) => ({ id: 'sw-6289731484943315811', name: 'Alpha Scans', version: '1.7.0', changelogUrl: HISTORY, changelog: 'Fixed the chapter list.', ...over });
const answer = (over = {}) => ({ ok: true, updates: [update()], checked: 2, ...over });

function fakeView() {
  const log = [];
  return {
    log,
    checking: () => log.push(['checking']),
    show: (result) => log.push(['show', rig.plain(result)]),
    error: (text) => log.push(['error', text]),
    updating: (id, on) => log.push(['updating', id, on]),
    outcome: (ok, message) => log.push(['outcome', ok, message]),
    all: (name) => log.filter((entry) => entry[0] === name),
  };
}

function setup(apiImpl, { linkController, confirmUpdate, now } = {}) {
  const e = env(apiImpl);
  const view = fakeView();
  const controller = e.ctx.createSourceUpdatesController({ api: e.ctx.api, view, linkController, confirmUpdate, now });
  return { e, view, controller, calls: e.calls };
}

// ── answers become plain values ───────────────────────────────────────────

test('an answer is cut to plain values: an id that is not a source id drops the row, a link that is not the history of an extension is dropped, text is capped', () => {
  const { ctx } = env();
  const out = rig.plain(ctx.sourceUpdatesNormalize({
    updates: [
      update(),
      update({ id: '"><img src=x onerror=PWN(1)>' }), update({ id: 'sw-1/../2' }), update({ id: 'alpha' }), update({ id: 'sw-' }), null, 'text',
      update({ name: 'N'.repeat(500), version: 'v'.repeat(100), changelog: 'c'.repeat(5000), changelogUrl: 'https://evil.example/x' }),
      update({ changelogUrl: 'javascript:alert(1)' }),
      update({ changelogUrl: `${HISTORY}?x=1` }),
      update({ changelogUrl: 'https://github.com/evil/extensions-source/commits/main/src/en/alpha' }),
    ],
    checked: '7',
  }));
  assert.equal(out.updates.length, 5);
  assert.deepEqual(out.updates[0], update());
  assert.deepEqual(out.updates[1], { id: 'sw-6289731484943315811', name: 'N'.repeat(80), version: 'v'.repeat(30), changelogUrl: '', changelog: 'c'.repeat(1500) });
  assert.deepEqual(out.updates.slice(2).map((u) => u.changelogUrl), ['', '', '']);
  assert.equal(out.checked, 7);
  assert.deepEqual(rig.plain(ctx.sourceUpdatesNormalize(null)), { updates: [], checked: 0 });
  assert.deepEqual(rig.plain(ctx.sourceUpdatesNormalize({ updates: 'x', checked: -3 })), { updates: [], checked: 0 });
});

test('a hostile name, version or changelog is only ever text in the markup', () => {
  const { ctx } = env();
  for (const evil of rig.HOSTILE) {
    const html = ctx.buildSourceUpdatesRowsHtml(ctx.sourceUpdatesNormalize({ updates: [update({ name: evil, version: evil, changelog: evil })] }).updates);
    const $ = rig.markup(html);
    assert.equal($('img, script, svg').length, 0, evil);
    assert.equal($('[onerror], [onfocus], [onload]').length, 0, evil);
    assert.equal($('li').length, 1);
    assert.equal($('pre').text(), evil.slice(0, 1500), 'the changelog is text');
  }
});

test('a row has the new version, a link that opens in a new tab without giving the page away, the changelog when there is one, and Update for that source', () => {
  const { ctx } = env();
  const card = (over) => rig.markup(ctx.buildSourceUpdateRowHtml(ctx.sourceUpdatesNormalize({ updates: [update(over)] }).updates[0]));
  const full = card({});
  assert.equal(full('.source-updates-name').text(), 'Alpha Scans');
  assert.match(full('.source-updates-version').text(), /1\.7\.0/);
  const link = full('a.source-updates-link');
  assert.equal(link.attr('href'), HISTORY);
  assert.equal(link.attr('target'), '_blank');
  assert.equal(link.attr('rel'), 'noopener noreferrer');
  assert.equal(full('details pre').text(), 'Fixed the chapter list.');
  assert.equal(full('button[data-update-source]').attr('data-update-source'), 'sw-6289731484943315811');
  const bare = card({ changelog: '', changelogUrl: '' });
  assert.equal(bare('a').length, 0);
  assert.equal(bare('details').length, 0);
  assert.equal(bare('button[data-update-source]').length, 1);
});

// ── the steps ─────────────────────────────────────────────────────────────

test('checking asks the route once, shows what it found, and a failure is said in its own words and leaves the list as it was', async () => {
  const { controller, calls, view } = setup(async () => answer());
  assert.equal(calls.length, 0, 'nothing is asked before the check');
  assert.equal(await controller.check(), true);
  assert.equal(calls[0].route, '/api/sources/engine/updates');
  assert.deepEqual(view.log.map((entry) => entry[0]), ['error', 'checking', 'show']);
  assert.equal(view.all('show')[0][1].updates.length, 1);
  const failing = setup(async () => { throw rig.httpError(502, { error: 'Suwayomi-Server could not list its extensions (HTTP 500).' }); });
  assert.equal(await failing.controller.check(), false);
  assert.deepEqual(failing.view.all('show')[0], ['show', null], 'the list was not replaced');
  assert.match(failing.view.all('error').pop()[1], /could not list its extensions/);
});

test('one check at a time, and the tab being opened checks only when it was not checked a moment ago', async () => {
  const gate = rig.deferred();
  let clock = 1_000_000;
  const { controller, calls } = setup(() => gate.promise, { now: () => clock });
  const first = controller.check();
  assert.equal(await controller.check(), false, 'a second check while one runs does nothing');
  assert.equal(calls.length, 1);
  gate.resolve(answer());
  await first;
  assert.equal(await controller.opened(), false, 'checked a moment ago');
  assert.equal(calls.length, 1);
  clock += 61_000;
  const again = setup(async () => answer(), { now: () => clock });
  await again.controller.check();
  clock += 61_000;
  assert.equal(await again.controller.opened(), true, 'a minute later it asks again');
  assert.equal(again.calls.length, 2);
});

test('Update asks first, writes through the card\'s own controller, then says where to read the check; declining changes nothing', async () => {
  const sent = [];
  const link = { runEngineUpdate: async (id) => { sent.push(id); return true; }, lastResult: () => ({ generated: true, message: '' }) };
  let asked = 0;
  const yes = setup(async () => answer(), { linkController: link, confirmUpdate: () => { asked += 1; return true; } });
  assert.equal(await yes.controller.update('sw-6289731484943315811'), true);
  assert.equal(asked, 1);
  assert.deepEqual(sent, ['sw-6289731484943315811']);
  assert.deepEqual(yes.view.all('updating'), [['updating', 'sw-6289731484943315811', true], ['updating', 'sw-6289731484943315811', false]]);
  assert.deepEqual(yes.view.all('outcome')[0].slice(1), [true, '']);
  const no = setup(async () => answer(), { linkController: link, confirmUpdate: () => false });
  assert.equal(await no.controller.update('sw-6289731484943315811'), false);
  assert.equal(sent.length, 1, 'declining writes nothing');
  assert.equal(await yes.controller.update('../x'), false, 'an id that is not a source id is refused before anything is asked');
  assert.equal(await yes.controller.update('alpha'), false);
  assert.equal(asked, 1);
});

test('a failed update says why, and the button is free again', async () => {
  const link = { runEngineUpdate: async () => false, lastResult: () => ({ generated: false, message: 'Suwayomi-Server could not update the extension (HTTP 500).' }) };
  const { controller, view } = setup(async () => answer(), { linkController: link, confirmUpdate: () => true });
  assert.equal(await controller.update('sw-1'), false);
  assert.deepEqual(view.all('outcome')[0].slice(1), [false, 'Suwayomi-Server could not update the extension (HTTP 500).']);
  assert.deepEqual(view.all('updating').map((entry) => entry[2]), [true, false]);
  const missing = setup(async () => answer(), { linkController: {}, confirmUpdate: () => true });
  assert.equal(await missing.controller.update('sw-1'), false, 'a page whose link block has no update step does nothing');
});

// ── the page ──────────────────────────────────────────────────────────────

test('the link block offers the update step and mounts this block; the page loads the script and the Suwayomi card has its slot', () => {
  const link = fs.readFileSync(path.join(rig.MODULES_DIR, 'ui-settings-source-link.js'), 'utf8');
  assert.match(link, /runEngineUpdate: \(id\) => sourceLinkRunEngineUpdate\(ctx, id\)/);
  assert.match(link, /typeof mountSourceUpdates === 'function'\) mountSourceUpdates\(card, controller, request/);
  assert.match(link, /\{ id, acknowledge: true \}, SOURCE_ENGINE_UPDATE_ENDPOINT/, 'only the id of the installed source is sent, with the confirmation');
  const html = fs.readFileSync(path.join(rig.PUBLIC_DIR, 'index.html'), 'utf8');
  assert.ok(html.indexOf('ui-settings-source-updates') > html.indexOf('ui-settings-source-link'), 'loaded after ui-settings-source-link.js');
  assert.match(fs.readFileSync(path.join(rig.MODULES_DIR, 'ui-settings-cards-sources.js'), 'utf8'), /id="suwayomiUpdatesSlot"/);
  const css = fs.readFileSync(path.join(rig.PUBLIC_DIR, 'css-modules', 'source-import.css'), 'utf8');
  for (const selector of ['.source-updates-row', '.source-updates-link', '.source-updates-text']) assert.ok(css.includes(selector), selector);
});

test('with the slot, the block is checked as the settings open, and again when the Suwayomi tab is clicked (not within a minute)', async () => {
  const e = env(async () => answer());
  const slot = rig.fakeCard();
  const listeners = [];
  e.ctx.document.getElementById = (id) => (id === 'suwayomiUpdatesSlot' ? slot : null);
  e.ctx.document.querySelector = (selector) => (selector === '.settings-nav-item[data-tab="tab-suwayomi"]' ? { addEventListener: (type, fn) => { if (type === 'click') listeners.push(fn); } } : null);
  const mounted = e.ctx.mountSourceUpdates(rig.fakeCard(), { runEngineUpdate() {} }, e.ctx.api);
  assert.ok(mounted && mounted.controller);
  await rig.settle();
  assert.equal(e.calls.length, 1, 'asked once as the settings opened');
  assert.equal(e.calls[0].route, '/api/sources/engine/updates');
  assert.equal(listeners.length, 1);
  listeners[0]();
  await rig.settle();
  assert.equal(e.calls.length, 1, 'the tab opened a moment later does not ask again');
});

test('a page without the slot gets no block', () => {
  const e = env();
  assert.equal(e.ctx.mountSourceUpdates(rig.fakeCard(), { runEngineUpdate() {} }, e.ctx.api), null);
});

test('both languages carry every string the block uses, and none is empty', () => {
  const wanted = (strings) => Object.keys(strings).filter((k) => k.startsWith('settings.sourceUpdates.')).sort();
  assert.deepEqual(wanted(rig.PT), wanted(rig.EN));
  for (const strings of [rig.EN, rig.PT]) for (const key of wanted(strings)) assert.ok(String(strings[key]).trim().length > 0, key);
  const source = fs.readFileSync(FILE, 'utf8');
  const used = new Set([...source.matchAll(/'(settings\.sourceUpdates\.[A-Za-z.]+)'/g)].map((m) => m[1]));
  for (const key of used) assert.ok(rig.EN[key] && rig.PT[key], `a language is missing ${key}`);
  assert.ok(rig.EN['settings.sourceUpdates.found'].includes('{count}') && rig.PT['settings.sourceUpdates.found'].includes('{count}'));
  assert.ok(rig.EN['settings.sourceUpdates.confirm'].includes('YOUR Suwayomi-Server'), 'the confirmation says where the program is installed');
});

test('the block never builds markup from server text without escaping it, and never touches storage or the address bar', () => {
  const source = fs.readFileSync(FILE, 'utf8');
  assert.ok(!/localStorage|sessionStorage|location\./.test(source));
  for (const [, expression] of source.matchAll(/\$\{\s*([^}]+?)\s*\}/g)) {
    assert.ok(!/^(update\.(name|version|changelog|changelogUrl|id)|u\.\w+|result\.\w+)$/.test(expression), `unescaped: ${expression}`);
  }
});
