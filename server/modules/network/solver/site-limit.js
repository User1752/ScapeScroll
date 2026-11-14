'use strict';

// How many requests one site may have in flight at the same time, for the pool-off path (passthrough.js),
// which has no queue of its own: without it, twenty different pages of one protected site are twenty
// Chromes started at once. A plain counting limit per key, served first come first served. Pure promises:
// no clock, no timer, no I/O, and a site nobody holds or waits for leaves nothing behind.
//
// Interface: createSiteLimit(limit) -> { acquire(key, rank), waitingFor(key), counts() }
//   acquire(key, rank)  Promise of a release function, resolved once fewer than `limit` holders have the key.
//                  The release gives back one place and hands it to the first in line; calling it again does nothing.
//                  The line is ordered by `rank` (a lower number goes first, 0 by default), first come first served
//                  among equal ranks. The promise carries cancel(): it takes a waiter out of the line and returns
//                  true, or returns false when that waiter already has its place (or never had to wait).
//   waitingFor(key)  how many are in line for the key.
//   counts()       { sites, active, waiting } for the tests.
// A limit that is not a whole number of at least one is one: when in doubt, less at a time.

function createSiteLimit(limit) {
  const places = Number.isInteger(limit) && limit >= 1 ? limit : 1;
  const sites = new Map(); // key -> { active, waiters: [{ rank, grant }, ...] }

  function releaser(key, site) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = site.waiters.shift();
      if (next) {
        next.grant(releaser(key, site)); // the place passes straight on: `active` does not change
        return;
      }
      site.active -= 1;
      if (site.active === 0) sites.delete(key);
    };
  }

  function acquire(key, rank = 0) {
    let site = sites.get(key);
    if (!site) {
      site = { active: 0, waiters: [] };
      sites.set(key, site);
    }
    if (site.active < places) {
      site.active += 1;
      return Object.assign(Promise.resolve(releaser(key, site)), { cancel: () => false });
    }
    const waiter = { rank, grant: null };
    const promise = new Promise((resolve) => { waiter.grant = resolve; });
    const after = site.waiters.findIndex((other) => other.rank > rank);
    site.waiters.splice(after === -1 ? site.waiters.length : after, 0, waiter);
    return Object.assign(promise, {
      cancel() {
        const at = site.waiters.indexOf(waiter);
        if (at === -1) return false;
        site.waiters.splice(at, 1);
        return true;
      },
    });
  }

  function waitingFor(key) {
    const site = sites.get(key);
    return site ? site.waiters.length : 0;
  }

  function counts() {
    let active = 0;
    let waiting = 0;
    for (const site of sites.values()) {
      active += site.active;
      waiting += site.waiters.length;
    }
    return { sites: sites.size, active, waiting };
  }

  return { acquire, waitingFor, counts };
}

module.exports = { createSiteLimit };
