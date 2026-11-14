'use strict';

const { interpret } = require('./classify');
const { buildSessionId } = require('./session-id');

// Making sure a slot holds a browser session this process has SEEN on the
// current FlareSolverr: when the one it has can no longer serve the next job
// (recycleReason / recycleSlot), checking that it still exists (confirmSession)
// and creating a new one under a fresh id with the proxy (createSession). What
// happens to the slot after a job is slot-release.js; which job gets it is
// scheduler.js.
//
// createSession and confirmSession resolve one of
//   { ok: true }           the slot holds a confirmed session
//   { fallback: true }     no session could be opened: this job runs in a one-off browser
//   { transport: err }     the request itself failed (the raw error)
//   { restart: true }      a restart took the slot meanwhile: the job goes back to the queue
//
// Interface: recycleReason(slot, solverUrl, proxyInfo), recycleSlot(slot, reason),
// confirmSession(slot, job, proxyInfo). Private state: the next session number.

// Why the slot's session cannot serve the next job as it is (it timed out, its solver or proxy
// changed, it is too old or used too often), or null. Only evaluated between jobs.
function recycleReason(ctx, slot, solverUrl, proxyInfo) {
  const { cfg, ports } = ctx;
  if (!slot.confirmed) return null;
  if (slot.suspect) return 'suspect';
  if (slot.solverUrl !== solverUrl) return 'solver-url';
  if (slot.fingerprint !== proxyInfo.fingerprint) return 'proxy-changed';
  if (ports.now() - slot.createdAt > cfg.maxSessionAgeMs) return 'age';
  if (slot.uses >= cfg.maxSessionUses) return 'uses';
  return null;
}

// Destroys the slot's session (on the solver it was created on, which may not be
// the current one) and forgets it, so the next step creates a new one under a
// new id. The slot stays with the job that holds it.
async function recycleSlot(ctx, slot, reason) {
  ctx.state.counters.recycles += 1;
  ctx.ports.log(`Session #${slot.key} recycled (${reason}).`);
  const old = { id: slot.id, solverUrl: slot.solverUrl };
  slot.confirmed = false;
  await ctx.slots.destroyRemote(old);
}

// The session answered sessions.create under the new id: the slot now holds it.
function adoptSession(ctx, slot, job, proxyInfo) {
  const { state, ports } = ctx;
  slot.confirmed = true;
  slot.solverUrl = job.solverUrl;
  slot.fingerprint = proxyInfo.fingerprint;
  slot.proxyMode = proxyInfo.mode;
  slot.createdAt = ports.now();
  slot.lastOkAt = ports.now();
  slot.uses = 0;
  slot.otherFailures = 0;
  slot.suspect = false;
  if (slot.status === 'opening') slot.status = 'busy';
  ctx.circuit.noteSuccess();
  ports.log(`Session #${slot.key} opened (${ctx.slots.liveSlots().length} of ${state.maxSessions}).`);
}

// Creates the session under a fresh id, with the proxy (the only request that
// carries one). Resolves like the header says.
async function createSession(ctx, slot, job, proxyInfo) {
  const { state, cfg, ports } = ctx;
  for (let attempt = 1; ; attempt += 1) {
    const release = await ctx.launchLock.acquire();
    if (slot.dead || state.shuttingDown) {
      release();
      return { restart: true };
    }
    const id = buildSessionId(ctx.pid, ctx.startTag, ctx.nextSessionNumber, cfg.orphanIdPrefix);
    ctx.nextSessionNumber += 1;
    slot.id = id;
    slot.confirmed = false;
    let res;
    try {
      res = await ctx.transport.createSession(job.solverUrl, id, proxyInfo.proxy);
    } finally {
      release();
    }
    // Known gap, accepted: when OUR abort (sessionCreateTimeoutMs) fires while FlareSolverr
    // is still launching the browser, the create can still complete over there. The slot
    // was never confirmed, so releaseSlot() drops it without a destroy and the pool never
    // learns that browser exists; it keeps running under an id nothing will use again. The
    // orphan sweep leaves it alone as well (it runs once at boot, and this process is
    // alive). It is cleaned up only because the caller recovers the solver from the
    // TimeoutError it receives for this job (fetch-utils does, which restarts FlareSolverr).
    if (res.transport) return { transport: res.transport };
    if (slot.dead) return { restart: true };

    const seen = interpret(res);
    const alreadyThere = seen.kind === 'ok' && /already exists/i.test(String(seen.body.message || ''));
    if (seen.kind === 'ok' && !alreadyThere) {
      adoptSession(ctx, slot, job, proxyInfo);
      return { ok: true };
    }
    // A nonce id cannot already exist; if it does, whatever is there did not get
    // our proxy. Remove it and run this job without a session.
    if (alreadyThere) await ctx.slots.destroyRemote({ id, solverUrl: job.solverUrl });
    const kind = alreadyThere ? 'other' : seen.kind;
    if (kind === 'unsupported') {
      state.sessionsUnsupported = true;
      ports.warnOnce('unsupported', 'This FlareSolverr does not support browser sessions; using one-off browsers.');
      ctx.circuit.noteFailure('unsupported');
      return { fallback: true };
    }
    if (kind === 'launch' && attempt === 1) {
      // Another idle browser can be what holds chromedriver: close it, give the
      // file a moment, and launch once more.
      await ctx.slots.closeOtherIdleSlots(slot);
      await ports.sleep(cfg.launchRetryDelayMs);
      if (slot.dead || state.shuttingDown) return { restart: true };
      continue;
    }
    ctx.circuit.noteFailure(kind === 'launch' ? 'launch' : 'create');
    return { fallback: true };
  }
}

// Makes sure the slot holds a session this process has SEEN on the current
// FlareSolverr. Resolves like createSession.
async function confirmSession(ctx, slot, job, proxyInfo) {
  const { cfg, ports } = ctx;
  if (slot.confirmed) {
    // Skipping the list right after an answer saves a call that is cheap anyway (3 to 4 ms next
    // to a busy driver on a real FlareSolverr 3.5.2), so the window is short. Never
    // with a proxy: if FlareSolverr was restarted without the lifecycle announcing it,
    // the request for the unknown id would create an UNPROXIED session, which the pool
    // would then take for the proxied one and send the user's traffic out on their own address.
    if (!proxyInfo.proxy && ports.now() - slot.lastOkAt < cfg.verifySkipWithinMs) return { ok: true };
    const res = await ctx.transport.listSessions(slot.solverUrl);
    if (res.transport) return { transport: res.transport };
    if (slot.dead) return { restart: true };
    const seen = interpret(res);
    if (seen.kind === 'ok' && Array.isArray(seen.body.sessions) && seen.body.sessions.includes(slot.id)) {
      slot.lastOkAt = ports.now();
      return { ok: true };
    }
    // FlareSolverr no longer has it (restarted, destroyed from outside) or cannot
    // tell: start over under a new id. If it is still there after all, remove it.
    ports.log(`Session #${slot.key} is gone from FlareSolverr; opening a new one.`);
    const old = { id: slot.id, solverUrl: slot.solverUrl };
    slot.confirmed = false;
    if (seen.kind !== 'ok') await ctx.slots.destroyRemote(old);
    if (slot.dead) return { restart: true };
  }
  return createSession(ctx, slot, job, proxyInfo);
}

/**
 * { state, cfg, ports, pid, startTag, transport, slots, launchLock, circuit } ->
 * the interface in the header. `startTag` tells two pools in one process apart.
 */
function createSessions({ state, cfg, ports, pid, startTag, transport, slots, launchLock, circuit }) {
  const ctx = { state, cfg, ports, pid, startTag, transport, slots, launchLock, circuit, nextSessionNumber: 1 };
  return {
    recycleReason: (slot, solverUrl, proxyInfo) => recycleReason(ctx, slot, solverUrl, proxyInfo),
    recycleSlot: (slot, reason) => recycleSlot(ctx, slot, reason),
    confirmSession: (slot, job, proxyInfo) => confirmSession(ctx, slot, job, proxyInfo),
  };
}

module.exports = { createSessions };
