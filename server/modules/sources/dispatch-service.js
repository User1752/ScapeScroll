'use strict';

const ALLOWED_METHODS = new Set([
  'search', 'mangaDetails', 'chapters', 'pages',
  'trending', 'recentlyAdded', 'latestUpdates', 'popularAllTime',
  'byGenres', 'authorSearch',
]);

function buildSourceCall(mod, method, payload = {}) {
  const {
    query,
    page,
    mangaId,
    chapterId,
    genres,
    orderBy,
    authorName,
    publicationStatus,
    contentRating,
    format,
  } = payload;

  const filters = {
    publicationStatus: publicationStatus || '',
    contentRating: contentRating || '',
    format: format || '',
  };

  switch (method) {
    case 'search':
      return mod.search(query || '', Number(page) || 1, orderBy || '', filters);
    case 'mangaDetails':
      return mod.mangaDetails(mangaId || '');
    case 'chapters':
      return mod.chapters(mangaId || '');
    case 'pages':
      return mod.pages(chapterId || '');
    case 'trending':
      return mod.trending();
    case 'recentlyAdded':
      return mod.recentlyAdded();
    case 'latestUpdates':
      return mod.latestUpdates();
    case 'popularAllTime':
      return mod.popularAllTime();
    case 'byGenres':
      return mod.byGenres(genres || [], orderBy || '', filters, Number(page) || 1);
    case 'authorSearch':
      return mod.authorSearch(authorName || '');
    default:
      return null;
  }
}

function createSourceDispatchService({ safeId, loadSourceFromFile, withTimeout, timeoutMs, logger = console }) {
  async function dispatch({ id, method, body } = {}) {
    const sid = safeId(id);
    if (!sid) {
      const err = new Error('Invalid source ID');
      err.statusCode = 400;
      throw err;
    }
    if (!ALLOWED_METHODS.has(method)) {
      const err = new Error('Method not supported');
      err.statusCode = 400;
      throw err;
    }

    const mod = loadSourceFromFile(sid);
    if (typeof mod[method] !== 'function') {
      const err = new Error('Method not implemented by this source');
      err.statusCode = 400;
      throw err;
    }

    const payload = body || {};
    const call = buildSourceCall(mod, method, payload);
    // buildSourceCall's own switch is a second list of "known" methods,
    // separate from ALLOWED_METHODS above — if the two ever drift (a method
    // added to one but not the other), its `default: return null` case used
    // to hand withTimeout() a null instead of a promise, which crashed
    // synchronously on `null.then` (confirmed live: exactly this happened
    // for a source-specific `favorites` method, before it was added to ALLOWED_METHODS —
    // this guard makes that drift a clean "Method not supported" instead of
    // a confusing null.then() crash, whichever list is missing an entry).
    if (!call || typeof call.then !== 'function') {
      const err = new Error('Method not supported');
      err.statusCode = 400;
      throw err;
    }

    try {
      return await withTimeout(call, timeoutMs, `${sid}.${method}`);
    } catch (err) {
      const { query, mangaId, chapterId } = payload;
      logger.error('[SOURCES][CALL_FAILED]', {
        sourceId: sid,
        method,
        mangaId,
        chapterId,
        query,
        error: err?.message,
      });
      throw err;
    }
  }

  return { dispatch };
}

module.exports = { createSourceDispatchService, ALLOWED_METHODS };