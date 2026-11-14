'use strict';

// The callers that cannot change a signature declare how patient they are around the call
// (solver-context.js): cover search, the comic lookup, the image proxy. Each is loaded for real
// against a fetch-utils stand-in that records the context it was called in, so what is pinned here
// is what the caller declares, not what the pool does with it (fetch-utils-solver.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { getSolverContext } = require('../../server/modules/network/solver-context');
const { SITE, FETCH_UTILS_PATH, stubDns } = require('../helpers/fetch-utils-rig');

const SOLVER = 'http://127.0.0.1:8191/v1';


function stubFetchUtils(t, exportsObject) {
  const original = require.cache[FETCH_UTILS_PATH];
  require.cache[FETCH_UTILS_PATH] = { id: FETCH_UTILS_PATH, filename: FETCH_UTILS_PATH, loaded: true, children: [], paths: [], exports: exportsObject };
  t.after(() => { if (original) require.cache[FETCH_UTILS_PATH] = original; else delete require.cache[FETCH_UTILS_PATH]; });
}

function freshModule(t, id) {
  const path = require.resolve(id);
  delete require.cache[path];
  t.after(() => { delete require.cache[path]; });
  return require(path);
}

test('cover search is the one caller that wants a browser of its own: background, 23.5 s (24 s less the margin), oneOff', async (t) => {
  const seen = [];
  const page = '<html><script>{title:"A cover",x:1,original:"https://images.example.org/a.jpg"}</script></html>';
  stubFetchUtils(t, {
    DEFAULT_USER_AGENT: 'test-agent',
    resolveViaSolver: async () => { seen.push(getSolverContext()); return page; },
    // what server/helpers.js takes from fetch-utils when cover search loads it
    createPageUrlResolver: () => ({ resolvePageUrl: () => null }),
  });
  const coverSearch = freshModule(t, '../../server/modules/cover-search');

  const before = Date.now();
  await coverSearch.searchCoverImages({ q: 'declared patience cover' });

  const [declared] = seen;
  assert.equal(declared.priority, 'background');
  // The engines keep SafeSearch in cookies: a persistent session could serve unfiltered results to a later "Hide NSFW" search.
  assert.equal(declared.oneOff, true);
  // A one-off browser always gets the full time (the pool cannot bound a launch), so asking for a bounded navigation would mean nothing.
  assert.equal('boundSolve' in declared, false);
  // 24 s because the page was measured at 12 s with a cold browser (see cover-search-patience.test.js); the plain request that follows only gets what is left of 27 s.
  assert.ok(declared.deadlineAt >= before + 23_400 && declared.deadlineAt <= Date.now() + 23_500);
});

test('no other caller asks for a browser of its own: the comic lookup and the image proxy keep the shared session', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [];
  stubFetchUtils(t, { fetchText: async () => { seen.push(getSolverContext()); return '<html><body><ul></ul></body></html>'; } });
  const comicLookup = freshModule(t, '../../server/modules/leagueofcomicgeeks/service');
  await comicLookup.lookupCover({ title: 'Shared Session Comic' });
  assert.equal(seen.length, 1);
  assert.equal('oneOff' in seen[0], false);
});

test('the comic lookup declares background patience for its 12 s, without boundSolve', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // no debounced disk save, no real wait
  const seen = [];
  stubFetchUtils(t, { fetchText: async () => { seen.push(getSolverContext()); return '<html><body><ul></ul></body></html>'; } });
  const comicLookup = freshModule(t, '../../server/modules/leagueofcomicgeeks/service');

  const before = Date.now();
  assert.equal(await comicLookup.lookupCover({ title: 'Declared Patience Comic' }), null);

  const [declared] = seen;
  assert.equal(declared.priority, 'background');
  assert.equal('boundSolve' in declared, false, 'an abandoned lookup must go on solving and warm the cookie');
  assert.ok(declared.deadlineAt >= before + 11_900 && declared.deadlineAt <= Date.now() + 12_000);
});

test('a "no match" cached under the old key format (written when the lock handed over the wrong page) is not read any more', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-locg-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'locg.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ 'old key comic|': { value: null, at: Date.now() } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let fetched = 0;
  stubFetchUtils(t, { fetchText: async () => { fetched += 1; return '<html><body><ul></ul></body></html>'; } });
  const comicLookup = freshModule(t, '../../server/modules/leagueofcomicgeeks/service');
  comicLookup.configure({ cacheFilePath: cacheFile });

  await comicLookup.lookupCover({ title: 'Old Key Comic' });
  assert.equal(fetched, 1, 'the entry under the old key did not answer');
});

test('an image whose upstream says 403 asks FlareSolverr as an interactive call with a 15 s patience', async (t) => {
  stubDns(t);
  const seen = [];
  stubFetchUtils(t, {
    DEFAULT_USER_AGENT: 'test-agent',
    inferRefererForUrl: () => `${SITE}/`,
    getDomainSession: () => null,
    getFlaresolverrUrl: async () => SOLVER,
    executeFlareSolverr: async () => { seen.push(getSolverContext()); },
  });
  let attempts = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    attempts += 1;
    return attempts === 1
      ? new Response('no', { status: 403 })
      : new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { status: 200, headers: { 'content-type': 'image/png' } });
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const { createProxyService } = freshModule(t, '../../server/modules/proxy/service');

  const before = Date.now();
  await createProxyService({ isSafeUrl: () => true }).fetchProxyImage({ url: 'https://img.example/page.png' });

  const [declared] = seen;
  assert.equal(declared.priority, 'interactive');
  assert.equal('boundSolve' in declared, false);
  assert.ok(declared.deadlineAt >= before + 14_900 && declared.deadlineAt <= Date.now() + 15_000);
});
