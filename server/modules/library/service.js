'use strict';

const { createLibraryContentService } = require('./content-service');
const { checkAnimePlanetHiatus } = require('./ap-hiatus');
const { checkMangaChapterCount, recordUpdateHistoryEntry } = require('./update-tracking');
const { normalizeTitle, titleSimilarity } = require('../common/title-similarity');

function createLibraryService({ readStore, writeStore, safeManga, isSafeUrl, loadSourceFromFile }) {
  const contentService = createLibraryContentService({ readStore, writeStore, safeManga, isSafeUrl });

  // These used to be a second, byte-identical copy of the same six helpers
  // content-service.js already had — now shared from there instead, so a
  // change to the composite-key format can't silently desync the two files.
  const {
    normSourceId,
    safeStatusKey,
    safeReviewKey,
    mergeReviewEntries,
    collectReadingStatusCandidates,
  } = contentService;

  async function getLibrary() {
    return contentService.getLibrary();
  }

  async function addToLibrary({ mangaId, sourceId, manga } = {}) {
    return contentService.addToLibrary({ mangaId, sourceId, manga });
  }

  async function removeFromLibrary({ mangaId, sourceId } = {}) {
    return contentService.removeFromLibrary({ mangaId, sourceId });
  }

  async function updateLibraryCover({ mangaId, sourceId, cover } = {}) {
    return contentService.updateLibraryCover({ mangaId, sourceId, cover });
  }

  async function updateMangaTags({ mangaId, sourceId, tags } = {}) {
    return contentService.updateMangaTags({ mangaId, sourceId, tags });
  }

  async function setNsfwOverride({ mangaId, sourceId, nsfw } = {}) {
    return contentService.setNsfwOverride({ mangaId, sourceId, nsfw });
  }

  async function addHistoryEntry({ mangaId, sourceId, manga, chapterId, chapterName } = {}) {
    return contentService.addHistoryEntry({ mangaId, sourceId, manga, chapterId, chapterName });
  }

  async function removeHistoryEntry({ mangaId, sourceId } = {}) {
    return contentService.removeHistoryEntry({ mangaId, sourceId });
  }

  async function clearHistory() {
    return contentService.clearHistory();
  }

  async function toggleFavorite({ mangaId, sourceId, manga } = {}) {
    return contentService.toggleFavorite({ mangaId, sourceId, manga });
  }

  async function getUserStatus() {
    return contentService.getUserStatus();
  }

  async function setUserStatus({ mangaId, sourceId, status, mangaData } = {}) {
    return contentService.setUserStatus({ mangaId, sourceId, status, mangaData });
  }

  async function importAniListLibrary({ entries, keepCover } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) {
      const err = new Error('entries array required');
      err.statusCode = 400;
      throw err;
    }

    const safeEntries = entries.slice(0, 2000);
    const ANILIST_STATUS_MAP = {
      CURRENT: 'reading',
      COMPLETED: 'completed',
      PAUSED: 'on_hold',
      DROPPED: 'dropped',
      PLANNING: 'plan_to_read',
      REPEATING: 'reading',
    };

    // A higher threshold than the manual "Find Dupes" scanner uses (0.8 vs
    // 0.6) since this merges automatically with no user confirming which
    // entry is "the same manga" \u2014 a false match here would silently
    // overwrite an unrelated favorite's data. titleSimilarity/normalizeTitle
    // now shared from server/modules/common/title-similarity.js \u2014 this used
    // to be a second, byte-identical copy of the same scoring.
    const FUZZY_MERGE_THRESHOLD = 0.8;

    const store = await readStore();
    let imported = 0;
    let overwritten = 0;
    let skipped = 0;
    let failed = 0;

    for (const entry of safeEntries) {
      try {
        const anilistId = Number(entry.anilistId);
        if (!anilistId || anilistId <= 0) { skipped++; continue; }

        const localStatus = ANILIST_STATUS_MAP[String(entry.status || '').toUpperCase()] || null;
        const mangaObj = safeManga({
          id: String(anilistId),
          title: String(entry.title || '').slice(0, 400),
          cover: String(entry.cover || '').slice(0, 2000),
        });

        const alId = String(anilistId);
        const nt = normalizeTitle(entry.title);

        // Tier 1: a real, source-backed favorite already explicitly linked to
        // this AniList id. Deliberately excludes a same-id anilist PLACEHOLDER
        // here (that used to be combined into this same check with `||`) —
        // once a prior import run leaves an unresolved placeholder behind, an
        // id match against that placeholder would otherwise win every single
        // time and permanently block the title-matching tiers below from ever
        // reaching the real favorite it should have merged into instead.
        let favIdx = store.favorites.findIndex(m => m.sourceId !== 'anilist' && m.anilistId === alId);

        if (favIdx < 0 && nt) {
          favIdx = store.favorites.findIndex(
            m => m.sourceId !== 'anilist' && normalizeTitle(m.title) === nt
          );
        }

        // Fuzzy fallback: catches a real duplicate the exact match above
        // misses because AniList's title differs slightly from what's
        // stored locally (different romanization, punctuation, a subtitle
        // AniList includes that the source scraper doesn't, etc.) — same
        // failure mode "Find Dupes" exists to catch manually, just applied
        // automatically here at a stricter threshold.
        if (favIdx < 0 && entry.title) {
          let bestScore = 0, bestIdx = -1;
          store.favorites.forEach((m, idx) => {
            if (m.sourceId === 'anilist') return;
            const score = titleSimilarity(entry.title, m.title);
            if (score > bestScore) { bestScore = score; bestIdx = idx; }
          });
          if (bestIdx >= 0 && bestScore >= FUZZY_MERGE_THRESHOLD) favIdx = bestIdx;
        }

        // Last resort: a placeholder this exact entry created on a previous
        // import run, before it was ever linked to a real source — update it
        // in place rather than pushing yet another duplicate below.
        if (favIdx < 0) {
          favIdx = store.favorites.findIndex(m => m.id === alId && m.sourceId === 'anilist');
        }

        // If this entry resolved to a real favorite above, retire any OTHER
        // leftover anilist placeholder for the same id from an earlier import
        // run — otherwise the real favorite and the stale placeholder both
        // keep showing up side by side in the library forever.
        if (favIdx >= 0 && store.favorites[favIdx].sourceId !== 'anilist') {
          const staleIdx = store.favorites.findIndex(
            (m, idx) => idx !== favIdx && m.id === alId && m.sourceId === 'anilist'
          );
          if (staleIdx >= 0) {
            store.favorites.splice(staleIdx, 1);
            delete store.readingStatus[`${alId}:anilist`];
            if (staleIdx < favIdx) favIdx--;
          }
        }

        const alreadyFav = favIdx >= 0;
        const existingFav = alreadyFav ? store.favorites[favIdx] : null;

        if (alreadyFav) {
          if (existingFav?.sourceId && existingFav.sourceId !== 'anilist') {
            store.favorites[favIdx] = {
              ...existingFav,
              title: existingFav.title || mangaObj.title,
              cover: keepCover ? (mangaObj.cover || existingFav.cover) : (existingFav.cover || mangaObj.cover),
              anilistId: alId,
              updatedAt: new Date().toISOString(),
            };
          } else {
            store.favorites[favIdx] = {
              ...existingFav,
              ...mangaObj,
              sourceId: 'anilist',
              anilistId: alId,
              updatedAt: new Date().toISOString(),
            };
          }
          overwritten++;
        } else {
          store.favorites.push({ ...mangaObj, sourceId: 'anilist', anilistId: alId, addedAt: new Date().toISOString() });
          imported++;
        }

        if (localStatus) {
          const alKey = `${anilistId}:anilist`;
          let targetKey = alKey;
          let targetManga = { ...mangaObj, sourceId: 'anilist' };

          const updatedFav = store.favorites[favIdx];
          if (updatedFav?.id && updatedFav?.sourceId && updatedFav.sourceId !== 'anilist') {
            targetKey = `${updatedFav.id}:${updatedFav.sourceId}`.replace(/[^a-z0-9:_-]/gi, '_');
            targetManga = safeManga({
              id: updatedFav.id,
              title: updatedFav.title || mangaObj.title,
              cover: updatedFav.cover || mangaObj.cover,
            });
            targetManga.sourceId = updatedFav.sourceId;
          }

          store.readingStatus[targetKey] = {
            status: localStatus,
            updatedAt: new Date().toISOString(),
            manga: targetManga,
          };

          if (targetKey !== alKey) delete store.readingStatus[alKey];
        }
      } catch (_) {
        failed++;
      }
    }

    store.anilistSync = {
      lastImportAt: new Date().toISOString(),
      importedCount: imported,
      overwriteCount: overwritten,
      skippedCount: skipped,
      failedCount: failed,
    };

    await writeStore(store);
    return {
      ok: true,
      imported,
      overwritten,
      skipped,
      failed,
      syncedAt: store.anilistSync.lastImportAt,
    };
  }

  async function resolveAniListLibrary({ resolutions, keepCover } = {}) {
    if (!Array.isArray(resolutions) || resolutions.length === 0) {
      return { ok: true, resolved: 0 };
    }

    const store = await readStore();
    let resolved = 0;

    for (const r of resolutions.slice(0, 2000)) {
      try {
        const anilistId = String(Number(r.anilistId) || 0);
        const mangaId = String(r.mangaId || '').slice(0, 400);
        const sourceId = String(r.sourceId || '').slice(0, 100);
        const title = String(r.title || '').slice(0, 400);
        const cover = String(r.cover || '').slice(0, 2000);

        if (!anilistId || anilistId === '0' || !mangaId || !sourceId || sourceId === 'anilist') continue;

        const mangaObj = safeManga({ id: mangaId, title, cover });

        const realFavIdx = store.favorites.findIndex(m => m.id === mangaId && m.sourceId === sourceId);
        const alFavIdx = store.favorites.findIndex(m => m.id === anilistId && m.sourceId === 'anilist');
        const alFav = alFavIdx >= 0 ? store.favorites[alFavIdx] : null;

        // "Keep AniList cover" prefers whatever cover the placeholder already
        // had (AniList's own artwork) over the newly-resolved source's cover.
        const resolvedCover = keepCover ? (alFav?.cover || mangaObj.cover) : mangaObj.cover;

        if (realFavIdx >= 0) {
          store.favorites[realFavIdx] = {
            ...store.favorites[realFavIdx],
            title: store.favorites[realFavIdx].title || mangaObj.title,
            cover: keepCover ? resolvedCover : (store.favorites[realFavIdx].cover || resolvedCover),
            sourceId,
            anilistId,
            updatedAt: new Date().toISOString(),
          };
        } else {
          store.favorites.push({
            ...mangaObj,
            cover: resolvedCover,
            sourceId,
            anilistId,
            addedAt: alFav?.addedAt || new Date().toISOString(),
          });
        }

        const alKey = `${anilistId}:anilist`;
        const realKey = `${mangaId}:${sourceId}`.replace(/[^a-z0-9:_-]/gi, '_');
        const alStatus = store.readingStatus[alKey];
        if (alStatus) {
          const existingSt = store.readingStatus[realKey];
          if (!existingSt || new Date(alStatus.updatedAt) >= new Date(existingSt.updatedAt || 0)) {
            store.readingStatus[realKey] = { ...alStatus, manga: { ...mangaObj, cover: resolvedCover, sourceId } };
          }
          delete store.readingStatus[alKey];
        }

        const freshAlIdx = store.favorites.findIndex(m => m.id === anilistId && m.sourceId === 'anilist');
        if (freshAlIdx >= 0) store.favorites.splice(freshAlIdx, 1);

        resolved++;
      } catch (_) {
        // Skip bad entry.
      }
    }

    await writeStore(store);
    return { ok: true, resolved };
  }

  async function getAniListSyncMeta() {
    const store = await readStore();
    return store.anilistSync || {};
  }

  async function migrateLibrary({ migrations, includeCategories = true, includeProgress = true, includeTracking = true, includeCover = true } = {}) {
    if (!Array.isArray(migrations) || migrations.length === 0) {
      const err = new Error('migrations array required');
      err.statusCode = 400;
      throw err;
    }

    const store = await readStore();
    let migrated = 0;
    let failed = 0;
    const migratedEntries = [];

    for (const m of migrations.slice(0, 500)) {
      try {
        const fromMangaId = String(m.fromMangaId || '').slice(0, 400);
        const fromSourceIdRaw = normSourceId(m.fromSourceId);
        const toMangaId = String(m.toMangaId || '').slice(0, 400);
        const toSourceId = String(m.toSourceId || '').slice(0, 100);
        const title = String(m.title || '').slice(0, 400);
        const cover = String(m.cover || '').slice(0, 2000);

        if (!fromMangaId || !toMangaId || !toSourceId) {
          console.warn('[MIGRATION][BACKEND] Skipped: missing ids', { fromMangaId, toMangaId, toSourceId });
          failed++;
          continue;
        }
        if (fromMangaId === toMangaId && fromSourceIdRaw === toSourceId) {
          console.warn('[MIGRATION][BACKEND] Skipped: same manga and source', { fromMangaId, toMangaId, fromSourceIdRaw, toSourceId });
          failed++;
          continue;
        }

        const mangaObj = { ...safeManga({ id: toMangaId, title, cover, sourceId: toSourceId }), sourceId: toSourceId };

        const oldFavIdx = store.favorites.findIndex(
          f => f.id === fromMangaId && normSourceId(f.sourceId) === fromSourceIdRaw
        );
        const oldFav = oldFavIdx >= 0 ? store.favorites[oldFavIdx] : null;
        const newFavIdx = store.favorites.findIndex(f => f.id === toMangaId && f.sourceId === toSourceId);

        if (includeTracking) {
          const carriedAnilistId = oldFav?.anilistId || (newFavIdx >= 0 ? store.favorites[newFavIdx]?.anilistId : null);
          if (carriedAnilistId) mangaObj.anilistId = String(carriedAnilistId);
        }

        if (newFavIdx >= 0) {
          store.favorites[newFavIdx] = { ...store.favorites[newFavIdx], ...mangaObj, updatedAt: new Date().toISOString() };
        } else {
          store.favorites.push({ ...mangaObj, addedAt: oldFav?.addedAt || new Date().toISOString() });
        }

        const newKey = safeStatusKey(toMangaId, toSourceId);
        if (includeProgress) {
          const statusCandidates = collectReadingStatusCandidates(store, fromMangaId, fromSourceIdRaw);
          if (statusCandidates.length > 0) {
            const picked = statusCandidates[0];
            store.readingStatus[newKey] = { ...picked.value, manga: mangaObj };
            if (picked.key !== newKey) delete store.readingStatus[picked.key];
          } else {
            console.warn('[MIGRATION][BACKEND] No reading status found for migration', {
              fromMangaId,
              fromSourceId: fromSourceIdRaw || 'unknown',
            });
          }
        } else {
          // Not carrying progress over — still drop the old entry so it
          // doesn't linger under a manga id no longer in favorites.
          for (const cand of collectReadingStatusCandidates(store, fromMangaId, fromSourceIdRaw)) {
            delete store.readingStatus[cand.key];
          }
        }

        const oldReviewRawKey = String(fromMangaId).slice(0, 200);
        const oldReviewSafeKey = safeReviewKey(fromMangaId);
        const newReviewKey = safeReviewKey(toMangaId);
        const reviewSourceKeys = [...new Set([oldReviewRawKey, oldReviewSafeKey])]
          .filter(k => k && Array.isArray(store.reviews?.[k]) && store.reviews[k].length > 0);

        if (newReviewKey && reviewSourceKeys.length > 0) {
          let incoming = [];
          for (const k of reviewSourceKeys) incoming = incoming.concat(store.reviews[k] || []);
          store.reviews[newReviewKey] = mergeReviewEntries(store.reviews[newReviewKey], incoming);

          for (const k of reviewSourceKeys) {
            if (k !== newReviewKey) delete store.reviews[k];
          }
        } else if (reviewSourceKeys.length === 0) {
          console.warn('[MIGRATION][BACKEND] No reviews to copy for manga:', fromMangaId);
        }

        // Carry over coverOverrides and mangaTags — both are sidecar dicts
        // keyed by the exact same "mangaId:sourceId" shape as readingStatus
        // (safeStatusKey), but migrateLibrary previously only ever moved
        // favorites/readingStatus/reviews/customLists, silently orphaning a
        // custom cover or any tags under the old key.
        const oldCompositeKey = safeStatusKey(fromMangaId, fromSourceIdRaw);
        if (oldCompositeKey !== newKey) {
          if (includeCover && store.coverOverrides?.[oldCompositeKey] && !store.coverOverrides[newKey]) {
            store.coverOverrides[newKey] = store.coverOverrides[oldCompositeKey];
          }
          if (store.coverOverrides) delete store.coverOverrides[oldCompositeKey];

          if (store.mangaTags?.[oldCompositeKey]?.length) {
            const merged = [...(store.mangaTags[newKey] || []), ...store.mangaTags[oldCompositeKey]];
            const seen = new Set();
            store.mangaTags[newKey] = merged.filter((tag) => {
              const lower = tag.toLowerCase();
              if (seen.has(lower)) return false;
              seen.add(lower);
              return true;
            });
            delete store.mangaTags[oldCompositeKey];
          }

          // Tri-state now (true/false/absent, see schema.js's nsfwOverrides
          // comment) — an explicit `false` is a real value to carry over,
          // not an empty one, so this has to check presence (!== undefined)
          // rather than truthiness like the coverOverrides copy above does.
          if (store.nsfwOverrides?.[oldCompositeKey] !== undefined && store.nsfwOverrides[newKey] === undefined) {
            store.nsfwOverrides[newKey] = store.nsfwOverrides[oldCompositeKey];
          }
          if (store.nsfwOverrides) delete store.nsfwOverrides[oldCompositeKey];
        }

        for (const list of (store.customLists || [])) {
          const idx = list.mangaItems.findIndex(
            i => i.id === fromMangaId && normSourceId(i.sourceId) === fromSourceIdRaw
          );
          if (idx < 0) continue;
          if (!includeCategories) {
            // Not carrying category membership over — just drop the old
            // entry rather than leaving it pointing at a manga id that's
            // no longer in favorites.
            list.mangaItems.splice(idx, 1);
            continue;
          }
          const alreadyIn = list.mangaItems.some(i => i.id === toMangaId && i.sourceId === toSourceId);
          if (!alreadyIn) {
            list.mangaItems[idx] = { ...mangaObj, addedAt: list.mangaItems[idx].addedAt || new Date().toISOString() };
          } else {
            list.mangaItems.splice(idx, 1);
          }
        }

        const freshOldIdx = store.favorites.findIndex(
          f => f.id === fromMangaId && normSourceId(f.sourceId) === fromSourceIdRaw
        );
        if (freshOldIdx >= 0) {
          store.favorites.splice(freshOldIdx, 1);
        }

        migrated++;
        migratedEntries.push({ fromMangaId, toMangaId });
      } catch (err) {
        failed++;
        console.error('[MIGRATION][BACKEND] Migration failed:', err);
      }
    }

    await writeStore(store);
    return { ok: true, migrated, failed, migrations: migratedEntries };
  }

  async function clearLibrary() {
    return contentService.clearLibrary();
  }

  async function syncLibraryStatus() {
    const store = await readStore();
    const favorites = store.favorites || [];
    if (favorites.length === 0) return { ok: true, updated: 0 };

    let updated = 0;

    for (const fav of favorites) {
      if (!fav.sourceId || !fav.id || fav.sourceId === 'unknown') continue;
      
      let sourceStatus = null;
      try {
        const src = loadSourceFromFile(fav.sourceId);
        if (src && src.mangaDetails) {
          // Add a tiny delay to prevent flooding sources like MangaDex
          await new Promise(r => setTimeout(r, 200));
          const details = await src.mangaDetails(fav.id);
          if (details && details.status) {
             sourceStatus = details.status.toLowerCase().trim();
          }
        }
      } catch (err) {
        console.warn(`[SyncStatus] Failed to fetch details for ${fav.title}:`, err.message);
      }

      let newStatus = sourceStatus || fav.status || 'ongoing';
      
      // If the source says it's ongoing or we don't know, check Anime-Planet to see if it's on Hiatus
      if (newStatus === 'ongoing' && fav.title) {
        // Add a delay to avoid AP rate limits
        await new Promise(r => setTimeout(r, 500));
        const isHiatus = await checkAnimePlanetHiatus(fav.title);
        if (isHiatus) {
          newStatus = 'hiatus';
        }
      }

      const statusMap = {
        'ongoing': 'ongoing', 'publishing': 'ongoing', 'releasing': 'ongoing', 'serializing': 'ongoing',
        'completed': 'completed', 'finished': 'completed', 'end': 'completed',
        'hiatus': 'hiatus', 'on hiatus': 'hiatus', 'on_hiatus': 'hiatus',
        'cancelled': 'cancelled', 'dropped': 'cancelled',
      };
      
      const normalizedStatus = statusMap[newStatus] || newStatus;

      if (fav.status !== normalizedStatus) {
        fav.status = normalizedStatus;
        fav.updatedAt = new Date().toISOString();
        updated++;
      }
    }

    if (updated > 0) {
      await writeStore(store);
    }
    return { ok: true, updated };
  }

  // "Refresh" button on a manga's details page — re-fetches that ONE
  // manga's chapters (+ status/genres/author from mangaDetails) in a single
  // action, rather than waiting for it to naturally happen next time the
  // user opens the reader. Also where new-chapter detection actually
  // happens (see update-tracking.js) - this is the only place
  // lastKnownChapterCount and hasUnseenUpdate get written.
  async function refreshMangaItem({ mangaId, sourceId } = {}) {
    if (!mangaId || !sourceId) {
      const err = new Error('mangaId and sourceId are required');
      err.statusCode = 400;
      throw err;
    }

    const store = await readStore();
    const matchesTarget = (m) => String(m.id) === String(mangaId) && String(m.sourceId || '') === String(sourceId || '');
    if (!(store.favorites || []).some(matchesTarget)) {
      const err = new Error('Manga not found in library');
      err.statusCode = 404;
      throw err;
    }

    const mod = loadSourceFromFile(sourceId);
    // A source being rate-limited/temporarily down (confirmed live: AllManga's
    // own cooldown throws "Rate limited, retry later" for every call while
    // it's active) is an expected, transient condition here, not a server
    // error — this is called in bulk across the whole library (see
    // ui-updates.js's auto-refresh sweep on app open), where hitting a
    // rate-limited source is routine, not exceptional. Softens it into a
    // normal ok:false result instead of an uncaught 500, and simply leaves
    // this item's tracking untouched (it'll get picked up again on the next
    // sweep/manual refresh) rather than failing the whole request.
    let chaptersResult;
    try {
      chaptersResult = await mod.chapters(mangaId);
    } catch (err) {
      return { ok: false, temporarilyUnavailable: true, error: err.message };
    }
    const details = typeof mod.mangaDetails === 'function'
      ? await mod.mangaDetails(mangaId).catch(() => null)
      : null;

    const currentCount = Array.isArray(chaptersResult?.chapters) ? chaptersResult.chapters.length : 0;
    // Re-resolved by identity here, not the index captured before the two
    // awaits above — store.favorites is a shared in-memory array (readStore()
    // returns the same singleton on every call, no per-request snapshot),
    // and removeFromLibrary/migrateLibrary both splice it. A stale index
    // reused after network I/O this slow can silently point at a different
    // manga by the time this line runs, overwriting the wrong favorite's
    // chapter count/status/genres/author with data that was fetched for a
    // completely different title.
    const fav = (store.favorites || []).find(matchesTarget);
    if (!fav) {
      const err = new Error('Manga was removed from the library while refreshing');
      err.statusCode = 404;
      throw err;
    }
    const { isUpdate, newChapters, lastKnownChapterCount } = checkMangaChapterCount(fav, currentCount);

    fav.lastKnownChapterCount = lastKnownChapterCount;
    if (isUpdate) {
      fav.hasUnseenUpdate = true;
      fav.lastUpdateDetectedAt = new Date().toISOString();
      // Feeds predictNextCheckWindow (update-tracking.js) — logged once per
      // detected update (not once per new chapter, so a 3-chapter batch
      // drop only counts as one release event, matching how a reader would
      // describe "this title updates roughly every N days").
      fav.updateHistory = recordUpdateHistoryEntry(fav, fav.lastUpdateDetectedAt);
    }
    if (details?.status) fav.status = details.status;
    if (details?.genres?.length) fav.genres = details.genres;
    if (details?.author) fav.author = details.author;
    fav.updatedAt = new Date().toISOString();

    await writeStore(store);
    return {
      ok: true,
      chapterCount: currentCount,
      isUpdate,
      newChapters,
      favorite: fav,
    };
  }

  // Manga side of the Updates feed — anime's own favorites (with their
  // existing totalEpisodes/hasUnseenUpdate fields) are read directly by
  // routes/anime.js, so this only needs to cover store.favorites.
  async function getLibraryUpdates() {
    const store = await readStore();
    const items = (store.favorites || []).filter((f) => f.hasUnseenUpdate);
    items.sort((a, b) => new Date(b.lastUpdateDetectedAt || 0) - new Date(a.lastUpdateDetectedAt || 0));
    return { items };
  }

  async function dismissMangaUpdate({ mangaId, sourceId } = {}) {
    if (!mangaId || !sourceId) {
      const err = new Error('mangaId and sourceId are required');
      err.statusCode = 400;
      throw err;
    }
    const store = await readStore();
    const fav = (store.favorites || []).find(
      (m) => String(m.id) === String(mangaId) && String(m.sourceId || '') === String(sourceId || '')
    );
    if (fav) {
      fav.hasUnseenUpdate = false;
      await writeStore(store);
    }
    return { ok: true };
  }

  return {
    getLibrary,
    addToLibrary,
    removeFromLibrary,
    updateLibraryCover,
    updateMangaTags,
    setNsfwOverride,
    addHistoryEntry,
    removeHistoryEntry,
    clearHistory,
    toggleFavorite,
    getUserStatus,
    setUserStatus,
    importAniListLibrary,
    resolveAniListLibrary,
    getAniListSyncMeta,
    migrateLibrary,
    clearLibrary,
    syncLibraryStatus,
    refreshMangaItem,
    getLibraryUpdates,
    dismissMangaUpdate,
  };
}

module.exports = { createLibraryService };