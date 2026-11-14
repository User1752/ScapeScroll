'use strict';

// Saving a chapter of another source for offline reading (server/modules/local/offline-downloads.js saveChapter): a manga's meta.json is created
// with its first chapter, read AGAIN after the pages are fetched (another save may have added a chapter meanwhile), never gets the same chapter
// twice, and an existing meta.json that cannot be read still fails the save before any page is fetched. A temp folder and fake collaborators.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createOfflineDownloadService } = require('../../server/modules/local/offline-downloads');

function setup({ fetchImageBuffer } = {}) {
  const LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-offline-'));
  const fetched = [];
  const service = createOfflineDownloadService({
    LOCAL_DIR,
    safeId: (id) => (/^[a-z0-9_-]+$/i.test(String(id)) ? String(id) : ''),
    loadSourceFromFile: () => ({ pages: async () => ({ pages: ['https://img.example/1.jpg', 'https://img.example/2.jpg'] }) }),
    sha1Short: () => 'abc',
    fetchImageBuffer: fetchImageBuffer || (async (url) => { fetched.push(url); return Buffer.from('image'); }),
    resolvePageUrl: (page) => ({ url: page, referer: '' }),
    safeName: (name) => String(name || '').replace(/[^a-z0-9 ()-]/gi, '').trim(),
    crypto,
  });
  return { LOCAL_DIR, service, fetched, cleanup: () => fs.rmSync(LOCAL_DIR, { recursive: true, force: true }) };
}
const readMeta = (dir, id) => JSON.parse(fs.readFileSync(path.join(dir, id, 'meta.json'), 'utf8'));
const save = (service, chapter, name) => service.saveChapter({ sourceId: 'somesource', chapterId: chapter, chapterName: name, mangaTitle: 'My Manga', mangaId: 'm1' });

test('the first save creates the manga with that chapter, a later save of another chapter adds to it, and the same chapter is never added twice', async (t) => {
  const { LOCAL_DIR, service, cleanup } = setup();
  t.after(cleanup);
  const first = await save(service, 'c1', 'Chapter 1');
  assert.equal(first.success, true);
  let meta = readMeta(LOCAL_DIR, first.localId);
  assert.equal(meta.originalSourceId, 'somesource');
  assert.deepEqual(meta.chapters.map((c) => c.sourceChapterId), ['c1']);
  assert.match(meta.cover, /\/images\/Chapter 1\/0001\.jpg$/, 'the cover is the first page saved');

  const second = await save(service, 'c2', 'Chapter 2');
  assert.equal(second.localId, first.localId, 'the same manga');
  meta = readMeta(LOCAL_DIR, first.localId);
  assert.deepEqual(meta.chapters.map((c) => c.sourceChapterId), ['c1', 'c2']);

  await save(service, 'c2', 'Chapter 2');
  assert.deepEqual(readMeta(LOCAL_DIR, first.localId).chapters.map((c) => c.sourceChapterId), ['c1', 'c2'], 'saving it again changes nothing');
});

test('a chapter another save added while this one was fetching its pages is kept, because meta.json is read again afterwards', async (t) => {
  let service;
  let LOCAL_DIR;
  let injected = false;
  const env = setup({
    fetchImageBuffer: async () => {
      if (!injected) {
        injected = true;
        // a different save finishes first and leaves its chapter in meta.json
        const dir = fs.readdirSync(LOCAL_DIR).find((d) => fs.existsSync(path.join(LOCAL_DIR, d, 'meta.json')));
        const metaPath = path.join(LOCAL_DIR, dir, 'meta.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta.chapters.push({ id: `${dir}:9`, sourceChapterId: 'other', name: 'Other', pages: [] });
        fs.writeFileSync(metaPath, JSON.stringify(meta), 'utf8');
      }
      return Buffer.from('image');
    },
  });
  ({ service, LOCAL_DIR } = env);
  t.after(env.cleanup);
  const saved = await save(service, 'c1', 'Chapter 1');
  assert.deepEqual(readMeta(LOCAL_DIR, saved.localId).chapters.map((c) => c.sourceChapterId), ['other', 'c1']);
});

test('an existing meta.json that cannot be read fails the save before a single page is fetched', async (t) => {
  const { LOCAL_DIR, service, fetched, cleanup } = setup();
  t.after(cleanup);
  fs.mkdirSync(path.join(LOCAL_DIR, 'local-dl-abc'));
  fs.writeFileSync(path.join(LOCAL_DIR, 'local-dl-abc', 'meta.json'), '{ not json', 'utf8');
  await assert.rejects(save(service, 'c1', 'Chapter 1'), SyntaxError);
  assert.deepEqual(fetched, []);
});

test('when every page fails, a brand-new manga leaves nothing behind and the caller is told (502)', async (t) => {
  const { LOCAL_DIR, service, cleanup } = setup({ fetchImageBuffer: async () => { throw new Error('upstream down'); } });
  t.after(cleanup);
  const quiet = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(save(service, 'c1', 'Chapter 1'), (err) => err.statusCode === 502 && /Could not fetch any pages/.test(err.message));
  } finally {
    console.warn = quiet;
  }
  assert.deepEqual(fs.readdirSync(LOCAL_DIR), []);
});
