'use strict';

const fs = require('fs');
const path = require('path');
const { createSourceHealthCheckService } = require('../sources/health-check');
const { disabledSourceSetOf, enabledSourceIdsOf } = require('../sources/disabled-sources');
const { createAnimeHealthCheckService } = require('./anime-health');
const { createServicesHealthCheckService } = require('./services-health');
const { createImageQualityHealthCheckService } = require('./image-quality-health');
const { createDependencyHealthCheckService } = require('./dependency-health');
const {
  REQUIRED_STORE_KEYS,
  REQUIRED_DATA_FILES,
  RECENT_SOURCE_ERROR_WINDOW_MS,
  RECOVERED_SOURCE_ERROR_AFTER_MS,
  PROBE_COVERED_SOURCE_METHODS,
  MODULE_DEFINITIONS,
  SOURCE_ERROR_TYPES,
} = require('../../config/system-health');

function getModeLocal() {
  return process.env.LOCAL_MODE === '1'
    || process.env.SCROLLSCAPE_LOCAL_MODE === '1'
    || process.pkg != null;
}

function classifyOverall(checks) {
  if (checks.some(c => c.status === 'fail')) return 'fail';
  if (checks.some(c => c.status === 'warning')) return 'warning';
  return 'pass';
}

function computeSummary(checks) {
  const summary = { total: checks.length, pass: 0, warning: 0, fail: 0 };
  for (const check of checks) {
    if (check.status === 'pass') summary.pass += 1;
    else if (check.status === 'warning') summary.warning += 1;
    else summary.fail += 1;
  }
  return summary;
}

function classifySourceError(message) {
  const raw = String(message || '').trim();
  const text = raw.toLowerCase();

  for (const errorType of SOURCE_ERROR_TYPES) {
    if (!errorType.patterns || !errorType.patterns.length) continue;
    if (errorType.patterns.some((pattern) => text.includes(pattern))) {
      return {
        code: errorType.code,
        key: errorType.key,
        label: errorType.label,
        suggestedAction: errorType.suggestedAction,
      };
    }
  }

  const fallback = SOURCE_ERROR_TYPES.find((e) => e.key === 'unknown') || {
    code: 'error-99',
    key: 'unknown',
    label: 'Unknown error',
    suggestedAction: 'Inspect raw logs and source module output for root cause.',
  };

  return {
    code: fallback.code,
    key: fallback.key,
    label: fallback.label,
    suggestedAction: fallback.suggestedAction,
  };
}

function isTransientSourceErrorKey(key) {
  return key === 'cloudflare_or_challenge'
    || key === 'timeout_or_network'
    || key === 'rate_limit'
    || key === 'site_maintenance';
}

async function readErrorLogEntries(dataRoot) {
  const logPath = path.join(dataRoot, 'error-log.json');
  try {
    const raw = await fs.promises.readFile(logPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toSourceStatus(results) {
  if (!Array.isArray(results) || !results.length) {
    return {
      status: 'warning',
      summary: { total: 0, passing: 0, degraded: 0, failing: 0 },
      results: [],
    };
  }

  const normalizedResults = results.map((r) => {
    // latestVersion/updatable are additive and only ever populated by
    // dependency-health.js's checks — every other check type (sources,
    // anime, services, image quality) simply never sets them, so they stay
    // absent from those responses rather than showing up as `undefined`.
    const passthrough = {};
    if (r.latestVersion !== undefined) passthrough.latestVersion = r.latestVersion;
    if (r.updatable !== undefined) passthrough.updatable = r.updatable;
    if (r.severity !== undefined) passthrough.severity = r.severity;

    if (r.ok) {
      return {
        id: r.id,
        name: r.name,
        status: 'pass',
        error: '',
        details: r.details || '',
        errorCode: '',
        errorLabel: '',
        suggestedAction: '',
        ...passthrough,
      };
    }

    const error = r.error || 'Unknown source failure';
    const classified = classifySourceError(error);
    const transient = isTransientSourceErrorKey(classified.key);

    return {
      id: r.id,
      name: r.name,
      // A check can say its own failure is only a warning (severity), for a row whose text means
      // nothing to the classifier above (the browser-session pool keeping failing): without it
      // such a row would be a hard failure and land in the "services are unreachable" warning.
      status: (r.severity === 'warning' || transient) ? 'warning' : 'fail',
      error,
      errorCode: classified.code,
      errorLabel: classified.label,
      suggestedAction: classified.suggestedAction,
      transient,
      ...passthrough,
    };
  });

  const passing = normalizedResults.filter((r) => r.status === 'pass').length;
  const degraded = normalizedResults.filter((r) => r.status === 'warning').length;
  const failing = normalizedResults.filter((r) => r.status === 'fail').length;
  const status = (failing > 0 || degraded > 0) ? 'warning' : 'pass';

  return {
    status,
    summary: {
      total: results.length,
      passing,
      degraded,
      failing,
    },
    results: normalizedResults,
  };
}

// The ids of the rows (normalised by toSourceStatus) that passed their live probe.
function passingIds(rows) {
  return (rows || []).filter((row) => row.status === 'pass').map((row) => row.id);
}

// The call a log record is about, from its own request path (/api/source/<id>/<method>, what the error handler
// stores in details.url); '' when it has none.
function methodOfRecord(entry) {
  const path = String((entry && entry.details && entry.details.url) || '').split('?')[0];
  const match = /^\/api\/source\/[^/]+\/([A-Za-z]+)\/?$/.exec(path);
  return match ? match[1] : '';
}

function collectRecentSourceErrors(entries, sourceIds, { now = Date.now(), windowMs = RECENT_SOURCE_ERROR_WINDOW_MS, healthyIds, recoveredAfterMs = RECOVERED_SOURCE_ERROR_AFTER_MS } = {}) {
  const sourceSet = new Set(sourceIds || []);
  // The sources whose live probe passed in this very run: their records of a call the probe exercises stop
  // counting after recoveredAfterMs (anything that is not a list of ids means no live result, so nothing is
  // dropped for it).
  const healthySet = new Set(Array.isArray(healthyIds) ? healthyIds : []);
  // An entry with no usable lastSeenAt can't be shown to be recent, so it
  // doesn't count (recordError always stamps one, so this only drops
  // hand-edited/corrupt records).
  const isRecent = (e) => {
    const seenAt = Date.parse(e.lastSeenAt);
    if (!Number.isFinite(seenAt)) return false;
    const age = now - seenAt;
    const recovered = age > recoveredAfterMs && healthySet.has(e.area) && PROBE_COVERED_SOURCE_METHODS.has(methodOfRecord(e));
    return age <= windowMs && !recovered;
  };
  const filtered = entries
    .filter((e) => sourceSet.has(e.area) && isRecent(e))
    .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));

  return filtered.slice(0, 20).map((e) => {
    const message = e.message || '';
    const classified = classifySourceError(message);
    return {
      area: e.area,
      code: e.code || '',
      message,
      count: Number(e.count) || 1,
      lastSeenAt: e.lastSeenAt || null,
      errorCode: classified.code,
      errorLabel: classified.label,
      suggestedAction: classified.suggestedAction,
    };
  });
}

function buildSourceErrorCatalog(sourceResults, recentErrors) {
  const grouped = new Map();

  function addError(code, label, suggestedAction, sample) {
    if (!code) return;
    if (!grouped.has(code)) {
      grouped.set(code, {
        code,
        label: label || 'Unknown error',
        suggestedAction: suggestedAction || '',
        count: 0,
        samples: [],
      });
    }
    const bucket = grouped.get(code);
    bucket.count += 1;
    if (sample && bucket.samples.length < 3 && !bucket.samples.includes(sample)) {
      bucket.samples.push(sample);
    }
  }

  for (const item of sourceResults || []) {
    if (item.status === 'fail') {
      addError(item.errorCode, item.errorLabel, item.suggestedAction, `${item.id}: ${item.error}`);
    }
  }

  for (const entry of recentErrors || []) {
    addError(entry.errorCode, entry.errorLabel, entry.suggestedAction, `${entry.area}: ${entry.message}`);
  }

  return Array.from(grouped.values()).sort((a, b) => b.count - a.count);
}

function createSystemHealthService({
  readStore, writeStore, loadSourceFromFile, getFlaresolverrUrl, getSolverSnapshot, fetchProxyImage, projectRoot, dataDir,
}) {
  const root = projectRoot || path.resolve(__dirname, '../../..');
  const dataRoot = dataDir || path.join(root, 'data');
  const sourceHealthService = createSourceHealthCheckService({ readStore, loadSourceFromFile });
  const animeHealthService = createAnimeHealthCheckService();
  const servicesHealthService = createServicesHealthCheckService({ getFlaresolverrUrl, getSolverSnapshot });
  const imageQualityHealthService = createImageQualityHealthCheckService({ readStore, writeStore, loadSourceFromFile, fetchProxyImage });
  const dependencyHealthService = createDependencyHealthCheckService({ getFlaresolverrUrl });

  async function getHealth() {
    const timestamp = new Date().toISOString();
    const warnings = [];
    const errors = [];

    let store = null;
    let storeError = null;
    try {
      store = await readStore();
    } catch (err) {
      storeError = err;
      errors.push(`Failed to read data store: ${err.message}`);
    }

    // The sources left on: the error-log history of one the user switched off is not counted either.
    const installedSourceIds = enabledSourceIdsOf(store);
    // All three probes run concurrently, not sequentially - each is already
    // internally capped (~15-20s per source, in parallel across sources),
    // but running the manga probe THEN the anime+services probe meant the
    // per-phase caps added together instead of overlapping. Confirmed live:
    // that sum could exceed the blanket 30s /api/* timeout (server.js) even
    // with nothing unusual going on, killing this "fast, always-live"
    // endpoint with a 504 and leaving the System Health page's diagnostics
    // panels stuck on "Could not load" - worse right after a restart (no
    // warm caches) or alongside a heavy concurrent check like Image Quality.
    const [sourceProbeResults, animeProbeResults, serviceProbeResults] = await Promise.all([
      sourceHealthService.runHealthCheck().catch((err) => {
        errors.push(`Source probe failed: ${err.message}`);
        return [];
      }),
      animeHealthService.runHealthCheck().catch((err) => {
        errors.push(`Anime source probe failed: ${err.message}`);
        return [];
      }),
      servicesHealthService.runServiceChecks().catch((err) => {
        errors.push(`Services probe failed: ${err.message}`);
        return [];
      }),
    ]);
    const sourceStatus = toSourceStatus(sourceProbeResults);

    const errorLogEntries = await readErrorLogEntries(dataRoot);
    const recentSourceErrors = collectRecentSourceErrors(errorLogEntries, installedSourceIds, { healthyIds: passingIds(sourceStatus.results) });
    const sourceErrorCatalog = buildSourceErrorCatalog(sourceStatus.results, recentSourceErrors);
    if (sourceStatus.summary.total === 0) {
      warnings.push('No installed sources found.');
    }
    if (sourceStatus.summary.degraded > 0) {
      warnings.push(`${sourceStatus.summary.degraded}/${sourceStatus.summary.total} sources are temporarily unavailable (degraded).`);
    }
    if (sourceStatus.summary.failing > 0) {
      warnings.push(`${sourceStatus.summary.failing}/${sourceStatus.summary.total} sources are failing live probes (hard failures).`);
    }
    if (recentSourceErrors.length > 0) {
      warnings.push(`Recent source errors detected (${recentSourceErrors.length} records).`);
    }

    const animeStatus = toSourceStatus(animeProbeResults);
    // No area-tagged error-log history exists for anime providers (unlike
    // manga sources, nothing currently calls the error-logger from
    // server/modules/anime/*.js), so there's no recentErrors half to add
    // here the way manga's catalog has one — but buildSourceErrorCatalog
    // only needs live results to be useful, and animeStatus.results already
    // carries the same classified errorCode/errorLabel/suggestedAction every
    // manga source result does (both go through the same toSourceStatus()
    // above). Passing [] just means "no historical correlation", not "no
    // catalog" — a currently-failing provider still shows up classified.
    const animeErrorCatalog = buildSourceErrorCatalog(animeStatus.results, []);
    const servicesStatus = toSourceStatus(serviceProbeResults);
    if (animeStatus.summary.failing > 0) {
      warnings.push(`${animeStatus.summary.failing}/${animeStatus.summary.total} anime sources are failing live probes.`);
    }
    if (servicesStatus.summary.failing > 0) {
      warnings.push(`${servicesStatus.summary.failing}/${servicesStatus.summary.total} external services are unreachable: ${servicesStatus.results.filter(r => r.status === 'fail').map(r => r.name).join(', ')}.`);
    }

    let databaseStatus = 'pass';
    const missingCollections = [];
    const missingDataFiles = [];

    if (storeError) {
      databaseStatus = 'fail';
    } else {
      for (const key of REQUIRED_STORE_KEYS) {
        if (!(key in store)) missingCollections.push(key);
      }
      if (missingCollections.length) {
        databaseStatus = 'warning';
        warnings.push(`Store is missing required collections: ${missingCollections.join(', ')}`);
      }
    }

    for (const filename of REQUIRED_DATA_FILES) {
      const filePath = path.join(dataRoot, filename);
      if (!fs.existsSync(filePath)) missingDataFiles.push(filename);
    }
    if (missingDataFiles.length) {
      databaseStatus = databaseStatus === 'fail' ? 'fail' : 'warning';
      warnings.push(`Missing required data files: ${missingDataFiles.join(', ')}`);
    }

    const modules = MODULE_DEFINITIONS.map((mod) => {
      const absPath = path.join(root, mod.relPath);
      const available = fs.existsSync(absPath);
      return {
        id: mod.id,
        label: mod.label,
        kind: mod.kind,
        status: available ? 'pass' : 'fail',
        details: available
          ? `Available at ${mod.relPath}`
          : `Missing file ${mod.relPath}`,
      };
    });

    const moduleFailures = modules.filter(m => m.status === 'fail');
    if (moduleFailures.length) {
      errors.push(`Missing module files: ${moduleFailures.map(m => m.id).join(', ')}`);
    }

    const statusCandidates = [
      databaseStatus,
      moduleFailures.length ? 'fail' : 'pass',
      sourceStatus.status,
    ];
    let overallStatus = 'pass';
    if (statusCandidates.includes('fail') || errors.length > 0) overallStatus = 'fail';
    else if (statusCandidates.includes('warning') || warnings.length > 0) overallStatus = 'warning';

    return {
      ok: overallStatus !== 'fail',
      overallStatus,
      app: {
        name: 'ScrollScape',
        status: overallStatus,
        modeLocal: getModeLocal(),
        timestamp,
      },
      database: {
        status: databaseStatus,
        engine: 'json-file-store',
        requiredCollections: REQUIRED_STORE_KEYS,
        missingCollections,
        requiredDataFiles: REQUIRED_DATA_FILES,
        missingDataFiles,
      },
      modules,
      sources: {
        status: sourceStatus.status,
        summary: sourceStatus.summary,
        results: sourceStatus.results,
        recentErrors: recentSourceErrors,
        errorCatalog: sourceErrorCatalog,
      },
      anime: {
        status: animeStatus.status,
        summary: animeStatus.summary,
        results: animeStatus.results,
        errorCatalog: animeErrorCatalog,
      },
      services: {
        status: servicesStatus.status,
        summary: servicesStatus.summary,
        results: servicesStatus.results,
      },
      warnings,
      errors,
    };
  }

  async function runSmokeTest() {
    const checks = [];

    async function runCheck(id, label, fn) {
      const started = Date.now();
      try {
        const result = await fn();
        checks.push({
          id,
          label,
          status: result?.status || 'pass',
          durationMs: Date.now() - started,
          details: result?.details || '',
        });
      } catch (err) {
        checks.push({
          id,
          label,
          status: 'fail',
          durationMs: Date.now() - started,
          details: err.message,
        });
      }
    }

    await runCheck('store-read', 'Read store', async () => {
      const store = await readStore();
      return {
        status: 'pass',
        details: `Store loaded. Installed sources: ${Object.keys(store.installedSources || {}).length}`,
      };
    });

    await runCheck('store-structure', 'Store required collections', async () => {
      const store = await readStore();
      const missing = REQUIRED_STORE_KEYS.filter(key => !(key in store));
      if (missing.length) {
        return {
          status: 'warning',
          details: `Missing collections: ${missing.join(', ')}`,
        };
      }
      return { status: 'pass', details: 'All required collections are present.' };
    });

    await runCheck('data-files', 'Data files integrity', async () => {
      const missing = REQUIRED_DATA_FILES
        .map(name => ({ name, fullPath: path.join(dataRoot, name) }))
        .filter(item => !fs.existsSync(item.fullPath))
        .map(item => item.name);

      if (missing.length) {
        return {
          status: 'warning',
          details: `Missing files: ${missing.join(', ')}`,
        };
      }
      return { status: 'pass', details: 'All required data files are available.' };
    });

    await runCheck('route-modules', 'Route module exports', async () => {
      const routeDir = path.join(root, 'server', 'routes');
      const files = fs.readdirSync(routeDir).filter(f => f.endsWith('.js'));
      const invalid = [];

      for (const file of files) {
        const routeModule = require(path.join(routeDir, file));
        const hasRegister = Object.keys(routeModule).some(k => k.startsWith('register') && typeof routeModule[k] === 'function');
        if (!hasRegister && file !== 'bootstrap.js') invalid.push(file);
      }

      if (invalid.length) {
        return {
          status: 'warning',
          details: `Route files without register function: ${invalid.join(', ')}`,
        };
      }

      return { status: 'pass', details: `Validated ${files.length} route files.` };
    });

    await runCheck('source-contracts', 'Installed source contracts', async () => {
      const store = await readStore();
      const ids = Object.keys(store.installedSources || {});
      if (!ids.length) {
        return {
          status: 'warning',
          details: 'No installed sources found to validate.',
        };
      }

      const broken = [];
      const missingMeta = [];
      for (const id of ids) {
        try {
          const mod = loadSourceFromFile(id);
          const requiredFunctions = ['search', 'mangaDetails', 'chapters', 'pages'];
          const missingFns = requiredFunctions.filter(fn => typeof mod[fn] !== 'function');
          if (missingFns.length) {
            broken.push(`${id} (missing: ${missingFns.join(', ')})`);
          }

          const meta = mod.meta || {};
          if (!meta.name || !meta.id) {
            missingMeta.push(id);
          }
        } catch (err) {
          broken.push(`${id} (${err.message})`);
        }
      }

      if (broken.length) {
        return {
          status: 'fail',
          details: `Invalid source modules: ${broken.join(' | ')}`,
        };
      }

      if (missingMeta.length) {
        return {
          status: 'warning',
          details: `Source meta is incomplete for: ${missingMeta.join(', ')}`,
        };
      }

      return { status: 'pass', details: `Validated ${ids.length} installed sources.` };
    });

    await runCheck('source-health-probe', 'Source live health probe', async () => {
      const results = await sourceHealthService.runHealthCheck();
      if (!results.length) {
        // No rows is not a problem when the user switched every installed source off: the probe skips them on purpose.
        const store = await readStore();
        const disabled = disabledSourceSetOf(store);
        const installedIds = Object.keys(store.installedSources || {});
        if (installedIds.length && installedIds.every((id) => disabled.has(id))) {
          return { status: 'pass', details: 'Every installed source is disabled; nothing to probe.' };
        }
        return {
          status: 'warning',
          details: 'No installed sources to run live probe.',
        };
      }

      const failing = results.filter(r => !r.ok);
      if (failing.length) {
        return {
          status: 'warning',
          details: `${failing.length}/${results.length} probes failed: ${failing.map(r => r.id).join(', ')}`,
        };
      }

      return { status: 'pass', details: `All ${results.length} source probes passed.` };
    });

    await runCheck('source-error-log', 'Recent source error log', async () => {
      const store = await readStore();
      if (!Object.keys(store.installedSources || {}).length) {
        return {
          status: 'warning',
          details: 'No installed sources available for error-log analysis.',
        };
      }

      const entries = await readErrorLogEntries(dataRoot);
      // Only the sources left on: a source that was switched off because it keeps failing would otherwise
      // keep this check lit for the whole week the window lasts.
      const probe = await sourceHealthService.runHealthCheck().catch(() => []);
      const classifiedProbe = toSourceStatus(probe);
      const recent = collectRecentSourceErrors(entries, enabledSourceIdsOf(store), { healthyIds: passingIds(classifiedProbe.results) });
      const catalog = buildSourceErrorCatalog(classifiedProbe.results, recent);
      if (!recent.length) {
        if (catalog.length) {
          return {
            status: 'warning',
            details: `Classified source issues: ${catalog.map((c) => `${c.code} ${c.label}`).join(', ')}`,
          };
        }
        return {
          status: 'pass',
          details: 'No recent source errors in error-log.json.',
        };
      }

      const noisy = recent.filter((e) => e.count >= 3);
      if (noisy.length) {
        return {
          status: 'warning',
          details: `Source errors detected (${recent.length} records; ${noisy.length} repeated >= 3 times).`,
        };
      }

      return {
        status: 'warning',
        details: `Source errors detected (${recent.length} records): ${catalog.map((c) => `${c.code} ${c.label}`).join(', ')}`,
      };
    });

    await runCheck('read-only-safety', 'Smoke test read-only safety', async () => ({
      status: 'pass',
      details: 'Checks only perform read operations and contract validation.',
    }));

    const overallStatus = classifyOverall(checks);

    return {
      ok: overallStatus !== 'fail',
      overallStatus,
      summary: computeSummary(checks),
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  // Deliberately separate from getHealth() rather than folded into its
  // Promise.all — probing real cover/page images across every installed
  // source can take up to a minute (some sources need a FlareSolverr
  // solve), which would make the main health page's normal load slow for a
  // check that only needs to run occasionally, not on every page visit.
  // Mirrors runSmokeTest()'s pattern of being its own on-demand endpoint.
  async function runImageQualityCheck() {
    const results = await imageQualityHealthService.runImageQualityChecks().catch((err) => {
      return [{ id: 'image-quality', name: 'Image Quality', ok: false, error: `Probe failed: ${err.message}` }];
    });
    const status = toSourceStatus(results);
    return {
      ok: status.status !== 'fail',
      overallStatus: status.status,
      summary: status.summary,
      results: status.results,
      timestamp: new Date().toISOString(),
    };
  }

  // Same reasoning as runImageQualityCheck() above: every check here hits an
  // external registry (npmjs.org, nodejs.org), so it's its own slow,
  // on-demand endpoint rather than something run on every page visit. Also
  // cached for CACHE_TTL_MS inside dependencyHealthService itself, since
  // "is there a newer version" doesn't change between one click and the next.
  async function runDependencyCheck({ force = false } = {}) {
    const results = await dependencyHealthService.runDependencyChecks({ force }).catch((err) => {
      return [{ id: 'dependency-check', name: 'Dependency Check', ok: false, error: `Check failed: ${err.message}` }];
    });
    const status = toSourceStatus(results);
    return {
      ok: status.status !== 'fail',
      overallStatus: status.status,
      summary: status.summary,
      results: status.results,
      timestamp: new Date().toISOString(),
    };
  }

  async function logStartupHealth() {
    try {
      const health = await getHealth();
      const moduleFailures = health.modules.filter(m => m.status === 'fail').length;
      console.log(`[SystemHealth] ${health.overallStatus.toUpperCase()} | database=${health.database.status} | modulesMissing=${moduleFailures}`);
      if (health.warnings.length) {
        for (const warning of health.warnings) console.warn(`[SystemHealth] Warning: ${warning}`);
      }
      if (health.errors.length) {
        for (const error of health.errors) console.error(`[SystemHealth] Error: ${error}`);
      }
    } catch (err) {
      console.error(`[SystemHealth] Startup health failed: ${err.message}`);
    }
  }

  return {
    getHealth,
    runSmokeTest,
    runImageQualityCheck,
    runDependencyCheck,
    logStartupHealth,
  };
}

module.exports = { createSystemHealthService, collectRecentSourceErrors, classifySourceError, isTransientSourceErrorKey, toSourceStatus };
