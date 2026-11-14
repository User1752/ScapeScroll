'use strict';

// The "Add from a link" block of the Import card (public/modules/ui-settings-source-link.js), run in the same vm sandbox as the
// card's other tests (tests/helpers/source-import-rig.js). The block asks the server for the text of a source; what matters here is
// that the answer is only ever shown as text, that a written source goes through the card's own Check (never straight to install),
// that one request runs at a time, and that both languages carry every string.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const rig = require('../helpers/source-import-rig');

const SCRIPTS = [...rig.SCRIPTS, 'ui-settings-source-link.js'];
const LINK_FILE = path.join(rig.MODULES_DIR, 'ui-settings-source-link.js');
const env = (apiImpl) => rig.makeEnv({ apiImpl, scripts: SCRIPTS });

const generated = (over = {}) => ({ ok: true, status: 'generated', id: 'mangas', name: 'Mangas Example', code: 'module.exports = {};', notes: ['A note.'], probe: { verdict: 'open', engine: { id: 'madara', name: 'Madara' }, reasons: [{ severity: 'warn', text: 'A warning.' }] }, ...over });
const refused = (over = {}) => ({ ok: true, status: 'refused', stage: 'probe', message: 'The site cannot be added from a link: the check came out "needs-solver".', probe: { verdict: 'needs-solver', reasons: [{ severity: 'block', text: 'A challenge stands in front of the content.' }] }, ...over });

// A view that records what it was told, and an import controller that records the order of its calls.
function setup(answer, { url = ' https://mangas.example ' } = {}) {
  const e = env(async () => (answer instanceof Error ? Promise.reject(answer) : answer));
  const log = [];
  const view = {
    read: () => ({ url }),
    busy: (on) => log.push(['busy', on]),
    error: (text) => log.push(['error', text]),
    clearResult: () => log.push(['clearResult']),
    showResult: (a) => log.push(['showResult', rig.plain(a)]),
    fill: (code, id) => log.push(['fill', code, id]),
  };
  const importController = { edit: () => log.push(['edit']), check: async () => { log.push(['check']); return true; } };
  const controller = e.ctx.createSourceLinkController({ api: e.ctx.api, view, importController });
  return { e, log, controller, names: () => log.map((entry) => entry[0]) };
}

test('a written source goes into the card\'s boxes and through the card\'s own Check, never straight to install', async () => {
  const { e, log, controller, names } = setup(generated());
  assert.equal(await controller.run(), true);
  assert.equal(e.calls.length, 1);
  assert.equal(e.calls[0].route, '/api/sources/import/link');
  assert.deepEqual(e.calls[0].body, { url: 'https://mangas.example' }, 'the address is trimmed and nothing else is sent');
  assert.deepEqual(names(), ['error', 'clearResult', 'busy', 'showResult', 'fill', 'edit', 'check', 'busy']);
  assert.deepEqual(log.find((entry) => entry[0] === 'fill'), ['fill', 'module.exports = {};', 'mangas']);
  assert.deepEqual(log.filter((entry) => entry[0] === 'busy').map((entry) => entry[1]), [true, false]);
});

test('a refusal is shown and nothing is put in the boxes or checked', async () => {
  const { log, controller, names } = setup(refused());
  assert.equal(await controller.run(), false);
  assert.ok(names().includes('showResult'));
  assert.ok(!names().includes('fill') && !names().includes('check') && !names().includes('edit'));
  assert.equal(log.at(-1)[0], 'busy');
  assert.equal(log.at(-1)[1], false);
});

test('an answer that says generated but carries no text is not a written source', async () => {
  const { controller, names } = setup(generated({ code: '' }));
  assert.equal(await controller.run(), false);
  assert.ok(!names().includes('fill'));
});

test('an empty address asks for one and sends nothing', async () => {
  const { e, log, controller } = setup(generated(), { url: '   ' });
  assert.equal(await controller.run(), false);
  assert.equal(e.calls.length, 0);
  assert.ok(log.some((entry) => entry[0] === 'error' && /address/i.test(entry[1])));
});

test('a failed request shows the sentence of the error, frees the block, and writes nothing', async () => {
  const { log, controller, names } = setup(rig.httpError(403, { ok: false, code: 'LOCAL_ONLY', error: 'raw' }));
  assert.equal(await controller.run(), false);
  assert.match(log.find((entry) => entry[0] === 'error' && entry[1])[1], /only available on the computer running ScrollScape/);
  assert.ok(!names().includes('fill'));
  assert.equal(log.at(-1)[1], false, 'busy is released');
  const again = setup(new TypeError('fetch failed'));
  assert.equal(await again.controller.run(), false);
  assert.ok(again.log.some((entry) => entry[0] === 'error' && /request failed/.test(entry[1])), 'a made-up error is not shown as the server\'s');
});

test('one request at a time: a second click while the first runs does nothing', async () => {
  const gate = rig.deferred();
  const e = env(() => gate.promise);
  const importController = { edit() {}, check: async () => true };
  const view = { read: () => ({ url: 'mangas.example' }), busy() {}, error() {}, clearResult() {}, showResult() {}, fill() {} };
  const controller = e.ctx.createSourceLinkController({ api: e.ctx.api, view, importController });
  const first = controller.run();
  assert.equal(await controller.run(), false);
  gate.resolve(refused());
  await first;
  assert.equal(e.calls.length, 1);
});

test('the answer is only ever text: hostile names, notes and reasons are escaped, whatever the server sent', () => {
  const e = env();
  for (const hostile of rig.HOSTILE) {
    const html = e.ctx.buildSourceLinkResultHtml(generated({ name: hostile, message: hostile, notes: [hostile], probe: { engine: { name: hostile }, reasons: [{ severity: hostile, text: hostile }] } }));
    const $ = rig.markup(html);
    assert.equal($('img, script, svg, iframe').length, 0, hostile);
    assert.equal($('[onerror], [onfocus], [onload]').length, 0, hostile);
    const refusedHtml = e.ctx.buildSourceLinkResultHtml(refused({ message: hostile }));
    assert.equal(rig.markup(refusedHtml)('img, script, svg').length, 0, hostile);
  }
  const normalised = rig.plain(e.ctx.sourceLinkNormalize({ status: 'generated', code: 'x', notes: new Array(50).fill('n'), probe: { reasons: new Array(50).fill({ severity: 'warn', text: 'r' }) } }));
  assert.equal(normalised.notes.length, 20);
  assert.equal(normalised.reasons.length, 20);
  assert.equal(rig.plain(e.ctx.sourceLinkNormalize(null)).generated, false);
  assert.equal(rig.plain(e.ctx.sourceLinkNormalize({ probe: { reasons: [{ severity: 'bogus', text: 't' }] } })).reasons[0].severity, 'info', 'an unknown severity is only information');
});

test('the block has the address box, the button, and the labels of the language in use; both languages have every string', () => {
  const e = env();
  const $ = rig.markup(e.ctx.buildSourceLinkHtml());
  assert.equal($('input#sourceLinkUrl[type="url"]').length, 1);
  assert.equal($('button#sourceLinkBtn').length, 1);
  assert.equal($('label[for="sourceLinkUrl"]').length, 1);
  assert.equal($('#sourceLinkError[role="alert"]').length, 1);
  assert.equal($('#sourceLinkResult[aria-live="polite"]').length, 1);
  const keys = (strings) => Object.keys(strings).filter((k) => k.startsWith('settings.sourceLink.')).sort();
  assert.ok(keys(rig.EN).length >= 8);
  assert.deepEqual(keys(rig.PT), keys(rig.EN));
  for (const key of keys(rig.EN)) {
    assert.ok(rig.EN[key] && rig.PT[key], key);
    assert.deepEqual(rig.PT[key].match(/\{\w+\}/g) || [], rig.EN[key].match(/\{\w+\}/g) || [], `${key}: the same placeholders in both languages`);
  }
});

test('mounted on the card: the button and Enter run it, the busy card does not, and a card without a notice is left alone', async () => {
  const e = env(async () => refused());
  const elements = {};
  const make = (id) => { elements[id] = rig.fakeElement(); return elements[id]; };
  const notice = { insertAdjacentHTML: (position, html) => { notice.html = html; notice.position = position; ['sourceLinkBlock', 'sourceLinkUrl', 'sourceLinkBtn', 'sourceLinkError', 'sourceLinkResult'].forEach(make); elements.sourceLinkUrl.value = 'mangas.example'; } };
  const card = rig.fakeElement();
  card.querySelector = (selector) => (selector === '.source-import-notice' ? notice : (elements[selector.slice(1)] || null));
  const importController = { edit() {}, check: async () => true };

  const mountedBlock = e.ctx.mountSourceLinkBlock(card, importController, e.ctx.api);
  assert.ok(mountedBlock);
  assert.equal(notice.position, 'afterend');
  assert.equal(e.ctx.mountSourceLinkBlock(card, importController, e.ctx.api), null, 'not added twice');

  const linkCalls = () => e.calls.filter((c) => c.route === '/api/sources/import/link').length;
  await elements.sourceLinkBtn.fire('click');
  await rig.settle();
  assert.equal(linkCalls(), 1);
  await elements.sourceLinkUrl.fire('keydown', { key: 'Enter', preventDefault() {} });
  await rig.settle();
  assert.equal(linkCalls(), 2);
  await elements.sourceLinkUrl.fire('keydown', { key: 'a', preventDefault() {} });
  assert.equal(linkCalls(), 2);
  card.setAttribute('aria-busy', 'true');
  await elements.sourceLinkBtn.fire('click');
  assert.equal(linkCalls(), 2, 'while the card checks, installs or tests, the block waits');

  const bare = rig.fakeElement();
  bare.querySelector = () => null;
  assert.equal(e.ctx.mountSourceLinkBlock(bare, importController, e.ctx.api), null);
  assert.equal(e.ctx.mountSourceLinkBlock(null, importController, e.ctx.api), null);
});

test('the page loads the block after the card\'s own script, and the card calls it only when it is there', () => {
  const index = fs.readFileSync(path.join(rig.PUBLIC_DIR, 'index.html'), 'utf8');
  const at = (name) => index.indexOf(`modules/${name}.js`);
  assert.ok(at('ui-settings-source-link') > at('ui-settings-source-import'), 'loaded after ui-settings-source-import.js');
  assert.match(fs.readFileSync(rig.LOGIC_FILE, 'utf8'), /typeof mountSourceLinkBlock === 'function'\) mountSourceLinkBlock\(card, controller, api\)/);
  assert.ok(rig.lines(LINK_FILE).length <= 450, 'within the size rule of the project');
});

// ── Regenerate ────────────────────────────────────────────────────────────

const generatedList = (sources) => ({ ok: true, sources });

test('the list of sources written from a link has a Regenerate button for each, and shows nothing when there are none', () => {
  const e = env();
  assert.equal(e.ctx.buildSourceLinkGeneratedHtml(e.ctx.sourceLinkNormalizeGenerated({ ok: true, sources: [] })), '');
  assert.equal(e.ctx.buildSourceLinkGeneratedHtml(e.ctx.sourceLinkNormalizeGenerated(null)), '');
  const $ = rig.markup(e.ctx.buildSourceLinkGeneratedHtml(e.ctx.sourceLinkNormalizeGenerated(generatedList([
    { id: 'mangas', name: 'Mangas Example', base: 'https://mangas.example', on: '2026-10-28' },
    { id: '../bad', name: 'Bad id', base: 'https://x.example', on: '2026-10-28' },
    null,
    { id: 'no-name', base: 'https://y.example', on: '2026-10-01' },
  ]))));
  assert.deepEqual($('[data-link-regenerate]').map((_, b) => $(b).attr('data-link-regenerate')).get(), ['mangas', 'no-name'], 'an id that is not an id gets no button');
  assert.match($.text(), /Mangas Example/);
  assert.match($.text(), /mangas\.example, written 2026-10-28/);
  assert.match($('button[data-link-regenerate="mangas"]').text(), /Regenerate/);
});

test('names and addresses in that list are only text', () => {
  const e = env();
  for (const hostile of rig.HOSTILE) {
    const html = e.ctx.buildSourceLinkGeneratedHtml(e.ctx.sourceLinkNormalizeGenerated(generatedList([{ id: 'ok', name: hostile, base: hostile, on: hostile }])));
    const $ = rig.markup(html);
    assert.equal($('img, script, svg, iframe').length, 0, hostile);
    assert.equal($('[onerror], [onfocus], [onload]').length, 0, hostile);
  }
});

test('regenerate sends only the id, then fills the boxes and runs the card\'s Check like a pasted link; a bad id sends nothing', async () => {
  const { e, log, controller, names } = setup(generated({ regenerated: true, unchanged: false }));
  assert.equal(await controller.regenerate('mangas'), true);
  assert.deepEqual(e.calls[0].body, { regenerate: 'mangas' }, 'the address is the installed file\'s, never sent from here');
  assert.deepEqual(names(), ['error', 'clearResult', 'busy', 'showResult', 'fill', 'edit', 'check', 'busy']);
  assert.deepEqual(log.find((entry) => entry[0] === 'fill'), ['fill', 'module.exports = {};', 'mangas']);
  for (const bad of ['', '../x', 'a b', null, undefined, 'x'.repeat(81)]) assert.equal(await controller.regenerate(bad), false, String(bad));
  assert.equal(e.calls.length, 1);
});

test('the answer says whether the regenerated source differs from the installed one', () => {
  const e = env();
  const same = rig.markup(e.ctx.buildSourceLinkResultHtml(generated({ regenerated: true, unchanged: true }))).text();
  assert.match(same, /same source as the installed one/);
  const changed = rig.markup(e.ctx.buildSourceLinkResultHtml(generated({ regenerated: true, unchanged: false }))).text();
  assert.match(changed, /differs from the installed one/);
  const fresh = rig.markup(e.ctx.buildSourceLinkResultHtml(generated())).text();
  assert.doesNotMatch(fresh, /installed one/);
});

test('refresh shows the list the server gave, and an empty one when it cannot be read', async () => {
  const shown = [];
  const view = { read: () => ({ url: '' }), busy() {}, error() {}, clearResult() {}, showResult() {}, fill() {}, showGenerated: (list) => shown.push(rig.plain(list)) };
  const importController = { edit() {}, check: async () => true };
  const good = env(async () => generatedList([{ id: 'mangas', name: 'Mangas', base: 'https://mangas.example', on: '2026-10-28' }]));
  await good.ctx.createSourceLinkController({ api: good.ctx.api, view, importController }).refresh();
  assert.deepEqual(shown[0], [{ id: 'mangas', name: 'Mangas', base: 'https://mangas.example', on: '2026-10-28' }]);
  assert.equal(good.calls[0].route, '/api/sources/import/generated');
  const bad = env(async () => { throw rig.httpError(403, { ok: false, code: 'LOCAL_ONLY', error: 'x' }); });
  await bad.ctx.createSourceLinkController({ api: bad.ctx.api, view, importController }).refresh();
  assert.deepEqual(shown[1], []);
});

test('on the card: the list is read when the block is added and again when the card says its lists changed; a click on Regenerate runs it unless the card is busy', async () => {
  const e = env(async (route) => (route === '/api/sources/import/generated' ? generatedList([{ id: 'mangas', name: 'M', base: 'https://mangas.example', on: '2026-10-28' }]) : refused()));
  const elements = {};
  const make = (id) => { elements[id] = rig.fakeElement(); return elements[id]; };
  const notice = { insertAdjacentHTML: () => { ['sourceLinkBlock', 'sourceLinkUrl', 'sourceLinkBtn', 'sourceLinkError', 'sourceLinkResult', 'sourceLinkGenerated'].forEach(make); } };
  const card = rig.fakeElement();
  card.querySelector = (selector) => (selector === '.source-import-notice' ? notice : (elements[selector.slice(1)] || null));
  const importController = { edit() {}, check: async () => true };
  const reads = () => e.calls.filter((c) => c.route === '/api/sources/import/generated').length;
  const asks = () => e.calls.filter((c) => c.route === '/api/sources/import/link');

  e.ctx.mountSourceLinkBlock(card, importController, e.ctx.api);
  await rig.settle();
  assert.equal(reads(), 1);
  assert.match(elements.sourceLinkGenerated.innerHTML, /data-link-regenerate="mangas"/);
  e.ctx.refreshSourceLinkList(card);
  await rig.settle();
  assert.equal(reads(), 2);
  e.ctx.refreshSourceLinkList(rig.fakeElement());
  assert.equal(reads(), 2, 'a card that has no block is ignored');

  const button = { disabled: false, getAttribute: (name) => (name === 'data-link-regenerate' ? 'mangas' : null) };
  const clickRegenerate = () => elements.sourceLinkGenerated.fire('click', { target: { closest: (s) => (s === '[data-link-regenerate]' ? button : null) } });
  await clickRegenerate();
  await rig.settle();
  assert.deepEqual(asks().map((c) => c.body), [{ regenerate: 'mangas' }]);
  card.setAttribute('aria-busy', 'true');
  await clickRegenerate();
  await rig.settle();
  assert.equal(asks().length, 1, 'while the card checks, installs or tests, the button waits');
  card.setAttribute('aria-busy', 'false');
  await elements.sourceLinkGenerated.fire('click', { target: { closest: () => null } });
  assert.equal(asks().length, 1, 'a click elsewhere in the list does nothing');
});

test('the card tells the block when its lists change, and works without it', () => {
  assert.match(fs.readFileSync(rig.LOGIC_FILE, 'utf8'), /typeof refreshSourceLinkList === 'function'\) refreshSourceLinkList\(card\)/);
  assert.ok(rig.lines(rig.LOGIC_FILE).length <= 450);
});

test('when the card says its lists changed, the last answer is dropped once no check is open, and kept while one is', async () => {
  const e = env(async () => generatedList([]));
  const elements = {};
  const notice = { insertAdjacentHTML: () => { ['sourceLinkBlock', 'sourceLinkUrl', 'sourceLinkBtn', 'sourceLinkError', 'sourceLinkResult', 'sourceLinkGenerated', 'sourceImportReport'].forEach((id) => { elements[id] = rig.fakeElement(); }); } };
  const card = rig.fakeElement();
  card.querySelector = (selector) => (selector === '.source-import-notice' ? notice : (elements[selector.slice(1)] || null));
  e.ctx.mountSourceLinkBlock(card, { edit() {}, check: async () => true }, e.ctx.api);
  await rig.settle();

  elements.sourceLinkResult.innerHTML = '<p>Written.</p>';
  elements.sourceImportReport.innerHTML = '<p>report</p>';
  e.ctx.refreshSourceLinkList(card);
  await rig.settle();
  assert.equal(elements.sourceLinkResult.innerHTML, '<p>Written.</p>', 'a check is still open: its answer stays');

  elements.sourceImportReport.innerHTML = '';
  e.ctx.refreshSourceLinkList(card);
  await rig.settle();
  assert.equal(elements.sourceLinkResult.innerHTML, '', 'installed or dropped: the answer is about nothing now');
});
