// ============================================================================
// ANALYTICS → WRAPPED TAB → THE ANILIST VIEW (page)
//
// The same card as the "This app" view, drawn from the person's AniList list (wrapped-anilist.js has the numbers): one page for manga
// and one for anime, "all time" or the titles finished in a year. It leaves out what AniList cannot know (days, streaks, reading time)
// and says why, so a missing card is never a bug. Markup only comes from a plain object (_wrappedAniListHtml), which the tests check.
// ============================================================================

function _wAlOptions() {
  const genres = (typeof state !== 'undefined' && state.settings && Array.isArray(state.settings.genreBlacklist) ? state.settings.genreBlacklist : []).filter(Boolean);
  return {
    kind: _wrapped.kind,
    period: _wrapped.period === 'year' ? 'year' : 'all', // AniList has no "last 7 / 30 days"
    year: _wrapped.year || new Date().getFullYear(),
    hideNsfw: !!_wrapped.hideNsfw,
    excludeGenres: genres,
    excludeTitles: Object.keys(_wrapped.hidden),
  };
}

// AniList's "ONE_SHOT" as "one shot", but "TV" and "OVA" stay as they are.
const _wAlFormat = (format) => {
  const words = String(format || '').replace(/_/g, ' ');
  return words.length <= 3 ? words : words.toLowerCase();
};

// What of this AniList list is also in the library, to link it: AniList's media id for a manga (the id saved on the favourite, or the one
// the Tracker linked it to), the MyAnimeList id or AniList id for an anime. Read fresh each time the page is drawn.
async function _wAlLibraryIndex(kind) {
  const index = new Map();
  try {
    if (kind === 'anime') {
      const favorites = typeof _fetchAnimeFavorites === 'function' ? await _fetchAnimeFavorites() : [];
      for (const f of favorites) {
        if (f?.idMal) index.set(`mal:${f.idMal}`, f);
        if (f?.anilistId) index.set(`al:${f.anilistId}`, f);
      }
    } else {
      const links = typeof _alGetAllLinks === 'function' ? _alGetAllLinks() : {};
      for (const f of ((typeof state !== 'undefined' && state.favorites) || [])) {
        const id = f?.anilistId || links[f?.id];
        if (id && !index.has(`al:${id}`)) index.set(`al:${id}`, f);
      }
    }
  } catch (e) {
    dbg.warn(dbg.ERR_ANILIST, 'Wrapped could not read the library', e);
  }
  return index;
}

const _wAlLibraryMatch = (library, item) => library.get(`al:${item.mediaId}`) || (item.idMal ? library.get(`mal:${item.idMal}`) : null) || null;

// A title's name: a button that opens it when it is in the library, plain text when it is not.
function _wAlName(item, kind, library) {
  const match = library && _wAlLibraryMatch(library, item);
  if (!match) return escapeHtml(item.title);
  const id = kind === 'anime' ? match.idMal : match.id;
  return `<button type="button" class="wrapped-open" data-wrapped-action="open-${kind}" data-id="${escapeHtml(id)}" data-source="${escapeHtml(match.sourceId || '')}" title="${escapeHtml(t('wrapped.al.open'))}">${escapeHtml(item.title)}</button>`;
}

// What a click on a name does. The library is the one index of this page: what was drawn is what is looked up.
async function wrappedOpenItem(d) {
  try {
    if (d.wrappedAction === 'open-author') {
      if (d.name && typeof searchByAuthor === 'function') await searchByAuthor(d.name);
      return;
    }
    const library = _wrapped.alLibrary;
    const fav = library && [...library.values()].find((f) => String(d.wrappedAction === 'open-anime' ? f.idMal : f.id) === String(d.id));
    if (!fav) return;
    if (d.wrappedAction === 'open-anime') {
      if (typeof _animeGoToDetails === 'function') _animeGoToDetails({ idMal: fav.idMal, anilistId: fav.anilistId, title: fav.title, cover: fav.cover, episodes: fav.totalEpisodes || 0 }, null);
      return;
    }
    const sourceId = fav.sourceId || d.source || '';
    if (sourceId && sourceId !== state.currentSourceId) {
      state.currentSourceId = sourceId; // the same as opening it from the library: the title belongs to a source
      if (typeof renderSourceSelect === 'function') renderSourceSelect();
    }
    await loadMangaDetails(fav.id, 'library', fav.title, false, sourceId || state.currentSourceId);
  } catch (e) {
    showToast('Error', (e && e.message) || 'Something went wrong opening this title.', 'error');
  }
}

function _wAlTitleList(al, kind, library) {
  const unitKey = kind === 'anime' ? 'wrapped.nEpisodes' : 'wrapped.nChapters';
  const heading = t(kind === 'anime' ? 'wrapped.topAnime' : 'wrapped.topManga');
  const items = al.top.map((x, i) => {
    const detail = [_wt(unitKey, { n: _wNum(x.units) }), _wAlFormat(x.format), x.score ? `★ ${x.score}` : ''].filter(Boolean).join(' · ');
    // a title with no latin letters or digits has no key to be hidden by (the same normalisation as the server's)
    const hide = !x.key ? '' : `<button class="wrapped-hide" data-wrapped-action="hide" data-key="${escapeHtml(x.key)}" data-title="${escapeHtml(x.title)}" title="${escapeHtml(t('wrapped.hideTitle'))}" aria-label="${escapeHtml(t('wrapped.hideTitle'))}">⊘</button>`;
    return `<li>${_wRank(i)}${_wCover(x.cover, x.title)}<span class="wrapped-item"><b>${_wAlName(x, kind, library)}</b><small>${escapeHtml(detail)}</small></span>${hide}</li>`;
  }).join('');
  return `<section class="wrapped-card wrapped-card--wide"><h3>${escapeHtml(heading)}</h3><ol class="wrapped-list">${items}</ol></section>`;
}

function _wAlPeopleCard(al, kind) {
  if (!al.people.length) return '';
  const unitKey = kind === 'anime' ? 'wrapped.nEpisodes' : 'wrapped.nChapters';
  const items = al.people.map((x, i) => `<li>${_wRank(i)}<span class="wrapped-item"><b>${kind === 'manga' ? `<button type="button" class="wrapped-open" data-wrapped-action="open-author" data-name="${escapeHtml(x.name)}" title="${escapeHtml(t('wrapped.al.openAuthor'))}">${escapeHtml(x.name)}</button>` : escapeHtml(x.name)}</b><small>${escapeHtml(_wt(unitKey, { n: _wNum(x.units) }))}</small></span></li>`).join('');
  return `<section class="wrapped-card"><h3>${escapeHtml(t(kind === 'anime' ? 'wrapped.topStudios' : 'wrapped.topAuthors'))}</h3><ol class="wrapped-list wrapped-list--compact">${items}</ol></section>`;
}

// The cards that show how the list is spread, each as markup or '' when there is nothing to show. Only the genres are wide.
function _wAlSpreadCards(w) {
  const al = w.al;
  const card = (title, body, wide = false) => `<section class="wrapped-card${wide ? ' wrapped-card--wide' : ''}"><h3>${escapeHtml(t(title))}</h3>${body}</section>`;
  const statusItems = Object.entries(al.statuses).filter(([, n]) => n > 0);
  const monthly = w.period.id === 'year';
  const labels = al.finishedBy.map((x) => (monthly
    ? new Date(Number(x.key.slice(0, 4)), Number(x.key.slice(5)) - 1, 1, 12).toLocaleDateString(typeof currentLanguage === 'string' ? currentLanguage : undefined, { month: 'short' })
    : x.key));
  const scoreLabels = al.scores.map((_, i) => String(i + 1));
  return {
    genres: al.genres.length ? card('wrapped.topGenres', _wBars(al.genres, (g) => g.genre, (g) => g.units, (g) => `${Math.round(g.share * 100)}%`), true) : '',
    statuses: statusItems.length ? card('wrapped.al.statuses', _wBars(statusItems, ([s]) => t(`wrapped.al.status.${w.kind}.${s}`), ([, n]) => n, ([, n]) => _wNum(n))) : '',
    scores: al.scoredTitles ? card('wrapped.al.scores', _wColumns(al.scores, scoreLabels, (i, v) => `${scoreLabels[i]}: ${_wt('wrapped.nTitles', { n: v })}`)) : '',
    formats: al.formats.length ? card('wrapped.al.formats', _wBars(al.formats, (f) => _wAlFormat(f.format), (f) => f.count, (f) => _wNum(f.count))) : '',
    finished: al.finishedBy.some((x) => x.count > 0)
      ? card(monthly ? 'wrapped.al.finishedByMonth' : 'wrapped.al.finishedByYear', _wColumns(al.finishedBy.map((x) => x.count), labels, (i, v) => `${labels[i]}: ${_wt('wrapped.nTitles', { n: v })}`))
      : '',
  };
}

function _wAlLibraryCard(al, kind, library) {
  let body = '';
  if (al.finished.length) body += `<h4>${escapeHtml(t('wrapped.finished'))} · ${_wNum(al.completed)}</h4><ul class="wrapped-plain">${al.finished.map((x) => `<li>${_wAlName(x, kind, library)} <small>${escapeHtml(_wDate(x.day))}</small></li>`).join('')}</ul>`;
  if (al.rated.length) body += `<h4>${escapeHtml(t('wrapped.rated'))} · ${escapeHtml(_wt('wrapped.avgRating', { n: al.meanScore }))}</h4><ul class="wrapped-plain">${al.rated.map((x) => `<li>${_wAlName(x, kind, library)} <b>★ ${escapeHtml(x.rating)}</b></li>`).join('')}</ul>`;
  return body ? `<section class="wrapped-card"><h3>${escapeHtml(t('wrapped.library'))}</h3>${body}</section>` : '';
}

function _wAlKpis(w) {
  const al = w.al;
  const kpis = [
    [t('wrapped.al.kpi.titles'), _wNum(al.titles), ''],
    [t('wrapped.al.kpi.completed'), _wNum(al.completed), ''],
    [t('wrapped.al.kpi.meanScore'), al.meanScore ? String(al.meanScore) : '—', al.scoredTitles ? _wt('wrapped.al.scoredTitles', { n: _wNum(al.scoredTitles) }) : ''],
    w.kind === 'anime'
      ? [t('wrapped.al.kpi.watchTime'), al.minutes ? formatTime(al.minutes) : '—', '']
      : [t('wrapped.al.kpi.volumes'), al.volumes ? _wNum(al.volumes) : '—', ''],
  ];
  return `<div class="wrapped-kpis">${kpis.map(([label, value, hint]) => `<div class="wrapped-kpi"><div class="wrapped-kpi-label">${escapeHtml(label)}</div><div class="wrapped-kpi-value">${escapeHtml(value)}</div>${hint ? `<div class="wrapped-kpi-hint">${escapeHtml(hint)}</div>` : ''}</div>`).join('')}</div>`;
}

function _wrappedAniListHtml(w, library) {
  const al = w.al;
  const parts = [];
  parts.push(`<p class="wrapped-notice">${escapeHtml(w.period.id === 'year' ? _wt('wrapped.al.note.year', { year: w.period.year }) : t('wrapped.al.note.all'))}</p>`);
  if (al.cut) parts.push(`<p class="wrapped-notice">${escapeHtml(t('wrapped.al.cut'))}</p>`);
  if (w.filters.hidden.nsfw) parts.push(`<p class="wrapped-note">${escapeHtml(_wt('wrapped.hiddenAdult', { n: w.filters.hidden.nsfw }))}</p>`);
  if (!al.titles) {
    parts.push(`<div class="wrapped-empty">${escapeHtml(t('wrapped.al.empty'))}</div>`);
    return parts.join('');
  }
  const sub = [
    w.kind === 'anime' && al.minutes ? `${formatTime(al.minutes)} ${t('wrapped.al.watching')}` : '',
    _wt('wrapped.nTitles', { n: _wNum(al.titles) }),
  ].filter(Boolean).join(' · ');
  parts.push(`<section class="wrapped-hero"><div class="wrapped-hero-label">${escapeHtml(w.period.label)} · AniList</div><div class="wrapped-hero-number">${_wNum(w.hero.number)}<small>${escapeHtml(w.hero.unit)}</small></div><div class="wrapped-hero-sub">${escapeHtml(sub)}</div></section>`);
  parts.push(_wAlKpis(w));
  // Rows of cards of a similar height (the grid stretches them): the titles beside the people and the library, stacked; then the genres
  // beside the statuses; then three small ones. A card with nothing to show is simply not there.
  const spread = _wAlSpreadCards(w);
  const stack = [_wAlPeopleCard(al, w.kind), _wAlLibraryCard(al, w.kind, library)].filter(Boolean);
  const cards = [_wAlTitleList(al, w.kind, library), stack.length ? `<div class="wrapped-stack">${stack.join('')}</div>` : '', spread.genres, spread.statuses, spread.scores, spread.formats, spread.finished];
  parts.push(`<div class="wrapped-grid wrapped-grid--even">${cards.join('')}</div>`);
  return parts.join('');
}

function _wAlErrorHtml(e) {
  if (e && e.code === 'not-connected') return `<div class="wrapped-empty">${escapeHtml(t('wrapped.al.notConnected'))}</div>`;
  return `<div class="wrapped-empty">${escapeHtml(_wt('wrapped.al.error', { message: (e && e.message) || '' }))} <button class="wrapped-link" data-wrapped-action="retry">${escapeHtml(t('wrapped.retry'))}</button></div>`;
}

async function renderWrappedAniListTab(root, seq) {
  const previous = _wrapped.alData;
  const frame = (w, body, extra = '') => `<div class="wrapped">${_wToolbarHtml(w)}<div class="wrapped-body${extra}">${body}</div></div>`;
  root.innerHTML = frame(previous, escapeHtml(t('wrapped.loading')), ' wrapped-body--loading');
  try {
    const force = _wrapped.alForce === true;
    _wrapped.alForce = false;
    const raw = await wrappedAniListFetch(_wrapped.kind, { force });
    if (seq !== _wrapped.seq) return; // a newer request has taken over
    const w = wrappedAniListBuild(raw, _wAlOptions());
    _wrapped.alData = w;
    _wrapped.shown = w;
    _wrapped.alLibrary = await _wAlLibraryIndex(w.kind);
    if (seq !== _wrapped.seq) return;
    root.innerHTML = frame(w, _wrappedAniListHtml(w, _wrapped.alLibrary));
    root.querySelectorAll('.wrapped-cover img').forEach((img) => img.addEventListener('error', () => img.remove()));
  } catch (e) {
    if (seq !== _wrapped.seq) return;
    if (!e || e.code !== 'not-connected') dbg.warn(dbg.ERR_ANILIST, 'Wrapped could not read AniList', e);
    root.innerHTML = frame(previous, _wAlErrorHtml(e));
  }
}
