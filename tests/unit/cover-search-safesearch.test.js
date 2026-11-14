'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const FETCH_UTILS = require.resolve('../../server/modules/network/fetch-utils');
const MODULE = require.resolve('../../server/modules/cover-search');

// One minimal Brave-shaped result. It has to be a REAL result: the module
// never caches an empty result list, so an empty page would make every
// cache assertion below pass for the wrong reason.
const BRAVE_PAGE = '<html><script>{title:"A cover",x:1,original:"https://images.example.org/a.jpg"}</script></html>';

// Loads the cover-search module against a stubbed network layer, so nothing
// here ever touches the real Brave/Google: resolveViaSolver() hands back a
// one-result HTML page and records the URL it was asked for.
function loadModule(t) {
  const requested = [];
  require.cache[FETCH_UTILS] = {
    id: FETCH_UTILS,
    filename: FETCH_UTILS,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      DEFAULT_USER_AGENT: 'test-agent',
      resolveViaSolver: async (url) => { requested.push(url); return BRAVE_PAGE; },
    },
  };
  delete require.cache[MODULE];
  const mod = require(MODULE);
  t.after(() => {
    delete require.cache[MODULE];
    delete require.cache[FETCH_UTILS];
  });
  return { mod, requested };
}

test('Brave URL: SafeSearch is off by default and strict when asked', () => {
  const { buildBraveImageSearchUrl } = require(MODULE);
  assert.match(buildBraveImageSearchUrl({ q: 'berserk', page: 1, safe: false }), /[?&]safesearch=off(&|$)/);
  assert.match(buildBraveImageSearchUrl({ q: 'berserk', page: 1, safe: true }), /[?&]safesearch=strict(&|$)/);
});

test('Google URL: safe=off by default and safe=active when asked, query still encoded', () => {
  const { buildGoogleImageSearchUrl } = require(MODULE);
  const off = buildGoogleImageSearchUrl({ q: 'a b&c', start: 0, hl: 'en', gl: 'us', safe: false });
  const on = buildGoogleImageSearchUrl({ q: 'a b&c', start: 0, hl: 'en', gl: 'us', safe: true });
  assert.match(off, /[?&]safe=off&/);
  assert.match(on, /[?&]safe=active&/);
  assert.ok(on.includes('q=a%20b%26c'));
});

test('searchCoverImages passes the safe flag through to Brave, and a filtered result is never replayed unfiltered', async (t) => {
  const { mod, requested } = loadModule(t);

  const filtered = await mod.searchCoverImages({ q: 'unique query one', safe: '1' });
  assert.equal(filtered.items.length, 1, 'fixture must yield a real, cacheable result');

  // Same query without the flag: the filtered entry must NOT be replayed.
  await mod.searchCoverImages({ q: 'unique query one' });
  assert.equal(requested.length, 2, 'the unfiltered request must not be served from the filtered cache entry');
  assert.match(requested[0], /safesearch=strict/);
  assert.match(requested[1], /safesearch=off/);

  // Each variant is now cached under its own key: repeating either costs nothing.
  await mod.searchCoverImages({ q: 'unique query one', safe: '1' });
  await mod.searchCoverImages({ q: 'unique query one' });
  assert.equal(requested.length, 2);
});

test('searchCoverImages caches per safe flag (a repeat of the same request makes no second network call)', async (t) => {
  const { mod, requested } = loadModule(t);

  await mod.searchCoverImages({ q: 'unique query two', safe: 'true' });
  await mod.searchCoverImages({ q: 'unique query two', safe: 'true' });

  assert.equal(requested.length, 1);
});

test('the Google engine honours the flag too', async (t) => {
  const { mod, requested } = loadModule(t);

  await mod.searchCoverImages({ q: 'unique query three', engine: 'google', safe: 'on' });

  assert.match(requested[0], /google\.com\/search\?.*safe=active/);
});

test('anything other than an explicit on-value leaves SafeSearch off', async (t) => {
  const { mod, requested } = loadModule(t);

  for (const [i, value] of ['0', 'false', '', 'maybe'].entries()) {
    await mod.searchCoverImages({ q: `unique query four ${i}`, safe: value });
  }

  assert.equal(requested.length, 4);
  for (const url of requested) assert.match(url, /safesearch=off/);
});
