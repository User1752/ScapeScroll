'use strict';

// POST /api/progress/safety-copy: the copy kept before the reading progress is lowered from AniList's numbers. The client writes
// nothing unless this says the copy exists, so what it answers when no copy could be made matters as much as when one was.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const progressRoutes = require('../../server/routes/progress');
const autoBackup = require('../../server/modules/store/auto-backup');

const silent = { log() {}, warn() {} };

async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-safety-copy-'));
  const progressPath = path.join(dir, 'reading-progress.json');
  const service = progressRoutes.configure({ filePath: progressPath });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ favorites: [] }));
  autoBackup.configure({
    storePath: path.join(dir, 'store.json'), backupDir: path.join(dir, 'backups'), log: silent,
    extraFiles: [{ path: progressPath, prefix: 'progress', flush: () => service.flushSync() }],
  });
  const app = express();
  app.use(express.json());
  progressRoutes.registerProgressRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => {
    server.close();
    autoBackup.configure({ storePath: path.join(dir, 'store.json'), backupDir: path.join(dir, 'backups'), log: silent }); // leaves no timers
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = (p, body) => fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { dir, service, post };
}

test('the copy holds the progress as it is NOW (including what is still waiting to be written), and says ok', async (t) => {
  const { dir, service, post } = await start(t);
  service.applyOps({ readAdd: ['k:1', 'k:2', 'k:3'], highest: { k: 916 }, init: true });
  const res = await post('/api/progress/safety-copy');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  const names = fs.readdirSync(path.join(dir, 'backups')).filter((n) => n.startsWith('progress-before-anilist-progress-'));
  assert.equal(names.length, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'backups', names[0]), 'utf8'));
  assert.deepEqual(Object.keys(saved.read).sort(), ['k:1', 'k:2', 'k:3']);
  assert.equal(saved.highest.k, 916, 'the number about to be lowered is in the copy');
});

test('a second request minutes later is ok too (the copy of a moment ago is as good)', async (t) => {
  const { post } = await start(t);
  assert.equal((await (await post('/api/progress/safety-copy')).json()).ok, true);
  const again = await (await post('/api/progress/safety-copy')).json();
  assert.equal(again.ok, true);
  assert.equal(again.skipped, 'recent');
});

test('when no copy can be made the answer is NOT ok, so the client changes nothing', async (t) => {
  const { dir, post } = await start(t);
  fs.rmSync(path.join(dir, 'store.json')); // nothing to copy
  const res = await (await post('/api/progress/safety-copy')).json();
  assert.equal(res.ok, false);
  assert.equal(res.skipped, 'no-store');
});
