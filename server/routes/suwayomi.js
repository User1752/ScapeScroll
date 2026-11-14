/**
 * routes/suwayomi.js — Image relay to a user's own Suwayomi-Server instance
 *
 * Endpoints:
 *   GET /api/suwayomi/test                                — Connectivity check (Settings "Test Connection")
 *   GET /api/suwayomi/thumbnail/:mangaId                   — Manga cover image
 *   GET /api/suwayomi/page/:mangaId/:chapterIndex/:index   — Chapter page image
 *   GET /api/suwayomi/windows-setup.cmd                    — The script that sets up a Suwayomi-Server on this Windows computer (tools/windows/), with the
 *                                                            folder of this app filled in so it installs next to the library
 *   POST /api/suwayomi/connect-local                       — Reads the connection file that script wrote and saves it in the settings (this computer only)
 *   GET  /api/suwayomi/local/status                        — The Suwayomi-Server this app sets up on this Windows computer: installed, running, progress, firewall
 *   POST /api/suwayomi/local/{install,start,stop,uninstall,firewall,autostart} — Set it up (download, check, unpack, configure, start, connect), run it, remove it
 *                                                            (this computer only: they start and stop programs of this computer)
 *
 * These exist because a source written for the extension engine can't
 * point its img/cover fields at /api/proxy-image: that endpoint enforces
 * isSafeUrl() on the target, which rejects the private/loopback addresses a
 * self-hosted Suwayomi-Server instance realistically runs on. See
 * server/modules/suwayomi/service.js's header for why bypassing that guard
 * here is safe (the target is an admin-configured setting, not an
 * attacker/scraper-controlled URL). Path params are digit-only validated
 * before use as defense in depth even though they're not interpolated into
 * a shell or SQL context.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { readStore, writeStore, flushNow } = require('../store');
const { requireThisComputer, requireLocalRequest } = require('../middleware/local-only');
const { rateLimiter } = require('../middleware/security');
const { readLocalConnection, setupScriptPath, connectionFilePath, bakeSetupScript } = require('../modules/suwayomi/local-setup');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { applyUntrustedContentHeaders, safeRelayContentType } = require('../modules/http/untrusted-content');
const { createSuwayomiService } = require('../modules/suwayomi/service');
const { createLocalServer, findInstall } = require('../modules/suwayomi/local-server');
const { createFirewall } = require('../modules/suwayomi/local-firewall');

const asyncHandler = createAsyncHandler('SUWAYOMI');
const suwayomiService = createSuwayomiService({ readStore });

const DIGITS_ONLY = /^\d+$/;

function requireDigits(paramName) {
  return (req, res, next) => {
    if (!DIGITS_ONLY.test(req.params[paramName] || '')) {
      return res.status(400).json({ ok: false, error: `Invalid ${paramName}` });
    }
    next();
  };
}

async function sendImage(res, { body, contentType }) {
  // The Suwayomi URL is operator-configured but still a third party; keep
  // whatever it returns from ever being served as a document on our origin.
  applyUntrustedContentHeaders(res);
  res.set('Content-Type', safeRelayContentType(contentType));
  res.set('Cache-Control', 'max-age=86400');
  const nodeStream = Readable.fromWeb(body);
  await pipeline(nodeStream, res);
}

const CONNECT_RATE_MAX = 10;
const LOCAL_RATE_MAX = 20;

// The folder that holds the library (server.js says which): the Suwayomi folder of the setup script is inside it.
let userRootDir = path.join(__dirname, '..', '..');
function configure({ userRoot } = {}) {
  if (userRoot) userRootDir = String(userRoot);
}

/** Saves the address and login of a Suwayomi-Server of this computer in the settings. */
async function saveConnectionInSettings(store, connection) {
  const data = await store.readStore();
  data.settings = data.settings || {};
  Object.assign(data.settings, { suwayomiUrl: connection.url, suwayomiUsername: connection.username, suwayomiPassword: connection.password });
  await store.writeStore(data);
  store.flushNow();
}

// The Suwayomi-Server this app sets up and runs on this computer: one for the whole app, made when first needed.
let sharedLocal = null;
let sharedFirewall = null;
function defaultLocalServer() {
  if (!sharedLocal) {
    sharedLocal = createLocalServer({ userRoot: () => userRootDir, saveConnection: (connection) => saveConnectionInSettings({ readStore, writeStore, flushNow }, connection) });
    // Closing the app closes it, like the browser solver.
    process.once('exit', () => sharedLocal.stopNow());
  }
  return sharedLocal;
}
const defaultFirewall = () => sharedFirewall || (sharedFirewall = createFirewall());

/** At the start of the app: start the Suwayomi-Server this app set up, unless the person turned that off. Never throws. */
async function autoStartLocal() {
  try {
    const data = await readStore();
    if (data && data.settings && data.settings.suwayomiLocalAutoStart === false) return;
    await defaultLocalServer().autoStart();
  } catch (_) { /* started from the settings, or by hand */ }
}

/**
 * @param {import('express').Application} app
 * @param {{ readConnection?: Function, scriptPath?: Function, service?: object, store?: object }} [deps]   replaced in tests
 */
function registerSuwayomiRoutes(app, { readConnection = readLocalConnection, scriptPath = setupScriptPath, service = suwayomiService, store = { readStore, writeStore, flushNow }, userRoot = () => userRootDir, localServer = null, firewall = null } = {}) {
  const connectLimit = rateLimiter(60_000, CONNECT_RATE_MAX);
  const localLimit = rateLimiter(60_000, LOCAL_RATE_MAX);
  const local = () => localServer || defaultLocalServer();
  const rules = () => firewall || defaultFirewall();

  app.get('/api/suwayomi/test', asyncHandler(async (_req, res) => {
    res.json(await service.testConnection());
  }));

  // The script is plain text that ships with the app; it is offered as a download and never run from here.
  app.get('/api/suwayomi/windows-setup.cmd', (_req, res) => {
    const file = scriptPath();
    if (!file) return res.status(404).json({ ok: false, error: 'This build has no Suwayomi setup script.' });
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="Setup-Suwayomi.cmd"');
    res.set('X-Content-Type-Options', 'nosniff');
    return res.send(bakeSetupScript(fs.readFileSync(file, 'utf8'), userRoot()));
  });

  // Saves the address and login the setup script made for the Suwayomi-Server of this computer. The file is at a fixed place and can only name this computer.
  app.post('/api/suwayomi/connect-local', requireThisComputer, connectLimit, asyncHandler(async (_req, res) => {
    let connection;
    try {
      connection = readConnection({ file: connectionFilePath(userRoot()) });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
    await saveConnectionInSettings(store, connection);
    let reachable = false;
    let sourceCount = null;
    try {
      const test = await service.testConnection();
      reachable = true;
      sourceCount = test.sourceCount;
    } catch (_) { /* saved; the server may still be starting */ }
    // The password is never sent back.
    return res.json({ ok: true, saved: true, reachable, sourceCount, url: connection.url, username: connection.username });
  }));

  // ── The Suwayomi-Server this app sets up and runs on this computer (Windows) ─────────────────────────────────────────────────────────────────────
  // Every one of these starts, stops or removes a program of this computer, so they answer this computer only (no remote opt-in, unlike the import tool).

  app.get('/api/suwayomi/local/status', requireLocalRequest, asyncHandler(async (_req, res) => {
    const server = local();
    const data = await store.readStore();
    const state = await server.status();
    const firewallOn = state.installed ? await rules().status() : null;
    res.json({ ok: true, ...state, firewall: firewallOn, autoStart: !(data && data.settings && data.settings.suwayomiLocalAutoStart === false) });
  }));

  // Starts the download and returns at once; the status says how far it is. Nothing is downloaded without the person's yes (acknowledge).
  app.post('/api/suwayomi/local/install', requireLocalRequest, localLimit, asyncHandler(async (req, res) => {
    if (!req.body || req.body.acknowledge !== true) {
      return res.status(400).json({ ok: false, error: 'Confirm first: this downloads Suwayomi-Server (about 330 MB) from its project on GitHub, checks it, and runs it on this computer.' });
    }
    try {
      return res.json({ ok: true, ...local().startInstall() });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/suwayomi/local/start', requireLocalRequest, localLimit, asyncHandler(async (_req, res) => {
    try {
      return res.json({ ok: true, ...(await local().start()) });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/suwayomi/local/stop', requireLocalRequest, localLimit, asyncHandler(async (_req, res) => {
    await local().stop();
    res.json({ ok: true });
  }));

  // Removes the Suwayomi folder of this app (the server, its extensions and what it downloaded). The settings of the address stay as the person has them.
  app.post('/api/suwayomi/local/uninstall', requireLocalRequest, localLimit, asyncHandler(async (req, res) => {
    if (!req.body || req.body.confirm !== true) return res.status(400).json({ ok: false, error: 'Confirm first: this deletes the Suwayomi folder of this app.' });
    try {
      return res.json({ ok: true, ...(await local().uninstall()) });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  }));

  // Windows asks the person for permission (a prompt of its own); a refusal comes back as ok: false.
  app.post('/api/suwayomi/local/firewall', requireLocalRequest, localLimit, asyncHandler(async (req, res) => {
    const action = req.body && req.body.action;
    if (action !== 'add' && action !== 'remove') return res.status(400).json({ ok: false, error: 'Say whether to add or remove the rules.' });
    const server = local();
    const layout = server.layout();
    const found = findInstall(layout);
    const programs = found ? [found.javaw, path.join(path.dirname(found.javaw), 'java.exe')] : [];
    try {
      const result = await rules().apply(action, { root: layout.root, programs });
      return res.json({ ok: true, applied: result.ok, firewall: await rules().status() });
    } catch (err) {
      return res.status(err.statusCode || 500).json({ ok: false, error: err.message });
    }
  }));

  app.post('/api/suwayomi/local/autostart', requireLocalRequest, localLimit, asyncHandler(async (req, res) => {
    if (!req.body || typeof req.body.enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'Say whether it should start with the app.' });
    const data = await store.readStore();
    data.settings = data.settings || {};
    data.settings.suwayomiLocalAutoStart = req.body.enabled;
    await store.writeStore(data);
    store.flushNow();
    return res.json({ ok: true, autoStart: req.body.enabled });
  }));

  app.get(
    '/api/suwayomi/thumbnail/:mangaId',
    requireDigits('mangaId'),
    asyncHandler(async (req, res) => {
      await sendImage(res, await suwayomiService.getThumbnail(req.params.mangaId));
    })
  );

  app.get(
    '/api/suwayomi/page/:mangaId/:chapterIndex/:index',
    requireDigits('mangaId'),
    requireDigits('chapterIndex'),
    requireDigits('index'),
    asyncHandler(async (req, res) => {
      await sendImage(res, await suwayomiService.getPage(req.params.mangaId, req.params.chapterIndex, req.params.index));
    })
  );
}

module.exports = { registerSuwayomiRoutes, configure, autoStartLocal };
