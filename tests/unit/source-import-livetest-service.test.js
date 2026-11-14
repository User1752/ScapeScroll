'use strict';

// The service around the live test (server/modules/source-import/test-run.js): one test at a time, what is remembered on the
// installed entry, what a replacement forgets, and the errors it answers with.

const test = require('node:test');
const assert = require('node:assert/strict');

const sourceUi = require('../../server/modules/common/source-ui');
const { withTimeout } = require('../../server/modules/common/async-utils');
const { makeRig, rejection } = require('../helpers/source-import-server-rig');
const { JPEG, sleep } = require('../helpers/live-test-rig');

test.afterEach(() => sourceUi.clearSourceUiRegistry());

// ── The service around it ─────────────────────────────────────────────────

const FILE_SOURCE = (extra = '') => `${extra}
exports.meta = { id: 'demo', name: 'Demo', version: '1.0.0' };
exports.search = async (q, page) => (page > 1 ? { results: [], hasNextPage: false } : { results: [{ id: 't1', title: 'Test Title', cover: '', genres: [] }], hasNextPage: false });
exports.mangaDetails = async (id) => { if (String(id).includes('..')) { const e = new Error('bad'); e.statusCode = 400; throw e; } if (String(id).startsWith('definitely-not')) { const e = new Error('nf'); e.statusCode = 404; throw e; } return { id, title: 'Test Title', status: 'ongoing', genres: [], description: 'd' }; };
exports.chapters = async (id) => { if (String(id).includes('..')) { const e = new Error('bad'); e.statusCode = 400; throw e; } return { chapters: [{ id: 'c2', name: 'Chapter 2', chapter: '2', publishAt: null }, { id: 'c1', name: 'Chapter 1', chapter: '1', publishAt: null }] }; };
exports.pages = async (id) => { if (String(id).includes('..')) { const e = new Error('bad'); e.statusCode = 400; throw e; } return { pages: [{ index: 0, img: 'https://img.example/0.jpg' }] }; };
`;

function serviceRig(t, options = {}) {
  const helpers = { resolvePageUrl: (p) => ({ url: p.img, referer: '' }), fetchImage: async () => JPEG, sleep, withTimeout, limits: { spacingMs: 0, imageSpacingMs: 0 }, ...options.helpers };
  return makeRig(t, { ...options.rig, liveTest: helpers });
}

async function install(rig, code = FILE_SOURCE()) {
  const report = await rig.service.preview({ code, id: 'demo' });
  return rig.service.install({ sha256: report.sha256, id: 'demo', replace: true });
}

test('the service tests an installed source, remembers the outcome on its entry, and a replacement forgets it', async (t) => {
  const rig = serviceRig(t);
  await install(rig);
  const result = await rig.service.test({ id: 'demo' });
  assert.equal(result.ok, true);
  assert.equal(result.verified, true, JSON.stringify(result.checks.filter((c) => c.status !== 'pass')));
  const entry = rig.store.installedSources.demo;
  assert.equal(entry.liveTest.verified, true);
  assert.equal(entry.liveTest.depth, 'basic');
  assert.equal(entry.liveTest.fail, 0);
  assert.equal(entry.liveTest.sha256, entry.sha256, 'tied to the file that was tested');
  assert.ok(rig.counters.flushed >= 2, 'written at once, not left to the timer');
  await install(rig, FILE_SOURCE('// a new version'));
  assert.equal(rig.store.installedSources.demo.liveTest, undefined, 'a replaced file is not verified until it is tested again');
});

test('only "full" asks for the extra measurements; anything else is basic', async (t) => {
  const rig = serviceRig(t);
  await install(rig);
  assert.equal((await rig.service.test({ id: 'demo', depth: 'weird' })).depth, 'basic');
  assert.equal((await rig.service.test({ id: 'demo', depth: 'full' })).depth, 'full');
});

test('a source that is not installed, an id that is not an id, and a source that cannot be loaded are refused with a reason', async (t) => {
  const rig = serviceRig(t);
  assert.equal((await rejection(rig.service.test({ id: 'nothing-here' }))).statusCode, 404);
  assert.equal((await rejection(rig.service.test({ id: '../x' }))).statusCode, 400);
  assert.equal((await rejection(rig.service.test({}))).statusCode, 400);
  assert.equal((await rejection(rig.service.test({ id: 'local' }))).statusCode, 400);
  await install(rig);
  const broken = serviceRig(t, { rig: { loadSource: (core, id, opts) => { if (opts && opts.allowSelfHeal === false) return core.loadSourceFromFile(id, opts); throw new Error('Cannot find module'); } } });
  await install(broken);
  const err = await rejection(broken.service.test({ id: 'demo' }));
  assert.equal(err.statusCode, 400);
  assert.match(err.message, /could not be loaded/);
});

test('two tests at once are not allowed: the second is told to wait, and the first still finishes and is remembered', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const rig = serviceRig(t, { helpers: { fetchImage: async () => { await gate; return JPEG; } } });
  await install(rig);
  const first = rig.service.test({ id: 'demo' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const second = await rejection(rig.service.test({ id: 'demo' }));
  assert.equal(second.statusCode, 409);
  release();
  const done = await first;
  assert.equal(done.ok, true);
  assert.equal((await rig.service.test({ id: 'demo' })).ok, true, 'and once it is over a new one may start');
});

test('a failed store write does not lose the result', async (t) => {
  let writes = 0;
  const rig = serviceRig(t, { rig: { writeStoreImpl: async () => { writes += 1; if (writes > 1) throw new Error('disk full'); } } });
  await install(rig);
  const result = await rig.service.test({ id: 'demo' });
  assert.equal(result.ok, true);
  assert.ok(result.checks.length > 5);
});


// ── The service: files replaced while a test runs ────────────────────────

test('a file replaced while its test runs: the result belongs to the old file and is not stored on the new one', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const rig = serviceRig(t, { helpers: { fetchImage: async () => { await gate; return JPEG; } } });
  await install(rig);
  const running = rig.service.test({ id: 'demo' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await install(rig, FILE_SOURCE('// a new version, replaced during the test'));
  const newSha = rig.store.installedSources.demo.sha256;
  release();
  const done = await running;
  assert.equal(done.ok, true, 'the person still sees what the test found');
  assert.equal(rig.store.installedSources.demo.sha256, newSha);
  assert.equal(rig.store.installedSources.demo.liveTest, undefined, 'the new file is not "verified" by a test of the old one');
});
