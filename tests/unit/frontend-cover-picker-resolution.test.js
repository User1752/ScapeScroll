'use strict';

// The cover picker shows the real size of each image it offers (read from the image once it has loaded) and, for the web image search only, can leave
// out the ones too small for a cover. Nothing recompresses or resizes an image: what looks soft is an image that is small at its source, and this says so.
// The real file runs in a vm sandbox for the rule; the markup, the switch and the style are checked in the source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const read = (...p) => fs.readFileSync(path.join(PUBLIC, ...p), 'utf8').replace(/\r\n/g, '\n');

function loadPicker(extra = {}) {
  const ctx = { ...extra, console, window: {}, document: { addEventListener() {} }, localStorage: { getItem: () => null, setItem() {} }, state: {} };
  vm.createContext(ctx);
  vm.runInContext(read('modules', 'ui-cover-picker.js'), ctx, { filename: 'ui-cover-picker.js' });
  return ctx;
}

test('an image is small when it is too little for a cover card: under 460 x 726 (AniList\'s "large" cover)', () => {
  const { coverPickerIsSmall } = loadPicker();
  assert.equal(coverPickerIsSmall(720, 1020), false, 'a good cover');
  assert.equal(coverPickerIsSmall(460, 726), false, 'the limit itself is enough: a cover of exactly this size is the one the library already shows sharp');
  assert.equal(coverPickerIsSmall(459, 726), true);
  assert.equal(coverPickerIsSmall(460, 725), true);
  assert.equal(coverPickerIsSmall(230, 363), true, 'AniList\'s "medium" cover');
  assert.equal(coverPickerIsSmall(225, 320), true, 'the size of a source thumbnail');
  assert.equal(coverPickerIsSmall(236, 295), true, 'what a Pinterest thumbnail is');
  assert.equal(coverPickerIsSmall(1600, 900), false, 'big, whatever its shape');
  assert.equal(coverPickerIsSmall(0, 0), true, 'an image that did not load is not a good one');
  assert.equal(coverPickerIsSmall(undefined, NaN), true);
});

test('each card carries its size, and the switch is shown for the web search only, remembered, and on by default', () => {
  const src = read('modules', 'ui-cover-picker.js');
  assert.match(src, /<span class="cover-choice-res" aria-hidden="true"><\/span>/, 'a place for the size on every card');
  assert.match(src, /id="coverPickerLargeOnly"/);
  assert.match(src, /<label class="cover-picker-filter" id="coverPickerFilter" hidden>/, 'hidden until a web search');
  assert.match(src, /const web = pickerState\.mode === 'google';/, 'only the web search is filtered: the covers of the sources and AniList are what they are');
  assert.match(src, /localStorage\.getItem\(COVER_PICKER_LARGE_ONLY_KEY\) !== '0'/, 'on unless the person turned it off');
  assert.match(src, /localStorage\.setItem\(COVER_PICKER_LARGE_ONLY_KEY, largeOnlyBox\.checked \? '1' : '0'\)/);
  assert.match(src, /card\.querySelector\('\.cover-choice-res'\)\.textContent = `\$\{img\.naturalWidth\}×\$\{img\.naturalHeight\}`;/, 'the size is the image\'s own, not a guess');
  assert.match(src, /metaEl\.textContent = `Searching \$\{modeLabel\}[^\n]*\n\s*syncFilter\(\);/, 'every search sets the switch for its mode');
  assert.match(src, /hidden\)/, 'and says how many it left out');
});

test('a small image is marked, and only left out when the grid says so', () => {
  const css = read('css-modules', 'manga-details-page.css');
  assert.match(css, /\.cover-choice-thumb \{\s*position: relative;/);
  assert.match(css, /\.cover-choice-res \{[^}]*position: absolute;/);
  assert.match(css, /\.cover-choice-res:empty \{ display: none; \}/);
  assert.match(css, /\.cover-choice-card\.is-small \.cover-choice-res \{/);
  assert.match(css, /\.cover-picker-grid\.hide-small \.cover-choice-card\.is-small \{ display: none; \}/);
});

test('nothing on the way recompresses or resizes: an image is drawn from its own bytes at the card\'s size', () => {
  const css = read('css-modules', 'manga-details-page.css');
  const thumb = css.slice(css.indexOf('.cover-choice-thumb img {'), css.indexOf('}', css.indexOf('.cover-choice-thumb img {')));
  assert.doesNotMatch(thumb, /filter|blur|image-rendering/, 'no style softens it');
  const utils = read('modules', 'utils.js');
  assert.doesNotMatch(utils, /canvas|toDataURL|toBlob/, 'and nothing redraws it');
});

// ── the countdown of the paused web search ──────────────────────────────────

// Enough of a page for coverLimitedMessage: a grid whose innerHTML makes a timer element inside a paragraph, and a clock the test drives by hand.
function fakeGrid() {
  const paragraph = { textContent: '' };
  const timer = { textContent: '', isConnected: true, closest: () => paragraph };
  return { paragraph, timer, html: '', set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; }, querySelector: () => timer };
}

test('a known wait is shown as a clock that runs down by itself', () => {
  const ticks = [];
  const { coverLimitedMessage } = loadPicker({ setInterval: (fn) => { ticks.push(fn); return 1; }, clearInterval() {} });
  const grid = fakeGrid();
  coverLimitedMessage(grid, 90_000);
  assert.match(grid.innerHTML, /class="cover-limit-timer"/);
  assert.match(grid.innerHTML, /If Brave still says no then, the wait grows/);
  assert.equal(grid.timer.textContent, '1:30');
  assert.equal(ticks.length, 1, 'one timer, ticking every second');

  const long = fakeGrid();
  coverLimitedMessage(long, 3_700_000);
  assert.equal(long.timer.textContent, '1:01:40', 'over an hour: h:mm:ss');
});

test('with no wait known the old words are kept', () => {
  const { coverLimitedMessage } = loadPicker({ setInterval: () => { throw new Error('no timer needed'); } });
  for (const none of [0, undefined, null, NaN, -5]) {
    const grid = fakeGrid();
    coverLimitedMessage(grid, none);
    assert.match(grid.innerHTML, /The web image search is being limited right now\. Try again in a few minutes\./);
  }
});

test('the countdown stops when its message was replaced, and says so when it runs out', async () => {
  const ticks = [];
  const cleared = [];
  const { coverLimitedMessage } = loadPicker({ setInterval: (fn) => { ticks.push(fn); return ticks.length; }, clearInterval: (id) => cleared.push(id) });

  const replaced = fakeGrid();
  coverLimitedMessage(replaced, 60_000);
  replaced.timer.isConnected = false; // a new search drew the grid again, or the picker closed
  ticks[0]();
  assert.deepEqual(cleared, [1], 'the interval is cleared, nothing keeps running');

  const ending = fakeGrid();
  coverLimitedMessage(ending, 30);
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  ticks[1]();
  assert.match(ending.paragraph.textContent, /The pause is over\. Press "Search Brave Images" to try again\./);
  assert.deepEqual(cleared, [1, 2]);
});
