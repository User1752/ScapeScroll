'use strict';

// server/modules/network/solver/orphans.js: sessions left by a ScrollScape that was
// stopped hard. The transport is a script; liveness is a function the test supplies.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createPoolState } = require('../../server/modules/network/solver/pool-state');
const { createPorts } = require('../../server/modules/network/solver/ports');
const { createOrphanSweeper } = require('../../server/modules/network/solver/orphans');

const LOCAL = 'http://127.0.0.1:8191/v1';
const OWN_PID = 1000;
const OWN_TAG = 'own';
const ALIVE = 2000;

function makeEnv({ listed = { httpStatus: 200, body: { status: 'ok', sessions: [] } }, destroyAnswer = null } = {}) {
  const cfg = mergeConfig(POOL, {});
  const state = createPoolState(cfg);
  state.enabled = true;
  const out = { listed: [], destroyed: [], logs: [], warns: [] };
  const ports = createPorts({ log: (m) => out.logs.push(m), warn: (m) => out.warns.push(m) }, state);
  const transport = {
    listSessions: async (solverUrl) => { out.listed.push(solverUrl); return typeof listed === 'function' ? listed() : listed; },
    destroySession: async (solverUrl, id) => { out.destroyed.push(id); return destroyAnswer ? destroyAnswer(id) : { httpStatus: 200, body: { status: 'ok' } }; },
  };
  const { sweepOrphans } = createOrphanSweeper({ state, cfg, ports, transport, pid: OWN_PID, startTag: OWN_TAG, isPidAlive: (pid) => pid === ALIVE });
  return { state, out, sweepOrphans };
}

const sessionsAnswer = (...sessions) => ({ httpStatus: 200, body: { status: 'ok', sessions } });

test('only the sessions of dead ScrollScape processes are closed; ours, a live one\'s and anyone else\'s are left alone', async () => {
  const { state, out, sweepOrphans } = makeEnv({
    listed: sessionsAnswer('ss-3000-abc-1', 'ss-1000-own-2', 'ss-2000-abc-3', 'someone-elses', 'ss-4000-ABC-1', 'ss-notanumber-abc-1', 'xss-3000-abc-1', 'ss-5000-zz-9'),
  });
  assert.equal(await sweepOrphans(LOCAL), 2);
  assert.deepEqual(out.destroyed, ['ss-3000-abc-1', 'ss-5000-zz-9']);
  assert.equal(state.counters.orphansSwept, 2);
  assert.deepEqual(out.logs, ['[SolverPool] Closed 2 browser sessions left by an earlier run.']);
});

test('pids are reused: a session with this process\'s pid and another start tag is an earlier run\'s and is closed; one with its own tag never is', async () => {
  const { out, sweepOrphans } = makeEnv({
    listed: sessionsAnswer('ss-1000-old1-1', 'ss-1000-own-1', 'ss-1000-old2-7', 'ss-1000-own-2', 'ss-1000-OWN-3'),
  });
  assert.equal(await sweepOrphans(LOCAL), 2);
  assert.deepEqual(out.destroyed, ['ss-1000-old1-1', 'ss-1000-old2-7'], 'the pid is this process\'s, so liveness does not come into it: the tag does');
});

test('one session is "session", and nothing to close says nothing', async () => {
  const one = makeEnv({ listed: sessionsAnswer('ss-3000-abc-1') });
  assert.equal(await one.sweepOrphans(LOCAL), 1);
  assert.match(one.out.logs[0], /Closed 1 browser session left/);

  const none = makeEnv();
  assert.equal(await none.sweepOrphans(LOCAL), 0);
  assert.deepEqual(none.out.logs, []);
});

test('a session that could not be closed is not counted', async () => {
  const { out, sweepOrphans } = makeEnv({
    listed: sessionsAnswer('ss-3000-abc-1', 'ss-3000-abc-2'),
    destroyAnswer: (id) => (id.endsWith('-1') ? { transport: new TypeError('fetch failed') } : { httpStatus: 200, body: { status: 'ok' } }),
  });
  assert.equal(await sweepOrphans(LOCAL), 1);
  assert.deepEqual(out.destroyed, ['ss-3000-abc-1', 'ss-3000-abc-2'], 'it carries on with the next one');
});

test('it does not even ask while the pool is off, closing or restarting, or for a solver that is not on this computer', async () => {
  for (const [label, change] of [
    ['off', (s) => { s.enabled = false; }],
    ['closing', (s) => { s.shuttingDown = true; }],
    ['restarting', (s) => { s.restarting = true; }],
  ]) {
    const { state, out, sweepOrphans } = makeEnv({ listed: sessionsAnswer('ss-3000-abc-1') });
    change(state);
    assert.equal(await sweepOrphans(LOCAL), 0, label);
    assert.deepEqual(out.listed, [], label);
  }
  const { out, sweepOrphans } = makeEnv({ listed: sessionsAnswer('ss-3000-abc-1') });
  for (const remote of ['http://192.168.1.20:8191/v1', 'http://flaresolverr.example:8191/v1', 'http://127.0.0.1.evil.example/v1']) {
    assert.equal(await sweepOrphans(remote), 0, remote);
  }
  assert.deepEqual(out.listed, []);
});

test('every failure is swallowed: a refused connection, a refusal, a list that is not a list, an exception', async () => {
  const cases = [
    { transport: new TypeError('fetch failed') },
    { httpStatus: 500, body: { status: 'error', message: 'no' } },
    { httpStatus: 200, body: { status: 'ok' } },
    { httpStatus: 200, body: { status: 'ok', sessions: 'ss-3000-abc-1' } },
  ];
  for (const listed of cases) {
    const { out, sweepOrphans } = makeEnv({ listed });
    assert.equal(await sweepOrphans(LOCAL), 0);
    assert.deepEqual(out.destroyed, []);
    assert.deepEqual(out.warns, [], 'a solver that is not up yet is not worth a warning');
  }

  const broken = makeEnv({ listed: () => { throw new Error('transport broke'); } });
  assert.equal(await broken.sweepOrphans(LOCAL), 0);
  assert.equal(broken.out.warns.length, 1);
  assert.match(broken.out.warns[0], /orphan sweep failed: transport broke/);
});
