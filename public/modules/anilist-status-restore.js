// ============================================================================
// ANILIST: RESET THE STATUSES ON ANILIST FROM SCROLLSCAPE
//
// For a library whose statuses on AniList were moved by an old sync (every title to Reading) while ScrollScape still has the ones
// the person set. Two steps, never one: a PREVIEW that reads the AniList list and writes nothing, and an APPLY that is only offered
// for what the preview found. Only the STATUS is written, never the progress: the progress of reading lives in the browser and can
// be wrong where an old sync ran, and writing it would spread the same mistake.
//
// Before the first write, what each title HAS on AniList is saved (store.anilistRestoreUndo, see server/modules/anilist/restore-journal.js):
// if that record cannot be saved nothing is written, and "Undo the last reset" puts back the titles that still have the status this tool gave.
//
// A title is left alone ("ignored", and listed as such) when it has no status here, is not linked to AniList, or is not on the
// person's AniList list (this never ADDS a title to the list). Several library entries pointing at one AniList title are changed once.
// ============================================================================

const ANILIST_STATUS_FROM_LOCAL = {
  reading: 'CURRENT',
  on_hold: 'PAUSED',
  completed: 'COMPLETED',
  dropped: 'DROPPED',
  plan_to_read: 'PLANNING',
};
const ANILIST_STATUS_LABEL = {
  CURRENT: 'Reading', PAUSED: 'Paused', COMPLETED: 'Completed', DROPPED: 'Dropped', PLANNING: 'Planning', REPEATING: 'Rereading',
};
// AniList's real budget is far under its documented one; this runs once, by hand, so it is slow on purpose.
const ANILIST_RESTORE_GAP_MS = 2000;

// The decision, with nothing in it that talks to AniList or the page: what changes, what already matches, what is left alone and why.
//   statusOf(fav)           the status ScrollScape has for a library entry (reading, on_hold, ...), or ''
//   mediaIdOf(fav)          the AniList id the entry is linked to, or 0
//   remoteStatusByMediaId   Map of AniList id -> status for every title on the person's AniList list
function planAniListStatusRestore({ favorites, statusOf, mediaIdOf, remoteStatusByMediaId }) {
  const plan = { changes: [], same: 0, ignored: { noStatus: [], notLinked: [], notOnList: [], conflict: [] } };
  const wanted = new Map();
  for (const fav of (favorites || [])) {
    const title = String(fav?.title || fav?.id || '').trim() || '(untitled)';
    const want = ANILIST_STATUS_FROM_LOCAL[statusOf(fav)];
    if (!want) { plan.ignored.noStatus.push(title); continue; }
    const mediaId = Number(mediaIdOf(fav) || 0);
    if (!mediaId) { plan.ignored.notLinked.push(title); continue; }
    const have = remoteStatusByMediaId.get(mediaId);
    if (!have) { plan.ignored.notOnList.push(title); continue; }
    if (wanted.has(mediaId)) {
      if (wanted.get(mediaId) !== want) plan.ignored.conflict.push(title);
      continue;
    }
    wanted.set(mediaId, want);
    // Rereading is Reading again, not a status that is wrong.
    if (have === want || (have === 'REPEATING' && want === 'CURRENT')) { plan.same++; continue; }
    plan.changes.push({ mangaId: fav.id, sourceId: fav.sourceId || '', title, mediaId, from: have, to: want });
  }
  return plan;
}

async function anilistFetchMangaListStatuses() {
  const userId = _alUser()?.id || null;
  const data = await anilistGQL(
    'query ($userId: Int) { MediaListCollection(userId: $userId, type: MANGA) { lists { entries { status media { id } } } } }',
    userId ? { userId } : {}
  );
  if (data?.errors?.length) throw new Error(data.errors[0]?.message || 'AniList could not return your list');
  const byId = new Map();
  for (const list of (data?.data?.MediaListCollection?.lists || [])) {
    for (const entry of (list.entries || [])) {
      const id = Number(entry?.media?.id || 0);
      if (id && entry.status) byId.set(id, String(entry.status));
    }
  }
  return byId;
}

const _anilistRestoreRateLimited = (msg) => /429|too many requests|slow down|rate limit/i.test(String(msg || ''));

// Writes only `status`. Stops at the first rate limit (what is left is found again by a new preview) or when asked to.
async function anilistApplyStatusRestore(changes, { onProgress, shouldStop } = {}) {
  const result = { done: 0, failed: 0, rateLimited: false, stopped: false, failures: [], appliedIds: [] };
  for (let i = 0; i < changes.length; i++) {
    if (shouldStop && shouldStop()) { result.stopped = true; break; }
    const change = changes[i];
    try {
      const res = await anilistGQL(
        'mutation ($m: Int, $st: MediaListStatus) { SaveMediaListEntry(mediaId: $m, status: $st) { id status } }',
        { m: change.mediaId, st: change.to }
      );
      if (res?.errors?.length) throw new Error(res.errors[0]?.message || 'AniList refused the change');
      result.done++;
      result.appliedIds.push(change.mediaId);
    } catch (e) {
      if (_anilistRestoreRateLimited(e?.message)) { result.rateLimited = true; break; }
      result.failed++;
      result.failures.push(`${change.title}: ${e?.message || 'failed'}`);
    }
    if (onProgress) onProgress({ processed: i + 1, total: changes.length, ...result });
    await _sleep(ANILIST_RESTORE_GAP_MS);
  }
  return result;
}

// What of a saved reset can be taken back: a title goes back to the status it had only if it still has the one the reset gave it. One
// changed since (by hand, on AniList or here) is the person's newer decision and is left alone; so is one no longer on the list.
function planAniListRestoreUndo(journalChanges, remoteStatusByMediaId) {
  const plan = { reverts: [], changedSince: [], notOnList: [] };
  for (const c of (journalChanges || [])) {
    const have = remoteStatusByMediaId.get(Number(c.mediaId));
    if (!have) { plan.notOnList.push(c.title); continue; }
    if (have !== c.to) { plan.changedSince.push(c.title); continue; }
    plan.reverts.push(c);
  }
  return plan;
}

// The reset with its undo record: the record is saved BEFORE the first write (without it nothing is written), and afterwards it is cut
// down to the titles that were really changed. `saveJournal(changes)` and `clearJournal()` talk to the server.
async function anilistRunStatusRestore(changes, { saveJournal, clearJournal, onProgress, shouldStop } = {}) {
  try {
    await saveJournal(changes.map((c) => ({ mediaId: c.mediaId, title: c.title, from: c.from, to: c.to })));
  } catch (e) {
    return { ok: false, journalFailed: true, error: e?.message || 'could not save the undo record' };
  }
  const result = await anilistApplyStatusRestore(changes, { onProgress, shouldStop });
  const applied = new Set(result.appliedIds);
  try {
    if (!applied.size) await clearJournal();
    else if (applied.size < changes.length) await saveJournal(changes.filter((c) => applied.has(c.mediaId)).map((c) => ({ mediaId: c.mediaId, title: c.title, from: c.from, to: c.to })));
  } catch (_) { /* the longer record stays: undoing a title that was never changed writes nothing (it is not at the status the reset gave) */ }
  return { ok: true, ...result };
}

// Takes back the last reset. The record is dropped once everything it covered was put back (or turned out to need nothing).
async function anilistRunRestoreUndo(journal, remoteStatusByMediaId, { clearJournal, onProgress, shouldStop } = {}) {
  const plan = planAniListRestoreUndo(journal.changes, remoteStatusByMediaId);
  const result = plan.reverts.length
    ? await anilistApplyStatusRestore(plan.reverts.map((c) => ({ mediaId: c.mediaId, title: c.title, to: c.from })), { onProgress, shouldStop })
    : { done: 0, failed: 0, rateLimited: false, stopped: false, failures: [], appliedIds: [] };
  const finished = !result.rateLimited && !result.stopped && !result.failed;
  if (finished) { try { await clearJournal(); } catch (_) { /* a stale record only offers an undo that finds nothing to do */ } }
  return { ...result, plan, finished };
}

async function _anilistRestoreJournalRequest(method, journal) {
  const res = await fetch('/api/anilist/restore-journal', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: journal ? JSON.stringify({ journal }) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const _anilistRestoreSaveJournal = (changes) => _anilistRestoreJournalRequest('PUT', { createdAt: new Date().toISOString(), changes });
const _anilistRestoreClearJournal = () => _anilistRestoreJournalRequest('DELETE');
const _anilistRestoreLoadJournal = async () => (await _anilistRestoreJournalRequest('GET')).journal || null;

// ── The card inside Settings → Tracking ─────────────────────────────────────

let _anilistRestorePlan = null;
let _anilistRestoreStop = false;
let _anilistRestoreRunning = false;

function anilistStatusRestoreHtml() {
  return `
                <div class="setting-group" id="anilistRestoreBlock" style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08)">
                  <label>Reset AniList statuses from ScrollScape</label>
                  <p class="setting-description">Puts on AniList the status each manga has here (Reading, Paused, Completed, Dropped, Planning). Only statuses are written, never progress, and no title is added to or removed from your AniList list. Preview first: nothing is changed until you apply, and the last reset can be undone. AniList may fill in the chapter count of titles it sets to Completed.</p>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn secondary" id="btnAniListRestorePreview">Preview changes</button>
                    <button class="btn primary" id="btnAniListRestoreApply" disabled style="display:none"></button>
                    <button class="btn secondary" id="btnAniListRestoreStop" style="display:none">Stop</button>
                  </div>
                  <p id="anilistRestoreSummary" class="setting-description" style="margin-top:8px"></p>
                  <div id="anilistRestoreList" style="display:none;max-height:260px;overflow:auto;font-size:0.82rem;margin-top:6px"></div>
                  <div id="anilistRestoreUndo" style="display:none;margin-top:10px">
                    <p id="anilistRestoreUndoText" class="setting-description"></p>
                    <button class="btn secondary" id="btnAniListRestoreUndo">Undo the last reset</button>
                  </div>
                </div>`;
}

function _anilistRestoreRenderPlan(plan) {
  const summary = document.getElementById('anilistRestoreSummary');
  const list = document.getElementById('anilistRestoreList');
  const apply = document.getElementById('btnAniListRestoreApply');
  const ig = plan.ignored;
  const ignoredText = [
    ig.noStatus.length ? `${ig.noStatus.length} without a status here` : '',
    ig.notLinked.length ? `${ig.notLinked.length} not linked to AniList` : '',
    ig.notOnList.length ? `${ig.notOnList.length} not on your AniList list` : '',
    ig.conflict.length ? `${ig.conflict.length} sharing an AniList title with another entry` : '',
  ].filter(Boolean).join(', ');
  if (summary) {
    summary.textContent = `${plan.changes.length} would change, ${plan.same} already match.` + (ignoredText ? ` Left alone: ${ignoredText}.` : '');
  }
  if (list) {
    list.style.display = plan.changes.length ? '' : 'none';
    list.innerHTML = '<table style="width:100%;border-collapse:collapse">' + plan.changes.map((c) =>
      `<tr><td style="padding:2px 6px">${escapeHtml(c.title)}</td><td style="padding:2px 6px;white-space:nowrap;opacity:0.85">${escapeHtml(ANILIST_STATUS_LABEL[c.from] || c.from)} &rarr; <strong>${escapeHtml(ANILIST_STATUS_LABEL[c.to] || c.to)}</strong></td></tr>`
    ).join('') + '</table>';
  }
  if (apply) {
    apply.style.display = plan.changes.length ? '' : 'none';
    apply.disabled = !plan.changes.length;
    apply.textContent = `Apply ${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'} on AniList`;
  }
}

async function _anilistRestorePreview() {
  const btn = document.getElementById('btnAniListRestorePreview');
  const summary = document.getElementById('anilistRestoreSummary');
  if (!_alToken()) { showToast('AniList', 'Connect your AniList account first.', 'warning'); return; }
  if (_anilistRestoreRunning) return;
  if (!(state.favorites || []).length) {
    if (summary) summary.textContent = 'Your library is empty here, so there is nothing to compare.';
    return;
  }
  btn.disabled = true;
  _anilistRestorePlan = null;
  if (summary) summary.textContent = 'Reading your AniList list…';
  try {
    const remote = await anilistFetchMangaListStatuses();
    const links = _alGetAllLinks();
    _anilistRestorePlan = planAniListStatusRestore({
      favorites: state.favorites,
      statusOf: (fav) => (state.readingStatus?.[_statusStoreKey(fav.id, fav.sourceId)]?.status) || '',
      mediaIdOf: (fav) => fav.anilistId || links[fav.id] || 0,
      remoteStatusByMediaId: remote,
    });
    _anilistRestoreRenderPlan(_anilistRestorePlan);
  } catch (e) {
    if (summary) summary.textContent = `Could not read your AniList list: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function _anilistRestoreApply() {
  const plan = _anilistRestorePlan;
  if (!plan?.changes.length || _anilistRestoreRunning) return;
  const n = plan.changes.length;
  if (!confirm(`Change the status of ${n} title${n === 1 ? '' : 's'} on your AniList account?\n\nOnly statuses are written, never progress. What each title has now is saved first, so this reset can be undone.`)) return;

  const btnPreview = document.getElementById('btnAniListRestorePreview');
  const btnApply = document.getElementById('btnAniListRestoreApply');
  const btnStop = document.getElementById('btnAniListRestoreStop');
  const summary = document.getElementById('anilistRestoreSummary');
  _anilistRestoreRunning = true;
  _anilistRestoreStop = false;
  if (btnPreview) btnPreview.disabled = true;
  if (btnApply) btnApply.disabled = true;
  if (btnStop) btnStop.style.display = '';
  try {
    const result = await anilistRunStatusRestore(plan.changes, {
      saveJournal: _anilistRestoreSaveJournal,
      clearJournal: _anilistRestoreClearJournal,
      shouldStop: () => _anilistRestoreStop,
      onProgress: ({ processed, total, done, failed }) => {
        if (summary) summary.textContent = `Applying… ${processed} of ${total} (${done} changed${failed ? `, ${failed} failed` : ''})`;
      },
    });
    if (result.journalFailed) {
      if (summary) summary.textContent = `Nothing was changed: the undo record could not be saved (${result.error}).`;
      return;
    }
    const left = plan.changes.length - result.done - result.failed;
    const tail = result.rateLimited ? ' AniList asked to slow down: wait a few minutes and preview again to continue.'
      : result.stopped ? ' Stopped: preview again to continue.' : ' Preview again to check.';
    if (summary) summary.textContent = `Done: ${result.done} changed${result.failed ? `, ${result.failed} failed` : ''}${left > 0 && (result.rateLimited || result.stopped) ? `, ${left} not reached` : ''}.${tail}`;
    showToast('AniList', `${result.done} statuses changed.`, result.failed || result.rateLimited ? 'warning' : 'success');
    _anilistRestorePlan = null;
    const list = document.getElementById('anilistRestoreList');
    if (list) list.style.display = 'none';
    if (btnApply) btnApply.style.display = 'none';
    _anilistRestoreRefreshUndo();
  } finally {
    _anilistRestoreRunning = false;
    if (btnPreview) btnPreview.disabled = false;
    if (btnStop) btnStop.style.display = 'none';
  }
}

async function _anilistRestoreRefreshUndo() {
  const box = document.getElementById('anilistRestoreUndo');
  const text = document.getElementById('anilistRestoreUndoText');
  if (!box) return;
  let journal = null;
  try { journal = await _anilistRestoreLoadJournal(); } catch (_) { /* no record to show */ }
  box.style.display = journal ? '' : 'none';
  if (journal && text) {
    const n = journal.changes.length;
    text.textContent = `Last reset: ${n} title${n === 1 ? '' : 's'}, ${new Date(journal.createdAt).toLocaleString()}. Undo puts back the status each had before, for the ones that still have the status the reset gave them.`;
  }
}

async function _anilistRestoreUndo() {
  if (_anilistRestoreRunning) return;
  if (!_alToken()) { showToast('AniList', 'Connect your AniList account first.', 'warning'); return; }
  const summary = document.getElementById('anilistRestoreSummary');
  const btnUndo = document.getElementById('btnAniListRestoreUndo');
  const btnPreview = document.getElementById('btnAniListRestorePreview');
  const btnStop = document.getElementById('btnAniListRestoreStop');
  _anilistRestoreRunning = true;
  _anilistRestoreStop = false;
  if (btnUndo) btnUndo.disabled = true;
  if (btnPreview) btnPreview.disabled = true;
  try {
    const journal = await _anilistRestoreLoadJournal();
    if (!journal) { if (summary) summary.textContent = 'There is no reset to undo.'; return; }
    if (summary) summary.textContent = 'Reading your AniList list…';
    const remote = await anilistFetchMangaListStatuses();
    const n = planAniListRestoreUndo(journal.changes, remote).reverts.length;
    if (n && !confirm(`Put ${n} title${n === 1 ? '' : 's'} back to the status they had before the last reset?`)) { if (summary) summary.textContent = ''; return; }
    if (btnStop) btnStop.style.display = '';
    const result = await anilistRunRestoreUndo(journal, remote, {
      clearJournal: _anilistRestoreClearJournal,
      shouldStop: () => _anilistRestoreStop,
      onProgress: ({ processed, total, done }) => { if (summary) summary.textContent = `Undoing… ${processed} of ${total} (${done} put back)`; },
    });
    const skipped = result.plan.changedSince.length + result.plan.notOnList.length;
    const why = [
      result.plan.changedSince.length ? `${result.plan.changedSince.length} changed since` : '',
      result.plan.notOnList.length ? `${result.plan.notOnList.length} no longer on your list` : '',
    ].filter(Boolean).join(', ');
    const tail = result.rateLimited ? ' AniList asked to slow down: wait a few minutes and undo again to continue.' : result.stopped ? ' Stopped: undo again to continue.' : '';
    if (summary) summary.textContent = `Undone: ${result.done} put back${result.failed ? `, ${result.failed} failed` : ''}${skipped ? `. Left as they are: ${why}` : ''}.${tail}`;
    showToast('AniList', `${result.done} statuses put back.`, result.failed || result.rateLimited ? 'warning' : 'success');
  } catch (e) {
    if (summary) summary.textContent = `Could not undo: ${e.message}`;
  } finally {
    _anilistRestoreRunning = false;
    if (btnUndo) btnUndo.disabled = false;
    if (btnPreview) btnPreview.disabled = false;
    if (btnStop) btnStop.style.display = 'none';
    _anilistRestoreRefreshUndo();
  }
}

function bindAniListStatusRestore() {
  _anilistRestorePlan = null;
  const preview = document.getElementById('btnAniListRestorePreview');
  const apply = document.getElementById('btnAniListRestoreApply');
  const stop = document.getElementById('btnAniListRestoreStop');
  if (preview) preview.onclick = _anilistRestorePreview;
  if (apply) apply.onclick = _anilistRestoreApply;
  if (stop) stop.onclick = () => { _anilistRestoreStop = true; };
  const undo = document.getElementById('btnAniListRestoreUndo');
  if (undo) undo.onclick = _anilistRestoreUndo;
  _anilistRestoreRefreshUndo();
}
