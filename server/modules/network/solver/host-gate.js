'use strict';

const { SOLVER_HOST_BLOCKED } = require('../../errors/error-codes');

// The per-site gate: spacing between navigations to one site, and the cooldown
// after Cloudflare blocks it. Both are about the site, not the session, so they
// apply to the stateless lane as well. Spacing has two halves: nextStartAt is
// what the scheduler reserves when it PICKS a job (so it does not pick a second
// one for the site at once), lastStartAt is when a navigation to the site REALLY
// started, which is what claimStart() holds the next one to.
//
// Interface (hostKey is hostKeyOf(url)):
//   reserve(hostKey, t)        the scheduler picked a job for the site
//   release(hostKey)           that job failed before it navigated: the site was not touched, so
//                              the reservation is given back (what a real start holds is kept)
//   nextStartAt(hostKey)       when the scheduler may pick the next one (0: now)
//   isBlocked(hostKey, t)      the site is in its cooldown
//   claimStart(hostKey, t)     0 when a navigation may start now (the site is then
//                              claimed), otherwise how many ms to wait
//   noteBlock(hostKey)         Cloudflare blocked the site; returns blocks in a row
//   noteSuccess(hostKey)       forgives the site
//   prune(t)                   forgets sites nobody asked for in a while
//   cooldowns(t)               [{ host, secondsLeft }] for the status
//
// State: one entry per site, { nextStartAt, lastStartAt, blockedUntil, blockCount,
// touchedAt }, private to this module.

function gateOf(ctx, hostKey, t = ctx.ports.now()) {
  let gate = ctx.gates.get(hostKey);
  if (!gate) {
    gate = { nextStartAt: 0, lastStartAt: 0, blockedUntil: 0, blockCount: 0, touchedAt: t };
    ctx.gates.set(hostKey, gate);
  }
  gate.touchedAt = t;
  return gate;
}

function pruneGates(ctx, t) {
  for (const [hostKey, gate] of ctx.gates) {
    if (t - gate.touchedAt >= ctx.cfg.gatePruneAfterMs && t >= gate.blockedUntil && t >= gate.nextStartAt) ctx.gates.delete(hostKey);
  }
}

// Returns how many blocks in a row this site has now answered with.
function noteBlock(ctx, hostKey) {
  const { cfg, ports, state } = ctx;
  const t = ports.now();
  const gate = gateOf(ctx, hostKey, t);
  // A second call that was already running when the cooldown opened: the same event.
  if (t < gate.blockedUntil) return gate.blockCount;
  gate.blockCount += 1;
  const waitMs = Math.min(cfg.blockCooldown.initialMs * 2 ** (gate.blockCount - 1), cfg.blockCooldown.maxMs);
  gate.blockedUntil = t + waitMs;
  state.counters.hostBlocks += 1;
  ports.log(`${hostKey} blocked the solver; leaving it alone for ${Math.round(waitMs / 1000)} s.`);
  ports.record(SOLVER_HOST_BLOCKED, 'Cloudflare blocked the browser solver for a site; it is left alone for a while.', { host: hostKey, kind: 'blocked' });
  return gate.blockCount;
}

function noteSuccess(ctx, hostKey) {
  const gate = ctx.gates.get(hostKey);
  if (!gate) return;
  gate.blockCount = 0;
  gate.blockedUntil = 0;
}

function claimStart(ctx, hostKey, startedAt) {
  const { cfg } = ctx;
  const gate = gateOf(ctx, hostKey, startedAt);
  const waitMs = gate.lastStartAt + cfg.hostSpacingMs - startedAt;
  // More than one spacing can only be a clock that went back: not worth waiting for.
  if (waitMs <= 0 || waitMs > cfg.hostSpacingMs) {
    gate.lastStartAt = startedAt;
    gate.nextStartAt = Math.max(gate.nextStartAt, startedAt + cfg.hostSpacingMs);
    return 0;
  }
  return waitMs;
}

// A job the scheduler picked never reached the site (FlareSolverr refused the connection before the
// navigation could start): the reservation goes back to what the last REAL start holds. Without this,
// every call to a site would wait a whole spacing behind the failure of the one before it.
function release(ctx, hostKey) {
  const gate = ctx.gates.get(hostKey);
  if (gate) gate.nextStartAt = gate.lastStartAt ? gate.lastStartAt + ctx.cfg.hostSpacingMs : 0;
}

function cooldowns(ctx, t) {
  return [...ctx.gates].filter(([, gate]) => gate.blockedUntil > t)
    .map(([host, gate]) => ({ host, secondsLeft: Math.ceil((gate.blockedUntil - t) / 1000) }));
}

function createHostGate({ cfg, state, ports }) {
  const ctx = { cfg, state, ports, gates: new Map() };
  return {
    reserve: (hostKey, t) => { gateOf(ctx, hostKey, t).nextStartAt = t + cfg.hostSpacingMs; },
    nextStartAt: (hostKey) => (ctx.gates.has(hostKey) ? ctx.gates.get(hostKey).nextStartAt : 0),
    release: (hostKey) => release(ctx, hostKey),
    isBlocked: (hostKey, t) => ctx.gates.has(hostKey) && t < ctx.gates.get(hostKey).blockedUntil,
    claimStart: (hostKey, t) => claimStart(ctx, hostKey, t),
    noteBlock: (hostKey) => noteBlock(ctx, hostKey),
    noteSuccess: (hostKey) => noteSuccess(ctx, hostKey),
    prune: (t) => pruneGates(ctx, t),
    cooldowns: (t) => cooldowns(ctx, t),
  };
}

module.exports = { createHostGate };
