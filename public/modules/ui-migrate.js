// ============================================================================
// LIBRARY MIGRATION
// Lets the user move manga from one source to another, with per-manga
// chapter-count comparison so they can pick the best-updated source.
// ============================================================================

// ── Helpers ──────────────────────────────────────────────────────────────────

// BatCave is Western comics (DC/Marvel), not manga — no other installed
// source carries that content at all, so it can never be a valid migration
// target (nothing to search for a match against) nor a useful "from" group
// (nowhere to migrate its own favorites to either). It was also the single
// biggest cost in "Comparing sources" (~8s per search, always a miss) for
// exactly that reason: real time spent confirming something structurally
// true from the start. Excluded everywhere migration gathers a source list.
const MIGRATE_EXCLUDED_SOURCES = new Set(['batcave']);

/** Group favorites by sourceId and return sorted array of { sourceId, count, mangas }. */
function _migrateGroupBySource() {
  const map = new Map();
  // Agrupa todos os mangas sem source sob o mesmo grupo 'unknown'
  for (const m of (state.favorites || [])) {
    let sid = m.sourceId;
    if (!sid || sid === 'unknown' || sid === 'null' || sid === 'undefined') sid = 'unknown';
    if (MIGRATE_EXCLUDED_SOURCES.has(sid)) continue;
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(m);
  }
  return [...map.entries()]
    .map(([sourceId, mangas]) => ({ sourceId, count: mangas.length, mangas }))
    .sort((a, b) => b.count - a.count);
}

/** Source display name — uses installed sources info if available. */
function _srcName(sourceId) {
  if (sourceId === 'unknown') return 'Sem source';
  if (sourceId === 'anilist') return 'AniList (placeholder)';
  return state.installedSources?.[sourceId]?.name || sourceId;
}

function _normSourceId(sourceId) {
  return sourceId || 'unknown';
}

function _migrateStoreKeyPart(v) {
  return String(v || '').replace(/[^a-z0-9:_-]/gi, '_');
}

function _migrateStatusKey(mangaId, sourceId) {
  return `${_migrateStoreKeyPart(mangaId)}:${_migrateStoreKeyPart(sourceId || 'unknown')}`;
}

function _cleanTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _titleSimilarity(a, b) {
  const aa = _cleanTitle(a);
  const bb = _cleanTitle(b);
  if (!aa || !bb) return 0;
  if (aa === bb) return 1;

  // Whole-word/phrase containment ("one piece" inside "one piece pirate
  // warriors") is a strong signal, but a raw substring check isn't safe for
  // short titles — confirmed live in a real Migrate All run: "HEN" (a real
  // favorite's title) is a literal substring of "Shen Yi Di Nu" even though
  // the two share no actual word, and the old `aa.includes(bb)` check
  // scored that pair 0.9 (comfortably above MIN_SIM), migrating the
  // favorite to a completely unrelated manga. \b word boundaries around the
  // ENTIRE shorter title make sure it only counts when it appears as whole
  // word(s) in the longer one, not embedded inside an unrelated word.
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shorter = aa.length <= bb.length ? aa : bb;
  const longer = aa.length <= bb.length ? bb : aa;
  if (new RegExp(`\\b${escapeRe(shorter)}\\b`).test(longer)) return 0.9;

  const sa = new Set(aa.split(' '));
  const sb = new Set(bb.split(' '));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / Math.max(sa.size, sb.size);
}

// 5s not 8s — a source that's actually down (confirmed live: BatCave and
// VortexScans both routinely ran the full old 8s timeout out on every
// single search, ~55 times per batch of 5 manga × 11 sources) was the
// dominant cost of the whole "Comparing sources" step, dwarfing the
// per-candidate parallelization fix. Genuinely slow-but-working sources in
// the same measurement all finished well under 4s, so this still leaves
// real headroom for those.
const MIGRATE_SOURCE_TIMEOUT_MS = 5000;

// Global cap across the WHOLE scan, on top of each source's own
// sourceConcurrency (default 3) — without this, N installed sources means
// up to 3xN simultaneous in-flight requests with nothing bounding the
// total (confirmed: ~39 at once with 13 sources installed). Several
// installed sources are FlareSolverr-backed, and the server can only run
// one FlareSolverr solve per domain at a time (withFsLock, server-side) —
// that only serializes requests to the *same* domain, not the overall
// volume this scan fires across every domain at once, so a wide-enough
// fan-out still queues deep enough server-side to blow past
// MIGRATE_SOURCE_TIMEOUT_MS before FlareSolverr even starts on some of
// them, which then reads as a false "miss" and feeds the circuit breaker.
// A single global semaphore, acquired around each manga-vs-source check
// regardless of which source's pool it belongs to, bounds real concurrent
// load without touching the per-source pacing that pool already provides.
const MIGRATE_GLOBAL_CONCURRENCY = 8;

function _migrateCreateSemaphore(max) {
  let active = 0;
  const queue = [];
  function acquire() {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }
  function release() {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  }
  return { acquire, release };
}

async function _sourceSearch(sourceId, query) {
  return fetch(`/api/source/${encodeURIComponent(sourceId)}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, page: 1 }),
    signal: AbortSignal.timeout(MIGRATE_SOURCE_TIMEOUT_MS)
  }).then(res => res.json());
}

// Two independent, pre-existing ways a source can be turned off, both
// checked here so every "what can I migrate to" list below excludes a
// source no matter which one the user used — same as a
// MIGRATE_EXCLUDED_SOURCES entry, a source the user deliberately turned
// off shouldn't still be offered as a migration target:
//  - state.settings.visibleSources (the quick "Sources" picker on Home) —
//    null means "no filter set, everything's visible", same convention
//    ui-library.js's own visibleSources check already uses.
//  - state.settings.disabledSourceIds (Settings → Sources → Manga Sources → "Disabled
//    sources") — the same field getSelectableSources() (ui-state.js)
//    already filters by for Search/Discover/Random Manga source pickers;
//    migration never went through that shared helper, so it never picked
//    this one up.
function _migrateVisibleSourceFilter(sid) {
  const visibleSources = Array.isArray(state.settings?.visibleSources) ? state.settings.visibleSources : null;
  if (visibleSources !== null && !visibleSources.includes(sid)) return false;
  const disabledSourceIds = state.settings?.disabledSourceIds;
  if (Array.isArray(disabledSourceIds) && disabledSourceIds.includes(sid)) return false;
  return true;
}

async function _getInstalledTargetSources(fromSourceId) {
  try {
    const stateData = await api('/api/state');
    return Object.values(stateData?.installedSources || {})
      .filter(s => s.id !== 'local' && s.id !== fromSourceId && !MIGRATE_EXCLUDED_SOURCES.has(s.id) && _migrateVisibleSourceFilter(s.id))
      .map(s => s.id);
  } catch (_) {
    return getSelectableSourceIds().filter(sid => sid !== 'local' && sid !== fromSourceId && !MIGRATE_EXCLUDED_SOURCES.has(sid) && _migrateVisibleSourceFilter(sid));
  }
}

async function _isMigratableManga(manga, targetSources) {
  const title = String(manga?.title || '').trim();
  if (!title || !targetSources.length) return false;

  for (const sid of targetSources) {
    try {
      const r = await _sourceSearch(sid, title);
      const candidates = (r?.results || []).slice(0, 6);
      for (const c of candidates) {
        if (!c?.id) continue;
        if (_titleSimilarity(title, c.title || '') >= 0.2) return true;
      }
    } catch (_) {
      // Ignore failing source and continue checking others.
    }
  }
  return false;
}

async function _filterMigratableMangas(mangas, fromSourceId) {
  const targetSources = await _getInstalledTargetSources(fromSourceId);
  if (!targetSources.length) return [];

  const BATCH = 6;
  const out = [];
  for (let i = 0; i < mangas.length; i += BATCH) {
    const chunk = mangas.slice(i, i + BATCH);
    const flags = await Promise.all(chunk.map(m => _isMigratableManga(m, targetSources)));
    flags.forEach((ok, idx) => {
      if (ok) out.push(chunk[idx]);
    });
  }
  return out;
}

async function _sourceChaptersCount(sourceId, mangaId) {
  try {
    const r = await fetch(`/api/source/${encodeURIComponent(sourceId)}/chapters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mangaId }),
      signal: AbortSignal.timeout(MIGRATE_SOURCE_TIMEOUT_MS)
    }).then(res => res.json());
    const ch = r?.chapters || [];
    return Array.isArray(ch) ? ch.length : null;
  } catch (_) {
    return null;
  }
}

// Circuit breaker for the current "Comparing sources" run only (reset in
// _migrateShowStep3 below, never persisted) — a source that's actually
// unreachable right now (BatCave/VortexScans, confirmed live) doesn't get
// any less broken by asking it again for the next manga in the list, but
// every miss still paid the full search timeout. After a few consecutive
// misses in THIS run, stop spending that timeout on it and treat it as an
// instant no-match for the rest of the run — a source having a bad moment
// gets a few real tries first, it just doesn't get 22 of them.
const _migrateSourceMissStreak = new Map();
const MIGRATE_SOURCE_MISS_LIMIT = 3;

// Every query _chapCount generates on its own (below) is just a punctuation
// variant of the SAME title string — if a manga is filed under its
// original-language title on the current source but a target source only
// indexes the English (or vice versa), none of those variants ever help,
// because they're not actually a different title, just a different cut of
// the same one. AniList already carries romaji/english/synonyms for almost
// everything, so one lookup per manga (cached per run, not per source) adds
// the genuinely different titles this needs. Cache key is the lowercased
// title, cleared per "Comparing sources" run in _migrateShowStep3.
const _migrateAniListVariantCache = new Map();

async function _fetchAniListTitleVariants(title) {
  const key = String(title || '').trim().toLowerCase();
  if (!key) return [];
  if (_migrateAniListVariantCache.has(key)) return _migrateAniListVariantCache.get(key);

  const gql = `query ($search: String) {
    Media(search: $search, type: MANGA) {
      title { romaji english native }
      synonyms
    }
  }`;
  try {
    let data = await anilistGQL(gql, { search: title });
    if (data?.errors?.some(e => /rate limit|too many requests/i.test(e.message || ''))) {
      await new Promise(r => setTimeout(r, 3000));
      data = await anilistGQL(gql, { search: title });
    }
    const m = data?.data?.Media;
    const variants = m
      ? [...new Set([m.title?.romaji, m.title?.english, ...(m.synonyms || [])].filter(Boolean))]
      : [];
    _migrateAniListVariantCache.set(key, variants);
    return variants;
  } catch (_) {
    _migrateAniListVariantCache.set(key, []);
    return [];
  }
}

/** Fetch first-result chapter count from a single source for a title, plus
 *  any AniList-sourced alternate titles (see _fetchAniListTitleVariants) —
 *  candidates are matched against whichever of those reads closest, not
 *  just the original title, so a source indexing this under a different
 *  language's title still counts as a real match. Returns null on miss.
 *  `missLimit` overrides MIGRATE_SOURCE_MISS_LIMIT — see
 *  _migrateAllMissLimit's own comment for why "Migrate All" needs a much
 *  higher one than Step 3's small per-source-group runs do. */
async function _chapCount(sourceId, title, extraTitles = [], missLimit = MIGRATE_SOURCE_MISS_LIMIT) {
  if ((_migrateSourceMissStreak.get(sourceId) || 0) >= missLimit) return null;
  try {
    const titleStr = String(title || '').trim();
    if (!titleStr) return null;
    // Was 0.55 — raised alongside the word-boundary fix above (_titleSimilarity)
    // after a real Migrate All run confirmed several 0.55-0.6-range matches
    // were plainly wrong manga (shared only a generic word/short substring,
    // e.g. "Ideal Type but Rigid" vs "Not My Ideal Type"). 0.65 is still well
    // below the 0.9 a genuine phrase-containment or AniList-variant exact
    // match scores, so real matches aren't affected — it only raises the bar
    // for the loose word-overlap fallback.
    const MIN_SIM = 0.65;

    const titleVariants = [titleStr, ...extraTitles.map(t => String(t || '').trim())].filter(Boolean);
    const bestSim = (candidateTitle) => Math.max(...titleVariants.map(t => _titleSimilarity(t, candidateTitle)));

    // Exact title + AniList's genuinely different-language variants
    // (romaji/english/native/synonyms) come first; punctuation-only
    // reshuffles of the SAME title (split on ':'/'-', a cleaned version)
    // come last and get skipped entirely when every "primary" query above
    // came back completely empty (see the early-exit below) — a source
    // that recognizes nothing under the exact title or any of its real
    // alternate names is very unlikely to suddenly match a different
    // punctuation cut of that same string, so paying for those extra
    // round-trips on a guaranteed miss is pure waste. Confirmed live: a
    // single manga×source miss against a FlareSolverr-backed source
    // (shared browser instance, effectively one request at a time across
    // every such source at once — see flaresolverr-lifecycle.js) measured
    // at 24s for what should be a quick lookup; this doesn't fix that
    // shared bottleneck, but it does cut how many times a guaranteed miss
    // has to pay for it.
    const anilistVariants = extraTitles.map(t => String(t || '').trim()).filter(Boolean);
    const punctuationVariants = [
      titleStr.split(':')[0]?.trim(),
      titleStr.split('-')[0]?.trim(),
      _cleanTitle(titleStr),
    ].filter(Boolean);
    const primaryQueries = [...new Set([titleStr, ...anilistVariants])];
    const fallbackQueries = [...new Set(punctuationVariants)].filter(q => !primaryQueries.includes(q));
    const queries = [...primaryQueries, ...fallbackQueries].slice(0, 8);
    const primaryCount = Math.min(primaryQueries.length, queries.length);

    let candidatesFound = new Map();
    let anyNonEmptyResult = false;

    for (let i = 0; i < queries.length; i++) {
      const q = queries[i];
      const r = await _sourceSearch(sourceId, q);
      const rawResults = r?.results || [];
      if (rawResults.length > 0) anyNonEmptyResult = true;

      const candidates = rawResults.slice(0, 8)
        .filter(c => c?.id && !candidatesFound.has(c.id))
        .map(c => ({ c, sim: bestSim(c.title || '') }))
        .filter(({ sim }) => sim >= MIN_SIM);

      // Each candidate's chapter count is independent of the others — this
      // used to await them one at a time (up to 8 per query, up to 4
      // queries per manga×source pair, ×11 sources ×N manga overall), which
      // was the actual reason "Comparing sources" took forever: dozens of
      // full chapter-list fetches queued up strictly sequentially per pair
      // instead of overlapping. The query loop itself stays sequential —
      // its early-exit below (stop once a good match is found) is a real
      // savings worth keeping for the common case where the first query
      // variant already succeeds.
      await Promise.all(candidates.map(async ({ c, sim }) => {
        let chapCount = Number.isFinite(Number(c.lastChapter)) ? Number(c.lastChapter) : null;
        if (chapCount === null) {
          chapCount = await _sourceChaptersCount(sourceId, c.id);
        }

        candidatesFound.set(c.id, {
          // Similarity dominates rank (×100000, not ×1000) so a better
          // title match always outranks a worse-matched candidate with more
          // chapters — chapCount only breaks ties between near-equally
          // well-matched candidates, rather than being able to override a
          // real similarity gap the way the old weighting allowed.
          rank: sim * 100000 + (chapCount || 0),
          chapCount,
          mangaId: c.id,
          cover: c.cover,
          title: c.title || titleStr
        });
      }));

      if ([...candidatesFound.values()].some(c => c.chapCount !== null && c.chapCount > 0)) {
        break;
      }

      if (i === primaryCount - 1 && !anyNonEmptyResult) break;
    }

    if (candidatesFound.size === 0) {
      _migrateSourceMissStreak.set(sourceId, (_migrateSourceMissStreak.get(sourceId) || 0) + 1);
      return null;
    }

    const allCandidates = [...candidatesFound.values()].sort((a,b) => b.rank - a.rank);
    const best = allCandidates[0];
    _migrateSourceMissStreak.set(sourceId, 0);

    return {
      chapCount: best.chapCount,
      mangaId: best.mangaId,
      cover: best.cover,
      title: best.title,
      allCandidates
    };
  } catch (_) {
    _migrateSourceMissStreak.set(sourceId, (_migrateSourceMissStreak.get(sourceId) || 0) + 1);
    return null;
  }
}

// ── State for the modal ───────────────────────────────────────────────────────

let _migrateSelectedMangas  = []; // { id, sourceId, title, cover }
let _migrateFromSourceId    = null;
// What to carry over to the new source, chosen on the "Data to migrate" step
// below (_migrateShowDataToggleStep) — persists across runs within the same
// page load (not saved to localStorage) so re-migrating shortly after
// doesn't reset the user's choices back to "everything".
let _migrateDataToggles = { categories: true, chapters: true, tracking: true, cover: true };

// ── Step 0 — "Data to migrate" toggles ──────────────────────────────────────
// Shown first for every migration entry point (single manga, multi-select via
// Migrate Library, and the Migrate All sweep) before any of their own
// source-picking/comparison UI. Replaces modal's .settings-body in place and
// calls onContinue() once the user confirms — the caller is responsible for
// building whatever comes next into the same .settings-body.
function _migrateShowDataToggleStep(modal, onContinue) {
  const body = modal.querySelector('.settings-body');
  if (!body) { onContinue(); return; }

  const TOGGLES = [
    { key: 'categories', label: 'Categories', desc: 'Custom list membership for this manga.' },
    { key: 'chapters',   label: 'Chapters (Progress)', desc: 'Reading status plus per-chapter read/flagged progress.' },
    { key: 'tracking',   label: 'Tracking', desc: 'AniList link for this manga.' },
    { key: 'cover',      label: 'Cover', desc: 'Your custom cover, if you set one for this manga.' },
  ];

  body.innerHTML = `
    <p style="margin:0 0 1.1rem;color:var(--text-muted);font-size:0.88rem">Choose what to carry over to the new source.</p>
    <div class="setting-group">
      <label>Data to migrate:</label>
      ${TOGGLES.map(item => `
        <label class="toggle-label" style="padding:0.65rem 0">
          <span class="toggle-text">
            ${escapeHtml(item.label)}
            <span style="display:block;font-weight:400;font-size:0.78rem;color:var(--text-muted);margin-top:2px">${escapeHtml(item.desc)}</span>
          </span>
          <input type="checkbox" class="migrate-data-toggle" data-key="${item.key}" ${_migrateDataToggles[item.key] ? 'checked' : ''}>
          <span class="toggle-slider"></span>
        </label>`).join('')}
    </div>
    <div class="setting-group" style="display:flex;flex-direction:row;gap:8px;margin-top:0.4rem">
      <button class="btn primary" id="migrateDataToggleContinue" style="flex:1">Continue</button>
      <button class="btn secondary" id="migrateDataToggleCancel">Cancel</button>
    </div>`;

  body.querySelectorAll('.migrate-data-toggle').forEach(cb => {
    cb.onchange = () => { _migrateDataToggles[cb.dataset.key] = cb.checked; };
  });
  document.getElementById('migrateDataToggleCancel').onclick = () => modal.remove();
  document.getElementById('migrateDataToggleContinue').onclick = () => onContinue();
}

function showMigrateModalForManga(manga) {
  if (!manga || !manga.id) {
    showToast('Migration', 'Invalid manga selection.', 'warning');
    return;
  }

  const sourceId = _normSourceId(
    manga.sourceId
    || state.currentSourceId
    || (state.favorites || []).find(f => String(f.id) === String(manga.id))?.sourceId
    || ''
  );

  if (!sourceId) {
    showToast('Migration', 'Could not resolve source for this manga.', 'warning');
    return;
  }
  if (MIGRATE_EXCLUDED_SOURCES.has(sourceId)) {
    showToast('Migration', `${_srcName(sourceId)} has no equivalent among your other installed sources, so this can't be migrated.`, 'info');
    return;
  }

  _migrateFromSourceId = sourceId;
  _migrateSelectedMangas = [{
    ...manga,
    sourceId,
    title: manga.title || manga.name || manga.id,
    cover: manga.cover || '',
  }];

  document.getElementById('migrateModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'migrateModal';
  modal.className = 'settings-modal';
  modal.innerHTML = `
    <div class="settings-content" style="width:min(96vw,1080px);max-width:1080px;max-height:96vh;overflow:auto;border:1px solid color-mix(in srgb, var(--primary) 25%, transparent);box-shadow:0 16px 50px rgba(0,0,0,0.55)">
      <div class="settings-header">
        <h2>Migrate Manga</h2>
        <button class="btn secondary" id="migrateBtnCloseSingle">&#x2715;</button>
      </div>
      <div class="settings-body" style="text-align:center;padding:2rem 1rem;color:var(--text-muted)">
        Preparing migration options for <strong>${escapeHtml(manga.title || manga.name || manga.id)}</strong>…
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.getElementById('migrateBtnCloseSingle').onclick = () => modal.remove();

  _migrateShowDataToggleStep(modal, () => _migrateShowStep3(modal));
}

// ── Step 1 — Source overview ──────────────────────────────────────────────────

function showMigrateModal() {
  document.getElementById('migrateModal')?.remove();

  const groups = _migrateGroupBySource();

  // A source name's own first letter (deterministic, no icon assets to
  // manage) gives each row a quick visual anchor instead of a wall of
  // same-weight text rows — colored via a small fixed hue rotation off the
  // theme's own primary so it stays on-palette in both light and dark mode
  // without hardcoding a color per source.
  const avatarHue = (name) => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  };

  const rows = groups.length === 0
    ? `<div style="text-align:center;padding:2.5rem 1rem;color:var(--text-muted)">Library is empty.</div>`
    : groups.map(g => {
        const name = _srcName(g.sourceId);
        const hue = avatarHue(name);
        const isPlaceholder = g.sourceId === 'anilist' || g.sourceId === 'unknown';
        return `
        <div class="migrate-source-row" data-source-id="${escapeHtml(g.sourceId)}" style="display:flex;align-items:center;gap:0.9rem;padding:0.7rem 0.9rem;border-radius:12px;cursor:pointer;border:1px solid transparent;transition:background-color .15s ease, border-color .15s ease, transform .15s ease">
          <div style="width:38px;height:38px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:0.95rem;color:#fff;background:linear-gradient(135deg, hsl(${hue} 62% 45%), hsl(${hue} 62% 32%))">${escapeHtml(name.charAt(0).toUpperCase())}</div>
          <div style="flex:1;min-width:0;display:flex;align-items:center;gap:0.5rem">
            <span style="font-weight:600;font-size:0.98rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name)}</span>
            ${isPlaceholder ? `<span class="migrate-badge-warn">no source</span>` : ''}
          </div>
          <span style="font-variant-numeric:tabular-nums;font-size:0.9rem;color:var(--text-muted);min-width:2.5rem;text-align:right">${g.count}</span>
          <span class="migrate-source-chevron" style="color:var(--primary);font-size:1.1rem;transition:transform .15s ease">&rsaquo;</span>
        </div>`;
      }).join('');

  const modal = document.createElement('div');
  modal.id = 'migrateModal';
  modal.className = 'settings-modal';
  modal.innerHTML = `
    <div class="settings-content" style="width:min(96vw,1080px);max-width:1080px;max-height:96vh;overflow:auto;border:1px solid color-mix(in srgb, var(--primary) 25%, transparent);box-shadow:0 16px 50px rgba(0,0,0,0.55)">
      <div class="settings-header">
        <h2>Migrate Library</h2>
        <button class="btn secondary" id="migrateBtnClose">&#x2715;</button>
      </div>
      <div class="settings-body"></div>
    </div>`;

  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.getElementById('migrateBtnClose').onclick = () => modal.remove();

  _migrateShowDataToggleStep(modal, () => {
    const body = modal.querySelector('.settings-body');
    body.innerHTML = `
      <p style="margin-bottom:1rem;color:var(--text-muted);font-size:0.88rem">
        Select a source to see its manga, then pick which ones to migrate to another source.
      </p>
      <div id="migrateSourceRows" style="display:flex;flex-direction:column;gap:2px">${rows}</div>`;

    modal.querySelectorAll('.migrate-source-row').forEach(row => {
      row.onmouseenter = () => {
        row.style.background = 'color-mix(in srgb, var(--primary) 7%, transparent)';
        row.style.borderColor = 'color-mix(in srgb, var(--primary) 22%, transparent)';
        const chevron = row.querySelector('.migrate-source-chevron');
        if (chevron) chevron.style.transform = 'translateX(3px)';
      };
      row.onmouseleave = () => {
        row.style.background = '';
        row.style.borderColor = 'transparent';
        const chevron = row.querySelector('.migrate-source-chevron');
        if (chevron) chevron.style.transform = '';
      };
      row.onclick = () => {
        _migrateFromSourceId = row.dataset.sourceId;
        _migrateSelectedMangas = [];
        _migrateShowStep2(modal, groups.find(g => g.sourceId === _migrateFromSourceId));
      };
    });
  });
}

// ── Step 2 — Manga picker ─────────────────────────────────────────────────────

function _migrateShowStep2(modal, group) {
  const { sourceId, mangas } = group;

  const rows = mangas.map(m => {
    const currentSource = _normSourceId(m.sourceId || sourceId);
    const key    = _migrateStatusKey(m.id, currentSource);
    const status = state.readingStatus[key]?.status;
    const badge  = status ? `<span class="status-badge status-badge-${status}" style="font-size:0.7rem;padding:2px 6px">${statusLabel(status)}</span>` : '';
    return `
      <label class="migrate-manga-row" data-manga-id="${escapeHtml(m.id)}" data-source-id="${escapeHtml(currentSource)}" style="display:flex;align-items:center;gap:0.9rem;padding:0.65rem 0.75rem;border-radius:10px;cursor:pointer;transition:background-color .15s ease">
        <input type="checkbox" class="migrate-manga-chk migrate-chk" value="${escapeHtml(m.id)}">
        ${m.cover ? `<img src="${escapeHtml(normalizeImageUrl(m.cover))}" style="width:56px;height:76px;object-fit:cover;border-radius:7px;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : `<div style="width:56px;height:76px;background:color-mix(in srgb, var(--primary) 12%, transparent);border-radius:7px;flex-shrink:0"></div>`}
        <div style="flex:1;min-width:0">
          <div style="font-size:1.05rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(m.title || m.id)}</div>
          ${badge}
        </div>
      </label>`;
  }).join('');

  modal.querySelector('.settings-content').innerHTML = `
    <div class="settings-header">
      <div style="display:flex;align-items:center;gap:0.6rem">
        <button class="btn secondary" id="migrateBtnBack" style="padding:4px 10px;font-size:0.8rem">← Back</button>
        <h2 style="font-size:1.2rem">${escapeHtml(_srcName(sourceId))} — pick manga</h2>
      </div>
      <button class="btn secondary" id="migrateBtnClose2">&#x2715;</button>
    </div>
    <div class="settings-body" style="padding-bottom:0">
      <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.75rem">
        <label style="font-size:0.92rem;display:flex;align-items:center;gap:0.55rem;cursor:pointer;font-weight:500">
          <input type="checkbox" id="migrateSelectAll" class="migrate-chk"> Select all
        </label>
        <span id="migrateSelCount" style="font-size:0.88rem;color:var(--text-muted)">0 selected</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:0.75rem;padding:0.55rem 0.8rem;border-radius:10px;background:color-mix(in srgb, var(--primary) 6%, transparent);border:1px solid color-mix(in srgb, var(--primary) 16%, transparent)">
        <label class="toggle-label" style="gap:0.7rem">
          <span class="toggle-text" style="font-size:0.85rem">Hide up-to-date manga — checks each one live against ${escapeHtml(_srcName(sourceId))} and hides any that already have every chapter, so comparing sources only runs on the rest</span>
          <input type="checkbox" id="migrateHideUpToDateToggle">
          <span class="toggle-slider"></span>
        </label>
        <span id="migrateHideUpToDateStatus" style="font-size:0.78rem;color:var(--text-muted);white-space:nowrap"></span>
      </div>
      <div id="migrateMangaList" style="max-height:74vh;overflow-y:auto;display:flex;flex-direction:column;gap:4px;padding-right:4px">${rows}</div>
    </div>
    <div style="padding:0.75rem 1.2rem;border-top:1px solid color-mix(in srgb, var(--primary) 15%, transparent);display:flex;justify-content:flex-end">
      <button class="btn primary" id="migrateBtnNext" disabled>Next →</button>
    </div>`;

  document.getElementById('migrateBtnClose2').onclick = () => modal.remove();
  document.getElementById('migrateBtnBack').onclick   = () => { showMigrateModal(); modal.remove(); };

  // Rows hidden by the "Hide up-to-date manga" toggle below are excluded
  // from both the count and "Select all" — otherwise "Select all" would
  // silently sweep up manga the user can't even see.
  const _visibleMangaChks = () => [...modal.querySelectorAll('.migrate-manga-chk')]
    .filter(chk => chk.closest('.migrate-manga-row')?.style.display !== 'none');

  const updateCount = () => {
    const visible = _visibleMangaChks();
    const n = visible.filter(chk => chk.checked).length;
    document.getElementById('migrateSelCount').textContent = `${n} selected`;
    document.getElementById('migrateBtnNext').disabled = n === 0;
    document.getElementById('migrateSelectAll').indeterminate = n > 0 && n < visible.length;
    document.getElementById('migrateSelectAll').checked = n === visible.length && visible.length > 0;
  };

  document.getElementById('migrateSelectAll').onchange = (e) => {
    _visibleMangaChks().forEach(chk => { chk.checked = e.target.checked; });
    updateCount();
  };

  modal.querySelectorAll('.migrate-manga-chk').forEach(chk => { chk.onchange = updateCount; });

  // "Hide up-to-date manga" — per manga, compares the chapter count we
  // already have on file (fav.lastKnownChapterCount, the same field the
  // Updates feed keeps fresh via its own periodic sweep and the per-manga
  // "Refresh" button — far more consistently populated across the library
  // than the localStorage-only chapterCountCache, which only ever gets a
  // manga once its details page has actually been opened) against a fresh
  // chapters() call to its OWN current source (not every installed source —
  // that full cross-source comparison is exactly what Step 3 does next, and
  // is the expensive part this toggle exists to let you skip for manga that
  // don't need it). A manga only counts as "up to date" when both numbers
  // are known and the live count isn't ahead of the local one — no local
  // count on file, or a failed/unreachable live check, leaves it visible
  // rather than guessing, since hiding a manga we actually know nothing
  // about would defeat the point of a review step.
  const upToDateCache = new Map(); // mangaId -> boolean

  const applyHideUpToDateVisibility = () => {
    const hideOn = document.getElementById('migrateHideUpToDateToggle').checked;
    modal.querySelectorAll('.migrate-manga-row').forEach(row => {
      const mid = row.dataset.mangaId;
      const hide = hideOn && upToDateCache.get(mid) === true;
      row.style.display = hide ? 'none' : '';
      if (hide) {
        const chk = row.querySelector('.migrate-manga-chk');
        if (chk?.checked) chk.checked = false;
      }
    });
    updateCount();
  };

  document.getElementById('migrateHideUpToDateToggle').onchange = async (e) => {
    const statusEl = document.getElementById('migrateHideUpToDateStatus');
    if (!e.target.checked) {
      applyHideUpToDateVisibility();
      if (statusEl) statusEl.textContent = '';
      return;
    }

    e.target.disabled = true;
    const toCheck = mangas.filter(m => !upToDateCache.has(m.id));
    let done = 0;
    const setStatus = () => {
      if (statusEl) statusEl.textContent = toCheck.length ? `Checking… ${done}/${toCheck.length}` : '';
    };
    setStatus();

    const CONCURRENCY = 5;
    let idx = 0;
    async function worker() {
      while (idx < toCheck.length) {
        const m = toCheck[idx++];
        const sid = _normSourceId(m.sourceId || sourceId);
        const localCount = Number(m.lastKnownChapterCount) || Number(state.chapterCountCache?.[m.id]) || 0;
        let isUpToDate = false;
        if (localCount > 0) {
          const liveCount = await _sourceChaptersCount(sid, m.id);
          if (liveCount !== null && liveCount <= localCount) isUpToDate = true;
        }
        upToDateCache.set(m.id, isUpToDate);
        done++;
        setStatus();
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toCheck.length) }, worker));

    e.target.disabled = false;
    applyHideUpToDateVisibility();
    const hiddenCount = [...upToDateCache.values()].filter(Boolean).length;
    if (statusEl) statusEl.textContent = hiddenCount ? `${hiddenCount} up to date, hidden` : 'None up to date yet';
  };

  // Row hover
  modal.querySelectorAll('.migrate-manga-row').forEach(row => {
    row.onmouseenter = () => row.style.background = 'color-mix(in srgb, var(--primary) 7%, transparent)';
    row.onmouseleave = () => row.style.background = '';
  });

  document.getElementById('migrateBtnNext').onclick = () => {
    _migrateSelectedMangas = [];
    modal.querySelectorAll('.migrate-manga-chk:checked').forEach(chk => {
      const row = chk.closest('.migrate-manga-row');
      const mid = row.dataset.mangaId;
      const sid = _normSourceId(row.dataset.sourceId);
      const fav = state.favorites.find(f => f.id === mid && _normSourceId(f.sourceId) === sid);
      if (fav) _migrateSelectedMangas.push(fav);
    });
    if (!_migrateSelectedMangas.length) {
      showToast('Migration', 'No valid manga selected. Try selecting again.', 'warning');
      return;
    }
    _migrateShowStep3(modal);
  };
}

// ── Step 3 — Source comparison + confirm ──────────────────────────────────────

async function _migrateShowStep3(modal) {
  // Fresh circuit-breaker state per run — a source down 10 minutes ago in
  // an earlier comparison shouldn't stay silently skipped forever once
  // it's back.
  _migrateSourceMissStreak.clear();
  _migrateAniListVariantCache.clear();

  // Get installed source IDs (exclude the from-source, 'local', and any
  // source excluded from migration entirely — see MIGRATE_EXCLUDED_SOURCES)
  let stateData;
  try { stateData = await api('/api/state'); } catch (_) {}
  const allSources = Object.keys(stateData?.installedSources || {})
    // The from-source itself is always kept regardless of visibility — it
    // still needs its own "current source" pill (unselectable, just for
    // comparison) even if the user has hidden it from Discover/Library.
    .filter(sid => sid !== 'local' && !MIGRATE_EXCLUDED_SOURCES.has(sid) && (sid === _migrateFromSourceId || _migrateVisibleSourceFilter(sid)));
  const targetSources = allSources.filter(sid => sid !== _migrateFromSourceId);

  if (targetSources.length === 0) {
    modal.querySelector('.settings-content').innerHTML = `
      <div class="settings-header">
        <div style="display:flex;align-items:center;gap:0.6rem">
          <button class="btn secondary" id="migrateBtnBackNoSources" style="padding:4px 10px;font-size:0.8rem">← Back</button>
          <h2 style="font-size:1.2rem">Choose target source</h2>
        </div>
        <button class="btn secondary" id="migrateBtnCloseNoSources">&#x2715;</button>
      </div>
      <div class="settings-body" style="padding:2rem 1.2rem">
        <div style="border:1px solid color-mix(in srgb, var(--primary) 20%, transparent);background:color-mix(in srgb, var(--primary) 8%, transparent);padding:1rem;border-radius:10px;color:var(--text-muted)">
          No target sources available. Install at least one source different from <strong>${escapeHtml(_srcName(_migrateFromSourceId))}</strong>.
        </div>
      </div>`;

    document.getElementById('migrateBtnCloseNoSources').onclick = () => modal.remove();
    document.getElementById('migrateBtnBackNoSources').onclick = () => {
      const groups = _migrateGroupBySource();
      const group  = groups.find(g => g.sourceId === _migrateFromSourceId);
      if (group) _migrateShowStep2(modal, group);
    };
    return;
  }

  _migrateShowStep3Table(modal, allSources, targetSources);
}

// ── Shared comparison engine ────────────────────────────────────────────────
// Everything below is used by both the per-source-group Step 3 table above
// and the library-wide "Migrate All" scan further down — they differ only in
// which manga list gets scanned and what happens with each finished row, not
// in how a row is rendered or how the cross-source search itself works.

// One source pill for a manga row — reused for the initial render and to
// patch in a single pill after a manual search finds a match (see
// _migrateManualSearchModal below), so both paths render identically.
function _migrateBuildPill(rowKey, sid, manga, info, maxCount) {
  const count = info?.chapCount ?? null;
  const isBest = count !== null && count === maxCount && maxCount >= 0;
  const isCurrent = sid === manga.sourceId;
  const label = count !== null ? String(count) : '—';
  const crown = isBest && !isCurrent ? ' *' : '';

  let borderColor = 'color-mix(in srgb, var(--primary) 14%, transparent)';
  let countColor = 'var(--text-muted)';
  if (isBest)    { borderColor = '#7cfc88'; countColor = '#7cfc88'; }
  else if (isCurrent) { borderColor = 'var(--primary)'; countColor = 'var(--primary)'; }

  const pillBaseStyle = `display:flex;flex-direction:column;align-items:center;gap:0.2rem;min-width:78px;padding:0.35rem 0.55rem;border-radius:8px;border:1px solid ${borderColor};background:${isCurrent ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'color-mix(in srgb, var(--bg-tertiary) 85%, transparent)'}`;
  const nameHtml = `<span style="font-size:0.65rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.02em;white-space:nowrap;max-width:110px;overflow:hidden;text-overflow:ellipsis">${escapeHtml(_srcName(sid))}</span>`;
  const countHtml = `<span style="font-size:0.9rem;font-variant-numeric:tabular-nums;font-weight:700;color:${countColor}">${label}${crown}</span>`;

  if (isCurrent) {
    return `<div style="${pillBaseStyle}" title="Current source">${nameHtml}${countHtml}</div>`;
  }

  if (!info?.mangaId) {
    // No automatic match — clickable instead of a dead end, mirrors
    // Komikku's "search manually if the automatic match is missing or
    // wrong" fallback. Dashed border marks it as an action, not a result.
    return `<button type="button" class="migrate-manual-search-btn" data-row-key="${escapeHtml(rowKey)}" data-target-source="${escapeHtml(sid)}" style="${pillBaseStyle};border-style:dashed;cursor:pointer" title="Search manually on ${escapeHtml(_srcName(sid))}">${nameHtml}<span style="font-size:0.72rem;color:var(--primary)">Search…</span></button>`;
  }

  let selectHtml = '';
  if (info.allCandidates && info.allCandidates.length > 1) {
    const options = info.allCandidates.map((c, i) =>
      `<option value="${escapeHtml(c.mangaId)}" ${i === 0 ? 'selected' : ''}>${escapeHtml(c.title)} (${c.chapCount !== null ? c.chapCount : '?'} ch)</option>`
    ).join('');
    selectHtml = `<select class="migrate-candidate-select" data-row-key="${escapeHtml(rowKey)}" data-target-source="${escapeHtml(sid)}" style="width:100%;max-width:110px;font-size:0.65rem;padding:1px;margin-top:2px;background:var(--bg-input);color:var(--text);border:1px solid color-mix(in srgb, var(--primary) 30%, transparent);border-radius:4px">${options}</select>`;
  }

  return `<label style="${pillBaseStyle};cursor:pointer">
    <input type="checkbox" class="migrate-target-chk migrate-chk" data-row-key="${escapeHtml(rowKey)}" data-target-source="${escapeHtml(sid)}" style="margin:0">
    ${nameHtml}
    ${countHtml}
    ${selectHtml}
  </label>`;
}

function _migrateBuildRowPillsHtml(manga, sourceResults, allSources) {
  const rowKey = `${manga.id}::${_normSourceId(manga.sourceId)}`;
  const counts = allSources.map(sid => sourceResults[sid]?.chapCount ?? -1);
  const maxCount = Math.max(...counts);
  return allSources.map(sid => _migrateBuildPill(rowKey, sid, manga, sourceResults[sid], maxCount)).join('');
}

// Does a genuinely better source exist for this manga than its current one?
// Returns the best alternative sourceId, or null if the current source (or
// "no known current source" — an 'unknown'/local-import favorite has none to
// compare against, so anything found counts) is already at least as good as
// anything else installed.
function _migrateRowHasUpgrade(manga, sourceResults, allSources) {
  const currentSid = manga.sourceId || null;
  const currentCount = currentSid ? (sourceResults[currentSid]?.chapCount ?? null) : null;
  let bestOtherSid = null;
  let bestOtherCount = -1;
  for (const sid of allSources) {
    if (sid === currentSid) continue;
    const c = sourceResults[sid]?.chapCount;
    if (c === null || c === undefined) continue;
    if (c > bestOtherCount) { bestOtherCount = c; bestOtherSid = sid; }
  }
  if (!bestOtherSid) return null;
  if (currentCount !== null && bestOtherCount <= currentCount) return null;
  return bestOtherSid;
}

// Runs the cross-source chapter-count comparison over `mangaList` against
// every source in `allSources`, streaming one manga's result at a time
// (onMangaDone, fired once every source has reported for that manga) and
// ticking per-source progress as each individual source request settles
// (onSourceTick, optional).
//
// One independent pool PER SOURCE, each working through the whole manga
// list at its own pace — NOT one worker per manga firing all sources at
// once via Promise.all, which is what this used to be. That first design
// had a real bug, confirmed live on a real 252-manga/15-source run: every
// source's progress counter landed on the exact same number throughout the
// whole scan. The root cause was structural — a manga-parallel worker can't
// start manga N+1 in its slot until ALL 15 sources finish manga N, so a
// fast source doesn't get to run ahead of a slow one; every source ends up
// paced by whichever one is currently slowest. Per-source pools have no
// such coupling.
//
// Each source's own pool runs `sourceConcurrency` requests at once (not a
// single strictly-sequential walker) for a second reason found in the SAME
// live run, after fixing the first bug: since a manga's row only resolves
// once every source has reported for it, and each source works through the
// list in order, the overall completion rate ends up bounded by whichever
// ONE source is slowest across its entire walk — with sourceConcurrency: 1
// that measured at ~44 minutes estimated for 252 manga, because nothing
// else can make up for one persistently slow (not necessarily broken, just
// high-latency) source. A small pool per source (3 in flight, not 1) lets a
// latency-bound source make several times more headway per unit of wall
// time, which directly shrinks how long the whole scan's bottleneck source
// takes — this is not just cosmetic, it's the actual fix for the "why is
// this taking 44 minutes" complaint, not merely the "why do all the bars
// match" one.
async function _migrateCompareAcrossSources(mangaList, allSources, { onMangaDone, onSourceTick, missLimit, isCancelled, sourceConcurrency = 3 } = {}) {
  const total = mangaList.length;
  const accumulators = mangaList.map(() => ({ sourceResults: {}, reported: 0 }));
  // One AniList lookup per manga (cached, not per source — see
  // _fetchAniListTitleVariants), shared across every source's pool instead
  // of each one fetching it independently — the synchronous check-then-set
  // below (no `await` in between) is safe from duplicate fetches even
  // though many pools reach a given manga at roughly the same moment.
  const extraTitlesCache = new Map();
  const getExtraTitles = (idx, manga) => {
    if (!extraTitlesCache.has(idx)) extraTitlesCache.set(idx, _fetchAniListTitleVariants(manga.title));
    return extraTitlesCache.get(idx);
  };

  let doneManga = 0;
  // Scan-scoped, not module-global — only one scan ever runs at a time, so
  // this just needs to cap the requests THIS run fires, not survive across
  // separate scans. Only wraps the actual per-source network calls below,
  // not getExtraTitles' AniList lookup just above (a separate, already
  // request-deduped, already-throttled-elsewhere concern — see that
  // function's own comment).
  const globalSem = _migrateCreateSemaphore(MIGRATE_GLOBAL_CONCURRENCY);

  async function checkOne(sid, idx) {
    const manga = mangaList[idx];
    const extraTitles = await getExtraTitles(idx, manga);
    let result = null;
    await globalSem.acquire();
    try {
      const bySearch = await _chapCount(sid, manga.title, extraTitles, missLimit);
      if (bySearch) {
        result = bySearch;
      } else if (sid === manga.sourceId && manga.id) {
        // Fallback: if this is the current source and we already have a
        // manga ID, ask chapters directly so current source is never
        // blank when reachable.
        const directCount = await _sourceChaptersCount(sid, manga.id);
        if (directCount !== null) {
          result = { chapCount: directCount, mangaId: manga.id, cover: manga.cover, title: manga.title };
        }
      }
    } catch (_) {
      // result stays null — one bad request never stops this source's pool.
    } finally {
      globalSem.release();
    }

    const acc = accumulators[idx];
    acc.sourceResults[sid] = result;
    acc.reported++;
    onSourceTick?.(sid);

    if (acc.reported === allSources.length) {
      doneManga++;
      onMangaDone?.({ manga, sourceResults: acc.sourceResults }, doneManga, total);
    }
  }

  // `isCancelled` is checked before starting each NEW request, not used to
  // abort ones already in flight — those still finish naturally (bounded by
  // their own 5s timeout, MIGRATE_SOURCE_TIMEOUT_MS), so the whole scan
  // winds down within a few seconds of cancelling instead of hanging.
  async function sourcePool(sid) {
    let nextIdx = 0;
    async function poolWorker() {
      while (nextIdx < mangaList.length) {
        if (isCancelled?.()) return;
        const idx = nextIdx++;
        await checkOne(sid, idx);
      }
    }
    await Promise.all(Array.from({ length: Math.min(sourceConcurrency, mangaList.length) }, poolWorker));
  }

  await Promise.all(allSources.map(sourcePool));
}

// Renders the comparison table shell immediately (empty) and streams rows in
// one manga at a time as each one's own cross-source comparison finishes,
// instead of the old sequential-batches-of-5 loop that held the whole UI on
// a loading screen until an entire group of 5 was done. A rolling worker
// pool keeps the same peak concurrency (5 manga compared at once) but a fast
// manga's row lands as soon as it's ready rather than waiting on its
// group-mates — the small corner counter is the only "is it done yet"
// signal now that there's no full-screen progress bar blocking the view.
function _migrateShowStep3Table(modal, allSources, targetSources) {
  const rowKeyFor = (manga) => `${manga.id}::${_normSourceId(manga.sourceId)}`;
  const total = _migrateSelectedMangas.length;

  // Card-per-manga layout: source results are pills that WRAP onto new
  // lines instead of fixed table columns, so an install with a lot of
  // sources (columns used to just keep extending the table sideways,
  // e.g. 11 sources ≈ 1900px+, forcing horizontal scroll even inside the
  // modal's own generous max-width) grows vertically per row instead —
  // never wider than the viewport, no horizontal scrollbar. Same
  // information and interactions as the table version (checkbox + count +
  // candidate dropdown per source, best/current highlighting), just
  // reflowed.
  modal.querySelector('.settings-content').innerHTML = `
    <style>
      /* A manga row the "Auto-select upgrades" toggle picked out — a real
         better-source match found, not just visually similar to the
         individual best-count pill's green so the two read as related. */
      .migrate-cmp-row.migrate-row-upgrade {
        background: color-mix(in srgb, #7cfc88 8%, transparent);
        border-left: 3px solid #7cfc88;
      }
    </style>
    <div class="settings-header">
      <div style="display:flex;align-items:center;gap:0.6rem">
        <button class="btn secondary" id="migrateBtnBack3" style="padding:4px 10px;font-size:0.8rem">← Back</button>
        <h2 style="font-size:1.2rem">Choose target source</h2>
      </div>
      <div style="display:flex;align-items:center;gap:0.75rem">
        <span id="migrateCompareCorner" style="font-size:0.78rem;color:var(--text-muted);white-space:nowrap">Comparing… 0/${total}</span>
        <button class="btn secondary" id="migrateBtnClose4">&#x2715;</button>
      </div>
    </div>
    <div class="settings-body" style="padding-bottom:0">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;margin-bottom:0.6rem;padding:0.6rem 0.8rem;border-radius:10px;background:color-mix(in srgb, var(--primary) 6%, transparent);border:1px solid color-mix(in srgb, var(--primary) 16%, transparent)">
        <label class="toggle-label" style="gap:0.7rem">
          <span class="toggle-text" style="font-size:0.88rem">Auto-select upgrades — picks the best source for manga that have more chapters elsewhere, leaves the rest untouched</span>
          <input type="checkbox" id="migrateAutoSelectToggle">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p style="font-size:0.88rem;color:var(--text-muted);margin-bottom:0.75rem">
        Chapter counts show the top search result per source.
        <span style="color:#7cfc88">Green / *</span> = most chapters.
        Current source is <span style="color:var(--primary);font-weight:600">highlighted</span>. Only one checkbox per manga row.
        Rows appear as each manga finishes comparing — no need to wait for all of them.
      </p>
      <div id="migrateCmpRows" style="min-height:45vh;max-height:78vh;overflow-y:auto;border:1px solid color-mix(in srgb, var(--primary) 16%, transparent);border-radius:10px">
        <p id="migrateCmpEmptyHint" class="muted" style="text-align:center;margin:2rem 0">Comparing sources…</p>
      </div>
    </div>
    <div style="padding:0.75rem 1.2rem;border-top:1px solid color-mix(in srgb, var(--primary) 15%, transparent);display:flex;justify-content:space-between;align-items:center">
      <span id="migrateChoiceCount" style="font-size:0.9rem;color:var(--text-muted)">0 manga with target selected</span>
      <button class="btn primary" id="migrateBtnConfirm" disabled>Migrate Selected</button>
    </div>`;

  const contentEl = modal.querySelector('.settings-content');
  if (contentEl) {
    contentEl.style.width = 'min(98vw, 1200px)';
    contentEl.style.maxWidth = '1200px';
    contentEl.style.maxHeight = '96vh';
  }

  document.getElementById('migrateBtnClose4').onclick = () => modal.remove();
  document.getElementById('migrateBtnBack3').onclick = () => {
    const groups = _migrateGroupBySource();
    const group  = groups.find(g => g.sourceId === _migrateFromSourceId);
    _migrateShowStep2(modal, group);
  };

  const rowsContainer = document.getElementById('migrateCmpRows');
  const cornerEl = document.getElementById('migrateCompareCorner');
  const results = []; // populated incrementally as each manga's comparison lands
  const resultsByRowKey = new Map();

  const selectedTargets = new Map(); // rowKey -> sourceId
  const updateChoiceCount = () => {
    const n = selectedTargets.size;
    const countEl = document.getElementById('migrateChoiceCount');
    if (countEl) countEl.textContent = `${n} manga with target selected`;
    const btn = document.getElementById('migrateBtnConfirm');
    if (btn) btn.disabled = n === 0;
  };

  // "Auto-select upgrades" toggle — sweeps every row for a genuine upgrade
  // (some OTHER source has strictly more chapters than wherever this manga
  // currently lives, or it has no current source at all) and pre-selects
  // the best one, with a green highlight so it's obvious at a glance which
  // rows the toggle touched. Manga that are already on their best source
  // (nothing beats the current count) are left completely alone — no
  // selection, no highlight — exactly like the "Integrity Check: All Good"
  // panel elsewhere in the app only shows its green state for the one item
  // you're actually looking at, not swept into a bulk view.
  let autoSelectOn = false;

  const applyAutoSelectToRow = (rowEl, manga, sourceResults) => {
    if (!rowEl) return;
    const rowKey = rowKeyFor(manga);
    const upgradeSid = _migrateRowHasUpgrade(manga, sourceResults, allSources);
    rowEl.classList.toggle('migrate-row-upgrade', !!upgradeSid);
    if (!upgradeSid) return;
    const chk = rowEl.querySelector(`.migrate-target-chk[data-target-source="${CSS.escape(upgradeSid)}"]`);
    if (chk && !chk.checked) {
      chk.checked = true;
      chk.onchange();
    }
  };

  document.getElementById('migrateAutoSelectToggle').onchange = (e) => {
    autoSelectOn = e.target.checked;
    if (autoSelectOn) {
      for (const { manga, sourceResults } of results) {
        const rowKey = rowKeyFor(manga);
        const rowEl = modal.querySelector(`.migrate-cmp-row[data-row-key="${CSS.escape(rowKey)}"]`);
        applyAutoSelectToRow(rowEl, manga, sourceResults);
      }
    } else {
      modal.querySelectorAll('.migrate-target-chk:checked').forEach(chk => { chk.checked = false; });
      modal.querySelectorAll('.migrate-row-upgrade').forEach(row => row.classList.remove('migrate-row-upgrade'));
      selectedTargets.clear();
      updateChoiceCount();
    }
  };

  const wireCheckbox = (chk) => {
    chk.onchange = () => {
      const rowKey = chk.dataset.rowKey;
      const sid = chk.dataset.targetSource;
      if (!rowKey || !sid) return;

      if (chk.checked) {
        modal.querySelectorAll('.migrate-target-chk').forEach(other => {
          if (other.dataset.rowKey !== rowKey) return;
          if (other !== chk) other.checked = false;
        });
        selectedTargets.set(rowKey, sid);
      } else if (selectedTargets.get(rowKey) === sid) {
        selectedTargets.delete(rowKey);
      }

      updateChoiceCount();
    };
  };

  // Manual search (see _migrateManualSearchModal) — picking a result there
  // patches just this one pill in place: rebuilds that manga row's pills
  // (best/current highlighting can shift once a new count arrives) and
  // rewires only that row's own checkboxes/buttons, so every other row's
  // selection state and the rest of the table are untouched.
  const wireManualSearchButtons = (scopeEl) => {
    (scopeEl || modal).querySelectorAll('.migrate-manual-search-btn').forEach(btn => {
      btn.onclick = () => {
        const rowKey = btn.dataset.rowKey;
        const sid = btn.dataset.targetSource;
        const entry = resultsByRowKey.get(rowKey);
        if (!entry) return;
        _migrateManualSearchModal(sid, entry.manga.title, async (picked) => {
          let chapCount = Number.isFinite(Number(picked.lastChapter)) ? Number(picked.lastChapter) : null;
          if (chapCount === null) chapCount = await _sourceChaptersCount(sid, picked.id);
          entry.sourceResults[sid] = {
            chapCount,
            mangaId: picked.id,
            cover: picked.cover,
            title: picked.title || entry.manga.title,
            allCandidates: [{ mangaId: picked.id, title: picked.title, chapCount }],
          };

          const rowEl = modal.querySelector(`.migrate-cmp-row[data-row-key="${CSS.escape(rowKey)}"]`);
          const pillsEl = rowEl?.querySelector('.migrate-cmp-pills');
          if (!pillsEl) return;
          pillsEl.innerHTML = _migrateBuildRowPillsHtml(entry.manga, entry.sourceResults, allSources);
          rowEl.querySelectorAll('.migrate-target-chk').forEach(wireCheckbox);
          wireManualSearchButtons(rowEl);
        });
      };
    });
  };

  // Appends one manga's row the moment its own comparison resolves — never
  // waits on any other manga still in flight.
  const appendRow = (entry) => {
    document.getElementById('migrateCmpEmptyHint')?.remove();
    const rowKey = rowKeyFor(entry.manga);
    resultsByRowKey.set(rowKey, entry);
    results.push(entry);

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="migrate-cmp-row" data-row-key="${escapeHtml(rowKey)}" style="display:flex;gap:0.9rem;padding:0.75rem;border-bottom:1px solid color-mix(in srgb, var(--primary) 8%, transparent)">
        <div style="display:flex;align-items:center;gap:0.6rem;width:190px;flex-shrink:0">
          ${entry.manga.cover ? `<img src="${escapeHtml(normalizeImageUrl(entry.manga.cover))}" style="width:40px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
          <span style="font-size:0.9rem;font-weight:600;overflow-wrap:anywhere">${escapeHtml(entry.manga.title || entry.manga.id)}</span>
        </div>
        <div class="migrate-cmp-pills" style="display:flex;flex-wrap:wrap;gap:0.5rem;flex:1;align-content:flex-start">${_migrateBuildRowPillsHtml(entry.manga, entry.sourceResults, allSources)}</div>
      </div>`;
    const rowEl = wrap.firstElementChild;
    rowsContainer.appendChild(rowEl);
    rowEl.querySelectorAll('.migrate-target-chk').forEach(wireCheckbox);
    wireManualSearchButtons(rowEl);
    // Rows stream in progressively (see the worker pool below) — a row that
    // lands after the toggle is already on needs the same sweep a row
    // present at toggle-time got, or it'd silently sit unselected.
    if (autoSelectOn) applyAutoSelectToRow(rowEl, entry.manga, entry.sourceResults);
  };

  document.getElementById('migrateBtnConfirm').onclick = async () => {
    await _migrateExecute(modal, results, selectedTargets, rowKeyFor);
  };

  // Cross-source comparison for every selected manga — see
  // _migrateCompareAcrossSources above (shared with the "Migrate All" scan
  // further down). A row only lands in the table if at least one TARGET
  // source (not the origin) found a match; the corner counter updates the
  // instant each manga finishes, not when its whole worker-pool batch does.
  (async () => {
    let done = 0;
    const setCorner = () => {
      if (!cornerEl) return;
      cornerEl.textContent = done < total ? `Comparing… ${done}/${total}` : `Done — ${total}/${total} compared`;
    };
    setCorner();

    await _migrateCompareAcrossSources(_migrateSelectedMangas, allSources, {
      onMangaDone: ({ manga, sourceResults }) => {
        if (targetSources.some(sid => !!sourceResults[sid]?.mangaId)) {
          appendRow({ manga, sourceResults });
        }
        done++;
        setCorner();
      },
    });

    if (!results.length) {
      modal.querySelector('.settings-content').innerHTML = `
        <div class="settings-header">
          <div style="display:flex;align-items:center;gap:0.6rem">
            <button class="btn secondary" id="migrateBtnBackNone" style="padding:4px 10px;font-size:0.8rem">← Back</button>
            <h2 style="font-size:1.05rem">Choose target source</h2>
          </div>
          <button class="btn secondary" id="migrateBtnCloseNone">&#x2715;</button>
        </div>
        <div class="settings-body" style="padding:2rem 1.2rem">
          <div style="border:1px solid color-mix(in srgb, var(--primary) 20%, transparent);background:color-mix(in srgb, var(--primary) 8%, transparent);padding:1rem;border-radius:10px;color:var(--text-muted)">
            None of the selected manga has a valid match in installed target sources.
          </div>
        </div>`;
      document.getElementById('migrateBtnCloseNone').onclick = () => modal.remove();
      document.getElementById('migrateBtnBackNone').onclick = () => {
        const groups = _migrateGroupBySource();
        const group  = groups.find(g => g.sourceId === _migrateFromSourceId);
        if (group) _migrateShowStep2(modal, group);
      };
    }
  })();
}

// ── "Migrate All" — library-wide upgrade scan ───────────────────────────────
// A standalone entry point, separate from the per-source Steps 1-3 above —
// explicitly requested as a "run once (or again after installing a new
// source), not something to do regularly" operation, so it's fine for this
// to take a while: it live-checks EVERY favorite (excluding locally-imported
// files — there's no "better online source" concept for those, and
// MIGRATE_EXCLUDED_SOURCES for the same reason BatCave is excluded
// everywhere else in this file) against every OTHER installed source, using
// the exact same _migrateCompareAcrossSources engine Step 3 uses, and only
// ever surfaces a manga that has a genuine upgrade available — one already
// on its best source (per _migrateRowHasUpgrade) never appears in the list
// at all, so there's nothing to review for it.

function _migrateAllEligibleMangas() {
  return (state.favorites || []).filter(m => {
    const sid = _normSourceId(m.sourceId);
    return sid !== 'local' && !MIGRATE_EXCLUDED_SOURCES.has(sid);
  });
}

// Step 3 compares a small, already-picked group (typically 5-50 manga)
// against other sources — 3 consecutive misses there (MIGRATE_SOURCE_MISS_LIMIT,
// above) is a solid "this source is down right now" signal. At Migrate All's
// scale that same threshold misfires routinely: 3 unlucky genre-mismatched
// titles in a row on an otherwise perfectly working source is ordinary noise
// over a couple hundred manga, and once a source trips the limit it can
// never recover for the rest of the run — the very first line of _chapCount
// blocks every further attempt unconditionally, silently missing whatever
// real matches that source would have had for everything checked afterward.
// Confirmed live: a 252-manga run against 15 sources found only 7 genuine
// upgrades, an implausibly low number once this was suspected — scaling the
// limit with the run size is the actual fix, not just the per-source
// progress bars (see _migrateCompareAcrossSources's own comment for that
// one). Capped so a truly-dead source still gets cut off within a couple of
// minutes of wasted timeouts rather than paying the 5s cost for the entire
// run.
function _migrateAllMissLimit(total) {
  return Math.min(30, Math.max(MIGRATE_SOURCE_MISS_LIMIT, Math.ceil(total * 0.08)));
}

function _formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function showMigrateAllModal() {
  document.getElementById('migrateModal')?.remove();

  // Gate the whole (expensive) scan below behind the same "Data to migrate"
  // step the other two entry points show — via a small standalone modal
  // rather than restructuring the large scan/comparison flow beneath this
  // into a callback. Cancelling here (X or backdrop) skips the scan
  // entirely instead of starting it and cancelling partway through.
  const proceed = await new Promise((resolve) => {
    const gateModal = document.createElement('div');
    gateModal.id = 'migrateModal';
    gateModal.className = 'settings-modal';
    gateModal.innerHTML = `
      <div class="settings-content" style="width:min(96vw,520px);max-width:520px">
        <div class="settings-header">
          <h2>Migrate All — Library-wide check</h2>
          <button class="btn secondary" id="migrateAllGateClose">&#x2715;</button>
        </div>
        <div class="settings-body"></div>
      </div>`;
    document.body.appendChild(gateModal);
    const close = () => { gateModal.remove(); resolve(false); };
    gateModal.onclick = (e) => { if (e.target === gateModal) close(); };
    document.getElementById('migrateAllGateClose').onclick = close;
    _migrateShowDataToggleStep(gateModal, () => { gateModal.remove(); resolve(true); });
  });
  if (!proceed) return;

  const mangas = _migrateAllEligibleMangas();
  if (!mangas.length) {
    showToast('Migrate All', 'No manga in your library are eligible to check.', 'info');
    return;
  }

  let stateData;
  try { stateData = await api('/api/state'); } catch (_) {}
  const allSources = Object.keys(stateData?.installedSources || {})
    .filter(sid => sid !== 'local' && !MIGRATE_EXCLUDED_SOURCES.has(sid) && _migrateVisibleSourceFilter(sid));

  if (allSources.length < 2) {
    showToast('Migrate All', 'Install at least 2 sources to compare against each other.', 'info');
    return;
  }

  // Fresh circuit-breaker/cache state per run — same reasoning as Step 3's
  // own reset: a source down 10 minutes ago in an earlier run shouldn't stay
  // silently skipped forever once it's back.
  _migrateSourceMissStreak.clear();
  _migrateAniListVariantCache.clear();

  const modal = document.createElement('div');
  modal.id = 'migrateModal';
  modal.className = 'settings-modal';
  modal.innerHTML = `
    <div class="settings-content" style="width:min(98vw,1200px);max-width:1200px;max-height:96vh;overflow:auto;border:1px solid color-mix(in srgb, var(--primary) 25%, transparent);box-shadow:0 16px 50px rgba(0,0,0,0.55)">
      <div class="settings-header">
        <h2>Migrate All — Library-wide check</h2>
        <button class="btn secondary" id="migrateAllBtnClose">&#x2715;</button>
      </div>
      <div class="settings-body" style="padding-bottom:0">
        <p style="font-size:0.88rem;color:var(--text-muted);margin-bottom:0.75rem">
          Checking ${mangas.length} manga against ${allSources.length} installed sources. This is a one-off sweep of your whole library — only manga with a genuine upgrade available will show up below. Some sources go through a shared Cloudflare-bypass browser that can only handle one request at a time, so this can take a while; closing this window cancels the scan.
        </p>
        <div style="margin-bottom:0.75rem;padding:0.7rem 0.9rem;border-radius:10px;background:color-mix(in srgb, var(--primary) 6%, transparent);border:1px solid color-mix(in srgb, var(--primary) 16%, transparent)">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:1rem;margin-bottom:0.4rem">
            <span id="migrateAllOverallLabel" style="font-size:0.9rem;font-weight:600">Scanning… 0/${mangas.length} manga</span>
            <span id="migrateAllEta" style="font-size:0.82rem;color:var(--text-muted);white-space:nowrap">Estimating time…</span>
          </div>
          <div style="width:100%;height:8px;background:color-mix(in srgb, var(--primary) 15%, transparent);border-radius:99px;overflow:hidden">
            <div id="migrateAllOverallBar" style="height:100%;width:0%;background:linear-gradient(90deg, var(--primary), var(--primary-light));border-radius:99px;transition:width .3s ease"></div>
          </div>
        </div>
        <div id="migrateAllSourceRows" style="display:flex;flex-direction:column;gap:5px;margin-bottom:1rem"></div>
        <h3 style="font-size:0.95rem;margin:0 0 0.6rem" id="migrateAllCandidatesHeading">Manga with an upgrade available</h3>
        <div id="migrateAllCmpRows" style="min-height:30vh;max-height:50vh;overflow-y:auto;border:1px solid color-mix(in srgb, var(--primary) 16%, transparent);border-radius:10px">
          <p id="migrateAllEmptyHint" class="muted" style="text-align:center;margin:2rem 0">Scanning your library…</p>
        </div>
      </div>
      <div style="padding:0.75rem 1.2rem;border-top:1px solid color-mix(in srgb, var(--primary) 15%, transparent);display:flex;justify-content:space-between;align-items:center">
        <span id="migrateAllChoiceCount" style="font-size:0.9rem;color:var(--text-muted)">0 manga selected</span>
        <button class="btn primary" id="migrateAllBtnConfirm" disabled>Migrate Selected</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  let sourceProgressTimer = null; // started below, once sourceProgress/sourceRowsEl exist
  // Closing (X, backdrop click, or the browser tab going away) used to only
  // hide the modal — the scan itself kept running underneath with no way to
  // stop it, reported live: closing while ~44 minutes remained left it
  // running invisibly in the background with no cancel available at all.
  // `cancelled` is read by isCancelled below, checked before every new
  // request the scan starts (in-flight ones still finish naturally, capped
  // at their own 5s timeout) — closing now genuinely winds the scan down
  // within a few seconds instead of leaving it running forever.
  let cancelled = false;
  let scanDone = false;
  const closeAndCancel = () => {
    clearInterval(sourceProgressTimer);
    modal.remove();
    if (!scanDone && !cancelled) {
      cancelled = true;
      showToast('Migrate All', 'Scan cancelled.', 'info');
      // Both are only ever cleared at the *start* of the next run, not on
      // cancel — bounded by library size so not a leak, but no reason to
      // keep a cancelled scan's per-source miss-streak/title-variant state
      // around until the next one starts.
      _migrateSourceMissStreak.clear();
      _migrateAniListVariantCache.clear();
    }
  };
  modal.onclick = (e) => { if (e.target === modal) closeAndCancel(); };
  document.getElementById('migrateAllBtnClose').onclick = closeAndCancel;

  // Per-source progress rows — the one signal a single manga-level counter
  // can't give: WHICH source is dragging the whole run out. A source that's
  // genuinely down trips _chapCount's own per-run circuit breaker after a
  // few consecutive misses (MIGRATE_SOURCE_MISS_LIMIT, above) and starts
  // returning instantly, so its bar catches up fast rather than staying
  // stuck paying the full per-manga timeout for the rest of the run.
  const sourceRowsEl = document.getElementById('migrateAllSourceRows');
  const sourceProgress = new Map(allSources.map(sid => [sid, 0]));
  sourceRowsEl.innerHTML = allSources.map(sid => `
    <div style="display:flex;align-items:center;gap:0.6rem">
      <span style="font-size:0.78rem;color:var(--text-muted);width:130px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(_srcName(sid))}</span>
      <div style="flex:1;height:6px;background:color-mix(in srgb, var(--primary) 12%, transparent);border-radius:99px;overflow:hidden">
        <div class="migrate-all-source-bar" data-source-id="${escapeHtml(sid)}" style="height:100%;width:0%;background:color-mix(in srgb, var(--primary) 55%, var(--primary-light));border-radius:99px;transition:width .3s ease"></div>
      </div>
      <span class="migrate-all-source-count" data-source-id="${escapeHtml(sid)}" style="font-size:0.76rem;color:var(--text-muted);width:70px;text-align:right;flex-shrink:0">0/${mangas.length}</span>
    </div>`).join('');

  // Batched DOM writes on a plain interval, not requestAnimationFrame — this
  // is explicitly meant to be left running in the background (minimized
  // window, another tab focused) for what can be several minutes on a real
  // library, and rAF callbacks are throttled to a crawl or stop firing
  // entirely for a backgrounded/hidden tab in most browsers (confirmed
  // live: a 2-manga test run finished in 23s with every source bar still
  // frozen at its initial 0 - rAF never got a chance to paint). A plain
  // interval keeps running regardless of tab visibility. Real library
  // scale (255 favorites × ~13 sources in this project's own reference
  // install) means individual source ticks land in the thousands over the
  // run, so writing a bar's inline style on every single one would still be
  // wasted work — 250ms is frequent enough to feel live without that cost.
  const flushSourceProgress = () => {
    for (const [sid, doneCount] of sourceProgress) {
      const pct = mangas.length ? Math.min(100, (doneCount / mangas.length) * 100) : 0;
      const bar = sourceRowsEl.querySelector(`.migrate-all-source-bar[data-source-id="${CSS.escape(sid)}"]`);
      const countEl = sourceRowsEl.querySelector(`.migrate-all-source-count[data-source-id="${CSS.escape(sid)}"]`);
      if (bar) bar.style.width = `${pct}%`;
      if (countEl) countEl.textContent = `${doneCount}/${mangas.length}`;
    }
  };
  sourceProgressTimer = setInterval(flushSourceProgress, 250);
  const onSourceTick = (sid) => {
    sourceProgress.set(sid, (sourceProgress.get(sid) || 0) + 1);
  };

  const overallLabelEl = document.getElementById('migrateAllOverallLabel');
  const overallBarEl = document.getElementById('migrateAllOverallBar');
  const etaEl = document.getElementById('migrateAllEta');
  const startedAt = Date.now();
  // Simple elapsed/done*remaining estimate, recomputed on every manga — no
  // smoothing beyond that. It swings a bit early on (a handful of fast
  // early hits) but settles down within the first few dozen manga, which is
  // good enough for "roughly how much longer" rather than a precise ETA.
  const updateOverall = (doneManga, total) => {
    const pct = total ? Math.min(100, (doneManga / total) * 100) : 0;
    if (overallLabelEl) overallLabelEl.textContent = doneManga < total ? `Scanning… ${doneManga}/${total} manga` : `Done — ${total}/${total} manga checked`;
    if (overallBarEl) overallBarEl.style.width = `${pct}%`;
    if (etaEl) {
      if (doneManga === 0) {
        etaEl.textContent = 'Estimating time…';
      } else if (doneManga >= total) {
        etaEl.textContent = `Took ${_formatDuration(Date.now() - startedAt)}`;
      } else {
        const elapsed = Date.now() - startedAt;
        const rate = elapsed / doneManga;
        etaEl.textContent = `~${_formatDuration(rate * (total - doneManga))} remaining`;
      }
    }
  };

  const rowsContainer = document.getElementById('migrateAllCmpRows');
  const rowKeyFor = (manga) => `${manga.id}::${_normSourceId(manga.sourceId)}`;
  const results = [];
  const resultsByRowKey = new Map();
  const selectedTargets = new Map();

  const updateChoiceCount = () => {
    const n = selectedTargets.size;
    const countEl = document.getElementById('migrateAllChoiceCount');
    if (countEl) countEl.textContent = `${n} manga selected`;
    const btn = document.getElementById('migrateAllBtnConfirm');
    if (btn) btn.disabled = n === 0;
  };

  const wireCheckbox = (chk) => {
    chk.onchange = () => {
      const rowKey = chk.dataset.rowKey;
      const sid = chk.dataset.targetSource;
      if (!rowKey || !sid) return;
      if (chk.checked) {
        modal.querySelectorAll('.migrate-target-chk').forEach(other => {
          if (other.dataset.rowKey === rowKey && other !== chk) other.checked = false;
        });
        selectedTargets.set(rowKey, sid);
      } else if (selectedTargets.get(rowKey) === sid) {
        selectedTargets.delete(rowKey);
      }
      updateChoiceCount();
    };
  };

  const wireManualSearchButtons = (scopeEl) => {
    (scopeEl || modal).querySelectorAll('.migrate-manual-search-btn').forEach(btn => {
      btn.onclick = () => {
        const rowKey = btn.dataset.rowKey;
        const sid = btn.dataset.targetSource;
        const entry = resultsByRowKey.get(rowKey);
        if (!entry) return;
        _migrateManualSearchModal(sid, entry.manga.title, async (picked) => {
          let chapCount = Number.isFinite(Number(picked.lastChapter)) ? Number(picked.lastChapter) : null;
          if (chapCount === null) chapCount = await _sourceChaptersCount(sid, picked.id);
          entry.sourceResults[sid] = {
            chapCount, mangaId: picked.id, cover: picked.cover, title: picked.title || entry.manga.title,
            allCandidates: [{ mangaId: picked.id, title: picked.title, chapCount }],
          };
          const rowEl = modal.querySelector(`.migrate-cmp-row[data-row-key="${CSS.escape(rowKey)}"]`);
          const pillsEl = rowEl?.querySelector('.migrate-cmp-pills');
          if (!pillsEl) return;
          pillsEl.innerHTML = _migrateBuildRowPillsHtml(entry.manga, entry.sourceResults, allSources);
          rowEl.querySelectorAll('.migrate-target-chk').forEach(wireCheckbox);
          wireManualSearchButtons(rowEl);
        });
      };
    });
  };

  // Every row shown here already IS an upgrade — that's the whole point of
  // this view, unlike Step 3's "show everything, toggle auto-select" table —
  // so it's pre-selected immediately on arrival rather than making the user
  // re-click through what could be dozens of rows.
  const appendRow = (entry, upgradeSid) => {
    document.getElementById('migrateAllEmptyHint')?.remove();
    const rowKey = rowKeyFor(entry.manga);
    resultsByRowKey.set(rowKey, entry);
    results.push(entry);

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="migrate-cmp-row" data-row-key="${escapeHtml(rowKey)}" style="display:flex;gap:0.9rem;padding:0.75rem;border-bottom:1px solid color-mix(in srgb, var(--primary) 8%, transparent)">
        <div style="display:flex;align-items:center;gap:0.6rem;width:190px;flex-shrink:0">
          ${entry.manga.cover ? `<img src="${escapeHtml(normalizeImageUrl(entry.manga.cover))}" style="width:40px;height:56px;object-fit:cover;border-radius:6px;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
          <span style="font-size:0.9rem;font-weight:600;overflow-wrap:anywhere">${escapeHtml(entry.manga.title || entry.manga.id)}</span>
        </div>
        <div class="migrate-cmp-pills" style="display:flex;flex-wrap:wrap;gap:0.5rem;flex:1;align-content:flex-start">${_migrateBuildRowPillsHtml(entry.manga, entry.sourceResults, allSources)}</div>
      </div>`;
    const rowEl = wrap.firstElementChild;
    rowsContainer.appendChild(rowEl);
    rowEl.querySelectorAll('.migrate-target-chk').forEach(wireCheckbox);
    wireManualSearchButtons(rowEl);

    const chk = rowEl.querySelector(`.migrate-target-chk[data-target-source="${CSS.escape(upgradeSid)}"]`);
    if (chk) { chk.checked = true; chk.onchange(); }
  };

  document.getElementById('migrateAllBtnConfirm').onclick = async () => {
    await _migrateExecute(modal, results, selectedTargets, rowKeyFor, 'migrateAllBtnConfirm');
  };

  await _migrateCompareAcrossSources(mangas, allSources, {
    missLimit: _migrateAllMissLimit(mangas.length),
    isCancelled: () => cancelled,
    onSourceTick,
    onMangaDone: (entry, doneManga, total) => {
      if (cancelled) return; // modal's already gone — nothing left to update
      const upgradeSid = _migrateRowHasUpgrade(entry.manga, entry.sourceResults, allSources);
      if (upgradeSid) appendRow(entry, upgradeSid);
      updateOverall(doneManga, total);
    },
  });

  if (cancelled) return;
  scanDone = true;

  // Scan's done — stop the interval and paint the final counts directly
  // rather than waiting up to 250ms for the timer's next tick.
  clearInterval(sourceProgressTimer);
  flushSourceProgress();

  const heading = document.getElementById('migrateAllCandidatesHeading');
  if (heading) heading.textContent = `Manga with an upgrade available (${results.length})`;
  if (!results.length) {
    rowsContainer.innerHTML = `<p class="muted" style="text-align:center;margin:2rem 0">Everything in your library is already on its best available source. Nothing to migrate.</p>`;
  }
}

// Small search dialog for one specific source — the fallback for when
// _chapCount's automatic multi-query search comes up empty. Same idea
// Komikku's migration guide describes ("if a series is not found, or is
// wrong, you can manually search it"), scoped here to the one source pill
// that was clicked rather than the whole row.
function _migrateManualSearchModal(sourceId, initialQuery, onPick) {
  document.querySelector('.migrate-manual-search-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'settings-modal migrate-manual-search-modal';
  modal.style.zIndex = '10001';
  modal.innerHTML = `
    <div class="settings-content" style="width:min(94vw,560px);max-width:560px;max-height:82vh;overflow:auto">
      <div class="settings-header">
        <h3 style="font-size:1rem;margin:0">Search on ${escapeHtml(_srcName(sourceId))}</h3>
        <button class="btn secondary" id="migrateManualClose">&#x2715;</button>
      </div>
      <div class="settings-body">
        <div style="display:flex;gap:0.5rem;margin-bottom:0.75rem">
          <input type="text" id="migrateManualQuery" class="input" value="${escapeHtml(initialQuery)}" style="flex:1">
          <button class="btn primary" id="migrateManualSearchBtn">Search</button>
        </div>
        <div id="migrateManualResults" style="display:flex;flex-direction:column;gap:0.4rem;min-height:120px"></div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.getElementById('migrateManualClose').onclick = () => modal.remove();

  const resultsEl = document.getElementById('migrateManualResults');
  const queryInput = document.getElementById('migrateManualQuery');

  const runSearch = async () => {
    const q = queryInput.value.trim();
    if (!q) return;
    resultsEl.innerHTML = '<p class="muted" style="text-align:center;margin:1rem 0">Searching…</p>';
    try {
      const r = await _sourceSearch(sourceId, q);
      const items = (r?.results || []).slice(0, 20).filter(c => c?.id);
      if (!items.length) {
        resultsEl.innerHTML = '<p class="muted" style="text-align:center;margin:1rem 0">No results.</p>';
        return;
      }
      resultsEl.innerHTML = items.map((c, i) => `
        <button type="button" class="migrate-manual-result" data-idx="${i}" style="display:flex;align-items:center;gap:0.8rem;text-align:left;padding:0.5rem;border-radius:8px;border:1px solid color-mix(in srgb, var(--primary) 15%, transparent);background:transparent;color:var(--text);cursor:pointer">
          ${c.cover ? `<img src="${escapeHtml(normalizeImageUrl(c.cover))}" style="width:52px;height:72px;object-fit:cover;border-radius:5px;flex-shrink:0" loading="lazy" onerror="this.style.display='none'">` : ''}
          <span style="font-size:0.92rem">${escapeHtml(c.title || c.id)}</span>
        </button>`).join('');
      resultsEl.querySelectorAll('.migrate-manual-result').forEach(btn => {
        btn.onclick = () => {
          const item = items[Number(btn.dataset.idx)];
          modal.remove();
          onPick(item);
        };
      });
    } catch (e) {
      resultsEl.innerHTML = `<p class="muted" style="text-align:center;margin:1rem 0">Search failed: ${escapeHtml(e.message || 'unknown error')}</p>`;
    }
  };

  document.getElementById('migrateManualSearchBtn').onclick = runSearch;
  queryInput.onkeydown = (e) => { if (e.key === 'Enter') runSearch(); };
  runSearch();
}

// ── Step 4 — Execute ──────────────────────────────────────────────────────────

async function _migrateExecute(modal, results, selectedTargets, rowKeyFor, confirmBtnId = 'migrateBtnConfirm') {
  const btn = document.getElementById(confirmBtnId);
  if (btn) { btn.disabled = true; btn.textContent = 'Migrating…'; }

  const selectedCount = selectedTargets?.size || 0;
  if (!selectedCount) {
    if (btn) { btn.disabled = false; btn.textContent = 'Migrate Selected'; }
    showToast('Migration', 'Select one target source per manga row before migrating.', 'warning');
    return;
  }

  // Build migration payloads — only migrate rows that found a target match
  const migrations = [];
  let skipped = 0;
  for (const { manga, sourceResults } of results) {
    const rowKey = rowKeyFor(manga);
    const toSourceId = selectedTargets.get(rowKey);
    if (!toSourceId) {
      console.warn('[MIGRATION] No target source selected for', manga);
      continue;
    }

    const info = sourceResults[toSourceId];
    if (!info?.mangaId) {
      console.warn('[MIGRATION] No mangaId found in target source', { manga, toSourceId, info });
      skipped++;
      continue;
    }
    // Ensures fromSourceId is always a string ("unknown" if there isn't one)
    let fromSourceId = manga.sourceId;
    if (!fromSourceId || fromSourceId === null || fromSourceId === undefined) fromSourceId = 'unknown';
    migrations.push({
      fromMangaId:  manga.id,
      fromSourceId: fromSourceId,
      toMangaId:    info.mangaId,
      toSourceId,
      title:        info.title || manga.title,
      cover:        info.cover || manga.cover || '',
    });
  }

  if (!migrations.length) {
    if (btn) { btn.disabled = false; btn.textContent = 'Migrate Selected'; }
    showToast('Migration', 'No valid matches found for the selected rows.', 'warning');
    return;
  }

  try {
    const res = await api('/api/library/migrate', {
      method: 'POST',
      body: JSON.stringify({
        migrations,
        includeCategories: _migrateDataToggles.categories,
        includeProgress: _migrateDataToggles.chapters,
        includeTracking: _migrateDataToggles.tracking,
        includeCover: _migrateDataToggles.cover,
      }),
    });

    // ── Remap localStorage data for migrated manga ────────────────────────
    if (Array.isArray(res.migrations) && res.migrations.length > 0) {
      const okKeys = new Set(res.migrations.map(x => `${x.fromMangaId}=>${x.toMangaId}`));
      const successfulWithSources = migrations.filter(x => okKeys.has(`${x.fromMangaId}=>${x.toMangaId}`));
      // The manga are already moved server-side at this point (the request
      // above already completed) - this is just remapping reading progress,
      // but it's real per-manga network work with no other visible feedback,
      // so show it explicitly rather than leaving "Migrating…" sitting there
      // indistinguishable from actually being stuck.
      await _migrateRemapLocalStorage(successfulWithSources, (done, total) => {
        if (btn) btn.textContent = `Migrating… (${done}/${total})`;
      }, { remapTracking: _migrateDataToggles.tracking, remapChapters: _migrateDataToggles.chapters });
    }

    // Refresh state
    try {
      const libData = await fetch('/api/library').then(r => r.json());
      state.favorites = libData.favorites || state.favorites;
      state.coverOverrides = libData.coverOverrides || state.coverOverrides;
      const statusData = await fetch('/api/user/status').then(r => r.json());
      state.readingStatus = statusData.readingStatus || state.readingStatus;
      const listsData = await api('/api/lists');
      state.customLists = listsData.lists || [];
      // Reload ratings so the UI reflects migrated scores immediately
      const ratingsData = await fetch('/api/ratings').then(r => r.json());
      state.ratings = ratingsData.ratings || state.ratings;
      renderLibrary();
    } catch (_) {}

    modal.remove();
    const parts = [`${res.migrated} manga migrated`];
    if (res.failed) parts.push(`${res.failed} failed`);
    if (skipped) parts.push(`${skipped} without match`);

    // AVISO ESPECIAL PARA SEM SOURCE
    // Verifica se algum dos migrados tinha sourceId 'unknown' e ficou sem status/review
    let semSourceWarn = false;
    if (Array.isArray(migrations)) {
      for (const m of migrations) {
        if ((m.fromSourceId === 'unknown' || !m.fromSourceId) && m.fromMangaId && m.toMangaId) {
          // Verifica se o novo manga ficou sem status
          const newKey = `${m.toMangaId}:${m.toSourceId}`.replace(/[^a-z0-9:_-]/gi, '_');
          if (!state.readingStatus[newKey]) {
            semSourceWarn = true;
            break;
          }
        }
      }
    }
    if (semSourceWarn) {
      parts.push('Warning: some manga migrated from "no source" had no progress/status to copy over.');
    }

    showToast('Migration complete', parts.join(', '), (res.failed || skipped || semSourceWarn) ? 'warning' : 'success');
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Migrate Selected'; }
    showToast('Migration failed', err.message, 'error');
  }
}

/**
 * Remap local chapter-progress keys after source migration.
 * Maps chapter progress by chapter ordering (oldest-first) between source A and B,
 * because chapter IDs are source-specific and cannot be copied verbatim.
 *
 * @param {Array<{fromMangaId:string, fromSourceId:string, toMangaId:string, toSourceId:string}>} migrationPairs
 */
async function _migrateRemapLocalStorage(migrationPairs, onProgress, { remapTracking = true, remapChapters = true } = {}) {
  const pairs = Array.isArray(migrationPairs) ? migrationPairs : [];
  if (!pairs.length) return;

  // Remap tracker links first (independent of chapter/source remap) —
  // gated by the "Tracking" toggle in the pre-migration data-to-migrate
  // step (_migrateShowDataToggleStep). Off means the AniList link simply
  // stays behind under the old (now-removed) manga entry rather than
  // following it to the new source.
  if (remapTracking) {
    try {
      const idMap = new Map(pairs.map(p => [String(p.fromMangaId || ''), String(p.toMangaId || '')]));
      const links = _alGetAllLinks();
      if (Object.keys(links).length) {
        const remapped = {};
        for (const [key, val] of Object.entries(links)) remapped[idMap.get(key) || key] = val;
        _alSetAllLinks(remapped);
      }
    } catch (_) {
      // Non-fatal.
    }
  }

  // Gated by the "Chapters (Progress)" toggle — off skips remapping
  // read/flagged chapters and last-read position entirely, so the newly
  // migrated manga starts with a clean slate on the new source.
  if (!remapChapters) return;

  try {
    if (!state.readChapters) state.readChapters = new Set();
    if (!state.flaggedChapters) state.flaggedChapters = new Set();
    if (!state.lastReadPages) state.lastReadPages = {};
    if (!state.lastReadChapter) state.lastReadChapter = {};
    if (!state.highestReadChapter) state.highestReadChapter = {};

    const _parseNum = (ch) => {
      const raw = String(ch?.chapter ?? ch?.name ?? '').trim();
      if (!raw) return null;
      const m = raw.match(/\d+(?:\.\d+)?/);
      if (!m) return null;
      const n = Number(m[0]);
      return Number.isFinite(n) ? n : null;
    };

    const _oldestFirst = (chapters) => {
      const list = Array.isArray(chapters) ? chapters.slice() : [];
      if (list.length <= 1) return list;

      const rows = list.map((c, i) => ({ c, i, n: _parseNum(c) }));
      const numeric = rows.filter(r => r.n !== null).length;
      const mostlyNumeric = numeric >= Math.max(2, Math.floor(list.length * 0.5));

      if (mostlyNumeric) {
        return rows
          .sort((a, b) => (a.n - b.n) || (a.i - b.i))
          .map(r => r.c);
      }
      // Most sources list newest-first in API output.
      return list.reverse();
    };

    const _fetchChapters = async (sourceId, mangaId) => {
      const r = await api(`/api/source/${encodeURIComponent(sourceId)}/chapters`, {
        method: 'POST',
        body: JSON.stringify({ mangaId })
      });
      return _oldestFirst((r?.chapters || []).filter(ch => ch?.id));
    };

    // Each pair only ever reads/writes the state entries keyed by its OWN
    // fromMangaId/toMangaId (readChapters, lastReadChapter, lastReadPages,
    // flaggedChapters, highestReadChapter) - no two pairs share a key, so
    // running several at once is safe (JS's single-threaded event loop means
    // the Set/object mutations themselves are never interleaved mid-write
    // either way). This used to run one pair fully at a time, each one
    // making 2 real chapter-list fetches (old source + new source) - with a
    // large migration (100+ manga) and even a few slow targets mixed in
    // (confirmed live: WeebCentral's own /full-chapter-list for a long-
    // running series is a multi-MB response), that added up to several
    // minutes with the "Migrating…" button as the only visible state -
    // indistinguishable from actually being stuck. A worker pool (same
    // CONCURRENCY the Step 3 comparison table already uses) plus the
    // onProgress callback below fixes both the real wait and the appearance
    // of one.
    let done = 0;
    onProgress?.(0, pairs.length);

    async function processPair(p) {
      const fromMangaId = String(p.fromMangaId || '');
      const toMangaId = String(p.toMangaId || '');
      const fromSourceId = String(p.fromSourceId || '');
      const toSourceId = String(p.toSourceId || '');
      if (!fromMangaId || !toMangaId || !fromSourceId || !toSourceId) return;

      let oldChapters = [];
      let newChapters = [];
      try {
        [oldChapters, newChapters] = await Promise.all([
          _fetchChapters(fromSourceId, fromMangaId),
          _fetchChapters(toSourceId, toMangaId),
        ]);
      } catch (_) {
        oldChapters = [];
        newChapters = [];
      }

      const oldById = new Map(oldChapters.map((ch, idx) => [String(ch.id), { idx, num: _parseNum(ch) }]));
      const newByIdx = newChapters;
      const newByNum = new Map();
      for (let i = 0; i < newByIdx.length; i++) {
        const ch = newByIdx[i];
        const n = _parseNum(ch);
        if (n === null) continue;
        const k = String(n);
        if (!newByNum.has(k)) newByNum.set(k, { idx: i, ch });
      }

      const _mapOldChapterId = (oldChapterId) => {
        const oldMeta = oldById.get(String(oldChapterId));
        if (!oldMeta) return null;

        if (oldMeta.num !== null) {
          const direct = newByNum.get(String(oldMeta.num));
          if (direct?.ch?.id) return { idx: direct.idx, id: direct.ch.id };
        }

        const fallback = newByIdx[oldMeta.idx];
        if (fallback?.id) return { idx: oldMeta.idx, id: fallback.id };
        return null;
      };

      const oldReadIds = [];
      for (const key of state.readChapters) {
        const k = String(key || '');
        if (!k.startsWith(`${fromMangaId}:`)) continue;
        oldReadIds.push(k.slice(fromMangaId.length + 1));
      }

      const mappedReadIds = new Set();
      for (const oldId of oldReadIds) {
        const mapped = _mapOldChapterId(oldId);
        if (mapped?.id) mappedReadIds.add(String(mapped.id));
      }

      let oldReadCount = 0;
      const oldReadIdxs = oldReadIds
        .map(chId => oldById.get(String(chId))?.idx)
        .filter(n => Number.isInteger(n));
      if (oldReadIdxs.length > 0) oldReadCount = Math.max(...oldReadIdxs) + 1;
      if (oldReadCount === 0) {
        const highest = Number(state.highestReadChapter?.[fromMangaId] || 0);
        if (Number.isFinite(highest) && highest > 0) oldReadCount = Math.floor(highest);
      }

      // Fallback: if old read set is empty, infer from highest chapter number first.
      if (mappedReadIds.size === 0 && oldReadCount > 0) {
        const byNum = newByIdx.filter(ch => {
          const n = _parseNum(ch);
          return n !== null && n <= oldReadCount;
        });
        if (byNum.length > 0) {
          for (const ch of byNum) if (ch?.id) mappedReadIds.add(String(ch.id));
        } else {
          const mappedReadCount = Math.max(0, Math.min(oldReadCount, newByIdx.length));
          for (let i = 0; i < mappedReadCount; i++) {
            const ch = newByIdx[i];
            if (ch?.id) mappedReadIds.add(String(ch.id));
          }
        }
      }

      for (const newId of mappedReadIds) {
        state.readChapters.add(`${toMangaId}:${newId}`);
      }

      for (const key of [...state.readChapters]) {
        if (String(key).startsWith(`${fromMangaId}:`)) state.readChapters.delete(key);
      }

      const oldLastId = state.lastReadChapter?.[fromMangaId];
      let mappedLast = oldLastId ? _mapOldChapterId(oldLastId) : null;

      // If we don't have an explicit last chapter id, infer from highest chapter number.
      if (!mappedLast) {
        const oldHighest = Number(state.highestReadChapter?.[fromMangaId] || 0);
        if (Number.isFinite(oldHighest) && oldHighest > 0) {
          const byNum = newByNum.get(String(oldHighest));
          if (byNum?.ch?.id) {
            mappedLast = { idx: byNum.idx, id: byNum.ch.id };
          } else {
            const fallbackIdx = Math.max(0, Math.min(Math.floor(oldHighest) - 1, newByIdx.length - 1));
            const fallback = newByIdx[fallbackIdx];
            if (fallback?.id) mappedLast = { idx: fallbackIdx, id: fallback.id };
          }
        }
      }

      if (mappedLast?.id) {
        const oldPageKey = `${fromMangaId}:${oldLastId}`;
        const newPageKey = `${toMangaId}:${mappedLast.id}`;
        const oldPage = state.lastReadPages?.[oldPageKey] || 0;
        state.lastReadChapter[toMangaId] = mappedLast.id;
        state.lastReadPages[newPageKey] = oldPage;

        // Ensure continuity: mark everything older than (and including) last read.
        const upto = Math.max(0, Math.min(mappedLast.idx, newByIdx.length - 1));
        for (let i = 0; i <= upto; i++) {
          const ch = newByIdx[i];
          if (ch?.id) mappedReadIds.add(String(ch.id));
        }
      }

      delete state.lastReadChapter[fromMangaId];
      for (const k of Object.keys(state.lastReadPages || {})) {
        if (k.startsWith(`${fromMangaId}:`)) delete state.lastReadPages[k];
      }

      const oldFlagIds = [];
      for (const key of state.flaggedChapters) {
        const k = String(key || '');
        if (!k.startsWith(`${fromMangaId}:`)) continue;
        oldFlagIds.push(k.slice(fromMangaId.length + 1));
      }
      for (const oldId of oldFlagIds) {
        const mapped = _mapOldChapterId(oldId);
        if (mapped?.id) state.flaggedChapters.add(`${toMangaId}:${mapped.id}`);
      }
      for (const key of [...state.flaggedChapters]) {
        if (String(key).startsWith(`${fromMangaId}:`)) state.flaggedChapters.delete(key);
      }

      const oldHighest = Number(state.highestReadChapter?.[fromMangaId] || 0);
      if (oldHighest > 0) {
        const maxNew = newByIdx.length || oldHighest;
        state.highestReadChapter[toMangaId] = Math.max(
          Number(state.highestReadChapter[toMangaId] || 0),
          Math.min(oldHighest, maxNew)
        );
      }
      delete state.highestReadChapter[fromMangaId];
    }

    const REMAP_CONCURRENCY = 5;
    let nextIdx = 0;
    async function remapWorker() {
      while (nextIdx < pairs.length) {
        const p = pairs[nextIdx++];
        try {
          await processPair(p);
        } catch (_) {
          // One pair failing to remap must never stop the rest - the
          // migration itself already succeeded server-side regardless.
        }
        done++;
        onProgress?.(done, pairs.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(REMAP_CONCURRENCY, pairs.length) }, remapWorker));

    // AniList links are already remapped above.

    saveSettings();
  } catch (_) {
    // Non-fatal — remap failure should not block the rest of the flow.
  }
}
