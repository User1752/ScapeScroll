'use strict';

// "Reset AniList statuses from ScrollScape": for a library whose statuses on AniList were moved to Reading by an old sync while
// ScrollScape still has the ones the person set. The rules that keep it from doing damage of its own:
//  - the decision (what changes, what matches, what is left alone) is made before anything is written, and a preview writes nothing;
//  - only the STATUS is written, never the progress, and a title that is not on the AniList list is never added;
//  - a rate limit stops it (and says so) instead of failing every remaining title one by one.
// The real files run in a vm sandbox; the only thing replaced is the call to AniList.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (f) => fs.readFileSync(path.join(MODULES, f), 'utf8');

function sandbox() {
  const store = { scrollscape_anilist_token: 'token', scrollscape_anilist_user: JSON.stringify({ id: 7, name: 'me' }) };
  const context = {
    console, setTimeout, clearTimeout, fetch: () => { throw new Error('no network in this test'); },
    state: { settings: {}, favorites: [], readingStatus: {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    dbg: new Proxy({}, { get: () => () => {} }),
    window: { addEventListener() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    api: async () => ({}), $: () => null, escapeHtml: (s) => String(s), showToast() {},
  };
  vm.createContext(context);
  for (const file of ['anilist.js', 'anilist-status-restore.js']) vm.runInContext(read(file), context, { filename: file });
  context._sleep = async () => {};
  return context;
}

const fav = (id, title, anilistId) => ({ id, title, sourceId: 'src', anilistId });
const statusMap = (obj) => (f) => obj[f.id] || '';
const remote = (obj) => new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));

function plan(context, favorites, statuses, remoteStatuses, links = {}) {
  return context.planAniListStatusRestore({
    favorites,
    statusOf: statusMap(statuses),
    mediaIdOf: (f) => f.anilistId || links[f.id] || 0,
    remoteStatusByMediaId: remote(remoteStatuses),
  });
}

test('each ScrollScape status becomes the matching AniList status, and only titles that differ are changed', () => {
  const c = sandbox();
  const p = plan(c,
    [fav('a', 'A', 1), fav('b', 'B', 2), fav('c', 'C', 3), fav('d', 'D', 4), fav('e', 'E', 5)],
    { a: 'reading', b: 'on_hold', c: 'completed', d: 'dropped', e: 'plan_to_read' },
    { 1: 'CURRENT', 2: 'CURRENT', 3: 'CURRENT', 4: 'CURRENT', 5: 'CURRENT' });
  assert.equal(p.same, 1, 'A already is Reading on AniList');
  assert.deepEqual(JSON.parse(JSON.stringify(p.changes.map((x) => [x.title, x.from, x.to]))), [
    ['B', 'CURRENT', 'PAUSED'], ['C', 'CURRENT', 'COMPLETED'], ['D', 'CURRENT', 'DROPPED'], ['E', 'CURRENT', 'PLANNING'],
  ]);
});

test('Rereading on AniList is Reading, not a wrong status', () => {
  const c = sandbox();
  const p = plan(c, [fav('a', 'A', 1)], { a: 'reading' }, { 1: 'REPEATING' });
  assert.equal(p.changes.length, 0);
  assert.equal(p.same, 1);
});

test('a title with no status here, no link, or not on the AniList list is left alone, and listed as such', () => {
  const c = sandbox();
  const p = plan(c,
    [fav('a', 'No status', 1), fav('b', 'Not linked', 0), fav('c', 'Not on the list', 3), fav('d', 'Linked by the map', 0)],
    { b: 'dropped', c: 'dropped', d: 'completed' },
    { 1: 'CURRENT', 9: 'PAUSED' },
    { d: 9 });
  assert.deepEqual(JSON.parse(JSON.stringify(p.ignored)), { noStatus: ['No status'], notLinked: ['Not linked'], notOnList: ['Not on the list'], conflict: [] });
  assert.equal(p.changes.length, 1, 'the one linked only through the links map is still found');
  assert.equal(p.changes[0].title, 'Linked by the map');
  assert.equal(p.changes[0].to, 'COMPLETED');
});

test('two library entries for one AniList title change it once, and disagreeing ones are reported instead of fought over', () => {
  const c = sandbox();
  const same = plan(c, [fav('a', 'A (source 1)', 1), fav('b', 'A (source 2)', 1)], { a: 'dropped', b: 'dropped' }, { 1: 'CURRENT' });
  assert.equal(same.changes.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(same.ignored.conflict)), []);

  const clash = plan(c, [fav('a', 'A (source 1)', 1), fav('b', 'A (source 2)', 1)], { a: 'dropped', b: 'completed' }, { 1: 'CURRENT' });
  assert.equal(clash.changes.length, 1);
  assert.equal(clash.changes[0].to, 'DROPPED', 'the first entry decides');
  assert.deepEqual(JSON.parse(JSON.stringify(clash.ignored.conflict)), ['A (source 2)']);
});

test('the AniList list is read once, with the account id, and every title of every list is kept once', async () => {
  const c = sandbox();
  const asked = [];
  c.anilistGQL = async (query, variables) => {
    asked.push({ query, variables });
    return { data: { MediaListCollection: { lists: [
      { entries: [{ status: 'CURRENT', media: { id: 1 } }, { status: 'PAUSED', media: { id: 2 } }] },
      { entries: [{ status: 'CURRENT', media: { id: 1 } }, { status: null, media: { id: 3 } }, { status: 'DROPPED', media: null }] }, // a custom list repeats an entry
    ] } } };
  };
  const byId = await c.anilistFetchMangaListStatuses();
  assert.equal(asked.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(asked[0].variables)), { userId: 7 });
  assert.doesNotMatch(asked[0].query, /mutation/i);
  assert.deepEqual(JSON.parse(JSON.stringify([...byId.entries()])), [[1, 'CURRENT'], [2, 'PAUSED']]);
});

// ── apply ───────────────────────────────────────────────────────────────────

const changes = (n) => Array.from({ length: n }, (_, i) => ({ mangaId: `m${i}`, title: `T${i}`, mediaId: 100 + i, from: 'CURRENT', to: 'PAUSED' }));

test('apply writes only the status of each title: no progress, nothing else', async () => {
  const c = sandbox();
  const writes = [];
  c.anilistGQL = async (query, variables) => { writes.push({ query, variables }); return { data: { SaveMediaListEntry: { id: 1 } } }; };
  const result = await c.anilistApplyStatusRestore(changes(3));
  assert.equal(result.done, 3);
  assert.equal(writes.length, 3);
  for (const w of writes) {
    assert.match(w.query, /SaveMediaListEntry\(mediaId: \$m, status: \$st\)/);
    assert.doesNotMatch(w.query, /progress|score|delete/i);
    assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(w.variables).sort())), ['m', 'st']);
  }
  assert.deepEqual(writes.map((w) => [w.variables.m, w.variables.st]), [[100, 'PAUSED'], [101, 'PAUSED'], [102, 'PAUSED']]);
});

test('a rate limit stops the run at once and says how far it got; a plain failure only counts that title', async () => {
  const c = sandbox();
  let calls = 0;
  c.anilistGQL = async () => {
    calls++;
    if (calls === 2) return { errors: [{ message: 'Something went wrong' }] };
    if (calls === 4) return { errors: [{ message: 'Too Many Requests.' }] };
    return { data: {} };
  };
  const result = await c.anilistApplyStatusRestore(changes(10));
  assert.equal(calls, 4, 'nothing is asked after the rate limit');
  assert.deepEqual({ done: result.done, failed: result.failed, rateLimited: result.rateLimited }, { done: 2, failed: 1, rateLimited: true });
  assert.match(result.failures[0], /T1: Something went wrong/);
});

test('Stop ends the run before the next title', async () => {
  const c = sandbox();
  let calls = 0, stop = false;
  c.anilistGQL = async () => { calls++; if (calls === 2) stop = true; return { data: {} }; };
  const result = await c.anilistApplyStatusRestore(changes(10), { shouldStop: () => stop });
  assert.equal(calls, 2);
  assert.equal(result.stopped, true);
  assert.equal(result.done, 2);
});

// ── the undo record ─────────────────────────────────────────────────────────

const planned = (n) => Array.from({ length: n }, (_, i) => ({ mediaId: 100 + i, title: `T${i}`, from: 'CURRENT', to: 'PAUSED' }));

test('the undo record is saved BEFORE the first write, and cut down to what was really changed', async () => {
  const c = sandbox();
  const events = [];
  let calls = 0;
  c.anilistGQL = async () => { calls++; events.push('write'); if (calls === 3) return { errors: [{ message: 'Too Many Requests.' }] }; return { data: {} }; };
  const saved = [];
  const result = await c.anilistRunStatusRestore(planned(6), {
    saveJournal: async (changes) => { events.push('save'); saved.push(changes.map((x) => x.mediaId)); },
    clearJournal: async () => { events.push('clear'); },
  });
  assert.equal(events[0], 'save', 'the record exists before anything is written');
  assert.deepEqual(saved[0], [100, 101, 102, 103, 104, 105]);
  assert.equal(result.rateLimited, true);
  assert.deepEqual(saved[1], [100, 101], 'after the rate limit the record holds only the two titles that were changed');
  assert.equal(events.at(-1), 'save');
});

test('if the undo record cannot be saved nothing is written to AniList at all', async () => {
  const c = sandbox();
  let writes = 0;
  c.anilistGQL = async () => { writes++; return { data: {} }; };
  const result = await c.anilistRunStatusRestore(planned(3), { saveJournal: async () => { throw new Error('disk full'); }, clearJournal: async () => {} });
  assert.equal(writes, 0);
  assert.equal(result.ok, false);
  assert.equal(result.journalFailed, true);
  assert.match(result.error, /disk full/);
});

test('a reset that changed nothing leaves no undo record behind', async () => {
  const c = sandbox();
  c.anilistGQL = async () => ({ errors: [{ message: 'Too Many Requests.' }] });
  let cleared = 0;
  await c.anilistRunStatusRestore(planned(3), { saveJournal: async () => {}, clearJournal: async () => { cleared++; } });
  assert.equal(cleared, 1);
});

test('undo puts back only the titles that still have the status the reset gave them', () => {
  const c = sandbox();
  const journal = [
    { mediaId: 1, title: 'Untouched since', from: 'CURRENT', to: 'PAUSED' },
    { mediaId: 2, title: 'Changed by hand since', from: 'CURRENT', to: 'PAUSED' },
    { mediaId: 3, title: 'Removed from the list', from: 'CURRENT', to: 'DROPPED' },
  ];
  const p = c.planAniListRestoreUndo(journal, remote({ 1: 'PAUSED', 2: 'COMPLETED' }));
  assert.deepEqual(JSON.parse(JSON.stringify(p.reverts.map((x) => x.title))), ['Untouched since']);
  assert.deepEqual(JSON.parse(JSON.stringify(p.changedSince)), ['Changed by hand since']);
  assert.deepEqual(JSON.parse(JSON.stringify(p.notOnList)), ['Removed from the list']);
});

test('running the undo writes the old status of each title (status only), and drops the record when it is all done', async () => {
  const c = sandbox();
  const writes = [];
  c.anilistGQL = async (query, variables) => { writes.push({ query, variables }); return { data: {} }; };
  let cleared = 0;
  const journal = { createdAt: 'x', changes: [{ mediaId: 1, title: 'A', from: 'PLANNING', to: 'CURRENT' }, { mediaId: 2, title: 'B', from: 'DROPPED', to: 'CURRENT' }] };
  const result = await c.anilistRunRestoreUndo(journal, remote({ 1: 'CURRENT', 2: 'COMPLETED' }), { clearJournal: async () => { cleared++; } });
  assert.equal(writes.length, 1, 'B was changed since and is left alone');
  assert.equal(writes[0].variables.m, 1);
  assert.equal(writes[0].variables.st, 'PLANNING');
  assert.doesNotMatch(writes[0].query, /progress/i);
  assert.equal(result.finished, true);
  assert.equal(cleared, 1);
});

test('an undo that is cut short by a rate limit keeps the record, so it can be continued', async () => {
  const c = sandbox();
  let calls = 0;
  c.anilistGQL = async () => { calls++; return calls === 2 ? { errors: [{ message: 'Too Many Requests.' }] } : { data: {} }; };
  let cleared = 0;
  const journal = { createdAt: 'x', changes: planned(5) };
  const statuses = remote(Object.fromEntries(planned(5).map((x) => [x.mediaId, 'PAUSED'])));
  const result = await c.anilistRunRestoreUndo(journal, statuses, { clearJournal: async () => { cleared++; } });
  assert.equal(result.rateLimited, true);
  assert.equal(result.finished, false);
  assert.equal(cleared, 0);
});

test('applying reports which titles were changed, by AniList id', async () => {
  const c = sandbox();
  c.anilistGQL = async (query, variables) => (variables.m === 101 ? { errors: [{ message: 'nope' }] } : { data: {} });
  const result = await c.anilistApplyStatusRestore(planned(3));
  assert.deepEqual(JSON.parse(JSON.stringify(result.appliedIds)), [100, 102]);
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('the card is part of the AniList block in Settings and is bound when the modal opens', () => {
  assert.match(read('ui-settings-cards-theme-tracking.js'), /anilistStatusRestoreHtml\(\)/);
  assert.match(read('ui-settings-modal.js'), /bindAniListStatusRestore\(\)/);
  const html = sandbox().anilistStatusRestoreHtml();
  for (const id of ['btnAniListRestorePreview', 'btnAniListRestoreApply', 'btnAniListRestoreStop', 'anilistRestoreSummary', 'anilistRestoreList', 'anilistRestoreUndo', 'btnAniListRestoreUndo']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.match(html, /id="btnAniListRestoreApply" disabled/, 'nothing to apply before a preview');
  assert.match(read('..\\index.html'), /anilist-status-restore\.js/);
});
