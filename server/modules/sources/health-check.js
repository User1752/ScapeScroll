/**
 * server/modules/sources/health-check.js — Source health check logic
 *
 * Tests each installed source by calling search() with a generic query and
 * verifying that the response conforms to the expected shape { results, hasNextPage }.
 *
 * A configurable timeout (default 7 s) prevents a hung source from blocking
 * the startup sequence or the health-check API endpoint indefinitely.
 *
 * Used both at startup (fire-and-forget) and via GET /api/sources/health-check.
 */

'use strict';

const { runWithSolverContext, backgroundProbeContext } = require('../network/solver-context');
const { disabledSourceSetOf } = require('./disabled-sources');
const { isQuiet } = require('../common/quiet-mode');

const HEALTH_CHECK_TIMEOUT_MS = 15_000;
// Use a query with 3+ chars so scrapers that branch on short queries
// (e.g. MangaKatana) don't fall into the slower trending/homepage path.
const HEALTH_CHECK_QUERY      = 'one piece';

// A probe is background work for the FlareSolverr browser (backgroundProbeContext).

/**
 * @param {{ readStore: Function, loadSourceFromFile: Function }} deps
 */
function createSourceHealthCheckService({ readStore, loadSourceFromFile }) {
  // This fires a real, live search() against every installed source in
  // parallel — an actual outbound request per source, not a cheap ping.
  // It's reachable from a plain user click (System Health's "Refresh"), and
  // "Run Smoke Test" fires it up to 3 times in a row on its own (the main
  // health check plus two of its own internal checks reusing it) — the same
  // "burst triggers a block, keep hammering through it" shape that got this
  // project's own IP blocked by Brave Search (see cover-search/index.js and
  // GUIDELINES.md's "Rate limiting for external services"), just aimed at
  // every installed source instead of one search engine. A short cache plus
  // in-flight de-duplication means rapid re-clicks or the smoke test's own
  // repeat calls reuse the same run instead of re-probing everything again.
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

  /**
   * One live probe of one installed source. Never throws: a source that fails to load, answers with the
   * wrong shape, throws or times out is a row with ok:false.
   *
   * @returns {Promise<{ id: string, name: string, ok: boolean, error?: string }>}
   */
  async function probeSource(id, name) {
    let mod;
    try {
      mod = loadSourceFromFile(id);
    } catch (e) {
      return { id, name, ok: false, error: `Failed to load module: ${e.message}` };
    }

    if (typeof mod.search !== 'function') {
      return { id, name, ok: false, error: 'search() is not implemented.' };
    }

    try {
      let result;

      // Prefer a dedicated healthCheck() method if the source exposes one.
      // This allows scrapers (e.g. MangaKatana) to do a single fast probe
      // instead of a full search() with retries and backoff.
      if (typeof mod.healthCheck === 'function') {
        const probe = runWithSolverContext(backgroundProbeContext(HEALTH_CHECK_TIMEOUT_MS), () => mod.healthCheck());
        result = (probe && typeof probe.then === 'function')
          ? await Promise.race([
              probe,
              new Promise((_, rej) =>
                setTimeout(() => rej(new Error('timeout')), HEALTH_CHECK_TIMEOUT_MS)
              ),
            ])
          : probe;

        if (!result || typeof result !== 'object') {
          return { id, name, ok: false, error: 'healthCheck() did not return an object.' };
        }
        if (result.temporarilyUnavailable) {
          return { id, name, ok: false, error: result.error || 'Temporarily unavailable' };
        }
        return { id, name, ok: result.ok !== false };
      }

      // Fallback: call search() with a meaningful query.
      const searchProbe = runWithSolverContext(backgroundProbeContext(HEALTH_CHECK_TIMEOUT_MS), () => mod.search(HEALTH_CHECK_QUERY, 1));
      result = (searchProbe && typeof searchProbe.then === 'function')
        ? await Promise.race([
            searchProbe,
            new Promise((_, rej) =>
              setTimeout(() => rej(new Error('timeout')), HEALTH_CHECK_TIMEOUT_MS)
            ),
          ])
        : searchProbe;

      // Expected shape: { results: Array, hasNextPage: boolean }
      if (!result || typeof result !== 'object') {
        return { id, name, ok: false, error: 'search() did not return an object.' };
      }
      if (result.temporarilyUnavailable) {
        return { id, name, ok: false, error: 'Site temporarily unavailable (rate-limited or Cloudflare)' };
      }
      if (!Array.isArray(result.results)) {
        return { id, name, ok: false, error: 'search() did not return { results: [] }.' };
      }

      return { id, name, ok: true };
    } catch (e) {
      return { id, name, ok: false, error: `probe threw: ${e.message}` };
    }
  }

  /**
   * Runs a lightweight search() probe on every installed source the user has not switched off.
   *
   * A disabled source (store.settings.disabledSourceIds) is left out before anything is loaded or
   * searched, and has no row in the result: a probe of a Cloudflare-protected source opens FlareSolverr's
   * browser (and can restart it), which is not worth doing for a source nobody uses. When every installed
   * source is disabled the result is [], like for no sources at all.
   *
   * @returns {Promise<{ id: string, name: string, ok: boolean, error?: string }[]>}
   */
  async function _runHealthCheckNow() {
    let store;
    try {
      store = await readStore();
    } catch (e) {
      return [{ id: 'store', name: 'Store', ok: false, error: `Failed to read store: ${e.message}` }];
    }

    const disabled = disabledSourceSetOf(store);
    const ids = Object.keys(store.installedSources || {}).filter((id) => !disabled.has(id));
    if (!ids.length) return [];

    return Promise.all(ids.map((id) => probeSource(id, store.installedSources[id]?.name || id)));
  }

  /**
   * Logs health check results to the console.
   * Intended to be called at startup (fire-and-forget).
   *
   * @returns {Promise<void>}
   */
  async function logHealthCheck() {
    let results;
    try {
      results = await runHealthCheck();
    } catch (e) {
      console.error('[HealthCheck] Unexpected error during source health check:', e.message);
      return;
    }

    if (!results.length) {
      console.log('[HealthCheck] No installed sources to check.');
      return;
    }

    const ok      = results.filter(r => r.ok);
    const failing = results.filter(r => !r.ok);

    console.log(`[HealthCheck] Sources: ${ok.length} OK, ${failing.length} failing.`);

    for (const r of ok) {
      console.log(`[HealthCheck]   [OK] ${r.name} (${r.id})`);
    }
    for (const r of failing) {
      console.warn(`[HealthCheck]   [FAIL] ${r.name} (${r.id}): ${r.error}`);
    }
  }

  return { runHealthCheck, logHealthCheck };
}

module.exports = { createSourceHealthCheckService };
