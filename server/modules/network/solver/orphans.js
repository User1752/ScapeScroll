'use strict';

const { isLoopbackUrl } = require('../../common/host-utils');
const { interpret } = require('./classify');
const { parseSessionId } = require('./session-id');

// Sessions left behind by a ScrollScape that was stopped hard (nothing can
// clean up on exit): ours by their id, and whose process no longer exists.
// Other clients' sessions and those of a live process are left alone, and so are this
// process's own: the id carries the start tag of the pool that made it, because pids are
// reused, and a session with our pid and another tag is an earlier run's. Every
// failure is swallowed: this is housekeeping, and a refused connection only
// means FlareSolverr is not up yet. It never recovers the solver, never starts
// anything and never counts toward the circuit.
//
// Interface: sweepOrphans(solverUrl) -> Promise of how many sessions it closed.
// Skipped (0) while the pool is off, closing or restarting, and for a solver that
// is not on this computer: the rollback path sends no `sessions.*` command at all.

// Whether the session belongs to a process that is still running. For our own pid that is a
// question of the tag, not of liveness: this process is always alive, but the run that made the
// session may have had the same pid.
function isLive(ctx, parts) {
  if (parts.pid === ctx.pid) return parts.tag === ctx.startTag;
  return ctx.isPidAlive(parts.pid);
}

async function sweepOrphans(ctx, solverUrl) {
  const { state, cfg, ports } = ctx;
  if (!state.enabled || state.shuttingDown || state.restarting || !isLoopbackUrl(solverUrl)) return 0;
  let swept = 0;
  try {
    const listed = await ctx.transport.listSessions(solverUrl);
    if (listed.transport) return 0;
    const seen = interpret(listed);
    if (seen.kind !== 'ok' || !Array.isArray(seen.body.sessions)) return 0;
    for (const id of seen.body.sessions) {
      const parts = parseSessionId(id, cfg.orphanIdPrefix);
      if (!parts || isLive(ctx, parts)) continue;
      const res = await ctx.transport.destroySession(solverUrl, id);
      if (!res.transport && interpret(res).kind === 'ok') swept += 1;
    }
  } catch (err) {
    ports.warnOnce('sweep', `The orphan sweep failed: ${err && err.message}`);
  }
  if (swept) {
    state.counters.orphansSwept += swept;
    ports.log(`Closed ${swept} browser session${swept === 1 ? '' : 's'} left by an earlier run.`);
  }
  return swept;
}

/** { state, cfg, ports, transport, pid, startTag, isPidAlive } -> { sweepOrphans }. startTag is the one in the ids this pool builds. */
function createOrphanSweeper({ state, cfg, ports, transport, pid, startTag, isPidAlive }) {
  const ctx = { state, cfg, ports, transport, pid, startTag, isPidAlive };
  return { sweepOrphans: (solverUrl) => sweepOrphans(ctx, solverUrl) };
}

module.exports = { createOrphanSweeper };
