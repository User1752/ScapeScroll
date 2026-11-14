'use strict';

const path = require('path');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { createSystemHealthService } = require('../modules/system-health/service');
const { updateNpmDependency, updatePinnedCdnLib, updateNodeRuntime } = require('../modules/system-health/dependency-update');
const { requireLocalRequest } = require('../middleware/local-only');
const { readStore, writeStore } = require('../store');
const { loadSourceFromFile } = require('../sourceLoader');
const { clearErrors } = require('../modules/error-logger');
const { getFlaresolverrUrl, getSolverPool } = require('../modules/network/fetch-utils');
const { isSafeUrl } = require('../helpers');
const { createProxyService } = require('../modules/proxy/service');

const asyncHandler = createAsyncHandler('SYSTEM_HEALTH');

// Reused (not the same instance as routes/proxy.js's) so the image-quality
// check measures real served bytes through the exact same fetch/Referer/
// FlareSolverr-fallback path a real reader request takes, instead of
// re-implementing a simpler fetch of its own.
const proxyServiceForHealth = createProxyService({ isSafeUrl });

// Inside a packaged pkg exe, __dirname resolves to the read-only snapshot
// root, not a real on-disk location — fine for projectRoot below (it only
// ever checks bundled app code, e.g. server/routes/*.js, which genuinely
// does live in the snapshot), but wrong for dataDir: store.json/
// error-log.json live on real disk next to the exe (server.js's own
// DATA_DIR = path.join(USER_ROOT, 'data')), never in the snapshot. Using
// __dirname here made this health check report them as permanently
// "missing" inside every packaged build, even though the app itself was
// reading/writing them correctly the whole time via the real DATA_DIR.
const IS_PKG = typeof process.pkg !== 'undefined';
const USER_ROOT = IS_PKG ? require('../modules/common/app-root').getAppRoot() : path.resolve(__dirname, '../..');

const systemHealthService = createSystemHealthService({
  readStore,
  writeStore,
  loadSourceFromFile,
  getFlaresolverrUrl,
  // The session pool's own status, read in-process for one row of the External Services grid.
  getSolverSnapshot: () => getSolverPool().getStatus(),
  fetchProxyImage: proxyServiceForHealth.fetchProxyImage,
  projectRoot: path.resolve(__dirname, '../..'),
  dataDir: path.join(USER_ROOT, 'data'),
});

// Injected from server.js via configure() — the resource monitor's
// middleware has to be attached to the app very early (before any route
// that might respond and end the request first), which is server.js's job,
// but the route reading its snapshot belongs here with the rest of the
// diagnostic API surface. Defaults to a no-op so this route still responds
// sanely if configure() is never called (e.g. in a unit test).
let getResourceSnapshot = () => null;

function configure(opts) {
  if (typeof opts?.getResourceSnapshot === 'function') {
    getResourceSnapshot = opts.getResourceSnapshot;
  }
}

/**
 * @param {import('express').Application} app
 */
function registerSystemHealthRoutes(app) {
  app.get('/api/system/health', asyncHandler(async (req, res) => {
    // getHealth() live-probes every installed source (manga + anime) and
    // external service in parallel, each individually capped around 15-20s -
    // comfortably under the blanket 30s apiTimeout (server.js) in the
    // common case, but real contention (e.g. several Cloudflare sources
    // queueing on the same FlareSolverr instance, or a concurrent Image
    // Quality check) can still push it close to that ceiling. Same
    // override mechanism already used for the other slow health routes
    // below, just with more headroom than they need since this one runs on
    // every page load rather than only when explicitly triggered.
    req.setTimeout(45_000);
    res.setTimeout(45_000);
    const result = await systemHealthService.getHealth();
    res.json(result);
  }));

  app.get('/api/system/resources', (_req, res) => {
    res.json(getResourceSnapshot() || { error: 'Resource monitor not configured' });
  });

  app.get('/api/system/smoke-test', asyncHandler(async (_req, res) => {
    const result = await systemHealthService.runSmokeTest();
    res.json(result);
  }));

  app.get('/api/system/image-quality', asyncHandler(async (req, res) => {
    // Probing real images across every installed source can legitimately
    // take close to PROBE_TIMEOUT_MS (image-quality-health.js) even though
    // sources run in parallel — overrides the blanket 30s apiTimeout
    // (server.js) applied to every /api/* route, same res.setTimeout()
    // mechanism that middleware itself uses, just for this one slow route.
    req.setTimeout(90_000);
    res.setTimeout(90_000);
    const result = await systemHealthService.runImageQualityCheck();
    res.json(result);
  }));

  app.get('/api/system/dependency-check', asyncHandler(async (req, res) => {
    const result = await systemHealthService.runDependencyCheck({ force: req.query.force === 'true' });
    res.json(result);
  }));

  // The three update mechanisms are structurally different (npm install vs.
  // a text edit vs. a checksum-verified download+staged-swap — see
  // dependency-update.js's own header comment) but share one entry point,
  // dispatched by the same `id` scheme dependency-health.js's own checks
  // already use (`dep-<npmName>`, `node-runtime`, or a PINNED_CDN_LIBS id) —
  // the frontend never needs to know which mechanism backs a given row.
  //
  // Always local-only, even when an Access Password is set: this runs
  // `npm install`, rewrites public/index.html and downloads a Node.js
  // runtime ON THE HOST, which is a maintenance action for whoever sits at
  // that machine, never something a remote (even logged-in) client should
  // trigger. The target version is resolved server-side from the registry;
  // a `latestVersion` in the body (which the panel still sends) is ignored.
  app.post('/api/system/dependency-update', requireLocalRequest, asyncHandler(async (req, res) => {
    // npm install and the Node.js download+extract can both legitimately
    // run past the blanket 30s apiTimeout (server.js) — same pattern as
    // /api/system/image-quality above, just for this one slow route.
    req.setTimeout(180_000);
    res.setTimeout(180_000);

    const { id } = req.body || {};
    if (typeof id !== 'string' || !id) {
      return res.status(400).json({ ok: false, error: 'Missing "id".' });
    }

    let result;
    if (id === 'node-runtime') {
      result = await updateNodeRuntime();
    } else if (id.startsWith('dep-')) {
      result = await updateNpmDependency(id.slice('dep-'.length));
    } else {
      result = await updatePinnedCdnLib(id);
    }

    res.json({ ok: true, result });
  }));

  app.delete('/api/health/source-errors', asyncHandler(async (_req, res) => {
    await clearErrors();
    res.json({ ok: true, cleared: true });
  }));
}

module.exports = {
  registerSystemHealthRoutes,
  systemHealthService,
  configure,
};
