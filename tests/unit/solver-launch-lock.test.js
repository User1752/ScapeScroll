'use strict';

// server/modules/network/solver/launch-lock.js: one browser launch at a time.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLaunchLock } = require('../../server/modules/network/solver/launch-lock');

// A promise the code under test must settle. When a rule is broken it never does, and a test that
// waits for ever is worse than one that fails, so the wait is bounded.
function soon(promise, what, ms = 1000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what} was never answered` })), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

test('the lock is taken by one holder at a time and free again after its release', () => {
  let freed = 0;
  const lock = createLaunchLock({ onFree: () => { freed += 1; } });
  const release = lock.tryAcquire();
  assert.equal(typeof release, 'function');
  assert.equal(lock.tryAcquire(), null, 'taken');
  release();
  assert.equal(freed, 1, 'the scheduler is told, a one-off job may have been waiting');
  assert.equal(typeof lock.tryAcquire(), 'function');
});

test('waiters get the lock in order, and a hand-over does not announce that it is free', async () => {
  let freed = 0;
  const lock = createLaunchLock({ onFree: () => { freed += 1; } });
  const order = [];
  const first = lock.tryAcquire();
  const second = lock.acquire().then((release) => { order.push('second'); return release; });
  const third = lock.acquire().then((release) => { order.push('third'); return release; });
  await Promise.resolve();
  assert.deepEqual(order, [], 'nobody gets in while it is held');

  first();
  const secondRelease = await soon(second, 'the second holder');
  assert.deepEqual(order, ['second']);
  assert.equal(freed, 0, 'handed on, never free');
  assert.equal(lock.tryAcquire(), null);

  secondRelease();
  const thirdRelease = await soon(third, 'the third holder');
  assert.deepEqual(order, ['second', 'third']);
  thirdRelease();
  assert.equal(freed, 1);
});

test('acquire on a free lock resolves at once with a release function', async () => {
  const lock = createLaunchLock({ onFree: () => {} });
  const release = await soon(lock.acquire(), 'a free lock');
  assert.equal(lock.tryAcquire(), null);
  release();
  assert.equal(typeof lock.tryAcquire(), 'function');
});

test('a release function is idempotent: releasing twice cannot free a lock someone else now holds', async () => {
  let freed = 0;
  const lock = createLaunchLock({ onFree: () => { freed += 1; } });
  const first = lock.tryAcquire();
  const waiting = lock.acquire();
  first();
  const second = await soon(waiting, 'the waiting holder');
  first(); // a second release of the old holder must be a no-op
  assert.equal(lock.tryAcquire(), null, 'the new holder still has it');
  assert.equal(freed, 0);
  second();
  assert.equal(freed, 1);
});
