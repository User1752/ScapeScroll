'use strict';

// The Wrapped tab (public/modules/ui-analytics-wrapped.js). The numbers come from the server and are tested there; here: the page draws
// them without letting a title become markup, says what the person must be told (a period that reaches before the detailed history,
// adult titles whose status is unknown), asks the server for what was chosen, and its buttons do what they say. The real utils.js (for
// escapeHtml) and the real module run in a vm sandbox; the server's own computeWrapped makes realistic input.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { computeWrapped } = require('../../server/modules/analytics/wrapped');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (f) => fs.readFileSync(path.join(MODULES, f), 'utf8');
// the locale files register themselves on window.ScrollScapeI18nLocales[<language>]
function locale(lang) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read(`i18n/locales/${lang}.js`), ctx);
  return ctx.window.ScrollScapeI18nLocales[lang];
}
const EN = locale('en-GB');

function sandbox({ settings = {}, stored = {} } = {}) {
  const store = { ...stored };
  const calls = [];
  const elements = new Map();
  const classes = new Set(['hidden']);
  elements.set('wrappedHiddenList', { classList: { toggle: (c) => (classes.has(c) ? classes.delete(c) : classes.add(c)) } });
  const context = {
    console, JSON, Number, String, Object, Array, Math, Date, URLSearchParams,
    state: { settings },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    document: { getElementById: (id) => elements.get(id) || null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    dbg: new Proxy({}, { get: () => () => {} }),
    currentLanguage: 'en-GB',
    t: (key) => EN[key] ?? key,
    api: async (url) => { calls.push(url); return { ok: true, wrapped: sandbox.next }; },
    $: () => null, showToast() {},
  };
  vm.createContext(context);
  vm.runInContext(read('utils.js'), context, { filename: 'utils.js' });
  context.t = (key) => EN[key] ?? key; // utils.js has none; the app's i18n supplies it
  vm.runInContext(read('ui-analytics-wrapped.js'), context, { filename: 'ui-analytics-wrapped.js' });
  return { ctx: context, store, calls, classes };
}

const NOW = new Date(2026, 9, 31, 16);
const ledger = {
  version: 1, since: '2026-07-09',
  manga: {
    '2026-10-31': { k1: { c: 3, m: 12, s: 2 }, evil: { c: 2, m: 4, s: 1 }, adult: { c: 4, m: 9, s: 2 } },
    '2026-10-30': { k1: { c: 2, m: 8, s: 1 } },
  },
  anime: { '2026-10-30': { 21: { e: 2, m: 44, s: 2 } } },
  titles: { manga: { k1: 'Kingdom', evil: '<img src=x onerror=PWN(1)>"\'', adult: 'Some Doujin' }, anime: { 21: 'ONE PIECE' } },
  meta: { manga: { k1: { cover: '/api/proxy-image?url=a', author: 'Hara Yasuhisa', genres: ['Action', 'Drama'] }, adult: { genres: ['Adult', 'Comedy'], nsfw: true } } },
};
const wrapped = (options = {}) => computeWrapped({
  analytics: { totalChaptersRead: 100, ledger, dailyChapterCounts: { '2026-05-13': 2, '2026-10-30': 4, '2026-10-31': 9 } },
  favorites: [], history: [], animeFavorites: [], readingStatus: {}, reviews: {}, nsfwOverrides: {},
}, { now: NOW, period: 'year', ...options });

test('the page draws the numbers, and a title can never become markup', () => {
  const { ctx } = sandbox();
  const html = ctx._wrappedHtml(wrapped());
  assert.match(html, /wrapped-hero-number">11<small>chapters read/);
  assert.ok(html.includes('Kingdom'));
  assert.ok(html.includes('ONE PIECE'));
  assert.ok(html.includes('Hara Yasuhisa'));
  assert.ok(!html.includes('<img src=x'), 'the hostile title is escaped');
  assert.ok(html.includes('&lt;img src=x onerror=PWN(1)&gt;'));
  // the names of the attributes only: the values (between quotes) may contain the escaped title, which can SAY onerror= harmlessly
  const attributeNames = html.replace(/="[^"]*"/g, '=""');
  assert.ok(!/<[a-z][^>]*\son[a-z]+=/i.test(attributeNames), 'no tag has an inline handler: the page uses delegated events');
  assert.match(html, /data-wrapped-action="hide" data-key="[a-z0-9]+" data-title="&lt;img/, 'the title in an attribute is escaped too');
  assert.match(html, /class="wrapped-rank wrapped-rank--1">1</);
});

test('a period that reaches before the detailed history says so, with the date; one inside it does not', () => {
  const { ctx } = sandbox();
  assert.match(ctx._wrappedHtml(wrapped({ period: 'year' })), /wrapped-notice">Which manga you read has only been recorded since 9 Jul 2026/);
  assert.ok(!ctx._wrappedHtml(wrapped({ period: 'week' })).includes('wrapped-notice'));
});

test('with adult titles hidden, the page says how many were hidden and warns about those it cannot know', () => {
  const { ctx } = sandbox({ stored: { scrollscape_wrapped_hide_nsfw: '1' } });
  ctx._wrappedLoadPrefs();
  const html = ctx._wrappedHtml(wrapped({ hideNsfw: true }));
  assert.ok(!html.includes('Some Doujin'), 'the adult title is not drawn');
  assert.match(html, /1 adult title\(s\) hidden\./);
  assert.match(html, /It is not known whether 2 of these titles are adult/, 'Kingdom and the hostile one have no answer recorded');
  assert.ok(!html.includes('>Adult<'), 'and the adult tag is not a genre');
});

test('an empty period shows a message, not a page of zeros', () => {
  const { ctx } = sandbox();
  const html = ctx._wrappedHtml(wrapped({ period: 'week', excludeTitles: ['kingdom', 'imgsrcxonerrorpwn1', 'somedoujin', 'onepiece'] }));
  assert.match(html, /wrapped-empty">Nothing read or watched in this period yet\./);
  assert.ok(!html.includes('wrapped-hero'));
});

test('what the page asks the server for: the period, the year, the choices, and what the person hid', () => {
  const { ctx } = sandbox({ settings: { hideNsfw: true, genreBlacklist: ['ecchi', 'harem'] }, stored: { scrollscape_wrapped_hidden: JSON.stringify({ somedoujin: 'Some Doujin' }), scrollscape_wrapped_period: 'month' } });
  ctx._wrappedLoadPrefs();
  const q = new URLSearchParams(ctx._wrappedQuery());
  assert.equal(q.get('period'), 'month');
  assert.equal(q.get('hideNsfw'), '1', 'the Hide NSFW setting is the default');
  assert.equal(q.get('excludeGenres'), 'ecchi,harem', 'and so is the genre blacklist');
  assert.equal(q.get('excludeTitles'), 'somedoujin');
  assert.equal(q.get('year'), null, 'a year only goes with the year period');
  assert.equal(q.get('top'), '10');
});

test('the person\'s own choice of adult titles wins over the setting, and is remembered', () => {
  const { ctx, store } = sandbox({ settings: { hideNsfw: true }, stored: { scrollscape_wrapped_hide_nsfw: '0' } });
  ctx._wrappedLoadPrefs();
  assert.equal(new URLSearchParams(ctx._wrappedQuery()).get('hideNsfw'), null);
  ctx.renderWrappedTab = () => {};
  ctx._wrappedAction({ wrappedAction: 'nsfw' }, true);
  assert.equal(store.scrollscape_wrapped_hide_nsfw, '1');
});

test('the buttons: period, year, hide a title, show it again, and a period that does not exist is ignored', () => {
  const { ctx, store } = sandbox();
  let renders = 0;
  ctx.renderWrappedTab = () => { renders++; };
  ctx._wrappedLoadPrefs();

  ctx._wrappedAction({ wrappedAction: 'period', period: 'week' });
  assert.equal(store.scrollscape_wrapped_period, 'week');
  ctx._wrappedAction({ wrappedAction: 'period', period: 'forever' });
  assert.equal(store.scrollscape_wrapped_period, 'week');
  assert.equal(renders, 1);

  ctx._wrappedAction({ wrappedAction: 'year' }, '2025');
  assert.equal(store.scrollscape_wrapped_year, '2025');
  ctx._wrappedAction({ wrappedAction: 'year' }, 'abc');
  assert.equal(store.scrollscape_wrapped_year, '2025');

  ctx._wrappedAction({ wrappedAction: 'hide', key: 'kingdom', title: 'Kingdom' });
  assert.deepEqual(JSON.parse(store.scrollscape_wrapped_hidden), { kingdom: 'Kingdom' });
  assert.match(ctx._wrappedHtml(wrapped()), /wrapped-hidden-list|Kingdom/);
  ctx._wrappedAction({ wrappedAction: 'hide' }); // no key: nothing
  assert.deepEqual(JSON.parse(store.scrollscape_wrapped_hidden), { kingdom: 'Kingdom' });
  ctx._wrappedAction({ wrappedAction: 'show', key: 'kingdom' });
  assert.deepEqual(JSON.parse(store.scrollscape_wrapped_hidden), {});
  assert.equal(renders, 4, 'period, year, hide and show each redraw once; the ignored ones do not');
});

test('the toolbar: a year selector appears only when there is more than one year, and hidden titles can be shown again', () => {
  const { ctx } = sandbox({ stored: { scrollscape_wrapped_hidden: JSON.stringify({ kingdom: 'Kingdom <b>' }) } });
  ctx._wrappedLoadPrefs();
  const data = wrapped();
  data.coverage.activityFrom = '2025-03-01';
  const withYears = ctx._wToolbarHtml(data);
  assert.match(withYears, /<select class="wrapped-year"[^>]*>.*<option value="2025">2025<\/option>/);
  assert.ok(withYears.includes('Hidden titles (1)'));
  assert.ok(withYears.includes('Kingdom &lt;b&gt;'), 'the name of a hidden title is escaped');
  assert.match(withYears, /data-wrapped-action="show" data-key="kingdom"/);
  assert.ok(!ctx._wToolbarHtml(wrapped()).includes('wrapped-year'), 'one year only: no selector');
});

test('every string the page uses exists in English and in Portuguese', () => {
  const src = read('ui-analytics-wrapped.js');
  const keys = new Set([...src.matchAll(/\b(?:t|_wt)\('((?:wrapped|analytics)\.[A-Za-z.]+)'/g)].map((m) => m[1]));
  for (const id of ['week', 'month', 'year', 'all']) keys.add(`wrapped.period.${id}`);
  keys.add('analytics.tabOverview'); keys.add('analytics.tabWrapped');
  assert.ok(keys.size > 30, `${keys.size} keys found`);
  for (const lang of ['en-GB', 'pt-PT']) {
    const table = locale(lang);
    const missing = [...keys].filter((k) => !table || typeof table[k] !== 'string' || !table[k]);
    assert.deepEqual(missing, [], `${lang} is missing ${missing.join(', ')}`);
  }
});

test('the tab is wired into the Analytics page: the buttons, both panels, the stylesheet and the script', () => {
  const html = fs.readFileSync(path.join(MODULES, '..', 'index.html'), 'utf8').replace(/\r\n/g, '\n');
  for (const id of ['analyticsTabs', 'analyticsOverview', 'analyticsWrapped']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(html, /data-analytics-tab="overview"/);
  assert.match(html, /data-analytics-tab="wrapped"/);
  assert.match(html, /css-modules\/analytics-wrapped\.css/);
  assert.match(html, /modules\/ui-analytics-wrapped\.js/);
  // the Overview content is inside its panel, and the Wrapped panel is outside it
  const overview = html.slice(html.indexOf('id="analyticsOverview"'), html.indexOf('id="analyticsWrapped"'));
  assert.ok(overview.includes('id="anaChapters"') && overview.includes('id="readingActivityHeatmap"'), 'the existing Analytics content moved into the Overview panel');
  assert.match(read('ui-analytics-view.js').replace(/\r\n/g, '\n'), /async function renderAnalyticsView\(\) \{\n {2}if \(typeof bindAnalyticsTabs === 'function'\) bindAnalyticsTabs\(\);/);
});
