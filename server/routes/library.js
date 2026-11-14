'use strict';

const { safeManga, isSafeUrl } = require('../helpers');
const { readStore, writeStore, flushNow } = require('../store');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { createLibraryService } = require('../modules/library/service');
const { createCoverCandidateService } = require('../modules/library/cover-candidate');
const { createProxyService } = require('../modules/proxy/service');
const { loadSourceFromFile } = require('../sourceLoader');
const { safetySnapshot } = require('../modules/store/auto-backup');
const { sanitizeRestoreJournal } = require('../modules/anilist/restore-journal');

const asyncHandler = createAsyncHandler('LIBRARY');

const libraryService = createLibraryService({
  readStore,
  writeStore,
  safeManga,
  isSafeUrl,
  loadSourceFromFile,
});

// Reused just for its AniList passthrough + image fetch/measure — not a
// second live instance of anything, same pattern routes/sources.js already
// uses to reuse this same factory for its own AniList author-fallback.
const { proxyAniList, fetchProxyImage } = createProxyService({ isSafeUrl });
const coverCandidateService = createCoverCandidateService({ readStore, proxyAniList, fetchProxyImage });

/**
 * @param {import('express').Router} router
 */
function registerLibraryRoutes(router) {
  router.get('/api/library', asyncHandler(async (_req, res) => {
    res.json(await libraryService.getLibrary());
  }));

  router.post('/api/library/sync-status', asyncHandler(async (_req, res) => {
    res.json(await libraryService.syncLibraryStatus());
  }));

  // "Refresh" button on a manga's details page — can legitimately take as
  // long as a normal chapters()/mangaDetails() call on a slow source, so
  // this gets the same extended timeout /api/source/:id/:method already
  // needs for the same reason (see routes/sources.js).
  router.post('/api/library/refresh-item', asyncHandler(async (req, res) => {
    req.setTimeout(50_000);
    res.setTimeout(50_000);
    res.json(await libraryService.refreshMangaItem(req.body || {}));
  }));

  router.get('/api/library/updates', asyncHandler(async (_req, res) => {
    const { items: manga } = await libraryService.getLibraryUpdates();
    // Anime favorites already carry hasUnseenUpdate/lastUpdateDetectedAt
    // (see routes/anime.js's refresh-item) - read directly rather than
    // standing up a whole second service module just to filter an array.
    const store = await readStore();
    const anime = (store.animeFavorites || [])
      .filter((f) => f.hasUnseenUpdate)
      .sort((a, b) => new Date(b.lastUpdateDetectedAt || 0) - new Date(a.lastUpdateDetectedAt || 0));
    res.json({ manga, anime });
  }));

  router.post('/api/library/updates/dismiss', asyncHandler(async (req, res) => {
    res.json(await libraryService.dismissMangaUpdate(req.body || {}));
  }));

  router.post('/api/library/add', asyncHandler(async (req, res) => {
    res.json(await libraryService.addToLibrary(req.body || {}));
  }));

  router.post('/api/library/remove', asyncHandler(async (req, res) => {
    res.json(await libraryService.removeFromLibrary(req.body || {}));
  }));

  router.post('/api/library/cover', asyncHandler(async (req, res) => {
    res.json(await libraryService.updateLibraryCover(req.body || {}));
  }));

  // Cover Scan (public/modules/ui-cover-scan.js) — one manga at a time,
  // read-only discovery only. The client drives a worker pool over the
  // whole library and streams results into a review table; nothing is
  // written here, applying a chosen cover reuses /api/library/cover above.
  router.post('/api/library/cover-candidate', asyncHandler(async (req, res) => {
    res.json(await coverCandidateService.getCoverCandidate(req.body || {}));
  }));

  router.post('/api/library/tags', asyncHandler(async (req, res) => {
    res.json(await libraryService.updateMangaTags(req.body || {}));
  }));

  // Manual NSFW toggle (right-click "Add to NSFW"/"Remove from NSFW" in the
  // library) — see content-service.js's setNsfwOverride and utils.js's
  // isNsfwManga() for where the flag actually gets consulted.
  router.post('/api/library/nsfw', asyncHandler(async (req, res) => {
    res.json(await libraryService.setNsfwOverride(req.body || {}));
  }));

  router.post('/api/history/add', asyncHandler(async (req, res) => {
    res.json(await libraryService.addHistoryEntry(req.body || {}));
  }));

  router.post('/api/history/remove', asyncHandler(async (req, res) => {
    res.json(await libraryService.removeHistoryEntry(req.body || {}));
  }));

  router.delete('/api/history/clear', asyncHandler(async (_req, res) => {
    res.json(await libraryService.clearHistory());
  }));

  router.post('/api/favorites/toggle', asyncHandler(async (req, res) => {
    res.json(await libraryService.toggleFavorite(req.body || {}));
  }));

  router.get('/api/user/status', asyncHandler(async (_req, res) => {
    res.json(await libraryService.getUserStatus());
  }));

  router.post('/api/user/status', asyncHandler(async (req, res) => {
    res.json(await libraryService.setUserStatus(req.body || {}));
  }));

  router.post('/api/anilist/import-apply', asyncHandler(async (req, res) => {
    await safetySnapshot('anilist-import'); // the library as it was, kept before AniList's is applied to it
    res.json(await libraryService.importAniListLibrary(req.body || {}));
  }));

  router.post('/api/anilist/resolve-apply', asyncHandler(async (req, res) => {
    await safetySnapshot('anilist-import');
    res.json(await libraryService.resolveAniListLibrary(req.body || {}));
  }));

  router.get('/api/anilist/sync-meta', asyncHandler(async (_req, res) => {
    res.json(await libraryService.getAniListSyncMeta());
  }));

  // The undo record of "Reset AniList statuses from ScrollScape": what each title had on AniList before the last reset.
  router.get('/api/anilist/restore-journal', asyncHandler(async (_req, res) => {
    const store = await readStore();
    res.json({ ok: true, journal: store.anilistRestoreUndo || null });
  }));

  router.put('/api/anilist/restore-journal', asyncHandler(async (req, res) => {
    const journal = sanitizeRestoreJournal(req.body && req.body.journal);
    if (!journal) {
      const err = new Error('The undo record has no valid change in it.');
      err.statusCode = 400;
      err.expected = true;
      throw err;
    }
    const store = await readStore();
    store.anilistRestoreUndo = journal;
    await writeStore(store);
    flushNow(); // a deliberate write that must be on disk before the AniList writes it protects begin
    res.json({ ok: true, journal });
  }));

  router.delete('/api/anilist/restore-journal', asyncHandler(async (_req, res) => {
    const store = await readStore();
    store.anilistRestoreUndo = null;
    await writeStore(store);
    res.json({ ok: true });
  }));

  router.post('/api/library/migrate', asyncHandler(async (req, res) => {
    await safetySnapshot('library-migrate');
    res.json(await libraryService.migrateLibrary(req.body || {}));
  }));

  router.delete('/api/library/clear', asyncHandler(async (_req, res) => {
    res.json(await libraryService.clearLibrary());
  }));
}

function startDailyLibrarySync() {
  // Sync immediately on startup, then every 24 hours
  setTimeout(() => {
    libraryService.syncLibraryStatus().catch(err => {
      console.warn('[LibrarySync] Background sync failed:', err.message);
    });
  }, 5000); // Wait 5 seconds after startup

  setInterval(() => {
    libraryService.syncLibraryStatus().catch(err => {
      console.warn('[LibrarySync] Background sync failed:', err.message);
    });
  }, 24 * 60 * 60 * 1000);
}

module.exports = { registerLibraryRoutes, startDailyLibrarySync };