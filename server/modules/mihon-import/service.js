'use strict';

/**
 * Imports a Tachiyomi/Mihon library backup (.tachibk — gzip-compressed
 * protobuf) into ScrollScape's own library.
 *
 * Honest scope limit, surfaced in the import summary rather than hidden:
 * Tachiyomi/Mihon's `source` field is a numeric id specific to *its own*
 * extension ecosystem — there is no general way to map that to one of
 * ScrollScape's own scraper plugin ids. This importer:
 *   1. Resolves a source NAME from the backup's own source list
 *      (BackupSource: {name, sourceId}) for whichever numeric id a manga
 *      references.
 *   2. Tries to match that name against a currently-installed ScrollScape
 *      source by name (case-insensitive), and — only for sources where the
 *      URL scheme is known to carry the same id (currently just MangaDex's
 *      UUID-based URLs) — extracts a working manga id from it.
 *   3. Everything else imports as metadata-only, sourceId 'unknown' — the
 *      same tolerated state the app's own favorites-source-inference code
 *      already handles elsewhere (see inferSourceIdForFavorite in
 *      library/content-service.js). Title, cover, author, description,
 *      genres, reading status (heuristic — see below) and categories all
 *      still come across; only "read the next chapter directly" needs the
 *      user to re-link it to a live source afterward (the existing Migrate
 *      feature already does exactly that).
 *
 * Tachiyomi/Mihon has no direct "user reading status" field — that's a
 * per-user library-organisation concept (categories/shelves) that varies
 * per install. Status here is approximated from chapter read state:
 * all read -> completed, some read -> reading, none read -> plan_to_read.
 *
 * Re-importing a library the user already has most of in ScrollScape (the
 * common case — this is meant for migrating, not just first-time import):
 * the (id, sourceId) dedup above only catches re-running the *same* backup
 * twice, since a metadata-only entry's synthetic id never matches whatever
 * id/sourceId the same manga already has under a live ScrollScape source.
 * Before creating a new entry, this also checks the existing library for an
 * EXACT (case/punctuation-insensitive) title match — same conservative
 * exact-only rule server/modules/comics-metadata/title-matching.js already
 * uses for cross-database matching, to avoid two different titles ever
 * getting merged. On a match, the backup's reading status/categories attach
 * to the manga's EXISTING (already-working, live-sourced) entry instead of
 * spawning a second metadata-only duplicate of something already there.
 */

const zlib = require('zlib');
const path = require('path');
const protobuf = require('protobufjs');

let backupRoot = null;
async function getBackupType() {
  if (!backupRoot) {
    backupRoot = await protobuf.load(path.join(__dirname, 'backup.proto'));
  }
  return backupRoot.lookupType('tachiyomi.Backup');
}

const MANGADEX_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

// Tachiyomi's own SManga status constants (0=unknown .. 6=on hiatus).
const PUBLICATION_STATUS = { 1: 'ongoing', 2: 'completed', 3: 'ongoing', 4: 'completed', 5: 'cancelled', 6: 'ongoing' };

function resolveSourceIdForManga(backupSourceName, installedSources) {
  if (!backupSourceName) return null;
  const needle = backupSourceName.trim().toLowerCase();
  for (const [sid, info] of Object.entries(installedSources || {})) {
    const name = String(info?.name || '').trim().toLowerCase();
    if (name && (name === needle || name.includes(needle) || needle.includes(name))) return sid;
  }
  return null;
}

function extractWorkingMangaId(sourceId, url) {
  if (sourceId === 'mangadex') {
    const m = MANGADEX_UUID_RE.exec(String(url || ''));
    if (m) return m[1];
  }
  return null;
}

function computeReadingStatus(chapters) {
  const total = chapters.length;
  if (total === 0) return null;
  const readCount = chapters.filter((c) => c.read).length;
  if (readCount === 0) return 'plan_to_read';
  if (readCount >= total) return 'completed';
  return 'reading';
}

// Same normalize-and-compare-exactly rule as title-matching.js's pickBestMatch
// — case/punctuation-insensitive, but never fuzzy. A wrong merge here would
// silently attach one manga's reading progress/categories to a different one.
function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Reverse of PUBLICATION_STATUS above — ScrollScape only stores the string,
// Tachiyomi's own field is numeric, so exporting needs one representative
// code per string rather than a perfect inverse (several codes collapsed to
// the same string on import, e.g. 1/3/6 all read back as 'ongoing').
const PUBLICATION_STATUS_CODE = { ongoing: 1, completed: 2, cancelled: 5, hiatus: 6 };

function createMihonImportService({ readStore, writeStore, safeManga, sha1Short }) {
  async function parseBackupBuffer(rawBuffer) {
    // .tachibk is gzip-compressed; a raw .proto dump (rare, but some tools
    // export uncompressed) starts with a protobuf tag byte instead of the
    // gzip magic number (0x1f 0x8b) — try gunzip first, fall back to raw.
    let buffer = rawBuffer;
    try {
      buffer = zlib.gunzipSync(rawBuffer);
    } catch (_) {
      // Not gzipped — assume it's already a raw protobuf buffer.
    }

    const BackupType = await getBackupType();
    const decoded = BackupType.decode(buffer);
    return BackupType.toObject(decoded, { longs: Number, enums: Number, defaults: true });
  }

  async function importMihonBackup(rawBuffer) {
    const backup = await parseBackupBuffer(rawBuffer);

    const sourcesById = new Map((backup.backupSources || []).map((s) => [Number(s.sourceId), s.name]));
    const categoriesById = new Map((backup.backupCategories || []).map((c) => [Number(c.id), c.name]));

    const store = await readStore();
    const installedSources = store.installedSources || {};

    // Snapshot BEFORE this import's own writes, so a title match only ever
    // resolves to something the user already had — never to another entry
    // from elsewhere in this same backup (those still get their own normal
    // dedup-by-id handling below).
    const existingByTitle = new Map();
    for (const f of store.favorites) {
      const key = normalizeTitle(f.title);
      if (key && !existingByTitle.has(key)) existingByTitle.set(key, f);
    }

    let imported = 0;
    let unresolvedSource = 0;
    let matchedExisting = 0;
    let categoriesCreated = 0;
    const errors = [];

    for (const bm of (backup.backupManga || [])) {
      try {
        if (bm.favorite === false) continue; // backups can carry non-library history entries too
        if (!bm.title) continue;

        const backupSourceName = sourcesById.get(Number(bm.source)) || '';
        const matchedSourceId = resolveSourceIdForManga(backupSourceName, installedSources);
        const workingId = matchedSourceId ? extractWorkingMangaId(matchedSourceId, bm.url) : null;

        // A live-id match already IS the real, working entry — only look for
        // an existing-library title match when we'd otherwise be about to
        // create a synthetic metadata-only one.
        const titleMatch = !workingId ? existingByTitle.get(normalizeTitle(bm.title)) : null;

        const sourceId = workingId ? matchedSourceId : (titleMatch ? titleMatch.sourceId : 'unknown');
        if (!workingId) unresolvedSource++;

        // No live id to key on — derive a stable one from the backup's own
        // (source, url) pair so re-importing the same backup twice updates
        // the same entry instead of duplicating it. A title match instead
        // reuses the existing entry's own id, so this backup's data lands on
        // it rather than spawning a second, non-functional duplicate.
        const mangaId = workingId || (titleMatch ? titleMatch.id : `mihon-${sha1Short(`${bm.source}:${bm.url}`)}`);

        const genres = Array.isArray(bm.genre) ? bm.genre.filter(Boolean) : [];
        const chapters = Array.isArray(bm.chapters) ? bm.chapters : [];

        if (titleMatch) {
          matchedExisting++;
        } else {
          const mangaEntry = {
            ...safeManga({
              id: mangaId,
              title: bm.title,
              cover: bm.thumbnailUrl || '',
              author: [bm.author, bm.artist].filter(Boolean).join(', '),
              description: bm.notes || '',
              status: PUBLICATION_STATUS[Number(bm.status)] || '',
              url: bm.url || '',
              genres,
            }),
            id: mangaId,
            sourceId,
            addedAt: bm.dateAdded ? new Date(Number(bm.dateAdded)).toISOString() : new Date().toISOString(),
          };

          const existingIdx = store.favorites.findIndex((f) => f.id === mangaId && f.sourceId === sourceId);
          if (existingIdx >= 0) store.favorites[existingIdx] = { ...store.favorites[existingIdx], ...mangaEntry };
          else store.favorites.push(mangaEntry);
        }

        // safeManga() just needs enough fields for readingStatus/customLists'
        // own denormalized "manga" snapshot — the existing entry already has
        // better data than the backup for a title-match, so prefer it.
        const snapshotSource = titleMatch || { id: mangaId, sourceId, title: bm.title, cover: bm.thumbnailUrl || '' };

        const readingStatus = computeReadingStatus(chapters);
        if (readingStatus) {
          const key = `${mangaId}:${sourceId}`.replace(/[^a-z0-9:_-]/gi, '_').slice(0, 300);
          store.readingStatus[key] = { status: readingStatus, updatedAt: new Date().toISOString(), manga: safeManga(snapshotSource) };
        }

        // Categories -> ScrollScape custom lists (created on first use).
        for (const catId of (bm.categories || [])) {
          const catName = categoriesById.get(Number(catId));
          if (!catName) continue;
          let list = store.customLists.find((l) => l.name.toLowerCase() === catName.toLowerCase());
          if (!list) {
            list = { id: `list_${Date.now()}_${store.customLists.length}`, name: catName.slice(0, 100), description: '', mangaItems: [], isDynamic: false, filterQuery: null, createdAt: new Date().toISOString() };
            store.customLists.push(list);
            categoriesCreated++;
          }
          if (!list.mangaItems.some((m) => m.id === mangaId)) {
            list.mangaItems.push({ ...safeManga(snapshotSource), sourceId, addedAt: new Date().toISOString() });
          }
        }

        imported++;
      } catch (err) {
        errors.push({ title: bm?.title || 'unknown', error: err.message });
      }
    }

    await writeStore(store);
    return { ok: true, imported, unresolvedSource, matchedExisting, categoriesCreated, totalInBackup: (backup.backupManga || []).length, errors };
  }

  // Reverse of importMihonBackup — builds a .tachibk Mihon/Komikku (same
  // format, Komikku hasn't diverged the schema) can restore.
  //
  // Same honest scope limit as the importer, mirrored: ScrollScape's
  // sourceId ('mangapill', 'mangadex', ...) has no relationship to whatever
  // numeric extension id Mihon/Komikku uses on the receiving device — there
  // is no shared registry to map through. Each distinct sourceId among the
  // exported manga gets its own synthetic BackupSource entry (a sequential
  // id, paired with the source's real display name) so the file is
  // internally consistent and Mihon's own by-name extension matching (the
  // same mechanism the importer above relies on in reverse) has a name to
  // work with — but a fresh install's numeric extension ids won't already
  // line up with these on first restore either way; that's inherent to
  // migrating between apps with separate source ecosystems, not something
  // fixable from this end.
  //
  // Per-chapter read state is fetched from a live source at read time and
  // never persisted server-side, only in each browser's own localStorage —
  // so it comes in as `readChapters` (an array of "mangaId:chapterId"
  // strings, exactly ui-settings.js's own key format) rather than being read
  // from the store here. A chapter present there becomes a BackupChapter
  // with read:true; nothing else about it (a proper name, its position) is
  // known without re-fetching the manga's full chapter list from its live
  // source for every single library entry at export time, which isn't worth
  // the wait for what Mihon needs to show useful progress — the id alone as
  // both name and url still correctly carries "this specific chapter was
  // read" across, which is the part that actually matters.
  async function exportMihonBackup({ readChapters } = {}) {
    const store = await readStore();
    const readSet = new Set(Array.isArray(readChapters) ? readChapters : []);

    const sourceIdByName = new Map(); // sourceId -> synthetic numeric id
    let nextSourceNumericId = 1;
    function synthNumericSourceId(sid) {
      if (!sourceIdByName.has(sid)) sourceIdByName.set(sid, nextSourceNumericId++);
      return sourceIdByName.get(sid);
    }

    const categoryIdByListId = new Map(); // customList.id -> numeric BackupCategory id
    const backupCategories = (store.customLists || []).map((list, i) => {
      categoryIdByListId.set(list.id, i + 1);
      return { name: list.name, order: i, id: i + 1 };
    });
    const listsByMangaKey = new Map(); // "mangaId:sourceId" -> [category numeric ids]
    for (const list of (store.customLists || [])) {
      const catId = categoryIdByListId.get(list.id);
      for (const item of (list.mangaItems || [])) {
        const key = `${item.id}:${item.sourceId || ''}`;
        if (!listsByMangaKey.has(key)) listsByMangaKey.set(key, []);
        listsByMangaKey.get(key).push(catId);
      }
    }

    const backupManga = (store.favorites || []).map((f) => {
      const chapters = [];
      for (const rc of readSet) {
        const sep = rc.lastIndexOf(':');
        if (sep < 0) continue;
        const rcMangaId = rc.slice(0, sep);
        if (rcMangaId !== f.id) continue;
        const chapterId = rc.slice(sep + 1);
        chapters.push({ url: chapterId, name: chapterId, read: true, bookmark: false, chapterNumber: 0, sourceOrder: 0 });
      }

      return {
        source: synthNumericSourceId(f.sourceId || 'unknown'),
        url: f.url || '',
        title: f.title || '',
        artist: '',
        author: f.author || '',
        description: f.description || '',
        genre: Array.isArray(f.genres) ? f.genres : [],
        status: PUBLICATION_STATUS_CODE[String(f.status || '').toLowerCase()] || 0,
        thumbnailUrl: f.cover || '',
        dateAdded: f.addedAt ? new Date(f.addedAt).getTime() : Date.now(),
        chapters,
        categories: listsByMangaKey.get(`${f.id}:${f.sourceId || ''}`) || [],
        favorite: true,
        history: [],
        lastModifiedAt: Date.now(),
        notes: '',
      };
    });

    const backupSources = [...sourceIdByName.entries()].map(([sid, numericId]) => ({
      name: store.installedSources?.[sid]?.name || sid,
      sourceId: numericId,
    }));

    const BackupType = await getBackupType();
    const payload = { backupManga, backupCategories, backupSources };
    const errMsg = BackupType.verify(payload);
    if (errMsg) throw new Error(`Invalid backup payload: ${errMsg}`);
    const message = BackupType.create(payload);
    const buffer = BackupType.encode(message).finish();
    return zlib.gzipSync(buffer);
  }

  return { importMihonBackup, parseBackupBuffer, exportMihonBackup };
}

module.exports = { createMihonImportService };
