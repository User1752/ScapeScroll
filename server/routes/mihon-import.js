/**
 * routes/mihon-import.js — Import AND export Tachiyomi/Mihon/Komikku library
 * backups (.tachibk). Komikku is a Tachiyomi fork and hasn't diverged its
 * backup schema, so the same protobuf definition (backup.proto) reads and
 * writes its backups too — no separate handling needed.
 *
 * See server/modules/mihon-import/service.js for the mapping rules in both
 * directions and their honest scope limits (source-id resolution is
 * best-effort by name match in both directions — there's no shared registry
 * between ScrollScape's own source ids and Mihon/Komikku's numeric extension
 * ids on either end).
 */

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const { readStore, writeStore } = require('../store');
const { safeManga, sha1Short } = require('../helpers');
const { createMihonImportService } = require('../modules/mihon-import/service');
const { createAsyncHandler } = require('../modules/http/async-handler');

const mihonImportService = createMihonImportService({ readStore, writeStore, safeManga, sha1Short });

let upload = null;

/** @param {{ upload: import('multer').Multer }} opts */
function configure(opts) {
  upload = opts.upload;
}

const asyncHandler = createAsyncHandler('MIHON-IMPORT');

/** @param {import('express').Router} router */
function registerMihonImportRoutes(router) {
  router.post('/api/import/mihon', upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) {
      const err = new Error('No file uploaded');
      err.statusCode = 400;
      throw err;
    }

    let result;
    try {
      const buffer = await fsp.readFile(req.file.path);
      result = await mihonImportService.importMihonBackup(buffer);
    } catch (err) {
      err.statusCode = err.statusCode || 400;
      err.message = `Could not read this file as a Tachiyomi/Mihon backup: ${err.message}`;
      throw err;
    } finally {
      if (req.file?.path) fsp.unlink(req.file.path).catch(() => {});
    }

    res.json(result);
  }));

  // ── POST /api/export/mihon ───────────────────────────────────────────────
  // Body: { readChapters?: string[] } — the requesting browser's own
  // localStorage read-chapter keys (see service.js's exportMihonBackup doc
  // comment for why that can't come from server-side store.json instead).
  router.post('/api/export/mihon', asyncHandler(async (req, res) => {
    const { readChapters } = req.body || {};
    const gz = await mihonImportService.exportMihonBackup({ readChapters });
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="scrollscape-library.tachibk"');
    res.send(gz);
  }));
}

module.exports = { configure, registerMihonImportRoutes };
