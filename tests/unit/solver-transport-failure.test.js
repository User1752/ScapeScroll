'use strict';

// server/modules/network/solver/transport-failure.js: what it means for the pool when a request to
// FlareSolverr itself got no answer. The real state and ports are used; the clock is the test's.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver/errors');
const { createTransportFailure } = require('../../server/modules/network/solver/transport-failure');

function makeEnv({ offByChoice = false } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, { downAfterWedgeMs: 3000 });
  const state = createPoolState(cfg);
  state.enabled = true;
  const out = { warns: [], rejected: [] };
  const hooks = { isOffByChoice: () => offByChoice };
  const ports = createPorts({ now: () => clock.t, log: () => {}, warn: (m) => out.warns.push(m), hooks }, state);
  const onTransportFailure = createTransportFailure({ state, cfg, ports, rejectQueued: (code) => out.rejected.push(code) });
  return { clock, cfg, state, out, onTransportFailure };
}

const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
const unroutable = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('no route'), { code: 'EHOSTUNREACH' }) });
const aggregateRefused = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new AggregateError([Object.assign(new Error('v6'), { code: 'ECONNREFUSED' }), Object.assign(new Error('v4'), { code: 'ECONNREFUSED' })]), {}) });
const reset = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

test('every failure is noted for the status, and no session is trusted until it has been checked again', () => {
  const { state, onTransportFailure } = makeEnv();
  state.slots.set(1, { lastOkAt: 1234 });
  state.slots.set(2, { lastOkAt: 5678 });
  onTransportFailure(reset(), null);
  assert.equal(state.lastError.kind, 'transport');
  assert.deepEqual([...state.slots.values()].map((s) => s.lastOkAt), [0, 0]);
});

test('a timeout makes the session it was for suspect; any other failure does not', () => {
  const { onTransportFailure } = makeEnv();
  const slot = { suspect: false, lastOkAt: 1 };
  onTransportFailure(reset(), slot);
  assert.equal(slot.suspect, false);
  onTransportFailure(timeout(), slot);
  assert.equal(slot.suspect, true, 'our own abort leaves the browser in an unknown state');
});

test('a timeout opens the fail-fast window, refuses what is queued, and says so once', () => {
  const { clock, cfg, state, out, onTransportFailure } = makeEnv();
  onTransportFailure(timeout(), null);
  assert.equal(state.downUntil, clock.t + cfg.downAfterWedgeMs);
  assert.deepEqual(out.rejected, [POOL_ERROR_CODES.DOWN]);
  assert.match(out.warns[0], /FlareSolverr is not answering; jobs fail fast for 3 s/);

  clock.t += 1000;
  onTransportFailure(timeout(), null);
  assert.equal(state.downUntil, clock.t + cfg.downAfterWedgeMs, 'a failure inside the window extends it');
  assert.equal(out.warns.length, 1, 'but is not said again');
  assert.equal(out.rejected.length, 1);
});

// The opposite of a wedge: nothing is listening, so every job fails by itself at once and a window would only
// replace the words ("not reachable, turn it on") with "not answering, try again in a moment" for 30 s.
test('a refused connection opens no window and refuses nothing: it is remembered for System Health and said once', () => {
  for (const make of [refused, unroutable, aggregateRefused]) {
    const { state, out, onTransportFailure } = makeEnv();
    onTransportFailure(make(), null);
    assert.equal(state.downUntil, 0, make.name);
    assert.deepEqual(out.rejected, []);
    assert.equal(state.solverRefused, true);
    assert.equal(out.warns.length, 1);
    assert.match(out.warns[0], /FlareSolverr is not reachable/);
    assert.doesNotMatch(out.warns[0], /fail fast/);

    onTransportFailure(make(), null);
    assert.equal(out.warns.length, 1, 'once per episode');
    assert.equal(state.lastError.kind, 'transport', 'the status still knows');
  }
});

test('anything that is not a refusal ends the memory of one: a timeout, a reset socket', () => {
  const { state, onTransportFailure } = makeEnv();
  onTransportFailure(refused(), null);
  assert.equal(state.solverRefused, true);
  onTransportFailure(reset(), null);
  assert.equal(state.solverRefused, false, 'something was there to reset the connection');
  onTransportFailure(refused(), null);
  onTransportFailure(timeout(), null);
  assert.equal(state.solverRefused, false, 'something took the call and never answered');
});

test('a reset socket, a TLS or a DNS failure is not a wedged solver: no window is opened', () => {
  const { state, out, onTransportFailure } = makeEnv();
  for (const cause of ['ECONNRESET', 'ENOTFOUND', 'CERT_HAS_EXPIRED', 'UND_ERR_SOCKET']) {
    onTransportFailure(Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(cause), { code: cause }) }), null);
  }
  onTransportFailure(new Error('something else'), null);
  assert.equal(state.downUntil, 0);
  assert.deepEqual(out.rejected, []);
});

test('nothing opens while the pool is off or FlareSolverr is being restarted: a restart is the reason it does not answer', () => {
  const { state, out, onTransportFailure } = makeEnv();
  state.restarting = true;
  onTransportFailure(timeout(), null);
  onTransportFailure(refused(), null);
  state.restarting = false;
  state.enabled = false;
  onTransportFailure(refused(), null);
  onTransportFailure(timeout(), null);
  assert.equal(state.downUntil, 0);
  assert.equal(state.solverRefused, false, 'a restart is why nothing is listening; a pool that is off has no opinion');
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(out.warns, []);
});

test('after the window a new failure opens it again, but it is the same episode: it is not said again until FlareSolverr has answered', () => {
  const { clock, cfg, state, out, onTransportFailure } = makeEnv();
  onTransportFailure(timeout(), null);
  clock.t += cfg.downAfterWedgeMs;
  onTransportFailure(timeout(), null);
  assert.equal(out.rejected.length, 2, 'whatever is queued is still refused each time the window opens');
  assert.equal(state.downUntil, clock.t + cfg.downAfterWedgeMs);
  assert.equal(out.warns.length, 1, 'one line per episode, not one every 30 s for as long as nothing answers');

  clock.t += cfg.downAfterWedgeMs;
  onTransportFailure(refused(), null);
  assert.equal(out.warns.length, 1, 'whichever way it fails: a refusal is the same episode, and says nothing more');

  // Something answered (navigation.js clears the flag): the next failure is a new episode.
  state.downReported = false;
  clock.t += cfg.downAfterWedgeMs;
  onTransportFailure(timeout(), null);
  assert.equal(out.warns.length, 2);
});

test('when the user turned FlareSolverr off the pool says nothing, whichever way it fails: a refused connection is what they chose', () => {
  const { state, out, onTransportFailure } = makeEnv({ offByChoice: true });
  onTransportFailure(refused(), null);
  assert.equal(state.downUntil, 0, 'a refusal opens no window');
  assert.deepEqual(out.rejected, []);
  assert.deepEqual(out.warns, []);
  assert.equal(state.solverRefused, true, 'the status still knows');
  assert.equal(state.lastError.kind, 'transport');

  // It is asked every time, not once: turning FlareSolverr on later makes the next failure worth saying.
  const env = makeEnv({ offByChoice: true });
  env.onTransportFailure(refused(), null);
  env.onTransportFailure(timeout(), null);
  assert.deepEqual(env.out.warns, []);
  assert.equal(env.state.downReported, false, 'a silent episode did not use up the one line');
});
