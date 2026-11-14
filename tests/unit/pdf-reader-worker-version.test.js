'use strict';

// pdf.js refuses a document when its worker is not EXACTLY the version of the library ('The API version "6.4.299" does not match the Worker version
// "6.3.289"'). The library was bumped in public/index.html and the worker URL in ui-pdf-reader.js was not, and the reader swallowed the error, so no PDF
// opened. Two faults are pinned here:
//  - the worker URL now comes from the version the library reports (pdfjsLib.version): nothing left to bump by hand;
//  - the health check said "6.5.438 is available" (npm has it) for a library served from cdnjs, which had no such version (404): the in-app Update
//    would have pinned a URL that does not exist. "Latest" for a CDN-served library is what that CDN has.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n');
const { PINNED_CDN_LIBS, checkPinnedCdnLib } = require('../../server/modules/system-health/dependency-health');

const pdfjs = PINNED_CDN_LIBS.find((l) => l.id === 'pdfjs-dist');
const jszip = PINNED_CDN_LIBS.find((l) => l.id === 'jszip');
const html = (version) => `<script type="module">import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${version}/pdf.min.mjs';</script>`;

// A fetch that answers by address: npm says one thing, cdnjs another.
async function withRegistries({ npm, cdnjs }, fn) {
  const real = global.fetch;
  const asked = [];
  global.fetch = async (url) => {
    asked.push(String(url));
    const body = String(url).includes('api.cdnjs.com') ? { version: cdnjs } : { version: npm };
    return { ok: true, status: 200, json: async () => body };
  };
  try { return await fn(asked); } finally { global.fetch = real; }
}

test('the reader asks for the worker of the version the library reports, never for a version written in the file', () => {
  const src = read('public', 'modules', 'ui-pdf-reader.js');
  assert.doesNotMatch(src, /pdf\.js\/\d+\.\d+\.\d+\/pdf\.worker/, 'no worker version written by hand');
  assert.match(src, /pdf\.js\/\$\{pdfjsLib\.version\}\/pdf\.worker\.min\.mjs/);
  assert.match(read('public', 'index.html'), /pdf\.js\/\d+\.\d+\.\d+\/pdf\.min\.mjs/, 'the library itself is still pinned in index.html, the one place to bump');
});

test('pdf.js is checked against cdnjs (where it is served from), the other libraries against npm', () => {
  assert.equal(pdfjs.cdnjsName, 'pdf.js');
  assert.equal(jszip.cdnjsName, undefined);
});

test('a version that npm has and cdnjs does not is not offered as an update: the library is up to date', async () => {
  const row = await withRegistries({ npm: '6.5.438', cdnjs: '6.4.299' }, () => checkPinnedCdnLib(pdfjs, html('6.4.299')));
  assert.equal(row.ok, true);
  assert.match(row.details, /6\.4\.299 \(latest\)/);
  assert.ok(!row.latestVersion, 'no update is offered');
});

test('when cdnjs does have a newer version, it is offered, and it is the cdnjs one', async () => {
  const row = await withRegistries({ npm: '6.9.999', cdnjs: '6.5.100' }, () => checkPinnedCdnLib(pdfjs, html('6.4.299')));
  assert.equal(row.ok, false);
  assert.equal(row.latestVersion, '6.5.100');
  assert.match(row.error, /6\.4\.299 pinned — latest is 6\.5\.100/);
});

test('a library not served from cdnjs still asks npm, and cdnjs is never asked for it', async () => {
  let asked;
  const row = await withRegistries({ npm: '3.10.9', cdnjs: '0.0.0' }, async (log) => {
    const r = await checkPinnedCdnLib(jszip, '<script src="https://cdn.jsdelivr.net/npm/jszip@3.10.2/dist/jszip.min.js"></script>');
    asked = log;
    return r;
  });
  assert.equal(row.latestVersion, '3.10.9');
  assert.ok(asked.every((u) => u.includes('registry.npmjs.org')), asked.join(', '));
});

test('the in-app Update installs what the panel reported as latest: the same source, not npm alone', () => {
  const src = read('server', 'modules', 'system-health', 'dependency-update.js');
  assert.match(src, /resolveLatestVersion\(lib\.registryName, \(\) => fetchLatestCdnLibVersion\(lib\)\)/);
});
