'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTtlDiskCache } = require('../../server/modules/common/ttl-disk-cache');

const tempFile = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttl-disk-cache-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return path.join(dir, 'cache.json');
};
const settle = () => new Promise((resolve) => { setTimeout(resolve, 120); });

test('past maxEntries the oldest entry goes first, and an entry set again counts as the newest', () => {
  const cache = createTtlDiskCache({ maxEntries: 3 });
  cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
  cache.set('a', 10); // a is now the newest; b is the oldest
  cache.set('d', 4);
  assert.equal(cache.getFresh('b', Infinity), undefined);
  assert.deepEqual(['a', 'c', 'd'].map((k) => cache.getFresh(k, Infinity)), [10, 3, 4]);
});

test('with no limit nothing is ever dropped (the other caches keep behaving as before)', () => {
  const cache = createTtlDiskCache();
  for (let i = 0; i < 500; i++) cache.set('k' + i, i);
  assert.equal(cache.getFresh('k0', Infinity), 0);
  assert.equal(cache.getFresh('k499', Infinity), 499);
});

test('what was saved comes back after a restart, and a second caller waits for the one load', async (t) => {
  const file = tempFile(t);
  const first = createTtlDiskCache({ saveDebounceMs: 5 });
  first.configure({ cacheFilePath: file });
  first.set('kept', { n: 1 });
  await settle();

  const second = createTtlDiskCache({ saveDebounceMs: 5 });
  second.configure({ cacheFilePath: file });
  await Promise.all([second.ensureLoaded(), second.ensureLoaded()]); // both resolve only once the file is in
  assert.deepEqual(second.getFresh('kept', 60_000), { n: 1 });
});

test('a value is stale once older than the time asked for', () => {
  const cache = createTtlDiskCache();
  cache.set('x', 1);
  assert.equal(cache.getFresh('x', 60_000), 1);
  assert.equal(cache.getFresh('x', -1), undefined);
});
