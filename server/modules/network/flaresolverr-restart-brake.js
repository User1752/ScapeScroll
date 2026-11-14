'use strict';

const { RECOVERY_BRAKE } = require('../../config/solver');

// A brake on the restarts the app starts by itself when FlareSolverr stops answering (recoverFromHang in
// flaresolverr-lifecycle.js). Without one, a site that wedges FlareSolverr every time it is asked turns every timeout into
// another kill-and-relaunch of a hidden Chromium: a loop that keeps every other protected source down and that an antivirus
// has every reason to dislike. Two rules:
//   - at most `maxPerWindow` recoveries in `windowMs`; after that the app waits for the oldest to age out;
//   - at least `minGapMs` between two: a timeout that was already in flight when a restart finished says nothing about the
//     NEW process, and used to cause a second restart right behind the first.
// Only the recovery from a hang is braked. The start-up check and the idle restart happen once and on purpose, and the idle
// restart is also what un-pauses a recovery that has been refused for a long time.
//
// Interface: check() -> { allowed, retryInMs, why }, record() (a recovery is really going ahead), status() for System Health.
// The clock is injected so a test needs no waiting.

function createRestartBrake({ now = Date.now, config = RECOVERY_BRAKE } = {}) {
  let times = [];

  function forget(t) {
    times = times.filter((at) => t - at < config.windowMs);
  }

  function check() {
    const t = now();
    forget(t);
    if (times.length >= config.maxPerWindow) {
      return { allowed: false, why: 'limit', retryInMs: times[0] + config.windowMs - t };
    }
    const last = times[times.length - 1];
    if (last !== undefined && t - last < config.minGapMs) {
      return { allowed: false, why: 'gap', retryInMs: last + config.minGapMs - t };
    }
    return { allowed: true, why: null, retryInMs: 0 };
  }

  function record() {
    const t = now();
    forget(t);
    times.push(t);
  }

  // Counts and times only: nothing that names a site.
  function status() {
    const verdict = check();
    return {
      restarts: times.length,
      windowMinutes: Math.round(config.windowMs / 60_000),
      paused: !verdict.allowed && verdict.why === 'limit',
      retryInSeconds: Math.ceil(verdict.retryInMs / 1000),
    };
  }

  function reset() {
    times = [];
  }

  return { check, record, status, reset };
}

module.exports = { createRestartBrake };
