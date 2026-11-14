// ============================================================================
// ANIME WATCH TEST + MY ANIME LIBRARY (M1 search/stream slice + M2 persistence
// and AniList sync)
//
// Deliberately isolated from the rest of the app: doesn't touch state.js or
// the manga `favorites` store collection — see schema.js's animeFavorites
// comment for why. Search comes straight from AniList's own catalog (idMal +
// episodes are exactly what's needed); episode video comes from a single
// hardcoded provider (server/modules/anime/zokoanime.js). Favoriting and
// watch progress persist server-side via /api/anime/favorites* and
// /api/anime/progress (server/routes/anime.js). Episode completion also
// pushes progress to the user's AniList list — see anilistReconcileAnimeProgress()
// in modules/anilist.js, gated the same way the manga sync already is
// (requires a connected token AND state.settings.anilistAutoSync).
// Depends on anilistGQL() (modules/anilist.js) and hls.js (CDN, index.html).
// ============================================================================

let _animeTestCurrent = null; // { idMal, anilistId, title, episodes }
let _animeTestHls = null;
let _animeTestIsFavorited = false;
let _animeTestFavoriteEntry = null; // full /api/anime/favorites record for the current show, incl. tags/watchStatus — feeds showAnimeLibraryContextMenu from the details page (null when not favorited)
let _animeTestCurrentEpisode = null;
let _animeTestPreferredProvider = null; // mirrors a favorite's stored preferredProvider field (still read/applied below even though the UI that used to set it — the anime "Migrate" feature — has been removed)
let _animeTestLastSavedAt = 0;
let _animeTestWatchSessionStart = null; // set when an episode starts playing, flushed on episode switch/leaving the page — see _animeTestFlushWatchSession
let _animeTestSyncedEpisodes = new Set(); // "idMal:episode" already pushed to AniList this session

const ANIME_PROGRESS_SAVE_INTERVAL_MS = 10_000;
const ANIME_ANILIST_SYNC_THRESHOLD = 0.9; // fraction of episode duration counted as "watched"

// Every "click an anime card" handler in this file goes through here — a
// real navigateTo() to its own view (not just swapping a panel's visibility
// inside the search page), so it gets the same back-stack/URL-identity
// treatment manga-details already has instead of feeling like a scroll
// position within the search results.
function _animeGoToDetails(show, resume) {
  setView("anime-details", { show, resume });
}

/**
 * @param {{idMal:string,anilistId?:string|number,title:string,cover?:string,episodes?:number,score?:number}} show
 * @param {{episode?:number, positionSeconds?:number}} [resume] auto-play this episode at this position (from the library view)
 */
async function _animeTestSelectShow(show, resume) {
  // Flush any watch session still pending from whichever show was open
  // before this call — setView()'s own flush only fires when *leaving*
  // anime-details entirely, so clicking a related-show card (Seasons/You
  // Might Also Like) while already on anime-details skips it: this
  // function is about to overwrite _animeTestCurrent below, and
  // _animeTestFlushWatchSession() reads _animeTestCurrent at flush time —
  // called after that overwrite, it would credit the previous show's
  // elapsed watch time to the new one instead.
  if (_animeTestCurrent?.idMal !== show?.idMal) _animeTestFlushWatchSession();

  // Reset any player left over from whichever show/episode was open before
  // this navigation — otherwise the previous anime's video just sits there
  // (paused, wrong title) until a new episode row is clicked.
  if (_animeTestHls) {
    _animeTestHls.destroy();
    _animeTestHls = null;
  }
  const video = $("animeTestVideo");
  video.pause();
  video.removeAttribute("src");
  video.load();
  _animeTestCurrentEpisode = null;

  _animeTestCurrent = show;
  $("animeTestShowTitle").textContent = show.title;
  $("animeTestShowTitle2").textContent = show.title;
  $("animeTestScoreMeta").textContent = show.score ? `★ ${(show.score / 10).toFixed(1)} (AniList)` : "";
  _animeTestSetCoverThumb(show.cover || "");
  $("animeTestEpisodeCrumb").textContent = "";
  $("animeTestEpisodeMeta").textContent = "";
  $("animeTestDescription").textContent = ""; // repopulated by _animeTestLoadExtendedDetails below once fetched
  $("animeTestStats").innerHTML = "";
  $("animeTestLinks").innerHTML = "";
  $("animeTestBadgeRow").innerHTML = "";
  $("animeTestGenrePills").innerHTML = "";
  $("animeTestEpisodeCountBadge").textContent = "";
  $("animeRecommendedSection").classList.add("hidden");
  $("animeSeasonsSection").classList.add("hidden");
  $("animeMoviesSection")?.classList.add("hidden");
  $("animeTestMangaCheckResult").classList.add("hidden");
  $("animeTestMangaCheckResult").innerHTML = "";
  _animeTestUpdateQualitySelect([], '');

  // Unknown total (still airing) or a resumed episode beyond the known
  // count (show.episodes can be stale vs. what was actually saved) both
  // need the range extended rather than truncated.
  _animeTestEpisodeCount = Math.max(show.episodes || 24, resume?.episode || 0);

  await _animeTestRefreshFavoriteButton(); // also sets _animeTestWatchedUpTo, needed before the grid renders "watched" chips
  _animeTestRenderEpisodeGrid(resume?.episode || _animeTestWatchedUpTo || 1);
  _animeTestLoadExtendedDetails(show.idMal);

  if (resume?.episode) {
    _animeTestPlayEpisode(resume.episode, resume.positionSeconds || 0);
  }
}

// "Refresh" button on the episode list — AniList already carries an
// authoritative episode count independent of any streaming source, so this
// just re-queries that (same idMal-keyed Media lookup _animeTestLoadExtendedDetails
// already uses) and hands the fresh number to /api/anime/refresh-item, which
// does the "did this actually grow since last time" comparison server-side
// (see routes/anime.js) — this only needs to act on the result.
async function _animeTestRefreshEpisodeCount() {
  const show = _animeTestCurrent;
  if (!show?.idMal) return;
  const btn = $("refreshAnimeBtn");
  const prevHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.textContent = "Refreshing..."; }

  try {
    // Shared with ui-updates.js's startup sweep (_fetchAniListEpisodeCountForSweep)
    // rather than a second copy of the same query — that one already retries
    // once on an AniList rate-limit response, which this manual "Refresh"
    // button used to lack entirely (a plain query with no retry), a
    // robustness fix that had drifted into only one of the two copies.
    const freshCount = await _fetchAniListEpisodeCountForSweep(show.idMal);
    if (!freshCount) {
      showToast("Refresh", "AniList doesn't have an episode count for this show yet.", "info");
      return;
    }

    const result = await api("/api/anime/refresh-item", {
      method: "POST",
      body: JSON.stringify({ idMal: show.idMal, totalEpisodes: freshCount })
    });

    if (result.isUpdate) {
      showToast("New episodes!", `${result.newEpisodes} new episode${result.newEpisodes !== 1 ? "s" : ""} found.`, "success");
    } else {
      showToast("Refreshed", "No new episodes — you're up to date.", "info");
    }

    show.episodes = freshCount;
    _animeTestEpisodeCount = Math.max(freshCount, _animeTestWatchedUpTo || 0);
    _animeTestRenderEpisodeGrid(_animeTestWatchedUpTo || 1);
  } catch (err) {
    showToast("Refresh failed", err.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = prevHtml; }
  }
}

// ── Episode grid (M4 polish) — a flat 1000+-row list (e.g. One Piece) was
// both slow to render and unusable to scan, so long-running shows are
// chunked into 100-episode ranges (matching the reference layout) with only
// the active range's chips actually in the DOM at once.
let _animeTestEpisodeCount = 0;
let _animeTestWatchedUpTo = 0;
const ANIME_EPISODE_RANGE_SIZE = 100;

function _animeTestRenderEpisodeGrid(focusEpisode = 1) {
  const rangeSel = $("animeTestEpisodeRange");
  const count = _animeTestEpisodeCount;

  if (count > ANIME_EPISODE_RANGE_SIZE) {
    const options = [];
    for (let start = 1; start <= count; start += ANIME_EPISODE_RANGE_SIZE) {
      const end = Math.min(start + ANIME_EPISODE_RANGE_SIZE - 1, count);
      options.push(`<option value="${start}">${start} - ${end}</option>`);
    }
    rangeSel.innerHTML = options.join("");
    const focusRangeStart = Math.floor((focusEpisode - 1) / ANIME_EPISODE_RANGE_SIZE) * ANIME_EPISODE_RANGE_SIZE + 1;
    rangeSel.value = String(focusRangeStart);
    rangeSel.classList.remove("hidden");
    rangeSel.onchange = () => _animeTestRenderEpisodeGridRange(parseInt(rangeSel.value, 10));
    _animeTestRenderEpisodeGridRange(focusRangeStart);
  } else {
    rangeSel.classList.add("hidden");
    rangeSel.innerHTML = ""; // clear stale ranges from whatever show was open before (harmless while hidden, but wrong state to leave sitting in the DOM)
    _animeTestRenderEpisodeGridRange(1);
  }
}

function _animeTestRenderEpisodeGridRange(rangeStart) {
  const listEl = $("animeTestEpisodeList");
  const rangeEnd = Math.min(rangeStart + ANIME_EPISODE_RANGE_SIZE - 1, _animeTestEpisodeCount);
  const chips = [];
  for (let i = rangeStart; i <= rangeEnd; i++) {
    const watched = i <= _animeTestWatchedUpTo ? " watched" : "";
    chips.push(`<div class="anime-episode-chip${watched}" data-ep="${i}">${i}</div>`);
  }
  listEl.innerHTML = chips.join("");
  listEl.querySelectorAll(".anime-episode-chip").forEach(chip => {
    chip.onclick = () => _animeTestPlayEpisode(parseInt(chip.dataset.ep, 10));
  });
  _animeTestApplyEpisodeFilter();
  // Highlight-if-present only — deliberately NOT _animeTestSetActiveEpisodeRow,
  // which also jumps the range dropdown to wherever the active episode is.
  // That's right when a new episode starts playing, but wrong here: this
  // path also runs when the user manually browses to a *different* range to
  // look around, and jumping them back to the playing episode's range on
  // every render made the dropdown feel broken (confirmed live — selecting
  // an earlier range snapped straight back).
  listEl.querySelectorAll(".anime-episode-chip").forEach(chip => {
    chip.classList.toggle("active", parseInt(chip.dataset.ep, 10) === _animeTestCurrentEpisode);
  });
}

function _animeTestApplyEpisodeFilter() {
  const raw = $("animeTestEpisodeFilter")?.value.trim() || "";
  const listEl = $("animeTestEpisodeList");
  listEl.querySelectorAll(".anime-episode-chip").forEach(chip => {
    const matches = !raw || chip.dataset.ep.includes(raw);
    chip.classList.toggle("filtered-out", !matches);
  });
}

function _animeTestFormatDate(d) {
  if (!d?.year) return "—";
  const parts = [d.year];
  if (d.month) parts.unshift(String(d.month).padStart(2, '0'));
  if (d.day) parts.unshift(String(d.day).padStart(2, '0'));
  return parts.reverse().join('/');
}

function _animeTestRenderStats(m) {
  // Whichever title the page is already showing up top (show.title, set in
  // _animeTestSelectShow — normally title.english, falling back to romaji
  // then native, same fallback chain used everywhere else in this file) is
  // the "primary" one. "Japanese Title" here is AniList's romaji field
  // (e.g. "Hajime no Ippo", "Koe no Katachi") — the romanized name, not the
  // native 日本語/kanji script (explicitly not wanted). Both romaji and
  // English are shown independently whenever each exists and differs from
  // the primary, rather than picking only one — a show whose primary is
  // already the romaji title (no distinct English title) correctly gets no
  // extra "Japanese Title" row, since it's already on screen.
  const mainTitle = (_animeTestCurrent?.title || '').trim().toLowerCase();
  const englishTitle = m.title?.english?.trim() || null;
  const romajiTitle = m.title?.romaji?.trim() || null;
  const altRows = [];
  if (romajiTitle && romajiTitle.toLowerCase() !== mainTitle) altRows.push(["Japanese Title", romajiTitle]);
  if (englishTitle && englishTitle.toLowerCase() !== mainTitle) altRows.push(["English Title", englishTitle]);

  const rows = [
    ...altRows,
    ["Format", m.format],
    ["Status", m.status ? m.status.charAt(0) + m.status.slice(1).toLowerCase().replace(/_/g, ' ') : null],
    ["Episodes", m.episodes
      ? `${m.episodes}${m.nextAiringEpisode ? ` (${m.nextAiringEpisode.episode - 1} aired)` : ''}`
      // AniList's `episodes` is null for a still-airing show with an
      // unknown final count (One Piece, etc.) — nextAiringEpisode.episode-1
      // (the last confirmed-aired episode) is a real number worth showing
      // instead of the bare "Airing" text, which told the user nothing.
      : (m.nextAiringEpisode?.episode ? `${m.nextAiringEpisode.episode - 1} aired` : (m.status === 'RELEASING' ? 'Airing' : null))],
    ["Duration", m.duration ? `${m.duration} min` : null],
    ["Season", m.season ? `${m.season.charAt(0)}${m.season.slice(1).toLowerCase()} ${m.seasonYear || ''}` : null],
    ["Start Date", m.startDate?.year ? _animeTestFormatDate(m.startDate) : null],
    ["End Date", m.endDate?.year ? _animeTestFormatDate(m.endDate) : null],
    ["Country", m.countryOfOrigin],
    ["Adult", m.isAdult ? "Yes" : "No"],
    ["Studios", (m.studios?.nodes || []).map(s => s.name).join(', ') || null],
  ].filter(([, v]) => v);

  $("animeTestStats").innerHTML = rows.map(([label, value]) =>
    `<div class="stat-row"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-value">${escapeHtml(String(value))}</span></div>`
  ).join("");

  // Pill-styled (not btn btn-secondary) — these sit inline with the SUB/
  // DUB pills now (see index.html's anime-watch-server-row), not in their
  // own row below the player.
  const links = [];
  if (m.siteUrl) links.push(`<a class="anime-pill" href="${escapeHtml(m.siteUrl)}" target="_blank" rel="noopener noreferrer">AniList</a>`);
  if (m.idMal) links.push(`<a class="anime-pill" href="https://myanimelist.net/anime/${m.idMal}" target="_blank" rel="noopener noreferrer">MyAnimeList</a>`);
  if (m.trailer?.site === 'youtube' && m.trailer?.id) links.push(`<a class="anime-pill" href="https://www.youtube.com/watch?v=${escapeHtml(m.trailer.id)}" target="_blank" rel="noopener noreferrer">▶ Trailer</a>`);
  $("animeTestLinks").innerHTML = links.join("");
}

// Info-sidebar badge row (episode count / airing status) + genre pill row —
// visual-only, reuses the same AniList fields _animeTestRenderStats already
// has (no extra fetch).
function _animeTestRenderBadgesAndGenres(m) {
  const episodeCount = m.episodes
    ? `${m.episodes} EP`
    : (m.nextAiringEpisode?.episode ? `${m.nextAiringEpisode.episode - 1} EP` : null);
  const countBadge = $("animeTestEpisodeCountBadge");
  if (countBadge) countBadge.textContent = episodeCount ? `(${episodeCount})` : "";

  const statusLabel = m.status ? m.status.replace(/_/g, ' ') : null;
  const badges = [];
  if (episodeCount) badges.push(`<span class="anime-watch-badge">&#127909; ${escapeHtml(episodeCount)}</span>`);
  if (statusLabel) badges.push(`<span class="anime-watch-badge status-${escapeHtml((m.status || '').toLowerCase())}">${escapeHtml(statusLabel)}</span>`);
  if (m.format) badges.push(`<span class="anime-watch-badge">${escapeHtml(m.format.replace(/_/g, ' '))}</span>`);
  $("animeTestBadgeRow").innerHTML = badges.join("");

  const genres = (m.genres || []).slice(0, 6);
  // Clickable — see _initAnimeTestView's delegated click handler, which
  // jumps to Advanced Search (anime mode) pre-filtered to just this genre.
  // AniList's genres field only ever draws from its fixed 19-value enum
  // (see ui-anime-advanced-search.js's own comment on that), so every pill
  // rendered here is guaranteed to have a matching #animeGenreGrid checkbox.
  $("animeTestGenrePills").innerHTML = genres.map(g => `<button type="button" class="anime-genre-pill" data-genre="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join("");
}

function _animeTestSetCoverThumb(url) {
  const img = $("animeTestCoverImg");
  if (!img) return;
  if (url) {
    img.src = url;
    img.classList.remove("hidden");
  } else {
    img.removeAttribute("src");
    img.classList.add("hidden");
  }
}

// Shared by the Seasons and "You Might Also Like" rows — same card shape,
// same click-to-details behavior, just different AniList edges feeding them.
function _animeTestRelatedCardHTML(m) {
  const title = m.title?.romaji || m.title?.english || `AniList MAL#${m.idMal}`; // romaji-first for anime, at the user's request
  // extraLarge before large — AniList's "large" field is actually their
  // medium-res file (compare the CDN paths), "extraLarge" is the real big
  // one. See the fix note on ANIME_DISCOVER_MEDIA_FIELDS (ui-anime-
  // discover.js) for the full explanation; every anime cover query in this
  // app got the same fix together.
  const cover = m.coverImage?.extraLarge || m.coverImage?.large || "";
  return `<div class="manga-card" data-idmal="${m.idMal}" data-anilist-id="${m.id || ''}" data-title="${escapeHtml(title)}" data-cover="${escapeHtml(cover)}" data-episodes="${m.episodes || ''}">
    <div class="manga-card-cover">
      <img src="${escapeHtml(cover)}" alt="${escapeHtml(title)}" loading="lazy">
    </div>
    <div class="manga-card-info">
      <div class="manga-card-title">${escapeHtml(title)}</div>
    </div>
  </div>`;
}

// Walks the PREQUEL chain backwards and the SEQUEL chain forwards from the
// currently open show, one AniList request per extra hop — the first hop in
// each direction is free (reuses the edges the details query already
// fetched); only reaching further needs a new request, and only if that
// direction actually has something to find. Capped both ways so a
// pathological relations graph can't spiral into a rate-limit problem.
const ANIME_SEASON_CHAIN_MAX_HOPS = 5;

async function _animeTestFetchRelationsFor(idMal) {
  try {
    const data = await anilistGQL(
      `query ($idMal: Int) {
        Media(idMal: $idMal, type: ANIME) {
          relations { edges { relationType node { type idMal format episodes title { romaji english } coverImage { extraLarge large } } } }
        }
      }`,
      { idMal: Number(idMal) }
    );
    return data?.data?.Media?.relations?.edges || [];
  } catch (_) {
    return [];
  }
}

// AniList's PREQUEL/SEQUEL relation is crowd-maintained and, for
// long-running franchises with lots of tie-in media, occasionally tags a
// movie/special/OVA as a "sequel" of the main show even though no user
// would call it "the next season" (confirmed live: One Piece — a single
// continuous, ongoing TV entry with no real multi-season split on AniList
// at all — surfaced one unrelated movie/special this way, as the sole
// "season" found). Real seasons of a franchise are consistently the same
// broadcast format as the show itself; excluding the tie-in formats below
// filters this out without needing an exact-format match (a real season
// can occasionally differ, e.g. TV -> TV_SHORT, and should still count).
const ANIME_NON_SEASON_FORMATS = new Set(['MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC']);

// Movies are collected as a side effect of the same walk, from every hop's
// edges (not just the one PREQUEL/SEQUEL edge each hop follows) — this is
// deliberately scoped to "the franchise chain this show belongs to" rather
// than a global movie search, so opening any Dragon Ball season surfaces
// Dragon Ball movies specifically, using network calls the season walk was
// already making rather than a separate query.
function _animeCollectMovies(edges, seen, moviesByIdMal) {
  for (const e of edges) {
    const n = e.node;
    if (n?.type === 'ANIME' && n.format === 'MOVIE' && n.idMal && !seen.has(Number(n.idMal))) {
      moviesByIdMal.set(Number(n.idMal), n);
    }
  }
}

async function _animeTestExpandSeasonChain(initialEdges, startIdMal) {
  const seen = new Set([Number(startIdMal)]);
  const moviesByIdMal = new Map();
  const pick = (edges, relationType) => edges.find(e =>
    e.node?.type === 'ANIME' && e.relationType === relationType && e.node.idMal &&
    !seen.has(Number(e.node.idMal)) && !ANIME_NON_SEASON_FORMATS.has(e.node.format)
  );

  _animeCollectMovies(initialEdges, seen, moviesByIdMal);

  const prequels = [];
  let edges = initialEdges;
  for (let i = 0; i < ANIME_SEASON_CHAIN_MAX_HOPS; i++) {
    const edge = pick(edges, 'PREQUEL');
    if (!edge) break;
    seen.add(Number(edge.node.idMal));
    prequels.unshift(edge.node);
    edges = await _animeTestFetchRelationsFor(edge.node.idMal);
    _animeCollectMovies(edges, seen, moviesByIdMal);
  }

  const sequels = [];
  edges = initialEdges;
  for (let i = 0; i < ANIME_SEASON_CHAIN_MAX_HOPS; i++) {
    const edge = pick(edges, 'SEQUEL');
    if (!edge) break;
    seen.add(Number(edge.node.idMal));
    sequels.push(edge.node);
    edges = await _animeTestFetchRelationsFor(edge.node.idMal);
    _animeCollectMovies(edges, seen, moviesByIdMal);
  }

  return { seasons: [...prequels, ...sequels], movies: [...moviesByIdMal.values()] };
}

function _animeTestBindRelatedCards(container) {
  container.querySelectorAll("[data-idmal]").forEach(card => {
    card.onclick = () => {
      _animeGoToDetails({
        idMal: card.dataset.idmal,
        anilistId: card.dataset.anilistId,
        title: card.dataset.title,
        cover: card.dataset.cover,
        episodes: parseInt(card.dataset.episodes, 10) || 0,
      });
    };
  });
}

// AniList's own community-curated "recommendations" edge (not a genre/tag
// string-match reimplementation) — it's already exactly "anime similar to
// this one," available for free off the same API this whole feature already
// depends on. Fetched together with the rest of the details-page data (one
// request) rather than as a separate round-trip.
async function _animeTestLoadExtendedDetails(idMal) {
  const section = $("animeRecommendedSection");
  const row = $("animeRecommendedRow");
  section.classList.add("hidden");
  row.innerHTML = "";

  // This used to fail completely silently on an AniList rate-limit (a real,
  // recurring issue in this app — the startup library sync alone can
  // exhaust the shared budget) — the description/stats/links area just
  // stayed blank forever with no indication anything had gone wrong, which
  // reads as "stuck loading" rather than "failed." Now: a visible loading
  // state, one retry on rate-limit, and a real retry button on failure.
  $("animeTestDescription").textContent = "Loading details...";

  const query = `query ($idMal: Int) {
        Media(idMal: $idMal, type: ANIME) {
          title { romaji english }
          description(asHtml: false)
          coverImage { extraLarge large }
          genres format status episodes duration countryOfOrigin isAdult siteUrl idMal
          season seasonYear
          startDate { year month day }
          endDate { year month day }
          studios(isMain: true) { nodes { name } }
          trailer { id site }
          nextAiringEpisode { episode }
          relations {
            edges {
              relationType
              node { type idMal id format episodes title { romaji english } coverImage { extraLarge large } }
            }
          }
          recommendations(sort: RATING_DESC, perPage: 12) {
            nodes {
              mediaRecommendation {
                id idMal episodes
                title { romaji english }
                coverImage { extraLarge large }
              }
            }
          }
        }
      }`;

  try {
    let data = await anilistGQL(query, { idMal: Number(idMal) });
    if (data?.errors?.some(e => /rate limit|too many requests/i.test(e.message || ''))) {
      await new Promise(r => setTimeout(r, 3000));
      data = await anilistGQL(query, { idMal: Number(idMal) });
    }
    if (data?.errors?.length || !data?.data?.Media) {
      $("animeTestDescription").innerHTML = `Couldn't load details. <a href="#" id="animeTestDetailsRetry" class="anime-watch-breadcrumb-link">Retry</a>`;
      const retryLink = $("animeTestDetailsRetry");
      if (retryLink) retryLink.onclick = (e) => { e.preventDefault(); _animeTestLoadExtendedDetails(idMal); };
      return;
    }

    const media = data?.data?.Media;
    if (!media) return;

    // Whatever title the header was set to when this page opened (show.title
    // — from a card's data-title, or a favorite's stored f.title, which for
    // anime favorited before romaji became the preference is still the old
    // English one) gets corrected here to romaji-first, now that the real
    // AniList title object is in hand. This is the one place that needs to
    // do the correcting — every entry point into this page funnels through
    // here, including old library favorites whose persisted title predates
    // this preference and was never going to update on its own.
    const preferredTitle = media.title?.romaji || media.title?.english || _animeTestCurrent.title;
    if (preferredTitle && preferredTitle !== _animeTestCurrent.title) {
      _animeTestCurrent.title = preferredTitle;
      $("animeTestShowTitle").textContent = preferredTitle;
      $("animeTestShowTitle2").textContent = preferredTitle;
    }

    const rawDescription = media.description || "";
    // asHtml:false still leaves AniList's own <br> line breaks in — strip
    // any stray markup rather than trust it's fully plain. Shown in full
    // now that the description lives in the center column (real width
    // there) instead of the narrow left sidebar — no more collapse/
    // truncate-with-a-click-to-expand.
    $("animeTestDescription").textContent = rawDescription.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    _animeTestRenderStats(media);
    _animeTestRenderBadgesAndGenres(media);

    // Corrects the initial episode-grid guess against the real aired count,
    // in *either* direction — not just upward. Two distinct cases:
    //  - Unknown total, still airing (One Piece, etc.): AniList's `episodes`
    //    is null, so _animeTestSelectShow's Math.max(show.episodes || 24, ...)
    //    falls back to a placeholder of 24 — needs correcting UP to the real
    //    (large) aired count.
    //  - Known total, still airing (Grand Blue Dreaming S3, etc.): AniList's
    //    `episodes` is the full planned count (e.g. 12) even though only
    //    some have aired (e.g. 8) — the grid was showing all 12 as
    //    clickable when 9-12 don't exist yet and would just fail to play;
    //    needs correcting DOWN to the real aired count instead.
    // Once a show is no longer airing (no nextAiringEpisode), the full
    // `episodes` count is the real count and needs no correction either way.
    const lastAired = media.nextAiringEpisode?.episode ? media.nextAiringEpisode.episode - 1 : media.episodes;
    if (lastAired && lastAired !== _animeTestEpisodeCount) {
      _animeTestEpisodeCount = lastAired;
      _animeTestRenderEpisodeGrid(_animeTestWatchedUpTo || 1);
    }

    // Backfills genres for shows opened from an entry point that didn't
    // already have them (calendar/library cards, direct nav) — search
    // results carry genres from the start, this just closes the gap so
    // favoriting from *any* details page can feed the homepage's
    // recommendation scoring (see ui-anime-discover.js).
    if (_animeTestCurrent && (!_animeTestCurrent.genres || !_animeTestCurrent.genres.length) && Array.isArray(media.genres)) {
      _animeTestCurrent.genres = media.genres;
    }
    // Same backfill idea as genres above, but format needs to actually
    // persist (not just live in memory for this page view) since it's what
    // makes the library/history cards show "Movie" instead of "Ep 1/1" —
    // see _animeFavoriteCardHTML. A favorite added before this field
    // existed only gets a chance to pick it up by having its details page
    // visited again, which is exactly this code path.
    if (_animeTestCurrent && media.format) {
      const formatJustDiscovered = _animeTestCurrent.format !== media.format;
      _animeTestCurrent.format = media.format;
      if (_animeTestFavoriteEntry && _animeTestFavoriteEntry.format !== media.format) {
        _animeTestFavoriteEntry.format = media.format;
        fetch('/api/anime/format', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idMal: _animeTestCurrent.idMal, format: media.format }),
        }).catch(() => {});
      }
      // Auto-resume (a favorited show's card is clicked from the library)
      // calls _animeTestPlayEpisode before this async fetch resolves, so its
      // own Discord report has no way of knowing yet whether this is a
      // movie — confirmed live: it always sent the bare "Episode 1 · Sub"
      // subtitle for a movie played this way. Once format is actually
      // known, correct that report in place if a session is still active,
      // same "fix the initial guess once real data arrives" idea as the
      // episode-count correction below.
      if (formatJustDiscovered && media.format === 'MOVIE' && _animeTestCurrentEpisode && typeof discordPresenceReport === 'function') {
        const dub = $("animeTestDubToggle")?.checked || false;
        discordPresenceReport({
          details: `Watching ${_animeTestCurrent.title || ''}`,
          subtitle: dub ? 'Dub' : 'Sub',
          cover: _animeTestCurrent.cover || '',
          iconKind: 'anime',
          largeText: _animeTestCurrent.title || '',
        });
      }
    }
    const bestMediaCover = media.coverImage?.extraLarge || media.coverImage?.large;
    if (_animeTestCurrent && !_animeTestCurrent.cover && bestMediaCover) {
      _animeTestCurrent.cover = bestMediaCover;
      _animeTestSetCoverThumb(bestMediaCover);
    }

    // Seasons — AniList's relations only expose the immediate PREQUEL/SEQUEL
    // (confirmed live: Season 3 links to Season 2 but not Season 1 at all),
    // so a franchise with 3+ seasons needs the chain walked one hop at a
    // time to surface everything.
    const seasonsSection = $("animeSeasonsSection");
    const seasonsRow = $("animeSeasonsRow");
    const moviesSection = $("animeMoviesSection");
    const moviesRow = $("animeMoviesRow");
    const { seasons: seasonNodes, movies: movieNodes } = await _animeTestExpandSeasonChain(media.relations?.edges || [], idMal);
    if (seasonNodes.length) {
      seasonsRow.innerHTML = seasonNodes.map(n => _animeTestRelatedCardHTML(n)).join("");
      _animeTestBindRelatedCards(seasonsRow);
      seasonsSection.classList.remove("hidden");
      initRowAutoScroll(seasonsRow, _animeTestBindRelatedCards);
    } else {
      seasonsSection.classList.add("hidden");
      seasonsRow.innerHTML = "";
    }
    if (moviesSection && moviesRow) {
      if (movieNodes.length) {
        moviesRow.innerHTML = movieNodes.map(n => _animeTestRelatedCardHTML(n)).join("");
        _animeTestBindRelatedCards(moviesRow);
        moviesSection.classList.remove("hidden");
        initRowAutoScroll(moviesRow, _animeTestBindRelatedCards);
      } else {
        moviesSection.classList.add("hidden");
        moviesRow.innerHTML = "";
      }
    }

    const recs = (media.recommendations?.nodes || [])
      .map(n => n.mediaRecommendation)
      .filter(m => m && m.idMal);
    if (!recs.length) return;

    row.innerHTML = recs.map(m => _animeTestRelatedCardHTML(m)).join("");
    _animeTestBindRelatedCards(row);
    section.classList.remove("hidden");
    initRowAutoScroll(row, _animeTestBindRelatedCards);
  } catch (e) {
    dbg.warn(dbg.ERR_SOURCE, "Anime recommendations failed", e);
    $("animeTestDescription").innerHTML = `Couldn't load details. <a href="#" id="animeTestDetailsRetry" class="anime-watch-breadcrumb-link">Retry</a>`;
    const retryLink = $("animeTestDetailsRetry");
    if (retryLink) retryLink.onclick = (e2) => { e2.preventDefault(); _animeTestLoadExtendedDetails(idMal); };
  }
}

function _animeTestSetActiveEpisodeRow(episode) {
  if (!episode) return;
  const rangeSel = $("animeTestEpisodeRange");
  const listEl = $("animeTestEpisodeList");

  // If the target episode isn't in the currently-rendered range (e.g.
  // autoplay just crossed a 100-episode boundary), switch ranges first —
  // otherwise this silently no-ops because the chip doesn't exist yet.
  if (!rangeSel.classList.contains("hidden")) {
    const targetRangeStart = Math.floor((episode - 1) / ANIME_EPISODE_RANGE_SIZE) * ANIME_EPISODE_RANGE_SIZE + 1;
    if (parseInt(rangeSel.value, 10) !== targetRangeStart) {
      rangeSel.value = String(targetRangeStart);
      _animeTestRenderEpisodeGridRange(targetRangeStart); // re-enters this function with the right range already in the DOM
      return;
    }
  }

  listEl?.querySelectorAll(".anime-episode-chip").forEach(chip => {
    chip.classList.toggle("active", parseInt(chip.dataset.ep, 10) === episode);
  });
  const active = listEl?.querySelector(".anime-episode-chip.active");
  active?.scrollIntoView({ block: "nearest" });
}

// ── "Does this anime have a manga?" check ─────────────────────────────────
// AniList's `relations` edge covers both directions (ADAPTATION covers
// manga→anime and anime→manga alike) — same idea as the existing
// ui-anime-film-adaptation-check-via-anilist-graphql.js, which checks the
// opposite direction (does a MANGA have an anime), just not reusable as-is
// since that one is wired to the manga-details page's DOM/state instead.
// Searches every installed manga source for an exact (case/whitespace
// -insensitive) title match — used by the "Check for Manga" redirect so it
// can send the user straight to the actual manga instead of just linking
// out to its AniList page. Checked in parallel (typically only a handful
// of sources); returns the first exact match found, or null.
async function _animeTestFindInstalledManga(title) {
  const target = String(title || '').toLowerCase().trim();
  if (!target) return null;
  const sourceIds = typeof getSelectableSourceIds === 'function' ? getSelectableSourceIds() : [];

  const attempts = await Promise.allSettled(sourceIds.map(async (sid) => {
    const data = await api(`/api/source/${sid}/search`, {
      method: "POST",
      body: JSON.stringify({ query: title, page: 1 }),
    });
    const match = (data?.results || []).find(m => String(m.title || '').toLowerCase().trim() === target);
    return match ? { manga: match, sourceId: sid } : null;
  }));

  for (const a of attempts) {
    if (a.status === 'fulfilled' && a.value) return a.value;
  }
  return null;
}

async function _animeTestCheckForManga() {
  if (!_animeTestCurrent) return;
  const btn = $("animeTestMangaCheckBtn");
  const resultEl = $("animeTestMangaCheckResult");
  const originalText = btn.textContent;
  btn.textContent = "Checking...";
  btn.disabled = true;
  resultEl.classList.add("hidden");
  resultEl.innerHTML = "";

  const query = `query ($idMal: Int) {
    Media(idMal: $idMal, type: ANIME) {
      relations {
        edges {
          relationType
          node { type siteUrl title { romaji english } coverImage { extraLarge large } }
        }
      }
    }
  }`;

  try {
    // AniList's rate limit is shared with everything else this app does on
    // startup (library sync, etc.) and gets exhausted easily — a single 429
    // used to surface as a flat failure here. One retry after a short delay
    // covers the common case where the limit has already cleared by then.
    let data = await anilistGQL(query, { idMal: Number(_animeTestCurrent.idMal) });
    if (data?.errors?.some(e => /rate limit|too many requests/i.test(e.message || ''))) {
      showToast("Manga check", "AniList rate limit hit — retrying in a moment...", "info");
      await new Promise(r => setTimeout(r, 3000));
      data = await anilistGQL(query, { idMal: Number(_animeTestCurrent.idMal) });
    }
    if (data?.errors?.length) throw new Error(data.errors[0]?.message || "Check failed");

    const edges = data?.data?.Media?.relations?.edges || [];
    const mangaEdges = edges.filter(e => e.node?.type === 'MANGA' && (e.relationType === 'ADAPTATION' || e.relationType === 'SOURCE'));
    // A long-running series can have several MANGA adaptation edges at once
    // (one-shot prototypes, side-story spin-offs, the compiled main series
    // all show up as separate ADAPTATION relations) — confirmed live for
    // One Piece: 4 candidates, only one of which is the actual manga.
    // Prefer whichever title matches the anime's own name most closely,
    // falling back to the first candidate if nothing matches well.
    const animeTitle = (_animeTestCurrent.title || '').toLowerCase().trim();
    const mangaEdge = mangaEdges.find(e => {
      const t = (e.node.title?.english || e.node.title?.romaji || '').toLowerCase().trim();
      return t === animeTitle;
    }) || mangaEdges[0];

    if (mangaEdge) {
      const title = mangaEdge.node.title?.english || mangaEdge.node.title?.romaji || "Manga";
      const cover = mangaEdge.node.coverImage?.extraLarge || mangaEdge.node.coverImage?.large || "";
      const siteUrl = mangaEdge.node.siteUrl || "";

      // Prefer sending the user straight to the manga inside the app over
      // just linking out to its AniList page — searches installed sources
      // for this exact title and redirects if one has it. Falls back to
      // the AniList link only when nothing installed actually carries it,
      // since there's nowhere in-app to send them in that case.
      btn.textContent = "Found — searching your sources...";
      const found = await _animeTestFindInstalledManga(title);
      if (found) {
        showToast("Manga found", `"${title}" — opening it.`, "success");
        await loadMangaDetails(found.manga.id, "anime-details", title, false, found.sourceId);
        return;
      }

      // A real <a href target=_blank> the user clicks themselves — not
      // window.open() from here, which fires after an await and gets
      // silently popup-blocked in most browsers (that's why nothing used
      // to visibly happen after the "Manga found" toast).
      resultEl.innerHTML = `
        ${cover ? `<img src="${escapeHtml(cover)}" alt="${escapeHtml(title)}" loading="lazy">` : ""}
        <div class="anime-manga-check-card-info">
          <div class="anime-manga-check-card-label">Manga found (not in your installed sources)</div>
          <div class="anime-manga-check-card-title">${escapeHtml(title)}</div>
        </div>
        ${siteUrl ? `<a class="btn btn-secondary" href="${escapeHtml(siteUrl)}" target="_blank" rel="noopener noreferrer">Open on AniList</a>` : ""}
      `;
      resultEl.classList.remove("hidden");
    } else {
      showToast("Manga check", "No manga adaptation/source found on AniList for this anime.", "info");
    }
  } catch (e) {
    showToast("Manga check", `Failed: ${e.message}`, "error");
    dbg.warn(dbg.ERR_SOURCE, "Anime manga-check failed", e);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// ── Categories (M4 polish) — shares store.customLists with the manga side
// (see schema.js's animeItems comment): one set of named categories, an
// anime just tracks membership the same way a manga does. ────────────────

async function _animeTestToggleCategoriesPanel() {
  const panel = $("animeTestCategoriesPanel");
  if (!panel.classList.contains("hidden")) {
    panel.classList.add("hidden");
    return;
  }
  if (!_animeTestCurrent) return;

  panel.innerHTML = `<div class="muted">Loading...</div>`;
  panel.classList.remove("hidden");

  try {
    const [listsResp, catsResp] = await Promise.all([
      fetch("/api/lists").then(r => r.json()),
      fetch(`/api/lists/anime/${encodeURIComponent(_animeTestCurrent.idMal)}/categories`).then(r => r.json()),
    ]);
    const lists = listsResp.lists || [];
    const activeIds = new Set(catsResp.categoryIds || []);

    if (!lists.length) {
      panel.innerHTML = `<div class="muted">No categories yet — create one from My Manga's Library page first.</div>`;
      return;
    }

    panel.innerHTML = lists.map(l =>
      `<label><input type="checkbox" data-list-id="${escapeHtml(l.id)}" ${activeIds.has(l.id) ? 'checked' : ''}> ${escapeHtml(l.name)}</label>`
    ).join("");

    panel.querySelectorAll("input[type=checkbox]").forEach(cb => {
      cb.onchange = () => _animeTestSaveCategories(panel);
    });
  } catch (e) {
    panel.innerHTML = `<div class="muted">Failed to load categories.</div>`;
    dbg.warn(dbg.ERR_SOURCE, "Anime categories load failed", e);
  }
}

async function _animeTestSaveCategories(panel) {
  const categoryIds = Array.from(panel.querySelectorAll("input[type=checkbox]:checked")).map(cb => cb.dataset.listId);
  try {
    const resp = await fetch("/api/lists/anime-categories", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idMal: _animeTestCurrent.idMal,
        categoryIds,
        animeData: { title: _animeTestCurrent.title, cover: _animeTestCurrent.cover },
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  } catch (e) {
    showToast("Anime (test)", `Couldn't save categories: ${e.message}`, "error");
  }
}

async function _animeTestRefreshFavoriteButton() {
  const btn = $("animeTestFavBtn");
  if (!btn || !_animeTestCurrent) return;
  _animeTestWatchedUpTo = 0;
  _animeTestPreferredProvider = null;
  try {
    const resp = await fetch("/api/anime/favorites");
    const data = await resp.json();
    const entry = (data.favorites || []).find(f => f.idMal === String(_animeTestCurrent.idMal));
    _animeTestIsFavorited = !!entry;
    _animeTestFavoriteEntry = entry || null;
    _animeTestWatchedUpTo = entry?.lastWatchedEpisode || 0;
    _animeTestPreferredProvider = entry?.preferredProvider || null;
  } catch (e) {
    _animeTestIsFavorited = false;
    _animeTestFavoriteEntry = null;
  }
  btn.textContent = _animeTestIsFavorited ? "In My Anime" : "Add to My Anime";
  btn.classList.toggle("active", _animeTestIsFavorited);
  // Preselect the favorite's stored preferredProvider, if one was ever set
  // (the UI that set it has since been removed, but existing values are
  // still honored) — anime favorites have no persisted provider otherwise
  // (see schema.js's animeFavorites comment), so this only applies when set.
  const providerSelect = $("animeTestProviderSelect");
  if (providerSelect && _animeTestPreferredProvider) {
    const hasOption = Array.from(providerSelect.options).some(o => o.value === _animeTestPreferredProvider);
    if (hasOption) providerSelect.value = _animeTestPreferredProvider;
  }
}

async function _animeTestToggleFavorite() {
  if (!_animeTestCurrent) return;
  try {
    const resp = await fetch("/api/anime/favorites/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idMal: _animeTestCurrent.idMal,
        anilistId: _animeTestCurrent.anilistId || null,
        title: _animeTestCurrent.title,
        cover: _animeTestCurrent.cover || "",
        totalEpisodes: _animeTestCurrent.episodes || 0,
        genres: _animeTestCurrent.genres || [],
        format: _animeTestCurrent.format || null,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    _animeTestIsFavorited = data.inLibrary;
    // The toggle endpoint doesn't echo back tags/watchStatus — good enough
    // for a just-favorited show (both start empty), and refreshed properly
    // next time _animeTestRefreshFavoriteButton runs (e.g. next navigation).
    _animeTestFavoriteEntry = _animeTestIsFavorited
      ? { idMal: _animeTestCurrent.idMal, anilistId: _animeTestCurrent.anilistId || null, title: _animeTestCurrent.title, cover: _animeTestCurrent.cover || "", totalEpisodes: _animeTestCurrent.episodes || 0, format: _animeTestCurrent.format || null, tags: [], watchStatus: null, lastWatchedEpisode: 0 }
      : null;
    const btn = $("animeTestFavBtn");
    btn.textContent = _animeTestIsFavorited ? "In My Anime" : "Add to My Anime";
    btn.classList.toggle("active", _animeTestIsFavorited);
    showToast("Anime (test)", _animeTestIsFavorited ? "Added to My Anime." : "Removed from My Anime.", "success");
  } catch (e) {
    showToast("Anime (test)", `Couldn't update My Anime: ${e.message}`, "error");
  }
}

// `requestedQuality` is only ever passed explicitly by the quality
// dropdown's own onchange (see _initAnimeTestView) — every other caller
// (episode row clicks, provider/dub toggles, autoplay) omits it, letting
// the server pick its own best default for whatever's now playing.
// ── Skip Opening — real per-episode timestamps from AniSkip (community-
// sourced, keyed by MAL id + episode), not a guessed fixed-length skip:
// openings vary in length between shows (and sometimes between episodes of
// the same show), so a fixed jump would either cut into the first scene or
// leave part of the opening playing. When AniSkip has no submission for
// this exact episode, no button is shown at all — no fallback guess.
let _animeTestSkipTimes = null; // {start, end} in seconds, or null

async function _animeTestFetchSkipTimes(idMal, episode, episodeLength) {
  try {
    const params = new URLSearchParams({ idMal: String(idMal), episode: String(episode) });
    if (episodeLength) params.append('episodeLength', String(Math.round(episodeLength)));
    const resp = await fetch(`/api/anime/skip-times?${params.toString()}`);
    const data = await resp.json();
    if (data?.found) return { start: data.start, end: data.end };
  } catch (_) { /* AniSkip unreachable — just don't show the button */ }
  return null;
}

function _animeTestUpdateSkipButtonVisibility(video) {
  const btn = $("animeTestSkipOpeningBtn");
  if (!btn) return;
  if (!_animeTestSkipTimes) { btn.classList.add("hidden"); return; }
  const inWindow = video.currentTime >= _animeTestSkipTimes.start && video.currentTime < _animeTestSkipTimes.end;
  btn.classList.toggle("hidden", !inWindow);
  // Auto Skip: jump straight past the opening instead of waiting for the
  // button click, still gated on the exact same real per-episode AniSkip
  // window as the manual button (see this file's header note on why a
  // guessed fixed-length skip was rejected) — just automates clicking it.
  if (inWindow && $("animeTestAutoSkipToggle")?.checked) {
    video.currentTime = _animeTestSkipTimes.end;
  }
}

// Keys popover — a small, static reference of playback shortcuts (native
// <video controls> already provide space/arrows/f; N is this app's own
// addition, wired in _initAnimeTestView). Toggled like the categories
// panel: one outside-click listener closes whichever of the two is open.
function _animeTestToggleKeysPopover() {
  let panel = $("animeTestKeysPopover");
  if (panel) { panel.remove(); return; }
  const btn = $("animeTestKeysBtn");
  if (!btn) return;
  panel = document.createElement("div");
  panel.id = "animeTestKeysPopover";
  panel.className = "anime-keys-popover";
  panel.innerHTML = `
    <div class="anime-keys-row"><kbd>Space</kbd><span>Play / pause</span></div>
    <div class="anime-keys-row"><kbd>&#8592; &#8594;</kbd><span>Seek back / forward</span></div>
    <div class="anime-keys-row"><kbd>&#8593; &#8595;</kbd><span>Volume up / down</span></div>
    <div class="anime-keys-row"><kbd>F</kbd><span>Fullscreen</span></div>
    <div class="anime-keys-row"><kbd>N</kbd><span>Next episode</span></div>
  `;
  btn.parentElement.style.position = "relative";
  btn.insertAdjacentElement("afterend", panel);
}
document.addEventListener("click", (e) => {
  const panel = $("animeTestKeysPopover");
  if (panel && !panel.contains(e.target) && e.target.id !== "animeTestKeysBtn") panel.remove();
});

// Watch-time analytics (streak/heatmap/AP parity with manga's
// recordReadingSession — see ui-anime-film-adaptation-check-via-anilist-
// graphql.js). Each _animeTestPlayEpisode call flushes whatever session was
// open for the PREVIOUS episode before starting a new one, and
// ui-view-management.js's setView() flushes on navigating away from
// anime-details entirely — between the two, every episode-watching session
// gets closed out exactly once, same "count it on session end" semantics
// manga already has (no completion-percentage check, just "did they open
// it and then move on").
function _animeTestFlushWatchSession() {
  if (!_animeTestWatchSessionStart) return;
  const minutes = Math.round(((Date.now() - _animeTestWatchSessionStart) / 60000) * 10) / 10;
  const idMal = _animeTestCurrent?.idMal;
  const title = _animeTestCurrent?.title;
  const episode = _animeTestCurrentEpisode;
  _animeTestWatchSessionStart = null;
  if (!idMal || !episode) return;

  fetch("/api/anime/analytics/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idMal, title, episode, duration: minutes }),
  }).catch(() => {});

  if (typeof checkAndUnlockAchievements === 'function') checkAndUnlockAchievements();
}

// Tries `provider` first, then falls back through the user's other
// visible providers (DEFAULT_VISIBLE_ANIME_PROVIDERS / settings.
// visibleAnimeProviders — declared further down this file, already
// initialized by the time this actually runs) when it comes up empty. A
// title missing from one provider's catalog is common (e.g. Crayon
// Shin-chan: AniZone has zero results, AnimePahe only has scattered movies,
// no main series — confirmed live) and shouldn't dead-end episode playback
// when another configured provider might have it. Collects every attempt's
// error so a total failure names what was actually tried, not just the
// first provider.
async function _animeTestFetchStreamWithFallback(malId, title, episode, dub, provider, quality, format) {
  const visible = Array.isArray(state.settings.visibleAnimeProviders) && state.settings.visibleAnimeProviders.length
    ? state.settings.visibleAnimeProviders
    : DEFAULT_VISIBLE_ANIME_PROVIDERS;
  const order = [provider, ..._animeFallbackOrder(visible).filter(p => p !== provider)];

  const attempts = [];
  for (const p of order) {
    try {
      const resp = await fetch("/api/anime/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // format (AniList's: TV, MOVIE, ...) lets a provider that finds a title by name refuse a movie as the series.
        body: JSON.stringify({ malId, title, episode, dub, provider: p, quality: quality || undefined, format: format || undefined }),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      return { data, provider: p };
    } catch (e) {
      attempts.push(`${p}: ${e.message}`);
    }
  }
  throw new Error(attempts.join(' · '));
}

async function _animeTestPlayEpisode(episode, seekTo = 0, requestedQuality = '') {
  if (!_animeTestCurrent) return;
  _animeTestFlushWatchSession();
  const video = $("animeTestVideo");
  const dub = $("animeTestDubToggle")?.checked || false;
  const provider = $("animeTestProviderSelect")?.value || "anizone";
  _animeTestCurrentEpisode = episode;
  _animeTestWatchSessionStart = Date.now();
  _animeTestSkipTimes = null;
  $("animeTestSkipOpeningBtn")?.classList.add("hidden");
  if (typeof window._animePlayerCloseSettingsMenu === 'function') window._animePlayerCloseSettingsMenu();

  const epText = `Episode ${episode}${dub ? ' · Dub' : ' · Sub'}`;
  $("animeTestEpisodeCrumb").textContent = epText;
  $("animeTestEpisodeMeta").textContent = epText;
  _animeTestSetActiveEpisodeRow(episode);

  // Discord Rich Presence: reported (not cleared) on every episode switch —
  // same show, new episode text. Falling back to the generic anime-details
  // view label happens once, in setView() (ui-view-management.js), when the
  // user leaves anime-details entirely, mirroring how
  // _animeTestFlushWatchSession's own analytics flush is split the same way
  // between here (per-episode) and there (page-leave).
  if (typeof discordPresenceReport === 'function') {
    // A movie's "Episode 1" is only meaningful in the episode-grid UI,
    // which has the "FORMAT MOVIE" badge right there for context — the
    // Discord status line has none of that surrounding context, so it gets
    // the same MOVIE-aware treatment as the library/history cards
    // (_animeFavoriteCardHTML) instead of a bare, confusing "Episode 1".
    const discordSubtitle = _animeTestCurrent.format === 'MOVIE' ? (dub ? 'Dub' : 'Sub') : epText;
    discordPresenceReport({
      details: `Watching ${_animeTestCurrent.title || ''}`,
      subtitle: discordSubtitle,
      cover: _animeTestCurrent.cover || '',
      iconKind: 'anime',
      largeText: _animeTestCurrent.title || '',
    });
  }

  showToast("Anime (test)", `Loading episode ${episode}...`, "info");

  try {
    const { data, provider: workingProvider } = await _animeTestFetchStreamWithFallback(
      _animeTestCurrent.idMal, _animeTestCurrent.title, episode, dub, provider, requestedQuality, _animeTestCurrent.format
    );
    if (workingProvider !== provider) {
      // Reflect which provider actually served this episode so the next
      // episode of the same show defaults to the one known to work instead
      // of retrying the one that just failed every time.
      const select = $("animeTestProviderSelect");
      if (select) select.value = workingProvider;
    }

    _animeTestMountStream(video, data.src, data.subtitles || [], seekTo);
    _animeTestUpdateQualitySelect(data.availableQualities || [], data.quality || '');
  } catch (e) {
    showToast("Anime (test)", `Episode ${episode} failed on every configured source — ${e.message}`, "error");
    dbg.warn(dbg.ERR_SOURCE, "Anime test stream failed", e);
  }
}

// ── Custom player controls (replaces the native <video controls> bar) ──
// Wires play/pause, volume, seek bar, PiP, fullscreen, idle-hide, and the
// settings menu — all against the same #animeTestVideo element the HLS/
// skip/analytics/quality code above already targets. Bound once at init
// (video element itself is reused across episodes/shows, never
// recreated), not re-run per episode.
function _initAnimePlayerControls() {
  const wrap = $("animeTestPlayerWrap");
  const video = $("animeTestVideo");
  if (!wrap || !video) return;

  const centerBtn = $("animeTestCenterPlayBtn");
  const playBtn = $("animeTestPlayBtn");
  const muteBtn = $("animeTestMuteBtn");
  const volSlider = $("animeTestVolumeSlider");
  const timeEl = $("animeTestPlayerTime");
  const seekTrack = $("animeTestSeekTrack");
  const seekBuffered = $("animeTestSeekBuffered");
  const seekPlayed = $("animeTestSeekPlayed");
  const seekHandle = $("animeTestSeekHandle");
  const ccBtn = $("animeTestCcBtn");
  const settingsBtn = $("animeTestSettingsBtn");
  const settingsMenu = $("animeTestSettingsMenu");
  const pipBtn = $("animeTestPipBtn");
  const fsBtn = $("animeTestFullscreenBtn");

  const fmtTime = (s) => {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    const mm = h ? String(m).padStart(2, "0") : String(m);
    const ss = String(sec).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  };

  // ── Play/pause ──
  const updatePlayIcon = () => {
    const paused = video.paused;
    playBtn?.querySelector(".icon-play")?.classList.toggle("hidden", !paused);
    playBtn?.querySelector(".icon-pause")?.classList.toggle("hidden", paused);
    centerBtn?.classList.toggle("hidden", !paused);
  };
  const togglePlay = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
  centerBtn?.addEventListener("click", togglePlay);
  playBtn?.addEventListener("click", togglePlay);
  video.addEventListener("click", togglePlay);
  video.addEventListener("play", updatePlayIcon);
  video.addEventListener("pause", updatePlayIcon);
  updatePlayIcon();

  // ── Volume ──
  const updateMuteIcon = () => {
    const muted = video.muted || video.volume === 0;
    muteBtn?.querySelector(".icon-vol-on")?.classList.toggle("hidden", muted);
    muteBtn?.querySelector(".icon-vol-off")?.classList.toggle("hidden", !muted);
  };
  muteBtn?.addEventListener("click", () => { video.muted = !video.muted; });
  volSlider?.addEventListener("input", () => {
    video.volume = parseFloat(volSlider.value);
    video.muted = video.volume === 0;
  });
  video.addEventListener("volumechange", () => {
    if (volSlider) volSlider.value = video.muted ? 0 : video.volume;
    updateMuteIcon();
  });

  // ── Time + seek bar ──
  const updateTimeUI = () => {
    if (timeEl) timeEl.textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
    const pct = video.duration ? (video.currentTime / video.duration) * 100 : 0;
    if (seekPlayed) seekPlayed.style.width = pct + "%";
    if (seekHandle) seekHandle.style.left = pct + "%";
    if (seekBuffered && video.buffered.length) {
      const end = video.buffered.end(video.buffered.length - 1);
      const bufPct = video.duration ? (end / video.duration) * 100 : 0;
      seekBuffered.style.width = bufPct + "%";
    }
  };
  video.addEventListener("timeupdate", updateTimeUI);
  video.addEventListener("loadedmetadata", updateTimeUI);
  video.addEventListener("progress", updateTimeUI);

  let seeking = false;
  const seekToClientX = (clientX) => {
    if (!seekTrack || !video.duration) return;
    const rect = seekTrack.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    video.currentTime = pct * video.duration;
    updateTimeUI();
  };
  seekTrack?.addEventListener("mousedown", (e) => { seeking = true; seekToClientX(e.clientX); });
  window.addEventListener("mousemove", (e) => { if (seeking) seekToClientX(e.clientX); });
  window.addEventListener("mouseup", () => { seeking = false; });

  // ── Idle-hide (matches the convention of every native/embedded player:
  // controls fade out after a few seconds of no mouse movement while
  // playing) ──
  let idleTimer = null;
  const showControls = () => {
    wrap.classList.remove("controls-idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!video.paused) wrap.classList.add("controls-idle"); }, 2800);
  };
  wrap.addEventListener("mousemove", showControls);
  wrap.addEventListener("mouseleave", () => { if (!video.paused) wrap.classList.add("controls-idle"); });
  video.addEventListener("pause", () => { wrap.classList.remove("controls-idle"); clearTimeout(idleTimer); });
  showControls();

  // ── Picture-in-picture ──
  pipBtn?.addEventListener("click", async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch (e) { dbg.warn(dbg.ERR_SOURCE, "PiP failed", e); }
  });

  // ── Fullscreen ──
  const updateFsIcon = () => {
    const isFs = !!document.fullscreenElement;
    fsBtn?.querySelector(".icon-fs-enter")?.classList.toggle("hidden", isFs);
    fsBtn?.querySelector(".icon-fs-exit")?.classList.toggle("hidden", !isFs);
  };
  fsBtn?.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await wrap.requestFullscreen();
    } catch (e) { dbg.warn(dbg.ERR_SOURCE, "Fullscreen failed", e); }
  });
  document.addEventListener("fullscreenchange", updateFsIcon);

  // ── Captions (only meaningful for providers that actually carry
  // <track> elements — zokoanime/animepahe today; AniZone's are .ass,
  // not wired to <track> yet, see anizone.js's header comment) ──
  const updateCcVisibility = () => {
    const hasTracks = video.querySelectorAll("track").length > 0;
    ccBtn?.classList.toggle("hidden", !hasTracks);
  };
  ccBtn?.addEventListener("click", () => {
    const tracks = video.textTracks;
    if (!tracks.length) return;
    const anyShowing = Array.from(tracks).some(t => t.mode === "showing");
    for (const t of tracks) t.mode = anyShowing ? "hidden" : "showing";
    ccBtn.classList.toggle("active", !anyShowing);
  });
  // Re-checked from _animeTestMountStream after each episode load (tracks
  // are added fresh per episode) — exposed on window so that function can
  // call it without this whole init re-running.
  window._animePlayerUpdateCcVisibility = updateCcVisibility;

  // ── Settings menu (Server / Playback Speed / Quality / Captions —
  // cascading, one level of submenu, "< Back" returns to the root list) ──
  const closeSettingsMenu = () => settingsMenu?.classList.add("hidden");
  settingsBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = settingsMenu?.classList.contains("hidden");
    closeSettingsMenu();
    if (willOpen) { _animePlayerRenderSettingsRoot(video); settingsMenu.classList.remove("hidden"); }
  });
  // Rows get rebuilt (menu.innerHTML = ...) inside their own click handler
  // when navigating into a submenu — by the time that click event finishes
  // dispatching and bubbles up to the document-level "click outside
  // closes it" listener below, the original clicked element is already
  // detached from the DOM, so settingsMenu.contains(e.target) reads false
  // even though the click was genuinely inside the menu, closing it
  // instantly and making every row look like it does nothing. Stopping
  // propagation at the menu container (not on every individual row/back
  // button, which would need repeating this on each) fixes it in one place.
  settingsMenu?.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", (e) => {
    if (settingsMenu && !settingsMenu.classList.contains("hidden") && !settingsMenu.contains(e.target) && e.target !== settingsBtn) {
      closeSettingsMenu();
    }
  });
  window._animePlayerCloseSettingsMenu = closeSettingsMenu;
}

function _animePlayerRenderSettingsRoot(video) {
  const menu = $("animeTestSettingsMenu");
  if (!menu) return;
  const providerSelect = $("animeTestProviderSelect");
  const qualitySelect = $("animeTestQualitySelect");
  const hasQuality = (qualitySelect?.options?.length || 0) > 1;
  const hasCaptions = video.querySelectorAll("track").length > 0;

  const rows = [];
  if ((providerSelect?.options?.length || 0) > 1) {
    const current = providerSelect.options[providerSelect.selectedIndex]?.textContent || "";
    rows.push({ key: "server", label: "Server", value: current });
  }
  rows.push({ key: "speed", label: "Playback Speed", value: `${video.playbackRate}x` });
  if (hasQuality) {
    const current = qualitySelect.options[qualitySelect.selectedIndex]?.textContent || "Auto";
    rows.push({ key: "quality", label: "Quality", value: current });
  }
  if (hasCaptions) {
    const activeTrack = Array.from(video.textTracks).find(t => t.mode === "showing");
    rows.push({ key: "captions", label: "Captions", value: activeTrack ? activeTrack.label : "Off" });
  }

  menu.innerHTML = rows.map(r => `
    <div class="anime-player-menu-item" data-menu="${r.key}">
      <span>${escapeHtml(r.label)}</span>
      <span class="anime-player-menu-item-value">${escapeHtml(r.value)} &#8250;</span>
    </div>
  `).join("");

  menu.querySelectorAll("[data-menu]").forEach(row => {
    row.onclick = () => {
      const key = row.dataset.menu;
      if (key === "server") _animePlayerRenderServerMenu(video);
      else if (key === "speed") _animePlayerRenderSpeedMenu(video);
      else if (key === "quality") _animePlayerRenderQualityMenu(video);
      else if (key === "captions") _animePlayerRenderCaptionsMenu(video);
    };
  });
}

function _animePlayerRenderServerMenu(video) {
  const select = $("animeTestProviderSelect");
  const options = Array.from(select?.options || []);
  const menu = _animePlayerRenderSubmenu("Server", options.map(o => ({
    label: o.textContent,
    value: o.value,
    active: o.selected,
  })), () => _animePlayerRenderSettingsRoot(video));
  menu.querySelectorAll("[data-value]").forEach(row => {
    row.onclick = () => {
      if (select.value !== row.dataset.value) {
        select.value = row.dataset.value;
        select.dispatchEvent(new Event("change"));
      }
      _animePlayerRenderSettingsRoot(video);
    };
  });
}

function _animePlayerRenderSubmenu(title, items, onBack) {
  const menu = $("animeTestSettingsMenu");
  if (!menu) return;
  menu.innerHTML = `
    <div class="anime-player-menu-back" id="animePlayerMenuBack">&#8249; ${escapeHtml(title)}</div>
    ${items.map(it => `
      <div class="anime-player-menu-item" data-value="${escapeHtml(String(it.value))}">
        <span>${escapeHtml(it.label)}</span>
        <span class="anime-player-menu-check">${it.active ? "&#10003;" : ""}</span>
      </div>
    `).join("")}
  `;
  $("animePlayerMenuBack").onclick = onBack;
  return menu;
}

function _animePlayerRenderSpeedMenu(video) {
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const menu = _animePlayerRenderSubmenu("Playback Speed", speeds.map(s => ({
    label: s === 1 ? "Normal" : `${s}x`,
    value: s,
    active: video.playbackRate === s,
  })), () => _animePlayerRenderSettingsRoot(video));
  menu.querySelectorAll("[data-value]").forEach(row => {
    row.onclick = () => {
      video.playbackRate = parseFloat(row.dataset.value);
      _animePlayerRenderSettingsRoot(video);
    };
  });
}

function _animePlayerRenderQualityMenu(video) {
  const select = $("animeTestQualitySelect");
  const options = Array.from(select?.options || []);
  const menu = _animePlayerRenderSubmenu("Quality", options.map(o => ({
    label: o.textContent,
    value: o.value,
    active: o.selected,
  })), () => _animePlayerRenderSettingsRoot(video));
  menu.querySelectorAll("[data-value]").forEach(row => {
    row.onclick = () => {
      select.value = row.dataset.value;
      select.dispatchEvent(new Event("change"));
      _animePlayerRenderSettingsRoot(video);
    };
  });
}

function _animePlayerRenderCaptionsMenu(video) {
  const tracks = Array.from(video.textTracks);
  const items = [{ label: "Off", value: "off", active: !tracks.some(t => t.mode === "showing") }]
    .concat(tracks.map((t, i) => ({ label: t.label || `Track ${i + 1}`, value: String(i), active: t.mode === "showing" })));
  const menu = _animePlayerRenderSubmenu("Captions", items, () => _animePlayerRenderSettingsRoot(video));
  menu.querySelectorAll("[data-value]").forEach(row => {
    row.onclick = () => {
      const wantIdx = row.dataset.value === "off" ? -1 : parseInt(row.dataset.value, 10);
      tracks.forEach((t, i) => { t.mode = i === wantIdx ? "showing" : "hidden"; });
      const ccBtn = $("animeTestCcBtn");
      ccBtn?.classList.toggle("active", wantIdx !== -1);
      _animePlayerRenderSettingsRoot(video);
    };
  });
}

// Server-provided quality list (AnimePahe's separate Kwik links per
// resolution — see animepahe/index.js). zokoanime always reports an empty
// list here since it has no server-side quality choice; if its own HLS
// stream turns out to have real adaptive-bitrate levels, MANIFEST_PARSED
// below (_animeTestPopulateHlsQualityLevels) overrides this with those
// instead, shortly after this runs.
function _animeTestUpdateQualitySelect(availableQualities, currentQuality) {
  const select = $("animeTestQualitySelect");
  if (!select) return;

  if (availableQualities.length < 2) {
    select.innerHTML = "";
    return;
  }
  select.innerHTML = availableQualities.map(q =>
    `<option value="${escapeHtml(q)}"${q === currentQuality ? ' selected' : ''}>${escapeHtml(q)}</option>`
  ).join("");
}

// hls.js-level quality (confirmed live: zokoanime's own master playlist
// embeds real 360p/720p/1080p variants, unlike AnimePahe where each
// resolution is a wholly separate resolved URL) — switching here is
// instant and client-side (hls.loadLevel/nextLevel, see the onchange
// handler), no server re-request needed, so it uses a distinct "hls:N"
// option-value prefix the onchange handler branches on rather than
// reusing the server-quality re-request path.
function _animeTestPopulateHlsQualityLevels(hls) {
  const select = $("animeTestQualitySelect");
  if (!select) return;
  if (!hls.levels || hls.levels.length < 2) return;

  const order = hls.levels
    .map((lvl, idx) => ({ idx, height: lvl.height }))
    .sort((a, b) => b.height - a.height);
  const options = ['<option value="hls:auto">Auto</option>']
    .concat(order.map(o => `<option value="hls:${o.idx}">${o.height}p</option>`));
  select.innerHTML = options.join('');
  // autoLevelEnabled (keyed off loadLevel, not currentLevel) is the
  // reliable way to ask "is this actually in auto mode right now" — see
  // the onchange handler's own comment on why currentLevel alone isn't it.
  select.value = hls.autoLevelEnabled ? 'hls:auto' : `hls:${hls.loadLevel}`;
}

function _animeTestMountStream(video, src, subtitles, seekTo = 0) {
  // Clear previous <track> elements from the last episode
  video.querySelectorAll("track").forEach(t => t.remove());
  for (const sub of subtitles) {
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = sub.label || sub.lang || "Subtitles";
    track.srclang = sub.lang || "en";
    track.src = sub.src;
    if (sub.default) track.default = true;
    video.appendChild(track);
  }
  // Custom controls' CC button visibility depends on whether THIS episode
  // actually has tracks — re-checked per mount since it varies by provider
  // (see _initAnimePlayerControls's own comment on why AniZone never has
  // any yet).
  if (typeof window._animePlayerUpdateCcVisibility === 'function') window._animePlayerUpdateCcVisibility();

  if (_animeTestHls) {
    _animeTestHls.destroy();
    _animeTestHls = null;
  }

  const seekOnceReady = () => {
    if (seekTo > 0) video.currentTime = seekTo;
    video.play().catch(() => {});
  };

  // Fires once duration is known, regardless of which path below actually
  // loads the stream (hls.js's own metadata timing differs from native
  // <video>'s) — AniSkip's episodeLength param wants the real duration.
  video.addEventListener("loadedmetadata", () => {
    if (!_animeTestCurrent?.idMal || !_animeTestCurrentEpisode) return;
    _animeTestFetchSkipTimes(_animeTestCurrent.idMal, _animeTestCurrentEpisode, video.duration)
      .then(times => { _animeTestSkipTimes = times; });
  }, { once: true });

  // hls.js first: it's the reliable path on virtually every real desktop
  // browser (Chrome/Edge/Firefox never support HLS natively). Native <video>
  // src is only the fallback for the rare case hls.js itself can't run —
  // canPlayType() is unreliable across browsers (reports "maybe" in some
  // Chromium builds that then fail to actually load it), so it's checked
  // last, not first.
  if (typeof Hls !== "undefined" && Hls.isSupported()) {
    _animeTestHls = new Hls();
    _animeTestHls.loadSource(src);
    _animeTestHls.attachMedia(video);
    _animeTestHls.on(Hls.Events.MANIFEST_PARSED, () => {
      seekOnceReady();
      _animeTestPopulateHlsQualityLevels(_animeTestHls);
    });
    _animeTestHls.on(Hls.Events.ERROR, (_evt, data) => {
      if (data.fatal) showToast("Anime (test)", `Playback error: ${data.details}`, "error");
    });
  } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = src;
    video.addEventListener("loadedmetadata", seekOnceReady, { once: true });
  } else {
    showToast("Anime (test)", "This browser can't play HLS and hls.js didn't load.", "error");
  }
}

// ── Autoplay next episode (M3) ────────────────────────────────────────────
// Only advances to an episode that actually has a row rendered in the
// sidebar — for a still-airing show that row range gets extended as soon as
// a real episode number is seen (see _animeTestSelectShow), but this must
// not guess past whatever's currently known to exist, since the stream
// endpoint 404ing on a not-yet-released episode is a real failure state,
// not a rare edge case, for anything currently airing.
function _animeTestPlayNextEpisodeIfEnabled() {
  if (!$("animeTestAutoplayToggle")?.checked) return;
  if (!_animeTestCurrentEpisode) return;

  const nextEp = _animeTestCurrentEpisode + 1;
  const nextRow = $("animeTestEpisodeList").querySelector(`.anime-episode-row[data-ep="${nextEp}"]`);
  if (!nextRow) return;

  showToast("Anime (test)", `Autoplaying episode ${nextEp}...`, "info");
  _animeTestPlayEpisode(nextEp);
}

// ── Watch progress (M2) ─────────────────────────────────────────────────
// Saves regardless of favorite status (see the comment inside — History is
// independent of favoriting) — throttled to avoid a network call every
// timeupdate tick (which fires several times a second).

function _animeTestSaveProgress(force = false) {
  // No longer gated on _animeTestIsFavorited — watching something without
  // hitting "Add to My Anime" first used to leave zero trace anywhere
  // (not History, not My Anime); now it still shows up in History, same
  // as reading a manga chapter shows up there without favoriting it.
  if (!_animeTestCurrent || !_animeTestCurrentEpisode) return;
  const video = $("animeTestVideo");
  if (!video || !video.duration) return;

  // AniList sync check runs on every tick regardless of the save throttle
  // below (it has its own once-per-episode guard) — the 10s save-throttle
  // exists to limit *this app's own* progress writes, not AniList's.
  _animeTestMaybeSyncAniList(video);

  const now = Date.now();
  if (!force && now - _animeTestLastSavedAt < ANIME_PROGRESS_SAVE_INTERVAL_MS) return;
  _animeTestLastSavedAt = now;

  fetch("/api/anime/progress", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      idMal: _animeTestCurrent.idMal,
      episode: _animeTestCurrentEpisode,
      positionSeconds: video.currentTime,
      durationSeconds: video.duration,
      // Only actually needed the first time a history row is created for
      // this idMal (server keeps whatever it already has otherwise) — sent
      // every time anyway since it's cheap and _animeTestCurrent already
      // holds it.
      title: _animeTestCurrent.title,
      cover: _animeTestCurrent.cover,
      totalEpisodes: _animeTestCurrent.episodes,
      anilistId: _animeTestCurrent.anilistId,
      genres: _animeTestCurrent.genres,
      format: _animeTestCurrent.format || null,
    }),
    keepalive: true, // lets the request survive a page unload (used on beforeunload below)
  }).catch(() => {});
}

// Pushes to AniList once an episode crosses ANIME_ANILIST_SYNC_THRESHOLD —
// not on every progress tick like the local save above. AniList tracks a
// whole-number "episodes completed" count, not an in-episode position, so
// syncing continuously would just mean the same write repeated dozens of
// times for no benefit; a completion threshold (matching how other
// tracking apps like Trakt/Simkl "scrobble") is the right unit of sync here.
function _animeTestMaybeSyncAniList(video) {
  if (!_animeTestCurrent?.anilistId || !_animeTestCurrentEpisode) return;
  if (video.currentTime / video.duration < ANIME_ANILIST_SYNC_THRESHOLD) return;

  const key = `${_animeTestCurrent.idMal}:${_animeTestCurrentEpisode}`;
  if (_animeTestSyncedEpisodes.has(key)) return;
  _animeTestSyncedEpisodes.add(key);

  anilistReconcileAnimeProgress({
    anilistId: _animeTestCurrent.anilistId,
    localEpisode: _animeTestCurrentEpisode,
    idMal: _animeTestCurrent.idMal,
  }).catch(e => {
    dbg.warn(dbg.ERR_ANILIST, "Anime AniList sync failed", e);
    // Once per episode (the key stays recorded, as before): a failing push must not turn into a toast and a request on every progress tick.
    if (typeof showToast === 'function') showToast('AniList', "Couldn't update AniList with this episode (" + ((e && e.message) || 'no answer') + '). Watching on, or marking it again from the tracker, sends it.', 'warning');
  });
}

// ── Edit Page (mirrors getDefaultLibraryCardSettings/loadLibraryCardSettings
// in ui-library.js, scoped to fields _animeFavoriteCardHTML actually has). ─
function getDefaultAnimeLibraryCardSettings() {
  return { showProgressBar: true, showEpisodeLabel: true, showTags: true, showStatus: true };
}

function loadAnimeLibraryCardSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('scrollscape.animeLibraryCardSettings'));
    if (saved && typeof saved === 'object') {
      return { ...getDefaultAnimeLibraryCardSettings(), ...saved };
    }
  } catch (e) { /* ignore parse errors */ }
  return getDefaultAnimeLibraryCardSettings();
}

function saveAnimeLibraryCardSettings(settings) {
  localStorage.setItem('scrollscape.animeLibraryCardSettings', JSON.stringify(settings));
}

const ANIME_CUST_CHECK_IDS = {
  showProgressBar: 'animeCustProgressBar',
  showEpisodeLabel: 'animeCustEpisodeLabel',
  showTags: 'animeCustTags',
  showStatus: 'animeCustStatus',
};
const ANIME_CUST_PRESETS = {
  full:    { showProgressBar: true,  showEpisodeLabel: true,  showTags: true,  showStatus: true  },
  compact: { showProgressBar: true,  showEpisodeLabel: true,  showTags: false, showStatus: true  },
  minimal: { showProgressBar: false, showEpisodeLabel: false, showTags: false, showStatus: false },
};

function _animeCustApplyToForm(settings) {
  Object.entries(ANIME_CUST_CHECK_IDS).forEach(([key, id]) => { const el = $(id); if (el) el.checked = !!settings[key]; });
}

function _animeCustCollectFromForm() {
  const settings = {};
  Object.entries(ANIME_CUST_CHECK_IDS).forEach(([key, id]) => { settings[key] = !!$(id)?.checked; });
  return settings;
}

// Same sample-card idea as ui-library.js's manga preview — a fixed mock
// favorite so the preview always has something to show regardless of
// whether the user's own library has progress/tags on anything yet.
function _animeCustRenderPreview(settings) {
  const el = $("animeCustPreviewCard");
  if (!el) return;
  el.innerHTML = `
    <div class="manga-card-cover">
      <div class="no-cover">?</div>
      ${settings.showStatus ? `<div class="library-card-status status-badge-watching">Watching</div>` : ""}
      ${settings.showProgressBar ? `<div class="anime-card-progress"><div style="width:60%;"></div></div>` : ""}
    </div>
    <div class="manga-card-info">
      <div class="manga-card-title">Sample Anime Title</div>
      ${settings.showEpisodeLabel ? `<div class="manga-card-author">Ep 6 / 12</div>` : ""}
      ${settings.showTags ? `<div class="library-card-tags"><span class="tag">action</span><span class="tag">isekai</span></div>` : ""}
    </div>`;
}

function _openEditAnimeLibraryCardModal() {
  const modal = $("customizeAnimeLibraryCardModal");
  if (!modal) return;
  const settings = loadAnimeLibraryCardSettings();
  _animeCustApplyToForm(settings);
  _animeCustRenderPreview(settings);
  modal.classList.remove("hidden");
}

// ── Sources (visible anime providers) ─────────────────────────────────────
// The anime sources there are come from the server's registry (server/modules/anime-sources/, GET /api/anime/providers): the ones
// that ship with the app and any that were added. This list says which of them are OFFERED in the watch-page provider dropdown
// (#animeTestProviderSelect) and in Settings > Anime Sources. Anime favorites carry no persisted provider field (schema.js), so there
// is no library-grid filter equivalent.
//
// The list below is what the registry holds today, kept here so the player still works if the registry cannot be reached; it is
// replaced, in place, by _animeLoadProviders() as soon as the registry answers.
const ANIME_PROVIDERS = [
  { id: 'anizone', name: '1 (AniZone)' },
  { id: 'animepahe', name: '2 (AnimePahe)' },
  { id: 'zokoanime', name: '3 (zokoanime)', warning: 'Resolves through a rotating pool of third-party CDN domains — one confirmed by a real threat-detection tool as malicious. Enable only if you understand the risk.' },
  { id: 'miruro', name: '4 (Miruro)', warning: 'Its stream data is behind the bot protection of the site, so it needs FlareSolverr and is refused from some computers. It may simply not work on this one.' },
  { id: 'animeparadise', name: '5 (AnimeParadise)' },
];

/**
 * Replaces the provider list with the registry's (in place: Settings reads the same array). The label is the position and the name,
 * as it always was ("3 (zokoanime)"); a source's own warning is what the risky checkbox shows. A bad answer changes nothing.
 */
function _animeApplyProviders(providers) {
  if (!Array.isArray(providers) || !providers.length) return false;
  const list = providers
    .filter(p => p && typeof p.id === 'string' && p.id && typeof p.name === 'string')
    .map((p, index) => ({ id: p.id, name: `${index + 1} (${p.name})`, ...(p.warning ? { warning: String(p.warning) } : {}) }));
  if (!list.length) return false;
  ANIME_PROVIDERS.splice(0, ANIME_PROVIDERS.length, ...list);
  return true;
}

async function _animeLoadProviders() {
  try {
    const resp = await fetch('/api/anime/providers');
    const data = await resp.json();
    if (resp.ok && data && data.ok && _animeApplyProviders(data.providers)) _animeSyncProviderSelectOptions();
  } catch (_) { /* the list above stays */ }
}
// Asked for as soon as the script loads, so Settings > Anime Sources lists the same sources even if the watch page was never opened.
_animeLoadProviders();

// TODO(security): zokoanime resolves through a rotating pool of
// third-party CDN domains it doesn't control (confirmed live: the same
// title resolved to hls2.aniwatchtv.uk in one request and
// suzaku.xin-cdn.xyz — flagged as malicious by a real threat-detection
// tool — in another). Off by default below (DEFAULT_VISIBLE_
// ANIME_PROVIDERS excludes it) until that's investigated further — a
// user can still manually re-enable it via Settings > Anime Sources if
// they explicitly want to, but it should not be anyone's default.
//
// Miruro (server/modules/anime/miruro.js) was reconsidered after an
// earlier pass here wrongly lumped it in with zokoanime's rotating-CDN
// risk — the REAL miruro.tv (one of 4 official domains, confirmed against
// the project's own domain-verification page, not a third-party scanner's
// stale "phishing" flag on that specific mirror) is open-source and
// explicitly ad-free by design, unlike animepahe (current, well-documented
// malvertising). A real provider was built for it; left out of
// DEFAULT_VISIBLE_ANIME_PROVIDERS for now only because its own stream API
// is currently blocked by a Cloudflare IP-reputation check even through
// FlareSolverr, not for a safety reason — see miruro.js's header comment.
//
// AnimeParadise (server/modules/anime/animeparadise.js) was promoted to the
// default on 2026-10-26, after it was proven out and checked: 9 of 10 real
// titles resolved (episode 1, about 1.2 s each, valid HLS playlist); across 4
// titles the app only ever talked to api.animeparadise.moe and
// stream.animeparadise.moe (master playlist, segments and subtitles all on
// the second, the origin of the video is an opaque token, never a third-party
// host); every request is server-side plain HTTP, so no page of the site and
// no ad ever runs in any browser; the relayed bytes reach the player with
// the untrusted-content headers (media types only, nosniff, CSP sandbox) and
// subtitles are native <track> elements; and Cloudflare's malware-blocking
// resolver does not list the domains. The order of this list is the fallback
// priority (_animeFallbackOrder applies it to whatever order a list was saved
// in). animepahe was taken out of the default list the day after (2026-10-27):
// it needs the hidden browser, and when its video host (Kwik) refuses the
// connection (seen on a real network: the title resolves, the video never
// opens) it takes up to a minute to fail. It is one tick away in Settings >
// Anime Sources, and then it is tried after the default providers. A user's own
// choice there is kept: the one-time upgrade in ui-settings.js only touches
// the exact old default. The list itself is declared once, in ui-settings.js
// (DEFAULT_SETTINGS).
const DEFAULT_VISIBLE_ANIME_PROVIDERS = [...DEFAULT_SETTINGS.visibleAnimeProviders];

// The one priority list of the fallback: the default providers in their default order, then the others in the
// order of ANIME_PROVIDERS. The checkboxes of Settings > Anime Sources save in ANIME_PROVIDERS order, so a saved
// list says WHICH providers are on, never which is tried first.
function _animeFallbackOrder(ids) {
  const priority = [...DEFAULT_VISIBLE_ANIME_PROVIDERS, ...ANIME_PROVIDERS.map(p => p.id)];
  const rank = (id) => {
    const index = priority.indexOf(id);
    return index === -1 ? priority.length : index;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b));
}

function _animeSyncProviderSelectOptions() {
  const select = $("animeTestProviderSelect");
  if (!select) return;
  const visible = Array.isArray(state.settings.visibleAnimeProviders) && state.settings.visibleAnimeProviders.length
    ? state.settings.visibleAnimeProviders
    : DEFAULT_VISIBLE_ANIME_PROVIDERS;
  const prevValue = select.value;
  const options = ANIME_PROVIDERS.filter(p => visible.includes(p.id));
  const list = options.length ? options : ANIME_PROVIDERS;
  select.innerHTML = list
    .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  if (options.some(p => p.id === prevValue)) select.value = prevValue;
}
// (This used to also render a visible HD-1/HD-2/HD-3 pill row here —
// removed once server switching moved into the player's own Settings
// menu, see _animePlayerRenderServerMenu, so it isn't offered in two
// places at once. #animeTestProviderSelect's options above are still the
// single source of truth that menu reads from.)

function showAnimeSourcesModal() {
  document.querySelector('.anime-sources-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'modal-overlay anime-sources-modal';
  const visible = Array.isArray(state.settings.visibleAnimeProviders) && state.settings.visibleAnimeProviders.length ? state.settings.visibleAnimeProviders : DEFAULT_VISIBLE_ANIME_PROVIDERS;

  modal.innerHTML = `
    <div class="import-modal-box" style="max-width:400px">
      <div class="modal-header">
        <h3>Visible Anime Sources</h3>
        <button class="btn-close-modal" id="closeAnimeSourcesModal">&times;</button>
      </div>
      <div class="modal-body">
        <form id="animeSourcesForm" style="display:flex;flex-direction:column;gap:0.4rem">
          ${ANIME_PROVIDERS.map(p => `
            <label class="home-source-check${p.warning ? ' home-source-check-risky' : ''}">
              <input type="checkbox" class="home-source-option" name="providers" value="${escapeHtml(p.id)}" ${visible.includes(p.id) ? 'checked' : ''}>
              <span>
                <span class="home-source-check-label">${escapeHtml(p.name)}</span>
                ${p.warning ? `<span class="home-source-check-warning" title="${escapeHtml(p.warning)}">⚠ ${escapeHtml(p.warning)}</span>` : ''}
              </span>
            </label>
          `).join('')}
        </form>
      </div>
      <div class="modal-footer">
        <button class="btn secondary" id="cancelAnimeSourcesModal">Cancel</button>
        <button class="btn primary"   id="saveAnimeSourcesModal">Save</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  $('closeAnimeSourcesModal').onclick  = () => modal.remove();
  $('cancelAnimeSourcesModal').onclick = e => { e.preventDefault(); modal.remove(); };
  $('saveAnimeSourcesModal').onclick   = e => {
    e.preventDefault();
    const checked = Array.from(modal.querySelectorAll('input[name="providers"]:checked')).map(cb => cb.value);
    state.settings.visibleAnimeProviders = checked.length ? checked : DEFAULT_VISIBLE_ANIME_PROVIDERS;
    if (typeof saveSettings === 'function') saveSettings();
    modal.remove();
    _animeSyncProviderSelectOptions();
  };
}

// ── Cover picker — structurally mirrors openMangaCoverPicker (ui-search.js)
// but simpler: there's no "installed anime sources" concept to search
// covers from, so this is AniList + Google Images only. Reuses the same
// CSS classes (cover-picker-*, cover-choice-*) and searchGoogleCoverChoices
// (already generic, not manga-specific) and _coverChoiceKey for dedup —
// only the AniList query (type: ANIME here vs MANGA there) and the save
// endpoint (idMal-keyed, no sourceId) actually differ. ────────────────────
async function _searchAniListAnimeCoverChoices(title, page = 1, perPage = 8) {
  const gql = `query ($search: String, $page: Int, $perPage: Int) {
      Page(page: $page, perPage: $perPage) {
        pageInfo { hasNextPage }
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          id
          title { romaji english native }
          coverImage { extraLarge large medium }
        }
      }
    }`;
  const variables = { search: title, page, perPage };
  // Same rate-limit retry every other AniList call site in this app already
  // has (animeAdvancedSearch, _loadAnimeHomeDiscovery, etc.) — this one was
  // missing it, so a rate-limited response's data.errors went unchecked and
  // `data?.data?.Page?.media || []` silently fell back to an empty array,
  // showing "No cover results found" for what was actually a failed
  // request rather than a genuine zero-result search.
  let data = await anilistGQL(gql, variables);
  if (data?.errors?.some(e => /rate limit|too many requests/i.test(e.message || ''))) {
    await new Promise(r => setTimeout(r, 3000));
    data = await anilistGQL(gql, variables);
  }
  if (data?.errors?.length) throw new Error(data.errors[0]?.message || "AniList cover search failed");
  return {
    items: (data?.data?.Page?.media || [])
      .map(item => ({
        id: item.id,
        title: item?.title?.romaji || item?.title?.english || item?.title?.native || title, // romaji-first for anime
        cover: item?.coverImage?.extraLarge || item?.coverImage?.large || item?.coverImage?.medium || '',
        provider: 'AniList',
        sourceId: 'anilist',
      }))
      .filter(item => item.cover),
    hasNextPage: !!data?.data?.Page?.pageInfo?.hasNextPage,
  };
}

// MyAnimeList's own image gallery for this exact title, via Jikan (server
// proxy — see routes/anime.js's /api/anime/cover-choices/:idMal) — replaces
// an earlier Google/Brave Images-scraping fallback that broke unpredictably
// whenever those search-result pages changed shape. Unlike the AniList
// search above, this isn't a text search at all: Jikan's /pictures
// endpoint takes only the idMal and returns everything MAL has for that
// one title, so there's no query/pagination here (hasNextPage is always
// false — see runCoverSearch's caller).
async function _searchJikanAnimeCoverChoices(idMal) {
  const data = await api(`/api/anime/cover-choices/${encodeURIComponent(idMal)}`);
  return {
    items: Array.isArray(data?.items) ? data.items : [],
    hasNextPage: false,
  };
}

function openAnimeCoverPicker(anime) {
  const idMal = String(anime?.idMal || '');
  const title = String(anime?.title || '').trim();
  const currentCover = String(anime?.cover || '').trim();
  if (!idMal || !title) {
    showToast('Cover error', 'Missing anime data.', 'error');
    return;
  }

  document.getElementById('animeCoverPickerModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'animeCoverPickerModal';
  modal.className = 'settings-modal';
  modal.innerHTML = `
    <div class="settings-content cover-picker-modal-content">
      <div class="settings-header">
        <h2>Choose Cover</h2>
        <button class="btn btn-secondary" id="animeCoverPickerClose">Close</button>
      </div>
      <div class="cover-picker-body">
        <div class="cover-picker-column">
          <p class="cover-picker-label">Current cover</p>
          <div class="cover-picker-current">
            ${currentCover ? `<img src="${escapeHtml(normalizeImageUrl(currentCover))}" alt="${escapeHtml(title)}">` : `<div class="no-cover">?</div>`}
          </div>
          <div class="cover-picker-actions">
            <button class="btn btn-secondary" id="animeCoverPickerJikan">MyAnimeList Pictures</button>
            <button class="btn btn-secondary" id="animeCoverPickerGoogle">Search Brave Images</button>
          </div>
        </div>
        <div class="cover-picker-column cover-picker-column-wide">
          <div class="cover-picker-search-bar">
            <input id="animeCoverPickerSearchInput" class="input cover-picker-search-input" type="search" value="${escapeHtml(title)}" placeholder="Search covers...">
            <button class="btn" id="animeCoverPickerSearchRun">Search</button>
          </div>
          <p class="cover-picker-label">Search results</p>
          <div class="cover-picker-search-meta muted" id="animeCoverPickerSearchMeta"></div>
          <div class="cover-picker-loading-bar" id="animeCoverPickerLoadingBar"><div class="cover-picker-loading-bar-fill"></div></div>
          <div class="cover-picker-grid muted" id="animeCoverPickerSuggestions">Loading cover suggestions...</div>
          <div class="cover-picker-load-more-wrap">
            <button class="btn btn-secondary" id="animeCoverPickerLoadMore">Load more</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const closePicker = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) closePicker(); };
  document.getElementById('animeCoverPickerClose').onclick = closePicker;

  const closeAfterApply = async (coverUrl) => {
    if (!coverUrl) return;
    try {
      await api('/api/anime/cover-override', { method: 'POST', body: JSON.stringify({ idMal, coverUrl }) });
      closePicker();
      showToast('Cover updated', 'Saved.', 'success');
      if (typeof renderAnimeLibrary === 'function') renderAnimeLibrary();
      if (_animeTestCurrent?.idMal === idMal) _animeTestSetCoverThumb(coverUrl);
    } catch (e) {
      showToast('Cover error', e.message || 'Could not save cover.', 'error');
    }
  };

  const gridEl = document.getElementById('animeCoverPickerSuggestions');
  const metaEl = document.getElementById('animeCoverPickerSearchMeta');
  const loadingBarEl = document.getElementById('animeCoverPickerLoadingBar');
  const searchInput = document.getElementById('animeCoverPickerSearchInput');
  const loadMoreBtn = document.getElementById('animeCoverPickerLoadMore');
  const pickerState = { query: title, mode: 'anilist', page: 1, seen: new Set(), hasNextPage: false, loading: false };

  const renderChoiceCards = (choices, append = false) => {
    const html = choices.map(choice => `
      <button class="cover-choice-card" data-cover-url="${escapeHtml(choice.cover)}" title="${escapeHtml(choice.title)}">
        <span class="cover-choice-thumb"><img src="${escapeHtml(choice.cover)}" alt="${escapeHtml(choice.title)}" loading="lazy"></span>
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
  };

  const updateLoadMoreVisibility = () => {
    if (!loadMoreBtn) return;
    loadMoreBtn.style.display = pickerState.hasNextPage ? '' : 'none';
    loadMoreBtn.disabled = pickerState.loading;
  };

  const sourceLabel = () => pickerState.mode === 'jikan' ? 'MyAnimeList' : (pickerState.mode === 'google' ? 'Brave Images' : 'AniList');

  async function runCoverSearch(reset = false) {
    if (pickerState.loading) return;
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
    metaEl.textContent = pickerState.mode === 'jikan'
      ? `Loading MyAnimeList pictures for "${title}"...`
      : `Searching ${sourceLabel()} for "${nextQuery}"...`;
    if (loadingBarEl) loadingBarEl.classList.add('active');
    updateLoadMoreVisibility();
    try {
      // Jikan's /pictures endpoint isn't a text search — it's idMal-scoped
      // and returns everything in one response, so there's no query or
      // pagination to pass through here (see _searchJikanAnimeCoverChoices).
      const data = pickerState.mode === 'jikan'
        ? await _searchJikanAnimeCoverChoices(idMal)
        : pickerState.mode === 'google'
        ? await searchGoogleCoverChoices(nextQuery, pickerState.page, 14)
        : await _searchAniListAnimeCoverChoices(nextQuery, pickerState.page, 8);
      const fresh = (data.items || []).filter(choice => {
        const key = _coverChoiceKey(choice);
        if (pickerState.seen.has(key)) return false;
        pickerState.seen.add(key);
        return true;
      });
      pickerState.hasNextPage = !!data.hasNextPage;
      gridEl.classList.remove('muted');
      if (!fresh.length && pickerState.page === 1) {
        gridEl.innerHTML = pickerState.mode === 'jikan'
          ? '<p class="muted">MyAnimeList has no extra pictures for this title.</p>'
          : '<p class="muted">No cover results found. Try a shorter title.</p>';
      } else if (!fresh.length) {
        showToast('Cover search', 'No more results found.', 'info');
      } else {
        renderChoiceCards(fresh, !reset && pickerState.page > 1);
      }
      metaEl.textContent = `${pickerState.seen.size} result(s) from ${sourceLabel()}.`;
    } catch (e) {
      pickerState.hasNextPage = false;
      gridEl.classList.remove('muted');
      gridEl.innerHTML = '<p class="muted">Could not load cover search results.</p>';
      metaEl.textContent = 'Cover search failed.';
    } finally {
      pickerState.loading = false;
      if (loadingBarEl) loadingBarEl.classList.remove('active');
      updateLoadMoreVisibility();
    }
  }

  document.getElementById('animeCoverPickerJikan').onclick = () => {
    pickerState.mode = 'jikan';
    runCoverSearch(true);
  };
  document.getElementById('animeCoverPickerGoogle').onclick = () => {
    pickerState.mode = 'google';
    const base = (searchInput?.value || title || '').trim();
    const q = /cover/i.test(base) ? base : `${base} anime cover`;
    if (searchInput) searchInput.value = q;
    runCoverSearch(true);
  };
  document.getElementById('animeCoverPickerSearchRun').onclick = () => runCoverSearch(true);
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    runCoverSearch(true);
  });
  loadMoreBtn.onclick = () => runCoverSearch(false);
  runCoverSearch(true);
}
window.openAnimeCoverPicker = openAnimeCoverPicker;

// ── Tags — structurally mirrors showEditTagsModal (ui-library.js), minus
// the sourceId parameter (animeTags is keyed by idMal alone — see
// schema.js's comment). ────────────────────────────────────────────────
async function showEditAnimeTagsModal(anime) {
  document.querySelector('.edit-anime-tags-modal')?.remove();
  let tags = [...(anime.tags || [])];

  const modal = document.createElement('div');
  modal.className = 'settings-modal edit-anime-tags-modal';

  const renderChips = () => tags.length
    ? tags.map((t, i) => `
        <span class="category-chip tag-chip" style="display:inline-flex;align-items:center;gap:0.3rem">
          ${escapeHtml(t)}
          <button type="button" class="tag-remove-btn" data-idx="${i}" title="Remove tag" style="background:none;border:none;color:inherit;cursor:pointer;font-size:0.9em;line-height:1;padding:0">&times;</button>
        </span>`).join('')
    : '<span class="muted" style="font-size:0.85rem">No tags yet.</span>';

  modal.innerHTML = `
    <div class="settings-content" style="max-width:460px">
      <div class="settings-header">
        <h2>Edit Tags</h2>
        <button class="btn secondary" id="closeAnimeTagsModal">&#x2715;</button>
      </div>
      <div class="settings-body">
        <p class="setting-description" style="margin-top:0">${escapeHtml(anime.title || '')}</p>
        <div id="animeTagsChipList" style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-bottom:0.8rem;min-height:1.6rem">${renderChips()}</div>
        <div class="setting-group" style="display:flex;gap:8px">
          <input type="text" id="newAnimeTagInput" class="input" maxlength="60" placeholder="e.g. studio:toei, format:movie" autocomplete="off" style="flex:1">
          <button class="btn secondary" id="addAnimeTagBtn">Add</button>
        </div>
        <div class="setting-group" style="display:flex;gap:8px">
          <button class="btn primary" id="saveAnimeTagsBtn">Save</button>
          <button class="btn secondary" id="closeAnimeTagsModal2">Cancel</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  $('closeAnimeTagsModal').onclick = () => modal.remove();
  $('closeAnimeTagsModal2').onclick = () => modal.remove();

  const bindTagRemove = () => {
    $('animeTagsChipList').querySelectorAll('.tag-remove-btn').forEach(btn => {
      btn.onclick = () => { tags.splice(Number(btn.dataset.idx), 1); refreshChips(); };
    });
  };
  const refreshChips = () => { $('animeTagsChipList').innerHTML = renderChips(); bindTagRemove(); };
  bindTagRemove();

  const addTag = () => {
    const input = $('newAnimeTagInput');
    const val = input.value.trim();
    if (!val) return;
    if (!tags.some(t => t.toLowerCase() === val.toLowerCase())) tags.push(val);
    input.value = '';
    refreshChips();
    input.focus();
  };
  $('addAnimeTagBtn').onclick = addTag;
  $('newAnimeTagInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addTag(); }
  });

  $('saveAnimeTagsBtn').onclick = async () => {
    const saveBtn = $('saveAnimeTagsBtn');
    saveBtn.disabled = true;
    try {
      const data = await api('/api/anime/tags', {
        method: 'POST',
        body: JSON.stringify({ idMal: anime.idMal, tags }),
      });
      showToast('Tags', 'Saved.', 'success');
      modal.remove();
      if (typeof renderAnimeLibrary === 'function') renderAnimeLibrary();
    } catch (err) {
      showToast('Error', err.message || 'Could not save tags.', 'error');
      saveBtn.disabled = false;
    }
  };

  setTimeout(() => $('newAnimeTagInput')?.focus(), 50);
}

// ── Shared favorite-card rendering (My Anime library + History) ──────────

function _animeFavoriteCardHTML(f) {
  const cardSettings = loadAnimeLibraryCardSettings();
  // A movie's "1 episode" is a technicality of how AniList models it, not a
  // real progress count — "Ep 1 / 1" reads as a bug even though the number
  // is technically correct, so movies get their own label instead.
  const progressLabel = f.format === 'MOVIE'
    ? (f.lastWatchedEpisode ? "Movie · Watched" : "Movie")
    : (f.lastWatchedEpisode
      ? `Ep ${f.lastWatchedEpisode}${f.totalEpisodes ? ` / ${f.totalEpisodes}` : ''}`
      : "Not started");
  const pct = f.lastDurationSeconds > 0
    ? Math.min(100, Math.round((f.lastPositionSeconds / f.lastDurationSeconds) * 100))
    : 0;
  const status = _animeComputeStatus(f);
  const tags = Array.isArray(f.tags) ? f.tags : [];
  return `<div class="manga-card" data-idmal="${escapeHtml(f.idMal)}" data-anilist-id="${f.anilistId || ''}" data-title="${escapeHtml(f.title)}" data-cover="${escapeHtml(f.cover)}" data-episodes="${f.totalEpisodes || ''}" data-resume-ep="${f.lastWatchedEpisode || 1}" data-resume-pos="${f.lastPositionSeconds || 0}">
    <div class="manga-card-cover">
      <img src="${escapeHtml(f.cover)}" alt="${escapeHtml(f.title)}" loading="lazy">
      ${cardSettings.showStatus ? `<div class="library-card-status status-badge-${status}">${escapeHtml(statusLabel(status))}</div>` : ""}
      ${cardSettings.showProgressBar && pct > 0 ? `<div class="anime-card-progress"><div style="width:${pct}%;"></div></div>` : ""}
    </div>
    <div class="manga-card-info">
      <div class="manga-card-title">${escapeHtml(f.title)}</div>
      ${cardSettings.showEpisodeLabel ? `<div class="manga-card-author">${escapeHtml(progressLabel)}</div>` : ""}
      ${cardSettings.showTags && tags.length ? `<div class="library-card-tags">${tags.slice(0, 4).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
    </div>
  </div>`;
}

function _bindAnimeFavoriteCardClicks(container) {
  container.querySelectorAll("[data-idmal]").forEach(card => {
    card.onclick = () => {
      _animeGoToDetails(
        {
          idMal: card.dataset.idmal,
          anilistId: card.dataset.anilistId,
          title: card.dataset.title,
          cover: card.dataset.cover,
          episodes: parseInt(card.dataset.episodes, 10) || 0,
        },
        {
          episode: parseInt(card.dataset.resumeEp, 10) || 1,
          positionSeconds: parseFloat(card.dataset.resumePos) || 0,
        }
      );
    };
  });
}

async function _fetchAnimeFavorites() {
  try {
    const resp = await fetch("/api/anime/favorites");
    const data = await resp.json();
    return data.favorites || [];
  } catch (e) {
    dbg.warn(dbg.ERR_SOURCE, "Failed to load anime favorites", e);
    return [];
  }
}

// ── "Sync Anime Library Status" (Settings > Anime tab) ──────────────────────
// Mirrors the manga counterpart (Settings > Library Sync, POST /api/library/
// sync-status -> syncLibraryStatus, which asks each favorite's own source
// for a fresh status) but the AniList querying happens HERE, client-side,
// not server-side — same reasoning /api/anime/refresh-item's own comment
// already established: the client already has anilistGQL and every
// favorite's own anilistId, so there's no reason to stand up a second
// AniList client on the server for the same lookup. The server route this
// posts to only ever receives already-resolved statuses and writes them.
//
// Manga's sync also cross-checks Anime-Planet when a source just says
// "ongoing" (scrapers often can't tell "actively publishing" from "on
// hiatus" apart) — not needed here, since AniList's own `status` field is
// already this project's single source of truth for anime (chapter 15),
// not a scraped guess needing a second opinion.
const ANIME_AIRING_STATUS_MAP = {
  RELEASING: 'ongoing',
  FINISHED: 'completed',
  NOT_YET_RELEASED: 'not_yet_released',
  CANCELLED: 'cancelled',
  HIATUS: 'hiatus',
};

async function syncAnimeLibraryStatus() {
  const favorites = await _fetchAnimeFavorites();
  const withAnilistId = favorites.filter(f => f.anilistId);
  if (!withAnilistId.length) return { ok: true, updated: 0 };

  // One batched request per chunk (aliased Media(id: ...) per favorite,
  // same pattern renderAnimeCalendar already uses) instead of one
  // round-trip per title — this app's own AniList rate-limit budget has
  // been exhausted by far less before (see this file's own history on
  // that). Chunked rather than one giant query so a single favorite with a
  // stale/bad anilistId can't blow up the whole sync.
  const BATCH_SIZE = 40;
  const resolved = [];
  for (let i = 0; i < withAnilistId.length; i += BATCH_SIZE) {
    const chunk = withAnilistId.slice(i, i + BATCH_SIZE);
    const fields = chunk.map((f, idx) => `m${idx}: Media(id: ${Number(f.anilistId)}, type: ANIME) { status }`).join('\n');
    try {
      let data = await anilistGQL(`query { ${fields} }`);
      if (data?.errors?.some(e => /rate limit|too many requests/i.test(e.message || ''))) {
        await new Promise(r => setTimeout(r, 3000));
        data = await anilistGQL(`query { ${fields} }`);
      }
      chunk.forEach((f, idx) => {
        const mapped = ANIME_AIRING_STATUS_MAP[data?.data?.[`m${idx}`]?.status];
        if (mapped) resolved.push({ idMal: f.idMal, status: mapped });
      });
    } catch (_) {
      // One chunk failing (rate limit, AniList down) never stops the rest.
    }
  }

  if (!resolved.length) return { ok: true, updated: 0 };
  return api('/api/anime/sync-status', {
    method: 'POST',
    body: JSON.stringify({ updates: resolved }),
  });
}

// ── My Anime library view (M2 + M4 filters) ──────────────────────────────

// Prefers the explicit, user-set f.watchStatus (schema.js's
// animeWatchStatus sidecar, set via the library card context menu) over
// this episode-count guess — same precedence manga's readingStatus has
// over anything chapter-derived. Without an explicit status, this is the
// only signal available, so it stays as the fallback.
function _animeComputeStatus(f) {
  if (f.watchStatus) return f.watchStatus;
  if (!f.lastWatchedEpisode) return "not-started";
  if (f.totalEpisodes && f.lastWatchedEpisode >= f.totalEpisodes) return "completed";
  return "watching";
}

let _animeLibraryFavorites = [];
let _animeLibraryLists = [];

// ── Sort (mirrors LIBRARY_SORT_MODES/_sortLibrary in ui-library.js, but
// only over fields an anime favorite actually has — no chapter/rating
// data exists for anime, see schema.js's animeFavorites comment). ───────
const ANIME_SORT_MODES = [
  { key: "added",        label: "Date Added" },
  { key: "az",           label: "A → Z" },
  { key: "za",           label: "Z → A" },
  { key: "episodes",     label: "Total Episodes" },
  { key: "unwatched",    label: "Unwatched Episodes" },
  { key: "last-watched", label: "Last Watched" },
];
let _animeLibSortMode = "added";

function _updateAnimeLibrarySortLabel() {
  const labelEl = $("animeLibSortLabel");
  if (!labelEl) return;
  const mode = ANIME_SORT_MODES.find(m => m.key === _animeLibSortMode);
  labelEl.textContent = mode?.label || 'Sort';
}

function setAnimeLibrarySortMode(modeKey) {
  if (!ANIME_SORT_MODES.some(m => m.key === modeKey)) return;
  _animeLibSortMode = modeKey;
  _updateAnimeLibrarySortLabel();
  _animeApplyLibraryFilters();
}

function openAnimeLibrarySortDrawer() {
  if (typeof _openSortDrawer !== 'function') return;
  _openSortDrawer({
    modes: ANIME_SORT_MODES,
    currentKey: _animeLibSortMode,
    anchorBtnId: 'btnSortAnimeLibrary',
    onSelect: setAnimeLibrarySortMode,
  });
}

function _animeSortLibrary(favs) {
  const title      = f => String(f.title || '').toLowerCase();
  const added      = f => f.dateAdded ? new Date(f.dateAdded).getTime() : 0;
  const episodes   = f => Number(f.totalEpisodes) || 0;
  const watched    = f => Number(f.lastWatchedEpisode) || 0;
  const unwatched  = f => Math.max(0, episodes(f) - watched(f));
  const lastWatch  = f => f.updatedAt ? new Date(f.updatedAt).getTime() : 0;
  switch (_animeLibSortMode) {
    case "az":           return [...favs].sort((a, b) => title(a).localeCompare(title(b)));
    case "za":            return [...favs].sort((a, b) => title(b).localeCompare(title(a)));
    case "episodes":      return [...favs].sort((a, b) => episodes(b) - episodes(a) || title(a).localeCompare(title(b)));
    case "unwatched":     return [...favs].sort((a, b) => unwatched(b) - unwatched(a) || title(a).localeCompare(title(b)));
    case "last-watched":  return [...favs].sort((a, b) => lastWatch(b) - lastWatch(a));
    default:              return [...favs].sort((a, b) => added(b) - added(a));
  }
}

async function renderAnimeLibrary() {
  const grid = $("animeLibraryGrid");
  const empty = $("animeLibraryEmpty");
  const catFilter = $("animeLibraryCategoryFilter");
  if (!grid) return;

  const [favorites, listsResp] = await Promise.all([
    _fetchAnimeFavorites(),
    fetch("/api/lists").then(r => r.json()).catch(() => ({ lists: [] })),
  ]);
  _animeLibraryFavorites = favorites;
  _animeLibraryLists = listsResp.lists || [];

  // Repopulate the category filter's options without clobbering whatever
  // the user currently has selected.
  const prevCatValue = catFilter.value;
  catFilter.innerHTML = `<option value="">All categories</option>` +
    _animeLibraryLists.map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join("");
  catFilter.value = prevCatValue;

  empty.classList.toggle("hidden", favorites.length > 0);
  _updateAnimeLibrarySortLabel();
  _animeApplyLibraryFilters();
}

// Same download-trigger pattern as exportMihonBackupFile() (ui-backup.js)
// — fetch as a blob and click a throwaway <a>, since the response has to
// come from an authenticated same-origin fetch rather than a plain link.
async function _animeExportAnikku() {
  const btn = $("animeLibraryExportBtn");
  const original = btn.textContent;
  btn.textContent = "Exporting...";
  btn.disabled = true;
  try {
    const resp = await fetch("/api/anime/export/anikku");
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Export failed (HTTP ${resp.status})`);
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `scrollscape-anime-library-${new Date().toISOString().slice(0, 10)}.tachibk`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("Anime export", "Library exported. Import the .tachibk file from Anikku's own backup/restore screen.", "success");
  } catch (e) {
    showToast("Anime export", `Failed: ${e.message}`, "error");
  } finally {
    btn.textContent = original;
    btn.disabled = false;
  }
}

function _animeApplyLibraryFilters() {
  const grid = $("animeLibraryGrid");
  const statusFilter = $("animeLibraryStatusFilter").value;
  const catId = $("animeLibraryCategoryFilter").value;

  const catList = catId ? _animeLibraryLists.find(l => l.id === catId) : null;
  const catIdMals = catList ? new Set(catList.animeItems.map(a => a.idMal)) : null;

  const filtered = _animeLibraryFavorites.filter(f => {
    if (statusFilter && _animeComputeStatus(f) !== statusFilter) return false;
    if (catIdMals && !catIdMals.has(f.idMal)) return false;
    if (typeof animeTagMatches === 'function' && !animeTagMatches(f)) return false;
    return true;
  });

  grid.innerHTML = _animeSortLibrary(filtered).map(_animeFavoriteCardHTML).join("");
  _bindAnimeFavoriteCardClicks(grid);
  _bindAnimeLibraryContextMenu(grid, filtered);
}

// Per-card contextmenu + 600ms touch-hold fallback for mobile — same
// pattern as manga's renderLibrary() (ui-library.js:1382-1412), minus the
// bookshelf-3D spine-picker branch (no spine concept for anime cards).
function _bindAnimeLibraryContextMenu(grid, favorites) {
  if (typeof showAnimeLibraryContextMenu !== 'function') return;
  grid.querySelectorAll("[data-idmal]").forEach(card => {
    let pressTimer = null;
    let startX = 0, startY = 0;

    const handleContextMenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const anime = favorites.find(f => f.idMal === card.dataset.idmal);
      if (anime) showAnimeLibraryContextMenu(e, anime);
    };

    card.addEventListener('contextmenu', handleContextMenu);

    card.addEventListener('touchstart', (e) => {
      if (e.touches.length > 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        handleContextMenu(e);
      }, 600);
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!pressTimer) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) { clearTimeout(pressTimer); pressTimer = null; }
    }, { passive: true });

    card.addEventListener('touchend', () => {
      if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    });
  });
}

// ── History view (M2) — same favorites collection, filtered to shows with
// actual watch activity and sorted by most recent, same "recently active
// items" shape as the manga History page (server/modules/library/content-
// service.js's addHistoryEntry: one deduped entry per item, not a full
// per-episode log). ────────────────────────────────────────────────────────

async function _fetchAnimeHistory() {
  try {
    const resp = await fetch("/api/anime/history");
    const data = await resp.json();
    return data.history || [];
  } catch (e) {
    dbg.warn(dbg.ERR_SOURCE, "Failed to load anime history", e);
    return [];
  }
}

// Same row layout/CSS classes as manga's renderHistoryView() (ui-history.js
// — .history-item/.history-cover/.history-info/.history-actions etc., all
// media-type-agnostic). "Stopped at: Episode N" stands in for manga's
// chapter-name label; no chapter-name hydration step is needed since the
// episode number is already known directly, unlike manga chapter names
// which require a fetch per source. Backed by store.animeHistory (see
// routes/anime.js's POST /api/anime/progress) — a real, independent log
// like manga's history, not derived from animeFavorites, so a show watched
// without ever hitting "Add to My Anime" still shows up here. That
// independence is also why a delete/[x] button here is now safe: it only
// clears the history row, same as manga's, never the favorite.
async function renderAnimeHistory() {
  const grid = $("animeHistoryGrid");
  const empty = $("animeHistoryEmpty");
  if (!grid) return;

  const watched = await _fetchAnimeHistory();

  empty.classList.toggle("hidden", watched.length > 0);
  grid.innerHTML = watched.map(f => {
    const coverUrl = normalizeImageUrl(f.cover);
    const genres = (f.genres || []).slice(0, 3);
    const date = f.updatedAt ? new Date(f.updatedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "";
    const episodeLabel = f.format === 'MOVIE'
      ? "Movie"
      : `Episode ${f.lastWatchedEpisode}${f.totalEpisodes ? ` / ${f.totalEpisodes}` : ''}`;
    return `
      <div class="history-item" data-idmal="${escapeHtml(f.idMal)}" data-anilist-id="${f.anilistId || ''}" data-title="${escapeHtml(f.title)}" data-cover="${escapeHtml(f.cover)}" data-episodes="${f.totalEpisodes || ''}" data-resume-ep="${f.lastWatchedEpisode || 1}" data-resume-pos="${f.lastPositionSeconds || 0}">
        <div class="history-cover">
          ${coverUrl ? `<img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(f.title)}" loading="lazy" decoding="async">` : `<div class="no-cover">?</div>`}
        </div>
        <div class="history-info">
          <h3 class="history-title">${escapeHtml(f.title)}</h3>
          ${genres.length ? `<div class="history-genres">${genres.map(g => `<span class="manga-card-genre">${escapeHtml(g)}</span>`).join("")}</div>` : ""}
          <p class="history-last-chapter">Stopped at: ${escapeHtml(episodeLabel)}</p>
          ${date ? `<p class="history-date">${date}</p>` : ""}
        </div>
        <div class="history-actions">
          <button class="btn history-view-btn" data-idmal="${escapeHtml(f.idMal)}">View Details</button>
          <button class="btn btn-start-reading-detail history-read-btn" data-idmal="${escapeHtml(f.idMal)}">&#9654; Continue Watching</button>
          <button class="history-delete-btn" title="Remove from history" data-idmal="${escapeHtml(f.idMal)}">[x]</button>
        </div>
      </div>`;
  }).join("");

  grid.querySelectorAll(".history-view-btn").forEach(btn => {
    btn.onclick = () => {
      const f = watched.find(x => x.idMal === btn.dataset.idmal);
      if (!f) return;
      _animeGoToDetails({ idMal: f.idMal, anilistId: f.anilistId, title: f.title, cover: f.cover, episodes: f.totalEpisodes || 0 }, null);
    };
  });
  grid.querySelectorAll(".history-read-btn").forEach(btn => {
    btn.onclick = () => {
      const f = watched.find(x => x.idMal === btn.dataset.idmal);
      if (!f) return;
      _animeGoToDetails(
        { idMal: f.idMal, anilistId: f.anilistId, title: f.title, cover: f.cover, episodes: f.totalEpisodes || 0 },
        { episode: f.lastWatchedEpisode || 1, positionSeconds: f.lastPositionSeconds || 0 }
      );
    };
  });
  grid.querySelectorAll(".history-delete-btn").forEach(btn => {
    btn.onclick = async () => {
      try {
        await api("/api/anime/history/remove", {
          method: "POST",
          body: JSON.stringify({ idMal: btn.dataset.idmal }),
        });
        renderAnimeHistory();
      } catch (e) { showToast("Error", e.message, "error"); }
    };
  });
}

// ── Calendar view (M2) — real AniList airing schedule (nextAiringEpisode),
// not a prediction like the manga calendar has to fall back to (manga
// sources don't publish release schedules the way AniList tracks anime
// broadcasts). One batched query with a field alias per show instead of N
// requests — given how easily this app's own AniList budget gets exhausted
// (see the M1/M2 rate-limit incidents), a favorites list of any real size
// firing one request per item would be exactly that mistake again.
// ────────────────────────────────────────────────────────────────────────

async function renderAnimeCalendar() {
  const grid = $("animeCalendarGrid");
  const empty = $("animeCalendarEmpty");
  const status = $("animeCalendarStatus");
  if (!grid) return;

  grid.innerHTML = "";
  empty.classList.add("hidden");
  status.textContent = "Loading...";

  const favorites = (await _fetchAnimeFavorites()).filter(f => f.anilistId);
  if (!favorites.length) {
    status.textContent = "";
    empty.classList.remove("hidden");
    return;
  }

  try {
    const fields = favorites.map((f, i) =>
      `m${i}: Media(id: ${Number(f.anilistId)}, type: ANIME) { idMal title { romaji english } coverImage { extraLarge large } nextAiringEpisode { airingAt episode } }`
    ).join("\n");
    const data = await anilistGQL(`query { ${fields} }`);
    if (data?.errors?.length) throw new Error(data.errors[0]?.message || "AniList calendar query failed");

    const entries = Object.values(data?.data || {})
      .filter(m => m?.nextAiringEpisode?.airingAt)
      .sort((a, b) => a.nextAiringEpisode.airingAt - b.nextAiringEpisode.airingAt);

    status.textContent = "";
    if (!entries.length) {
      empty.classList.remove("hidden");
      empty.textContent = "Nothing currently airing in My Anime.";
      return;
    }

    grid.innerHTML = entries.map(m => {
      const title = m.title?.romaji || m.title?.english || ""; // romaji-first for anime
      const cover = m.coverImage?.extraLarge || m.coverImage?.large || "";
      const airDate = new Date(m.nextAiringEpisode.airingAt * 1000);
      const dateLabel = airDate.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `<div class="manga-card" data-idmal="${m.idMal || ''}" data-title="${escapeHtml(title)}" data-cover="${escapeHtml(cover)}">
        <div class="manga-card-cover">
          <img src="${escapeHtml(cover)}" alt="${escapeHtml(title)}" loading="lazy">
          <span class="all-pop-source-badge">Ep ${m.nextAiringEpisode.episode}</span>
        </div>
        <div class="manga-card-info">
          <div class="manga-card-title">${escapeHtml(title)}</div>
          <div class="manga-card-author">${escapeHtml(dateLabel)}</div>
        </div>
      </div>`;
    }).join("");

    grid.querySelectorAll("[data-idmal]").forEach(card => {
      card.onclick = () => {
        _animeGoToDetails({
          idMal: card.dataset.idmal,
          title: card.dataset.title,
          cover: card.dataset.cover,
        });
      };
    });
  } catch (e) {
    status.textContent = `Couldn't load calendar: ${e.message}`;
    dbg.warn(dbg.ERR_SOURCE, "Anime calendar failed", e);
  }
}

function _initAnimeTestView() {
  _animeSyncProviderSelectOptions();
  _animeLoadProviders();
  const favBtn = $("animeTestFavBtn");
  const mangaCheckBtn = $("animeTestMangaCheckBtn");
  const categoriesBtn = $("animeTestCategoriesBtn");
  const epFilter = $("animeTestEpisodeFilter");
  const video = $("animeTestVideo");
  const providerSelect = $("animeTestProviderSelect");
  if (favBtn) favBtn.onclick = _animeTestToggleFavorite;
  if (mangaCheckBtn) mangaCheckBtn.onclick = _animeTestCheckForManga;
  const animeTrackerBtn = $("animeTrackerBtn");
  if (animeTrackerBtn) animeTrackerBtn.onclick = () => showAnimeTrackerModal(_animeTestCurrent);
  const refreshBtn = $("refreshAnimeBtn");
  if (refreshBtn) refreshBtn.onclick = _animeTestRefreshEpisodeCount;
  // Same "Anime actions" context menu the My Anime library grid's cards use
  // (Edit Tags/Change Cover/Mark as.../Remove/AniList Status/Categories) —
  // right-click on the cover, only shown once the show is
  // actually favorited since every one of those actions assumes a real
  // favorite record exists. Delegated on the image itself rather than
  // rebound per-render since the <img> element is static HTML, only its
  // src changes per show.
  const coverImg = $("animeTestCoverImg");
  if (coverImg) coverImg.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    if (typeof showAnimeLibraryContextMenu !== 'function') return;
    if (!_animeTestFavoriteEntry) {
      showToast("Anime (test)", "Add this show to My Anime first.", "info");
      return;
    }
    showAnimeLibraryContextMenu(e, _animeTestFavoriteEntry);
  });
  // Delegated (not rebound per-render) since #animeTestGenrePills' content
  // is fully replaced on every show load (_animeTestRenderBadgesAndGenres).
  const genrePillsEl = $("animeTestGenrePills");
  if (genrePillsEl) genrePillsEl.onclick = (e) => {
    const pill = e.target.closest(".anime-genre-pill");
    const genre = pill?.dataset.genre;
    if (!genre) return;
    setView("advanced-search");
    if (typeof applyAdvancedSearchMode === "function") applyAdvancedSearchMode("anime");
    const searchInput = $("animeAdvancedSearchInput");
    if (searchInput) searchInput.value = "";
    document.querySelectorAll('#animeGenreGrid input[type="checkbox"], #animeTagGrid input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    const genreCb = document.querySelector(`#animeGenreGrid input[type="checkbox"][value="${CSS.escape(genre)}"]`);
    if (genreCb) genreCb.checked = true;
    if (typeof animeAdvancedSearch === "function") animeAdvancedSearch(1, false);
  };
  if (categoriesBtn) categoriesBtn.onclick = (e) => { e.stopPropagation(); _animeTestToggleCategoriesPanel(); };
  if (epFilter) epFilter.oninput = _animeTestApplyEpisodeFilter;
  const breadcrumbHome = $("animeTestBreadcrumbHome");
  if (breadcrumbHome) breadcrumbHome.onclick = (e) => {
    e.preventDefault();
    setView("discover");
    if (typeof applyHomeMode === 'function') applyHomeMode('anime');
  };
  // Switching server/provider re-requests the *currently playing* episode
  // from the new provider — picking a provider alone never did anything
  // before this, since _animeTestPlayEpisode only reads the dropdown at
  // the moment an episode row is clicked.
  if (providerSelect) providerSelect.onchange = () => {
    if (_animeTestCurrentEpisode) _animeTestPlayEpisode(_animeTestCurrentEpisode);
  };
  const dubToggle = $("animeTestDubToggle");
  if (dubToggle) dubToggle.onchange = () => {
    if (_animeTestCurrentEpisode) _animeTestPlayEpisode(_animeTestCurrentEpisode);
  };
  // SUB/DUB pills — same proxy-into-the-real-control pattern as the
  // player's Settings menu (_animePlayerRenderServerMenu/-QualityMenu):
  // click sets #animeTestDubToggle.checked and fires its existing change
  // handler above, so there's still exactly one place that reacts to a
  // sub/dub switch.
  const langGroup = $("animeTestLangPillGroup");
  if (langGroup && dubToggle) {
    langGroup.querySelectorAll("button[data-lang]").forEach(btn => {
      btn.onclick = () => {
        const wantDub = btn.dataset.lang === "dub";
        if (dubToggle.checked === wantDub) return;
        dubToggle.checked = wantDub;
        dubToggle.dispatchEvent(new Event("change"));
        langGroup.querySelectorAll("button[data-lang]").forEach(b => b.classList.toggle("active", b === btn));
      };
    });
  }
  // Theater mode — hides both sidebars so the player gets the full width.
  // Not persisted across episodes/shows on purpose (matches how most
  // streaming sites treat it: a per-viewing-session toggle, not a saved
  // preference).
  const theaterBtn = $("animeTestTheaterBtn");
  const watchLayout = $("animeWatchLayout");
  if (theaterBtn && watchLayout) {
    theaterBtn.onclick = () => {
      const on = watchLayout.classList.toggle("theater-mode");
      theaterBtn.classList.toggle("active", on);
    };
  }
  // Keys — a small reference popover, not a rebinding UI: the video's
  // native `controls` already give space/arrows/f for play-pause/seek/
  // fullscreen in every real browser, this just documents that plus the
  // one app-specific shortcut (N, wired below).
  const keysBtn = $("animeTestKeysBtn");
  if (keysBtn) keysBtn.onclick = (e) => {
    e.stopPropagation();
    _animeTestToggleKeysPopover();
  };
  // N = jump to the next episode row currently in the sidebar grid — mirrors
  // _animeTestPlayNextEpisodeIfEnabled's own "only advance to a rendered
  // row" rule, so this never guesses past an episode that doesn't exist yet
  // for a still-airing show. Ignored while typing in the episode filter box
  // or any other input, so it doesn't hijack normal text entry.
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "n") return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if ($("view-anime-details")?.classList.contains("hidden")) return;
    if (!_animeTestCurrentEpisode) return;
    const nextEp = _animeTestCurrentEpisode + 1;
    const nextChip = $("animeTestEpisodeList")?.querySelector(`.anime-episode-chip[data-ep="${nextEp}"]`);
    if (nextChip) _animeTestPlayEpisode(nextEp);
  });
  const qualitySelect = $("animeTestQualitySelect");
  if (qualitySelect) qualitySelect.onchange = () => {
    const val = qualitySelect.value;
    // "hls:N" (or "hls:auto") means client-side ABR level switching —
    // instant, no server round-trip. Anything else is a server-provided
    // quality label (AnimePahe) that needs a fresh /api/anime/stream call.
    if (val.startsWith('hls:')) {
      if (!_animeTestHls) return;
      const level = val.slice(4);
      const levelIndex = level === 'auto' ? -1 : parseInt(level, 10);
      // currentLevel alone forces one immediate switch but doesn't disable
      // hls.js's own ABR controller (confirmed live: autoLevelEnabled stayed
      // true and it silently re-picked its own level right after) —
      // loadLevel is what autoLevelEnabled is actually keyed off, so that's
      // what needs setting to make a manual pick stick. nextLevel forces
      // the currently-buffering segment to switch immediately too, instead
      // of only affecting what loads after it.
      _animeTestHls.loadLevel = levelIndex;
      _animeTestHls.nextLevel = levelIndex;
      return;
    }
    if (_animeTestCurrentEpisode) _animeTestPlayEpisode(_animeTestCurrentEpisode, 0, val);
  };
  // Close the categories dropdown on any outside click
  document.addEventListener("click", (e) => {
    const panel = $("animeTestCategoriesPanel");
    if (panel && !panel.classList.contains("hidden") && !panel.contains(e.target) && e.target.id !== "animeTestCategoriesBtn") {
      panel.classList.add("hidden");
    }
  });

  const libStatusFilter = $("animeLibraryStatusFilter");
  const libCatFilter = $("animeLibraryCategoryFilter");
  const libExportBtn = $("animeLibraryExportBtn");
  if (libStatusFilter) libStatusFilter.onchange = _animeApplyLibraryFilters;
  if (libCatFilter) libCatFilter.onchange = _animeApplyLibraryFilters;
  if (libExportBtn) libExportBtn.onclick = _animeExportAnikku;

  // ── My Anime side action panel (mirrors #librarySideActions' wiring) ──
  const btnSortAnime = $("btnSortAnimeLibrary");
  if (btnSortAnime) btnSortAnime.onclick = () => openAnimeLibrarySortDrawer();
  const btnAnimeCats = $("btnManageAnimeCategories");
  if (btnAnimeCats) btnAnimeCats.onclick = () => { if (typeof showManageCategoriesModal === 'function') showManageCategoriesModal(); };
  const btnAnimeTags = $("btnAnimeLibraryTags");
  if (btnAnimeTags) btnAnimeTags.onclick = () => { if (typeof showAnimeLibraryTagsPanel === 'function') showAnimeLibraryTagsPanel(); };
  const btnAnimeDupes = $("btnScanAnimeDuplicates");
  if (btnAnimeDupes) btnAnimeDupes.onclick = () => { if (typeof showAnimeDuplicateScanModal === 'function') showAnimeDuplicateScanModal(); };
  const btnImportLocalAnime = $("importLocalAnimeBtn");
  if (btnImportLocalAnime) btnImportLocalAnime.onclick = () => { if (typeof showImportAnikkuModal === 'function') showImportAnikkuModal(); };
  const btnAnimeSourcesBtn = $("btnAnimeSources");
  if (btnAnimeSourcesBtn) btnAnimeSourcesBtn.onclick = () => { if (typeof showAnimeSourcesModal === 'function') showAnimeSourcesModal(); };

  const btnEditAnimeCard = $("btnEditAnimeLibraryCard");
  if (btnEditAnimeCard) btnEditAnimeCard.onclick = _openEditAnimeLibraryCardModal;
  const closeEditAnimeCard = () => $("customizeAnimeLibraryCardModal")?.classList.add("hidden");
  bindModalEscClose("customizeAnimeLibraryCardModal", closeEditAnimeCard);
  $("btnCustomizeAnimeCardClose")?.addEventListener("click", closeEditAnimeCard);
  $("btnCustomizeAnimeCardCancel")?.addEventListener("click", closeEditAnimeCard);
  $("btnCustomizeAnimeCardSave")?.addEventListener("click", () => {
    saveAnimeLibraryCardSettings(_animeCustCollectFromForm());
    closeEditAnimeCard();
    _animeApplyLibraryFilters();
  });
  $("customizeAnimeLibraryCardModal")?.addEventListener("change", (e) => {
    if (!e.target.matches('input[type="checkbox"]')) return;
    _animeCustRenderPreview(_animeCustCollectFromForm());
  });
  document.querySelectorAll('#customizeAnimeLibraryCardModal .lib-cust-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = ANIME_CUST_PRESETS[btn.dataset.preset];
      if (!preset) return;
      _animeCustApplyToForm(preset);
      _animeCustRenderPreview(preset);
    });
  });
  if (video) {
    video.addEventListener("timeupdate", () => {
      _animeTestSaveProgress(false);
      _animeTestUpdateSkipButtonVisibility(video);
    });
    video.addEventListener("pause", () => _animeTestSaveProgress(true));
    window.addEventListener("beforeunload", () => _animeTestSaveProgress(true));
    video.addEventListener("ended", () => {
      _animeTestSaveProgress(true); // count the finished episode as watched before moving on
      _animeTestPlayNextEpisodeIfEnabled();
    });
  }
  _initAnimePlayerControls();
  const skipOpeningBtn = $("animeTestSkipOpeningBtn");
  if (skipOpeningBtn) {
    skipOpeningBtn.onclick = () => {
      if (!video || !_animeTestSkipTimes) return;
      video.currentTime = _animeTestSkipTimes.end;
      skipOpeningBtn.classList.add("hidden");
    };
  }
}

document.addEventListener("DOMContentLoaded", _initAnimeTestView);
