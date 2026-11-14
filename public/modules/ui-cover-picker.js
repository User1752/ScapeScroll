// ============================================================================
// modules/ui-cover-picker.js — manga cover lookup/picker subsystem, split out
// of modules/ui-search.js to keep that file scoped to search/discovery.
// Covers: reading the currently-stored cover, persisting a newly-picked one
// (including the local-manga upload-the-bytes path, which has no
// favorites/coverOverrides entry to update), searching AniList/installed
// sources/Brave Images for candidates, and the picker modal itself.
//
// Depends on (loaded before this file by index.html):
//   modules/api.js      → api()
//   modules/state.js    → state
//   modules/utils.js    → $(), escapeHtml(), showToast(), normalizeImageUrl()
//   modules/anilist.js  → anilistGQL(), getDisplayMangaTitle()
//   modules/ui-search.js → _normalizeLookupTitle()
// ============================================================================

// BatCave (DC/Marvel) and ComicHubFree are the only Western-comics-only
// installed sources (see MIGRATE_EXCLUDED_SOURCES in ui-migrate.js for the
// same BatCave-is-not-manga distinction elsewhere) — everything else here
// defaults to "manga" the way the search term always used to, unless the
// manga's own type/genres say otherwise.
const _COVER_SEARCH_WESTERN_COMIC_SOURCES = new Set(['batcave', 'comichubfree']);

/**
 * Picks the right noun for a Brave Images cover search ("X <noun> cover")
 * instead of always assuming "manga" — a manhwa/manhua/webtoon, a web
 * comic, or a Western comic searched as "manga cover" returns
 * mostly-irrelevant results.
 * Checks the manga's own `type` field first (rarely set by scrapers), then
 * its genres/tags (reliably set — e.g. ManhwaTo's own genre list already
 * includes "Manhwa"/"Webtoons"), then falls back to a known-source list for
 * the sources that carry neither.
 */
function _coverSearchTypeLabel(manga, sourceId) {
  const type = String(manga?.type || '').toLowerCase().trim();
  if (type === 'manhwa' || type === 'manhua') return type;
  if (type === 'comic' || type === 'western') return 'comic';
  if (type === 'webcomic' || type === 'web comic') return 'webcomic';
  if (type === 'manga') return 'manga';

  const tags = [
    ...(Array.isArray(manga?.genres) ? manga.genres : []),
    ...(Array.isArray(manga?.tags) ? manga.tags : []),
  ].map(t => String(t || '').toLowerCase().trim());
  if (tags.includes('manhwa')) return 'manhwa';
  if (tags.includes('manhua')) return 'manhua';
  // "Web Comic" is its own tag distinct from manhwa/manhua on sites that use
  // it (an original English-language webcomic, not a KR/CN scanlation) —
  // checked before the generic webtoon/webtoons fallback below so it isn't
  // swallowed into "manhwa".
  if (tags.includes('webcomic') || tags.includes('web comic')) return 'webcomic';
  // "Long Strip" is MangaDex's own format tag for the same vertical-scroll
  // reading format webtoon/webtoons signals elsewhere — same fallback.
  if (tags.includes('webtoon') || tags.includes('webtoons') || tags.includes('long strip')) return 'manhwa';

  if (_COVER_SEARCH_WESTERN_COMIC_SOURCES.has(String(sourceId || '').toLowerCase())) return 'comic';

  return 'manga';
}

// Cache key is the lowercased search title, same pattern as ui-migrate.js's
// _migrateAniListVariantCache — a Brave Images search can retry through all
// 3 variants for the same manga more than once in a session (e.g. the user
// reopens the picker), and this is a real network round-trip each time.
const _coverPickerAniListTripletCache = new Map();

/**
 * Looks up a manga's AniList romaji/english/native title triplet by search
 * term, for the Brave Images fallback chain below — a manhwa/manhua's
 * scraped title is often in only one of these languages, and Brave can be
 * picky about which one actually has indexed image results.
 * Returns {romaji, english, native} (each possibly empty) or all-empty on
 * any failure (no match, rate limit, network error) — callers just get
 * fewer fallback candidates, never a thrown error.
 */
async function _fetchAniListTitleTriplet(title) {
  const key = String(title || '').trim().toLowerCase();
  const empty = { romaji: '', english: '', native: '' };
  if (!key) return empty;
  if (_coverPickerAniListTripletCache.has(key)) return _coverPickerAniListTripletCache.get(key);

  try {
    const data = await anilistGQL(
      `query ($search: String) { Media(search: $search, type: MANGA) { title { romaji english native } } }`,
      { search: title }
    );
    const t = data?.data?.Media?.title;
    const triplet = t ? { romaji: t.romaji || '', english: t.english || '', native: t.native || '' } : empty;
    _coverPickerAniListTripletCache.set(key, triplet);
    return triplet;
  } catch (_) {
    _coverPickerAniListTripletCache.set(key, empty);
    return empty;
  }
}

function _getStoredMangaCover(mangaId, sourceId) {
  const overrideKey = `${String(mangaId)}:${String(sourceId || '')}`;
  return state.coverOverrides?.[overrideKey]
    || (state.favorites || []).find(m => String(m?.id) === String(mangaId) && String(m?.sourceId || '') === String(sourceId))?.cover
    || (state.history || []).find(m => String(m?.id) === String(mangaId) && String(m?.sourceId || '') === String(sourceId))?.cover
    || '';
}

function _coverPickerSourceIds(primarySourceId) {
  const sourceIds = Object.keys(state.installedSources || {}).filter(sid => sid !== 'local');
  const ordered = [];
  if (primarySourceId && sourceIds.includes(primarySourceId)) ordered.push(primarySourceId);
  for (const sid of sourceIds) {
    if (ordered.includes(sid)) continue;
    ordered.push(sid);
  }
  return ordered.slice(0, 4);
}

function _coverChoiceKey(choice) {
  return `${String(choice?.cover || '')}::${_normalizeLookupTitle(choice?.title || '')}::${String(choice?.sourceId || choice?.provider || '')}`;
}

function _applyCoverToCurrentDetailsView(mangaId, sourceId, coverUrl) {
  if (!coverUrl) return;
  if (String(state.currentManga?.id) !== String(mangaId) || String(state.currentSourceId || '') !== String(sourceId || '')) return;
  state.currentManga = { ...state.currentManga, cover: coverUrl };
  const coverImg = $("details")?.querySelector('.manga-cover img');
  if (coverImg) coverImg.src = coverUrl;
}

// Local manga have no favorites/coverOverrides entry to update — their cover
// is whatever /api/local/list reads back from that title's own meta.json on
// disk, so the generic coverOverrides path (below) never actually reaches
// the value it needs to change. They get their own upload-the-bytes route.
async function _persistLocalMangaCover(mangaId, coverUrl) {
  const isRemote = /^https?:\/\//i.test(coverUrl);
  const fetchUrl = isRemote ? `/api/proxy-image?url=${encodeURIComponent(coverUrl)}` : coverUrl;
  const imgResp = await fetch(fetchUrl);
  if (!imgResp.ok) throw new Error('Could not download cover image');
  const blob = await imgResp.blob();

  const resp = await fetch(`/api/local/${mangaId}/cover`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'image/jpeg' },
    body: blob,
  });
  const data = await resp.json();
  if (!resp.ok || !data.success) throw new Error(data.error || 'Cover update failed');

  const idx = (state.localManga || []).findIndex(m => String(m.id) === String(mangaId));
  if (idx !== -1) state.localManga[idx].cover = data.cover;
  return data.cover;
}

async function persistMangaCover(mangaId, sourceId, coverUrl) {
  if (String(sourceId || '') === 'local') {
    const cover = await _persistLocalMangaCover(mangaId, coverUrl);
    renderLibrary();
    if (typeof renderHistoryView === 'function') renderHistoryView();
    _applyCoverToCurrentDetailsView(mangaId, sourceId, cover);
    return { ok: true, cover };
  }

  const res = await api('/api/library/cover', {
    method: 'POST',
    body: JSON.stringify({ mangaId, sourceId, cover: coverUrl })
  });
  state.favorites = res.favorites || state.favorites;
  state.history = res.history || state.history;
  state.coverOverrides = res.coverOverrides || state.coverOverrides;
  state.readingStatus = res.readingStatus || state.readingStatus;
  renderLibrary();
  if (typeof renderHistoryView === 'function') renderHistoryView();
  _applyCoverToCurrentDetailsView(mangaId, sourceId, coverUrl);
  return res;
}

async function searchAniListCoverChoices(title, page = 1, perPage = 8) {
  const data = await anilistGQL(
    `query ($search: String, $page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage }
        media(search: $search, type: MANGA, sort: SEARCH_MATCH) {
          id
          title { romaji english native }
          coverImage { extraLarge large medium }
        }
      }
    }`,
    { search: title, page, perPage }
  );
  return {
    items: (data?.data?.Page?.media || [])
      .map(item => ({
        id: item.id,
        title: item?.title?.english || item?.title?.romaji || item?.title?.native || title,
        cover: item?.coverImage?.extraLarge || item?.coverImage?.large || item?.coverImage?.medium || '',
        provider: 'AniList',
        sourceId: 'anilist',
      }))
      .filter(item => item.cover),
    hasNextPage: !!data?.data?.Page?.pageInfo?.hasNextPage,
  };
}

async function searchSourceCoverChoices(query, sourceId, page = 1) {
  const result = await api(`/api/source/${sourceId}/search`, {
    method: 'POST',
    body: JSON.stringify({ query, page })
  });
  return {
    items: (result?.results || [])
      .filter(item => item?.cover && !String(item.cover).endsWith('.pdf') && !String(item.cover).endsWith('.epub'))
      .map(item => ({
        id: item.id,
        title: item.title || query,
        cover: item.cover,
        provider: state.installedSources[sourceId]?.name || sourceId,
        sourceId,
      })),
    hasNextPage: !!result?.hasNextPage,
    rateLimited: !!result?.rateLimited,
  };
}

// What a cover needs to look sharp in the library's cards: the size of AniList's "large" cover (460 x 726), which the app already treats as a good cover and
// which is drawn at about 255 px wide, so nothing near 1080p is needed. The web image search returns whatever size each site happens to have, many of them
// thumbnails: an image below this is marked, and can be left out.
const COVER_PICKER_MIN_SIZE = Object.freeze({ width: 460, height: 726 });
const COVER_PICKER_LARGE_ONLY_KEY = 'scrollscape_cover_picker_large_only';
function coverPickerIsSmall(width, height) {
  return !(width >= COVER_PICKER_MIN_SIZE.width && height >= COVER_PICKER_MIN_SIZE.height);
}

// The web image search is paused (Brave asked for a bot check). How long Brave keeps that up is not known, so what is shown is when ScrollScape will ask
// again, counting down by itself; the clock is the wait the server reported, not a time of day, so a server and a page whose clocks differ do not matter.
function coverLimitedMessage(gridEl, retryInMs) {
  const wait = Math.max(0, Number(retryInMs) || 0);
  if (!wait) {
    gridEl.innerHTML = '<p class="muted">The web image search is being limited right now. Try again in a few minutes.</p>';
    return;
  }
  const until = Date.now() + wait;
  gridEl.innerHTML = '<p class="muted">Brave Images is limiting searches right now. ScrollScape can ask again in <strong class="cover-limit-timer"></strong>. If Brave still says no then, the wait grows. Meanwhile use "Search other sources" or paste an image address.</p>';
  const timer = gridEl.querySelector('.cover-limit-timer');
  const clock = (ms) => {
    const total = Math.ceil(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  };
  // true once the countdown has nothing left to do: it ran out, or the message was replaced (a new search, the picker closed)
  const tick = () => {
    if (!timer.isConnected) return true;
    const left = until - Date.now();
    if (left <= 0) {
      timer.closest('p').textContent = 'The pause is over. Press "Search Brave Images" to try again.';
      return true;
    }
    timer.textContent = clock(left);
    return false;
  };
  if (tick()) return;
  const id = setInterval(() => { if (tick()) clearInterval(id); }, 1000);
}

async function searchCoverChoices(query, sourceId, page = 1, mode = 'sources') {
  const sourceIds = _coverPickerSourceIds(sourceId);
  const otherSourceIds = sourceIds.filter(sid => sid !== sourceId);

  if (mode === 'google') {
    const google = await searchGoogleCoverChoices(query, page, 14).catch(() => ({ items: [], hasNextPage: false, rateLimited: false }));
    return {
      items: google.items || [],
      hasNextPage: !!google.hasNextPage,
      sourceLabels: ['Brave Images'],
      rateLimited: !!google.rateLimited,
      retryInMs: google.retryInMs || 0,
    };
  }

  const jobs = [
    searchAniListCoverChoices(query, page, 8).catch(() => ({ items: [], hasNextPage: false })),
    ...otherSourceIds.map(sid => searchSourceCoverChoices(query, sid, page).catch(() => ({ items: [], hasNextPage: false }))),
  ];
  const results = await Promise.all(jobs);
  const deduped = [];
  const seen = new Set();
  for (const block of results) {
    for (const item of (block?.items || [])) {
      const key = _coverChoiceKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }
  }
  return {
    items: deduped,
    hasNextPage: results.some(block => block?.hasNextPage),
    sourceLabels: ['AniList', ...otherSourceIds.map(sid => state.installedSources[sid]?.name || sid)],
  };
}

async function searchGoogleCoverChoices(query, page = 1, count = 14) {
  const start = Math.max(0, (page - 1) * count);
  // "Hide NSFW" also switches the web image search to SafeSearch: that grid is
  // raw search results, which none of the genre/tag hiding ever sees.
  const safe = state.settings?.hideNsfw === true ? '&safe=1' : '';
  const url = `/api/cover/google-images?q=${encodeURIComponent(query)}&start=${start}&count=${count}${safe}`;
  const result = await api(url);
  const items = Array.isArray(result?.items) ? result.items : [];
  return {
    items: items
      .filter(item => item && item.cover)
      .map(item => ({
        id: item.id,
        title: item.title || query,
        cover: item.cover,
        provider: item.provider || 'Brave Images',
        sourceId: 'google-images',
      })),
    hasNextPage: !!result?.hasNextPage,
    rateLimited: !!result?.rateLimited,
    retryInMs: Number(result?.retryInMs) || 0,
  };
}

/**
 * Opens the AniList page of a manga in a new tab. The lookup is the checked one (ui-anilist-match.js): the title the library linked it to, else the candidate that is
 * CLEARLY the same title (name, year, author). With no clear one it opens AniList's own search for the name and lets the person choose: a page of the wrong title
 * (a search for "Sugar" opened "SUG*R") is worse than none.
 * @param {string|{ id?: string, sourceId?: string, title: string, altTitle?: string, year?: number|string, author?: string }} input   a title, or what the page knows
 */
async function openAniListForManga(input) {
  const manga = input && typeof input === 'object' ? input : { title: String(input || '') };
  const title = String(manga.title || '');
  const tab = window.open('about:blank', '_blank');
  if (!tab) {
    showToast('Pop-up Blocked', 'Please allow pop-ups to open AniList.', 'error');
    return;
  }
  tab.document.write('<body style="background:#1a1a2e;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><h2>Searching AniList...</h2></body>');
  try {
    const id = typeof anilistMediaIdForManga === 'function' ? await anilistMediaIdForManga(manga) : 0;
    if (id) {
      tab.location.href = `https://anilist.co/manga/${id}`;
    } else {
      tab.location.href = `https://anilist.co/search/manga?search=${encodeURIComponent(title)}`;
    }
  } catch (e) {
    tab.location.href = `https://anilist.co/search/manga?search=${encodeURIComponent(title)}`;
  }
}
window.openAniListForManga = openAniListForManga;

// BatCave comics have no AniList presence (manga-only database). LOCG sits
// behind Cloudflare, so a precise-match lookup like openAniListForManga's
// can't be done directly from the browser here — this always opens LOCG's
// own search results and lets the user pick the right edition themselves.
function openLocgForComic(title) {
  // Strip BatCave's own trailing year annotation ("Title (2026-)", "Title
  // (1991 series)", "Title (2018-2019)") so the query is just the clean
  // series name — LOCG's own search ranks that higher than with the
  // annotation still attached.
  const cleanTitle = String(title || '').replace(/\s*\((?:\d{4}(?:-\d{4})?-?|\d{4}\s+series)\)\s*$/i, '').trim() || title;
  window.open(`https://leagueofcomicgeeks.com/search?keyword=${encodeURIComponent(cleanTitle)}`, '_blank');
}
window.openLocgForComic = openLocgForComic;

function openMangaCoverPicker(manga, options = {}) {
  const mangaId = String(manga?.id || '');
  const sourceId = String(options.sourceId || manga?.sourceId || state.currentSourceId || '');
  const title = String(manga?.title || '').trim();
  // Only Brave Images' own search (not "Search other sources", which needs
  // the scraped title to match what the source site actually indexes) uses
  // this — the user's chosen mangaTitleLanguage display name, so a Brave
  // query for e.g. a native-language toggle isn't silently forced back to
  // the English/scraped title. Falls back to the scraped title when there's
  // no reliable AniList link/variant cached yet.
  const displayTitle = (typeof getDisplayMangaTitle === 'function' ? getDisplayMangaTitle(manga) : '').trim() || title;
  const sourceCover = String(options.sourceCover || manga?._sourceCover || manga?.cover || '').trim();
  const currentCover = String(options.currentCover || manga?.cover || _getStoredMangaCover(mangaId, sourceId) || '').trim();

  if (!mangaId || !sourceId || !title) {
    showToast('Cover error', 'Missing manga data.', 'error');
    return;
  }

  document.getElementById('coverPickerModal')?.remove();
  document.documentElement.classList.remove('cover-picker-open');
  document.body.classList.remove('cover-picker-open');
  const modal = document.createElement('div');
  modal.id = 'coverPickerModal';
  modal.className = 'settings-modal';
  modal.innerHTML = `
    <div class="settings-content cover-picker-modal-content">
      <div class="settings-header">
        <h2>Choose Cover</h2>
        <button class="btn btn-secondary" id="coverPickerClose">Close</button>
      </div>
      <div class="cover-picker-body">
        <div class="cover-picker-column">
          <p class="cover-picker-label">Current cover</p>
          <div class="cover-picker-current">
            ${currentCover ? `<img src="${escapeHtml(normalizeImageUrl(currentCover))}" alt="${escapeHtml(title)}">` : `<div class="no-cover">?</div>`}
          </div>
          <div class="cover-picker-actions">
            ${sourceCover ? `<button class="btn btn-secondary" id="coverPickerUseSource">Use Source Cover</button>` : ''}
            <button class="btn btn-secondary" id="coverPickerSearchSources">Search other sources</button>
            <button class="btn btn-secondary" id="coverPickerGoogle">Search Brave Images</button>
          </div>
        </div>
        <div class="cover-picker-column cover-picker-column-wide">
          <div class="cover-picker-search-bar">
            <input id="coverPickerSearchInput" class="input cover-picker-search-input" type="search" value="${escapeHtml(title)}" placeholder="Search covers...">
            <button class="btn" id="coverPickerSearchRun">Search</button>
          </div>
          <p class="cover-picker-label">Search results</p>
          <div class="cover-picker-search-meta muted" id="coverPickerSearchMeta"></div>
          <label class="cover-picker-filter" id="coverPickerFilter" hidden><input type="checkbox" id="coverPickerLargeOnly"><span>Only large images</span><small class="muted" id="coverPickerHiddenCount"></small></label>
          <div class="cover-picker-loading-bar" id="coverPickerLoadingBar"><div class="cover-picker-loading-bar-fill"></div></div>
          <div class="cover-picker-grid muted" id="coverPickerSuggestions">Loading cover suggestions...</div>
          <div class="cover-picker-load-more-wrap">
            <button class="btn btn-secondary" id="coverPickerLoadMore">Load more</button>
          </div>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  document.documentElement.classList.add('cover-picker-open');
  document.body.classList.add('cover-picker-open');

  const closePicker = () => {
    document.documentElement.classList.remove('cover-picker-open');
    document.body.classList.remove('cover-picker-open');
    modal.remove();
  };

  modal.onclick = (e) => { if (e.target === modal) closePicker(); };
  document.getElementById('coverPickerClose').onclick = closePicker;

  const closeAfterApply = async (coverUrl) => {
    if (!coverUrl) return;
    try {
      await persistMangaCover(mangaId, sourceId, coverUrl);
      closePicker();
      showToast('Cover updated', 'Saved to your library data.', 'success');
    } catch (e) {
      showToast('Cover error', 'Could not search covers.', 'error');
    }
  };

  const sourceBtn = document.getElementById('coverPickerUseSource');
  if (sourceBtn) sourceBtn.onclick = () => closeAfterApply(sourceCover);

  const gridEl = document.getElementById('coverPickerSuggestions');
  const metaEl = document.getElementById('coverPickerSearchMeta');
  const loadingBarEl = document.getElementById('coverPickerLoadingBar');
  const searchInput = document.getElementById('coverPickerSearchInput');
  const loadMoreBtn = document.getElementById('coverPickerLoadMore');
  const pickerState = {
    query: title,
    mode: 'sources',
    page: 1,
    seen: new Set(),
    hasNextPage: false,
    loading: false,
    // Bumped by every search entry point (the initial auto-search, "Search
    // other sources", "Search Brave Images", the manual search box, "Load
    // more") the instant it starts. Each entry point captures its own value
    // right after bumping and checks it against pickerState.searchGen
    // before writing any result to the DOM — if a newer search has started
    // in the meantime, the check fails and the stale response is silently
    // dropped instead of applied. Without this, two searches racing (e.g.
    // the modal's own default "sources" auto-search still in flight when
    // the user immediately clicks "Search Brave Images") can interleave
    // their writes to the same grid/meta elements in an arbitrary order —
    // confirmed live: the slower one finishing last could overwrite a
    // faster, successful "14 results" render with "No cover results found"
    // while leaving the old "14 result(s)" meta text untouched, since nothing
    // tied a response back to the search that actually produced it.
    searchGen: 0,
  };

  const renderChoiceCards = (choices, append = false) => {
    const html = choices.map(choice => `
      <button class="cover-choice-card" data-cover-url="${escapeHtml(choice.cover)}" title="${escapeHtml(choice.title)}">
        <span class="cover-choice-thumb"><img src="${escapeHtml(normalizeImageUrl(choice.cover))}" alt="${escapeHtml(choice.title)}" loading="lazy"><span class="cover-choice-res" aria-hidden="true"></span></span>
        <span class="cover-choice-title">${escapeHtml(choice.title)}</span>
        <span class="cover-choice-source">${escapeHtml(choice.provider || '')}</span>
      </button>`).join('');
    if (!append) gridEl.innerHTML = html;
    else gridEl.insertAdjacentHTML('beforeend', html);
    gridEl.querySelectorAll('.cover-choice-card[data-cover-url]').forEach((btn) => {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.onclick = () => closeAfterApply(btn.dataset.coverUrl || '');
    });
    watchResolutions();
  };

  // The size of each image, read from the image itself once it has loaded: written on its card, and a small one is marked (and left out
  // when "Only large images" is on, which only the web image search offers: the covers of the sources and AniList are what they are).
  const largeOnlyBox = document.getElementById('coverPickerLargeOnly');
  const filterEl = document.getElementById('coverPickerFilter');
  const hiddenCountEl = document.getElementById('coverPickerHiddenCount');
  const readLargeOnly = () => { try { return localStorage.getItem(COVER_PICKER_LARGE_ONLY_KEY) !== '0'; } catch (_) { return true; } };
  if (largeOnlyBox) largeOnlyBox.checked = readLargeOnly();
  const syncFilter = () => {
    const web = pickerState.mode === 'google';
    const on = web && !!(largeOnlyBox && largeOnlyBox.checked);
    if (filterEl) filterEl.hidden = !web;
    gridEl.classList.toggle('hide-small', on);
    const small = gridEl.querySelectorAll('.cover-choice-card.is-small').length;
    if (hiddenCountEl) hiddenCountEl.textContent = on && small ? `(${small} hidden)` : '';
  };
  const noteResolution = (img) => {
    const card = img.closest('.cover-choice-card');
    if (!card || !img.naturalWidth) return;
    card.querySelector('.cover-choice-res').textContent = `${img.naturalWidth}×${img.naturalHeight}`;
    card.classList.toggle('is-small', coverPickerIsSmall(img.naturalWidth, img.naturalHeight));
    syncFilter();
  };
  const watchResolutions = () => {
    gridEl.querySelectorAll('.cover-choice-card img').forEach((img) => {
      if (img.dataset.watched === '1') return;
      img.dataset.watched = '1';
      if (img.complete && img.naturalWidth) noteResolution(img);
      else img.addEventListener('load', () => noteResolution(img));
    });
  };
  if (largeOnlyBox) {
    largeOnlyBox.onchange = () => {
      try { localStorage.setItem(COVER_PICKER_LARGE_ONLY_KEY, largeOnlyBox.checked ? '1' : '0'); } catch (_) { /* the choice is only not remembered */ }
      syncFilter();
    };
  }

  const updateLoadMoreVisibility = () => {
    if (!loadMoreBtn) return;
    loadMoreBtn.style.display = pickerState.hasNextPage ? '' : 'none';
    loadMoreBtn.disabled = pickerState.loading;
  };

  async function runCoverSearch(reset = false) {
    if (pickerState.loading) return;
    const myGen = ++pickerState.searchGen;
    const nextQuery = (searchInput?.value || '').trim() || title;
    pickerState.loading = true;
    if (reset) {
      pickerState.query = nextQuery;
      pickerState.page = 1;
      pickerState.seen.clear();
      gridEl.classList.add('muted');
      gridEl.innerHTML = 'Searching covers...';
    } else {
      pickerState.page += 1;
    }
    const modeLabel = pickerState.mode === 'google' ? 'Brave Images' : 'AniList + other sources';
    metaEl.textContent = `Searching ${modeLabel} for "${nextQuery}"...`;
    syncFilter();
    if (loadingBarEl) loadingBarEl.classList.add('active');
    updateLoadMoreVisibility();
    try {
      const data = await searchCoverChoices(nextQuery, sourceId, pickerState.page, pickerState.mode);
      // A different search (mode switch, manual re-search, "Search Brave
      // Images", etc.) started after this one and may have already resolved
      // — see pickerState.searchGen's comment. Drop this stale response
      // instead of clobbering whatever that newer search rendered.
      if (myGen !== pickerState.searchGen) return;
      const fresh = (data.items || []).filter(choice => {
        const key = _coverChoiceKey(choice);
        if (pickerState.seen.has(key)) return false;
        pickerState.seen.add(key);
        return true;
      });
      pickerState.hasNextPage = !!data.hasNextPage;
      gridEl.classList.remove('muted');
      if (!fresh.length && pickerState.page === 1) {
        // A search the web image engine refused is not a search that found nothing: say which, so the person knows to wait and not to retype the title.
        if (data.rateLimited) coverLimitedMessage(gridEl, data.retryInMs);
        else gridEl.innerHTML = '<p class="muted">No cover results found. Try a shorter title.</p>';
      } else if (!fresh.length) {
        showToast('Cover search', 'No more results found.', 'info');
      } else {
        renderChoiceCards(fresh, !reset && pickerState.page > 1);
      }
      metaEl.textContent = `${pickerState.seen.size} result(s) from ${data.sourceLabels.join(' + ')}.`;
    } catch (e) {
      if (myGen !== pickerState.searchGen) return;
      pickerState.hasNextPage = false;
      gridEl.classList.remove('muted');
      gridEl.innerHTML = '<p class="muted">Could not load cover search results.</p>';
      metaEl.textContent = 'Cover search failed.';
    } finally {
      if (myGen === pickerState.searchGen) {
        pickerState.loading = false;
        if (loadingBarEl) loadingBarEl.classList.remove('active');
        updateLoadMoreVisibility();
      }
    }
  }

  // Tries each candidate query in turn — sequentially, not in parallel,
  // since Brave's own scrape can take several seconds per query (sometimes
  // routed through FlareSolverr's real-browser fallback). A candidate's
  // results get APPENDED to whatever's already showing instead of
  // replacing it, and trying more candidates never clears what an earlier
  // one already found — across 2-4 fallback attempts that could otherwise
  // be 20-40s of a static "Searching..." with nothing to show for it,
  // which reads as a hang even though it's still working. Stops early once
  // there's a reasonable number of results to look at, or once every
  // candidate has been tried, OR immediately once a candidate comes back
  // rate-limited — trying further candidates against an endpoint that just
  // told us to back off would only extend its cooldown further (see
  // server/modules/cover-search/index.js). Returns { found, rateLimited }.
  const COVER_FALLBACK_ENOUGH_RESULTS = 8;
  // myGen ties this whole candidate chain back to the search that started it
  // (see pickerState.searchGen's comment) — every candidate in the loop
  // shares it, since they're all part of the same logical search, but the
  // chain as a whole is abandoned the instant a genuinely different search
  // starts (a mode switch, a fresh manual search) while it's still running.
  async function _tryCoverCandidates(candidates, myGen) {
    let anyFound = pickerState.seen.size > 0;
    for (let i = 0; i < candidates.length; i++) {
      if (myGen !== pickerState.searchGen) return { found: anyFound, rateLimited: false };
      const candidate = candidates[i];
      if (!candidate) continue;
      if (pickerState.seen.size >= COVER_FALLBACK_ENOUGH_RESULTS) break;

      if (searchInput) searchInput.value = candidate;
      pickerState.query = candidate;
      pickerState.page = 1;
      if (!anyFound) {
        gridEl.classList.add('muted');
        gridEl.innerHTML = 'Searching covers...';
      }
      const modeLabel = pickerState.mode === 'google' ? 'Brave Images' : 'AniList + other sources';
      metaEl.textContent = candidates.length > 1
        ? `Searching ${modeLabel} for "${candidate}" (${i + 1}/${candidates.length})...`
        : `Searching ${modeLabel} for "${candidate}"...`;
      if (loadingBarEl) loadingBarEl.classList.add('active');
      pickerState.loading = true;
      try {
        const data = await searchCoverChoices(candidate, sourceId, 1, pickerState.mode);
        if (myGen !== pickerState.searchGen) return { found: anyFound, rateLimited: false };
        if (data.rateLimited) {
          return { found: anyFound, rateLimited: true, retryInMs: data.retryInMs || 0 };
        }
        const fresh = (data.items || []).filter(choice => {
          const key = _coverChoiceKey(choice);
          if (pickerState.seen.has(key)) return false;
          pickerState.seen.add(key);
          return true;
        });
        pickerState.hasNextPage = !!data.hasNextPage;
        if (fresh.length) {
          gridEl.classList.remove('muted');
          renderChoiceCards(fresh, anyFound);
          metaEl.textContent = `${pickerState.seen.size} result(s) from ${data.sourceLabels.join(' + ')}.`;
          anyFound = true;
        }
      } catch (_) {
        // This candidate failed outright — move on to the next one rather
        // than aborting the whole chain over one bad attempt.
      } finally {
        if (myGen === pickerState.searchGen) {
          pickerState.loading = false;
          if (loadingBarEl) loadingBarEl.classList.remove('active');
          updateLoadMoreVisibility();
        }
      }
    }
    return { found: anyFound, rateLimited: false };
  }

  // Only shown once every phase (primary query, then fallback title
  // variants) has actually been exhausted — writing this straight from
  // _tryCoverCandidates itself would flash "no results" between the
  // primary attempt failing and the fallback phase starting.
  function _showNoCoverResults() {
    gridEl.classList.remove('muted');
    gridEl.innerHTML = '<p class="muted">No cover results found. Try a shorter title.</p>';
    metaEl.textContent = 'Cover search failed.';
  }

  function _showCoverRateLimited(retryInMs) {
    gridEl.classList.remove('muted');
    coverLimitedMessage(gridEl, retryInMs);
    metaEl.textContent = 'Rate-limited by Brave Images.';
  }

  document.getElementById('coverPickerGoogle').onclick = async () => {
    pickerState.mode = 'google';
    const myGen = ++pickerState.searchGen;
    const rawInput = (searchInput?.value || '').trim();
    // If the box still holds the untouched scraped title, search Brave with
    // the user's chosen display-language title instead — but if they typed
    // their own query (or a fallback candidate already swapped it in),
    // respect that instead of overriding it.
    const base = (rawInput && rawInput !== title) ? rawInput : (displayTitle || rawInput || title);
    const typeLabel = _coverSearchTypeLabel(manga, sourceId);
    const primaryQuery = /cover/i.test(base) ? base : `${base} ${typeLabel} cover`;

    // Fresh start for this button click — otherwise leftover results from
    // whatever search ran before (the modal's own initial "sources" mode
    // auto-search, or an earlier click) would still count toward
    // _tryCoverCandidates' "already found something" check and leak into
    // the grid alongside these new Brave results.
    pickerState.seen.clear();
    gridEl.classList.add('muted');
    gridEl.innerHTML = 'Searching covers...';

    const primaryResult = await _tryCoverCandidates([primaryQuery], myGen);
    if (myGen !== pickerState.searchGen) return;
    if (primaryResult.found) return;
    if (primaryResult.rateLimited) { _showCoverRateLimited(primaryResult.retryInMs); return; }

    // Primary title came back empty — a manhwa/manhua's scraped title is
    // often in just one language, so before giving up, try AniList's other
    // title variants rather than making the user retype it by hand. Capped
    // to english + native (dropping romaji) — each candidate here is a real
    // outbound Brave request, and every one beyond the primary compounds
    // the risk of tripping Brave's own rate limit on a single "Change
    // Cover" click (confirmed live: a real 429 after just a couple of
    // manual cover changes each needing this fallback). Romaji is the one
    // most often redundant with the primary query anyway — for Japanese
    // titles it's frequently identical to (or a near match of) the
    // already-scraped source title, unlike native script or the English
    // title, which are the two most likely to actually differ from it.
    const triplet = await _fetchAniListTitleTriplet(base.replace(new RegExp(`\\s*${typeLabel}\\s*cover$`, 'i'), '') || title);
    if (myGen !== pickerState.searchGen) return;
    const altCandidates = [triplet.english, triplet.native]
      .map(t => String(t || '').trim())
      .filter(t => t && t.toLowerCase() !== base.toLowerCase())
      .filter((t, i, arr) => arr.indexOf(t) === i)
      .map(t => `${t} ${typeLabel} cover`);
    const fallbackResult = altCandidates.length
      ? await _tryCoverCandidates(altCandidates, myGen)
      : { found: false, rateLimited: false };
    if (myGen !== pickerState.searchGen) return;
    if (fallbackResult.rateLimited) _showCoverRateLimited(fallbackResult.retryInMs);
    else if (!fallbackResult.found) _showNoCoverResults();
  };

  document.getElementById('coverPickerSearchSources').onclick = () => {
    pickerState.mode = 'sources';
    runCoverSearch(true);
  };

  document.getElementById('coverPickerSearchRun').onclick = () => runCoverSearch(true);
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    runCoverSearch(true);
  });
  loadMoreBtn.onclick = () => runCoverSearch(false);
  runCoverSearch(true);
}

window.openMangaCoverPicker = openMangaCoverPicker;
