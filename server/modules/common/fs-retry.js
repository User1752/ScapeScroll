'use strict';

const { sleep } = require('./async-utils');

// A rename or copy the operating system refuses for a moment (an antivirus, a sync client or an indexer holding the
// file; seen live on the mapped network drive as EPERM for store.json) is tried again a few times instead of
// dropping the write. Any other error, or the last refusal, is thrown as it came.
const RETRYABLE_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const FS_RETRY_DELAYS_MS = Object.freeze([100, 300, 800, 2000]);

/**
 * @param {(attempt: number) => Promise<T>} task  the filesystem step; it must be safe to run again
 * @param {{ delays?: number[], sleepFn?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<T>}
 * @template T
 */
async function retryTransientFs(task, { delays = FS_RETRY_DELAYS_MS, sleepFn = sleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task(attempt);
    } catch (err) {
      if (!RETRYABLE_FS_CODES.has(err && err.code) || attempt >= delays.length) throw err;
      await sleepFn(delays[attempt]);
    }
  }
}

module.exports = { retryTransientFs, RETRYABLE_FS_CODES, FS_RETRY_DELAYS_MS };
