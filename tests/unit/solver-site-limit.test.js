'use strict';

// server/modules/network/solver/site-limit.js: how many FlareSolverr requests one site may have in flight at a time
// when the pool is off (solver/passthrough.js). Pure promises: no clock, no timer, no I/O.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSiteLimit } = require('../../server/modules/network/solver/site-limit');

// Resolves with what the promise settles to, or with 'pending' if it has not settled after the microtasks have run.
async function state(promise) {
  let seen = 'pending';
  promise.then(() => { seen = 'granted'; }, () => { seen = 'failed'; });
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  return seen;
}

test('up to the limit are let in at once, the rest wait, and the first to leave lets the first in line in', async () => {
  const limit = createSiteLimit(2);
  const first = await limit.acquire('a.example');
  const second = await limit.acquire('a.example');
  const third = limit.acquire('a.example');
  const fourth = limit.acquire('a.example');
  assert.equal(await state(third), 'pending');
  assert.equal(await state(fourth), 'pending');
  assert.deepEqual(limit.counts(), { sites: 1, active: 2, waiting: 2 });

  first();
  assert.equal(await state(third), 'granted', 'in the order they asked');
  assert.equal(await state(fourth), 'pending');
  second();
  assert.equal(await state(fourth), 'granted');
  assert.deepEqual(limit.counts(), { sites: 1, active: 2, waiting: 0 });
});

test('one site waiting does not hold up another', async () => {
  const limit = createSiteLimit(1);
  const holdA = await limit.acquire('a.example');
  const waitingA = limit.acquire('a.example');
  const holdB = await limit.acquire('b.example');
  assert.equal(await state(waitingA), 'pending');
  assert.equal(typeof holdB, 'function', 'another site went straight in');
  holdA();
  assert.equal(await state(waitingA), 'granted');
  holdB();
});

test('letting go twice gives back only one place, and a site nobody holds or awaits leaves no trace', async () => {
  const limit = createSiteLimit(1);
  const release = await limit.acquire('a.example');
  const waiting = limit.acquire('a.example');
  release();
  release();
  release();
  const next = await waiting;
  assert.deepEqual(limit.counts(), { sites: 1, active: 1, waiting: 0 }, 'three releases of one place are one release');
  const another = limit.acquire('a.example');
  assert.equal(await state(another), 'pending', 'the place is still held by the one who got it');
  next();
  (await another)();
  assert.deepEqual(limit.counts(), { sites: 0, active: 0, waiting: 0 });
});

test('a limit that is not a whole number of at least one is one: when in doubt, less at a time', async () => {
  for (const junk of [0, -3, 1.5, NaN, Infinity, '2', null, undefined]) {
    const limit = createSiteLimit(junk);
    const hold = await limit.acquire('a.example');
    assert.equal(await state(limit.acquire('a.example')), 'pending', String(junk));
    hold();
  }
});

test('a lower rank goes first, equal ranks keep the order they asked in, and waitingFor counts the line', async () => {
  const limit = createSiteLimit(1);
  const hold = await limit.acquire('a.example');
  const order = [];
  const ask = (name, rank) => limit.acquire('a.example', rank).then((release) => { order.push(name); release(); });
  const line = [ask('background-1', 1), ask('interactive-1', 0), ask('background-2', 1), ask('interactive-2', 0)];
  assert.equal(limit.waitingFor('a.example'), 4);
  assert.equal(limit.waitingFor('nobody.example'), 0);
  hold();
  await state(Promise.all(line));
  assert.deepEqual(order, ['interactive-1', 'interactive-2', 'background-1', 'background-2']);
});

test('cancel takes a waiter out of the line; it cannot take back a place that was already given', async () => {
  const limit = createSiteLimit(1);
  const hold = await limit.acquire('a.example');
  const leaver = limit.acquire('a.example');
  const stayer = limit.acquire('a.example');
  assert.equal(leaver.cancel(), true);
  assert.equal(leaver.cancel(), false, 'a second cancel finds nobody');
  assert.equal(limit.waitingFor('a.example'), 1);
  hold();
  const granted = await stayer;
  assert.equal(typeof granted, 'function', 'the one who stayed got the place');
  assert.equal(await state(leaver), 'pending', 'the one who left is never answered');
  assert.equal(stayer.cancel(), false, 'a place already given cannot be cancelled');
  granted();
  assert.deepEqual(limit.counts(), { sites: 0, active: 0, waiting: 0 });
  const free = limit.acquire('a.example');
  assert.equal(free.cancel(), false, 'no waiting happened, nothing to cancel');
  (await free)();
});

test('the order of a long line is the order it was asked in, and every place given back is taken by the next', async () => {
  const limit = createSiteLimit(3);
  const granted = [];
  const releases = [];
  const asked = Array.from({ length: 12 }, (_, n) => limit.acquire('a.example').then((release) => { granted.push(n); releases.push(release); }));
  await state(Promise.all(asked));
  assert.deepEqual(granted, [0, 1, 2]);
  while (releases.length) {
    releases.shift()();
    await state(Promise.all(asked));
    assert.ok(limit.counts().active <= 3);
  }
  assert.deepEqual(granted, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(limit.counts(), { sites: 0, active: 0, waiting: 0 });
});
