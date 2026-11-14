// ============================================================================
// READING STATUS
// ============================================================================

async function loadReadingStatus() {
  try {
    const data = await api("/api/user/status");
    state.readingStatus = data.readingStatus || {};
  } catch (e) { /* non-fatal */ }
}

function _statusStoreKeyPart(v) {
  return String(v || '').replace(/[^a-z0-9:_-]/gi, '_');
}

function _statusStoreKey(mangaId, sourceId) {
  return `${_statusStoreKeyPart(mangaId)}:${_statusStoreKeyPart(sourceId || 'unknown')}`;
}

function getMangaStatus(mangaId, sourceId) {
  return state.readingStatus[_statusStoreKey(mangaId, sourceId)]?.status || null;
}

// ── Journal-style re-read prompt ────────────────────────────────────────────
// Opening a chapter for a manga marked "completed" a while ago is genuinely
// ambiguous: it could be an actual re-read, or just catching up on new
// chapters a source added after the manga was marked done — readingStatus is
// a pure user-set sidecar (never auto-derived from reading activity, see
// content-service.js's setUserStatus), so without this it would just stay
// stuck on "Completed" forever either way. Asking once, instead of silently
// picking one interpretation, means neither case loses anything: confirming
// flips status to Reading same as the manual selector above would; declining
// just keeps reading with nothing changed, snoozed for a day so it doesn't
// re-ask on every single chapter in the same sitting.
const REREAD_PROMPT_MIN_DAYS_SINCE_COMPLETED = 14;
const REREAD_PROMPT_SNOOZE_KEY = 'scrollscape_reread_prompt_snoozed';
const REREAD_PROMPT_SNOOZE_MS = 24 * 60 * 60 * 1000;

function _rereadSnoozeMap() {
  try { return JSON.parse(localStorage.getItem(REREAD_PROMPT_SNOOZE_KEY) || '{}'); }
  catch (_) { return {}; }
}

function _isRereadPromptSnoozed(mangaId) {
  const until = _rereadSnoozeMap()[mangaId];
  return typeof until === 'number' && Date.now() < until;
}

function _snoozeRereadPrompt(mangaId) {
  const map = _rereadSnoozeMap();
  map[mangaId] = Date.now() + REREAD_PROMPT_SNOOZE_MS;
  try { localStorage.setItem(REREAD_PROMPT_SNOOZE_KEY, JSON.stringify(map)); } catch (_) {}
}

function _showRereadPromptBanner(mangaId, sourceId, mangaTitle) {
  document.getElementById('rereadPromptBanner')?.remove();
  const banner = document.createElement('div');
  banner.id = 'rereadPromptBanner';
  banner.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:14px;background:var(--surface-2,#1c1c22);border:1px solid var(--border,#333);border-radius:10px;padding:12px 16px;box-shadow:0 8px 24px rgba(0,0,0,0.4);max-width:92vw;';
  banner.innerHTML = `
    <span style="font-size:0.9rem">Reading "${escapeHtml(mangaTitle)}" again? It's marked Completed.</span>
    <div style="display:flex;gap:8px;flex-shrink:0">
      <button class="btn primary" id="rereadPromptYes" style="white-space:nowrap">Mark as Reading</button>
      <button class="btn secondary" id="rereadPromptNo" style="white-space:nowrap">Not now</button>
    </div>
  `;
  document.body.appendChild(banner);

  $('rereadPromptYes').onclick = async () => {
    try {
      await api("/api/user/status", {
        method: "POST",
        body: JSON.stringify({ mangaId, sourceId, status: 'reading', mangaData: state.currentManga || {} }),
      });
      state.readingStatus[_statusStoreKey(mangaId, sourceId)] = { status: 'reading', updatedAt: new Date().toISOString() };
      showToast("Status Updated", statusLabel('reading'), "success");
      if (typeof renderLibrary === 'function') renderLibrary();
    } catch (err) {
      showToast("Error", err.message, "error");
    }
    banner.remove();
  };
  $('rereadPromptNo').onclick = () => {
    _snoozeRereadPrompt(mangaId);
    banner.remove();
  };
}

// Called once a chapter open has actually committed (loadChapter,
// ui-add-to-list-modal.js) — not on every navigation attempt, only once the
// read is real.
function maybeShowRereadPrompt(mangaId, sourceId, mangaTitle) {
  const entry = state.readingStatus[_statusStoreKey(mangaId, sourceId)];
  if (entry?.status !== 'completed' || !entry.updatedAt) return;

  const daysSince = (Date.now() - new Date(entry.updatedAt).getTime()) / (24 * 60 * 60 * 1000);
  if (daysSince < REREAD_PROMPT_MIN_DAYS_SINCE_COMPLETED) return;
  if (_isRereadPromptSnoozed(mangaId)) return;

  _showRereadPromptBanner(mangaId, sourceId, mangaTitle);
}

function renderReadingStatusSection(mangaId, sourceId) {
  const section = $("readingStatusSection");
  if (!section) return;
  const current = getMangaStatus(mangaId, sourceId);
  section.innerHTML = `
    <div class="status-selector-section">
      <span class="status-selector-label">Reading Status:</span>
      <select class="status-select" id="mangaStatusSelect">
        <option value="none" ${!current ? "selected" : ""}>— Not Set —</option>
        <option value="reading"      ${current === "reading"       ? "selected" : ""}>Reading</option>
        <option value="completed"    ${current === "completed"     ? "selected" : ""}>Completed</option>
        <option value="on_hold"      ${current === "on_hold"       ? "selected" : ""}>On Hold</option>
        <option value="plan_to_read" ${current === "plan_to_read"  ? "selected" : ""}>Plan to Read</option>
        <option value="dropped"      ${current === "dropped"       ? "selected" : ""}>Dropped</option>
      </select>
    </div>
  `;
  $("mangaStatusSelect").onchange = async (e) => {
    const newStatus = e.target.value;
    try {
      await api("/api/user/status", {
        method: "POST",
        body: JSON.stringify({
          mangaId, sourceId, status: newStatus,
          mangaData: state.currentManga || {}
        })
      });
      const key = _statusStoreKey(mangaId, sourceId);
      state.readingStatus[key] = newStatus !== "none"
        ? { status: newStatus, updatedAt: new Date().toISOString() }
        : undefined;
      if (newStatus === "none") delete state.readingStatus[key];
      showToast("Status Updated", statusLabel(newStatus), "success");
      renderReadingStatusSection(mangaId, sourceId);
      renderLibrary();
      await checkAndUnlockAchievements();
    } catch (err) {
      showToast("Error", err.message, "error");
    }
  };
}

