'use strict';

const { readStore, writeStore, flushNow } = require('../store');
const discordRpc = require('../modules/discord-rpc/service');
const { COMMON_SETTINGS_FIELDS, copySettingsFields } = require('../modules/common/settings-fields');
const { parseSolverSettingsUpdate } = require('../modules/common/solver-settings');
const { applySolverSettings } = require('../modules/network/solver-wiring');
const { parseDisabledSourceIds } = require('../modules/sources/disabled-sources');

// The settings this edition saves as they come: the ones every edition has (settings-fields.js) and this edition's own.
// disabledSourceIds is the sources the user switched off: the browser sends the whole list, and a list that is not
// entirely valid ids is ignored as a whole (settings-fields.js, 'idList'). The System Health probes skip these sources.
const SAVED_SETTINGS_FIELDS = Object.freeze([
  ...COMMON_SETTINGS_FIELDS,
  // Whether the Suwayomi-Server this app set up on this computer starts with the app (routes/suwayomi.js); on unless it is false.
  Object.freeze(['suwayomiLocalAutoStart', 'boolean']),
  Object.freeze(['disabledSourceIds', 'idList']),
]);

// Tells the FlareSolverr session pool what was just saved. fetch-utils (which builds the
// pool, and with it loads the FlareSolverr lifecycle) is only required when a save happens, so
// a test of this route that injects its own `applySolver` never loads it.
function applyToTheSolverPool(settings) {
  const { getSolverPool } = require('../modules/network/fetch-utils');
  applySolverSettings(getSolverPool(), settings, process.env);
}

// The pool's three keys are judged together, before anything is read or written: one bad value
// refuses the whole save, so a half-applied pool setting can never be stored. The values to
// store travel on the request.
function judgeSolverSettings(req, res, next) {
  const { patch, error } = parseSolverSettingsUpdate(req.body || {});
  if (error) return res.status(400).json({ ok: false, error });
  req.solverSettingsPatch = patch;
  return next();
}

function registerSettingsRoutes(app, { applySolver = applyToTheSolverPool } = {}) {
  app.get('/api/settings', async (req, res) => {
    try {
      const store = await readStore();
      res.json({ ok: true, data: store.settings || {} });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  // Only the list of sources the user switched off, for what the browser does at every start-up
  // (ui-disabled-sources-sync.js): GET /api/settings would hand over every stored credential on each page load.
  app.get('/api/settings/disabled-sources', async (req, res) => {
    try {
      const store = await readStore();
      res.json({ ok: true, data: { disabledSourceIds: parseDisabledSourceIds(store.settings && store.settings.disabledSourceIds) } });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.post('/api/settings', judgeSolverSettings, async (req, res) => {
    try {
      const updates = req.body || {};
      const store = await readStore();

      store.settings = store.settings || {};
      copySettingsFields(store.settings, updates, SAVED_SETTINGS_FIELDS);
      Object.assign(store.settings, req.solverSettingsPatch);

      await writeStore(store);
      // Settings are rare, deliberate writes (unlike high-frequency reading
      // progress) — flush to disk immediately rather than relying on the
      // debounced write. The launcher's restart/stop force-kills the process
      // on Windows, which skips the graceful-shutdown flush entirely, so a
      // save made just before a restart could otherwise be silently lost.
      flushNow();
      // The pool is switched on, off or resized by the same save; what was saved is on disk either way.
      applySolver(store.settings);
      // Lets a toggle/Client-ID edit take effect immediately (connect,
      // disconnect, or reconnect with a new ID) instead of requiring a
      // full server restart — see service.js's applySettings().
      discordRpc.applySettings(store.settings);
      // Never echo the settings object back here — every credential field
      // in SAVED_SETTINGS_FIELDS (proxyPassword, comicVineApiKey, suwayomi's own, plus whatever else is already stored) would round-trip in plaintext
      // on every single save, not just the one field this particular request
      // changed. Confirmed live: the frontend never reads this response body
      // (every POST /api/settings call here is fire-and-forget) — GET
      // /api/settings is the deliberate, one-time-per-settings-open read that
      // pre-fills the form instead.
      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message });
    }
  });
}

module.exports = { registerSettingsRoutes, SAVED_SETTINGS_FIELDS };
