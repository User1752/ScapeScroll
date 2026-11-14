'use strict';

// The date a site prints beside a chapter (server/modules/source-import/chapter-dates.js, measure.js), and the two templates that use it. What matters: a date is
// read in the main languages of manga sites, a relative time is counted only for seconds to days, a numeric date is read in the order measured on the site, a date
// that cannot be read (or is in the future, or does not exist) is null and never invented, and the measurement of a site's order is decided by what it printed.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const { parseChapterDate, detectDateOrder, isRelativeDate, fold } = require('../../server/modules/source-import/chapter-dates');
const { chapterDateTexts, pageLanguage, dateOrderOf, titlePageOf, titleLinksFrom, hasMadaraChapters } = require('../../server/modules/source-import/generator/measure');
const { buildSource } = require('../../server/modules/source-import/generator');
const fetchUtils = require('../../server/modules/network/fetch-utils');

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const at = (text, order = 'dmy') => parseChapterDate(text, { order, now: NOW });

test('relative times in the main languages count seconds, minutes, hours and days; a week or more is not a publication date', () => {
  const day = (n) => new Date(NOW - n * 86_400_000).toISOString();
  const hour = (n) => new Date(NOW - n * 3_600_000).toISOString();
  const cases = [
    ['3 days ago', day(3)], ['1 day ago', day(1)], ['a day ago', day(1)], ['5 hours ago', hour(5)], ['10 mins ago', new Date(NOW - 600_000).toISOString()], ['30 seconds ago', new Date(NOW - 30_000).toISOString()],
    ['há 2 horas', hour(2)], ['2 dias atrás', day(2)], ['hace 5 minutos', new Date(NOW - 300_000).toISOString()], ['hace 3 días', day(3)],
    ['il y a 3 jours', day(3)], ['il y a 4 heures', hour(4)], ['vor 4 Tagen', day(4)], ['vor 2 Stunden', hour(2)], ['3 giorni fa', day(3)], ['2 ore fa', hour(2)],
    ['2 hari yang lalu', day(2)], ['5 jam yang lalu', hour(5)], ['3 gün önce', day(3)], ['4 saat önce', hour(4)],
  ];
  for (const [text, want] of cases) assert.equal(at(text), want, text);
  for (const coarse of ['2 weeks ago', '3 months ago', 'a year ago', 'hace 2 semanas', 'há 3 meses', 'il y a 2 ans', 'vor 3 Wochen', '2 minggu yang lalu', '3 ay önce']) assert.equal(at(coarse), null, coarse);
  assert.equal(isRelativeDate('3 days ago') && isRelativeDate('há 2 horas') && isRelativeDate('hace 3 días'), true);
  assert.equal(isRelativeDate('Mar 4, 2026') || isRelativeDate('04/03/2026') || isRelativeDate('4 de março de 2026'), false, 'a date that is only a day is not a relative time');
});

test('absolute dates: named months in the main languages, in either order; numeric dates in the order measured; a year first is a year first', () => {
  const march4 = '2026-03-04T00:00:00.000Z';
  for (const text of ['Mar 4, 2026', 'March 4, 2026', 'March 4th, 2026', '4 March 2026', '4 de março de 2026', '4 de marzo de 2026', '4 mars 2026', '4. März 2026', '4 marzo 2026', '4 Maret 2026', '4 Mart 2026', 'mar 4 2026', '2026-03-04', '2026/03/04', '4-3-2026'.replace('4-3', '04-03')]) assert.equal(at(text), march4, text);
  assert.equal(at('04/03/2026', 'dmy'), march4);
  assert.equal(at('03/04/2026', 'mdy'), march4);
  assert.equal(at('04.03.2026', 'dmy'), march4);
  assert.equal(at('4/3/26', 'dmy'), march4, 'a two-digit year is this century');
  assert.equal(at('13/03/2026', 'mdy'), '2026-03-13T00:00:00.000Z', 'a day above 12 settles it whatever the order says');
  assert.equal(at('03/13/2026', 'dmy'), '2026-03-13T00:00:00.000Z');
  assert.equal(at('2026-03-04T05:06:07.000Z'), '2026-03-04T05:06:07.000Z', 'a full ISO time is kept');
  assert.equal(at('  MARÇO 4, 2026 '), march4, 'case and accents do not matter');
});

test('what cannot be read, does not exist or is in the future is null, never invented', () => {
  for (const bad of ['', '   ', null, undefined, 'tomorrow', 'soon', 'Upcoming', '31/02/2026', '32/01/2026', '00/00/2026', '1850-01-01', '12/2026', 'Mar 2026', 'garbage 4, 2026', 'x'.repeat(80), '2999-01-01', '01/01/2999', 'Dec 25, 2026']) assert.equal(at(bad), null, JSON.stringify(bad));
  assert.equal(parseChapterDate('Jun 3, 2026', { now: NOW }), '2026-06-03T00:00:00.000Z', 'two days ahead is clock skew, not the future');
  assert.equal(parseChapterDate('Jun 4, 2026', { now: NOW }), null);
  assert.equal(fold('  Março  GÜN '), 'marco gun');
});

test('the order of a site\'s numeric dates is settled by a part above 12, then by the language of the page', () => {
  assert.equal(detectDateOrder(['13/03/2026', '01/02/2026']), 'dmy');
  assert.equal(detectDateOrder(['03/13/2026']), 'mdy');
  assert.equal(detectDateOrder(['2026/03/04', '2026/03/13']), 'ymd');
  assert.equal(detectDateOrder(['01/02/2026', '03/04/2026'], 'en'), 'mdy');
  assert.equal(detectDateOrder(['01/02/2026'], 'en-US'), 'mdy');
  assert.equal(detectDateOrder(['01/02/2026'], 'en-GB'), 'dmy');
  assert.equal(detectDateOrder(['01/02/2026'], 'pt-BR'), 'dmy');
  assert.equal(detectDateOrder(['Mar 4, 2026', '3 days ago'], 'fr'), 'dmy');
  assert.equal(detectDateOrder([], ''), 'dmy');
  assert.equal(detectDateOrder(['13/03/2026', '03/13/2026'], 'en'), 'mdy', 'a tie goes to the language');
  assert.equal(detectDateOrder(null), 'dmy');
});

test('the dates of a page are read by the theme\'s own selector, in memory, and the order is measured from them and the page\'s language', () => {
  const madara = '<html lang="pt-BR"><body><li class="wp-manga-chapter"><span class="chapter-release-date"><i>13/03/2026</i></span></li><li class="wp-manga-chapter"><span class="chapter-release-date"> 01/02/2026 </span></li></body></html>';
  assert.deepEqual(chapterDateTexts('madara', madara), ['13/03/2026', '01/02/2026']);
  assert.deepEqual(chapterDateTexts('mangathemesia', '<li><span class="chapterdate">October 1, 2025</span></li>'), ['October 1, 2025']);
  assert.deepEqual(chapterDateTexts('iken', madara), []);
  assert.equal(pageLanguage(madara), 'pt-BR');
  assert.equal(pageLanguage('<html><body></body></html>'), '');
  assert.equal(dateOrderOf('madara', madara, madara), 'dmy');
  assert.equal(dateOrderOf('madara', '<span class="chapter-release-date">01/02/2026</span>', '<html lang="en-US">'), 'mdy');
  assert.equal(titlePageOf('https://x.example/series/a-title/chapter-3/'), 'https://x.example/series/a-title/');
  assert.equal(titlePageOf('https://x.example/series/a-title'), 'https://x.example/series/a-title/');
  for (const none of ['https://x.example/', 'https://x.example/only', 'not a url', '', undefined]) assert.equal(titlePageOf(none), '', String(none));
});

test('the titles on a list page are same-origin /folder/slug/ links, each once, in the page\'s order, up to a limit', () => {
  const html = '<a href="/manga/a/">A</a><a href="https://x.example/manga/b">B</a><a href="/manga/a/">again</a><a href="/manga/c/chapter-1/">chapter</a><a href="/manga/">list</a><a href="https://other.example/manga/z/">z</a><a href="/series/q/">q</a><a href="/manga/d/?x=1">d</a><a href="#top">top</a><a href=\'/manga/e/\'>e</a>';
  assert.deepEqual(titleLinksFrom(html, 'https://x.example', 'manga'), ['https://x.example/manga/a/', 'https://x.example/manga/b/', 'https://x.example/manga/e/']);
  assert.deepEqual(titleLinksFrom(html, 'https://x.example', 'series'), ['https://x.example/series/q/']);
  assert.equal(titleLinksFrom(html, 'https://x.example', 'manga', 2).length, 2);
  for (const none of ['', undefined, null]) assert.deepEqual(titleLinksFrom(none, 'https://x.example', 'manga'), []);
  assert.deepEqual(titleLinksFrom(html, 'not a url', 'manga'), []);
});

test('a page lists chapters only when it has the elements of the list: a page that mentions the class in a style or a script does not', () => {
  assert.equal(hasMadaraChapters('<ul><li class="wp-manga-chapter free"><a>1</a></li></ul>'), true);
  assert.equal(hasMadaraChapters('<style>.wp-manga-chapter{color:red}</style><script>var c = "wp-manga-chapter";</script><div class="wp-manga-chapter-x"></div>'), false);
  assert.equal(hasMadaraChapters('<div class="wp-manga-chapter"></div>'), false, 'a list item, not any element');
  for (const none of ['', undefined, null]) assert.equal(hasMadaraChapters(none), false);
});

// ── the templates ─────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, '..', '..');
const BASE = 'https://datas.example';

function load(code, { pages = {}, posts = {} } = {}) {
  const real = fetchUtils.fetchText;
  const realSafe = require('../../server/modules/network/safe-fetch');
  const realSafeFetch = realSafe.safeFetch;
  fetchUtils.fetchText = async (url) => { const hit = pages[url]; if (hit === undefined) throw new Error('HTTP 404'); return hit; };
  realSafe.safeFetch = async (url) => { const body = posts[url]; return new Response(body === undefined ? 'no' : body, { status: body === undefined ? 404 : 200 }); };
  try {
    const file = path.join(ROOT, 'data', 'sources', '__dates_test__.js');
    const mod = new Module(file, null);
    mod.filename = file;
    mod.paths = Module._nodeModulePaths(path.dirname(file));
    mod._compile(code, file);
    return mod.exports;
  } finally {
    fetchUtils.fetchText = real;
    realSafe.safeFetch = realSafeFetch;
  }
}

const madaraTitle = (rows) => `<html><body><div class="post-title"><h1>T</h1></div><ul>${rows}</ul></body></html>`;
const madaraRow = (n, date) => `<li class="wp-manga-chapter"><a href="${BASE}/manga/t/chapter-${n}/">Chapter ${n}</a><span class="chapter-release-date"><i>${date}</i></span></li>`;

test('a Madara source reads the dates in the language and the order of the site it was written for, and a date it cannot read is null', async () => {
  const rows = madaraRow(4, 'há 2 horas') + madaraRow(3, '13/03/2026') + madaraRow(2, '01/02/2026') + madaraRow(1, 'semana passada');
  const pt = load(buildSource({ engine: 'madara', base: BASE, name: 'Datas', genres: [], dateOrder: 'dmy' }).code, { pages: { [`${BASE}/manga/t/`]: madaraTitle(rows) } });
  const { chapters } = await pt.chapters('t');
  assert.ok(Date.now() - Date.parse(chapters[0].publishAt) < 3 * 3_600_000, 'a relative time in Portuguese');
  assert.equal(chapters[1].publishAt, '2026-03-13T00:00:00.000Z');
  assert.equal(chapters[2].publishAt, '2026-02-01T00:00:00.000Z', 'day first');
  assert.equal(chapters[3].publishAt, null, 'words it does not know are null');
  const us = load(buildSource({ engine: 'madara', base: BASE, name: 'Datas', genres: [] }).code, { pages: { [`${BASE}/manga/t/`]: madaraTitle(madaraRow(2, '01/02/2026') + madaraRow(1, 'Mar 4, 2026')) } });
  assert.equal((await us.chapters('t')).chapters[0].publishAt, '2026-01-02T00:00:00.000Z', 'month first when nothing was measured (what Date.parse did)');
  assert.equal(buildSource({ engine: 'madara', base: BASE, name: 'Datas', genres: [], dateOrder: 'x"; evil(); "' }).dateOrder, 'mdy', 'only the three orders are written into a file');
});

test('a MangaThemesia source reads the printed dates the same way', async () => {
  const row = (n, d) => `<li><div class="chbox"><div class="eph-num"><a href="${BASE}/t-chapter-${n}/"><span class="chapternum">Chapter ${n}</span><span class="chapterdate">${d}</span></a></div></div></li>`;
  const title = `<html><body><h1 class="entry-title">T</h1><div id="chapterlist"><ul>${row(2, '13 de março de 2026')}${row(1, '01/02/2026')}</ul></div></body></html>`;
  const source = load(buildSource({ engine: 'mangathemesia', base: BASE, name: 'Datas', genres: [], dateOrder: 'dmy' }).code, { pages: { [`${BASE}/manga/t/`]: title } });
  const { chapters } = await source.chapters('t');
  assert.deepEqual(chapters.map((c) => c.publishAt), ['2026-03-13T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
});
