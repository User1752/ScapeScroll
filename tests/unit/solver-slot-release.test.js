'use strict';

// server/modules/network/solver/slot-release.js: what happens to a slot once its job has been
// answered. The transport answers from a script, the slots are a recorder, and the state is the
// real one; every refusal and race of the blank reset is driven from here.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { createSlotRelease } = require('../../server/modules/network/solver/slot-release');

const OK = { httpStatus: 200, body: { status: 'ok' } };
const errorAnswer = (message) => ({ httpStatus: 500, body: { status: 'error', message } });

function makeEnv(config = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, { blankResetSettleMs: 1, ...config });
  const state = createPoolState(cfg);
  state.enabled = true;
  state.maxSessions = 5; // room for the several slots a test makes; the tests about a smaller pool lower it
  const out = { requested: [], closed: [], dropped: [], failures: [], woke: 0, warns: [] };
  // What requestInSession answers, in order: an answer, an Error to throw, or a function of the slot.
  const script = [];
  script.closeFails = false;
  const ports = createPorts({
    now: () => clock.t,
    // A real timer that keeps the process alive: the test is waiting on it.
    setTimer: (fn, ms) => ({ id: setTimeout(fn, ms) }),
    clearTimer: (handle) => clearTimeout(handle.id),
    log: () => {},
    warn: (m) => out.warns.push(m),
  }, state);
  const live = [];
  const slots = {
    liveSlots: () => live.filter((s) => s.status !== 'closing'),
    closeSlot: async (slot, reason) => {
      out.closed.push([slot.key, reason]);
      slot.status = 'closing';
      if (script.closeFails) throw new Error('destroy broke');
    },
    dropSlot: (slot) => { out.dropped.push(slot.key); slot.dead = true; },
  };
  const transport = {
    requestInSession: async (slot, url, maxTimeout, timeoutMs) => {
      out.requested.push({ url, maxTimeout, timeoutMs, status: slot.status });
      const next = script.length ? script.shift() : OK;
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(slot) : next;
    },
  };
  const release = createSlotRelease({
    state, cfg, ports, transport, slots, onTransportFailure: (err, slot) => out.failures.push([err, slot]), wake: () => { out.woke += 1; },
  });
  const slot = (over = {}) => {
    const made = {
      key: live.length + 1, id: `ss-1-a-${live.length + 1}`, status: 'busy', confirmed: true, dead: false, closeAfter: null, lastUsedAt: 0, lastOkAt: 0, ...over,
    };
    live.push(made);
    return made;
  };
  return { clock, cfg, state, out, script, release, slot };
}

const urls = (env) => env.out.requested.map((r) => r.url);

test('a kept session is parked on a blank page and handed back idle, with the time it was last used', async () => {
  const env = makeEnv();
  const slot = env.slot();
  env.clock.t += 5000;
  await env.release.releaseSlot(slot, 'keep');

  assert.deepEqual(urls(env), ['about:blank']);
  assert.equal(env.out.requested[0].status, 'resetting', 'while the page is loading the slot is not up for grabs');
  assert.equal(env.out.requested[0].maxTimeout, env.cfg.blankResetMaxTimeoutMs);
  assert.equal(env.out.requested[0].timeoutMs, env.cfg.blankResetMaxTimeoutMs + env.cfg.blankResetAbortGraceMs);
  assert.equal(slot.status, 'idle');
  assert.equal(slot.lastUsedAt, env.clock.t);
  assert.equal(slot.lastOkAt, env.clock.t);
  assert.equal(env.state.counters.resets, 1);
  assert.ok(env.out.woke >= 1, 'the scheduler is told a slot is free');
});

test('the second blank page is tried when the first is refused, and a success forgets earlier failures', async () => {
  const env = makeEnv();
  env.state.blankFailures = 2;
  env.script.push(errorAnswer('Error: about:blank is not allowed'));
  const slot = env.slot();
  await env.release.releaseSlot(slot, 'keep');
  assert.deepEqual(urls(env), ['about:blank', 'data:text/html,']);
  assert.equal(slot.status, 'idle');
  assert.equal(env.state.blankFailures, 0);
});

// What FlareSolverr says when it will not load a blank page at all.
const BLAMES_THE_PAGE = 'Error: unknown error: invalid argument: about:blank is not allowed';

test('a reset the page is blamed for closes the session, and three in a row make every later session recycle after use', async () => {
  const env = makeEnv();
  for (let i = 1; i <= 3; i += 1) {
    env.script.push(errorAnswer(BLAMES_THE_PAGE), errorAnswer(BLAMES_THE_PAGE));
    const slot = env.slot();
    await env.release.releaseSlot(slot, 'keep');
    assert.equal(env.state.blankFailures, i);
    assert.equal(slot.status, 'closing');
  }
  assert.deepEqual(env.out.closed.map(([, reason]) => reason), ['reset-failed', 'reset-failed', 'reset-failed']);
  assert.equal(env.state.blankUnsupported, true);
  assert.equal(env.out.warns.filter((m) => /cannot park a session on a blank page/.test(m)).length, 1, 'said once');

  const requestsBefore = env.out.requested.length;
  const next = env.slot();
  await env.release.releaseSlot(next, 'keep');
  assert.equal(env.out.requested.length, requestsBefore, 'no reset is attempted any more');
  assert.deepEqual(env.out.closed.at(-1), [next.key, 'blank-unsupported']);
});

test('a browser that is broken is an ordinary recycle: whatever the blank page, it is never counted against it', async () => {
  // Chrome crashing three times in a row inside sessions must not turn warm sessions off for the rest of the process.
  const env = makeEnv();
  const browserFailures = [
    'Error: invalid session id',
    'Error starting Chrome: PermissionError',
    'Error solving the challenge. Timeout after 10.0 seconds.',
    'Error: unknown error: net::ERR_PROXY_CONNECTION_FAILED',
    'Error: no',
    'Error: chrome not reachable',
  ];
  for (const message of browserFailures) {
    env.script.push(errorAnswer(message), errorAnswer(message));
    const slot = env.slot();
    await env.release.releaseSlot(slot, 'keep');
    assert.equal(slot.status, 'closing', message);
  }
  assert.deepEqual(env.out.closed.map(([, reason]) => reason), browserFailures.map(() => 'reset-failed'));
  assert.equal(env.state.blankFailures, 0);
  assert.equal(env.state.blankUnsupported, false);
  assert.deepEqual(env.out.warns, []);

  // One failure that blames the page and one that blames the browser: the browser's is the likelier culprit, so nothing is counted.
  env.script.push(errorAnswer(BLAMES_THE_PAGE), errorAnswer('Error: invalid session id'));
  await env.release.releaseSlot(env.slot(), 'keep');
  assert.equal(env.state.blankFailures, 0);

  // And a session that is parked fine afterwards is still just a session that is parked.
  const fine = env.slot();
  await env.release.releaseSlot(fine, 'keep');
  assert.equal(fine.status, 'idle');
});

test('a reset the transport refuses to send closes the session without counting against the blank page', async () => {
  const env = makeEnv();
  env.script.push({ refused: true });
  const slot = env.slot();
  await env.release.releaseSlot(slot, 'keep');
  assert.deepEqual(urls(env), ['about:blank'], 'refused is final: the other blank page is not tried');
  assert.deepEqual(env.out.closed, [[slot.key, 'reset-failed']]);
  assert.equal(env.state.blankFailures, 0, 'the session was at fault, not the page');
});

test('a solver that does not answer during the reset is reported and the session goes back to the pool to be checked before its next use', async () => {
  const env = makeEnv();
  const silent = new TypeError('fetch failed');
  env.script.push({ transport: silent });
  const slot = env.slot();
  await env.release.releaseSlot(slot, 'keep');
  assert.deepEqual(env.out.failures, [[silent, slot]]);
  assert.equal(slot.status, 'idle');
  assert.deepEqual(env.out.closed, []);
  assert.equal(env.state.blankFailures, 0);
});

test('a slot that went with a restart during the reset is left alone', async () => {
  const env = makeEnv();
  env.script.push((slot) => { slot.dead = true; return OK; });
  const slot = env.slot();
  await env.release.releaseSlot(slot, 'keep');
  assert.equal(slot.status, 'resetting', 'nothing more is done to a dead slot');
  assert.deepEqual(env.out.closed, []);
  assert.equal(env.state.blankFailures, 0);
});

test('after a timeout the browser gets a moment, then a blank page: if it answers it is kept, if not it is closed without blaming the page', async () => {
  const env = makeEnv();
  const kept = env.slot();
  await env.release.releaseSlot(kept, 'probe');
  assert.equal(kept.status, 'idle');

  // The text a kept session's reset would be counted for (BLAMES_THE_PAGE): only that it is a probe keeps it from counting.
  env.script.push(errorAnswer(BLAMES_THE_PAGE), errorAnswer(BLAMES_THE_PAGE));
  const lost = env.slot();
  await env.release.releaseSlot(lost, 'probe');
  assert.deepEqual(env.out.closed, [[lost.key, 'reset-failed']]);
  assert.equal(env.state.blankFailures, 0, 'a probe failing says nothing about whether this FlareSolverr can park a session');

  const dying = env.slot();
  const pending = env.release.releaseSlot(dying, 'probe');
  dying.dead = true;
  await pending;
  assert.equal(dying.status, 'busy', 'a restart during the settle time: nothing is sent for it');
  assert.equal(env.out.requested.length, 3, 'one blank page for the first slot, two for the second, none for the third');
});

test('recycling closes the session with the reason it was given; with none it says "recycle"', async () => {
  const env = makeEnv();
  const a = env.slot();
  const b = env.slot();
  await env.release.releaseSlot(a, 'recycle', 'driver');
  await env.release.releaseSlot(b, 'recycle');
  assert.deepEqual(env.out.closed, [[a.key, 'driver'], [b.key, 'recycle']]);
  assert.deepEqual(env.out.requested, []);
});

test('when the solver did not answer nothing is sent: the slot is idle again and will be checked before its next use', async () => {
  for (const action of ['suspect', 'invalidate']) {
    const env = makeEnv();
    const slot = env.slot();
    await env.release.releaseSlot(slot, action);
    assert.equal(slot.status, 'idle', action);
    assert.deepEqual(env.out.requested, [], action);
  }
});

test('a slot told to go is closed for that reason as soon as its job ends, whichever way the job ended', async () => {
  const env = makeEnv();
  const parked = env.slot({ closeAfter: 'disabled' });
  await env.release.releaseSlot(parked, 'keep');
  const suspect = env.slot({ closeAfter: 'shutdown' });
  await env.release.releaseSlot(suspect, 'suspect');
  assert.deepEqual(env.out.closed, [[parked.key, 'disabled'], [suspect.key, 'shutdown']]);
  assert.deepEqual(env.out.requested, [], 'no page is loaded in a browser that is about to go');
});

test('a pool that shrank is not left with the extra session: closed at once when kept, or after a job that ended without a reset', async () => {
  const env = makeEnv();
  env.state.maxSessions = 1;
  const stays = env.slot();
  const extra = env.slot();
  await env.release.releaseSlot(extra, 'keep');
  assert.deepEqual(env.out.closed, [[extra.key, 'resized']]);
  assert.deepEqual(env.out.requested, [], 'closed without a blank page');

  const other = env.slot();
  await env.release.releaseSlot(other, 'suspect');
  assert.deepEqual(env.out.closed.at(-1), [other.key, 'resized']);
  assert.equal(stays.status, 'busy');
});

test('a pool that shrank while the blank page was loading closes the session when it comes back', async () => {
  const env = makeEnv();
  env.slot();
  env.state.maxSessions = 2;
  env.script.push(() => { env.state.maxSessions = 1; return OK; });
  const second = env.slot();
  await env.release.releaseSlot(second, 'keep');
  assert.deepEqual(env.out.closed, [[second.key, 'resized']]);
  assert.equal(env.state.blankFailures, 0);
});

test('a session nobody has seen confirmed is dropped, not destroyed; a dead one is left alone', async () => {
  const env = makeEnv();
  const unconfirmed = env.slot({ confirmed: false });
  await env.release.releaseSlot(unconfirmed, 'keep');
  assert.deepEqual(env.out.dropped, [unconfirmed.key]);

  const dead = env.slot({ dead: true });
  await env.release.releaseSlot(dead, 'recycle');
  assert.deepEqual(env.out.closed, []);
  assert.deepEqual(env.out.requested, []);
});

test('whatever goes wrong while releasing a session closes it, is said once, and still wakes the scheduler', async () => {
  const env = makeEnv();
  env.script.push(new Error('transport blew up'), new Error('transport blew up'));
  const first = env.slot();
  const second = env.slot();
  const wokeBefore = env.out.woke;
  await env.release.releaseSlot(first, 'keep');
  await env.release.releaseSlot(second, 'keep');
  assert.deepEqual(env.out.closed, [[first.key, 'error'], [second.key, 'error']]);
  assert.equal(env.out.warns.filter((m) => /Releasing a session failed: transport blew up/.test(m)).length, 1, 'said once');
  assert.equal(env.out.woke - wokeBefore, 2, 'a release always ends by waking the scheduler');
});

test('a close that fails after the job was answered is left to the slot registry: nothing is unhandled here', async () => {
  const env = makeEnv();
  env.script.closeFails = true;
  env.state.maxSessions = 1;
  const told = env.slot({ closeAfter: 'disabled' });
  env.slot(); // the one that stays
  const extra = env.slot();
  await env.release.releaseSlot(told, 'suspect');
  await env.release.releaseSlot(extra, 'suspect');
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(env.out.closed.map(([, reason]) => reason), ['disabled', 'resized']);
  assert.deepEqual(env.out.warns, [], 'the slot registry reports a failed destroy, not the release');
});
