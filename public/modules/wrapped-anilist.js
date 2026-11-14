// ============================================================================
// WRAPPED → THE ANILIST VIEW (data)
//
// The Wrapped tab can show the numbers on the person's AniList list instead of the ones this app recorded. Two halves, so the second can
// be tested without a network:
//   wrappedAniListFetch(kind)         reads the whole list (manga or anime) and, apart, the staff / studio statistics, from AniList.
//   wrappedAniListBuild(raw, options) works out everything the page and the share cards show, from what was read.
//
// What AniList can and cannot say (checked against its schema): it knows each title's progress, score, status, genres, format and the
// day it was started and finished. It does NOT know when each chapter was read, so there is no per-day anything here (no streaks, no
// weekdays, no "last 7 days") and no reading time for manga. A "year" is therefore the titles FINISHED that year, and the page says so.
//
// Read-only: nothing is ever written to AniList from here. The token stays in this browser; the list goes through this app's own
// /api/anilist proxy, which keeps AniList's rate limit. The result is kept in memory for a few minutes (a click on a period or a
// "hide this title" must not read the whole list again) and never written to disk.
// ============================================================================

const WRAPPED_AL_CHUNK = 100;           // list entries per request
const WRAPPED_AL_MAX_CHUNKS = 20;       // 2000 titles; a longer list is cut and the page says so
const WRAPPED_AL_CACHE_MS = 10 * 60 * 1000;
const WRAPPED_AL_PEOPLE_LIMIT = 25;     // AniList's own top by number of titles; the ranking here is re-worked on what is shown
const WRAPPED_AL_TOP = 10;
const WRAPPED_AL_ADULT_GENRES = Object.freeze(['hentai']);
// PLANNING has no progress. Everything else counts as read / watched.
const WRAPPED_AL_COUNTED = new Set(['CURRENT', 'COMPLETED', 'PAUSED', 'DROPPED', 'REPEATING']);
const WRAPPED_AL_STATUSES = Object.freeze(['CURRENT', 'REPEATING', 'COMPLETED', 'PAUSED', 'DROPPED', 'PLANNING']);

const _wrappedAlCache = new Map(); // kind -> { at, raw }

const WRAPPED_AL_ENTRIES_QUERY = `query ($userId: Int, $type: MediaType, $chunk: Int, $perChunk: Int) {
  MediaListCollection(userId: $userId, type: $type, chunk: $chunk, perChunk: $perChunk) {
    hasNextChunk
    lists { entries {
      mediaId status progress progressVolumes score(format: POINT_10_DECIMAL)
      completedAt { year month day }
      media { id idMal format episodes chapters duration isAdult genres title { userPreferred romaji english native } coverImage { large } }
    } }
  }
}`;
const WRAPPED_AL_PEOPLE_QUERY = {
  manga: `query ($userId: Int) { User(id: $userId) { statistics { manga { staff(limit: ${WRAPPED_AL_PEOPLE_LIMIT}, sort: COUNT_DESC) { mediaIds staff { name { full } } } } } } }`,
  anime: `query ($userId: Int) { User(id: $userId) { statistics { anime { studios(limit: ${WRAPPED_AL_PEOPLE_LIMIT}, sort: COUNT_DESC) { mediaIds studio { name isAnimationStudio } } } } } }`,
};

// The same normalisation the server uses for a hidden title, so what is hidden on the "This app" view is hidden here too.
function wrappedTitleKey(value) {
  return String(value ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

function _walNotConnected() {
  const e = new Error('AniList is not connected');
  e.code = 'not-connected';
  return e;
}

async function _walUserId() {
  const saved = Number(_alUser()?.id || 0);
  if (saved) return saved;
  const viewer = await anilistFetchViewer();
  if (!viewer?.id) throw _walNotConnected();
  return Number(viewer.id);
}

function _walCheck(data) {
  if (data?.errors?.length) throw new Error(data.errors[0]?.message || 'AniList could not answer');
  if (!data?.data) throw new Error('AniList sent an answer this page does not understand');
}

async function _walFetchEntries(userId, kind) {
  const entries = [];
  const seen = new Set();
  let cut = false;
  for (let chunk = 1, more = true; more; chunk++) {
    if (chunk > WRAPPED_AL_MAX_CHUNKS) { cut = true; break; }
    const data = await anilistGQL(WRAPPED_AL_ENTRIES_QUERY, { userId, type: kind === 'anime' ? 'ANIME' : 'MANGA', chunk, perChunk: WRAPPED_AL_CHUNK });
    _walCheck(data);
    const collection = data.data.MediaListCollection;
    for (const list of (collection?.lists || [])) {
      for (const entry of (list?.entries || [])) {
        const id = Number(entry?.mediaId || 0);
        if (!id || seen.has(id) || !entry.media) continue; // a title also sits in each custom list the person made
        seen.add(id);
        entries.push(entry);
      }
    }
    more = collection?.hasNextChunk === true;
  }
  return { entries, cut };
}

// The people behind the titles (manga: staff, anime: animation studios). Not essential: the page works without them.
async function _walFetchPeople(userId, kind) {
  try {
    const data = await anilistGQL(WRAPPED_AL_PEOPLE_QUERY[kind], { userId });
    _walCheck(data);
    const stats = data.data.User?.statistics?.[kind];
    if (kind === 'anime') {
      return (stats?.studios || []).filter((s) => s?.studio?.isAnimationStudio).map((s) => ({ name: s.studio.name, mediaIds: s.mediaIds || [] }));
    }
    return (stats?.staff || []).map((s) => ({ name: s?.staff?.name?.full, mediaIds: s.mediaIds || [] })).filter((p) => p.name);
  } catch (_) {
    return [];
  }
}

async function wrappedAniListFetch(kind, { force = false } = {}) {
  const key = kind === 'anime' ? 'anime' : 'manga';
  const cached = _wrappedAlCache.get(key);
  if (!force && cached && Date.now() - cached.at < WRAPPED_AL_CACHE_MS) return cached.raw;
  if (!_alToken()) throw _walNotConnected();
  const userId = await _walUserId();
  const { entries, cut } = await _walFetchEntries(userId, key);
  const people = await _walFetchPeople(userId, key);
  const raw = { kind: key, entries, people, cut };
  _wrappedAlCache.set(key, { at: Date.now(), raw });
  return raw;
}

function wrappedAniListForget() { _wrappedAlCache.clear(); }

// ── the numbers ─────────────────────────────────────────────────────────────

const _walNum = (n) => Number(n || 0).toLocaleString(typeof currentLanguage === 'string' ? currentLanguage : undefined);
const _walRound1 = (n) => Math.round(n * 10) / 10;
function _walT(key, vars) {
  let text = t(key);
  for (const [k, v] of Object.entries(vars || {})) text = text.split(`{${k}}`).join(String(v));
  return text;
}

function _walDay(date) {
  if (!date || !Number.isInteger(date.year)) return '';
  const part = (n) => String(Number.isInteger(n) && n > 0 ? n : 1).padStart(2, '0');
  return `${date.year}-${part(date.month)}-${part(date.day)}`;
}

// One list entry as the page needs it, or null when it cannot be shown.
function _walEntry(raw, kind) {
  const media = raw && raw.media;
  const mediaId = Number(raw?.mediaId || media?.id || 0);
  if (!media || !mediaId) return null;
  const names = media.title || {};
  const title = names.userPreferred || names.english || names.romaji || names.native || '';
  if (!title) return null;
  const status = String(raw.status || '');
  const progress = Math.max(0, Math.floor(Number(raw.progress) || 0));
  const total = Number(kind === 'anime' ? media.episodes : media.chapters) || 0;
  return {
    mediaId,
    idMal: Number(media.idMal) || 0,
    title,
    keys: [names.userPreferred, names.english, names.romaji, names.native].filter(Boolean).map(wrappedTitleKey).filter(Boolean),
    status,
    units: progress || (status === 'COMPLETED' ? total : 0), // a title marked completed without a number counts as the whole title
    volumes: Math.max(0, Math.floor(Number(raw.progressVolumes) || 0)),
    score: Math.max(0, Number(raw.score) || 0),
    duration: Math.max(0, Number(media.duration) || 0),
    format: String(media.format || ''),
    genres: Array.isArray(media.genres) ? media.genres : [],
    adult: media.isAdult === true,
    cover: media.coverImage?.large || '',
    finishedDay: status === 'COMPLETED' ? _walDay(raw.completedAt) : '',
  };
}

// Share of the units read in titles tagged with each genre (a title has several, so the shares do not add up to 100).
function _walGenres(titles, skip) {
  const totals = new Map();
  let base = 0;
  for (const e of titles) {
    const names = new Map();
    for (const raw of e.genres) { const n = String(raw).trim(); if (n && !skip.has(n.toLowerCase())) names.set(n.toLowerCase(), n); }
    if (!names.size) continue;
    base += e.units;
    for (const [lower, shown] of names) {
      const g = totals.get(lower) || { genre: shown, units: 0, titles: 0 };
      g.units += e.units; g.titles++;
      totals.set(lower, g);
    }
  }
  return [...totals.values()]
    .sort((a, b) => b.units - a.units || b.titles - a.titles || a.genre.localeCompare(b.genre))
    .slice(0, 8)
    .map((g) => ({ ...g, share: base ? Math.round((g.units / base) * 1000) / 1000 : 0 }));
}

// AniList names the people with the ids of the titles they worked on: the ranking is re-made on the titles that are shown.
function _walPeople(people, titles) {
  const unitsById = new Map(titles.map((e) => [e.mediaId, e.units]));
  return (people || []).map((p) => {
    const ids = (p.mediaIds || []).map(Number).filter((id) => unitsById.has(id));
    return { name: p.name, units: ids.reduce((n, id) => n + unitsById.get(id), 0), titles: ids.length };
  }).filter((p) => p.units > 0).sort((a, b) => b.units - a.units || a.name.localeCompare(b.name)).slice(0, 5);
}

function _walFinishedBy(titles, period, year) {
  const counts = new Map();
  for (const e of titles) {
    if (!e.finishedDay) continue;
    const key = period === 'year' ? e.finishedDay.slice(0, 7) : e.finishedDay.slice(0, 4);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (period === 'year') {
    return Array.from({ length: 12 }, (_, i) => { const key = `${year}-${String(i + 1).padStart(2, '0')}`; return { key, count: counts.get(key) || 0 }; });
  }
  if (!counts.size) return [];
  const years = [...counts.keys()].map(Number);
  const first = Math.min(...years);
  const last = Math.max(...years);
  // every year in between, even one with nothing: a gap in the axis would read as a mistake
  return Array.from({ length: last - first + 1 }, (_, i) => { const key = String(first + i); return { key, count: counts.get(key) || 0 }; });
}

function _walCardStats(kind, al) {
  const score = { label: t('wrapped.card.meanScore'), value: al.meanScore ? String(al.meanScore) : '—' };
  const titles = { label: t('wrapped.card.titles'), value: _walNum(al.titles) };
  const time = kind === 'anime'
    ? { label: t('wrapped.card.watchTime'), value: al.minutes && typeof formatTime === 'function' ? formatTime(al.minutes) : '—' }
    : { label: t('wrapped.card.volumes'), value: al.volumes ? _walNum(al.volumes) : '—' };
  return [time, titles, score];
}

// What the share card shows, already in words (the card module only draws it).
function _walCard(kind, al, hero, periodLabel) {
  const unitText = t(kind === 'anime' ? 'wrapped.nEpisodes' : 'wrapped.nChapters');
  const top = al.top.map((x, i) => ({
    rank: i + 1,
    title: x.title,
    detail: [unitText.split('{n}').join(_walNum(x.units)), x.score ? `★ ${x.score}` : ''].filter(Boolean).join(' · '),
    cover: x.cover,
  }));
  const people = al.people.map((x, i) => ({ rank: i + 1, title: x.name, detail: unitText.split('{n}').join(_walNum(x.units)), cover: '' }));
  return {
    number: _walNum(hero.number),
    unit: hero.unit,
    periodText: _walT('wrapped.card.periodAniList', { period: periodLabel }),
    stats: _walCardStats(kind, al),
    topTitle: t(kind === 'anime' ? 'wrapped.card.topAnime' : 'wrapped.card.topManga'),
    peopleTitle: t(kind === 'anime' ? 'wrapped.card.topStudios' : 'wrapped.card.topAuthors'),
    top,
    people,
    genres: al.genres.map((g) => ({ label: g.genre, share: g.share, text: `${Math.round(g.share * 100)}%` })),
  };
}

function _walHeroUnit(kind, period) {
  if (period === 'year') return t(kind === 'anime' ? 'wrapped.al.heroFinishedEpisodes' : 'wrapped.al.heroFinishedChapters');
  return t(kind === 'anime' ? 'wrapped.heroEpisodes' : 'wrapped.heroChapters');
}

// Everything the AniList view shows. `raw` is what wrappedAniListFetch returns. options:
//   kind 'manga' | 'anime', period 'all' | 'year' (+ year), hideNsfw, excludeGenres[], excludeTitles[] (title keys), now
function wrappedAniListBuild(raw, options = {}) {
  const kind = options.kind === 'anime' ? 'anime' : 'manga';
  const period = options.period === 'year' ? 'year' : 'all';
  const now = options.now || new Date();
  const year = period === 'year' ? (Number.isInteger(options.year) ? options.year : now.getFullYear()) : null;
  const hiddenKeys = new Set((options.excludeTitles || []).map(String));
  const skipGenres = new Set([...(options.excludeGenres || []), ...(options.hideNsfw ? WRAPPED_AL_ADULT_GENRES : [])].map((g) => String(g).trim().toLowerCase()).filter(Boolean));
  const hidden = { nsfw: 0, excluded: 0 };

  const byId = new Map();
  for (const item of (raw?.entries || [])) {
    const e = _walEntry(item, kind);
    if (!e || byId.has(e.mediaId)) continue;
    if (options.hideNsfw === true && e.adult) { hidden.nsfw++; continue; }
    if (e.keys.some((k) => hiddenKeys.has(k))) { hidden.excluded++; continue; }
    byId.set(e.mediaId, e);
  }
  const shown = [...byId.values()];
  const years = [...new Set(shown.filter((e) => e.finishedDay).map((e) => Number(e.finishedDay.slice(0, 4))))].sort((a, b) => b - a);
  const counted = shown.filter((e) => WRAPPED_AL_COUNTED.has(e.status) && e.units > 0
    && (period === 'all' || (e.finishedDay && Number(e.finishedDay.slice(0, 4)) === year)));

  const units = counted.reduce((n, e) => n + e.units, 0);
  const scored = counted.filter((e) => e.score > 0);
  const top = [...counted].sort((a, b) => b.units - a.units || b.score - a.score || a.title.localeCompare(b.title)).slice(0, WRAPPED_AL_TOP)
    .map((e) => ({ mediaId: e.mediaId, idMal: e.idMal, title: e.title, key: wrappedTitleKey(e.title), units: e.units, score: e.score ? _walRound1(e.score) : 0, cover: e.cover, format: e.format }));
  const formats = new Map();
  for (const e of counted) if (e.format) formats.set(e.format, (formats.get(e.format) || 0) + 1);
  const scores = Array.from({ length: 10 }, () => 0);
  for (const e of scored) scores[Math.min(10, Math.max(1, Math.round(e.score))) - 1]++;
  const statuses = {};
  if (period === 'all') for (const s of WRAPPED_AL_STATUSES) statuses[s] = shown.filter((e) => e.status === s).length;

  const al = {
    kind,
    units,
    titles: counted.length,
    completed: counted.filter((e) => e.status === 'COMPLETED').length,
    volumes: counted.reduce((n, e) => n + e.volumes, 0),
    minutes: kind === 'anime' ? counted.reduce((n, e) => n + e.units * e.duration, 0) : 0,
    meanScore: scored.length ? _walRound1(scored.reduce((n, e) => n + e.score, 0) / scored.length) : 0,
    scoredTitles: scored.length,
    top,
    genres: _walGenres(counted, skipGenres),
    people: _walPeople(raw?.people, counted),
    statuses,
    scores,
    formats: [...formats].map(([format, count]) => ({ format, count })).sort((a, b) => b.count - a.count || a.format.localeCompare(b.format)),
    finishedBy: _walFinishedBy(counted, period, year),
    finished: counted.filter((e) => e.finishedDay).sort((a, b) => b.finishedDay.localeCompare(a.finishedDay)).slice(0, 5).map((e) => ({ mediaId: e.mediaId, idMal: e.idMal, title: e.title, day: e.finishedDay })),
    rated: [...scored].sort((a, b) => b.score - a.score || b.units - a.units).slice(0, 5).map((e) => ({ mediaId: e.mediaId, idMal: e.idMal, title: e.title, rating: _walRound1(e.score) })),
    years,
    cut: raw?.cut === true,
  };
  const label = period === 'year' ? String(year) : t('wrapped.period.all');
  const hero = { number: units, unit: _walHeroUnit(kind, period) };
  return {
    source: 'anilist',
    kind,
    generatedAt: now.toISOString(),
    period: { id: period, year, label },
    filters: { hideNsfw: options.hideNsfw === true, hidden },
    hero,
    al,
    card: _walCard(kind, al, hero, label),
  };
}
