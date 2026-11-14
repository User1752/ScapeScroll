/**
 * routes/source-catalog.js — The catalog of sites a Mihon-compatible repository lists
 *
 * Endpoints:
 *   POST /api/sources/catalog/list  — One page of the catalog (body: { lang?, q?, warnings?, nativeOnly?, hideCloudflare?, hideAdult?, hideInstalled?, onlyInstalled?, offset? })
 *
 * Choosing a row is not an endpoint of its own: the row's key goes to POST /api/sources/import/link ({ catalog: { key } }), which looks the
 * address up here (siteOf) and runs the generator, so every source written from the catalog passes the same Check and the same
 * confirmation as one written from a pasted link.
 *
 * Security:
 *  • The catalog asks GitHub and the DNS for things and then hands a site to the code that installs sources, so the route is in
 *    PRIVILEGED_ROUTES (local-only while no password is set) AND behind requireThisComputer, like the import routes.
 *  • Only fixed addresses (server/config/catalog.js) are asked for text; the browser never sends an address, only a row's key.
 */

'use strict';

const fs = require('fs');
const { readStore, writeStore, flushNow } = require('../store');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { requireThisComputer } = require('../middleware/local-only');
const { rateLimiter } = require('../middleware/security');
const { createCatalog, createCaches } = require('../modules/source-catalog/catalog');
const { createRepoRegistry } = require('../modules/source-catalog/repos');
const { repoCandidates } = require('../modules/source-catalog/repo-url');
const catalogConfig = require('../config/catalog');
const { createSuwayomiService } = require('../modules/suwayomi/service');
const { fetchText } = require('../modules/source-catalog/fetch-text');
const { parseDenylist } = require('../modules/source-import/site-denylist');
const { createFailure } = require('../modules/source-import/failure');

const asyncHandler = createAsyncHandler('SOURCE_CATALOG');
const RATE_WINDOW_MS = 60_000;
// The screen asks again every few seconds while the background reading is still going.
const LIST_RATE_MAX = 60;
// Adding and removing a repository asks a third party for a list.
const REPO_RATE_MAX = 10;

let catalog = null;
let repos = null; // the repositories the person added (settings.catalogRepos)
// Whether the person has set up a Suwayomi-Server (Settings -> Suwayomi); replaced in tests.
let engineConfigured = async () => {
  try { return !!(await createSuwayomiService({ readStore }).getConfig()); } catch (_) { return false; }
};

/**
 * @param {{ cacheDir?: string, denylistFile?: string, catalog?: object }} [options]   `catalog` replaces the real one in tests
 */
function configure({ cacheDir = '', denylistFile = '', catalog: replacement, hasEngine, registry } = {}) {
  if (typeof hasEngine === 'function') engineConfigured = hasEngine;
  const denylist = () => {
    if (!denylistFile) return [];
    try { return parseDenylist(fs.readFileSync(denylistFile, 'utf8')); } catch (_) { return []; }
  };
  repos = registry || createRepoRegistry({ store: { readStore, writeStore, flushNow }, fetchText, config: catalogConfig });
  catalog = replacement || createCatalog({
    fetchText,
    caches: createCaches(cacheDir),
    denylist,
    getExtraRepos: () => repos.list().catch(() => []),
    getDefaultOn: () => repos.defaultOn().catch(() => true),
  });
}

function registry() {
  if (!repos) throw new Error('Source catalog route not configured');
  return repos;
}

function service() {
  if (!catalog) throw new Error('Source catalog route not configured');
  return catalog;
}

/** The fields this route uses, one by one and checked. req.body is replaced by a small summary before anything can log it. */
function takeBody(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');
  const taken = {
    lang: text(body.lang, 12),
    q: text(body.q, 80),
    warnings: Array.isArray(body.warnings) ? body.warnings.filter((w) => typeof w === 'string').slice(0, 3) : undefined,
    nativeOnly: body.nativeOnly !== false,
    hideCloudflare: body.hideCloudflare === true,
    hideAdult: body.hideAdult === true,
    hideInstalled: body.hideInstalled === true,
    onlyInstalled: body.onlyInstalled === true,
    offset: Number.isFinite(Number(body.offset)) ? Math.max(0, Math.floor(Number(body.offset))) : 0,
    limit: Number.isFinite(Number(body.limit)) ? Math.max(1, Math.floor(Number(body.limit))) : undefined,
  };
  req.body = { lang: taken.lang, q: taken.q.slice(0, 20), offset: taken.offset };
  return taken;
}

/** The ids and addresses of what is installed, to mark the rows already added. A failure only leaves the marks off. */
async function installedMarks() {
  const ids = new Set();
  const bases = new Set();
  const byBase = new Map();
  try {
    const store = await readStore();
    for (const id of Object.keys((store && store.installedSources) || {})) ids.add(id);
  } catch (_) { /* the rows are listed without the marks */ }
  try {
    for (const item of await require('./source-import').generatedSources()) { bases.add(item.base); byBase.set(item.base, item.id); }
  } catch (_) { /* same */ }
  return { ids, bases, byBase };
}

/**
 * The site a catalog row stands for (see catalog.siteOf). Used by the link route.
 * @param {string} key
 */
async function siteOf(key) {
  if (typeof key !== 'string' || !key) throw createFailure('Choose a site of the catalog first.');
  return service().siteOf(key);
}

/**
 * @param {import('express').Router} router
 */
function registerSourceCatalogRoutes(router) {
  const listLimit = rateLimiter(RATE_WINDOW_MS, LIST_RATE_MAX);

  const repoLimit = rateLimiter(RATE_WINDOW_MS, REPO_RATE_MAX);

  // The repositories added besides the default one, and how each is doing.
  router.get('/api/sources/catalog/repos', requireThisComputer, listLimit, asyncHandler(async (_req, res) => {
    const added = await registry().list();
    const status = new Map((typeof service().reposStatus === 'function' ? await service().reposStatus() : []).map((r) => [r.url, r]));
    const rows = added.map((r) => ({ url: r.url, name: r.name, ok: status.has(r.url) ? status.get(r.url).ok : null, count: status.has(r.url) ? status.get(r.url).count : 0 }));
    // The default repository is listed like the others (it can be removed, and added again by pasting its address), first.
    const defaultOn = typeof registry().defaultOn === 'function' ? await registry().defaultOn() : true;
    if (defaultOn) {
      const mine = typeof service().defaultStatus === 'function' ? await service().defaultStatus() : null;
      let name = '';
      try { name = repoCandidates(catalogConfig.repoIndexUrl).label; } catch (_) { /* the host below */ }
      rows.unshift({ url: catalogConfig.repoIndexUrl, name: name || new URL(catalogConfig.repoIndexUrl).hostname, ok: mine ? mine.ok : null, count: mine ? mine.count : 0, default: true });
    }
    res.json({ ok: true, max: registry().MAX_REPOS, default: catalogConfig.repoIndexUrl, defaultOn, repos: rows });
  }));

  // Adds one: the address is judged strictly, then a list of extensions has to be really there (asked through the catalog's own request).
  router.post('/api/sources/catalog/repos', requireThisComputer, repoLimit, asyncHandler(async (req, res) => {
    const input = req.body && typeof req.body.input === 'string' ? req.body.input.slice(0, 400) : '';
    req.body = { input: input.slice(0, 20) };
    const repo = await registry().add(input);
    res.json({ ok: true, repo });
  }));

  router.delete('/api/sources/catalog/repos', requireThisComputer, repoLimit, asyncHandler(async (req, res) => {
    const url = req.body && typeof req.body.url === 'string' ? req.body.url.slice(0, 400) : '';
    res.json({ ok: true, removed: await registry().remove(url) });
  }));

  router.post('/api/sources/catalog/list', requireThisComputer, listLimit, asyncHandler(async (req, res) => {
    const params = takeBody(req);
    res.json({ ok: true, ...(await service().list(params, await installedMarks(), { extensionEngine: await engineConfigured() })) });
  }));
}

/** Tells the catalog that no source could be written for a row's site, so the list stops offering it as automatic. Never throws: it only improves the list. */
async function markFailed(key, reason) {
  try { return await service().markFailed(key, reason); } catch (_) { return false; }
}

module.exports = { configure, registerSourceCatalogRoutes, siteOf, markFailed, getCatalog: service };
