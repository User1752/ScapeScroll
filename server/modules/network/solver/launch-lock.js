'use strict';

// One browser launch at a time: a session being created and a stateless request
// (which launches its own browser) never overlap. A stateless request while a session sat open
// worked fine on a real FlareSolverr 3.5.2, but two launches at the very same moment were never
// tried, so whether they really collide on chromedriver (a file lock), and whether
// sessions.create blocks FlareSolverr's other requests, is still unverified.
//
// Interface:
//   acquire()      Promise of a release function, once the lock is free
//   tryAcquire()   a release function, or null when the lock is taken
// A release function is idempotent. When the lock is handed on to a waiter
// nothing else happens; when it becomes free, onFree() is called (the scheduler
// looks at the queue again, since a stateless job may have been waiting for it).

function makeRelease(ctx) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = ctx.waiters.shift();
    if (next) {
      next(makeRelease(ctx));
      return;
    }
    ctx.busy = false;
    ctx.onFree();
  };
}

function tryAcquire(ctx) {
  if (ctx.busy) return null;
  ctx.busy = true;
  return makeRelease(ctx);
}

function acquire(ctx) {
  return new Promise((resolve) => {
    if (ctx.busy) {
      ctx.waiters.push(resolve);
      return;
    }
    ctx.busy = true;
    resolve(makeRelease(ctx));
  });
}

function createLaunchLock({ onFree }) {
  const ctx = { onFree, busy: false, waiters: [] };
  return {
    acquire: () => acquire(ctx),
    tryAcquire: () => tryAcquire(ctx),
  };
}

module.exports = { createLaunchLock };
