// ============================================================================
// SETTINGS > ADVANCED > "IMPORT A SOURCE" CARD — THE MANGA | ANIME SWITCH
// ============================================================================
// The card imports a manga source by default. This adds a switch: in "Anime" mode the same text box, Check and Install talk to the anime
// routes (server/routes/anime-source-import.js) instead, the manga-only "Add from a link" block and the manga list are hidden, and the
// anime sources imported earlier are listed with Uninstall. Nothing of the card's own logic is copied: it asks every request through
// animeSourceRequest(), which only changes WHICH route a request goes to, and a click on Uninstall in the anime list is the card's own
// (data-si-action="uninstall").
//
// Each imported anime source has a Test button: the card's own (data-si-action="test"), its request sent to the anime route, its result
// shown in the box under the row by the card's own renderer. It follows a stream through the relay of the app and plays nothing.
//
// A source that was just installed is switched on in Settings > Anime Sources: the person installed it on purpose, so it should not
// sit there unticked. It goes after the others, so it never changes which source is tried first. One that was uninstalled is taken out
// of that saved list again.
//
// Loaded after ui-settings-source-import.js, which calls animeSourceRequest(), mountAnimeSourceMode() and refreshAnimeSourceList() when
// they exist; the card works without this file.

const ANIME_SOURCE_ROUTES = Object.freeze({
  '/api/sources/import/preview': '/api/anime/sources/import/preview',
  '/api/sources/import/install': '/api/anime/sources/import/install',
  '/api/sources/uninstall': '/api/anime/sources/uninstall',
  '/api/sources/import/test': '/api/anime/sources/import/test',
});
const ANIME_SOURCE_PROVIDERS_ENDPOINT = '/api/anime/providers';
const ANIME_SOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

const animeSourceKnown = new WeakMap(); // card -> Set of the ids that were imported when it last looked

const animeSourceKind = (card) => (card.getAttribute('data-source-kind') === 'anime' ? 'anime' : 'manga');

/** The request function the card uses: in anime mode the three routes of the card go to their anime twins; the rest is untouched. */
function animeSourceRequest(card, request) {
  return (route, options) => request(animeSourceKind(card) === 'anime' && ANIME_SOURCE_ROUTES[route] ? ANIME_SOURCE_ROUTES[route] : route, options);
}

/** The anime sources that were imported, out of the answer of GET /api/anime/providers: [{ id, name }]. */
function animeSourceNormalizeImported(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.providers) ? raw.providers : [];
  return list
    .filter((p) => p && typeof p === 'object' && p.origin === 'imported' && ANIME_SOURCE_ID_RE.test(String(p.id)))
    .map((p) => ({ id: String(p.id), name: String(p.name || p.id).slice(0, 80) }));
}

/** The ids in `list` the card had not seen before. */
const animeSourceNewIds = (known, list) => list.map((s) => s.id).filter((id) => !known.has(id));

function buildAnimeSourceModeHtml() {
  const button = (kind, key, pressed) => `<button type="button" class="btn ${pressed ? 'primary' : 'secondary'}" data-source-kind-btn="${kind}" aria-pressed="${pressed}">${sourceImportText(key)}</button>`;
  return `<div class="setting-group source-kind-group">
    <span class="source-import-subtitle" id="sourceKindLabel">${sourceImportText('settings.sourceAnime.kindLabel')}</span>
    <div class="source-kind-switch" role="group" aria-labelledby="sourceKindLabel">${button('manga', 'settings.sourceAnime.kindManga', true)}${button('anime', 'settings.sourceAnime.kindAnime', false)}</div>
    <p class="setting-description" id="sourceAnimeNote" hidden>${sourceImportText('settings.sourceAnime.note')}</p>
  </div>`;
}

/** The anime sources imported earlier, each with the card's own Uninstall; the names are text. */
function buildAnimeInstalledHtml(list) {
  const rows = (Array.isArray(list) ? list : []).map((s) => `<li class="source-import-imported-row">
    <span class="toggle-text">${escapeHtml(s.name)} <span class="setting-description">${escapeHtml(s.id)}</span></span>
    <span class="source-import-imported-actions">
      <button type="button" class="btn secondary" data-si-action="test" data-depth="basic" data-source-id="${escapeHtml(s.id)}" title="${escapeHtml(t('settings.sourceAnime.testHint'))}">${sourceImportText('settings.sourceImport.testButton')}</button>
      <button type="button" class="btn secondary" data-si-action="uninstall" data-source-id="${escapeHtml(s.id)}">${sourceImportText('settings.sourceImport.uninstallButton')}</button>
    </span>
    <div class="source-import-test-result" data-test-for="${escapeHtml(s.id)}" aria-live="polite"></div>
  </li>`);
  return `<p class="source-import-subtitle">${sourceImportText('settings.sourceAnime.installedTitle')}</p>`
    + (rows.length ? `<ul class="source-import-list">${rows.join('')}</ul>` : `<p class="muted">${sourceImportText('settings.sourceAnime.none')}</p>`);
}

/** Switches a just-installed source on in Settings > Anime Sources, after the ones already on. */
function animeSourceSwitchOn(ids) {
  if (!ids.length || typeof state === 'undefined' || !state.settings) return;
  const current = Array.isArray(state.settings.visibleAnimeProviders) && state.settings.visibleAnimeProviders.length
    ? state.settings.visibleAnimeProviders
    : (typeof DEFAULT_VISIBLE_ANIME_PROVIDERS !== 'undefined' ? DEFAULT_VISIBLE_ANIME_PROVIDERS : []);
  state.settings.visibleAnimeProviders = [...current, ...ids.filter((id) => !current.includes(id))];
  if (typeof saveSettings === 'function') saveSettings();
}

/** Takes a removed source out of Settings > Anime Sources, so the saved list does not keep an id that is gone. */
function animeSourceSwitchOff(ids) {
  const visible = typeof state !== 'undefined' && state.settings ? state.settings.visibleAnimeProviders : null;
  if (!ids.length || !Array.isArray(visible)) return;
  const kept = visible.filter((id) => !ids.includes(id));
  if (kept.length === visible.length) return;
  state.settings.visibleAnimeProviders = kept;
  if (typeof saveSettings === 'function') saveSettings();
}

/**
 * Reads the imported anime sources again and shows them. `announce` is false the first time (what was already imported is not new).
 * The player's own list is read again too, so a source that was added or removed is there (or gone) without a reload.
 */
async function refreshAnimeSourceList(card, { announce = true } = {}) {
  const box = card && card.querySelector ? card.querySelector('#sourceAnimeInstalled') : null;
  if (!box) return;
  let list = [];
  try { list = animeSourceNormalizeImported(await api(ANIME_SOURCE_PROVIDERS_ENDPOINT)); } catch (_) { return; }
  const known = animeSourceKnown.get(card) || new Set();
  if (announce) {
    animeSourceSwitchOn(animeSourceNewIds(known, list));
    animeSourceSwitchOff([...known].filter((id) => !list.some((s) => s.id === id)));
  }
  animeSourceKnown.set(card, new Set(list.map((s) => s.id)));
  // Nothing was added or removed: the list, and any test result shown in it, are left alone (the card asks again after every test).
  if (box.innerHTML && known.size === list.length && list.every((s) => known.has(s.id))) return;
  box.innerHTML = buildAnimeInstalledHtml(list);
  if (announce && typeof _animeLoadProviders === 'function') _animeLoadProviders();
}

function animeSourceSetKind(card, controller, kind) {
  card.setAttribute('data-source-kind', kind);
  const anime = kind === 'anime';
  const show = (id, on) => { const el = card.querySelector('#' + id); if (el) el.hidden = !on; };
  show('sourceAnimeNote', anime);
  show('sourceAnimeInstalled', anime);
  show('sourceLinkBlock', !anime);
  show('sourceCatalogBlock', !anime);
  const mangaList = card.querySelector('#sourceImportImported');
  if (mangaList && mangaList.parentElement) mangaList.parentElement.hidden = anime;
  card.querySelectorAll('[data-source-kind-btn]').forEach((b) => {
    const on = b.getAttribute('data-source-kind-btn') === kind;
    b.setAttribute('aria-pressed', String(on));
    b.className = `btn ${on ? 'primary' : 'secondary'}`;
  });
  // A report is about the kind it was checked as: a switch drops it (the text the person typed stays).
  controller.cancel();
}

/** Adds the switch and the anime list to the card. Never throws: the card must keep working without them. */
function mountAnimeSourceMode(card, controller) {
  try {
    const notice = card && card.querySelector('.source-import-notice');
    if (!notice || card.querySelector('#sourceAnimeInstalled')) return null;
    notice.insertAdjacentHTML('beforebegin', buildAnimeSourceModeHtml());
    notice.insertAdjacentHTML('afterend', '<div class="setting-group" id="sourceAnimeInstalled" hidden></div>');
    card.addEventListener('click', (e) => {
      const target = e.target && e.target.closest ? e.target.closest('[data-source-kind-btn]') : null;
      if (target && card.getAttribute('aria-busy') !== 'true') animeSourceSetKind(card, controller, target.getAttribute('data-source-kind-btn') === 'anime' ? 'anime' : 'manga');
    });
    refreshAnimeSourceList(card, { announce: false });
    return true;
  } catch (err) {
    if (typeof dbg !== 'undefined') dbg.warn(dbg.ERR_SETTINGS, 'Could not add the manga/anime switch to the import card', err);
    return null;
  }
}

window.animeSourceRequest = animeSourceRequest;
window.animeSourceNormalizeImported = animeSourceNormalizeImported;
window.animeSourceNewIds = animeSourceNewIds;
window.buildAnimeSourceModeHtml = buildAnimeSourceModeHtml;
window.buildAnimeInstalledHtml = buildAnimeInstalledHtml;
window.animeSourceSwitchOn = animeSourceSwitchOn;
window.animeSourceSwitchOff = animeSourceSwitchOff;
window.refreshAnimeSourceList = refreshAnimeSourceList;
window.mountAnimeSourceMode = mountAnimeSourceMode;
