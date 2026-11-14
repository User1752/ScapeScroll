'use strict';

/**
 * routes/progress.js — the reading progress kept on the server (modules/progress/service.js)
 *
 *   GET  /api/progress          the whole progress: { rev, initialized, read:[keys], flagged:[keys], last, highest, pages, totals }
 *   POST /api/progress/ops      changes to apply ({ readAdd, readRemove, ..., reset?, init? }); idempotent, so a retry is safe
 *   GET  /api/progress/status   counts only (what Settings shows)
 *   POST /api/progress/safety-copy   keeps a copy of the progress file before it is lowered from AniList's numbers
 */

const { createAsyncHandler } = require('../modules/http/async-handler');
const { safetySnapshot } = require('../modules/store/auto-backup');
const { createProgressService } = require('../modules/progress/service');

const asyncHandler = createAsyncHandler('PROGRESS');
let service = null;

function configure({ filePath }) {
  service = createProgressService({ filePath, flushOnExit: true });
  return service;
}

const getService = () => service;

function needService() {
  if (service) return service;
  throw Object.assign(new Error('The reading progress is not configured on this server.'), { statusCode: 503, expected: true });
}

function registerProgressRoutes(app) {
  app.get('/api/progress', asyncHandler(async (_req, res) => {
    res.json({ ok: true, ...needService().get() });
  }));

  app.post('/api/progress/ops', asyncHandler(async (req, res) => {
    res.json({ ok: true, ...needService().applyOps(req.body && req.body.ops) });
  }));

  app.get('/api/progress/status', asyncHandler(async (_req, res) => {
    res.json({ ok: true, ...needService().status() });
  }));

  // A copy of the progress (and of the store) as it is now, kept before the person lowers it from AniList's numbers. `recent` means a
  // copy with this label was made minutes ago, which is as good. The client writes nothing unless this says the copy exists.
  app.post('/api/progress/safety-copy', asyncHandler(async (_req, res) => {
    needService().flushSync();
    const r = await safetySnapshot('anilist-progress');
    res.json({ ok: !!(r && (r.ok || r.skipped === 'recent')), skipped: r && r.skipped ? r.skipped : undefined });
  }));
}

module.exports = { configure, getService, registerProgressRoutes };
