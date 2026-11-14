// ============================================================================
// ANALYTICS → WRAPPED TAB
//
// A look back at what was read and watched, by period (last 7 days, last 30 days, a year, all time): the number of chapters in big,
// the totals, the top manga, genres, authors and anime, how regular the reading is, what was finished and rated. The numbers come from
// the server (GET /api/analytics/wrapped, server/modules/analytics/wrapped.js); this only draws them, so everything here is markup built
// from a plain object, which is what the tests check (_wrappedHtml).
//
// A switch at the top picks where the numbers come from: this app (the server's record, below) or the person's AniList list
// (wrapped-anilist.js has the numbers, ui-analytics-wrapped-anilist.js the page); the toolbar and the buttons are shared.
//
// Two things the page is careful about:
//  - it says when a period reaches before the title-level history (the server keeps which manga was read only since a date): the lists
//    then cover that date onwards and must not read as the whole year;
//  - it can leave things out, for a page that is shown or shared: adult titles (and adult tags), and any title the person hides. What
//    is left out is left out of EVERY number (the server does it), and the choice is remembered in this browser.
// ============================================================================

const WRAPPED_KEYS = Object.freeze({ period: 'scrollscape_wrapped_period', year: 'scrollscape_wrapped_year', hideNsfw: 'scrollscape_wrapped_hide_nsfw', hidden: 'scrollscape_wrapped_hidden', source: 'scrollscape_wrapped_source', kind: 'scrollscape_wrapped_kind' });
const WRAPPED_PERIOD_IDS = Object.freeze(['week', 'month', 'year', 'all']);
// AniList does not know on which day something was read: only these two periods exist on its view (see wrapped-anilist.js).
const WRAPPED_AL_PERIOD_IDS = Object.freeze(['year', 'all']);
// data: the last answer of this app's server; alData: the last AniList view; shown: whichever is on the page (what Share draws).
const _wrapped = { period: 'year', year: null, hideNsfw: null, hidden: {}, source: 'app', kind: 'manga', data: null, alData: null, alLibrary: null, shown: null, alForce: false, seq: 0, tab: 'overview', loaded: false };

function _wrappedLsGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
function _wrappedLsSet(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* the page still works without remembering */ } }

function _wrappedLoadPrefs() {
  if (_wrapped.loaded) return;
  _wrapped.loaded = true;
  const period = _wrappedLsGet(WRAPPED_KEYS.period);
  if (WRAPPED_PERIOD_IDS.includes(period)) _wrapped.period = period;
  const year = Number.parseInt(_wrappedLsGet(WRAPPED_KEYS.year), 10);
  if (Number.isInteger(year)) _wrapped.year = year;
  if (_wrappedLsGet(WRAPPED_KEYS.source) === 'anilist') _wrapped.source = 'anilist';
  if (_wrappedLsGet(WRAPPED_KEYS.kind) === 'anime') _wrapped.kind = 'anime';
  const nsfw = _wrappedLsGet(WRAPPED_KEYS.hideNsfw);
  _wrapped.hideNsfw = nsfw === null ? !!(typeof state !== 'undefined' && state.settings && state.settings.hideNsfw) : nsfw === '1';
  try {
    const hidden = JSON.parse(_wrappedLsGet(WRAPPED_KEYS.hidden) || '{}');
    _wrapped.hidden = hidden && typeof hidden === 'object' && !Array.isArray(hidden) ? hidden : {};
  } catch (_) { _wrapped.hidden = {}; }
}

function _wt(key, vars) {
  let text = t(key);
  for (const [k, v] of Object.entries(vars || {})) text = text.split(`{${k}}`).join(String(v));
  return text;
}

const _wNum = (n) => Number(n || 0).toLocaleString(typeof currentLanguage === 'string' ? currentLanguage : undefined);
const _wDate = (day) => {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12).toLocaleDateString(typeof currentLanguage === 'string' ? currentLanguage : undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

function _wrappedQuery() {
  const q = new URLSearchParams({ period: _wrapped.period, top: '10' });
  if (_wrapped.period === 'year' && _wrapped.year) q.set('year', String(_wrapped.year));
  if (_wrapped.hideNsfw) q.set('hideNsfw', '1');
  const genres = (typeof state !== 'undefined' && state.settings && Array.isArray(state.settings.genreBlacklist) ? state.settings.genreBlacklist : []).filter(Boolean);
  if (genres.length) q.set('excludeGenres', genres.join(','));
  const hidden = Object.keys(_wrapped.hidden).slice(0, 200);
  if (hidden.length) q.set('excludeTitles', hidden.join(','));
  return q.toString();
}

// ── markup (pure: a Wrapped object in, a string out) ────────────────────────

function _wCover(cover, title) {
  const initial = escapeHtml(String(title || '?').trim().charAt(0).toUpperCase() || '?');
  const src = cover ? normalizeImageUrl(cover) : '';
  return `<span class="wrapped-cover" data-initial="${initial}">${src ? `<img src="${escapeHtml(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</span>`;
}

function _wRank(i) { return `<span class="wrapped-rank wrapped-rank--${i < 3 ? i + 1 : 'n'}">${i + 1}</span>`; }

// A row of buttons that work as tabs (the same look as the periods): items are [id, text], `attr` names the data-* that carries the id.
function _wSegmented(label, action, attr, items, active) {
  const buttons = items.map(([id, text]) => `<button class="wrapped-period${active === id ? ' active' : ''}" data-wrapped-action="${action}" data-${attr}="${id}" role="tab" aria-selected="${active === id}">${escapeHtml(text)}</button>`).join('');
  return `<div class="wrapped-periods" role="tablist" aria-label="${escapeHtml(label)}">${buttons}</div>`;
}

// The year picker: from the first year there is something for, to this one. '' when there is only one.
function _wYearSelectHtml(w, alMode) {
  const current = new Date().getFullYear();
  const first = alMode
    ? Math.min(current, ...(w.al.years.length ? w.al.years : [current]))
    : Number.parseInt(String(w.coverage?.activityFrom || w.coverage?.detailedSince || '').slice(0, 4), 10);
  if (!Number.isInteger(first) || first >= current) return '';
  const selected = _wrapped.year || current;
  const options = [];
  for (let y = current; y >= first; y--) options.push(`<option value="${y}"${y === selected ? ' selected' : ''}>${y}</option>`);
  return `<select class="wrapped-year" id="wrappedYear" data-wrapped-action="year" aria-label="${escapeHtml(t('wrapped.year'))}">${options.join('')}</select>`;
}

function _wToolbarHtml(w) {
  const alMode = _wrapped.source === 'anilist';
  if (w && (w.source === 'anilist') !== alMode) w = null; // the last answer of the OTHER view says nothing about this one
  const periodIds = alMode ? WRAPPED_AL_PERIOD_IDS : WRAPPED_PERIOD_IDS;
  const activePeriod = periodIds.includes(_wrapped.period) ? _wrapped.period : 'all';
  const periods = _wSegmented(t('wrapped.periodLabel'), 'period', 'period', periodIds.map((id) => [id, id === 'year' && _wrapped.year && _wrapped.year !== new Date().getFullYear() ? String(_wrapped.year) : t(`wrapped.period.${id}`)]), activePeriod);
  const source = _wSegmented(t('wrapped.sourceLabel'), 'source', 'source', [['app', t('wrapped.source.app')], ['anilist', t('wrapped.source.anilist')]], _wrapped.source);
  const kind = alMode ? _wSegmented(t('wrapped.kindLabel'), 'kind', 'kind', [['manga', t('wrapped.kind.manga')], ['anime', t('wrapped.kind.anime')]], _wrapped.kind) : '';
  const yearSelect = activePeriod === 'year' && w ? _wYearSelectHtml(w, alMode) : '';

  const hiddenCount = Object.keys(_wrapped.hidden).length;
  const canShare = !!(w && (alMode ? w.al.titles > 0 : ((w.reading && w.reading.chapters) || (w.anime && w.anime.episodes))));
  const privacy = `<label class="wrapped-toggle"><input type="checkbox" id="wrappedHideNsfw" data-wrapped-action="nsfw"${_wrapped.hideNsfw ? ' checked' : ''}><span>${escapeHtml(t('wrapped.hideAdult'))}</span></label>`
    + (hiddenCount ? `<button class="wrapped-link" data-wrapped-action="toggle-hidden">${escapeHtml(_wt('wrapped.hiddenTitles', { n: hiddenCount }))}</button>` : '')
    + (alMode ? `<button class="wrapped-link" data-wrapped-action="al-refresh">${escapeHtml(t('wrapped.al.refresh'))}</button>` : '')
    + (canShare ? `<button class="btn secondary wrapped-share-btn" data-wrapped-action="share">${escapeHtml(t('wrapped.share'))}</button>` : '');
  return `<div class="wrapped-toolbar">${source}${kind}${periods}${yearSelect}<div class="wrapped-privacy">${privacy}</div></div>`
    + `<div class="wrapped-hidden-list hidden" id="wrappedHiddenList">${_wHiddenListHtml()}</div>`;
}

function _wHiddenListHtml() {
  const entries = Object.entries(_wrapped.hidden);
  if (!entries.length) return '';
  return `<p class="wrapped-note">${escapeHtml(t('wrapped.hiddenNote'))}</p><ul>${entries.map(([key, name]) => `<li><span>${escapeHtml(name || key)}</span><button class="wrapped-link" data-wrapped-action="show" data-key="${escapeHtml(key)}">${escapeHtml(t('wrapped.showAgain'))}</button></li>`).join('')}</ul>`;
}

function _wBars(items, labelOf, valueOf, shareOf) {
  const max = Math.max(1, ...items.map(valueOf));
  return `<ul class="wrapped-bar-list">${items.map((it) => `<li><span class="wrapped-bar-label">${escapeHtml(labelOf(it))}</span><span class="wrapped-bar-track"><i style="width:${Math.max(2, Math.round((valueOf(it) / max) * 100))}%"></i></span><span class="wrapped-bar-value">${escapeHtml(shareOf(it))}</span></li>`).join('')}</ul>`;
}

function _wColumns(values, labels, titleOf) {
  const max = Math.max(1, ...values);
  return `<div class="wrapped-columns">${values.map((v, i) => `<div class="wrapped-column" title="${escapeHtml(titleOf(i, v))}"><i style="height:${v ? Math.max(4, Math.round((v / max) * 100)) : 0}%"${v ? ` data-value="${escapeHtml(_wNum(v))}"` : ''}></i><span>${escapeHtml(labels[i])}</span></div>`).join('')}</div>`;
}

function _wrappedHtml(w) {
  const r = w.reading || {};
  const a = w.anime || {};
  const act = w.activity || {};
  const lib = w.library || {};
  const empty = !r.chapters && !a.episodes;
  const parts = [];

  if (w.coverage?.partial && w.coverage.detailedSince) {
    parts.push(`<p class="wrapped-notice">${escapeHtml(_wt('wrapped.partial', { date: _wDate(w.coverage.detailedSince) }))}</p>`);
  }
  const unknownAdult = (r.topManga || []).filter((m) => m.nsfw === null).length;
  if (_wrapped.hideNsfw && unknownAdult) {
    parts.push(`<p class="wrapped-notice">${escapeHtml(_wt('wrapped.unknownAdult', { n: unknownAdult }))}</p>`);
  }
  const hiddenAdult = w.filters?.hidden?.nsfw || 0;
  if (hiddenAdult) parts.push(`<p class="wrapped-note">${escapeHtml(_wt('wrapped.hiddenAdult', { n: hiddenAdult }))}</p>`);

  if (empty) {
    parts.push(`<div class="wrapped-empty">${escapeHtml(t('wrapped.empty'))}</div>`);
    return parts.join('');
  }

  const subline = [
    r.minutes ? `${formatTime(r.minutes)} ${t('wrapped.readingTime')}` : '',
    r.titles ? _wt('wrapped.nTitles', { n: _wNum(r.titles) }) : '',
    a.episodes ? _wt('wrapped.nEpisodes', { n: _wNum(a.episodes) }) : '',
  ].filter(Boolean).join(' · ');
  parts.push(`<section class="wrapped-hero"><div class="wrapped-hero-label">${escapeHtml(w.period?.label || '')}</div><div class="wrapped-hero-number">${_wNum(r.chapters)}<small>${escapeHtml(t('wrapped.heroChapters'))}</small></div>${subline ? `<div class="wrapped-hero-sub">${escapeHtml(subline)}</div>` : ''}</section>`);

  const kpis = [
    [t('wrapped.kpi.activeDays'), _wNum(act.activeDays), act.currentStreak ? _wt('wrapped.currentStreak', { n: act.currentStreak }) : ''],
    [t('wrapped.kpi.bestDay'), act.bestDay ? _wNum(act.bestDay.count) : '—', act.bestDay ? _wDate(act.bestDay.day) : ''],
    [t('wrapped.kpi.streak'), act.longestStreak ? _wt('wrapped.days', { n: act.longestStreak }) : '—', ''],
    [t('wrapped.kpi.perDay'), r.avgChaptersPerActiveDay ? String(r.avgChaptersPerActiveDay) : '—', r.avgMinutesPerActiveDay ? `${formatTime(r.avgMinutesPerActiveDay)}` : ''],
  ];
  parts.push(`<div class="wrapped-kpis">${kpis.map(([label, value, hint]) => `<div class="wrapped-kpi"><div class="wrapped-kpi-label">${escapeHtml(label)}</div><div class="wrapped-kpi-value">${escapeHtml(value)}</div>${hint ? `<div class="wrapped-kpi-hint">${escapeHtml(hint)}</div>` : ''}</div>`).join('')}</div>`);

  const cards = [];
  if ((r.topGenres || []).length) {
    cards.push(`<section class="wrapped-card wrapped-card--wide"><h3>${escapeHtml(t('wrapped.topGenres'))}</h3>${_wBars(r.topGenres, (g) => g.genre, (g) => g.chapters, (g) => `${Math.round(g.share * 100)}%`)}<p class="wrapped-note">${escapeHtml(_wt('wrapped.genreCoverage', { a: r.genreCoverage?.titlesWithGenres || 0, b: r.genreCoverage?.titles || 0 }))}</p></section>`);
  }
  if ((r.topManga || []).length) {
    cards.push(`<section class="wrapped-card wrapped-card--wide"><h3>${escapeHtml(t('wrapped.topManga'))}</h3><ol class="wrapped-list">${r.topManga.map((m, i) => `<li>${_wRank(i)}${_wCover(m.cover, m.title)}<span class="wrapped-item"><b>${escapeHtml(m.title)}</b><small>${escapeHtml([_wt('wrapped.nChapters', { n: _wNum(m.chapters) }), m.minutes ? formatTime(m.minutes) : '', m.rating ? `★ ${m.rating}` : ''].filter(Boolean).join(' · '))}</small></span><button class="wrapped-hide" data-wrapped-action="hide" data-key="${escapeHtml(m.key)}" data-title="${escapeHtml(m.title)}" title="${escapeHtml(t('wrapped.hideTitle'))}" aria-label="${escapeHtml(t('wrapped.hideTitle'))}">⊘</button></li>`).join('')}</ol></section>`);
  }
  if ((r.topAuthors || []).length) {
    cards.push(`<section class="wrapped-card"><h3>${escapeHtml(t('wrapped.topAuthors'))}</h3><ol class="wrapped-list wrapped-list--compact">${r.topAuthors.map((x, i) => `<li>${_wRank(i)}<span class="wrapped-item"><b>${escapeHtml(x.author)}</b><small>${escapeHtml(_wt('wrapped.nChapters', { n: _wNum(x.chapters) }))}</small></span></li>`).join('')}</ol></section>`);
  }
  if ((a.topAnime || []).length) {
    cards.push(`<section class="wrapped-card"><h3>${escapeHtml(t('wrapped.topAnime'))}</h3><ol class="wrapped-list">${a.topAnime.slice(0, 5).map((x, i) => `<li>${_wRank(i)}${_wCover(x.cover, x.title)}<span class="wrapped-item"><b>${escapeHtml(x.title)}</b><small>${escapeHtml([_wt('wrapped.nEpisodes', { n: _wNum(x.episodes) }), x.minutes ? formatTime(x.minutes) : ''].filter(Boolean).join(' · '))}</small></span></li>`).join('')}</ol></section>`);
  }

  const weekdayNames = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i, 12).toLocaleDateString(typeof currentLanguage === 'string' ? currentLanguage : undefined, { weekday: 'short' }));
  const week = r.byWeekday || [];
  const months = Object.keys(r.byMonth || {}).sort();
  let consistency = '';
  if (week.some((n) => n > 0)) consistency += `<h4>${escapeHtml(t('wrapped.weekday'))}</h4>${_wColumns(week, weekdayNames, (i, v) => `${weekdayNames[i]}: ${_wt('wrapped.nChapters', { n: v })}`)}`;
  if (months.length > 1) {
    consistency += `<h4>${escapeHtml(t('wrapped.byMonth'))}</h4>${_wColumns(months.map((m) => r.byMonth[m]), months.map((m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1, 12).toLocaleDateString(typeof currentLanguage === 'string' ? currentLanguage : undefined, { month: 'short' }); }), (i, v) => `${months[i]}: ${_wt('wrapped.nChapters', { n: v })}`)}`;
  }
  if (consistency) cards.push(`<section class="wrapped-card wrapped-card--wide"><h3>${escapeHtml(t('wrapped.consistency'))}</h3>${consistency}</section>`);

  const finished = lib.finished || {};
  const rated = lib.rated || {};
  if (finished.count || rated.count) {
    let body = '';
    if (finished.count) body += `<h4>${escapeHtml(t('wrapped.finished'))} · ${_wNum(finished.count)}</h4><ul class="wrapped-plain">${(finished.titles || []).slice(0, 5).map((x) => `<li>${escapeHtml(x.title)}</li>`).join('')}</ul>`;
    if (rated.count) body += `<h4>${escapeHtml(t('wrapped.rated'))} · ${escapeHtml(_wt('wrapped.avgRating', { n: rated.average }))}</h4><ul class="wrapped-plain">${(rated.top || []).slice(0, 5).map((x) => `<li>${escapeHtml(x.title)} <b>★ ${escapeHtml(x.rating)}</b></li>`).join('')}</ul>`;
    cards.push(`<section class="wrapped-card"><h3>${escapeHtml(t('wrapped.library'))}</h3>${body}</section>`);
  }

  parts.push(`<div class="wrapped-grid">${cards.join('')}</div>`);
  return parts.join('');
}

// ── behaviour ───────────────────────────────────────────────────────────────

// What a click or a change on the page does: `d` is the element's dataset (data-wrapped-action and the data-* beside it).
function _wrappedAction(d, value) {
  switch (d.wrappedAction) {
    case 'period':
      if (!WRAPPED_PERIOD_IDS.includes(d.period)) return;
      _wrapped.period = d.period;
      _wrappedLsSet(WRAPPED_KEYS.period, d.period);
      renderWrappedTab();
      return;
    case 'source':
      if (d.source !== 'app' && d.source !== 'anilist') return;
      _wrapped.source = d.source;
      _wrappedLsSet(WRAPPED_KEYS.source, d.source);
      renderWrappedTab();
      return;
    case 'kind':
      if (d.kind !== 'manga' && d.kind !== 'anime') return;
      _wrapped.kind = d.kind;
      _wrappedLsSet(WRAPPED_KEYS.kind, d.kind);
      renderWrappedTab();
      return;
    case 'open-manga':
    case 'open-anime':
    case 'open-author':
      if (typeof wrappedOpenItem === 'function') wrappedOpenItem(d);
      return;
    case 'al-refresh':
      _wrapped.alForce = true; // read the list again instead of the copy kept for a few minutes
      renderWrappedTab();
      return;
    case 'year': {
      const y = Number.parseInt(value, 10);
      if (!Number.isInteger(y)) return;
      _wrapped.year = y;
      _wrappedLsSet(WRAPPED_KEYS.year, String(y));
      renderWrappedTab();
      return;
    }
    case 'nsfw':
      _wrapped.hideNsfw = !!value;
      _wrappedLsSet(WRAPPED_KEYS.hideNsfw, value ? '1' : '0');
      renderWrappedTab();
      return;
    case 'hide':
      if (!d.key) return;
      _wrapped.hidden[d.key] = d.title || d.key;
      _wrappedLsSet(WRAPPED_KEYS.hidden, JSON.stringify(_wrapped.hidden));
      renderWrappedTab();
      return;
    case 'show':
      delete _wrapped.hidden[d.key];
      _wrappedLsSet(WRAPPED_KEYS.hidden, JSON.stringify(_wrapped.hidden));
      renderWrappedTab();
      return;
    case 'toggle-hidden': {
      const list = document.getElementById('wrappedHiddenList');
      if (list) list.classList.toggle('hidden');
      return;
    }
    case 'share':
      if (typeof openWrappedShare === 'function') openWrappedShare();
      return;
    case 'retry':
      renderWrappedTab();
  }
}

async function renderWrappedTab() {
  const root = document.getElementById('analyticsWrapped');
  if (!root) return;
  _wrappedLoadPrefs();
  const seq = ++_wrapped.seq;
  if (_wrapped.source === 'anilist') { await renderWrappedAniListTab(root, seq); return; }
  const previous = _wrapped.data;
  root.innerHTML = `<div class="wrapped">${_wToolbarHtml(previous)}<div class="wrapped-body wrapped-body--loading">${escapeHtml(t('wrapped.loading'))}</div></div>`;
  try {
    const res = await api(`/api/analytics/wrapped?${_wrappedQuery()}`);
    if (seq !== _wrapped.seq) return; // a newer request has taken over
    _wrapped.data = res.wrapped;
    _wrapped.shown = res.wrapped;
    root.innerHTML = `<div class="wrapped">${_wToolbarHtml(res.wrapped)}<div class="wrapped-body">${_wrappedHtml(res.wrapped)}</div></div>`;
    root.querySelectorAll('.wrapped-cover img').forEach((img) => img.addEventListener('error', () => img.remove()));
  } catch (e) {
    if (seq !== _wrapped.seq) return;
    dbg.warn(dbg.ERR_ANALYTICS, 'Wrapped could not load', e);
    root.innerHTML = `<div class="wrapped">${_wToolbarHtml(previous)}<div class="wrapped-body"><div class="wrapped-empty">${escapeHtml(_wt('wrapped.error', { message: e.message || '' }))} <button class="wrapped-link" data-wrapped-action="retry">${escapeHtml(t('wrapped.retry'))}</button></div></div></div>`;
  }
}

// The tabs of the Analytics page (Overview | Wrapped). Called every time the page opens: it keeps the tab that was open.
function bindAnalyticsTabs() {
  const root = document.getElementById('analyticsWrapped');
  const overview = document.getElementById('analyticsOverview');
  const nav = document.getElementById('analyticsTabs');
  if (!root || !overview || !nav) return;

  const show = (tab) => {
    _wrapped.tab = tab === 'wrapped' ? 'wrapped' : 'overview';
    overview.classList.toggle('hidden', _wrapped.tab !== 'overview');
    root.classList.toggle('hidden', _wrapped.tab !== 'wrapped');
    nav.querySelectorAll('[data-analytics-tab]').forEach((b) => {
      const on = b.dataset.analyticsTab === _wrapped.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
    if (_wrapped.tab === 'wrapped') renderWrappedTab();
  };

  nav.onclick = (e) => {
    const b = e.target.closest('[data-analytics-tab]');
    if (b) show(b.dataset.analyticsTab);
  };
  root.onclick = (e) => {
    const el = e.target.closest('[data-wrapped-action]');
    if (el && el.tagName !== 'SELECT' && el.type !== 'checkbox') _wrappedAction(el.dataset);
  };
  root.onchange = (e) => {
    const el = e.target.closest('[data-wrapped-action]');
    if (!el) return;
    _wrappedAction(el.dataset, el.type === 'checkbox' ? el.checked : el.value);
  };
  show(_wrapped.tab);
}
