'use strict';

// The image-quality probe compares today's sizes with the last healthy ones. The page it measures has to be the
// SAME page as then: seen live, vortexscans, demonicscans and comizy were reported as "page dropped from 2185KB
// to 376KB" (and similar) every time their newest chapter changed, because the probe measured the first chapter
// of the list instead of the chapter its baseline was taken on, i.e. a colour page against a black-and-white one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageQualityHealthCheckService } = require('../../server/modules/system-health/image-quality-health');

const COVER = 'https://cdn.example.test/cover.jpg';
const pageUrl = (chapterId) => `https://cdn.example.test/${chapterId}/1.jpg`;

// One source whose chapter list and page sizes the test controls; every pages() call is recorded.
function setup({ chapters, sizes, baseline }) {
  const pagesAsked = [];
  const mod = {
    trending: async () => ({ results: [{ id: 'sample' }] }),
    search: async () => ({ results: [{ id: 'sample' }] }),
    mangaDetails: async () => ({ cover: COVER }),
    chapters: async () => ({ chapters: chapters.map((id) => ({ id })) }),
    pages: async (chapterId) => { pagesAsked.push(chapterId); return { pages: [{ index: 0, img: pageUrl(chapterId) }] }; },
  };
  const store = { installedSources: { src: { name: 'SRC' } }, imageHealthBaseline: baseline ? { src: baseline } : {} };
  const service = createImageQualityHealthCheckService({
    readStore: async () => store,
    writeStore: async () => {},
    loadSourceFromFile: () => mod,
    fetchProxyImage: async ({ url }) => ({ contentLength: sizes[url] ?? 50_000 }),
  });
  return { service, store, pagesAsked };
}

const KB = 1024;
const baselineOn = (chapterId, extra = {}) => ({ mangaId: 'sample', chapterId, coverBytes: 100 * KB, pageBytes: 2000 * KB, sampledAt: 'then', ...extra });

test('the chapter the baseline was taken on is measured again, not whatever is first in the list today', async () => {
  const { service, store, pagesAsked } = setup({
    chapters: ['ch-9', 'ch-8', 'ch-1'], // two newer chapters appeared since the baseline
    sizes: { [COVER]: 100 * KB, [pageUrl('ch-1')]: 1900 * KB, [pageUrl('ch-9')]: 300 * KB },
    baseline: baselineOn('ch-1'),
  });

  const [row] = await service.runImageQualityChecks();

  assert.equal(row.ok, true, row.error);
  assert.deepEqual(pagesAsked, ['ch-1'], 'only the pinned chapter is asked for');
  assert.equal(store.imageHealthBaseline.src.chapterId, 'ch-1', 'and it stays the pinned one');
  assert.equal(store.imageHealthBaseline.src.pageBytes, 1900 * KB);
});

test('a real drop on the pinned chapter is still reported', async () => {
  const { service, store } = setup({
    chapters: ['ch-9', 'ch-1'],
    sizes: { [COVER]: 100 * KB, [pageUrl('ch-1')]: 200 * KB },
    baseline: baselineOn('ch-1'),
  });

  const [row] = await service.runImageQualityChecks();

  assert.equal(row.ok, false);
  assert.match(row.error, /Possible image quality regression: page dropped from 2000KB to 200KB/);
  assert.equal(store.imageHealthBaseline.src.pageBytes, 2000 * KB, 'a regression never moves the baseline');
});

test('a pinned chapter that is gone is not compared with a different chapter, and the baseline moves to the new one', async () => {
  const { service, store, pagesAsked } = setup({
    chapters: ['ch-9', 'ch-8'],
    sizes: { [COVER]: 100 * KB, [pageUrl('ch-9')]: 300 * KB },
    baseline: baselineOn('removed-chapter'),
  });

  const [row] = await service.runImageQualityChecks();

  assert.equal(row.ok, true, row.error);
  assert.deepEqual(pagesAsked, ['ch-9']);
  assert.deepEqual(
    { chapterId: store.imageHealthBaseline.src.chapterId, pageBytes: store.imageHealthBaseline.src.pageBytes },
    { chapterId: 'ch-9', pageBytes: 300 * KB },
  );
});

test('the cover is still compared when the pinned chapter is gone, and the tiny-image floor still applies', async () => {
  const dropped = setup({
    chapters: ['ch-9'],
    sizes: { [COVER]: 20 * KB, [pageUrl('ch-9')]: 300 * KB },
    baseline: baselineOn('removed-chapter'),
  });
  const [coverRow] = await dropped.service.runImageQualityChecks();
  assert.equal(coverRow.ok, false);
  assert.match(coverRow.error, /cover dropped from 100KB to 20KB/);

  const tiny = setup({
    chapters: ['ch-9'],
    sizes: { [COVER]: 100 * KB, [pageUrl('ch-9')]: 2 * KB },
    baseline: baselineOn('removed-chapter'),
  });
  const [tinyRow] = await tiny.service.runImageQualityChecks();
  assert.equal(tinyRow.ok, false);
  assert.match(tinyRow.error, /page is only/);
});

test('without a baseline the newest chapter is measured, as before', async () => {
  const { service, pagesAsked, store } = setup({ chapters: ['ch-9', 'ch-1'], sizes: {} });
  const [row] = await service.runImageQualityChecks();
  assert.equal(row.ok, true, row.error);
  assert.deepEqual(pagesAsked, ['ch-9']);
  assert.equal(store.imageHealthBaseline.src.chapterId, 'ch-9');
});

test('a baseline without a chapter id (older runs) is measured on the newest chapter, with no page comparison', async () => {
  const { service, pagesAsked } = setup({
    chapters: ['ch-9'],
    sizes: { [COVER]: 100 * KB, [pageUrl('ch-9')]: 300 * KB },
    baseline: { mangaId: 'sample', coverBytes: 100 * KB, pageBytes: 2000 * KB },
  });
  const [row] = await service.runImageQualityChecks();
  assert.equal(row.ok, true, row.error);
  assert.deepEqual(pagesAsked, ['ch-9']);
});
