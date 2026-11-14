// ============================================================================
// SEARCH & MANGA DETAILS
// ============================================================================

let _liveSearchTimer = null;
const _chapterAnyTitleCache = new Map();

function _chapCacheKey(sourceId, mangaId) {
  return `${sourceId || ''}:${mangaId || ''}`;
}

function _limitMapSize(map, maxSize = 600) {
  if (!map || map.size <= maxSize) return;
  const firstKey = map.keys().next().value;
  if (firstKey !== undefined) map.delete(firstKey);
}

function _extractKnownChapterCount(manga) {
  const candidates = [manga?.chapterCount, manga?.chaptersCount, manga?.latestChapter, manga?.lastChapter, manga?.chapters];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(String(value).trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

async function _fetchChapterCount(sourceId, mangaId) {
  if (!sourceId || !mangaId) return 0;

  const key = _chapCacheKey(sourceId, mangaId);
  const cached = Number(state.chapterCountCache?.[key]);
  if (Number.isFinite(cached) && cached >= 0) return cached;

  try {
    const result = await api(`/api/source/${sourceId}/chapters`, {
      method: 'POST',
      body: JSON.stringify({ mangaId }),
    });
    const count = Array.isArray(result?.chapters) ? result.chapters.length : 0;
    state.chapterCountCache[key] = count;
    return count;
  } catch (_) {
    return 0;
  }
}

async function _findBestMangaIdByTitle(sourceId, title) {
  if (!sourceId || !title) return '';
  try {
    const result = await api(`/api/source/${sourceId}/search`, {
      method: 'POST',
      body: JSON.stringify({ query: title, page: 1 }),
    });
    let best = null;
    for (const candidate of (result?.results || []).slice(0, 10)) {
      if (!candidate?.id) continue;
      const sim = _titleScore(title, candidate.title || '');
      if (sim < 0.7) continue;
      if (!best || sim > best.sim) best = { id: candidate.id, sim };
    }
    return best?.id || '';
  } catch (_) {
    return '';
  }
}

async function _hasAnySourceChapters(manga, preferredSourceId) {
  if (!manga?.id) return false;

  const knownCount = _extractKnownChapterCount(manga);
  if (Number.isFinite(knownCount) && knownCount > 0) return true;

  const currentCount = await _fetchChapterCount(preferredSourceId, manga.id);
  if (currentCount > 0) return true;

  const titleKey = _normalizeLookupTitle(manga.title || manga.id);
  if (titleKey && _chapterAnyTitleCache.has(titleKey)) return _chapterAnyTitleCache.get(titleKey) === true;

  const sourceIds = Object.keys(state.installedSources || {}).filter(sid => sid !== 'local' && sid !== preferredSourceId);
  for (const sid of sourceIds) {
    const matchId = await _findBestMangaIdByTitle(sid, manga.title || '');
    if (!matchId) continue;
    const count = await _fetchChapterCount(sid, matchId);
    if (count > 0) {
      if (titleKey) {
        _chapterAnyTitleCache.set(titleKey, true);
        _limitMapSize(_chapterAnyTitleCache);
      }
      return true;
    }
  }

  if (titleKey) {
    _chapterAnyTitleCache.set(titleKey, false);
    _limitMapSize(_chapterAnyTitleCache);
  }
  return false;
}

async function _filterMangaWithoutChapters(results, sourceId) {
  // The original implementation made a /chapters API call for every search result,
  // and if 0, searched every other source. This causes the UI to hang on "Searching..."
  // for minutes or hours due to massive backend API spam and timeouts.
  return Array.isArray(results) ? results : [];
}

// ── Pagination helper ───────────────────────────────────────────────────────
// Only a handful of sources can report a real, query-specific total page
// count (MangaDex via its own `total` field, KingOfShojo/MangaKatana via
// their "1 2 3 … N" numbered pagination) — everyone else only ever knows
// "is there a next page", so `totalPages` is undefined for them and this
// just falls back to the plain "Page X" it always showed.
function formatLoadedStatus(loadedCount) {
  return `${loadedCount} result(s) loaded`;
}

// ── Infinite-scroll "load more" controller ──────────────────────────────────
// Replaces numbered Prev/Next pagination for search results: a small
// sentinel element sits where the pagination controls used to be, and an
// IntersectionObserver fires the caller's onLoadMore() once it scrolls near
// the bottom. One instance is created per results host (search vs advanced
// search) and reused across searches — attach()/showEnd()/clear() all
// tear down any previous observer first, so switching searches never leaves
// a stale observer watching a detached sentinel.
function createLoadMoreController(hostId) {
  let observer = null;
  let loading = false;

  function disconnect() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  function clear() {
    disconnect();
    const host = $(hostId);
    if (host) host.innerHTML = "";
  }

  function showEnd(message = "No more results.") {
    disconnect();
    const host = $(hostId);
    if (host) host.innerHTML = `<div class="load-more-status load-more-end">${escapeHtml(message)}</div>`;
  }

  async function trigger(onLoadMore) {
    if (loading) return;
    loading = true;
    const statusEl = $(hostId)?.querySelector(".load-more-status");
    if (statusEl) statusEl.textContent = "Loading more…";
    try {
      await onLoadMore();
    } catch (_) {
      showEnd("Could not load more results.");
    } finally {
      loading = false;
    }
  }

  function attach(onLoadMore) {
    const host = $(hostId);
    if (!host) return;
    disconnect();
    host.innerHTML = `<div class="load-more-sentinel"><span class="load-more-status"></span></div>`;
    const sentinel = host.querySelector(".load-more-sentinel");
    // Start loading a bit before the sentinel is actually on screen so
    // scrolling doesn't visibly stall waiting for the network.
    observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) trigger(onLoadMore);
    }, { rootMargin: "400px 0px 0px 0px" });
    observer.observe(sentinel);
  }

  return {
    show(hasNextPage, onLoadMore) {
      if (!hasNextPage) { showEnd(); return; }
      attach(onLoadMore);
    },
    clear,
  };
}

const _searchLoadMore = createLoadMoreController("searchPagination");

function normalizeSourceSearchResult(raw, sourceId) {
  if (!raw || typeof raw !== 'object') return null;

  const url = String(raw.url || raw.href || raw.sourceUrl || '').trim();

  let id = String(
    raw.id ||
    raw.mangaId ||
    raw.slug ||
    ''
  ).trim();

  if (!id || id === 'undefined' || id === 'null') {
    const match = url.match(/\/manga\/([^/?#]+)/i);
    if (match) id = decodeURIComponent(match[1]);
  }

  const title = String(raw.title || raw.name || '').trim();

  if (!id || id === 'undefined' || !title) {
    if (window.SCROLLSCAPE_DEBUG_SOURCE_HEALTH) {
      console.warn('[ScrollScape] Dropping invalid search result', {
        sourceId,
        raw,
        resolvedId: id,
        title,
        url
      });
    }
    return null;
  }

  return {
    ...raw,
    id,
    mangaId: id,
    slug: String(raw.slug || id).trim(),
    sourceId: String(raw.sourceId || raw.source || sourceId || '').trim(),
    title,
    url
  };
}

// ── Main search ─────────────────────────────────────────────────────────────

// Shared by single-source search and searchAllSources(): normalizes raw
// source results, applies the NSFW/genre-blacklist filter, then drops
// manga with zero chapters. Pulled out of search() so both paths stay in
// sync instead of drifting apart.
async function _processSearchResults(rawResults, sourceId, query) {
  const normalizedResults = (rawResults || [])
    .map(m => normalizeSourceSearchResult(m, sourceId))
    .filter(Boolean);

  if (window.SCROLLSCAPE_DEBUG_SOURCE_HEALTH && normalizedResults.length === 0 && query && query !== '*') {
    console.log({
      area: sourceId,
      code: "NO_RESULTS",
      errorLabel: `${sourceId} search returned no results for valid query`,
      suggestedAction: "Check source site or try fallback.",
      cooldownUntil: null,
      retryAllowed: true,
      query: query,
      rawResultsLength: (rawResults || []).length
    });
  }

  const blacklist = state.settings.genreBlacklist || [];
  const results = normalizedResults.filter(m => {
    if (state.settings.hideNsfw && isNsfwManga(m)) return false;
    if (blacklist.length > 0 && Array.isArray(m.genres)) {
      const lowerGenres = m.genres.map(g => typeof g === 'string' ? g.toLowerCase() : '');
      if (lowerGenres.some(g => blacklist.includes(g))) return false;
    }
    return true;
  });
  return _filterMangaWithoutChapters(results, sourceId);
}

window.search = async function search(page = 1, isLoadMore = false) {
  const query = $("searchInput").value.trim();
  const dropdown = $("searchDropdown");
  const searchAllToggle = $("searchAllSourcesToggle");
  const allSources = !!(searchAllToggle && searchAllToggle.checked);

  if (!allSources && !state.currentSourceId) { $("searchStatus").textContent = "Select a source first."; return; }
  if (!query) {
    if (dropdown) { dropdown.innerHTML = ""; dropdown.classList.remove("grouped-by-source"); }
    $("searchStatus").textContent = "";
    _searchLoadMore.clear();
    return;
  }

  if (allSources) { _searchLoadMore.clear(); return searchAllSources(query); }

  state.searchQuery = query;
  state.searchPage = page;
  if (!isLoadMore) $("searchStatus").textContent = "Searching...";
  try {
    const result = await api(`/api/source/${state.currentSourceId}/search`, {
      method: "POST",
      body: JSON.stringify({ query, page })
    });
    const chapterFiltered = await _processSearchResults(result.results, state.currentSourceId, query);
    const hasNextPage = result.hasNextPage || false;
    state.searchHasNextPage = hasNextPage;
    if (!dropdown) return;
    dropdown.classList.remove("grouped-by-source");

    if (!isLoadMore) {
      if (!chapterFiltered.length) {
        dropdown.innerHTML = `<div class="muted" style="padding:1rem">No results found for "${escapeHtml(query)}"</div>`;
        $("searchStatus").textContent = "0 result(s) found";
        _searchLoadMore.show(false);
        return;
      }
      dropdown.innerHTML = chapterFiltered.map(m => mangaCardHTML(m)).join("");
    } else if (chapterFiltered.length) {
      dropdown.insertAdjacentHTML("beforeend", chapterFiltered.map(m => mangaCardHTML(m)).join(""));
    }
    bindMangaCards(dropdown);
    if (typeof _hydrateMissingGenres === 'function') _hydrateMissingGenres(dropdown);
    const loadedCount = dropdown.querySelectorAll(".manga-card").length;
    $("searchStatus").textContent = formatLoadedStatus(loadedCount);
    _searchLoadMore.show(hasNextPage, () => search(page + 1, true));
  } catch (e) {
    if (!isLoadMore) {
      $("searchStatus").textContent = "Could not search manga.";
      _searchLoadMore.clear();
    } else {
      throw e; // let the load-more controller show its "could not load more" state
    }
  }
}

// How many results a source reveals at a time in "Search all sources" —
// not a hard cap: each source's group has its own "+N more" button once
// there's more to show, either already fetched-but-hidden or via the
// source's next native page. Switch the source dropdown to a single
// source for the full infinite-scroll experience instead.
const SEARCH_ALL_SOURCES_REVEAL_CHUNK = 20;
// How many sources are queried in parallel at once. Several installed
// sources share the same FlareSolverr instance to get past Cloudflare —
// firing all of them at once just queues them up behind each other, so a
// small worker pool (matching the pattern already used for genre
// hydration in ui-discover.js) keeps things moving without hammering it.
const SEARCH_ALL_SOURCES_CONCURRENCY = 3;

// ── "Search all sources" per-source reveal controller ───────────────────────
// Shared by searchAllSources() here and advancedSearchAllSources() in
// ui-advanced-search.js. Each source keeps an unbounded local pool of
// already-fetched-and-filtered results; clicking "+N more" reveals the next
// chunk from that pool first (no network needed) and only fetches the
// source's next native page once the pool is actually exhausted.
// fetchPage(nativePage) must resolve to { items, hasNextPage }, already
// normalized/filtered by the caller.
function _appendMangaCardsToGrid(gridEl, items) {
  if (!gridEl || !items.length) return;
  gridEl.insertAdjacentHTML("beforeend", items.map(m => mangaCardHTML(m)).join(""));
  bindMangaCards(gridEl);
  if (typeof _hydrateMissingGenres === 'function') _hydrateMissingGenres(gridEl);
}

// Bounds how many native pages ONE reveal (initial or "+N more" click) will
// fetch trying to fill a single chunk — a heavily filtered source could
// otherwise need many native pages to yield even one chunk-worth of
// matches. Same reasoning as advancedSearch()'s per-round fill-up cap.
const SOURCE_REVEAL_MAX_FETCH_ATTEMPTS = 20;

function createSourceRevealController({ groupEl, chunkSize, fetchPage }) {
  const statusEl = groupEl?.querySelector(".search-source-group-status");
  const gridEl = groupEl?.querySelector(".search-source-group-grid");
  const moreEl = groupEl?.querySelector(".search-source-group-more");

  let pool = [];
  let shown = 0;
  let nativePage = 0;
  let hasMoreNative = true;
  let loading = false;

  function renderMoreButton() {
    if (!moreEl) return;
    const hasMore = pool.length > shown || hasMoreNative;
    if (!hasMore) { moreEl.innerHTML = ""; return; }
    moreEl.innerHTML = `<button class="btn secondary search-source-load-more-btn" type="button">+${chunkSize} more</button>`;
    moreEl.querySelector("button").onclick = loadMore;
  }

  function revealNextChunk() {
    const chunk = pool.slice(shown, shown + chunkSize);
    _appendMangaCardsToGrid(gridEl, chunk);
    shown += chunk.length;
    if (statusEl) statusEl.textContent = shown ? `${shown} result(s)` : "No results";
    return chunk.length;
  }

  // Fetches native pages (bounded) until the pool has enough unshown items
  // for a full chunk, or the source is genuinely exhausted.
  async function ensurePoolHasChunk() {
    const target = shown + chunkSize;
    let attempts = 0;
    while (pool.length < target && hasMoreNative && attempts < SOURCE_REVEAL_MAX_FETCH_ATTEMPTS) {
      attempts++;
      nativePage += 1;
      const { items, hasNextPage } = await fetchPage(nativePage);
      pool.push(...items);
      hasMoreNative = hasNextPage;
    }
  }

  async function loadMore() {
    if (loading) return;
    loading = true;
    if (moreEl) moreEl.innerHTML = `<span class="load-more-status">Loading more…</span>`;
    try {
      await ensurePoolHasChunk();
      revealNextChunk();
    } catch (e) {
      if (moreEl) moreEl.innerHTML = `<span class="load-more-status">Could not load more results.</span>`;
      loading = false;
      return;
    }
    loading = false;
    renderMoreButton();
  }

  return {
    async loadFirstPage() {
      try {
        await ensurePoolHasChunk();
        const shownCount = revealNextChunk();
        if (shownCount === 0 && !hasMoreNative) {
          if (groupEl) groupEl.style.display = "none";
        } else {
          renderMoreButton();
        }
        return shownCount;
      } catch (e) {
        if (statusEl) statusEl.textContent = "Unavailable";
        if (groupEl) groupEl.style.display = "none";
        throw e;
      }
    },
  };
}

async function searchAllSources(query) {
  const dropdown = $("searchDropdown");
  const pg = $("searchPagination");
  if (pg) pg.innerHTML = "";
  if (!dropdown) return;

  const sources = getSelectableSources();
  if (!sources.length) {
    $("searchStatus").textContent = "No installed sources to search.";
    dropdown.classList.remove("grouped-by-source");
    dropdown.innerHTML = "";
    return;
  }

  state.searchQuery = query;
  state.searchPage = 1;
  $("searchStatus").textContent = `Searching ${sources.length} source(s)...`;

  dropdown.classList.add("grouped-by-source");
  dropdown.innerHTML = sources.map(s => `
    <div class="search-source-group" data-source-id="${escapeHtml(s.id)}">
      <div class="search-source-group-header">
        <span class="search-source-group-name">${escapeHtml(s.name)}</span>
        <span class="search-source-group-status">Searching…</span>
      </div>
      <div class="search-source-group-grid"></div>
      <div class="search-source-group-more"></div>
    </div>
  `).join("");

  let totalShown = 0;
  let doneCount = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < sources.length) {
      const source = sources[cursor++];
      const groupEl = dropdown.querySelector(`.search-source-group[data-source-id="${source.id}"]`);

      const controller = createSourceRevealController({
        groupEl,
        chunkSize: SEARCH_ALL_SOURCES_REVEAL_CHUNK,
        fetchPage: async (nativePage) => {
          const result = await api(`/api/source/${source.id}/search`, {
            method: "POST",
            body: JSON.stringify({ query, page: nativePage })
          });
          const items = await _processSearchResults(result.results, source.id, query);
          return { items, hasNextPage: result.hasNextPage || false };
        },
      });

      try {
        totalShown += await controller.loadFirstPage();
      } catch (e) {
        // controller already set the "Unavailable" state on the group
      }

      doneCount++;
      $("searchStatus").textContent = doneCount < sources.length
        ? `Searching... (${doneCount}/${sources.length} sources done, ${totalShown} result(s) so far)`
        : `${totalShown} result(s) shown across ${sources.length} source(s)`;
    }
  }

  await Promise.all(Array.from({ length: Math.min(SEARCH_ALL_SOURCES_CONCURRENCY, sources.length) }, worker));
}

function toggleSourceSwitchDropdown(e) {
  e.stopPropagation();
  const dropdown = $("sourceSwitchDropdown");
  if (!dropdown) return;
  const isHidden = dropdown.classList.contains("hidden");
  // Close any other open ones first
  document.querySelectorAll(".source-switch-dropdown").forEach(d => d.classList.add("hidden"));
  if (isHidden) {
    // Rebuild items in case sources changed
    const installed = getSelectableSources().filter(s => s.id !== state.currentSourceId);
    if (installed.length === 0) { showToast("No other sources installed", "", "info"); return; }
    const title = state.currentManga?.title || "";
    dropdown.innerHTML = installed.map(s =>
      `<button class="source-switch-item" onclick="switchToSourceSearch(${inlineJsArg(s.id)},${inlineJsArg(title)})">${escapeHtml(s.name)}</button>`
    ).join("");
    dropdown.classList.remove("hidden");
    setTimeout(() => document.addEventListener("click", _closeSrcDropdown, { once: true }), 0);
  }
}

function _closeSrcDropdown() {
  document.querySelectorAll(".source-switch-dropdown").forEach(d => d.classList.add("hidden"));
}

function showSourceSwitchChoiceModal(sourceId, title, choices) {
  document.getElementById('sourceSwitchChoiceModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'sourceSwitchChoiceModal';
  modal.className = 'settings-modal';
  
  const rows = choices.map(c => `
    <div class="manga-choice-row" style="display:flex;align-items:center;gap:1rem;padding:0.75rem;border-bottom:1px solid color-mix(in srgb, var(--primary) 15%, transparent);cursor:pointer;transition:background-color .2s" onclick="
        document.getElementById('sourceSwitchChoiceModal').remove();
        state.currentSourceId = ${inlineJsArg(sourceId)};
        const selectors = [document.getElementById('sourceSelect'), document.getElementById('advancedSourceSelect')];
        selectors.forEach(s => { if (s) s.value = ${inlineJsArg(sourceId)}; });
        loadMangaDetails(${inlineJsArg(c.id)});
    " onmouseenter="this.style.backgroundColor='color-mix(in srgb, var(--primary) 10%, transparent)'" onmouseleave="this.style.backgroundColor=''">
       ${c.cover ? `<img src="${escapeHtml(normalizeImageUrl(c.cover))}" style="width:40px;height:56px;object-fit:cover;border-radius:4px">` : `<div style="width:40px;height:56px;background:color-mix(in srgb, var(--primary) 15%, transparent);border-radius:4px"></div>`}
       <div style="flex:1">
         <div style="font-weight:600;font-size:1rem">${escapeHtml(c.title)}</div>
         ${c.author ? `<div style="font-size:0.8rem;color:var(--text-muted)">${escapeHtml(c.author)}</div>` : ''}
       </div>
    </div>
  `).join('');

  modal.innerHTML = `
    <div class="settings-content" style="max-width:500px">
      <div class="settings-header">
        <h2>Select Manga</h2>
        <button class="btn secondary" id="closeSourceSwitchChoice">&#x2715;</button>
      </div>
      <div class="settings-body" style="padding:0;max-height:60vh;overflow-y:auto">
        <div style="padding:1rem;font-size:0.9rem;color:var(--text-muted);border-bottom:1px solid color-mix(in srgb, var(--primary) 15%, transparent)">
          Multiple results found for "<strong>${escapeHtml(title)}</strong>". Please choose the correct one:
        </div>
        ${rows}
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.getElementById('closeSourceSwitchChoice').onclick = () => modal.remove();
}

async function switchToSourceSearch(sourceId, title) {
  document.querySelectorAll(".source-switch-dropdown").forEach(d => d.classList.add("hidden"));
  if (!title) return;
  showToast(`Searching in ${state.installedSources[sourceId]?.name || sourceId}...`, title, "info");
  try {
    const result = await api(`/api/source/${sourceId}/search`, {
      method: "POST",
      body: JSON.stringify({ query: title, page: 1 })
    });
    const rawResults = result.results || [];
    const normalizedResults = typeof normalizeSourceSearchResult === 'function' ? rawResults.map(m => normalizeSourceSearchResult(m, sourceId)).filter(Boolean) : rawResults;
    const chapterFiltered = await _filterMangaWithoutChapters(normalizedResults, sourceId);
    if (chapterFiltered.length === 0) {
      showToast("Not found", `"${title}" not found in ${state.installedSources[sourceId]?.name || sourceId}`, "info");
      return;
    }
    
    if (chapterFiltered.length > 1) {
      showSourceSwitchChoiceModal(sourceId, title, chapterFiltered);
      return;
    }

    // Switch source globally and open first result
    state.currentSourceId = sourceId;
    const selectors = [$("sourceSelect"), $("advancedSourceSelect")];
    selectors.forEach(s => { if (s) s.value = sourceId; });
    loadMangaDetails(chapterFiltered[0].id);
  } catch (e) {
    showToast("Error", "Could not load manga details.", "error");
  }
}

function _normalizeLookupTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _titleScore(a, b) {
  const aa = _normalizeLookupTitle(a);
  const bb = _normalizeLookupTitle(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;
  if (aa.includes(bb) || bb.includes(aa)) return 0.9;
  const sa = new Set(aa.split(' '));
  const sb = new Set(bb.split(' '));
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / Math.max(sa.size || 1, sb.size || 1);
}

async function _resolveMangaByTitleAcrossSources(title, excludeSourceId) {
  const wanted = String(title || '').trim();
  if (!wanted) return null;

  const sourceIds = Object.keys(state.installedSources || {})
    .filter(sid => sid !== 'local' && sid !== excludeSourceId);

  let best = null;
  for (const sid of sourceIds) {
    try {
      const r = await api(`/api/source/${sid}/search`, {
        method: 'POST',
        body: JSON.stringify({ query: wanted, page: 1 }),
      });
      const rawResults = r?.results || [];
      const normResults = typeof normalizeSourceSearchResult === 'function' ? rawResults.map(m => normalizeSourceSearchResult(m, sid)).filter(Boolean) : rawResults;
      for (const c of normResults.slice(0, 8)) {
        if (!c?.id) continue;
        const sim = _titleScore(wanted, c.title || '');
        if (sim < 0.55) continue;
        if (!best || sim > best.sim) {
          best = { sourceId: sid, mangaId: c.id, title: c.title || wanted, sim };
        }
      }
    } catch (_) {
      // Ignore one failing source and continue trying the others.
    }
  }
  return best;
}

async function _resolveMangaInSourceByTitle(sourceId, title) {
  const wanted = String(title || '').trim();
  if (!sourceId || !wanted) return null;

  const r = await api(`/api/source/${sourceId}/search`, {
    method: 'POST',
    body: JSON.stringify({ query: wanted, page: 1 }),
  });

  const rawResults = r?.results || [];
  const normResults = typeof normalizeSourceSearchResult === 'function' ? rawResults.map(m => normalizeSourceSearchResult(m, sourceId)).filter(Boolean) : rawResults;
  let best = null;
  for (const c of normResults.slice(0, 10)) {
    if (!c?.id) continue;
    const sim = _titleScore(wanted, c.title || '');
    if (sim < 0.6) continue;
    if (!best || sim > best.sim) {
      best = {
        mangaId: c.id,
        title: c.title || wanted,
        cover: c.cover || '',
        sim,
      };
    }
  }
  return best;
}

function normalizeLibraryMangaPayload(manga, activeSourceId) {
  const sourceId = String(
    manga?.sourceId ||
    manga?.source ||
    activeSourceId ||
    ''
  ).trim();

  const url = String(manga?.url || manga?.href || manga?.sourceUrl || '').trim();

  let id = String(
    manga?.id ||
    manga?.mangaId ||
    manga?.slug ||
    ''
  ).trim();

  if (id === 'undefined') id = '';

  if (!id && url) {
    const match = url.match(/\/manga\/([^/?#]+)/i);
    if (match) id = decodeURIComponent(match[1]);
  }

  const title = String(manga?.title || manga?.name || '').trim();

  return {
    ...manga,
    id,
    mangaId: id,
    slug: String(manga?.slug || id).trim(),
    sourceId,
    title,
    cover: manga?.cover || manga?.image || manga?.coverUrl || '',
    url
  };
}

function buildLibraryPayload(manga, activeSourceId) {
  const normalized = normalizeLibraryMangaPayload(manga, activeSourceId);
  if (!normalized.id || !normalized.sourceId || !normalized.title) {
    return null;
  }
  return normalized;
}

async function loadMangaDetails(rawMangaId, fromView = "discover", fallbackTitle = "", skipFallback = false, forcedSourceId = "") {
  // Normalize mangaId if needed
  let mangaId = String(rawMangaId || '').trim();
  if (mangaId === 'undefined') mangaId = '';

  if (!mangaId) {
    if (window.SCROLLSCAPE_DEBUG_SOURCE_HEALTH) {
      console.log({
        source: 'manga-details-error',
        message: 'Refusing to load details for undefined mangaId',
        rawMangaId
      });
    }
    showToast('Error', 'Cannot load details: Manga ID is missing', 'error');
    return;
  }

  if (forcedSourceId && forcedSourceId !== state.currentSourceId) {
    state.currentSourceId = forcedSourceId;
    try { renderSourceSelect(); } catch (_) {}
  }
  $("searchStatus").textContent = "Loading details...";
  try {
    let result;
    try {
      result = await api(`/api/source/${state.currentSourceId}/mangaDetails`, {
        method: "POST",
        body: JSON.stringify({ mangaId })
      });
    } catch (err) {
      const activeSourceId = forcedSourceId || state.currentSourceId;
      const fav = (state.favorites || []).find(m => String(m.id) === String(mangaId) && String(m.sourceId) === String(activeSourceId))
               || (state.history || []).find(m => String(m.id) === String(mangaId) && String(m.sourceId) === String(activeSourceId));
      if (!fav) throw err;
      result = {
        id: fav.id,
        title: fav.title,
        cover: fav.cover,
        description: fav.description || "",
        status: fav.status || "unknown",
        genres: fav.genres || [],
        author: fav.author || "",
        altTitle: fav.altTitle || ""
      };
    }
    result._sourceCover = result.cover || "";
    const storedCover = _getStoredMangaCover(result.id, state.currentSourceId);
    if (storedCover) result.cover = storedCover;
    state.currentManga = result;
    const isFavorited = isMangaInLibrary(result, state.currentSourceId);
    const hasProgress = !!state.lastReadChapter?.[result.id];

    // Navigate with context
    setView("manga-details", {
      mangaId: mangaId,
      sourceId: state.currentSourceId,
      title: result.title || fallbackTitle || "",
      scrollPosition: 0
    });

    // Render detail card
    $("details").innerHTML = `
      <div class="manga-details">
        ${result.cover && !result.cover.endsWith('.pdf') && !result.cover.endsWith('.epub') ? `
          <div class="manga-cover">
            <button type="button" class="cover-anilist-link cover-picker-trigger" title="Change cover">
              <img src="${escapeHtml(normalizeImageUrl(result.cover))}" alt="${escapeHtml(result.title)}">
              <div class="cover-anilist-hint">Change Cover</div>
            </button>
          </div>` : (result.cover ? `<div class="manga-cover"><div class="no-cover" style="height:100%;font-size:4rem;">&#128196;</div></div>` : "")}
        <div class="manga-info">
          <h2 class="manga-title">${escapeHtml(getDisplayMangaTitle(result))}</h2>
          ${_sourceOffNoticeHtml(state.currentSourceId)}
          ${result.altTitle ? `<p class="manga-alt-title">${escapeHtml(result.altTitle)}</p>` : ""}
          ${result.author  ? `<p class="manga-author"><span class="author-link" data-author="${escapeHtml(result.author)}" onclick="searchByAuthor(this.dataset.author)">${escapeHtml(result.author)}</span></p>` : ""}
          <div class="manga-meta">
            ${result.status ? `<span class="badge badge-${result.status === 'ongoing' ? 'success' : 'secondary'}">${escapeHtml(result.status)}</span>` : ""}
            ${result.year   ? `<span class="badge">${escapeHtml(String(result.year))}</span>` : ""}
            <span class="badge" title="Current Source">${escapeHtml(state.installedSources[state.currentSourceId]?.name || state.currentSourceId)}</span>
            <span class="source-switch-wrap">
              <span class="badge badge-source source-switch-btn" id="sourceSwitchBtn" onclick="showMigrateModalForManga(state.currentManga)" title="Migrate this manga to another source">Migrate ▾</span>
            </span>
            <span class="badge badge-adaptation-check" id="adaptationCheckBtn" onclick="checkAnimeAdaptation(${inlineJsArg(result.title)})">Check</span>
          </div>
          <div id="adaptationResult"></div>
          ${result.genres?.length ? `
            <div class="manga-genres">
              ${result.genres.map(g => `<span class="genre-tag" data-genre="${escapeHtml(g)}" title="Search: ${escapeHtml(g)}">${escapeHtml(g)}</span>`).join("")}
            </div>` : ""}
          ${result.description ? `
            <div class="manga-description" data-expanded="false">
              <p>${escapeHtml(result.description)}</p>
              <button class="btn-expand-description" title="Show full description">Read More</button>
            </div>` : ""}
          <div class="manga-actions">
            <button class="btn" id="addFavBtn">
              ${isFavorited ? "Remove from Library" : "Add to Library"}
            </button>
            ${!hasProgress ? `<button class="btn btn-start-reading-detail" id="startReadingBtn">&#9654; Start Reading</button>` : ""}
            ${hasProgress ? `<button class="btn btn-continue" id="continueReadingBtn">Continue</button>` : ""}
            <button class="btn btn-tracker" id="trackerBtn">Tracker</button>
            <button class="btn btn-secondary" id="manageCategoriesBtn">&#128194; Categories</button>
            ${fromView === 'random' ? `<button class="btn btn-reroll" id="rerollBtn" title="Pick another random manga">Reroll</button>` : ""}
          </div>
          <div id="detailRatingWrap" class="detail-rating-wrap"></div>
        </div>
      </div>
      <section id="similarMangaSection" class="similar-manga-section hidden">
        <div class="section-header">
          <h3>You might also like</h3>
        </div>
        <div id="similarMangaRow" class="popular-row"></div>
      </section>
    `;

    // Reroll random
    if ($('rerollBtn')) $('rerollBtn').onclick = () => openRandomPickerDrawer();

    // Favorites toggle
    $("addFavBtn").onclick = async () => {
      try {
        const safeManga = buildLibraryPayload(result, state.currentSourceId);

        if (!safeManga) {
          showToast("Error", "Could not update Library.", "error");
          if (window.SCROLLSCAPE_DEBUG_LIBRARY_UPDATE) {
            console.log({
              source: "library-update-error",
              action: "add/remove",
              endpoint: "unknown",
              errorName: "Validation Error",
              errorMessage: "Invalid library payload: missing id, sourceId, or title after normalization",
              payload: result
            });
          }
          return;
        }

        const mangaIdStr = safeManga.id;
        const sourceIdStr = safeManga.sourceId;
        const mangaKey = getMangaKey(safeManga);
        const favsBefore = state.favorites.length;
        const isFavoritedBefore = isMangaInLibrary(safeManga, sourceIdStr);
        const action = isFavoritedBefore ? "remove" : "add";
        const endpoint = action === "add" ? "/api/library/add" : "/api/library/remove";
        
        if (window.SCROLLSCAPE_DEBUG_LIBRARY_UPDATE) {
          console.log({
            source: "library-update-attempt",
            action: action,
            title: safeManga.title,
            id: safeManga.id,
            sourceId: safeManga.sourceId,
            mangaKey: mangaKey,
            payload: safeManga,
            endpoint: endpoint
          });
        }
        
        let res;
        let success = false;
        if (action === "add") {
          success = await ensureMangaInLibrary(safeManga, sourceIdStr);
          if (!success) throw new Error("Persistence verification failed.");
        } else {
          res = await ensureMangaNotInLibrary(safeManga.id, sourceIdStr);
          success = true;
        }

        if (window.SCROLLSCAPE_DEBUG_LIBRARY_UPDATE) {
          console.log({
            source: "library-update-response",
            action,
            endpoint,
            status: 200,
            ok: success,
            favoritesCountBefore: favsBefore,
            favoritesCountAfter: state.favorites.length
          });
        }
        
        const saved = state.favorites.some(f => getMangaKey(f) === mangaKey);
        if (action === "add" && !saved) {
          throw new Error("Persistence verification failed.");
        }
        
        $("addFavBtn").textContent = saved ? (t("context.remove") || "Remove from Library") : (t("manga.addToLibrary") || "Add to Library");
        
        if (window.SCROLLSCAPE_DEBUG_LIBRARY_MEMBERSHIP) {
          console.log({
            stage: "post-add-verify",
            title: result.title,
            id: mangaIdStr,
            sourceId: sourceIdStr,
            mangaKey: mangaKey,
            persistenceResult: action,
            favoritesCountBefore: favsBefore,
            favoritesCountAfter: state.favorites.length,
            savedObject: safeManga
          });
        }
        
        showToast(saved ? "Added to Library" : "Removed from Library", result.title, saved ? "success" : "info");
        renderLibrary();
        await updateStats();
        await checkAndUnlockAchievements();

        // Only on a fresh add (not remove), only when the user actually has
        // AniList connected (showTrackerModal itself handles "not connected"
        // with a static message, but popping a whole modal for that on every
        // single add would be a nag for anyone not using AniList at all —
        // same _alToken() gate every other "auto" AniList behavior in this
        // app already uses), and only when the toggle (Settings → Tracking)
        // is on.
        if (action === "add" && saved && typeof _alToken === 'function' && _alToken()
            && state.settings.anilistShowTrackerOnAdd && typeof showTrackerModal === 'function') {
          showTrackerModal(safeManga);
        }
      } catch (e) {
        if (window.SCROLLSCAPE_DEBUG_LIBRARY_UPDATE) {
          const action = isMangaInLibrary(result, state.currentSourceId) ? "remove" : "add";
          console.log({
            source: "library-update-error",
            action: action,
            endpoint: action === "add" ? "/api/library/add" : "/api/library/remove",
            errorName: e.name || "Error",
            errorMessage: e.message,
            payload: result
          });
        }
        console.error(e);
        showToast("Error", "Could not update Library.", "error");
      }
    };

    // Start reading (first chapter)
    const startBtn = $("startReadingBtn");
    if (startBtn) {
      startBtn.onclick = async () => {
        if (!state.allChapters?.length) {
          showToast("Loading chapters...", "", "info");
          return;
        }
        const firstIdx = state.allChapters.length - 1;
        const ch = state.allChapters[firstIdx];
        await loadChapter(ch.id, ch.name || `Chapter ${ch.chapter || 1}`, firstIdx);
      };
    }

    // Continue reading
    if (hasProgress) {
      $("continueReadingBtn").onclick = async () => {
        const lastChapterId = state.lastReadChapter[result.id];
        const lastPageIndex = state.lastReadPages[`${result.id}:${lastChapterId}`] || 0;
        try {
          const cr = await api(`/api/source/${state.currentSourceId}/chapters`, {
            method: "POST",
            body: JSON.stringify({ mangaId: result.id })
          });
          state.allChapters = cr.chapters || [];
          state.chapterCountCache[result.id] = state.allChapters.length;
          saveSettings();
          const idx = state.allChapters.findIndex(c => c.id === lastChapterId);
          if (idx >= 0) {
            const ch = state.allChapters[idx];
            await loadChapter(lastChapterId, ch.name || `Chapter ${ch.chapter || idx + 1}`, idx, lastPageIndex);
          } else {
            showToast("Chapter not found", "It may have been removed.", "error");
          }
        } catch (e) { showToast("Error", "Could not load source details.", "error"); }
      };
    }

    // Genre tag navigation
    $("details").querySelectorAll(".genre-tag[data-genre]").forEach(tag => {
      tag.onclick = (e) => { e.stopPropagation(); searchByGenre(tag.dataset.genre); };
    });

    // Description expand/collapse
    const descDiv = $("details").querySelector(".manga-description[data-expanded]");
    if (descDiv) {
      const expandBtn = descDiv.querySelector(".btn-expand-description");
      if (expandBtn) {
        expandBtn.onclick = (e) => {
          e.preventDefault();
          const isExpanded = descDiv.dataset.expanded === "true";
          descDiv.dataset.expanded = !isExpanded ? "true" : "false";
          expandBtn.textContent = !isExpanded ? "Show Less" : "Read More";
        };
      }
    }

    // Tracker button
    $("trackerBtn").onclick = () => showTrackerModal(result);
    const detailCoverTrigger = $("details")?.querySelector('.cover-picker-trigger');
    if (detailCoverTrigger) {
      const isComicSource = state.currentSourceId === 'batcave';
      detailCoverTrigger.title = isComicSource
        ? 'Left click: LOCG | Right click: Change Cover'
        : 'Left click: AniList | Right click: Change Cover';
      const hint = detailCoverTrigger.querySelector('.cover-anilist-hint');
      if (hint) {
        hint.textContent = isComicSource ? 'LOCG (RMB: Cover)' : 'AniList (RMB: Cover)';
        hint.style.fontSize = '0.75rem';
      }
      detailCoverTrigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isComicSource) {
          openLocgForComic(result.title);
        } else if (typeof window.openAniListForManga === 'function') {
          // The page's own facts (id, alternative title, year, author) let the AniList lookup tell this title from others of the same name.
          window.openAniListForManga({ id: result.id, sourceId: state.currentSourceId, title: result.title, altTitle: result.altTitle, year: result.year, author: result.author });
        } else {
          window.open('https://anilist.co/search/manga?search=' + encodeURIComponent(result.title), '_blank');
        }
      });
      detailCoverTrigger.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMangaCoverPicker(result, {
          sourceId: state.currentSourceId,
          sourceCover: result._sourceCover,
          currentCover: result.cover,
        });
      });
    }

    // Categories button
    $("manageCategoriesBtn").onclick = () => {
      const manga = { ...result, sourceId: state.currentSourceId };
      showCategoryModal(manga);
    };

    if (_alGetLink(result.id) && _alToken()) {
      $("trackerBtn").innerHTML = 'Tracker \u2713';
      $("trackerBtn").classList.add('btn-tracker--tracked');
    }

    // Rating widget
    renderDetailRating(result.id);

    // Render reading status
    renderReadingStatusSection(result.id, state.currentSourceId);
    loadSimilarManga(result, state.currentSourceId);
    await loadChapters();
    $("searchStatus").textContent = "";
  } catch (e) {
    if (!skipFallback && fromView === 'library') {
      const sourceId = forcedSourceId || state.currentSourceId;
      const wantedTitle = String(fallbackTitle || '').trim();
      if (sourceId && wantedTitle) {
        try {
          const fixed = await _resolveMangaInSourceByTitle(sourceId, wantedTitle);
          if (fixed?.mangaId && String(fixed.mangaId) !== String(mangaId)) {
            const migrateRes = await api('/api/library/migrate', {
              method: 'POST',
              body: JSON.stringify({
                migrations: [{
                  fromMangaId: mangaId,
                  fromSourceId: sourceId,
                  toMangaId: fixed.mangaId,
                  toSourceId: sourceId,
                  title: fixed.title || wantedTitle,
                  cover: fixed.cover || '',
                }]
              }),
            });

            if (Array.isArray(migrateRes?.migrations) && migrateRes.migrations.length > 0 && typeof _migrateRemapLocalStorage === 'function') {
              _migrateRemapLocalStorage(migrateRes.migrations);
            }

            try {
              const libData = await fetch('/api/library').then(r => r.json());
              state.favorites = libData.favorites || state.favorites;
              state.coverOverrides = libData.coverOverrides || state.coverOverrides;
              const statusData = await fetch('/api/user/status').then(r => r.json());
              state.readingStatus = statusData.readingStatus || state.readingStatus;
              const ratingsData = await fetch('/api/ratings').then(r => r.json());
              state.ratings = ratingsData.ratings || state.ratings;
              renderLibrary();
            } catch (_) {}

            showToast('Library repaired', `${wantedTitle} ID was fixed in ${state.installedSources[sourceId]?.name || sourceId}.`, 'warning');
            return loadMangaDetails(fixed.mangaId, fromView, wantedTitle, true);
          }
        } catch (_) {
          // Continue with original error message.
        }
      }
    }

    $("searchStatus").textContent = "Could not load manga details.";
    showToast("Error", "Could not load manga details.", "error");
  }
}

// ── "You might also like" — similar manga based on the manga currently
// being viewed, not the aggregate library-wide profile the Home page's
// loadRecommendations() (ui-calendar.js) uses. Queries every installed
// source (not just the one the viewed manga is on) — genre-overlap scoring
// below is what keeps results actually similar despite each source having
// its own tag vocabulary/aliasing, rather than restricting to one source to
// dodge that mismatch. Session-cached per mangaId so re-opening the same
// manga doesn't refire every source's call again.
const _similarMangaCache = new Map();

// Persistent across page reloads, not just the in-memory Map above —
// reported live: reopening a manga already sitting in the library still
// re-ran the full every-installed-source fan-out every single time, since
// the in-memory cache resets on every navigation. Recommendations don't
// need to be minute-fresh (a source's catalog doesn't meaningfully change
// hour to hour), so a bounded-TTL localStorage cache is safe here in a way
// it wouldn't be for something like the chapter list. Same one-JSON-object-
// per-key shape anilist.js's _alGetLink/_alSetLink already use for their
// own localStorage cache, for consistency.
const SIMILAR_MANGA_CACHE_KEY = 'scrollscape_similar_manga_cache';
const SIMILAR_MANGA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const SIMILAR_MANGA_CACHE_MAX_ENTRIES = 300; // bounds localStorage growth from browsing many manga over time

function _loadSimilarMangaCacheEntry(mangaId) {
  try {
    const all = JSON.parse(localStorage.getItem(SIMILAR_MANGA_CACHE_KEY) || '{}');
    const entry = all[mangaId];
    if (!entry || !Array.isArray(entry.list)) return null;
    if (Date.now() - (entry.cachedAt || 0) > SIMILAR_MANGA_CACHE_TTL_MS) return null;
    return entry.list;
  } catch (_) {
    return null;
  }
}

function _saveSimilarMangaCacheEntry(mangaId, list) {
  try {
    const all = JSON.parse(localStorage.getItem(SIMILAR_MANGA_CACHE_KEY) || '{}');
    all[mangaId] = { list, cachedAt: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > SIMILAR_MANGA_CACHE_MAX_ENTRIES) {
      // Evict oldest first — a simple recency bound rather than a real LRU,
      // cheap enough given this only runs on a cache miss (at most once per
      // newly-viewed manga, not on every render).
      keys.sort((a, b) => (all[a].cachedAt || 0) - (all[b].cachedAt || 0));
      for (const k of keys.slice(0, keys.length - SIMILAR_MANGA_CACHE_MAX_ENTRIES)) delete all[k];
    }
    localStorage.setItem(SIMILAR_MANGA_CACHE_KEY, JSON.stringify(all));
  } catch (_) {
    // Quota exceeded or localStorage unavailable — recommendations just
    // refetch live next time instead of persisting, never fatal.
  }
}

function _renderSimilarManga(list, section, row) {
  if (!list.length) return;
  row.innerHTML = list.map(m => mangaCardHTML(m)).join("");
  bindMangaCards(row);
  if (typeof _hydrateMissingGenres === 'function') _hydrateMissingGenres(row);
  section.classList.remove('hidden');
  initRowAutoScroll(row);
}

// "Batman: Justice Buster" -> "Batman" — cutting at the first colon/dash
// isolates the franchise/series name from a subtitle, which is what a
// title search actually needs to catch other entries in the same
// franchise (e.g. other Batman manga) that byGenres alone would never
// surface, since genre tags say nothing about being the same franchise.
function _extractFranchiseKeyword(title) {
  const t = String(title || '').trim();
  const cut = t.split(/[:\-–—]/)[0].trim();
  return cut.length >= 3 ? cut : t;
}

async function loadSimilarManga(result, sourceId) {
  const section = $("similarMangaSection");
  const row = $("similarMangaRow");
  if (!section || !row) return;
  section.classList.add('hidden');

  // First choice: what AniList's readers recommend for this title (ui-similar-anilist.js). When it has nothing, or does not answer in time, the row
  // is built from genres as before.
  if (typeof loadSimilarFromAniList === 'function') {
    const fromAniList = await Promise.race([
      loadSimilarFromAniList(result, sourceId, { section, row, isStale: () => state.currentManga?.id !== result.id || state.currentSourceId !== sourceId }),
      new Promise((resolve) => { setTimeout(() => resolve(false), 8000); }),
    ]);
    if (fromAniList) return;
  }

  const genres = (result?.genres || []).filter(Boolean);
  if (!genres.length) return;

  // Composite key, not just the manga id — the same id string can mean two
  // different manga on two different sources (this function's own dedupe
  // below already assumes id+sourceId is the real identity, via
  // `favoriteIdsBySource`'s "${m.sourceId}::${m.id}" keys). A bare
  // id-keyed cache could serve one manga's cached recommendations under a
  // different manga's page if two sources ever assign the same id string.
  const cacheKey = `${sourceId}::${result.id}`;

  // A slow fan-out can still be in flight when the user navigates to a
  // different manga's details page before it settles — nothing below
  // otherwise knows that happened, so every render call re-checks this
  // instead of trusting whichever manga was current when the request
  // started (the details page's own DOM is reused across navigations, so
  // a stale render would otherwise silently overwrite the new page).
  const isStale = () => state.currentManga?.id !== result.id || state.currentSourceId !== sourceId;
  const applyNsfwFilter = (l) => state.settings.hideNsfw === true ? l.filter(m => !isNsfwManga(m)) : l;

  // In-memory cache (same tab session) then persisted localStorage cache
  // (survives reloads/app restarts) — both keyed by manga id. A hit
  // renders instantly with zero network calls, which is the point: this
  // row's recommendations don't need to be fresher than a day old. Both
  // cache layers store the raw, unfiltered list — hideNsfw is applied at
  // render time (below, and again after a live fetch) so toggling that
  // setting takes effect immediately even against already-cached data,
  // instead of a cache entry saved while it was off silently ignoring it
  // once the user turns it on.
  let list = _similarMangaCache.get(cacheKey) || _loadSimilarMangaCacheEntry(cacheKey);
  if (list) {
    _similarMangaCache.set(cacheKey, list);
    if (!isStale()) _renderSimilarManga(applyNsfwFilter(list), section, row);
    return;
  }

  try {
    const sourceIds = (typeof getSelectableSourceIds === 'function' ? getSelectableSourceIds() : [sourceId]).filter(Boolean);
    const targetGenresLower = new Set(genres.map(g => String(g).toLowerCase()));
    const normTitle = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
    const currentTitleKey = normTitle(result.title);
    const favoriteIdsBySource = new Set((state.favorites || []).map(m => `${m.sourceId}::${m.id}`));

    // byGenres() is a "discover" browse endpoint, not a "similar to X"
    // one — it doesn't rank by how closely a result actually matches the
    // genres asked for (confirmed live: a Batman/DC manga tagged Action/
    // Superhero/Drama surfaced only generic action shounen sharing
    // nothing but "Action"). Scoring/sorting every candidate by genre
    // overlap with the viewed manga — rather than trusting any single
    // source's own ordering — is what actually keeps this "similar",
    // regardless of which source(s) happen to have a matching title.
    const franchiseKeyword = _extractFranchiseKeyword(result.title);
    const franchiseKeywordLower = franchiseKeyword.toLowerCase();

    // Cache miss: this used to block on every one of the ~2x
    // installed-sources requests (byGenres + franchise-search, one
    // Promise.all each) settling before rendering anything — a single
    // slow/hanging source held the whole row hidden the entire time
    // (same class of bug as Migrate All's per-source fan-out). Instead,
    // each source's results land in these accumulators as they arrive,
    // and a throttled recompute+render pass runs after every arrival, so
    // the row fills in progressively and no single source gates the rest.
    const genreRaw = [];
    const franchiseRaw = [];

    const computeList = () => {
      const seenTitles = new Set();
      const dedupe = (m) => {
        if (String(m.id) === String(result.id) && m.sourceId === sourceId) return false;
        const titleKey = normTitle(m.title || m.id);
        if (titleKey === currentTitleKey || seenTitles.has(titleKey)) return false;
        if (favoriteIdsBySource.has(`${m.sourceId}::${m.id}`)) return false;
        seenTitles.add(titleKey);
        return true;
      };

      // Franchise matches go first regardless of genre overlap — being the
      // same series is a stronger "you might also like" signal than any
      // amount of shared tags.
      const franchiseMatches = franchiseRaw.filter(dedupe).map(m => ({ ...m, _tagOverlap: Infinity }));

      const genreMatches = genreRaw
        .filter(dedupe)
        .map(m => {
          const mGenres = (m.genres || []).map(g => String(g).toLowerCase());
          const overlap = mGenres.filter(g => targetGenresLower.has(g)).length;
          return { ...m, _tagOverlap: overlap };
        })
        // Keep genre-tagged results sharing at least one tag; results with
        // no genre data at all (some sources omit it from search results)
        // are kept but ranked last rather than dropped outright.
        .filter(m => (m.genres || []).length === 0 || m._tagOverlap > 0)
        .sort((a, b) => b._tagOverlap - a._tagOverlap);

      // NOT filtered by hideNsfw here — this result gets cached raw, and
      // the setting is applied at every render site instead (see the
      // cache-hit branch above for why).
      return [...franchiseMatches, ...genreMatches].slice(0, 24);
    };

    // Re-rendering on every one of the ~28 arrivals (even throttled) meant
    // the row's innerHTML got fully replaced many times a second while
    // sources were still answering — every replace tears down and rebuilds
    // every <img>, which reads as constant flicker rather than "filling
    // in". Capped to a single early paint (grace period batches whichever
    // sources answer first) plus the one unconditional final paint after
    // everything settles below — at most 2 full replacements total,
    // regardless of how many sources are installed.
    let firstPaintTimer = null;
    let hasPaintedOnce = false;
    const scheduleRender = () => {
      if (hasPaintedOnce || firstPaintTimer) return;
      firstPaintTimer = setTimeout(() => {
        firstPaintTimer = null;
        hasPaintedOnce = true;
        if (!isStale()) _renderSimilarManga(applyNsfwFilter(computeList()), section, row);
      }, 250);
    };

    const genrePromises = sourceIds.map(async (sid) => {
      try {
        const data = await api(`/api/source/${sid}/byGenres`, {
          method: "POST",
          body: JSON.stringify({ genres: genres.slice(0, 3) }),
        });
        genreRaw.push(...(data.results || []).map(m => ({ ...m, sourceId: sid })));
      } catch (_) {
        // Best-effort — one source failing shouldn't block the rest.
      } finally {
        scheduleRender();
      }
    });

    // Same-franchise search ("Batman" -> other Batman manga) — genre
    // overlap alone can't catch this, since two entries in the same
    // franchise don't necessarily share every tag, and plenty of
    // unrelated manga share the same broad genres.
    const franchisePromises = sourceIds.map(async (sid) => {
      try {
        const data = await api(`/api/source/${sid}/search`, {
          method: "POST",
          body: JSON.stringify({ query: franchiseKeyword, page: 1 }),
        });
        franchiseRaw.push(...(data.results || [])
          .filter(m => String(m.title || '').toLowerCase().includes(franchiseKeywordLower))
          .map(m => ({ ...m, sourceId: sid })));
      } catch (_) {
        // Best-effort — one source failing shouldn't block the rest.
      } finally {
        scheduleRender();
      }
    });

    await Promise.all([...genrePromises, ...franchisePromises]);
    if (firstPaintTimer) {
      clearTimeout(firstPaintTimer);
      firstPaintTimer = null;
    }

    list = computeList();
    _similarMangaCache.set(cacheKey, list);
    _saveSimilarMangaCacheEntry(cacheKey, list);
  } catch (_) {
    return; // Best-effort — a source hiccup here shouldn't disturb the details page.
  }

  if (!list.length || isStale()) return;
  _renderSimilarManga(applyNsfwFilter(list), section, row);
}

function renderDetailRating(mangaId) {
  const wrap = $("detailRatingWrap");
  if (!wrap) return;
  const ratingKey = String(mangaId || '').replace(/[^a-z0-9:_-]/gi, '_');
  const current = state.ratings[ratingKey] || 0;
  wrap.innerHTML = `
    <div class="detail-rating-row" data-manga-id="${escapeHtml(mangaId)}">
      <span class="detail-rating-label">Rating</span>
      <div class="detail-rating-btns">
        ${Array.from({length: 10}, (_, i) => {
          const v = i + 1;
          return `<button class="card-score-btn detail-score-btn${v <= current ? ' active' : ''}" data-score="${v}">${v}</button>`;
        }).join("")}
      </div>
      ${current ? `<span class="detail-rating-current">${current}<span class="detail-rating-max">/10</span></span>` : ""}
      ${current ? `<button class="detail-rating-clear" title="Clear rating">\u2715</button>` : ""}
    </div>
  `;
  const row = wrap.querySelector(".detail-rating-row");
  row.querySelectorAll(".detail-score-btn").forEach(btn => {
    btn.onmouseenter = () => {
      const v = Number(btn.dataset.score);
      row.querySelectorAll(".detail-score-btn").forEach(b => b.classList.toggle("hover", Number(b.dataset.score) <= v));
    };
    btn.onmouseleave = () => row.querySelectorAll(".detail-score-btn").forEach(b => b.classList.remove("hover"));
    btn.onclick = async () => {
      const score = Number(btn.dataset.score);
      const newScore = state.ratings[ratingKey] === score ? null : score;
      try {
        if (newScore) {
          await api("/api/reviews", { method: "POST", body: JSON.stringify({ mangaId, rating: newScore, text: "" }) });
          state.ratings[ratingKey] = newScore;
          // Sync score to AniList if this manga is linked
          const _alId = _alGetLink(mangaId);
          if (_alId && _alToken()) {
            anilistGQL(
              'mutation ($m: Int, $sc: Float) { SaveMediaListEntry(mediaId: $m, score: $sc) { id } }',
              { m: _alId, sc: newScore }
            ).catch(e => dbg.warn(dbg.ERR_ANILIST, 'Score sync failed', e));
          }
        } else {
          await api('/api/ratings/clear', { method: 'POST', body: JSON.stringify({ mangaId }) });
          delete state.ratings[ratingKey];
        }
        renderDetailRating(mangaId);
        renderLibrary();
      } catch (e) { showToast("Error", "Could not process rating.", "error"); }
    };
  });
  const clearBtn = wrap.querySelector(".detail-rating-clear");
  if (clearBtn) {
    clearBtn.onclick = async () => {
      try {
        await api('/api/ratings/clear', { method: 'POST', body: JSON.stringify({ mangaId }) });
        delete state.ratings[ratingKey];
        renderDetailRating(mangaId);
        renderLibrary();
      } catch (e) { showToast("Error", "Could not clear rating.", "error"); }
    };
  }
}

// A warning for a manga whose source is not active: turned off in Settings (disabledSourceIds), or not installed at all.
// The manga still opens from the library (what was saved is used), so this only says why its source is not answering.
function _sourceOffNoticeHtml(sourceId) {
  const id = String(sourceId || '');
  const installed = state.installedSources || {};
  // 'local' has no source to turn off, and before the list of installed sources has loaded nothing can be called missing
  if (!id || id === 'local' || Object.keys(installed).length === 0) return '';
  const disabled = Array.isArray(state.settings && state.settings.disabledSourceIds) && state.settings.disabledSourceIds.includes(id);
  const missing = !installed[id];
  if (!disabled && !missing) return '';
  const name = (installed[id] && installed[id].name) || id;
  const label = t(missing ? 'manga.sourceMissing' : 'manga.sourceOff');
  const hint = String(t(missing ? 'manga.sourceMissingHint' : 'manga.sourceOffHint')).replace('{name}', name);
  return `<div class="source-off-notice" role="status" title="${escapeHtml(hint)}">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
    <div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(hint)}</span></div>
  </div>`;
}
