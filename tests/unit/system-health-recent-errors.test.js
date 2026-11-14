'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectRecentSourceErrors } = require('../../server/modules/system-health/service');
const { RECENT_SOURCE_ERROR_WINDOW_MS } = require('../../server/config/system-health');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-11T12:00:00Z');
const daysAgo = (days) => new Date(NOW - days * DAY_MS).toISOString();
const entry = (area, lastSeenAt, extra = {}) => ({
  area,
  code: 'HTTP-500',
  message: 'Rate limited, retry later',
  count: 1,
  lastSeenAt,
  ...extra,
});

test('the default window is 7 days', () => {
  assert.equal(RECENT_SOURCE_ERROR_WINDOW_MS, 7 * DAY_MS);
});

test('keeps entries inside the window and drops older ones', () => {
  const result = collectRecentSourceErrors(
    [entry('allmanga', daysAgo(1)), entry('allmanga', daysAgo(38), { message: 'old blip' })],
    ['allmanga'],
    { now: NOW },
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].message, 'Rate limited, retry later');
});

test('an entry exactly at the window edge still counts', () => {
  const result = collectRecentSourceErrors([entry('mangadex', daysAgo(7))], ['mangadex'], { now: NOW });
  assert.equal(result.length, 1);
});

test('ignores errors from areas that are not installed sources', () => {
  const result = collectRecentSourceErrors(
    [entry('system_health', daysAgo(1)), entry('mangadex', daysAgo(1))],
    ['mangadex'],
    { now: NOW },
  );
  assert.deepEqual(result.map((r) => r.area), ['mangadex']);
});

test('sorts newest first', () => {
  const result = collectRecentSourceErrors(
    [entry('a', daysAgo(5), { message: 'older' }), entry('a', daysAgo(1), { message: 'newer' })],
    ['a'],
    { now: NOW },
  );
  assert.deepEqual(result.map((r) => r.message), ['newer', 'older']);
});

test('an entry without a usable lastSeenAt cannot be shown to be recent, so it is dropped', () => {
  const result = collectRecentSourceErrors(
    [entry('a', undefined), entry('a', 'not a date'), entry('a', null)],
    ['a'],
    { now: NOW },
  );
  assert.deepEqual(result, []);
});

test('a source that only has stale entries yields no recent errors at all', () => {
  assert.deepEqual(
    collectRecentSourceErrors([entry('allmanga', daysAgo(38), { count: 11 })], ['allmanga'], { now: NOW }),
    [],
  );
});
