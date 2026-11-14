'use strict';

/**
 * routes/anime.js — M1 streaming slice (search+stream, no persistence) plus
 * M2's persistence layer: favoriting a show and saving watch progress
 * against server/modules/store/schema.js's `animeFavorites` collection.
 * See server/modules/anime/zokoanime.js for how the stream URL is resolved.
 */

const fs = require('fs');
const fsp = fs.promises;
const { getAnimeRegistry } = require('../modules/anime-sources');
const { createAnikkuExportService } = require('../modules/anime/anikku-export');
const { createAnalyticsService } = require('../modules/analytics/service');
const { createAsyncHandler } = require('../modules/http/async-handler');
const { sendRelayedResource } = require('../modules/http/untrusted-content');
const { readStore, writeStore, flushNow } = require('../store');
const limits = require('../config/limits');

const asyncHandler = createAsyncHandler('ANIME');
const anikkuExportService = createAnikkuExportService({ readStore, writeStore });
const analyticsService = createAnalyticsService({ readStore, writeStore });

// idMal is used directly as an object key into the animeTags/animeCoverOverrides/
// animeWatchStatus sidecar dicts (unlike manga's composite "mangaId:sourceId" keys,
// which can never literally equal "__proto__"). Reject the handful of property
// names that would otherwise reach into the prototype chain instead of setting an
// own property.
const UNSAFE_ID_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
function isSafeAnimeId(idMal) {
  return !UNSAFE_ID_KEYS.has(String(idMal));
}

let upload = null;
/** @param {{ upload: import('multer').Multer }} opts */
function configure(opts) {
  upload = opts.upload;
}

function registerAnimeRoutes(app) {
  // ── Export (M4) — Anikku-format .tachibk, see anikku-export.js's header
  // comment for the format's own scope limits.
  app.get('/api/anime/export/anikku', asyncHandler(async (req, res) => {
    const gz = await anikkuExportService.exportAnikkuBackup();
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', 'attachment; filename="scrollscape-anime-library.tachibk"');
    res.send(gz);
  }));

  // ── Import (My Anime panel's "Import Local") — Anikku's own .tachibk
  // schema only, not Aniyomi's differently-numbered combined manga+anime
  // one. See anikku-export.js's importAnikkuBackup for the resolution and
  // merge rules.
  app.post('/api/anime/import/anikku', upload.single('file'), asyncHandler(async (req, res) => {
    if (!req.file) {
      const err = new Error('No file uploaded');
      err.statusCode = 400;
      throw err;
    }
    let result;
    try {
      const buffer = await fsp.readFile(req.file.path);
      result = await anikkuExportService.importAnikkuBackup(buffer);
    } catch (err) {
      err.statusCode = err.statusCode || 400;
      err.message = `Could not read this file as an Anikku backup: ${err.message}`;
      throw err;
    } finally {
      if (req.file?.path) fsp.unlink(req.file.path).catch(() => {});
    }
    flushNow();
    res.json(result);
  }));

  // The anime sources there are, in the order they are offered (server/modules/anime-sources/): what the player and Settings > Anime
  // Sources list. Only ids, names and what each understands; nothing about where a source gets its video.
  app.get('/api/anime/providers', asyncHandler(async (req, res) => {
    res.json({ ok: true, providers: getAnimeRegistry().list() });
  }));

  // `provider` picks the source (the registry knows them: see anime-sources/bundled.js for the five that ship with the app); no
  // provider is zokoanime, as it always was. A source is found by the MAL id or by the title, whichever its meta.keyedBy says.
  app.post('/api/anime/stream', asyncHandler(async (req, res) => {
    // The blanket 30s /api apiTimeout (server.js) is well short of what a provider that needs the hidden browser takes — miruro makes
    // two sequential FlareSolverr solves (episodes, then sources), each up to ~35-40s on a cold challenge (see executeFlareSolverr's
    // own maxTimeout) — same override pattern as routes/sources.js's per-source dispatch route uses for the same underlying reason.
    req.setTimeout(100_000);
    res.setTimeout(100_000);
    const { malId, episode, dub, provider, title, quality, format } = req.body || {};
    const result = await getAnimeRegistry().resolveStream(typeof provider === 'string' && provider ? provider : 'zokoanime', { malId, title, episode, dub, quality, format });
    res.json({ ok: true, ...result });
  }));

  // Same-origin relay for a source's playlists, segments and subtitles: the host's CORS policy (and often a Referer it wants) keeps
  // the browser from reading them directly. The source relays its own video, or declares the hosts its video lives on and the app
  // relays only those (anime-sources/relay.js).
  const relayHls = asyncHandler(async (req, res) => {
    const { url, ref } = req.query;
    if (!url || typeof url !== 'string') {
      const err = new Error('url is required');
      err.statusCode = 400;
      throw err;
    }
    const providerId = req.params.provider || 'zokoanime';
    const { contentType, body } = await getAnimeRegistry().relay(providerId, url, typeof ref === 'string' ? ref : undefined);
    sendRelayedResource(res, contentType, body);
  });
  app.get('/api/anime/hls-proxy', relayHls); // zokoanime's, the first provider: its address is kept
  app.get('/api/anime/:provider/hls-proxy', relayHls);

  // ── Skip-intro timestamps (AniSkip) ───────────────────────────────────────
  // Real per-episode opening timestamps, community-sourced and keyed by
  // MAL id + episode number — deliberately not a guessed fixed-length skip
  // (openings vary between shows, sometimes within the same show), and not
  // every episode has submitted data, in which case AniSkip itself reports
  // that (`found: false`) rather than this app guessing on its behalf.
  // episodeLength (video.duration, seconds) is optional but helps AniSkip
  // disambiguate between multiple submissions when a show has re-encodes
  // of differing length floating around.
  app.get('/api/anime/skip-times', asyncHandler(async (req, res) => {
    const { idMal, episode, episodeLength } = req.query || {};
    const mal = parseInt(idMal, 10);
    const ep = parseInt(episode, 10);
    if (!Number.isFinite(mal) || mal <= 0 || !Number.isFinite(ep) || ep <= 0) {
      const err = new Error('idMal and episode are required');
      err.statusCode = 400;
      throw err;
    }

    const params = new URLSearchParams();
    params.append('types', 'op');
    const len = parseFloat(episodeLength);
    if (Number.isFinite(len) && len > 0) params.append('episodeLength', String(Math.round(len)));

    try {
      const upstream = await fetch(`https://api.aniskip.com/v2/skip-times/${mal}/${ep}?${params.toString()}`, {
        signal: AbortSignal.timeout(limits.fetchTimeoutMs),
      });
      const data = await upstream.json();
      if (!data?.found) {
        res.json({ ok: true, found: false });
        return;
      }
      const op = (data.results || []).find(r => r.skipType === 'op');
      if (!op?.interval) {
        res.json({ ok: true, found: false });
        return;
      }
      res.json({ ok: true, found: true, start: op.interval.startTime, end: op.interval.endTime });
    } catch (_) {
      // AniSkip being unreachable/slow is a "no button shown" case, not a
      // hard failure of the watch page — same graceful-degradation as any
      // other optional-enhancement external call in this app.
      res.json({ ok: true, found: false });
    }
  }));

  // ── Cover choices (MyAnimeList Pictures, via Jikan) ─────────────────────
  // Replaces an earlier Google/Brave Images-scraping fallback in the cover
  // picker (ui-anime-test.js's openAnimeCoverPicker) — that scraped search-
  // engine result-page HTML with regexes, which broke unpredictably as
  // Google/Brave changed markup or served bot-detection pages instead of
  // real results. Jikan is MyAnimeList's actual public REST API (no key
  // needed), so this returns real, stable results instead — a very natural
  // fit here since idMal (MAL's own id) is already this app's primary
  // anime identifier throughout. One retry on a 429 since Jikan's rate
  // limit (~3 req/s) is easy to brush against from a single user click if
  // another request just went out; still a real error after that, not a
  // silent empty result — see the client-side history of that exact bug.
  app.get('/api/anime/cover-choices/:idMal', asyncHandler(async (req, res) => {
    const idMal = parseInt(req.params.idMal, 10);
    if (!Number.isFinite(idMal) || idMal <= 0) {
      const err = new Error('idMal is required');
      err.statusCode = 400;
      throw err;
    }

    const fetchOnce = () => fetch(`https://api.jikan.moe/v4/anime/${idMal}/pictures`, {
      signal: AbortSignal.timeout(limits.fetchTimeoutMs),
    });

    let upstream = await fetchOnce();
    if (upstream.status === 429) {
      await new Promise(r => setTimeout(r, 1200));
      upstream = await fetchOnce();
    }
    if (!upstream.ok) {
      const err = new Error(`MyAnimeList request failed (HTTP ${upstream.status})`);
      err.statusCode = 502;
      throw err;
    }

    const data = await upstream.json();
    const items = (data?.data || [])
      .map((pic, idx) => ({
        id: `mal-${idMal}-${idx}`,
        cover: pic?.jpg?.large_image_url || pic?.jpg?.image_url || pic?.webp?.large_image_url || pic?.webp?.image_url || '',
        provider: 'MyAnimeList',
        sourceId: 'myanimelist',
      }))
      .filter(item => item.cover);

    res.json({ ok: true, items });
  }));

  // ── Favorites (M2) ─────────────────────────────────────────────────────

  app.get('/api/anime/favorites', asyncHandler(async (req, res) => {
    const store = await readStore();
    const overrides = store.animeCoverOverrides || {};
    const tags = store.animeTags || {};
    const watchStatus = store.animeWatchStatus || {};
    const favorites = store.animeFavorites.map(f => ({
      ...f,
      ...(overrides[f.idMal] ? { cover: overrides[f.idMal] } : null),
      tags: tags[f.idMal] || [],
      watchStatus: watchStatus[f.idMal] || null,
    }));
    res.json({ ok: true, favorites });
  }));

  // ── Cover override (M4 polish) — same sidecar-dict pattern as the manga
  // side's coverOverrides, applied on read above rather than mutating the
  // favorite's own `cover` field, so the original AniList cover isn't lost
  // if the override is ever cleared.
  app.post('/api/anime/cover-override', asyncHandler(async (req, res) => {
    const { idMal, coverUrl } = req.body || {};
    if (!idMal || !isSafeAnimeId(idMal)) {
      const err = new Error('idMal is required');
      err.statusCode = 400;
      throw err;
    }
    const store = await readStore();
    const id = String(idMal);
    if (coverUrl && String(coverUrl).trim()) {
      store.animeCoverOverrides[id] = String(coverUrl).trim().slice(0, 2000);
    } else {
      delete store.animeCoverOverrides[id];
    }
    await writeStore(store);
    flushNow();
    res.json({ ok: true });
  }));

  // ── Tags — same sidecar pattern as manga's mangaTags (server/modules/
  // library/content-service.js's updateMangaTags), keyed by idMal alone
  // instead of "mangaId:sourceId" since an anime favorite has no sourceId
  // of its own to key on.
  app.post('/api/anime/tags', asyncHandler(async (req, res) => {
    const { idMal, tags } = req.body || {};
    if (!idMal || !isSafeAnimeId(idMal)) {
      const err = new Error('idMal is required');
      err.statusCode = 400;
      throw err;
    }
    const store = await readStore();
    const id = String(idMal);
    const seen = new Set();
    const clean = [];
    for (const raw of (Array.isArray(tags) ? tags : [])) {
      const t = String(raw ?? '').trim().slice(0, 60);
      const lower = t.toLowerCase();
      if (!t || seen.has(lower)) continue;
      seen.add(lower);
      clean.push(t);
      if (clean.length >= 30) break;
    }
    if (clean.length) store.animeTags[id] = clean;
    else delete store.animeTags[id];
    await writeStore(store);
    res.json({ ok: true, tags: clean });
  }));

  // ── Explicit watch status — same sidecar pattern as manga's
  // readingStatus (server/modules/library/content-service.js's
  // setUserStatus): a pure user-set flag, never derived from or
  // overwritten by lastWatchedEpisode/totalEpisodes. _animeComputeStatus()
  // (ui-anime-test.js) checks this first, falling back to its own
  // episode-derived guess only when nothing's been explicitly set.
  const ANIME_WATCH_STATUSES = new Set(['watching', 'completed', 'on_hold', 'plan_to_watch', 'dropped']);
  app.post('/api/anime/status', asyncHandler(async (req, res) => {
    const { idMal, status } = req.body || {};
    if (!idMal || !isSafeAnimeId(idMal)) {
      const err = new Error('idMal is required');
      err.statusCode = 400;
      throw err;
    }
    const store = await readStore();
    const id = String(idMal);
    if (!status || status === 'none') {
      delete store.animeWatchStatus[id];
    } else {
      if (!ANIME_WATCH_STATUSES.has(status)) {
        const err = new Error('Invalid status');
        err.statusCode = 400;
        throw err;
      }
      store.animeWatchStatus[id] = status;
    }
    await writeStore(store);
    res.json({ ok: true, watchStatus: store.animeWatchStatus[id] || null });
  }));

  // Silently catches up lastWatchedEpisode when AniList's own remote
  // progress is ahead of what ScrollScape has recorded locally (see
  // anilistReconcileAnimeProgress in anilist.js — "whichever side has more
  // progress wins", the same rule manga's own AniList sync already
  // follows). Deliberately NOT /api/anime/progress: that route also logs a
  // History entry and feeds watch-time analytics, which is correct for an
  // episode someone just actually watched, but wrong here — this is
  // catching up a number, not recording a viewing session that never
  // happened in this app. lastPositionSeconds resets to 0 since there's no
  // meaningful mid-episode position to infer from a bare episode count.
  app.post('/api/anime/progress-sync', asyncHandler(async (req, res) => {
    const { idMal, episode } = req.body || {};
    const target = Number(episode);
    if (!idMal || !isSafeAnimeId(idMal) || !Number.isFinite(target) || target <= 0) {
      const err = new Error('idMal and a positive episode are required');
      err.statusCode = 400;
      throw err;
    }
    const store = await readStore();
    const fav = store.animeFavorites.find(f => f.idMal === String(idMal));
    if (!fav) return res.json({ ok: true, updated: false });

    if (target > (Number(fav.lastWatchedEpisode) || 0)) {
      fav.lastWatchedEpisode = target;
      fav.lastPositionSeconds = 0;
      fav.updatedAt = new Date().toISOString();
      await writeStore(store);
      return res.json({ ok: true, updated: true, lastWatchedEpisode: fav.lastWatchedEpisode });
    }
    res.json({ ok: true, updated: false, lastWatchedEpisode: fav.lastWatchedEpisode });
  }));

  // Backfills `format` onto an already-favorited show — see the field's own
  // comment on the favorite object above for why this exists separately
  // from favorites/toggle: a favorite added before this field existed has
  // no way to get it except a later visit to its details page, which is
  // exactly where this gets called from (_animeTestLoadExtendedDetails).
  app.post('/api/anime/format', asyncHandler(async (req, res) => {
    const { idMal, format } = req.body || {};
    if (!idMal || !isSafeAnimeId(idMal) || typeof format !== 'string' || !format) {
      const err = new Error('idMal and format are required');
      err.statusCode = 400;
      throw err;
    }
    const store = await readStore();
    const fav = store.animeFavorites.find(f => f.idMal === String(idMal));
    if (!fav) return res.json({ ok: true, updated: false });
    if (fav.format !== format) {
      fav.format = format;
      await writeStore(store);
    }
    res.json({ ok: true, updated: true });
  }));

  app.post('/api/anime/favorites/toggle', asyncHandler(async (req, res) => {
    const { idMal, anilistId, title, cover, totalEpisodes, genres, format } = req.body || {};
    // isSafeAnimeId is already required on every route that looks an idMal
    // up in the tags/status/cover-override dicts below — but this is the
    // one route that actually CREATES a favorite's idMal in the first
    // place. Without this check here too, an idMal of "__proto__" could be
    // favorited and then poison every one of those idMal-keyed plain-object
    // dicts (store.animeTags['__proto__'], etc. resolve onto Object.prototype
    // instead of a real own property) the moment anything reads it back.
    if (!idMal || !title || !isSafeAnimeId(idMal)) {
      const err = new Error('idMal and title are required');
      err.statusCode = 400;
      throw err;
    }
    const store = await readStore();
    const id = String(idMal);
    const idx = store.animeFavorites.findIndex(f => f.idMal === id);

    let inLibrary;
    if (idx >= 0) {
      store.animeFavorites.splice(idx, 1);
      inLibrary = false;
    } else {
      store.animeFavorites.push({
        idMal: id,
        // Captured at favorite-time (not re-fetched later) so the homepage's
        // "Recommended For You" section can score genre overlap without an
        // extra AniList call per load — see ui-anime-discover.js. Optional:
        // favorites added before this field existed just don't contribute
        // to that scoring, same graceful-degradation as a missing anilistId.
        genres: Array.isArray(genres) ? genres.filter(g => typeof g === 'string').slice(0, 10) : [],
        // AniList's own id — distinct from idMal, and what SaveMediaListEntry
        // (the sync mutation) actually needs. Optional: a favorite added
        // before this field existed, or one AniList has no listing for,
        // just can't sync — the rest of the feature still works.
        anilistId: anilistId ? Number(anilistId) : null,
        title: String(title),
        cover: cover || '',
        // AniList's media format (MOVIE/TV/OVA/...) — lets the library/
        // history cards show "Movie" instead of a misleading "Ep 1/1" for a
        // format where "1 episode" is a technicality, not a real progress
        // count. Optional, same graceful-degradation as anilistId/genres
        // above: a favorite added before this field existed just falls back
        // to the old episode-count label until POST /api/anime/format
        // backfills it (see _animeTestLoadExtendedDetails).
        format: typeof format === 'string' ? format : null,
        totalEpisodes: Number(totalEpisodes) || 0,
        lastWatchedEpisode: 0,
        lastPositionSeconds: 0,
        lastDurationSeconds: 0,
        dateAdded: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      inLibrary = true;
    }

    await writeStore(store);
    flushNow();
    res.json({ ok: true, inLibrary });
  }));

  // "Refresh" button on an anime's details page. Unlike manga (which has
  // to ask the streaming source itself for a chapter count), AniList
  // already carries an authoritative episode count for practically every
  // anime, independent of which streaming source the show is even linked
  // to - the client already has AniList query access (public/modules/
  // anilist.js's anilistGQL) and a stored anilistId, so it fetches the
  // current count itself and posts just the number here rather than this
  // route standing up a second server-side AniList client for the same
  // lookup. Same "no baseline yet = don't flag as new" rule as manga's
  // equivalent (update-tracking.js) - totalEpisodes starts at 0 for any
  // favorite that never got a real count, and 0 doesn't count as a baseline.
  app.post('/api/anime/refresh-item', asyncHandler(async (req, res) => {
    const { idMal, totalEpisodes } = req.body || {};
    if (!idMal || !isSafeAnimeId(idMal)) {
      const err = new Error('idMal is required');
      err.statusCode = 400;
      throw err;
    }
    const currentCount = Number(totalEpisodes) || 0;
    const store = await readStore();
    const fav = store.animeFavorites.find(f => f.idMal === String(idMal));
    if (!fav) {
      const err = new Error('Not in My Anime');
      err.statusCode = 404;
      throw err;
    }

    const hadBaseline = Number(fav.totalEpisodes) > 0;
    const previous = hadBaseline ? Number(fav.totalEpisodes) : currentCount;
    const isUpdate = hadBaseline && currentCount > previous;

    if (currentCount > 0) fav.totalEpisodes = currentCount;
    if (isUpdate) {
      fav.hasUnseenUpdate = true;
      fav.lastUpdateDetectedAt = new Date().toISOString();
    }
    fav.updatedAt = new Date().toISOString();

    await writeStore(store);
    res.json({
      ok: true,
      totalEpisodes: fav.totalEpisodes,
      isUpdate,
      newEpisodes: isUpdate ? currentCount - previous : 0,
    });
  }));

  // "Sync Anime Library Status" (Settings > Anime tab) — the manga
  // equivalent (routes/library.js's /sync-status) has the server itself
  // fetch each favorite's status from its own source. Anime has no
  // per-favorite source to ask (see schema.js's animeFavorites comment on
  // why) and doesn't need one anyway — AniList's own `status` field is
  // already this project's single source of truth for anime. Same
  // reasoning as /api/anime/refresh-item just above: the client already has
  // AniList query access and every favorite's own anilistId, so it resolves
  // the statuses itself (public/modules/ui-anime-test.js's
  // syncAnimeLibraryStatus, batched into one request per chunk) and this
  // route only ever receives and writes the results — never a second
  // server-side AniList client for the same lookup.
  const ANIME_AIRING_STATUSES = new Set(['ongoing', 'completed', 'not_yet_released', 'cancelled', 'hiatus']);
  app.post('/api/anime/sync-status', asyncHandler(async (req, res) => {
    const { updates } = req.body || {};
    if (!Array.isArray(updates)) {
      const err = new Error('updates array required');
      err.statusCode = 400;
      throw err;
    }
    const store = await readStore();
    let updated = 0;
    for (const u of updates.slice(0, 2000)) {
      const idMal = String(u?.idMal || '');
      if (!idMal || !isSafeAnimeId(idMal) || !ANIME_AIRING_STATUSES.has(u?.status)) continue;
      const fav = store.animeFavorites.find(f => f.idMal === idMal);
      if (!fav) continue;
      if (fav.airingStatus !== u.status) {
        fav.airingStatus = u.status;
        fav.updatedAt = new Date().toISOString();
        updated++;
      }
    }
    if (updated > 0) await writeStore(store);
    res.json({ ok: true, updated });
  }));

  app.post('/api/anime/updates/dismiss', asyncHandler(async (req, res) => {
    const { idMal } = req.body || {};
    if (!idMal || !isSafeAnimeId(idMal)) {
      const err = new Error('idMal is required');
      err.statusCode = 400;
      throw err;
    }
    const store = await readStore();
    const fav = store.animeFavorites.find(f => f.idMal === String(idMal));
    if (fav) {
      fav.hasUnseenUpdate = false;
      await writeStore(store);
    }
    res.json({ ok: true });
  }));

  // ── Watch progress + History ──────────────────────────────────────────────
  // Corrected assumption from an earlier pass at this feature (the comment
  // used to claim this mirrors manga — it didn't): manga's history
  // (addHistoryEntry, library/content-service.js) records a read
  // independently of favoriting; a manga read once and never favorited
  // still shows in History. This route used to only touch animeFavorites,
  // silently no-op-ing when the show wasn't favorited yet — a show watched
  // without hitting "Add to My Anime" left zero trace anywhere, in either
  // My Anime or History. Now it always upserts into animeHistory (deduped
  // by idMal, capped at 100, most-recent-first — same shape as manga's
  // store.history), and additionally updates the favorite entry when one
  // exists, same as before.
  //
  // title/cover/totalEpisodes/anilistId/genres are only required to CREATE
  // a fresh history entry (nothing to copy them from without an existing
  // favorite or history row) — optional on every subsequent call for the
  // same idMal.
  app.post('/api/anime/progress', asyncHandler(async (req, res) => {
    const { idMal, episode, positionSeconds, durationSeconds, title, cover, totalEpisodes, anilistId, genres, format } = req.body || {};
    if (!idMal || !episode) {
      const err = new Error('idMal and episode are required');
      err.statusCode = 400;
      throw err;
    }
    const store = await readStore();
    const id = String(idMal);
    const now = new Date().toISOString();

    const favEntry = store.animeFavorites.find(f => f.idMal === id);
    if (favEntry) {
      favEntry.lastWatchedEpisode = Number(episode) || favEntry.lastWatchedEpisode;
      favEntry.lastPositionSeconds = Number(positionSeconds) || 0;
      favEntry.lastDurationSeconds = Number(durationSeconds) || favEntry.lastDurationSeconds;
      favEntry.updatedAt = now;
    }

    const histIdx = store.animeHistory.findIndex(h => h.idMal === id);
    const existingHist = histIdx >= 0 ? store.animeHistory[histIdx] : null;
    if (histIdx >= 0) store.animeHistory.splice(histIdx, 1);
    store.animeHistory.unshift({
      idMal: id,
      title: String(title || existingHist?.title || favEntry?.title || ''),
      cover: String(cover || existingHist?.cover || favEntry?.cover || ''),
      totalEpisodes: Number(totalEpisodes) || existingHist?.totalEpisodes || favEntry?.totalEpisodes || 0,
      format: (typeof format === 'string' && format) || existingHist?.format || favEntry?.format || null,
      anilistId: anilistId ? Number(anilistId) : (existingHist?.anilistId || favEntry?.anilistId || null),
      genres: Array.isArray(genres) ? genres.filter(g => typeof g === 'string').slice(0, 10) : (existingHist?.genres || favEntry?.genres || []),
      lastWatchedEpisode: Number(episode) || existingHist?.lastWatchedEpisode || 0,
      lastPositionSeconds: Number(positionSeconds) || 0,
      lastDurationSeconds: Number(durationSeconds) || existingHist?.lastDurationSeconds || 0,
      updatedAt: now,
    });
    store.animeHistory = store.animeHistory.slice(0, 100);

    await writeStore(store);
    // Progress saves fire every few seconds during playback — unlike
    // favorites/settings (rare, deliberate writes), this is exactly the
    // high-frequency case writeStore's own debounced save exists for, so no
    // flushNow() here.
    res.json({ ok: true, saved: true });
  }));

  // ── Watch-time analytics (streak/heatmap/AP parity with manga) ────────────
  // Mirrors POST /api/analytics/session (routes/analytics.js) — a separate
  // route rather than a mediaType flag on the shared one, same convention
  // as every other anime-prefixed endpoint in this file, but both feed the
  // same store.analytics through analyticsService (see its own comment on
  // why totalTimeSpent/dailyStreak/the heatmap are shared while
  // totalChaptersRead/totalEpisodesWatched stay separate).
  app.post('/api/anime/analytics/session', asyncHandler(async (req, res) => {
    res.json(await analyticsService.recordAnimeSession(req.body || {}));
  }));

  app.get('/api/anime/history', asyncHandler(async (req, res) => {
    const store = await readStore();
    res.json({ ok: true, history: store.animeHistory || [] });
  }));

  app.post('/api/anime/history/remove', asyncHandler(async (req, res) => {
    const { idMal } = req.body || {};
    if (!idMal) {
      const err = new Error('idMal is required');
      err.statusCode = 400;
      throw err;
    }
    const store = await readStore();
    store.animeHistory = (store.animeHistory || []).filter(h => h.idMal !== String(idMal));
    await writeStore(store);
    flushNow();
    res.json({ ok: true });
  }));
}

module.exports = { registerAnimeRoutes, configure };
