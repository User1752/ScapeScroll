'use strict';

/**
 * server/modules/covers/service.js — a local copy of the cover of every title in the library (data/covers/).
 *
 * A cover is an address on the source's own image host, and those hosts change their rules (a host that answers a plain request and refuses
 * a browser's, one that wants its site as Referer, one whose files expire): the page asked for each cover straight from the host and the
 * covers went blank. The server now fetches each one once, with the headers each host accepts (the image proxy's), and keeps the file; the
 * page shows that file instead (GET /api/library-cover/<file>, and the map of address -> file at GET /api/library-covers).
 *
 * It is one idea, a reconcile: the covers the library needs now (the one the person chose, else the source's, of every favourite) against the
 * files and the index on disk (disk.js):
 *   - a cover that is needed and not on disk is fetched (one at a time, with a gap, and a failure is left alone for a few hours);
 *   - a cover that is on disk and no title needs any more is deleted. That is how a changed cover replaces the old one, and how a title that
 *     leaves the library takes its cover with it: only the covers of the library are kept.
 * Nothing here is triggered by a particular action: the store tells it that something was written, it waits a few seconds, and looks.
 * data/ is shared between a PC and a container, so there is one copy.
 */

const { createCoverDisk, FILE_RE } = require('./disk');

// ── pure helpers (also what the page's own lookup has to agree with: public/modules/utils.js coverUrlKey) ──

// The address a cover is known by: the image's own https address, whether the value is that address or this app's proxy address for it
// (the form some covers were saved in). '' for anything that is not a remote https image.
function coverUrlKey(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s, 'http://localhost');
    if (u.pathname === '/api/proxy-image') s = u.searchParams.get('url') || '';
  } catch (_) {
    return '';
  }
  if (/^http:\/\//i.test(s)) s = `https://${s.slice(7)}`;
  return /^https:\/\//i.test(s) ? s : '';
}

// The same cleaning as library/content-service.js uses for the key of a chosen cover (id:sourceId); a test keeps the two equal.
const sanitizePart = (v) => String(v || '').replace(/[^a-z0-9:_-]/gi, '_').slice(0, 300);
function coverOverrideKey(mangaId, sourceId) {
  return `${sanitizePart(mangaId)}:${sanitizePart(sourceId || 'unknown')}`.slice(0, 300);
}

// The cover a favourite shows: the one the person chose (coverOverrides), else the one the source gave.
function effectiveCover(store, favorite) {
  const chosen = store && store.coverOverrides && store.coverOverrides[coverOverrideKey(favorite.id, favorite.sourceId)];
  return typeof chosen === 'string' && chosen.trim() ? chosen.trim() : favorite.cover;
}

// Some hosts need the site as Referer; the page sends it as `ref` (public/modules/utils.js normalizeImageUrl) and so does this.
function refererHintFor(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return undefined; }
  if (host === 'wp.youtube-anime.com' || host === 'aln.youtube-anime.com') return 'https://allmanga.to';
  if (host === 'batcave.biz' || host.endsWith('.batcave.biz')) return 'https://batcave.biz/';
  return undefined;
}

// What the library needs: address -> the Referer to ask with. A manga kept on this computer (sourceId 'local') has no remote cover.
function wantedCovers(store) {
  const wanted = new Map();
  const favorites = Array.isArray(store && store.favorites) ? store.favorites : [];
  for (const fav of favorites) {
    if (!fav || fav.sourceId === 'local') continue;
    const raw = effectiveCover(store, fav);
    const url = coverUrlKey(raw);
    if (!url || wanted.has(url)) continue;
    let ref;
    try { ref = new URL(String(raw), 'http://localhost').searchParams.get('ref') || undefined; } catch (_) { /* no hint */ }
    wanted.set(url, ref || refererHintFor(url));
  }
  return wanted;
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * @param {object} o
 * @param {string} o.dir                          where the covers live (data/covers)
 * @param {() => Promise<object>} o.readStore
 * @param {(o:{url:string,ref?:string,measureBytes:boolean}) => Promise<{contentType:string,body:any}>} o.fetchImage  the image proxy's fetch
 * @param {object} o.limits                        config/limits.js (the libraryCover* values)
 */
function createLibraryCoverService({ dir, readStore, fetchImage, limits, logger = console, now = Date.now, sleep = defaultSleep }) {
  const disk = createCoverDisk({ dir, limits, fetchImage, now, sleep });
  let running = null;
  let again = false;
  let timer = null;

  async function runOnce() {
    const store = await readStore();
    // A store without a list of favourites says nothing about the library: nothing is deleted on that.
    if (!store || !Array.isArray(store.favorites)) return { downloaded: 0, removed: 0, failed: 0, kept: 0, pending: 0 };
    return disk.sync(wantedCovers(store));
  }

  // One run at a time; a request that arrives during a run makes one more run after it (the library may have changed meanwhile).
  function reconcile() {
    if (running) { again = true; return running; }
    running = runOnce()
      .catch((e) => { if (logger.warn) logger.warn('[Covers] Could not update the local covers:', e && e.message); return null; })
      .finally(() => {
        running = null;
        if (again) { again = false; scheduleReconcile(); }
      });
    return running;
  }

  // A look already waiting is kept, not pushed back: the store is written often, and a look that every write postponed would never happen.
  function scheduleReconcile(delayMs = limits.libraryCoverDebounceMs) {
    if (timer) return;
    timer = setTimeout(() => { timer = null; reconcile(); }, delayMs);
    if (timer.unref) timer.unref();
  }

  return {
    reconcile,
    scheduleReconcile,
    start: () => scheduleReconcile(limits.libraryCoverStartDelayMs),
    getMap: () => disk.getMap(),
    getFile: (name) => disk.getFile(name),
    // `busy`: a look is running or waiting to run, so the page keeps asking until it is over and draws the covers as they arrive.
    status: async () => ({ ...(await disk.counts()), running: !!running, busy: !!running || !!timer }),
  };
}

module.exports = { createLibraryCoverService, coverUrlKey, coverOverrideKey, effectiveCover, wantedCovers, refererHintFor, FILE_RE };
