'use strict';

// "Sync progress with AniList" (right-click on a library card): shows the number on AniList and the number worked out here, and lets the
// person choose which one wins. What must hold:
//  - "the number here" comes from the chapters that are really read and numbered, never from the stored `highestReadChapter` that once
//    held a wrong value and was written over AniList;
//  - the two ways are offered with exactly what they would do (how many chapters, up or DOWN), and a way that cannot work says why;
//  - what the preview counts is what is applied (raising uses the Tracker's own function);
//  - nothing changes here before the server kept a copy of its files, and nothing is applied that was not chosen.
// The real files run in a vm sandbox; only AniList, the server and the sources are replaced.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULES = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (f) => fs.readFileSync(path.join(MODULES, f), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
function locale(lang) {
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(read(`i18n/locales/${lang}.js`), ctx);
  return ctx.window.ScrollScapeI18nLocales[lang];
}
const EN = locale('en-GB');

function sandbox({ chapters = [] } = {}) {
  const store = { scrollscape_anilist_token: 'token', scrollscape_anilist_user: JSON.stringify({ id: 7 }) };
  const context = {
    console, setTimeout, clearTimeout, fetch: () => { throw new Error('no network in this test'); },
    state: { settings: {}, favorites: [], readChapters: new Set(), lastReadChapter: {}, lastReadPages: {}, highestReadChapter: {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    dbg: new Proxy({}, { get: () => () => {} }),
    window: { addEventListener() {} },
    document: { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    api: async () => ({ chapters }), $: () => null, showToast() {},
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    t: (key) => EN[key] ?? key,
  };
  vm.createContext(context);
  for (const file of ['anilist.js', 'anilist-progress-restore.js', 'anilist-progress-sync.js']) vm.runInContext(read(file), context, { filename: file });
  return context;
}

const chapters = (n, extra = []) => [...Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, chapter: String(i + 1) })), ...extra];
const keys = (ids) => ids.map((id) => `m:${id}`);
const upTo = (n) => keys(Array.from({ length: n }, (_, i) => `c${i + 1}`));
const plan = (c, chs, read, anilist) => plain(c.planProgressSync({ mangaId: 'm', chapters: chs, readKeys: read, anilist }));

test('both agree: nothing to do', () => {
  const p = plan(sandbox(), chapters(100), upTo(100), { exists: true, progress: 100 });
  assert.equal(p.inSync, true);
  assert.equal(p.toApp, null);
  assert.equal(p.toAniList, null);
});

test('this app is ahead (the Kingdom case): bring AniList\'s number here unmarks the rest, or push this one up', () => {
  const p = plan(sandbox(), chapters(400), upTo(400), { exists: true, progress: 343 });
  assert.equal(p.appNumber, 400);
  assert.equal(p.anilistNumber, 343);
  assert.equal(p.toApp.kind, 'lower');
  assert.equal(p.toApp.chapters, 57);
  assert.equal(p.toApp.to, 343);
  assert.deepEqual(p.toAniList, { from: 343, to: 400, lowers: false, creates: false });
});

test('AniList is ahead (read in Komikku): bring it here marks the missing chapters, or push this lower number DOWN to AniList', () => {
  const p = plan(sandbox(), chapters(200), upTo(100), { exists: true, progress: 162 });
  assert.equal(p.appNumber, 100);
  assert.equal(p.toApp.kind, 'raise');
  assert.equal(p.toApp.chapters, 62, 'chapters 101 to 162');
  assert.equal(p.toAniList.lowers, true, 'the person is told AniList would go DOWN');
  assert.deepEqual([p.toAniList.from, p.toAniList.to], [162, 100]);
});

test('extras do not count as beyond: a chapter 0, a 5.5 and a 222.5 are inside 222', () => {
  const chs = chapters(222, [{ id: 'z', chapter: '0' }, { id: 'h', chapter: '5.5' }, { id: 'e', chapter: '222.5' }]);
  const p = plan(sandbox(), chs, [...upTo(222), 'm:z', 'm:h', 'm:e'], { exists: true, progress: 222 });
  assert.equal(p.appNumber, 222, 'AniList counts 222.5 as 222');
  assert.equal(p.inSync, true);
});

test('not on AniList yet: it can be sent (and created), and there is nothing to bring here', () => {
  const p = plan(sandbox(), chapters(50), upTo(30), { exists: false, progress: 0 });
  assert.equal(p.toApp, null);
  assert.equal(p.blocked.toApp, 'anilist-zero');
  assert.deepEqual(p.toAniList, { from: 0, to: 30, lowers: false, creates: true });
});

test('nothing read here: there is nothing to send, and AniList\'s number can be brought here', () => {
  const p = plan(sandbox(), chapters(50), [], { exists: true, progress: 20 });
  assert.equal(p.appNumber, 0);
  assert.equal(p.toAniList, null);
  assert.equal(p.blocked.toAniList, 'app-zero');
  assert.equal(p.toApp.chapters, 20);
});

test('a source with no numbers is counted by position, oldest first (the way the Import counts)', () => {
  const named = ['Prologue', 'Beginning', 'Middle', 'Later', 'End'].map((name, i) => ({ id: `n${i}`, name }));
  const read5 = ['m:n3', 'm:n1'].concat(['m:n0']);
  const p = plan(sandbox(), [...named].reverse(), read5, { exists: true, progress: 2 });
  assert.equal(p.appNumber, 4, 'the furthest read chapter is the 4th, oldest first');
  assert.equal(p.toApp.kind, 'lower');
});

test('a source that changed its ids is never guessed at, and a source with no chapters says so', () => {
  const c = sandbox();
  assert.match(plan(c, chapters(10), ['m:gone-1', 'm:gone-2'], { exists: true, progress: 5 }).error, /none of the chapters read here/);
  assert.match(plan(c, [], upTo(3), { exists: true, progress: 5 }).error, /lists no chapters/);
});

test('lowering a number that nothing here is beyond is blocked with its reason, not offered', () => {
  const chs = chapters(30);
  const p = plan(sandbox(), chs, upTo(10), { exists: true, progress: 20 });
  assert.equal(p.toApp.kind, 'raise');
  const lone = plan(sandbox(), [{ id: 'a', chapter: '1' }, { id: 'b', chapter: '2' }, { id: 'x', name: 'Extra' }], ['m:a', 'm:b', 'm:x'], { exists: true, progress: 2 });
  assert.equal(lone.appNumber, 2);
  assert.equal(lone.inSync, true, 'an unnumbered extra is not beyond anything');
});

test('the number here never comes from the stored highest chapter', () => {
  const src = read('anilist-progress-sync.js');
  const body = src.slice(src.indexOf('function planProgressSync'), src.indexOf('async function anilistApplyProgressSync'));
  assert.ok(!/highestReadChapter|state\./.test(body), 'the plan is a pure function of the chapters, the keys and AniList\'s answer');
  const c = sandbox();
  c.state.highestReadChapter = { m: 900 };
  assert.equal(plan(c, chapters(100), upTo(100), { exists: true, progress: 100 }).inSync, true);
});

test('what the preview counts is what raising applies (the Tracker\'s own function)', async () => {
  for (const [chs, read, n] of [
    [chapters(200, [{ id: 'h', chapter: '40.5' }]), upTo(100), 162],
    [['Zero', 'One', 'Two', 'Three', 'Four', 'Five'].map((name, i) => ({ id: `n${i}`, name })).reverse(), ['m:n0'], 4], // newest first, as the sources send them
  ]) {
    const c = sandbox({ chapters: chs });
    const p = plan(c, chs, read, { exists: true, progress: n });
    c.state.readChapters = new Set(read);
    await c._syncTrackerProgressToLocal('m', 'src', n);
    assert.equal(c.state.readChapters.size - read.length, p.toApp.chapters, 'the same number of chapters added as the preview said');
  }
});

// ── applying ────────────────────────────────────────────────────────────────

const deps = (over = {}) => {
  const calls = [];
  return {
    calls,
    keepCopy: async () => { calls.push('copy'); return { ok: true }; },
    raise: async (...a) => { calls.push(['raise', ...a]); },
    lower: async (a) => { calls.push(['lower', a.mangaId, a.readRemove.length]); },
    write: async (...a) => { calls.push(['write', ...a]); },
    ...over,
  };
};

test('AniList → app: the copy is kept first, then it raises or lowers as the plan said', async () => {
  const c = sandbox();
  const raise = plan(c, chapters(200), upTo(100), { exists: true, progress: 162 });
  const d1 = deps();
  assert.deepEqual(plain(await c.anilistApplyProgressSync({ plan: raise, direction: 'toApp', mangaId: 'm', sourceId: 's', mediaId: 9 }, d1)), { ok: true });
  assert.deepEqual(plain(d1.calls), ['copy', ['raise', 'm', 's', 162]]);
  const lower = plan(c, chapters(400), upTo(400), { exists: true, progress: 343 });
  const d2 = deps();
  await c.anilistApplyProgressSync({ plan: lower, direction: 'toApp', mangaId: 'm', sourceId: 's', mediaId: 9 }, d2);
  assert.deepEqual(plain(d2.calls), ['copy', ['lower', 'm', 57]]);
});

test('nothing here is changed when the server could not keep its copy; a recent copy is enough', async () => {
  const c = sandbox();
  const p = plan(c, chapters(400), upTo(400), { exists: true, progress: 343 });
  for (const failing of [async () => { throw new Error('down'); }, async () => ({ ok: false }), async () => null]) {
    const d = deps({ keepCopy: failing });
    const r = plain(await c.anilistApplyProgressSync({ plan: p, direction: 'toApp', mangaId: 'm', sourceId: 's', mediaId: 9 }, d));
    assert.deepEqual(r, { ok: false, reason: 'copy' });
    assert.equal(d.calls.length, 0, 'nothing was raised or lowered');
  }
  const d = deps({ keepCopy: async () => ({ ok: false, skipped: 'recent' }) });
  assert.equal((await c.anilistApplyProgressSync({ plan: p, direction: 'toApp', mangaId: 'm', sourceId: 's', mediaId: 9 }, d)).ok, true);
});

test('app → AniList writes the number found here, creating the entry only when there is none, and never touches this app', async () => {
  const c = sandbox();
  const d = deps();
  const up = plan(c, chapters(400), upTo(400), { exists: true, progress: 343 });
  await c.anilistApplyProgressSync({ plan: up, direction: 'toAniList', mangaId: 'm', sourceId: 's', mediaId: 9 }, d);
  const fresh = plan(c, chapters(50), upTo(30), { exists: false, progress: 0 });
  await c.anilistApplyProgressSync({ plan: fresh, direction: 'toAniList', mangaId: 'm', sourceId: 's', mediaId: 9 }, d);
  assert.deepEqual(plain(d.calls), [['write', 9, 400, { newEntry: false }], ['write', 9, 30, { newEntry: true }]]);
  assert.ok(!d.calls.includes('copy'), 'AniList is written to, so there is no server copy to keep');
});

test('a way that is not available, a missing media id and an error all end as { ok:false }, never as a half change', async () => {
  const c = sandbox();
  const blocked = plan(c, chapters(50), [], { exists: true, progress: 0 });
  const d = deps();
  assert.equal((await c.anilistApplyProgressSync({ plan: blocked, direction: 'toApp', mangaId: 'm', sourceId: 's', mediaId: 9 }, d)).ok, false);
  const p = plan(c, chapters(400), upTo(400), { exists: true, progress: 343 });
  assert.equal((await c.anilistApplyProgressSync({ plan: p, direction: 'toAniList', mangaId: 'm', sourceId: 's', mediaId: 0 }, d)).ok, false);
  const r = plain(await c.anilistApplyProgressSync({ plan: p, direction: 'toAniList', mangaId: 'm', sourceId: 's', mediaId: 9 }, deps({ write: async () => { throw new Error('AniList is down'); } })));
  assert.deepEqual(r, { ok: false, reason: 'AniList is down' });
  assert.equal((await c.anilistApplyProgressSync({ plan: p, direction: 'sideways', mangaId: 'm', sourceId: 's', mediaId: 9 }, d)).ok, false);
  assert.equal(d.calls.length, 0);
});

// ── the window ──────────────────────────────────────────────────────────────

test('the window shows both numbers, says what each button does, and warns when AniList would go DOWN', () => {
  const c = sandbox();
  const html = c._alsyncBodyHtml(c.planProgressSync({ mangaId: 'm', chapters: chapters(200), readKeys: upTo(100), anilist: { exists: true, progress: 162 } }));
  assert.match(html, /On AniList[\s\S]*chapter 162/);
  assert.match(html, /In this app[\s\S]*chapter 100/);
  assert.match(html, /data-alsync="toApp"[\s\S]*Marks 62 more chapter\(s\) as read here, up to chapter 162\. AniList is not changed\./);
  assert.match(html, /data-alsync="toAniList"[\s\S]*AniList goes DOWN from chapter 162 to chapter 100/);
  assert.match(html, /Only the progress changes, never the reading status\./);
});

test('in sync there are no buttons; a way that cannot work shows its reason instead of a button', () => {
  const c = sandbox();
  const same = c._alsyncBodyHtml(c.planProgressSync({ mangaId: 'm', chapters: chapters(10), readKeys: upTo(10), anilist: { exists: true, progress: 10 } }));
  assert.match(same, /Both say chapter 10\. Nothing to do\./);
  assert.ok(!same.includes('data-alsync='));
  const fresh = c._alsyncBodyHtml(c.planProgressSync({ mangaId: 'm', chapters: chapters(10), readKeys: upTo(4), anilist: { exists: false, progress: 0 } }));
  assert.match(fresh, /not on your AniList list yet/);
  assert.match(fresh, /AniList has no progress for this manga/);
  assert.match(fresh, /Adds it to your AniList list as Reading, at chapter 4\./);
  assert.ok(!fresh.includes('data-alsync="toApp"'));
});

test('the right-click menu offers it for one manga of a real source, with AniList connected, and nowhere else', () => {
  const menu = read('ui-library-context-menu.js');
  assert.match(menu, /\$\{!isBulk && sourceId !== 'local' \? `<button class="context-item" id="ctxSyncProgress">/);
  assert.match(menu, /anilistOpenProgressSync\(\{ \.\.\.manga, sourceId \}\)/);
  const inside = menu.indexOf('ctxSyncProgress') > menu.indexOf("typeof _alToken === 'function' && _alToken()");
  assert.ok(inside, 'inside the part of the menu that only exists when AniList is connected');
  const html = fs.readFileSync(path.join(MODULES, '..', 'index.html'), 'utf8');
  assert.match(html, /modules\/anilist-progress-sync\.js/);
});

test('every string of the window exists in English and in Portuguese', () => {
  const src = read('anilist-progress-sync.js');
  const keys = new Set([...src.matchAll(/\b(?:t|_alsyncT)\('(anilistSync\.[A-Za-z.]+)'/g)].map((m) => m[1]));
  keys.add('anilistSync.menu');
  for (const k of ['anilistZero', 'nothingToMark', 'nothingBeyond', 'appZero', 'other']) keys.add(`anilistSync.blocked.${k}`);
  assert.ok(keys.size > 20, `${keys.size} keys found`);
  for (const lang of ['en-GB', 'pt-PT']) {
    const table = locale(lang);
    const missing = [...keys].filter((k) => typeof table[k] !== 'string' || !table[k]);
    assert.deepEqual(missing, [], `${lang} is missing ${missing.join(', ')}`);
  }
});
