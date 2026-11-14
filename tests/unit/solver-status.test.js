'use strict';

// server/modules/network/solver/status.js: the pool's report on itself. It reads the
// shared state and two parts, and must hold counts and states only.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { createHostGate } = require('../../server/modules/network/solver/host-gate');
const { createCircuit } = require('../../server/modules/network/solver/circuit');
const { createStatus } = require('../../server/modules/network/solver/status');

function makeEnv({ offByChoice = false } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, { circuit: { failures: 1, windowMs: 10_000, openMs: 20_000 }, blockCooldown: { initialMs: 4000, maxMs: 4000 } });
  const state = createPoolState(cfg);
  const ports = createPorts({ now: () => clock.t, log: () => {}, warn: () => {}, recordError: async () => {}, hooks: { isOffByChoice: () => offByChoice } }, state);
  const hostGate = createHostGate({ cfg, state, ports });
  const circuit = createCircuit({ cfg, ports });
  const slotList = [];
  const slots = { liveSlots: () => slotList.filter((s) => s.status !== 'closing') };
  const { getStatus } = createStatus({ state, ports, slots, hostGate, circuit });
  return { clock, state, hostGate, circuit, slotList, getStatus };
}

const slotOf = (over = {}) => ({
  id: 'ss-4242-abc-1', solverUrl: 'http://127.0.0.1:8191/v1', fingerprint: 'user:deadbeef', status: 'idle', createdAt: 0, lastUsedAt: 0, uses: 0, proxyMode: 'none', ...over,
});

test('a pool that was never switched on reports "disabled", with what disabled it only while it is', () => {
  const { state, getStatus } = makeEnv();
  const status = getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.state, 'disabled');
  assert.equal(status.disabledBy, null);

  state.disabledBy = 'env';
  assert.equal(getStatus().disabledBy, 'env');
  state.enabled = true;
  assert.equal(getStatus().disabledBy, null, 'an enabled pool is not disabled by anything');
});

test('the shape: enabled, disabledBy, state, sessions, queued, inFlight, counters, cooldowns, circuit, lastError, solver', () => {
  const { state, getStatus } = makeEnv();
  state.enabled = true;
  assert.deepEqual(Object.keys(getStatus()), ['enabled', 'disabledBy', 'state', 'sessions', 'queued', 'inFlight', 'counters', 'cooldowns', 'circuit', 'lastError', 'solver']);
  assert.deepEqual(getStatus().queued, { interactive: 0, background: 0 });
  assert.deepEqual(getStatus().circuit, { open: false, secondsLeft: 0 });
  assert.equal(getStatus().lastError, null);
  assert.equal(getStatus().solver, null, 'no news about FlareSolverr');
});

// The row next to FlareSolverr's own in System Health must not say "Ready" about a browser that cannot open.
test('solver: "off" when the user switched FlareSolverr off, "refused" when the last request was refused, otherwise nothing', () => {
  const { state, getStatus } = makeEnv();
  state.enabled = true;
  assert.equal(getStatus().solver, null);
  state.solverRefused = true;
  assert.equal(getStatus().solver, 'refused');
  state.solverRefused = false;
  assert.equal(getStatus().solver, null, 'it answered');

  const off = makeEnv({ offByChoice: true });
  off.state.enabled = true;
  assert.equal(off.getStatus().solver, 'off');
  off.state.solverRefused = true;
  assert.equal(off.getStatus().solver, 'off', 'a switched-off FlareSolverr refusing is expected, and is said as what it is');
});

test('the state is the first that applies: disabled, restarting, down, circuit-open, then active or idle', () => {
  const { clock, state, circuit, slotList, getStatus } = makeEnv();
  state.enabled = true;
  assert.equal(getStatus().state, 'idle');
  slotList.push(slotOf());
  assert.equal(getStatus().state, 'active');

  circuit.noteFailure('launch');
  assert.equal(getStatus().state, 'circuit-open');
  state.downUntil = clock.t + 1000;
  assert.equal(getStatus().state, 'down', 'down comes before the circuit');
  state.restarting = true;
  assert.equal(getStatus().state, 'restarting', 'and a restart before both');
  state.enabled = false;
  assert.equal(getStatus().state, 'disabled');

  state.enabled = true;
  state.restarting = false;
  clock.t += 1000;
  assert.equal(getStatus().state, 'circuit-open', 'the down window is over');
});

test('a session is described by its times, uses and proxy label; a closing one is not listed', () => {
  const { clock, slotList, state, getStatus } = makeEnv();
  state.enabled = true;
  slotList.push(
    slotOf({ status: 'idle', createdAt: clock.t - 5000, lastUsedAt: clock.t - 2000, uses: 3, proxyMode: 'user-proxy' }),
    slotOf({ status: 'busy', createdAt: 0, lastUsedAt: clock.t - 9000, proxyMode: 'none' }),
    slotOf({ status: 'closing' }),
    slotOf({ status: 'opening', proxyMode: 'something-else' }),
  );
  assert.deepEqual(getStatus().sessions, [
    { idleMs: 2000, ageMs: 5000, uses: 3, busy: false, proxy: 'user' },
    { idleMs: 0, ageMs: 0, uses: 0, busy: true, proxy: 'none' },
    { idleMs: 0, ageMs: 0, uses: 0, busy: true, proxy: 'none' },
  ]);
});

test('only jobs still waiting for a slot are queued, counted by class', () => {
  const { state, getStatus } = makeEnv();
  state.queue.push(
    { state: 'queued', priority: 'interactive' }, { state: 'queued', priority: 'interactive' }, { state: 'queued', priority: 'background' },
    { state: 'preflighting', priority: 'background' }, { state: 'running', priority: 'interactive' },
  );
  state.inFlight = 2;
  const status = getStatus();
  assert.deepEqual(status.queued, { interactive: 2, background: 1 });
  assert.equal(status.inFlight, 2);
});

test('cooldowns and the circuit come from the parts that own them', () => {
  const { clock, state, hostGate, circuit, getStatus } = makeEnv();
  state.enabled = true;
  hostGate.noteBlock('cf-site.example');
  circuit.noteFailure('create');
  const status = getStatus();
  assert.deepEqual(status.cooldowns, [{ host: 'cf-site.example', secondsLeft: 4 }]);
  assert.deepEqual(status.circuit, { open: true, secondsLeft: 20 });
  clock.t += 4000;
  assert.deepEqual(getStatus().cooldowns, []);
});

test('what is reported is a copy, and holds no id, URL, fingerprint or message text', () => {
  const { state, slotList, getStatus } = makeEnv();
  state.enabled = true;
  slotList.push(slotOf({ proxyMode: 'user-proxy' }));
  state.counters.jobs = 4;
  state.lastError = { at: '2026-10-25T12:00:00.000Z', kind: 'timeout' };

  const status = getStatus();
  status.counters.jobs = 99;
  status.lastError.kind = 'changed';
  assert.equal(state.counters.jobs, 4);
  assert.equal(state.lastError.kind, 'timeout');

  const text = JSON.stringify(getStatus());
  for (const secret of ['ss-4242', '127.0.0.1', 'deadbeef', '://']) assert.ok(!text.includes(secret), secret);
});
