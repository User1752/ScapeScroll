'use strict';

// The run of the live test: the budget, the stop after three failures in a row, the time limits, the pause between calls, what
// a site that did not answer means, hostile answers, and the real address check of the app. See source-import-livetest.test.js
// for the checks themselves.

const test = require('node:test');
const assert = require('node:assert/strict');

const sourceUi = require('../../server/modules/common/source-ui');
const { withTimeout } = require('../../server/modules/common/async-utils');
const { createLiveTest, DEFAULT_LIMITS, CHECK_IDS, chapterNumber, genreNames } = require('../../server/modules/source-import/live-test');
const { createPageUrlResolver } = require('../../server/modules/network/fetch-utils');
const { isSafeUrl } = require('../../server/modules/common/sanitize');
const { JPEG, refused, sleep, fakeSource, runner, statusOf, detailOf } = require('../helpers/live-test-rig');

test.afterEach(() => sourceUi.clearSourceUiRegistry());

// ── Failures, budget, time ────────────────────────────────────────────────

test('three calls failing in a row stop the run: nothing else is asked of the site, and it is not verified', async () => {
  let afterwards = 0;
  let searches = 0;
  // the first list answers, then the site starts refusing: page 2, the page past the end (a refusal that was asked for, but a
  // 503 is the site not answering) and the text search fail one after another
  const mod = fakeSource({
    search: async () => { searches += 1; if (searches > 1) throw new Error('HTTP 503'); return { results: [{ id: 'a', title: 'Alpha Beta' }], hasNextPage: true }; },
    mangaDetails: async () => { throw new Error('HTTP 503'); },
    byGenres: async () => { afterwards += 1; return { results: [] }; },
  });
  const result = await runner(mod)();
  assert.match(result.aborted, /3 calls failed in a row/);
  assert.equal(statusOf(result, 'search-page-2'), 'fail');
  assert.equal(statusOf(result, 'search-text'), 'fail');
  assert.equal(statusOf(result, 'details'), 'skip');
  assert.equal(statusOf(result, 'chapters'), 'skip');
  assert.match(detailOf(result, 'chapters'), /not run/);
  assert.equal(statusOf(result, 'images'), 'skip');
  assert.equal(statusOf(result, 'never-listed'), 'skip');
  assert.equal(afterwards, 0, 'the genre search was never called');
  assert.equal(result.verified, false);
});

test('a refusal that was asked for does not count as a failure of the site', async () => {
  // eight refused calls in a row (missing title, three bad ids, two never-listed probes) must not stop anything
  const result = await runner(fakeSource({ byGenres: async () => { throw refused('refused', 404); } }))();
  assert.equal(result.aborted, '');
  assert.equal(statusOf(result, 'bad-ids'), 'pass');
});

test('the call budget is a ceiling: what is left is skipped, and the run is not verified', async () => {
  const result = await runner(fakeSource(), { limits: { maxCalls: 4 } })();
  assert.equal(result.calls, 4);
  assert.match(result.aborted, /budget/);
  assert.ok(result.checks.some((c) => c.status === 'skip'));
  assert.equal(result.verified, false);
});

test('a call that never answers is cut at its time limit and counts as a failure', async () => {
  const mod = fakeSource({ mangaDetails: () => new Promise(() => {}) });
  const result = await runner(mod, { limits: { callTimeoutMs: 20 } })();
  assert.equal(statusOf(result, 'details'), 'fail');
  assert.match(detailOf(result, 'details'), /did not answer/);
});

test('the pause between calls is asked for, and not before the first', async () => {
  const waits = [];
  let clock = 0;
  // a clock that moves a little on every read, so the pause is always owed
  const result = await createLiveTest({
    loadSourceFromFile: () => fakeSource(), resolvePageUrl: (p) => ({ url: p.img, referer: '' }), fetchImage: async () => JPEG,
    sleep: async (ms) => { waits.push(ms); }, withTimeout, now: () => (clock += 1), limits: { spacingMs: 777, imageSpacingMs: 55 },
  })({ id: 'fake' });
  assert.ok(result.calls > 5);
  assert.ok(waits.some((ms) => ms > 700 && ms <= 777), 'a pause between calls');
  assert.ok(waits.includes(55), 'a pause between images');
});



test('the budget is what the docs promise: 45 calls, 5 images, three failures in a row, five minutes', () => {
  assert.equal(DEFAULT_LIMITS.maxCalls, 45);
  assert.equal(DEFAULT_LIMITS.maxImages, 5);
  assert.equal(DEFAULT_LIMITS.maxConsecutiveFailures, 3);
  assert.equal(DEFAULT_LIMITS.maxDurationMs, 5 * 60_000);
  assert.ok(Object.isFrozen(DEFAULT_LIMITS));
});

test('the chapter list is judged with a status each: oldest first and repeats fail, a list that is all today is only a warning', async () => {
  const withChapters = (chapters) => fakeSource({ chapters: async (id) => { if (String(id).includes('..')) throw refused('invalid id', 400); return { chapters }; } });
  const ch = (n, extra = {}) => ({ id: `c${n}`, name: `Chapter ${n}`, chapter: String(n), publishAt: null, ...extra });
  const oldestFirst = await runner(withChapters([ch(1), ch(2), ch(3)]))();
  assert.equal(statusOf(oldestFirst, 'chapters'), 'fail');
  assert.equal(oldestFirst.verified, false);
  assert.equal(statusOf(await runner(withChapters([ch(3), ch(3), ch(1)]))(), 'chapters'), 'fail');
  const today = new Date().toISOString();
  const sameDay = await runner(withChapters([4, 3, 2, 1].map((n) => ch(n, { publishAt: today }))))();
  assert.equal(statusOf(sameDay, 'chapters'), 'warn');
  assert.equal(sameDay.verified, true, 'a warning does not stop a source from being verified');
  assert.equal(statusOf(await runner(withChapters([{ id: '', name: 'x' }]))(), 'chapters'), 'fail');
});

test('the number of a chapter: its own field, the number after "Ch", else the last number in the name', () => {
  assert.equal(chapterNumber({ chapter: '12.5' }), 12.5);
  assert.equal(chapterNumber({ name: 'Vol.2 Ch.11' }), 11);
  assert.equal(chapterNumber({ name: 'Chapter 7: Part 2' }), 7);
  assert.equal(chapterNumber({ name: 'Special 3 and 4' }), 4);
  assert.equal(chapterNumber({ name: 'Prologue' }), null);
  assert.equal(chapterNumber({ chapter: '', title: 'Ch 9' }), 9);
});

test('a page 2 that is empty although the source said there was one fails', async () => {
  const mod = fakeSource({ search: async (q, page) => (page === 1 ? { results: [{ id: 'a', title: 'Alpha Beta' }], hasNextPage: true } : { results: [], hasNextPage: false }) });
  const result = await runner(mod)();
  assert.equal(statusOf(result, 'search-page-2'), 'fail');
  assert.match(detailOf(result, 'search-page-2'), /page 2 is empty/);
});

test('details that answer no title fail, and what they leave out is a warning', async () => {
  const missing = (id) => String(id).startsWith('definitely-not');
  const noTitle = fakeSource({ mangaDetails: async (id) => { if (missing(id)) throw refused('nf', 404); return { id }; } });
  assert.equal(statusOf(await runner(noTitle)(), 'details'), 'fail');
  const bare = fakeSource({ mangaDetails: async (id) => { if (missing(id)) throw refused('nf', 404); return { id, title: 'Only A Title' }; } });
  const result = await runner(bare)();
  assert.equal(statusOf(result, 'details'), 'warn');
  assert.match(detailOf(result, 'details'), /no status, genres, description/);
});

test('a source that cannot list without a text is tried again with "a", also when the first try throws', async () => {
  const seen = [];
  const needsText = fakeSource({ search: async (q, page) => { seen.push(q); if (page >= 99999) return { results: [] }; if (q === '') throw new Error('query is required'); return { results: [{ id: 'a', title: 'Alpha Beta', cover: '/c.png' }], hasNextPage: false }; } });
  assert.equal(statusOf(await runner(needsText)(), 'browse'), 'pass');
  assert.deepEqual(seen.slice(0, 2), ['', 'a']);
  const emptyFirst = fakeSource({ search: async (q, page) => { if (page >= 99999) return { results: [] }; return q === '' ? { results: [] } : { results: [{ id: 'a', title: 'Alpha Beta', cover: '/c.png' }], hasNextPage: false }; } });
  assert.equal(statusOf(await runner(emptyFirst)(), 'browse'), 'pass');
  const broken = await runner(fakeSource({ search: async () => { throw new Error('always broken'); } }))();
  assert.equal(statusOf(broken, 'browse'), 'fail');
  assert.match(detailOf(broken, 'browse'), /always broken/);
});

test('the filters the test sends are the ones the app sends: three strings, plus the one being probed', async () => {
  const calls = [];
  sourceUi.registerSourceUi('fake', { filters: { publicationStatus: true } });
  const spy = fakeSource({ search: async (q, page, orderBy, filters) => { calls.push(filters); return page >= 99999 ? { results: [] } : { results: [{ id: 'a', title: 'Alpha Beta' }], hasNextPage: false }; } });
  await runner(spy)('full');
  assert.ok(calls.length > 3);
  for (const f of calls) {
    assert.deepEqual(Object.keys(f).sort(), ['contentRating', 'format', 'publicationStatus']);
    assert.ok(Object.values(f).every((v) => typeof v === 'string'));
  }
  assert.ok(calls.some((f) => f.publicationStatus === 'completed') && calls.some((f) => f.publicationStatus === 'ongoing'));
});

test('an image address the app would not fetch, an image that never answers and a run of refused images each fail the images check', async () => {
  const nowhere = createLiveTest({ loadSourceFromFile: () => fakeSource(), resolvePageUrl: () => null, fetchImage: async () => JPEG, sleep, withTimeout });
  const unresolved = await nowhere({ id: 'fake' });
  assert.equal(statusOf(unresolved, 'images'), 'fail');
  assert.match(detailOf(unresolved, 'images'), /not an address the app can fetch/);
  assert.equal(unresolved.verified, false);
  const hanging = await runner(fakeSource(), { fetchImage: () => new Promise(() => {}), limits: { callTimeoutMs: 20 } })();
  assert.equal(statusOf(hanging, 'images'), 'fail');
  assert.match(detailOf(hanging, 'images'), /did not answer/);
  let fetched = 0;
  const tenPages = fakeSource({ pages: async () => ({ pages: Array.from({ length: 10 }, (_, i) => ({ index: i, img: `https://img.example/${i}.jpg` })) }) });
  const refusing = await runner(tenPages, { fetchImage: async () => { fetched += 1; throw new Error('HTTP 403'); } })();
  assert.equal(statusOf(refusing, 'images'), 'fail');
  assert.equal(fetched, 3, 'it stops after three in a row instead of hammering the CDN');
});

test('the images of a long chapter are a sample of at most five: first, last, middle and two more', async () => {
  const fetched = [];
  const long = fakeSource({ pages: async () => ({ pages: Array.from({ length: 40 }, (_, i) => ({ index: i, img: `https://img.example/${i}.jpg` })) }) });
  const result = await runner(long, { fetchImage: async (url) => { fetched.push(Number(/(\d+)\.jpg/.exec(url)[1])); return JPEG; } })();
  assert.equal(result.images, 5);
  assert.deepEqual([...fetched].sort((a, b) => a - b), [0, 1, 20, 38, 39]);
});

test('the real address check of the app refuses private, local and non-web addresses, so the test never sends a request to them', () => {
  const { resolvePageUrl } = createPageUrlResolver({ isSafeUrl });
  const refusedAddresses = ['http://127.0.0.1/a.jpg', 'http://localhost:4000/a.jpg', 'http://10.0.0.5/a.jpg', 'http://172.16.0.1/a.jpg', 'http://192.168.1.1/a.jpg', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'ftp://example.com/a.jpg', 'http://[::1]/a.jpg'];
  for (const bad of refusedAddresses) assert.equal(resolvePageUrl({ img: bad }), null, bad);
  assert.ok(resolvePageUrl({ img: 'https://img.example.com/a.jpg' }));
});

test('a source whose pages point at the private network fails the images check without a single image request', async () => {
  const { resolvePageUrl } = createPageUrlResolver({ isSafeUrl });
  let requests = 0;
  const hostile = fakeSource({ pages: async () => ({ pages: [{ index: 0, img: 'http://127.0.0.1:4000/api/state' }, { index: 1, img: 'http://169.254.169.254/' }, { index: 2, img: 'file:///c:/windows/win.ini' }] }) });
  const run = createLiveTest({ loadSourceFromFile: () => hostile, resolvePageUrl, fetchImage: async () => { requests += 1; return JPEG; }, sleep, withTimeout });
  const result = await run({ id: 'fake' });
  assert.equal(statusOf(result, 'images'), 'fail');
  assert.equal(requests, 0);
});

test('the time limit of the whole run is enforced, and what is left is skipped', async () => {
  let clock = 0;
  const run = createLiveTest({
    loadSourceFromFile: () => fakeSource(), resolvePageUrl: (p) => ({ url: p.img, referer: '' }), fetchImage: async () => JPEG,
    sleep, withTimeout, now: () => { clock += 60_000; return clock; }, limits: { maxDurationMs: 5 * 60_000 },
  });
  const result = await run({ id: 'fake' });
  assert.match(result.aborted, /time limit/);
  assert.ok(result.checks.some((c) => c.status === 'skip'));
  assert.equal(result.verified, false);
});

test('a refusal that was asked for still counts when it is the site not answering (a 503, a timeout, a block)', async () => {
  const asked = (id) => String(id).startsWith('definitely-not') || String(id).includes('..');
  const down = fakeSource({
    mangaDetails: async (id) => { if (asked(id)) throw new Error('HTTP 503'); return { id, title: 'Title Number 0', status: 'ongoing', genres: [], description: 'x' }; },
    chapters: async () => { throw new Error('HTTP 503'); },
  });
  const result = await runner(down)();
  assert.match(result.aborted, /3 calls failed in a row/);
  assert.equal(result.verified, false);
});

test('a site that did not answer is "inconclusive", never "refused": missing-title, bad-ids and never-listed do not pass on it', async () => {
  const asked = (id) => String(id).startsWith('definitely-not') || String(id).includes('..');
  const mod = fakeSource({
    mangaDetails: async (id) => { if (asked(id)) throw new Error('timed out'); return { id, title: 'Title Number 0', status: 'ongoing', genres: ['Action'], description: 'x' }; },
    byGenres: async () => { throw new Error('timed out'); },
  });
  const result = await runner(mod, { limits: { maxConsecutiveFailures: 99 } })();
  assert.equal(statusOf(result, 'missing-title'), 'warn');
  assert.match(detailOf(result, 'missing-title'), /inconclusive/);
  assert.equal(statusOf(result, 'bad-ids'), 'warn');
  assert.equal(statusOf(result, 'never-listed'), 'warn');
  assert.match(detailOf(result, 'never-listed'), /inconclusive/);
});

test('the never-listed scan reads genres in every shape a source uses, and look-alike spellings', async () => {
  assert.deepEqual(genreNames({ genres: ['A', { name: 'B' }, { title: 'C' }], tags: 'D, E' }), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(genreNames({ genres: 'X; Y' }), ['X', 'Y']);
  assert.deepEqual(genreNames(null), []);
  const shapes = [['Comedy', { name: '\uFF2C\uFF4F\uFF4C\uFF49' }], 'Action, Shotacon', [{ label: 'Tod\u200Bdler' }]];
  for (const genres of shapes) {
    const mod = fakeSource({ search: async (q, page) => (page >= 99999 ? { results: [] } : { results: [{ id: 'a', title: 'Alpha Beta', genres }], hasNextPage: false }) });
    assert.equal(statusOf(await runner(mod)(), 'never-listed'), 'fail', JSON.stringify(genres));
  }
  const inDetails = fakeSource({ mangaDetails: async (id) => { if (String(id).startsWith('definitely-not')) throw refused('nf', 404); return { id, title: 'T', genres: ['Loli'], status: 'x', description: 'y' }; } });
  assert.equal(statusOf(await runner(inDetails)(), 'never-listed'), 'fail', 'the tags on a details answer count too');
});

test('all four never-listed names are searched as genres', async () => {
  const asked = [];
  await runner(fakeSource({ byGenres: async (genres) => { asked.push(genres[0]); return { results: [] }; } }))();
  assert.deepEqual(asked.slice(0, 4), ['Loli', 'Shota', 'Lolicon', 'Shotacon']);
});

test('a report line never carries a local path, and a hostile error object does not escape the run', async () => {
  const leaky = fakeSource({ mangaDetails: async (id) => { if (String(id).startsWith('definitely-not')) throw refused('nf', 404); throw new Error('ENOENT: no such file C:\\Users\\someone\\secret\\data.json'); } });
  const result = await runner(leaky)();
  assert.doesNotMatch(detailOf(result, 'details'), /someone/);
  const hostile = fakeSource({ mangaDetails: async () => { throw { get message() { throw new Error('getter'); } }; } });
  assert.equal(statusOf(await runner(hostile)(), 'details'), 'fail');
});

test('a source that will not load is tagged for the service; the run throws the error itself', async () => {
  const run = createLiveTest({ loadSourceFromFile: () => { throw new Error('Cannot find module'); }, resolvePageUrl: () => null, fetchImage: async () => JPEG, sleep, withTimeout });
  await assert.rejects(run({ id: 'fake' }), (err) => err.liveTestLoad === true && /Cannot find module/.test(err.message));
});

test('the check ids are unique and include the ones the card must have titles for', () => {
  assert.equal(new Set(CHECK_IDS).size, CHECK_IDS.length);
  for (const id of ['browse', 'images', 'never-listed', 'declared-sort', 'list-trending']) assert.ok(CHECK_IDS.includes(id), id);
});

test('pages that are all one picture, or a loading placeholder, fail: the images load, but they are not the chapter', async () => {
  const proxied = (url) => `/api/proxy-image?url=${encodeURIComponent(url)}`;
  const withPages = (pages) => fakeSource({ pages: async (id) => { if (String(id).includes('..')) throw refused('invalid id', 400); return { pages }; } });
  const sameOne = await runner(withPages([0, 1, 2].map((i) => ({ index: i, img: proxied('https://site.example/themes/x/images/Loading/Loading.gif') }))))();
  assert.equal(statusOf(sameOne, 'pages'), 'fail');
  assert.match(detailOf(sameOne, 'pages'), /same image/);
  assert.equal(sameOne.verified, false);
  assert.equal(statusOf(sameOne, 'images'), 'skip', 'nothing is fetched for pages that are already known to be wrong');
  const mixed = await runner(withPages([{ index: 0, img: 'https://cdn.example/a.webp' }, { index: 1, img: 'https://cdn.example/img/loading.gif' }, { index: 2, img: 'https://cdn.example/c.webp' }]))();
  assert.equal(statusOf(mixed, 'pages'), 'fail');
  assert.match(detailOf(mixed, 'pages'), /1 of 3 pages are a loading placeholder/);
  const fine = await runner(withPages([0, 1, 2].map((i) => ({ index: i, img: proxied(`https://cdn.example/2026/10/${i}-reloading-title.webp`) }))))();
  assert.equal(statusOf(fine, 'pages'), 'pass', 'a title that merely contains the letters is not a placeholder');
  const single = await runner(withPages([{ index: 0, img: 'https://cdn.example/only.webp' }]))();
  assert.equal(statusOf(single, 'pages'), 'pass', 'a one-page chapter is not "all the same"');
});

test('the oldest chapter is opened too: a site can serve a recent chapter in the HTML and an old one by a call the page makes', async () => {
  const placeholder = [0, 1, 2].map((i) => ({ index: i, img: '/api/proxy-image?url=https%3A%2F%2Fsite.example%2Fimages%2FLoading.gif' }));
  const real = (n) => Array.from({ length: n }, (_, i) => ({ index: i, img: `https://cdn.example/${n}/${i}.webp` }));
  const asked = [];
  const mod = fakeSource({
    pages: async (id) => {
      if (String(id).includes('..')) throw refused('invalid id', 400);
      asked.push(id);
      return { pages: id === 'c1' ? placeholder : real(4) }; // fakeSource lists c5 (newest) .. c1 (oldest)
    },
  });
  const result = await runner(mod)();
  assert.deepEqual(asked.slice(0, 2), ['c5', 'c1']);
  assert.equal(statusOf(result, 'pages'), 'fail');
  assert.match(detailOf(result, 'pages'), /oldest chapter: 3 of 3 pages are a loading placeholder|oldest chapter: all 3 pages point at the same image/);
  assert.equal(result.verified, false);
  const fine = await runner(fakeSource())();
  assert.match(detailOf(fine, 'pages'), /in the newest chapter, 4 in the oldest/);
  const single = await runner(fakeSource({ chapters: async (id) => { if (String(id).includes('..')) throw refused('invalid id', 400); return { chapters: [{ id: 'c1', name: 'Chapter 1', chapter: '1', publishAt: null }] }; } }))();
  assert.equal(detailOf(single, 'pages'), '4 pages', 'a title with one chapter is not opened twice');
});
