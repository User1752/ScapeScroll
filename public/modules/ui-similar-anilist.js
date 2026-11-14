// ============================================================================
// "YOU MIGHT ALSO LIKE" ON THE MANGA PAGE — FROM ANILIST'S RECOMMENDATIONS
// ============================================================================
// The row used to be built by asking every installed source for titles of the same genres, which finds "the same genres", not "what readers who liked
// this also liked". AniList keeps the second: each title has recommendations, voted by readers. One request (by the AniList id of the title when the
// library knows it, else by its name) gives the list; the cards show AniList's own cover and score, and a click looks the title up in the installed
// sources (the same lookup the author search uses: _resolveAndOpenAuthorTitle), so no source is asked about a title the person does not open.
//
// Hide NSFW, the genre blacklist and the library are applied when the row is drawn (what is in the library is not offered again). The answer is kept for
// a few days in the browser, so opening a page again asks nothing. When AniList has no recommendations for the title (or cannot be reached) this returns
// false and the page keeps the genre-based row it had (ui-search.js, loadSimilarManga).

const SIMILAR_AL = Object.freeze({
  // v2: the answers kept by name before the match was checked could be those of another title.
  cacheKey: 'scrollscape_similar_anilist_v2',
  hintsKey: 'scrollscape_similar_al_hints_v1',
  hintsMax: 200,
  ttlMs: 3 * 24 * 60 * 60 * 1000,
  cacheMax: 80,
  perPage: 25,
  minToShow: 4,
  maxToShow: 18,
});

const SIMILAR_AL_FIELDS = `recommendations(sort: RATING_DESC, perPage: ${SIMILAR_AL.perPage}) {
      nodes { rating mediaRecommendation { id type format countryOfOrigin isAdult genres averageScore title { romaji english } coverImage { large } } }
    }`;
const SIMILAR_AL_QUERY_BY_ID = `query ($id: Int) { Media(id: $id, type: MANGA) { id ${SIMILAR_AL_FIELDS} } }`;

const _similarAlText = (value, max) => String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

/** AniList's recommendation nodes as plain items: manga only, with a title, each title once, capped values. */
function similarAlParse(nodes) {
  const seen = new Set();
  const out = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const m = node && node.mediaRecommendation;
    const id = Number(m && m.id);
    if (!m || !Number.isFinite(id) || id <= 0 || seen.has(id) || (m.type && m.type !== 'MANGA')) continue;
    const title = _similarAlText((m.title && (m.title.english || m.title.romaji)) || '', 120);
    if (!title) continue;
    seen.add(id);
    const cover = String((m.coverImage && m.coverImage.large) || '');
    out.push({
      id,
      title,
      cover: /^https:\/\/[A-Za-z0-9.-]+\//.test(cover) ? cover.slice(0, 300) : '',
      genres: (Array.isArray(m.genres) ? m.genres : []).map((g) => _similarAlText(g, 40)).filter(Boolean).slice(0, 12),
      score: Number.isFinite(Number(m.averageScore)) ? Math.max(0, Math.min(100, Math.round(Number(m.averageScore)))) : 0,
      votes: Number.isFinite(Number(node.rating)) ? Math.round(Number(node.rating)) : 0,
      adult: m.isAdult === true,
    });
  }
  return out;
}

/**
 * What the person's settings and library leave of the items.
 * @param {Array} items   from similarAlParse
 * @param {{ hideNsfw?: boolean, genreBlacklist?: string[] }} settings
 * @param {Set<string>} ownedIds   AniList ids of what the library already has (as text)
 * @param {number|string} selfId   the AniList id of the title being viewed
 */
function similarAlVisible(items, settings, ownedIds, selfId) {
  const blacklist = Array.isArray(settings && settings.genreBlacklist) ? settings.genreBlacklist : [];
  return items.filter((item) => {
    if (String(item.id) === String(selfId) || ownedIds.has(String(item.id))) return false;
    if (settings && settings.hideNsfw && (item.adult || item.genres.some((g) => isNsfwTag(g)))) return false;
    if (blacklist.length && item.genres.some((g) => blacklist.includes(g.toLowerCase()))) return false;
    return true;
  });
}

/** The AniList ids the library already has: the links made by the Tracker and the ids stored on favorites. */
function similarAlOwnedIds() {
  const ids = new Set();
  try {
    for (const value of Object.values(typeof _alGetAllLinks === 'function' ? _alGetAllLinks() : {})) if (value) ids.add(String(value));
  } catch (_) { /* no links: nothing owned from them */ }
  for (const fav of (typeof state !== 'undefined' && state.favorites) || []) if (fav && fav.anilistId) ids.add(String(fav.anilistId));
  return ids;
}

// ── the kept answers ────────────────────────────────────────────────────────

function _similarAlRead() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SIMILAR_AL.cacheKey) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function similarAlCacheGet(key) {
  const entry = _similarAlRead()[key];
  return entry && Array.isArray(entry.items) && Date.now() - Number(entry.at || 0) < SIMILAR_AL.ttlMs ? entry : null;
}

function similarAlCacheSet(key, value) {
  try {
    const all = _similarAlRead();
    all[key] = { at: Date.now(), id: value.id, items: value.items };
    const keys = Object.keys(all);
    if (keys.length > SIMILAR_AL.cacheMax) for (const old of keys.sort((a, b) => Number(all[a].at || 0) - Number(all[b].at || 0)).slice(0, keys.length - SIMILAR_AL.cacheMax)) delete all[old];
    localStorage.setItem(SIMILAR_AL.cacheKey, JSON.stringify(all));
  } catch (_) { /* a full or blocked storage only means asking again next time */ }
}

// ── asking AniList ──────────────────────────────────────────────────────────

// Which AniList title a NAME is (checked, never the first answer of a text search) is decided in ui-anilist-match.js, for every place that has to ask.

// ── what the page already knows about which AniList title a page is ─────────

function _similarAlHintsRead() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SIMILAR_AL.hintsKey) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/** A card of this row opened a title in a source: the AniList id of the card is the AniList id of that page (no name search will be needed for it). */
function similarAlRememberHint(sourceId, mangaId, aniId) {
  const id = Number(aniId);
  if (!sourceId || !mangaId || !Number.isFinite(id) || id <= 0) return;
  try {
    const all = _similarAlHintsRead();
    all[`${sourceId}::${mangaId}`] = { id, at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > SIMILAR_AL.hintsMax) for (const old of keys.sort((a, b) => Number(all[a].at || 0) - Number(all[b].at || 0)).slice(0, keys.length - SIMILAR_AL.hintsMax)) delete all[old];
    localStorage.setItem(SIMILAR_AL.hintsKey, JSON.stringify(all));
  } catch (_) { /* the name is searched instead */ }
}

function similarAlHintFor(sourceId, mangaId) {
  const entry = _similarAlHintsRead()[`${sourceId}::${mangaId}`];
  return entry && Number(entry.id) > 0 ? Number(entry.id) : 0;
}

/**
 * { id, items } for a title: by its AniList id when known; else the AniList title that is clearly the same name (two requests: the candidates, then its
 * recommendations); null when AniList has no such title, no clear match, or cannot be asked.
 * @param {number|string|null} aniId
 * @param {string|string[]} names   the title, or the title and its alternative titles
 * @param {{ year?: number }} [known]   what else the page knows, to tell two titles of one name apart
 */
async function similarAlFetch(aniId, names, known = {}) {
  const ask = typeof anilistGQL === 'function' ? anilistGQL : null;
  if (!ask) return null;
  let id = Number(aniId) || 0;
  if (!id) {
    if (typeof anilistFindMediaId !== 'function') return null;
    id = await anilistFindMediaId({ names: Array.isArray(names) ? names : [names], year: known && known.year, author: known && known.author });
    if (!id) return null;
  }
  const body = await ask(SIMILAR_AL_QUERY_BY_ID, { id });
  const media = body && body.data && body.data.Media;
  if (!media) return null;
  return { id: Number(media.id) || 0, items: similarAlParse(media.recommendations && media.recommendations.nodes) };
}

const _similarAlTitleKey = (title) => `t:${String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`;

// ── the cards ───────────────────────────────────────────────────────────────

function similarAlCardHtml(item) {
  const score = item.score ? `<span class="similar-al-score" title="AniList: ${escapeHtml(String(item.score))}/100">&#9733; ${escapeHtml((item.score / 10).toFixed(1))}</span>` : '';
  const genres = item.genres.slice(0, 3).map((g) => `<span class="manga-card-genre">${escapeHtml(g)}</span>`).join('');
  return `
    <div class="manga-card similar-al-card" data-author-title="${escapeHtml(item.title)}" data-anilist-id="${escapeHtml(String(item.id))}" title="${escapeHtml(t('similar.findTitle'))}">
      <div class="manga-card-cover">
        ${item.cover ? `<img src="${escapeHtml(item.cover)}" alt="${escapeHtml(item.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<div class="no-cover">?</div>'}
        <span class="all-pop-source-badge">AniList</span>
        ${score}
      </div>
      <div class="manga-card-info">
        <h3 class="manga-card-title">${escapeHtml(item.title)}</h3>
        <div class="manga-card-genres">${genres}</div>
        <span class="btn-start-reading similar-al-find">${escapeHtml(t('similar.find'))}</span>
      </div>
    </div>`;
}

// One listener for the whole row (the auto-scroll clones cards, and a clone keeps no handler of its own).
function _similarAlBindRow(row) {
  if (row._similarAlBound) return;
  row._similarAlBound = true;
  row.addEventListener('click', (event) => {
    const card = event.target && event.target.closest ? event.target.closest('.similar-al-card') : null;
    if (!card || typeof _resolveAndOpenAuthorTitle !== 'function') return;
    const title = card.dataset.authorTitle || '';
    if (!title) return;
    if (typeof showToast === 'function') showToast('Searching', `Looking for "${title}" in your installed sources...`, '');
    _resolveAndOpenAuthorTitle(title, card.dataset.anilistId || '');
  });
}

function _similarAlNote(section) {
  const header = section.querySelector('.section-header');
  if (!header) return;
  header.querySelector('.similar-al-note')?.remove();
  const note = document.createElement('span');
  note.className = 'similar-al-note muted';
  note.textContent = t('similar.anilistNote');
  header.appendChild(note);
}

/**
 * Fills the "You might also like" row from AniList.
 * @param {object} result   the manga being viewed (id, title)
 * @param {string} sourceId
 * @param {{ section: HTMLElement, row: HTMLElement, isStale: () => boolean }} target
 * @returns {Promise<boolean>} whether the row now shows AniList's recommendations (false: the page keeps its own way)
 */
async function loadSimilarFromAniList(result, sourceId, { section, row, isStale }) {
  try {
    // Which AniList title this page is, best first: what the library linked it to, what the card that opened it said, else its name (checked, see anilistMatchPick).
    const linked = (typeof _alGetLink === 'function' ? _alGetLink(result && result.id) : null) || similarAlHintFor(sourceId, result && result.id) || null;
    const key = linked ? `id:${linked}` : _similarAlTitleKey(result && result.title);
    let entry = similarAlCacheGet(key);
    if (!entry) {
      const fetched = await similarAlFetch(linked, [result && result.title, result && result.altTitle], { year: result && result.year, author: result && result.author });
      if (!fetched) return false;
      entry = { id: fetched.id, items: fetched.items };
      similarAlCacheSet(key, entry);
    }
    if (isStale()) return true; // another page is open now: nothing to draw, and the page must not go on to draw its own row either
    const shown = similarAlVisible(entry.items, state.settings || {}, similarAlOwnedIds(), linked || entry.id).slice(0, SIMILAR_AL.maxToShow);
    if (shown.length < SIMILAR_AL.minToShow) return false;
    row.innerHTML = shown.map(similarAlCardHtml).join('');
    _similarAlBindRow(row);
    _similarAlNote(section);
    section.classList.remove('hidden');
    if (typeof initRowAutoScroll === 'function') initRowAutoScroll(row, () => {});
    return true;
  } catch (_) {
    return false;
  }
}

window.similarAlParse = similarAlParse;
window.similarAlVisible = similarAlVisible;
window.similarAlOwnedIds = similarAlOwnedIds;
window.similarAlCardHtml = similarAlCardHtml;
window.similarAlCacheGet = similarAlCacheGet;
window.similarAlCacheSet = similarAlCacheSet;
window.similarAlFetch = similarAlFetch;
window.similarAlRememberHint = similarAlRememberHint;
window.similarAlHintFor = similarAlHintFor;
window.loadSimilarFromAniList = loadSimilarFromAniList;
