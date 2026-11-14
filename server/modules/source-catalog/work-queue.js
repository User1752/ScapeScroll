'use strict';

// A small background queue: a few jobs at a time, a pause between starts, one job per key (asking for the same key twice while it waits
// or runs does nothing), and a breaker that stops starting jobs for a while after several failures in a row (offline, or the host is
// refusing). A job never throws into the caller: its failure only counts toward the breaker.

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * @param {{ concurrency: number, spacingMs: number, breakerCount: number, breakerMs: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} options
 */
function createWorkQueue({ concurrency, spacingMs, breakerCount, breakerMs, now = Date.now, sleep = wait }) {
  const waiting = [];
  const keys = new Set();
  let running = 0;
  let failures = 0;
  let pausedUntil = 0;
  let pumping = false;

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (waiting.length) {
        if (now() < pausedUntil) { await sleep(Math.min(1000, pausedUntil - now())); continue; }
        if (running >= concurrency) { await sleep(20); continue; }
        const job = waiting.shift();
        running += 1;
        Promise.resolve()
          .then(job.run)
          .then(() => { failures = 0; }, () => {
            failures += 1;
            if (failures >= breakerCount) { failures = 0; pausedUntil = now() + breakerMs; }
          })
          .finally(() => { running -= 1; keys.delete(job.key); });
        if (spacingMs) await sleep(spacingMs);
      }
    } finally {
      pumping = false;
    }
  }

  return {
    /** Queues the job unless one with this key is already waiting or running. @returns {boolean} whether it was queued */
    add(key, run) {
      if (keys.has(key)) return false;
      keys.add(key);
      waiting.push({ key, run });
      pump();
      return true;
    },
    has: (key) => keys.has(key),
    /** Jobs waiting or running. */
    size: () => waiting.length + running,
    paused: () => now() < pausedUntil,
    /** Drops the jobs that have not started (the ones running finish). */
    clear() { for (const job of waiting.splice(0)) keys.delete(job.key); },
  };
}

module.exports = { createWorkQueue };
