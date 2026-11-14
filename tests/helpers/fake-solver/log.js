'use strict';

// The fake's log: one entry per /v1 call, in arrival order (the fields are listed in
// the header of fake-flaresolverr.js), and fake.waitFor() resolving when an entry
// the caller is waiting for exists.

function checkLogWaiters(state) {
  for (const waiter of [...state.logWaiters]) {
    let hit;
    try {
      hit = state.fake.log.find(waiter.predicate);
    } catch (_) {
      hit = undefined;
    }
    if (hit) {
      state.logWaiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.resolve(hit);
    }
  }
}

function openEntry(state, body, res, callEpoch) {
  state.seq += 1;
  const entry = {
    seq: state.seq,
    t: Date.now(),
    endedAt: null,
    cmd: typeof body.cmd === 'string' ? body.cmd : null,
    session: typeof body.session === 'string' && body.session ? body.session : null,
    url: typeof body.url === 'string' && body.url ? body.url : null,
    maxTimeout: body.maxTimeout ?? null,
    proxy: body.proxy ?? null,
    usedProxy: null,
    hadCookies: Array.isArray(body.cookies) && body.cookies.length > 0,
    ttl: body.session_ttl_minutes ?? null,
    stateless: false,
    launched: false,
    lazy: false,
    ttlRecreated: false,
    existed: false,
    collided: false,
    aborted: false,
    outcome: null,
    httpStatus: null,
    error: null,
  };
  state.fake.log.push(entry);
  res.on('close', () => {
    if (res.writableFinished || callEpoch !== state.epoch || state.ownDrops.has(res)) return;
    entry.aborted = true;
    checkLogWaiters(state);
  });
  checkLogWaiters(state);
  return entry;
}

function closeEntry(state, entry, outcome, httpStatus = null, error = null) {
  if (entry.endedAt !== null) return;
  entry.endedAt = Date.now();
  entry.outcome = outcome;
  entry.httpStatus = httpStatus;
  entry.error = error;
  checkLogWaiters(state);
}

function waitFor(state, predicate, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, timer: null };
    waiter.timer = setTimeout(() => {
      state.logWaiters.delete(waiter);
      reject(new Error(`the fake FlareSolverr saw no call matching ${predicate} within ${timeoutMs} ms`));
    }, timeoutMs);
    waiter.timer.unref();
    state.logWaiters.add(waiter);
    checkLogWaiters(state);
  });
}

module.exports = { openEntry, closeEntry, waitFor };
