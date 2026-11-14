'use strict';

const fs = require('fs');
const fsp = fs.promises;

/**
 * A small in-memory Map backed by a debounced, atomically-written JSON file
 * on disk, with a per-read TTL check — the exact pattern that used to be
 * copy-pasted, line-for-line, between comicvine/service.js and
 * leagueofcomicgeeks/service.js (cover/publisher lookups that are expensive
 * or rate-limited enough to be worth surviving a restart).
 *
 * @param {{ saveDebounceMs?: number, maxEntries?: number }} [opts] maxEntries: the oldest entries go first once there are more (default: no limit)
 */
function createTtlDiskCache({ saveDebounceMs = 2_000, maxEntries = Infinity } = {}) {
  const cache = new Map();
  let cacheFilePath = null;
  let loading = null;
  let saveTimer = null;

  /** @param {{ cacheFilePath: string }} options */
  function configure({ cacheFilePath: filePath } = {}) {
    if (!filePath || typeof filePath !== 'string') {
      throw new Error('Invalid cacheFilePath provided to createTtlDiskCache().configure()');
    }
    cacheFilePath = filePath;
  }

  // Restarts are frequent during development (and after any settings
  // change), and every one used to wipe an in-memory-only cache — repaying
  // for lookups already resolved just minutes earlier. Loading once from
  // disk on first use is what actually keeps repeat lookups (and any
  // upstream rate limit) under control.
  // One load, shared: a second caller that arrives while the file is still being read waits for it instead of seeing an empty cache.
  async function ensureLoaded() {
    if (!cacheFilePath) return;
    if (!loading) {
      loading = (async () => {
        try {
          const raw = await fsp.readFile(cacheFilePath, 'utf8');
          const parsed = JSON.parse(raw);
          for (const [key, entry] of Object.entries(parsed)) {
            if (!cache.has(key)) cache.set(key, entry);
          }
        } catch {
          // No cache file yet (first run) or it's unreadable — start fresh.
        }
      })();
    }
    await loading;
  }

  function scheduleSave() {
    if (!cacheFilePath) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        const tmpPath = `${cacheFilePath}.tmp`;
        await fsp.writeFile(tmpPath, JSON.stringify(Object.fromEntries(cache)), 'utf8');
        await fsp.rename(tmpPath, cacheFilePath);
      } catch (_) {
        // Best-effort — worst case a few entries get re-fetched next time.
      }
    }, saveDebounceMs);
  }

  /** Returns the cached value for `key` if present and younger than `ttlMs`, else undefined. */
  function getFresh(key, ttlMs) {
    const entry = cache.get(key);
    if (entry && Date.now() - entry.at < ttlMs) return entry.value;
    return undefined;
  }

  /** Stores `value` under `key`, stamped with the current time, and schedules a debounced save. */
  function set(key, value) {
    cache.delete(key); // so an entry that is set again counts as the newest
    cache.set(key, { value, at: Date.now() });
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value); // Map keeps insertion order: the first key is the oldest
    scheduleSave();
  }

  return { configure, ensureLoaded, getFresh, set };
}

module.exports = { createTtlDiskCache };
