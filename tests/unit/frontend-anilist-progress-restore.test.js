'use strict';

// "Lower the reading progress here to AniList's": for a library where an old sync marked every chapter of a manga as read and the
// number was then corrected by hand on AniList. The rules that keep it from doing damage of its own:
//  - a preview writes nothing, and only a title where MORE is read here than on AniList is ever changed;
//  - chapters are removed only when they can be placed in the source's list (a source that changed its ids is never guessed at);
//  - chapters that were not read are never marked as read;
//  - nothing is changed unless the server confirmed it kept a copy first, and one failing title does not stop the others.
// The real files run in a vm sandbox; the only things replaced are AniList, the server and the sources.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (f) => fs.readFileSync(path.join(MODULES, f), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));

function sandbox() {
  const store = { scrollscape_anilist_token: 'token', scrollscape_anilist_user: JSON.stringify({ id: 7, name: 'me' }) };
  const context = {
    console, setTimeout, clearTimeout, fetch: () => { throw new Error('no network in this test'); },
    state: { settings: {}, favorites: [], readChapters: new Set() },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    dbg: new Proxy({}, { get: () => () => {} }),
    window: { addEventListener() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    api: async () => ({}), $: () => null, escapeHtml: (s) => String(s), showToast() {},
  };
  vm.createContext(context);
  for (const file of ['anilist.js', 'anilist-progress-restore.js']) vm.runInContext(read(file), context, { filename: file });
  context._sleep = async () => {};
  return context;
}

const fav = (id, title, anilistId, sourceId = 'src') => ({ id, title, sourceId, anilistId });
const keysOf = (map) => (mangaId) => map[mangaId] || [];
const nKeys = (mangaId, n) => Array.from({ length: n }, (_, i) => `${mangaId}:c${i + 1}`);
const chapters = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, chapter: String(i + 1) }));
const remote = (obj) => new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));

function plan(c, favorites, keys, remoteProgress, links = {}) {
  return plain(c.planAniListProgressRestore({
    favorites,
    mediaIdOf: (f) => f.anilistId || links[f.id] || 0,
    readKeysOf: keysOf(keys),
    remoteProgressByMediaId: remote(remoteProgress),
  }));
}

test('only a manga with MORE read here than on AniList is lowered; equal, ahead, zero, unlinked and not-on-list are left alone', () => {
  const c = sandbox();
  const p = plan(c,
    [fav('a', 'A', 1), fav('b', 'B', 2), fav('c', 'C', 3), fav('d', 'D', 4), fav('e', 'E', 0), fav('f', 'F', 6)],
    { a: nKeys('a', 900), b: nKeys('b', 10), c: nKeys('c', 5), d: nKeys('d', 40), e: nKeys('e', 7), f: nKeys('f', 8) },
    { 1: 300, 2: 10, 3: 50, 4: 0 });
  assert.deepEqual(p.changes.map((x) => [x.title, x.from, x.to]), [['A', 900, 300]]);
  assert.equal(p.same, 1, 'B matches');
  assert.equal(p.ahead, 1, 'C: AniList is ahead, that is for the Import');
  assert.deepEqual(p.ignored.zero, ['D'], 'a 0 on AniList is more likely "not filled in" than "read nothing"');
  assert.deepEqual(p.ignored.notLinked, ['E']);
  assert.deepEqual(p.ignored.notOnList, ['F']);
});

test('the same manga twice in the library is planned once; the link may come from the stored links', () => {
  const c = sandbox();
  const p = plan(c, [fav('a', 'A', 1), fav('a', 'A again', 1, 'other'), fav('b', 'B', 0)], { a: nKeys('a', 20), b: nKeys('b', 20) }, { 1: 5, 9: 5 }, { b: 9 });
  assert.deepEqual(p.changes.map((x) => x.title), ['A', 'B']);
});

test('lowering keeps the first N chapters oldest first whatever order the source lists them in', () => {
  const c = sandbox();
  const shuffled = chapters(10).reverse();
  const keys = nKeys('m', 10);
  const l = plain(c.planAniListProgressLowering({ mangaId: 'm', chapters: shuffled, readKeys: keys, progress: 4 }));
  assert.deepEqual(l.readRemove.sort(), nKeys('m', 10).slice(4).sort());
  assert.equal(l.lastChapterId, 'c4');
  assert.equal(l.highest, 4);
});

test('chapters that were not read are not marked as read, and a read chapter inside the number is kept', () => {
  const c = sandbox();
  const keys = ['m:c2', 'm:c9', 'm:c10'];
  const l = plain(c.planAniListProgressLowering({ mangaId: 'm', chapters: chapters(10), readKeys: keys, progress: 5 }));
  assert.deepEqual(l.readRemove.sort(), ['m:c10', 'm:c9']);
  assert.ok(!('readAdd' in l), 'the plan has no way to add a chapter');
});

test('a source that lists fewer chapters than AniList\'s number, or none, or whose ids are not the ones read, is never guessed at', () => {
  const c = sandbox();
  // a source whose chapters have no numbers is counted by position, and cannot show a position it does not have
  const unnumbered = Array.from({ length: 3 }, (_, i) => ({ id: `u${i + 1}`, name: `Special ${String.fromCharCode(65 + i)}` }));
  assert.match(c.planAniListProgressLowering({ mangaId: 'm', chapters: unnumbered, readKeys: ['m:u1', 'm:u2', 'm:u3'], progress: 5 }).error, /fewer than AniList/);
  assert.match(c.planAniListProgressLowering({ mangaId: 'm', chapters: chapters(3), readKeys: nKeys('m', 3), progress: 0 }).error, /no chapter of the source is numbered/);
  assert.match(c.planAniListProgressLowering({ mangaId: 'm', chapters: [], readKeys: nKeys('m', 3), progress: 2 }).error, /no chapters/);
  const renamed = c.planAniListProgressLowering({ mangaId: 'm', chapters: chapters(10).map((ch) => ({ ...ch, id: `new-${ch.id}` })), readKeys: nKeys('m', 10), progress: 2 });
  assert.match(renamed.error, /are in the source's list/, 'otherwise "beyond" would mean everything');
});

test('a read key the source\'s list does not know is left alone, not removed', () => {
  const c = sandbox();
  const l = plain(c.planAniListProgressLowering({ mangaId: 'm', chapters: chapters(10), readKeys: ['m:c1', 'm:c8', 'm:old-id'], progress: 3 }));
  assert.deepEqual(l.readRemove, ['m:c8']);
});

test('beyond is decided by the chapter NUMBER: a gap in the numbering does not make a chapter count, and the highest is a number', () => {
  const c = sandbox();
  const ch = [{ id: 'a', chapter: '1' }, { id: 'b', chapter: '2' }, { id: 'c', chapter: '4' }, { id: 'd', chapter: '5' }];
  const l = plain(c.planAniListProgressLowering({ mangaId: 'm', chapters: ch, readKeys: ['m:a', 'm:b', 'm:c', 'm:d'], progress: 3 }));
  assert.deepEqual(l.readRemove.sort(), ['m:c', 'm:d'], 'chapters 4 and 5 are beyond 3; there is no chapter 3');
  assert.equal(l.highest, 2);
  assert.equal(l.lastChapterId, 'b');
});

test('extra chapters (a 0, a 5.5, a bonus with no number) are not "beyond" AniList\'s whole number: nothing is unmarked for them', () => {
  const c = sandbox();
  // 222 numbered chapters, a chapter 0, 222.5, and 12 extras with no number: 235 read here, 222 on AniList (Yuragi-sou)
  const ch = [
    ...chapters(222),
    { id: 'zero', chapter: '0' }, { id: 'half', chapter: '222.5' },
    ...Array.from({ length: 11 }, (_, i) => ({ id: `x${i}`, name: `Bonus ${String.fromCharCode(65 + i)}` })),
  ];
  const keys = ch.map((x) => `m:${x.id}`);
  assert.equal(keys.length, 235);
  const l = plain(c.planAniListProgressLowering({ mangaId: 'm', chapters: ch, readKeys: keys, progress: 222 }));
  assert.deepEqual(l.readRemove, [], 'nothing read lies beyond 222');
});

test('a manga read to 728 and put back to 16 on AniList loses exactly chapters 17 and up (by number, the source in any order)', () => {
  const c = sandbox();
  const l = plain(c.planAniListProgressLowering({ mangaId: 'm', chapters: chapters(728).reverse(), readKeys: nKeys('m', 728), progress: 16 }));
  assert.equal(l.readRemove.length, 712);
  assert.ok(!l.readRemove.includes('m:c16') && l.readRemove.includes('m:c17'));
  assert.equal(l.lastChapterId, 'c16');
  assert.equal(l.highest, 16);
});

test('a title with a small gap is flagged small (listed apart, unticked); a big gap is not', () => {
  const c = sandbox();
  const p = plan(c,
    [fav('tiny', 'Tiny', 1), fav('kingdom', 'Kingdom', 2), fav('yuragi', 'Yuragi', 3), fav('vinland', 'Vinland', 4)],
    { tiny: nKeys('tiny', 21), kingdom: nKeys('kingdom', 914), yuragi: nKeys('yuragi', 235), vinland: nKeys('vinland', 249) },
    { 1: 20, 2: 343, 3: 222, 4: 224 });
  const bySmall = Object.fromEntries(p.changes.map((x) => [x.title, x.small]));
  assert.deepEqual(bySmall, { Tiny: true, Kingdom: false, Yuragi: true, Vinland: false });
});

function deps(c, { copy = { ok: true }, chaptersBy = {}, keys = {}, calls = [], failLower = new Set() } = {}) {
  return {
    keepCopy: async () => { if (copy instanceof Error) throw copy; return copy; },
    loadChapters: async (change) => { const ch = chaptersBy[change.mangaId]; if (ch instanceof Error) throw ch; return ch || []; },
    readKeysOf: keysOf(keys),
    lower: async (m) => { if (failLower.has(m.mangaId)) throw new Error('server said no'); calls.push(plain(m)); },
  };
}

test('nothing is lowered unless the server confirmed it kept a copy first', async () => {
  const c = sandbox();
  const changes = [{ mangaId: 'a', title: 'A', from: 10, to: 3, sourceId: 's' }];
  for (const copy of [{ ok: false }, new Error('HTTP 500'), null]) {
    const calls = [];
    const r = await c.anilistRunProgressRestore(changes, deps(c, { copy, chaptersBy: { a: chapters(10) }, keys: { a: nKeys('a', 10) }, calls }));
    assert.equal(r.copyFailed, true);
    assert.equal(calls.length, 0);
    assert.equal(r.done, 0);
  }
});

test('one title that fails (source down, server refuses) does not stop the others, and is named', async () => {
  const c = sandbox();
  const changes = ['a', 'b', 'c'].map((id) => ({ mangaId: id, title: id.toUpperCase(), from: 10, to: 3, sourceId: 's' }));
  const calls = [];
  const r = await c.anilistRunProgressRestore(changes, deps(c, {
    chaptersBy: { a: chapters(10), b: new Error('source is down'), c: chapters(10) },
    keys: { a: nKeys('a', 10), b: nKeys('b', 10), c: nKeys('c', 10) },
    calls, failLower: new Set(['c']),
  }));
  assert.equal(r.done, 1);
  assert.equal(r.failed, 2);
  assert.deepEqual(plain(r.appliedIds), ['a']);
  assert.match(r.failures.join('|'), /B: source is down/);
  assert.match(r.failures.join('|'), /C: server said no/);
  assert.deepEqual(calls.map((x) => x.mangaId), ['a']);
  assert.deepEqual(calls[0].readRemove.sort(), nKeys('a', 10).slice(3).sort());
});

test('a title with nothing beyond AniList\'s number is counted as left alone and nothing is written for it', async () => {
  const c = sandbox();
  const changes = [{ mangaId: 'a', title: 'A', from: 13, to: 10, sourceId: 's' }];
  const calls = [];
  const extras = [...chapters(10), { id: 'zero', chapter: '0' }, { id: 'half', chapter: '10.5' }, { id: 'bonus', name: 'Bonus' }];
  const r = await c.anilistRunProgressRestore(changes, deps(c, { chaptersBy: { a: extras }, keys: { a: extras.map((x) => `a:${x.id}`) }, calls }));
  assert.equal(r.unchanged, 1);
  assert.equal(r.done, 0);
  assert.deepEqual(calls, []);
});

test('Stop ends the run between two titles', async () => {
  const c = sandbox();
  const changes = ['a', 'b', 'c'].map((id) => ({ mangaId: id, title: id, from: 10, to: 3, sourceId: 's' }));
  const calls = [];
  let stop = false;
  const d = deps(c, { chaptersBy: { a: chapters(10), b: chapters(10), c: chapters(10) }, keys: { a: nKeys('a', 10), b: nKeys('b', 10), c: nKeys('c', 10) }, calls });
  const lower = d.lower;
  d.lower = async (m) => { await lower(m); stop = true; };
  const r = await c.anilistRunProgressRestore(changes, d, { shouldStop: () => stop });
  assert.equal(r.stopped, true);
  assert.equal(r.done, 1);
});

test('the AniList list is read for progress with a query that writes nothing, and a title is counted once', async () => {
  const c = sandbox();
  const queries = [];
  c.anilistGQL = async (q) => {
    queries.push(q);
    return { data: { MediaListCollection: { lists: [
      { entries: [{ progress: 300, media: { id: 1 } }, { progress: 0, media: { id: 2 } }] },
      { entries: [{ progress: 999, media: { id: 1 } }, { progress: null, media: { id: 3 } }] },
    ] } } };
  };
  const m = await c.anilistFetchMangaListProgress();
  assert.deepEqual(plain([...m]), [[1, 300], [2, 0], [3, 0]]);
  assert.ok(queries.every((q) => /^query/.test(q) && !/mutation/i.test(q)));
});

test('an AniList error is raised, not read as an empty list', async () => {
  const c = sandbox();
  c.anilistGQL = async () => ({ errors: [{ message: 'Invalid token' }] });
  await assert.rejects(() => c.anilistFetchMangaListProgress(), /Invalid token/);
});

test('the preview card, its buttons and the files are wired in', () => {
  assert.match(read('ui-settings-cards-theme-tracking.js'), /anilistProgressRestoreHtml\(\)/);
  assert.match(read('ui-settings-modal.js'), /bindAniListProgressRestore\(\)/);
  const html = sandbox().anilistProgressRestoreHtml();
  for (const id of ['btnAniListProgressPreview', 'btnAniListProgressApply', 'btnAniListProgressStop', 'anilistProgressList']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(fs.readFileSync(path.join(MODULES, '..', 'index.html'), 'utf8'), /anilist-progress-restore\.js/);
});

// The card itself, driven through its real buttons with a minimal page: the preview lists what would change, only the ticked ones are
// lowered, and the numbers shown are the ones used.
function pageSandbox({ remoteList, favorites, readKeys, chaptersBy }) {
  const c = sandbox();
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, style: {}, disabled: false, textContent: '', _html: '', boxes: [], querySelectorAll() { return this.boxes; } });
  for (const id of ['btnAniListProgressPreview', 'btnAniListProgressApply', 'btnAniListProgressStop', 'anilistProgressSummary', 'anilistProgressList']) el(id);
  Object.defineProperty(els.anilistProgressList, 'innerHTML', {
    get() { return this._html; },
    set(html) {
      this._html = html;
      this.boxes = [...html.matchAll(/<input[^>]*data-progress-index="(\d+)"([^>]*)>/g)].map((m) => ({ dataset: { progressIndex: m[1] }, checked: /\bchecked\b/.test(m[2]), onchange: null }));
    },
  });
  c.document.getElementById = (id) => els[id] || null;
  c.document.querySelectorAll = (sel) => (sel.startsWith('#anilistProgressList') ? els.anilistProgressList.boxes : []);
  c.confirm = () => true;
  c.renderLibrary = () => {};
  c.state.favorites = favorites;
  c.state.readChapters = new Set(Object.values(readKeys).flat());
  c.anilistGQL = async () => ({ data: { MediaListCollection: { lists: [{ entries: remoteList }] } } });
  c.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
  c.api = async (url, opts) => ({ chapters: chaptersBy[JSON.parse(opts.body).mangaId] || [] });
  const lowered = [];
  c.progressSyncLowerManga = async (m) => { lowered.push(plain(m)); };
  c.bindAniListProgressRestore();
  return { c, els, lowered };
}

test('the card: Preview lists the titles, Apply lowers only the ticked ones with the numbers shown', async () => {
  const { els, lowered } = pageSandbox({
    remoteList: [{ progress: 300, media: { id: 1 } }, { progress: 5, media: { id: 2 } }, { progress: 20, media: { id: 3 } }],
    favorites: [fav('kingdom', 'Kingdom', 1), fav('bleach', 'Bleach', 2), fav('mine', 'Mine', 3)],
    readKeys: { kingdom: nKeys('kingdom', 400), bleach: nKeys('bleach', 30), mine: nKeys('mine', 20) },
    chaptersBy: { kingdom: chapters(963), bleach: chapters(100) },
  });
  await els.btnAniListProgressPreview.onclick();
  assert.match(els.anilistProgressSummary.textContent, /^2 would be lowered, 1 already match/);
  assert.match(els.anilistProgressList.innerHTML, /Kingdom/);
  assert.match(els.anilistProgressList.innerHTML, /400 &rarr; <strong>300<\/strong>/);
  assert.match(els.anilistProgressList.innerHTML, /30 &rarr; <strong>5<\/strong>/);
  assert.doesNotMatch(els.anilistProgressList.innerHTML, /Mine/, 'a title that already matches is not offered');
  assert.equal(els.btnAniListProgressApply.textContent, 'Lower 2 manga here');

  els.anilistProgressList.boxes[1].checked = false; // Bleach is left as it is
  els.anilistProgressList.boxes[1].onchange();
  assert.equal(els.btnAniListProgressApply.textContent, 'Lower 1 manga here');

  await els.btnAniListProgressApply.onclick();
  assert.equal(lowered.length, 1);
  assert.equal(lowered[0].mangaId, 'kingdom');
  assert.equal(lowered[0].readRemove.length, 100);
  assert.equal(lowered[0].lastChapterId, 'c300');
  assert.equal(lowered[0].highest, 300);
  assert.match(els.anilistProgressSummary.textContent, /^Done: 1 lowered/);
  assert.equal(els.btnAniListProgressApply.style.display, 'none');
});

test('the card: the preview writes nothing, and with nothing ticked Apply does nothing', async () => {
  const { els, lowered } = pageSandbox({
    remoteList: [{ progress: 3, media: { id: 1 } }],
    favorites: [fav('a', 'A', 1)],
    readKeys: { a: nKeys('a', 10) },
    chaptersBy: { a: chapters(10) },
  });
  await els.btnAniListProgressPreview.onclick();
  assert.equal(lowered.length, 0, 'a preview writes nothing');
  els.anilistProgressList.boxes[0].checked = false;
  await els.btnAniListProgressApply.onclick();
  assert.equal(lowered.length, 0);
});

test('the card: small gaps are listed apart and unticked, so Apply only offers the big ones until the person ticks more', async () => {
  const { els, lowered } = pageSandbox({
    remoteList: [{ progress: 20, media: { id: 1 } }, { progress: 343, media: { id: 2 } }],
    favorites: [fav('tiny', 'Tiny', 1), fav('kingdom', 'Kingdom', 2)], // listed small first, to prove the grouping is not the order
    readKeys: { tiny: nKeys('tiny', 21), kingdom: nKeys('kingdom', 400) },
    chaptersBy: { tiny: chapters(25), kingdom: chapters(963) },
  });
  await els.btnAniListProgressPreview.onclick();
  assert.match(els.anilistProgressSummary.textContent, /^1 would be lowered, 1 with a small difference/);
  assert.match(els.anilistProgressList.innerHTML, /Small differences/);
  assert.ok(els.anilistProgressList.innerHTML.indexOf('Kingdom') < els.anilistProgressList.innerHTML.indexOf('Tiny'), 'the big ones come first');
  const [bigBox, smallBox] = els.anilistProgressList.boxes;
  assert.equal(bigBox.checked, true);
  assert.equal(smallBox.checked, false, 'a small gap is not ticked by default');
  assert.equal(els.btnAniListProgressApply.textContent, 'Lower 1 manga here');
  await els.btnAniListProgressApply.onclick();
  assert.deepEqual(lowered.map((m) => m.mangaId), ['kingdom']);
});

test('a title found to have nothing beyond AniList\'s number is remembered, and not offered again for the same number', async () => {
  const c = sandbox();
  const changes = [{ mangaId: 'tales', title: 'Tales', from: 803, to: 443, sourceId: 's' }];
  // 803 entries (a source that splits chapters in parts), numbered 1..443: none beyond 443
  const parts = Array.from({ length: 803 }, (_, i) => ({ id: `p${i}`, chapter: String(Math.floor(i * 443 / 803) + 1) }));
  const settledCalls = [];
  const calls = [];
  const d = deps(c, { chaptersBy: { tales: parts }, keys: { tales: parts.map((p) => `tales:${p.id}`) }, calls });
  d.settle = (change) => settledCalls.push(change.mangaId);
  const r = await c.anilistRunProgressRestore(changes, d);
  assert.equal(r.unchanged, 1);
  assert.deepEqual(calls, [], 'by number nothing is beyond 443: the 803 read entries stay (a count would have cut 360 of them)');
  assert.deepEqual(settledCalls, ['tales']);

  const keys = { tales: nKeys('tales', 803) };
  const again = plain(c.planAniListProgressRestore({ favorites: [fav('tales', 'Tales', 1)], mediaIdOf: (f) => f.anilistId, readKeysOf: keysOf(keys), remoteProgressByMediaId: remote({ 1: 443 }), settled: { tales: 443 } }));
  assert.equal(again.changes.length, 0);
  assert.equal(again.settled, 1);
  const changed = plain(c.planAniListProgressRestore({ favorites: [fav('tales', 'Tales', 1)], mediaIdOf: (f) => f.anilistId, readKeysOf: keysOf(keys), remoteProgressByMediaId: remote({ 1: 400 }), settled: { tales: 443 } }));
  assert.equal(changed.changes.length, 1, 'AniList has another number now, so it is checked again');
});
