'use strict';

// server/modules/network/solver/restart.js: FlareSolverr restarting. The slots, the
// queue and the scheduler are replaced by recorders; the lifecycle is a function
// that hands the pool its listener.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { POOL_ERROR_CODES } = require('../../server/modules/network/solver/errors');
const { createRestart } = require('../../server/modules/network/solver/restart');

function makeRestart({ withRegistration = true } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, { restartWaitMaxMs: 1000, restartWatchdogGraceMs: 500, downAfterWedgeMs: 3000 });
  const state = createPoolState(cfg);
  state.enabled = true;
  const timers = [];
  const out = { abandoned: 0, rejected: [], woke: 0, warns: [], logs: [], listeners: [], unsubscribed: 0, circuitResets: 0 };
  const hooks = withRegistration ? { onRestart: (listener) => { out.listeners.push(listener); return () => { out.unsubscribed += 1; }; } } : {};
  const ports = createPorts({
    now: () => clock.t,
    // A timer that has fired is gone, as a real one is.
    setTimer: (fn, ms) => {
      const handle = { ms, unref() { return this; } };
      handle.fn = () => { timers.splice(timers.indexOf(handle), 1); fn(); };
      timers.push(handle);
      return handle;
    },
    clearTimer: (handle) => { const at = timers.indexOf(handle); if (at !== -1) timers.splice(at, 1); },
    log: (m) => out.logs.push(m),
    warn: (m) => out.warns.push(m),
    hooks,
  }, state);
  const restart = createRestart({
    state,
    cfg,
    ports,
    slots: { abandonAll: () => { out.abandoned += 1; } },
    circuit: { reset: () => { out.circuitResets += 1; } },
    rejectQueued: (code) => out.rejected.push(code),
    wake: () => { out.woke += 1; },
  });
  return { clock, cfg, state, out, timers, restart };
}

test('a restart that begins drops every session, forgets what the old process was known not to do, and arms the watchdog', () => {
  const { state, out, timers, restart } = makeRestart();
  state.downUntil = 5;
  state.sessionsUnsupported = true;
  state.blankUnsupported = true;
  state.blankFailures = 2;

  restart.beginRestart('the idle watcher');
  assert.equal(state.restarting, true);
  assert.equal(state.downUntil, 0);
  assert.deepEqual([state.sessionsUnsupported, state.blankUnsupported, state.blankFailures], [false, false, 0]);
  assert.equal(out.abandoned, 1);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000 + 500, 'the longest a job waits, plus a grace');
  assert.ok(out.woke >= 1);
});

test('a restart is ignored while the pool is off or closing', () => {
  const off = makeRestart();
  off.state.enabled = false;
  off.restart.beginRestart('x');
  assert.equal(off.state.restarting, false);
  assert.equal(off.out.abandoned, 0);
  assert.equal(off.timers.length, 0);

  const closing = makeRestart();
  closing.state.shuttingDown = true;
  closing.restart.beginRestart('x');
  assert.equal(closing.state.restarting, false);
});

test('a second begin changes nothing but re-arms the watchdog; an end without a begin is nothing', () => {
  const { state, out, timers, restart } = makeRestart();
  restart.endRestart({ ok: true });
  assert.equal(out.woke, 0);

  restart.beginRestart('one');
  restart.beginRestart('two');
  assert.equal(out.abandoned, 1);
  assert.equal(timers.length, 1, 'the first watchdog was cancelled');
  assert.equal(state.restarting, true);
});

test('a restart that ends well resumes the jobs', () => {
  const { state, out, timers, restart } = makeRestart();
  restart.beginRestart('x');
  const wokeBefore = out.woke;
  restart.endRestart({ ok: true });
  assert.equal(state.restarting, false);
  assert.equal(state.downUntil, 0);
  assert.equal(timers.length, 0, 'the watchdog is stopped');
  assert.ok(out.woke > wokeBefore);
  assert.deepEqual(out.rejected, []);
});

test('the reason a restart gives is logged, cut to the length the config allows', () => {
  const { cfg, out, restart } = makeRestart();
  restart.beginRestart('r'.repeat(cfg.logReasonMaxChars + 20));
  assert.match(out.logs[0], new RegExp(`\\(r{${cfg.logReasonMaxChars}}\\); jobs wait\\.$`));
  restart.endRestart({ ok: true });
  restart.beginRestart('');
  assert.match(out.logs.at(-1), /\(no reason given\)/);
});

test('a restart that did not come back puts the pool down for a while and refuses what is waiting', () => {
  const { clock, cfg, state, out, restart } = makeRestart();
  restart.beginRestart('x');
  restart.endRestart({ ok: false });
  assert.equal(state.restarting, false);
  assert.equal(state.downUntil, clock.t + cfg.downAfterWedgeMs);
  assert.deepEqual(out.rejected, [POOL_ERROR_CODES.DOWN]);
  assert.match(out.warns[0], /did not come back; jobs fail fast for 3 s/);
  restart.endRestart({ ok: false }); // there is no restart left to end
  assert.equal(out.rejected.length, 1);
});

test('a restart whose end is never reported is treated as failed when the watchdog fires', () => {
  const { state, out, timers, restart } = makeRestart();
  restart.beginRestart('x');
  timers[0].fn();
  assert.equal(state.restarting, false);
  assert.ok(state.downUntil > 0);
  assert.deepEqual(out.rejected, [POOL_ERROR_CODES.DOWN]);
  assert.match(out.warns[0], /never reported its end/);
});

test('the pool subscribes once, routes begin and end, ignores anything else, and lets go on request', () => {
  const { state, out, restart } = makeRestart();
  restart.subscribe();
  assert.equal(out.listeners.length, 1);
  const [listener] = out.listeners;

  listener(null);
  listener({ phase: 'unknown' });
  assert.equal(state.restarting, false);
  listener({ phase: 'begin', reason: 'x' });
  assert.equal(state.restarting, true);
  listener({ phase: 'end', ok: 'yes' });
  assert.equal(state.restarting, false);
  assert.deepEqual(out.rejected, [POOL_ERROR_CODES.DOWN], 'only a real true counts as ok');

  restart.unsubscribe();
  restart.unsubscribe();
  assert.equal(out.unsubscribed, 1);
});

test('with no registration from the app nothing is subscribed and letting go is harmless', () => {
  const { out, restart } = makeRestart({ withRegistration: false });
  assert.doesNotThrow(() => { restart.subscribe(); restart.unsubscribe(); });
  assert.deepEqual(out.listeners, []);
});

// ── Restarts that overlap ───────────────────────────────────────────────────
// The lifecycle announces every restart it really performs. Two of them can be in flight at once
// (the idle watcher and a recovery from a hang used not to share a guard), and then the events
// arrive as begin, begin, end, end: the pool must not resume at the first end while the second
// restart is still killing and spawning.

test('two restarts that overlap keep the pool paused until the last one ends', () => {
  const { state, out, timers, restart } = makeRestart();
  restart.beginRestart('the idle watcher');
  restart.beginRestart('hang recovery');
  assert.equal(out.abandoned, 1, 'the sessions went with the first');
  const wokeBefore = out.woke;

  restart.endRestart({ ok: true });
  assert.equal(state.restarting, true, 'the second restart is still going');
  assert.equal(out.woke, wokeBefore, 'nothing resumes yet');
  assert.equal(timers.length, 1, 'and the watchdog still guards it');

  restart.endRestart({ ok: true });
  assert.equal(state.restarting, false);
  assert.ok(out.woke > wokeBefore, 'the last end resumes the jobs');
  assert.equal(timers.length, 0);
  assert.deepEqual(out.rejected, []);
});

test('the last restart to end decides whether FlareSolverr is back', () => {
  const failedFirst = makeRestart();
  failedFirst.restart.beginRestart('a');
  failedFirst.restart.beginRestart('b');
  failedFirst.restart.endRestart({ ok: false });
  assert.equal(failedFirst.state.restarting, true);
  failedFirst.restart.endRestart({ ok: true });
  assert.equal(failedFirst.state.restarting, false);
  assert.equal(failedFirst.state.downUntil, 0, 'a copy is answering again: the pool resumes');
  assert.deepEqual(failedFirst.out.rejected, []);

  const failedLast = makeRestart();
  failedLast.restart.beginRestart('a');
  failedLast.restart.beginRestart('b');
  failedLast.restart.endRestart({ ok: true });
  failedLast.restart.endRestart({ ok: false });
  assert.equal(failedLast.state.restarting, false);
  assert.ok(failedLast.state.downUntil > 0, 'the last one did not come back: the pool is down for a while');
  assert.deepEqual(failedLast.out.rejected, [POOL_ERROR_CODES.DOWN]);
});

test('an end that has no begin does not unbalance the next restart', () => {
  const { state, restart } = makeRestart();
  restart.endRestart({ ok: true });
  restart.endRestart({ ok: false });
  restart.beginRestart('x');
  restart.endRestart({ ok: true });
  assert.equal(state.restarting, false, 'one begin, one end: resumed');
});

test('a watchdog that fires ends every restart that was still counted', () => {
  const { state, out, timers, restart } = makeRestart();
  restart.beginRestart('a');
  restart.beginRestart('b');
  restart.beginRestart('c');
  timers[0].fn();
  assert.equal(state.restarting, false, 'the pool does not stay paused for the rest of the process');
  assert.deepEqual(out.rejected, [POOL_ERROR_CODES.DOWN]);

  restart.beginRestart('after');
  restart.endRestart({ ok: true });
  assert.equal(state.restarting, false, 'and the count started over');
});

// ── The circuit breaker ─────────────────────────────────────────────────────
// Session failures that opened the circuit came from the FlareSolverr process that is replaced, so a
// restart that brings the solver back closes it. Only then: a restart that fails leaves the cause where it was.

test('the circuit is closed when a restart ends well, not when it begins', () => {
  const { out, restart } = makeRestart();
  restart.beginRestart('x');
  assert.equal(out.circuitResets, 0, 'the restart may still fail');
  restart.endRestart({ ok: true });
  assert.equal(out.circuitResets, 1);
});

test('a restart that did not come back, or whose end was never reported, leaves the circuit as it is', () => {
  const failed = makeRestart();
  failed.restart.beginRestart('x');
  failed.restart.endRestart({ ok: false });
  assert.equal(failed.out.circuitResets, 0);

  const silent = makeRestart();
  silent.restart.beginRestart('x');
  silent.timers[0].fn(); // the watchdog
  assert.equal(silent.out.circuitResets, 0);
});

test('with two restarts in flight the circuit is closed once, by the last one, and only if it brought FlareSolverr back', () => {
  const good = makeRestart();
  good.restart.beginRestart('a');
  good.restart.beginRestart('b');
  good.restart.endRestart({ ok: true });
  assert.equal(good.out.circuitResets, 0, 'the second restart is still going');
  good.restart.endRestart({ ok: true });
  assert.equal(good.out.circuitResets, 1);

  const failedLast = makeRestart();
  failedLast.restart.beginRestart('a');
  failedLast.restart.beginRestart('b');
  failedLast.restart.endRestart({ ok: true });
  failedLast.restart.endRestart({ ok: false });
  assert.equal(failedLast.out.circuitResets, 0, 'the last one decides');
});

test('reset forgets a restart in progress: after the pool was switched off and on again the next restart is counted from zero', () => {
  const { state, timers, restart } = makeRestart();
  restart.beginRestart('a');
  restart.beginRestart('b');
  restart.reset();
  assert.equal(state.restarting, false);
  assert.equal(timers.length, 0);

  restart.beginRestart('c');
  restart.endRestart({ ok: true });
  assert.equal(state.restarting, false);
});
