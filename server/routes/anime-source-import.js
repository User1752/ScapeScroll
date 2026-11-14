/**
 * routes/anime-source-import.js — Import an anime source file the person wrote or generated themselves
 *
 * Endpoints:
 *   POST /api/anime/sources/import/preview  — Reads the text without running it, stages it under its sha256 and reports what it
 *                                             found (body: { code, id? })
 *   POST /api/anime/sources/import/install  — Installs the staged file with that sha256 (body: { sha256, id, replace? })
 *   POST /api/anime/sources/uninstall       — Removes an anime source imported earlier (body: { id })
 *   POST /api/anime/sources/import/test     — Runs the checklist of what makes an episode play against the REAL site, when the person asks
 *                                             (body: { id }); it follows the stream through the relay and plays nothing
 *
 * Security: the same as the manga import (routes/source-import.js). These routes install code that runs in this process, so they are
 * in PRIVILEGED_ROUTES (local-only while no password is set) AND behind requireThisComputer: they stay on this computer even with an
 * Access Password. What is installed is the staged file named by its sha256, never text sent with the install request, and the request
 * body (which holds the whole source text) is replaced by a small summary before anything can log it. An imported anime source has to
 * declare the hosts its video comes from, and the app relays only those (modules/anime-sources/relay.js).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { requireThisComputer } = require('../middleware/local-only');
const { rateLimiter } = require('../middleware/security');
const { getAnimeRegistry } = require('../modules/anime-sources');
const { createAnimeImportService, sourcePathIn } = require('../modules/anime-sources/import');
const { loadInstalledAnimeSources } = require('../modules/anime-sources/loader');
const { createAnimeLiveTest } = require('../modules/anime-sources/live-test');
const { createFailure } = require('../modules/source-import/failure');
const { withTimeout, sleep } = require('../modules/common/async-utils');
const { beginQuiet } = require('../modules/common/quiet-mode');

const asyncHandler = createAsyncHandler('ANIME_SOURCE_IMPORT');
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
// A test calls the real site: few of them per minute.
const TEST_RATE_MAX = 6;
// A little more than the longest a test may run (live-test.js: 4 minutes), so the run ends before the connection does.
const TEST_HTTP_TIMEOUT_MS = 5 * 60_000;

let importService = null;
let liveTest = null;
let activeRegistry = null;
let testing = false;

/**
 * Builds the service and loads the sources imported earlier. Run once, at start, after the source loader is configured.
 *
 * @param {{ stagingDir: string, sourcesDir: string, loadCandidate: Function, registry?: object, warn?: Function }} options
 * @returns {{ loaded: string[], skipped: object[] }}
 */
function configure({ stagingDir, sourcesDir, loadCandidate, registry = getAnimeRegistry(), warn = console.warn, testDeps = {} } = {}) {
  for (const dir of [stagingDir, sourcesDir]) fs.mkdirSync(dir, { recursive: true });
  importService = createAnimeImportService({ stagingDir, sourcePath: sourcePathIn(sourcesDir), registry, loadCandidate });
  activeRegistry = registry;
  liveTest = createAnimeLiveTest({ registry, sleep, withTimeout, ...testDeps });
  return loadInstalledAnimeSources({ dir: path.resolve(sourcesDir), registry, loadCandidate, warn });
}

// Reads the fields this route uses, one by one, and leaves req.body as a small summary: the error handler logs the body of a failed
// request, and for this route that would be the whole source file.
function takeBody(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const taken = { code: body.code, id: body.id, sha256: body.sha256, replace: body.replace };
  req.body = {
    id: typeof taken.id === 'string' ? taken.id.slice(0, 80) : undefined,
    sha256: typeof taken.sha256 === 'string' ? taken.sha256.slice(0, 64) : undefined,
    codeLength: typeof taken.code === 'string' ? taken.code.length : undefined,
  };
  return taken;
}

function service() {
  if (!importService) throw new Error('Anime source import route not configured');
  return importService;
}

// One test at a time: it calls the real site, and two at once would double the requests the person agreed to.
async function runTest(id) {
  if (typeof id !== 'string' || !id) throw createFailure('Choose an anime source to test.');
  if (!activeRegistry || !activeRegistry.has(id)) throw createFailure(`"${id.slice(0, 40)}" is not an anime source.`, 404);
  if (testing) throw createFailure('A test is already running: wait for it to finish.', 409);
  testing = true;
  // The app's own background probes stand aside while the person watches this run (common/quiet-mode.js).
  const endQuiet = beginQuiet();
  try { return { ok: true, ...(await liveTest({ id })) }; } finally { testing = false; endQuiet(); }
}

/** @param {import('express').Router} router */
function registerAnimeSourceImportRoutes(router) {
  const limit = rateLimiter(RATE_WINDOW_MS, RATE_MAX);
  const testLimit = rateLimiter(RATE_WINDOW_MS, TEST_RATE_MAX);

  router.post('/api/anime/sources/import/preview', requireThisComputer, limit, asyncHandler(async (req, res) => {
    const { code, id } = takeBody(req);
    res.json(await service().preview({ code, id }));
  }));

  router.post('/api/anime/sources/import/install', requireThisComputer, limit, asyncHandler(async (req, res) => {
    const { sha256, id, replace } = takeBody(req);
    res.json(await service().install({ sha256, id, replace }));
  }));

  router.post('/api/anime/sources/import/test', requireThisComputer, testLimit, asyncHandler(async (req, res) => {
    // The blanket 30 s /api timeout (server.js, apiTimeout) would cut a test that is meant to take minutes with a 504 while it is still
    // running (its own limit is the time limit of the run), so this route extends it, as routes/sources.js does for a slow source call.
    req.setTimeout(TEST_HTTP_TIMEOUT_MS);
    res.setTimeout(TEST_HTTP_TIMEOUT_MS);
    const { id } = takeBody(req);
    res.json(await runTest(id));
  }));

  router.post('/api/anime/sources/uninstall', requireThisComputer, limit, asyncHandler(async (req, res) => {
    const { id } = takeBody(req);
    res.json(await service().uninstall({ id }));
  }));
}

module.exports = { configure, registerAnimeSourceImportRoutes };
