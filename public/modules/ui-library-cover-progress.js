// ============================================================================
// LIBRARY → COVER LOADING PROGRESS (a ring with "37/249" under the side column)
//
// The covers of the library are `loading="lazy"`, so on a big library they trickle in as the page is scrolled and the person sees blank cards for a
// while. When the library is drawn this loads the covers of the grid itself, from the top down and a few at a time (which also leaves them in the
// browser's cache, so scrolling is instant), and shows how far it is in a ring under the floating column on the right: the ring fills and says
// "done/total". It appears only if the covers take more than a moment (a library already in the cache never shows it), stays a little at 100%,
// and goes away. A cover that fails counts as done (its card shows the placeholder); a newer draw of the library replaces the one in progress.
// The engine is plain functions (lcpRun, lcpSources) so it is tested without a page; the ring is built here.
//
// The home page has the same ring, for its rows of covers (homeCoverProgressWatch, below): it comes when a row is drawn and takes the bottom right
// corner of the window, because there is no side column to sit under.
// ============================================================================

const LIBRARY_COVER_PROGRESS = Object.freeze({
  showAfterMs: 350,        // a library that loads faster than this never shows the ring
  holdDoneMs: 700,         // how long it stays at 100% before it goes
  concurrency: 6,          // covers asked for at once
  perCoverTimeoutMs: 20_000, // one slow cover must not hold the count
  ringRadius: 18,
  cornerWidth: 84,         // the width of the ring where there is no side column to take it from (the home page)
  homeSettleMs: 400,       // after the last row is drawn, how long to wait before counting the home page's covers
  homeTickMs: 400,         // how often the home page's count is looked at again
  homeGiveUpMs: 90_000,    // a count that never finishes (a cover that never answers) is dropped after this
});
const _LCP_CIRCUMFERENCE = 2 * Math.PI * LIBRARY_COVER_PROGRESS.ringRadius;

let _lcpToken = 0;       // each draw of the library takes the next number; older runs stop
let _lcpEl = null;
let _lcpHideTimer = null;
let _lcpResizeBound = false;

// ── the engine ──────────────────────────────────────────────────────────────

// The distinct cover addresses in a grid, in page order, and which of them the browser already has.
function lcpSources(images) {
  const seen = new Map();
  for (const img of images) {
    const src = String((img && (img.currentSrc || img.src)) || '').trim();
    if (!src || seen.has(src)) continue;
    seen.set(src, !!(img.complete && img.naturalWidth > 0));
  }
  return { all: [...seen.keys()], pending: [...seen].filter(([, ready]) => !ready).map(([src]) => src), ready: [...seen.values()].filter(Boolean).length };
}

// Loads `pending` with at most `concurrency` at a time, in order; `onProgress(done, total)` after each one, starting from `ready` done.
// Stops early (resolving) when `isCurrent()` turns false. `load(src)` resolves whatever happens to the cover: a failed one is done too.
async function lcpRun({ pending, ready, total, load, onProgress, isCurrent, concurrency }) {
  let done = ready;
  let next = 0;
  onProgress(done, total);
  async function worker() {
    while (next < pending.length && isCurrent()) {
      const src = pending[next++];
      await load(src);
      if (!isCurrent()) return;
      done++;
      onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return done;
}

// The browser loads a cover into its cache by being asked for one; `new Image()` is never added to the page.
function lcpLoadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => resolve('timeout'), LIBRARY_COVER_PROGRESS.perCoverTimeoutMs);
    img.onload = () => { clearTimeout(timer); resolve('ok'); };
    img.onerror = () => { clearTimeout(timer); resolve('failed'); };
    img.decoding = 'async';
    img.src = src;
  });
}

// ── the ring ────────────────────────────────────────────────────────────────

function _lcpElement() {
  if (_lcpEl && _lcpEl.isConnected) return _lcpEl;
  const r = LIBRARY_COVER_PROGRESS.ringRadius;
  const el = document.createElement('div');
  el.id = 'libraryCoverProgress';
  el.className = 'library-cover-progress';
  el.setAttribute('role', 'progressbar');
  el.hidden = true;
  el.innerHTML = `<svg class="lcp-ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="lcp-track" cx="22" cy="22" r="${r}"></circle><circle class="lcp-arc" cx="22" cy="22" r="${r}" stroke-dasharray="${_LCP_CIRCUMFERENCE.toFixed(2)}" stroke-dashoffset="${_LCP_CIRCUMFERENCE.toFixed(2)}"></circle></svg>`
    + '<span class="lcp-count"><b class="lcp-done">0</b><span class="lcp-total">/0</span></span>'
    + `<span class="lcp-label">${escapeHtml(t('library.coverProgress.label'))}</span>`;
  document.body.appendChild(el);
  _lcpEl = el;
  if (!_lcpResizeBound) { _lcpResizeBound = true; window.addEventListener('resize', _lcpPlace); }
  return el;
}

// Under the floating column, the same width and edge; above it when the window leaves no room below; and when the column fills the whole
// height (a small window), beside it on the left at the bottom, so it is never lost under the header.
function _lcpPlace() {
  const el = _lcpEl;
  if (!el || el.hidden) return;
  const panel = document.getElementById('librarySideActions');
  const box = panel ? panel.getBoundingClientRect() : null;
  const height = el.offsetHeight || 96;
  const room = window.innerHeight - 8;
  // No side column on this page (the library is not the view in use): the bottom right corner.
  if (!box || !(box.width > 0)) {
    el.style.width = `${LIBRARY_COVER_PROGRESS.cornerWidth}px`;
    el.style.right = '16px';
    el.style.top = `${Math.max(8, room - height - 8)}px`;
    return;
  }
  el.style.width = `${Math.round(box.width)}px`;
  el.style.right = '12px';
  if (box.bottom + 10 + height <= room) {
    el.style.top = `${box.bottom + 10}px`;
  } else if (box.top - height - 10 >= 8) {
    el.style.top = `${box.top - height - 10}px`;
  } else {
    el.style.right = `${12 + Math.round(box.width) + 10}px`;
    el.style.top = `${Math.max(8, room - height - 4)}px`;
  }
}

function _lcpDraw(done, total) {
  const el = _lcpElement();
  const fraction = total ? Math.min(1, done / total) : 1;
  el.querySelector('.lcp-done').textContent = String(done);
  el.querySelector('.lcp-total').textContent = `/${total}`;
  el.querySelector('.lcp-arc').setAttribute('stroke-dashoffset', (_LCP_CIRCUMFERENCE * (1 - fraction)).toFixed(2));
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', String(total));
  el.setAttribute('aria-valuenow', String(done));
  el.setAttribute('aria-label', t('library.coverProgress.aria').split('{done}').join(String(done)).split('{total}').join(String(total)));
  el.classList.toggle('is-done', done >= total);
}

function _lcpShow() {
  clearTimeout(_lcpHideTimer);
  const el = _lcpElement();
  el.classList.remove('is-leaving');
  el.hidden = false;
  _lcpPlace();
}

function _lcpHide(afterMs) {
  clearTimeout(_lcpHideTimer);
  if (!_lcpEl) return;
  _lcpHideTimer = setTimeout(() => {
    if (!_lcpEl) return;
    _lcpEl.classList.add('is-leaving');
    _lcpHideTimer = setTimeout(() => { if (_lcpEl) _lcpEl.hidden = true; }, 300);
  }, afterMs);
}

// ── entry point: called after the library is drawn ──────────────────────────

async function libraryCoverProgressStart(grid) {
  const token = ++_lcpToken;
  const isCurrent = () => token === _lcpToken;
  if (!grid) { _lcpHide(0); return; }
  const found = lcpSources([...grid.querySelectorAll('img')]);
  if (!found.pending.length) { _lcpHide(0); return; } // everything is already there: nothing to show

  const total = found.all.length;
  let shown = false;
  let lastDone = found.ready;
  const showTimer = setTimeout(() => { if (isCurrent()) { shown = true; _lcpShow(); _lcpDraw(lastDone, total); } }, LIBRARY_COVER_PROGRESS.showAfterMs);
  const done = await lcpRun({
    pending: found.pending, ready: found.ready, total, load: lcpLoadImage, isCurrent, concurrency: LIBRARY_COVER_PROGRESS.concurrency,
    onProgress: (n) => { lastDone = n; if (shown && isCurrent()) _lcpDraw(n, total); },
  });
  clearTimeout(showTimer);
  if (!isCurrent()) return; // a newer draw has taken over (it has its own ring)
  if (shown) { _lcpDraw(done, total); _lcpHide(LIBRARY_COVER_PROGRESS.holdDoneMs); }
}

// ── the home page ───────────────────────────────────────────────────────────

// The rows of the home page are drawn with whatever the sources' lists carry: many cards come with no cover (a "?") and get theirs a moment
// later, from the title's own page or AniList (ui-discover.js, _hydrateMissingGenres). So the home page counts one slot per card, not only the
// images that are already there: a card is done when its cover has loaded (or failed), or, with no cover to be had, once that search is over.

// The cards of the home page in use (manga or anime), one per title (a card the auto-scroll cloned counts once), in page order.
function homeCoverSlots() {
  const seen = new Map();
  for (const id of ['discoverMangaContent', 'discoverAnimeContent']) {
    const box = document.getElementById(id);
    if (!box || (box.classList && box.classList.contains('hidden'))) continue;
    for (const card of box.querySelectorAll('.popular-row .manga-card, .results-grid .manga-card, .continue-reading-row .manga-card')) {
      const data = card.dataset || {};
      const key = data.mangaId ? `${data.sourceId || ''}:${data.mangaId}` : card;
      if (!seen.has(key)) seen.set(key, card);
    }
  }
  return [...seen.values()];
}

// What is left of the cards' covers: { total, done, toLoad } where toLoad are the addresses still to be asked for. `loaded` holds those already asked for;
// `searching` says whether covers are still being looked for (a card with no image yet is waiting for one only then).
function homeCoverCount(cards, loaded, searching) {
  let done = 0;
  const toLoad = [];
  for (const card of cards) {
    const img = card.querySelector('img');
    if (img) {
      const src = String(img.currentSrc || img.src || '').trim();
      if (!src || img.complete || loaded.has(src)) done++; // a cover that failed is complete too: it counts as done
      else toLoad.push(src);
    } else if (searching && card.querySelector('.no-cover[data-missing-cover="1"]')) {
      // waiting for the search of a cover
    } else {
      done++;
    }
  }
  return { total: cards.length, done, toLoad };
}

let _hcpToken = 0;
// The covers already asked for, kept between counts (a row drawn again starts a new count, which must not lose what the last one had loaded).
const _hcpLoaded = new Set();
const _HCP_LOADED_MAX = 3000;

// Counts the covers of the home page's cards until every one is done (loaded, failed, or searched for in vain), showing the ring as the library does.
function homeCoverProgressStart() {
  const token = ++_hcpToken;
  const lcp = ++_lcpToken; // a count of the library in progress stops: there is one ring
  const isCurrent = () => token === _hcpToken && lcp === _lcpToken;
  const loaded = _hcpLoaded;
  const asked = new Set();
  if (loaded.size > _HCP_LOADED_MAX) loaded.clear();
  let inFlight = 0;
  let shown = false;
  let waited = 0;
  const searching = () => (typeof homeHydrationActive === 'function' ? homeHydrationActive() > 0 : false);

  function ask(addresses) {
    for (const src of addresses) {
      if (asked.has(src) || inFlight >= LIBRARY_COVER_PROGRESS.concurrency) continue;
      asked.add(src);
      inFlight++;
      lcpLoadImage(src).then(() => { loaded.add(src); inFlight--; });
    }
  }

  function tick() {
    if (!isCurrent()) return;
    const found = homeCoverCount(homeCoverSlots(), loaded, searching());
    const pending = found.total - found.done;
    if (pending > 0) ask(found.toLoad);
    if (pending > 0 && !shown && waited >= LIBRARY_COVER_PROGRESS.showAfterMs) { shown = true; _lcpShow(); }
    if (shown) _lcpDraw(found.done, found.total);
    if (pending === 0 || waited >= LIBRARY_COVER_PROGRESS.homeGiveUpMs) {
      if (shown) { _lcpDraw(found.done, found.total); _lcpHide(LIBRARY_COVER_PROGRESS.holdDoneMs); }
      return;
    }
    waited += LIBRARY_COVER_PROGRESS.homeTickMs;
    setTimeout(tick, LIBRARY_COVER_PROGRESS.homeTickMs);
  }
  tick();
}

// Whether a change of a row is a row drawn again (cards put in), not a cover swapped into a card that was already there.
function homeCoverProgressIsRowDrawn(records) {
  return records.some((record) => [...(record.addedNodes || [])].some((node) => node && node.nodeType === 1 && node.classList && [...node.classList].some((name) => /card/.test(name))));
}

// Watches the home page's rows and, a moment after they are drawn, starts the count (the newest count replaces the one in progress).
function homeCoverProgressWatch() {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return null;
  const boxes = ['discoverMangaContent', 'discoverAnimeContent'].map((id) => document.getElementById(id)).filter(Boolean);
  if (!boxes.length) return null;
  let timer = null;
  const observer = new MutationObserver((records) => {
    if (!homeCoverProgressIsRowDrawn(records)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const view = document.getElementById('view-discover');
      if (!view || (view.classList && view.classList.contains('hidden'))) return; // another page is in use: no ring on it
      homeCoverProgressStart();
    }, LIBRARY_COVER_PROGRESS.homeSettleMs);
  });
  boxes.forEach((box) => observer.observe(box, { childList: true, subtree: true }));
  return observer;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.addEventListener) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', homeCoverProgressWatch);
  else homeCoverProgressWatch();
}
