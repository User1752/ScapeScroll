'use strict';

// The block of the Suwayomi tab that sets up, runs and removes the Suwayomi-Server of this computer (public/modules/ui-settings-suwayomi-local.js), run in the
// same vm sandbox as the card's other tests (tests/helpers/source-import-rig.js). What matters: every value of an answer is only ever shown as text, nothing is
// downloaded before the second press (which names what will happen), a set-up that is running shows its progress and is followed until it ends, removing asks
// again, a server that this computer cannot run is told so without buttons, and the catalog's "Add via Suwayomi" with no server offers the set-up first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rig = require('../helpers/source-import-rig');

const SCRIPTS = [...rig.SCRIPTS, 'ui-settings-source-link.js', 'ui-settings-source-catalog-html.js', 'ui-settings-source-catalog.js', 'ui-settings-suwayomi-local.js'];
const env = (apiImpl) => rig.makeEnv({ apiImpl, scripts: SCRIPTS });
const MB = 1048576;

const status = (over = {}) => ({ ok: true, supported: true, reason: '', version: 'v2.4.2366', sizeBytes: 328 * MB, installed: false, running: false, phase: 'idle', message: '', received: 0, total: 0, firewall: null, autoStart: true, ...over });
const html = (ctx, state, ui) => rig.markup(ctx.buildSuwayomiLocalHtml(ctx.suwayomiLocalNormalize(state), ui));
const actions = ($) => $('[data-local-action]').map((_, el) => el.attribs['data-local-action']).get();

// ── answers become plain values ───────────────────────────────────────────

test('an answer is cut to plain values: an unknown phase is idle, text is capped, numbers are numbers, and anything else is off', () => {
  const { ctx } = env();
  const out = rig.plain(ctx.suwayomiLocalNormalize(status({ phase: '<img src=x>', message: 'm'.repeat(900), reason: 'r'.repeat(900), received: -5, total: 'x', version: 'v'.repeat(80), firewall: 'yes', installed: 'yes', running: 1 })));
  assert.deepEqual(out, { supported: true, reason: 'r'.repeat(200), installed: false, running: false, phase: 'idle', message: 'm'.repeat(300), received: 0, total: 0, version: 'v'.repeat(30), sizeBytes: 328 * MB, firewall: null, autoStart: true });
  assert.deepEqual(rig.plain(ctx.suwayomiLocalNormalize(null)).supported, false, 'no answer is not a green light');
  assert.equal(ctx.suwayomiLocalNormalize(status({ firewall: false })).firewall, false);
  assert.equal(ctx.suwayomiLocalNormalize(status({ autoStart: false })).autoStart, false);
});

test('a hostile message or reason is only ever text in the markup', () => {
  const { ctx } = env();
  for (const evil of rig.HOSTILE) {
    for (const state of [status({ phase: 'error', message: evil }), status({ supported: false, reason: evil }), status({ phase: 'downloading', message: evil, total: 5 }), status({ installed: true, phase: 'error', message: evil })]) {
      const $ = html(ctx, state, { note: evil });
      assert.equal($('img, script, svg').length, 0, evil);
      assert.equal($('[onerror], [onfocus], [onload]').length, 0, evil);
    }
  }
});

// ── what each state shows ─────────────────────────────────────────────────

test('where this computer cannot run it, it says so and offers no button, and points to Docker', () => {
  const { ctx } = env();
  const $ = html(ctx, status({ supported: false, reason: 'Setting up a server from here is only available on Windows.' }));
  assert.equal($('button').length, 0);
  assert.match($('p').text(), /only available on Windows/);
  assert.match($('p').text(), /Docker/);
  assert.match(ctx.buildSuwayomiLocalHtml(null), /Looking…/);
});

test('not set up: one button, and the second press says what will be downloaded, from where, checked how, and where it goes', () => {
  const { ctx } = env();
  assert.deepEqual(actions(html(ctx, status())), ['install-ask']);
  const confirm = html(ctx, status(), { confirming: 'install' });
  assert.deepEqual(actions(confirm), ['install', 'cancel']);
  const text = confirm('.suwayomi-local-confirm').text();
  for (const part of [/v2\.4\.2366/, /328 MB/, /GitHub/, /SHA-256/, /Suwayomi folder inside your ScrollScape folder/, /this computer only/, /third parties/]) assert.match(text, part);
  assert.match(confirm('[data-local-action="install"]').text(), /Download 328 MB and set up/);
  const failed = html(ctx, status({ phase: 'error', message: 'There is not enough free space here.' }));
  assert.match(failed('.suwayomi-local-error').text(), /✗ There is not enough free space/);
  assert.deepEqual(actions(failed), ['install-ask'], 'and it can be tried again');
});

test('while it is being set up the block shows the progress and no button; counted steps have a bar with a value, the others a bar that moves', () => {
  const { ctx } = env();
  const downloading = html(ctx, status({ phase: 'downloading', message: 'Downloading Suwayomi...', received: 82 * MB, total: 328 * MB }));
  assert.equal(downloading('button').length, 0);
  assert.equal(downloading('progress').attr('max'), String(328 * MB));
  assert.equal(downloading('progress').attr('value'), String(82 * MB));
  assert.match(downloading('.suwayomi-local-progress').text(), /82 MB of 328 MB/);
  const unpacking = html(ctx, status({ phase: 'unpacking', message: 'Unpacking...', received: 400, total: 1200 }));
  assert.equal(unpacking('progress').attr('value'), '400');
  const starting = html(ctx, status({ phase: 'starting', message: 'Starting Suwayomi (the first start takes a minute or two)...' }));
  assert.equal(starting('progress').attr('value'), undefined, 'a bar with no value moves by itself');
  const over = html(ctx, status({ phase: 'downloading', received: 999 * MB, total: 328 * MB }));
  assert.equal(over('progress').attr('value'), String(328 * MB), 'never past the end');
  assert.equal(starting('[role="status"]').length, 1);
});

test('set up: where it stands, Stop or Start, start with the app, the firewall, and a removal that asks again', () => {
  const { ctx } = env();
  const up = html(ctx, status({ installed: true, running: true, firewall: false }));
  assert.match(up('.suwayomi-local-state').text(), /Running on this computer/);
  assert.deepEqual(actions(up), ['stop', 'firewall-add', 'remove-ask']);
  assert.equal(up('[data-local-autostart]').attr('checked') !== undefined, true);
  const down = html(ctx, status({ installed: true, running: false, firewall: true, autoStart: false }));
  assert.match(down('.suwayomi-local-state').text(), /Stopped/);
  assert.deepEqual(actions(down), ['start', 'firewall-remove', 'remove-ask']);
  assert.equal(down('[data-local-autostart]').attr('checked'), undefined);
  assert.match(down('.suwayomi-local-row').text(), /keeps it from your home network/);
  assert.deepEqual(actions(html(ctx, status({ installed: true, firewall: null }))), ['start', 'remove-ask'], 'no firewall line where it cannot be asked');
  const removing = html(ctx, status({ installed: true }), { confirming: 'remove' });
  assert.deepEqual(actions(removing), ['start', 'remove', 'cancel']);
  assert.match(removing.text(), /Your ScrollScape library is not touched/);
  const busy = html(ctx, status({ installed: true }), { working: 'start' });
  assert.equal(busy('button[data-local-action="start"]').attr('disabled') !== undefined, true, 'held while it works');
  assert.match(busy('[data-local-action="start"]').text(), /Starting/);
  assert.match(html(ctx, status({ installed: true }), { note: '✗ nope' })('.suwayomi-local-error').text(), /✗ nope/);
  assert.match(html(ctx, status({ installed: true, phase: 'error', message: 'It did not answer in time.' }))('.suwayomi-local-error').text(), /did not answer in time/, 'a start that failed says so');
});

// ── the behaviour ─────────────────────────────────────────────────────────

function fakeRoot() {
  const root = rig.fakeCard();
  root.isConnected = true;
  const click = (action) => root.fire('click', { target: { closest: (selector) => (selector === '[data-local-action]' ? { getAttribute: () => action } : null) } });
  const change = (checked) => root.fire('change', { target: { hasAttribute: (name) => name === 'data-local-autostart', checked } });
  return { root, click, change };
}

/** A server that answers from a script: `states` is what the status shows next (the last one stays), `answers` what each POST gives. */
function mount(e, { states, answers = {} }) {
  const calls = [];
  const queue = [...states];
  const timers = [];
  const fetchImpl = async (route, init) => {
    calls.push({ route, body: init && init.body ? JSON.parse(init.body) : undefined, method: init && init.method });
    if (route === '/api/suwayomi/local/status') {
      const current = queue.length > 1 ? queue.shift() : queue[0];
      return { ok: current.ok !== false, status: current.ok === false ? 403 : 200, json: async () => current };
    }
    const answer = answers[route] || { status: 200, body: { ok: true } };
    return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
  };
  const { root, click, change } = fakeRoot();
  const connected = [];
  const control = e.ctx.mountSuwayomiLocal(root, { fetchImpl, setTimer: (fn) => { timers.push(fn); }, onConnected: () => connected.push(1) });
  const tick = async () => { const fn = timers.shift(); if (fn) await fn(); };
  return { root, click, change, calls, connected, control, timers, tick, posts: () => calls.filter((c) => c.method === 'POST') };
}

test('nothing is sent before the second press; then the yes is sent, the progress is followed until it ends, and the boxes are told only once it is up', async () => {
  const e = env();
  const m = mount(e, { states: [status(), status({ phase: 'downloading', message: 'Downloading Suwayomi...', received: 10, total: 100 }), status({ phase: 'starting', message: 'Starting...' }), status({ installed: true, running: true, phase: 'done' })] });
  await rig.settle();
  assert.match(m.root.innerHTML, /Set up Suwayomi on this computer/);
  await m.click('install-ask');
  assert.match(m.root.innerHTML, /Download 328 MB and set up/);
  assert.deepEqual(m.posts(), [], 'the first press only asks');
  await m.click('cancel');
  assert.match(m.root.innerHTML, /Set up Suwayomi on this computer/);
  await m.click('install-ask');
  await m.click('install');
  assert.deepEqual(m.posts().map((c) => [c.route, c.body]), [['/api/suwayomi/local/install', { acknowledge: true }]]);
  assert.match(m.root.innerHTML, /Downloading Suwayomi/);
  assert.equal(m.timers.length, 1, 'it asks again in a moment');
  await m.tick();
  assert.match(m.root.innerHTML, /Starting/);
  assert.deepEqual(m.connected, [], 'not yet');
  await m.tick();
  assert.match(m.root.innerHTML, /Running on this computer/);
  assert.deepEqual(m.connected, [1], 'the address and login are shown once it is up');
  assert.equal(m.timers.length, 0, 'it stops asking when the set-up ended');
});

test('a refusal of the server is shown as a sentence, and a block that left the page stops asking', async () => {
  const e = env();
  const m = mount(e, { states: [status()], answers: { '/api/suwayomi/local/install': { status: 409, body: { ok: false, error: 'The setup is already running.' } } } });
  await rig.settle();
  await m.click('install-ask');
  await m.click('install');
  assert.match(m.root.innerHTML, /✗ The setup is already running\./);
  const away = mount(e, { states: [status({ phase: 'downloading', total: 5 })] });
  await rig.settle();
  assert.equal(away.timers.length, 1);
  away.root.isConnected = false;
  await away.tick();
  assert.equal(away.timers.length, 0, 'a block that left the page does not ask again');
  const remote = mount(e, { states: [{ ok: false, error: 'This can only be done from the computer that runs ScrollScape.' }] });
  await rig.settle();
  assert.match(remote.root.innerHTML, /only be done from the computer that runs ScrollScape/);
  assert.equal(rig.markup(remote.root.innerHTML)('button').length, 0);
});

test('start, stop, the firewall and start-with-the-app each send their own request; a refused firewall prompt says so; removing asks again and sends the confirmation', async () => {
  const e = env();
  const m = mount(e, {
    states: [status({ installed: true, running: false, firewall: false })],
    answers: { '/api/suwayomi/local/firewall': { status: 200, body: { ok: true, applied: false } } },
  });
  await rig.settle();
  await m.click('start');
  await m.click('stop');
  await m.change(false);
  assert.deepEqual(m.posts().map((c) => [c.route, c.body]), [['/api/suwayomi/local/start', {}], ['/api/suwayomi/local/stop', {}], ['/api/suwayomi/local/autostart', { enabled: false }]]);
  assert.deepEqual(m.connected, [1], 'a start shows the saved login');
  await m.click('firewall-add');
  assert.equal(m.posts().at(-1).route, '/api/suwayomi/local/firewall');
  assert.deepEqual(m.posts().at(-1).body, { action: 'add' });
  assert.match(m.root.innerHTML, /✗ The rules were not added/);
  const before = m.posts().length;
  await m.click('remove-ask');
  assert.equal(m.posts().length, before, 'asking sends nothing');
  assert.match(m.root.innerHTML, /deletes its/);
  await m.click('remove');
  assert.deepEqual(m.posts().at(-1), { route: '/api/suwayomi/local/uninstall', body: { confirm: true }, method: 'POST' });
  const ok = mount(e, { states: [status({ installed: true, firewall: true })], answers: { '/api/suwayomi/local/firewall': { status: 200, body: { ok: true, applied: true } } } });
  await rig.settle();
  await ok.click('firewall-remove');
  assert.deepEqual(ok.posts().at(-1).body, { action: 'remove' });
  assert.match(ok.root.innerHTML, /✓ The rules were removed/);
});

test('a click on something that is not one of the block\'s buttons does nothing', async () => {
  const e = env();
  const m = mount(e, { states: [status()] });
  await rig.settle();
  await m.click('delete-everything');
  await m.root.fire('click', { target: { closest: () => null } });
  await m.root.fire('change', { target: { hasAttribute: () => false } });
  assert.deepEqual(m.posts(), []);
});

// ── the catalog ───────────────────────────────────────────────────────────

test('with no server set up, the offer is only made where this computer can set one up, and it opens the question of the set-up', async () => {
  const e = env();
  assert.equal(e.ctx.suwayomiLocalOffer(), false, 'no block on the page');
  const m = mount(e, { states: [status()] });
  await rig.settle();
  assert.equal(e.ctx.suwayomiLocalOffer(), true);
  assert.match(m.root.innerHTML, /Download 328 MB and set up/);
  assert.match(String((e.toasts.at(-1) || [])[0]), /No Suwayomi-Server is set up yet/);
  const set = env();
  mount(set, { states: [status({ installed: true })] });
  await rig.settle();
  assert.equal(set.ctx.suwayomiLocalOffer(), false, 'there is a server');
  const other = env();
  mount(other, { states: [status({ supported: false, reason: 'Only Windows.' })] });
  await rig.settle();
  assert.equal(other.ctx.suwayomiLocalOffer(), false, 'this computer cannot set one up');
});

test('adding through the engine with no server asks about the set-up instead of the extension, and does not install anything', async () => {
  const sent = [];
  const link = { runEngine: async (key) => { sent.push(key); return true; }, lastResult: () => ({ generated: true, message: '' }) };
  const KEY = 'eu.kanade.tachiyomi.extension.en.alpha#0';
  const log = [];
  const view = { read: () => ({ lang: 'en', q: '', nativeOnly: true, hideCloudflare: false }), loading() {}, loaded() {}, error() {}, showList() {}, adding: (...a) => log.push(['adding', ...a]), outcome() {} };
  const e = env(async () => ({ ok: true, rows: [], total: 0, offset: 0, limit: 60, lang: 'en', languages: [], counts: {}, pending: { themes: 0, dns: 0, paused: false }, stale: false, extensionEngine: { available: true, enabled: false } }));
  const asked = [];
  const offered = [];
  const controller = e.ctx.createSourceCatalogController({ api: e.ctx.api, view, linkController: link, timer: { set() {}, clear() {} }, confirmEngine: () => { asked.push(1); return true; }, offerSetup: () => { offered.push(1); return true; } });
  const unknown = await controller.addEngine(KEY);
  assert.equal(unknown, true, 'before the catalog said whether there is a server, the usual question is asked');
  assert.deepEqual(sent, [KEY]);
  await controller.open();
  sent.length = 0;
  asked.length = 0;
  assert.equal(await controller.addEngine(KEY), false);
  assert.deepEqual([offered.length, asked.length, sent.length], [1, 0, 0], 'the set-up is offered; no confirmation of an extension, nothing installed');
});

// ── the page ──────────────────────────────────────────────────────────────

test('the page loads the block before the settings modal that mounts it, the card has its slot and keeps the script as a fallback', () => {
  const page = fs.readFileSync(path.join(rig.PUBLIC_DIR, 'index.html'), 'utf8');
  const at = (name) => page.indexOf(`/modules/${name}`);
  assert.ok(at('ui-settings-suwayomi-local.js') > at('ui-settings-source-catalog.js'));
  assert.ok(at('ui-settings-suwayomi-local.js') > 0 && at('ui-settings-suwayomi-local.js') < at('ui-settings-modal.js'));
  const card = fs.readFileSync(path.join(rig.MODULES_DIR, 'ui-settings-cards-sources.js'), 'utf8');
  assert.match(card, /id="suwayomiLocalSlot"/);
  assert.match(card, /windows-setup\.cmd/, 'the script stays as a way to set it up');
  assert.match(card, /id="suwayomiConnectLocalBtn"/);
  const modal = fs.readFileSync(path.join(rig.MODULES_DIR, 'ui-settings-modal.js'), 'utf8');
  assert.match(modal, /mountSuwayomiLocal\(suwayomiLocalSlot/);
});

test('the block puts nothing of an answer into an attribute or a script, and has no inline handlers', () => {
  const source = fs.readFileSync(path.join(rig.MODULES_DIR, 'ui-settings-suwayomi-local.js'), 'utf8');
  assert.ok(!/\bon(click|change|error|load)\s*=/.test(source), 'no inline event handlers');
  assert.ok(!/eval\(|new Function|document\.write/.test(source));
  const lineCount = source.split('\n').length;
  assert.ok(lineCount <= 450, `${lineCount} lines`);
});
