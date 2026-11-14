'use strict';

/**
 * "Only from the machine running ScrollScape" guard for the routes that can
 * change what code the server runs or what it trusts.
 *
 * Why this exists: the server binds every interface outside the packaged exe
 * (Launch-ScrollScape.bat, scrollscape.sh, Docker) and the Access Password is
 * OFF by default, so with defaults any device on the network could POST a
 * repo URL it controls to /api/repos, install a "source" from it (which is
 * downloaded and require()d — arbitrary code in the server process), or
 * overwrite the operator settings. Once a password is set the normal auth
 * gate protects these routes exactly like every other /api route; this guard
 * covers the window where there is NO password, and (SCROLLSCAPE_ADMIN_LOCAL_ONLY=1)
 * can keep them local-only even when there is one.
 *
 * A request counts as local only if ALL of these hold:
 *   - the TCP peer is a loopback address (not just "looks local" by header), and
 *   - the Host header names this machine. The second check is what stops DNS
 *     rebinding: a page on evil.example that re-resolves to 127.0.0.1 reaches
 *     the loopback socket but still sends Host: evil.example, and
 *   - the request was not relayed by a reverse proxy running on this machine
 *     that announces itself (tailscale serve and Caddy add X-Forwarded-*).
 *     Such a proxy makes every peer look like 127.0.0.1, and a remote client
 *     controls the Host header it sends, so relayed requests are never treated
 *     as local. A relay that adds no headers at all (nginx's default config,
 *     ssh -L, netsh portproxy) cannot be told apart from a local browser: do
 *     not put one in front of this app without an Access Password, and
 *   - the browser did not mark it as coming from another site (see
 *     isCrossSiteBrowserRequest).
 */

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// Headers a reverse proxy adds when it relays a request. A direct request from
// a browser on this machine never carries them.
const PROXY_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'forwarded',
  'tailscale-user-login',
  'tailscale-user-name',
  'tailscale-user-profile-pic',
  'tailscale-headers-info',
  'tailscale-funnel-request',
];

function isLoopbackAddress(address) {
  return LOOPBACK_ADDRESSES.has(String(address || ''));
}

/** @param {string|undefined} hostHeader e.g. "localhost:4000" or "[::1]:4000" */
function isLocalHostHeader(hostHeader) {
  const host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return false;
  // Strip an optional :port. IPv6 literals are bracketed, so the port (if
  // any) is whatever follows the closing bracket.
  const name = host.startsWith('[')
    ? host.slice(0, host.indexOf(']') + 1)
    : host.replace(/:\d+$/, '');
  return LOCAL_HOSTNAMES.has(name);
}

function isProxiedRequest(req) {
  const headers = req?.headers || {};
  return PROXY_HEADERS.some((name) => headers[name] !== undefined);
}

// A loopback socket with a local Host header is also what a browser produces
// when a page from ANOTHER site makes the request (an image/form/fetch to
// http://localhost:4000, a redirect chain followed by FlareSolverr's Chrome, a
// page script running there). Browsers label those: Sec-Fetch-Site is
// "cross-site"/"same-site" instead of "none" (typed URL, bookmark) or
// "same-origin" (this app's own pages), and a cross-origin POST carries an
// Origin that is not this host. Neither header exists on curl, the Suwayomi
// bridge or the server's own calls, so those are unaffected.
function isCrossSiteBrowserRequest(headers = {}) {
  const site = String(headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site' || site === 'same-site') return true;
  const origin = headers.origin;
  if (origin === undefined) return false;
  try {
    return new URL(String(origin)).host.toLowerCase() !== String(headers.host || '').toLowerCase();
  } catch {
    return true; // "Origin: null" (sandboxed iframe, data: URL) or garbage
  }
}

function isLocalRequest(req) {
  return isLoopbackAddress(req?.socket?.remoteAddress)
    && isLocalHostHeader(req?.headers?.host)
    && !isProxiedRequest(req)
    && !isCrossSiteBrowserRequest(req?.headers);
}

// Method + path of every route that installs code, changes operator settings
// or credentials, imports a backup (which can plant repos/sources) or hands
// back the stored credentials (settings, and the backup export that carries
// them). Paths are compared lower-cased — see isPrivilegedRoute.
const PRIVILEGED_ROUTES = [
  { method: 'POST', path: '/api/repos' },
  { method: 'DELETE', path: '/api/repos' },
  { method: 'POST', path: '/api/sources/install' },
  { method: 'POST', path: '/api/sources/uninstall' },
  // Import of a source file the person supplies: the preview stages code, the install runs and keeps it.
  { method: 'POST', path: '/api/sources/import/preview' },
  { method: 'POST', path: '/api/sources/import/install' },
  { method: 'POST', path: '/api/sources/import/test' },
  { method: 'POST', path: '/api/sources/import/link' },
  { method: 'POST', path: '/api/sources/import/generated' },
  // The catalog of a repository's sites: it hands a site to the code that installs sources, and asks GitHub and the DNS on the way.
  { method: 'POST', path: '/api/sources/catalog/list' },
  // The repositories the person added to the catalog: an address that decides what the server fetches.
  { method: 'GET', path: '/api/sources/catalog/repos' },
  { method: 'POST', path: '/api/sources/catalog/repos' },
  { method: 'DELETE', path: '/api/sources/catalog/repos' },
  // Installs an extension in the person's own Suwayomi-Server and writes the source that reads it.
  { method: 'POST', path: '/api/sources/engine/prepare' },
  { method: 'POST', path: '/api/sources/engine/updates' },
  { method: 'POST', path: '/api/sources/engine/update' },
  // Saves the Suwayomi address and login that the setup script of this computer made.
  { method: 'POST', path: '/api/suwayomi/connect-local' },
  // The Suwayomi-Server this app sets up and runs on this computer: they download, start, stop and remove a program.
  { method: 'GET', path: '/api/suwayomi/local/status' },
  { method: 'POST', path: '/api/suwayomi/local/install' },
  { method: 'POST', path: '/api/suwayomi/local/start' },
  { method: 'POST', path: '/api/suwayomi/local/stop' },
  { method: 'POST', path: '/api/suwayomi/local/uninstall' },
  { method: 'POST', path: '/api/suwayomi/local/firewall' },
  { method: 'POST', path: '/api/suwayomi/local/autostart' },
  { method: 'POST', path: '/api/anime/sources/import/preview' },
  { method: 'POST', path: '/api/anime/sources/import/install' },
  { method: 'POST', path: '/api/anime/sources/import/test' },
  { method: 'POST', path: '/api/anime/sources/uninstall' },
  { method: 'POST', path: '/api/backup/import' },
  { method: 'GET', path: '/api/backup/export' },
  { method: 'GET', path: '/api/settings' },
  { method: 'POST', path: '/api/settings' },
  // Only the list of sources the user switched off (no credentials in it): it is read and written by the same screen.
  { method: 'GET', path: '/api/settings/disabled-sources' },
  { method: 'POST', path: '/api/auth/set-password' },
  { method: 'POST', path: '/api/system/dependency-update' },
  // Diagnostics: the log keeps request URLs (query strings included) and its
  // only reader is the System Health page, which never asks for it over the LAN.
  { method: 'GET', path: '/api/error-log' },
  { method: 'DELETE', path: '/api/error-log' },
];

// Routes that exist in only one edition register themselves here instead of
// being named in the list above, which is shared by every branch.
function addPrivilegedRoutes(routes) {
  for (const route of routes) {
    const entry = { method: String(route.method).toUpperCase(), path: String(route.path).toLowerCase() };
    if (!PRIVILEGED_ROUTES.some((r) => r.method === entry.method && r.path === entry.path)) {
      PRIVILEGED_ROUTES.push(entry);
    }
  }
}

// No legitimate route path comes anywhere near this; the long part of a
// request is its query string. Longer is treated as privileged (see below).
const MAX_PATH_LENGTH = 2048;

// Characters that make Express read the target a second way. parseurl takes a
// fast path for plain "/a/b?c" targets and falls back to the legacy
// url.parse() as soon as the target holds a '#', a tab/newline/space or a few
// other characters — and url.parse() turns every backslash into a slash. So
// "/api\settings#x" is routed to the settings handler although the text before
// the '#' does not equal "/api/settings". None of these appears in the path of
// a real request, so a path holding one counts as privileged instead of the
// guard trying to replay that second parser. Listed by code point on purpose:
// backslash, tab, LF, FF, CR, space, no-break space, byte-order mark.
const AMBIGUOUS_CHAR_CODES = new Set([0x5c, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0xa0, 0xfeff]);

function hasAmbiguousChar(text) {
  for (let i = 0; i < text.length; i++) {
    if (AMBIGUOUS_CHAR_CODES.has(text.charCodeAt(i))) return true;
  }
  return false;
}

// The guard has to agree with Express about WHICH handler a request reaches,
// and Express is more forgiving than a string comparison: its router ignores
// case ("/API/Settings" reaches the settings handler), answers HEAD from the
// GET handler, and accepts an absolute-form target ("GET http://host/api/x")
// by routing on the path inside it. Each of those walked straight past an
// exact-match test, so the comparison is made on the lower-cased path, HEAD
// counts as GET, and a target that is not origin-form ("/path") is treated as
// privileged outright — nothing legitimate sends one to an origin server, and
// the parsers that read it disagree about what path it holds (an earlier
// "try every parser" version was bypassed with "http:///api\settings", and a
// version that only handled case and absolute-form with "/api\settings#x").
// A path longer than MAX_PATH_LENGTH is privileged too, which also keeps the
// work below bounded: stripping trailing slashes with a regex took quadratic
// time on a path of thousands of slashes and stalled the event loop.
function isPrivilegedRoute(req) {
  const target = String(req?.originalUrl || req?.url || '');
  if (!target.startsWith('/')) return true;

  let end = target.length;
  for (const mark of ['?', '#']) {
    const at = target.indexOf(mark);
    if (at !== -1 && at < end) end = at;
  }
  if (end > MAX_PATH_LENGTH) return true;

  const rawPath = target.slice(0, end);
  if (hasAmbiguousChar(rawPath)) return true;

  let fullPath = rawPath.toLowerCase();
  while (fullPath.length > 1 && fullPath.endsWith('/')) fullPath = fullPath.slice(0, -1);

  let method = String(req?.method || '').toUpperCase();
  if (method === 'HEAD') method = 'GET';
  return PRIVILEGED_ROUTES.some((r) => r.method === method && r.path === fullPath);
}

// SCROLLSCAPE_ADMIN_LOCAL_ONLY=1: the privileged routes are reachable only from
// this machine even when an Access Password is set. For when other devices
// (e.g. over Tailscale) may read the library but must not install sources or
// change settings. Start-ScrollScape-Safe.ps1 turns it on.
// Fails closed: a value nobody recognises as "off" (true, yes, on, y, ...) turns the protection ON; a
// restriction that silently did nothing because of how it was spelled would be the worse mistake.
function isAdminLocalOnly(env = process.env) {
  const value = String(env.SCROLLSCAPE_ADMIN_LOCAL_ONLY || '').trim().toLowerCase();
  return value !== '' && !['0', 'false', 'no', 'off', 'n'].includes(value);
}

// On a server (Docker, a NAS) every request arrives from the container network, never from this computer's loopback, and the password cannot be set from this page
// either (that route is refused the same way), so "set an Access Password in Settings" alone sent the person in a circle: the way out is said here.
const LOCAL_ONLY_MESSAGE = 'This action is only available from the computer running ScrollScape '
  + '(open it as http://localhost:PORT), or after you set an Access Password (in Settings on this computer; on a server such as Docker or a NAS, '
  + 'once from inside the container: see "Set an Access Password first" in the README).';

// For the routes that are never for another device, with or without a password (the updater, the Suwayomi of this computer): saying "set an
// Access Password" there would be a promise the route does not keep.
const NEVER_REMOTE_MESSAGE = 'This action is only available from the computer running ScrollScape '
  + '(open it as http://localhost:PORT). It is never available from another device, not even with an Access Password; '
  + 'on a server, run the command on the server itself.';

// Same refusal, for the case where a password IS set but the operator asked for
// the privileged routes to stay on this machine regardless.
const ADMIN_LOCAL_ONLY_MESSAGE = 'This action is only available from the computer running ScrollScape '
  + '(open it as http://localhost:PORT); it is disabled for remote devices even with the Access Password.';

/**
 * Express middleware for routes that must never be reachable by a remote
 * client: answers 403 unless the request is local (see isLocalRequest).
 * Used directly on routes that are never meant for remote use at all (the
 * updater); the auth gate uses isPrivilegedRoute/isLocalRequest for the
 * "no password set" case instead.
 */
function requireLocalRequest(req, res, next) {
  if (isLocalRequest(req)) return next();
  return res.status(403).json({ ok: false, code: 'LOCAL_ONLY', error: NEVER_REMOTE_MESSAGE });
}

// SCROLLSCAPE_ALLOW_REMOTE_IMPORT=1: the source import tool (and what hangs from it: the source catalog, the extension engine) also answers a request
// from another device, but only one that is logged in with the Access Password (see requireThisComputer). For a server that runs the app in a container:
// every request reaches it from the container network, so without this the tool could never be used from the browser of another computer.
// An opt-in, so only a value that plainly says "on" turns it on (a misspelling leaves the restriction in place), and SCROLLSCAPE_ADMIN_LOCAL_ONLY wins.
function isRemoteImportAllowed(env = process.env) {
  if (isAdminLocalOnly(env)) return false;
  return ['1', 'true', 'yes', 'on', 'y'].includes(String(env.SCROLLSCAPE_ALLOW_REMOTE_IMPORT || '').trim().toLowerCase());
}

// The same switch, as a saved setting (Settings > Security, "Allow installing sources from other devices"): for a person who runs the app in a container
// and cannot easily change its environment. server.js says how to read it; until it does, the setting counts as off. It is only a way to say yes: the
// environment's "admin local only" still wins over it, and it changes nothing without a login.
let storedRemoteImport = async () => false;
function configureRemoteImportSetting(readEnabled) {
  if (typeof readEnabled === 'function') storedRemoteImport = readEnabled;
}

// What a refusal says when the remote way exists but is not switched on.
const REMOTE_IMPORT_MESSAGE = 'This action is only available from the computer running ScrollScape (open it as http://localhost:PORT). '
  + 'To use it from another device, log in with the Access Password and turn on "Allow installing sources from other devices" in Settings > Security '
  + '(or start the app with SCROLLSCAPE_ALLOW_REMOTE_IMPORT=1).';

/**
 * For the routes of the source import tool, which install code: they answer a request from this computer, and, only when SCROLLSCAPE_ALLOW_REMOTE_IMPORT
 * is switched on, a request from another device that carries a valid login. "Valid login" is not taken from the route's own reading of anything:
 * the auth gate (middleware/auth-gate.js) marks `req.scrollscapeSession` after it checked the session cookie, and with no password set it refuses a
 * remote request to any PRIVILEGED_ROUTES entry before it gets here, so no password means no remote use whatever the switch says. A request a browser
 * marks as cross-site is refused even then (a page of another site must not be able to use a logged-in browser to install code), and
 * SCROLLSCAPE_ADMIN_LOCAL_ONLY switches the remote way off again. Its refusal says how to open it, or that it cannot be opened.
 */
async function requireThisComputer(req, res, next) {
  if (isLocalRequest(req)) return next();
  if (!isAdminLocalOnly() && req.scrollscapeSession === true && !isCrossSiteBrowserRequest(req.headers)) {
    let on = isRemoteImportAllowed();
    // A setting that cannot be read means "off".
    if (!on) { try { on = (await storedRemoteImport()) === true; } catch (_) { on = false; } }
    if (on) return next();
  }
  const message = isAdminLocalOnly() ? ADMIN_LOCAL_ONLY_MESSAGE : REMOTE_IMPORT_MESSAGE;
  return res.status(403).json({ ok: false, code: 'LOCAL_ONLY', error: message });
}

// ── Whole-app guard for a server that listens on this computer only ──────────
//
// The checks above protect the PRIVILEGED_ROUTES. Everything else (the library,
// history, /local-media, the static files) was left open on the reasoning that
// "it is a LAN reader". That stops being true when the server is bound to
// loopback (the exe, and main's default): the only legitimate client is a
// browser or tool on THIS computer, so a request that arrives with another
// site's name on it is never the owner. Two attacks reach a loopback socket
// without the owner doing anything but visiting a web page:
//   - DNS rebinding: the page's own name is re-resolved to 127.0.0.1, so the
//     browser treats it as same-origin (Sec-Fetch-Site: same-origin, Origin ==
//     Host) and the page can READ every /api route. Only the Host header gives
//     it away, and it is never "localhost".
//   - a plain cross-site request (form post, fetch, image) to
//     http://localhost:PORT, which cannot be read back but can still write: the
//     multipart import routes need no CORS preflight.
// Behind an Access Password both are already handled (the session cookie is
// host-bound and SameSite), and a reverse proxy such as `tailscale serve` is
// then a supported setup, so the guard steps aside. Without a password a
// relayed request is refused on purpose: nothing can tell a relay from a
// rebinding page except the Host it forwards, and an unprotected library behind
// a proxy is exactly what the password is for.

const HOST_NOT_LOCAL_MESSAGE = 'ScrollScape is listening on this computer only, so it answers to '
  + 'http://localhost:PORT (or 127.0.0.1) and nothing else. To open it under another name or through a '
  + 'proxy such as tailscale serve, set an Access Password in Settings first.';

const CROSS_SITE_MESSAGE = 'Refused: this request was made by another website, not by ScrollScape. '
  + 'Open ScrollScape directly as http://localhost:PORT.';

// A person clicking a link to http://localhost:PORT on some other page is a
// cross-site request too (Sec-Fetch-Site: cross-site), but it is a top-level
// page load: the other site cannot read the answer and cannot change anything
// with a GET the way it can with a post. Refusing it would only make a bookmark
// in a web app or a link in a README answer 403, so it is the one cross-site
// shape let through. Subresources (image, script, fetch), iframes, form posts
// and CORS preflights all keep Sec-Fetch-Mode/Dest values that are not these.
function isTopLevelPageLoad(req) {
  const method = String(req?.method || '').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  const headers = req?.headers || {};
  return String(headers['sec-fetch-mode'] || '').toLowerCase() === 'navigate'
    && String(headers['sec-fetch-dest'] || '').toLowerCase() === 'document';
}

/**
 * @param {{ loopbackOnly: boolean, isPasswordSet?: () => boolean | Promise<boolean> }} options
 *   loopbackOnly: the server is bound to a loopback address (decided once at
 *   start-up, from the same value passed to listen()).
 *   isPasswordSet: asked per request, and only for a request that would be
 *   refused, because the password can be set or removed while the server runs.
 *   If it throws, the password is treated as NOT set: the guard keeps refusing
 *   rather than trusting a store it cannot read.
 */
function createLocalHostGuard({ loopbackOnly, isPasswordSet } = {}) {
  return async function localHostGuard(req, res, next) {
    if (!loopbackOnly) return next();

    let refusal = null;
    if (!isLocalHostHeader(req.headers?.host)) {
      refusal = { code: 'HOST_NOT_LOCAL', error: HOST_NOT_LOCAL_MESSAGE };
    } else if (isCrossSiteBrowserRequest(req.headers) && !isTopLevelPageLoad(req)) {
      refusal = { code: 'CROSS_SITE_BLOCKED', error: CROSS_SITE_MESSAGE };
    }
    if (!refusal) return next(); // the common case never touches the store

    let passwordSet;
    try {
      passwordSet = !!(await isPasswordSet?.());
    } catch {
      passwordSet = false;
    }
    if (passwordSet) return next();

    return res.status(403).json({ ok: false, ...refusal });
  };
}

module.exports = {
  isLoopbackAddress,
  isLocalHostHeader,
  isLocalRequest,
  isProxiedRequest,
  isCrossSiteBrowserRequest,
  isTopLevelPageLoad,
  isPrivilegedRoute,
  addPrivilegedRoutes,
  isAdminLocalOnly,
  isRemoteImportAllowed,
  configureRemoteImportSetting,
  requireLocalRequest,
  requireThisComputer,
  createLocalHostGuard,
  PRIVILEGED_ROUTES,
  LOCAL_ONLY_MESSAGE,
  NEVER_REMOTE_MESSAGE,
  ADMIN_LOCAL_ONLY_MESSAGE,
  REMOTE_IMPORT_MESSAGE,
  HOST_NOT_LOCAL_MESSAGE,
  CROSS_SITE_MESSAGE,
};
