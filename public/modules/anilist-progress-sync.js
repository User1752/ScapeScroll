// ============================================================================
// ANILIST: SYNC THE PROGRESS OF ONE MANGA (right-click on a library card → "Sync progress with AniList")
//
// The two sides count differently: AniList has a chapter NUMBER, this app has the chapters it marked as read. This window works out both
// as numbers, shows them side by side, and offers the two ways to make them equal. Nothing is applied until one of the buttons is
// pressed, and the person always chooses the direction:
//   AniList → this app   raises the progress here (marks the chapters up to AniList's number as read) or lowers it (unmarks the ones
//                        numbered beyond it: the same rule as "Lower the reading progress here to AniList's");
//   this app → AniList   writes the number found here to AniList, UP or DOWN. Only the progress: the status of an entry is never touched.
//
// The decision is a pure function (planProgressSync) so it is tested without a page; the window only asks the two sides and draws it.
//
// How "the number here" is worked out: the highest chapter NUMBER among the chapters read that the source lists now (a 222.5 counts as
// 222, as AniList does). A source whose chapters mostly have no number is counted by position, oldest first, the way the Import counts.
// It is NEVER taken from `highestReadChapter`, the stored number that once held the wrong value and wrote it over AniList.
// ============================================================================

const _ALSYNC_EPS = 1e-9;

// `chapters` as the source lists them (any order), `readKeys` the keys read here, `anilist` { exists, progress }.
// Returns { error } when the two cannot be compared, else { anilistNumber, appNumber, exists, inSync, toApp, toAniList }, where each of
// toApp / toAniList is null (with a `why` in `blocked`) or says exactly what pressing its button does.
function planProgressSync({ mangaId, chapters, readKeys, anilist }) {
  const ordered = _oldestFirstChapters(chapters || []).filter((ch) => ch?.id);
  if (!ordered.length) return { error: 'the source lists no chapters' };
  const keyOf = (ch) => `${mangaId}:${ch.id}`;
  const listed = new Set(ordered.map(keyOf));
  const readHere = new Set(readKeys.filter((k) => listed.has(k)));
  if (readKeys.length && !readHere.size) return { error: "none of the chapters read here are in the source's list now" };

  const rows = ordered.map((ch, i) => ({ ch, i, n: _parseChapterNumber(ch) }));
  const numbered = rows.filter((r) => r.n !== null);
  const mostlyNumbered = numbered.length >= Math.max(2, Math.floor(ordered.length * 0.5));
  const readRows = rows.filter((r) => readHere.has(keyOf(r.ch)));
  const readNumbered = readRows.filter((r) => r.n !== null);
  let appNumber = 0;
  if (readRows.length) {
    appNumber = mostlyNumbered && readNumbered.length
      ? readNumbered.reduce((mx, r) => Math.max(mx, Math.floor(r.n)), 0)
      : Math.max(...readRows.map((r) => r.i)) + 1;
  }
  const exists = anilist?.exists === true;
  const anilistNumber = Math.max(0, Math.floor(Number(anilist?.progress) || 0));
  const plan = { anilistNumber, appNumber, exists, inSync: exists && anilistNumber === appNumber, toApp: null, toAniList: null, blocked: {} };
  if (plan.inSync) return plan;

  // AniList → this app
  if (!anilistNumber) plan.blocked.toApp = 'anilist-zero';
  else if (anilistNumber > appNumber) {
    const hasNumber = rows.some((r) => r.n !== null);
    const pick = hasNumber ? rows.filter((r) => r.n !== null && r.n <= anilistNumber + _ALSYNC_EPS) : rows.slice(0, Math.min(anilistNumber, rows.length));
    const add = pick.map((r) => keyOf(r.ch)).filter((k) => !readHere.has(k));
    if (add.length) plan.toApp = { kind: 'raise', chapters: add.length, to: anilistNumber };
    else plan.blocked.toApp = 'nothing-to-mark';
  } else {
    const low = planAniListProgressLowering({ mangaId, chapters, readKeys: [...readHere], progress: anilistNumber });
    if (low.error) plan.blocked.toApp = low.error;
    else if (!low.readRemove.length) plan.blocked.toApp = 'nothing-beyond';
    else plan.toApp = { kind: 'lower', chapters: low.readRemove.length, to: anilistNumber, lowering: low };
  }

  // this app → AniList
  if (!appNumber) plan.blocked.toAniList = 'app-zero';
  else plan.toAniList = { from: anilistNumber, to: appNumber, lowers: exists && appNumber < anilistNumber, creates: !exists };
  return plan;
}

// Does what the button says, and nothing else. `deps` is what talks to the page, the server and AniList (replaced in tests):
//   keepCopy()                         the server keeps a copy of its files; must answer { ok:true } (or skipped:'recent')
//   raise(mangaId, sourceId, number)   marks the chapters up to `number` as read here
//   lower(lowering)                    progressSyncLowerManga, with { mangaId, ... } added
//   write(mediaId, number, opts)       writes the progress on AniList
// Returns { ok:true } or { ok:false, reason }. Changes here are only made after the server's copy was kept.
async function anilistApplyProgressSync({ plan, direction, mangaId, sourceId, mediaId }, deps) {
  try {
    if (direction === 'toApp') {
      if (!plan.toApp) return { ok: false, reason: 'nothing to do' };
      const copy = await deps.keepCopy().catch(() => null);
      if (!copy || !(copy.ok === true || copy.skipped === 'recent')) return { ok: false, reason: 'copy' };
      if (plan.toApp.kind === 'raise') await deps.raise(mangaId, sourceId, plan.toApp.to);
      else await deps.lower({ mangaId, ...plan.toApp.lowering });
      return { ok: true };
    }
    if (direction === 'toAniList') {
      if (!plan.toAniList || !mediaId) return { ok: false, reason: 'nothing to do' };
      await deps.write(mediaId, plan.toAniList.to, { newEntry: plan.toAniList.creates });
      return { ok: true };
    }
    return { ok: false, reason: 'direction' };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || 'error' };
  }
}

// ── the window ──────────────────────────────────────────────────────────────

const _alsyncT = (key, vars) => {
  let text = t(key);
  for (const [k, v] of Object.entries(vars || {})) text = text.split(`{${k}}`).join(String(v));
  return text;
};
const _alsyncNumber = (n) => (n ? _alsyncT('anilistSync.chapter', { n }) : t('anilistSync.nothing'));

function _alsyncOptionHtml(direction, title, detail, warn) {
  return `<button class="btn ${warn ? 'secondary' : 'primary'}" data-alsync="${direction}" style="display:block;width:100%;text-align:left;margin-top:0.6rem;padding:0.7rem 0.9rem"><b>${escapeHtml(title)}</b><br><small style="opacity:0.85">${escapeHtml(detail)}</small></button>`;
}

function _alsyncBlockedHtml(why, n) {
  const text = {
    'anilist-zero': t('anilistSync.blocked.anilistZero'),
    'nothing-to-mark': t('anilistSync.blocked.nothingToMark'),
    'nothing-beyond': _alsyncT('anilistSync.blocked.nothingBeyond', { n }),
    'app-zero': t('anilistSync.blocked.appZero'),
  }[why] || _alsyncT('anilistSync.blocked.other', { why });
  return `<p class="setting-description" style="margin:0.5rem 0 0">${escapeHtml(text)}</p>`;
}

function _alsyncBodyHtml(plan) {
  const side = (label, n) => `<div style="flex:1;padding:0.7rem 0.9rem;border-radius:12px;background:var(--bg-secondary)"><div class="setting-description" style="margin:0">${escapeHtml(label)}</div><div style="font-size:1.25rem;font-weight:700">${escapeHtml(_alsyncNumber(n))}</div></div>`;
  let html = `<div style="display:flex;gap:0.8rem">${side(t('anilistSync.onAniList'), plan.exists ? plan.anilistNumber : 0)}${side(t('anilistSync.here'), plan.appNumber)}</div>`;
  if (!plan.exists) html += `<p class="setting-description" style="margin:0.6rem 0 0">${escapeHtml(t('anilistSync.notOnList'))}</p>`;
  if (plan.inSync) return `${html}<p style="margin:0.9rem 0 0">${escapeHtml(_alsyncT('anilistSync.inSync', { n: _alsyncNumber(plan.appNumber) }))}</p>`;
  html += `<p class="setting-description" style="margin:0.9rem 0 0">${escapeHtml(t('anilistSync.choose'))}</p>`;
  const a = plan.toApp;
  if (a) {
    html += _alsyncOptionHtml('toApp', t('anilistSync.useAniList'), _alsyncT(a.kind === 'raise' ? 'anilistSync.raiseHere' : 'anilistSync.lowerHere', { k: a.chapters, n: a.to }), false);
  } else html += _alsyncBlockedHtml(plan.blocked.toApp, plan.anilistNumber);
  const b = plan.toAniList;
  if (b) {
    const detail = b.creates ? _alsyncT('anilistSync.createsOnAniList', { to: b.to }) : _alsyncT(b.lowers ? 'anilistSync.lowersAniList' : 'anilistSync.raisesAniList', { from: b.from, to: b.to });
    html += _alsyncOptionHtml('toAniList', t('anilistSync.useHere'), detail, b.lowers);
  } else html += _alsyncBlockedHtml(plan.blocked.toAniList, plan.appNumber);
  return `${html}<p class="setting-description" style="margin:0.9rem 0 0">${escapeHtml(t('anilistSync.statusNote'))}</p>`;
}

async function _alsyncLoad(manga, sourceId) {
  const mediaId = await _resolveAniListMediaIdForManga(manga.id, manga.title);
  if (!mediaId) return { notFound: true };
  const entry = await _anilistReadEntryByMediaId(mediaId, 'MANGA');
  const data = await api(`/api/source/${encodeURIComponent(sourceId)}/chapters`, { method: 'POST', body: JSON.stringify({ mangaId: manga.id }) });
  const plan = planProgressSync({ mangaId: manga.id, chapters: data?.chapters || [], readKeys: _anilistProgressReadKeys(manga.id), anilist: entry });
  return { mediaId, plan };
}

const _alsyncDeps = () => ({
  keepCopy: () => fetch('/api/progress/safety-copy', { method: 'POST' }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
  raise: (mangaId, sourceId, n) => _syncTrackerProgressToLocal(mangaId, sourceId, n),
  lower: progressSyncLowerManga,
  write: _anilistWriteProgressByMediaId,
});

async function anilistOpenProgressSync(manga) {
  const sourceId = manga.sourceId || '';
  document.querySelector('.alsync-modal')?.remove();
  const modal = document.createElement('div');
  modal.className = 'settings-modal alsync-modal';
  modal.innerHTML = `<div class="settings-content" style="max-width:480px"><div class="settings-header"><h2>${escapeHtml(t('anilistSync.title'))}</h2><button class="btn secondary" data-alsync="close">&#x2715;</button></div><div class="settings-body"><p class="setting-description" style="margin-top:0">${escapeHtml(manga.title || '')}</p><div id="alsyncBody">${escapeHtml(t('anilistSync.reading'))}</div></div></div>`;
  document.body.appendChild(modal);
  const body = modal.querySelector('#alsyncBody');
  let loaded = null;
  modal.addEventListener('click', async (e) => {
    const action = e.target.closest('[data-alsync]')?.dataset.alsync;
    if (e.target === modal || action === 'close') { modal.remove(); return; }
    if (!loaded?.plan || (action !== 'toApp' && action !== 'toAniList')) return;
    modal.querySelectorAll('[data-alsync]').forEach((b) => { b.disabled = true; });
    const res = await anilistApplyProgressSync({ plan: loaded.plan, direction: action, mangaId: manga.id, sourceId, mediaId: loaded.mediaId }, _alsyncDeps());
    if (!res.ok) {
      body.innerHTML = `<p>${escapeHtml(res.reason === 'copy' ? t('anilistSync.copyFailed') : _alsyncT('anilistSync.failed', { message: res.reason }))}</p>`;
      return;
    }
    if (action === 'toAniList' && typeof _alPendingDrop === 'function') _alPendingDrop(manga.id); // what was waiting to be sent is now moot
    if (action === 'toApp' && typeof renderLibrary === 'function') renderLibrary();
    showToast('AniList', t(action === 'toApp' ? 'anilistSync.doneHere' : 'anilistSync.doneAniList'), 'success');
    modal.remove();
  });
  try {
    loaded = await _alsyncLoad(manga, sourceId);
    if (!modal.isConnected) return;
    if (loaded.notFound) body.innerHTML = `<p>${escapeHtml(t('anilistSync.notFound'))}</p>`;
    else if (loaded.plan.error) body.innerHTML = `<p>${escapeHtml(_alsyncT('anilistSync.cannotCompare', { why: loaded.plan.error }))}</p>`;
    else body.innerHTML = _alsyncBodyHtml(loaded.plan);
  } catch (e) {
    if (modal.isConnected) body.innerHTML = `<p>${escapeHtml(_alsyncT('anilistSync.failed', { message: (e && e.message) || '' }))}</p>`;
  }
}
