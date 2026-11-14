'use strict';

// The live test of an installed source (server/modules/source-import/live-test*.js): the manual checklist run against the real
// site on the person's request. Here the "site" is a fake source module, so every check can be made to pass and to fail on
// purpose. This file: the reading checks, what must be refused and what the source declares. The run (budget, abort, time,
// hostile answers) is in source-import-livetest-run.test.js and the service around it in source-import-livetest-service.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const sourceUi = require('../../server/modules/common/source-ui');
const { imageKind, CORE_CHECKS } = require('../../server/modules/source-import/live-test');
const { JPEG, refused, fakeSource, runner, statusOf, detailOf } = require('../helpers/live-test-rig');

test.afterEach(() => sourceUi.clearSourceUiRegistry());

// ── The healthy case ──────────────────────────────────────────────────────

test('a source that does everything right is verified, with every check passed and the cost counted', async () => {
  const result = await runner(fakeSource())();
  assert.equal(result.verified, true);
  assert.equal(result.counts.fail, 0);
  assert.equal(result.aborted, '');
  for (const id of ['browse', 'search-page-2', 'search-past-end', 'search-text', 'details', 'chapters', 'pages', 'images', 'missing-title', 'bad-ids', 'never-listed']) {
    assert.equal(statusOf(result, id), 'pass', `${id}: ${detailOf(result, id)}`);
  }
  assert.equal(result.images, 4, 'every page of a short chapter is fetched');
  assert.ok(result.calls > 5 && result.calls <= 30, `${result.calls} calls`);
  assert.ok(CORE_CHECKS.every((id) => statusOf(result, id) === 'pass'));
  assert.equal(result.depth, 'basic');
});

test('the basic test leaves out the sort, filter and list measurements; the full one runs them', async () => {
  sourceUi.registerSourceUi('fake', { genres: ['Action'], orderBy: [{ value: 'relevance', label: 'A' }, { value: 'rating', label: 'B' }], filters: { orderBy: true, format: true } });
  const basic = await runner(fakeSource())();
  assert.ok(!basic.checks.some((c) => /^declared-(sort|format|publicationStatus|contentRating)$|^list-/.test(c.id)));
  const full = await runner(fakeSource({ trending: async () => ({ results: [{ id: 't', title: 'T', genres: [] }] }) }))('full');
  assert.equal(statusOf(full, 'declared-sort'), 'pass', detailOf(full, 'declared-sort'));
  assert.equal(statusOf(full, 'declared-format'), 'pass', detailOf(full, 'declared-format'));
  assert.equal(statusOf(full, 'declared-publicationStatus'), 'skip');
  assert.equal(statusOf(full, 'list-trending'), 'pass');
});

// ── Listing and paging ────────────────────────────────────────────────────

test('a page 2 that is page 1 again fails; a source with one page is not asked for a second', async () => {
  const same = fakeSource({ search: async (q, page) => (page >= 99999 ? { results: [], hasNextPage: false } : { results: [{ id: 'x1', title: 'Same One' }, { id: 'x2', title: 'Same Two' }], hasNextPage: true }) });
  const result = await runner(same)();
  assert.equal(statusOf(result, 'search-page-2'), 'fail');
  assert.match(detailOf(result, 'search-page-2'), /page 1 again/);
  const single = fakeSource({ search: async (q, page) => (page > 1 ? { results: [] } : { results: [{ id: 'x1', title: 'Only One' }], hasNextPage: false }) });
  assert.equal(statusOf(await runner(single)(), 'search-page-2'), 'skip');
});

test('a page past the end must be empty (or refused): repeating page 1 fails', async () => {
  const repeats = fakeSource({ search: async () => ({ results: [{ id: 'x1', title: 'Same One' }], hasNextPage: false }) });
  assert.equal(statusOf(await runner(repeats)(), 'search-past-end'), 'fail');
  const refusing = fakeSource({ search: async (q, page) => { if (page >= 99999) throw refused('no such page', 404); return { results: [{ id: 'x1', title: 'Only One' }], hasNextPage: false }; } });
  assert.equal(statusOf(await runner(refusing)(), 'search-past-end'), 'pass');
});

test('a list with nothing in it, and items without an id or a title, fail the first check and skip what needs a title', async () => {
  const empty = await runner(fakeSource({ search: async () => ({ results: [], hasNextPage: false }) }))();
  assert.equal(statusOf(empty, 'browse'), 'fail');
  assert.equal(statusOf(empty, 'details'), 'skip');
  assert.equal(statusOf(empty, 'chapters'), 'skip');
  assert.equal(empty.verified, false);
  const broken = await runner(fakeSource({ search: async () => ({ results: [{ id: '', title: 'x' }, { id: 'a', title: '' }], hasNextPage: false }) }))();
  assert.equal(statusOf(broken, 'browse'), 'fail');
  assert.match(detailOf(broken, 'browse'), /lack an id or a title/);
  const notShaped = await runner(fakeSource({ search: async () => ({}) }))();
  assert.match(detailOf(notShaped, 'browse'), /did not answer/);
});

test('a text search that finds nothing for a word the site just listed fails; results without the word are only a warning', async () => {
  const none = fakeSource({ search: async (q) => (q === '' ? { results: [{ id: 'a', title: 'Alpha Beta' }], hasNextPage: false } : { results: [], hasNextPage: false }) });
  assert.equal(statusOf(await runner(none)(), 'search-text'), 'fail');
  const fuzzy = fakeSource({ search: async (q) => (q === '' ? { results: [{ id: 'a', title: 'Alpha Beta' }], hasNextPage: false } : { results: [{ id: 'z', title: 'Something Else' }], hasNextPage: false }) });
  assert.equal(statusOf(await runner(fuzzy)(), 'search-text'), 'warn');
});

// ── Chapters ──────────────────────────────────────────────────────────────

test('the chapter list is judged: order, repeats, dates that are not dates, in the future, or all today', async () => {
  const withChapters = (chapters) => fakeSource({ chapters: async () => ({ chapters }) });
  const ch = (n, extra = {}) => ({ id: `c${n}`, name: `Chapter ${n}`, chapter: String(n), publishAt: null, ...extra });
  assert.match(detailOf(await runner(withChapters([ch(1), ch(2), ch(3)]))(), 'chapters'), /oldest first/);
  assert.match(detailOf(await runner(withChapters([ch(3), ch(3), ch(1)]))(), 'chapters'), /repeated/);
  assert.match(detailOf(await runner(withChapters([ch(2, { publishAt: 'yesterday-ish' }), ch(1)]))(), 'chapters'), /not dates/);
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();
  assert.match(detailOf(await runner(withChapters([ch(2, { publishAt: future }), ch(1)]))(), 'chapters'), /in the future/);
  const today = new Date().toISOString();
  assert.match(detailOf(await runner(withChapters([4, 3, 2, 1].map((n) => ch(n, { publishAt: today }))))(), 'chapters'), /today/);
  const nulls = await runner(withChapters([ch(3), ch(2), ch(1)]))();
  assert.equal(statusOf(nulls, 'chapters'), 'pass');
  assert.match(detailOf(nulls, 'chapters'), /0 with a date/);
  assert.equal(statusOf(await runner(withChapters([]))(), 'chapters'), 'fail');
});

// ── Pages and images ──────────────────────────────────────────────────────

test('pages with nothing in them, an image that is refused and bytes that are not an image all fail', async () => {
  assert.equal(statusOf(await runner(fakeSource({ pages: async () => ({ pages: [] }) }))(), 'pages'), 'fail');
  const noPages = await runner(fakeSource({ pages: async () => ({ pages: [] }) }))();
  assert.equal(statusOf(noPages, 'images'), 'skip');
  const forbidden = await runner(fakeSource(), { fetchImage: async () => { throw new Error('HTTP 403'); } })();
  assert.equal(statusOf(forbidden, 'images'), 'fail');
  assert.match(detailOf(forbidden, 'images'), /HTTP 403/);
  const html = await runner(fakeSource(), { fetchImage: async () => Buffer.from('<html>blocked</html>'.padEnd(40, ' ')) })();
  assert.equal(statusOf(html, 'images'), 'fail');
  assert.match(detailOf(html, 'images'), /not an image/);
  const noAddress = await runner(fakeSource({ pages: async () => ({ pages: [{ index: 0, img: '' }] }) }))();
  assert.match(detailOf(noAddress, 'pages'), /no image address/);
});

test('image kinds are recognised by their first bytes', () => {
  assert.equal(imageKind(JPEG), 'jpeg');
  assert.equal(imageKind(Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(8)])), 'png');
  assert.equal(imageKind(Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4), Buffer.from('WEBP', 'latin1'), Buffer.alloc(8)])), 'webp');
  assert.equal(imageKind(Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(12)])), 'gif');
  assert.equal(imageKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif', 'latin1'), Buffer.alloc(4)])), 'avif');
  assert.equal(imageKind(Buffer.from('not an image at all, just text')), '');
  assert.equal(imageKind(Buffer.alloc(4)), '');
  assert.equal(imageKind(null), '');
});

// ── What must be refused ──────────────────────────────────────────────────

test('a title that does not exist must answer 404; anything else is told apart', async () => {
  assert.equal(statusOf(await runner(fakeSource({ mangaDetails: async (id) => ({ id, title: 'Made up' }) }))(), 'missing-title'), 'fail');
  const plain = await runner(fakeSource({ mangaDetails: async (id) => { if (String(id).startsWith('definitely-not')) throw new Error('boom'); return { id, title: 'T' }; } }))();
  assert.equal(statusOf(plain, 'missing-title'), 'warn');
  const four = await runner(fakeSource({ mangaDetails: async (id) => { if (String(id).startsWith('definitely-not')) throw refused('bad', 400); return { id, title: 'T' }; } }))();
  assert.equal(statusOf(four, 'missing-title'), 'warn');
});

test('a path-like id must be refused by details, chapters and pages; answering it fails, a bare Error is only a warning', async () => {
  assert.equal(statusOf(await runner(fakeSource({ pages: async () => ({ pages: [{ index: 0, img: 'https://img.example/0.jpg' }] }) }))(), 'bad-ids'), 'fail');
  const loose = await runner(fakeSource({ chapters: async (id) => { if (String(id).includes('..')) throw new Error('no'); return { chapters: [{ id: 'c1', name: 'Chapter 1', chapter: '1', publishAt: null }] }; } }))();
  assert.equal(statusOf(loose, 'bad-ids'), 'warn');
  assert.match(detailOf(loose, 'bad-ids'), /500/);
});

test('a never-listed category must give nothing, in a genre search and in the tags of every title seen', async () => {
  const leaks = fakeSource({ byGenres: async (genres) => ({ results: [{ id: 'l1', title: 'Leak', genres: [genres[0]] }], hasNextPage: false }) });
  const searched = await runner(leaks)();
  assert.equal(statusOf(searched, 'never-listed'), 'fail');
  assert.match(detailOf(searched, 'never-listed'), /never listed/);
  const tagged = await runner(fakeSource({ search: async (q, page) => (page >= 99999 ? { results: [] } : { results: [{ id: 'a', title: 'Alpha Beta', genres: ['Comedy', 'Oppai Loli'] }], hasNextPage: false }) }))();
  assert.equal(statusOf(tagged, 'never-listed'), 'fail');
  assert.match(detailOf(tagged, 'never-listed'), /carry a category that is never listed/);
  const refusing = await runner(fakeSource({ byGenres: async () => { throw refused('refused', 404); } }))();
  assert.equal(statusOf(refusing, 'never-listed'), 'pass', 'a refusal is also "not listed"');
  const noGenres = fakeSource();
  delete noGenres.byGenres;
  assert.equal(statusOf(await runner(noGenres)(), 'never-listed'), 'pass');
});

// ── What the source declares ──────────────────────────────────────────────

test('a declared genre list is tried: titles tagged with it pass, titles that are not are a warning, nothing is a failure', async () => {
  sourceUi.registerSourceUi('fake', { genres: ['Action', 'Comedy'] });
  assert.equal(statusOf(await runner(fakeSource())(), 'declared-genres'), 'pass');
  const untagged = await runner(fakeSource({ byGenres: async () => ({ results: [{ id: 'g', title: 'G', genres: ['Other'] }] }) }))();
  assert.equal(statusOf(untagged, 'declared-genres'), 'warn');
  const empty = await runner(fakeSource({ byGenres: async (genres) => (/loli|shota/i.test(genres[0]) ? { results: [] } : { results: [] }) }))();
  assert.equal(statusOf(empty, 'declared-genres'), 'fail');
  const noMethod = fakeSource();
  delete noMethod.byGenres;
  assert.equal(statusOf(await runner(noMethod)(), 'declared-genres'), 'fail');
  sourceUi.clearSourceUiRegistry();
  assert.equal(statusOf(await runner(fakeSource())(), 'declared-genres'), 'skip');
});

test('a declared genre whose own name has a slash is matched by the tag as a whole, since a tag is otherwise cut at a slash', async () => {
  sourceUi.registerSourceUi('fake', { genres: ['3D / Digital Art', 'Comedy'] });
  const whole = fakeSource({ byGenres: async (genres) => ({ results: [{ id: 'g1', title: 'One', genres: [genres[0], 'Other'] }, { id: 'g2', title: 'Two', genres: [genres[0]] }] }) });
  assert.equal(statusOf(await runner(whole)(), 'declared-genres'), 'pass');
  const notThere = fakeSource({ byGenres: async () => ({ results: [{ id: 'g3', title: 'Three', genres: ['3D', 'Digital Art Other'] }] }) });
  assert.equal(statusOf(await runner(notThere)(), 'declared-genres'), 'warn', 'a title that only has a piece of the name is not tagged with it');
  sourceUi.clearSourceUiRegistry();
});

test('declared sort values and filters that all give the same list are decorative and fail the full test', async () => {
  sourceUi.registerSourceUi('fake', { orderBy: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }], filters: { orderBy: true, publicationStatus: true } });
  const decorative = fakeSource({ search: async (q, page) => (page >= 99999 ? { results: [] } : { results: [{ id: 'same1', title: 'Same One' }, { id: 'same2', title: 'Same Two' }], hasNextPage: false }) });
  const result = await runner(decorative)('full');
  assert.equal(statusOf(result, 'declared-sort'), 'fail');
  assert.match(detailOf(result, 'declared-sort'), /decorative/);
  assert.equal(statusOf(result, 'declared-publicationStatus'), 'fail');
  assert.equal(result.verified, false);
});


test('a site with numeric ids is probed for a missing title with a number of the same length, not a word', async () => {
  const probed = [];
  const numeric = fakeSource({
    search: async (q, page) => (page >= 99999 ? { results: [] } : { results: [{ id: '12345', title: 'Alpha Beta', cover: '/c.png' }], hasNextPage: false }),
    mangaDetails: async (id) => {
      probed.push(id);
      if (!/^\d+$/.test(id)) throw refused('invalid gallery id', 400);
      if (id === '99999') throw refused('not found', 404);
      return { id, title: 'Alpha Beta', status: 'x', genres: [], description: 'y' };
    },
  });
  const result = await runner(numeric)();
  assert.equal(statusOf(result, 'missing-title'), 'pass');
  assert.ok(probed.includes('99999'));
});

test('a sort that only works once a format is chosen is a warning, not a failure; one that never works is still decorative', async () => {
  const orderBy = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }];
  const item = (id) => ({ id, title: `Title ${id}`, cover: '/c.png' });
  const mixedFeed = (formatAware) => fakeSource({
    search: async (q, page, order, filters) => {
      if (page >= 99999) return { results: [] };
      const format = filters && filters.format;
      if (!format) return { results: [item('m1'), item('m2')], hasNextPage: false }; // merged feed: the sort is ignored
      return { results: [item(formatAware ? `${format}-${order}` : `${format}-same`)], hasNextPage: false };
    },
  });
  sourceUi.registerSourceUi('fake', { orderBy, filters: { orderBy: true, format: true } });
  const partial = await runner(mixedFeed(true))('full');
  assert.equal(statusOf(partial, 'declared-sort'), 'warn');
  assert.match(detailOf(partial, 'declared-sort'), /only with a format chosen \("manga"\)/);
  assert.equal(partial.verified, true, 'a partial sort is a warning that does not undo "verified"');
  const never = await runner(mixedFeed(false))('full');
  assert.equal(statusOf(never, 'declared-sort'), 'fail');
  sourceUi.registerSourceUi('fake', { orderBy, filters: { orderBy: true } });
  assert.equal(statusOf(await runner(mixedFeed(true))('full'), 'declared-sort'), 'fail', 'a source that declared no format filter is not asked again');
});

test('images that a CDN rate limits (429) are a warning when some loaded, and a failure when none did', async () => {
  let n = 0;
  const someLimited = await runner(fakeSource(), { fetchImage: async () => { n += 1; if (n === 3) throw new Error('storage.example returned 429'); return JPEG; } })();
  assert.equal(statusOf(someLimited, 'images'), 'warn');
  assert.match(detailOf(someLimited, 'images'), /rate limited/);
  assert.equal(someLimited.verified, true, 'a rate-limited image is not a broken source');
  const allLimited = await runner(fakeSource(), { fetchImage: async () => { throw new Error('HTTP 429'); } })();
  assert.equal(statusOf(allLimited, 'images'), 'fail');
  let m = 0;
  const mixed = await runner(fakeSource(), { fetchImage: async () => { m += 1; if (m === 2) throw new Error('HTTP 429'); if (m === 3) throw new Error('HTTP 403'); return JPEG; } })();
  assert.equal(statusOf(mixed, 'images'), 'fail', 'one real refusal among the rate limits is still a failure');
});

test('a filter that "differs" only because one of its two values returned nothing is a warning, not a measurement', async () => {
  const item = (id) => ({ id, title: `Title ${id}`, cover: '/c.png' });
  const mod = fakeSource({
    search: async (q, page, order, filters) => {
      if (page >= 99999) return { results: [] };
      if (filters && filters.format === 'manga') return { results: [] }; // the site has no such format
      return { results: [item(`${(filters && filters.format) || 'all'}-1`)], hasNextPage: false };
    },
  });
  sourceUi.registerSourceUi('fake', { filters: { format: true } });
  const result = await runner(mod)('full');
  assert.equal(statusOf(result, 'declared-format'), 'warn');
  assert.match(detailOf(result, 'declared-format'), /not measured against two real values/);
  assert.equal(result.verified, true, 'a warning does not undo "verified"');
});
