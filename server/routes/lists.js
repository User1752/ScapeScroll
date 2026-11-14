'use strict';

const { safeManga } = require('../helpers');
const { readStore, writeStore } = require('../store');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { createListService } = require('../modules/lists/service');

const asyncHandler = createAsyncHandler('LISTS');

const listService = createListService({
  readStore,
  writeStore,
  safeManga,
});

/**
 * @param {import('express').Router} router
 */
function registerListRoutes(router) {
  router.get('/api/lists', asyncHandler(async (_req, res) => {
    res.json(await listService.getLists());
  }));

  router.post('/api/lists', asyncHandler(async (req, res) => {
    res.json(await listService.createList(req.body || {}));
  }));

  router.put('/api/lists/:id', asyncHandler(async (req, res) => {
    const listId = String(req.params.id || '').slice(0, 100);
    // Express matches this wildcard before the more specific routes below
    // even get a chance — 'manga-categories'/'anime-categories' have to be
    // special-cased right here rather than as their own router.put(), or
    // they 404 out of updateList() trying (and failing) to find a real
    // list with that literal id. Confirmed live: that's exactly what
    // happened before this anime-categories check was added here.
    if (listId === 'manga-categories') {
      res.json(await listService.setMangaCategories(req.body || {}));
      return;
    }
    if (listId === 'anime-categories') {
      res.json(await listService.setAnimeCategories(req.body || {}));
      return;
    }

    res.json(await listService.updateList(listId, req.body || {}));
  }));

  router.delete('/api/lists/:id', asyncHandler(async (req, res) => {
    res.json(await listService.deleteList(req.params.id));
  }));

  router.post('/api/lists/:id/manga', asyncHandler(async (req, res) => {
    res.json(await listService.addMangaToList(req.params.id, req.body || {}));
  }));

  router.delete('/api/lists/:id/manga/:mangaId', asyncHandler(async (req, res) => {
    res.json(await listService.removeMangaFromList(req.params.id, req.params.mangaId));
  }));

  router.get('/api/lists/manga/:mangaId/categories', asyncHandler(async (req, res) => {
    res.json(await listService.getMangaCategories(req.params.mangaId, req.query.sourceId));
  }));

  router.get('/api/lists/anime/:idMal/categories', asyncHandler(async (req, res) => {
    res.json(await listService.getAnimeCategories(req.params.idMal));
  }));
}

module.exports = { registerListRoutes };