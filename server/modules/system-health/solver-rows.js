'use strict';

/**
 * server/modules/system-health/solver-rows.js — the two External Services rows that are about
 * FlareSolverr: its own ("is it up?") and the one for the browser-session pool in front of it
 * ("what is it doing?"). They sit next to each other in the grid, so what one says must not
 * contradict the other; services-health.js builds the service around them.
 */

const { isLoopbackUrl } = require('../common/host-utils');
const { warnOnce } = require('../common/env-flags');
const { describeSolverMessage } = require('../network/solver/classify');
const { ENV_NAMES, solverStatusUrl } = require('../../config/solver');

// ── The pool's row ───────────────────────────────────────────────────────────

// The FlareSolverr session pool (network/solver-pool.js) lives in this process, so, like Discord
// RPC, this reads its status instead of probing anything. Counts and states only: the status
// names the sites that are cooling down, and not even those are printed here, and it holds no URL,
// cookie, proxy or session id at all.
const SOLVER_POOL_ROW = Object.freeze({ id: 'solver-pool', name: 'Browser sessions' });

const SOLVER_POOL_OFF_DETAILS = Object.freeze({
  setting: 'Off (not switched on in Settings)',
  env: `Off (${ENV_NAMES.solverSessionsDisabled} is set)`,
});

// What the row says when the pool has a browser to offer but FlareSolverr, which opens it, is away. Not a fault:
// the FlareSolverr row next to it says why (and a user who switched it off chose this).
const WAITING_DETAILS = Object.freeze({
  off: 'Waiting for FlareSolverr (it is off)',
  unreachable: 'Waiting for FlareSolverr (it is not reachable)',
});
const WAITING_STATES = new Set(['idle', 'active', 'down']);

// The FlareSolverr row says this when nothing listens on the port by choice or because nothing is installed.
const FLARESOLVERR_OFF_DETAILS = 'Off (not installed, or you chose not to use it)';

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

function coolingNote(snapshot) {
  const cooling = Array.isArray(snapshot.cooldowns) ? snapshot.cooldowns.length : 0;
  return cooling ? `, ${plural(cooling, 'site')} cooling down` : '';
}

function describeOpenSessions(snapshot) {
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const requests = sessions.reduce((sum, session) => sum + (Number(session.uses) || 0), 0);
  const idleMs = sessions.filter((session) => !session.busy).map((session) => Number(session.idleMs) || 0);
  const use = idleMs.length ? `idle ${Math.round(Math.min(...idleMs) / 60_000)} min` : 'in use';
  const queued = (Number(snapshot.queued?.interactive) || 0) + (Number(snapshot.queued?.background) || 0);
  return `${plural(sessions.length, 'session')} open (${use}, ${plural(requests, 'request')}), queue ${queued}${coolingNote(snapshot)}`;
}

// What the browser is waiting for, 'off' | 'unreachable', or null. The row next to this one is the live truth about
// FlareSolverr, so it comes first: when it answers, the pool's memory of a refusal is old (and a FlareSolverr the user
// runs themselves is not "off" because the app was told not to start one); when it says Off, so does this row, even
// before any call has told the pool anything. Otherwise the pool's own account (status.solver) decides, except that
// its "off" is the app's own choice about the copy it would start: next to a row that shows a real failure (a
// FlareSolverr the user runs elsewhere, which is theirs to keep up) the browser is waiting for one that is not there.
function whatItWaitsFor(snapshot, flareRow) {
  if (flareRow && flareRow.ok && /^Reachable/.test(String(flareRow.details))) return null;
  if (flareRow && flareRow.details === FLARESOLVERR_OFF_DETAILS) return 'off';
  if (snapshot.solver === 'off') return flareRow && flareRow.ok === false ? 'unreachable' : 'off';
  return snapshot.solver === 'refused' ? 'unreachable' : null;
}

/**
 * The System Health row for the session pool, from pool.getStatus() and, when there is one, the FlareSolverr row
 * beside it; null (no row) for anything that is not a status. Only a pool that keeps failing is a warning: a
 * switched-off or restarting pool is not a fault, a browser waiting for a FlareSolverr that is away is not one
 * either (that row has its own say), and a FlareSolverr that is down already has its own row.
 */
function checkSolverPool(snapshot, flareRow) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const ok = (details) => ({ ...SOLVER_POOL_ROW, ok: true, error: '', details });
  const waiting = WAITING_STATES.has(snapshot.state) ? whatItWaitsFor(snapshot, flareRow) : null;
  if (waiting) return ok(WAITING_DETAILS[waiting]);
  switch (snapshot.state) {
    case 'disabled':
      return ok(SOLVER_POOL_OFF_DETAILS[snapshot.disabledBy] || 'Off');
    case 'restarting':
      return ok('FlareSolverr is restarting; requests wait');
    case 'down':
      return ok('FlareSolverr did not answer; retrying shortly');
    case 'circuit-open': {
      const minutes = Math.max(1, Math.ceil((Number(snapshot.circuit?.secondsLeft) || 0) / 60));
      // Explicit warning: this text means nothing to the error classifier, which would call it a failure.
      return { ...SOLVER_POOL_ROW, ok: false, severity: 'warning', error: `Browser sessions kept failing; using one-off browsers for the next ${minutes} min` };
    }
    case 'active':
      return ok(describeOpenSessions(snapshot));
    case 'idle':
      return ok(`Ready (a browser opens when a protected site is first needed)${coolingNote(snapshot)}`);
    default:
      return null;
  }
}

// The pool's row, read in-process on every call (not with the cache of the network probes). A snapshot that is
// missing (no pool yet) or throws just leaves the row out: it never fails the health check, and a throw is reported once.
function readSolverPoolRow(getSolverSnapshot, flareRow) {
  try {
    return checkSolverPool(getSolverSnapshot(), flareRow);
  } catch (err) {
    warnOnce('solver-pool-health-row', `[SystemHealth] The browser-session row was left out: ${err && err.message}`);
    return null;
  }
}

// The probes with the pool's row right after FlareSolverr's own: that is the service it is a pool of.
function placeSolverPoolRow(probes, poolRow) {
  return poolRow ? probes.flatMap((row) => (row.id === 'flaresolverr' ? [row, poolRow] : [row])) : probes;
}

// ── FlareSolverr's own row ───────────────────────────────────────────────────

const flaresolverrRow = (fields) => ({ id: 'flaresolverr', name: 'FlareSolverr', ...fields });

// "Nothing is listening" (not a timeout, not an HTTP error: something that
// answers badly is a real problem whoever started it).
function isConnectionFailure(err) {
  return err?.name !== 'TimeoutError' && err?.name !== 'AbortError';
}

// What the app did about a hung FlareSolverr lately (flaresolverr-lifecycle.js getRecoveryStatus): how many automatic restarts, and
// whether the brake has paused them. Counts and times only. Nothing to say when it has not had to restart it.
function recoveryNoteOf(getRecoveryStatus) {
  let status;
  try {
    status = getRecoveryStatus();
  } catch {
    return { text: '', paused: null };
  }
  if (!status || !(status.restarts > 0)) return { text: '', paused: null };
  return {
    text: `, restarted ${plural(status.restarts, 'time')} by the app in the last ${status.windowMinutes} min`,
    paused: status.paused ? Math.max(1, Math.ceil(status.retryInSeconds / 60)) : null,
  };
}

/**
 * The FlareSolverr probe. FlareSolverr is opt-in (see flaresolverr-lifecycle.js): a user who answered no,
 * set FLARESOLVERR_DISABLED, or never installed it has nothing listening on the port by choice, which is not a
 * fault. Only the copy this app would run itself can be "off by choice": a FlareSolverr the user pointed Settings
 * at on another host (Docker, a NAS) is theirs to keep up, so a failure there is still a failure. When in doubt
 * (the check itself throws) the failure stands.
 */
function createFlareSolverrCheck({ getFlaresolverrUrl, isFlaresolverrManaged, timeoutMs, getRecoveryStatus = () => null }) {
  function failureOrOff(url, err, failure) {
    if (!isConnectionFailure(err) || !isLoopbackUrl(url)) return failure;
    try {
      if (isFlaresolverrManaged()) return failure;
    } catch {
      return failure;
    }
    return flaresolverrRow({ ok: true, error: '', details: FLARESOLVERR_OFF_DETAILS });
  }

  return async function checkFlareSolverr() {
    let url;
    try {
      url = await getFlaresolverrUrl();
      if (!url) return flaresolverrRow({ ok: false, error: 'Not configured.' });
    } catch (e) {
      return flaresolverrRow({ ok: false, error: `Config read failed: ${e.message}` });
    }

    try {
      // FlareSolverr's own root (solverStatusUrl: not /v1, which only accepts POST commands)
      // answers a plain GET with a small "I'm alive" JSON status page.
      const res = await fetch(solverStatusUrl(url), { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return flaresolverrRow({ ok: false, error: `HTTP ${res.status}` });
      const data = await res.json().catch(() => null);
      const version = data?.version ? ` v${data.version}` : '';
      const recovery = recoveryNoteOf(getRecoveryStatus);
      if (recovery.paused) {
        // Explicit warning: it answers now, but it keeps hanging and the app has stopped restarting it for a while.
        return flaresolverrRow({ ok: false, severity: 'warning', error: `FlareSolverr keeps hanging${recovery.text}; automatic restarts are paused for ${recovery.paused} more min` });
      }
      return flaresolverrRow({ ok: true, error: '', details: `Reachable${version}${recovery.text}` });
    } catch (err) {
      // Node's refusal of a URL with user:pass@ in it echoes the whole address, and this row is served to every
      // client on the network: the same sanitiser as for FlareSolverr's own messages takes addresses out.
      return failureOrOff(url, err, flaresolverrRow({ ok: false, error: describeSolverMessage(err && err.message) }));
    }
  };
}

module.exports = {
  checkSolverPool,
  readSolverPoolRow,
  placeSolverPoolRow,
  createFlareSolverrCheck,
};
