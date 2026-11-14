// ============================================================================
// SETTINGS > ADVANCED > "IMPORT A SOURCE" CARD — CHECK / INSTALL LOGIC AND DOM
// ============================================================================
// The markup, the report cleaning and the shared constants live in
// ui-settings-source-import-html.js, which is loaded before this file. What is
// here: the controller (check / install / cancel / uninstall over a view port,
// testable without a browser) and the thin DOM glue around it.
//
// The card is injected, not part of ui-settings-modal-html.js: showSettings()
// (ui-settings-modal.js) only calls mountSourceImportCard(modal, onChanged) once
// the modal is in the DOM, and does nothing if this file is missing.
//
// Both routes are local-only (the computer running ScrollScape), so a refusal
// from another device is shown as a plain sentence.
//
// Layers:
//   sourceImport<Step>(ctx)         the logic, one function per step, over a context { request, view, ... }
//   createSourceImportController    the context and the steps put together
//   sourceImportView / sourceImportBind / mount...    the thin DOM glue

const SOURCE_IMPORT_CARD_ID = 'sourceImportCard';  const SOURCE_IMPORT_TAB_ID = 'tab-sources';
// The card is added after the one that holds the repositories list.
const SOURCE_IMPORT_ANCHOR_ID = 'animeSetProvidersList';
const SOURCE_IMPORT_PREVIEW_ENDPOINT = '/api/sources/import/preview';
const SOURCE_IMPORT_INSTALL_ENDPOINT = '/api/sources/import/install';
const SOURCE_IMPORT_UNINSTALL_ENDPOINT = '/api/sources/uninstall';
const SOURCE_IMPORT_TEST_ENDPOINT = '/api/sources/import/test';

// ── Request bookkeeping ───────────────────────────────────────────────────
// One request at a time. Every start, edit and cancel moves `generation` on, so an answer that arrives for an older
// one finds it is no longer the current one and is ignored (it can neither show a stale report nor undo a cancel).

function sourceImportBegin(ctx, kind, form) {
  ctx.generation += 1;
  ctx.inflight = { token: ctx.generation, kind, form };
  ctx.view.busy(true);
  return ctx.generation;
}

const sourceImportIsCurrent = (ctx, token) => token === ctx.generation;

function sourceImportFinish(ctx, token) {
  if (ctx.inflight && ctx.inflight.token === token) {
    ctx.inflight = null;
    ctx.view.busy(false);
  }
}

function sourceImportSupersede(ctx) {
  ctx.generation += 1;
  if (ctx.inflight) {
    ctx.inflight = null;
    ctx.view.busy(false);
  }
}

const sourceImportTrimmedId = (form) => String(form.id === undefined || form.id === null ? '' : form.id).trim();

function sourceImportShowError(ctx, err) {
  ctx.view.error(sourceImportErrorText(err), sourceImportErrorDetails(err));
}

async function sourceImportNotifyChanged(ctx) {
  try { if (typeof ctx.onChanged === 'function') await ctx.onChanged(); } catch (_) { /* the lists refresh on the next open */ }
  ctx.view.refreshImported();
}

// ── Steps ─────────────────────────────────────────────────────────────────

/**
 * The text or the id box changed. A report that was about the old text no longer describes what is in the form, and
 * a check still waiting for its answer is about text that is gone: either way it is dropped and Check is needed again.
 * Also run when an install or an uninstall ends, so what was typed while it ran is compared with the checked text.
 */
function sourceImportEdit(ctx) {
  if (ctx.inflight && ctx.inflight.kind !== 'check') return; // an install uses the checked fingerprint, not the form
  const form = ctx.view.read();
  if (ctx.inflight) {
    if (form.code !== ctx.inflight.form.code || sourceImportTrimmedId(form) !== ctx.inflight.form.id) sourceImportSupersede(ctx);
    return;
  }
  if (!ctx.checked) return;
  if (form.code === ctx.checked.code && sourceImportTrimmedId(form) === ctx.checked.id) return;
  sourceImportSupersede(ctx);
  ctx.checked = null;
  ctx.view.invalidated();
}

async function sourceImportCheck(ctx) {
  if (ctx.inflight) return false;
  const { view } = ctx;
  const form = view.read();
  const code = typeof form.code === 'string' ? form.code : '';
  const id = sourceImportTrimmedId(form);
  view.error('', []);
  if (!code.trim()) {
    view.error(t('settings.sourceImport.emptyCode'), []);
    return false;
  }
  const bytes = sourceImportByteLength(code);
  if (bytes > SOURCE_IMPORT_MAX_BYTES) {
    view.tooLarge(bytes, SOURCE_IMPORT_MAX_BYTES);
    return false;
  }
  ctx.checked = null;
  view.clearReport();
  const token = sourceImportBegin(ctx, 'check', { code, id });
  try {
    const body = { code };
    if (id) body.id = id;
    const answer = await ctx.request(SOURCE_IMPORT_PREVIEW_ENDPOINT, { method: 'POST', body: JSON.stringify(body) });
    if (!sourceImportIsCurrent(ctx, token)) return false;
    if (!answer || answer.ok !== true) throw new Error(answer && answer.error);
    const report = sourceImportNormalizeReport(answer);
    ctx.checked = { code, id, report };
    view.showReport(report);
    return true;
  } catch (err) {
    if (sourceImportIsCurrent(ctx, token)) sourceImportShowError(ctx, err);
    return false;
  } finally {
    sourceImportFinish(ctx, token);
  }
}

/**
 * What the screen does after an install that the server accepted. The source IS installed, whatever happened on
 * screen while the request ran (a cancel, a new check), so the toast and the lists stay truthful. The form and the
 * report are only touched while they still belong to this install: text typed meanwhile is never wiped, and a newer
 * check's report is never cleared.
 */
function sourceImportAfterInstall(ctx, sent, answer) {
  const { view } = ctx;
  const installed = answer.installed && typeof answer.installed === 'object' ? answer.installed : {};
  const form = view.read();
  const stillMine = ctx.checked === sent;
  if (stillMine) {
    ctx.checked = null;
    view.clearReport();
  }
  const sameText = form.code === sent.code && sourceImportTrimmedId(form) === sent.id;
  if ((stillMine || ctx.checked === null) && sameText) view.resetForm();
  view.success({
    name: sourceImportCleanText(installed.name || sent.report.id, 200),
    replaced: answer.replaced === true,
    // The report area is free only when no newer report is in it.
    warnings: stillMine
      ? sourceImportCleanList(answer.warnings, (text) => sourceImportCleanText(text, SOURCE_IMPORT_ERROR_MAX_CHARS))
      : [],
  });
}

async function sourceImportInstall(ctx) {
  if (ctx.inflight || !ctx.checked || !ctx.checked.report.canInstall) return false;
  const sent = ctx.checked;
  const body = { sha256: sent.report.sha256, id: sent.report.id };
  if (sent.report.replace) body.replace = true;
  ctx.view.error('', []);
  const token = sourceImportBegin(ctx, 'install', null);
  try {
    const answer = await ctx.request(SOURCE_IMPORT_INSTALL_ENDPOINT, { method: 'POST', body: JSON.stringify(body) });
    if (!answer || answer.ok !== true) throw new Error(answer && answer.error);
    sourceImportAfterInstall(ctx, sent, answer);
    await sourceImportNotifyChanged(ctx);
    return true;
  } catch (err) {
    if (sourceImportIsCurrent(ctx, token)) {
      // 404: the checked file is gone; 409: what was checked no longer holds (the file changed, or the id is now
      // taken or needs a confirmed replacement). Installing the same report again cannot work, so it goes and the
      // text stays: Check is what comes next. The error line stays too.
      if (err && (err.status === 404 || err.status === 409)) {
        ctx.checked = null;
        ctx.view.clearReport();
      }
      sourceImportShowError(ctx, err);
    }
    return false;
  } finally {
    sourceImportFinish(ctx, token);
    sourceImportEdit(ctx);
  }
}

/** Throws away the check result. What the person typed or pasted is left alone: it may be the only copy of their code. */
function sourceImportCancel(ctx) {
  sourceImportSupersede(ctx);
  ctx.checked = null;
  ctx.view.error('', []);
  ctx.view.clearReport();
}

/** Puts the id the file itself names into the id box. The report is about the old id, so it is asked for again. */
function sourceImportAdoptId(ctx) {
  if (ctx.inflight || !ctx.checked || !ctx.checked.report.detectedId) return;
  ctx.view.setId(ctx.checked.report.detectedId);
  sourceImportEdit(ctx);
}

async function sourceImportUninstall(ctx, rawId) {
  const id = String(rawId || '');
  if (ctx.inflight || !SOURCE_IMPORT_ID_RE.test(id)) return false;
  const token = sourceImportBegin(ctx, 'uninstall', null);
  try {
    await ctx.request(SOURCE_IMPORT_UNINSTALL_ENDPOINT, { method: 'POST', body: JSON.stringify({ id }) });
    ctx.view.uninstalled();
  } catch (err) {
    if (sourceImportIsCurrent(ctx, token)) sourceImportShowError(ctx, err);
    return false;
  } finally {
    sourceImportFinish(ctx, token);
    sourceImportEdit(ctx);
  }
  await sourceImportNotifyChanged(ctx);
  return true;
}

/**
 * Runs the live test of an installed source, because the person pressed Test. It calls the real site and can take a minute or
 * two, so nothing else starts meanwhile. The answer is about the installed source, not about the form: typing in the form
 * while it runs does not make it stale, and it is shown either way.
 */
async function sourceImportTest(ctx, rawId, rawDepth) {
  const id = String(rawId || '');
  if (ctx.inflight || !SOURCE_IMPORT_ID_RE.test(id)) return false;
  const depth = rawDepth === 'full' ? 'full' : 'basic';
  ctx.view.error('', []);
  const token = sourceImportBegin(ctx, 'test', null);
  ctx.view.testing(id, true);
  try {
    const answer = await ctx.request(SOURCE_IMPORT_TEST_ENDPOINT, { method: 'POST', body: JSON.stringify({ id, depth }) });
    if (!answer || answer.ok !== true) throw new Error(answer && answer.error);
    ctx.view.showTest(id, answer);
    // The outcome is remembered on the installed entry: re-reading the state updates the "verified" tag.
    await sourceImportNotifyChanged(ctx);
    return true;
  } catch (err) {
    ctx.view.testing(id, false);
    sourceImportShowError(ctx, err);
    return false;
  } finally {
    sourceImportFinish(ctx, token);
    // A Check report that was waiting stays installable only while the form is what it was about.
    sourceImportEdit(ctx);
  }
}

/**
 * @param {object} deps
 * @param {(path: string, opts?: object) => Promise<any>} deps.api   the api() wrapper: rejects with the server's error text (and .status/.data)
 * @param {object} deps.view   { read, busy, showReport, clearReport, invalidated, error, tooLarge, success, uninstalled, resetForm, setId, refreshImported, testing, showTest }
 * @param {() => (void|Promise<void>)} [deps.onChanged]   called after an install or an uninstall (refreshes the source lists)
 */
function createSourceImportController({ api: request, view, onChanged }) {
  // `checked` is what the last successful check was about: the text and the id box as they were, and the clean report.
  // Install uses ONLY this, never what is in the form now.
  const ctx = { request, view, onChanged, checked: null, generation: 0, inflight: null };
  return {
    check: () => sourceImportCheck(ctx),
    install: () => sourceImportInstall(ctx),
    edit: () => sourceImportEdit(ctx),
    cancel: () => sourceImportCancel(ctx),
    adoptDetectedId: () => sourceImportAdoptId(ctx),
    uninstall: (id) => sourceImportUninstall(ctx, id),
    test: (id, depth) => sourceImportTest(ctx, id, depth),
    checkedReport: () => (ctx.checked ? ctx.checked.report : null),
  };
}

// ── DOM glue ──────────────────────────────────────────────────────────────

function sourceImportView(card, notify) {
  const byId = (id) => card.querySelector('#' + id);
  const code = byId('sourceImportCode');
  const id = byId('sourceImportId');
  const file = byId('sourceImportFile');
  const report = byId('sourceImportReport');
  const error = byId('sourceImportError');
  const imported = byId('sourceImportImported');
  const currentSha = (sourceId) => {
    const entry = typeof state !== 'undefined' && state.installedSources ? state.installedSources[sourceId] : null;
    return entry ? String(entry.sha256 || '') : '';
  };
  const resultBox = (sourceId) => [...card.querySelectorAll('[data-test-for]')].find((el) => el.getAttribute('data-test-for') === sourceId) || null;
  const tests = createSourceImportTestStore({ resultBox, currentSha });
  const buttons = () => ['sourceImportCheckBtn', 'sourceImportFileBtn'].map(byId).filter(Boolean);
  return {
    read: () => ({ code: code ? code.value : '', id: id ? id.value : '' }),
    // The report's own buttons are not touched: the controller runs one request at a time, and the stylesheet dims
    // every button of a busy card.
    busy(on) {
      card.setAttribute('aria-busy', on ? 'true' : 'false');
      buttons().forEach((b) => { b.disabled = on; });
    },
    // The markup comes from sourceImportNormalizeReport, so nothing in it is raw server text.
    showReport(value) {
      if (report) report.innerHTML = buildSourceImportReportHtml(value);
    },
    clearReport() { if (report) report.innerHTML = ''; },
    invalidated() { if (report) report.innerHTML = `<p class="setting-description">${sourceImportText('settings.sourceImport.invalidated')}</p>`; },
    // textContent, never innerHTML: the text may be the server's. The reasons are added as list items.
    error(text, details) {
      if (!error) return;
      error.textContent = text || '';
      (Array.isArray(details) ? details : []).forEach((line) => {
        const item = document.createElement('span');
        item.className = 'source-import-error-line';
        item.textContent = line;
        error.appendChild(item);
      });
      // The line sits above the report, far from the Install and Uninstall buttons that were pressed: bring it into view.
      if (text && typeof error.scrollIntoView === 'function') error.scrollIntoView({ block: 'nearest' });
    },
    tooLarge(bytes, max) {
      if (error) error.textContent = sourceImportFill(t('settings.sourceImport.tooLarge'), { bytes, max });
    },
    success(result) {
      const key = result.replaced ? 'settings.sourceImport.replaced' : 'settings.sourceImport.installed';
      notify(t('settings.sourceImport.toastTitle'), sourceImportFill(t(key), { name: result.name }), 'success');
      if (result.warnings.length && report) {
        report.innerHTML = `<div class="source-import-section"><p class="source-import-subtitle">${sourceImportText('settings.sourceImport.warningsTitle')}</p>${
          sourceImportListHtml(result.warnings.map((text) => `<li>${escapeHtml(text)}</li>`))}</div>`;
      }
    },
    uninstalled() { notify(t('settings.sourceImport.toastTitle'), t('settings.sourceImport.uninstalled'), 'success'); },
    resetForm() {
      if (code) code.value = '';
      if (id) id.value = '';
      if (file) file.value = '';
    },
    setId(value) { if (id) id.value = value; },
    // What each test showed, kept here because the list is rebuilt (and its result boxes emptied) when the state is re-read.
    testing(sourceId, on) { if (on) tests.running(sourceId); else tests.failed(sourceId); },
    showTest(sourceId, result) { tests.show(sourceId, result); },
    refreshImported() {
      if (!imported) return;
      imported.innerHTML = buildSourceImportImportedHtml(sourceImportImportedEntries(typeof state !== 'undefined' ? state.installedSources : null));
      tests.reapply();
      if (typeof refreshSourceLinkList === 'function') refreshSourceLinkList(card);
      if (typeof refreshAnimeSourceList === 'function') refreshAnimeSourceList(card);
    },
  };
}

/** Asks before an imported source's file is deleted (the same native question the rest of Settings asks). */
function sourceImportConfirmUninstall(sourceId) {
  const installed = typeof state !== 'undefined' ? state.installedSources : null;
  const entry = sourceImportImportedEntries(installed).find((item) => item.id === sourceId);
  const name = entry ? entry.name : sourceId;
  return typeof confirm !== 'function' || confirm(sourceImportFill(t('settings.sourceImport.uninstallConfirm'), { name }));
}

// The file is read in the browser into the text box, so what is checked is what the person can see and edit. It does
// not touch the id box: the server takes the id from the file's own meta.id, and a file name is not an id.
function sourceImportBindFile(card, controller, view) {
  const file = card.querySelector('#sourceImportFile');
  const code = card.querySelector('#sourceImportCode');
  if (!file) return;
  file.addEventListener('change', async () => {
    const chosen = file.files && file.files[0];
    if (!chosen) return;
    if (chosen.size > SOURCE_IMPORT_MAX_BYTES) {
      view.tooLarge(chosen.size, SOURCE_IMPORT_MAX_BYTES);
      file.value = '';
      return;
    }
    try {
      const text = await chosen.text();
      if (code) code.value = text;
      view.error('', []);
      controller.edit();
    } catch (_) {
      view.error(t('settings.sourceImport.readFailed'), []);
    }
  });
}

function sourceImportBind(card, controller, view) {
  const byId = (id) => card.querySelector('#' + id);
  const code = byId('sourceImportCode');
  const id = byId('sourceImportId');
  const file = byId('sourceImportFile');

  if (code) code.addEventListener('input', () => controller.edit());
  if (id) id.addEventListener('input', () => controller.edit());
  sourceImportBindFile(card, controller, view);

  // One delegated listener: the report and the list are re-rendered, so buttons inside them come and go.
  card.addEventListener('click', (e) => {
    const target = e.target && e.target.closest ? e.target.closest('[data-si-action]') : null;
    if (!target || target.disabled) return undefined;
    // While a request runs nothing can be started again. The stylesheet only stops the mouse; this stops the keyboard.
    if (card.getAttribute('aria-busy') === 'true') return undefined;
    const action = target.getAttribute('data-si-action');
    // The promise is returned for a caller that wants to wait for the request (the browser ignores it).
    if (action === 'choose-file') {
      // Cleared before the picker opens: choosing the same file again fires no change event otherwise.
      if (file) { file.value = ''; file.click(); }
    } else if (action === 'check') return controller.check();
    else if (action === 'install') return controller.install();
    else if (action === 'cancel') controller.cancel();
    else if (action === 'adopt-id') controller.adoptDetectedId();
    else if (action === 'test') return controller.test(target.getAttribute('data-source-id'), target.getAttribute('data-depth'));
    else if (action === 'uninstall') {
      const sourceId = target.getAttribute('data-source-id');
      return sourceImportConfirmUninstall(sourceId) ? controller.uninstall(sourceId) : undefined;
    }
    return undefined;
  });
}

/**
 * Adds the card to the Advanced tab of an open Settings modal, right after the Anime Sources card.
 *
 * Never throws: a failure here must not stop showSettings() from wiring the rest of the modal.
 *
 * @param {HTMLElement} modal
 * @param {() => (void|Promise<void>)} [onChanged]   re-reads the source lists after an install or an uninstall
 * @returns {{card: HTMLElement, controller: object}|null} null when there was nowhere to add it, or it is already there
 */
function mountSourceImportCard(modal, onChanged) {
  try {
    const tab = modal && modal.querySelector('#' + SOURCE_IMPORT_TAB_ID);
    if (!tab || tab.querySelector('#' + SOURCE_IMPORT_CARD_ID)) return null;
    const card = document.createElement('div');
    card.id = SOURCE_IMPORT_CARD_ID;
    card.className = 'settings-section-card source-import-card';
    const installed = typeof state !== 'undefined' ? state.installedSources : null;
    card.innerHTML = buildSourceImportCardHtml(sourceImportImportedEntries(installed));
    const anchorBody = tab.querySelector('#' + SOURCE_IMPORT_ANCHOR_ID);
    const anchor = anchorBody && anchorBody.closest ? anchorBody.closest('.settings-section-card') : null;
    if (anchor) anchor.insertAdjacentElement('afterend', card);
    else tab.appendChild(card);

    const view = sourceImportView(card, showToast);
    const request = typeof animeSourceRequest === 'function' ? animeSourceRequest(card, api) : api; // anime mode: ui-settings-anime-import.js
    const controller = createSourceImportController({ api: request, view, onChanged });
    sourceImportBind(card, controller, view);
    if (typeof mountAnimeSourceMode === 'function') mountAnimeSourceMode(card, controller);
    // The "add from a link" block lives in its own file (ui-settings-source-link.js); the card works without it.
    if (typeof mountSourceLinkBlock === 'function') mountSourceLinkBlock(card, controller, api);
    return { card, controller };
  } catch (err) {
    if (typeof dbg !== 'undefined') dbg.warn(dbg.ERR_SETTINGS, 'Could not add the import-a-source card to Settings', err);
    return null;
  }
}

window.createSourceImportController = createSourceImportController;
window.mountSourceImportCard = mountSourceImportCard;
