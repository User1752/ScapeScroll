'use strict';

// The automatic copies of data/store.json. What matters: a copy exists for each day and survives the restart of the server, the
// folder does not grow for ever, a damaged store never replaces a good copy, a copy taken before a big change is not overwritten
// by the calls that follow it, and nothing here ever writes to store.json itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const autoBackup = require('../../server/modules/store/auto-backup');
const { createAutoBackup, selectBackupsToDelete, isoWeekKey } = autoBackup;

const silent = { log() {}, warn() {} };

function setup(t, { store = { favorites: [{ id: 'a' }], readingStatus: {} }, clock = new Date(2026, 9, 31, 12, 0, 0), ...options } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const storePath = path.join(dir, 'store.json');
  const backupDir = path.join(dir, 'backups');
  if (store !== null) fs.writeFileSync(storePath, typeof store === 'string' ? store : JSON.stringify(store));
  const state = { clock };
  const backup = createAutoBackup({ storePath, backupDir, now: () => state.clock, log: silent, ...options });
  return { backup, storePath, backupDir, state, names: () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).sort() : []) };
}

test('isoWeekKey follows ISO 8601, including the year boundary', () => {
  assert.equal(isoWeekKey('2026-10-31'), '2026-W44');
  assert.equal(isoWeekKey('2026-01-01'), '2026-W01');
  assert.equal(isoWeekKey('2027-01-01'), '2026-W53', 'a Friday that still belongs to the last week of 2026');
  assert.equal(isoWeekKey('2024-12-30'), '2025-W01');
});

test('daily copies: the newest 7 days stay, then one per week for 4 weeks, and the rest go', () => {
  const days = [];
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2026, 9, 31 - i));
    days.push(`store-${d.toISOString().slice(0, 10)}.json`);
  }
  const doomed = new Set(selectBackupsToDelete(days));
  const kept = days.filter((n) => !doomed.has(n));
  assert.deepEqual(kept.slice(0, 7), days.slice(0, 7), 'the last 7 days are all kept');
  const weekly = kept.slice(7);
  assert.equal(weekly.length, 4, 'four older copies, one per week');
  assert.equal(new Set(weekly.map((n) => isoWeekKey(n.slice(6, 16)))).size, 4);
  assert.ok(weekly.every((n) => n < days[6]), 'and all older than the daily ones');
});

test('safety copies: the newest 5 stay; files this module did not make are never deleted', () => {
  const safety = Array.from({ length: 8 }, (_, i) => `store-before-restore-202610${String(10 + i)}-120000.json`);
  const mine = selectBackupsToDelete([...safety, 'notes.txt', 'store-final-manual.json', 'my-own-copy.json']);
  assert.deepEqual(mine.sort(), safety.slice(0, 3).sort(), 'the three oldest');
});

test('the daily copy is made once a day, is a byte-for-byte copy, and leaves store.json alone', async (t) => {
  const { backup, storePath, backupDir, state, names } = setup(t);
  const before = fs.readFileSync(storePath);
  const first = await backup.snapshot();
  assert.equal(first.ok, true);
  assert.deepEqual(names(), ['store-2026-10-31.json']);
  assert.deepEqual(fs.readFileSync(path.join(backupDir, 'store-2026-10-31.json')), before);
  assert.deepEqual(fs.readFileSync(storePath), before, 'the store itself is untouched');

  assert.deepEqual(await backup.snapshot(), { ok: false, skipped: 'exists' }, 'a second call the same day does nothing');

  state.clock = new Date(2026, 10, 1, 9, 0, 0);
  assert.equal((await backup.snapshot()).ok, true);
  assert.deepEqual(names(), ['store-2026-10-31.json', 'store-2026-11-01.json']);
});

test('a store that is missing, empty, damaged or not an object is never copied, and an existing copy is left as it is', async (t) => {
  const good = setup(t);
  await good.backup.snapshot();
  const goodCopy = fs.readFileSync(path.join(good.backupDir, 'store-2026-10-31.json'));

  for (const [label, content, skipped] of [['damaged', '{"favorites": [', 'invalid-store'], ['empty object', '{}', 'invalid-store'], ['array', '[1,2]', 'invalid-store'], ['text', 'hello', 'invalid-store']]) {
    const s = setup(t, { store: content });
    assert.deepEqual(await s.backup.snapshot(), { ok: false, skipped }, label);
    assert.deepEqual(s.names(), [], `${label}: no copy`);
  }
  const missing = setup(t, { store: null });
  assert.deepEqual(await missing.backup.snapshot(), { ok: false, skipped: 'no-store' });

  assert.deepEqual(fs.readFileSync(path.join(good.backupDir, 'store-2026-10-31.json')), goodCopy);
});

test('a safety copy is named for what is about to happen, and a second call in the same flow does not replace the first', async (t) => {
  const { backup, storePath, state, names } = setup(t);
  assert.equal((await backup.snapshot('before-restore')).ok, true);
  assert.deepEqual(names(), ['store-before-before-restore-20261031-120000.json']);

  fs.writeFileSync(storePath, JSON.stringify({ favorites: [{ id: 'changed by the first step' }] }));
  state.clock = new Date(2026, 9, 31, 12, 3, 0);
  assert.deepEqual(await backup.snapshot('before-restore'), { ok: false, skipped: 'recent' }, 'three minutes later: still the same flow');
  assert.equal(names().length, 1);
  const kept = JSON.parse(fs.readFileSync(path.join(path.dirname(storePath), 'backups', names()[0]), 'utf8'));
  assert.equal(kept.favorites[0].id, 'a', 'the copy still holds the state from BEFORE the change');

  state.clock = new Date(2026, 9, 31, 12, 30, 0);
  assert.equal((await backup.snapshot('before-restore')).ok, true, 'half an hour later it is a new thing');
  assert.equal(names().length, 2);
});

test('the label of a safety copy is made safe for a file name', async (t) => {
  const { backup, names } = setup(t);
  await backup.snapshot('../../etc/passwd  AniList import!');
  assert.equal(names().length, 1);
  assert.match(names()[0], /^store-before-etc-passwd-anilist-import-\d{8}-\d{6}\.json$/);
});

test('copies are pruned as new ones are made, and list() says what there is', async (t) => {
  const { backup, state, names } = setup(t, { keepDaily: 2, keepWeekly: 1 });
  for (let day = 20; day <= 31; day++) {
    state.clock = new Date(2026, 9, day, 8, 0, 0);
    await backup.snapshot();
  }
  const left = names();
  assert.equal(left.length, 3, left.join(', '));
  assert.deepEqual(left.slice(-2), ['store-2026-10-30.json', 'store-2026-10-31.json']);
  const listed = await backup.list();
  assert.equal(listed.length, 3);
  assert.ok(listed.every((f) => f.kind === 'daily' && f.bytes > 0));
});

test('the reading progress file is copied the same way under its own name, and each kind is pruned on its own', async (t) => {
  const names = [];
  for (let d = 1; d <= 12; d++) { names.push(`store-2026-10-${String(d).padStart(2, '0')}.json`, `progress-2026-10-${String(d).padStart(2, '0')}.json`); }
  const progressGone = selectBackupsToDelete(names, { prefix: 'progress', keepDaily: 2, keepWeekly: 0 });
  assert.equal(progressGone.length, 10);
  assert.ok(progressGone.every((n) => n.startsWith('progress-')), 'the store\'s copies are not touched');
  const storeGone = selectBackupsToDelete(names, { keepDaily: 2, keepWeekly: 0 });
  assert.ok(storeGone.every((n) => n.startsWith('store-')), 'and the progress copies are not touched by the store\'s pruning');

  const { backup, backupDir, storePath } = setup(t, { store: { read: { 'a:1': 0 }, initialized: true } });
  const made = createAutoBackup({ storePath, backupDir, prefix: 'progress', log: silent, now: () => new Date(2026, 9, 31, 12) });
  assert.equal((await made.snapshot()).ok, true);
  assert.equal((await backup.snapshot()).ok, true);
  assert.deepEqual(fs.readdirSync(backupDir).sort(), ['progress-2026-10-31.json', 'store-2026-10-31.json']);
  assert.deepEqual((await made.list()).map((f) => f.name), ['progress-2026-10-31.json'], 'each lists only its own');
});

test('the safety copy before a big change covers every file that is kept: the store AND the reading progress', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-backup-both-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ favorites: [] }));
  fs.writeFileSync(path.join(dir, 'reading-progress.json'), JSON.stringify({ read: { 'a:1': 0 } }));
  let flushed = 0;
  autoBackup.configure({
    storePath: path.join(dir, 'store.json'), backupDir: path.join(dir, 'backups'), log: silent,
    extraFiles: [{ path: path.join(dir, 'reading-progress.json'), prefix: 'progress', flush: () => { flushed++; } }],
  });
  const result = await autoBackup.safetySnapshot('before-restore');
  assert.equal(result.ok, true, 'the answer is the store\'s');
  assert.equal(flushed, 1, 'the progress is written out first, so the copy has the latest');
  const files = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(files.filter((n) => n.startsWith('store-before-')).length, 1);
  assert.equal(files.filter((n) => n.startsWith('progress-before-')).length, 1);
  const listed = await autoBackup.listBackups();
  assert.deepEqual(listed.map((f) => f.of).sort(), ['progress', 'store']);
  autoBackup.configure({ storePath: path.join(dir, 'store.json'), backupDir: path.join(dir, 'backups'), log: silent }); // leaves no timers
});

test('runDaily never throws: a folder it cannot write to is reported and the server carries on', async (t) => {
  const warnings = [];
  const { storePath } = setup(t);
  // a folder that cannot be created: its parent is the store FILE
  const broken = createAutoBackup({ storePath, backupDir: path.join(storePath, 'backups'), log: { log() {}, warn: (m) => warnings.push(m) } });
  const result = await broken.runDaily();
  assert.equal(result.ok, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /could not make the daily copy/);
  assert.ok(JSON.parse(fs.readFileSync(storePath, 'utf8')).favorites, 'the store is as it was');
});

test('a damaged store is reported as such by runDaily, and no copy is made', async (t) => {
  const warnings = [];
  const { backup, names } = setup(t, { store: '{"favorites": [', log: { log() {}, warn: (m) => warnings.push(m) } });
  const result = await backup.runDaily();
  assert.deepEqual(result, { ok: false, skipped: 'invalid-store' });
  assert.match(warnings[0], /not a valid store/);
  assert.deepEqual(names(), []);
});
