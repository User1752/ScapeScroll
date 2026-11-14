'use strict';

// server/modules/network/solver/circuit.js: the circuit breaker, on a hand-moved clock.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { SOLVER_SESSION_FAILED } = require('../../server/modules/errors/error-codes');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { createCircuit } = require('../../server/modules/network/solver/circuit');

function makeCircuit(config = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, { circuit: { failures: 3, windowMs: 10_000, openMs: 20_000 }, ...config });
  const state = createPoolState(cfg);
  const out = { logs: [], warns: [], recorded: [] };
  const ports = createPorts({
    now: () => clock.t,
    log: (m) => out.logs.push(m),
    warn: (m) => out.warns.push(m),
    recordError: async (entry) => { out.recorded.push(entry); },
  }, state);
  return { clock, state, out, circuit: createCircuit({ cfg, ports }) };
}

test('failures below the threshold leave the circuit closed, and each is noted as the last error', () => {
  const { clock, state, circuit } = makeCircuit();
  circuit.noteFailure('launch');
  circuit.noteFailure('create');
  assert.equal(circuit.isOpen(clock.t), false);
  assert.equal(state.lastError.kind, 'create');
  assert.deepEqual(circuit.status(clock.t), { open: false, secondsLeft: 0 });
});

test('the third failure inside the window opens it once: one warning, one error entry', () => {
  const { clock, out, circuit } = makeCircuit();
  circuit.noteFailure('launch');
  clock.t += 1000;
  circuit.noteFailure('launch');
  clock.t += 1000;
  circuit.noteFailure('create');

  assert.equal(circuit.isOpen(clock.t), true);
  assert.equal(circuit.isOpen(clock.t + 19_999), true);
  assert.equal(circuit.isOpen(clock.t + 20_000), false);
  assert.deepEqual(circuit.status(clock.t), { open: true, secondsLeft: 20 });
  assert.equal(out.warns.length, 1);
  assert.match(out.warns[0], /\(create\).*20 s/);
  assert.equal(out.recorded.length, 1);
  assert.equal(out.recorded[0].code, SOLVER_SESSION_FAILED);
  assert.equal(out.recorded[0].area, 'solver-pool');
  assert.deepEqual(out.recorded[0].details, { kind: 'create' });

  // More failures while it is open change nothing (jobs are stateless meanwhile).
  clock.t += 1000;
  circuit.noteFailure('create');
  assert.equal(out.recorded.length, 1);
  assert.equal(circuit.status(clock.t).secondsLeft, 19, 'still counting from the opening');
});

test('failures that fall outside the window are forgotten', () => {
  const { clock, circuit } = makeCircuit();
  circuit.noteFailure('launch');
  circuit.noteFailure('launch');
  clock.t += 10_000; // the window is 10 s: both are now too old
  circuit.noteFailure('launch');
  assert.equal(circuit.isOpen(clock.t), false);
});

test('after the window the first failure reopens it at once; a success closes it', () => {
  const { clock, out, circuit } = makeCircuit();
  for (let i = 0; i < 3; i += 1) circuit.noteFailure('launch');
  assert.equal(out.recorded.length, 1);

  clock.t += 20_000; // the closing probe is the next session job
  assert.equal(circuit.isOpen(clock.t), false);
  circuit.noteFailure('create');
  assert.equal(circuit.isOpen(clock.t), true, 'a failing probe reopens it without three more failures');
  assert.equal(out.recorded.length, 2);

  clock.t += 20_000;
  circuit.noteSuccess();
  assert.deepEqual(out.logs.filter((m) => /circuit is closed/.test(m)).length, 1);
  circuit.noteFailure('create');
  assert.equal(circuit.isOpen(clock.t), false, 'closed for good: three failures are needed again');
});

test('a success while the circuit is still open does not close it early, and a success on a closed one says nothing', () => {
  const { clock, out, circuit } = makeCircuit();
  circuit.noteSuccess();
  assert.equal(out.logs.length, 0);
  for (let i = 0; i < 3; i += 1) circuit.noteFailure('launch');
  clock.t += 5000;
  circuit.noteSuccess();
  assert.equal(circuit.isOpen(clock.t), true);
  assert.equal(out.logs.filter((m) => /circuit is closed/.test(m)).length, 0);
});

test('reset closes an open circuit and forgets the failures, with one line in the log; on a closed one it is silent', () => {
  const { clock, out, circuit } = makeCircuit();
  circuit.noteFailure('launch');
  circuit.noteFailure('launch');
  circuit.noteFailure('launch');
  assert.equal(circuit.isOpen(clock.t), true);

  circuit.reset();
  assert.equal(circuit.isOpen(clock.t), false);
  assert.deepEqual(circuit.status(clock.t), { open: false, secondsLeft: 0 });
  assert.equal(out.logs.filter((line) => /circuit is closed/.test(line)).length, 1);

  // the failures that opened it are forgotten too: two more are below the threshold again
  circuit.noteFailure('launch');
  circuit.noteFailure('launch');
  assert.equal(circuit.isOpen(clock.t), false);

  const logged = out.logs.length;
  circuit.reset();
  circuit.reset();
  assert.equal(out.logs.length, logged, 'nothing to close, nothing to say');
});
