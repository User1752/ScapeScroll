'use strict';

// What the pool knows about the cookie a site's navigations leave behind, so that a waiting
// job is asked for a plain request (its preflight) when that can say something new, and not
// before. A Cloudflare cookie only exists once a navigation to the site has been answered;
// asking a waiting job earlier is a try that cannot succeed, and the job has had its turn.
//
// The pool never sees the cookie: the call layer saves it (solver-call.js). What the pool can
// see is that a navigation to the site was answered, which is the moment the saved cookie may
// have changed. That moment is a "generation" of the site, counted here:
//   - a job remembers the generation it last tried (or was queued in) and is asked again only
//     when the site is at another one: once per change of the cookie, never more;
//   - when a try really went to the site and the site said no, every other waiting job of that
//     site is spared the same doomed try until the cookie changes again: the answer would be the
//     same, and tries are one at a time pool-wide, so each one delays every job behind it.
//
// Interface (hostKey is hostKeyOf(url)):
//   generation(hostKey)            the site's current generation (0 for a site never answered)
//   noteChange(hostKey)            a navigation to the site was answered
//   noteMiss(hostKey, generation)  a try made at that generation got a "no" from the site
//   isWorthAsking(hostKey)         false once a try at the current generation got a "no"
//   prune(t)                       forgets sites nobody asked about for a while
// State: one entry per site, { generation, missedGeneration, touchedAt }, private to this module.

const NEVER = -1;

function entryOf(ctx, hostKey) {
  let entry = ctx.sites.get(hostKey);
  if (!entry) {
    entry = { generation: 0, missedGeneration: NEVER, touchedAt: 0 };
    ctx.sites.set(hostKey, entry);
  }
  entry.touchedAt = ctx.ports.now();
  return entry;
}

function prune(ctx, t) {
  for (const [hostKey, entry] of ctx.sites) {
    if (t - entry.touchedAt >= ctx.cfg.gatePruneAfterMs) ctx.sites.delete(hostKey);
  }
}

/** { cfg, ports } -> the interface in the header. */
function createCookieWatch({ cfg, ports }) {
  const ctx = { cfg, ports, sites: new Map() };
  return {
    generation: (hostKey) => entryOf(ctx, hostKey).generation,
    noteChange: (hostKey) => { entryOf(ctx, hostKey).generation += 1; },
    noteMiss: (hostKey, generation) => { entryOf(ctx, hostKey).missedGeneration = generation; },
    isWorthAsking: (hostKey) => {
      const entry = entryOf(ctx, hostKey);
      return entry.missedGeneration !== entry.generation;
    },
    prune: (t) => prune(ctx, t),
  };
}

module.exports = { createCookieWatch };
