'use strict';

// The undo record of "Reset AniList statuses from ScrollScape" (store.anilistRestoreUndo). It comes from the browser, so it is rebuilt
// field by field; and the three routes (GET / PUT / DELETE /api/anilist/restore-journal) are run on a real Express app over a
// temporary store.json: a record that is not valid is refused, a valid one survives a restart of the store, and nothing else in the
// store is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const { sanitizeRestoreJournal, MAX_CHANGES } = require('../../server/modules/anilist/restore-journal');

const change = (mediaId, from = 'CURRENT', to = 'PAUSED', title = `T${mediaId}`) => ({ mediaId, title, from, to });

test('a good record keeps only the known fields, and statuses are normalised to AniList names', () => {
  const j = sanitizeRestoreJournal({
    createdAt: '2026-10-31T12:00:00Z',
    secret: 'dropped',
    changes: [{ mediaId: 5, title: 'Bleach', from: 'current', to: 'planning', token: 'dropped too', extra: 1 }],
  });
  assert.deepEqual(j, { createdAt: '2026-10-31T12:00:00.000Z', changes: [{ mediaId: 5, title: 'Bleach', from: 'CURRENT', to: 'PLANNING' }] });
});

test('entries that are not valid are dropped, not repaired: ids, statuses, duplicates', () => {
  const j = sanitizeRestoreJournal({
    changes: [
      change(1), change(1, 'PAUSED', 'DROPPED'), // the same title twice: the first wins
      change(-4), change(0), change(2.5), { ...change(3), mediaId: 'abc' },
      { ...change(6), from: 'DELETED' }, { ...change(7), to: 'ARCHIVED' }, { ...change(8), from: '' },
      null, 'text', 5, [],
      change(9),
    ],
  });
  assert.deepEqual(j.changes.map((c) => c.mediaId), [1, 9]);
  assert.equal(j.changes[0].to, 'PAUSED');
});

test('nothing valid in it means no record at all (an empty undo is never saved)', () => {
  for (const input of [null, undefined, 'x', 5, [], {}, { changes: [] }, { changes: [change(-1)] }, { changes: 'no' }]) {
    assert.equal(sanitizeRestoreJournal(input), null, JSON.stringify(input));
  }
});

test('titles are cut, the list is capped, and a bad date becomes now', () => {
  const j = sanitizeRestoreJournal({ createdAt: 'not a date', changes: [change(1, 'CURRENT', 'PAUSED', 'x'.repeat(5000))] });
  assert.equal(j.changes[0].title.length, 200);
  assert.ok(Math.abs(new Date(j.createdAt).getTime() - Date.now()) < 10_000);
  const many = sanitizeRestoreJournal({ changes: Array.from({ length: MAX_CHANGES + 500 }, (_, i) => change(i + 1)) });
  assert.equal(many.changes.length, MAX_CHANGES);
});

// ── the routes ──────────────────────────────────────────────────────────────

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('GET / PUT / DELETE on a real store: refused when invalid, kept when valid, and the rest of the store is untouched', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-journal-'));
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, JSON.stringify({ favorites: [{ id: 'keep-me', title: 'Kingdom' }], readingStatus: {} }));
  const storeModule = require('../../server/store');
  storeModule.configure(storePath);
  await storeModule.initStore();
  const { registerLibraryRoutes } = require('../../server/routes/library');
  const app = express();
  app.use(express.json());
  registerLibraryRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  // the store writes with a short delay, after the test is over: the folder goes when the process ends, not before
  t.after(() => { server.close(); storeModule.flushNow(); });
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const port = server.address().port;

  assert.deepEqual((await request(port, 'GET', '/api/anilist/restore-journal')).body, { ok: true, journal: null });

  const bad = await request(port, 'PUT', '/api/anilist/restore-journal', { journal: { changes: [change(-1)] } });
  assert.equal(bad.status, 400);
  assert.deepEqual((await request(port, 'GET', '/api/anilist/restore-journal')).body.journal, null, 'a refused record is not stored');

  const ok = await request(port, 'PUT', '/api/anilist/restore-journal', { journal: { createdAt: '2026-10-31T12:00:00Z', changes: [change(1), change(2, 'PLANNING', 'CURRENT')], injected: '<script>' } });
  assert.equal(ok.status, 200);
  const got = (await request(port, 'GET', '/api/anilist/restore-journal')).body.journal;
  assert.deepEqual(got.changes.map((c) => c.mediaId), [1, 2]);
  assert.equal('injected' in got, false);

  // it is on disk at once (the AniList writes it protects begin right after), next to the rest of the store
  const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  assert.equal(onDisk.anilistRestoreUndo.changes.length, 2);
  assert.equal(onDisk.favorites[0].id, 'keep-me');

  assert.deepEqual((await request(port, 'DELETE', '/api/anilist/restore-journal')).body, { ok: true });
  assert.equal((await request(port, 'GET', '/api/anilist/restore-journal')).body.journal, null);
  assert.equal((await request(port, 'GET', '/api/anilist/restore-journal')).status, 200);
});
