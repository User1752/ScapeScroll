'use strict';

// Where the app looks for FlareSolverr (fetch-utils.js getFlaresolverrUrl): the address typed in Settings wins, then FLARESOLVERR_URL (what the
// Docker compose file sets, since there FlareSolverr is another container), then the local default. The one exception: a Settings address that
// points at this computer gives way to an environment address on another host (the library's data/ is shared between a PC and a container). The environment has to be an http(s)
// address to count. A fake store, so nothing here reads the real library.

const test = require('node:test');
const assert = require('node:assert/strict');

const fetchUtils = require('../../server/modules/network/fetch-utils');
const { DEFAULT_FLARESOLVERR_URL } = require('../../server/config/solver');

const CONTAINER = 'http://flaresolverr:8191/v1';

function withEnv(value, fn) {
  const before = process.env.FLARESOLVERR_URL;
  if (value === undefined) delete process.env.FLARESOLVERR_URL; else process.env.FLARESOLVERR_URL = value;
  return Promise.resolve(fn()).finally(() => {
    if (before === undefined) delete process.env.FLARESOLVERR_URL; else process.env.FLARESOLVERR_URL = before;
  });
}

const storeWith = (flaresolverrUrl) => ({ readStore: async () => ({ settings: { flaresolverrUrl } }) });

test('nothing typed in Settings and no environment: the local default, as always', async () => {
  fetchUtils.configure(storeWith(''));
  await withEnv(undefined, async () => assert.equal(await fetchUtils.getFlaresolverrUrl(), DEFAULT_FLARESOLVERR_URL));
});

test('FLARESOLVERR_URL is the default when Settings holds nothing, and the address typed in Settings still wins', async () => {
  fetchUtils.configure(storeWith(''));
  await withEnv(CONTAINER, async () => assert.equal(await fetchUtils.getFlaresolverrUrl(), CONTAINER));
  fetchUtils.configure(storeWith('http://192.168.1.50:8191/v1'));
  await withEnv(CONTAINER, async () => assert.equal(await fetchUtils.getFlaresolverrUrl(), 'http://192.168.1.50:8191/v1'));
});

test('an address in Settings that points at THIS computer gives way to the container address of the environment (a library shared with a PC)', async () => {
  for (const saved of ['http://127.0.0.1:8191/v1', 'http://localhost:8191/v1', 'http://[::1]:8191/v1', 'http://127.0.0.5:9000/v1']) {
    fetchUtils.configure(storeWith(saved));
    await withEnv(CONTAINER, async () => assert.equal(await fetchUtils.getFlaresolverrUrl(), CONTAINER, saved));
  }
  // nothing changes where the environment has nothing to say, or says the same kind of thing
  fetchUtils.configure(storeWith('http://127.0.0.1:8191/v1'));
  await withEnv(undefined, async () => assert.equal(await fetchUtils.getFlaresolverrUrl(), 'http://127.0.0.1:8191/v1'));
  await withEnv('http://localhost:8191/v1', async () => assert.equal(await fetchUtils.getFlaresolverrUrl(), 'http://127.0.0.1:8191/v1'));
  await withEnv('not an address', async () => assert.equal(await fetchUtils.getFlaresolverrUrl(), 'http://127.0.0.1:8191/v1'));
  // an address of another machine in Settings is the person's choice and still wins; so does a look-alike host name
  fetchUtils.configure(storeWith('http://127.0.0.1.evil.example:8191/v1'));
  await withEnv(CONTAINER, async () => assert.equal(await fetchUtils.getFlaresolverrUrl(), 'http://127.0.0.1.evil.example:8191/v1'));
  fetchUtils.configure(storeWith(''));
});

test('an environment value that is not an http(s) address is ignored, and a store that cannot be read still falls back to it', async () => {
  fetchUtils.configure(storeWith(''));
  for (const bad of ['', '   ', 'flaresolverr:8191', 'ftp://flaresolverr/v1', 'http://', 'http://a b/v1', 'javascript:alert(1)']) {
    await withEnv(bad, async () => assert.equal(await fetchUtils.getFlaresolverrUrl(), DEFAULT_FLARESOLVERR_URL, JSON.stringify(bad)));
  }
  fetchUtils.configure({ readStore: async () => { throw new Error('store is being written'); } });
  await withEnv(CONTAINER, async () => assert.equal(await fetchUtils.getFlaresolverrUrl(), CONTAINER));
  await withEnv(undefined, async () => assert.equal(await fetchUtils.getFlaresolverrUrl(), DEFAULT_FLARESOLVERR_URL));
  fetchUtils.configure(storeWith(''));
});
