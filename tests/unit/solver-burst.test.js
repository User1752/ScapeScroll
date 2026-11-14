'use strict';

// A burst of lookups for one protected site must not become a queue of browser navigations. The site
// stub behaves like a Cloudflare site: a plain request without the clearance cookie meets the
// challenge, with it the page. The first lookup is solved in the browser and saves the cookie; every
// other one waiting behind it is then asked for again with a plain request, one at a time, and is
// answered without a browser.
//
// The real fetch-utils and pool and a fake FlareSolverr. Before the preflight waited for the cookie,
// the first pump spent every waiting job's only try before the first navigation had produced a
// cookie, so 20 lookups cost 20 navigations and, spaced 1.5 s apart, most of them ran out of
// patience (measured: 8 of 20 answered).

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { runWithSolverContext } = require('../../server/modules/network/solver-context');
const { navigations, creates } = require('../helpers/solver-pool-rig');
const { SITE, stubSite, rig } = require('../helpers/fetch-utils-rig');

const LOOKUPS = 20;
// What production does, for the test that runs with it: the site is spaced 1.5 s apart, a navigation
// takes 300 ms here (a cold one is 12-16 s live), and the comic lookup gives up after 12 s.
const PRODUCTION = { hostSpacingMs: POOL.hostSpacingMs, navigationMs: 300, lookupPatienceMs: 12_000 };
const SCALE = 10;

// The pool copies POOL when fetch-utils builds it, which the rig does for every test; the values are
// put back at once.
async function withPool(overrides, fn) {
  const saved = { ...POOL };
  Object.assign(POOL, { blankResetSettleMs: 5, launchRetryDelayMs: 5, ...overrides });
  try {
    return await fn();
  } finally {
    Object.assign(POOL, saved);
  }
}

const cookieHeader = (init) => String(init && init.headers && (init.headers.Cookie || init.headers.cookie) || '');

function stubProtectedSite(t) {
  return stubSite(t, async (url, init) => (/cf_clearance=/.test(cookieHeader(init))
    ? new Response(`<html><body>PLAIN PAGE ${url}</body></html>`, { status: 200 })
    : new Response('<html><title>Just a moment...</title></html>', { status: 403 })));
}

function assertEveryLookupAnswered(settled) {
  const failed = settled.filter((s) => s.status === 'rejected').map((s) => s.reason && (s.reason.code || s.reason.message));
  assert.deepEqual(failed, [], 'every lookup was answered');
  settled.forEach((s, i) => assert.ok(String(s.value).includes(`/lookup/${i}`), `lookup ${i} got its own page`));
}

for (const maxSessions of [1, 2]) {
  test(`${LOOKUPS} lookups of one site cost at most 3 navigations, with ${maxSessions} browser session${maxSessions === 1 ? '' : 's'} (timers divided by ${SCALE})`, async (t) => {
    const { fake, fu, pool } = await withPool({ hostSpacingMs: PRODUCTION.hostSpacingMs / SCALE }, () => rig(t, { settings: { maxSessions }, fakeOptions: { latencyMs: PRODUCTION.navigationMs / SCALE } }));
    stubProtectedSite(t);

    const urls = Array.from({ length: LOOKUPS }, (_, i) => `${SITE}/lookup/${i}`);
    const settled = await Promise.allSettled(urls.map((url) => fu.executeFlareSolverr(url, fake.url)));

    assertEveryLookupAnswered(settled);
    const solved = navigations(fake).length;
    assert.ok(solved <= 3, `${solved} browser navigations for ${LOOKUPS} lookups`);
    assert.ok(creates(fake).length <= maxSessions);
    const { counters } = pool.getStatus();
    assert.ok(counters.directJobs >= LOOKUPS - 3, `${counters.directJobs} answered by a plain request`);
  });
}

test(`${LOOKUPS} lookups through fetchText, with the production timers, are all answered inside the lookup patience`, async (t) => {
  // spacing 1.5 s, comic-lookup patience 12 s, the pool at its default size. Serial navigations
  // would need 20 x 1.5 s = 30 s and leave most lookups refused as busy after 12 s.
  const { fake, fu } = await withPool({}, () => rig(t, { settings: { maxSessions: POOL.defaultMaxSessions }, fakeOptions: { latencyMs: PRODUCTION.navigationMs } }));
  stubProtectedSite(t);

  const urls = Array.from({ length: LOOKUPS }, (_, i) => `${SITE}/lookup/${i}`);
  const startedAt = Date.now();
  const settled = await Promise.allSettled(urls.map((url) => runWithSolverContext(
    { priority: 'background', deadlineAt: Date.now() + PRODUCTION.lookupPatienceMs },
    () => fu.fetchText(url, 0),
  )));

  assertEveryLookupAnswered(settled);
  const solved = navigations(fake).length;
  assert.ok(solved <= 3, `${solved} browser navigations for ${LOOKUPS} lookups`);
  assert.ok(Date.now() - startedAt < PRODUCTION.lookupPatienceMs / 2, 'and quickly: nobody waited for a second browser pass');
});

test('a site whose cookie does not let a plain request through costs one try per cookie, not one per waiting lookup', async (t) => {
  // Every plain request meets the challenge (the cookie is bound to something a plain request lacks).
  // The waiting lookups must not each pay a failing request for every cookie that is saved.
  const { fake, fu } = await withPool({ hostSpacingMs: PRODUCTION.hostSpacingMs / SCALE }, () => rig(t, { settings: { maxSessions: 1 }, fakeOptions: { latencyMs: 15 } }));
  const plain = stubSite(t, async () => new Response('<html><title>Just a moment...</title></html>', { status: 403 }));

  const urls = Array.from({ length: 6 }, (_, i) => `${SITE}/doomed/${i}`);
  const results = await Promise.all(urls.map((url) => fu.executeFlareSolverr(url, fake.url)));

  results.forEach((html, i) => assert.ok(html.includes(`/doomed/${i}`)));
  assert.equal(navigations(fake).length, 6, 'each lookup needed the browser after all');
  // 6 navigations save 6 cookies. One failing try per cookie is the most there may be; one per
  // waiting lookup and cookie would be 5 + 4 + 3 + 2 + 1 = 15.
  assert.ok(plain.length <= 6, `${plain.length} plain requests`);
});

test('with the proxy of Settings in use no preflight is sent: a plain request would leave from the address of the app', async (t) => {
  const settings = { flaresolverrUrl: null, proxyUrl: 'http://proxy.example:8080' };
  const { fake, fu } = await withPool({ hostSpacingMs: PRODUCTION.hostSpacingMs / SCALE }, () => rig(t, { readStore: async () => ({ settings }), fakeOptions: { latencyMs: 40 } }));
  settings.flaresolverrUrl = fake.url;
  const plain = stubProtectedSite(t); // would hand the page to a request that carries the cookie

  const results = await Promise.all([1, 2, 3].map((i) => fu.executeFlareSolverr(`${SITE}/proxied/${i}`, fake.url)));

  results.forEach((html, i) => assert.ok(html.includes(`/proxied/${i + 1}`)));
  assert.deepEqual(plain, [], 'not one plain request');
  assert.equal(navigations(fake).length, 3, 'every lookup went to the browser that has the proxy');
});
