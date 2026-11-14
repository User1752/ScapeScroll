'use strict';

// server/modules/network/solver/host-gate.js: spacing between navigations to one
// site, and the cooldown after Cloudflare blocks it. A hand-moved clock, no I/O.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { SOLVER_HOST_BLOCKED } = require('../../server/modules/errors/error-codes');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { createHostGate } = require('../../server/modules/network/solver/host-gate');

const SITE = 'cf-site.example';
const OTHER = 'other-site.example';

function makeGate(config = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, { hostSpacingMs: 100, ...config });
  const state = createPoolState(cfg);
  const logs = [];
  const recorded = [];
  const ports = createPorts({
    now: () => clock.t,
    log: (m) => logs.push(m),
    warn: () => {},
    recordError: async (entry) => { recorded.push(entry); },
  }, state);
  return { clock, cfg, state, logs, recorded, gate: createHostGate({ cfg, state, ports }) };
}

test('a navigation may start at once on a site nobody asked for, and then holds the next one a spacing back', () => {
  const { clock, gate } = makeGate();
  assert.equal(gate.nextStartAt(SITE), 0);
  assert.equal(gate.claimStart(SITE, clock.t), 0, 'the first claim goes ahead');
  assert.equal(gate.claimStart(SITE, clock.t), 100, 'a second one at the same moment waits a whole spacing');
  assert.equal(gate.claimStart(SITE, clock.t + 60), 40, 'and then only what is left of it');
  assert.equal(gate.claimStart(SITE, clock.t + 100), 0, 'once the spacing has passed it goes ahead');
  assert.equal(gate.claimStart(OTHER, clock.t), 0, 'another site is not held up');
});

test('a clock that went back is not waited for', () => {
  const { clock, gate } = makeGate();
  assert.equal(gate.claimStart(SITE, clock.t), 0);
  // More than one spacing "in the future" can only be a clock that moved backwards.
  assert.equal(gate.claimStart(SITE, clock.t - 5000), 0);
});

test('reserve is what the scheduler does when it picks a job; claimStart only ever pushes it later', () => {
  const { clock, gate } = makeGate();
  gate.reserve(SITE, clock.t + 1000);
  assert.equal(gate.nextStartAt(SITE), clock.t + 1100);
  gate.claimStart(SITE, clock.t + 50); // a start earlier than the reservation does not pull it back
  assert.equal(gate.nextStartAt(SITE), clock.t + 1100);
  gate.claimStart(SITE, clock.t + 2000); // a later one pushes it on
  assert.equal(gate.nextStartAt(SITE), clock.t + 2100);
});

test('a block opens a cooldown for that site only, doubling each time up to the cap', () => {
  const { clock, cfg, state, logs, recorded, gate } = makeGate({ blockCooldown: { initialMs: 1000, maxMs: 3000 } });
  assert.equal(gate.isBlocked(SITE, clock.t), false);

  assert.equal(gate.noteBlock(SITE), 1);
  assert.equal(gate.isBlocked(SITE, clock.t), true);
  assert.equal(gate.isBlocked(SITE, clock.t + 999), true);
  assert.equal(gate.isBlocked(SITE, clock.t + 1000), false);
  assert.equal(gate.isBlocked(OTHER, clock.t), false, 'only the blocked site');
  assert.equal(state.counters.hostBlocks, 1);

  clock.t += 1000;
  assert.equal(gate.noteBlock(SITE), 2);
  assert.equal(gate.isBlocked(SITE, clock.t + 1999), true);
  assert.equal(gate.isBlocked(SITE, clock.t + 2000), false, 'twice the first');

  clock.t += 2000;
  assert.equal(gate.noteBlock(SITE), 3);
  assert.equal(gate.isBlocked(SITE, clock.t + 2999), true);
  assert.equal(gate.isBlocked(SITE, clock.t + 3000), false, 'capped at maxMs, not 4000');
  assert.equal(cfg.blockCooldown.maxMs, 3000);

  assert.equal(recorded.length, 3, 'one error entry per cooldown opening');
  assert.deepEqual(recorded[0], {
    code: SOLVER_HOST_BLOCKED,
    area: 'solver-pool',
    message: 'Cloudflare blocked the browser solver for a site; it is left alone for a while.',
    details: { host: SITE, kind: 'blocked' },
  });
  assert.equal(logs.length, 3);
});

test('a second answer of a call that was already running when the cooldown opened is the same event', () => {
  const { clock, state, recorded, gate } = makeGate();
  assert.equal(gate.noteBlock(SITE), 1);
  assert.equal(gate.noteBlock(SITE), 1, 'still inside the cooldown it opened');
  assert.equal(state.counters.hostBlocks, 1);
  assert.equal(recorded.length, 1);
  assert.equal(gate.isBlocked(SITE, clock.t), true);
});

test('a success forgives the site', () => {
  const { clock, gate } = makeGate({ blockCooldown: { initialMs: 1000, maxMs: 8000 } });
  gate.noteBlock(SITE);
  gate.noteSuccess(SITE);
  assert.equal(gate.isBlocked(SITE, clock.t), false);
  assert.equal(gate.noteBlock(SITE), 1, 'the count starts over');
  gate.noteSuccess('never-seen.example'); // a site without a gate is nothing to forgive
});

test('cooldowns lists the sites still blocked, with whole seconds left rounded up', () => {
  const { clock, gate } = makeGate({ blockCooldown: { initialMs: 1500, maxMs: 8000 } });
  gate.noteBlock(SITE);
  gate.claimStart(OTHER, clock.t);
  assert.deepEqual(gate.cooldowns(clock.t), [{ host: SITE, secondsLeft: 2 }]);
  assert.deepEqual(gate.cooldowns(clock.t + 1500), []);
});

test('a site nobody asked for in ten minutes is forgotten, unless it is still blocked', () => {
  const { clock, cfg, gate } = makeGate({ blockCooldown: { initialMs: 20 * 60_000, maxMs: 20 * 60_000 } });
  gate.claimStart('idle.example', clock.t);
  gate.noteBlock(SITE);

  gate.prune(clock.t + cfg.gatePruneAfterMs - 1);
  assert.equal(gate.nextStartAt('idle.example'), clock.t + 100, 'not old enough yet');

  gate.prune(clock.t + cfg.gatePruneAfterMs);
  assert.equal(gate.nextStartAt('idle.example'), 0, 'forgotten');
  assert.equal(gate.isBlocked(SITE, clock.t + cfg.gatePruneAfterMs), true, 'a cooldown is not forgotten');
});

test('asking about a site keeps it from being forgotten', () => {
  const { clock, cfg, gate } = makeGate();
  gate.claimStart(SITE, clock.t);
  gate.claimStart(OTHER, clock.t); // asked about once, then left alone: the control
  const touchedAt = clock.t + cfg.gatePruneAfterMs - 50;
  gate.claimStart(SITE, touchedAt); // asked again, shortly before it would have been forgotten
  // The spacing that second start set is over by now, so nothing but the touch can keep the gate:
  // a spacing still running would hold it on its own and the test could not tell.
  const pruneAt = clock.t + cfg.gatePruneAfterMs + 50;
  assert.equal(gate.nextStartAt(SITE), touchedAt + 100);
  assert.ok(pruneAt >= gate.nextStartAt(SITE), 'the spacing no longer holds the gate');
  gate.prune(pruneAt);
  assert.equal(gate.nextStartAt(SITE), touchedAt + 100, 'kept: it was asked about less than a prune period ago');
  assert.equal(gate.nextStartAt(OTHER), 0, 'forgotten: nobody asked for it since');
});

test('release gives back what the scheduler reserved for a job that never reached the site, and keeps what a real start holds', () => {
  const { clock, gate } = makeGate();
  gate.reserve(SITE, clock.t);
  assert.equal(gate.nextStartAt(SITE), clock.t + 100);
  gate.release(SITE);
  assert.equal(gate.nextStartAt(SITE), 0, 'nothing ever started: the next job may be picked at once');

  assert.equal(gate.claimStart(SITE, clock.t), 0, 'a navigation really started');
  gate.reserve(SITE, clock.t + 500); // a job picked later, which then fails before it navigates
  gate.release(SITE);
  assert.equal(gate.nextStartAt(SITE), clock.t + 100, 'the spacing the real start holds is not given away');
  assert.equal(gate.claimStart(SITE, clock.t + 10), 90);

  assert.doesNotThrow(() => gate.release('never-heard-of.example'));
  assert.equal(gate.nextStartAt('never-heard-of.example'), 0);
});
