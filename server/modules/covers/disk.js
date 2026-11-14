'use strict';

/**
 * server/modules/covers/disk.js — what the local covers do to data/covers/: the index, the files, what is fetched and what is deleted.
 * (service.js decides WHAT the library needs and WHEN to look; this does the looking.)
 *
 * Files are named from the address (sha1, 24 hex) so two titles with the same cover share one file, and index.json maps address -> file.
 * Only a name that is in the index is ever served. Every file is written to a temporary name and renamed, so a half-written cover never exists.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const FILE_RE = /^[a-f0-9]{24}\.(?:jpg|png|webp|gif|avif)$/;
const TYPE_TO_EXT = Object.freeze({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' });
const EXT_TO_TYPE = Object.freeze({ jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' });
const INDEX_NAME = 'index.json';
const MIN_BYTES = 64; // anything smaller is not a picture

const fileNameFor = (url, ext) => `${crypto.createHash('sha1').update(url).digest('hex').slice(0, 24)}.${ext}`;
const unlinkQuiet = (ctx, name) => fsp.unlink(path.join(ctx.dir, name)).catch(() => {});
const exists = (ctx, name) => fsp.access(path.join(ctx.dir, name)).then(() => true, () => false);

// index: { covers: { [url]: { file, type, bytes, at } }, failed: { [url]: { at, count, reason } } }
async function loadIndex(ctx) {
  if (ctx.index) return ctx.index;
  ctx.index = { covers: {}, failed: {} };
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(ctx.dir, INDEX_NAME), 'utf8'));
    if (raw && raw.covers && typeof raw.covers === 'object') {
      for (const [url, e] of Object.entries(raw.covers)) if (e && typeof e.file === 'string' && FILE_RE.test(e.file)) ctx.index.covers[url] = e;
    }
    if (raw && raw.failed && typeof raw.failed === 'object') ctx.index.failed = raw.failed;
  } catch (_) { /* no index yet, or one that cannot be read: it is made again from what is fetched */ }
  return ctx.index;
}

async function saveIndex(ctx) {
  const target = path.join(ctx.dir, INDEX_NAME);
  await fsp.writeFile(`${target}.tmp`, JSON.stringify(ctx.index));
  await fsp.rename(`${target}.tmp`, target);
}

// Takes the files and index entries no title needs any more, and any file or leftover that is not in the index.
async function prune(ctx, wanted, summary) {
  const { index } = ctx;
  for (const [url, entry] of Object.entries(index.covers)) {
    if (wanted.has(url)) continue;
    await unlinkQuiet(ctx, entry.file);
    delete index.covers[url];
    summary.removed++;
  }
  for (const url of Object.keys(index.failed)) if (!wanted.has(url)) delete index.failed[url];
  const known = new Set(Object.values(index.covers).map((e) => e.file));
  for (const name of await fsp.readdir(ctx.dir).catch(() => [])) {
    if (name === INDEX_NAME) continue;
    if ((FILE_RE.test(name) && !known.has(name)) || name.endsWith('.tmp')) await unlinkQuiet(ctx, name);
  }
}

// One cover, fetched with the image proxy's headers and kept only when it really is a picture of a sensible size.
async function download(ctx, url, ref) {
  const res = await ctx.fetchImage({ url, ref, measureBytes: true });
  const type = String((res && res.contentType) || '').split(';')[0].trim().toLowerCase();
  const ext = TYPE_TO_EXT[type];
  if (!ext) throw new Error(`not an image (${type || 'no type'})`);
  const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(await new Response(res.body).arrayBuffer());
  if (body.length < MIN_BYTES) throw new Error('empty answer');
  if (body.length > ctx.limits.libraryCoverMaxBytes) throw new Error('too large');
  const file = fileNameFor(url, ext);
  await fsp.writeFile(path.join(ctx.dir, `${file}.tmp`), body);
  await fsp.rename(path.join(ctx.dir, `${file}.tmp`), path.join(ctx.dir, file));
  return { file, type, bytes: body.length, at: ctx.now() };
}

// What is needed and not on disk, one at a time with a gap; a failure is remembered and left alone until the retry time.
async function fetchMissing(ctx, wanted, summary) {
  const { index, limits } = ctx;
  for (const [url, ref] of wanted) {
    const have = index.covers[url];
    if (have) {
      if (await exists(ctx, have.file)) { summary.kept++; continue; }
      delete index.covers[url]; // the file went away: fetch it again
    }
    const failed = index.failed[url];
    if (failed && ctx.now() - failed.at < limits.libraryCoverRetryMs) { summary.pending++; continue; }
    try {
      index.covers[url] = await download(ctx, url, ref);
      delete index.failed[url];
      summary.downloaded++;
    } catch (e) {
      index.failed[url] = { at: ctx.now(), count: (failed ? failed.count : 0) + 1, reason: String((e && e.message) || e).slice(0, 120) };
      summary.failed++;
    }
    await saveIndex(ctx);
    await ctx.sleep(limits.libraryCoverSpacingMs);
  }
}

// Makes the folder match what the library needs; resolves with what it did.
async function syncDisk(ctx, wanted) {
  const summary = { downloaded: 0, removed: 0, failed: 0, kept: 0, pending: 0 };
  await fsp.mkdir(ctx.dir, { recursive: true });
  await loadIndex(ctx);
  await prune(ctx, wanted, summary);
  await fetchMissing(ctx, wanted, summary);
  await saveIndex(ctx);
  return summary;
}

function createCoverDisk({ dir, limits, fetchImage, now, sleep }) {
  const ctx = { dir, limits, fetchImage, now, sleep, index: null };
  return {
    sync: (wanted) => syncDisk(ctx, wanted),
    // the address -> served path map the page uses
    async getMap() {
      await loadIndex(ctx);
      return Object.fromEntries(Object.entries(ctx.index.covers).map(([url, e]) => [url, `/api/library-cover/${e.file}`]));
    },
    // the file behind a served name: only names in the index, never a leftover
    async getFile(name) {
      if (!FILE_RE.test(String(name || ''))) return null;
      await loadIndex(ctx);
      if (!Object.values(ctx.index.covers).some((e) => e.file === name)) return null;
      return { path: path.join(dir, name), type: EXT_TO_TYPE[name.split('.').pop()] };
    },
    async counts() {
      await loadIndex(ctx);
      return { stored: Object.keys(ctx.index.covers).length, failed: Object.keys(ctx.index.failed).length };
    },
  };
}

module.exports = { createCoverDisk, FILE_RE };
