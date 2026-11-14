// ============================================================================
// SETTINGS > ADVANCED > "IMPORT A SOURCE" CARD — THE SOURCE CATALOG BLOCK
// ============================================================================
// A list of the sites a public repository of Mihon-compatible extensions names, like the Extensions tab of that app: the person
// searches, filters by language, and chooses a site to add. ScrollScape does not run those extensions. For a site built on a
// theme it has a template for, choosing it hands the site to the "add from a link" block, which writes the source itself and puts
// the text through the card's own Check; nothing is installed until the person confirms there.
//
// The list is read from the server (server/modules/source-catalog/), which also works out, in the background, what each extension
// is built on and whether its site sits behind Cloudflare; this block asks again every few seconds while that is going on.
// The block is a <details>: nothing is asked of the network until the person opens it for the first time.
//
// Loaded after ui-settings-source-link.js, whose controller does the writing (runCatalog). The card works without this file.
//
// Layers: sourceCatalog<Step>(ctx) (the logic, over a view port, testable without a browser), createSourceCatalogController, then the
// thin DOM glue. Every value of an answer goes through sourceCatalogNormalize first: it is text, capped, and never markup.

const SOURCE_CATALOG_ENDPOINT = '/api/sources/catalog/list';
const SOURCE_CATALOG_PREFIX = 'sourceCatalog';
const SOURCE_CATALOG_BLOCK_ID = `${SOURCE_CATALOG_PREFIX}Block`;
// The block of the Advanced tab lives in a slot of that tab's card, with a prefix of its own.
const SOURCE_CATALOG_ADVANCED_PREFIX = 'advancedCatalog';
const SOURCE_CATALOG_ADVANCED_SLOT_ID = 'advancedCatalogSlot';
const SOURCE_CATALOG_PREFIX_RE = /^[A-Za-z][A-Za-z0-9]{2,30}$/;
const SOURCE_CATALOG_ICON_RE = /^https:\/\/cdn\.jsdelivr\.net\/[A-Za-z0-9._~%@/+-]{1,280}$/;
const SOURCE_CATALOG_SOURCE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SOURCE_CATALOG_KEY_RE = /^[a-z0-9._]{1,120}#\d{1,3}$/;
const SOURCE_CATALOG_LANG_RE = /^[A-Za-z]{2,4}(?:-[A-Za-z0-9]{2,8})?$/;
const SOURCE_CATALOG_WARNINGS = ['SAFE', 'MIXED', 'NSFW'];
const SOURCE_CATALOG_ENGINES = ['ready', 'later', 'handwritten', 'checking', 'unknown', 'failed'];
// How a row can be added: written from a template of the app ('native'), through the person's Suwayomi-Server ('engine'), looked at by the generator when
// chosen ('check': a site of a repository the person added), or not at all ('').
const SOURCE_CATALOG_VIAS = ['native', 'engine', 'check'];
const SOURCE_CATALOG_CLOUDFLARE = ['yes', 'no', 'unknown', 'checking', 'n/a'];
const SOURCE_CATALOG_PAGE = 60;
// The server reads the themes and the DNS in the background: ask again while it does, but not forever.
const SOURCE_CATALOG_POLL_MS = 4000;
const SOURCE_CATALOG_POLL_MAX = 45;
const SOURCE_CATALOG_QUERY_DELAY_MS = 350;
const SOURCE_CATALOG_ROWS_MAX = 120;
const SOURCE_CATALOG_LANGS_MAX = 40;

const sourceCatalogClean = (value, max) => String(value === undefined || value === null ? '' : value).slice(0, max);
const sourceCatalogInt = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.floor(Number(value)) : 0);

/** The answer of the list route as plain capped values. Nothing here is HTML. */
function sourceCatalogNormalize(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const pending = a.pending && typeof a.pending === 'object' ? a.pending : {};
  const rows = (Array.isArray(a.rows) ? a.rows : []).slice(0, SOURCE_CATALOG_ROWS_MAX).map((row) => {
    const r = row && typeof row === 'object' ? row : {};
    return {
      key: typeof r.key === 'string' && SOURCE_CATALOG_KEY_RE.test(r.key) ? r.key : '',
      name: sourceCatalogClean(r.name, 80),
      host: sourceCatalogClean(r.host, 120),
      // A logo only from where the repository keeps them (the server checks too): a plain https address with a path and nothing else.
      icon: typeof r.icon === 'string' && SOURCE_CATALOG_ICON_RE.test(r.icon) ? r.icon : '',
      lang: sourceCatalogClean(r.lang, 12),
      warning: SOURCE_CATALOG_WARNINGS.includes(r.warning) ? r.warning : 'MIXED',
      engine: SOURCE_CATALOG_ENGINES.includes(r.engine) ? r.engine : 'unknown',
      // An answer with no `via` is read as the server's earlier answers were: a site the app has a template for is added from it.
      via: SOURCE_CATALOG_VIAS.includes(r.via) ? r.via : (r.engine === 'ready' ? 'native' : ''),
      cloudflare: SOURCE_CATALOG_CLOUDFLARE.includes(r.cloudflare) ? r.cloudflare : 'n/a',
      installed: r.installed === true,
      // The id of the source that was added for the site, for Uninstall: the same shape every source id has.
      installedId: typeof r.installedId === 'string' && SOURCE_CATALOG_SOURCE_ID_RE.test(r.installedId) ? r.installedId : '',
      blocked: r.blocked === true,
      // The name of the repository the person added that the site is from ('' for the default one).
      repo: sourceCatalogClean(r.repo, 60),
    };
  }).filter((row) => row.key);
  return {
    rows,
    total: sourceCatalogInt(a.total),
    offset: sourceCatalogInt(a.offset),
    lang: SOURCE_CATALOG_LANG_RE.test(String(a.lang)) ? String(a.lang) : '',
    languages: (Array.isArray(a.languages) ? a.languages : []).slice(0, SOURCE_CATALOG_LANGS_MAX)
      .filter((item) => item && SOURCE_CATALOG_LANG_RE.test(String(item.lang)))
      .map((item) => ({ lang: String(item.lang), count: sourceCatalogInt(item.count) })),
    pending: { themes: sourceCatalogInt(pending.themes), dns: sourceCatalogInt(pending.dns), paused: pending.paused === true },
    stale: a.stale === true,
    // Whether the app offers the extension engine, and whether a Suwayomi-Server is set up for it.
    extensionEngine: { available: !!(a.extensionEngine && a.extensionEngine.available === true), enabled: !!(a.extensionEngine && a.extensionEngine.enabled === true) },
  };
}

// The markup (the block, a card per site, the language box, the status line) is in ui-settings-source-catalog-html.js, loaded before this file.

// ── Steps ─────────────────────────────────────────────────────────────────

function sourceCatalogBody(ctx, form, { offset, limit }) {
  const body = {
    lang: SOURCE_CATALOG_LANG_RE.test(String(form.lang)) ? String(form.lang) : 'en',
    q: String(form.q || '').slice(0, 80),
    nativeOnly: form.nativeOnly !== false,
    hideCloudflare: form.hideCloudflare === true,
    hideAdult: form.hideAdult === true,
    hideInstalled: form.hideInstalled === true,
    onlyInstalled: form.onlyInstalled === true,
    offset,
    limit,
  };
  const warnings = typeof ctx.getWarnings === 'function' ? ctx.getWarnings() : null;
  if (Array.isArray(warnings) && warnings.length) body.warnings = warnings;
  return body;
}

/**
 * Reads the list. `more` adds the next page; `refresh` reads again what is already shown (the background work may have settled more
 * rows), and keeps asking while the server says it is still working.
 * @returns {Promise<boolean>}
 */
async function sourceCatalogLoad(ctx, { more = false, refresh = false } = {}) {
  const { view } = ctx;
  if (ctx.timer) { ctx.setTimer.clear(ctx.timer); ctx.timer = null; }
  ctx.generation += 1;
  const token = ctx.generation;
  if (!more && !refresh) ctx.polls = 0;
  const shown = ctx.shown;
  const offset = more ? shown : 0;
  const limit = refresh ? Math.min(SOURCE_CATALOG_ROWS_MAX, Math.max(SOURCE_CATALOG_PAGE, shown)) : SOURCE_CATALOG_PAGE;
  if (!more && !refresh) view.loading();
  view.error('');
  try {
    const answer = await ctx.request(SOURCE_CATALOG_ENDPOINT, { method: 'POST', body: JSON.stringify(sourceCatalogBody(ctx, view.read(), { offset, limit })) });
    if (token !== ctx.generation) return false;
    if (!answer || answer.ok !== true) throw new Error(answer && answer.error);
    const page = sourceCatalogNormalize(answer);
    ctx.shown = more ? shown + page.rows.length : page.rows.length;
    ctx.loaded = true;
    ctx.engineEnabled = page.extensionEngine.enabled;
    view.showList(page, { append: more, hasMore: page.offset + page.rows.length < page.total });
    if (page.pending.themes + page.pending.dns > 0 && !page.pending.paused && ctx.polls < SOURCE_CATALOG_POLL_MAX) {
      ctx.polls += 1;
      ctx.timer = ctx.setTimer.set(() => { ctx.timer = null; sourceCatalogLoad(ctx, { refresh: true }); }, SOURCE_CATALOG_POLL_MS);
    }
    return true;
  } catch (err) {
    if (token === ctx.generation) {
      view.loaded();
      view.error(sourceImportErrorText(err));
    }
    return false;
  }
}

/**
 * The first time the block is opened: nothing is asked of the network before. Opened again after it was closed, the list shown is
 * read once more (the asking stopped when it closed, so what it shows may be from before the background work finished).
 */
function sourceCatalogOpened(ctx) {
  if (ctx.stopped && ctx.loaded) {
    ctx.stopped = false;
    return sourceCatalogLoad(ctx, { refresh: true });
  }
  ctx.stopped = false;
  if (ctx.loaded || ctx.opened) return Promise.resolve(false);
  ctx.opened = true;
  return sourceCatalogLoad(ctx).then((ok) => { if (!ok) ctx.opened = false; return ok; });
}

/** Chooses a site: the "add from a link" block writes the source and the card's Check runs on it. */
async function sourceCatalogAdd(ctx, key) {
  const link = ctx.linkController;
  if (ctx.adding || !SOURCE_CATALOG_KEY_RE.test(String(key)) || !link || typeof link.runCatalog !== 'function') return false;
  ctx.adding = true;
  ctx.view.adding(key, true);
  try {
    const ok = await link.runCatalog(key);
    const result = typeof link.lastResult === 'function' ? link.lastResult() : null;
    // A site that could not be written for is remembered by the server and no longer offered as automatic: read the list again so its card goes,
    // and say why afterwards (reading the list clears the status line).
    if (!ok) await sourceCatalogLoad(ctx);
    ctx.view.outcome(ok, result && result.message ? result.message : '');
    return ok;
  } finally {
    ctx.adding = false;
    ctx.view.adding(key, false);
  }
}

/**
 * Chooses a site that runs in the person's Suwayomi-Server: the app asks that server to install the extension, which is a program from a third
 * party, so the person confirms first, in words that say so. Then the same as "Add": the written source goes through the card's Check.
 */
async function sourceCatalogAddEngine(ctx, key) {
  const link = ctx.linkController;
  if (ctx.adding || !SOURCE_CATALOG_KEY_RE.test(String(key)) || !link || typeof link.runEngine !== 'function') return false;
  // No Suwayomi-Server is set up: offer to set one up on this computer (the Suwayomi tab asks its own question, which is opened for the person) instead of failing after the confirmation.
  if (ctx.engineEnabled === false && ctx.offerSetup()) return false;
  if (!ctx.confirmEngine()) return false;
  ctx.adding = true;
  ctx.view.adding(key, true);
  try {
    const ok = await link.runEngine(key);
    const result = typeof link.lastResult === 'function' ? link.lastResult() : null;
    ctx.view.outcome(ok, result && result.message ? result.message : '');
    return ok;
  } finally {
    ctx.adding = false;
    ctx.view.adding(key, false);
  }
}

/**
 * Removes the source that was added for a site: the card's own Uninstall (which asks first, deletes the file and refreshes the lists), then the list
 * is read again so the card goes back to "Add".
 */
async function sourceCatalogUninstall(ctx, id) {
  const link = ctx.linkController;
  if (ctx.adding || !SOURCE_CATALOG_SOURCE_ID_RE.test(String(id)) || !link || typeof link.uninstall !== 'function') return false;
  if (!ctx.confirmUninstall(String(id))) return false;
  ctx.adding = true;
  try {
    const ok = await link.uninstall(String(id));
    if (ok) await sourceCatalogLoad(ctx);
    return ok;
  } finally {
    ctx.adding = false;
  }
}

/** A filter changed: the list starts again from the top. */
const sourceCatalogFiltersChanged = (ctx) => (ctx.opened || ctx.loaded ? sourceCatalogLoad(ctx) : Promise.resolve(false));

/** Stops asking again (the block closed, or the card went away). */
function sourceCatalogStop(ctx) {
  ctx.stopped = true;
  ctx.generation += 1;
  if (ctx.timer) { ctx.setTimer.clear(ctx.timer); ctx.timer = null; }
}

/**
 * @param {object} deps
 * @param {(path: string, opts?: object) => Promise<any>} deps.api   the api() wrapper
 * @param {object} deps.view   { read, loading, loaded, error, showList, adding, outcome }
 * @param {{ runCatalog: (key: string) => Promise<boolean>, lastResult?: () => object }} deps.linkController   the "add from a link" controller
 * @param {() => (string[]|null)} [deps.getWarnings]   which content the list may hold (Hide NSFW narrows it)
 * @param {{ set: Function, clear: Function }} [deps.timer]   replaced in tests
 * @param {(id: string) => boolean} [deps.confirmUninstall]   asks before the source added for a site is removed (the card's own question by default)
 * @param {() => boolean} [deps.confirmEngine]   asks the person to confirm installing an extension in their Suwayomi-Server (the native question by default)
 * @param {() => boolean} [deps.offerSetup]   when no Suwayomi-Server is set up: shows the offer to set one up on this computer and says whether it did (the Suwayomi tab's block by default)
 */
function createSourceCatalogController({ api: request, view, linkController, getWarnings, timer, confirmEngine, confirmUninstall, offerSetup }) {
  const setTimer = timer || { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };
  const askSetup = offerSetup || (() => typeof suwayomiLocalOffer === 'function' && suwayomiLocalOffer() === true);
  const askEngine = confirmEngine || (() => typeof confirm !== 'function' || confirm(t('settings.sourceCatalog.engineConfirm')));
  const askUninstall = confirmUninstall || ((id) => (typeof sourceImportConfirmUninstall === 'function' ? sourceImportConfirmUninstall(id) : true));
  const ctx = { request, view, linkController, getWarnings, setTimer, confirmEngine: askEngine, confirmUninstall: askUninstall, offerSetup: askSetup, engineEnabled: null, generation: 0, shown: 0, polls: 0, loaded: false, opened: false, adding: false, timer: null };
  return {
    open: () => sourceCatalogOpened(ctx),
    reload: () => sourceCatalogFiltersChanged(ctx),
    more: () => sourceCatalogLoad(ctx, { more: true }),
    add: (key) => sourceCatalogAdd(ctx, key),
    addEngine: (key) => sourceCatalogAddEngine(ctx, key),
    uninstall: (id) => sourceCatalogUninstall(ctx, id),
    stop: () => sourceCatalogStop(ctx),
    state: () => ({ shown: ctx.shown, loaded: ctx.loaded, polls: ctx.polls, waiting: !!ctx.timer }),
  };
}

// ── DOM glue ──────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} card   what the block's elements are looked up in (the import card, or the slot of the Advanced tab)
 * @param {string} [prefix]   the prefix of the block's ids
 * @param {(() => void)|null} [reveal]   what to do when a site was written: show the report of the card's Check, which may be in another tab
 */
function sourceCatalogView(card, prefix = SOURCE_CATALOG_PREFIX, reveal = null) {
  const byId = (id) => card.querySelector('#' + id);
  const lang = byId(`${prefix}Lang`);
  const query = byId(`${prefix}Query`);
  const native = byId(`${prefix}Native`);
  const hideCf = byId(`${prefix}HideCf`);
  const checked = (id) => { const el = byId(`${prefix}${id}`); return !!el && el.checked === true; };
  const list = byId(`${prefix}List`);
  const status = byId(`${prefix}Status`);
  const error = byId(`${prefix}Error`);
  const more = byId(`${prefix}More`);
  const engineHint = byId(`${prefix}EngineHint`);
  return {
    read: () => ({ lang: lang ? lang.value : 'en', q: query ? query.value : '', nativeOnly: native ? native.checked !== false : true, hideCloudflare: hideCf ? hideCf.checked === true : false, hideAdult: checked('HideAdult'), hideInstalled: checked('HideInstalled'), onlyInstalled: checked('OnlyInstalled') }),
    loading() { if (status) status.textContent = t('settings.sourceCatalog.loading'); if (more) more.hidden = true; },
    loaded() { if (status) status.textContent = ''; },
    error(text) { if (error) error.textContent = text || ''; },
    // The markup comes from buildSourceCatalogRowsHtml, which only ever escapes text.
    showList(page, { append, hasMore }) {
      if (list) list.innerHTML = (append ? list.innerHTML : '') + buildSourceCatalogRowsHtml(page.rows);
      if (lang && !append) {
        const current = page.lang || lang.value || 'en';
        lang.innerHTML = buildSourceCatalogLanguageOptionsHtml(page.languages, current);
        lang.value = current;
      }
      if (status) status.textContent = sourceCatalogStatusText(page);
      if (more) more.hidden = !hasMore;
      // The extension engine is offered but no Suwayomi-Server is set up yet: say where to set it up.
      if (engineHint) engineHint.hidden = !(page.extensionEngine.available && !page.extensionEngine.enabled);
    },
    adding(key, on) {
      card.setAttribute('aria-busy', on ? 'true' : 'false');
      const button = typeof card.querySelectorAll === 'function'
        ? [...card.querySelectorAll('[data-catalog-add], [data-catalog-engine]')].find((el) => el.getAttribute('data-catalog-add') === key || el.getAttribute('data-catalog-engine') === key)
        : null;
      if (button) button.disabled = on;
    },
    // What happened to the site just chosen, here where it was chosen: the full answer is in the block below.
    outcome(ok, message) {
      const text = ok ? t('settings.sourceCatalog.written') : (message || t('settings.sourceCatalog.notWritten')); if (status) status.textContent = text; if (typeof showToast === 'function') showToast(text, '', ok ? 'success' : 'error');
      if (!ok) return;
      if (reveal) { reveal(); return; }
      const report = byId('sourceImportReport');
      if (report && typeof report.scrollIntoView === 'function') report.scrollIntoView({ block: 'nearest' });
    },
  };
}

/** From the Advanced tab: the report of the Check is in the Sources tab, so go there and show it. */
function sourceCatalogRevealReport() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
  const tab = document.querySelector('.settings-nav-item[data-tab="tab-sources"]');
  if (tab && typeof tab.click === 'function') tab.click();
  const report = typeof document.getElementById === 'function' ? document.getElementById('sourceImportReport') : null;
  if (report && typeof report.scrollIntoView === 'function') report.scrollIntoView({ block: 'nearest' });
}

/**
 * Wires one block that is already in the page: its controller, its filters and its buttons.
 * @param {HTMLElement} root   where the block's ids are looked up
 * @param {string} prefix
 * @param {{ linkController: object, request: Function, busyCard: HTMLElement, reveal?: (() => void)|null }} deps   `busyCard` is the import card: while it runs a request, a click waits
 */
function sourceCatalogWire(root, prefix, { linkController, request, busyCard, reveal = null, collapsible = true }) {
  const view = sourceCatalogView(root, prefix, reveal);
  const getWarnings = () => (typeof state !== 'undefined' && state.settings && state.settings.hideNsfw === true ? ['SAFE'] : null);
  const controller = createSourceCatalogController({ api: request, view, linkController, getWarnings });
  // The repositories the person added (a block of its own, inside this one): the list is read again when they change.
  if (typeof mountSourceRepos === 'function') mountSourceRepos(root, prefix, { request, onChanged: () => controller.reload() });
  const block = root.querySelector(`#${prefix}Block`);
  const idle = () => busyCard.getAttribute('aria-busy') !== 'true';
  const note = root.querySelector(`#${prefix}FilterNote`);
  // With Hide NSFW on in the settings, the list only holds general-audience sites (the server's cap), so "Hide 18+ sites" is on and cannot be turned off.
  // Read again whenever the block is shown, since the setting can change in between; returns whether it changed (the list is then read again).
  let forced = null;
  let own = false; // what the box was before it was forced, so it goes back to the person's own choice
  const sync = () => {
    const now = !!getWarnings();
    const adult = root.querySelector(`#${prefix}HideAdult`);
    if (adult) {
      if (now && !forced) own = adult.checked === true;
      if (now) adult.checked = true;
      else if (forced) adult.checked = own;
      adult.disabled = now;
    }
    if (note) note.hidden = !now;
    const changed = forced !== null && forced !== now;
    forced = now;
    return changed;
  };
  sync();
  if (block) {
    // Only a block that closes asks when it is opened; one that does not is asked for by whoever mounted it (the Advanced tab, when it is opened).
    if (collapsible) block.addEventListener('toggle', () => { if (block.open) { sync(); controller.open(); } else controller.stop(); });
    block.addEventListener('click', (e) => {
      const closest = (selector) => (e.target && e.target.closest ? e.target.closest(selector) : null);
      const target = closest('[data-catalog-add]');
      if (target && !target.disabled && idle()) { controller.add(target.getAttribute('data-catalog-add')); return; }
      const viaEngine = closest('[data-catalog-engine]');
      if (viaEngine && !viaEngine.disabled && idle()) { controller.addEngine(viaEngine.getAttribute('data-catalog-engine')); return; }
      const remove = closest('[data-catalog-uninstall]');
      if (remove && !remove.disabled && idle()) controller.uninstall(remove.getAttribute('data-catalog-uninstall'));
    });
  }
  [`${prefix}Lang`, `${prefix}Native`, `${prefix}HideCf`, `${prefix}HideAdult`, `${prefix}HideInstalled`, `${prefix}OnlyInstalled`].forEach((id) => {
    const el = root.querySelector('#' + id);
    if (!el) return;
    el.addEventListener('change', () => {
      // "Hide added" and "Show only added" cancel each other: both on would always give an empty list.
      const pair = id === `${prefix}OnlyInstalled` ? `${prefix}HideInstalled` : (id === `${prefix}HideInstalled` ? `${prefix}OnlyInstalled` : '');
      const other = pair ? root.querySelector('#' + pair) : null;
      if (el.checked && other) other.checked = false;
      controller.reload();
    });
  });
  const query = root.querySelector(`#${prefix}Query`);
  if (query) {
    let pending = null;
    query.addEventListener('input', () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => { pending = null; controller.reload(); }, SOURCE_CATALOG_QUERY_DELAY_MS);
    });
  }
  const more = root.querySelector(`#${prefix}More`);
  if (more) more.addEventListener('click', () => controller.more());
  return { block, controller, sync };
}

/**
 * The same block in the Advanced tab, in the slot its card leaves for it, writing through the same controller of the import card: the person who is
 * setting up the server can add a site there without going to another tab first (the report of the Check is shown in the Sources tab afterwards).
 * A page without that slot gets nothing.
 */
function mountAdvancedCatalog(card, linkController, request) {
  const slot = typeof document !== 'undefined' && typeof document.getElementById === 'function' ? document.getElementById(SOURCE_CATALOG_ADVANCED_SLOT_ID) : null;
  if (!slot || slot.querySelector(`#${SOURCE_CATALOG_ADVANCED_PREFIX}Block`)) return null;
  slot.innerHTML = buildSourceCatalogHtml(SOURCE_CATALOG_ADVANCED_PREFIX, false);
  const wired = sourceCatalogWire(slot, SOURCE_CATALOG_ADVANCED_PREFIX, { linkController, request, busyCard: card, reveal: sourceCatalogRevealReport, collapsible: false });
  // The block is always open here: the list is read when the Advanced tab is opened (once: opening it again does not ask again).
  const tab = typeof document.querySelector === 'function' ? document.querySelector('.settings-nav-item[data-tab="tab-advanced"]') : null;
  if (tab && typeof tab.addEventListener === 'function') tab.addEventListener('click', () => { if (wired.sync()) wired.controller.reload(); wired.controller.open(); });
  return wired;
}

/**
 * Adds the block to the import card, above the "add from a link" block. Never throws: a failure here must not stop the card from
 * working without it. Nothing is asked of the network until the person opens the block.
 *
 * @param {HTMLElement} card
 * @param {object|null} linkController   the controller of the "add from a link" block (null: the block is not added)
 * @param {(path: string, opts?: object) => Promise<any>} request   the api() wrapper
 * @returns {{block: HTMLElement, controller: object}|null}
 */
function mountSourceCatalogBlock(card, linkController, request) {
  try {
    if (!card || !linkController || card.querySelector('#' + SOURCE_CATALOG_BLOCK_ID)) return null;
    // The catalog lives in the Advanced tab when the page has it (its slot): not twice. A page without that tab keeps it in this card, above "add from a link".
    const inAdvancedTab = mountAdvancedCatalog(card, linkController, request);
    if (inAdvancedTab) return inAdvancedTab;
    const anchor = card.querySelector('#sourceLinkBlock');
    if (!anchor) return null;
    anchor.insertAdjacentHTML('beforebegin', buildSourceCatalogHtml());
    return sourceCatalogWire(card, SOURCE_CATALOG_PREFIX, { linkController, request, busyCard: card });
  } catch (err) {
    if (typeof dbg !== 'undefined') dbg.warn(dbg.ERR_SETTINGS, 'Could not add the source catalog block to the import card', err);
    return null;
  }
}

window.sourceCatalogNormalize = sourceCatalogNormalize;
window.buildSourceCatalogHtml = buildSourceCatalogHtml;
window.buildSourceCatalogRowHtml = buildSourceCatalogRowHtml;
window.buildSourceCatalogRowsHtml = buildSourceCatalogRowsHtml;
window.buildSourceCatalogLanguageOptionsHtml = buildSourceCatalogLanguageOptionsHtml;
window.sourceCatalogStatusText = sourceCatalogStatusText;
window.createSourceCatalogController = createSourceCatalogController;
window.mountSourceCatalogBlock = mountSourceCatalogBlock;
