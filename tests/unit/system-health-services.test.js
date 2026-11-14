'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const lifecycle = require('../../server/modules/network/flaresolverr-lifecycle');
const { createServicesHealthCheckService } = require('../../server/modules/system-health/services-health');

// FlareSolverr off by choice must not read as a fault. Everything the check
// touches is faked: global fetch answers for the FlareSolverr address and for
// AniList, and the "is the app supposed to run FlareSolverr" question is
// injected, so nothing here depends on this machine's data/setup.json, a real
// FlareSolverr or the network.

const LOCAL_URL = 'http://127.0.0.1:8191/v1';
const REMOTE_URL = 'http://flaresolverr:8191/v1';

// What Node's fetch throws when nothing is listening on the address.
function refused() {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8191'), { code: 'ECONNREFUSED' });
  return err;
}

// `answer` is what a request to the FlareSolverr address does: a function that
// returns a Response-like object or throws.
function fakeFetch(answer) {
  return async (url) => {
    if (String(url).startsWith('https://graphql.anilist.co')) {
      return { ok: true, status: 200, json: async () => ({ data: { Media: { id: 1 } } }) };
    }
    if (/^http:\/\/(127\.0\.0\.1|flaresolverr|\[::1\])/.test(String(url))) return answer(String(url));
    throw new Error(`unexpected request to ${url}`);
  };
}

async function flaresolverrRow({ url = LOCAL_URL, managed, answer = () => { throw refused(); }, managedThrows = false } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(answer);
  try {
    const service = createServicesHealthCheckService({
      getFlaresolverrUrl: async () => url,
      isFlaresolverrManaged: () => {
        if (managedThrows) throw new Error('could not tell');
        return managed;
      },
    });
    const rows = await service.runServiceChecks();
    return rows.find((row) => row.id === 'flaresolverr');
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('FlareSolverr off by choice and nothing listening is reported as off, not as a failure', async () => {
  const row = await flaresolverrRow({ managed: false });
  assert.equal(row.ok, true);
  assert.equal(row.error, '');
  assert.match(row.details, /^Off\b/);
});

test('FlareSolverr that should be running but is down still fails', async () => {
  const row = await flaresolverrRow({ managed: true });
  assert.equal(row.ok, false);
  assert.equal(row.error, 'fetch failed');
});

test('a FlareSolverr that answers is reported as reachable whether or not the app manages it', async () => {
  const answer = () => ({ ok: true, status: 200, json: async () => ({ msg: 'FlareSolverr is ready!', version: '3.3.21' }) });
  for (const managed of [true, false]) {
    const row = await flaresolverrRow({ managed, answer });
    assert.equal(row.ok, true, `managed=${managed}`);
    assert.equal(row.details, 'Reachable v3.3.21', `managed=${managed}`);
  }
});

test('a FlareSolverr on another host is the user\'s to keep up: down stays a failure even when the app does not manage one', async () => {
  const row = await flaresolverrRow({ url: REMOTE_URL, managed: false, answer: () => { throw new TypeError('fetch failed'); } });
  assert.equal(row.ok, false);
  assert.equal(row.error, 'fetch failed');
});

test('every loopback spelling of the address counts as the local copy', async () => {
  for (const url of ['http://127.0.0.1:8191/v1', 'http://localhost:8191/v1', 'http://[::1]:8191/v1', 'http://127.0.0.2:8191/v1']) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (target) => {
      if (String(target).startsWith('https://graphql.anilist.co')) return { ok: true, status: 200, json: async () => ({}) };
      throw refused();
    };
    try {
      const service = createServicesHealthCheckService({ getFlaresolverrUrl: async () => url, isFlaresolverrManaged: () => false });
      const row = (await service.runServiceChecks()).find((r) => r.id === 'flaresolverr');
      assert.equal(row.ok, true, url);
      assert.match(row.details, /^Off\b/, url);
    } finally {
      globalThis.fetch = realFetch;
    }
  }
});

test('something that answers badly, or hangs, is a failure even when the app does not manage FlareSolverr', async () => {
  const http500 = await flaresolverrRow({ managed: false, answer: () => ({ ok: false, status: 500, json: async () => ({}) }) });
  assert.equal(http500.ok, false);
  assert.equal(http500.error, 'HTTP 500');

  const timeout = await flaresolverrRow({
    managed: false,
    answer: () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
  });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /timeout/);
});

test('when the managed-or-not question itself fails the failure stands', async () => {
  const row = await flaresolverrRow({ managed: false, managedThrows: true });
  assert.equal(row.ok, false);
  assert.equal(row.error, 'fetch failed');
});

test('without an injected answer the check asks the FlareSolverr lifecycle', async () => {
  const original = lifecycle.isManaged;
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => { throw refused(); });
  try {
    for (const managed of [false, true]) {
      lifecycle.isManaged = () => managed;
      const service = createServicesHealthCheckService({ getFlaresolverrUrl: async () => LOCAL_URL });
      const row = (await service.runServiceChecks()).find((r) => r.id === 'flaresolverr');
      assert.equal(row.ok, !managed, `managed=${managed}`);
    }
  } finally {
    lifecycle.isManaged = original;
    globalThis.fetch = realFetch;
  }
});

// Loopback now comes from common/host-utils.js instead of a copy in this module: it must keep judging by the
// parsed host, so a name that merely starts with a loopback address is a remote host.
test('a host that only looks like loopback is a remote FlareSolverr: down stays a failure', async () => {
  for (const url of ['http://127.0.0.1.evil.example:8191/v1', 'http://localhost.evil.example:8191/v1', 'http://10.0.0.5:8191/v1']) {
    const row = await flaresolverrRow({ url, managed: false, answer: () => { throw refused(); } });
    assert.equal(row.ok, false, url);
  }
});

// The session pool's row comes from the pool's own status; without one the grid is what it always was.
test('the browser-session row appears next to FlareSolverr when there is a status, and is left out when there is none', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(() => ({ ok: true, status: 200, json: async () => ({ version: '3.5.2' }) }));
  try {
    const idle = { state: 'idle', enabled: true, disabledBy: null, sessions: [], queued: { interactive: 0, background: 0 }, cooldowns: [], circuit: { open: false, secondsLeft: 0 } };
    const withRow = await createServicesHealthCheckService({ getFlaresolverrUrl: async () => LOCAL_URL, getSolverSnapshot: () => idle }).runServiceChecks();
    assert.deepEqual(withRow.map((row) => row.id), ['flaresolverr', 'solver-pool', 'anilist', 'discord']);
    assert.equal(withRow[1].ok, true);

    for (const getSolverSnapshot of [undefined, () => null]) {
      const without = await createServicesHealthCheckService({ getFlaresolverrUrl: async () => LOCAL_URL, getSolverSnapshot }).runServiceChecks();
      assert.deepEqual(without.map((row) => row.id), ['flaresolverr', 'anilist', 'discord']);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

// Seen live: a refresh in the middle of a FlareSolverr restart showed 'fetch failed' on its row for the next
// 20 s while the session row, read live, already said '2 sessions open'. Only the third-party request is worth
// caching (rate limiting); the local FlareSolverr status page is cheap and must be as fresh as the row beside it.
test('the FlareSolverr row is read afresh on every call; only the AniList request is cached', async () => {
  const realFetch = globalThis.fetch;
  let alive = false;
  let flaresolverrRequests = 0;
  let anilistRequests = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith('https://graphql.anilist.co')) {
      anilistRequests += 1;
      return { ok: true, status: 200, json: async () => ({}) };
    }
    flaresolverrRequests += 1;
    if (!alive) throw refused();
    return { ok: true, status: 200, json: async () => ({ version: '3.5.2' }) };
  };
  try {
    const service = createServicesHealthCheckService({ getFlaresolverrUrl: async () => LOCAL_URL, isFlaresolverrManaged: () => true });
    const rowOf = async () => (await service.runServiceChecks()).find((row) => row.id === 'flaresolverr');

    assert.equal((await rowOf()).ok, false);
    alive = true; // it came back a moment later
    const up = await rowOf();
    assert.equal(up.ok, true);
    assert.equal(up.details, 'Reachable v3.5.2');
    assert.equal(anilistRequests, 1, 'AniList stays cached between calls');

    flaresolverrRequests = 0;
    await Promise.all([service.runServiceChecks(), service.runServiceChecks()]);
    assert.equal(flaresolverrRequests, 1, 'two callers at the same moment share one status request');
  } finally {
    globalThis.fetch = realFetch;
  }
});
