'use strict';

// server/modules/sources/disabled-sources.js: the server's own copy of the sources the user switched off.
// Two rules over one id check: parseDisabledSourceIds() cleans what is stored (keeps what is usable), and
// strictSourceIdList() judges an update from the browser (all or nothing). Pure functions; no store, no I/O.

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../../server/config/limits');
const {
  parseDisabledSourceIds,
  strictSourceIdList,
  disabledSourceSetOf,
} = require('../../server/modules/sources/disabled-sources');

test('the cap is a named limit of the project, not a number in the helper', () => {
  assert.equal(Number.isInteger(limits.disabledSourceIdsMax), true);
  assert.ok(limits.disabledSourceIdsMax >= 100 && limits.disabledSourceIdsMax <= 1000);
});

test('parse: a valid list is kept as it is, in order', () => {
  assert.deepEqual(parseDisabledSourceIds(['alpha', 'beta-2', 'gamma_3', 'A1']), ['alpha', 'beta-2', 'gamma_3', 'A1']);
  assert.deepEqual(parseDisabledSourceIds([]), []);
});

test('parse: anything that is not an array is an empty list, and nothing throws', () => {
  const junk = [undefined, null, 'alpha', 7, true, {}, { 0: 'alpha', length: 1 }, () => ['alpha'], new Set(['alpha']), Symbol('x')];
  for (const value of junk) {
    assert.deepEqual(parseDisabledSourceIds(value), [], String(typeof value));
  }
  assert.deepEqual(parseDisabledSourceIds(JSON.parse('{"__proto__":["alpha"]}')), []);
});

test('parse: entries that are not source ids are dropped, the good ones around them stay', () => {
  const dirty = ['alpha', 5, null, undefined, '', 'has space', 'path/../up', 'a.b', '<b>x</b>', {}, ['alpha'], 'beta', true, 'x'.repeat(5000)];
  assert.deepEqual(parseDisabledSourceIds(dirty), ['alpha', 'beta']);
});

test('parse: ids that name a slot every object has are never kept', () => {
  assert.deepEqual(parseDisabledSourceIds(['__proto__', 'constructor', 'prototype', 'alpha']), ['alpha']);
});

test('parse: a hole in a sparse array is not an id', () => {
  const sparse = ['alpha', , 'beta']; // eslint-disable-line no-sparse-arrays
  assert.deepEqual(parseDisabledSourceIds(sparse), ['alpha', 'beta']);
});

test('parse: a repeated id is kept once, at its first place', () => {
  assert.deepEqual(parseDisabledSourceIds(['b', 'a', 'b', 'a', 'c']), ['b', 'a', 'c']);
  assert.deepEqual(parseDisabledSourceIds(['a', 'A']), ['a', 'A'], 'ids are case sensitive, like the sources themselves');
});

test('parse: 10000 entries are cut at the cap and the work stays small', () => {
  const many = Array.from({ length: 10_000 }, (_, i) => `source-${i}`);
  const started = Date.now();
  const cleaned = parseDisabledSourceIds(many);
  assert.equal(cleaned.length, limits.disabledSourceIdsMax);
  assert.deepEqual(cleaned.slice(0, 3), ['source-0', 'source-1', 'source-2']);
  assert.ok(Date.now() - started < 500);
  assert.equal(parseDisabledSourceIds(Array.from({ length: 10_000 }, () => 'same')).length, 1);
});

test('parse: the list it returns is a new array, never the one it was given', () => {
  const given = ['alpha'];
  const cleaned = parseDisabledSourceIds(given);
  assert.notEqual(cleaned, given);
  cleaned.push('beta');
  assert.deepEqual(given, ['alpha']);
});

test('strict: a list of valid ids is accepted as the cleaned, de-duplicated list; [] is a valid list', () => {
  assert.deepEqual(strictSourceIdList(['alpha', 'beta']), ['alpha', 'beta']);
  assert.deepEqual(strictSourceIdList(['alpha', 'beta', 'alpha']), ['alpha', 'beta']);
  assert.deepEqual(strictSourceIdList([]), []);
});

test('strict: one bad entry refuses the whole list (undefined, never a partial copy)', () => {
  const bad = [
    ['alpha', 5], ['alpha', null], ['alpha', ''], ['alpha', 'two words'], ['alpha', 'x'.repeat(5000)],
    ['alpha', {}], ['alpha', ['beta']], ['alpha', '__proto__'], ['constructor'], ['alpha', , 'beta'], // eslint-disable-line no-sparse-arrays
  ];
  for (const list of bad) assert.equal(strictSourceIdList(list), undefined, JSON.stringify(list));
});

test('strict: what is not an array is refused', () => {
  const junk = [undefined, null, 'alpha', 7, true, {}, { length: 1, 0: 'alpha' }, new Set(['alpha']), JSON.parse('{"__proto__":["alpha"]}')];
  for (const value of junk) assert.equal(strictSourceIdList(value), undefined, String(typeof value));
});

test('strict: a list over the cap is refused whole, one at the cap is accepted', () => {
  const atCap = Array.from({ length: limits.disabledSourceIdsMax }, (_, i) => `s${i}`);
  assert.deepEqual(strictSourceIdList(atCap), atCap);
  assert.equal(strictSourceIdList([...atCap, 'one-more']), undefined);
  assert.equal(strictSourceIdList(Array.from({ length: 10_000 }, (_, i) => `s${i}`)), undefined);
});

test('strict: an array with a huge length and no entries is refused without walking it', () => {
  const huge = [];
  huge.length = 4_000_000_000;
  const started = Date.now();
  assert.equal(strictSourceIdList(huge), undefined);
  assert.ok(Date.now() - started < 200);
});

test('set: the ids of store.settings.disabledSourceIds as a Set', () => {
  const set = disabledSourceSetOf({ settings: { disabledSourceIds: ['alpha', 'beta', 'alpha'] } });
  assert.equal(set instanceof Set, true);
  assert.deepEqual([...set], ['alpha', 'beta']);
  assert.equal(set.has('alpha'), true);
  assert.equal(set.has('gamma'), false);
});

test('set: a missing store, missing settings or junk in the place give an empty Set and never throw', () => {
  const stores = [
    undefined, null, 'store', 5, true, [], {}, { settings: null }, { settings: 'x' }, { settings: [] }, { settings: {} },
    { settings: { disabledSourceIds: null } }, { settings: { disabledSourceIds: 'alpha' } }, { settings: { disabledSourceIds: { 0: 'alpha' } } },
    { settings: { disabledSourceIds: 5 } }, JSON.parse('{"settings":{"__proto__":{"disabledSourceIds":["alpha"]}}}'),
  ];
  for (const store of stores) {
    let set;
    assert.doesNotThrow(() => { set = disabledSourceSetOf(store); }, JSON.stringify(store));
    assert.equal(set.size, 0, JSON.stringify(store));
  }
});

test('set: junk entries inside a list are dropped here too (a store that was never normalised is still safe)', () => {
  const set = disabledSourceSetOf({ settings: { disabledSourceIds: ['alpha', 7, '__proto__', {}, 'beta'] } });
  assert.deepEqual([...set], ['alpha', 'beta']);
});

test('set: a new Set each time, so a caller cannot change the stored list through it', () => {
  const store = { settings: { disabledSourceIds: ['alpha'] } };
  disabledSourceSetOf(store).add('beta');
  assert.deepEqual(store.settings.disabledSourceIds, ['alpha']);
});
