'use strict';

// The web cover search (server/modules/cover-search/index.js) asks a real browser (FlareSolverr) first and a plain request second. Measured on
// a real FlareSolverr on 2026-11-01: the Brave images page takes 12 s with a cold browser and 7 s with a warm one, and Brave answers 429 to
// the plain request. Two faults followed from that, and both are pinned here:
//  - the browser was given 8 s, so every search gave up just before the page arrived and fell back to the request Brave refuses;
//  - that refusal put the host on a five-minute cooldown which was checked BEFORE the browser, so one refused plain request made every
//    later search fail even though the browser path works.
// The network layer is stubbed (nothing here touches Brave or a browser).

const test = require('node:test');
const assert = require('node:assert/strict');
const { CALLER_PATIENCE } = require('../../server/config/solver');

const FETCH_UTILS = require.resolve('../../server/modules/network/fetch-utils');
const SAFE_FETCH = require.resolve('../../server/modules/network/safe-fetch');
const MODULE = require.resolve('../../server/modules/cover-search');

require(MODULE); // the real one first: the modules it shares with the rest of the server load against the real network layer, once

const page = (n) => `<html><script>{title:"Cover ${n}",x:1,original:"https://images.example.org/${n}.jpg"}</script></html>`;

function load(t, { solver, plain, options = {} }) {
  const calls = { solver: 0, plain: 0 };
  const stub = (file, exports) => { require.cache[file] = { id: file, filename: file, loaded: true, children: [], paths: [], exports }; };
  stub(FETCH_UTILS, { DEFAULT_USER_AGENT: 'test-agent', resolveViaSolver: async (url) => { calls.solver++; return solver(url, calls); } });
  stub(SAFE_FETCH, { safeFetch: async (url, init) => { calls.plain++; return plain(url, init, calls); } });
  delete require.cache[MODULE];
  const mod = require(MODULE);
  mod.configure({ searchSpacingMs: 0, saveDebounceMs: 5, ...options });
  t.after(() => { delete require.cache[MODULE]; delete require.cache[FETCH_UTILS]; delete require.cache[SAFE_FETCH]; });
  return { mod, calls };
}

const refused = () => ({ status: 429, ok: false, text: async () => '' });

test('the browser is given long enough for the page it was measured to need, and the whole search stays inside what the API allows', () => {
  assert.ok(CALLER_PATIENCE.coverTryMs >= 20_000, 'a cold browser takes 12 s: 8 s made every search give up just before the page arrived');
  assert.ok(CALLER_PATIENCE.coverGiveUpMarginMs < CALLER_PATIENCE.coverTryMs);
  assert.ok(CALLER_PATIENCE.coverTotalMs > CALLER_PATIENCE.coverTryMs, 'the plain fallback has some time left');
  assert.ok(CALLER_PATIENCE.coverTotalMs <= 28_000, '/api answers within 30 s');
});

test('a slow browser that does deliver is used, and the plain request is never made', async (t) => {
  const { mod, calls } = load(t, {
    solver: async () => { await new Promise((resolve) => { setTimeout(resolve, 120); }); return page('slow'); },
    plain: refused,
  });
  const r = await mod.searchCoverImages({ q: 'slow but fine', count: 12 });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].cover, 'https://images.example.org/slow.jpg');
  assert.equal(r.rateLimited, false);
  assert.equal(calls.plain, 0);
});

test('one refused plain request no longer stops the browser path for the next five minutes', async (t) => {
  let browserUp = false;
  const { mod, calls } = load(t, {
    solver: async () => { if (!browserUp) throw new Error('FlareSolverr is not reachable'); return page('after'); },
    plain: refused,
  });
  const first = await mod.searchCoverImages({ q: 'first search', count: 12 });
  assert.deepEqual([first.items.length, first.rateLimited], [0, true], 'no browser: the plain request is refused (429)');
  assert.equal(calls.plain, 1);

  browserUp = true; // the browser is there now: the host is on cooldown for plain requests, which is no reason not to use it
  const second = await mod.searchCoverImages({ q: 'second search', count: 12 });
  assert.equal(second.items.length, 1, 'the browser was asked although the cooldown is running');
  assert.equal(second.rateLimited, false);
  assert.equal(calls.plain, 1, 'and the plain request, which is what is refused, was not made again');
});

test('with no browser at all, a host on cooldown is not asked again until it is over (the cooldown still protects the plain request)', async (t) => {
  const { mod, calls } = load(t, { solver: async () => { throw new Error('connect ECONNREFUSED'); }, plain: refused });
  await mod.searchCoverImages({ q: 'one', count: 12 });
  assert.equal(calls.plain, 1);
  const again = await mod.searchCoverImages({ q: 'two', count: 12 });
  assert.equal(again.rateLimited, true);
  assert.equal(calls.plain, 1, 'no second plain request during the cooldown');
});

test('with no browser, a host that does answer plain requests still works, bounded by the time left of the search', async (t) => {
  let init;
  const { mod } = load(t, { solver: async () => { throw new Error('not configured'); }, plain: async (_url, i) => { init = i; return { status: 200, ok: true, text: async () => page('plain') }; } });
  const r = await mod.searchCoverImages({ q: 'plain works', count: 12 });
  assert.equal(r.items[0].cover, 'https://images.example.org/plain.jpg');
  assert.ok(init.signal, 'the plain request has its own timeout');
});

test('the cover picker says when the web image search was limited, instead of "no results found", and counts the pause down', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const picker = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'modules', 'ui-cover-picker.js'), 'utf8');
  assert.match(picker, /if \(data\.rateLimited\) coverLimitedMessage\(gridEl, data\.retryInMs\);\s+else gridEl\.innerHTML = '<p class="muted">No cover results found\. Try a shorter title\.<\/p>';/);
  assert.match(picker, /The web image search is being limited right now\. Try again in a few minutes\./, 'no wait known: the old words');
  assert.match(picker, /_showCoverRateLimited\(primaryResult\.retryInMs\)/);
  assert.match(picker, /_showCoverRateLimited\(fallbackResult\.retryInMs\)/);
  assert.match(picker, /return \{ found: anyFound, rateLimited: true, retryInMs: data\.retryInMs \|\| 0 \}/, 'the wait is carried through the candidate chain');
});

// ── "load more" and the bot check ───────────────────────────────────────────

const pageOf = (n) => `<html><script>${Array.from({ length: n }, (_, i) => `{title:"Cover ${i}",x:1,original:"https://images.example.org/${i}.jpg"}`).join(',')}</script></html>`;
const BOT_CHECK = '<html><head><title>Brave Search</title></head><body>Verifying you&#x27;re not a bot. Quick check before you continue searching. Your request has been flagged as being suspicious and Brave Search decided to schedule a captcha</body></html>';

test('"load more" is served from the one list a search fetched: pages are slices of it, and no second request is made', async (t) => {
  const { mod, calls } = load(t, { solver: async () => pageOf(30), plain: refused });
  const first = await mod.searchCoverImages({ q: 'many covers', start: 0, count: 12 });
  const second = await mod.searchCoverImages({ q: 'many covers', start: 12, count: 12 });
  const third = await mod.searchCoverImages({ q: 'many covers', start: 24, count: 12 });
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [12, 12, 6]);
  assert.deepEqual([first.hasNextPage, second.hasNextPage, third.hasNextPage], [true, true, false], 'the last, partial page says there is no more');
  const covers = [...first.items, ...second.items, ...third.items].map((i) => i.cover);
  assert.equal(new Set(covers).size, 30, 'every page is different: nothing repeated, nothing missing');
  assert.equal(calls.solver, 1, 'one browser request for the whole search');
  assert.equal(calls.plain, 0);
});

test('a list is kept per safe flag: a filtered search never gets the unfiltered list', async (t) => {
  const { mod, calls } = load(t, { solver: async () => pageOf(5), plain: refused });
  await mod.searchCoverImages({ q: 'flagged list', count: 12 });
  await mod.searchCoverImages({ q: 'flagged list', count: 12, safe: '1' });
  assert.equal(calls.solver, 2);
});

test('Brave\'s bot check is a block, not "no results": the answer says so, and the host is left alone for a while', async (t) => {
  const { mod, calls } = load(t, { solver: async () => BOT_CHECK, plain: refused });
  const first = await mod.searchCoverImages({ q: 'checked search', count: 12 });
  assert.deepEqual([first.items.length, first.rateLimited], [0, true]);
  assert.equal(calls.solver, 1);
  const again = await mod.searchCoverImages({ q: 'another search', count: 12 });
  assert.deepEqual([again.items.length, again.rateLimited], [0, true], 'still blocked: said at once');
  assert.deepEqual([calls.solver, calls.plain], [1, 0], 'and neither the browser nor the plain request asked Brave again (that only keeps the check going)');
});

test('an ordinary page that merely has no results is still "nothing found", not a block', async (t) => {
  const { mod } = load(t, { solver: async () => '<html><body>No results for your query</body></html>', plain: refused });
  const r = await mod.searchCoverImages({ q: 'no such cover anywhere', count: 12 });
  assert.deepEqual([r.items.length, r.rateLimited], [0, false]);
});

// ── the pause: how long, remembered, growing; lists kept on disk; one search at a time ─────────────────────────

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const MIN = 60_000;
const tempDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-search-test-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
};
const settle = () => new Promise((resolve) => { setTimeout(resolve, 150); }); // the debounced save (5 ms here) has written its file
const seedState = (dir, state) => fs.writeFileSync(path.join(dir, 'cover-search-state.json'), JSON.stringify({ brave: { value: state, at: Date.now() } }));
const near = (value, minutes) => Math.abs(value - minutes * MIN) < 5_000;

test('a bot check says how long the pause is: ten minutes the first time', async (t) => {
  const { mod } = load(t, { solver: async () => BOT_CHECK, plain: refused });
  const r = await mod.searchCoverImages({ q: 'first check', count: 12 });
  assert.equal(r.rateLimited, true);
  assert.ok(near(r.retryInMs, 10), 'retryInMs is ' + r.retryInMs);
  const again = await mod.searchCoverImages({ q: 'second one', count: 12 });
  assert.ok(again.retryInMs > 9 * MIN && again.retryInMs <= r.retryInMs, 'the same pause, running down');
  const ok = await load(t, { solver: async () => pageOf(3), plain: refused }).mod.searchCoverImages({ q: 'not limited', count: 12 });
  assert.deepEqual([ok.rateLimited, ok.retryInMs], [false, 0], 'an answer that was not limited carries no wait');
});

test('the pause doubles each time the check comes back after one, up to two hours, and starts over after a good search or a long quiet time', async (t) => {
  const check = async (state) => {
    const dir = tempDir(t);
    if (state) seedState(dir, state);
    const { mod } = load(t, { solver: async () => BOT_CHECK, plain: refused, options: { cacheDir: dir } });
    return (await mod.searchCoverImages({ q: 'again', count: 12 })).retryInMs;
  };
  const ended = Date.now() - 1_000; // the last pause has just ended
  assert.ok(near(await check({ until: ended, strikes: 1 }), 20));
  assert.ok(near(await check({ until: ended, strikes: 2 }), 40));
  assert.ok(near(await check({ until: ended, strikes: 6 }), 120), 'the limit');
  assert.ok(near(await check({ until: Date.now() - 7 * 3_600_000, strikes: 5 }), 10), 'seven hours of quiet: starts over');

  const dir = tempDir(t);
  seedState(dir, { until: ended, strikes: 3 });
  const worked = load(t, { solver: async () => pageOf(4), plain: refused, options: { cacheDir: dir } });
  await worked.mod.searchCoverImages({ q: 'a good one', count: 12 });
  await settle();
  const next = load(t, { solver: async () => BOT_CHECK, plain: refused, options: { cacheDir: dir } });
  assert.ok(near((await next.mod.searchCoverImages({ q: 'and a check', count: 12 })).retryInMs, 10), 'a good search ended the run of checks');
});

test('the pause survives a restart: the app does not go back to asking Brave', async (t) => {
  const dir = tempDir(t);
  const before = load(t, { solver: async () => BOT_CHECK, plain: refused, options: { cacheDir: dir } });
  await before.mod.searchCoverImages({ q: 'trips the check', count: 12 });
  await settle();
  const after = load(t, { solver: async () => pageOf(3), plain: refused, options: { cacheDir: dir } });
  const r = await after.mod.searchCoverImages({ q: 'a different search', count: 12 });
  assert.deepEqual([r.items.length, r.rateLimited], [0, true]);
  assert.ok(r.retryInMs > 9 * MIN, 'the rest of the pause: ' + r.retryInMs);
  assert.deepEqual([after.calls.solver, after.calls.plain], [0, 0], 'Brave was not asked');
});

test('the list of a search is kept on disk: the same title after a restart costs Brave nothing', async (t) => {
  const dir = tempDir(t);
  const before = load(t, { solver: async () => pageOf(30), plain: refused, options: { cacheDir: dir } });
  const first = await before.mod.searchCoverImages({ q: 'kept a day', start: 0, count: 12 });
  assert.equal(first.items.length, 12);
  await settle();
  const after = load(t, { solver: async () => { throw new Error('Brave must not be asked'); }, plain: refused, options: { cacheDir: dir } });
  const more = await after.mod.searchCoverImages({ q: 'kept a day', start: 12, count: 12 });
  assert.equal(more.items.length, 12);
  assert.equal(more.items[0].cover, 'https://images.example.org/12.jpg', 'the second page of the same list');
  assert.deepEqual([after.calls.solver, after.calls.plain], [0, 0]);
});

test('a list is served even while the host is paused (the pause only stops new requests)', async (t) => {
  const dir = tempDir(t);
  const warm = load(t, { solver: async () => pageOf(5), plain: refused, options: { cacheDir: dir } });
  await warm.mod.searchCoverImages({ q: 'already here', count: 12 });
  await warm.mod.searchCoverImages({ q: 'new one', count: 12 }); // a second good page
  seedState(dir, { until: Date.now() + 30 * MIN, strikes: 1 });
  await settle();
  const paused = load(t, { solver: async () => BOT_CHECK, plain: refused, options: { cacheDir: dir } });
  const hit = await paused.mod.searchCoverImages({ q: 'already here', count: 12 });
  assert.equal(hit.items.length, 5);
  assert.equal(hit.rateLimited, false);
  const miss = await paused.mod.searchCoverImages({ q: 'never searched', count: 12 });
  assert.deepEqual([miss.items.length, miss.rateLimited], [0, true]);
  assert.equal(paused.calls.solver, 0);
});

test('one real search at a time, and a gap between two of them', async (t) => {
  const log = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { mod } = load(t, {
    solver: async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      log.push({ at: Date.now(), event: 'start' });
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      log.push({ at: Date.now(), event: 'end' });
      inFlight--;
      return pageOf(3);
    },
    plain: refused,
    options: { searchSpacingMs: 150 },
  });
  await Promise.all([
    mod.searchCoverImages({ q: 'overlap one', count: 12 }),
    mod.searchCoverImages({ q: 'overlap two', count: 12 }),
    mod.searchCoverImages({ q: 'overlap three', count: 12 }),
  ]);
  assert.equal(maxInFlight, 1, 'the searches did not overlap');
  const starts = log.filter((e) => e.event === 'start').map((e) => e.at);
  const ends = log.filter((e) => e.event === 'end').map((e) => e.at);
  assert.ok(starts[1] - ends[0] >= 140, 'a gap after the first: ' + (starts[1] - ends[0]));
  assert.ok(starts[2] - ends[1] >= 140, 'and after the second: ' + (starts[2] - ends[1]));
});

test('two requests for the same new search make one request', async (t) => {
  const { mod, calls } = load(t, { solver: async () => { await new Promise((resolve) => { setTimeout(resolve, 30); }); return pageOf(6); }, plain: refused });
  const [a, b] = await Promise.all([mod.searchCoverImages({ q: 'twins', count: 12 }), mod.searchCoverImages({ q: 'twins', count: 12 })]);
  assert.deepEqual([a.items.length, b.items.length], [6, 6]);
  assert.equal(calls.solver, 1);
});
