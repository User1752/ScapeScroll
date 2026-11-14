'use strict';

// A source the user switched off (store.settings.disabledSourceIds) is not probed by System Health: the
// live probe (sources/health-check.js) and the image-quality probe (system-health/image-quality-health.js)
// never load its module, never call it and give it no row. A probe of such a source is a request to a
// Cloudflare-protected site that opens FlareSolverr's hidden browser and can restart it, so "not probed" is
// the whole point. Both services run on injected stand-ins (store, source modules, image fetch); nothing
// here touches the network or the data folder. Timers are mocked: the live probe races each source against
// a 15 s timer that would otherwise keep the test process alive after the assertions.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSourceHealthCheckService } = require('../../server/modules/sources/health-check');
const { createImageQualityHealthCheckService } = require('../../server/modules/system-health/image-quality-health');

const CACHE_TTL_MS = 20_000; // health-check.js: how long a finished run is reused
const NOW = 1_700_000_000_000;
const mockClock = (t) => t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });

function makeStore(ids, disabledSourceIds, baselines = {}) {
  const store = {
    installedSources: Object.fromEntries(ids.map((id) => [id, { name: id.toUpperCase() }])),
    imageHealthBaseline: baselines,
  };
  if (disabledSourceIds !== undefined) store.settings = { disabledSourceIds };
  return store;
}

const idsOf = (rows) => rows.map((row) => row.id).sort();

// ---- the live probe (sources/health-check.js) ----

function liveRig(store, { withHealthCheck = [] } = {}) {
  const seen = { loaded: [], searched: [], healthChecked: [], reads: 0 };
  const service = createSourceHealthCheckService({
    readStore: async () => { seen.reads += 1; return store; },
    loadSourceFromFile: (id) => {
      seen.loaded.push(id);
      const mod = { search: () => { seen.searched.push(id); return { results: [], hasNextPage: false }; } };
      if (withHealthCheck.includes(id)) mod.healthCheck = () => { seen.healthChecked.push(id); return { ok: true }; };
      return mod;
    },
  });
  return { service, seen };
}

test('live probe: a disabled source is never loaded and never searched, has no row, and the others are probed once each', async (t) => {
  mockClock(t);
  const { service, seen } = liveRig(makeStore(['alpha', 'beta', 'gamma'], ['beta']));

  const rows = await service.runHealthCheck();

  assert.deepEqual(idsOf(rows), ['alpha', 'gamma']);
  assert.equal(rows.every((row) => row.ok), true);
  assert.deepEqual(seen.loaded.sort(), ['alpha', 'gamma'], 'the disabled module is not even loaded');
  assert.deepEqual(seen.searched.sort(), ['alpha', 'gamma'], 'one probe each');
});

test('live probe: a disabled source that has its own healthCheck() is not asked either', async (t) => {
  mockClock(t);
  const { service, seen } = liveRig(makeStore(['alpha', 'beta'], ['beta']), { withHealthCheck: ['alpha', 'beta'] });

  const rows = await service.runHealthCheck();

  assert.deepEqual(idsOf(rows), ['alpha']);
  assert.deepEqual(seen.healthChecked, ['alpha']);
  assert.deepEqual(seen.searched, []);
  assert.deepEqual(seen.loaded, ['alpha']);
});

test('live probe: when every installed source is disabled the result is [] and nothing is loaded', async (t) => {
  mockClock(t);
  const { service, seen } = liveRig(makeStore(['alpha', 'beta'], ['beta', 'alpha']));

  assert.deepEqual(await service.runHealthCheck(), []);
  assert.deepEqual(seen.loaded, []);
  assert.deepEqual(seen.searched, []);
});

test('live probe: a store without the key, with an empty list or with junk behaves as before: every source is probed', async (t) => {
  mockClock(t);
  const stores = [
    makeStore(['alpha', 'beta']), // no settings at all
    makeStore(['alpha', 'beta'], []),
    makeStore(['alpha', 'beta'], 'beta'),
    makeStore(['alpha', 'beta'], { 0: 'beta', length: 1 }),
    makeStore(['alpha', 'beta'], [5, null, {}, '', 'two words', '__proto__']),
    makeStore(['alpha', 'beta'], ['not-installed']),
  ];
  stores.push({ ...makeStore(['alpha', 'beta']), settings: null });
  for (const store of stores) {
    const { service, seen } = liveRig(store);
    assert.deepEqual(idsOf(await service.runHealthCheck()), ['alpha', 'beta'], JSON.stringify(store.settings));
    assert.deepEqual(seen.searched.sort(), ['alpha', 'beta']);
  }
});

test('live probe: with nothing installed the result is [] as it always was', async (t) => {
  mockClock(t);
  const { service } = liveRig({ installedSources: {}, settings: { disabledSourceIds: ['alpha'] } });
  assert.deepEqual(await service.runHealthCheck(), []);
});

test('live probe: an unreadable store still answers with its one "store" row', async (t) => {
  mockClock(t);
  const service = createSourceHealthCheckService({
    readStore: async () => { throw new Error('disk gone'); },
    loadSourceFromFile: () => { throw new Error('must not load anything'); },
  });
  const rows = await service.runHealthCheck();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'store');
  assert.equal(rows[0].ok, false);
});

test('live probe: the 20 s cache still serves a second call, and the list is read again once it has expired', async (t) => {
  mockClock(t);
  const store = makeStore(['alpha', 'beta'], ['beta']);
  const { service, seen } = liveRig(store);

  const first = await service.runHealthCheck();
  const second = await service.runHealthCheck();
  assert.equal(second, first, 'the same result object: nothing was probed again');
  assert.equal(seen.reads, 1);
  assert.deepEqual(seen.searched, ['alpha']);

  t.mock.timers.tick(CACHE_TTL_MS - 1);
  assert.equal(await service.runHealthCheck(), first, 'still inside the window');

  store.settings.disabledSourceIds = ['alpha']; // the user switched the other source off meanwhile
  t.mock.timers.tick(2);
  const third = await service.runHealthCheck();
  assert.deepEqual(idsOf(third), ['beta']);
  assert.equal(seen.reads, 2);
  assert.deepEqual(seen.searched, ['alpha', 'beta']);
});

test('live probe: calls made while a run is in flight share it: one probe per enabled source', async (t) => {
  mockClock(t);
  const { service, seen } = liveRig(makeStore(['alpha', 'beta', 'gamma'], ['gamma']));

  const [a, b, c] = await Promise.all([service.runHealthCheck(), service.runHealthCheck(), service.runHealthCheck()]);

  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(seen.reads, 1);
  assert.deepEqual(seen.searched.sort(), ['alpha', 'beta']);
});

test('live probe: the startup log lists only the sources that were probed', async (t) => {
  mockClock(t);
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(String(line)));
  t.mock.method(console, 'warn', (line) => lines.push(String(line)));
  const { service } = liveRig(makeStore(['alpha', 'beta'], ['beta']));

  await service.logHealthCheck();

  assert.ok(lines.some((line) => line.includes('1 OK, 0 failing')), lines.join('\n'));
  assert.equal(lines.some((line) => line.includes('beta')), false, 'the disabled source is not mentioned');
});

// ---- the image-quality probe (system-health/image-quality-health.js) ----

const sampleCover = (id) => `https://cdn.example.test/${id}/cover.jpg`;
const samplePage = (id) => `https://cdn.example.test/${id}/page.jpg`;

function imageRig(store, { emptyChapters = [] } = {}) {
  const seen = { loaded: [], called: [], fetched: [], writes: 0, written: [] };
  const service = createImageQualityHealthCheckService({
    readStore: async () => store,
    writeStore: async (saved) => { seen.writes += 1; seen.written.push(JSON.parse(JSON.stringify(saved.imageHealthBaseline))); },
    loadSourceFromFile: (id) => {
      seen.loaded.push(id);
      const note = (method) => seen.called.push(`${id}.${method}`);
      const listing = async () => { note('listing'); return { results: [{ id: 'sample' }] }; };
      return {
        trending: listing,
        search: listing,
        mangaDetails: async () => { note('mangaDetails'); return { cover: sampleCover(id) }; },
        chapters: async () => { note('chapters'); return { chapters: emptyChapters.includes(id) ? [] : [{ id: 'ch-1' }] }; },
        pages: async () => { note('pages'); return { pages: [{ img: samplePage(id) }] }; },
      };
    },
    fetchProxyImage: async ({ url }) => { seen.fetched.push(url); return { contentLength: 50_000 }; },
  });
  return { service, seen };
}

test('image quality: a disabled source is not loaded, not sampled, has no row and no image is fetched for it', async (t) => {
  mockClock(t);
  const { service, seen } = imageRig(makeStore(['alpha', 'beta', 'gamma'], ['beta']));

  const rows = await service.runImageQualityChecks();

  assert.deepEqual(idsOf(rows), ['alpha', 'gamma']);
  assert.equal(rows.every((row) => row.ok), true, JSON.stringify(rows));
  assert.deepEqual(seen.loaded.sort(), ['alpha', 'gamma']);
  assert.deepEqual(seen.called.filter((call) => call.startsWith('beta.')), []);
  assert.deepEqual(seen.fetched.filter((url) => url.includes('/beta/')), []);
  assert.equal(seen.fetched.some((url) => url.includes('/alpha/')), true, 'the enabled sources are sampled as before');
});

test('image quality: a disabled source gets no baseline write and no baseline clear; the others still advance', async (t) => {
  mockClock(t);
  const stale = { mangaId: 'old', chapterId: 'old-ch', coverBytes: 90_000, pageBytes: 90_000, sampledAt: '2026-01-01T00:00:00.000Z' };
  // With no list this baseline would be cleared: its pinned sample has no chapters any more (control below).
  const control = imageRig(makeStore(['alpha', 'beta'], undefined, { beta: { ...stale } }), { emptyChapters: ['beta'] });
  const controlRows = await control.service.runImageQualityChecks();
  assert.equal(controlRows.find((row) => row.id === 'beta').ok, false);
  assert.equal('beta' in control.seen.written[0], false, 'control: an enabled source with a dead sample loses its baseline');

  const { service, seen } = imageRig(makeStore(['alpha', 'beta'], ['beta'], { beta: { ...stale } }), { emptyChapters: ['beta'] });
  const rows = await service.runImageQualityChecks();

  assert.deepEqual(idsOf(rows), ['alpha']);
  assert.equal(seen.writes, 1, 'alpha advanced');
  assert.deepEqual(seen.written[0].beta, stale, 'the disabled source keeps its baseline, so enabling it again compares against it');
  assert.equal(seen.written[0].alpha.mangaId, 'sample');
});

test('image quality: when every installed source is disabled the result is [] and nothing is loaded or written', async (t) => {
  mockClock(t);
  const { service, seen } = imageRig(makeStore(['alpha', 'beta'], ['alpha', 'beta'], { alpha: { mangaId: 'kept' } }));

  assert.deepEqual(await service.runImageQualityChecks(), []);
  assert.deepEqual(seen.loaded, []);
  assert.equal(seen.writes, 0);
});

test('image quality: a store without the key, with an empty list or with junk probes every source as before', async (t) => {
  mockClock(t);
  const stores = [
    makeStore(['alpha', 'beta']),
    makeStore(['alpha', 'beta'], []),
    makeStore(['alpha', 'beta'], 'beta'),
    makeStore(['alpha', 'beta'], [7, null, '__proto__', {}]),
    makeStore(['alpha', 'beta'], ['not-installed']),
  ];
  for (const store of stores) {
    const { service, seen } = imageRig(store);
    assert.deepEqual(idsOf(await service.runImageQualityChecks()), ['alpha', 'beta'], JSON.stringify(store.settings));
    assert.deepEqual(seen.loaded.sort(), ['alpha', 'beta']);
  }
});

test('image quality: with nothing installed the result is [] as it always was', async (t) => {
  mockClock(t);
  const { service } = imageRig({ installedSources: {}, imageHealthBaseline: {}, settings: { disabledSourceIds: ['alpha'] } });
  assert.deepEqual(await service.runImageQualityChecks(), []);
});
