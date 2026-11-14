'use strict';

// "Leave the sites alone for a moment": while a person watches a live Test of a source, the app's own background probes (the
// System Health source checks) stand aside, so the one thing being measured is not fighting them for the same browser, the same
// IP and the same rate limits. A probe that finds the app quiet answers from what it already knew instead of calling the site.
//
// Holds nothing but a clock reading per run: no timer, no file. A run that never calls its `end` (a crash between begin and end)
// cannot silence the probes for good, because every run expires by itself after `maxMs`.

const DEFAULT_MAX_MS = 6 * 60_000; // a little more than the longest a live Test may run (5 minutes)

function createQuietMode({ now = Date.now, maxMs = DEFAULT_MAX_MS } = {}) {
  const runs = new Set(); // each entry is { expiresAt }

  function prune() {
    const t = now();
    for (const run of runs) if (t >= run.expiresAt) runs.delete(run);
  }

  /** Starts a quiet stretch; returns the function that ends it (calling it twice is harmless). */
  function begin() {
    const run = { expiresAt: now() + maxMs };
    runs.add(run);
    return () => { runs.delete(run); };
  }

  function isQuiet() {
    prune();
    return runs.size > 0;
  }

  return { begin, isQuiet };
}

// The one the app uses; tests build their own with a fake clock.
const appQuietMode = createQuietMode();

module.exports = { createQuietMode, beginQuiet: appQuietMode.begin, isQuiet: appQuietMode.isQuiet, DEFAULT_MAX_MS };
