'use strict';

// What the AniList sync may do to a library, after a real account ended up with "Kingdom" (300 chapters read, 963 listed) marked as read
// in full and every title moved to Reading:
//  - saving a progress used to send `status: CURRENT`, which moved Planning/Paused/Dropped/Completed titles to Reading;
//  - the automatic sync (every app open, every chapter) copied a HIGHER number from AniList down into the library, marking every chapter
//    up to it as read, so one wrong value on AniList rewrote the library;
//  - the progress repair used highestReadChapter (a chapter number) as a count of chapters to mark.
// The real files run in a vm sandbox; the only thing replaced is the call to AniList, which records what it is asked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (f) => fs.readFileSync(path.join(MODULES, f), 'utf8');

function sandbox(stateOverrides = {}) {
  const store = { scrollscape_anilist_token: 'token' };
  const state = {
    settings: { anilistAutoSync: true },
    favorites: [],
    highestReadChapter: {},
    lastReadChapter: {},
    lastReadPages: {},
    readChapters: new Set(),
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
  for (const file of ['anilist.js', 'anilist-anime-sync.js', 'ui-add-to-list-modal.js']) {
    vm.runInContext(read(file), context, { filename: file });
  }
  return { context, state, store };
}

// AniList as a recorder: `entry` is what the title has there (null = no entry), `writes` collects every mutation.
function fakeAniList(context, entry) {
  const writes = [];
  context.anilistGQL = async (query, variables) => {
    if (/SaveMediaListEntry/.test(query)) { writes.push({ query, variables }); return { data: { SaveMediaListEntry: { id: 1 } } }; }
    return { data: { Media: { mediaListEntry: entry } } };
  };
  context._resolveAniListMediaIdForManga = async () => 46765;
  return writes;
}

const reconcile = (context, localProgressCandidate) => context._reconcileAniListProgress({ mangaId: 'kingdom', mangaTitle: 'Kingdom', sourceId: 'comizy', localProgressCandidate });

test('progress written for a title that has an entry does not carry a status, so its status stays', async () => {
  const { context } = sandbox();
  const writes = fakeAniList(context, { progress: 100, status: 'PLANNING' });
  await reconcile(context, 150);
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0].query, /status/i, 'a status in the mutation moves Planning/Paused/Dropped/Completed to Reading');
  assert.equal(writes[0].variables.p, 150);
});

test('a title with no entry yet is created as CURRENT', async () => {
  const { context } = sandbox();
  const writes = fakeAniList(context, null);
  await reconcile(context, 12);
  assert.equal(writes.length, 1);
  assert.match(writes[0].query, /status: CURRENT/);
});

test('a higher number on AniList is not copied into the library, and nothing is written back', async () => {
  const { context, state } = sandbox({ highestReadChapter: { kingdom: 300 } });
  const writes = fakeAniList(context, { progress: 963, status: 'CURRENT' });
  let pulled = 0;
  context._syncTrackerProgressToLocal = async () => { pulled++; return { updated: 1 }; };
  const result = await reconcile(context, 300);
  assert.equal(pulled, 0, 'the library was rewritten from AniList');
  assert.deepEqual(writes, [], 'a lower local number must not lower AniList either');
  assert.equal(state.highestReadChapter.kingdom, 300);
  assert.equal(result.ok, true);
});

test('equal numbers write nothing', async () => {
  const { context } = sandbox({ highestReadChapter: { kingdom: 300 } });
  const writes = fakeAniList(context, { progress: 300, status: 'CURRENT' });
  await reconcile(context, 300);
  assert.deepEqual(writes, []);
});

test('the startup sync goes through the same rule: a library with AniList numbers far ahead is left as it is', async () => {
  const { context, state } = sandbox({
    favorites: [{ id: 'kingdom', title: 'Kingdom', sourceId: 'comizy', anilistId: '46765' }],
    highestReadChapter: { kingdom: 300 },
  });
  const writes = fakeAniList(context, { progress: 963, status: 'CURRENT' });
  let pulled = 0;
  context._syncTrackerProgressToLocal = async () => { pulled++; return { updated: 1 }; };
  context._sleep = async () => {};
  await context.anilistStartupReconcileProgress();
  assert.equal(pulled, 0);
  assert.deepEqual(writes, []);
  assert.equal(state.highestReadChapter.kingdom, 300);
});

// ── the library's own numbers are never what goes to AniList (the Kingdom 343 -> 916 overwrite) ──────────────────────────────

test('opening the app does not write the number the library has kept over what was put back on AniList by hand', async () => {
  // the library says 916 (wrong: an old sync marked everything), the person corrected AniList to 343
  const { context } = sandbox({
    favorites: [{ id: 'kingdom', title: 'Kingdom', sourceId: 'comizy', anilistId: '46765' }],
    highestReadChapter: { kingdom: 916 },
    readChapters: new Set(Array.from({ length: 914 }, (_, i) => `kingdom:c${i}`)),
  });
  const writes = fakeAniList(context, { progress: 343, status: 'CURRENT' });
  context._sleep = async () => {};
  await context.anilistStartupReconcileProgress();
  assert.deepEqual(writes, [], 'nothing was read now, so nothing goes up');
});

test('a reconcile uses the chapter read now and ignores the highest the library kept', async () => {
  const { context } = sandbox({ highestReadChapter: { kingdom: 916 } });
  const writes = fakeAniList(context, { progress: 343, status: 'CURRENT' });
  await reconcile(context, 344);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].variables.p, 344, 'not 916');
  const none = fakeAniList(context, { progress: 343, status: 'CURRENT' });
  await reconcile(context, 0);
  assert.deepEqual(none, [], 'no chapter read now: nothing to send, whatever the library kept');
});

test('a push that could not be sent waits, and the next start sends it again (and only it)', async () => {
  const { context, store } = sandbox({
    favorites: [
      { id: 'kingdom', title: 'Kingdom', sourceId: 'comizy', anilistId: '46765' },
      { id: 'bleach', title: 'Bleach', sourceId: 'src', anilistId: '30' },
    ],
    highestReadChapter: { kingdom: 916, bleach: 728 },
  });
  context._resolveAniListMediaIdForManga = async () => 46765;
  context.anilistGQL = async () => { throw new Error('offline'); };
  await assert.rejects(() => reconcile(context, 350), /offline/);
  assert.deepEqual(JSON.parse(store.scrollscape_al_pending_push), { kingdom: { mangaTitle: 'Kingdom', sourceId: 'comizy', progress: 350 } });

  const writes = fakeAniList(context, { progress: 343, status: 'CURRENT' });
  context._sleep = async () => {};
  await context.anilistStartupReconcileProgress();
  assert.equal(writes.length, 1, 'only the one that was waiting, not Bleach nor the kept 916');
  assert.equal(writes[0].variables.p, 350);
  assert.equal(store.scrollscape_al_pending_push, undefined, 'and it does not wait any more');
});

test('a waiting push keeps the highest number that failed, and is dropped when AniList is already ahead', async () => {
  const { context, store } = sandbox();
  context._resolveAniListMediaIdForManga = async () => 1;
  context.anilistGQL = async () => { throw new Error('429'); };
  await assert.rejects(() => reconcile(context, 350));
  await assert.rejects(() => reconcile(context, 340));
  assert.equal(JSON.parse(store.scrollscape_al_pending_push).kingdom.progress, 350);
  fakeAniList(context, { progress: 400, status: 'CURRENT' });
  await reconcile(context, 350);
  assert.equal(store.scrollscape_al_pending_push, undefined);
});

test('the anime sync also leaves the status alone for a title that has an entry, and creates a new one as CURRENT', async () => {
  const { context } = sandbox();
  let writes = fakeAniList(context, { progress: 3, status: 'PAUSED' });
  await context.anilistReconcileAnimeProgress({ anilistId: 1, localEpisode: 8 });
  assert.equal(writes.length, 1);
  assert.doesNotMatch(writes[0].query, /status/i);

  writes = fakeAniList(context, null);
  await context.anilistReconcileAnimeProgress({ anilistId: 1, localEpisode: 2 });
  assert.match(writes[0].query, /status: CURRENT/);
});

// ── the repair of the chapter progress ──────────────────────────────────────

const chapters = (n) => Array.from({ length: n }, (_, i) => ({ id: `new-${i + 1}`, chapter: String(i + 1) }));

test('repair: a number in highestReadChapter is not a count, so it marks nothing when no chapter is marked', () => {
  const { context, state } = sandbox({
    highestReadChapter: { kingdom: 963 },
    lastReadChapter: { kingdom: 'old-id-that-is-gone' },
  });
  context._repairMangaChapterProgressIfNeeded('kingdom', chapters(963));
  assert.equal([...state.readChapters].length, 0, 'chapters were marked from a chapter number');
  assert.equal(state.highestReadChapter.kingdom, 963, 'the number itself is left alone');
  assert.equal(state.lastReadChapter.kingdom, undefined, 'only the dangling last-read id is dropped');
});

test('repair: chapters whose ids changed are re-marked by how many there were, not by the highest number', () => {
  const marked = Array.from({ length: 300 }, (_, i) => `kingdom:old-${i + 1}`);
  const { context, state } = sandbox({
    readChapters: new Set(marked),
    highestReadChapter: { kingdom: 963 },
    lastReadChapter: { kingdom: 'old-300' },
  });
  context._repairMangaChapterProgressIfNeeded('kingdom', chapters(963));
  const now = [...state.readChapters].filter((k) => k.startsWith('kingdom:'));
  assert.equal(now.length, 300, `marked ${now.length}`);
  assert.equal(state.lastReadChapter.kingdom, 'new-300');
  assert.equal(state.highestReadChapter.kingdom, 963, 'the repair does not touch the number');
});

test('repair: a manga whose chapter ids all still exist is left exactly as it was', () => {
  const read = new Set(['kingdom:new-1', 'kingdom:new-2']);
  const { context, state } = sandbox({ readChapters: read, highestReadChapter: { kingdom: 2 }, lastReadChapter: { kingdom: 'new-2' } });
  context._repairMangaChapterProgressIfNeeded('kingdom', chapters(963));
  assert.deepEqual([...state.readChapters].sort(), ['kingdom:new-1', 'kingdom:new-2']);
  assert.equal(state.lastReadChapter.kingdom, 'new-2');
});

// ── the tracker window must not offer a kept number over AniList's ───────────────────────────────────────────────────────────

test('the tracker window shows AniList\'s number for a title that has an entry, whatever this browser kept', () => {
  const { context } = sandbox();
  assert.equal(context._trackerProgressPrefill({ progress: 162, status: 'CURRENT' }, 348), 162, 'not the higher 348 this browser kept');
  assert.equal(context._trackerProgressPrefill({ progress: 0, status: 'PLANNING' }, 348), '', 'an entry at 0 is not filled with a kept number');
  assert.equal(context._trackerProgressPrefill({ progress: 343 }, 0), 343);
});

test('a title with no entry on AniList is offered what was read here, as a suggestion for the new entry', () => {
  const { context } = sandbox();
  assert.equal(context._trackerProgressPrefill(null, 12), 12);
  assert.equal(context._trackerProgressPrefill(null, undefined), '');
});

test('the tracker form takes its progress from that function, not from a max of the two numbers', () => {
  const source = read('anilist.js');
  assert.match(source, /const progressValue = _trackerProgressPrefill\(entry, state\.highestReadChapter\?\.\[manga\.id\]\)/);
  assert.doesNotMatch(source, /Math\.max\(entry\?\.progress \?\? 0, _localHighest\)/);
});
