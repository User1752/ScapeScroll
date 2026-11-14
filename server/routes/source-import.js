/**
 * routes/source-import.js — Import a source file the person wrote or generated themselves
 *
 * Endpoints:
 *   POST /api/sources/import/preview  — Reads the text without running it, stages it under its sha256 and reports
 *                                       what it found (body: { code, id? })
 *   POST /api/sources/import/install  — Installs the staged file with that sha256 (body: { sha256, id, replace? })
 *   POST /api/sources/import/link     — Writes a source from the address of a site, with no AI: probes the site, checks the
 *                                       template of its engine fits, and returns the text of the file (body: { url, id? }).
 *                                       It installs nothing: the text goes through the same Check as any other file
 *                                       With { regenerate: <id> } it writes the source again for an installed source this app wrote
 *                                       (its address comes from the installed file, never from the request); nothing is replaced
 *   POST /api/sources/import/generated — Lists the installed sources this app wrote from a link, for the Regenerate buttons
 *   POST /api/sources/import/test     — Runs the checklist against the REAL site for an installed source, when the person
 *                                       asks (body: { id, depth?: 'basic' | 'full' }); remembers the outcome
 *
 * Security:
 *  • These routes install or stage code (or ask a third-party site for pages), so they are in PRIVILEGED_ROUTES (local-only while no password is set) AND
 *    behind requireThisComputer: they stay on this computer even with an Access Password set.
 *  • What is installed is the staged file named by its sha256, never text sent with the install request.
 *  • The request body (which holds the whole source text) is replaced by a small summary before anything can log it.
 */

'use strict';

const fs = require('fs');
const { readStore, writeStore, flushNow } = require('../store');
const {
  sourcePath,
  loadSourceFromFile,
  loadCandidateFromFile,
  clearSourceCache,
} = require('../sourceLoader');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { requireThisComputer } = require('../middleware/local-only');
const { rateLimiter } = require('../middleware/security');
const { createSourceImportService } = require('../modules/source-import/service');
const { parseDenylist } = require('../modules/source-import/site-denylist');
const { generateFromLink } = require('../modules/source-import/generator/from-link');
const { createRegenerate } = require('../modules/source-import/regenerate');
const { createFailure } = require('../modules/source-import/failure');
const { beginQuiet } = require('../modules/common/quiet-mode');

const asyncHandler = createAsyncHandler('SOURCE_IMPORT');
const IMPORT_RATE_WINDOW_MS = 60_000;
const IMPORT_RATE_MAX = 30;
// A test calls the real site: few of them per minute.
const TEST_RATE_MAX = 6;
// A little more than the longest a test may run (live-test-support.js: 5 minutes), so the run ends before the connection does.
const TEST_HTTP_TIMEOUT_MS = 6 * 60_000;
// Writing a source from a link asks the site for about a dozen pages.
const LINK_RATE_MAX = 4;

let importService = null;
let regeneration = null;
let denylistFile = '';
let linkGenerator = generateFromLink;

// `denylistFile`: the person's own list of dangerous sites (data/site-denylist.txt), read on every request so an edit applies at once.
// `generate` replaces the link flow in tests.
function configure({ stagingDir, denylistFile: file = '', generate = generateFromLink } = {}) {
  denylistFile = file;
  linkGenerator = generate;
  importService = createSourceImportService({
    stagingDir,
    sourcePath,
    loadCandidateFromFile,
    loadSourceFromFile,
    clearSourceCache,
    readStore,
    writeStore,
    flushNow,
    // Lazy: routes/sources.js builds its popular-all cache when it is first required.
    invalidatePopularAll: () => require('./sources').invalidatePopularCache(),
  });
  regeneration = createRegenerate({
    readStore,
    readText: (id) => fs.readFileSync(sourcePath(id), 'utf8'),
    generate: (url, options) => linkGenerator(url, options),
  });
}

// Reads the fields this route uses, one by one, and leaves req.body as a small summary: the error handler logs the body
// of a failed request, and for this route that would be the whole source file.
function takeBody(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const catalogKey = body.catalog && typeof body.catalog === 'object' && typeof body.catalog.key === 'string' ? body.catalog.key.slice(0, 140) : '';
  const taken = { code: body.code, id: body.id, sha256: body.sha256, replace: body.replace, depth: body.depth, url: body.url, regenerate: body.regenerate, catalogKey };
  req.body = {
    catalogKey: catalogKey || undefined,
    id: typeof taken.id === 'string' ? taken.id.slice(0, 80) : undefined,
    sha256: typeof taken.sha256 === 'string' ? taken.sha256.slice(0, 64) : undefined,
    codeLength: typeof taken.code === 'string' ? taken.code.length : undefined,
    depth: typeof taken.depth === 'string' ? taken.depth.slice(0, 10) : undefined,
    url: typeof taken.url === 'string' ? taken.url.slice(0, 200) : undefined,
    regenerate: typeof taken.regenerate === 'string' ? taken.regenerate.slice(0, 80) : undefined,
  };
  return taken;
}

function extraDenylist() {
  if (!denylistFile) return [];
  try { return parseDenylist(fs.readFileSync(denylistFile, 'utf8')); } catch (_) { return []; }
}

// The answer for the card: a refusal is an answer (`status: 'refused'` says why), not an error. The generated text is returned for
// the person to read and Check; it is not staged here, so the Check stays the one gate every file passes.
async function linkAnswer({ url, id, regenerate, catalogKey }) {
  if (typeof regenerate === 'string' && regenerate) return { ok: true, ...(await regeneration.regenerate(regenerate, { denylist: extraDenylist() })) };
  if (catalogKey) {
    // A row of the catalog: the address is the repository's (never one the browser sent), and the same generator runs on it.
    const site = await require('./source-catalog').siteOf(catalogKey);
    const result = await linkGenerator(site.url, { id: site.id, denylist: extraDenylist() });
    if (result.status === 'bad-url') throw createFailure(result.message);
    // A refusal (the site did not answer, or the template does not fit it): the catalog stops offering the site as automatic for a while.
    if (result.status === 'refused') await require('./source-catalog').markFailed(catalogKey, result.stage || result.message);
    return { ok: true, ...result };
  }
  if (typeof url !== 'string' || !url.trim()) throw createFailure('Paste the address of the site first.');
  const result = await linkGenerator(url.trim(), { id: typeof id === 'string' && id.trim() ? id.trim() : undefined, denylist: extraDenylist() });
  if (result.status === 'bad-url') throw createFailure(result.message);
  return { ok: true, ...result };
}

function service() {
  if (!importService) throw new Error('Source import route not configured');
  return importService;
}

/**
 * @param {import('express').Router} router
 */
function registerSourceImportRoutes(router) {
  const limit = rateLimiter(IMPORT_RATE_WINDOW_MS, IMPORT_RATE_MAX);
  const testLimit = rateLimiter(IMPORT_RATE_WINDOW_MS, TEST_RATE_MAX);
  const linkLimit = rateLimiter(IMPORT_RATE_WINDOW_MS, LINK_RATE_MAX);

  router.post('/api/sources/import/preview', requireThisComputer, limit, asyncHandler(async (req, res) => {
    const { code, id } = takeBody(req);
    res.json(await service().preview({ code, id }));
  }));

  router.post('/api/sources/import/install', requireThisComputer, limit, asyncHandler(async (req, res) => {
    const { sha256, id, replace } = takeBody(req);
    res.json(await service().install({ sha256, id, replace }));
  }));

  router.post('/api/sources/import/link', requireThisComputer, linkLimit, asyncHandler(async (req, res) => {
    res.json(await linkAnswer(takeBody(req)));
  }));

  router.post('/api/sources/import/generated', requireThisComputer, limit, asyncHandler(async (req, res) => {
    takeBody(req);
    res.json({ ok: true, sources: await regeneration.list() });
  }));

  router.post('/api/sources/import/test', requireThisComputer, testLimit, asyncHandler(async (req, res) => {
    // The blanket 30 s /api timeout (server.js, apiTimeout) would cut a test that is meant to take minutes with a 504 while it is still
    // running (its own limit is the time limit of the run), so this route extends it, as routes/sources.js does for a slow source call.
    req.setTimeout(TEST_HTTP_TIMEOUT_MS);
    res.setTimeout(TEST_HTTP_TIMEOUT_MS);
    const { id, depth } = takeBody(req);
    // The app's own background probes stand aside while the person watches this run (common/quiet-mode.js).
    const endQuiet = beginQuiet();
    try {
      res.json(await service().test({ id, depth }));
    } finally {
      endQuiet();
    }
  }));
}

/** The installed sources this app wrote from a link: [{ id, name, engine, base, on }] (the catalog marks the sites already added with it). */
async function generatedSources() {
  return regeneration ? regeneration.list() : [];
}

module.exports = { configure, registerSourceImportRoutes, generatedSources };
