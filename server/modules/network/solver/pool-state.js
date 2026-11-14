'use strict';

// The one object the pool's parts share. Created by the composition root
// (solver-pool.js) and handed to every part that needs it; nothing else is
// shared between parts except the ports (ports.js) and the small interfaces each
// part returns. State that only ONE part touches stays inside that part
// (host-gate: the per-site gates; circuit: the failure window; launch-lock: the
// lock; slots: the id counter and the idle timer; ...), so it is not here.
//
// Who writes what (W = writes, R = reads):
//   enabled, disabledBy, maxSessions, idleMs
//                  W pool-control (applySettings); R every part that decides anything
//   shuttingDown   W pool-control (shutdown);
//                  R intake, scheduler, sessions, stateless-lane, preflight, restart, orphans
//   restarting     W restart (pool-control clears it when the pool is switched off);
//                  R scheduler, stateless-lane, transport-failure, orphans, status
//   downUntil      W transport-failure, restart (pool-control clears it on switch-off);
//                  R intake (admission), status
//   downReported   W transport-failure (a "not answering" / "not reachable" line was said); navigation, restart
//                  (FlareSolverr answered, or restarted: the next failure is a new episode); R transport-failure
//   solverRefused  W transport-failure (the last request to FlareSolverr was refused: nothing is listening),
//                  the transport's answer hook in solver-pool.js (any answer ends it), restart (it is back);
//                  R status (System Health: "waiting for FlareSolverr")
//   sessionsUnsupported
//                  W sessions, restart (a new FlareSolverr process starts over); R intake, scheduler
//   blankUnsupported, blankFailures
//                  W slot-release, restart; R slot-release
//   slots          W slots (restart goes through slots.abandonAll);
//                  R slots, transport-failure (forgets what it verified), pool-control (is it empty)
//   affinity       W slots (forgets a slot), scheduler (assigns a site to a slot); R scheduler
//   queue          W intake (adds), scheduler (requeue), jobs (removes);
//                  R scheduler, slots (the idle check), status, pool-control (switch-off)
//   preflightBusy  W preflight; R scheduler (one preflight at a time, pool-wide)
//   inFlight, drainWaiters
//                  W jobs (counts; wakes the waiters), pool-control adds a waiter; R status
//   emptyWaiters   W pool-control adds a waiter, slots wakes them when the last slot is gone
//   lastError      W ports.noteLastError; R status
//   counters       W the part that counts what it does; R status
//
// A slot is a plain object created by slots.js (newSlot documents its fields);
// a job is created by intake.js (buildJob). Parts change the fields of the ones
// they were handed, as the single closure did before the split.

function createPoolState(cfg) {
  return {
    enabled: false,
    disabledBy: null,
    maxSessions: cfg.defaultMaxSessions,
    idleMs: cfg.defaultIdleMinutes * 60_000,
    shuttingDown: false,

    // What this FlareSolverr process is known not to do. A restart starts a new
    // process, so these start over with it.
    sessionsUnsupported: false,
    blankUnsupported: false,
    blankFailures: 0,
    restarting: false,
    downUntil: 0,
    downReported: false,
    solverRefused: false,

    slots: new Map(), // slot.key -> slot
    affinity: new Map(), // hostKey -> the slot that holds that site's cookies
    queue: [], // jobs waiting for a slot (state 'queued') or for their preflight ('preflighting')

    preflightBusy: false,
    inFlight: 0,
    drainWaiters: [], // resolved when no job is in flight
    emptyWaiters: [], // resolved when no slot is left
    lastError: null,
    counters: {
      jobs: 0, sessionJobs: 0, statelessJobs: 0, directJobs: 0, resets: 0, recycles: 0,
      hostBlocks: 0, queueTimeouts: 0, orphansSwept: 0, httpErrors: 0,
    },
  };
}

module.exports = { createPoolState };
