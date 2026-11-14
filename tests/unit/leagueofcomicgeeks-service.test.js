'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const FETCH_UTILS = require.resolve('../../server/modules/network/fetch-utils');
const ERROR_LOGGER = require.resolve('../../server/modules/error-logger');
const SERVICE = require.resolve('../../server/modules/leagueofcomicgeeks/service');

const MINUTE_MS = 60 * 1000;

function stubModule(resolvedPath, exportsObject) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports: exportsObject,
    children: [],
    paths: [],
  };
}

// The service destructures fetchText/recordError at require time, so the
// stubs must be in place before it is first required. The error-logger stub
// also keeps this test from ever touching the real data/error-log.json.
function loadServiceWith(t, { fetchText }) {
  const recorded = [];
  const calls = { fetch: 0 };
  stubModule(FETCH_UTILS, {
    fetchText: async (...args) => { calls.fetch += 1; return fetchText(...args); },
  });
  stubModule(ERROR_LOGGER, { recordError: async (e) => { recorded.push(e); } });
  delete require.cache[SERVICE];
  const service = require(SERVICE);
  t.after(() => {
    delete require.cache[SERVICE];
    delete require.cache[FETCH_UTILS];
    delete require.cache[ERROR_LOGGER];
  });
  return { lookupCover: service.lookupCover, calls, recorded };
}

test('a failed lookup is remembered for a few minutes, then retried', async (t) => {
  const { lookupCover, calls, recorded } = loadServiceWith(t, {
    fetchText: async () => { throw new Error('LOCG lookup exceeded 12000ms'); },
  });
  let clock = Date.parse('2026-10-11T12:00:00Z');
  t.mock.method(Date, 'now', () => clock);

  assert.equal(await lookupCover({ title: 'Betty & Veronica: Vixens' }), null);
  assert.equal(calls.fetch, 1);
  assert.equal(recorded.length, 1);

  // Same title again, inside the failure TTL: no new network call, no new error record.
  clock += 5 * MINUTE_MS;
  assert.equal(await lookupCover({ title: 'Betty & Veronica: Vixens' }), null);
  assert.equal(calls.fetch, 1);
  assert.equal(recorded.length, 1);

  // Past the failure TTL: it tries the network again.
  clock += 6 * MINUTE_MS;
  assert.equal(await lookupCover({ title: 'Betty & Veronica: Vixens' }), null);
  assert.equal(calls.fetch, 2);
  assert.equal(recorded.length, 2);
});

test('a different title is not affected by another title\'s remembered failure', async (t) => {
  const { lookupCover, calls } = loadServiceWith(t, {
    fetchText: async () => { throw new Error('boom'); },
  });
  await lookupCover({ title: 'First Comic' });
  await lookupCover({ title: 'Second Comic' });
  assert.equal(calls.fetch, 2);
});

test('a genuine "no match" answer keeps the long TTL - only failures use the short one', async (t) => {
  const { lookupCover, calls, recorded } = loadServiceWith(t, {
    fetchText: async () => '<html><body><ul></ul></body></html>',
  });
  let clock = Date.parse('2026-10-11T12:00:00Z');
  t.mock.method(Date, 'now', () => clock);

  assert.equal(await lookupCover({ title: 'Nothing Matches This' }), null);
  assert.equal(calls.fetch, 1);

  clock += 60 * MINUTE_MS; // far past the 10 min failure TTL, well inside the 24h answer TTL
  assert.equal(await lookupCover({ title: 'Nothing Matches This' }), null);
  assert.equal(calls.fetch, 1);
  assert.equal(recorded.length, 0);
});
