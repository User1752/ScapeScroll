// ============================================================================
// SETTINGS > SUWAYOMI — UPDATES OF THE SOURCES THAT RUN THROUGH THE SUWAYOMI-SERVER
// ============================================================================
// A source written for the extension engine only asks the person's own Suwayomi-Server; the extension it reads is kept up to date THERE. This block
// asks (POST /api/sources/engine/updates) which of the installed sources have a newer extension, says what changed (a link to the extension's
// history and, when the project has one, the start of its CHANGELOG.md) and offers Update. Update has the server install the new version and
// writes the source again, and the card's own Check shows it: the person still confirms the replacement, as for every other file.
//
// The list is checked when the settings open and when the Suwayomi tab is opened (one call to the server, not again within a minute), and again with the button. Nothing is installed without a
// confirmation that says a third party's program is installed in the person's Suwayomi-Server.
//
// Loaded after ui-settings-source-link.js (whose controller writes the source: runEngineUpdate). The card works without this file.
// Every value of an answer goes through sourceUpdatesNormalize first: it is text, capped, and never markup.

const SOURCE_UPDATES_ENDPOINT = '/api/sources/engine/updates';
const SOURCE_UPDATES_SLOT_ID = 'suwayomiUpdatesSlot';
const SOURCE_UPDATES_ID_RE = /^sw-\d{1,20}$/;
// The history of an extension's folder in the project that builds them: the only address a "what changed" link may have.
const SOURCE_UPDATES_HISTORY_RE = /^https:\/\/github\.com\/keiyoushi\/extensions-source\/commits\/main\/src\/[a-z]{2,4}\/[a-z0-9_]{1,60}$/;
const SOURCE_UPDATES_MAX = 100;
const SOURCE_UPDATES_RECHECK_MS = 60000;

const sourceUpdatesClean = (value, max) => String(value === undefined || value === null ? '' : value).slice(0, max);

/** The answer of the updates route as plain capped values. Nothing here is HTML. */
function sourceUpdatesNormalize(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const updates = (Array.isArray(a.updates) ? a.updates : []).slice(0, SOURCE_UPDATES_MAX).map((item) => {
    const u = item && typeof item === 'object' ? item : {};
    return {
      id: typeof u.id === 'string' && SOURCE_UPDATES_ID_RE.test(u.id) ? u.id : '',
      name: sourceUpdatesClean(u.name, 80),
      version: sourceUpdatesClean(u.version, 30),
      changelogUrl: typeof u.changelogUrl === 'string' && SOURCE_UPDATES_HISTORY_RE.test(u.changelogUrl) ? u.changelogUrl : '',
      changelog: sourceUpdatesClean(u.changelog, 1500),
    };
  }).filter((u) => u.id);
  return { updates, checked: Number.isFinite(Number(a.checked)) && Number(a.checked) >= 0 ? Math.floor(Number(a.checked)) : 0 };
}

// ── Markup ────────────────────────────────────────────────────────────────

/** One source with a newer extension: its name and the new version, what changed, and Update. */
function buildSourceUpdateRowHtml(update) {
  const link = update.changelogUrl
    ? `<a class="source-updates-link" href="${escapeHtml(update.changelogUrl)}" target="_blank" rel="noopener noreferrer">${sourceImportText('settings.sourceUpdates.whatChanged')}</a>`
    : '';
  const text = update.changelog ? `<details class="source-updates-text"><summary>${sourceImportText('settings.sourceUpdates.changelog')}</summary><pre>${escapeHtml(update.changelog)}</pre></details>` : '';
  return `<li class="source-updates-row">
    <span class="source-updates-body">
      <span class="source-updates-name">${escapeHtml(update.name)}</span>
      <span class="source-updates-version">${escapeHtml(sourceImportFill(t('settings.sourceUpdates.newVersion'), { version: update.version || '?' }))}</span>
      ${link}
    </span>
    <button type="button" class="btn secondary" data-update-source="${escapeHtml(update.id)}" aria-label="${escapeHtml(sourceImportFill(t('settings.sourceUpdates.updateLabel'), { name: update.name }))}">${sourceImportText('settings.sourceUpdates.update')}</button>
    ${text}
  </li>`;
}

function buildSourceUpdatesRowsHtml(updates) {
  return updates.map(buildSourceUpdateRowHtml).join('');
}

/** The block of the Suwayomi tab: a heading, the button that checks again, a line that says what the check found, and the list. */
function buildSourceUpdatesHtml() {
  return `<div class="setting-group source-updates-block" id="sourceUpdatesBlock">
    <div class="source-updates-head">
      <span class="source-import-subtitle">${sourceImportText('settings.sourceUpdates.title')}</span>
      <button type="button" class="btn secondary" id="sourceUpdatesCheck">${sourceImportText('settings.sourceUpdates.check')}</button>
    </div>
    <p class="setting-description source-import-error" id="sourceUpdatesError" role="alert"></p>
    <p class="setting-description" id="sourceUpdatesStatus" aria-live="polite"></p>
    <ul class="source-import-list source-updates-list" id="sourceUpdatesList"></ul>
  </div>`;
}

// ── Steps ─────────────────────────────────────────────────────────────────

/** Asks the server which sources have a newer extension. A failure is said in its own words and leaves the list as it was. */
async function sourceUpdatesCheck(ctx) {
  if (ctx.checking) return false;
  ctx.checking = true;
  ctx.view.error('');
  ctx.view.checking();
  try {
    const answer = await ctx.request(SOURCE_UPDATES_ENDPOINT, { method: 'POST', body: '{}' });
    if (!answer || answer.ok !== true) throw new Error(answer && answer.error);
    ctx.view.show(sourceUpdatesNormalize(answer));
    ctx.checkedAt = ctx.now();
    return true;
  } catch (err) {
    ctx.view.show(null);
    ctx.view.error(sourceImportErrorText(err));
    return false;
  } finally {
    ctx.checking = false;
  }
}

/** The person opened the tab: checks, unless it was checked a moment ago. */
const sourceUpdatesOpened = (ctx) => (ctx.checkedAt && ctx.now() - ctx.checkedAt < SOURCE_UPDATES_RECHECK_MS ? Promise.resolve(false) : sourceUpdatesCheck(ctx));

/**
 * Updates one source: the person confirms first (a third party's program is installed in their Suwayomi-Server), then the card's own controller has the
 * server update the extension and writes the source again; its Check runs and the person confirms the replacement there.
 */
async function sourceUpdatesUpdate(ctx, id) {
  const link = ctx.linkController;
  if (ctx.updating || !SOURCE_UPDATES_ID_RE.test(String(id)) || !link || typeof link.runEngineUpdate !== 'function') return false;
  if (!ctx.confirmUpdate()) return false;
  ctx.updating = true;
  ctx.view.updating(id, true);
  try {
    const ok = await link.runEngineUpdate(String(id));
    const result = typeof link.lastResult === 'function' ? link.lastResult() : null;
    ctx.view.outcome(ok, result && result.message ? result.message : '');
    return ok;
  } finally {
    ctx.updating = false;
    ctx.view.updating(id, false);
  }
}

/**
 * @param {object} deps
 * @param {(path: string, opts?: object) => Promise<any>} deps.api   the api() wrapper
 * @param {object} deps.view   { checking, show, error, updating, outcome }
 * @param {{ runEngineUpdate: (id: string) => Promise<boolean>, lastResult?: () => object }} deps.linkController   the "add from a link" controller
 * @param {() => boolean} [deps.confirmUpdate]   asks the person to confirm (the native question by default)
 * @param {() => number} [deps.now]   replaced in tests
 */
function createSourceUpdatesController({ api: request, view, linkController, confirmUpdate, now }) {
  const ask = confirmUpdate || (() => typeof confirm !== 'function' || confirm(t('settings.sourceUpdates.confirm')));
  const ctx = { request, view, linkController, confirmUpdate: ask, now: now || (() => Date.now()), checking: false, updating: false, checkedAt: 0 };
  return {
    check: () => sourceUpdatesCheck(ctx),
    opened: () => sourceUpdatesOpened(ctx),
    update: (id) => sourceUpdatesUpdate(ctx, id),
    state: () => ({ checking: ctx.checking, updating: ctx.updating, checkedAt: ctx.checkedAt }),
  };
}

// ── DOM glue ──────────────────────────────────────────────────────────────

/** @param {HTMLElement} root   what the block's elements are looked up in (the slot of the Suwayomi tab) */
function sourceUpdatesView(root, reveal) {
  const byId = (id) => root.querySelector('#' + id);
  const list = byId('sourceUpdatesList');
  const status = byId('sourceUpdatesStatus');
  const error = byId('sourceUpdatesError');
  const check = byId('sourceUpdatesCheck');
  return {
    checking() { if (status) status.textContent = t('settings.sourceUpdates.checking'); if (check) check.disabled = true; },
    // The markup comes from buildSourceUpdatesRowsHtml, which only ever escapes text. null: the check failed, the list stays as it was.
    show(result) {
      if (check) check.disabled = false;
      if (!result) { if (status) status.textContent = ''; return; }
      if (list) list.innerHTML = buildSourceUpdatesRowsHtml(result.updates);
      if (!status) return;
      if (!result.checked) status.textContent = t('settings.sourceUpdates.noSources');
      else status.textContent = result.updates.length ? sourceImportFill(t('settings.sourceUpdates.found'), { count: String(result.updates.length) }) : t('settings.sourceUpdates.upToDate');
    },
    error(text) { if (error) error.textContent = text || ''; },
    updating(id, on) {
      root.setAttribute('aria-busy', on ? 'true' : 'false');
      const button = typeof root.querySelectorAll === 'function' ? [...root.querySelectorAll('[data-update-source]')].find((el) => el.getAttribute('data-update-source') === id) : null;
      if (button) button.disabled = on;
    },
    // What happened to the update, here where it was asked: the Check of the new file is in the Sources tab, so it is shown there when it was written.
    outcome(ok, message) {
      const text = ok ? t('settings.sourceUpdates.written') : (message || t('settings.sourceUpdates.notWritten'));
      if (status) status.textContent = text;
      if (typeof showToast === 'function') showToast(text, '', ok ? 'success' : 'error');
      if (ok && typeof reveal === 'function') reveal();
    },
  };
}

/**
 * Adds the block to the slot the Suwayomi tab leaves for it and checks when that tab is opened. A page without the slot gets nothing. Never throws.
 * @param {HTMLElement} card   the import card (busy while a request of the card runs)
 * @param {object} linkController
 * @param {(path: string, opts?: object) => Promise<any>} request
 * @param {(() => void)|null} [reveal]   shows the report of the Check, which is in another tab
 */
function mountSourceUpdates(card, linkController, request, reveal = null) {
  try {
    const slot = typeof document !== 'undefined' && typeof document.getElementById === 'function' ? document.getElementById(SOURCE_UPDATES_SLOT_ID) : null;
    if (!card || !slot || !linkController || slot.querySelector('#sourceUpdatesBlock')) return null;
    slot.innerHTML = buildSourceUpdatesHtml();
    const controller = createSourceUpdatesController({ api: request, view: sourceUpdatesView(slot, reveal), linkController });
    const idle = () => card.getAttribute('aria-busy') !== 'true';
    const check = slot.querySelector('#sourceUpdatesCheck');
    if (check) check.addEventListener('click', () => { controller.check(); });
    slot.addEventListener('click', (e) => {
      const target = e.target && e.target.closest ? e.target.closest('[data-update-source]') : null;
      if (target && !target.disabled && idle()) controller.update(target.getAttribute('data-update-source'));
    });
    const tab = typeof document.querySelector === 'function' ? document.querySelector('.settings-nav-item[data-tab="tab-suwayomi"]') : null;
    if (tab && typeof tab.addEventListener === 'function') tab.addEventListener('click', () => { controller.opened(); });
    // And once as the settings open, so what is new is already there when the tab is looked at.
    controller.opened();
    return { controller };
  } catch (err) {
    if (typeof dbg !== 'undefined') dbg.warn(dbg.ERR_SETTINGS, 'Could not add the updates block to the Suwayomi tab', err);
    return null;
  }
}

window.mountSourceUpdates = mountSourceUpdates;
