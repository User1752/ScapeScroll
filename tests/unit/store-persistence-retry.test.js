'use strict';

// server/modules/store/persistence.js: a write the operating system refuses for a moment (an antivirus or a
// sync client holding store.json, seen live as "EPERM ... rename store.json.tmp -> store.json" on the mapped
// network drive) is retried, and one that still fails is tried again later instead of being dropped until
// the next change. Everything is faked: no real file, the delays are a few milliseconds.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStorePersistence } = require('../../server/modules/store/persistence');

const STORE_PATH = 'Z:\\fake\\data\\store.json';

function refusal(code) {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

// A fake disk: `renameFails` is a queue of error codes the next renames throw (then they succeed), or a code
// that every rename throws. It records what was written and how many writes ever overlapped. `disk.gate`, when
// set to a promise, holds every asynchronous write "in the threadpool" until it resolves.
function fakeDisk({ renameFails = [], alwaysFail = null } = {}) {
  const disk = { tmp: [], renamed: [], renameCalls: 0, running: 0, peak: 0, syncRenameCalls: 0, syncWrites: [], unlinked: [], gate: null };
  const queue = [...renameFails];
  disk.fsp = {
    async writeFile(path, text) {
      disk.running += 1;
      disk.peak = Math.max(disk.peak, disk.running);
      await new Promise((resolve) => { setImmediate(resolve); });
      if (disk.gate) await disk.gate;
      disk.tmp.push({ path, text });
      disk.running -= 1;
    },
    async unlink(path) { disk.unlinked.push(path); },
    async rename(from, to) {
      disk.renameCalls += 1;
      await new Promise((resolve) => { setImmediate(resolve); });
      if (alwaysFail) throw refusal(alwaysFail);
      if (queue.length) throw refusal(queue.shift());
      disk.renamed.push({ from, to });
    },
  };
  const syncQueue = [...renameFails];
  disk.fs = {
    writeFileSync(path, text) { disk.syncWrites.push({ path, text }); },
    renameSync(from, to) {
      disk.syncRenameCalls += 1;
      if (alwaysFail) throw refusal(alwaysFail);
      if (syncQueue.length) throw refusal(syncQueue.shift());
      disk.renamed.push({ from, to });
    },
  };
  return disk;
}

function logger() {
  const lines = [];
  return { lines, error: (line) => lines.push(String(line)), warn: () => {}, log: () => {} };
}

function persistenceOver(disk, log, extra = {}) {
  return createStorePersistence({
    fs: disk.fs,
    fsp: disk.fsp,
    logger: log,
    delayMs: 2,
    retryDelaysMs: [1, 1, 1],
    failureRetryMs: 15,
    syncRetryDelaysMs: [0, 0, 0],
    sleepSync: () => {},
    ...extra,
  });
}

async function until(check, what, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, 2); });
  }
}

function queueFlush(persistence, store = { n: 1 }, getStore = () => store) {
  persistence.queueDebouncedFlush({ getStore, getStorePath: () => STORE_PATH, isShuttingDown: () => false });
}

test('a rename the system refuses twice and then allows is retried and nothing is reported', async () => {
  const disk = fakeDisk({ renameFails: ['EPERM', 'EBUSY'] });
  const log = logger();
  queueFlush(persistenceOver(disk, log));
  await until(() => disk.renamed.length === 1, 'the file to be replaced');
  assert.equal(disk.renameCalls, 3);
  assert.deepEqual(log.lines, []);
  assert.deepEqual(disk.renamed, [{ from: `${STORE_PATH}.tmp`, to: STORE_PATH }]);
  assert.equal(JSON.parse(disk.tmp.at(-1).text).n, 1);
});

test('EACCES counts as a moment too; any other error is reported once and not repeated', async () => {
  const eacces = fakeDisk({ renameFails: ['EACCES'] });
  queueFlush(persistenceOver(eacces, logger()));
  await until(() => eacces.renamed.length === 1, 'EACCES to be retried');

  const full = fakeDisk({ alwaysFail: 'ENOSPC' });
  const log = logger();
  queueFlush(persistenceOver(full, log));
  await until(() => log.lines.length === 1, 'the error to be reported');
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.equal(full.renameCalls, 1, 'a full disk is not retried');
  assert.equal(log.lines.length, 1, 'and not reported again by a rescheduled flush');
  assert.match(log.lines[0], /^\[Store\] Async write error: ENOSPC/);
});

test('a write that keeps being refused is reported, then tried again later, a few times and no more', async () => {
  const disk = fakeDisk({ alwaysFail: 'EPERM' });
  const log = logger();
  const persistence = persistenceOver(disk, log);
  queueFlush(persistence);
  // 1 first flush + 5 later attempts, each with its own 1 + 3 renames (the first try and three retries).
  await until(() => log.lines.length >= 6, 'six reports', 4000);
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.equal(log.lines.length, 6, 'it gives up until something changes again');
  assert.equal(disk.renameCalls, 6 * 4);

  // The next change starts over with a fresh allowance.
  queueFlush(persistence);
  await until(() => log.lines.length >= 7, 'a new flush after the next change');
  await until(() => log.lines.length >= 12, 'its own five later attempts', 4000);
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  assert.equal(log.lines.length, 12);
});

test('the later attempt writes what the store holds then, and a success ends the retries', async () => {
  const disk = fakeDisk({ renameFails: ['EPERM', 'EPERM', 'EPERM', 'EPERM'] }); // first flush: try + 3 retries all refused
  const log = logger();
  let store = { n: 1 };
  // A long second chance, so the change below always lands before it.
  queueFlush(persistenceOver(disk, log, { failureRetryMs: 150 }), store, () => store);
  await until(() => log.lines.length === 1, 'the first flush to give up');
  store = { n: 2 }; // changed while it was waiting for its second chance
  await until(() => disk.renamed.length === 1, 'the later attempt to succeed');
  assert.equal(JSON.parse(disk.tmp.at(-1).text).n, 2, 'it wrote the latest state, not the one it first failed on');
  const renames = disk.renameCalls;
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  assert.equal(disk.renameCalls, renames, 'nothing is retried after a success');
});

test('two flushes never write at the same time, even when one is waiting out a refusal', async () => {
  const disk = fakeDisk({ renameFails: ['EPERM', 'EPERM'] });
  const persistence = persistenceOver(disk, logger(), { delayMs: 1, retryDelaysMs: [20, 20, 20] });
  queueFlush(persistence);
  await until(() => disk.renameCalls >= 1, 'the first rename');
  queueFlush(persistence, { n: 3 }); // a newer change arrives while the first flush is retrying
  await until(() => disk.renamed.length >= 2, 'both flushes to finish', 4000);
  assert.equal(disk.peak, 1, 'at most one write to the temporary file at any moment');
  assert.equal(JSON.parse(disk.tmp.at(-1).text).n, 3);
});

test('the flush at exit retries a refused rename a few times before giving up, and still never throws', () => {
  const recovers = fakeDisk({ renameFails: ['EPERM', 'EBUSY'] });
  const log = logger();
  const persistence = persistenceOver(recovers, log);
  const result = persistence.flushStoreSync({ store: { n: 1 }, storePath: STORE_PATH, isShuttingDown: false });
  assert.equal(result, true);
  assert.equal(recovers.syncRenameCalls, 3);
  assert.deepEqual(recovers.renamed, [{ from: `${STORE_PATH}.sync.tmp`, to: STORE_PATH }]);
  assert.deepEqual(log.lines, []);

  const stuck = fakeDisk({ alwaysFail: 'EPERM' });
  const stuckLog = logger();
  const again = persistenceOver(stuck, stuckLog).flushStoreSync({ store: { n: 1 }, storePath: STORE_PATH, isShuttingDown: false });
  assert.equal(again, true);
  assert.equal(stuck.syncRenameCalls, 4, 'the first try and three retries');
  assert.match(stuckLog.lines[0], /^\[Store\] Shutdown flush error: EPERM/);

  const notRetried = fakeDisk({ alwaysFail: 'ENOSPC' });
  persistenceOver(notRetried, logger()).flushStoreSync({ store: { n: 1 }, storePath: STORE_PATH, isShuttingDown: false });
  assert.equal(notRetried.syncRenameCalls, 1);
});

test('nothing is written while the app is shutting down or without a store, as before', async () => {
  const disk = fakeDisk();
  const persistence = persistenceOver(disk, logger());
  assert.equal(persistence.flushStoreSync({ store: null, storePath: STORE_PATH, isShuttingDown: false }), false);
  assert.equal(persistence.flushStoreSync({ store: { n: 1 }, storePath: STORE_PATH, isShuttingDown: true }), true);
  persistence.queueDebouncedFlush({ getStore: () => ({ n: 1 }), getStorePath: () => STORE_PATH, isShuttingDown: () => true });
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  assert.equal(disk.tmp.length + disk.syncWrites.length, 0);
});

// ── the write a route asks for right after a deliberate change (Store.flushNow) ─────────────────────────

function nowPorts(store = { n: 1 }) {
  return { getStore: () => store, getStorePath: () => STORE_PATH, isShuttingDown: () => false };
}

test('flushNow writes once, synchronously, and sleeps for nothing', () => {
  const disk = fakeDisk();
  let slept = 0;
  const persistence = persistenceOver(disk, logger(), { sleepSync: () => { slept += 1; } });
  persistence.flushNow(nowPorts());
  assert.equal(disk.syncRenameCalls, 1);
  assert.deepEqual(disk.renamed, [{ from: `${STORE_PATH}.sync.tmp`, to: STORE_PATH }], 'on disk before the call returns');
  assert.equal(slept, 0);
});

// ── a synchronous write and an asynchronous one that overlap (a settings save while a debounced flush runs) ──

// Starts a debounced flush and holds it inside the "threadpool"; resolves with the function that lets it go on.
async function holdAnAsyncWrite(disk, persistence, store) {
  let release;
  disk.gate = new Promise((resolve) => { release = resolve; });
  queueFlush(persistence, store);
  await until(() => disk.running === 1, 'the asynchronous write to be in flight');
  return () => { disk.gate = null; release(); };
}

test('a synchronous write never shares a temporary file with an asynchronous one in flight', async () => {
  const disk = fakeDisk();
  const persistence = persistenceOver(disk, logger());
  const letGo = await holdAnAsyncWrite(disk, persistence, { n: 1 });
  persistence.flushNow(nowPorts({ n: 2 }));
  letGo();
  await until(() => disk.running === 0 && disk.unlinked.length + disk.renamed.length === 2, 'both writes to be settled');
  assert.deepEqual(disk.syncWrites.map((w) => w.path), [`${STORE_PATH}.sync.tmp`]);
  assert.deepEqual(disk.tmp.map((w) => w.path), [`${STORE_PATH}.tmp`]);
});

test('an asynchronous write that a settings save overtook is dropped, so it cannot put older data back over store.json', async () => {
  const disk = fakeDisk();
  const persistence = persistenceOver(disk, logger());
  const letGo = await holdAnAsyncWrite(disk, persistence, { n: 1 });
  persistence.flushNow(nowPorts({ n: 2 }));
  assert.deepEqual(disk.renamed, [{ from: `${STORE_PATH}.sync.tmp`, to: STORE_PATH }]);
  letGo();
  await until(() => disk.unlinked.length === 1, 'the stale write to give up');
  assert.deepEqual(disk.renamed, [{ from: `${STORE_PATH}.sync.tmp`, to: STORE_PATH }], 'the old snapshot was not renamed over the new one');
  assert.deepEqual(disk.unlinked, [`${STORE_PATH}.tmp`]);
});

test('the flush at exit overtakes an asynchronous write the same way', async () => {
  const disk = fakeDisk();
  const persistence = persistenceOver(disk, logger());
  const letGo = await holdAnAsyncWrite(disk, persistence, { n: 1 });
  persistence.flushStoreSync({ store: { n: 2 }, storePath: STORE_PATH, isShuttingDown: false });
  letGo();
  await until(() => disk.unlinked.length === 1, 'the stale write to give up');
  assert.equal(disk.renamed.length, 1);
});

test('a write that fails synchronously does not make the asynchronous one stale', async () => {
  const disk = fakeDisk({ renameFails: ['EPERM'] });
  const persistence = persistenceOver(disk, logger());
  const letGo = await holdAnAsyncWrite(disk, persistence, { n: 1 });
  persistence.flushNow(nowPorts({ n: 2 })); // refused: nothing newer reached the disk
  letGo();
  await until(() => disk.renamed.length >= 1 && disk.running === 0, 'the asynchronous write to land');
  assert.deepEqual(disk.unlinked, []);
  assert.equal(disk.renamed.at(-1).from, `${STORE_PATH}.tmp`);
});

test('flushNow never blocks the event loop on a refused rename: the retries are the asynchronous ones', async () => {
  const disk = fakeDisk({ renameFails: ['EPERM'] });
  const log = logger();
  let slept = 0;
  const persistence = persistenceOver(disk, log, { sleepSync: () => { slept += 1; } });
  persistence.flushNow(nowPorts({ n: 7 }));
  assert.equal(disk.syncRenameCalls, 1, 'one attempt on the spot');
  assert.equal(slept, 0, 'and no sleeping on the event loop');
  assert.match(log.lines[0], /^\[Store\] Immediate write error: EPERM/);
  await until(() => disk.renamed.length === 1, 'the background retry to write the file');
  assert.equal(JSON.parse(disk.tmp.at(-1).text).n, 7);
});

test('flushNow reports another kind of failure once and does not retry it; nothing is written without a store or while shutting down', async () => {
  const full = fakeDisk({ alwaysFail: 'ENOSPC' });
  const log = logger();
  persistenceOver(full, log).flushNow(nowPorts());
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  assert.equal(full.syncRenameCalls, 1);
  assert.equal(full.renameCalls, 0, 'no asynchronous retry');
  assert.equal(log.lines.length, 1);

  const idle = fakeDisk();
  const persistence = persistenceOver(idle, logger());
  persistence.flushNow({ getStore: () => null, getStorePath: () => STORE_PATH, isShuttingDown: () => false });
  persistence.flushNow({ getStore: () => ({ n: 1 }), getStorePath: () => '', isShuttingDown: () => false });
  persistence.flushNow({ getStore: () => ({ n: 1 }), getStorePath: () => STORE_PATH, isShuttingDown: () => true });
  assert.equal(idle.syncWrites.length + idle.tmp.length, 0);
});
