'use strict';

// The webtoon reader is one long scroll, so the "page" it remembers is the image at the top of the view. It used to write 0 whatever the scroll (a manga read
// in webtoon mode never kept its place), and a chapter opened from the chapter list always began at the top. reader-position.js holds the two decisions as
// pure functions; the rest of the file checks that the reader really uses them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', ...p), 'utf8').replace(/\r\n/g, '\n');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(read('modules', 'reader-position.js'), ctx, { filename: 'reader-position.js' });
const { webtoonPageAtTop, chapterStartPage } = ctx;

const strip = (tops) => tops.map((top, idx) => ({ idx, top }));

test('the image being read is the last one whose top has reached the top of the view', () => {
  // five images 1000 px tall, the view's top edge at y = 100
  assert.equal(webtoonPageAtTop(strip([100, 1100, 2100, 3100, 4100]), 100), 0, 'at the start');
  assert.equal(webtoonPageAtTop(strip([-950, 50, 1050, 2050, 3050]), 100), 1, 'the second image has just passed the top');
  assert.equal(webtoonPageAtTop(strip([-2400, -1400, -400, 600, 1600]), 100), 2, 'the third is the one across the top of the view');
  assert.equal(webtoonPageAtTop(strip([-4100, -3100, -2100, -1100, -100]), 100), 4, 'the last');
});

test('an image whose top edge is a few pixels below the line already counts, and one well below does not', () => {
  assert.equal(webtoonPageAtTop(strip([-900, 110]), 100), 1, '10 px below the line: slack');
  assert.equal(webtoonPageAtTop(strip([-900, 400]), 100), 0, '300 px below: not yet');
});

test('the image\'s own number is reported, not its place in the list (an image without a source is not drawn but keeps its number)', () => {
  // pages 0 and 2 were drawn; page 1 had no image
  assert.equal(webtoonPageAtTop([{ idx: 0, top: -500 }, { idx: 2, top: 50 }], 100), 2);
});

test('nothing to look at gives the first page, and a view above everything gives the first image', () => {
  assert.equal(webtoonPageAtTop([], 100), 0);
  assert.equal(webtoonPageAtTop(undefined, 100), 0);
  assert.equal(webtoonPageAtTop(strip([900, 1900]), 100), 0);
});

test('a chapter opened from the list resumes only if it is the one the manga was left in, and not finished', () => {
  assert.equal(chapterStartPage({ saved: 12, total: 40, isLastRead: true }), 12);
  assert.equal(chapterStartPage({ saved: 12, total: 40, isLastRead: false }), 0, 'another chapter starts at the top');
  assert.equal(chapterStartPage({ saved: 39, total: 40, isLastRead: true }), 0, 'the last page was reached: a chapter read to the end starts again');
  assert.equal(chapterStartPage({ saved: 38, total: 40, isLastRead: true }), 38, 'one page short of the end still resumes');
  assert.equal(chapterStartPage({ saved: 0, total: 40, isLastRead: true }), 0);
});

test('a missing or odd saved value starts at the top, and an unknown total still resumes', () => {
  for (const saved of [undefined, null, NaN, -3, 'x']) assert.equal(chapterStartPage({ saved, total: 40, isLastRead: true }), 0);
  assert.equal(chapterStartPage({ saved: 7.9, total: 40, isLastRead: true }), 7);
  assert.equal(chapterStartPage({ saved: 7, total: undefined, isLastRead: true }), 7);
  assert.equal(chapterStartPage({ saved: 7, total: 0, isLastRead: true }), 7);
});

// ── the reader uses them ────────────────────────────────────────────────────

test('the webtoon draw numbers its images, tracks the scroll, restores the saved place, and never stores 0 over it', () => {
  const src = read('modules', 'ui-reader-page-rendering.js');
  assert.match(src, /class="webtoon-page" data-idx="\$\{pages\.indexOf\(p\)\}"/, 'each image carries its own number');
  assert.match(src, /_bindWebtoonProgress\(pageWrap\);/);
  assert.match(src, /_restoreWebtoonPosition\(pageWrap, idx\);/);
  const webtoon = src.slice(src.indexOf('if (mode === "webtoon") {'), src.indexOf('} else if (mode === "rtl") {'));
  assert.doesNotMatch(webtoon, /updateReadingProgress\([^)]*, 0\)/, 'the draw stores the place it opened at, not 0');
  assert.match(webtoon, /updateReadingProgress\(state\.currentManga\?\.id, state\.currentChapter\?\.id, idx\);/);
  assert.match(src, /webtoonPageAtTop\(/);
  assert.match(src, /_unbindWebtoonProgress\(\);\n\}/, 'leaving the webtoon view stops the tracking');
});

test('the position is not written while it is being restored, and a hand on the scroll ends the restore', () => {
  const src = read('modules', 'ui-reader-page-rendering.js');
  assert.match(src, /if \(_webtoonRestoring \|\| _webtoonProgressFrame\) return;/);
  for (const type of ['wheel', 'touchstart', 'pointerdown']) assert.ok(src.includes(`"${type}"`), type);
  assert.match(src, /Promise\.race\(\[Promise\.all\(sized\), patience\]\)/, 'it waits for the images above the target, but not forever');
});

test('a chapter opened from the chapter list starts at the saved page (both ways to open it)', () => {
  const src = read('modules', 'ui-add-to-list-modal.js');
  assert.equal((src.match(/_chapterListStartPage\(/g) || []).length, 3, 'defined once and used by the double click and the open button');
  assert.match(src, /parseInt\(el\.dataset\.chapterIndex\),\n\s+_chapterListStartPage\(el\.dataset\.chapterId\)/);
  assert.match(src, /parseInt\(btn\.dataset\.chapterIndex\),\n\s+_chapterListStartPage\(btn\.dataset\.chapterId\)/);
  assert.match(src, /if \(!mangaId \|\| state\.incognitoReading\) return 0;/, 'incognito never resumes');
});

test('the module is loaded by the page, before the reader that uses it', () => {
  const html = read('index.html');
  const a = html.indexOf('modules/reader-position.js');
  const b = html.indexOf('modules/ui-reader-page-rendering.js');
  assert.ok(a > 0 && b > a);
});
