// ============================================================================
// UPDATES VIEW
// Manga/anime whose chapter/episode count grew since their last refresh
// (see server/modules/library/update-tracking.js + routes/anime.js's
// refresh-item). Populated by the per-item "Refresh" buttons on the details
// pages (ui-add-to-list-modal.js / ui-anime-test.js) — nothing here scans
// the library on its own.
// ============================================================================

let _updatesTypeFilter = "all"; // "all" | "manga" | "anime"
let _updatesFilterBound = false;

function _bindUpdatesFilterRow() {
  if (_updatesFilterBound) return;
  const row = $("updatesFilterRow");
  if (!row) return;
  _updatesFilterBound = true;
  row.querySelectorAll(".updates-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      _updatesTypeFilter = btn.dataset.filter || "all";
      row.querySelectorAll(".updates-filter-btn").forEach((b) => {
        const active = b === btn;
        b.classList.toggle("primary", active);
        b.classList.toggle("secondary", !active);
      });
      renderUpdatesView();
    });
  });
}

async function renderUpdatesView() {
  const grid = $("updatesGrid");
  const countEl = $("updatesCount");
  if (!grid) return;
  _bindUpdatesFilterRow();
  grid.innerHTML = `<p class="muted" style="grid-column:1/-1;text-align:center;margin:2rem 0">Loading…</p>`;

  let data;
  try {
    data = await api("/api/library/updates");
  } catch (e) {
    grid.innerHTML = `<p class="muted" style="grid-column:1/-1;text-align:center;margin:2rem 0">Could not load updates: ${escapeHtml(e.message)}</p>`;
    return;
  }

  const allManga = data.manga || [];
  const allAnime = data.anime || [];
  // Badge/auto-refresh sweep should always reflect the true unfiltered
  // total, not whatever tab happens to be selected right now.
  const total = allManga.length + allAnime.length;
  _refreshUpdatesBadgeCount(total);

  const manga = _updatesTypeFilter === "anime" ? [] : allManga;
  const anime = _updatesTypeFilter === "manga" ? [] : allAnime;
  const shown = manga.length + anime.length;
  if (countEl) countEl.textContent = `${shown} update${shown !== 1 ? "s" : ""}`;

  if (!shown) {
    const emptyMsg = _updatesTypeFilter === "manga"
      ? `No new chapters since your last refresh. Use the "Refresh" button on a manga's page to check it.`
      : _updatesTypeFilter === "anime"
      ? `No new episodes since your last refresh. Use the "Refresh" button on an anime's page to check it.`
      : `No new chapters or episodes since your last refresh. Use the "Refresh" button on a manga or anime's page to check it.`;
    grid.innerHTML = `<p class="muted" style="grid-column:1/-1;text-align:center;margin:2rem 0">${emptyMsg}</p>`;
    return;
  }

  grid.innerHTML = [
    ...manga.map((m) => _updatesCardHtml(m.title, m.cover, "new chapters", m.lastUpdateDetectedAt)),
    ...anime.map((a) => _updatesCardHtml(a.title, a.cover, "new episodes", a.lastUpdateDetectedAt)),
  ].join("");

  const cards = Array.from(grid.querySelectorAll(".updates-card"));
  manga.forEach((m, i) => {
    const card = cards[i];
    card.onclick = () => {
      api("/api/library/updates/dismiss", { method: "POST", body: JSON.stringify({ mangaId: m.id, sourceId: m.sourceId }) }).catch(() => {});
      loadMangaDetails(m.id, "updates", m.title || "", false, m.sourceId);
    };
  });
  anime.forEach((a, i) => {
    const card = cards[manga.length + i];
    card.onclick = () => {
      api("/api/anime/updates/dismiss", { method: "POST", body: JSON.stringify({ idMal: a.idMal }) }).catch(() => {});
      setView("anime-details", {
        show: {
          idMal: a.idMal,
          anilistId: a.anilistId || null,
          title: a.title,
          cover: a.cover || "",
          episodes: Number(a.totalEpisodes) || 0,
        },
      });
    };
  });
}

function _updatesCardHtml(title, cover, badgeText, detectedAt) {
  // lastUpdateDetectedAt is when OUR sweep/refresh noticed the new chapter/
  // episode, not the source's own publish date (this feed has no per-item
  // access to that without a much heavier per-source fetch) - labeled
  // "Found" rather than implying it's the source's original release date.
  const dateLabel = detectedAt && typeof _timeAgo === 'function' ? _timeAgo(detectedAt) : '';
  return `<div class="library-card updates-card" style="cursor:pointer">
    ${cover ? `<img src="${escapeHtml(normalizeImageUrl(cover))}" loading="lazy" style="width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:8px" onerror="this.style.display='none'">` : `<div style="width:100%;aspect-ratio:2/3;border-radius:8px;background:color-mix(in srgb, var(--primary) 12%, transparent)"></div>`}
    <div style="padding:6px 2px">
      <div style="font-size:0.85rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(title || "")}</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:3px">
        <span style="font-size:0.72rem;font-weight:700;color:#7cfc88">&#9679; ${badgeText}</span>
        ${dateLabel ? `<span style="font-size:0.68rem;color:var(--text-muted)" title="When this update was found">${escapeHtml(dateLabel)}</span>` : ''}
      </div>
    </div>
  </div>`;
}

function _refreshUpdatesBadgeCount(count) {
  const badge = $("sidebarUpdatesBadge");
  if (!badge) return;
  if (count > 0) {
    badge.textContent = String(count);
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

// ── Auto-refresh sweep on app open ──────────────────────────────────────────
// Runs the same per-item refresh the manual "Refresh" buttons trigger, just
// across the whole library, in the background, once per app open. Two
// things keep this from being the "hammer every source at once" problem
// that was deliberately avoided when this feature was first built:
//
//  - A cooldown: an item checked within the last few hours is skipped, so
//    reloading the page (or reopening the app again the same day) doesn't
//    re-run the same few hundred requests every time.
//  - Concurrency 2, not the 5 the migrate flow uses — this runs completely
//    unattended, nobody's watching to notice (or care about) BatCave-style
//    sources getting hammered, so it errs conservative. A single slow or
//    down source only ever blocks its own 1-2 worker slots, never the rest
//    of the sweep (per-item try/catch, matching refresh-item's own design).
const UPDATES_AUTO_REFRESH_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4h
const UPDATES_AUTO_REFRESH_CONCURRENCY = 2;
let _updatesAutoRefreshRan = false;

// "Smart Update": server/modules/library/content-service.js computes
// nextUpdateEstimate live from each favorite's own real release history
// (update-tracking.js's predictNextCheckWindow) — a title that reliably
// drops a chapter every ~9 days stops costing a request every single sweep
// once nothing's due for another week, while a title with too little
// history yet (fewer than 2 detected updates) has no estimate at all and
// falls straight back to the flat cooldown this always used before, exactly
// like a freshly-added favorite with no update history would.
//
// The prediction can only make a title wait LONGER than the flat cooldown,
// never shorter — a noisy estimate from just two data points (the minimum
// needed to predict anything at all) suggesting "check again in an hour"
// would otherwise re-introduce the exact hammering-a-source problem the
// cooldown already exists to prevent.
function _needsAutoRefresh(item) {
  const last = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
  const cooldownElapsed = !last || (Date.now() - last) > UPDATES_AUTO_REFRESH_COOLDOWN_MS;
  if (!item.nextUpdateEstimate) return cooldownElapsed;

  const windowStart = new Date(item.nextUpdateEstimate).getTime();
  if (!Number.isFinite(windowStart)) return cooldownElapsed;
  return cooldownElapsed && Date.now() >= windowStart;
}

async function _fetchAniListEpisodeCountForSweep(idMal) {
  const query = `query ($idMal: Int) { Media(idMal: $idMal, type: ANIME) { episodes } }`;
  try {
    let data = await anilistGQL(query, { idMal: Number(idMal) });
    if (data?.errors?.some(e => /rate limit|too many requests/i.test(e.message || ''))) {
      await new Promise(r => setTimeout(r, 3000));
      data = await anilistGQL(query, { idMal: Number(idMal) });
    }
    return Number(data?.data?.Media?.episodes) || 0;
  } catch (_) {
    return 0;
  }
}

async function _autoRefreshAllOnAppOpen() {
  if (_updatesAutoRefreshRan) return; // one sweep per page load
  _updatesAutoRefreshRan = true;

  let mangaFavorites = [];
  let animeFavorites = [];
  try {
    const [libData, animeData] = await Promise.all([
      api("/api/library"),
      api("/api/anime/favorites"),
    ]);
    mangaFavorites = libData.favorites || [];
    animeFavorites = animeData.favorites || [];
  } catch (_) {
    return; // Can't even list the library — nothing to sweep.
  }

  // Completed/cancelled manga can't grow new chapters — skipping them cuts
  // the sweep down to only titles that could plausibly have something new,
  // which also means far fewer requests landing on already-strained sources
  // (confirmed live: AllManga's own rate limiter tripped instantly during
  // testing when its 163 entries — most of them presumably long-finished —
  // were all queued regardless of status).
  // Matches the raw values sources actually return (server/modules/library/
  // service.js's syncLibraryStatus only normalizes these to 'completed'/
  // 'cancelled' when that background job happens to run — a status written
  // by refreshMangaItem itself, or one that job hasn't reached yet, can
  // still be sitting as one of these raw variants).
  const NO_NEW_CHAPTERS_STATUSES = new Set(['completed', 'finished', 'end', 'cancelled', 'dropped']);
  const mangaQueue = mangaFavorites.filter((m) =>
    m.sourceId && m.sourceId !== 'local' && m.sourceId !== 'unknown'
    && !NO_NEW_CHAPTERS_STATUSES.has(String(m.status || '').toLowerCase())
    && _needsAutoRefresh(m)
  );
  // Same reasoning as the manga filter above, now that anime favorites can
  // carry a real airing status too (f.airingStatus, set by "Sync Anime
  // Library Status" — Settings > Anime tab, or left unset for a favorite
  // that's never been synced, which just never gets skipped here). AniList's
  // own status field is authoritative (not a scraped guess), so no raw-
  // variant matching is needed the way manga's mixed source vocabulary
  // requires — "ongoing"/"completed"/"not_yet_released"/"cancelled"/"hiatus"
  // are the only values this project ever writes into it (see routes/anime.js's
  // ANIME_AIRING_STATUSES). Hiatus stays out of the skip set on purpose — a
  // hiatus show can still resume.
  const ANIME_NO_NEW_EPISODES_STATUSES = new Set(['completed', 'cancelled']);
  const animeQueue = animeFavorites.filter((a) =>
    a.idMal
    && !ANIME_NO_NEW_EPISODES_STATUSES.has(String(a.airingStatus || '').toLowerCase())
    && _needsAutoRefresh(a)
  );
  const queue = [
    ...mangaQueue.map((m) => ({ type: "manga", item: m })),
    ...animeQueue.map((a) => ({ type: "anime", item: a })),
  ];
  if (!queue.length) return;

  let nextIdx = 0;
  let processed = 0;
  let foundAny = false;

  async function worker() {
    while (nextIdx < queue.length) {
      const { type, item } = queue[nextIdx++];
      try {
        if (type === "manga") {
          const result = await api("/api/library/refresh-item", {
            method: "POST",
            body: JSON.stringify({ mangaId: item.id, sourceId: item.sourceId }),
          });
          if (result.isUpdate) foundAny = true;
        } else {
          const freshCount = await _fetchAniListEpisodeCountForSweep(item.idMal);
          if (freshCount > 0) {
            const result = await api("/api/anime/refresh-item", {
              method: "POST",
              body: JSON.stringify({ idMal: item.idMal, totalEpisodes: freshCount }),
            });
            if (result.isUpdate) foundAny = true;
          }
        }
      } catch (_) {
        // One item failing (down source, timeout, etc.) never stops the sweep.
      }
      processed++;
      // Live-updates the badge every few items rather than only at the very
      // end — a full sweep across a large library can take minutes, and
      // "the badge just changes at some point" reads better than nothing
      // happening until it's entirely done.
      if (foundAny && processed % 5 === 0) {
        api("/api/library/updates").then((d) => {
          _refreshUpdatesBadgeCount((d.manga?.length || 0) + (d.anime?.length || 0));
        }).catch(() => {});
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(UPDATES_AUTO_REFRESH_CONCURRENCY, queue.length) }, worker));

  try {
    const finalData = await api("/api/library/updates");
    _refreshUpdatesBadgeCount((finalData.manga?.length || 0) + (finalData.anime?.length || 0));
  } catch (_) {}
}

// Populate the sidebar badge immediately on load (whatever's already known
// server-side, without waiting for the view to be opened), then kick off
// the background sweep above — the badge gets a second, more complete
// update once that finishes.
document.addEventListener("DOMContentLoaded", () => {
  api("/api/library/updates").then((data) => {
    _refreshUpdatesBadgeCount((data.manga?.length || 0) + (data.anime?.length || 0));
  }).catch(() => {});
  _autoRefreshAllOnAppOpen();
});
