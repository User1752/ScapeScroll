'use strict';

const { WEDGE_PAUSE, MESSAGES } = require('../../../config/solver');

// err.code of the refusal a call to a paused site gets. Not a pool error and not one callers tell apart by name, so it lives here.
const SITE_PAUSED_CODE = 'SOLVER_SITE_PAUSED';

// Which site keeps leaving FlareSolverr without an answer. A request our own abort has to cut (FlareSolverr took the page and
// never replied) means FlareSolverr is wedged, and every wedge ends in a restart of the browser and of every other protected
// source with it. One such site, asked again and again, is the loop; so the second stall within `windowMs` puts THAT site in
// a pause of `pauseMs`, during which a call to it is refused at once, without touching FlareSolverr.
//
// It sits at the call layer (solver-call.js) rather than in the session pool on purpose: the pool can be switched off, and
// the loop is just as real then. A real answer from the site (a page) forgives it. A stall that follows within `collateralMs`
// on another site's is the same wedge seen from a second caller, not evidence against the second site, and is not counted.
//
// Holds site keys (hostKeyOf) and clock readings only, no URL, cookie or page. The clock is injected.
//
// Interface: pausedFor(hostKey) -> ms left (0: not paused), noteStall(hostKey) -> true when that opened a pause,
// noteAnswered(hostKey), error(), status() -> { paused }.

function createWedgeMemory({ now = Date.now, config = WEDGE_PAUSE, log = () => {} } = {}) {
  const sites = new Map(); // hostKey -> { stalls: [clock readings], pausedUntil }
  let last = null;

  function entry(hostKey) {
    if (!sites.has(hostKey)) sites.set(hostKey, { stalls: [], pausedUntil: 0 });
    return sites.get(hostKey);
  }

  function forgetOld(t) {
    for (const [hostKey, site] of sites) {
      if (t >= site.pausedUntil && site.stalls.every((at) => t - at >= config.windowMs)) sites.delete(hostKey);
    }
  }

  function pausedFor(hostKey) {
    const site = sites.get(hostKey);
    return site ? Math.max(0, site.pausedUntil - now()) : 0;
  }

  function noteStall(hostKey) {
    const t = now();
    forgetOld(t);
    const before = last;
    last = { hostKey, at: t };
    if (before && before.hostKey !== hostKey && t - before.at < config.collateralMs) return false;
    const site = entry(hostKey);
    site.stalls = site.stalls.filter((at) => t - at < config.windowMs);
    site.stalls.push(t);
    if (site.stalls.length < config.after || t < site.pausedUntil) return false;
    site.stalls = [];
    site.pausedUntil = t + config.pauseMs;
    log(`${hostKey} left the browser solver without an answer ${config.after} times; leaving it alone for ${Math.round(config.pauseMs / 60_000)} min.`);
    return true;
  }

  function noteAnswered(hostKey) {
    sites.delete(hostKey);
  }

  // The error a call to a paused site gets. rateLimited: fetchText does not retry it (the same flag as a site in cooldown).
  function error() {
    const err = new Error(MESSAGES.sitePaused);
    err.code = SITE_PAUSED_CODE;
    err.rateLimited = true;
    return err;
  }

  function status() {
    const t = now();
    return { paused: [...sites.values()].filter((site) => site.pausedUntil > t).length };
  }

  return { pausedFor, noteStall, noteAnswered, error, status };
}

module.exports = { createWedgeMemory, SITE_PAUSED_CODE };
