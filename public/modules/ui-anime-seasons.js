// ============================================================================
// SEASONS VIEW — browse any past/future anime season (AniList data), modeled
// on MyAnimeList's /anime/season page: pick a season+year, see everything
// AniList has for it, paginate through more, jump straight to "now".
//
// Reuses the exact card renderer/click-binder/media-field-set the anime Home
// page's "Current Season" row already uses (ui-anime-discover.js) — same
// cards, same click-to-details behavior, just not capped to the current
// season or to one page of results.
// ============================================================================

const SEASON_ORDER = ["WINTER", "SPRING", "SUMMER", "FALL"];
const SEASONS_PER_PAGE = 50;

let _seasonsCurrent = null; // { season, year } — the season currently displayed
let _seasonsPage = 1;
let _seasonsHasNextPage = false;
let _seasonsLoading = false;
let _seasonsSort = "POPULARITY_DESC";

// "No confirmed air date yet" — AniList's own MediaStatus enum already
// carries this (NOT_YET_RELEASED: announced but nothing airing/aired), no
// extra query field needed since `status` is already part of
// ANIME_DISCOVER_MEDIA_FIELDS (ui-anime-discover.js). Persisted the same way
// as Calendar's analogous toggle (ui-calendar.js) — same key-naming
// convention, survives reloads/season navigation.
const SEASONS_HIDE_UNRELEASED_KEY = 'scrollscape_seasons_hide_unreleased';
function _seasonsHideUnreleased() {
  return localStorage.getItem(SEASONS_HIDE_UNRELEASED_KEY) === '1';
}

function _seasonStep(season, year, delta) {
  let idx = SEASON_ORDER.indexOf(season) + delta;
  let y = year;
  while (idx < 0) { idx += 4; y -= 1; }
  while (idx > 3) { idx -= 4; y += 1; }
  return { season: SEASON_ORDER[idx], year: y };
}

function _seasonLabel(season, year) {
  const label = season.charAt(0) + season.slice(1).toLowerCase();
  return `${label} ${year}`;
}

function _seasonsPopulateYearSelect() {
  const sel = $("seasonsYearSelect");
  if (!sel || sel.options.length) return; // build once
  const nowYear = new Date().getUTCFullYear();
  const years = [];
  for (let y = nowYear + 2; y >= 1960; y--) years.push(y);
  sel.innerHTML = years.map(y => `<option value="${y}">${y}</option>`).join("");
}

function _seasonsSyncControls() {
  const { season, year } = _seasonsCurrent;
  const titleEl = $("seasonsTitle");
  if (titleEl) titleEl.textContent = _seasonLabel(season, year);
  // customSelect.js wraps every <select> in a custom-styled dropdown whose
  // visible label only refreshes on the native element's own 'change' event
  // (see its syncTrigger()) — setting .value alone updates the underlying
  // native select but leaves the visible custom widget showing whatever it
  // last displayed (confirmed live: it kept showing "Winter" — the first
  // <option> — after jumping to a different season this way).
  const setSelectValue = (el, value) => {
    if (!el || el.value === value) return;
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  setSelectValue($("seasonsSeasonSelect"), season);
  setSelectValue($("seasonsYearSelect"), String(year));
}

async function _seasonsLoadPage(reset) {
  if (_seasonsLoading) return;
  _seasonsLoading = true;

  const grid = $("seasonsGrid");
  const status = $("seasonsStatus");
  const loadMoreBtn = $("seasonsLoadMoreBtn");
  if (reset) {
    _seasonsPage = 1;
    if (grid) grid.innerHTML = `<div class="muted">Loading...</div>`;
  } else if (status) {
    status.textContent = "Loading more...";
  }
  if (loadMoreBtn) loadMoreBtn.disabled = true;

  const { season, year } = _seasonsCurrent;
  const query = `query ($season: MediaSeason, $year: Int, $page: Int, $perPage: Int, $sort: [MediaSort]) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { hasNextPage }
      media(type: ANIME, season: $season, seasonYear: $year, sort: $sort) { ${ANIME_DISCOVER_MEDIA_FIELDS} }
    }
  }`;
  const variables = { season, year, page: _seasonsPage, perPage: SEASONS_PER_PAGE, sort: [_seasonsSort] };

  try {
    // Retry once on ANY failure, not just a cleanly-parsed rate-limit error —
    // a real 429/503 can just as easily surface as a thrown exception
    // (anilistGQL throws when the response isn't valid JSON, e.g. a CDN's
    // own rate-limit/error page in front of AniList) as it can a normal
    // GraphQL {errors:[...]} body, and the earlier version only ever
    // retried the latter, silently skipping the retry for the former.
    let data;
    try {
      data = await anilistGQL(query, variables);
      if (data?.errors?.length) throw new Error(data.errors[0]?.message || "AniList request failed");
    } catch (firstErr) {
      await new Promise(r => setTimeout(r, 3000));
      data = await anilistGQL(query, variables);
      if (data?.errors?.length) throw new Error(data.errors[0]?.message || "AniList request failed");
    }

    const hideNsfw = !!state.settings.hideNsfw;
    const hideUnreleased = _seasonsHideUnreleased();
    const media = (data?.data?.Page?.media || [])
      .filter(m => !hideNsfw || !m.isAdult)
      .filter(m => !hideUnreleased || m.status !== 'NOT_YET_RELEASED');
    _seasonsHasNextPage = !!data?.data?.Page?.pageInfo?.hasNextPage;

    if (grid) {
      const html = media.map(m => _animeDiscoverCardHTML(m)).join('');
      if (reset) {
        grid.innerHTML = media.length ? html : `<div class="muted">Nothing found for ${_seasonLabel(season, year)}.</div>`;
      } else {
        grid.insertAdjacentHTML('beforeend', html);
      }
      _bindAnimeDiscoverCards(grid);
    }
    if (status) status.textContent = '';
    if (loadMoreBtn) {
      loadMoreBtn.classList.toggle('hidden', !_seasonsHasNextPage);
      loadMoreBtn.disabled = false;
    }
  } catch (e) {
    dbg.error(dbg.ERR_SOURCE, 'Error loading seasons page', e);
    // AniList's shared per-session budget is easy to exhaust from elsewhere
    // in the app (the startup progress sync in particular — see
    // anilistStartupReconcileProgress's own comment) and give a generic
    // "Error loading anime." here with no indication why, which reads like
    // a bug in this page specifically rather than a temporary, app-wide
    // condition that clears on its own.
    const isRateLimited = /rate limit|too many requests|429/i.test(e?.message || '');
    const msg = isRateLimited
      ? `AniList is rate-limited right now (too many requests). Wait a bit and <a href="#" id="seasonsRetryLink" style="color:var(--primary);text-decoration:underline;">retry</a>.`
      : `Error loading anime. <a href="#" id="seasonsRetryLink" style="color:var(--primary);text-decoration:underline;">Retry</a>`;
    if (reset && grid) grid.innerHTML = `<div class="muted">${msg}</div>`;
    else if (status) status.innerHTML = msg;
    $("seasonsRetryLink")?.addEventListener('click', (ev) => { ev.preventDefault(); _seasonsLoadPage(reset); });
    if (loadMoreBtn) loadMoreBtn.disabled = false;
  } finally {
    _seasonsLoading = false;
  }
}

function _seasonsGoTo(season, year) {
  _seasonsCurrent = { season, year };
  _seasonsSyncControls();
  _seasonsLoadPage(true);
}

function renderSeasonsView() {
  _seasonsPopulateYearSelect();
  if (!_seasonsCurrent) _seasonsCurrent = _currentAniListSeason();
  _seasonsSyncControls();
  _seasonsLoadPage(true);
}
window.renderSeasonsView = renderSeasonsView;

document.addEventListener("DOMContentLoaded", () => {
  $("seeAllSeasonsLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    if (typeof setView === 'function') setView("seasons");
  });
  $("seasonsPrevBtn")?.addEventListener("click", () => {
    const { season, year } = _seasonStep(_seasonsCurrent.season, _seasonsCurrent.year, -1);
    _seasonsGoTo(season, year);
  });
  $("seasonsNextBtn")?.addEventListener("click", () => {
    const { season, year } = _seasonStep(_seasonsCurrent.season, _seasonsCurrent.year, 1);
    _seasonsGoTo(season, year);
  });
  $("seasonsTodayBtn")?.addEventListener("click", () => {
    const { season, year } = _currentAniListSeason();
    _seasonsGoTo(season, year);
  });
  $("seasonsSeasonSelect")?.addEventListener("change", (e) => {
    _seasonsGoTo(e.target.value, _seasonsCurrent.year);
  });
  $("seasonsYearSelect")?.addEventListener("change", (e) => {
    _seasonsGoTo(_seasonsCurrent.season, parseInt(e.target.value, 10));
  });
  $("seasonsSortSelect")?.addEventListener("change", (e) => {
    _seasonsSort = e.target.value || "POPULARITY_DESC";
    _seasonsLoadPage(true);
  });
  $("seasonsLoadMoreBtn")?.addEventListener("click", () => {
    _seasonsPage += 1;
    _seasonsLoadPage(false);
  });
  const hideUnreleasedToggle = $("seasonsHideUnreleasedToggle");
  if (hideUnreleasedToggle) {
    hideUnreleasedToggle.checked = _seasonsHideUnreleased();
    hideUnreleasedToggle.onchange = () => {
      localStorage.setItem(SEASONS_HIDE_UNRELEASED_KEY, hideUnreleasedToggle.checked ? '1' : '0');
      _seasonsLoadPage(true);
    };
  }
});
