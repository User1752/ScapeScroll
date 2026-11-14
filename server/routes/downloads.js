'use strict';

const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { safeId, resolvePageUrl, fetchImageBuffer, safeName } = require('../helpers');
const { loadSourceFromFile } = require('../sourceLoader');
const { readStore, writeStore } = require('../store');
const { createDownloadService } = require('../modules/downloads/service');
const { streamJobProgress } = require('../modules/http/job-progress-sse');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { apiTimeout } = require('../middleware/security');

const asyncHandler = createAsyncHandler('DOWNLOADS');
// See routes/local.js's identical longRunningTimeout for why: fetching N page
// images per request can legitimately exceed the global 30s /api apiTimeout,
// same as offline-save's save-chapter/save-bulk endpoints.
const longRunningTimeout = apiTimeout(5 * 60 * 1000);

const downloadService = createDownloadService({
  loadSourceFromFile,
  safeId,
  safeName,
  resolvePageUrl,
  fetchImageBuffer,
  AdmZip,
  crypto,
  readStore,
  writeStore,
});

function sendCbzResponse(res, filename, buffer) {
  res.setHeader('Content-Type', 'application/vnd.comicbook+zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}

/**
 * @param {import('express').Router} router
 */
function registerDownloadRoutes(router) {
  router.post('/api/download/chapter', longRunningTimeout, asyncHandler(async (req, res) => {
    const result = await downloadService.downloadChapter(req.body || {});
    sendCbzResponse(res, result.filename, result.buffer);
  }));

  router.post('/api/download/bulk/start', longRunningTimeout, asyncHandler(async (req, res) => {
    res.json(await downloadService.startBulkDownload(req.body || {}));
  }));

  router.get('/api/download/bulk/jobs', (_req, res) => {
    res.json({ jobs: downloadService.listBulkJobs() });
  });

  // Persisted completion log — survives past JOB_TTL and server restarts,
  // unlike /api/download/bulk/jobs above (see listDownloadHistory).
  router.get('/api/download/history', asyncHandler(async (_req, res) => {
    res.json({ history: await downloadService.listDownloadHistory() });
  }));

  router.get('/api/download/bulk/progress/:jobId', (req, res) => {
    const job = downloadService.getBulkJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    streamJobProgress({
      req,
      res,
      job,
      addListener: (write) => downloadService.addBulkListener(req.params.jobId, write),
      removeListener: (write) => downloadService.removeBulkListener(req.params.jobId, write),
      doneData: () => ({ jobId: req.params.jobId }),
      errorData: (currentJob) => ({ error: currentJob.error }),
    });
  });

  router.get('/api/download/bulk/file/:jobId', (req, res) => {
    const job = downloadService.getBulkJob(req.params.jobId);
    if (!job || job.status !== 'done' || !job.cbzBuffer) {
      return res.status(404).json({ error: 'File not ready' });
    }

    sendCbzResponse(res, job.filename, job.cbzBuffer);

    setTimeout(() => downloadService.deleteBulkJob(req.params.jobId), 10_000);
  });
}

module.exports = { registerDownloadRoutes };