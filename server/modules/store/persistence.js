'use strict';

const { sleep } = require('../common/async-utils');

// Each flush rewrites the ENTIRE store file from scratch (currently ~650KB
// for a real library) — not an incremental/delta write. On a local disk
// that's cheap enough not to matter; when data/ lives on a network share
// (confirmed live: this project's data/ is on a mapped SMB drive, not local
// disk), SMB's per-operation round-trip overhead means every flush is a
// real, measurable network I/O burst. A short debounce turns frequent small
// changes (reading progress, syncing status) into frequent full-file
// network rewrites. 3s batches far more of that activity into each flush
// without meaningfully changing the crash-loss window (worst case: the last
// few seconds of changes, same trade-off the previous 300ms already made,
// just a wider window).
//
// A write the operating system refuses for a moment is not a lost write. An antivirus
// or a sync client (the data/ folder sits inside a vault that one indexes) can hold
// store.json open just as the temporary file is renamed over it, and Windows answers
// that with EPERM, EBUSY or EACCES (seen live: "EPERM ... rename store.json.tmp ->
// store.json"). Those three are retried a few times, a short pause apart, and a flush that
// is still refused is tried again later, a few times, because the debounce only writes
// when something changes and nothing might change for a long while. Any other error
// (a full disk, a missing folder) is reported once and not repeated.
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const WRITE_RETRY_DELAYS_MS = Object.freeze([100, 300, 800, 2000]);
const SYNC_RETRY_DELAYS_MS = Object.freeze([50, 150, 400]);
const FAILURE_RETRY_MS = 10_000;
const LATER_ATTEMPTS = 5;

const isRetryable = (err) => !!err && RETRYABLE_CODES.has(err.code);

// Blocks the thread for `ms`: only for the flush at exit and the forced flush, which are synchronous.
function sleepSyncDefault(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The temporary file is written and renamed over store.json; a refusal of the kinds above is
// retried after each pause in `delays`. Resolves, or rejects with the error that ended it.
// Two things keep an asynchronous write from undoing a newer one:
//  - the store is serialised again for every attempt (`takeStore`), so a retry that wakes after a pause
//    does not put back what the store held before it;
//  - `writes.sync` counts the synchronous writes that reached the disk (a settings save, the flush at
//    exit); if one finished while this write was in the threadpool its data is newer, so this one is dropped.
// The synchronous writes use a temporary file of their own (writeStoreFileSync): sharing this one let the
// two interleave, and what was renamed over store.json was the first bytes of one and the tail of the other.
async function writeStoreFile(fsp, delays, takeStore, storePath, writes) {
  const tmpPath = `${storePath}.tmp`;
  for (let attempt = 0; ; attempt += 1) {
    const mark = writes.sync;
    const store = takeStore();
    if (!store) return;
    try {
      await fsp.writeFile(tmpPath, JSON.stringify(store, null, 2), 'utf8');
      if (writes.sync !== mark) {
        await fsp.unlink(tmpPath).catch(() => {});
        return;
      }
      await fsp.rename(tmpPath, storePath);
      return;
    } catch (err) {
      if (!isRetryable(err) || attempt >= delays.length) throw err;
      await sleep(delays[attempt]);
    }
  }
}

// The same, synchronously (the flush at exit and the forced one). Returns the error that ended it, or null;
// a write that succeeds is counted in `writes.sync`, which tells an asynchronous write that it is older.
function writeStoreFileSync({ fs, delays, sleepSync, writes }, store, storePath) {
  const tmpPath = `${storePath}.sync.tmp`; // not the asynchronous write's file: see writeStoreFile
  let json;
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (json === undefined) json = JSON.stringify(store, null, 2);
      fs.writeFileSync(tmpPath, json, 'utf8');
      fs.renameSync(tmpPath, storePath);
      writes.sync += 1;
      return null;
    } catch (err) {
      if (!isRetryable(err) || attempt >= delays.length) return err;
      sleepSync(delays[attempt]);
    }
  }
}

// flushNow (Store.flushNow) is the write a route asks for right after a deliberate change: ONE synchronous
// attempt, so the change is on disk when the request is answered, and no blocking retries: sleeping on the
// event loop while the file is locked would freeze every other request. A refusal of the retryable kind is
// handed to the asynchronous retries (the same ones a debounced flush gets); only the flush at process exit,
// which has nothing left to wait for, retries by blocking (flushStoreSync).
function createStorePersistence({
  fs,
  fsp,
  logger = console,
  delayMs = 3000,
  retryDelaysMs = WRITE_RETRY_DELAYS_MS,
  syncRetryDelaysMs = SYNC_RETRY_DELAYS_MS,
  failureRetryMs = FAILURE_RETRY_MS,
  sleepSync = sleepSyncDefault,
}) {
  let flushTimer = null;
  let writing = Promise.resolve(); // asynchronous flushes run one after the other, never two at the same time
  const writes = { sync: 0 }; // synchronous writes that reached the disk; an asynchronous write older than one is dropped
  let latest = null; // the getters of the last queueDebouncedFlush call
  let failedInARow = 0;

  function flushStoreSync({ store, storePath, isShuttingDown }) {
    if (!store || isShuttingDown || !storePath) return isShuttingDown;

    const err = writeStoreFileSync({ fs, delays: syncRetryDelaysMs, sleepSync, writes }, store, storePath);
    if (err) logger.error(`[Store] Shutdown flush error: ${err.message}`);
    return true;
  }

  async function flushOnce() {
    const { getStore, getStorePath, isShuttingDown } = latest;
    const store = getStore();
    const storePath = getStorePath();
    if (isShuttingDown() || !store || !storePath) return;

    try {
      await writeStoreFile(fsp, retryDelaysMs, getStore, storePath, writes);
      failedInARow = 0;
    } catch (err) {
      logger.error(`[Store] Async write error: ${err.message}`);
      // The data is safe in memory, but nothing would save it until the next change.
      failedInARow += 1;
      if (isRetryable(err) && failedInARow <= LATER_ATTEMPTS && !flushTimer) {
        flushTimer = setTimeout(fire, failureRetryMs);
      }
    }
  }

  function fire() {
    flushTimer = null;
    // A flush that fails in a way nobody planned must not end the chain: every later flush hangs off it.
    writing = writing.then(flushOnce).catch((err) => logger.error(`[Store] Async write error: ${err.message}`));
  }

  function queueDebouncedFlush({ getStore, getStorePath, isShuttingDown }) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (isShuttingDown()) return;

    latest = { getStore, getStorePath, isShuttingDown };
    failedInARow = 0; // a change starts over with a full allowance of later attempts
    flushTimer = setTimeout(fire, delayMs);
  }

  // flushNow, the write a route asks for after a deliberate change: see the comment above createStorePersistence.
  function flushNow({ getStore, getStorePath, isShuttingDown }) {
    const store = getStore();
    const storePath = getStorePath();
    if (!store || !storePath || isShuttingDown()) return;

    const err = writeStoreFileSync({ fs, delays: [], sleepSync, writes }, store, storePath);
    if (!err) return;
    logger.error(`[Store] Immediate write error: ${err.message}`);
    if (!isRetryable(err)) return;
    latest = { getStore, getStorePath, isShuttingDown };
    failedInARow = 0;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(fire, 0);
  }

  return {
    flushStoreSync,
    flushNow,
    queueDebouncedFlush,
  };
}

module.exports = { createStorePersistence };