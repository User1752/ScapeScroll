'use strict';

// server/modules/network/solver/pool-control.js: applying settings and shutting down.
// Every part it tells what to stop is a recorder, so the order and the reasons are visible.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver/errors');
const { createPoolControl } = require('../../server/modules/network/solver/pool-control');

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

// A promise the code under test must settle. When a rule is broken it never does, and a test that
// waits for ever is worse than one that fails, so the wait is bounded.
function soon(promise, what, ms = 1000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what} was never answered` })), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function makeEnv(config = {}) {
  const cfg = mergeConfig(POOL, config);
  const state = createPoolState(cfg);
  const timers = [];
  const out = { calls: [], released: [], closed: [], rejected: [], warns: [] };
  const ports = createPorts({
    // A timer that has fired is gone, as a real one is.
    setTimer: (fn, ms) => {
      const handle = { ms, unref() { return this; } };
      handle.fn = () => { timers.splice(timers.indexOf(handle), 1); fn(); };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => { const at = timers.indexOf(handle); if (at !== -1) timers.splice(at, 1); },
    log: () => {},
    warn: (m) => out.warns.push(m),
  }, state);
  const slotList = [];
  const note = (name) => () => { out.calls.push(name); };
  const slots = {
    stopIdleTimer: note('stopIdleTimer'),
    ensureIdleTimer: note('ensureIdleTimer'),
    liveSlots: () => slotList.filter((s) => s.status !== 'closing'),
    closeSlot: (slot, reason) => { out.closed.push([slot.key, reason]); slot.status = 'closing'; return Promise.resolve(); },
    closeAll: (reason) => { out.calls.push(`closeAll:${reason}`); return Promise.resolve(); },
  };
  const control = createPoolControl({
    state,
    cfg,
    ports,
    slots,
    jobs: { rejectQueued: (code) => { out.rejected.push(code); } },
    scheduler: { stopWake: note('stopWake'), schedulePump: note('schedulePump') },
    passthrough: { release: (job) => { out.released.push(job); } },
    // reset() is what forgets a restart in progress: it also clears the flag the pool checks
    restart: { reset: () => { note('resetRestart')(); state.restarting = false; }, stopWatchdog: note('stopWatchdog'), unsubscribe: note('unsubscribe') },
  });
  return { cfg, state, out, timers, slotList, slots, control };
}

test('settings that make no sense become the defaults, never an error', () => {
  const { cfg, state, control } = makeEnv();
  control.applySettings({ enabled: true, maxSessions: 2, idleMinutes: 5 });
  assert.equal(state.enabled, true);
  assert.equal(state.maxSessions, 2);
  assert.equal(state.idleMs, 5 * 60_000);

  for (const [maxSessions, idleMinutes] of [[99, 0], [0, 99], [1.5, 2.5], ['2', '5'], [NaN, Infinity], [-1, -1], [undefined, undefined]]) {
    control.applySettings({ enabled: true, maxSessions, idleMinutes });
    assert.equal(state.maxSessions, cfg.defaultMaxSessions, `maxSessions ${maxSessions}`);
    assert.equal(state.idleMs, cfg.defaultIdleMinutes * 60_000, `idleMinutes ${idleMinutes}`);
  }
  control.applySettings({ enabled: true, maxSessions: cfg.maxSessionsCap, idleMinutes: cfg.idleMinutesMax });
  assert.equal(state.maxSessions, cfg.maxSessionsCap);
  assert.equal(state.idleMs, cfg.idleMinutesMax * 60_000);

  assert.doesNotThrow(() => { control.applySettings(); control.applySettings({ enabled: 'true' }); });
  assert.equal(state.enabled, false, 'only a real true switches the pool on');
});

test('the smallest pool is the config\'s, not a number written in the code', () => {
  const { state, control } = makeEnv({ maxSessionsMin: 2, maxSessionsCap: 4, defaultMaxSessions: 3 });
  control.applySettings({ enabled: true, maxSessions: 1, idleMinutes: 10 });
  assert.equal(state.maxSessions, 3, 'below the configured minimum: the default');
  control.applySettings({ enabled: true, maxSessions: 2, idleMinutes: 10 });
  assert.equal(state.maxSessions, 2);
  control.applySettings({ enabled: true, maxSessions: 5, idleMinutes: 10 });
  assert.equal(state.maxSessions, 3, 'above the configured cap: the default');
});

test('what disabled the pool is remembered only while it is disabled', () => {
  const { state, control } = makeEnv();
  control.applySettings({ enabled: false, disabledBy: 'env' });
  assert.equal(state.disabledBy, 'env');
  control.applySettings({ enabled: false, disabledBy: 'setting' });
  assert.equal(state.disabledBy, 'setting');
  control.applySettings({ enabled: false, disabledBy: 'whatever' });
  assert.equal(state.disabledBy, null);
  control.applySettings({ enabled: true, disabledBy: 'env' });
  assert.equal(state.disabledBy, null);
});

test('switching the pool off hands the waiting jobs to the old path and stops everything, in that order', () => {
  const { state, out, control } = makeEnv();
  control.applySettings({ enabled: true, maxSessions: 1, idleMinutes: 10 });
  const waiting = { state: 'queued' };
  const running = { state: 'running' };
  state.queue.push(waiting, running);
  state.restarting = true;
  state.downUntil = 123;
  out.calls.length = 0;

  control.applySettings({ enabled: false, disabledBy: 'setting' });
  assert.deepEqual(out.released, [waiting]);
  assert.equal(state.restarting, false);
  assert.equal(state.downUntil, 0);
  assert.deepEqual(out.calls, ['resetRestart', 'stopWake', 'stopIdleTimer', 'closeAll:disabled']);

  out.calls.length = 0;
  control.applySettings({ enabled: false, disabledBy: 'setting' });
  assert.deepEqual(out.calls, [], 'already off: nothing to undo');
  assert.deepEqual(out.released, [waiting]);
});

test('settings applied while the pool stays on re-arm the idle timer and wake the scheduler', () => {
  const { state, out, control } = makeEnv();
  state.slots.set(1, {});
  control.applySettings({ enabled: true, maxSessions: 1, idleMinutes: 10 });
  assert.deepEqual(out.calls, ['stopIdleTimer', 'ensureIdleTimer', 'schedulePump']);

  out.calls.length = 0;
  state.slots.clear();
  control.applySettings({ enabled: true, maxSessions: 1, idleMinutes: 10 });
  assert.deepEqual(out.calls, ['stopIdleTimer', 'schedulePump'], 'no timer without a slot');
});

test('a smaller pool closes the extra IDLE slots, longest unused first, and leaves a busy one for when its job ends', () => {
  const { out, slotList, control } = makeEnv();
  slotList.push(
    { key: 1, status: 'idle', lastUsedAt: 300 },
    { key: 2, status: 'busy', lastUsedAt: 100 },
    { key: 3, status: 'idle', lastUsedAt: 200 },
  );
  control.applySettings({ enabled: true, maxSessions: 2, idleMinutes: 10 });
  assert.deepEqual(out.closed, [[3, 'resized']], 'one over the limit: the idle one unused for longest');

  out.closed.length = 0;
  control.applySettings({ enabled: true, maxSessions: 1, idleMinutes: 10 });
  assert.deepEqual(out.closed, [[1, 'resized']]);
  control.applySettings({ enabled: true, maxSessions: 1, idleMinutes: 10 });
  assert.deepEqual(out.closed, [[1, 'resized']], 'the busy one stays; nothing idle is left to close');
});

test('applying settings never throws: a part that fails is reported', () => {
  const { out, slots, control } = makeEnv();
  slots.stopIdleTimer = () => { throw new Error('timer broke'); };
  assert.doesNotThrow(() => control.applySettings({ enabled: true, maxSessions: 1, idleMinutes: 10 }));
  assert.deepEqual(out.warns, ['[SolverPool] Applying the settings failed: timer broke']);
});

test('shutdown refuses what is queued, stops the timers and the restart listener, and is the same promise when asked twice', async () => {
  const { state, out, control } = makeEnv();
  control.applySettings({ enabled: true, maxSessions: 1, idleMinutes: 10 });
  out.calls.length = 0;

  const first = control.shutdown({ timeoutMs: 1000 });
  const second = control.shutdown();
  assert.equal(first, second);
  assert.equal(state.shuttingDown, true);
  assert.deepEqual(out.rejected, [POOL_ERROR_CODES.SHUTTING_DOWN]);
  assert.deepEqual(out.calls.slice(0, 3), ['unsubscribe', 'stopWake', 'stopWatchdog']);
  await soon(first, 'the shutdown');
  assert.ok(out.calls.includes('closeAll:shutdown'));
  assert.ok(out.calls.includes('stopIdleTimer'));
});

test('shutdown waits for the jobs that are running, and for the last slot to go', async () => {
  const { state, out, timers, control } = makeEnv();
  state.inFlight = 1;
  state.slots.set(1, {});
  let done = false;
  const shutdown = control.shutdown({ timeoutMs: 5000 }).then(() => { done = true; });

  await tick();
  assert.equal(done, false, 'a job is still running');
  assert.equal(timers.length, 1, 'only the give-up timer');
  assert.equal(timers[0].ms, 5000);

  state.inFlight = 0;
  for (const wake of state.drainWaiters.splice(0)) wake();
  await tick();
  assert.deepEqual(out.calls.filter((c) => c === 'closeAll:shutdown'), ['closeAll:shutdown']);
  assert.equal(done, false, 'a slot is still being closed');

  state.slots.clear();
  for (const wake of state.emptyWaiters.splice(0)) wake();
  await soon(shutdown, 'the shutdown');
  assert.equal(done, true);
  assert.equal(timers.length, 0, 'the give-up timer is stopped');
});

test('a shutdown with no time given waits as long as the config says', async () => {
  const { state, timers, control } = makeEnv({ shutdownTimeoutMs: 777 });
  state.inFlight = 1;
  state.slots.set(1, {});
  const shutdown = control.shutdown();
  await tick();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 777);
  timers[0].fn();
  await soon(shutdown, 'the shutdown');
});

test('shutdown gives up waiting when its time is out', async () => {
  const { state, timers, control } = makeEnv();
  state.inFlight = 1;
  state.slots.set(1, {});
  const shutdown = control.shutdown({ timeoutMs: 50 });
  await tick();
  timers[0].fn(); // the give-up timer fires
  await soon(shutdown, 'the shutdown');
  assert.equal(state.shuttingDown, true);
});
