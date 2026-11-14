// ============================================================================
// SETTINGS > SUWAYOMI — THE SUWAYOMI-SERVER THIS APP SETS UP AND RUNS ON THIS COMPUTER (WINDOWS)
// ============================================================================
// "Install and use": one confirmation, and the app downloads one tested version of Suwayomi-Server, checks it, unpacks it into a folder inside the
// ScrollScape folder, makes it answer this computer only with a login made for it, starts it and connects to it (server/modules/suwayomi/local-server.js).
// The app starts it with itself and stops it when it closes. This block shows where that is (not set up, setting up with its progress, running, stopped)
// and offers what fits each state: set up, start, stop, start with the app, the firewall rules that keep it from the home network (Windows asks once), remove.
//
// Every answer of the server goes through suwayomiLocalNormalize first: capped plain values, never markup. Each button names what it does before it is
// pressed (setting up and removing ask a second time, in the block itself).

const SUWAYOMI_LOCAL_STATUS = '/api/suwayomi/local/status';
const SUWAYOMI_LOCAL_BUSY_PHASES = ['downloading', 'unpacking', 'configuring', 'starting'];
const SUWAYOMI_LOCAL_PHASES = ['idle', ...SUWAYOMI_LOCAL_BUSY_PHASES, 'done', 'error'];
const SUWAYOMI_LOCAL_POLL_MS = 1000;
// The block that is on the page (set by mountSuwayomiLocal), so the catalog can ask it to show its offer.
let suwayomiLocalController = null;

const suwayomiLocalText = (value, max) => String(value === undefined || value === null ? '' : value).slice(0, max);
const suwayomiLocalCount = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
const suwayomiLocalMb = (bytes) => `${Math.round(suwayomiLocalCount(bytes) / 1048576)} MB`;

/** The answer of the status route as plain capped values. Nothing here is HTML. */
function suwayomiLocalNormalize(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  return {
    supported: a.supported === true,
    reason: suwayomiLocalText(a.reason, 200),
    installed: a.installed === true,
    running: a.running === true,
    phase: SUWAYOMI_LOCAL_PHASES.includes(a.phase) ? a.phase : 'idle',
    message: suwayomiLocalText(a.message, 300),
    received: suwayomiLocalCount(a.received),
    total: suwayomiLocalCount(a.total),
    version: suwayomiLocalText(a.version, 30),
    sizeBytes: suwayomiLocalCount(a.sizeBytes),
    firewall: a.firewall === true ? true : (a.firewall === false ? false : null),
    autoStart: a.autoStart !== false,
  };
}

const suwayomiLocalIsBusy = (state) => !!state && SUWAYOMI_LOCAL_BUSY_PHASES.includes(state.phase);

// ── Markup ────────────────────────────────────────────────────────────────

const suwayomiLocalButton = (action, label, extra = '') => `<button type="button" class="btn secondary" data-local-action="${action}"${extra}>${escapeHtml(label)}</button>`;

/** The line and the bar of the set-up that is running. A bar with no value moves by itself, for the steps that have no count. */
function buildSuwayomiLocalProgressHtml(state) {
  const counted = (state.phase === 'downloading' || state.phase === 'unpacking') && state.total > 0;
  const bar = counted ? `<progress max="${state.total}" value="${Math.min(state.received, state.total)}"></progress>` : '<progress></progress>';
  const detail = state.phase === 'downloading' && state.total > 0 ? ` ${suwayomiLocalMb(state.received)} of ${suwayomiLocalMb(state.total)}` : '';
  return `<div class="suwayomi-local-progress" role="status">${bar}<span class="setting-description">${escapeHtml(state.message || 'Working…')}${escapeHtml(detail)}</span></div>`;
}

/** Not set up yet: what it is, and the button; the second press says exactly what will happen. */
function buildSuwayomiLocalOfferHtml(state, ui) {
  const size = suwayomiLocalMb(state.sizeBytes);
  const failed = ui.note ? `<p class="setting-description suwayomi-local-error">${escapeHtml(ui.note)}</p>` : (state.phase === 'error' && state.message ? `<p class="setting-description suwayomi-local-error">✗ ${escapeHtml(state.message)}</p>` : '');
  if (ui.confirming !== 'install') {
    return `${failed}<p class="setting-description">No Suwayomi-Server yet? ScrollScape can set one up on this computer: one download, no Docker, and it starts and stops with the app.</p>
      <div class="suwayomi-local-actions">${suwayomiLocalButton('install-ask', 'Set up Suwayomi on this computer')}</div>`;
  }
  return `${failed}<div class="suwayomi-local-confirm">
      <p class="setting-description">This downloads Suwayomi-Server ${escapeHtml(state.version)} (about ${escapeHtml(size)}, with its own Java) from the project's page on GitHub, checks it against the SHA-256 GitHub lists for that file, and unpacks it into a <strong>Suwayomi</strong> folder inside your ScrollScape folder. It answers this computer only, with a login made for it, and runs while ScrollScape does. The extensions you add later are programs from third parties; they run inside it, not in ScrollScape.</p>
      <div class="suwayomi-local-actions">${suwayomiLocalButton('install', `Download ${size} and set up`)}${suwayomiLocalButton('cancel', 'Cancel')}</div>
    </div>`;
}

/** Set up: where it is, and what can be done with it. */
function buildSuwayomiLocalManageHtml(state, ui) {
  const busy = ui.working ? ' disabled' : '';
  const note = ui.note ? `<p class="setting-description ${ui.note.startsWith('✗') ? 'suwayomi-local-error' : ''}">${escapeHtml(ui.note)}</p>` : '';
  const failed = state.phase === 'error' && state.message && !ui.note ? `<p class="setting-description suwayomi-local-error">✗ ${escapeHtml(state.message)}</p>` : '';
  const run = state.running
    ? suwayomiLocalButton('stop', ui.working === 'stop' ? 'Stopping…' : 'Stop', busy)
    : suwayomiLocalButton('start', ui.working === 'start' ? 'Starting… (a minute or two)' : 'Start', busy);
  const firewall = state.firewall === null ? '' : `<div class="suwayomi-local-row">
      <span class="setting-description">${state.firewall ? '✓ Windows Firewall keeps it from your home network.' : 'It can reach the other devices of your home network. Windows Firewall can keep it to the internet.'}</span>
      ${state.firewall
    ? suwayomiLocalButton('firewall-remove', 'Remove the rules', busy)
    : suwayomiLocalButton('firewall-add', 'Add the rules (Windows asks first)', busy)}
    </div>`;
  const removing = ui.confirming === 'remove'
    ? `<p class="setting-description">This stops it and deletes its <strong>Suwayomi</strong> folder: the server, the extensions it installed and what it downloaded. Your ScrollScape library is not touched.</p>
       <div class="suwayomi-local-actions">${suwayomiLocalButton('remove', 'Delete the Suwayomi folder', busy)}${suwayomiLocalButton('cancel', 'Cancel')}</div>`
    : `<div class="suwayomi-local-actions">${suwayomiLocalButton('remove-ask', 'Remove Suwayomi from this computer', busy)}</div>`;
  return `${failed}${note}<div class="suwayomi-local-row">
      <span class="suwayomi-local-state ${state.running ? 'is-running' : 'is-stopped'}">${state.running ? '● Running on this computer' : '○ Stopped'}</span>
      ${run}
    </div>
    <label class="toggle-label suwayomi-local-autostart">
      <span class="toggle-text">Start it when ScrollScape starts</span>
      <input type="checkbox" data-local-autostart ${state.autoStart ? 'checked' : ''}>
      <span class="toggle-slider"></span>
    </label>
    ${firewall}${removing}`;
}

/** The whole block for a state. ui: { confirming: 'install'|'remove'|null, working: '', note: '' }. */
function buildSuwayomiLocalHtml(state, ui = {}) {
  if (!state) return '<p class="setting-description">Looking…</p>';
  if (!state.supported) {
    return `<p class="setting-description">${escapeHtml(state.reason || 'This is not available here.')} Run Suwayomi-Server in Docker (see the README) and type its address above.</p>`;
  }
  if (suwayomiLocalIsBusy(state)) return buildSuwayomiLocalProgressHtml(state);
  return state.installed ? buildSuwayomiLocalManageHtml(state, ui) : buildSuwayomiLocalOfferHtml(state, ui);
}

// ── Behaviour ─────────────────────────────────────────────────────────────

/**
 * Draws the block into `root` and keeps it up to date while a set-up runs.
 * @param {HTMLElement} root
 * @param {{ fetchImpl?: Function, setTimer?: Function, onConnected?: () => void }} [options]   onConnected: the address and login were saved or it came up
 * @returns {{ refresh: () => Promise<object>, offerInstall: () => void }}
 */
function mountSuwayomiLocal(root, options = {}) {
  const doFetch = options.fetchImpl || ((...args) => fetch(...args));
  const timer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const onConnected = typeof options.onConnected === 'function' ? options.onConnected : () => {};
  let state = null;
  const ui = { confirming: null, working: '', note: '' };
  let polling = false;
  let wasBusy = false;

  const draw = () => { root.innerHTML = buildSuwayomiLocalHtml(state, ui); };

  async function post(path, body) {
    const res = await doFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    let data = {};
    try { data = await res.json(); } catch (_) { /* no body */ }
    if (!res.ok || data.ok === false) throw new Error(suwayomiLocalText(data.error || `HTTP ${res.status}`, 300));
    return data;
  }

  function schedulePoll() {
    if (polling) return;
    polling = true;
    timer(async () => {
      polling = false;
      if (root.isConnected === false) return;
      await refresh();
    }, SUWAYOMI_LOCAL_POLL_MS);
  }

  async function refresh() {
    try {
      const res = await doFetch(SUWAYOMI_LOCAL_STATUS);
      const data = await res.json();
      // A refusal (the page is opened from another device) is shown as a reason, not as an empty block.
      state = suwayomiLocalNormalize(res.ok ? data : { supported: false, reason: data && data.error });
    } catch (_) {
      state = state || suwayomiLocalNormalize({ supported: false, reason: 'ScrollScape could not be asked.' });
    }
    draw();
    const busy = suwayomiLocalIsBusy(state);
    if (busy) schedulePoll();
    // The set-up that was running has ended and it is up: the address and login are saved, so the boxes above can show them.
    if (wasBusy && !busy && state.installed && state.running) onConnected();
    wasBusy = busy;
    return state;
  }

  /** Runs `work` while the buttons are held, then says how it went and reads the state again. */
  async function act(name, work, done) {
    ui.working = name;
    ui.note = '';
    draw();
    try {
      await work();
      ui.note = done || '';
    } catch (err) {
      ui.note = `✗ ${err.message}`;
    }
    ui.working = '';
    await refresh();
  }

  const actions = {
    'install-ask': () => { ui.confirming = 'install'; draw(); },
    'remove-ask': () => { ui.confirming = 'remove'; draw(); },
    cancel: () => { ui.confirming = null; draw(); },
    install: async () => {
      ui.confirming = null;
      ui.note = '';
      try {
        await post('/api/suwayomi/local/install', { acknowledge: true });
      } catch (err) {
        ui.note = `✗ ${err.message}`;
      }
      await refresh();
    },
    start: () => act('start', async () => { await post('/api/suwayomi/local/start'); onConnected(); }, ''),
    stop: () => act('stop', () => post('/api/suwayomi/local/stop'), ''),
    'firewall-add': () => act('firewall', async () => {
      const answer = await post('/api/suwayomi/local/firewall', { action: 'add' });
      if (!answer.applied) throw new Error('The rules were not added (Windows asked and the answer was no, or it could not be asked).');
    }, '✓ The rules were added.'),
    'firewall-remove': () => act('firewall', async () => {
      const answer = await post('/api/suwayomi/local/firewall', { action: 'remove' });
      if (!answer.applied) throw new Error('The rules were not removed (Windows asked and the answer was no, or it could not be asked).');
    }, '✓ The rules were removed.'),
    remove: () => { ui.confirming = null; return act('remove', () => post('/api/suwayomi/local/uninstall', { confirm: true }), '✓ Removed.'); },
  };

  root.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-local-action]') : null;
    const run = button ? actions[button.getAttribute('data-local-action')] : null;
    return run ? run() : undefined;
  });
  root.addEventListener('change', (event) => {
    if (!event.target || !event.target.hasAttribute || !event.target.hasAttribute('data-local-autostart')) return;
    const enabled = event.target.checked === true;
    return act('autostart', () => post('/api/suwayomi/local/autostart', { enabled }), '');
  });

  draw();
  refresh();
  const controller = { refresh, offerInstall: actions['install-ask'], canOffer: () => !!state && state.supported && !state.installed, root };
  suwayomiLocalController = controller;
  return controller;
}

/**
 * The catalog's "Add via Suwayomi" with no server set up: shows the offer to set one up on this computer, in the Suwayomi tab's block.
 * @returns {boolean} whether there is such an offer (false: the person has a server, or this computer cannot set one up)
 */
function suwayomiLocalOffer() {
  const controller = suwayomiLocalController;
  if (!controller || !controller.canOffer()) return false;
  // The catalog is in the Advanced tab; the offer is drawn in the Suwayomi tab, so open that one first.
  const tab = typeof document !== 'undefined' && typeof document.querySelector === 'function' ? document.querySelector('.settings-nav-item[data-tab="tab-suwayomi"]') : null;
  if (tab && typeof tab.click === 'function') tab.click();
  controller.offerInstall();
  if (controller.root && typeof controller.root.scrollIntoView === 'function') controller.root.scrollIntoView({ block: 'center' });
  if (typeof showToast === 'function') showToast('No Suwayomi-Server is set up yet. You can install one on this computer from here.', '', 'info');
  return true;
}
