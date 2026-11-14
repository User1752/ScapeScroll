// ============================================================================
// GENRE / AUTHOR NAVIGATION
// ============================================================================

// "The same author" needs a real author->works index to answer correctly —
// most installed sources have no such thing; authorSearch on e.g.
// data/sources/demonicscans.js is just an alias for a plain title search
// server-side. Searching a name like "Lie Ren" that way matches any title
// merely CONTAINING those words ("Gui Zhan Lie Ren", "Shigatsu wa Kimi no
// Uso" — "uso" is Japanese for "lie") — confirmed live, one real author name
// pulled in 126 mostly-unrelated results across installed sources. AniList's
// Staff->staffMedia graph is a real credits index, so it's the primary path;
// each result is resolved against installed sources (by title, not author
// name) only when actually clicked, not for the whole list upfront. Falls
// back to the old per-source authorSearch sweep only when AniList has never
// heard of this person at all (self-published/very obscure creators).
const ANILIST_STAFF_MEDIA_QUERY = `query ($search: String) {
  Staff(search: $search) {
    staffMedia(type: MANGA, sort: POPULARITY_DESC, perPage: 24) {
      edges { staffRole node { id title { romaji english } coverImage { large } } }
    }
  }
}`;

// AniList's staffMedia has one edge per (media, role) pair, not per media —
// a title this person has more than one credit on (e.g. "Original Creator"
// AND "Illustration" on the same book) shows up as two separate edges for
// the exact same manga. Every role is kept — a real credit is a real
// credit, however minor — but deduped by media id so that doesn't render as
// duplicate cards for one title (confirmed live: "Du-ran-ki" and "Berserk:
// The Flame Dragon Knight" both have two same-person edges and were showing
// up twice each before this).
async function _fetchAniListStaffMedia(queryName) {
  async function attempt() {
    const data = await api('/api/anilist', {
      method: 'POST',
      body: JSON.stringify({ query: ANILIST_STAFF_MEDIA_QUERY, variables: { search: queryName } })
    });
    const edges = data?.data?.Staff?.staffMedia?.edges || [];
    const seen = new Set();
    const nodes = [];
    for (const e of edges) {
      const id = e?.node?.id;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      nodes.push(e.node);
    }
    return nodes;
  }
  try {
    return { nodes: await attempt(), failed: false };
  } catch (_) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      return { nodes: await attempt(), failed: false };
    } catch (_) {
      return { nodes: [], failed: true };
    }
  }
}

const AUTHOR_RESOLVE_MIN_SIM = 0.65; // same threshold ui-migrate.js uses for cross-source title matching
const AUTHOR_RESOLVE_CONCURRENCY = 6;
const AUTHOR_RESOLVE_PER_SOURCE_TIMEOUT_MS = 8000;

function _withClientTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
  ]);
}

// Finds this exact title among installed sources and opens it — same
// "search then open" step Migrate does for cross-source title matching
// (_titleSimilarity, ui-migrate.js), just one lookup instead of a whole-
// library comparison, and only run when the user actually clicks a card.
// Confirmed live: without a per-source cap this can take 20+ seconds when a
// known-slow source (e.g. BatCave, which the server itself gives 45s of
// room — see routes/sources.js's SOURCE_CALL_TIMEOUT) sits in a worker's
// queue, for what's meant to be a single click's response. An 8s client-side
// timeout plus stopping early once an exact-title match is found keeps the
// common case fast without needing every source to finish.
async function _resolveAndOpenAuthorTitle(title, anilistId) {
  // An exact AniList ID match against something already in the library is a
  // far stronger signal than any title-similarity guess, and catches cases
  // text matching never could — confirmed live: DemonicScans carries this
  // exact manga as "Apex Future Martial Arts", zero words in common with
  // AniList's "Log Into The Future", so a title search would open a
  // different (correct, but not-yet-owned) source instead of the copy
  // already being read. Checked first, no network call needed.
  if (anilistId) {
    const owned = (state.favorites || []).find((f) => String(f.anilistId) === String(anilistId));
    if (owned) {
      if (owned.sourceId !== state.currentSourceId && state.installedSources[owned.sourceId]) {
        state.currentSourceId = owned.sourceId;
        const sel = $('sourceSelect');
        if (sel) sel.value = owned.sourceId;
      }
      if (typeof similarAlRememberHint === 'function') similarAlRememberHint(owned.sourceId, owned.id, anilistId); // the page of this title knows which AniList title it is
      loadMangaDetails(owned.id, 'advanced-search', owned.title || title, false, owned.sourceId);
      return;
    }
  }

  const sourceIds = typeof getSelectableSourceIds === 'function' ? getSelectableSourceIds() : Object.keys(state.installedSources || {});
  let best = null; // { sim, id, sourceId }
  let cursor = 0;
  let stop = false;

  async function worker() {
    while (cursor < sourceIds.length && !stop) {
      const sid = sourceIds[cursor++];
      try {
        const result = await _withClientTimeout(api(`/api/source/${sid}/search`, {
          method: 'POST',
          body: JSON.stringify({ query: title, page: 1 })
        }), AUTHOR_RESOLVE_PER_SOURCE_TIMEOUT_MS);
        for (const m of (result.results || [])) {
          const sim = _titleSimilarity(title, m.title || '');
          if (sim >= AUTHOR_RESOLVE_MIN_SIM && (!best || sim > best.sim)) {
            best = { sim, id: m.id, sourceId: sid };
            if (sim >= 0.99) { stop = true; break; }
          }
        }
      } catch (_) {
        // Source unavailable, no match, or timed out — try the rest.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(AUTHOR_RESOLVE_CONCURRENCY, sourceIds.length) }, worker));

  if (!best) {
    showToast('Not found', `"${title}" isn't available in any of your installed sources.`, 'warning');
    return;
  }
  if (best.sourceId !== state.currentSourceId && state.installedSources[best.sourceId]) {
    state.currentSourceId = best.sourceId;
    const sel = $('sourceSelect');
    if (sel) sel.value = best.sourceId;
  }
  // Opened from a card that knows its AniList id (the recommendations row): say so, so the page of this title asks for the recommendations of THAT title and
  // does not search AniList again by name (a short or common name finds another title).
  if (typeof similarAlRememberHint === 'function') similarAlRememberHint(best.sourceId, best.id, anilistId);
  loadMangaDetails(best.id, 'advanced-search', title, false, best.sourceId);
}

function _authorStaffCardHTML(media) {
  const title = media.title?.english || media.title?.romaji || '';
  const cover = media.coverImage?.large || '';
  return `
    <div class="manga-card author-staff-card" data-author-title="${escapeHtml(title)}" data-anilist-id="${escapeHtml(String(media.id || ''))}" title="Find &quot;${escapeHtml(title)}&quot; in your installed sources">
      <div class="manga-card-cover">
        ${cover ? `<img src="${escapeHtml(cover)}" alt="${escapeHtml(title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<div class="no-cover">?</div>'}
      </div>
      <div class="manga-card-info">
        <h3 class="manga-card-title">${escapeHtml(title)}</h3>
      </div>
    </div>`;
}

function _bindAuthorStaffCards(container) {
  container.querySelectorAll('.author-staff-card').forEach((el) => {
    el.onclick = () => {
      const title = el.dataset.authorTitle;
      if (!title) return;
      const anilistId = el.dataset.anilistId || '';
      showToast('Searching', `Looking for "${title}" in your installed sources...`, '');
      _resolveAndOpenAuthorTitle(title, anilistId);
    };
  });
}

// Old behavior, kept only as a fallback for creators AniList doesn't have —
// see the block comment above for why this is noisy and not the first
// choice. Same bounded-concurrency worker-loop shape as
// advancedSearchAllSources() (ui-advanced-search.js), scaled down.
async function _searchByAuthorPerSourceFallback(queryName, resultsDiv, statusEl) {
  const sourceIds = typeof getSelectableSourceIds === 'function' ? getSelectableSourceIds() : Object.keys(state.installedSources || {});
  if (!sourceIds.length) {
    resultsDiv.innerHTML = `<div class="muted">No installed sources to search.</div>`;
    return;
  }

  const seenTitles = new Set();
  const merged = [];
  let doneCount = 0;
  let cursor = 0;
  const CONCURRENCY = 3;

  function renderSoFar() {
    if (merged.length) renderMangaGrid(resultsDiv, merged);
    if (statusEl) {
      statusEl.textContent = doneCount < sourceIds.length
        ? `AniList has no record of "${queryName}" — trying each source directly... (${merged.length} so far)`
        : `${merged.length} result(s) for author "${queryName}"`;
    }
  }
  if (statusEl) statusEl.textContent = `AniList has no record of "${queryName}" — trying each source directly...`;

  async function worker() {
    while (cursor < sourceIds.length) {
      const sid = sourceIds[cursor++];
      try {
        const result = await api(`/api/source/${sid}/authorSearch`, {
          method: "POST",
          body: JSON.stringify({ authorName: queryName })
        });
        const filtered = await _filterMangaWithoutChapters(result.results || [], sid);
        for (const m of filtered) {
          const key = String(m.title || "").trim().toLowerCase();
          if (!key || seenTitles.has(key)) continue;
          // Hide NSFW and the genre blacklist apply here as on every other list (this search did not apply them).
          if (typeof _mangaExcludedBySettings === 'function' && _mangaExcludedBySettings(m)) continue;
          seenTitles.add(key);
          merged.push({ ...m, sourceId: sid });
        }
      } catch (_) {
        // Source has no real author search, is down, or timed out — skip it.
      }
      doneCount++;
      renderSoFar();
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sourceIds.length) }, worker));

  if (!merged.length) {
    resultsDiv.innerHTML = `<div class="muted">No results found for author "${escapeHtml(queryName)}"</div>`;
  }
}

async function searchByAuthor(author) {
  if (!author) return;
  // A joined multi-credit string (e.g. the AniList author fallback returning
  // "Lie Ren, Mei Yue Yi Geng" for co-writers) isn't a real search term —
  // look up just the first name.
  const queryName = String(author).split(',')[0].trim();
  if (!queryName) return;

  setView("advanced-search");
  const advInput = $("advancedSearchInput");
  if (advInput) advInput.value = "";
  state.advancedFilters.tags.clear();
  document.querySelectorAll(".advanced-tags-section .genre-chip").forEach(c => c.classList.remove("active"));
  const statusEl = $("advancedSearchStatus");
  const resultsDiv = $("advancedResults");
  if (!resultsDiv) return;
  resultsDiv.classList.remove("grouped-by-source");
  resultsDiv.innerHTML = "";
  if (statusEl) statusEl.textContent = `Looking up "${queryName}" on AniList...`;

  const { nodes: media, failed } = await _fetchAniListStaffMedia(queryName);
  if (media.length) {
    resultsDiv.innerHTML = media.map((m) => _authorStaffCardHTML(m)).join("");
    _bindAuthorStaffCards(resultsDiv);
    if (statusEl) statusEl.textContent = `${media.length} manga by "${queryName}" on AniList — click one to find it in your sources`;
    return;
  }
  if (failed) {
    // AniList itself is unreachable/rate-limited right now — not "this
    // person has no credits". Say so; the fallback below is real but
    // noticeably noisier (see its own comment), so silently dropping into
    // it without explanation reads as the feature being broken rather than
    // AniList having a bad moment.
    showToast('AniList unavailable', 'Falling back to a broader (noisier) per-source search.', 'warning');
  }

  await _searchByAuthorPerSourceFallback(queryName, resultsDiv, statusEl);
}

function searchByGenre(genre) {
  // Clear existing tag filters and add the selected genre
  state.advancedFilters.tags.clear();
  state.advancedFilters.tags.add(genre.toLowerCase());

  // Navigate to advanced search view
  setView("advanced-search");

  // Visually activate the matching genre chip in the advanced search UI
  document.querySelectorAll(".advanced-tags-section .genre-chip").forEach(chip => {
    const chipTag = chip.dataset.tag || "";
    const isMatch = chipTag.toLowerCase() === genre.toLowerCase();
    chip.classList.toggle("active", isMatch);
    if (isMatch) state.advancedFilters.tags.add(chipTag);
  });

  // Pre-fill the search input and run the search
  const advInput = $("advancedSearchInput");
  if (advInput) advInput.value = "";
  advancedSearch();
}

