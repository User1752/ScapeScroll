'use strict';

// File size alone is not quality. Seen live (DemonicScans): the chapter the baseline was taken on was re-uploaded by the site as
// 83 slices of 800x1365 instead of a few tall strips, so page 1 went from 307KB to 83KB at the same density, and "page dropped"
// was reported on every run for ever (the baseline only moves on a healthy result). A smaller page is let through when it is as
// wide as before and as dense; a narrower page (downscaled) or a harder-compressed one is still reported.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createImageQualityHealthCheckService } = require('../../server/modules/system-health/image-quality-health');

const COVER = 'https://cdn.example.test/cover.jpg';
const PAGE = 'https://cdn.example.test/ch-1/1.png';
const KB = 1024;

// A body the size reader can parse: the PNG signature, an IHDR chunk header, width and height.
function pngOf(width, height) {
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function setup({ baseline, page }) {
  const store = { installedSources: { src: { name: 'SRC' } }, imageHealthBaseline: { src: baseline } };
  const service = createImageQualityHealthCheckService({
    readStore: async () => store,
    writeStore: async () => {},
    loadSourceFromFile: () => ({
      trending: async () => ({ results: [{ id: 'sample' }] }),
      mangaDetails: async () => ({ cover: COVER }),
      chapters: async () => ({ chapters: [{ id: 'ch-1' }] }),
      pages: async () => ({ pages: [{ index: 0, img: PAGE }] }),
    }),
    fetchProxyImage: async ({ url }) => (url === COVER
      ? { contentLength: 100 * KB }
      : { contentLength: page.bytes, contentType: 'image/png', body: pngOf(page.width, page.height) }),
  });
  return { service, store };
}

const baseline = (extra = {}) => ({ mangaId: 'sample', chapterId: 'ch-1', coverBytes: 100 * KB, pageBytes: 794 * KB, sampledAt: 'then', ...extra });
const STRIP = { pageWidth: 800, pageHeight: 11720 }; // 794KB: about 0.085 bytes per pixel

test('the same chapter cut into slices (smaller file, same width, same density) is not a regression and moves the baseline', async () => {
  const { service, store } = setup({ baseline: baseline(STRIP), page: { bytes: 83 * KB, width: 800, height: 1365 } });

  const [row] = await service.runImageQualityChecks();

  assert.equal(row.ok, true, row.error);
  assert.match(row.details, /page 83KB \(800x1365\)/);
  assert.deepEqual(
    { bytes: store.imageHealthBaseline.src.pageBytes, w: store.imageHealthBaseline.src.pageWidth, h: store.imageHealthBaseline.src.pageHeight },
    { bytes: 83 * KB, w: 800, h: 1365 },
  );
});

test('a page that is much smaller AND much less dense at the same width is still a regression', async () => {
  // 794KB over 800x11720 is 0.085 B/px; 83KB over 800x11720 is 0.009 B/px: the same cut, compressed far harder.
  const { service, store } = setup({ baseline: baseline(STRIP), page: { bytes: 83 * KB, width: 800, height: 11720 } });

  const [row] = await service.runImageQualityChecks();

  assert.equal(row.ok, false);
  assert.match(row.error, /page dropped from 794KB to 83KB/);
  assert.equal(store.imageHealthBaseline.src.pageBytes, 794 * KB, 'a regression never moves the baseline');
});

test('a narrower page is a downscale, not a new cut: still a regression even at the same density', async () => {
  const { service } = setup({ baseline: baseline(STRIP), page: { bytes: 200 * KB, width: 400, height: 5860 } });

  const [row] = await service.runImageQualityChecks();

  assert.equal(row.ok, false);
  assert.match(row.error, /page dropped from 794KB to 200KB/);
});

test('a baseline from before sizes were stored lets the first drop through once and then carries the size', async () => {
  const { service, store } = setup({ baseline: baseline(), page: { bytes: 83 * KB, width: 800, height: 1365 } });

  const [row] = await service.runImageQualityChecks();

  assert.equal(row.ok, true, row.error);
  assert.equal(store.imageHealthBaseline.src.pageWidth, 800);
  assert.equal(store.imageHealthBaseline.src.pageHeight, 1365);
});

test('a drop on an image whose size cannot be read is reported as before', async () => {
  const store = { installedSources: { src: { name: 'SRC' } }, imageHealthBaseline: { src: baseline(STRIP) } };
  const service = createImageQualityHealthCheckService({
    readStore: async () => store,
    writeStore: async () => {},
    loadSourceFromFile: () => ({
      trending: async () => ({ results: [{ id: 'sample' }] }),
      mangaDetails: async () => ({ cover: COVER }),
      chapters: async () => ({ chapters: [{ id: 'ch-1' }] }),
      pages: async () => ({ pages: [{ index: 0, img: PAGE }] }),
    }),
    fetchProxyImage: async ({ url }) => ({ contentLength: url === COVER ? 100 * KB : 83 * KB }),
  });

  const [row] = await service.runImageQualityChecks();

  assert.equal(row.ok, false);
  assert.match(row.error, /page dropped from 794KB to 83KB/);
});
