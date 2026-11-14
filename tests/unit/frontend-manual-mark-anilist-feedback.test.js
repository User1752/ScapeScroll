'use strict';

// Marking a chapter read by hand pushes the progress to AniList (anilistSyncProgress). A refused or failed push used to be swallowed, so the tracker kept the old
// number and nothing said why. anilistSyncProgress now returns what happened and the manual mark tells the person when it failed or found no title; an off
// auto-sync or a missing login stays quiet (a choice, not a failure).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'modules', f), 'utf8').replace(/\r\n/g, '\n');

// Runs the real anilistSyncProgress with _reconcileAniListProgress replaced, to see what it hands back.
function syncWith(reconcile) {
  const src = read('anilist.js');
  const a = src.indexOf('async function anilistSyncProgress');
  const b = src.indexOf('async function anilistFinalizeCurrentChapterProgress');
  assert.ok(a > 0 && b > a);
  const ctx = {
    state: { currentManga: { id: 'm1' }, currentSourceId: 's' },
    dbg: { warn() {}, ERR_ANILIST: 'x' },
    _normalizeProgressNumber: (v) => Math.floor(Number(v)) || 0,
    _resolveSourceIdForManga: () => 's',
    _reconcileAniListProgress: reconcile,
  };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b), ctx);
  return ctx.anilistSyncProgress;
}

test('anilistSyncProgress hands back what happened, and a failure as { ok: false, error } instead of swallowing it', async () => {
  const sent = { ok: true, mediaId: 1, localProgress: 3, remoteProgress: 2 };
  assert.equal((await syncWith(async () => sent)('Title', 3)).localProgress, 3);
  const failed = await syncWith(async () => { throw new Error('AniList is down'); })('Title', 3);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.message, 'AniList is down');
  assert.equal(await syncWith(async () => sent)('', 3), undefined, 'no title, nothing to send');
});

test('the manual mark tells the person about a failure or a title it could not find, and confirms a push; an off auto-sync stays quiet', () => {
  const src = read('ui-settings.js');
  const block = src.slice(src.indexOf('anilistSyncProgress(mangaTitle, chapterNum'), src.indexOf('function markChapterAsRead'));
  assert.match(block, /if \(res\.error\) showToast\('AniList', "Couldn't update AniList/);
  assert.match(block, /res\.reason === 'missing-media-id'\) showToast\('AniList', "Couldn't find this title on AniList/);
  assert.match(block, /res\.ok && res\.localProgress > res\.remoteProgress\) showToast\('AniList', 'Progress set to chapter '/);
  assert.doesNotMatch(block, /reason === 'nothing-read'|skipped\) showToast/, 'a skipped sync (auto-sync off, no login) says nothing');
});
