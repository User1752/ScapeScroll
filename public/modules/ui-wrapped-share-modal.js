// ============================================================================
// WRAPPED → SHARE WINDOW
//
// Opens from the Share button of the Wrapped tab: a preview of the card, the choices (which card, which size, the theme's colours or
// the default ones, the period on it or not) and what can be done with it: download the PNG, copy the image, or hand it to the
// phone's share sheet. The card is made in this browser (wrapped-share-cards.js) from the numbers the page is showing, so what the
// person hid is not on it.
// ============================================================================

const _wShare = { variant: 'recap', size: 'square', followTheme: true, showPeriod: true, blob: null, url: '', seq: 0, wrapped: null };

function _wShareOptions() {
  return { variant: _wShare.variant, size: _wShare.size, followTheme: _wShare.followTheme, showPeriod: _wShare.showPeriod };
}

// What this browser can do with an image: copying needs a secure context (https or localhost), which a server reached by its address on
// the network is not; the share sheet needs a phone or a recent browser. Download always works.
function wrappedShareCapabilities() {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const secure = typeof window !== 'undefined' && window.isSecureContext !== false;
  return {
    copy: secure && !!(nav.clipboard && nav.clipboard.write) && typeof ClipboardItem !== 'undefined',
    share: typeof nav.share === 'function' && typeof nav.canShare === 'function',
  };
}

function _wShareHtml() {
  const caps = wrappedShareCapabilities();
  const choice = (group, id, label, current) => `<label class="wrapped-share-choice"><input type="radio" name="wshare-${group}" value="${id}" data-wshare="${group}"${current === id ? ' checked' : ''}><span>${escapeHtml(label)}</span></label>`;
  return `<div class="wrapped-share-dialog" role="dialog" aria-modal="true" aria-labelledby="wrappedShareTitle">
    <div class="wrapped-share-head"><h3 id="wrappedShareTitle">${escapeHtml(t('wrapped.share.title'))}</h3><button class="wrapped-share-close" data-wshare-action="close" aria-label="${escapeHtml(t('wrapped.share.close'))}">×</button></div>
    <div class="wrapped-share-body">
      <div class="wrapped-share-preview" id="wrappedSharePreview"><span class="wrapped-share-status" id="wrappedShareStatus">${escapeHtml(t('wrapped.share.rendering'))}</span></div>
      <div class="wrapped-share-side">
        <fieldset><legend>${escapeHtml(t('wrapped.share.card'))}</legend>${choice('variant', 'recap', t('wrapped.share.recap'), _wShare.variant)}${choice('variant', 'top5', t('wrapped.share.top5'), _wShare.variant)}</fieldset>
        <fieldset><legend>${escapeHtml(t('wrapped.share.size'))}</legend>${choice('size', 'square', t('wrapped.share.square'), _wShare.size)}${choice('size', 'story', t('wrapped.share.story'), _wShare.size)}</fieldset>
        <label class="wrapped-toggle"><input type="checkbox" data-wshare="followTheme"${_wShare.followTheme ? ' checked' : ''}><span>${escapeHtml(t('wrapped.share.theme'))}</span></label>
        <label class="wrapped-toggle"><input type="checkbox" data-wshare="showPeriod"${_wShare.showPeriod ? ' checked' : ''}><span>${escapeHtml(t('wrapped.share.period'))}</span></label>
        <p class="wrapped-note">${escapeHtml(t('wrapped.share.note'))}</p>
        <div class="wrapped-share-actions">
          <button class="btn primary" data-wshare-action="download" disabled>${escapeHtml(t('wrapped.share.download'))}</button>
          <button class="btn secondary" data-wshare-action="copy" disabled${caps.copy ? '' : ` title="${escapeHtml(t('wrapped.share.copyUnavailable'))}" data-unavailable="1"`}>${escapeHtml(t('wrapped.share.copy'))}</button>
          ${caps.share ? `<button class="btn secondary" data-wshare-action="share" disabled>${escapeHtml(t('wrapped.share.native'))}</button>` : ''}
        </div>
        <p class="wrapped-note" id="wrappedShareNote">${caps.copy ? '' : escapeHtml(t('wrapped.share.copyUnavailable'))}</p>
      </div>
    </div>
  </div>`;
}

function _wShareSetStatus(text) {
  const el = document.getElementById('wrappedShareStatus');
  if (el) el.textContent = text;
}

function _wShareButtons(enabled) {
  const caps = wrappedShareCapabilities();
  document.querySelectorAll('#wrappedShareOverlay [data-wshare-action]').forEach((b) => {
    const a = b.dataset.wshareAction;
    if (a === 'close') return;
    b.disabled = !enabled || (a === 'copy' && !caps.copy);
  });
}

async function _wShareRender() {
  const seq = ++_wShare.seq;
  _wShareButtons(false);
  const preview = document.getElementById('wrappedSharePreview');
  if (!preview) return;
  preview.innerHTML = `<span class="wrapped-share-status" id="wrappedShareStatus">${escapeHtml(t('wrapped.share.rendering'))}</span>`;
  try {
    const blob = await renderWrappedCardBlob(_wShare.wrapped, _wShareOptions());
    if (seq !== _wShare.seq || !document.getElementById('wrappedSharePreview')) return; // a newer choice, or the window was closed
    if (_wShare.url) URL.revokeObjectURL(_wShare.url);
    _wShare.blob = blob;
    _wShare.url = URL.createObjectURL(blob);
    preview.innerHTML = `<img src="${_wShare.url}" alt="${escapeHtml(t('wrapped.share.title'))}" class="wrapped-share-img wrapped-share-img--${_wShare.size}">`;
    _wShareButtons(true);
  } catch (e) {
    if (seq !== _wShare.seq) return;
    dbg.warn(dbg.ERR_ANALYTICS, 'The Wrapped card could not be made', e);
    preview.innerHTML = `<span class="wrapped-share-status">${escapeHtml(t('wrapped.share.error').split('{message}').join(e.message || ''))}</span>`;
  }
}

function closeWrappedShare() {
  _wShare.seq++;
  if (_wShare.url) URL.revokeObjectURL(_wShare.url);
  _wShare.url = '';
  _wShare.blob = null;
  const overlay = document.getElementById('wrappedShareOverlay');
  if (overlay) overlay.remove();
  document.removeEventListener('keydown', _wShareKey);
}

function _wShareKey(e) { if (e.key === 'Escape') closeWrappedShare(); }

async function _wShareAction(action) {
  const blob = _wShare.blob;
  const note = document.getElementById('wrappedShareNote');
  if (action === 'close') { closeWrappedShare(); return; }
  if (!blob) return;
  const name = wrappedCardFileName(_wShare.wrapped, _wShareOptions());
  if (action === 'download') {
    const a = document.createElement('a');
    a.href = _wShare.url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  if (action === 'copy') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      if (note) note.textContent = t('wrapped.share.copied');
    } catch (e) {
      if (note) note.textContent = t('wrapped.share.error').split('{message}').join(e.message || '');
    }
    return;
  }
  if (action === 'share') {
    try {
      const file = new File([blob], name, { type: 'image/png' });
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'ScrollScape Wrapped' });
    } catch (e) {
      if (e && e.name !== 'AbortError' && note) note.textContent = t('wrapped.share.error').split('{message}').join(e.message || ''); // closing the sheet is not an error
    }
  }
}

function openWrappedShare() {
  const w = (typeof _wrapped !== 'undefined' && (_wrapped.shown || _wrapped.data)) || null;
  if (!w) return;
  closeWrappedShare();
  _wShare.wrapped = w;
  const overlay = document.createElement('div');
  overlay.id = 'wrappedShareOverlay';
  overlay.className = 'wrapped-share-overlay';
  overlay.innerHTML = _wShareHtml();
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) { closeWrappedShare(); return; }
    const b = e.target.closest('[data-wshare-action]');
    if (b && !b.disabled) _wShareAction(b.dataset.wshareAction);
  });
  overlay.addEventListener('change', (e) => {
    const el = e.target.closest('[data-wshare]');
    if (!el) return;
    const k = el.dataset.wshare;
    if (k === 'variant' && WRAPPED_CARD_VARIANTS.includes(el.value)) _wShare.variant = el.value;
    else if (k === 'size' && WRAPPED_CARD_SIZES[el.value]) _wShare.size = el.value;
    else if (k === 'followTheme') _wShare.followTheme = el.checked;
    else if (k === 'showPeriod') _wShare.showPeriod = el.checked;
    else return;
    _wShareRender();
  });
  document.body.appendChild(overlay);
  document.addEventListener('keydown', _wShareKey);
  const first = overlay.querySelector('[data-wshare-action="close"]');
  if (first) first.focus();
  _wShareRender();
}
