'use strict';

// server/modules/network/solver/slots.js: the slot registry. A fake transport records
// the destroy commands; the clock and the timers are the test's.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { createSlots } = require('../../server/modules/network/solver/slots');

const URL_A = 'http://127.0.0.1:8191/v1';
const tick = () => new Promise((resolve) => { setImmediate(resolve); });

function makeSlots({ config = {}, enabled = true, destroyAnswer = null } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, { idleTickMs: 1000, ...config });
  const state = createPoolState(cfg);
  state.enabled = enabled;
  state.idleMs = 10_000;
  const timers = [];
  const out = { warns: [], logs: [], destroyed: [], failures: [], recovered: 0, woke: 0 };
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
    hooks: { recoverFromHang: () => { out.recovered += 1; } },
  }, state);
  const transport = {
    destroySession: async (solverUrl, id) => {
      // The status of every slot AT THE MOMENT the destroy is sent.
      out.destroyed.push({ solverUrl, id, statuses: [...state.slots.values()].map((s) => s.status) });
      return destroyAnswer ? destroyAnswer(id) : { httpStatus: 200, body: { status: 'ok' } };
    },
  };
  const slots = createSlots({
    state, cfg, ports, transport, onTransportFailure: (err, slot) => out.failures.push([err, slot]), wake: () => { out.woke += 1; },
  });
  return { clock, cfg, state, out, timers, slots };
}

const confirm = (slot, id, status = 'idle') => Object.assign(slot, { id, confirmed: true, solverUrl: URL_A, status });

test('a new slot is registered, numbered, and starts the one idle timer', () => {
  const { cfg, state, timers, slots } = makeSlots();
  const first = slots.newSlot();
  const second = slots.newSlot();
  assert.deepEqual([first.key, second.key], [1, 2]);
  assert.equal(first.status, 'opening');
  assert.equal(first.confirmed, false);
  assert.equal(first.dead, false);
  assert.deepEqual([...state.slots.keys()], [1, 2]);
  assert.equal(timers.length, 1, 'one timer for any number of slots');
  assert.equal(timers[0].ms, Math.min(cfg.idleTickMs, state.idleMs / 2));
});

test('no idle timer exists while the pool is switched off', () => {
  const { timers, slots } = makeSlots({ enabled: false });
  slots.newSlot();
  assert.equal(timers.length, 0);
});

test('closing a slot marks it closing BEFORE the destroy is sent, so nothing can be handed the id', async () => {
  const { state, out, slots } = makeSlots();
  const slot = confirm(slots.newSlot(), 'ss-1-a-1');
  const closing = slots.closeSlot(slot, 'idle');

  assert.equal(slot.status, 'closing');
  assert.deepEqual(out.destroyed.map((d) => d.statuses), [['closing']], 'already closing when the request went out');
  assert.deepEqual(slots.liveSlots(), [], 'a closing slot no longer counts');
  assert.equal(state.slots.size, 1, 'but it is not forgotten until the destroy is over');

  await closing;
  assert.equal(state.slots.size, 0);
  assert.deepEqual(out.destroyed.map((d) => [d.solverUrl, d.id]), [[URL_A, 'ss-1-a-1']]);
  assert.ok(out.woke >= 1, 'the scheduler is told a place is free');
});

test('closing is idempotent, counts a recycle only for a reason that is not a retirement, and skips the destroy for an unconfirmed slot', async () => {
  const { state, out, slots } = makeSlots();
  const slot = confirm(slots.newSlot(), 'ss-1-a-1');
  const first = slots.closeSlot(slot, 'error');
  assert.equal(slots.closeSlot(slot, 'error'), first, 'the same promise');
  await first;
  assert.equal(out.destroyed.length, 1);
  assert.equal(state.counters.recycles, 1);

  const retired = confirm(slots.newSlot(), 'ss-1-a-2');
  await slots.closeSlot(retired, 'idle');
  assert.equal(state.counters.recycles, 1, 'an idle close is a retirement, not a recycle');

  const unconfirmed = slots.newSlot();
  await slots.closeSlot(unconfirmed, 'error');
  assert.equal(out.destroyed.length, 2, 'nothing is known to exist, so nothing is destroyed');
  assert.equal(state.slots.size, 0);
});

test('a destroy: "already gone" is success, an unexpected answer is said once, a failed request is reported', async () => {
  const answers = [
    { httpStatus: 500, body: { status: 'error', message: "Error: The session doesn't exist." } },
    { httpStatus: 500, body: { status: 'error', message: 'something else broke' } },
    { httpStatus: 500, body: { status: 'error', message: 'something else broke' } },
  ];
  const { out, slots } = makeSlots({ destroyAnswer: () => answers.shift() });
  await slots.destroyRemote({ id: 'a', solverUrl: URL_A });
  assert.deepEqual(out.warns, []);
  await slots.destroyRemote({ id: 'b', solverUrl: URL_A });
  await slots.destroyRemote({ id: 'c', solverUrl: URL_A });
  assert.equal(out.warns.length, 1, 'said once');
  assert.match(out.warns[0], /refused to close a session/);
});

test('a destroy that fails to reach FlareSolverr is reported; only a timeout asks for the solver to be recovered', async () => {
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  const refused = new TypeError('fetch failed');
  const queue = [{ transport: timeout }, { transport: refused }];
  const { out, slots } = makeSlots({ destroyAnswer: () => queue.shift() });
  await slots.destroyRemote({ id: 'a', solverUrl: URL_A });
  assert.deepEqual(out.failures, [[timeout, null]]);
  assert.equal(out.recovered, 1);
  await slots.destroyRemote({ id: 'b', solverUrl: URL_A });
  assert.deepEqual(out.failures.map(([err]) => err), [timeout, refused]);
  assert.equal(out.recovered, 1, 'a refused connection does not');
});

test('dropping a slot forgets it without telling FlareSolverr, and the site loses its claim on it', () => {
  const { state, out, slots } = makeSlots();
  const slot = confirm(slots.newSlot(), 'ss-1-a-1', 'busy');
  state.affinity.set('cf-site.example', slot);
  let empty = 0;
  state.emptyWaiters.push(() => { empty += 1; });

  slots.dropSlot(slot);
  assert.equal(slot.dead, true);
  assert.equal(state.slots.size, 0);
  assert.equal(state.affinity.size, 0);
  assert.equal(empty, 1, 'whoever waits for the last slot to go is told');
  assert.deepEqual(out.destroyed, []);
});

test('closeAll retires the idle slots now and a busy one when its job ends', async () => {
  const { state, out, slots } = makeSlots();
  const idle = confirm(slots.newSlot(), 'ss-1-a-1', 'idle');
  const busy = confirm(slots.newSlot(), 'ss-1-a-2', 'busy');
  await slots.closeAll('disabled');
  assert.equal(idle.status, 'closing');
  assert.equal(busy.status, 'busy');
  assert.equal(busy.closeAfter, 'disabled');
  assert.deepEqual(out.destroyed.map((d) => d.id), ['ss-1-a-1']);
  assert.deepEqual([...state.slots.keys()], [busy.key]);
});

test('abandoning every slot (a restart) destroys nothing and trusts no old id', () => {
  const { state, out, slots } = makeSlots();
  const a = confirm(slots.newSlot(), 'ss-1-a-1');
  const b = confirm(slots.newSlot(), 'ss-1-a-2', 'busy');
  state.affinity.set('cf-site.example', a);
  slots.abandonAll();
  assert.deepEqual([a.dead, b.dead], [true, true]);
  assert.equal(state.slots.size, 0);
  assert.equal(state.affinity.size, 0);
  assert.deepEqual(out.destroyed, []);
});

test('the idle timer closes a slot nobody used for the idle time, and only an idle one with nothing waiting', async () => {
  const { clock, state, timers, out, slots } = makeSlots();
  const old = confirm(slots.newSlot(), 'ss-1-a-1', 'idle');
  const busy = confirm(slots.newSlot(), 'ss-1-a-2', 'busy');
  old.lastUsedAt = clock.t;
  busy.lastUsedAt = clock.t;

  clock.t += state.idleMs - 1;
  timers[0].fn();
  assert.equal(old.status, 'idle', 'not idle long enough');

  clock.t += 1;
  state.queue.push({ state: 'queued' });
  timers[0].fn();
  assert.equal(old.status, 'idle', 'work is waiting: keep the browser');
  state.queue.length = 0;
  timers[0].fn();
  assert.equal(old.status, 'closing');
  assert.equal(busy.status, 'busy', 'never a slot that is working');
  await tick();
  assert.deepEqual(out.destroyed.map((d) => d.id), ['ss-1-a-1']);
  assert.equal(timers.length, 1, 'still one timer while a slot exists');

  busy.status = 'idle';
  busy.lastUsedAt = clock.t - state.idleMs;
  timers[0].fn();
  await tick();
  assert.equal(state.slots.size, 0);
  assert.equal(timers.length, 0, 'no timer once there is nothing to watch');
});

test('a throwing idle check is reported once and does not stop the timer', () => {
  const { state, timers, out, slots } = makeSlots();
  slots.newSlot();
  Object.defineProperty(state, 'queue', { get() { throw new Error('queue broke'); } });
  timers[0].fn();
  timers[0].fn();
  assert.equal(out.warns.length, 1);
  assert.match(out.warns[0], /idle check failed: queue broke/);
  assert.equal(timers.length, 1);
});

test('closing a slot that went with a restart only forgets it: no destroy, and whoever waits for the last slot is told', async () => {
  const { state, out, slots } = makeSlots();
  const slot = confirm(slots.newSlot(), 'ss-1-a-1');
  slot.dead = true;
  let empty = 0;
  state.emptyWaiters.push(() => { empty += 1; });

  await slots.closeSlot(slot, 'idle');
  assert.equal(state.slots.size, 0);
  assert.deepEqual(out.destroyed, []);
  assert.equal(empty, 1);
  assert.equal(slot.closing, null, 'there was no destroy to wait for');
});

test('a destroy that throws is reported once and the slot is forgotten all the same', async () => {
  const { state, out, slots } = makeSlots({ destroyAnswer: () => { throw new Error('destroy broke'); } });
  const first = confirm(slots.newSlot(), 'ss-1-a-1');
  const second = confirm(slots.newSlot(), 'ss-1-a-2');
  await slots.closeSlot(first, 'error');
  await slots.closeSlot(second, 'error');
  assert.equal(state.slots.size, 0);
  assert.equal(out.warns.length, 1, 'said once');
  assert.match(out.warns[0], /Closing a session failed: destroy broke/);
});

test('closing with no reason named still says why in the log: "closed", never "undefined", and it is not counted as a recycle', async () => {
  const { state, out, slots } = makeSlots();
  const idle = confirm(slots.newSlot(), 'ss-1-a-1');
  const busy = confirm(slots.newSlot(), 'ss-1-a-2', 'busy');
  await slots.closeAll(); // the public pool.closeAll() names no reason
  assert.equal(busy.closeAfter, 'closed');
  await slots.closeSlot(busy, busy.closeAfter);
  await slots.closeSlot(confirm(slots.newSlot(), 'ss-1-a-3'), undefined);

  assert.deepEqual(out.logs.filter((line) => /Session #/.test(line)), [
    '[SolverPool] Session #1 closed (closed).',
    '[SolverPool] Session #2 closed (closed).',
    '[SolverPool] Session #3 recycled (unspecified).',
  ]);
  assert.ok(out.logs.every((line) => !/undefined/.test(line)));
  assert.equal(state.counters.recycles, 1, 'only the call that really named no reason at all counts as a recycle');
  assert.equal(idle.status, 'closing');
});
