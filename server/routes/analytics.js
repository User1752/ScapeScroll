'use strict';

const { readStore, writeStore } = require('../store');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { createAnalyticsService } = require('../modules/analytics/service');

const asyncHandler = createAsyncHandler('ANALYTICS');
const analyticsService = createAnalyticsService({ readStore, writeStore });

/**
 * @param {import('express').Router} router
 */
function registerAnalyticsRoutes(router) {
  router.get('/api/analytics', asyncHandler(async (_req, res) => {
    res.json(await analyticsService.getAnalytics());
  }));

  // The numbers of a period (week | month | year | all) for the Wrapped tab; ?year=2025&hideNsfw=1&excludeGenres=a,b&excludeTitles=key1,key2&top=10
  router.get('/api/analytics/wrapped', asyncHandler(async (req, res) => {
    res.json({ ok: true, wrapped: await analyticsService.getWrapped(req.query || {}) });
  }));

  router.post('/api/analytics/session', asyncHandler(async (req, res) => {
    res.json(await analyticsService.recordSession(req.body || {}));
  }));

  // Media-agnostic on purpose (unlike /session, which is manga-specific —
  // anime's own session route lives in routes/anime.js) — AFK time isn't
  // "reading" or "watching" activity, it's tab focus/visibility time, the
  // same concept regardless of which page happens to be open. See
  // public/modules/ui-activity-tracker.js for the client side.
  router.post('/api/analytics/afk', asyncHandler(async (req, res) => {
    res.json(await analyticsService.recordAfkTime(req.body || {}));
  }));
}

module.exports = { registerAnalyticsRoutes };