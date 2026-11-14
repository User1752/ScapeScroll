'use strict';

const { POOL } = require('../../config/solver');
const { mergeConfig } = require('./solver/plain-object');
const { classifyFlareSolverrMessage, describeSolverMessage } = require('./solver/classify');
const { POOL_ERROR_CODES } = require('./solver/errors');
const { buildSessionId, parseSessionId, defaultIsPidAlive } = require('./solver/session-id');
const { createProxyResolver } = require('./solver/proxy-info');
const { createPoolState } = require('./solver/pool-state');
const { createPorts } = require('./solver/ports');
const { defaultPost, createTransport } = require('./solver/transport');
const { createHostGate } = require('./solver/host-gate');
const { createCookieWatch } = require('./solver/cookie-watch');
const { createCircuit } = require('./solver/circuit');
const { createLaunchLock } = require('./solver/launch-lock');
const { createJobs } = require('./solver/jobs');
const { createTransportFailure } = require('./solver/transport-failure');
const { createSlots } = require('./solver/slots');
const { createSessions } = require('./solver/sessions');
const { createSlotRelease } = require('./solver/slot-release');
const { createNavigation } = require('./solver/navigation');
const { createPassThrough } = require('./solver/passthrough');
const { createScheduler } = require('./solver/scheduler');
const { createPreflight } = require('./solver/preflight');
const { createStatelessLane } = require('./solver/stateless-lane');
const { createSessionRunner } = require('./solver/session-runner');
const { createIntake } = require('./solver/intake');
const { createRestart } = require('./solver/restart');
const { createOrphanSweeper } = require('./solver/orphans');
const { createPoolControl } = require('./solver/pool-control');
const { createStatus } = require('./solver/status');

// The FlareSolverr session pool: every browser call the app makes goes through
// here once the pool is switched on (fetch-utils.js builds the one instance).
//
// Why it exists: a stateless `request.get` launches Chrome, solves, and throws
// the browser away, so the Cloudflare cookie dies with it (sites that check it
// on a second page never get past) and every call pays the launch (~16 s). The
// pool keeps one Chrome session (up to maxSessions) and reuses it.
//
// The rules the code is built around, because each one was a trap in
// FlareSolverr 3.5.2 (read from its sources) and none is visible in an answer:
//   - `request.get` for a session id FlareSolverr does not know silently creates
//     an UNPROXIED session. So a request is only ever sent for an id this
//     process saw in a `sessions.create` / `sessions.list` answer of the CURRENT
//     FlareSolverr process (a restart starts a new one and every session is
//     forgotten), and never for one it has started to destroy. transport.js
//     (requestInSession) is the single place that sends one.
//   - `proxy` is read only by `sessions.create`; session_ttl_minutes would drop
//     the proxy on expiry; cookies in a session payload stay for every later
//     caller. None of the three is ever sent with a session request.
//   - A session has no lock of its own: two overlapping requests interleave. A
//     slot therefore runs one job at a time, and a slot that is being destroyed
//     is never picked (its status changes before the destroy is sent).
//   - Every `sessions.create` uses a new id, so "Session already exists." (which
//     would not apply a different proxy) and a half-destroyed driver can never be
//     mistaken for a fresh session.
//
// Everything with an effect is injected (see createSolverPool), nothing starts
// at require() time, and every timer is unref'd and only exists while there is
// something to wait for.
//
// How it is organised: one responsibility per module, all in ./solver/. This file
// only builds the shared state and the ports, wires the parts together and returns
// the public API. The parts share nothing but that state object (solver/pool-state.js
// says who writes what) and the small interface each one returns.
//   Pure rules:   classify (what an answer means), errors (what a caller gets),
//                 session-id (whose session is it), proxy-info, plain-object
//   Effects:      ports (clock, timers, log, error registry, hooks),
//                 transport (the POST and every command payload)
//   Policy:       host-gate (per-site spacing and cooldown), cookie-watch (when a site's cookie
//                 may have changed), circuit (circuit breaker),
//                 launch-lock (one browser launch at a time), transport-failure (what a
//                 request that got no answer means)
//   Sessions:     slots (where they live; close, idle timer), sessions (create / confirm /
//                 recycle), slot-release (blank reset after a job), navigation (timeout,
//                 spacing start, outcome table)
//   Jobs:         intake (run(): admission and the handle), jobs (bookkeeping), scheduler
//                 (queue, priorities, deadlines), preflight (the direct try for waiting
//                 jobs), session-runner and stateless-lane (the two ways to run a job),
//                 passthrough (the pool-off path) with site-limit (a few calls per site at a time there)
//   The pool:     restart (FlareSolverr restarts), orphans (sessions of dead processes),
//                 pool-control (settings and shutdown), status (the snapshot)

// Distinguishes two pools created in the same millisecond of one process (tests):
// without it their session ids would collide on the same FlareSolverr.
let poolsCreated = 0;

// The parts with no dependency on the scheduler. `wake` asks the scheduler to look
// at the queue again; it is late-bound (see createSolverPool).
function wireFoundation({ cfg, state, ports, post, wake }) {
  const jobs = createJobs({ state, cfg, ports });
  // Any answer from FlareSolverr ends "it refused the connection" (state.solverRefused, read by System Health).
  const transport = createTransport({ post, cfg, onAnswer: () => { state.solverRefused = false; } });
  const onTransportFailure = createTransportFailure({ state, cfg, ports, rejectQueued: jobs.rejectQueued });
  return {
    jobs,
    transport,
    onTransportFailure,
    hostGate: createHostGate({ cfg, state, ports }),
    cookieWatch: createCookieWatch({ cfg, ports }),
    circuit: createCircuit({ cfg, ports }),
    launchLock: createLaunchLock({ onFree: wake }),
    slots: createSlots({ state, cfg, ports, transport, onTransportFailure, wake }),
  };
}

// What happens on a slot around a job: the session behind it, the navigation, the
// blank reset after it; plus the pool-off path.
function wireSessionHandling(base, foundation, { pid, startTag, post, resolveProxy, wake }) {
  const { state, cfg, ports } = base;
  const { transport, slots, hostGate, cookieWatch, circuit, launchLock, jobs, onTransportFailure } = foundation;
  return {
    sessions: createSessions({ state, cfg, ports, pid, startTag, transport, slots, launchLock, circuit }),
    slotRelease: createSlotRelease({ state, cfg, ports, transport, slots, onTransportFailure, wake }),
    navigation: createNavigation({ state, cfg, ports, hostGate, cookieWatch, circuit, onTransportFailure }),
    passthrough: createPassThrough({ cfg, ports, post, resolveProxy, jobs }),
  };
}

// The scheduler and the parts it starts. The scheduler is built first and starts
// the others through `dispatch`, whose functions are bound here to parts that are
// built right after it and call back into it.
function wireScheduling(base, foundation, handling, { resolveProxy, wake }) {
  const { state, cfg, ports } = base;
  const { transport, slots, hostGate, cookieWatch, circuit, launchLock, jobs } = foundation;
  const { sessions, slotRelease, navigation, passthrough } = handling;
  const dispatch = {
    startPreflight: (job) => preflight.start(job),
    runSession: (job, slot) => sessionRunner.run(job, slot),
    startStateless: (job, release) => statelessLane.start(job, release),
  };
  const scheduler = createScheduler({ state, cfg, ports, hostGate, cookieWatch, circuit, launchLock, slots, jobs, passthrough, dispatch });
  const statelessLane = createStatelessLane({ state, ports, transport, resolveProxy, launchLock, navigation, jobs, scheduler });
  const sessionRunner = createSessionRunner({
    cfg, ports, transport, resolveProxy, slots, sessions, navigation, slotRelease, jobs, scheduler, statelessLane,
  });
  const preflight = createPreflight({ state, ports, jobs, passthrough, cookieWatch, resolveProxy, wake });
  const intake = createIntake({ state, cfg, ports, hostGate, cookieWatch, circuit, jobs, passthrough, wake });
  return { scheduler, intake };
}

// The operations around the pool as a whole.
function wireControl(base, foundation, handling, scheduler, { pid, startTag, isPidAlive, wake }) {
  const { state, cfg, ports } = base;
  const { transport, slots, hostGate, circuit, jobs } = foundation;
  const restart = createRestart({ state, cfg, ports, slots, circuit, rejectQueued: jobs.rejectQueued, wake });
  return {
    restart,
    orphans: createOrphanSweeper({ state, cfg, ports, transport, pid, startTag, isPidAlive }),
    control: createPoolControl({ state, cfg, ports, slots, jobs, scheduler, passthrough: handling.passthrough, restart }),
    status: createStatus({ state, ports, slots, hostGate, circuit }),
  };
}

/**
 * Builds a pool. Every external effect is injected so it can be tested against
 * the fake FlareSolverr (tests/helpers/fake-flaresolverr.js) with fake clocks.
 *
 *   config           POOL tunables (config/solver.js) with test overrides laid on a copy
 *   post             (solverUrl, payload, { timeoutMs }) -> { httpStatus, body|null }; rejects with the raw transport error
 *   getSolverProxy   (solverUrl) -> null | { proxy: { url, username?, password? } | null, mode, fingerprint }
 *   hooks            { noteUsed, recoverFromHang, onProxyFault?, onRestart?, isOffByChoice? }
 *   now, setTimer, clearTimer, pid, isPidAlive, log, warn, recordError
 *
 * Until applySettings() says otherwise the pool is OFF and every call goes
 * straight to FlareSolverr, exactly as it did before the pool existed: nothing
 * is queued, spaced or opened for a caller that has not been told the pool is
 * wanted (boot, a unit test that loads fetch-utils).
 */
function createSolverPool(deps = {}) {
  const cfg = mergeConfig(POOL, deps.config);
  const state = createPoolState(cfg);
  const ports = createPorts(deps, state);
  const base = { state, cfg, ports };
  const post = deps.post || defaultPost;
  const resolveProxy = createProxyResolver(deps.getSolverProxy || (async () => null));
  const pid = deps.pid ?? process.pid;
  const startTag = `${Date.now().toString(36)}${(poolsCreated += 1).toString(36)}`;

  // The parts that wake the scheduler are built before it, so they get this
  // late-bound function; `scheduling` is assigned two statements below.
  let scheduling = null;
  const wake = () => scheduling.scheduler.schedulePump();

  const foundation = wireFoundation({ ...base, post, wake });
  const handling = wireSessionHandling(base, foundation, { pid, startTag, post, resolveProxy, wake });
  scheduling = wireScheduling(base, foundation, handling, { resolveProxy, wake });
  const control = wireControl(base, foundation, handling, scheduling.scheduler, {
    pid, startTag, isPidAlive: deps.isPidAlive || defaultIsPidAlive, wake,
  });

  // The pool reacts to restarts itself, so whoever builds it only passes the
  // registration function (flaresolverr-lifecycle's registerRestartListener).
  control.restart.subscribe();

  return {
    run: scheduling.intake.run,
    applySettings: control.control.applySettings,
    beginRestart: control.restart.beginRestart,
    endRestart: control.restart.endRestart,
    sweepOrphans: control.orphans.sweepOrphans,
    closeAll: foundation.slots.closeAll,
    shutdown: control.control.shutdown,
    getStatus: control.status.getStatus,
  };
}

module.exports = {
  createSolverPool,
  classifyFlareSolverrMessage,
  describeSolverMessage,
  buildSessionId,
  parseSessionId,
  POOL_ERROR_CODES,
};
