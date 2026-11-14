'use strict';

// A site that puts a CAPTCHA in front of its chapters (AllManga does, since its pages API answers NEED_CAPTCHA) is not
// a fault of the source or a regression: ScrollScape cannot solve a CAPTCHA and does not try. The image-quality check used
// to report it as a "Cloudflare/challenge block" warning on every run, for good. It is now a KNOWN LIMIT: the row passes
// and says so, so a real change (a source that starts failing in another way) still stands out. Only a source that
// declares it on purpose counts: an error whose code ends in NEED_CAPTCHA. Any other error, even one that mentions a
// CAPTCHA in its text, is reported as before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageQualityHealthCheckService } = require('../../server/modules/system-health/image-quality-health');

const COVER = 'https://cdn.example.test/cover.jpg';

const PINNED = { mangaId: 'sample', chapterId: 'ch-1', coverBytes: 50_000, pageBytes: 50_000 };

// `over` replaces other calls of the source (chapters, mangaDetails); `baseline` pins a sample, as a second run has.
function rowFor(pages, { baseline, ...over } = {}) {
  const mod = {
    trending: async () => ({ results: [{ id: 'sample' }] }),
    search: async () => ({ results: [{ id: 'sample' }] }),
    mangaDetails: async () => ({ cover: COVER }),
    chapters: async () => ({ chapters: [{ id: 'ch-1' }] }),
    pages,
    ...over,
  };
  const store = { installedSources: { walled: { name: 'WALLED' } }, imageHealthBaseline: baseline ? { walled: { ...baseline } } : {} };
  const service = createImageQualityHealthCheckService({
    readStore: async () => store,
    writeStore: async () => {},
    loadSourceFromFile: () => mod,
    fetchProxyImage: async () => ({ contentLength: 50_000 }),
  });
  return service.runImageQualityChecks().then(([row]) => ({ row, store }));
}

const fail = (message, code) => async () => { throw Object.assign(new Error(message), code ? { code } : {}); };

test('a source that declares a CAPTCHA wall passes with a known-limit note, and its baseline is left alone', async () => {
  const { row, store } = await rowFor(fail('This site now requires a CAPTCHA to read chapters.', 'ANYSITE_NEED_CAPTCHA'));
  assert.equal(row.ok, true, row.error);
  assert.equal(row.error, '');
  assert.match(row.details, /CAPTCHA/);
  assert.match(row.details, /cannot solve/i);
  assert.deepEqual(store.imageHealthBaseline, {}, 'no baseline is written for a probe that could not measure a page');
});

test('the bare code and any prefix of it count; the declaration is the code, not the text', async () => {
  for (const code of ['NEED_CAPTCHA', 'X_NEED_CAPTCHA', 'ALLMANGA_NEED_CAPTCHA']) {
    const { row } = await rowFor(fail('walled', code));
    assert.equal(row.ok, true, code);
  }
  for (const code of ['NEED_CAPTCHA_LATER', 'CAPTCHA', 'SOLVER_HOST_BLOCKED', undefined, 7]) {
    const { row } = await rowFor(fail('The site shows a CAPTCHA, please solve it', code));
    assert.equal(row.ok, false, String(code));
    assert.match(row.error, /CAPTCHA/);
  }
});

// The wall can stand in front of the chapter list or the title's details as well as the pages. The code must survive
// the sample search (it used to be flattened to its text there), and a pinned sample must not be cleared for it.
test('a wall declared by chapters() or mangaDetails() is a known limit too, with or without a pinned sample', async () => {
  const wall = () => { throw Object.assign(new Error('CAPTCHA required'), { code: 'ANYSITE_NEED_CAPTCHA' }); };
  for (const [what, over] of [['chapters', { chapters: wall }], ['mangaDetails', { mangaDetails: wall }]]) {
    for (const baseline of [undefined, PINNED]) {
      const label = `${what}, ${baseline ? 'pinned' : 'no baseline'}`;
      const { row, store } = await rowFor(async () => ({ pages: [] }), { ...over, baseline });
      assert.equal(row.ok, true, `${label}: ${row.error}`);
      assert.equal(row.error, '', label);
      assert.match(row.details, /cannot solve/i, label);
      assert.deepEqual(store.imageHealthBaseline, baseline ? { walled: PINNED } : {}, `${label}: the baseline is left alone`);
    }
  }
});

test('a failure of chapters() that only mentions a CAPTCHA is still a failure, and a pinned sample is still cleared', async () => {
  const text = () => { throw Object.assign(new Error('Please solve the CAPTCHA'), { code: 'HTTP-403' }); };
  const fresh = await rowFor(async () => ({ pages: [] }), { chapters: text });
  assert.equal(fresh.row.ok, false);
  assert.match(fresh.row.error, /No candidate had usable chapters.*Please solve the CAPTCHA/);
  const pinned = await rowFor(async () => ({ pages: [] }), { chapters: text, baseline: PINNED });
  assert.equal(pinned.row.ok, false);
  assert.match(pinned.row.error, /^Sample unreachable \(Please solve the CAPTCHA\)/);
  assert.deepEqual(pinned.store.imageHealthBaseline, {}, 'unchanged: a sample that cannot be read is dropped');
});

test('every other failure is reported as before', async () => {
  const { row } = await rowFor(fail('upstream exploded', 'HTTP-500'));
  assert.equal(row.ok, false);
  assert.equal(row.error, 'upstream exploded');
  const timeout = await rowFor(async () => { throw new Error('timeout'); });
  assert.equal(timeout.row.ok, false);
  assert.equal(timeout.row.error, 'Probe timed out.');
});

test('a source that reads fine is unchanged', async () => {
  const { row } = await rowFor(async () => ({ pages: [{ index: 0, img: 'https://cdn.example.test/p1.jpg' }] }));
  assert.equal(row.ok, true);
  assert.match(row.details, /cover 49KB, page 49KB/);
});
