'use strict';

// server/modules/network/solver/ports.js: the pool's effects on the outside world.
// None of them may throw into the pool, and no timer may keep the process alive.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');

const newState = () => createPoolState(POOL);

test('timers are unref\'d by the port, stopping nothing is fine, and sleep resolves through a timer', async () => {
  const made = [];
  const cleared = [];
  const ports = createPorts({
    setTimer: (fn, ms) => { const handle = { fn, ms, unrefCalls: 0, unref() { this.unrefCalls += 1; return this; } }; made.push(handle); return handle; },
    clearTimer: (handle) => cleared.push(handle),
  }, newState());

  const handle = ports.startTimer(() => {}, 50);
  assert.equal(handle.unrefCalls, 1, 'the pool must never keep the process alive');
  ports.stopTimer(handle);
  ports.stopTimer(null);
  assert.deepEqual(cleared, [handle]);

  const slept = ports.sleep(30);
  assert.equal(made[1].ms, 30);
  made[1].fn();
  await slept;

  // A timer implementation without unref (a hand-made fake) is accepted.
  const bare = createPorts({ setTimer: () => 'handle-without-unref' }, newState());
  assert.equal(bare.startTimer(() => {}, 1), 'handle-without-unref');
});

test('the real timers are unref\'d too', () => {
  const ports = createPorts({}, newState());
  const handle = ports.startTimer(() => {}, 60_000);
  assert.equal(handle.hasRef(), false);
  ports.stopTimer(handle);
});

test('log and warn carry the pool prefix; warnOnce says a thing once per key', () => {
  const logs = [];
  const warns = [];
  const ports = createPorts({ log: (m) => logs.push(m), warn: (m) => warns.push(m) }, newState());
  ports.log('opened');
  ports.warn('careful');
  ports.warnOnce('k', 'first');
  ports.warnOnce('k', 'second');
  ports.warnOnce('other', 'third');
  assert.deepEqual(logs, ['[SolverPool] opened']);
  assert.deepEqual(warns, ['[SolverPool] careful', '[SolverPool] first', '[SolverPool] third']);
});

test('log, warn and warnOnce cannot fail either: a logger that throws never reaches the pool', () => {
  const attempts = { log: 0, warn: 0 };
  const ports = createPorts({
    log: () => { attempts.log += 1; throw new Error('console closed'); },
    warn: () => { attempts.warn += 1; throw new Error('console closed'); },
  }, newState());
  assert.doesNotThrow(() => ports.log('opened'));
  assert.doesNotThrow(() => ports.warn('careful'));
  assert.doesNotThrow(() => ports.warnOnce('k', 'first'));
  assert.doesNotThrow(() => ports.warnOnce('k', 'second'));
  assert.deepEqual(attempts, { log: 1, warn: 2 }, 'each was still tried, and warnOnce still says a thing once');
});

test('record hands the error registry code, area, message and details, and cannot fail', async () => {
  const recorded = [];
  const ports = createPorts({ recordError: async (entry) => { recorded.push(entry); } }, newState());
  ports.record('ERROR-019', 'text', { kind: 'launch' });
  assert.deepEqual(recorded, [{ code: 'ERROR-019', area: 'solver-pool', message: 'text', details: { kind: 'launch' } }]);

  const throwing = createPorts({ recordError: () => { throw new Error('disk full'); } }, newState());
  assert.doesNotThrow(() => throwing.record('ERROR-019', 'x', {}));
  const rejecting = createPorts({ recordError: () => Promise.reject(new Error('disk full')) }, newState());
  assert.doesNotThrow(() => rejecting.record('ERROR-019', 'x', {}));
  await new Promise((resolve) => { setImmediate(resolve); }); // an unhandled rejection would fail the run
});

test('the last error is a kind and a time, taken from the injected clock', () => {
  const state = newState();
  const ports = createPorts({ now: () => Date.UTC(2026, 9, 25, 12, 0, 0) }, state);
  assert.equal(state.lastError, null);
  ports.noteLastError('timeout');
  assert.deepEqual(state.lastError, { at: '2026-10-25T12:00:00.000Z', kind: 'timeout' });

  const broken = newState();
  createPorts({ now: () => NaN }, broken).noteLastError('x');
  assert.match(broken.lastError.at, /^\d{4}-\d\d-\d\dT/, 'a clock that answers nonsense falls back to the real time');
});

test('the hooks are called as methods of what the app gave, looked up at call time, and cannot fail', () => {
  const calls = [];
  const hooks = {
    noteUsed() { calls.push(['used', this === hooks]); },
    recoverFromHang() { throw new Error('hook failed'); },
  };
  const ports = createPorts({ hooks }, newState());
  ports.noteUsed();
  assert.doesNotThrow(() => ports.recoverSolver());
  assert.deepEqual(calls, [['used', true]]);

  // Added after the ports were built: still found.
  hooks.onProxyFault = (info) => calls.push(['fault', info]);
  ports.reportProxyFault('filter:1234');
  assert.deepEqual(calls[1], ['fault', { fingerprint: 'filter:1234' }]);
  hooks.onProxyFault = () => { throw new Error('hook failed'); };
  assert.doesNotThrow(() => ports.reportProxyFault('x'));

  // No hooks at all.
  const bare = createPorts({}, newState());
  assert.doesNotThrow(() => { bare.noteUsed(); bare.recoverSolver(); bare.reportProxyFault('x'); });
});

test('the restart registration is passed through, with its own `this`, or absent', () => {
  assert.equal(createPorts({}, newState()).subscribeRestart, null);
  assert.equal(createPorts({ hooks: {} }, newState()).subscribeRestart, null);

  const hooks = {
    seen: [],
    onRestart(listener) { this.seen.push(listener); return () => 'unsubscribed'; },
  };
  const ports = createPorts({ hooks }, newState());
  const listener = () => {};
  const unsubscribe = ports.subscribeRestart(listener);
  assert.deepEqual(hooks.seen, [listener]);
  assert.equal(unsubscribe(), 'unsubscribed');
});

test('the ports are a frozen object', () => {
  assert.ok(Object.isFrozen(createPorts({}, newState())));
});

test('isOffByChoice asks the lifecycle at call time, and anything it cannot answer is "no"', () => {
  let answer = true;
  const hooks = { isOffByChoice: () => answer };
  const ports = createPorts({ hooks }, newState());
  assert.equal(ports.isOffByChoice(), true);
  answer = false;
  assert.equal(ports.isOffByChoice(), false, 'asked again every time');
  for (const odd of ['yes', 1, {}, undefined, null]) {
    answer = odd;
    assert.equal(ports.isOffByChoice(), false, String(odd));
  }
  assert.equal(createPorts({ hooks: { isOffByChoice: () => { throw new Error('broken'); } } }, newState()).isOffByChoice(), false);
  assert.equal(createPorts({ hooks: { isOffByChoice: 'not a function' } }, newState()).isOffByChoice(), false);
  assert.equal(createPorts({}, newState()).isOffByChoice(), false, 'an app that gave no hook');
});
