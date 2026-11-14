'use strict';

// The share cards (public/modules/wrapped-share-cards.js, ui-wrapped-share-modal.js). The model (what is ON the card) is plain data and
// the drawing is checked with a context that records everything it is asked to draw, so nothing here needs a canvas. What matters:
//  - the card is made from the numbers the page shows, so a title that was hidden is not on it, and a partial period says so on it;
//  - nothing is drawn past the bottom or the sides, whatever the length of the titles and the number of rows;
//  - a cover can only be an address of this app's own image proxy (or the canvas could not be exported), never a script;
//  - the window only offers what the browser can do (copying an image needs a secure connection).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { computeWrapped } = require('../../server/modules/analytics/wrapped');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (f) => fs.readFileSync(path.join(MODULES, f), 'utf8');

function locale(lang) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read(`i18n/locales/${lang}.js`), ctx);
  return ctx.window.ScrollScapeI18nLocales[lang];
}
const EN = locale('en-GB');

function sandbox(extra = {}) {
  const context = {
    console, JSON, Number, String, Object, Array, Math, Date, Map, Set, URLSearchParams,
    state: { settings: {} }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => null, createElement: () => ({}), addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], body: { appendChild() {} } },
    window: { addEventListener() {}, isSecureContext: true },
    navigator: {}, dbg: new Proxy({}, { get: () => () => {} }), currentLanguage: 'en-GB', ...extra,
  };
  vm.createContext(context);
  vm.runInContext(read('utils.js'), context, { filename: 'utils.js' });
  context.t = (key) => EN[key] ?? key;
  vm.runInContext(read('wrapped-share-cards.js'), context, { filename: 'wrapped-share-cards.js' });
  return context;
}

// A 2D context that only remembers what it was asked to draw. measureText: half the font size per character.
function recorder() {
  const log = { texts: [], rects: [], images: [], arcs: [] };
  const sizeOf = (font) => Number(/(\d+(?:\.\d+)?)px/.exec(font || '')?.[1] || 16);
  const ctx = {
    font: '16px x', fillStyle: '', strokeStyle: '', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic', letterSpacing: '0px',
    createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }),
    fillRect(x, y, w, h) { log.rects.push({ kind: 'fillRect', x, y, w, h }); },
    roundRect(x, y, w, h) { log.rects.push({ kind: 'roundRect', x, y, w, h }); },
    beginPath() {}, fill() {}, stroke() {}, clip() {}, save() {}, restore() {}, closePath() {}, moveTo() {}, arcTo() {},
    arc(x, y, r) { log.arcs.push({ x, y, r }); },
    drawImage(img, x, y, w, h) { log.images.push({ img, x, y, w, h }); },
    measureText(text) { return { width: String(text).length * sizeOf(ctx.font) * 0.5 }; },
    fillText(text, x, y) { log.texts.push({ text: String(text), x, y, align: ctx.textAlign, size: sizeOf(ctx.font) }); },
  };
  return { ctx, log };
}

const NOW = new Date(2026, 9, 31, 16);
const TITLES = [
  'A Very Long Title That Goes On And On About A Boy Who Was Reincarnated In Another World With A Cheat Skill And A Talking Sword',
  'Kingdom', 'Hajime no Ippo', 'Renge to Naruto!', 'Wangan Midnight', 'BLEACH', 'Some Doujin',
];
function wrappedData(options = {}) {
  const manga = {};
  const titles = { manga: {}, anime: { 21: 'ONE PIECE', 22: 'Ghost in the Shell', 23: 'Grand Blue Dreaming', 24: 'Another Anime' } };
  const meta = { manga: {} };
  TITLES.forEach((title, i) => {
    const id = `m${i}`;
    titles.manga[id] = title;
    meta.manga[id] = { author: `Author Number ${i} With A Rather Long Name Indeed`, genres: ['Action', 'Drama', 'Comedy', 'Romance', 'Fantasy', 'Sports'].slice(0, 2 + (i % 5)), cover: i < 3 ? `/api/proxy-image?url=c${i}` : undefined, nsfw: title === 'Some Doujin' };
    for (const day of ['2026-10-31', '2026-10-30', '2026-10-29']) { manga[day] = manga[day] || {}; manga[day][id] = { c: 10 - i, m: 30 + i, s: 2 }; }
  });
  const anime = { '2026-10-30': Object.fromEntries(Object.keys(titles.anime).map((id, i) => [id, { e: 5 - i, m: 100, s: 2 }])) };
  return computeWrapped({
    analytics: { totalChaptersRead: 500, ledger: { version: 1, since: '2026-07-09', manga, anime, titles, meta }, dailyChapterCounts: { '2026-10-31': 40, '2026-10-30': 50, '2026-10-29': 30 } },
    favorites: [], history: [], animeFavorites: [], readingStatus: {}, reviews: {}, nsfwOverrides: {},
  }, { now: NOW, period: 'year', top: 10, ...options });
}

const COMBOS = [['recap', 'square'], ['recap', 'story'], ['top5', 'square'], ['top5', 'story']];

test('what is on each card: the tops are cut to what fits, and the top 5 is five', () => {
  const c = sandbox();
  const w = wrappedData();
  const sections = (variant, size) => Object.fromEntries(c.wrappedCardModel(w, { variant, size }).sections.map((s) => [s.id, (s.rows || s.bars).length]));
  const plain = (v) => JSON.parse(JSON.stringify(v)); // the sandbox has its own Object and Array
  assert.deepEqual(plain(sections('recap', 'square')), { manga: 3, authors: 3, genres: 2 });
  assert.deepEqual(plain(sections('recap', 'story')), { manga: 5, authors: 3, genres: 5, anime: 2 });
  assert.deepEqual(plain(sections('top5', 'square')), { manga: 5 }, 'no room for genres on the square top 5');
  assert.deepEqual(plain(sections('top5', 'story')), { manga: 5, genres: 3 });
  const model = c.wrappedCardModel(w, { variant: 'recap', size: 'square' });
  assert.equal(model.number, Number(w.reading.chapters).toLocaleString('en-GB'), 'the big number is the chapters read');
  assert.deepEqual(plain(model.stats.map((s) => s.label)), ['Reading time', 'Titles', 'Longest streak']);
  assert.deepEqual(plain(model.size), { w: 1080, h: 1080 });
  assert.deepEqual(plain(c.wrappedCardModel(w, { size: 'story' }).size), { w: 1080, h: 1920 });
});

test('an unknown card or size is the recap in square, and the period can be left off', () => {
  const c = sandbox();
  const w = wrappedData();
  const m = c.wrappedCardModel(w, { variant: 'nope', size: 'huge' });
  assert.equal(m.variant, 'recap');
  assert.equal(m.sizeId, 'square');
  assert.equal(c.wrappedCardModel(w, { showPeriod: false }).period, 'Wrapped');
  assert.equal(c.wrappedCardModel(w, {}).period, '2026 · Wrapped');
});

test('what the page hid is not on the card: adult titles, hidden titles, any trace of them', () => {
  const c = sandbox();
  const w = wrappedData({ hideNsfw: true, excludeTitles: ['kingdom'] });
  for (const [variant, size] of COMBOS) {
    const { ctx, log } = recorder();
    c.drawWrappedCard(ctx, c.wrappedCardModel(w, { variant, size }), {}, new Map());
    const everything = JSON.stringify(c.wrappedCardModel(w, { variant, size })) + log.texts.map((x) => x.text).join('|');
    assert.ok(!/Some Doujin/.test(everything), `${variant}/${size}: the adult title`);
    assert.ok(!/Kingdom/.test(everything), `${variant}/${size}: the hidden title`);
    assert.ok(log.texts.some((x) => /Hajime no Ippo/.test(x.text)), `${variant}/${size}: the others are there`);
  }
});

test('a period that reaches before the detailed history says so on the card; one inside it does not', () => {
  const c = sandbox();
  assert.match(c.wrappedCardModel(wrappedData({ period: 'year' }), {}).partial, /^Titles counted since 9 Jul 2026$/);
  assert.equal(c.wrappedCardModel(wrappedData({ period: 'week' }), {}).partial, '');
  const { ctx, log } = recorder();
  c.drawWrappedCard(ctx, c.wrappedCardModel(wrappedData({ period: 'year' }), { variant: 'recap', size: 'square' }), {}, new Map());
  assert.ok(log.texts.some((x) => /since 9 Jul 2026/.test(x.text)), 'and it is drawn');
});

test('a cover is only ever an address on this server: the proxy, never a script, a data address or another site', () => {
  const c = sandbox();
  assert.equal(c.wrappedCardCoverSrc('https://s4.anilist.co/file/a.png'), '/api/proxy-image?url=https%3A%2F%2Fs4.anilist.co%2Ffile%2Fa.png');
  assert.equal(c.wrappedCardCoverSrc('/api/proxy-image?url=x'), '/api/proxy-image?url=x');
  assert.equal(c.wrappedCardCoverSrc('http://insecure.example/c.jpg'), '/api/proxy-image?url=https%3A%2F%2Finsecure.example%2Fc.jpg', 'http is upgraded and proxied');
  for (const bad of ['', null, undefined, 'javascript:alert(1)', 'data:image/png;base64,AAAA', '//evil.example/x.png', 'file:///c:/x.png', 'blob:http://x/1']) {
    assert.equal(c.wrappedCardCoverSrc(bad), '', String(bad));
  }
});

test('nothing is drawn past the bottom or the sides, whatever the titles and the number of rows', () => {
  const c = sandbox();
  const w = wrappedData();
  for (const [variant, size] of COMBOS) {
    const model = c.wrappedCardModel(w, { variant, size });
    const { ctx, log } = recorder();
    c.drawWrappedCard(ctx, model, {}, new Map());
    const { w: W, h: H } = model.size;
    const limit = H - 72;
    const lowest = Math.max(...log.texts.map((x) => x.y), ...log.rects.filter((r) => r.kind === 'roundRect').map((r) => r.y + r.h));
    assert.ok(lowest <= limit, `${variant}/${size}: the lowest thing is at ${lowest}, the limit is ${limit}`);
    for (const x of log.texts) {
      assert.ok(x.text.length > 0);
      const width = x.text.length * x.size * 0.5;
      const left = x.align === 'right' ? x.x - width : x.align === 'center' ? x.x - width / 2 : x.x;
      assert.ok(left >= 0 && left + width <= W, `${variant}/${size}: "${x.text.slice(0, 30)}" is drawn from ${Math.round(left)} to ${Math.round(left + width)} on a ${W} card`);
    }
    for (const r of log.rects.filter((q) => q.kind === 'roundRect')) assert.ok(r.x >= 0 && r.x + r.w <= W, `${variant}/${size}: a box at ${r.x} is ${r.w} wide`);
  }
});

test('a title that is too long is cut with an ellipsis, not allowed to run over', () => {
  const c = sandbox();
  const { ctx, log } = recorder();
  c.drawWrappedCard(ctx, c.wrappedCardModel(wrappedData(), { variant: 'top5', size: 'square' }), {}, new Map());
  const long = log.texts.find((x) => /^A Very Long Title/.test(x.text));
  assert.ok(long && long.text.endsWith('…'), 'the long title is cut');
  assert.ok(long.text.length < 'A Very Long Title That Goes On And On About A Boy'.length + 20);
});

test('a cover that loaded is drawn; one that did not leaves the first letter of the title', () => {
  const c = sandbox();
  const model = c.wrappedCardModel(wrappedData(), { variant: 'top5', size: 'square' });
  const first = model.sections[0].rows[0];
  assert.ok(first.cover.startsWith('/api/proxy-image'));
  const withImage = recorder();
  c.drawWrappedCard(withImage.ctx, model, {}, new Map([[first.cover, { width: 200, height: 300 }]]));
  assert.equal(withImage.log.images.length, 1);
  assert.deepEqual(withImage.log.images[0].img, { width: 200, height: 300 });
  const without = recorder();
  c.drawWrappedCard(without.ctx, model, {}, new Map());
  assert.equal(without.log.images.length, 0);
  assert.ok(without.log.texts.some((x) => x.text === first.title.charAt(0).toUpperCase()), 'the letter stands in for the cover');
});

test('an empty period draws a message and nothing else; the numbers are in the language of the page', () => {
  const c = sandbox();
  const empty = computeWrapped({ analytics: {} }, { now: NOW, period: 'week' });
  const { ctx, log } = recorder();
  c.drawWrappedCard(ctx, c.wrappedCardModel(empty, {}), {}, new Map());
  assert.ok(log.texts.some((x) => /Nothing read or watched/.test(x.text)));
  assert.ok(!log.texts.some((x) => /chapters read/.test(x.text)));
});

test('the file name says what it is', () => {
  const c = sandbox();
  assert.equal(c.wrappedCardFileName(wrappedData(), { variant: 'recap', size: 'square' }), 'scrollscape-wrapped-2026-recap-square.png');
  assert.equal(c.wrappedCardFileName(wrappedData({ period: 'week' }), { variant: 'top5', size: 'story' }), 'scrollscape-wrapped-week-top5-story.png');
  assert.equal(c.wrappedCardFileName(wrappedData(), { variant: '../../x', size: 'x' }), 'scrollscape-wrapped-2026-recap-square.png', 'nothing from the options reaches the name unchecked');
});

// ── the window ──────────────────────────────────────────────────────────────

function modalSandbox(over = {}) {
  const c = sandbox(over);
  c.escapeHtml = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  vm.runInContext(read('ui-wrapped-share-modal.js'), c, { filename: 'ui-wrapped-share-modal.js' });
  return c;
}

test('the window offers copying only where the browser can: it needs a secure connection and the clipboard API', () => {
  const secure = modalSandbox({ navigator: { clipboard: { write() {} } }, ClipboardItem: function ClipboardItem() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(secure.wrappedShareCapabilities())), { copy: true, share: false });

  const insecure = modalSandbox({ window: { addEventListener() {}, isSecureContext: false }, navigator: { clipboard: { write() {} } }, ClipboardItem: function ClipboardItem() {} });
  assert.equal(insecure.wrappedShareCapabilities().copy, false, 'http on the network: no copying');
  assert.match(insecure._wShareHtml(), /data-wshare-action="copy" disabled title="Copying an image needs a secure connection[^"]*" data-unavailable="1"/);
  assert.match(insecure._wShareHtml(), /wrappedShareNote">Copying an image needs a secure connection/, 'and the window says why');

  const noApi = modalSandbox({ navigator: {} });
  assert.equal(noApi.wrappedShareCapabilities().copy, false);

  const phone = modalSandbox({ navigator: { share() {}, canShare() { return true; } } });
  assert.equal(phone.wrappedShareCapabilities().share, true);
  assert.match(phone._wShareHtml(), /data-wshare-action="share"/);
  assert.ok(!noApi._wShareHtml().includes('data-wshare-action="share"'));
});

test('the window is a real dialog: labelled, with a close button, the choices, and the privacy note', () => {
  const html = modalSandbox()._wShareHtml();
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="wrappedShareTitle"/);
  assert.match(html, /data-wshare-action="close" aria-label="Close"/);
  for (const v of ['recap', 'top5']) assert.match(html, new RegExp(`data-wshare="variant" value="${v}"|value="${v}" data-wshare="variant"`));
  for (const s of ['square', 'story']) assert.match(html, new RegExp(`name="wshare-size" value="${s}"`));
  assert.match(html, /titles you hid are not on it/);
  assert.ok(!/<[a-z][^>]*\son[a-z]+=/i.test(html.replace(/="[^"]*"/g, '="')), 'no inline handler');
});

test('every string the cards and the window use exists in English and in Portuguese', () => {
  const keys = new Set();
  for (const file of ['wrapped-share-cards.js', 'ui-wrapped-share-modal.js']) {
    for (const m of read(file).matchAll(/\bt\('((?:wrapped|analytics)\.[A-Za-z0-9.]+)'/g)) keys.add(m[1]);
  }
  keys.add('wrapped.share');
  assert.ok(keys.size > 25, `${keys.size} keys found`);
  for (const lang of ['en-GB', 'pt-PT']) {
    const table = locale(lang);
    const missing = [...keys].filter((k) => typeof table[k] !== 'string' || !table[k]);
    assert.deepEqual(missing, [], `${lang} is missing ${missing.join(', ')}`);
  }
});

test('the pieces are wired: the scripts load in order, and the tab has a Share button that opens the window', () => {
  const html = fs.readFileSync(path.join(MODULES, '..', 'index.html'), 'utf8');
  const at = (s) => html.indexOf(s);
  assert.ok(at('wrapped-share-cards.js') > 0 && at('ui-wrapped-share-modal.js') > at('wrapped-share-cards.js'));
  const tab = read('ui-analytics-wrapped.js');
  assert.match(tab, /data-wrapped-action="share"/);
  assert.match(tab, /case 'share':\s*\n\s*if \(typeof openWrappedShare === 'function'\) openWrappedShare\(\);/);
  assert.match(read('wrapped-share-cards.js'), /\/api\/proxy-image\?url=\$\{encodeURIComponent/, 'every cover goes through the proxy');
});
