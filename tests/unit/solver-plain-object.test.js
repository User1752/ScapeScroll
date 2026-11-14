'use strict';

// server/modules/network/solver/plain-object.js: the two helpers every module shares.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isPlainObject, mergeConfig } = require('../../server/modules/network/solver/plain-object');

test('only objects that are not arrays count as plain', () => {
  for (const yes of [{}, { a: 1 }, Object.create(null)]) assert.equal(isPlainObject(yes), true);
  for (const no of [[], null, undefined, 'text', 3, true, () => {}]) assert.equal(isPlainObject(no), false, String(no));
});

test('merging lays the override on a copy, one level deep, and never touches the base', () => {
  const base = Object.freeze({ a: 1, queue: Object.freeze({ maxQueued: 24, wait: 15 }), list: [1, 2] });
  const merged = mergeConfig(base, { a: 2, queue: { maxQueued: 3 }, extra: true });
  assert.deepEqual(merged, { a: 2, queue: { maxQueued: 3, wait: 15 }, list: [1, 2], extra: true });
  assert.deepEqual(base, { a: 1, queue: { maxQueued: 24, wait: 15 }, list: [1, 2] });
  assert.notEqual(merged.queue, base.queue, 'the nested object is a copy: a test override cannot leak into the shared config');
});

test('an override of another kind replaces what was there', () => {
  const base = { queue: { maxQueued: 24 }, flag: false, list: [1] };
  assert.deepEqual(mergeConfig(base, { queue: 5, flag: { on: true }, list: { not: 'an array' } }), { queue: 5, flag: { on: true }, list: { not: 'an array' } });
  assert.deepEqual(mergeConfig(base, { queue: [1, 2] }).queue, [1, 2]);
});

test('no override at all is just a copy', () => {
  const base = { queue: { maxQueued: 24 }, a: 1 };
  for (const nothing of [undefined, null, {}]) {
    const copy = mergeConfig(base, nothing);
    assert.deepEqual(copy, base);
    assert.notEqual(copy.queue, base.queue);
  }
});
