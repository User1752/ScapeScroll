// ============================================================================
// SETTINGS > ADVANCED > "IMPORT A SOURCE" CARD — THE "ADD FROM A LINK" BLOCK
// ============================================================================
// The person pastes the address of a site. The server probes it (Cloudflare and other protections, a login, robots.txt, ads),
// picks the template of the site's engine, and returns the text of a source file; no AI is involved and nothing is installed.
// The text is put in the card's own code box and the card's own Check runs on it, so a file written from a link passes the
// same gate, and needs the same confirmation, as one that was pasted.
//
// Loaded after ui-settings-source-import.js, which calls mountSourceLinkBlock(card, controller, api) once the card is in the DOM
// and does nothing if this file is missing. Every value of the answer goes through sourceLinkNormalize first: it is text, capped,
// and never markup.
//
// The sources this app wrote from a link are listed in the block with a Regenerate button: the server writes the source again from the
// address in the installed file, the text goes into the card's box and through its Check, and the person confirms the replacement.
//
// Layers: sourceLink<Step>(ctx) (the logic, over a view port, testable without a browser), createSourceLinkController,
// then the thin DOM glue.

const SOURCE_LINK_ENDPOINT = '/api/sources/import/link';
const SOURCE_LINK_GENERATED_ENDPOINT = '/api/sources/import/generated';
const SOURCE_ENGINE_ENDPOINT = '/api/sources/engine/prepare';
const SOURCE_ENGINE_UPDATE_ENDPOINT = '/api/sources/engine/update';
const SOURCE_LINK_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SOURCE_LINK_TEXT_MAX = 300;
const SOURCE_LINK_LIST_MAX = 20;
const SOURCE_LINK_SEVERITIES = ['block', 'warn', 'info'];

const sourceLinkClean = (value, max) => String(value === undefined || value === null ? '' : value).slice(0, max);

/** The answer of the link route as plain capped values. Nothing here is HTML. */
function sourceLinkNormalize(raw) {
  const answer = raw && typeof raw === 'object' ? raw : {};
  const probe = answer.probe && typeof answer.probe === 'object' ? answer.probe : {};
  const engine = probe.engine && typeof probe.engine === 'object' ? probe.engine : {};
  const list = (value, mapItem) => (Array.isArray(value) ? value : []).slice(0, SOURCE_LINK_LIST_MAX).map(mapItem);
  return {
    generated: answer.status === 'generated' && typeof answer.code === 'string' && answer.code.length > 0,
    id: sourceLinkClean(answer.id, 80),
    name: sourceLinkClean(answer.name, 80),
    code: typeof answer.code === 'string' ? answer.code : '',
    message: sourceLinkClean(answer.message, SOURCE_LINK_TEXT_MAX),
    engine: sourceLinkClean(engine.name, 40),
    regenerated: answer.regenerated === true,
    unchanged: answer.unchanged === true,
    notes: list(answer.notes, (text) => sourceLinkClean(text, SOURCE_LINK_TEXT_MAX)),
    reasons: list(probe.reasons, (reason) => {
      const item = reason && typeof reason === 'object' ? reason : {};
      const severity = SOURCE_LINK_SEVERITIES.includes(item.severity) ? item.severity : 'info';
      return { severity, text: sourceLinkClean(item.text, SOURCE_LINK_TEXT_MAX) };
    }),
  };
}

/** The installed sources written from a link: [{ id, name, base, on }], as plain capped values. */
function sourceLinkNormalizeGenerated(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.sources) ? raw.sources : [];
  return list.slice(0, SOURCE_LINK_LIST_MAX * 5)
    .filter((item) => item && typeof item === 'object' && SOURCE_LINK_ID_RE.test(String(item.id)))
    .map((item) => ({ id: String(item.id), name: sourceLinkClean(item.name || item.id, 80), base: sourceLinkClean(item.base, 120), on: sourceLinkClean(item.on, 10) }));
}

// ── Markup ────────────────────────────────────────────────────────────────

/** The block, added to the card right after its notice. */
function buildSourceLinkHtml() {
  return `<div class="setting-group source-link-block" id="sourceLinkBlock">
    <p class="source-import-subtitle">${sourceImportText('settings.sourceLink.title')}</p>
    <p class="setting-description">${sourceImportText('settings.sourceLink.description')}</p>
    <label for="sourceLinkUrl">${sourceImportText('settings.sourceLink.urlLabel')}</label>
    <div class="source-link-row">
      <input type="url" id="sourceLinkUrl" class="input source-link-url" maxlength="300" autocomplete="off" spellcheck="false" inputmode="url" placeholder="${escapeHtml(t('settings.sourceLink.urlPlaceholder'))}" aria-describedby="sourceLinkHint">
      <button type="button" class="btn primary" id="sourceLinkBtn">${sourceImportText('settings.sourceLink.button')}</button>
    </div>
    <p class="setting-description" id="sourceLinkHint">${sourceImportText('settings.sourceLink.hint')}</p>
    <p class="setting-description source-import-error" id="sourceLinkError" role="alert"></p>
    <div id="sourceLinkResult" class="source-link-result" aria-live="polite"></div>
    <div id="sourceLinkGenerated" class="source-link-generated"></div>
  </div>`;
}

/** The list of sources written from a link, each with its Regenerate button; nothing at all when there are none. */
function buildSourceLinkGeneratedHtml(raw) {
  const list = Array.isArray(raw) ? raw : sourceLinkNormalizeGenerated(raw);
  if (!list.length) return '';
  const rows = list.map((item) => `<li class="source-link-generated-row">
    <span class="toggle-text">${escapeHtml(item.name)} <span class="setting-description">${escapeHtml(sourceImportFill(t('settings.sourceLink.generatedOn'), { host: item.base.replace(/^https:\/\//, ''), date: item.on }))}</span></span>
    <button type="button" class="btn secondary" data-link-regenerate="${escapeHtml(item.id)}" title="${escapeHtml(t('settings.sourceLink.regenerateHint'))}">${sourceImportText('settings.sourceLink.regenerate')}</button>
  </li>`);
  return `<p class="source-import-subtitle">${sourceImportText('settings.sourceLink.generatedTitle')}</p><ul class="source-import-list">${rows.join('')}</ul>`;
}

const sourceLinkListHtml = (items, className) => (items.length ? `<ul class="${className}">${items.join('')}</ul>` : '');

/** What the probe and the generator said, for the person to read before the Check below it. */
function buildSourceLinkResultHtml(rawResult) {
  const result = sourceLinkNormalize(rawResult);
  const done = result.regenerated ? t(result.unchanged ? 'settings.sourceLink.regenSame' : 'settings.sourceLink.regenChanged') : t('settings.sourceLink.generated');
  const head = result.generated
    ? sourceImportFill(done, { name: result.name || result.id, engine: result.engine || '?' })
    : (result.message || t('settings.sourceLink.refused'));
  const reasons = result.reasons.filter((r) => r.severity !== 'info');
  return `<p class="${result.generated ? 'source-link-ok' : 'source-link-refused'}">${escapeHtml(head)}</p>`
    + sourceLinkListHtml(reasons.map((r) => `<li class="source-link-sev-${r.severity}">${escapeHtml(r.text)}</li>`), 'source-link-reasons')
    + sourceLinkListHtml(result.notes.map((text) => `<li>${escapeHtml(text)}</li>`), 'source-link-notes');
}

// ── Steps ─────────────────────────────────────────────────────────────────

/**
 * Asks the server to write a source for the address in the box. On success the text and the id go into the card's own boxes and
 * the card's own Check runs; the person still has to press Install. One request at a time.
 *
 * @returns {Promise<boolean>} whether a source was written
 */
async function sourceLinkRun(ctx) {
  if (ctx.running) return false;
  const url = String(ctx.view.read().url || '').trim();
  ctx.view.error('');
  if (!url) {
    ctx.view.error(t('settings.sourceLink.emptyUrl'));
    return false;
  }
  return sourceLinkAsk(ctx, { url });
}

/** Writes the source of an installed one again. Its address is the one in the installed file: only the id is sent. */
async function sourceLinkRegenerate(ctx, rawId) {
  const id = String(rawId || '');
  if (ctx.running || !SOURCE_LINK_ID_RE.test(id)) return false;
  ctx.view.error('');
  return sourceLinkAsk(ctx, { regenerate: id });
}

/** Which sources were written from a link. The list is a convenience: a failure to read it only leaves it empty. */
async function sourceLinkRefresh(ctx, { afterChange = false } = {}) {
  // What the last answer said ("written", "nothing changed") is about a check that is no longer open once it was installed or dropped.
  if (afterChange && typeof ctx.view.reportOpen === 'function' && !ctx.view.reportOpen()) ctx.view.clearResult();
  try {
    ctx.view.showGenerated(sourceLinkNormalizeGenerated(await ctx.request(SOURCE_LINK_GENERATED_ENDPOINT, { method: 'POST', body: '{}' })));
  } catch (_) {
    ctx.view.showGenerated([]);
  }
}

/** Writes the source of a row of the source catalog. Only the row's key is sent: the address is the server's, from the repository's list. */
async function sourceLinkRunCatalog(ctx, rawKey) {
  const key = String(rawKey || '');
  if (ctx.running || !/^[a-z0-9._]{1,120}#\d{1,3}$/.test(key)) return false;
  ctx.view.error('');
  return sourceLinkAsk(ctx, { catalog: { key } });
}

/**
 * Installs the extension of a catalog row in the person's Suwayomi-Server and writes the source that reads it (the caller has already asked the
 * person to confirm: `acknowledge` says so to the server). The answer has the shape of a link answer, so it goes into the card's boxes and Check.
 */
async function sourceLinkRunEngine(ctx, rawKey) {
  const key = String(rawKey || '');
  if (ctx.running || !/^[a-z0-9._]{1,120}#\d{1,3}$/.test(key)) return false;
  ctx.view.error('');
  return sourceLinkAsk(ctx, { key, acknowledge: true }, SOURCE_ENGINE_ENDPOINT);
}

/**
 * Updates the extension of an installed engine source in the person's Suwayomi-Server and writes the source again (the caller has already asked the person to
 * confirm). Only the id of the installed source is sent: the package is the repository's, looked up by the server. The answer goes into the card's boxes and Check.
 */
async function sourceLinkRunEngineUpdate(ctx, rawId) {
  const id = String(rawId || '');
  if (ctx.running || !/^sw-\d{1,20}$/.test(id)) return false;
  ctx.view.error('');
  return sourceLinkAsk(ctx, { id, acknowledge: true }, SOURCE_ENGINE_UPDATE_ENDPOINT);
}

async function sourceLinkAsk(ctx, body, endpoint = SOURCE_LINK_ENDPOINT) {
  const { view } = ctx;
  ctx.running = true;
  ctx.last = null;
  view.clearResult();
  view.busy(true);
  try {
    const answer = await ctx.request(endpoint, { method: 'POST', body: JSON.stringify(body) });
    if (!answer || answer.ok !== true) throw new Error(answer && answer.error);
    const result = sourceLinkNormalize(answer);
    ctx.last = result;
    view.showResult(answer);
    if (!result.generated) return false;
    view.fill(result.code, result.id);
    ctx.importController.edit();
    await ctx.importController.check();
    return true;
  } catch (err) {
    ctx.last = { generated: false, message: sourceImportErrorText(err) };
    view.error(sourceImportErrorText(err));
    return false;
  } finally {
    ctx.running = false;
    view.busy(false);
  }
}

/**
 * @param {object} deps
 * @param {(path: string, opts?: object) => Promise<any>} deps.api   the api() wrapper
 * @param {object} deps.view   { read, busy, error, clearResult, showResult, fill, showGenerated }
 * @param {{ edit: Function, check: Function }} deps.importController   the card's controller
 */
function createSourceLinkController({ api: request, view, importController }) {
  const ctx = { request, view, importController, running: false, last: null };
  return {
    run: () => sourceLinkRun(ctx),
    regenerate: (id) => sourceLinkRegenerate(ctx, id),
    refresh: (options) => sourceLinkRefresh(ctx, options),
    // The source catalog block (ui-settings-source-catalog.js) writes the source of a row through these two.
    runCatalog: (key) => sourceLinkRunCatalog(ctx, key),
    runEngine: (key) => sourceLinkRunEngine(ctx, key),
    runEngineUpdate: (id) => sourceLinkRunEngineUpdate(ctx, id),
    // The catalog's Uninstall button removes the source written for a site through the card's own controller (it asks, deletes, refreshes the lists).
    uninstall: (id) => importController.uninstall(id),
    lastResult: () => ctx.last,
  };
}

// ── DOM glue ──────────────────────────────────────────────────────────────

function sourceLinkView(card) {
  const byId = (id) => card.querySelector('#' + id);
  const url = byId('sourceLinkUrl');
  const error = byId('sourceLinkError');
  const result = byId('sourceLinkResult');
  const button = byId('sourceLinkBtn');
  const generated = byId('sourceLinkGenerated');
  const report = byId('sourceImportReport');
  return {
    read: () => ({ url: url ? url.value : '' }),
    busy(on) {
      if (button) button.disabled = on;
      if (url) url.disabled = on;
      card.setAttribute('aria-busy', on ? 'true' : 'false');
    },
    error(text) { if (error) error.textContent = text || ''; },
    clearResult() { if (result) result.innerHTML = ''; },
    // The markup comes from buildSourceLinkResultHtml, which only ever escapes text.
    showResult(answer) { if (result) result.innerHTML = buildSourceLinkResultHtml(answer); },
    reportOpen: () => !!(report && report.innerHTML.trim()),
    showGenerated(list) { if (generated) generated.innerHTML = buildSourceLinkGeneratedHtml(list); },
    fill(code, id) {
      const codeBox = byId('sourceImportCode');
      const idBox = byId('sourceImportId');
      if (codeBox) codeBox.value = code;
      if (idBox) idBox.value = id;
    },
  };
}

// The controller of each card, so the card can ask for the list to be read again after an install or an uninstall.
const sourceLinkControllers = new WeakMap();

/** Called by the card when its lists change: the sources written from a link may have changed with them. */
function refreshSourceLinkList(card) {
  const controller = sourceLinkControllers.get(card);
  if (controller) controller.refresh({ afterChange: true });
}

/**
 * Adds the block to the import card. Never throws: a failure here must not stop the card from working without it.
 *
 * @returns {{block: HTMLElement, controller: object}|null} null when there was nowhere to add it, or it is already there
 */
function mountSourceLinkBlock(card, importController, request) {
  try {
    const notice = card && card.querySelector('.source-import-notice');
    if (!notice || card.querySelector('#sourceLinkBlock')) return null;
    notice.insertAdjacentHTML('afterend', buildSourceLinkHtml());
    const controller = createSourceLinkController({ api: request, view: sourceLinkView(card), importController });
    const run = () => {
      // The card runs one request at a time: while it checks, installs or tests, a click here waits for the person to try again.
      if (card.getAttribute('aria-busy') !== 'true') controller.run();
    };
    const url = card.querySelector('#sourceLinkUrl');
    const button = card.querySelector('#sourceLinkBtn');
    const generated = card.querySelector('#sourceLinkGenerated');
    if (generated) {
      generated.addEventListener('click', (e) => {
        const target = e.target && e.target.closest ? e.target.closest('[data-link-regenerate]') : null;
        if (target && !target.disabled && card.getAttribute('aria-busy') !== 'true') controller.regenerate(target.getAttribute('data-link-regenerate'));
      });
    }
    sourceLinkControllers.set(card, controller);
    // The source catalog block (ui-settings-source-catalog.js) goes above this one and writes through this controller; this block works without it.
    if (typeof mountSourceCatalogBlock === 'function') mountSourceCatalogBlock(card, controller, request);
    // The updates of the sources that run through the Suwayomi-Server (ui-settings-source-updates.js), in the Suwayomi tab; also optional.
    if (typeof mountSourceUpdates === 'function') mountSourceUpdates(card, controller, request, typeof sourceCatalogRevealReport === 'function' ? sourceCatalogRevealReport : null);
    controller.refresh();
    if (button) button.addEventListener('click', run);
    if (url) url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run(); } });
    return { block: card.querySelector('#sourceLinkBlock'), controller };
  } catch (err) {
    if (typeof dbg !== 'undefined') dbg.warn(dbg.ERR_SETTINGS, 'Could not add the add-from-a-link block to the import card', err);
    return null;
  }
}

window.sourceLinkNormalize = sourceLinkNormalize;
window.buildSourceLinkHtml = buildSourceLinkHtml;
window.buildSourceLinkResultHtml = buildSourceLinkResultHtml;
window.sourceLinkNormalizeGenerated = sourceLinkNormalizeGenerated;
window.buildSourceLinkGeneratedHtml = buildSourceLinkGeneratedHtml;
window.createSourceLinkController = createSourceLinkController;
window.refreshSourceLinkList = refreshSourceLinkList;
window.mountSourceLinkBlock = mountSourceLinkBlock;
