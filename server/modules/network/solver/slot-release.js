'use strict';

const { interpret, refusesBlankPage } = require('./classify');

// What happens to a slot once its job has been answered: parked on a blank page
// and handed back to the pool, recycled, or closed. Always ends with the slot
// idle, closing or dropped, so nothing can be left holding it. Which job it goes
// to next is scheduler.js.
//
// Interface: releaseSlot(slot, action, reason). action:
//   'keep'       park it on a blank page (or close it, if it was told to go)
//   'probe'      a navigation timed out: keep it if it still answers a blank page
//   'recycle'    throw it away
//   'suspect' / 'invalidate'
//                the solver did not answer: nothing can be sent; the session is
//                checked before its next use

// The slot is free again: unless it was told to go, it waits for the next job.
function finishIdle(ctx, slot) {
  const { state, slots, ports } = ctx;
  if (slot.dead) return;
  if (slot.closeAfter) {
    slots.closeSlot(slot, slot.closeAfter).catch(() => {});
    return;
  }
  if (slots.liveSlots().length > state.maxSessions) {
    slots.closeSlot(slot, 'resized').catch(() => {});
    return;
  }
  slot.status = 'idle';
  slot.lastUsedAt = ports.now();
  ctx.wake();
}

// After every job that keeps its session: the page that was solved would keep
// running its scripts, and the next job should not start from it. The answer
// is never used for cookies or anything else. A failure recycles the session; but only a
// failure that blames the blank page itself (refusesBlankPage) counts towards "this FlareSolverr
// cannot do it": blankFailuresBeforeUnsupported of those in a row, and then every job recycles
// after use instead. A dead driver or a failed launch is an ordinary recycle, whatever the page.
// A blank page does not close popups or service workers, nor empty the cookie jar: how much that
// matters over many jobs is unverified until a real FlareSolverr shows Chrome's process count and
// memory over many jobs on an ad-heavy page.
async function resetSlot(ctx, slot, { probe = false } = {}) {
  const { state, cfg, ports } = ctx;
  slot.status = 'resetting';
  state.counters.resets += 1;
  let failure = null;
  for (const url of cfg.blankUrls) {
    const res = await ctx.transport.requestInSession(slot, url, cfg.blankResetMaxTimeoutMs, cfg.blankResetMaxTimeoutMs + cfg.blankResetAbortGraceMs);
    if (slot.dead) return;
    if (res.refused) {
      failure = { refused: true };
      break;
    }
    if (res.transport) {
      // The solver is not answering: nothing more can be done for this session now.
      // It is verified before its next use.
      ctx.onTransportFailure(res.transport, slot);
      finishIdle(ctx, slot);
      return;
    }
    const seen = interpret(res);
    if (seen.kind === 'ok') {
      failure = null;
      break;
    }
    // Every blank page that failed has to blame the page, or the failure is the browser's.
    failure = { refused: false, blamesPage: (failure ? failure.blamesPage : true) && refusesBlankPage(seen) };
  }
  if (failure) {
    if (!probe && failure.blamesPage) {
      state.blankFailures += 1;
      if (state.blankFailures >= cfg.blankFailuresBeforeUnsupported && !state.blankUnsupported) {
        state.blankUnsupported = true;
        ports.warn('This FlareSolverr cannot park a session on a blank page; each session is recycled after use instead.');
      }
    }
    await ctx.slots.closeSlot(slot, 'reset-failed');
    return;
  }
  state.blankFailures = 0;
  slot.lastOkAt = ports.now();
  finishIdle(ctx, slot);
}

// The reason a session that is kept is closed anyway, or null.
function closingReason(ctx, slot) {
  if (slot.closeAfter) return slot.closeAfter;
  if (ctx.state.blankUnsupported) return 'blank-unsupported';
  return ctx.slots.liveSlots().length > ctx.state.maxSessions ? 'resized' : null;
}

// What happens to the slot once its job has been answered. Always ends with the
// slot idle, closing or dropped, so nothing can be left holding it.
async function releaseSlot(ctx, slot, action, reason) {
  const { cfg, ports, slots } = ctx;
  try {
    if (slot.dead) return;
    if (!slot.confirmed) {
      // Nothing is known to exist, so nothing is destroyed (the gap noted in sessions.js).
      slots.dropSlot(slot);
      return;
    }
    switch (action) {
      case 'recycle':
        await slots.closeSlot(slot, reason || 'recycle');
        break;
      case 'probe':
        // The browser may still be busy with the navigation that timed out. Give it a
        // moment, then ask it for a blank page: if it answers, its cookie jar is worth keeping.
        // How often it does is unverified until a real FlareSolverr shows how often the blank page
        // answers after a navigation that timed out (the stuck worker may still hold chromedriver).
        await ports.sleep(cfg.blankResetSettleMs);
        if (slot.dead) return;
        await resetSlot(ctx, slot, { probe: true });
        break;
      case 'suspect':
      case 'invalidate':
        finishIdle(ctx, slot);
        break;
      default: { // 'keep'
        const closing = closingReason(ctx, slot);
        if (closing) await slots.closeSlot(slot, closing);
        else await resetSlot(ctx, slot);
      }
    }
  } catch (err) {
    ports.warnOnce('release-failed', `Releasing a session failed: ${err && err.message}`);
    slots.closeSlot(slot, 'error').catch(() => {});
  } finally {
    ctx.wake();
  }
}

/** { state, cfg, ports, transport, slots, onTransportFailure, wake } -> { releaseSlot }. */
function createSlotRelease({ state, cfg, ports, transport, slots, onTransportFailure, wake }) {
  const ctx = { state, cfg, ports, transport, slots, onTransportFailure, wake };
  return { releaseSlot: (slot, action, reason) => releaseSlot(ctx, slot, action, reason) };
}

module.exports = { createSlotRelease };
