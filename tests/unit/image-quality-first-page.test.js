'use strict';

// The probe only measures the first page's image, but pages() resolves the whole chapter, which
// can take minutes for a source that needs one throttled request per page. A source can export
// an optional firstPage(chapterId) for just that one page; the probe prefers it and every source
// without it keeps going through pages().

const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageQualityHealthCheckService } = require('../../server/modules/system-health/image-quality-health');

const COVER = 'https://cdn.example.test/cover.jpg';

// A complete fake source: a listing with one title, one chapter, and whatever page methods the
// test hands in. Every call is recorded so a test can say which method the probe really used.
function fakeSource(pageMethods) {
  const calls = { pages: [], firstPage: [] };
  const listing = async () => ({ results: [{ id: 'sample' }] });
  const mod = {
    trending: listing,
    search: listing,
    mangaDetails: async () => ({ cover: COVER }),
    chapters: async () => ({ chapters: [{ id: 'ch-1' }, { id: 'ch-0' }] }),
  };
  for (const [name, impl] of Object.entries(pageMethods)) {
    mod[name] = async (...args) => { calls[name].push(args); return impl(...args); };
  }
  return { mod, calls };
}

function makeService(sources) {
  const fetched = [];
  const store = {
    installedSources: Object.fromEntries(Object.keys(sources).map((id) => [id, { name: id.toUpperCase() }])),
    imageHealthBaseline: {},
  };
  const service = createImageQualityHealthCheckService({
    readStore: async () => store,
    writeStore: async () => {},
    loadSourceFromFile: (id) => sources[id],
    fetchProxyImage: async ({ url }) => { fetched.push(url); return { contentLength: 50_000 }; },
  });
  return { service, fetched };
}

const pageAt = (img) => async () => ({ pages: [{ index: 0, img }] });

test('firstPage is used for the page measurement and pages() is never called', async () => {
  const { mod, calls } = fakeSource({
    firstPage: pageAt('https://cdn.example.test/first.jpg'),
    pages: pageAt('https://cdn.example.test/from-pages.jpg'),
  });
  const { service, fetched } = makeService({ quick: mod });

  const [result] = await service.runImageQualityChecks();

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls.firstPage, [['ch-1']], 'asked once, for the newest chapter, with the one positional argument pages() gets');
  assert.deepEqual(calls.pages, [], 'the full page list is not resolved at all');
  assert.ok(fetched.includes('https://cdn.example.test/first.jpg'), 'the image measured is the one firstPage returned');
  assert.ok(!fetched.includes('https://cdn.example.test/from-pages.jpg'));
  assert.match(result.details, /page 49KB/);
});

test('a source without firstPage is still probed through pages()', async () => {
  const { mod, calls } = fakeSource({ pages: pageAt('https://cdn.example.test/from-pages.jpg') });
  const { service, fetched } = makeService({ plain: mod });

  const [result] = await service.runImageQualityChecks();

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(calls.pages, [['ch-1']]);
  assert.ok(fetched.includes('https://cdn.example.test/from-pages.jpg'));
});

test('a firstPage export that is not a function is ignored and pages() is used', async () => {
  const { mod, calls } = fakeSource({ pages: pageAt('https://cdn.example.test/from-pages.jpg') });
  mod.firstPage = 'not a function';
  const { service } = makeService({ odd: mod });

  const [result] = await service.runImageQualityChecks();

  assert.equal(result.ok, true, result.error);
  assert.equal(calls.pages.length, 1);
});

test('a firstPage that rejects fails only that source, with its own message, and pages() is not the fallback', async () => {
  const broken = fakeSource({
    firstPage: async () => { throw new Error('first page lookup failed'); },
    pages: pageAt('https://cdn.example.test/from-pages.jpg'),
  });
  const healthy = fakeSource({ firstPage: pageAt('https://cdn.example.test/first.jpg') });
  const legacy = fakeSource({ pages: pageAt('https://cdn.example.test/from-pages.jpg') });
  const { service } = makeService({ broken: broken.mod, healthy: healthy.mod, legacy: legacy.mod });

  const results = await service.runImageQualityChecks();
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  assert.equal(byId.broken.ok, false);
  assert.equal(byId.broken.error, 'first page lookup failed');
  assert.deepEqual(broken.calls.pages, [], 'a failing shortcut must not silently turn back into the slow full lookup');
  assert.equal(byId.healthy.ok, true, byId.healthy.error);
  assert.equal(byId.legacy.ok, true, byId.legacy.error);
});
