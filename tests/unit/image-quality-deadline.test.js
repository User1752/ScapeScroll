'use strict';

// One Cloudflare-slow source used to push the whole image-quality request past its limit
// (504 and no results at all). Each source now has an overall deadline: the slow one is
// reported as timed out and the others still come back.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createImageQualityHealthCheckService,
  SOURCE_DEADLINE_MS,
} = require('../../server/modules/system-health/image-quality-health');

const CONTRACT = {
  mangaDetails: async () => ({}),
  chapters: async () => ({ chapters: [] }),
  pages: async () => ({ pages: [] }),
};

function makeService({ sources, deadlineMs }) {
  const store = {
    installedSources: Object.fromEntries(Object.keys(sources).map((id) => [id, { name: id.toUpperCase() }])),
    imageHealthBaseline: {},
  };
  return createImageQualityHealthCheckService({
    readStore: async () => store,
    writeStore: async () => {},
    loadSourceFromFile: (id) => sources[id],
    fetchProxyImage: async () => ({ contentLength: 50_000 }),
    sourceDeadlineMs: deadlineMs,
  });
}

test('a source that never answers is reported as timed out while the others still return', { timeout: 5000 }, async (t) => {
  // The slow source's listing waits on a gate that the test opens at the end: the abandoned probe
  // then finishes and clears its own 60 s stage timer, instead of keeping the test process alive
  // for a minute after the assertions are done.
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  t.after(() => open());
  const slowListing = async () => { await gate; return { results: [] }; };

  const service = makeService({
    deadlineMs: 80,
    sources: {
      // has the page-image contract but its listing hangs: the probe cannot even pick a sample
      slowsource: { trending: slowListing, search: slowListing, popular: slowListing, ...CONTRACT },
      // no usable listing at all: finishes at once with its own (non-timeout) message
      emptysource: { trending: async () => ({ results: [] }), search: async () => ({ results: [] }), popular: async () => ({ results: [] }), ...CONTRACT },
    },
  });

  const started = Date.now();
  const results = await service.runImageQualityChecks();
  assert.ok(Date.now() - started < 2000, 'returned long before any 60 s stage timeout');

  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId.slowsource.ok, false);
  assert.equal(byId.slowsource.error, 'Probe timed out.');
  assert.ok(byId.emptysource, 'the other source is still in the answer');
  assert.notEqual(byId.emptysource.error, 'Probe timed out.');
});

test('a source module that fails to load does not stop the check', async () => {
  const service = createImageQualityHealthCheckService({
    readStore: async () => ({ installedSources: { broken: { name: 'Broken' } }, imageHealthBaseline: {} }),
    writeStore: async () => {},
    loadSourceFromFile: () => { throw new Error('syntax error in source'); },
    fetchProxyImage: async () => ({}),
    sourceDeadlineMs: 50,
  });
  const [only] = await service.runImageQualityChecks();
  assert.equal(only.ok, false);
  assert.match(only.error, /Failed to load module/);
});

// The deadline only helps if it fires before the route gives up on the whole request
// (routes/system-health.js: req/res.setTimeout(90_000)), with room left to answer.
test('the default per-source deadline sits safely under the 90 s route limit', () => {
  assert.ok(SOURCE_DEADLINE_MS < 90_000, `${SOURCE_DEADLINE_MS} ms must be under the route limit`);
  assert.ok(SOURCE_DEADLINE_MS <= 80_000, 'and leave time for the store write and the reply');
  assert.ok(SOURCE_DEADLINE_MS >= 30_000, 'but not so short that a Cloudflare solve cannot finish');
});
