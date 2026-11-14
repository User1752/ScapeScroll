'use strict';

/**
 * routes/covers.js — the local copy of the library's covers (modules/covers/service.js)
 *
 *   GET  /api/library-covers          { ok, covers: { <image address>: "/api/library-cover/<file>" }, ...status }: what the page swaps in
 *   GET  /api/library-cover/<file>    one kept cover (only a name the index knows; anything else is a 404)
 *   POST /api/library-covers/sync     look at the library now (fetch what is missing, delete what no title needs) and say what was done
 */

const fs = require('fs');
const { pipeline } = require('stream/promises');
const limits = require('../config/limits');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { applyUntrustedContentHeaders } = require('../modules/http/untrusted-content');
const { createLibraryCoverService } = require('../modules/covers/service');

const asyncHandler = createAsyncHandler('COVERS');
let service = null;

function configure({ dir, readStore, fetchImage }) {
  service = createLibraryCoverService({ dir, readStore, fetchImage, limits });
  return service;
}

function needService() {
  if (service) return service;
  throw Object.assign(new Error('The local covers are not configured on this server.'), { statusCode: 503, expected: true });
}

function registerCoverRoutes(app) {
  app.get('/api/library-covers', asyncHandler(async (_req, res) => {
    const s = needService();
    res.json({ ok: true, covers: await s.getMap(), ...(await s.status()) });
  }));

  app.get('/api/library-cover/:file', asyncHandler(async (req, res) => {
    const found = await needService().getFile(req.params.file);
    if (!found) { res.status(404).json({ ok: false, error: 'No such cover.' }); return; }
    // A picture from the internet kept on disk: served with the untrusted-content headers like every relay, and as the type it was kept as.
    applyUntrustedContentHeaders(res);
    res.set('Content-Type', found.type);
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); // the name comes from the address: the same name is the same picture
    await pipeline(fs.createReadStream(found.path), res).catch((err) => {
      if (!res.destroyed) throw err; // the browser went away mid-file: nothing to answer
    });
  }));

  app.post('/api/library-covers/sync', asyncHandler(async (_req, res) => {
    const s = needService();
    s.reconcile(); // not awaited: a first look fetches the whole library and /api answers within 30 s; GET /api/library-covers shows how far it is
    res.json({ ok: true, started: true, ...(await s.status()) });
  }));
}

module.exports = { configure, registerCoverRoutes };
