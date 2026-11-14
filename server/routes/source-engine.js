/**
 * routes/source-engine.js — Add a site through the person's own Suwayomi-Server (the extension engine)
 *
 * Endpoints:
 *   POST /api/sources/engine/prepare  — Installs the extension of a catalog row in the person's Suwayomi-Server and writes the source that reads it
 *                                       (body: { key, acknowledge: true }). It returns the text of the source, in the shape of the link route's
 *                                       answer: the card puts it in its box and runs its own Check, and the person still has to press Install.
 *
 *   POST /api/sources/engine/updates  — Which of the sources written for the engine have a newer extension in the person's Suwayomi-Server, with a link
 *                                       (and, when the project has one, the start of the text) of what changed. Asks that server, nothing else.
 *   POST /api/sources/engine/update   — Updates the extension of one of those sources in that server and writes the source again, in the same shape as
 *                                       prepare (body: { id: 'sw-<digits>', acknowledge: true }): the card Checks it and the person confirms the replacement.
 *
 * What the extension engine is: Suwayomi-Server runs Mihon-compatible extensions (Android programs); this app does not. The extension is installed
 * IN THAT SERVER, from the repositories it is set up with, and runs there with that server's own rights. This route is the only place that asks
 * for the install, and it does so only for a package the catalog lists, only when the person confirmed (`acknowledge`), and never for a package
 * or an address the browser sent: the body holds a catalog key, nothing else.
 *
 * Security: it installs code (in another server) and writes a source, so it is in PRIVILEGED_ROUTES (local-only while no password is set) AND
 * behind requireThisComputer, rate limited, and the body is replaced by a small summary before anything can log it.
 */

'use strict';

const { readStore } = require('../store');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { requireThisComputer } = require('../middleware/local-only');
const { rateLimiter } = require('../middleware/security');
const { createSuwayomiService } = require('../modules/suwayomi/service');
const { buildEngineSource } = require('../modules/source-catalog/engine');
const { planFilters } = require('../modules/source-catalog/engine/filter-plan');
const { findMergedChaptersPreference } = require('../modules/source-catalog/engine/preferences');
const config = require('../config/catalog');
const { createFailure } = require('../modules/source-import/failure');
const catalogRoutes = require('./source-catalog');

const asyncHandler = createAsyncHandler('SOURCE_ENGINE');
const RATE_WINDOW_MS = 60_000;
// Each one asks a Suwayomi-Server to download and convert a file.
const PREPARE_RATE_MAX = 6;
// Looking for updates asks one list of the server (and a changelog of the project for each that has one).
const UPDATES_RATE_MAX = 20;
const MAX_CHECKED = 100;
// A little more than the install itself may take (limits.engineInstallTimeoutMs), so the answer is not cut by the blanket API time limit first.
const PREPARE_HTTP_TIMEOUT_MS = 180_000;

let suwayomi = null;
let catalogOf = () => catalogRoutes.getCatalog();
let installedOf = () => installedEngineSourceIds();

/** @param {{ suwayomi?: object, catalog?: () => object, installed?: () => Promise<string[]> }} [options]   replaced in tests */
function configure({ suwayomi: replacement, catalog, installed } = {}) {
  suwayomi = replacement || null;
  if (typeof catalog === 'function') catalogOf = catalog;
  installedOf = typeof installed === 'function' ? installed : installedEngineSourceIds;
}

const engine = () => suwayomi || (suwayomi = createSuwayomiService({ readStore }));

function takeBody(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const taken = { key: typeof body.key === 'string' ? body.key.slice(0, 140) : '', id: typeof body.id === 'string' ? body.id.slice(0, 40) : '', acknowledge: body.acknowledge === true };
  req.body = { key: taken.key || undefined, id: taken.id || undefined, acknowledge: taken.acknowledge };
  return taken;
}

/** Installs the extension and finds the source it brought; throws a failure with its own sentence when any step does not hold. */
async function installAndFind(site) {
  const server = engine();
  if (!(await server.getConfig())) throw createFailure('Set the address of your Suwayomi-Server first (Settings -> Suwayomi).', 400);
  // The repository first: a Suwayomi-Server installs only from the repositories it knows, and this one has nothing to set up in its container.
  try {
    await server.ensureExtensionStore(config.engineStoreUrl);
  } catch (err) {
    throw createFailure(String((err && err.message) || err).slice(0, 300), err && err.statusCode === 400 ? 400 : (err && err.statusCode === 401 ? 401 : 502));
  }
  let outcome;
  try {
    outcome = await server.installExtension(site.pkg);
  } catch (err) {
    throw createFailure(String((err && err.message) || err).slice(0, 300), err && err.statusCode === 400 ? 400 : (err && err.statusCode === 401 ? 401 : 502));
  }
  let sources;
  try {
    sources = await server.listSources();
  } catch (err) {
    throw createFailure(`The extension was installed, but the list of sources could not be read: ${String((err && err.message) || err).slice(0, 200)}`, 502);
  }
  const found = sources.find((item) => item.id === site.sourceId);
  if (!found) throw createFailure('Your Suwayomi-Server installed the extension but does not list this site among its sources. The repository it is set up with may be a different one.', 409);
  return { found, already: outcome.already };
}

/** What the server lists as the filters of a source, or nothing when it cannot say: a source without filters is how these were before. */
async function filtersOf(sourceId) {
  try { return await engine().getSourceFilters(sourceId); } catch (_) { return []; }
}

/**
 * An extension that makes one chapter per picture may have a switch that joins them into long chapters (so a reader does not stop after every image).
 * It is turned on here, since reading is what the source is for; the person is told. Best effort: any failure is "nothing was changed".
 * @returns {Promise<string>} the sentence for the notes, or ''
 */
async function mergedChaptersNote(sourceId) {
  try {
    const server = engine();
    const preferences = await server.getSourcePreferences(sourceId);
    const found = findMergedChaptersPreference(preferences);
    if (!found) return '';
    if (!found.enabled) await server.setSourcePreference(sourceId, found.position, true);
    return found.enabled
      ? 'The extension joins a title\'s pictures into long chapters (its "merge chapters" setting is on), so it reads without stopping after every image.'
      : 'The extension\'s "merge chapters" setting was turned on in your Suwayomi-Server, so a title\'s pictures are joined into long chapters and it reads without stopping after every image.';
  } catch (_) {
    return '';
  }
}

/**
 * The source written for a site the Suwayomi-Server has loaded, in the shape of a link answer (the card puts it in its box and Checks it; the person
 * confirms). The extension's own filters are read into it: "no filters" when the server cannot tell.
 * @param {{ name: string }} site
 * @param {{ id: string, name?: string, supportsLatest?: boolean, isNsfw?: boolean }} found
 * @param {string} firstNote   what happened to the extension, in a sentence
 */
async function writtenAnswer(site, found, firstNote) {
  const filterPlan = planFilters(await filtersOf(found.id));
  const built = buildEngineSource({ sourceId: found.id, name: found.name || site.name, supportsLatest: found.supportsLatest, isNsfw: found.isNsfw, filterPlan });
  const notes = [
    firstNote,
    'The source works only while that server is reachable and keeps the extension: if you remove the extension there, the titles you saved from it stop opening.',
    'Titles of the genres this app never lists are left out only where the extension gives the genres in its lists.',
  ];
  const merged = await mergedChaptersNote(found.id);
  if (merged) notes.push(merged);
  const offered = [built.filters.genres && 'genres', built.filters.tags && 'tags you type', built.filters.status && 'status', built.filters.sort && 'sort'].filter(Boolean);
  notes.push(offered.length ? `The Advanced Search offers what the extension has: ${offered.join(', ')}.` : 'The extension has no genre, status or sort filter this app can use, so the Advanced Search has none for it.');
  if (built.adultOnly) notes.push('The extension marks the whole source as adult: every title is declared adult, and Hide NSFW hides the whole source.');
  return {
    ok: true,
    status: 'generated',
    code: built.code,
    id: built.id,
    name: built.name,
    engine: 'suwayomi',
    notes,
    probe: { verdict: 'open', engine: { id: 'suwayomi', name: 'Suwayomi', confidence: 'high' }, reasons: [] },
  };
}

/** Updates the extension and finds the source it has now; throws a failure with its own sentence when a step does not hold. */
async function updateAndFind(site) {
  const server = engine();
  if (!(await server.getConfig())) throw createFailure('Set the address of your Suwayomi-Server first (Settings -> Suwayomi).', 400);
  try {
    await server.updateExtension(site.pkg);
  } catch (err) {
    throw createFailure(String((err && err.message) || err).slice(0, 300), err && err.statusCode === 400 ? 400 : (err && err.statusCode === 401 ? 401 : 502));
  }
  let sources;
  try {
    sources = await server.listSources();
  } catch (err) {
    throw createFailure(`The extension was updated, but the list of sources could not be read: ${String((err && err.message) || err).slice(0, 200)}`, 502);
  }
  const found = sources.find((item) => item.id === site.sourceId);
  if (!found) throw createFailure('Your Suwayomi-Server updated the extension but no longer lists this site among its sources.', 409);
  return found;
}

/** The ids (the digits after the prefix) of the sources this app wrote for the engine that are installed now. */
async function installedEngineSourceIds() {
  const store = await readStore();
  const prefix = config.engineIdPrefix;
  return Object.keys((store && store.installedSources) || {})
    .filter((id) => id.startsWith(prefix) && /^\d{1,20}$/.test(id.slice(prefix.length)))
    .map((id) => id.slice(prefix.length));
}

/**
 * @param {import('express').Router} router
 */
function registerSourceEngineRoutes(router) {
  const prepareLimit = rateLimiter(RATE_WINDOW_MS, PREPARE_RATE_MAX);
  const updatesLimit = rateLimiter(RATE_WINDOW_MS, UPDATES_RATE_MAX);

  router.post('/api/sources/engine/prepare', requireThisComputer, prepareLimit, asyncHandler(async (req, res) => {
    req.setTimeout(PREPARE_HTTP_TIMEOUT_MS);
    res.setTimeout(PREPARE_HTTP_TIMEOUT_MS);
    const { key, acknowledge } = takeBody(req);
    if (!acknowledge) throw createFailure('Confirm first: the extension is a program from a third party and is installed in your Suwayomi-Server.', 400);
    const site = await catalogOf().engineSiteOf(key);
    const { found, already } = await installAndFind(site);
    res.json(await writtenAnswer(site, found, already
      ? 'The extension was already installed in your Suwayomi-Server.'
      : 'The extension was installed in your Suwayomi-Server. It runs there, not in ScrollScape, which only asks it.'));
  }));

  router.post('/api/sources/engine/updates', requireThisComputer, updatesLimit, asyncHandler(async (req, res) => {
    req.setTimeout(PREPARE_HTTP_TIMEOUT_MS);
    res.setTimeout(PREPARE_HTTP_TIMEOUT_MS);
    takeBody(req);
    const ids = await installedOf();
    if (!ids.length) return res.json({ ok: true, updates: [], checked: 0 });
    const server = engine();
    if (!(await server.getConfig())) throw createFailure('Set the address of your Suwayomi-Server first (Settings -> Suwayomi).', 400);
    let extensions;
    try {
      extensions = await server.listExtensions();
    } catch (err) {
      throw createFailure(String((err && err.message) || err).slice(0, 300), err && err.statusCode === 401 ? 401 : 502);
    }
    const updates = [];
    for (const sourceId of ids.slice(0, MAX_CHECKED)) {
      let site;
      try { site = await catalogOf().engineSiteOfSourceId(sourceId); } catch (_) { continue; }
      const extension = extensions.find((item) => item.pkg === site.pkg);
      if (!extension || !extension.installed || !extension.hasUpdate) continue;
      const changelog = await catalogOf().changelogFor(site.pkg);
      updates.push({ id: site.id, name: site.name, version: extension.versionName, changelogUrl: changelog.url, changelog: changelog.text });
    }
    res.json({ ok: true, updates, checked: ids.length });
  }));

  router.post('/api/sources/engine/update', requireThisComputer, prepareLimit, asyncHandler(async (req, res) => {
    req.setTimeout(PREPARE_HTTP_TIMEOUT_MS);
    res.setTimeout(PREPARE_HTTP_TIMEOUT_MS);
    const { id, acknowledge } = takeBody(req);
    if (!acknowledge) throw createFailure('Confirm first: the new version of the extension is a program from a third party and is installed in your Suwayomi-Server.', 400);
    const match = new RegExp(`^${config.engineIdPrefix}(\\d{1,20})$`).exec(id);
    if (!match || !(await installedOf()).includes(match[1])) throw createFailure('That is not a source written for the extension engine that is installed.', 404);
    const site = await catalogOf().engineSiteOfSourceId(match[1]);
    const found = await updateAndFind(site);
    res.json(await writtenAnswer(site, found, 'The extension was updated in your Suwayomi-Server. It runs there, not in ScrollScape, which only asks it.'));
  }));
}

module.exports = { configure, registerSourceEngineRoutes };
