'use strict';

/**
 * server/modules/system-health/anime-health.js — Anime provider health check
 *
 * Mirrors server/modules/sources/health-check.js's shape/contract exactly
 * (same { id, name, ok, error } result). The providers are the ones the anime
 * registry holds (server/modules/anime-sources/): the sources that ship with the
 * app, and any that were added since.
 */

const { runWithSolverContext, backgroundProbeContext } = require('../network/solver-context');
const { getAnimeRegistry } = require('../anime-sources');
const { isQuiet } = require('../common/quiet-mode');

// AnimePahe's own healthCheck() (a real search() call, not a lightweight
// probe) measured at ~16s live — just over the old 15s cap, causing an
// intermittent false "timeout" failure on an otherwise-healthy provider.
// With the browser-session pool the first protected call after a start (or a FlareSolverr
// restart) also opens its session first: measured 14-18 s for this probe on a cold pool and
// up to ~20 s beside the manga probes queued on the same two sessions, so 20 s still failed
// now and then. 30 s keeps the whole health route (45 s) comfortably above the slowest probe.
const HEALTH_CHECK_TIMEOUT_MS = 30_000;

// Same patience as the manga source probes (sources/health-check.js): backgroundProbeContext.

function createAnimeHealthCheckService() {
  // AnimePahe's own healthCheck() alone measured ~16s live (see the comment
  // above) — this whole probe is reachable from a plain user click (System
  // Health's "Refresh") and "Run Smoke Test" fires it multiple times in a
  // row. Same cache + in-flight-dedup pattern as the manga source/services
  // health checks (health-check.js, services-health.js) — see GUIDELINES.md's
  // "Rate limiting for external services".
  const HEALTH_CHECK_CACHE_TTL_MS = 20_000;
  let _cachedResult = null;
  let _cachedAt = 0;
  let _inFlight = null;

  async function runHealthCheck() {
    if (_inFlight) return _inFlight;
    // A live Test of a source is under way: the probes stand aside and answer from what they last saw (common/quiet-mode.js).
    if (isQuiet()) return _cachedResult || [];
    if (_cachedResult && (Date.now() - _cachedAt) < HEALTH_CHECK_CACHE_TTL_MS) {
      return _cachedResult;
    }
    _inFlight = _runHealthCheckNow()
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

  async function _runHealthCheckNow() {
    const providers = getAnimeRegistry().healthTargets();

    const results = await Promise.all(providers.map(async ({ id, name, check }) => {
      if (typeof check !== 'function') {
        return { id, name, ok: false, error: 'healthCheck() is not implemented.' };
      }
      try {
        const probe = runWithSolverContext(backgroundProbeContext(HEALTH_CHECK_TIMEOUT_MS), () => check());
        const result = await Promise.race([
          probe,
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), HEALTH_CHECK_TIMEOUT_MS)),
        ]);
        if (!result || typeof result !== 'object') {
          return { id, name, ok: false, error: 'healthCheck() did not return an object.' };
        }
        return { id, name, ok: result.ok !== false, error: result.error || '' };
      } catch (e) {
        return { id, name, ok: false, error: `probe threw: ${e.message}` };
      }
    }));

    return results;
  }

  return { runHealthCheck };
}

module.exports = { createAnimeHealthCheckService };
