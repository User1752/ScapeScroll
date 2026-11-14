// ============================================================================
// SETTINGS > INTEGRATIONS > "PROTECTED SITES" CARD
// ============================================================================
// The three settings of the FlareSolverr session pool (the hidden browser the
// server keeps open between requests to Cloudflare-protected sites; see
// server/config/solver.js and GUIDELINES.md, "Browser calls"): a switch, how
// many browsers may stay open, and after how many idle minutes they are closed.
//
// The card is injected, not part of ui-settings-modal-html.js: showSettings()
// (ui-settings-modal.js) only calls mountSolverSettingsCard(modal, onSaved)
// once the modal is in the DOM, and does nothing if this file is missing.
//
// The server owns the values (the pool lives in its process), so they are read
// with GET /api/settings and saved with POST /api/settings, like the other
// server-side cards (FlareSolverr URL, Discord). Two choices follow from how
// the route judges a save:
//   - a save carries ONLY the key that was just changed. The route validates
//     every solver key it receives all-or-nothing, and this tab's copy of the
//     other two may be stale (another tab) or, when the load failed, only the
//     defaults: sending all three could overwrite real values with guesses;
//   - the server's refusal text is shown next to the field it concerns and the
//     field goes back to the last value the server confirmed. A value that was
//     refused is never left on screen looking saved.
// No polling and no status block: the pool's live state is the System Health
// "External Services" row.
//
// Layers, so that all but the last are testable without a browser:
//   solverCard*Html / buildSolverSettingsCardHtml   markup (every value escaped)
//   createSolverSettingsController                  load / save logic, over a view port
//   solverCardView / solverCardBind / mount...      the thin DOM glue

const SOLVER_CARD_ID = 'solverSettingsCard';
const SOLVER_CARD_TAB_ID = 'tab-network';
const SOLVER_CARD_LOAD_ERROR_ID = 'solverSettingsLoadError';
const SOLVER_CARD_ENDPOINT = '/api/settings';
// The server's refusal is a sentence naming a key and its bounds; this only keeps
// a runaway message from stretching the card.
const SOLVER_CARD_ERROR_MAX_CHARS = 300;

// Mirror of SETTINGS_DEFAULTS and SETTINGS_BOUNDS in server/config/solver.js (the
// browser cannot require it); tests/unit/frontend-solver-ui.test.js fails when the
// two drift apart. They only seed the inputs and give them min/max: the server stays
// the judge of what is accepted. Every id here ends up in an attribute, so each is
// a plain constant.
const SOLVER_CARD_FIELDS = Object.freeze([
  Object.freeze({
    key: 'solverSessionsEnabled',
    kind: 'toggle',
    inputId: 'solverSessionsEnabledToggle',
    errorId: 'solverSessionsEnabledError',
    fallback: false,
  }),
  Object.freeze({
    key: 'solverSessionPoolSize',
    kind: 'number',
    inputId: 'solverSessionPoolSizeInput',
    rangeId: 'solverSessionPoolSizeRange',
    errorId: 'solverSessionPoolSizeError',
    labelKey: 'settings.solver.poolSizeLabel',
    min: 1,
    max: 3,
    fallback: 2,
  }),
  Object.freeze({
    key: 'solverSessionIdleMinutes',
    kind: 'number',
    inputId: 'solverSessionIdleMinutesInput',
    rangeId: 'solverSessionIdleMinutesRange',
    errorId: 'solverSessionIdleMinutesError',
    labelKey: 'settings.solver.idleMinutesLabel',
    min: 1,
    max: 15,
    fallback: 10,
  }),
]);

// ── Pure helpers ──────────────────────────────────────────────────────────

/** Replaces {name} placeholders; a placeholder with no value is left as written. */
function solverCardFill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
  ));
}

/** A stored value as the card will show it: junk (wrong type, out of range) becomes the default. */
function solverCardValueOf(field, raw) {
  if (field.kind === 'toggle') return typeof raw === 'boolean' ? raw : field.fallback;
  return Number.isInteger(raw) && raw >= field.min && raw <= field.max ? raw : field.fallback;
}

/**
 * What an input holds, as the value to send. An empty or unreadable number becomes null,
 * which the server refuses with its own message: the bounds are judged in one place.
 */
function solverCardParse(field, raw) {
  if (field.kind === 'toggle') return raw === true;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  const number = text === '' ? NaN : Number(text);
  return Number.isFinite(number) ? number : null;
}

/**
 * The text to show for a failed save. The server's own refusal is shown as it is; what a
 * browser or the wrapper makes up (a network TypeError, "HTTP 500") is replaced by a
 * translated sentence. `err.name` and not instanceof: the error may come from another realm.
 */
function solverCardErrorText(err) {
  const message = err && typeof err.message === 'string' ? err.message.trim() : '';
  const madeUp = !message || err.name === 'TypeError' || /^HTTP \d{3}$/.test(message);
  return madeUp ? t('settings.solver.saveFailed') : message.slice(0, SOLVER_CARD_ERROR_MAX_CHARS);
}

// ── Markup ────────────────────────────────────────────────────────────────

function solverCardText(key) {
  return escapeHtml(t(key));
}

function solverCardToggleHtml(field, checked) {
  // Named as the page names them, so the pointer matches the menu the user will look in.
  const where = t('nav.systemHealth') + ' > ' + t('systemHealth.section.services');
  return `
    <div class="setting-group">
      <label class="toggle-label" for="${field.inputId}">
        <span class="toggle-text" data-i18n="settings.solver.enabledLabel">${solverCardText('settings.solver.enabledLabel')}</span>
        <input type="checkbox" role="switch" id="${field.inputId}" aria-describedby="solverSessionsHint ${field.errorId}"${checked ? ' checked' : ''}>
        <span class="toggle-slider"></span>
      </label>
      <p class="setting-description solver-settings-error" id="${field.errorId}" role="alert"></p>
      <p class="setting-description" id="solverSessionsHint" data-i18n="settings.solver.hint">${solverCardText('settings.solver.hint')}</p>
      <p class="setting-description">${escapeHtml(solverCardFill(t('settings.solver.statusNote'), { where }))}</p>
      <p class="setting-description solver-settings-env" data-i18n="settings.solver.envNote">${solverCardText('settings.solver.envNote')}</p>
    </div>`;
}

function solverCardNumberHtml(field, value) {
  const range = solverCardFill(t('settings.solver.range'), { min: field.min, max: field.max });
  return `
    <div class="setting-group">
      <label for="${field.inputId}" data-i18n="${field.labelKey}">${solverCardText(field.labelKey)}</label>
      <input type="number" class="input" id="${field.inputId}" min="${escapeHtml(String(field.min))}" max="${escapeHtml(String(field.max))}" step="1" inputmode="numeric" value="${escapeHtml(String(value))}" aria-describedby="${field.rangeId} ${field.errorId}">
      <p class="setting-description" id="${field.rangeId}">${escapeHtml(range)}</p>
      <p class="setting-description solver-settings-error" id="${field.errorId}" role="alert"></p>
    </div>`;
}

/**
 * The inside of the card (its wrapper is made by mountSolverSettingsCard).
 * `values` is whatever the server stored, or nothing: every field goes through
 * solverCardValueOf, so a hostile or malformed value cannot reach the markup.
 */
function buildSolverSettingsCardHtml(values) {
  const stored = values && typeof values === 'object' ? values : {};
  const [toggle, pool, idle] = SOLVER_CARD_FIELDS;
  return `
    <p class="settings-section-title" data-i18n="settings.solver.title">${solverCardText('settings.solver.title')}</p>
    <p class="setting-description solver-settings-error" id="${SOLVER_CARD_LOAD_ERROR_ID}" role="alert"></p>
    ${solverCardToggleHtml(toggle, solverCardValueOf(toggle, stored[toggle.key]))}
    ${solverCardNumberHtml(pool, solverCardValueOf(pool, stored[pool.key]))}
    ${solverCardNumberHtml(idle, solverCardValueOf(idle, stored[idle.key]))}`;
}

// ── Load / save logic ─────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {(path: string, opts?: object) => Promise<any>} deps.api   the api() wrapper: rejects with the server's error text on a non-2xx
 * @param {{show: Function, error: Function, busy: Function, loadFailed: Function}} deps.view
 * @param {() => void} [deps.onSaved]   called after each confirmed save
 */
function createSolverSettingsController({ api: request, view, onSaved }) {
  // The last values the server confirmed; until the load answers, the defaults.
  const committed = {};
  for (const f of SOLVER_CARD_FIELDS) committed[f.key] = f.fallback;
  // Saves run one after the other, so two quick changes of one field cannot finish out of order.
  let queue = Promise.resolve();
  const pending = {};
  // Keys the user has typed in since their last commit: typing fires "input" (edit) and the value is only
  // committed by "change", so until then a save that finishes must leave the field alone.
  const typing = {};
  const fieldOf = (key) => SOLVER_CARD_FIELDS.find((f) => f.key === key);

  async function load() {
    view.busy(true);
    let failed = false;
    try {
      const body = await request(SOLVER_CARD_ENDPOINT);
      const stored = body && body.ok === true && body.data && typeof body.data === 'object' ? body.data : null;
      if (!stored) throw new Error('unreadable');
      for (const f of SOLVER_CARD_FIELDS) committed[f.key] = solverCardValueOf(f, stored[f.key]);
    } catch (_) {
      failed = true;
    }
    for (const f of SOLVER_CARD_FIELDS) view.show(f.key, committed[f.key]);
    view.loadFailed(failed);
    view.busy(false);
    return !failed;
  }

  // Only the last pending save of a key touches the screen, and not while the user is typing in the field:
  // an earlier one that finishes while the user has already changed the field again (or started to) must
  // not reset what they are typing.
  async function persist(field, value) {
    let failure = null;
    try {
      const res = await request(SOLVER_CARD_ENDPOINT, { method: 'POST', body: JSON.stringify({ [field.key]: value }) });
      if (res && res.ok === false) throw new Error(res.error);
    } catch (err) {
      failure = err;
    }
    pending[field.key] -= 1;
    const latest = pending[field.key] === 0 && !typing[field.key];
    if (failure) {
      if (latest) {
        view.show(field.key, committed[field.key]);
        view.error(field.key, solverCardErrorText(failure));
      }
      return false;
    }
    committed[field.key] = value;
    if (latest) view.show(field.key, value);
    try { if (typeof onSaved === 'function') onSaved(); } catch (_) { /* the "saved" flash is not the save */ }
    return true;
  }

  /** The user changed a control: save that one key. Resolves true when the server accepted it. */
  function change(key, raw) {
    const field = fieldOf(key);
    if (!field) return Promise.resolve(false);
    view.error(key, '');
    typing[key] = false;
    const value = solverCardParse(field, raw);
    pending[key] = (pending[key] || 0) + 1;
    const run = queue.then(() => persist(field, value));
    queue = run.catch(() => false); // a step that threw must not block the saves behind it
    return run;
  }

  /** The user is typing again: the refusal shown for the previous attempt no longer applies. */
  function edit(key) {
    typing[key] = true;
    view.error(key, '');
  }

  return { load, change, edit, committed: () => ({ ...committed }) };
}

// ── DOM glue ──────────────────────────────────────────────────────────────

function solverCardView(card) {
  const controls = SOLVER_CARD_FIELDS.map((field) => ({
    field,
    input: card.querySelector('#' + field.inputId),
    error: card.querySelector('#' + field.errorId),
  }));
  const controlOf = (key) => controls.find((c) => c.field.key === key);
  const loadError = card.querySelector('#' + SOLVER_CARD_LOAD_ERROR_ID);
  return {
    show(key, value) {
      const c = controlOf(key);
      if (!c || !c.input) return;
      if (c.field.kind === 'toggle') c.input.checked = value === true;
      else c.input.value = String(value);
    },
    // textContent, never innerHTML: the text may be the server's.
    error(key, text) {
      const c = controlOf(key);
      if (!c) return;
      if (c.error) c.error.textContent = text;
      if (!c.input) return;
      c.input.classList.toggle('is-invalid', !!text);
      if (text) c.input.setAttribute('aria-invalid', 'true');
      else c.input.removeAttribute('aria-invalid');
    },
    // Disabled only while the current values are being read, so an early click cannot be overwritten by the answer.
    busy(on) {
      card.setAttribute('aria-busy', on ? 'true' : 'false');
      controls.forEach((c) => { if (c.input) c.input.disabled = on; });
    },
    loadFailed(on) {
      if (loadError) loadError.textContent = on ? t('settings.solver.loadFailed') : '';
    },
  };
}

function solverCardBind(card, controller) {
  for (const field of SOLVER_CARD_FIELDS) {
    const input = card.querySelector('#' + field.inputId);
    if (!input) continue;
    // "change" (not "input"): a number is saved when it is committed, not on every keystroke.
    input.addEventListener('change', () => controller.change(field.key, field.kind === 'toggle' ? input.checked : input.value));
    if (field.kind === 'number') input.addEventListener('input', () => controller.edit(field.key));
  }
}

/**
 * Adds the card to the Integrations tab of an open Settings modal, right after its first
 * card (Network & Anti-Bot), and starts reading the current values.
 *
 * Never throws: a failure here must not stop showSettings() from wiring the rest of the modal.
 *
 * @param {HTMLElement} modal
 * @param {() => void} [onSaved]   the modal's "Saved" flash
 * @returns {{card: HTMLElement, controller: object, loaded: Promise<boolean>}|null} null when there was nowhere to add it, or it is already there
 */
function mountSolverSettingsCard(modal, onSaved) {
  try {
    const tab = modal && modal.querySelector('#' + SOLVER_CARD_TAB_ID);
    if (!tab || tab.querySelector('#' + SOLVER_CARD_ID)) return null;
    const card = document.createElement('div');
    card.id = SOLVER_CARD_ID;
    card.className = 'settings-section-card solver-settings-card';
    card.setAttribute('aria-busy', 'true');
    card.innerHTML = buildSolverSettingsCardHtml();
    const anchor = tab.querySelector('.settings-section-card');
    if (anchor) anchor.insertAdjacentElement('afterend', card);
    else tab.appendChild(card);

    const controller = createSolverSettingsController({ api, view: solverCardView(card), onSaved });
    solverCardBind(card, controller);
    return { card, controller, loaded: controller.load() };
  } catch (err) {
    if (typeof dbg !== 'undefined') dbg.warn(dbg.ERR_SETTINGS, 'Could not add the protected-sites card to Settings', err);
    return null;
  }
}

window.SOLVER_CARD_FIELDS = SOLVER_CARD_FIELDS;
window.buildSolverSettingsCardHtml = buildSolverSettingsCardHtml;
window.createSolverSettingsController = createSolverSettingsController;
window.mountSolverSettingsCard = mountSolverSettingsCard;
