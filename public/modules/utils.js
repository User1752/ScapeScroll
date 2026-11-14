// ============================================================================
// UTILITIES
// Stateless helper functions shared across the entire frontend.
// No dependencies on state, navigation, or i18n.
// ============================================================================

// ── DOM shorthand ─────────────────────────────────────────────────────────

/**
 * Shorthand for {@link document.getElementById}.
 *
 * @param {string} id
 * @returns {HTMLElement|null}
 */
function $(id) { return document.getElementById(id); }

/**
 * Marks a static (already-in-the-DOM, shown/hidden via the "hidden" class)
 * modal overlay as an ARIA dialog and wires Escape-to-close for it. Call
 * once during the modal's own setup code (not per-open) — the listener
 * re-checks the element's current visibility every time Escape is pressed,
 * so binding it early is safe even before the modal has ever been opened.
 *
 * Not used for dynamically-created modals (e.g. the Settings modal, built
 * fresh via document.createElement on each open) — those wire their own
 * open/close-scoped listener instead, since a single early bind here
 * wouldn't have an element to attach to yet.
 *
 * @param {string} modalId
 * @param {() => void} closeFn
 */
function bindModalEscClose(modalId, closeFn) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const el = document.getElementById(modalId);
    if (el && !el.classList.contains('hidden')) closeFn();
  });
}

/**
 * Returns a debounced wrapper around fn: calls are delayed until `wait` ms
 * have passed without another call.
 *
 * @param {Function} fn
 * @param {number} wait
 * @returns {Function}
 */
function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

// ── Text / HTML helpers ───────────────────────────────────────────────────

/**
 * Escape a string so it can be safely embedded in HTML.
 *
 * @param {*} s - Value to escape (will be coerced to string)
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Normalise image URLs for browser rendering.
 * - Upgrades insecure http:// image URLs to https://.
 * - Routes CDN images that require a Referer header through the local proxy
 *   (the browser won't send one for a plain <img src>, so a direct request
 *   gets rejected and the image never loads).
 *
 * @param {*} url
 * @returns {string}
 */
// ── The covers of the library, kept on the server (server/modules/covers/) ───────────────────────────────────────────────────────────
// The hosts of the source sites refuse a page's direct request for a cover (or change their rules), so the server keeps a copy of the cover
// of every title in the library and this swaps it in. Address -> "/api/library-cover/<file>"; empty until the server has answered, and then
// everything works as before (the cover is asked of its own host).
const _libraryCovers = new Map();
let _libraryCoversAt = 0;

// The address a cover is known by: its own https address, whether the value is that address or this app's proxy address for it. The same
// rule as coverUrlKey() in server/modules/covers/service.js (a test keeps the two equal).
function coverUrlKey(value) {
  let s = String(value || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s, 'http://localhost');
    if (u.pathname === '/api/proxy-image') s = u.searchParams.get('url') || '';
  } catch (_) {
    return '';
  }
  if (/^http:\/\//i.test(s)) s = `https://${s.slice(7)}`;
  return /^https:\/\//i.test(s) ? s : '';
}

// While the server is still fetching covers (its first look at a library takes a couple of minutes), the page asks again every few seconds and
// draws the library again whenever more arrived, so the covers fill in without a refresh.
let _libraryCoversPoll = null;
function _pollLibraryCovers() {
  if (_libraryCoversPoll) return;
  _libraryCoversPoll = setTimeout(async () => {
    _libraryCoversPoll = null;
    const changed = await loadLibraryCovers({ force: true });
    if (changed && typeof renderLibrary === 'function') renderLibrary();
  }, 12_000);
}

// Reads the map from the server (at most every 30 s unless forced). Resolves true when it changed, so a page can draw its covers again.
async function loadLibraryCovers({ force = false } = {}) {
  if (!force && Date.now() - _libraryCoversAt < 30_000) return false;
  _libraryCoversAt = Date.now();
  try {
    const res = await fetch('/api/library-covers');
    if (!res.ok) return false;
    const data = await res.json();
    const before = JSON.stringify([..._libraryCovers]);
    _libraryCovers.clear();
    for (const [address, local] of Object.entries((data && data.covers) || {})) {
      if (typeof local === 'string' && local.startsWith('/api/library-cover/')) _libraryCovers.set(address, local);
    }
    if (data && data.busy === true) _pollLibraryCovers();
    return JSON.stringify([..._libraryCovers]) !== before;
  } catch (_) {
    return false; // the covers are then asked of their own hosts, as they always were
  }
}

// Covers a browser cannot load directly from their host (measured from this app's own page): they go through the image proxy, which sends
// what each host accepts. The same list as browserBlockedHosts in server/config/image-hosts.js (a test keeps them equal).
const _BROWSER_BLOCKED_COVER_HOSTS = [/^uploads\.mangadex\.org$/i, /(^|\.)readdetectiveconan\.com$/i, /(^|\.)2xstorage\.com$/i];
function _isBrowserBlockedCover(value) {
  try { return _BROWSER_BLOCKED_COVER_HOSTS.some((re) => re.test(new URL(value).hostname)); } catch (_) { return false; }
}

// A safety net for a page that draws a cover without going through normalizeImageUrl: when such an image fails, it is asked for once more through
// the image proxy (or the library's copy). The failure is stopped from reaching the image's own onerror, which would hide it before the retry.
document.addEventListener('error', (event) => {
  const img = event.target;
  if (!img || img.tagName !== 'IMG' || !img.dataset || img.dataset.viaProxy === '1') return;
  const failed = img.currentSrc || img.src;
  if (!_isBrowserBlockedCover(failed)) return;
  img.dataset.viaProxy = '1';
  event.stopImmediatePropagation();
  img.src = normalizeImageUrl(failed);
}, true);

function normalizeImageUrl(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  const kept = _libraryCovers.size ? _libraryCovers.get(coverUrlKey(value)) : null;
  if (kept) return kept;
  // Already routed through our proxy — leave as-is.
  if (value.startsWith('/api/proxy-image')) return value;
  // AllManga CDN images need a Referer header; proxy them server-side.
  if (value.includes('wp.youtube-anime.com') || value.includes('aln.youtube-anime.com')) {
    const ref = encodeURIComponent('https://allmanga.to');
    return `/api/proxy-image?url=${encodeURIComponent(value)}&ref=${ref}`;
  }
  // BatCave covers/pages need a Referer header too; same treatment.
  if (value.includes('batcave.biz')) {
    const ref = encodeURIComponent('https://batcave.biz/');
    return `/api/proxy-image?url=${encodeURIComponent(value)}&ref=${ref}`;
  }
  if (_isBrowserBlockedCover(value)) return `/api/proxy-image?url=${encodeURIComponent(value.replace(/^http:\/\//i, 'https://'))}`;
  if (value.startsWith('http://')) return `https://${value.slice(7)}`;
  return value;
}

/**
 * Format a duration in minutes as a human-readable string.
 * Examples: 45 → "45m", 90 → "1h 30m", 120 → "2h"
 *
 * @param {number} minutes
 * @returns {string}
 */
function formatTime(minutes) {
  if (!minutes) return "0m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Convert an internal reading/watching-status key to a display label.
 * Covers both manga's readingStatus values and anime's watchStatus values
 * (see _animeComputeStatus in ui-anime-test.js) — they share completed/
 * on_hold/dropped, and only diverge on the reading/watching and
 * plan_to_read/plan_to_watch pairs, plus anime's derived-only "not-started".
 *
 * @param {"reading"|"watching"|"completed"|"on_hold"|"plan_to_read"|"plan_to_watch"|"dropped"|"not-started"|string} status
 * @returns {string}
 */
function statusLabel(status) {
  const map = {
    reading:       'Reading',
    watching:      'Watching',
    completed:     'Completed',
    on_hold:       'On Hold',
    plan_to_read:  'Plan to Read',
    plan_to_watch: 'Plan to Watch',
    dropped:       'Dropped',
    'not-started': 'Not Started'
  };
  return map[status] || status;
}

const NSFW_TAGS = new Set([
  'ecchi',
  'mature',
  'smut',
  'hentai',
  'adult',
  'nsfw',
  'erotica',
  'suggestive',
  'pornographic',
  'sexual violence',
  'monster girl',
  'netorare',
  'ntr',
  'bdsm',
  'doujin',
  'yuri h',
  'girls love',
  'yuri',
  'yaoi'
]);

const NSFW_TEXT_HINTS = [
  'mature',
  'adult',
  'hentai',
  'ecchi',
  'smut',
  'nsfw',
  'sex',
  'sexual',
  'erot',
  'porn',
  'oppai',
  'boobs',
  'breasts',
  'milf',
  'fetish',
  'bdsm',
  'incest',
  'hitozuma',
  'netorare',
  'ntr',
  'ahegao',
  'yuri h',
  'doujin',
  'lewdness',
  'girls love',
  'yuri',
  'yaoi'
];

function normalizeTagValue(tag) {
  return String(tag || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isNsfwTag(tag) {
  return NSFW_TAGS.has(normalizeTagValue(tag));
}

function isNsfwManga(manga) {
  if (!manga) return false;
  // Manual override (right-click "Add to NSFW" / "Remove from NSFW" in the
  // library) always wins, in EITHER direction, over both checks below —
  // it's the only way to pull a manga back out of NSFW when the tag
  // heuristic would otherwise flag it (a false positive), and the only way
  // to push one in when it would not. isNsfwOverridden
  // returns true/false only when the user has explicitly touched the
  // toggle for this exact manga, undefined otherwise — a plain `if
  // (isNsfwOverridden(...))` would be wrong here since `false` (an
  // explicit "not NSFW") is falsy and would fall through to the checks
  // below instead of short-circuiting them. Lives in ui-library.js;
  // guarded since not every page that can construct a manga-shaped object
  // loads that file.
  if (typeof isNsfwOverridden === 'function') {
    const override = isNsfwOverridden(manga.id, manga.sourceId);
    if (override !== undefined) return override;
  }
  // A source whose whole catalog is adult can say so itself (meta.ui.adultOnly, validated by the server): no id to add here.
  // It can only make a source MORE restricted; the manual override above still wins in both directions.
  if (typeof state !== 'undefined' && state.installedSources?.[manga.sourceId]?.ui?.adultOnly === true) return true;
  const allTags = [
    ...(Array.isArray(manga.genres) ? manga.genres : []),
    ...(Array.isArray(manga.tags) ? manga.tags : []),
    manga.contentRating,
    manga.content_rating,
    manga.ageRating,
  ].filter(Boolean);
  if (allTags.some(isNsfwTag)) return true;

  // Fallback for legacy entries that were saved without usable genre/tag metadata.
  const text = `${manga.title || ''} ${manga.description || ''}`.toLowerCase();
  return NSFW_TEXT_HINTS.some(k => text.includes(k));
}

// ── Webtoon / Manhwa / Manhua auto-detection ──────────────────────────────

const WEBTOON_TYPES = new Set(['manhwa', 'manhua', 'webtoon', 'webtoons']);
const WEBTOON_GENRES = new Set(['manhwa', 'manhua', 'webtoons', 'webtoon']);

/**
 * Returns true when the manga is a vertical-scroll format (Manhwa / Manhua / Webtoon).
 * Checks the `type` field first, then genres/tags.
 *
 * @param {object} manga
 * @returns {boolean}
 */
function isWebtoonFormat(manga) {
  if (!manga) return false;
  const type = String(manga.type || '').toLowerCase().trim();
  if (WEBTOON_TYPES.has(type)) return true;
  const allTags = [
    ...(Array.isArray(manga.genres) ? manga.genres : []),
    ...(Array.isArray(manga.tags)   ? manga.tags   : []),
  ].map(t => String(t || '').toLowerCase().trim());
  return allTags.some(t => WEBTOON_GENRES.has(t));
}

// ── Theme (dark / light toggle) ───────────────────────────────────────────

/**
 * Read the saved theme from localStorage and apply it to the document root.
 * Should be called once during app initialisation.
 */
function initTheme() {
  const saved = localStorage.getItem("scrollscapeTheme") || "dark";
  document.documentElement.setAttribute("data-theme", saved);
  updateThemeToggleIcon(saved);
}

/**
 * Toggle between "dark" and "light" themes and persist the choice.
 */
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("scrollscapeTheme", next);
  updateThemeToggleIcon(next);
}

/**
 * Show the correct sun / moon icon for the given theme.
 *
 * @param {"dark"|"light"} theme
 */
function updateThemeToggleIcon(theme) {
  const moonIcon = document.querySelector(".icon-moon");
  const sunIcon  = document.querySelector(".icon-sun");
  if (!moonIcon || !sunIcon) return;
  if (theme === "dark") {
    moonIcon.style.display = "block";
    sunIcon.style.display  = "none";
  } else {
    moonIcon.style.display = "none";
    sunIcon.style.display  = "block";
  }
}

// ── Toast notifications ───────────────────────────────────────────────────

/**
 * Display a brief toast notification.
 *
 * @param {string} title   - Primary line of text
 * @param {string} [message=""] - Optional secondary line
 * @param {"default"|"success"|"error"|"info"} [type="default"]
 */
function showToast(title, message = "", type = "default") {
  const container = $("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-title">${escapeHtml(title)}</div>
    ${message ? `<div class="toast-message">${escapeHtml(message)}</div>` : ""}
  `;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3100);
}

// Copies text to the clipboard. navigator.clipboard only exists in a secure context (https, or localhost): the app opened by the
// address of a server on the home network (http://192.168.x.x:4000, a CasaOS box) has none, so this falls back to the old way, a hidden
// textarea and the browser's copy command. Resolves true when something was copied and false when nothing could be (the browser wants a
// click very recently for the old way): then showTextToCopy() puts the text where the person can select it.
async function copyTextToClipboard(text) {
  const value = String(text === undefined || text === null ? '' : text);
  try {
    if (navigator.clipboard && window.isSecureContext !== false) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (_) { /* refused: try the old way */ }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(area);
  const active = document.activeElement;
  area.select();
  area.setSelectionRange(0, value.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } catch (_) { copied = false; }
  area.remove();
  if (active && typeof active.focus === 'function') active.focus();
  return copied;
}

// The text in a box that can be selected and copied by hand, for when copyTextToClipboard() could not. Closed by the button, by a click
// outside the box or by Escape.
function showTextToCopy(title, text) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="import-modal-box" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="modal-header"><h3>${escapeHtml(title)}</h3><button type="button" class="btn-close-modal" aria-label="Close">&times;</button></div>
      <div style="padding:1rem 1.4rem 1.2rem"><textarea readonly style="width:100%;min-height:50vh;box-sizing:border-box;font:inherit;font-family:monospace;font-size:.8rem;color:inherit;background:transparent;border:1px solid var(--border);border-radius:var(--radius)"></textarea></div>
    </div>`;
  const area = overlay.querySelector('textarea');
  area.value = String(text === undefined || text === null ? '' : text);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (event) => { if (event.key === 'Escape') close(); };
  overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
  overlay.querySelector('.btn-close-modal').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  area.focus();
  area.select();
}
