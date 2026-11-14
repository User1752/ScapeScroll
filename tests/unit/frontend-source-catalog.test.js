'use strict';

// The "Source catalog" block of the Import card (public/modules/ui-settings-source-catalog.js), run in the same vm sandbox as the card's
// other tests (tests/helpers/source-import-rig.js). The block asks the server for a list and hands a chosen site to the "add from a link"
// block; what matters here is that every value of an answer is only ever shown as text, that nothing is asked of the network before the
// block is opened, that a stale answer never replaces a newer one, that the block asks again only while the server is still working, and
// that both languages carry every string.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rig = require('../helpers/source-import-rig');

const SCRIPTS = [...rig.SCRIPTS, 'ui-settings-source-link.js', 'ui-settings-source-catalog-html.js', 'ui-settings-source-catalog.js'];
const FILE = path.join(rig.MODULES_DIR, 'ui-settings-source-catalog.js');
// The markup lives in a file of its own; what is checked about the block's source covers both.
const SOURCE = () => ['ui-settings-source-catalog-html.js', 'ui-settings-source-catalog.js'].map((name) => fs.readFileSync(path.join(rig.MODULES_DIR, name), 'utf8')).join(' ');
const KEY = 'eu.kanade.tachiyomi.extension.en.alpha#0';
const env = (apiImpl) => rig.makeEnv({ apiImpl, scripts: SCRIPTS });

const row = (over = {}) => ({ key: KEY, name: 'Alpha Scans', host: 'alpha.example', lang: 'en', warning: 'SAFE', engine: 'ready', cloudflare: 'no', installed: false, blocked: false, ...over });
const page = (over = {}) => ({ ok: true, rows: [row()], total: 1, offset: 0, limit: 60, lang: 'en', languages: [{ lang: 'en', count: 3 }, { lang: 'pt', count: 1 }], counts: {}, pending: { themes: 0, dns: 0, paused: false }, stale: false, ...over });

// ── answers become plain values ───────────────────────────────────────────

test('an answer is cut to plain values: a key that is not a key drops the row, an unknown word becomes a safe one, nothing is trusted', () => {
  const { ctx } = env();
  const out = rig.plain(ctx.sourceCatalogNormalize({
    rows: [row(), row({ key: '"><img src=x onerror=PWN(1)>' }), row({ key: '../x#0' }), row({ key: `${KEY}0000` }), null, 'text', row({ name: 'N'.repeat(500), host: 'h'.repeat(500), warning: 'SAFE-ISH', engine: 'bogus', cloudflare: '<b>' })],
    total: '12', offset: -4, lang: '<script>', languages: [{ lang: 'en', count: 2 }, { lang: '<x>', count: 1 }, null], pending: { themes: '3', dns: 'x', paused: 'yes' }, stale: 1,
  }));
  assert.equal(out.rows.length, 2);
  assert.deepEqual(out.rows[1], { key: KEY, name: 'N'.repeat(80), host: 'h'.repeat(120), icon: '', lang: 'en', warning: 'MIXED', engine: 'unknown', via: '', cloudflare: 'n/a', installed: false, installedId: '', blocked: false, repo: '' });
  assert.equal(out.total, 12);
  assert.equal(out.offset, 0);
  assert.equal(out.lang, '');
  assert.deepEqual(out.languages, [{ lang: 'en', count: 2 }]);
  assert.deepEqual(out.pending, { themes: 3, dns: 0, paused: false });
  assert.equal(out.stale, false);
  assert.deepEqual(rig.plain(ctx.sourceCatalogNormalize(null)).rows, []);
});

test('the block of the Advanced tab is a plain block with its title, not a <details> that closes; the one of the import card still closes', () => {
  const { ctx } = env();
  const open = rig.markup(ctx.buildSourceCatalogHtml('advancedCatalog', false));
  assert.equal(open('details, summary').length, 0);
  assert.equal(open('#advancedCatalogBlock').length, 1);
  assert.equal(open('.source-import-subtitle').length, 1);
  assert.equal(open('#advancedCatalogList').length, 1, 'the same filters and list');
  const closes = rig.markup(ctx.buildSourceCatalogHtml());
  assert.equal(closes('details#sourceCatalogBlock > summary').length, 1);
});

test('a hostile name or host is only ever text in the markup', () => {
  const { ctx } = env();
  for (const evil of rig.HOSTILE) {
    const html = ctx.buildSourceCatalogRowsHtml(ctx.sourceCatalogNormalize({ rows: [row({ name: evil, host: evil })] }).rows);
    const $ = rig.markup(html);
    assert.equal($('img, script, svg').length, 0, evil);
    assert.equal($('[onerror], [onfocus], [onload]').length, 0, evil);
    assert.equal($('li').length, 1);
  }
  const lang = rig.markup(`<select>${ctx.buildSourceCatalogLanguageOptionsHtml([{ lang: 'en', count: 1 }], rig.HOSTILE[0])}</select>`);
  assert.equal(lang('img').length, 0);
});

test('a row: Add is on only for a site a source can be written for that is not added and not blocked, and the badges say what each is', () => {
  const { ctx } = env();
  const html = (over) => rig.markup(ctx.buildSourceCatalogRowHtml(ctx.sourceCatalogNormalize({ rows: [row(over)] }).rows[0]));
  const ready = html({});
  assert.equal(ready('button[data-catalog-add]').attr('data-catalog-add'), KEY);
  assert.equal(ready('button[data-catalog-add]').attr('disabled'), undefined);
  assert.equal(ready('.source-catalog-badge').length, 0, 'a plain site carries no badge');
  for (const over of [{ engine: 'later' }, { engine: 'handwritten' }, { engine: 'unknown' }, { engine: 'checking' }, { installed: true }, { blocked: true }]) {
    assert.notEqual(html(over)('button[data-catalog-add]').attr('disabled'), undefined, JSON.stringify(over));
  }
  assert.match(html({ warning: 'NSFW' })('.source-catalog-badge.is-adult').text(), /18\+/);
  assert.equal(html({ warning: 'MIXED' })('.source-catalog-badge.is-mixed').length, 1);
  assert.equal(html({ cloudflare: 'yes' })('.source-catalog-badge.is-cloudflare').length, 1);
  assert.equal(html({ cloudflare: 'checking' })('.source-catalog-badge').length, 0, 'a lookup still going is not announced as a fact');
  assert.equal(html({ installed: true })('.source-catalog-badge.is-installed').length, 1);
  assert.equal(html({ engine: 'handwritten' })('.source-catalog-badge.is-engine').length, 1);
});

test('the language box keeps the language in use even when the list has none of it, and marks it selected', () => {
  const { ctx } = env();
  const $ = rig.markup(`<select>${ctx.buildSourceCatalogLanguageOptionsHtml([{ lang: 'en', count: 3 }, { lang: 'pt', count: 1 }], 'pt')}</select>`);
  assert.equal($('option[selected]').attr('value'), 'pt');
  const none = rig.markup(`<select>${ctx.buildSourceCatalogLanguageOptionsHtml([{ lang: 'en', count: 3 }], 'fr')}</select>`);
  assert.deepEqual(none('option').map((_, el) => none(el).attr('value')).get(), ['fr', 'en']);
});

test('the sentence under the filters says what the list is doing, or how much it holds', () => {
  const { ctx } = env();
  const n = (over) => ctx.sourceCatalogNormalize(page(over));
  assert.match(ctx.sourceCatalogStatusText(n({ pending: { themes: 40, dns: 0, paused: false } })), /40 extensions/);
  assert.match(ctx.sourceCatalogStatusText(n({ pending: { themes: 40, dns: 0, paused: true } })), /Paused/);
  assert.match(ctx.sourceCatalogStatusText(n({ total: 12 })), /12 sites/);
  assert.match(ctx.sourceCatalogStatusText(n({ rows: [], total: 0 })), /No site matches/);
  assert.match(ctx.sourceCatalogStatusText(n({ stale: true })), /older copy/);
});

// ── the controller ────────────────────────────────────────────────────────

function fakeView(form = { lang: 'en', q: '', nativeOnly: true, hideCloudflare: false }) {
  const log = [];
  const view = {
    form: { ...form },
    log,
    read: () => ({ ...view.form }),
    loading: () => log.push(['loading']),
    loaded: () => log.push(['loaded']),
    error: (text) => log.push(['error', text]),
    showList: (p, opts) => log.push(['showList', rig.plain(p), rig.plain(opts)]),
    adding: (key, on) => log.push(['adding', key, on]),
    outcome: (ok, message) => log.push(['outcome', ok, message]),
    all: (name) => log.filter((entry) => entry[0] === name),
  };
  return view;
}

function fakeTimer() {
  const timers = [];
  const cleared = [];
  return { timers, cleared, set: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clear: (id) => { cleared.push(id); } };
}

function setup(apiImpl, { form, getWarnings, linkController } = {}) {
  const e = env(apiImpl);
  const view = fakeView(form);
  const timer = fakeTimer();
  const controller = e.ctx.createSourceCatalogController({ api: e.ctx.api, view, linkController, getWarnings, timer });
  return { e, view, timer, controller, calls: e.calls };
}

test('nothing is asked until the block is opened, and opening it twice asks once', async () => {
  const { controller, calls, view } = setup(async () => page());
  assert.equal(calls.length, 0);
  assert.equal(await controller.open(), true);
  assert.equal(await controller.open(), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, '/api/sources/catalog/list');
  assert.deepEqual(calls[0].body, { lang: 'en', q: '', nativeOnly: true, hideCloudflare: false, hideAdult: false, hideInstalled: false, onlyInstalled: false, offset: 0, limit: 60 });
  assert.deepEqual(view.log.map((entry) => entry[0]), ['loading', 'error', 'showList']);
  const shown = view.all('showList')[0];
  assert.equal(shown[1].rows.length, 1);
  assert.deepEqual(shown[2], { append: false, hasMore: false });
});

test('the filters are sent as they are in the block, cut and checked; Hide NSFW narrows the content the list may hold', async () => {
  const { controller, calls } = setup(async () => page(), { form: { lang: 'pt-BR', q: 'x'.repeat(200), nativeOnly: false, hideCloudflare: true }, getWarnings: () => ['SAFE'] });
  await controller.open();
  assert.deepEqual(calls[0].body, { lang: 'pt-BR', q: 'x'.repeat(80), nativeOnly: false, hideCloudflare: true, hideAdult: false, hideInstalled: false, onlyInstalled: false, offset: 0, limit: 60, warnings: ['SAFE'] });
  const bad = setup(async () => page(), { form: { lang: '<script>', q: null, nativeOnly: undefined, hideCloudflare: 'yes' }, getWarnings: () => null });
  await bad.controller.open();
  assert.deepEqual(bad.calls[0].body, { lang: 'en', q: '', nativeOnly: true, hideCloudflare: false, hideAdult: false, hideInstalled: false, onlyInstalled: false, offset: 0, limit: 60 });
});

test('a changed filter starts the list again from the top, but only once the block has been opened', async () => {
  const { controller, calls } = setup(async () => page());
  assert.equal(await controller.reload(), false);
  assert.equal(calls.length, 0, 'a filter changed in a closed block asks nothing');
  await controller.open();
  assert.equal(await controller.reload(), true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.offset, 0);
});

test('while the server is still working the list is asked for again, quietly, and it stops by itself', async () => {
  const answers = [page({ pending: { themes: 30, dns: 0, paused: false } }), page({ pending: { themes: 0, dns: 4, paused: false } }), page()];
  const { controller, calls, view, timer } = setup(async () => answers.shift());
  await controller.open();
  assert.equal(timer.timers.length, 1);
  assert.equal(timer.timers[0].ms, 4000);
  timer.timers[0].fn();
  await rig.settle();
  assert.equal(calls.length, 2);
  assert.equal(view.all('loading').length, 1, 'a refresh does not blank the list');
  assert.ok(calls[1].body.limit >= 60 && calls[1].body.offset === 0);
  assert.equal(timer.timers.length, 2, 'dns still going: asked again');
  timer.timers[1].fn();
  await rig.settle();
  assert.equal(calls.length, 3);
  assert.equal(timer.timers.length, 2, 'nothing pending: no timer is set');
  assert.equal(controller.state().waiting, false);
});

test('a paused server is not asked again every few seconds, and asking is bounded even if the server never settles', async () => {
  const paused = setup(async () => page({ pending: { themes: 30, dns: 0, paused: true } }));
  await paused.controller.open();
  assert.equal(paused.timer.timers.length, 0);
  const endless = setup(async () => page({ pending: { themes: 30, dns: 0, paused: false } }));
  await endless.controller.open();
  for (let i = 0; i < 100 && endless.timer.timers.length > i; i += 1) { endless.timer.timers[i].fn(); await rig.settle(); }
  assert.equal(endless.calls.length, 46, 'the first read and 45 more, then it gives up');
});

test('"Show more" asks for the page after the rows already shown and adds to them', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => row({ key: `eu.kanade.tachiyomi.extension.en.e${i}#0`, name: `E${i}` }));
  const answers = [page({ rows, total: 61 }), page({ rows: [row({ key: 'eu.kanade.tachiyomi.extension.en.last#0', name: 'Last' })], total: 61, offset: 60 })];
  const { controller, calls, view } = setup(async () => answers.shift());
  await controller.open();
  assert.equal(view.all('showList')[0][2].hasMore, true);
  assert.equal(await controller.more(), true);
  assert.equal(calls[1].body.offset, 60);
  const second = view.all('showList')[1];
  assert.deepEqual(second[2], { append: true, hasMore: false });
  assert.equal(controller.state().shown, 61);
});

test('an answer that arrives after a newer request, or after the block closed, is ignored', async () => {
  const first = rig.deferred();
  const second = rig.deferred();
  const queue = [first, second];
  const { controller, view } = setup(() => queue.shift().promise);
  const a = controller.open();
  const b = controller.reload();
  second.resolve(page({ rows: [row({ name: 'Newer' })] }));
  assert.equal(await b, true);
  first.resolve(page({ rows: [row({ name: 'Older' })] }));
  assert.equal(await a, false);
  assert.deepEqual(view.all('showList').map((entry) => entry[1].rows[0].name), ['Newer']);
  const late = rig.deferred();
  const closing = setup(() => late.promise);
  const pending = closing.controller.open();
  closing.controller.stop();
  late.resolve(page());
  assert.equal(await pending, false);
  assert.equal(closing.view.all('showList').length, 0);
});

test('closing the block cancels the next asking', async () => {
  const { controller, timer } = setup(async () => page({ pending: { themes: 5, dns: 0, paused: false } }));
  await controller.open();
  assert.equal(controller.state().waiting, true);
  controller.stop();
  assert.deepEqual(timer.cleared, [1]);
  assert.equal(controller.state().waiting, false);
});

test('closed and opened again, the block reads the list once more, quietly; opened twice without closing it asks once', async () => {
  const answers = [page({ pending: { themes: 5, dns: 0, paused: false } }), page({ total: 9 })];
  const { controller, calls, view } = setup(async () => answers.shift());
  await controller.open();
  controller.stop();
  assert.equal(await controller.open(), true);
  assert.equal(calls.length, 2);
  assert.equal(view.all('loading').length, 1, 'the list is not blanked for the second read');
  assert.equal(await controller.open(), false, 'a second open without a close in between does nothing');
  assert.equal(calls.length, 2);
  const early = setup(async () => page());
  early.controller.stop();
  assert.equal(await early.controller.open(), true, 'closing a block that was never loaded changes nothing');
  assert.equal(early.calls.length, 1);
});

test('every Add button names the site it adds, for a screen reader', () => {
  const { ctx } = env();
  const $ = rig.markup(ctx.buildSourceCatalogRowHtml(ctx.sourceCatalogNormalize({ rows: [row({ name: 'Alpha Scans' })] }).rows[0]));
  assert.equal($('button[data-catalog-add]').attr('aria-label'), 'Add Alpha Scans');
});

test('a failed request shows the sentence of the error, and the block can be opened again to retry', async () => {
  let fail = true;
  const { controller, view, calls } = setup(async () => { if (fail) throw rig.httpError(502, { ok: false, error: 'The list of extensions could not be read (offline). Check the connection and try again.' }); return page(); });
  assert.equal(await controller.open(), false);
  assert.match(view.all('error').at(-1)[1], /could not be read/);
  assert.equal(view.all('loaded').length, 1);
  fail = false;
  assert.equal(await controller.open(), true, 'a block that failed to load asks again when it is opened again');
  assert.equal(calls.length, 2);
  const local = setup(async () => { throw rig.httpError(403, { ok: false, code: 'LOCAL_ONLY', error: 'raw' }); });
  await local.controller.open();
  assert.match(local.view.all('error').at(-1)[1], /only available on the computer running ScrollScape/);
  const madeUp = setup(async () => { throw new TypeError('fetch failed'); });
  await madeUp.controller.open();
  assert.match(madeUp.view.all('error').at(-1)[1], /request failed/);
});

test('choosing a site hands its key, and only its key, to the "add from a link" block, and says what came of it', async () => {
  const sent = [];
  const gate = rig.deferred();
  const linkController = { runCatalog: async (key) => { sent.push(key); await gate.promise; return false; }, lastResult: () => ({ generated: false, message: 'The site cannot be added from a link.' }) };
  const { controller, view } = setup(async () => page(), { linkController });
  const first = controller.add(KEY);
  assert.equal(await controller.add(KEY), false, 'one site at a time');
  gate.resolve();
  assert.equal(await first, false);
  assert.deepEqual(sent, [KEY]);
  assert.deepEqual(view.all('adding'), [['adding', KEY, true], ['adding', KEY, false]]);
  assert.deepEqual(view.all('outcome'), [['outcome', false, 'The site cannot be added from a link.']]);
  for (const key of ['', 'https://evil.example', '../x#0', KEY + 'x', undefined, null, 5]) assert.equal(await controller.add(key), false, String(key));
  assert.deepEqual(sent, [KEY]);
  const none = setup(async () => page());
  assert.equal(await none.controller.add(KEY), false, 'without the link block there is nothing to write with');
});

test('a written source is reported as written', async () => {
  const linkController = { runCatalog: async () => true, lastResult: () => ({ generated: true, message: '' }) };
  const { controller, view } = setup(async () => page(), { linkController });
  assert.equal(await controller.add(KEY), true);
  assert.deepEqual(view.all('outcome'), [['outcome', true, '']]);
});

// ── the "add from a link" block writes a catalog row ──────────────────────

test('runCatalog sends only the key, once at a time, and remembers the outcome', async () => {
  const e = env(async () => ({ ok: true, status: 'generated', id: 'alpha', name: 'Alpha', code: 'exports.meta = {};', notes: [], probe: { engine: { name: 'Madara' }, reasons: [] } }));
  const log = [];
  const view = { read: () => ({ url: '' }), busy() {}, error: (t) => log.push(['error', t]), clearResult() {}, showResult() {}, fill: (c, id) => log.push(['fill', id]) };
  const link = e.ctx.createSourceLinkController({ api: e.ctx.api, view, importController: { edit() {}, check: async () => true } });
  assert.equal(await link.runCatalog(KEY), true);
  assert.deepEqual(e.calls[0].body, { catalog: { key: KEY } });
  assert.equal(link.lastResult().generated, true);
  assert.deepEqual(log.find((entry) => entry[0] === 'fill'), ['fill', 'alpha']);
  for (const key of ['', 'https://evil.example', '../x#0', undefined]) assert.equal(await link.runCatalog(key), false, String(key));
  assert.equal(e.calls.length, 1, 'a key that is not a key is not sent');
  const refusing = env(async () => { throw rig.httpError(409, { ok: false, error: 'This site has its own scraper, so a source for it has to be written by hand.' }); });
  const link2 = refusing.ctx.createSourceLinkController({ api: refusing.ctx.api, view, importController: { edit() {}, check: async () => true } });
  assert.equal(await link2.runCatalog(KEY), false);
  assert.match(link2.lastResult().message, /by hand/);
});

// ── mounting ──────────────────────────────────────────────────────────────

function mountCard({ withLink = true, apiImpl = async () => page() } = {}) {
  const e = env(apiImpl);
  const card = rig.fakeCard();
  card.innerHTML = withLink ? '<div id="sourceLinkBlock"></div><div id="sourceImportReport"></div>' : '<div id="other"></div>';
  const anchor = card.querySelector('#sourceLinkBlock');
  const inserted = [];
  if (anchor) anchor.insertAdjacentHTML = (position, html) => { inserted.push([position, html]); const keep = card.innerHTML; card.innerHTML = keep + html; };
  const link = {
    runCatalog: async (key) => { link.sent.push(key); return true; },
    runEngine: async (key) => { link.engineSent.push(key); return true; },
    lastResult: () => ({ generated: true, message: '' }),
    sent: [],
    engineSent: [],
  };
  const mounted = e.ctx.mountSourceCatalogBlock(card, link, e.ctx.api);
  return { e, card, inserted, link, mounted };
}

test('the block is added above "add from a link", asks nothing at mount, and is not added twice or without the link block', async () => {
  const { e, mounted, inserted, card } = mountCard();
  assert.ok(mounted && mounted.block);
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0][0], 'beforebegin');
  assert.equal(e.calls.length, 0, 'mounting asks nothing of the network');
  assert.equal(e.ctx.mountSourceCatalogBlock(card, { runCatalog() {} }, e.ctx.api), null, 'already there');
  assert.equal(mountCard({ withLink: false }).mounted, null);
  assert.equal(e.ctx.mountSourceCatalogBlock(rig.fakeCard(), null, e.ctx.api), null);
});

test('opening the block loads the list; choosing a row writes it; the filters reload', async () => {
  const { e, mounted, card, link } = mountCard();
  const block = card.querySelector('#sourceCatalogBlock');
  block.open = true;
  await block.fire('toggle');
  await rig.settle();
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].route, '/api/sources/catalog/list');
  assert.match(card.querySelector('#sourceCatalogStatus').textContent, /1 sites/);
  assert.ok(mounted.controller);
  const target = { disabled: false, getAttribute: (name) => (name === 'data-catalog-add' ? KEY : null) };
  await block.fire('click', { target: { closest: (selector) => (selector === '[data-catalog-add]' ? target : null) } });
  assert.deepEqual(link.sent, [KEY]);
  card.setAttribute('aria-busy', 'true');
  await block.fire('click', { target: { closest: () => target } });
  assert.deepEqual(link.sent, [KEY], 'while the card is busy a click does nothing');
  card.setAttribute('aria-busy', 'false');
  await card.querySelector('#sourceCatalogNative').fire('change');
  await rig.settle();
  assert.equal(e.calls.length, 2);
});

test('the list shows a language box and a "show more" button only when there is more', async () => {
  const { card } = mountCard({ apiImpl: async () => page({ total: 130 }) });
  const block = card.querySelector('#sourceCatalogBlock');
  block.open = true;
  await block.fire('toggle');
  await rig.settle();
  assert.equal(card.querySelector('#sourceCatalogMore').hidden, false);
  assert.match(card.querySelector('#sourceCatalogLang').innerHTML, /<option value="en" selected>en \(3\)<\/option>/);
  assert.match(card.querySelector('#sourceCatalogList').innerHTML, /data-catalog-add/);
});

// ── the extension engine ──────────────────────────────────────────────────

test('a row says how it can be added; an answer from before that said nothing is read as a site with a template; the engine state is plain true/false', () => {
  const { ctx } = env();
  const n = (rows, extra = {}) => rig.plain(ctx.sourceCatalogNormalize({ rows, ...extra }));
  assert.deepEqual(n([row(), row({ engine: 'handwritten' }), row({ engine: 'handwritten', via: 'engine' }), row({ via: 'bogus' }), row({ engine: 'later', via: '<b>' })]).rows.map((r) => r.via), ['native', '', 'engine', 'native', '']);
  assert.deepEqual(n([], { extensionEngine: { available: true, enabled: true } }).extensionEngine, { available: true, enabled: true });
  assert.deepEqual(n([], { extensionEngine: { available: 'yes', enabled: 1 } }).extensionEngine, { available: false, enabled: false });
  assert.deepEqual(n([]).extensionEngine, { available: false, enabled: false });
});

test('a site that runs in the person\'s Suwayomi-Server has its own button and badge, and the button is off for one already added or blocked', () => {
  const { ctx } = env();
  const html = (over) => rig.markup(ctx.buildSourceCatalogRowHtml(ctx.sourceCatalogNormalize({ rows: [row({ engine: 'handwritten', via: 'engine', ...over })] }).rows[0]));
  const on = html({});
  assert.equal(on('button[data-catalog-engine]').attr('data-catalog-engine'), KEY);
  assert.equal(on('button[data-catalog-add]').length, 0, 'it is not the plain Add');
  assert.equal(on('button[data-catalog-engine]').attr('disabled'), undefined);
  assert.equal(on('.source-catalog-badge.is-via-engine').length, 1);
  assert.equal(on('.source-catalog-badge.is-engine').length, 0, 'it is not called hand-written only when it can be added');
  assert.equal(on('button').attr('aria-label'), 'Add Alpha Scans through your Suwayomi-Server');
  assert.notEqual(html({ installed: true })('button[data-catalog-engine]').attr('disabled'), undefined);
  assert.notEqual(html({ blocked: true })('button[data-catalog-engine]').attr('disabled'), undefined);
});

test('adding through the engine asks the person first, in words that say a third party\'s program is installed in their server, and sends nothing if they say no', async () => {
  const sent = [];
  const link = { runEngine: async (key) => { sent.push(key); return true; }, lastResult: () => ({ generated: true, message: '' }) };
  const asked = [];
  const e = env(async () => page());
  const view = fakeView();
  const refuse = e.ctx.createSourceCatalogController({ api: e.ctx.api, view, linkController: link, confirmEngine: () => { asked.push('no'); return false; } });
  assert.equal(await refuse.addEngine(KEY), false);
  assert.deepEqual(sent, []);
  assert.deepEqual(view.all('adding'), [], 'nothing is marked busy for a refused question');
  const accept = e.ctx.createSourceCatalogController({ api: e.ctx.api, view, linkController: link, confirmEngine: () => true });
  assert.equal(await accept.addEngine(KEY), true);
  assert.deepEqual(sent, [KEY]);
  assert.deepEqual(view.all('adding'), [['adding', KEY, true], ['adding', KEY, false]]);
  for (const key of ['', 'https://evil.example', '../x#0', undefined, 5]) assert.equal(await accept.addEngine(key), false, String(key));
  assert.deepEqual(sent, [KEY]);
  const none = e.ctx.createSourceCatalogController({ api: e.ctx.api, view: fakeView(), linkController: {}, confirmEngine: () => true });
  assert.equal(await none.addEngine(KEY), false, 'a link block without the engine writes nothing');
  assert.match(rig.EN['settings.sourceCatalog.engineConfirm'], /YOUR Suwayomi-Server/);
  assert.match(rig.EN['settings.sourceCatalog.engineConfirm'], /third party/);
  assert.match(rig.PT['settings.sourceCatalog.engineConfirm'], /terceiros/);
});

test('one at a time: a second engine click while the first runs does nothing', async () => {
  const gate = rig.deferred();
  const link = { runEngine: async () => { await gate.promise; return false; }, lastResult: () => ({ generated: false, message: 'Could not install.' }) };
  const e = env(async () => page());
  const view = fakeView();
  const controller = e.ctx.createSourceCatalogController({ api: e.ctx.api, view, linkController: link, confirmEngine: () => true });
  const first = controller.addEngine(KEY);
  assert.equal(await controller.addEngine(KEY), false);
  gate.resolve();
  assert.equal(await first, false);
  assert.deepEqual(view.all('outcome'), [['outcome', false, 'Could not install.']]);
});

test('the "add from a link" block sends the engine only the key and the confirmation, to its own route', async () => {
  const e = env(async () => ({ ok: true, status: 'generated', id: `sw-1`, name: 'Alpha', code: 'exports.meta = {};', notes: [], probe: { engine: { name: 'Suwayomi' }, reasons: [] } }));
  const log = [];
  const view = { read: () => ({ url: '' }), busy() {}, error: (t) => log.push(['error', t]), clearResult() {}, showResult() {}, fill: (c, id) => log.push(['fill', id]) };
  const link = e.ctx.createSourceLinkController({ api: e.ctx.api, view, importController: { edit() {}, check: async () => true } });
  assert.equal(await link.runEngine(KEY), true);
  assert.equal(e.calls[0].route, '/api/sources/engine/prepare');
  assert.deepEqual(e.calls[0].body, { key: KEY, acknowledge: true });
  assert.deepEqual(log.find((entry) => entry[0] === 'fill'), ['fill', 'sw-1']);
  for (const key of ['', 'https://evil.example', '../x#0', undefined]) assert.equal(await link.runEngine(key), false, String(key));
  assert.equal(e.calls.length, 1);
  const refusing = env(async () => { throw rig.httpError(502, { ok: false, error: 'Suwayomi-Server could not install the extension (HTTP 500).' }); });
  const link2 = refusing.ctx.createSourceLinkController({ api: refusing.ctx.api, view, importController: { edit() {}, check: async () => true } });
  assert.equal(await link2.runEngine(KEY), false);
  assert.match(link2.lastResult().message, /could not install/);
});

test('on the card: the engine button asks the native question first, then writes; and the hint says where to set the server up only when it is offered but not set up', async () => {
  const { e, card, link } = mountCard({ apiImpl: async () => page({ rows: [row({ engine: 'handwritten', via: 'engine' })], extensionEngine: { available: true, enabled: false } }) });
  const block = card.querySelector('#sourceCatalogBlock');
  block.open = true;
  await block.fire('toggle');
  await rig.settle();
  assert.equal(card.querySelector('#sourceCatalogEngineHint').hidden, false, 'offered, not set up: the hint is shown');
  const target = { disabled: false, getAttribute: (name) => (name === 'data-catalog-engine' ? KEY : null) };
  const click = () => block.fire('click', { target: { closest: (selector) => (selector === '[data-catalog-engine]' ? target : null) } });
  await click();
  assert.deepEqual(link.engineSent, [KEY]);
  assert.equal(e.confirms.length, 1);
  assert.match(e.confirms[0], /YOUR Suwayomi-Server/);
  assert.deepEqual(link.sent, [], 'it is not the plain Add');
  const set = mountCard({ apiImpl: async () => page({ extensionEngine: { available: true, enabled: true } }) });
  const b2 = set.card.querySelector('#sourceCatalogBlock');
  b2.open = true;
  await b2.fire('toggle');
  await rig.settle();
  assert.equal(set.card.querySelector('#sourceCatalogEngineHint').hidden, true);
  const off = mountCard({ apiImpl: async () => page() });
  const b3 = off.card.querySelector('#sourceCatalogBlock');
  b3.open = true;
  await b3.fire('toggle');
  await rig.settle();
  assert.equal(off.card.querySelector('#sourceCatalogEngineHint').hidden, true, 'an app without the engine says nothing about it');
});

// ── the same block in the Advanced tab ────────────────────────────────────

test('a block with another prefix has ids of its own (an id is unique in the page), its labels point at its own controls, and a bad prefix falls back', () => {
  const { ctx } = env();
  const idsOf = (html) => { const $ = rig.markup(html); return $('[id]').map((_, el) => $(el).attr('id')).get(); };
  const main = idsOf(ctx.buildSourceCatalogHtml());
  const other = idsOf(ctx.buildSourceCatalogHtml('advancedCatalog'));
  assert.equal(main.length, other.length);
  assert.ok(main.every((id) => id.startsWith('sourceCatalog')) && other.every((id) => id.startsWith('advancedCatalog')));
  assert.deepEqual(main.filter((id) => other.includes(id)), [], 'no id in both blocks');
  const $ = rig.markup(ctx.buildSourceCatalogHtml('advancedCatalog'));
  assert.equal($('label[for]').first().attr('for'), 'advancedCatalogLang');
  assert.equal($('#advancedCatalogLang').length, 1);
  for (const bad of ['', 'x', '1abc', 'a b', '"><img>', 'a-b', undefined, null, 5]) assert.deepEqual(idsOf(ctx.buildSourceCatalogHtml(bad)), main, String(bad));
});

function mountWithSlot({ apiImpl = async () => page() } = {}) {
  const e = env(apiImpl);
  const slot = rig.fakeCard();
  const clicks = { tab: 0, report: 0 };
  const tab = { click() { clicks.tab += 1; } };
  // The Advanced tab of the sidebar: what listens to it runs when it is clicked.
  const advancedTab = { listeners: [], addEventListener(type, fn) { if (type === 'click') this.listeners.push(fn); }, async click() { for (const fn of this.listeners) fn(); await rig.settle(); } };
  const report = { scrollIntoView() { clicks.report += 1; } };
  e.ctx.document.getElementById = (id) => (id === 'advancedCatalogSlot' ? slot : (id === 'sourceImportReport' ? report : null));
  e.ctx.document.querySelector = (selector) => (selector === '.settings-nav-item[data-tab="tab-sources"]' ? tab : (selector === '.settings-nav-item[data-tab="tab-advanced"]' ? advancedTab : null));
  const card = rig.fakeCard();
  card.innerHTML = '<div id="sourceLinkBlock"></div><div id="sourceImportReport"></div>';
  const anchor = card.querySelector('#sourceLinkBlock');
  anchor.insertAdjacentHTML = (position, html) => { const keep = card.innerHTML; card.innerHTML = keep + html; };
  const link = {
    runCatalog: async (key) => { link.sent.push(key); return true; },
    runEngine: async (key) => { link.engineSent.push(key); return true; },
    lastResult: () => ({ generated: true, message: '' }),
    sent: [],
    engineSent: [],
  };
  const mounted = e.ctx.mountSourceCatalogBlock(card, link, e.ctx.api);
  return { e, card, slot, link, clicks, mounted, advancedTab };
}

test('the Advanced tab has the block in its slot, always open, with its own ids, and loads nothing until the tab is opened (and then once); the Sources tab does not get a second one', async () => {
  const { e, slot, card, advancedTab } = mountWithSlot();
  assert.ok(slot.querySelector('#advancedCatalogBlock'));
  assert.ok(!card.querySelector('#sourceCatalogBlock'), 'the catalog is in the Advanced tab, not in the import card as well');
  assert.equal(e.calls.length, 0, 'mounting asks nothing of the network');
  await advancedTab.click();
  assert.equal(e.calls.length, 1);
  await advancedTab.click();
  assert.equal(e.calls.length, 1, 'opening the tab again does not ask again');
  assert.equal(e.calls[0].route, '/api/sources/catalog/list');
  assert.match(slot.querySelector('#advancedCatalogStatus').textContent, /1 sites/);
  assert.match(slot.querySelector('#advancedCatalogList').innerHTML, /data-catalog-add/);
});

test('with Hide NSFW on in the settings, "Hide 18+ sites" is on and cannot be turned off; with it off the box is the person\'s again; a change made while the tab is closed reads the list again', async () => {
  const { e, slot, advancedTab } = mountWithSlot();
  const adult = slot.querySelector('#advancedCatalogHideAdult');
  const note = slot.querySelector('#advancedCatalogFilterNote');
  assert.deepEqual([adult.checked === true, adult.disabled === true, note.hidden], [false, false, true], 'off: the box is free and no note');
  await advancedTab.click();
  assert.equal(e.calls.length, 1);
  e.ctx.state.settings = { ...(e.ctx.state.settings || {}), hideNsfw: true };
  await advancedTab.click();
  assert.deepEqual([adult.checked === true, adult.disabled === true, note.hidden], [true, true, false], 'on: ticked, locked, with the note');
  assert.equal(e.calls.length, 2, 'the setting changed since the list was read, so it is read again');
  assert.deepEqual(e.calls[1].body.warnings, ['SAFE']);
  await advancedTab.click();
  assert.equal(e.calls.length, 2, 'nothing changed: nothing is asked');
  e.ctx.state.settings = { ...e.ctx.state.settings, hideNsfw: false };
  await advancedTab.click();
  assert.deepEqual([adult.checked === true, adult.disabled === true, note.hidden], [false, false, true], 'off again: the box goes back to what it was');
  assert.equal(e.calls.length, 3);
});

test('a box the person had ticked themselves stays ticked when Hide NSFW is turned on and off again', async () => {
  const { e, slot, advancedTab } = mountWithSlot();
  const adult = slot.querySelector('#advancedCatalogHideAdult');
  adult.checked = true;
  await advancedTab.click();
  e.ctx.state.settings = { ...(e.ctx.state.settings || {}), hideNsfw: true };
  await advancedTab.click();
  e.ctx.state.settings = { ...e.ctx.state.settings, hideNsfw: false };
  await advancedTab.click();
  assert.equal(adult.checked, true, 'it goes back to what the person had chosen');
});

test('choosing a site in the Advanced tab writes it through the import card\'s controller and then shows the report of its Check in the Sources tab', async () => {
  const { e, slot, link, clicks, advancedTab } = mountWithSlot({ apiImpl: async () => page({ rows: [row({ engine: 'handwritten', via: 'engine' })], extensionEngine: { available: true, enabled: true } }) });
  const block = slot.querySelector('#advancedCatalogBlock');
  await advancedTab.click();
  const target = { disabled: false, getAttribute: (name) => (name === 'data-catalog-engine' ? KEY : null) };
  await block.fire('click', { target: { closest: (selector) => (selector === '[data-catalog-engine]' ? target : null) } });
  await rig.settle();
  assert.deepEqual(link.engineSent, [KEY]);
  assert.equal(e.confirms.length, 1, 'the question is asked here too');
  assert.deepEqual({ tab: clicks.tab, report: clicks.report }, { tab: 1, report: 1 }, 'the Sources tab is opened and the report shown');
  const plain = { disabled: false, getAttribute: (name) => (name === 'data-catalog-add' ? KEY : null) };
  await block.fire('click', { target: { closest: (selector) => (selector === '[data-catalog-add]' ? plain : null) } });
  await rig.settle();
  assert.deepEqual(link.sent, [KEY]);
  assert.equal(clicks.tab, 2);
});

test('while the import card is busy a click in the Advanced tab does nothing, and a page with no slot gets no second block', async () => {
  const { slot, card, link } = mountWithSlot();
  const block = slot.querySelector('#advancedCatalogBlock');
  card.setAttribute('aria-busy', 'true');
  const target = { disabled: false, getAttribute: () => KEY };
  await block.fire('click', { target: { closest: () => target } });
  assert.deepEqual([link.sent, link.engineSent], [[], []]);
  const plain = mountCard();
  assert.ok(plain.mounted, 'without a slot the import card\'s block is mounted as before');
});

// ── wiring and wording ────────────────────────────────────────────────────

test('both languages carry every string the block uses, and none is empty', () => {
  const wanted = (strings) => Object.keys(strings).filter((k) => k.startsWith('settings.sourceCatalog.')).sort();
  assert.deepEqual(wanted(rig.PT), wanted(rig.EN));
  for (const strings of [rig.EN, rig.PT]) for (const key of wanted(strings)) assert.ok(String(strings[key]).trim().length > 0, key);
  const source = SOURCE();
  const used = new Set([...source.matchAll(/'(settings\.sourceCatalog\.[A-Za-z.]+)'/g)].map((m) => m[1].replace(/\.$/, '')));
  for (const key of used) assert.ok(rig.EN[key] || [...Object.keys(rig.EN)].some((k) => k.startsWith(key + '.')), `en-GB is missing ${key}`);
  for (const engine of ['later', 'handwritten', 'unknown', 'checking']) assert.ok(rig.EN[`settings.sourceCatalog.engine.${engine}`] && rig.PT[`settings.sourceCatalog.engine.${engine}`], engine);
  for (const key of ['{count}']) assert.ok(rig.EN['settings.sourceCatalog.checking'].includes(key) && rig.PT['settings.sourceCatalog.checking'].includes(key));
  assert.ok(rig.EN['settings.sourceCatalog.count'].includes('{total}') && rig.PT['settings.sourceCatalog.count'].includes('{total}'));
});

test('the page loads the script after the "add from a link" block, the Manga | Anime switch hides the block, and the stylesheet styles it', () => {
  const html = fs.readFileSync(path.join(rig.PUBLIC_DIR, 'index.html'), 'utf8');
  const at = (name) => html.indexOf(name);
  assert.ok(at('ui-settings-source-catalog') > at('ui-settings-source-link'), 'loaded after ui-settings-source-link.js');
  assert.ok(at('ui-settings-source-catalog') > 0);
  assert.match(fs.readFileSync(path.join(rig.MODULES_DIR, 'ui-settings-anime-import.js'), 'utf8'), /show\('sourceCatalogBlock', !anime\)/);
  const css = fs.readFileSync(path.join(rig.PUBLIC_DIR, 'css-modules', 'source-import.css'), 'utf8');
  for (const selector of ['.source-catalog-block', '.source-catalog-card', '.source-catalog-logo', '.source-catalog-badge', '.source-catalog-list']) assert.ok(css.includes(selector), selector);
});

test('the "add from a link" block mounts the catalog above itself, only when the catalog script is there', () => {
  const link = fs.readFileSync(path.join(rig.MODULES_DIR, 'ui-settings-source-link.js'), 'utf8');
  assert.match(link, /typeof mountSourceCatalogBlock === 'function'\) mountSourceCatalogBlock\(card, controller, request\)/);
  const mounted = link.indexOf('mountSourceCatalogBlock(card, controller, request)');
  assert.ok(mounted > link.indexOf("notice.insertAdjacentHTML('afterend', buildSourceLinkHtml())"), 'the link block is in the card before the catalog is put above it');
});

test('the block never builds markup from server text without escaping it, and never touches storage or the address bar', () => {
  const source = SOURCE();
  assert.ok(!/localStorage|sessionStorage|location\./.test(source));
  // A value of the server put straight into a template literal, with no escapeHtml around it, is markup built from server text.
  for (const [, expression] of source.matchAll(/\$\{\s*([^}]+?)\s*\}/g)) {
    assert.ok(!/^(row\.(name|host|key|lang)|item\.(lang|name)|current|page\.lang)$/.test(expression), `unescaped: ${expression}`);
  }
});

test('a card of a site that is added has Uninstall (for the id of its source) in place of Add; an id that is not an id is never put in the markup', () => {
  const { ctx } = env();
  const card = (over) => rig.markup(ctx.buildSourceCatalogRowHtml(ctx.sourceCatalogNormalize({ rows: [row(over)] }).rows[0]));
  const added = card({ installed: true, installedId: 'sw-6289731484943315811' });
  assert.equal(added('button[data-catalog-uninstall]').attr('data-catalog-uninstall'), 'sw-6289731484943315811');
  assert.equal(added('button[data-catalog-add], button[data-catalog-engine]').length, 0);
  assert.equal(card({})('button[data-catalog-add]').length, 1, 'a site that is not added keeps Add');
  for (const evil of ['"><img src=x onerror=PWN(1)>', '../x', 'a b', 'x'.repeat(90), 7]) {
    const html = card({ installed: true, installedId: evil });
    assert.equal(html('[data-catalog-uninstall]').length, 0, String(evil));
    assert.equal(html('img').length, 0, String(evil));
  }
});

test('a site that could not be written for makes the list be read again (the server no longer offers it), and the reason is said after that, not lost to it', async () => {
  const link = { runCatalog: async () => false, lastResult: () => ({ generated: false, message: 'The site cannot be added from a link: the check came out "unreachable".' }) };
  const { controller, calls, view } = setup(async () => page(), { linkController: link });
  await controller.open();
  const before = calls.length;
  assert.equal(await controller.add(KEY), false);
  assert.equal(calls.length, before + 1, 'the list was asked for again');
  const names = view.log.map((entry) => entry[0]);
  assert.ok(names.lastIndexOf('showList') < names.lastIndexOf('outcome'), 'the reason comes after the list is shown again');
  assert.deepEqual(view.all('outcome').pop().slice(1), [false, 'The site cannot be added from a link: the check came out "unreachable".']);
});

test('Uninstall asks first, removes through the card\'s own controller, then reads the list again; a refusal changes nothing', async () => {
  const removed = [];
  const link = { runCatalog: async () => true, uninstall: async (id) => { removed.push(id); return true; } };
  let asked = null;
  const e = env(async () => page());
  const view = fakeView();
  const controller = e.ctx.createSourceCatalogController({ api: e.ctx.api, view, linkController: link, timer: fakeTimer(), confirmUninstall: (id) => { asked = id; return true; } });
  assert.equal(await controller.uninstall('sw-12'), true);
  assert.equal(asked, 'sw-12');
  assert.deepEqual(removed, ['sw-12']);
  assert.equal(e.calls.length, 1, 'the list is read again after it');
  assert.equal(await controller.uninstall('../x'), false, 'an id that is not an id is refused before anything is asked');
  const no = e.ctx.createSourceCatalogController({ api: e.ctx.api, view: fakeView(), linkController: link, timer: fakeTimer(), confirmUninstall: () => false });
  assert.equal(await no.uninstall('sw-12'), false);
  assert.deepEqual(removed, ['sw-12'], 'declining removes nothing');
});

test('Hide added and Show only added are sent as plain booleans and cancel each other in the boxes', () => {
  const { ctx } = env();
  assert.equal(ctx.sourceCatalogBody({}, { lang: 'en', onlyInstalled: true }, { offset: 0, limit: 60 }).onlyInstalled, true);
  assert.equal(ctx.sourceCatalogBody({}, { lang: 'en', onlyInstalled: 'yes' }, { offset: 0, limit: 60 }).onlyInstalled, false);
  const source = fs.readFileSync(FILE, 'utf8');
  assert.match(source, /OnlyInstalled/);
  assert.match(source, /other\.checked = false/);
});

test('the address on a card opens the site in a new tab, unless the site is blocked or the text is not a plain host name', () => {
  const { ctx } = env();
  const card = (over) => rig.markup(ctx.buildSourceCatalogRowHtml(ctx.sourceCatalogNormalize({ rows: [row(over)] }).rows[0]));
  const link = card({})('a.source-catalog-link');
  assert.equal(link.attr('href'), 'https://alpha.example/');
  assert.equal(link.attr('target'), '_blank');
  assert.equal(link.attr('rel'), 'noopener noreferrer');
  assert.equal(link.text(), 'alpha.example');
  assert.equal(card({ blocked: true })('a').length, 0, 'a site on the dangerous list is never made clickable');
  for (const evil of ['alpha.example/"onmouseover="PWN(1)', 'javascript:alert(1)', 'a b', 'x', '"><img src=x>']) assert.equal(card({ host: evil })('a').length, 0, evil);
});

test('the two filters, hide 18+ and hide added, are sent as plain booleans from the boxes', () => {
  const { ctx } = env();
  const body = ctx.sourceCatalogBody({}, { lang: 'en', q: '', hideAdult: true, hideInstalled: 'yes' }, { offset: 0, limit: 60 });
  assert.equal(body.hideAdult, true);
  assert.equal(body.hideInstalled, false);
});

test('a row is a card: a logo over an initial, the name, the address and the button; a logo address that is not the CDN is never put in an image', () => {
  const { ctx } = env();
  const good = 'https://cdn.jsdelivr.net/gh/keiyoushi/extensions@repo/icon/a.png';
  const card = (over) => rig.markup(ctx.buildSourceCatalogRowHtml(ctx.sourceCatalogNormalize({ rows: [row(over)] }).rows[0]));
  const withLogo = card({ icon: good });
  assert.equal(withLogo('li.source-catalog-card').length, 1);
  assert.equal(withLogo('img.source-catalog-logo-img').attr('src'), good);
  assert.equal(withLogo('img').attr('referrerpolicy'), 'no-referrer');
  assert.equal(withLogo('.source-catalog-initial').text(), 'A');
  for (const bad of ['https://evil.example/a.png', 'http://cdn.jsdelivr.net/a.png', 'javascript:alert(1)', 'https://cdn.jsdelivr.net/a.png" onerror="PWN(1)']) {
    const html = card({ icon: bad });
    assert.equal(html('img').length, 0, bad);
    assert.equal(html('.source-catalog-initial').length, 1, bad);
  }
});
