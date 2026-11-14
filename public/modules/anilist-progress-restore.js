// ============================================================================
// ANILIST: LOWER THE READING PROGRESS HERE TO WHAT ANILIST HAS
//
// For a library whose progress here was pushed too high by an old sync (every chapter of a manga marked as read) and was then
// corrected by hand on AniList. The automatic sync never brings a number DOWN and the Import only adds, so without this the wrong
// number stays here (and in the Wrapped, and goes back up on the next sync). Two steps, never one: a PREVIEW that reads the AniList
// list and writes nothing, and an APPLY that works only on the titles the person left ticked.
//
// Only ever LOWERS: a title where AniList is ahead of (or equal to) what is read here is left alone (bringing those up is the Import).
// Nothing is written to AniList. A title is left alone too when it is not linked, not on the AniList list, or AniList shows 0 (a
// progress of 0 is more likely "not filled in" than "read nothing", and wiping a manga is not something to guess).
//
// What is removed: the chapters read whose chapter NUMBER is beyond AniList's (see planAniListProgressLowering for why a number and
// not a count). Chapters not read are never marked as read. The place the manga is left at and its highest
// chapter go to that number. Before the first change the server keeps a copy of its files (data/backups, "before-anilist-progress").
// ============================================================================

// AniList's budget is small and the chapter lists come from the sources' own sites: slow on purpose, it runs once, by hand.
const ANILIST_PROGRESS_GAP_MS = 400;
// A title is ticked by default only when this many chapters AND this share of what is read here lie beyond AniList's number.
const ANILIST_PROGRESS_BIG_GAP = 10;
const ANILIST_PROGRESS_BIG_RATIO = 0.1;

// The decision, with nothing in it that talks to AniList or the page.
//   mediaIdOf(fav)           the AniList id the entry is linked to, or 0
//   readKeysOf(mangaId)      the "<mangaId>:<chapterId>" keys read here for it
//   remoteProgressByMediaId  Map of AniList id -> chapters read, for every title on the person's AniList list
//   settled                  { mangaId: AniList number } of titles already checked by number against that same number (nothing beyond)
function planAniListProgressRestore({ favorites, mediaIdOf, readKeysOf, remoteProgressByMediaId, settled = {} }) {
  const plan = { changes: [], same: 0, ahead: 0, settled: 0, ignored: { notLinked: [], notOnList: [], zero: [] } };
  const seen = new Set();
  for (const fav of (favorites || [])) {
    const title = String(fav?.title || fav?.id || '').trim() || '(untitled)';
    const mangaId = String(fav?.id || '');
    if (!mangaId || seen.has(mangaId)) continue;
    seen.add(mangaId);
    const mediaId = Number(mediaIdOf(fav) || 0);
    if (!mediaId) { plan.ignored.notLinked.push(title); continue; }
    if (!remoteProgressByMediaId.has(mediaId)) { plan.ignored.notOnList.push(title); continue; }
    const to = Math.floor(Number(remoteProgressByMediaId.get(mediaId)) || 0);
    const from = readKeysOf(mangaId).length;
    if (to <= 0) { if (from > 0) plan.ignored.zero.push(title); continue; }
    if (from > to && settled[mangaId] === to) { plan.settled++; continue; } // checked before by number: more entries than the number, none beyond it
    // Here the chapters are COUNTED and AniList's number is a chapter NUMBER, so a gap of a few is usually extra chapters (0, 5.5, bonus),
    // not a library marked as read by mistake. Those are listed apart, unticked, and the apply step still decides by number.
    if (from > to) plan.changes.push({ mangaId, sourceId: fav.sourceId || '', title, mediaId, from, to, small: !(from - to >= ANILIST_PROGRESS_BIG_GAP && (from - to) / from >= ANILIST_PROGRESS_BIG_RATIO) });
    else if (from === to) plan.same++;
    else plan.ahead++;
  }
  return plan;
}

// What lowering one manga to `progress` does, from its chapters as the source lists them (any order) and the keys read here.
// Returns { error } when the source cannot show where AniList's number is.
//
// "Beyond AniList's number" is decided by the chapter NUMBER, which is how AniList counts: a source that lists a chapter 0, a 5.5 or
// extras has more chapters than its last number, and counting them would unmark chapters that were really read (Yuragi-sou: 235 read
// here, 222 on AniList, the 13 extras are not beyond chapter 222). A chapter with no number is never beyond. Only a source whose
// chapters mostly have no number is counted by position, oldest first, the way the Import counts.
function planAniListProgressLowering({ mangaId, chapters, readKeys, progress }) {
  const ordered = _oldestFirstChapters(chapters || []).filter((ch) => ch?.id);
  if (!ordered.length) return { error: 'the source lists no chapters' };
  const keyOf = (ch) => `${mangaId}:${ch.id}`;
  // Only a chapter that can be placed in the source's list can be said to be beyond AniList's number. If none of what is read here is
  // in the list the source has changed its ids, and "beyond" would mean everything: that is not guessed at.
  const listed = new Set(ordered.map(keyOf));
  if (readKeys.length && !readKeys.some((k) => listed.has(k))) return { error: "none of the chapters read here are in the source's list now" };

  const rows = ordered.map((ch) => ({ ch, n: _parseChapterNumber(ch) }));
  const numbered = rows.filter((r) => r.n !== null);
  let beyond;
  let last;
  let highest;
  if (numbered.length >= Math.max(2, Math.floor(ordered.length * 0.5))) {
    // AniList's number is a whole one: a chapter 222.5 belongs to 222.
    const within = numbered.filter((r) => Math.floor(r.n) <= progress);
    if (!within.length) return { error: `no chapter of the source is numbered up to AniList's ${progress}` };
    beyond = new Set(numbered.filter((r) => Math.floor(r.n) > progress).map((r) => keyOf(r.ch)));
    last = within[within.length - 1].ch;
    highest = within.reduce((mx, r) => (r.n > mx ? r.n : mx), 0);
  } else {
    if (ordered.length < progress) return { error: `the source lists ${ordered.length} chapters, fewer than AniList's ${progress}` };
    beyond = new Set(ordered.slice(progress).map(keyOf));
    last = ordered[progress - 1];
    highest = progress;
  }
  const readRemove = readKeys.filter((k) => beyond.has(k));
  return { readRemove, lastChapterId: String(last.id), highest: highest > 0 ? highest : progress };
}

async function anilistFetchMangaListProgress() {
  const userId = _alUser()?.id || null;
  const data = await anilistGQL(
    'query ($userId: Int) { MediaListCollection(userId: $userId, type: MANGA) { lists { entries { progress media { id } } } } }',
    userId ? { userId } : {}
  );
  if (data?.errors?.length) throw new Error(data.errors[0]?.message || 'AniList could not return your list');
  const byId = new Map();
  for (const list of (data?.data?.MediaListCollection?.lists || [])) {
    for (const entry of (list.entries || [])) {
      const id = Number(entry?.media?.id || 0);
      if (id && !byId.has(id)) byId.set(id, Math.max(0, Math.floor(Number(entry.progress) || 0)));
    }
  }
  return byId;
}

// Lowers the titles in `changes`, one by one. `deps` is what talks to the page and the server (replaced in tests):
//   keepCopy()                      asks the server for its copy; must answer { ok:true } or nothing is changed
//   loadChapters(change)            the source's chapters for the manga
//   readKeysOf(mangaId)             the keys read here
//   lower(manga)                    progressSyncLowerManga
async function anilistRunProgressRestore(changes, deps, { onProgress, shouldStop } = {}) {
  const result = { done: 0, failed: 0, unchanged: 0, stopped: false, failures: [], copyFailed: false, appliedIds: [] };
  try {
    const copy = await deps.keepCopy();
    if (!copy || copy.ok !== true) throw new Error('no copy');
  } catch (_) {
    result.copyFailed = true;
    return result;
  }
  for (let i = 0; i < changes.length; i++) {
    if (shouldStop && shouldStop()) { result.stopped = true; break; }
    const change = changes[i];
    try {
      const chapters = await deps.loadChapters(change);
      const lowering = planAniListProgressLowering({ mangaId: change.mangaId, chapters, readKeys: deps.readKeysOf(change.mangaId), progress: change.to });
      if (lowering.error) throw new Error(lowering.error);
      if (!lowering.readRemove.length) {
        result.unchanged++; // by number nothing read lies beyond AniList's: nothing to unmark, and nothing is written
        if (deps.settle) deps.settle(change); // so the next preview does not offer it again for the same AniList number
      } else {
        await deps.lower({ mangaId: change.mangaId, readRemove: lowering.readRemove, lastChapterId: lowering.lastChapterId, highest: lowering.highest });
        result.done++;
        result.appliedIds.push(change.mangaId);
      }
    } catch (e) {
      result.failed++;
      result.failures.push(`${change.title}: ${e?.message || 'failed'}`);
    }
    if (onProgress) onProgress({ processed: i + 1, total: changes.length, done: result.done, failed: result.failed });
    await _sleep(ANILIST_PROGRESS_GAP_MS);
  }
  return result;
}

// ── The card inside Settings → Tracking ─────────────────────────────────────

let _anilistProgressPlan = null;
let _anilistProgressStop = false;
let _anilistProgressRunning = false;

function anilistProgressRestoreHtml() {
  return `
                <div class="setting-group" id="anilistProgressBlock" style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08)">
                  <label>Lower the reading progress here to AniList's</label>
                  <p class="setting-description">For manga where you read fewer chapters than are marked as read here (an old sync marked them all) and corrected the number on AniList. Preview first: the list shows what would change and you tick the ones to apply. Only chapters whose number is beyond AniList's are unmarked (a chapter 0, a 5.5 or an extra is not beyond), nothing is written to AniList, and the server keeps a copy of its files first. Titles where AniList is ahead are left to the Import.</p>
                  <div style="display:flex;gap:8px;flex-wrap:wrap">
                    <button class="btn secondary" id="btnAniListProgressPreview">Preview changes</button>
                    <button class="btn primary" id="btnAniListProgressApply" disabled style="display:none"></button>
                    <button class="btn secondary" id="btnAniListProgressStop" style="display:none">Stop</button>
                  </div>
                  <p id="anilistProgressSummary" class="setting-description" style="margin-top:8px"></p>
                  <div id="anilistProgressList" style="display:none;max-height:380px;overflow:auto;font-size:0.82rem;margin-top:6px"></div>
                </div>`;
}

const _anilistProgressChecked = () => [...document.querySelectorAll('#anilistProgressList input[data-progress-index]')]
  .filter((box) => box.checked).map((box) => Number(box.dataset.progressIndex));

function _anilistProgressRefreshApply() {
  const apply = document.getElementById('btnAniListProgressApply');
  if (!apply || !_anilistProgressPlan) return;
  const n = _anilistProgressChecked().length;
  apply.disabled = !n;
  apply.textContent = `Lower ${n} manga here`;
}

function _anilistProgressRenderPlan(plan) {
  const summary = document.getElementById('anilistProgressSummary');
  const list = document.getElementById('anilistProgressList');
  const apply = document.getElementById('btnAniListProgressApply');
  const ig = plan.ignored;
  const left = [
    plan.ahead ? `${plan.ahead} where AniList is ahead` : '',
    ig.zero.length ? `${ig.zero.length} where AniList shows 0` : '',
    ig.notLinked.length ? `${ig.notLinked.length} not linked to AniList` : '',
    ig.notOnList.length ? `${ig.notOnList.length} not on your AniList list` : '',
  ].filter(Boolean).join(', ');
  const big = plan.changes.map((c, i) => ({ c, i })).filter((r) => !r.c.small);
  const small = plan.changes.map((c, i) => ({ c, i })).filter((r) => r.c.small);
  if (summary) {
    summary.textContent = `${big.length} would be lowered${small.length ? `, ${small.length} with a small difference (listed below, unticked)` : ''}, ${plan.same} already match${plan.settled ? `, ${plan.settled} checked before (more entries than AniList's number, but none numbered beyond it)` : ''}.`
      + (left ? ` Left alone: ${left}.` : '');
  }
  if (list) {
    list.style.display = plan.changes.length ? '' : 'none';
    const row = ({ c, i }) => `<tr><td style="padding:2px 6px;width:1%"><input type="checkbox" data-progress-index="${i}"${c.small ? '' : ' checked'}></td><td style="padding:2px 6px">${escapeHtml(c.title)}</td><td style="padding:2px 6px;white-space:nowrap;opacity:0.85">${c.from} &rarr; <strong>${c.to}</strong> chapters</td></tr>`;
    const smallHead = small.length
      ? '<tr><td colspan="3" style="padding:8px 6px 2px;opacity:0.75">Small differences: usually extra chapters (a 0, a 5.5, bonus chapters), not a mistake. Untick by default.</td></tr>'
      : '';
    list.innerHTML = '<table style="width:100%;border-collapse:collapse">' + big.map(row).join('') + smallHead + small.map(row).join('') + '</table>';
    list.querySelectorAll('input[data-progress-index]').forEach((box) => { box.onchange = _anilistProgressRefreshApply; });
  }
  if (apply) {
    apply.style.display = plan.changes.length ? '' : 'none';
    _anilistProgressRefreshApply();
  }
}

const _ANILIST_PROGRESS_SETTLED_KEY = 'scrollscape_al_progress_settled';

function _anilistProgressSettled() {
  try {
    const parsed = JSON.parse(localStorage.getItem(_ANILIST_PROGRESS_SETTLED_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) { return {}; }
}

function _anilistProgressSettle(change) {
  try {
    localStorage.setItem(_ANILIST_PROGRESS_SETTLED_KEY, JSON.stringify({ ..._anilistProgressSettled(), [change.mangaId]: change.to }));
  } catch (_) { /* it is only offered again */ }
}

const _anilistProgressReadKeys = (mangaId) => {
  const prefix = `${mangaId}:`;
  const keys = [];
  for (const k of (state.readChapters || [])) if (typeof k === 'string' && k.startsWith(prefix)) keys.push(k);
  return keys;
};

async function _anilistProgressPreview() {
  const btn = document.getElementById('btnAniListProgressPreview');
  const summary = document.getElementById('anilistProgressSummary');
  if (!_alToken()) { showToast('AniList', 'Connect your AniList account first.', 'warning'); return; }
  if (_anilistProgressRunning) return;
  if (!(state.favorites || []).length) {
    if (summary) summary.textContent = 'Your library is empty here, so there is nothing to compare.';
    return;
  }
  btn.disabled = true;
  _anilistProgressPlan = null;
  if (summary) summary.textContent = 'Reading your AniList list…';
  try {
    const remote = await anilistFetchMangaListProgress();
    const links = _alGetAllLinks();
    _anilistProgressPlan = planAniListProgressRestore({
      favorites: state.favorites,
      mediaIdOf: (fav) => fav.anilistId || links[fav.id] || 0,
      readKeysOf: _anilistProgressReadKeys,
      remoteProgressByMediaId: remote,
      settled: _anilistProgressSettled(),
    });
    _anilistProgressRenderPlan(_anilistProgressPlan);
  } catch (e) {
    if (summary) summary.textContent = `Could not read your AniList list: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function _anilistProgressKeepCopy() {
  const res = await fetch('/api/progress/safety-copy', { method: 'POST' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function _anilistProgressLoadChapters(change) {
  const data = await api(`/api/source/${encodeURIComponent(change.sourceId)}/chapters`, {
    method: 'POST',
    body: JSON.stringify({ mangaId: change.mangaId }),
  });
  return data?.chapters || [];
}

async function _anilistProgressApply() {
  const plan = _anilistProgressPlan;
  if (!plan?.changes.length || _anilistProgressRunning) return;
  const chosen = _anilistProgressChecked().map((i) => plan.changes[i]).filter(Boolean);
  if (!chosen.length) return;
  const n = chosen.length;
  if (!confirm(`Lower the reading progress of ${n} manga here to AniList's numbers?\n\nChapters read beyond AniList's number are unmarked. Nothing is written to AniList. The server keeps a copy of its files first.`)) return;

  const btnPreview = document.getElementById('btnAniListProgressPreview');
  const btnApply = document.getElementById('btnAniListProgressApply');
  const btnStop = document.getElementById('btnAniListProgressStop');
  const summary = document.getElementById('anilistProgressSummary');
  _anilistProgressRunning = true;
  _anilistProgressStop = false;
  if (btnPreview) btnPreview.disabled = true;
  if (btnApply) btnApply.disabled = true;
  if (btnStop) btnStop.style.display = '';
  try {
    const result = await anilistRunProgressRestore(chosen, {
      keepCopy: _anilistProgressKeepCopy,
      loadChapters: _anilistProgressLoadChapters,
      readKeysOf: _anilistProgressReadKeys,
      lower: progressSyncLowerManga,
      settle: _anilistProgressSettle,
    }, {
      shouldStop: () => _anilistProgressStop,
      onProgress: ({ processed, total, done, failed }) => {
        if (summary) summary.textContent = `Applying… ${processed} of ${total} (${done} lowered${failed ? `, ${failed} failed` : ''})`;
      },
    });
    if (result.copyFailed) {
      if (summary) summary.textContent = 'Nothing was changed: the server could not keep a copy of its files first.';
      return;
    }
    const notReached = chosen.length - result.done - result.failed - result.unchanged;
    const failures = result.failures.length ? ` Could not lower: ${result.failures.join('; ')}.` : '';
    if (summary) summary.textContent = `Done: ${result.done} lowered${result.unchanged ? `, ${result.unchanged} with nothing beyond AniList's number (left as they are)` : ''}${result.failed ? `, ${result.failed} failed` : ''}${result.stopped && notReached > 0 ? `, ${notReached} not reached` : ''}.${failures} Preview again to check.`;
    showToast('AniList', `${result.done} manga lowered.`, result.failed ? 'warning' : 'success');
    _anilistProgressPlan = null;
    const list = document.getElementById('anilistProgressList');
    if (list) list.style.display = 'none';
    if (btnApply) btnApply.style.display = 'none';
    if (typeof renderLibrary === 'function') renderLibrary();
  } finally {
    _anilistProgressRunning = false;
    if (btnPreview) btnPreview.disabled = false;
    if (btnStop) btnStop.style.display = 'none';
  }
}

function bindAniListProgressRestore() {
  _anilistProgressPlan = null;
  const preview = document.getElementById('btnAniListProgressPreview');
  const apply = document.getElementById('btnAniListProgressApply');
  const stop = document.getElementById('btnAniListProgressStop');
  if (preview) preview.onclick = _anilistProgressPreview;
  if (apply) apply.onclick = _anilistProgressApply;
  if (stop) stop.onclick = () => { _anilistProgressStop = true; };
}
