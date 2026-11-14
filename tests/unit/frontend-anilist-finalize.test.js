'use strict';

// The AniList tracker must not say "read everything". anilistFinalizeCurrentChapterProgress() runs when a reading session ends AND on
// every pagehide / visibilitychange (ui-ui-binding.js), so it also runs for a person who only has a manga's details page open. It used to
// take the chapter number from state.allChapters[state.currentChapterIndex] without asking whether that chapter is the one open in the
// reader: currentChapterIndex starts at 0 and is only set when a chapter is loaded, and allChapters is replaced by the list of whatever
// manga was opened last, so index 0 of a newest-first list is the LATEST chapter, and switching tabs wrote it to AniList as progress
// ("Read chapter 16 - 728", seen on a real account). The real public/modules/anilist.js runs in a vm sandbox; the reconcile step is
// replaced by a recorder, so nothing talks to AniList.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'modules', 'anilist.js'), 'utf8');

// Newest first, the way a source lists them: index 0 is the latest chapter.
const chaptersNewestFirst = (latest) => Array.from({ length: latest }, (_, i) => ({ id: `ch-${latest - i}`, chapter: String(latest - i) }));

function setup(stateOverrides = {}) {
  const store = { scrollscape_anilist_token: 'token' };
  const state = {
    settings: { anilistAutoSync: true },
    favorites: [],
    highestReadChapter: {},
    currentManga: { id: 'bleach', title: 'BLEACH' },
    allChapters: chaptersNewestFirst(728),
    currentChapterIndex: 0, // what state.js starts with, and what is left over from the last chapter that was loaded
    currentChapter: null,
    incognitoReading: false,
    ...stateOverrides,
  };
  const context = {
    console, state, setTimeout, clearTimeout, fetch: () => { throw new Error('no network in this test'); },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    dbg: new Proxy({}, { get: () => () => {} }),
    window: { addEventListener() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    api: async () => ({}), $: () => null, escapeHtml: (s) => s, showToast() {},
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'anilist.js' });
  const calls = [];
  context._reconcileAniListProgress = async (args) => { calls.push(args); return { ok: true }; };
  return { context, state, calls };
}

test('a details page with no chapter open does not send the latest chapter as progress (the reported bug)', async () => {
  const { context, calls } = setup({ highestReadChapter: { bleach: 15 } });
  await context.anilistFinalizeCurrentChapterProgress();
  assert.deepEqual(calls, [], `sent ${JSON.stringify(calls.map((c) => c.localProgressCandidate))}: with no chapter open nothing was read now`);
});

test('with nothing read and nothing open there is nothing to send at all', async () => {
  const { context, calls } = setup({ highestReadChapter: {} });
  await context.anilistFinalizeCurrentChapterProgress();
  assert.deepEqual(calls, []);
});

test('a chapter left open from ANOTHER manga does not count for the manga whose page is open now', async () => {
  const { context, calls } = setup({
    highestReadChapter: { bleach: 15 },
    currentChapter: { id: 'wangan-9', mangaId: 'wangan-midnight' },
    currentChapterIndex: 0,
  });
  await context.anilistFinalizeCurrentChapterProgress();
  assert.deepEqual(calls, [], JSON.stringify(calls.map((c) => c.localProgressCandidate)));
});

test('a chapter that really is open in the reader for this manga is still what finalizes the session', async () => {
  // chapter 16 is at index 728 - 16 = 712 of a newest-first list of 728
  const { context, calls } = setup({
    currentChapterIndex: 712,
    currentChapter: { id: 'ch-16', mangaId: 'bleach' },
    highestReadChapter: { bleach: 15 },
  });
  await context.anilistFinalizeCurrentChapterProgress();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].localProgressCandidate, 16);
  assert.equal(calls[0].mangaId, 'bleach');
});

test('the highest chapter the library has kept is NOT sent, even when it is higher than the one open (it can be wrong)', async () => {
  const { context, calls } = setup({ currentChapterIndex: 712, currentChapter: { id: 'ch-16', mangaId: 'bleach' }, highestReadChapter: { bleach: 728 } });
  await context.anilistFinalizeCurrentChapterProgress();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].localProgressCandidate, 16, 'only the chapter that is open: "Read chapter 16 - 728" came from sending the kept number');
});

test('incognito reading leaves nothing for AniList, also when the page is hidden', async () => {
  const { context, calls } = setup({ incognitoReading: true, currentChapterIndex: 712, currentChapter: { id: 'ch-16', mangaId: 'bleach' }, highestReadChapter: { bleach: 20 } });
  await context.anilistFinalizeCurrentChapterProgress();
  assert.deepEqual(calls, []);
});

test('no token or auto-sync switched off: nothing is sent, as before', async () => {
  const off = setup({ settings: { anilistAutoSync: false }, currentChapterIndex: 712, currentChapter: { id: 'ch-16', mangaId: 'bleach' } });
  await off.context.anilistFinalizeCurrentChapterProgress();
  assert.deepEqual(off.calls, []);
});

test('loadChapter marks the chapter it opens with the manga it belongs to, which is what the check above relies on', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'modules', 'ui-add-to-list-modal.js'), 'utf8');
  assert.match(source, /state\.currentChapter\.mangaId\s*=\s*state\.currentManga/);
});
