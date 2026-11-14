'use strict';

/**
 * Exports ScrollScape's animeFavorites collection as an Anikku-compatible
 * .tachibk backup — see anikku-backup.proto's header comment for why this
 * is a dedicated schema rather than reusing mihon-import/backup.proto.
 *
 * Same honest scope limit as the manga exporter (mihon-import/service.js):
 * there's no shared registry between ScrollScape's own idMal-keyed anime
 * and whatever numeric extension id an Anikku install's real source uses,
 * so this ships everything under one synthetic "ScrollScape" BackupSource.
 * Anikku's own by-name extension matching (if the user has an AllAnime-
 * family extension installed) is what would resolve it into something
 * playable there — that matching happens on Anikku's side, not this one.
 *
 * Per-episode watch state: only lastWatchedEpisode is tracked server-side
 * (not a full per-episode log), so episodes 1..lastWatchedEpisode are
 * synthesized as seen:true — matching the exact same "watched" heuristic
 * the app's own episode-grid chip styling already uses (ui-anime-test.js's
 * _animeTestWatchedUpTo) — rather than emitting one entry per episode of a
 * 1000+ episode show, which would bloat the file for no benefit.
 */

const zlib = require('zlib');
const path = require('path');
const protobuf = require('protobufjs');

let backupRoot = null;
async function getBackupType() {
  if (!backupRoot) {
    backupRoot = await protobuf.load(path.join(__dirname, 'anikku-backup.proto'));
  }
  return backupRoot.lookupType('anikku.Backup');
}

// Small standalone AniList title-search helper for import's fallback path
// (see importAnikkuBackup below) — deliberately not routed through
// modules/proxy/service.js's proxyAniList, since that also carries an
// isSafeUrl dependency for its unrelated image-proxy half; a plain fetch
// here keeps this module's only dependency being the store. Same
// rate-limit-retry-once shape already proven client-side in
// ui-anime-film-adaptation-check-via-anilist-graphql.js.
async function resolveAnimeByTitle(title) {
  const query = `query ($search: String) {
    Media(search: $search, type: ANIME) { idMal id episodes coverImage { large } }
  }`;
  const fetchOnce = () => fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables: { search: title } }),
    signal: AbortSignal.timeout(15_000),
  }).then((r) => r.json());

  let data = await fetchOnce();
  if (data?.errors?.some((e) => /rate limit|too many requests/i.test(e.message || ''))) {
    await new Promise((r) => setTimeout(r, 3000));
    data = await fetchOnce();
  }
  if (data?.errors?.length) return null;
  const media = data?.data?.Media;
  return media?.idMal ? media : null;
}

function createAnikkuExportService({ readStore, writeStore }) {
  async function exportAnikkuBackup() {
    const store = await readStore();
    const overrides = store.animeCoverOverrides || {};

    const categoryIdByListId = new Map(); // customList.id -> numeric BackupCategory order/id
    const backupCategories = (store.customLists || []).map((list, i) => {
      categoryIdByListId.set(list.id, i + 1);
      return { name: list.name, order: i };
    });
    const categoriesByIdMal = new Map(); // idMal -> [category numeric ids]
    for (const list of (store.customLists || [])) {
      const catId = categoryIdByListId.get(list.id);
      for (const item of (list.animeItems || [])) {
        if (!categoriesByIdMal.has(item.idMal)) categoriesByIdMal.set(item.idMal, []);
        categoriesByIdMal.get(item.idMal).push(catId);
      }
    }

    const backupAnime = (store.animeFavorites || []).map(f => {
      const watchedUpTo = Number(f.lastWatchedEpisode) || 0;
      const episodes = [];
      for (let i = 1; i <= watchedUpTo; i++) {
        const isLast = i === watchedUpTo;
        episodes.push({
          url: `ep-${i}`,
          name: `Episode ${i}`,
          seen: true,
          episodeNumber: i,
          sourceOrder: i,
          // Only the most recently watched episode has a real in-progress
          // position — earlier ones are just marked fully seen.
          lastSecondSeen: isLast ? Math.round(Number(f.lastPositionSeconds) || 0) * 1000 : 0,
          totalSeconds: isLast ? Math.round(Number(f.lastDurationSeconds) || 0) * 1000 : 0,
        });
      }

      return {
        source: 1, // single synthetic "ScrollScape" source — see file header
        url: `https://myanimelist.net/anime/${f.idMal}`,
        title: f.title || '',
        description: '',
        genre: [],
        status: 0, // unknown — not tracked per favorite today, not guessed
        thumbnailUrl: overrides[f.idMal] || f.cover || '',
        dateAdded: f.dateAdded ? new Date(f.dateAdded).getTime() : Date.now(),
        episodes,
        categories: categoriesByIdMal.get(f.idMal) || [],
        favorite: true,
        history: watchedUpTo > 0 ? [{
          url: `ep-${watchedUpTo}`,
          lastRead: f.updatedAt ? new Date(f.updatedAt).getTime() : Date.now(),
          readDuration: Math.round(Number(f.lastPositionSeconds) || 0) * 1000,
        }] : [],
        lastModifiedAt: Date.now(),
      };
    });

    const backupSources = [{ name: 'ScrollScape', sourceId: 1 }];

    const BackupType = await getBackupType();
    const payload = { backupAnime, backupAnimeCategories: backupCategories, backupSources };
    const errMsg = BackupType.verify(payload);
    if (errMsg) throw new Error(`Invalid backup payload: ${errMsg}`);
    const message = BackupType.create(payload);
    const buffer = BackupType.encode(message).finish();
    return zlib.gzipSync(buffer);
  }

  // Reverse of exportAnikkuBackup above — decodes a .tachibk file back into
  // plain objects. Scoped to Anikku's own schema only (this .proto), not
  // Aniyomi's combined manga+anime one (different field numbers, a
  // deliberately separate schema per this file's header comment) — a real
  // third-party Aniyomi backup won't decode cleanly here, only Anikku ones
  // (including round-tripping ScrollScape's own prior export) will.
  async function decodeAnikkuBackup(buffer) {
    const raw = zlib.gunzipSync(buffer);
    const BackupType = await getBackupType();
    const message = BackupType.decode(raw);
    return BackupType.toObject(message, { longs: Number, defaults: true });
  }

  // Numeric category ids in a BackupAnime.categories entry are positional —
  // this mirrors exactly how exportAnikkuBackup assigned them above
  // (categoryIdByListId.set(list.id, i + 1)), so decoding needs the same
  // 1-based index-to-name mapping rather than any id field in the schema
  // itself (BackupCategory only carries name/order, see anikku-backup.proto).
  async function importAnikkuBackup(buffer) {
    const decoded = await decodeAnikkuBackup(buffer);
    const categoryNameByPosition = new Map(
      (decoded.backupAnimeCategories || []).map((c, i) => [i + 1, c.name])
    );

    const store = await readStore();
    const existingByIdMal = new Map((store.animeFavorites || []).map((f) => [f.idMal, f]));

    let imported = 0, updated = 0, skipped = 0;
    const unresolved = [];
    const totalInBackup = (decoded.backupAnime || []).length;

    for (const ba of (decoded.backupAnime || [])) {
      if (ba.favorite === false || !ba.title) { skipped++; continue; }

      // Fast path: round-tripping ScrollScape's own prior export (or another
      // ScrollScape instance's), whose url is always this exact MAL-url
      // shape (see exportAnikkuBackup above) — no AniList call needed.
      let idMal = null;
      const urlMatch = /\/anime\/(\d+)/.exec(ba.url || '');
      if (urlMatch) idMal = urlMatch[1];

      let anilistId = null;
      let resolvedCover = ba.thumbnailUrl || '';
      let resolvedEpisodes = 0;

      if (!idMal) {
        // A real third-party Anikku backup — its url is whatever provider
        // extension it came from, not a MAL url. Resolve by title instead.
        // Sequential (never parallel/batched) on purpose: this app has hit
        // AniList's rate limit more than once already this session doing
        // one-call-per-item work — see the calendar view's batched query
        // for the pattern this deliberately avoids repeating.
        try {
          const media = await resolveAnimeByTitle(ba.title);
          if (media) {
            idMal = String(media.idMal);
            anilistId = media.id || null;
            resolvedCover = resolvedCover || media.coverImage?.large || '';
            resolvedEpisodes = media.episodes || 0;
          }
        } catch (_) { /* falls through to unresolved below */ }
      }

      if (!idMal) {
        unresolved.push(ba.title);
        skipped++;
        continue;
      }

      const episodes = Array.isArray(ba.episodes) ? ba.episodes : [];
      const seenCount = episodes.filter((e) => e.seen).length;
      const maxEpisodeNumber = episodes.reduce((max, e) => Math.max(max, Number(e.episodeNumber) || 0), 0);
      const lastEpisode = episodes.length
        ? episodes.slice().sort((a, b) => (Number(a.episodeNumber) || 0) - (Number(b.episodeNumber) || 0)).pop()
        : null;

      let entry = existingByIdMal.get(idMal);
      if (entry) {
        // Progress only ever moves forward — never regress a favorite that's
        // further along locally than what this backup happens to carry.
        if (seenCount > (entry.lastWatchedEpisode || 0)) {
          entry.lastWatchedEpisode = seenCount;
          entry.lastPositionSeconds = lastEpisode ? Math.round((lastEpisode.lastSecondSeen || 0) / 1000) : entry.lastPositionSeconds;
          entry.lastDurationSeconds = lastEpisode ? Math.round((lastEpisode.totalSeconds || 0) / 1000) : entry.lastDurationSeconds;
          entry.updatedAt = new Date().toISOString();
        }
        if (!entry.totalEpisodes) entry.totalEpisodes = resolvedEpisodes || maxEpisodeNumber || 0;
        updated++;
      } else {
        entry = {
          idMal,
          genres: [],
          anilistId,
          title: ba.title,
          cover: resolvedCover,
          totalEpisodes: resolvedEpisodes || maxEpisodeNumber || 0,
          lastWatchedEpisode: seenCount,
          lastPositionSeconds: lastEpisode ? Math.round((lastEpisode.lastSecondSeen || 0) / 1000) : 0,
          lastDurationSeconds: lastEpisode ? Math.round((lastEpisode.totalSeconds || 0) / 1000) : 0,
          dateAdded: ba.dateAdded ? new Date(ba.dateAdded).toISOString() : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        store.animeFavorites.push(entry);
        existingByIdMal.set(idMal, entry);
        imported++;
      }

      for (const catPos of (ba.categories || [])) {
        const catName = categoryNameByPosition.get(Number(catPos));
        if (!catName) continue;
        let list = (store.customLists || []).find((l) => l.name.toLowerCase() === catName.toLowerCase());
        if (!list) {
          list = { id: `list_${Date.now()}_${store.customLists.length}`, name: catName.slice(0, 100), description: '', mangaItems: [], animeItems: [], isDynamic: false, filterQuery: null, createdAt: new Date().toISOString() };
          store.customLists.push(list);
        }
        if (!Array.isArray(list.animeItems)) list.animeItems = [];
        if (!list.animeItems.some((a) => a.idMal === idMal)) {
          list.animeItems.push({ idMal, addedAt: new Date().toISOString() });
        }
      }
    }

    await writeStore(store);
    return { ok: true, imported, updated, skipped, unresolved, totalInBackup };
  }

  return { exportAnikkuBackup, decodeAnikkuBackup, importAnikkuBackup };
}

module.exports = { createAnikkuExportService };
