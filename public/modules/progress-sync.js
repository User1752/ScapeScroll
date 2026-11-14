// ============================================================================
// READING PROGRESS SYNC
//
// The chapters read, where each manga was left (chapter and page), the highest chapter number and the flagged chapters used to live
// only in this browser's localStorage: per address (localhost:4000 and 192.168.1.97:4000 were two libraries), per browser, and in no
// backup of the server. They are kept on the server now (server/modules/progress/service.js). This browser keeps its copy in
// localStorage (fast, and it works offline) and keeps the server's in step.
//
// How, in short:
//  - Every change to the progress ends in saveSettings(), so that is the one place this listens (progressSyncMarkDirty). After a
//    short pause the CHANGES since the last sync are worked out (a diff against `_psBase`, what the server has plus what is still
//    waiting to be sent) and sent as small idempotent ops, never as the whole state: two browsers cannot overwrite each other's
//    reading with an old picture of the library.
//  - What is waiting to be sent is kept in localStorage (the queue), so closing the tab does not lose it, and it is retried.
//  - At start the server is the truth: this browser takes its progress, then replays what was still waiting. The first time THIS
//    browser meets a server that already has progress it only ADDS what it has that the server lacks (nothing it has is lost, and
//    nothing is taken away from the server); on a server that has none, it uploads everything it has.
//  - Replacing one side with the other is never automatic: it is the two buttons of the card in Settings → Data & Backup.
// ============================================================================

const PS_QUEUE_KEY = 'scrollscapeProgressQueue';
const PS_SYNCED_KEY = 'scrollscapeProgressSynced';
const PS_FORCE_KEY = 'scrollscapeProgressForceUpload';
const PS_CHUNK = 1500;          // keys in one request (the server reads up to 5 MB, a key is ~40 bytes)
const PS_DEBOUNCE_MS = 2500;
const PS_CONFLICT_MIN = 100;     // a conflict is only called when this browser has at least this many chapters read...
const PS_CONFLICT_RATIO = 0.7;   // ...and the server has under this share of them

let _psBase = null;              // { read:Set, flagged:Set, last:{mangaId:chapterId}, highest, pages, totals }: the server's copy plus the queue
let _psQueue = [];               // ops not acknowledged yet
let _psReady = false;
let _psSuppress = false;         // true while the state is being replaced from the server (that must not be sent back as a change)
let _psDirtyBeforeReady = false;
let _psConflict = false;         // the server has far less progress than this browser: nothing is synced until the person chooses
let _psTimer = null;
let _psSendPromise = null;       // the send that is running, so a second caller waits for it instead of returning early
let _psRetryMs = 0;
let _psLastSyncAt = null;
let _psError = '';

const _psEmpty = () => ({ read: new Set(), flagged: new Set(), last: {}, highest: {}, pages: {}, totals: {} });

function _psSnapshot() {
  return {
    read: new Set(state.readChapters || []),
    flagged: new Set(state.flaggedChapters || []),
    last: { ...(state.lastReadChapter || {}) },
    highest: { ...(state.highestReadChapter || {}) },
    pages: { ...(state.lastReadPages || {}) },
    totals: { ...(state.lastReadPageTotals || {}) },
  };
}

function _psCopy(s) {
  return { read: new Set(s.read), flagged: new Set(s.flagged), last: { ...s.last }, highest: { ...s.highest }, pages: { ...s.pages }, totals: { ...s.totals } };
}

function _psFromServer(data) {
  const last = {};
  for (const [m, v] of Object.entries(data.last || {})) if (v && v.c != null) last[m] = String(v.c);
  return { read: new Set(data.read || []), flagged: new Set(data.flagged || []), last, highest: { ...(data.highest || {}) }, pages: { ...(data.pages || {}) }, totals: { ...(data.totals || {}) } };
}

const _psNum = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

// The ops that turn `base` into `cur`. `at` stamps the chapter each manga was left at (the newer one wins on the server).
function _psDiff(base, cur, at) {
  const ops = { readAdd: [], readRemove: [], flaggedAdd: [], flaggedRemove: [], last: {}, highest: {}, pages: {}, totals: {} };
  for (const k of cur.read) if (!base.read.has(k)) ops.readAdd.push(k);
  for (const k of base.read) if (!cur.read.has(k)) ops.readRemove.push(k);
  for (const k of cur.flagged) if (!base.flagged.has(k)) ops.flaggedAdd.push(k);
  for (const k of base.flagged) if (!cur.flagged.has(k)) ops.flaggedRemove.push(k);
  for (const [m, c] of Object.entries(cur.last)) if (c != null && String(base.last[m]) !== String(c)) ops.last[m] = { c: String(c), at };
  for (const m of Object.keys(base.last)) if (!(m in cur.last)) ops.last[m] = null;
  for (const name of ['highest', 'pages', 'totals']) {
    for (const [k, v] of Object.entries(cur[name])) { const n = _psNum(v); if (n !== null && base[name][k] !== n) ops[name][k] = n; }
    for (const k of Object.keys(base[name])) if (!(k in cur[name])) ops[name][k] = null;
  }
  const empty = !ops.readAdd.length && !ops.readRemove.length && !ops.flaggedAdd.length && !ops.flaggedRemove.length
    && !Object.keys(ops.last).length && !Object.keys(ops.highest).length && !Object.keys(ops.pages).length && !Object.keys(ops.totals).length;
  return empty ? null : ops;
}

// The same ops applied to a copy (this mirrors the server; `highest` is set exactly here, the server only raises it).
function _psApply(base, ops) {
  if (ops.reset) { base.read.clear(); base.flagged.clear(); base.last = {}; base.highest = {}; base.pages = {}; base.totals = {}; }
  for (const k of ops.readRemove || []) base.read.delete(k);
  for (const k of ops.readAdd || []) base.read.add(k);
  for (const k of ops.flaggedRemove || []) base.flagged.delete(k);
  for (const k of ops.flaggedAdd || []) base.flagged.add(k);
  for (const [m, v] of Object.entries(ops.last || {})) { if (v === null) delete base.last[m]; else base.last[m] = String(v.c); }
  for (const name of ['highest', 'pages', 'totals']) {
    for (const [k, v] of Object.entries(ops[name] || {})) { if (v === null) delete base[name][k]; else base[name][k] = v; }
  }
  return base;
}

// Pieces small enough for one request; the flags (reset, init, legacy) go with the first piece (legacy with all of them).
function _psSplit(input, flags = {}) {
  const ops = { readAdd: [], readRemove: [], flaggedAdd: [], flaggedRemove: [], last: {}, highest: {}, pages: {}, totals: {}, ...(input || {}) };
  const pieces = [];
  const piece = () => ({ readAdd: [], readRemove: [], flaggedAdd: [], flaggedRemove: [], last: {}, highest: {}, pages: {}, totals: {}, ...(flags.legacy ? { legacy: true } : {}) });
  let cur = piece();
  let count = 0;
  const push = () => { pieces.push(cur); cur = piece(); count = 0; };
  const take = (n = 1) => { if (count + n > PS_CHUNK) push(); count += n; };
  for (const name of ['readRemove', 'readAdd', 'flaggedRemove', 'flaggedAdd']) for (const k of ops[name]) { take(); cur[name].push(k); }
  for (const name of ['last', 'highest', 'pages', 'totals']) for (const [k, v] of Object.entries(ops[name])) { take(); cur[name][k] = v; }
  if (count || !pieces.length) pieces.push(cur);
  if (flags.reset) pieces[0].reset = true;
  if (flags.init) pieces[0].init = true;
  return pieces;
}

function _psPersistQueue() {
  try {
    if (_psQueue.length) localStorage.setItem(PS_QUEUE_KEY, JSON.stringify(_psQueue));
    else localStorage.removeItem(PS_QUEUE_KEY);
  } catch (e) { dbg.warn(dbg.ERR_SETTINGS, 'Could not keep the progress queue in localStorage', e); }
}

function _psLoadQueue() {
  try { const q = JSON.parse(localStorage.getItem(PS_QUEUE_KEY) || '[]'); return Array.isArray(q) ? q : []; } catch (_) { return []; }
}

async function _psPost(ops) {
  const res = await fetch('/api/progress/ops', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ops }) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res.json().catch(() => ({}));
}

// Sends what is waiting, oldest first. A request the server refuses for good (400/413: it will never accept it) is dropped so it
// cannot block everything behind it; anything else (offline, 5xx, not signed in) is retried later, slower each time.
function _psSend() {
  if (_psSendPromise) return _psSendPromise;
  if (!_psQueue.length) return Promise.resolve();
  _psSendPromise = _psSendLoop().finally(() => { _psSendPromise = null; });
  return _psSendPromise;
}

async function _psSendLoop() {
  try {
    while (_psQueue.length) {
      try {
        await _psPost(_psQueue[0]);
      } catch (e) {
        if (e.status === 400 || e.status === 413) { dbg.warn(dbg.ERR_SETTINGS, 'The server refused a progress change; it is dropped', e); _psQueue.shift(); _psPersistQueue(); continue; }
        throw e;
      }
      _psQueue.shift();
      _psPersistQueue();
      _psLastSyncAt = Date.now();
      _psError = '';
    }
    _psRetryMs = 0;
  } catch (e) {
    _psError = e.message || 'could not reach the server';
    _psRetryMs = Math.min(60_000, (_psRetryMs || 2_000) * 2);
    setTimeout(_psSend, _psRetryMs);
  }
}

// Works out what changed and queues it (synchronously: this is what runs when the page is being closed), then sends.
function _psCapture() {
  if (!_psReady || !_psBase) return;
  const ops = _psDiff(_psBase, _psSnapshot(), Date.now());
  if (!ops) return;
  _psQueue.push(..._psSplit(ops));
  _psPersistQueue();
  _psApply(_psBase, ops);
}

async function progressSyncFlushNow() {
  clearTimeout(_psTimer);
  _psTimer = null;
  _psCapture();
  await _psSend();
}

// Called by saveSettings() (and by anything else that writes the progress keys directly).
// Not restarted by every call: a person turning pages for minutes would never reach a pause. The first change opens a short window and
// everything that changed by its end goes together.
function progressSyncMarkDirty() {
  if (_psSuppress) return;
  if (!_psReady) { _psDirtyBeforeReady = true; return; }
  if (_psTimer) return;
  _psTimer = setTimeout(() => { _psTimer = null; _psCapture(); _psSend(); }, PS_DEBOUNCE_MS);
}

// Puts a copy of the progress into the state and into localStorage, without telling the sync it changed.
function _psAssignToState(s) {
  _psSuppress = true;
  try {
    state.readChapters = new Set(s.read);
    state.flaggedChapters = new Set(s.flagged);
    state.lastReadChapter = { ...s.last };
    state.highestReadChapter = { ...s.highest };
    state.lastReadPages = { ...s.pages };
    state.lastReadPageTotals = { ...s.totals };
    if (typeof saveSettings === 'function') saveSettings();
  } finally {
    _psSuppress = false;
  }
}

function _psSameProgress(a, b) {
  return a.read.size === b.read.size && a.flagged.size === b.flagged.size && [...a.read].every((k) => b.read.has(k))
    && JSON.stringify(a.last) === JSON.stringify(b.last) && JSON.stringify(a.highest) === JSON.stringify(b.highest);
}

function _psRefreshUi() {
  try {
    if (typeof renderLibrary === 'function') renderLibrary();
    if (state.currentManga && typeof renderChaptersList === 'function' && document.getElementById('chaptersList')) renderChaptersList();
  } catch (e) { dbg.warn(dbg.ERR_SETTINGS, 'Could not redraw after the progress sync', e); }
}

// The ops that ONLY ADD what `local` has and `server` lacks. Used when this browser meets a server that already has progress: nothing
// is taken away from either side, and where both have a position the server's is kept (a browser has no times to compare with).
function _psAdditions(server, local) {
  const ops = _psDiff(server, local, Date.now()) || { readAdd: [], flaggedAdd: [], last: {}, highest: {}, pages: {}, totals: {} };
  const add = { readAdd: ops.readAdd, readRemove: [], flaggedAdd: ops.flaggedAdd, flaggedRemove: [], last: {}, highest: {}, pages: {}, totals: {} };
  for (const [m, v] of Object.entries(ops.last)) if (v !== null && !(m in server.last)) add.last[m] = v;
  for (const [k, v] of Object.entries(ops.highest)) if (v !== null && v > (server.highest[k] || 0)) add.highest[k] = v;
  for (const name of ['pages', 'totals']) for (const [k, v] of Object.entries(ops[name])) if (v !== null && !(k in server[name])) add[name][k] = v;
  return add;
}

async function _psUpload(ops, flags) {
  for (const piece of _psSplit(ops, flags)) await _psPost(piece);
}

async function progressSyncInit() {
  try {
    const res = await fetch('/api/progress');
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const data = await res.json();
    const server = _psFromServer(data);
    const local = _psSnapshot();
    const force = localStorage.getItem(PS_FORCE_KEY) === '1';
    let merged;

    if (force) {
      // A backup file was just restored in this browser: its progress replaces the server's.
      await _psUpload(_psDiff(_psEmpty(), local, Date.now()) || {}, { reset: true, init: true, legacy: true });
      localStorage.removeItem(PS_FORCE_KEY);
      _psQueue = [];
      merged = local;
    } else if (!data.initialized) {
      // The server has no progress yet: this browser's is the first.
      await _psUpload(_psDiff(_psEmpty(), local, Date.now()) || {}, { init: true, legacy: true });
      _psQueue = [];
      merged = local;
    } else if (localStorage.getItem(PS_SYNCED_KEY) !== '1' || _psDirtyBeforeReady) {
      // First time this browser meets a server that has progress (or this browser changed something before the sync was ready):
      // only add what it has and the server lacks.
      const add = _psAdditions(server, local);
      await _psUpload(add, { init: true, legacy: true });
      merged = _psApply(_psCopy(server), add);
      _psQueue = _psLoadQueue();
      for (const op of _psQueue) _psApply(merged, op);
    } else {
      // The usual start: the server's progress, then what was still waiting to be sent from this browser.
      merged = _psCopy(server);
      _psQueue = _psLoadQueue();
      for (const op of _psQueue) _psApply(merged, op);
      // A server with far less than this browser is more likely a file that was restored from an old copy, or lost, than a library
      // that was really emptied elsewhere. Neither side is overwritten without the person choosing (Settings → Data & Backup).
      if (local.read.size >= PS_CONFLICT_MIN && merged.read.size < local.read.size * PS_CONFLICT_RATIO) {
        _psConflict = true;
        _psError = `The server has ${merged.read.size.toLocaleString()} chapters read and this browser ${local.read.size.toLocaleString()}: nothing is synced until you choose in Settings → Data & Backup → Reading progress`;
        dbg.warn(dbg.ERR_SETTINGS, _psError);
        return { ok: true, conflict: true };
      }
    }

    const changed = !_psSameProgress(local, merged);
    _psBase = _psCopy(merged);
    _psAssignToState(merged);
    localStorage.setItem(PS_SYNCED_KEY, '1');
    _psReady = true;
    _psError = '';
    _psLastSyncAt = Date.now();
    _psPersistQueue();
    if (changed) _psRefreshUi();
    _psSend();
    return { ok: true, changed };
  } catch (e) {
    // Not reachable or not signed in: this browser keeps working from its own copy, and tries again later.
    _psError = e.message || 'could not reach the server';
    dbg.warn(dbg.ERR_SETTINGS, 'Reading progress sync could not start', e);
    setTimeout(progressSyncInit, 30_000);
    return { ok: false, error: _psError };
  }
}

// After restoring a backup file in this browser: its progress is meant to REPLACE the server's, on the next start.
function progressSyncForceUploadOnNextStart() {
  try { localStorage.setItem(PS_FORCE_KEY, '1'); } catch (_) { /* the restore itself still worked */ }
}

// ── The two deliberate actions ──────────────────────────────────────────────

async function progressSyncUseServerCopy() {
  const res = await fetch('/api/progress');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const server = _psFromServer(await res.json());
  clearTimeout(_psTimer);
  _psQueue = [];
  _psPersistQueue();
  _psBase = _psCopy(server);
  _psAssignToState(server);
  _psReady = true;
  _psConflict = false;
  _psError = '';
  localStorage.setItem(PS_SYNCED_KEY, '1');
  _psRefreshUi();
  return { read: server.read.size };
}

async function progressSyncReplaceServerCopy() {
  clearTimeout(_psTimer);
  const local = _psSnapshot();
  await _psUpload(_psDiff(_psEmpty(), local, Date.now()) || {}, { reset: true, init: true, legacy: true });
  _psQueue = [];
  _psPersistQueue();
  _psBase = _psCopy(local);
  _psReady = true;
  _psConflict = false;
  _psError = '';
  localStorage.setItem(PS_SYNCED_KEY, '1');
  _psLastSyncAt = Date.now();
  return { read: local.read.size };
}

// Lowers one manga's progress (the "Reset reading progress from AniList" tool): `readRemove` are the keys to forget, `lastChapterId` is
// where the manga is left at, `highest` its highest chapter number. The server first (a copy of its file is kept before the first
// one), then this browser, so a server that cannot be reached leaves both as they were. `highest` only goes up on the server, so it is
// forgotten and set again in a second request.
async function progressSyncLowerManga({ mangaId, readRemove = [], lastChapterId = null, highest = 0 }) {
  if (!_psReady || _psConflict) throw new Error('The reading progress is not in step with the server yet');
  await progressSyncFlushNow();
  const m = String(mangaId);
  const pageKey = lastChapterId != null ? `${m}:${lastChapterId}` : null;
  const first = { readRemove, highest: { [m]: null } };
  if (lastChapterId != null) { first.last = { [m]: { c: String(lastChapterId), at: Date.now() } }; first.pages = { [pageKey]: 0 }; }
  const second = { highest: { [m]: highest } };
  for (const piece of _psSplit(first)) await _psPost(piece);
  if (highest > 0) await _psPost(_psSplit(second)[0]);
  _psApply(_psBase, first);
  if (highest > 0) _psApply(_psBase, second);

  _psSuppress = true;
  try {
    for (const k of readRemove) state.readChapters.delete(k);
    if (lastChapterId != null) {
      state.lastReadChapter[m] = String(lastChapterId);
      state.lastReadPages[pageKey] = 0;
    }
    if (highest > 0) state.highestReadChapter[m] = highest; else delete state.highestReadChapter[m];
    if (typeof saveSettings === 'function') saveSettings();
  } finally {
    _psSuppress = false;
  }
}

function progressSyncStatus() {
  return { ready: _psReady, conflict: _psConflict, pending: _psQueue.length, error: _psError, lastSyncAt: _psLastSyncAt };
}

// ── The card in Settings → Data & Backup ────────────────────────────────────

function settingsCardProgressSync() {
  return `
            <div class="settings-section-card">
              <p class="settings-section-title">Reading progress</p>
              <div class="setting-group">
                <p class="setting-description" style="margin:0 0 0.6rem 0">Which chapters you read and where you stopped in each manga are kept on the server, so they follow you to every browser and device that opens this library, and they are part of the server's automatic backups.</p>
                <p id="progressSyncStatus" class="setting-description" style="margin:0 0 0.6rem 0">Checking…</p>
                <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
                  <button class="btn secondary" id="btnProgressUseServer">Use the server's progress here</button>
                  <button class="btn secondary" id="btnProgressReplaceServer">Replace the server's progress with this browser's</button>
                </div>
                <p class="setting-description" style="margin-top:0.5rem">Both buttons replace one side with the other and ask first. Use them when one copy is wrong (for example after an old AniList sync marked chapters as read).</p>
              </div>
            </div>
  `;
}

async function _psRenderStatus() {
  const el = document.getElementById('progressSyncStatus');
  if (!el) return;
  const mine = progressSyncStatus();
  let server = null;
  try { const r = await fetch('/api/progress/status'); if (r.ok) server = await r.json(); } catch (_) { /* shown as not reachable */ }
  const parts = [];
  if (server) parts.push(`On the server: ${server.read.toLocaleString()} chapters read, ${server.mangas.toLocaleString()} manga with a place saved.`);
  else parts.push('The server could not be reached.');
  if (mine.conflict) parts.push('This browser and the server do not agree and nothing is synced until you choose one of the two buttons below.');
  else parts.push(mine.ready ? `This browser: ${mine.pending ? `${mine.pending} change${mine.pending === 1 ? '' : 's'} waiting to be sent.` : 'everything is sent.'}` : 'This browser has not synced yet.');
  if (mine.error) parts.push(`Last problem: ${mine.error}.`);
  el.textContent = parts.join(' ');
}

function bindProgressSyncCard() {
  _psRenderStatus();
  const useServer = document.getElementById('btnProgressUseServer');
  const replaceServer = document.getElementById('btnProgressReplaceServer');
  const el = document.getElementById('progressSyncStatus');
  if (useServer) useServer.onclick = async () => {
    if (!confirm('Replace the reading progress in THIS browser with the server\'s?\n\nWhat this browser has and the server does not will be lost.')) return;
    try { const r = await progressSyncUseServerCopy(); showToast('Reading progress', `This browser now has the server's progress (${r.read.toLocaleString()} chapters read).`, 'success'); }
    catch (e) { if (el) el.textContent = `Could not read the server's progress: ${e.message}`; return; }
    _psRenderStatus();
  };
  if (replaceServer) replaceServer.onclick = async () => {
    if (!confirm('Replace the reading progress on the SERVER with this browser\'s?\n\nWhat the server has and this browser does not will be lost for every device. The server keeps daily copies of its progress file.')) return;
    try { const r = await progressSyncReplaceServerCopy(); showToast('Reading progress', `The server now has this browser's progress (${r.read.toLocaleString()} chapters read).`, 'success'); }
    catch (e) { if (el) el.textContent = `Could not send the progress: ${e.message}`; return; }
    _psRenderStatus();
  };
}

// A tab that is being closed or hidden: what changed in the last moments is queued now (the queue is in localStorage), and sent if it can be.
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { _psCapture(); _psSend(); } });
}
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pagehide', () => { _psCapture(); });
  window.addEventListener('online', () => { _psRetryMs = 0; _psSend(); });
}
