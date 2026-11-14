'use strict';

// server/modules/network/solver/sessions.js: making sure a slot holds a session this
// process has SEEN. The transport answers from a script, the slots are a recorder, and
// the launch lock and the circuit are the real ones.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { createCircuit } = require('../../server/modules/network/solver/circuit');
const { createLaunchLock } = require('../../server/modules/network/solver/launch-lock');
const { createSessions } = require('../../server/modules/network/solver/sessions');
const { parseSessionId } = require('../../server/modules/network/solver/session-id');

const SOLVER = 'http://127.0.0.1:8191/v1';
const OK = { httpStatus: 200, body: { status: 'ok', message: 'Session created successfully.' } };
const ALREADY = { httpStatus: 200, body: { status: 'ok', message: 'Session already exists.' } };
const errorAnswer = (message) => ({ httpStatus: 500, body: { status: 'error', message } });

function makeEnv(config = {}) {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, { launchRetryDelayMs: 1, ...config });
  const state = createPoolState(cfg);
  state.maxSessions = 2;
  const out = { creates: [], lists: [], destroyed: [], closedOthers: 0, logs: [], warns: [], recorded: [] };
  const scripts = { create: [], list: [] };
  const ports = createPorts({
    now: () => clock.t,
    // A real timer that keeps the process alive: the test is waiting on it.
    setTimer: (fn, ms) => ({ id: setTimeout(fn, ms) }),
    clearTimer: (handle) => clearTimeout(handle.id),
    log: (m) => out.logs.push(m),
    warn: (m) => out.warns.push(m),
    recordError: async (e) => { out.recorded.push(e); },
  }, state);
  const transport = {
    createSession: async (solverUrl, id, proxy) => { out.creates.push({ solverUrl, id, proxy }); return scripts.create.length ? scripts.create.shift() : OK; },
    listSessions: async (solverUrl) => { out.lists.push(solverUrl); return scripts.list.shift(); },
  };
  const slots = {
    destroyRemote: async (target) => { out.destroyed.push(target); },
    closeOtherIdleSlots: async () => { out.closedOthers += 1; },
    liveSlots: () => [{}],
  };
  const circuit = createCircuit({ cfg, ports });
  const sessions = createSessions({
    state, cfg, ports, pid: 4242, startTag: 'tag1', transport, slots, launchLock: createLaunchLock({ onFree: () => {} }), circuit,
  });
  return { clock, cfg, state, out, scripts, circuit, sessions };
}

const newSlot = (over = {}) => ({
  key: 1, id: null, status: 'opening', solverUrl: null, fingerprint: null, proxyMode: 'none', createdAt: 0, lastUsedAt: 0, lastOkAt: 0, uses: 0, confirmed: false, otherFailures: 0, suspect: false, dead: false, ...over,
});
const job = { solverUrl: SOLVER };
const noProxy = { proxy: null, mode: 'none', fingerprint: 'none' };
const userProxy = { proxy: { url: 'http://127.0.0.1:3128' }, mode: 'user-proxy', fingerprint: 'user:abcd1234' };

test('a session is recycled between jobs for the first reason that applies, and never before it was confirmed', () => {
  const { clock, cfg, sessions } = makeEnv();
  const live = (over) => newSlot({
    confirmed: true, solverUrl: SOLVER, fingerprint: 'none', createdAt: clock.t, uses: 0, ...over,
  });
  assert.equal(sessions.recycleReason(newSlot({ suspect: true }), SOLVER, noProxy), null, 'nothing to recycle');
  assert.equal(sessions.recycleReason(live(), SOLVER, noProxy), null);
  assert.equal(sessions.recycleReason(live({ suspect: true }), SOLVER, noProxy), 'suspect');
  assert.equal(sessions.recycleReason(live(), 'http://other:8191/v1', noProxy), 'solver-url');
  assert.equal(sessions.recycleReason(live(), SOLVER, userProxy), 'proxy-changed');
  assert.equal(sessions.recycleReason(live({ createdAt: clock.t - cfg.maxSessionAgeMs }), SOLVER, noProxy), null, 'exactly the age is still fine');
  assert.equal(sessions.recycleReason(live({ createdAt: clock.t - cfg.maxSessionAgeMs - 1 }), SOLVER, noProxy), 'age');
  assert.equal(sessions.recycleReason(live({ uses: cfg.maxSessionUses }), SOLVER, noProxy), 'uses');
  assert.equal(sessions.recycleReason(live({ uses: cfg.maxSessionUses - 1 }), SOLVER, noProxy), null);
});

test('recycling forgets the session and destroys it where it was created', async () => {
  const { state, out, sessions } = makeEnv();
  const slot = newSlot({ id: 'ss-1-a-1', confirmed: true, solverUrl: 'http://old:8191/v1' });
  await sessions.recycleSlot(slot, 'age');
  assert.equal(slot.confirmed, false);
  assert.deepEqual(out.destroyed, [{ id: 'ss-1-a-1', solverUrl: 'http://old:8191/v1' }]);
  assert.equal(state.counters.recycles, 1);
});

test('a session is created under a fresh id, with the proxy, and the slot adopts it', async () => {
  const { clock, state, out, sessions } = makeEnv();
  const slot = newSlot();
  const first = await sessions.confirmSession(slot, job, userProxy);
  assert.deepEqual(first, { ok: true });
  assert.equal(out.creates.length, 1);
  assert.deepEqual(out.creates[0].proxy, userProxy.proxy);
  assert.deepEqual(parseSessionId(out.creates[0].id), { pid: 4242, tag: 'tag1', n: 1 });
  assert.deepEqual(
    [slot.confirmed, slot.id, slot.solverUrl, slot.fingerprint, slot.proxyMode, slot.createdAt, slot.lastOkAt, slot.uses, slot.status],
    [true, out.creates[0].id, SOLVER, 'user:abcd1234', 'user-proxy', clock.t, clock.t, 0, 'busy'],
  );
  assert.ok(out.logs.some((m) => /Session #1 opened \(1 of 2\)/.test(m)));
  assert.equal(state.sessionsUnsupported, false);

  // Recreated after a recycle: a new id every time, so "already exists" can never be taken for a fresh session.
  slot.confirmed = false;
  await sessions.confirmSession(slot, job, noProxy);
  assert.deepEqual(parseSessionId(out.creates[1].id).n, 2);
  assert.equal(out.creates[1].proxy, null);
  assert.notEqual(out.creates[0].id, out.creates[1].id);
});

test('a session the slot already has is only listed when it is old enough, or when a proxy is in use', async () => {
  const { clock, cfg, out, scripts, sessions } = makeEnv();
  const slot = newSlot({ id: 'ss-1-a-1', confirmed: true, solverUrl: SOLVER, lastOkAt: clock.t });
  assert.deepEqual(await sessions.confirmSession(slot, job, noProxy), { ok: true });
  assert.deepEqual(out.lists, [], 'an answer a moment ago is trusted');

  // With a proxy the list is never skipped: an unannounced restart would otherwise hand the job an unproxied session.
  scripts.list.push({ httpStatus: 200, body: { status: 'ok', sessions: ['ss-1-a-1'] } });
  assert.deepEqual(await sessions.confirmSession(slot, job, userProxy), { ok: true });
  assert.equal(out.lists.length, 1);

  clock.t += cfg.verifySkipWithinMs;
  scripts.list.push({ httpStatus: 200, body: { status: 'ok', sessions: ['ss-1-a-1'] } });
  assert.deepEqual(await sessions.confirmSession(slot, job, noProxy), { ok: true });
  assert.equal(out.lists.length, 2);
  assert.equal(slot.lastOkAt, clock.t, 'confirmed again');
});

test('a session FlareSolverr no longer lists is replaced; one it cannot list is also destroyed, in case it is still there', async () => {
  const { clock, cfg, out, scripts, sessions } = makeEnv();
  const slot = newSlot({ id: 'ss-1-a-1', confirmed: true, solverUrl: SOLVER, lastOkAt: clock.t - cfg.verifySkipWithinMs });
  scripts.list.push({ httpStatus: 200, body: { status: 'ok', sessions: ['someone-elses'] } });
  assert.deepEqual(await sessions.confirmSession(slot, job, noProxy), { ok: true });
  assert.deepEqual(out.destroyed, [], 'a list that works and lacks the id: nothing to destroy');
  assert.equal(out.creates.length, 1);
  assert.notEqual(slot.id, 'ss-1-a-1');

  const second = newSlot({ id: 'ss-1-a-9', confirmed: true, solverUrl: SOLVER, lastOkAt: 0 });
  scripts.list.push(errorAnswer('Error: cannot tell'));
  assert.deepEqual(await sessions.confirmSession(second, job, noProxy), { ok: true });
  assert.deepEqual(out.destroyed, [{ id: 'ss-1-a-9', solverUrl: SOLVER }]);
});

test('a list that fails to arrive is the raw error; a slot that went with a restart meanwhile sends the job back', async () => {
  const { out, scripts, sessions } = makeEnv();
  const refused = new TypeError('fetch failed');
  scripts.list.push({ transport: refused });
  const a = await sessions.confirmSession(newSlot({ id: 'x', confirmed: true, solverUrl: SOLVER }), job, userProxy);
  assert.equal(a.transport, refused);
  assert.equal(out.creates.length, 0);

  const dying = newSlot({ id: 'x', confirmed: true, solverUrl: SOLVER });
  scripts.list.push({ httpStatus: 200, body: { status: 'ok', sessions: [] } });
  const pending = sessions.confirmSession(dying, job, userProxy);
  dying.dead = true;
  assert.deepEqual(await pending, { restart: true });
});

test('a create that never arrives is the raw error, and a slot that died or a pool that closed while waiting for the lock starts nothing', async () => {
  const { state, out, scripts, sessions } = makeEnv();
  const refused = new TypeError('fetch failed');
  scripts.create.push({ transport: refused });
  const failed = newSlot();
  const result = await sessions.confirmSession(failed, job, noProxy);
  assert.equal(result.transport, refused);
  assert.equal(failed.confirmed, false, 'never confirmed, so nothing will be destroyed for it');

  const dead = newSlot({ dead: true });
  assert.deepEqual(await sessions.confirmSession(dead, job, noProxy), { restart: true });
  state.shuttingDown = true;
  assert.deepEqual(await sessions.confirmSession(newSlot(), job, noProxy), { restart: true });
  assert.equal(out.creates.length, 1, 'only the first create was sent');
});

test('a FlareSolverr without sessions: one-off browsers from now on, and the circuit hears of it', async () => {
  const { clock, state, out, scripts, circuit, sessions } = makeEnv();
  scripts.create.push(errorAnswer("Request parameter 'cmd' = 'sessions.create' is invalid"));
  assert.deepEqual(await sessions.confirmSession(newSlot(), job, noProxy), { fallback: true });
  assert.equal(state.sessionsUnsupported, true);
  assert.ok(out.warns.some((m) => /does not support browser sessions/.test(m)));
  assert.equal(circuit.isOpen(clock.t), false, 'one failure is not three');
});

test('an id that already exists was not created by us: it is removed and the job runs without a session', async () => {
  const { out, scripts, sessions } = makeEnv();
  scripts.create.push(ALREADY);
  const slot = newSlot();
  assert.deepEqual(await sessions.confirmSession(slot, job, userProxy), { fallback: true });
  assert.deepEqual(out.destroyed, [{ id: out.creates[0].id, solverUrl: SOLVER }]);
  assert.equal(slot.confirmed, false);
});

test('a launch conflict closes the other idle browsers, waits, and tries once more; then the job runs without a session', async () => {
  const { clock, out, scripts, circuit, sessions } = makeEnv();
  scripts.create.push(errorAnswer('PermissionError: chromedriver.exe is locked'));
  assert.deepEqual(await sessions.confirmSession(newSlot(), job, noProxy), { ok: true });
  assert.equal(out.closedOthers, 1);
  assert.equal(out.creates.length, 2);
  assert.notEqual(out.creates[0].id, out.creates[1].id);

  scripts.create.push(errorAnswer('Error starting Chrome'), errorAnswer('Error starting Chrome'));
  assert.deepEqual(await sessions.confirmSession(newSlot({ key: 2 }), job, noProxy), { fallback: true });
  assert.equal(out.closedOthers, 2, 'only one retry per job');
  assert.equal(circuit.isOpen(clock.t), false);
  assert.ok(out.recorded.length === 0, 'one failure does not open it');
});

test('any other create error counts toward the circuit and the job runs without a session', async () => {
  const { clock, out, scripts, circuit, sessions } = makeEnv();
  for (let i = 0; i < 3; i += 1) {
    scripts.create.push(errorAnswer('Error: something odd'));
    assert.deepEqual(await sessions.confirmSession(newSlot({ key: i + 1 }), job, noProxy), { fallback: true });
  }
  assert.equal(circuit.isOpen(clock.t), true);
  assert.equal(out.recorded.length, 1);
});
