'use strict';

const {
  isPrivilegedRoute,
  isLocalRequest,
  isAdminLocalOnly,
  LOCAL_ONLY_MESSAGE,
  ADMIN_LOCAL_ONLY_MESSAGE,
} = require('./local-only');

const SESSION_COOKIE = 'scrollscape_session';

// Matched against the full path as written (case-sensitive, no normalisation),
// so a differently spelled variant is simply not exempt and goes through the
// gate. Must never overlap a privileged route: this check runs BEFORE both the
// admin-local and the session check, so an exempt privileged route would be open
// to everyone, password or not. Exported so a test can pin that.
const EXEMPT_PATHS = new Set(['/api/auth/login', '/api/auth/status', '/api/auth/logout']);

function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) {
      try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
    }
  }
  return out;
}

/**
 * Gates /api/* behind the optional single-password login (see
 * modules/auth/service.js). Deliberately does NOT gate /opds/* — external
 * OPDS readers have no way to run a browser-style cookie login flow, so
 * that route relies on its own rate limit (server.js) instead. Static
 * assets are never gated either: the SPA shell/JS must load unauthenticated
 * so it can render the login screen in the first place.
 *
 * @param {ReturnType<typeof import('../modules/auth/service').createAuthService>} authService
 */
function createAuthGate(authService) {
  return async function authGate(req, res, next) {
    // req.path is relative to wherever this middleware is mounted (Express
    // strips the mount prefix) — e.g. mounted at app.use('/api', ...), a
    // request to /api/auth/login shows up here as req.path === '/auth/login',
    // never matching a full '/api/auth/login' string. req.originalUrl is
    // always the full, unstripped path regardless of mount point.
    const fullPath = (req.originalUrl || req.url || '').split('?')[0];
    if (EXEMPT_PATHS.has(fullPath)) return next();

    // Admin-local mode: install/settings routes are for this machine only, with
    // or without a password (see isAdminLocalOnly in local-only.js). This runs
    // before the session check on purpose: a valid session must NOT get a remote
    // client past it, that is the whole point of the flag. Its own message,
    // because the ordinary one ("...or after you set an Access Password") would
    // send the operator to a remedy that cannot lift this refusal.
    if (isAdminLocalOnly() && isPrivilegedRoute(req) && !isLocalRequest(req)) {
      return res.status(403).json({ ok: false, code: 'LOCAL_ONLY', error: ADMIN_LOCAL_ONLY_MESSAGE });
    }

    let enabled = false;
    try {
      enabled = await authService.isGateEnabled();
    } catch {
      // If the store can't be read yet, fail open rather than locking the
      // app out of its own bootstrap — the rest of the app will surface
      // that error on its own. (Routes that install code or change operator
      // settings still get the local-only check below.) `enabled` is already
      // false from its declaration.
    }
    if (!enabled) {
      // No password set: ordinary routes stay open (the app is a LAN reader
      // by default), but the few that can run code or rewrite operator
      // settings are only honoured for requests from this machine — see
      // local-only.js for why.
      if (isPrivilegedRoute(req) && !isLocalRequest(req)) {
        return res.status(403).json({ ok: false, code: 'LOCAL_ONLY', error: LOCAL_ONLY_MESSAGE });
      }
      return next();
    }

    const token = parseCookies(req)[SESSION_COOKIE];
    if (authService.isValidSession(token)) {
      // Said here, once the session was checked, for the routes that need to know a login was really presented (requireThisComputer).
      req.scrollscapeSession = true;
      return next();
    }

    res.status(401).json({ error: 'Authentication required', code: 'AUTH_REQUIRED' });
  };
}

module.exports = { createAuthGate, parseCookies, SESSION_COOKIE, EXEMPT_PATHS };
