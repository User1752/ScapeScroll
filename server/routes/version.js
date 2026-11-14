'use strict';

const { getAppVersion } = require('../modules/common/app-version');

// GET /api/version -> { ok, version }: the version of the app, for the corner of Settings. Behind the Access Password like the rest of /api,
// and nothing but the number (it is in the file name of the release anyway).
function registerVersionRoutes(app) {
  app.get('/api/version', (req, res) => {
    res.json({ ok: true, version: getAppVersion() });
  });
}

module.exports = { registerVersionRoutes };
