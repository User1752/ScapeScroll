// ============================================================================
// AUTH GATE — optional single-password lock, off unless set in Settings.
// See server/modules/auth/service.js for the server-side half; this client
// piece is purely UX (show a login form) — the actual boundary is enforced
// server-side (server/middleware/auth-gate.js rejects /api/* with 401 when
// there's no valid session), so failing open here on a network hiccup just
// means the rest of the app's own API calls will surface the same 401.
//
// There is no button: the lock screen is a text box and nothing else. Two ways in:
//   - Enter: an explicit try, which says "Incorrect password"
//     and clears the field when it is wrong;
//   - a pause in typing (or a password manager filling the field): a SILENT
//     try with what is in the field. If it is right the app opens by itself; if
//     it is wrong nothing happens (no message, the text stays), so someone
//     still typing never sees an error. The server has no lockout, so the
//     silent tries are bounded here instead (AUTH_AUTO_TRY_MAX per page load,
//     none after the server answers 429, and never the same text twice).
// ============================================================================

const AUTH_AUTO_TRY_DELAY_MS = 350;
const AUTH_AUTO_TRY_MAX = 10;

/** Resolves when the password is right; rejects with the server's message (and `status`) when it is not. */
async function authGateLogin(password) {
  const resp = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const data = await resp.json();
  if (!resp.ok || !data.ok) {
    const err = new Error(data.error || 'Incorrect password');
    err.status = resp.status;
    throw err;
  }
}

/**
 * The login form's behaviour, over the elements it needs. `onOpen` runs once, when the password was right.
 * Returns nothing; everything is wired through the elements' handlers.
 */
function wireAuthGate({ overlay, form, input, errorEl, submitBtn = null, onOpen }) {
  let open = false;
  let inFlight = null; // the try that is running, as a promise of "was it right?"
  let timer = null;
  let lastSilentValue = null;
  let silentTries = 0;

  function enter() {
    if (open) return;
    open = true;
    clearTimeout(timer);
    overlay.classList.add('hidden');
    onOpen();
  }

  // One try at a time: what comes back is whether the password was right. A wrong answer is returned, not thrown, so
  // each caller decides what to show.
  function attempt(value) {
    const run = authGateLogin(value).then(
      () => ({ right: true }),
      (err) => ({ right: false, err }),
    );
    // inFlight is what is compared and cleared, so it is the very promise the callbacks refer to.
    const tracked = run.finally(() => { if (inFlight === tracked) inFlight = null; });
    inFlight = tracked;
    return run;
  }

  async function silentTry() {
    const value = input.value;
    if (open || inFlight || !value || value === lastSilentValue || silentTries >= AUTH_AUTO_TRY_MAX) return;
    lastSilentValue = value;
    silentTries += 1;
    const result = await attempt(value);
    if (result.right) enter();
    else if (result.err && result.err.status === 429) silentTries = AUTH_AUTO_TRY_MAX; // told to slow down: stop
  }

  function scheduleSilentTry() {
    clearTimeout(timer);
    errorEl.classList.add('hidden'); // typing again: the old message no longer applies
    timer = setTimeout(silentTry, AUTH_AUTO_TRY_DELAY_MS);
  }

  async function explicitTry() {
    clearTimeout(timer);
    if (inFlight) await inFlight; // a silent try may already be asking; it may even have opened the app
    if (open) return;
    errorEl.classList.add('hidden');
    if (submitBtn) submitBtn.disabled = true;
    try {
      const result = await attempt(input.value);
      if (result.right) {
        enter();
        return;
      }
      errorEl.textContent = (result.err && result.err.message) || 'Incorrect password';
      errorEl.classList.remove('hidden');
      input.value = '';
      lastSilentValue = null;
      input.focus();
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  form.onsubmit = (e) => {
    e.preventDefault();
    return explicitTry();
  };
  // 'input' covers typing and pasting; 'change' covers a password manager that only fires that one.
  input.addEventListener('input', scheduleSilentTry);
  input.addEventListener('change', scheduleSilentTry);
}

async function checkAuthGate() {
  let status;
  try {
    status = await fetch('/api/auth/status').then((r) => r.json());
  } catch (_) {
    return true;
  }
  if (!status?.passwordSet || status.authenticated) return true;

  return new Promise((resolve) => {
    const overlay = document.getElementById('authGateOverlay');
    const form = document.getElementById('authGateForm');
    const input = document.getElementById('authGatePasswordInput');
    const errorEl = document.getElementById('authGateError');
    const submitBtn = document.getElementById('authGateSubmitBtn'); // not in the page any more; a skin that adds one still works
    if (!overlay || !form || !input || !errorEl) { resolve(true); return; }

    overlay.classList.remove('hidden');
    input.focus();
    wireAuthGate({ overlay, form, input, errorEl, submitBtn, onOpen: () => resolve(true) });
  });
}
