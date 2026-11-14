// ============================================================================
// LIBRARY TAGS  –  filter the library by the tags of its titles (manga and anime)
//
// The "Tags" button of the library's side column opens a panel with every tag the library has: the genres each title already carries (from its source
// or AniList; for manga with the history as a fallback, see _getEnrichedGenres) and the person's own tags (Edit Tags in the right-click menu). Tags are
// picked, the grid shows the titles that have them: "match all" (every picked tag, the default) or "match any". The pick lives in this page only, the mode
// is remembered (one mode for both libraries). The pure parts come first so they can be tested without a page; one panel serves manga and anime.
// ============================================================================

const LIB_TAGS_MODE_KEY = 'scrollscape_library_tags_mode';
const libraryTagFilter = { selected: new Set(), mode: 'all' };
// The anime library's pick: its own set of tags, the same mode as the manga one.
const animeTagFilter = {
  selected: new Set(),
  get mode() { return libraryTagFilter.mode; },
  set mode(value) { libraryTagFilter.mode = value; },
};

// A tag is compared without case or outer spaces: "Slice of life" and "slice of life " are one tag.
function libraryTagKey(tag) {
  return String(tag == null ? '' : tag).trim().toLowerCase();
}

// genres: what the title carries (strings, or objects with a name); userTags: the person's own. Returns [{ key, label }], each tag once.
function libraryTagLabelsOf(genres, userTags) {
  const seen = new Map();
  for (const raw of [...(Array.isArray(genres) ? genres : []), ...(Array.isArray(userTags) ? userTags : [])]) {
    const label = String(raw && typeof raw === 'object' ? (raw.name || '') : (raw == null ? '' : raw)).trim();
    const key = libraryTagKey(label);
    if (key && !seen.has(key)) seen.set(key, { key, label });
  }
  return [...seen.values()];
}

// selected: Set of keys; mode: 'all' | 'any'; keys: Set of the keys the title has. Nothing picked matches everything.
function libraryTagsMatch(keys, selected, mode) {
  if (!selected || !selected.size) return true;
  if (mode === 'any') {
    for (const k of selected) if (keys.has(k)) return true;
    return false;
  }
  for (const k of selected) if (!keys.has(k)) return false;
  return true;
}

// lists: one [{ key, label }] per title. Returns [{ key, label, count }], the most used first. The label is the spelling most titles use.
function libraryTagCounts(lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const { key, label } of list) {
      let entry = byKey.get(key);
      if (!entry) { entry = { key, count: 0, spellings: new Map() }; byKey.set(key, entry); }
      entry.count += 1;
      entry.spellings.set(label, (entry.spellings.get(label) || 0) + 1);
    }
  }
  return [...byKey.values()]
    .map((e) => ({ key: e.key, count: e.count, label: [...e.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

try { libraryTagFilter.mode = localStorage.getItem(LIB_TAGS_MODE_KEY) === 'any' ? 'any' : 'all'; } catch (_) { /* the mode is only not remembered */ }

// ── manga ───────────────────────────────────────────────────────────────────

function libraryTagsOf(manga, fallbackSourceId = '') {
  return libraryTagLabelsOf(_getEnrichedGenres(manga), getMangaTags(manga.id, manga.sourceId || fallbackSourceId));
}

function libraryTagFilterActive() {
  return libraryTagFilter.selected.size > 0;
}

function libraryTagMatchesManga(manga, fallbackSourceId = '') {
  if (!libraryTagFilterActive()) return true;
  return libraryTagsMatch(new Set(libraryTagsOf(manga, fallbackSourceId).map((t) => t.key)), libraryTagFilter.selected, libraryTagFilter.mode);
}

// The manga the panel counts: the ones the library could show at all (a hidden source or hidden NSFW title adds no tags to the list).
function _libraryTagBaseItems() {
  const visibleSources = Array.isArray(state.settings.visibleSources) ? state.settings.visibleSources : null;
  const hideNsfw = state.settings.hideNsfw === true;
  const ok = (m) => m && m.id && m.title
    && !(visibleSources !== null && m.sourceId && !visibleSources.includes(m.sourceId))
    && !(hideNsfw && typeof _isNsfwEnriched === 'function' && _isNsfwEnriched(m));
  return [
    ...(state.favorites || []).filter(ok).map((m) => ({ m, fallback: '' })),
    ...(state.localManga || []).filter(ok).map((m) => ({ m, fallback: 'local' })),
  ];
}

function _updateTagsButton(filter, buttonId, badgeId) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  const n = filter.selected.size;
  btn.classList.toggle('active', n > 0);
  const badge = document.getElementById(badgeId);
  if (badge) { badge.hidden = n === 0; badge.textContent = String(n); }
  btn.title = n ? `Filter by tags (${n} picked)` : 'Filter by tags';
}

function updateLibraryTagsButton() {
  _updateTagsButton(libraryTagFilter, 'btnLibraryTags', 'libTagsBadge');
}

function showLibraryTagsPanel() {
  const lists = _libraryTagBaseItems().map(({ m, fallback }) => libraryTagsOf(m, fallback));
  _showTagFilterPanel({
    filter: libraryTagFilter,
    lists,
    noun: 'manga',
    onButton: updateLibraryTagsButton,
    onApply: () => { if (typeof renderLibrary === 'function') renderLibrary(); },
  });
}

// ── anime ───────────────────────────────────────────────────────────────────

// An anime favorite carries its genres (`genres`) and the person's own tags (`tags`, from animeTags, keyed by idMal).
function animeTagsOf(anime) {
  return libraryTagLabelsOf(anime && anime.genres, anime && anime.tags);
}

function animeTagFilterActive() {
  return animeTagFilter.selected.size > 0;
}

function animeTagMatches(anime) {
  if (!animeTagFilterActive()) return true;
  return libraryTagsMatch(new Set(animeTagsOf(anime).map((t) => t.key)), animeTagFilter.selected, animeTagFilter.mode);
}

function updateAnimeLibraryTagsButton() {
  _updateTagsButton(animeTagFilter, 'btnAnimeLibraryTags', 'animeLibTagsBadge');
}

function showAnimeLibraryTagsPanel() {
  const favorites = typeof _animeLibraryFavorites !== 'undefined' ? _animeLibraryFavorites : [];
  _showTagFilterPanel({
    filter: animeTagFilter,
    lists: favorites.map(animeTagsOf),
    noun: 'anime',
    onButton: updateAnimeLibraryTagsButton,
    onApply: () => { if (typeof _animeApplyLibraryFilters === 'function') _animeApplyLibraryFilters(); },
  });
}

// ── the panel ───────────────────────────────────────────────────────────────

// filter: the { selected, mode } this panel edits; lists: one [{ key, label }] per title; noun: what the titles are called; onButton: refresh the
// button's badge; onApply: draw the library again.
function _showTagFilterPanel({ filter, lists, noun, onButton, onApply }) {
  document.querySelector('.library-tags-modal')?.remove();

  const counts = libraryTagCounts(lists);
  const pickOf = () => [...filter.selected].sort().join('|') + '#' + filter.mode;
  const startedWith = pickOf();

  const modal = document.createElement('div');
  modal.className = 'settings-modal library-tags-modal';
  modal.innerHTML = `
    <div class="settings-content" style="max-width:640px">
      <div class="settings-header">
        <h2>Filter by tags</h2>
        <button class="btn secondary" id="libTagsClose" aria-label="Close">&#x2715;</button>
      </div>
      <div class="settings-body">
        <div class="lib-tags-toolbar">
          <input type="text" id="libTagsSearch" class="input" placeholder="Find a tag..." autocomplete="off" spellcheck="false">
          <div class="lib-tags-mode" role="group" aria-label="How the picked tags are matched">
            <button type="button" class="btn secondary" data-mode="all" title="A ${noun} must have every picked tag">Match all</button>
            <button type="button" class="btn secondary" data-mode="any" title="A ${noun} needs at least one of the picked tags">Match any</button>
          </div>
        </div>
        <div id="libTagsChips" class="lib-tags-chips"></div>
        <p class="setting-description" id="libTagsSummary" style="margin:0.8rem 0 0"></p>
        <div class="setting-group" style="display:flex;gap:8px;margin-top:0.8rem">
          <button class="btn primary" id="libTagsShow" style="flex:1"></button>
          <button class="btn secondary" id="libTagsClear">Clear</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const chipsEl = modal.querySelector('#libTagsChips');
  const searchEl = modal.querySelector('#libTagsSearch');
  const summaryEl = modal.querySelector('#libTagsSummary');
  const showBtn = modal.querySelector('#libTagsShow');

  const matchingCount = () => lists.filter((list) => libraryTagsMatch(new Set(list.map((t) => t.key)), filter.selected, filter.mode)).length;

  const refresh = () => {
    const needle = libraryTagKey(searchEl.value);
    const shown = counts.filter((c) => !needle || c.key.includes(needle));
    chipsEl.innerHTML = shown.length
      ? shown.map((c) => `<button type="button" class="category-chip tag-chip lib-tag-chip${filter.selected.has(c.key) ? ' active' : ''}" data-key="${escapeHtml(c.key)}" aria-pressed="${filter.selected.has(c.key)}">${escapeHtml(c.label)} <span class="lib-tag-count">${c.count}</span></button>`).join('')
      : `<span class="muted" style="font-size:0.85rem">${counts.length ? 'No tag matches that.' : 'No tags yet. Titles bring their genres when they are added; your own tags come from Edit Tags in the right-click menu.'}</span>`;
    modal.querySelectorAll('.lib-tags-mode [data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === filter.mode));
    const n = filter.selected.size;
    summaryEl.textContent = n
      ? `${n} tag${n === 1 ? '' : 's'} picked, ${filter.mode === 'all' ? `a ${noun} must have all of them` : `a ${noun} needs at least one`}.`
      : 'Pick the tags you want. Nothing picked shows the whole library.';
    showBtn.textContent = n ? `Show ${matchingCount()} ${noun}` : 'Show all';
    modal.querySelector('#libTagsClear').disabled = n === 0;
  };

  // The grid is drawn again when the panel closes, and only if the pick changed: a draw is the whole library.
  const close = () => {
    modal.remove();
    document.removeEventListener('keydown', onKey, true);
    onButton();
    if (pickOf() !== startedWith) onApply();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);

  chipsEl.addEventListener('click', (e) => {
    const chip = e.target.closest('.lib-tag-chip');
    if (!chip) return;
    const key = chip.dataset.key;
    if (filter.selected.has(key)) filter.selected.delete(key);
    else filter.selected.add(key);
    refresh();
  });
  modal.querySelectorAll('.lib-tags-mode [data-mode]').forEach((b) => {
    b.onclick = () => {
      filter.mode = b.dataset.mode === 'any' ? 'any' : 'all';
      try { localStorage.setItem(LIB_TAGS_MODE_KEY, filter.mode); } catch (_) { /* the mode is only not remembered */ }
      refresh();
    };
  });
  searchEl.addEventListener('input', refresh);
  modal.querySelector('#libTagsClear').onclick = () => { filter.selected.clear(); refresh(); };
  showBtn.onclick = close;
  modal.querySelector('#libTagsClose').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };

  refresh();
  setTimeout(() => searchEl.focus(), 50);
}
