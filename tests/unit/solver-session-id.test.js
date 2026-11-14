'use strict';

// server/modules/network/solver/session-id.js: whose session is this?

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSessionId, parseSessionId, defaultIsPidAlive } = require('../../server/modules/network/solver/session-id');

test('an id carries the pid and a tag and parses back to exactly its parts', () => {
  const id = buildSessionId(4242, 'mvo272', 7);
  assert.equal(id, 'ss-4242-mvo272-7');
  assert.deepEqual(parseSessionId(id), { pid: 4242, tag: 'mvo272', n: 7 });
  assert.deepEqual(parseSessionId(buildSessionId(1, 'a0', 123456)), { pid: 1, tag: 'a0', n: 123456 });
});

test('the prefix is configurable and an id is only read with the prefix it was built with', () => {
  const id = buildSessionId(9, 'zz', 3, 'other-');
  assert.equal(id, 'other-9-zz-3');
  assert.deepEqual(parseSessionId(id, 'other-'), { pid: 9, tag: 'zz', n: 3 });
  assert.equal(parseSessionId(id), null);
});

test('an id that is not ours is never parsed, so the orphan sweep leaves it alone', () => {
  for (const foreign of [
    'my-session', 'ss-', 'ss-4242', 'ss-4242-abc', 'ss-4242-abc-', 'ss--abc-1', 'ss-abc-abc-1', 'ss-4242--1',
    'ss-4242-ABC-1', 'ss-4242-abc-1-2', 'xss-4242-abc-1', 'SS-4242-abc-1', 'ss-0-abc-1', 'ss-4242-a_c-1', ' ss-4242-abc-1',
    `ss-${'9'.repeat(30)}-abc-1`, 'ss-4242-abc-1\n', '', null, undefined, 42, {}, ['ss-4242-abc-1'],
  ]) {
    assert.equal(parseSessionId(foreign), null, JSON.stringify(foreign));
  }
});

test('liveness: signal 0 only checks; a process that exists but is someone else\'s is alive', (t) => {
  assert.equal(defaultIsPidAlive(process.pid), true);

  const realKill = process.kill;
  t.after(() => { process.kill = realKill; });
  const failWith = (code) => () => { throw Object.assign(new Error(code), { code }); };

  process.kill = failWith('ESRCH');
  assert.equal(defaultIsPidAlive(123456), false);
  process.kill = failWith('EPERM');
  assert.equal(defaultIsPidAlive(123456), true);
  // Any other failure does not prove the process is gone.
  process.kill = failWith('EINVAL');
  assert.equal(defaultIsPidAlive(123456), true);

  const seen = [];
  process.kill = (pid, signal) => { seen.push([pid, signal]); };
  assert.equal(defaultIsPidAlive(77), true);
  assert.deepEqual(seen, [[77, 0]], 'signal 0, which sends nothing');
});
