// ============================================================================
// ROW AUTO-SCROLL + DRAG
// ============================================================================

function initRowAutoScroll(row, rebind = bindMangaCards) {
  if (row._autoScrollId) cancelAnimationFrame(row._autoScrollId);

  const SPEED = 0.4; // px per frame

  row.style.scrollSnapType = "none";

  // Loop seamlessly: duplicate the row's content once so the end of the
  // duplicate set lines up pixel-for-pixel with the start of the original.
  // Wrapping scrollLeft back by exactly one set-width there is invisible,
  // instead of snapping back to 0 mid-row like a straight reset would.
  const setWidth = row.scrollWidth;
  let loopWidth = 0;
  if (setWidth > row.clientWidth) {
    Array.from(row.children).forEach(child => row.appendChild(child.cloneNode(true)));
    rebind(row); // cloneNode drops JS-assigned onclick handlers — rebind covers both sets
    loopWidth = setWidth;
    // A cloned card copies whatever the original looked like at THIS exact
    // instant — this runs synchronously, right after render, well before
    // the original's own async genre/cover hydration (ui-discover.js) could
    // possibly have resolved anything yet. A clone made while the original
    // still showed "?" is a brand-new DOM node the original hydration
    // pass's fixed target list never knew about, so it stayed "?" forever
    // even after the original card next to it got fixed (confirmed live: a
    // duplicated card in this exact loop, permanently missing its cover
    // while its twin resolved fine). Re-running hydration over the whole
    // row (now original + clones) catches both sets — cheap for anything
    // already resolved (cache hit, no new fetch) and correct for whatever
    // is still pending.
    if (typeof _hydrateMissingGenres === 'function') _hydrateMissingGenres(row);
  }

  let pos = row.scrollLeft;

  function tick() {
    if (!row._dragging) {
      pos += SPEED;
      if (loopWidth) pos %= loopWidth;
      if (row.scrollWidth - row.clientWidth > 0) row.scrollLeft = pos;
    } else {
      pos = row.scrollLeft;
    }
    row._autoScrollId = requestAnimationFrame(tick);
  }
  row._autoScrollId = requestAnimationFrame(tick);

  initRowDrag(row);
}

function initRowDrag(row) {
  if (row._dragInit) return;
  row._dragInit = true;

  let startX    = 0;
  let startLeft = 0;
  let hasMoved  = false;

  row.style.cursor = "grab";

  row.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    startX    = e.clientX;
    startLeft = row.scrollLeft;
    hasMoved  = false;
    row.style.cursor = "grabbing";
  }, { passive: true });

  row.addEventListener("pointermove", e => {
    if (e.buttons !== 1) return;
    const dx = e.clientX - startX;
    if (!hasMoved && Math.abs(dx) < 5) return; // threshold: ignore tiny jitter
    hasMoved = true;
    row._dragging = true;
    row.scrollLeft = startLeft - dx;
  }, { passive: true });

  const stopDrag = () => { row._dragging = false; row.style.cursor = "grab"; };
  row.addEventListener("pointerup",     stopDrag);
  row.addEventListener("pointercancel", () => { hasMoved = false; stopDrag(); });

  // Block click from opening manga only if user actually dragged (not just clicked)
  row.addEventListener("click", e => {
    if (hasMoved) {
      e.stopPropagation();
      hasMoved = false;
    }
  }, true); // capture phase — fires before card onclick
}

// ============================================================================
// CARD TAG-ROW AUTO-SCROLL (My Anime / anime Discover cards' .library-card-
// tags — see ui-anime-test.js's _animeFavoriteCardHTML and ui-anime-
// discover.js's _animeDiscoverCardHTML)
// ============================================================================
// Same scrollLeft-wrapping technique as initRowAutoScroll above — a CSS
// @keyframes translateX version was tried first but users saw it scroll
// partway and then go blank instead of looping seamlessly, so this uses
// the same mechanism already proven correct for the big row carousels
// instead of debugging a second, parallel animation technique. Unlike
// initRowAutoScroll this doesn't spawn one
// requestAnimationFrame loop per row — there can be dozens of these on one
// page (one per visible card) — instead every registered row is ticked
// from a single shared loop. No drag wiring either: these are decorative
// pill rows a few px tall, not something worth click-vs-drag disambiguation
// for, and dragging one could fight the card's own click-to-open handler.
//
// Auto-discovered via MutationObserver rather than called explicitly from
// every render site (My Anime library, Discover's Popular/Season/New
// Episodes/Recommended/Continue Watching rows, Advanced Search, home
// search — eight call sites and counting) — same pattern customSelect.js
// already uses for auto-wrapping <select> elements, so a future new card
// grid gets this for free instead of needing its own wiring.
const _cardTagsMarqueeRows = new Set();
let _cardTagsMarqueeTicking = false;
const CARD_TAGS_MARQUEE_SPEED = 0.4; // px per frame, matches initRowAutoScroll's SPEED

function _tickCardTagsMarquee() {
  for (const row of _cardTagsMarqueeRows) {
    if (!row.isConnected) { _cardTagsMarqueeRows.delete(row); continue; }
    row._marqueePos = (row._marqueePos || 0) + CARD_TAGS_MARQUEE_SPEED;
    row._marqueePos %= row._marqueeLoopWidth;
    row.scrollLeft = row._marqueePos;
  }
  if (_cardTagsMarqueeRows.size > 0) {
    requestAnimationFrame(_tickCardTagsMarquee);
  } else {
    _cardTagsMarqueeTicking = false;
  }
}

function _initCardTagsMarquee(row) {
  if (row.hasAttribute("data-marquee-init")) return;
  row.setAttribute("data-marquee-init", "1");
  const setWidth = row.scrollWidth;
  if (setWidth <= row.clientWidth + 1) return; // fits — leave completely static
  row.innerHTML += row.innerHTML; // duplicate once for a seamless loop
  row._marqueeLoopWidth = setWidth;
  _cardTagsMarqueeRows.add(row);
  if (!_cardTagsMarqueeTicking) {
    _cardTagsMarqueeTicking = true;
    requestAnimationFrame(_tickCardTagsMarquee);
  }
}

function _scanForCardTagsMarquee(root) {
  if (root.nodeType !== 1) return;
  if (root.matches?.(".library-card-tags")) _initCardTagsMarquee(root);
  root.querySelectorAll?.(".library-card-tags")?.forEach(_initCardTagsMarquee);
}

(function () {
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) _scanForCardTagsMarquee(node);
    }
  });
  const start = () => {
    _scanForCardTagsMarquee(document.body);
    mo.observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

