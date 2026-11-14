'use strict';

/**
 * server/modules/system-health/services-health.js — External service checks
 *
 * Distinct from source health: these are shared infrastructure the app
 * depends on regardless of which manga/anime source is in use — FlareSolverr
 * (Cloudflare bypass, used by several sources on-demand) and the AniList API
 * (progress sync, anime search/details, home-page discovery). A source can
 * look "down" for a reason that's actually one of these, so surfacing them
 * separately makes that diagnosable instead of guessing per-source.
 */

const {
  checkSolverPool, readSolverPoolRow, placeSolverPoolRow, createFlareSolverrCheck,
} = require('./solver-rows');

const SERVICE_CHECK_TIMEOUT_MS = 8_000;

// Unlike FlareSolverr/AniList, this isn't a network probe — the connection
// (or lack of one) is already tracked in-process by service.js's own
// reconnect loop, so this just reads that state instead of re-checking it.
const discordRpc = require('../discord-rpc/service');

function checkDiscordRpc() {
  const status = discordRpc.getStatus();
  if (!status.dependencyLoaded) {
    return { id: 'discord', name: 'Discord RPC', ok: false, error: status.dependencyError || 'Dependency failed to load.' };
  }
  // Off is the deliberate default (see schema.js) — surfaced as a pass, not
  // a failure, so an opted-out user doesn't see a red row for a feature
  // they never turned on.
  if (!status.enabled) {
    return { id: 'discord', name: 'Discord RPC', ok: true, error: '', details: 'Disabled' };
  }
  if (!status.configured) {
    return { id: 'discord', name: 'Discord RPC', ok: false, error: 'Enabled but no Client ID set (Settings > Accounts).' };
  }
  if (!status.connected) {
    return { id: 'discord', name: 'Discord RPC', ok: false, error: 'Not connected — Discord not running, or still retrying.' };
  }
  const err = status.lastActivityError ? ` — last presence update failed: ${status.lastActivityError}` : '';
  return { id: 'discord', name: 'Discord RPC', ok: true, error: '', details: `Connected${err}` };
}

// FlareSolverr is opt-in (see flaresolverr-lifecycle.js); its row and the browser-session pool's row, which must
// agree with each other, are built in solver-rows.js.
const flaresolverr = require('../network/flaresolverr-lifecycle');

function createServicesHealthCheckService({ getFlaresolverrUrl, isFlaresolverrManaged = () => flaresolverr.isManaged(), getSolverSnapshot = () => null }) {
  const checkFlareSolverr = createFlareSolverrCheck({
    getFlaresolverrUrl, isFlaresolverrManaged, timeoutMs: SERVICE_CHECK_TIMEOUT_MS,
    getRecoveryStatus: () => flaresolverr.getRecoveryStatus?.() ?? null,
  });

  async function checkAniList() {
    try {
      const res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ Media(id: 1) { id } }' }),
        signal: AbortSignal.timeout(SERVICE_CHECK_TIMEOUT_MS),
      });
      // AniList can be network-reachable but self-report an outage (confirmed
      // live: a real "temporarily disabled due to severe stability issues"
      // body on a 403, not a connection failure) - that's a different,
      // more informative fact than a bare timeout/DNS failure, so the
      // message is surfaced either way rather than collapsed to "fail".
      let body = null;
      try { body = await res.json(); } catch {}
      if (res.ok) return { id: 'anilist', name: 'AniList API', ok: true, error: '' };
      const message = body?.errors?.[0]?.message || `HTTP ${res.status}`;
      return { id: 'anilist', name: 'AniList API', ok: false, error: message };
    } catch (err) {
      return { id: 'anilist', name: 'AniList API', ok: false, error: err.message };
    }
  }

  // checkAniList() is a real request to a third-party API (graphql.anilist.co)
  // — cheap individually, but this whole function is reachable from a plain
  // user click (System Health's "Refresh") and "Run Smoke Test" fires it
  // multiple times in a row on its own. Same cache + in-flight-dedup pattern
  // as health-check.js's runHealthCheck(), for the same reason — see
  // GUIDELINES.md's "Rate limiting for external services".
  const SERVICE_CHECK_CACHE_TTL_MS = 20_000;
  let _cachedResult = null;
  let _cachedAt = 0;
  let _inFlight = null;
  let _flaresolverrInFlight = null;

  // The third-party request (and Discord's local answer) are cached; FlareSolverr's status page is
  // not: it is local and cheap, and its row sits beside the session row, which is read live, so a
  // cached 'fetch failed' from the middle of a restart would contradict '2 sessions open' for 20 s.
  // Callers at the same moment share one request.
  function probeFlareSolverr() {
    if (!_flaresolverrInFlight) {
      _flaresolverrInFlight = checkFlareSolverr().finally(() => { _flaresolverrInFlight = null; });
    }
    return _flaresolverrInFlight;
  }

  async function runCachedProbes() {
    if (_inFlight) return _inFlight;
    if (_cachedResult && (Date.now() - _cachedAt) < SERVICE_CHECK_CACHE_TTL_MS) {
      return _cachedResult;
    }
    _inFlight = Promise.all([checkAniList(), checkDiscordRpc()])
      .then((result) => {
        _cachedResult = result;
        _cachedAt = Date.now();
        _inFlight = null;
        return result;
      })
      .catch((err) => {
        _inFlight = null;
        throw err;
      });
    return _inFlight;
  }

  async function runServiceChecks() {
    const [flaresolverrRow, cachedRows] = await Promise.all([probeFlareSolverr(), runCachedProbes()]);
    const probes = [flaresolverrRow, ...cachedRows];
    // Read on every call, and told what FlareSolverr's own row says, so the two never contradict each other.
    const poolRow = readSolverPoolRow(getSolverSnapshot, flaresolverrRow);
    return placeSolverPoolRow(probes, poolRow);
  }

  return { runServiceChecks };
}

module.exports = { createServicesHealthCheckService, checkSolverPool };
