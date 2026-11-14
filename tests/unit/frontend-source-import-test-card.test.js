'use strict';

// The live Test on the "Import a source" card (Settings > Advanced): the tag after an imported source's name, the Test and Test
// in full buttons, the result of a test as markup, the titles of its checks in both languages, and the store that keeps each
// result with the fingerprint of the file it was about. The rest of the card is in frontend-source-import-markup.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../../server/config/limits');
const { CHECK_IDS } = require('../../server/modules/source-import/live-test');
const rig = require('../helpers/source-import-rig');

const { EN, PT, plain, makeEnv, markup, importKeys } = rig;

// ── the live test ──────────────────────────────────────────

test('an imported source shows whether it was tested, and a result only counts for the file it was made on', () => {
  const { ctx } = makeEnv();
  const entries = plain(ctx.sourceImportImportedEntries({
    a: { id: 'a', name: 'A', installedVia: 'imported', sha256: 'abc', liveTest: { verified: true, at: '2026-10-28T12:00:00.000Z', fail: 0, warn: 2, sha256: 'abc' } },
    b: { id: 'b', name: 'B', installedVia: 'imported', sha256: 'new', liveTest: { verified: true, at: '2026-10-28T12:00:00.000Z', fail: 0, warn: 0, sha256: 'old' } },
    c: { id: 'c', name: 'C', installedVia: 'imported', sha256: 'abc' },
    d: { id: 'd', name: 'D', installedVia: 'imported', sha256: 'abc', liveTest: { verified: 'yes', at: { x: 1 }, fail: '3', warn: -1, sha256: 'abc' } },
  }));
  assert.deepEqual(entries[0].tested, { verified: true, at: '2026-10-28T12:00:00.000Z', fail: 0, warn: 2 });
  assert.equal(entries[1].tested, null, 'a result for another fingerprint is stale');
  assert.equal(entries[2].tested, null);
  assert.equal(entries[3].tested.verified, false, 'only true means verified');
  assert.equal(entries[3].tested.warn, 0);
  const $ = markup(ctx.buildSourceImportImportedHtml(entries));
  const rows = $('li');
  assert.match(rows.eq(0).find('.source-import-tested').attr('class'), /is-pass/);
  assert.equal(rows.eq(0).find('.source-import-tested').text(), EN['settings.sourceImport.testVerified']);
  assert.equal(rows.eq(1).find('.source-import-tested').text(), EN['settings.sourceImport.testNone']);
  assert.equal(rows.eq(3).find('.source-import-tested').text(), EN['settings.sourceImport.testNotVerified']);
});

test('every imported source has a Test and a Test in full button that name it, and a box for the answer', () => {
  const { ctx } = makeEnv();
  const $ = markup(ctx.buildSourceImportImportedHtml([{ id: 'demo', name: 'Demo', version: '1.0.0', tested: null }]));
  const buttons = $('[data-si-action="test"]');
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.toArray().map((b) => [$(b).attr('data-depth'), $(b).attr('data-source-id')]), [['basic', 'demo'], ['full', 'demo']]);
  assert.equal($(buttons.get(0)).text(), EN['settings.sourceImport.testButton']);
  assert.equal($(buttons.get(1)).text(), EN['settings.sourceImport.testFullButton']);
  assert.ok($(buttons.get(0)).attr('title').includes('makes requests'), 'the cost is said before it is pressed');
  const box = $('[data-test-for="demo"]');
  assert.equal(box.length, 1);
  assert.equal(box.attr('aria-live'), 'polite');
});

test('a test result is shown as a summary and one line per check, with the status said in words and titles in the page language', () => {
  const { ctx } = makeEnv();
  const result = {
    ok: true, verified: false, depth: 'full', aborted: '', calls: 17, images: 4, durationMs: 12340,
    counts: { pass: 2, fail: 1, warn: 1, skip: 1 },
    checks: [
      { id: 'browse', status: 'pass', detail: '24 titles on page 1' },
      { id: 'chapters', status: 'fail', detail: 'the list is oldest first' },
      { id: 'images', status: 'warn', detail: '' },
      { id: 'declared-sort', status: 'skip', detail: 'not run: the call budget is used up' },
      { id: 'something-new', status: 'pass', detail: '' },
    ],
  };
  const $ = markup(ctx.buildSourceImportTestHtml(result));
  assert.equal($('.source-import-test-summary strong').text(), EN['settings.sourceImport.testNotVerified']);
  assert.match($('.source-import-test-summary').attr('class'), /is-fail/);
  assert.match($('.source-import-test-summary').text(), /2 passed, 1 failed, 1 with a warning, 1 not run\. 17 calls to the source, 4 images, 12\.3 s\./);
  const rows = $('.source-import-test-check');
  assert.equal(rows.length, 5);
  assert.equal(rows.eq(0).find('strong').text(), EN['settings.sourceImport.test.check.browse']);
  assert.match(rows.eq(1).attr('class'), /is-fail/);
  assert.equal(rows.eq(1).find('.source-import-test-icon').attr('aria-label'), EN['settings.sourceImport.testStatus.fail']);
  assert.ok(rows.eq(1).text().includes('oldest first'));
  assert.equal(rows.eq(4).find('strong').text(), 'something-new', 'a check the page does not know is shown under its id');
  const verified = markup(ctx.buildSourceImportTestHtml({ ...result, verified: true, checks: [] }));
  assert.equal(verified('.source-import-test-summary strong').text(), EN['settings.sourceImport.testVerified']);
  assert.equal(verified('.source-import-test-list').length, 0);
});

test('a test that stopped early says why; the list is capped; hostile values add no element and no attribute', () => {
  const { ctx } = makeEnv();
  const stopped = markup(ctx.buildSourceImportTestHtml({ verified: false, aborted: '3 calls failed in a row (HTTP 503)', checks: [] }));
  assert.match(stopped.root().text(), /Stopped early: 3 calls failed in a row \(HTTP 503\)\./);
  const many = ctx.sourceImportNormalizeTest({ checks: Array.from({ length: 500 }, () => ({ id: 'browse', status: 'pass', detail: 'x'.repeat(5000) })) });
  assert.equal(many.checks.length, limits.sourceImportListMax || 60);
  assert.ok(many.checks[0].detail.length <= 300);
  const hostile = ctx.buildSourceImportTestHtml({
    verified: true, aborted: '<img src=x onerror=alert(1)>', calls: '<b>', images: {}, durationMs: 'abc',
    counts: { pass: '<script>', fail: -4, warn: 1e99, skip: NaN },
    checks: [{ id: '"><img src=x>', status: '<b>', detail: '<img src=x onerror=alert(1)>' }, { id: 'browse', status: 'pass', detail: '</li><img src=y>' }, null, 'x'],
  });
  const $ = markup(hostile);
  assert.equal($('img').length, 0);
  assert.equal($('script').length, 0);
  assert.equal($('[onerror]').length, 0);
  assert.equal($('.source-import-test-check').length, 4);
  assert.match($('.source-import-test-check').eq(0).attr('class'), /is-skip/, 'an unknown status is shown as not run');
});

test('the check titles of the page are exactly the ids the server can give, in both languages', () => {
  for (const id of CHECK_IDS) {
    assert.equal(typeof EN['settings.sourceImport.test.check.' + id], 'string', 'en-GB ' + id);
    assert.equal(typeof PT['settings.sourceImport.test.check.' + id], 'string', 'pt-PT ' + id);
  }
  for (const key of importKeys(EN).filter((k) => k.startsWith('settings.sourceImport.test.check.'))) {
    assert.ok(CHECK_IDS.includes(key.slice('settings.sourceImport.test.check.'.length)), key + ' names a check the server no longer has');
  }
});

test('two empty fingerprints are not a match: a result with no sha256 never marks a source as tested', () => {
  const { ctx } = makeEnv();
  const entries = plain(ctx.sourceImportImportedEntries({
    a: { id: 'a', name: 'A', installedVia: 'imported', liveTest: { verified: true, at: '2026-10-28T12:00:00.000Z', fail: 0, warn: 0 } },
    b: { id: 'b', name: 'B', installedVia: 'imported', sha256: '', liveTest: { verified: true, at: '', fail: 0, warn: 0, sha256: '' } },
  }));
  assert.equal(entries[0].tested, null);
  assert.equal(entries[1].tested, null);
});

// A tiny stand-in for the page: result boxes by id, and the fingerprint the state holds for each source.
function testStoreFor(ctx) {
  const boxes = { demo: { innerHTML: '' }, other: { innerHTML: '' } };
  const shas = { demo: 'sha-1', other: 'sha-9' };
  const store = ctx.createSourceImportTestStore({ resultBox: (id) => boxes[id] || null, currentSha: (id) => shas[id] || '' });
  return { store, boxes, shas };
}
const verifiedAnswer = { ok: true, verified: true, calls: 3, images: 1, durationMs: 1000, counts: { pass: 1, fail: 0, warn: 0, skip: 0 }, checks: [{ id: 'browse', status: 'pass', detail: 'x' }] };

test('the result store shows "running" at once, then the answer, and puts a failed run back to what was shown before', () => {
  const { ctx } = makeEnv();
  const { store, boxes } = testStoreFor(ctx);
  store.running('demo');
  assert.match(boxes.demo.innerHTML, new RegExp(EN['settings.sourceImport.testRunning']));
  store.show('demo', verifiedAnswer);
  assert.match(boxes.demo.innerHTML, /source-import-test-summary/);
  store.running('demo');
  store.failed('demo');
  assert.equal(boxes.demo.innerHTML, '', 'a run that failed leaves no half-finished "running" line, and no old result either (it was cleared when the new run began)');
  store.show('demo', verifiedAnswer);
  const shown = boxes.demo.innerHTML;
  store.failed('demo');
  assert.equal(boxes.demo.innerHTML, shown, 'a failure without a new run keeps what the box already had');
  assert.doesNotThrow(() => store.running('nobody'));
  assert.doesNotThrow(() => store.show('nobody', verifiedAnswer));
});

test('the result store puts a result back after the list was redrawn, but not under a file that was replaced since', () => {
  const { ctx } = makeEnv();
  const { store, boxes, shas } = testStoreFor(ctx);
  store.show('demo', verifiedAnswer);
  store.show('other', verifiedAnswer);
  boxes.demo.innerHTML = '';
  boxes.other.innerHTML = '';
  shas.other = 'sha-10'; // "other" was replaced by another file; "demo" was not
  store.reapply();
  assert.match(boxes.demo.innerHTML, /source-import-test-summary/, 'the same file keeps its result across a redraw');
  assert.equal(boxes.other.innerHTML, '', 'a replaced file does not get the old file\'s result');
  shas.other = 'sha-9';
  store.reapply();
  assert.equal(boxes.other.innerHTML, '', 'and it was forgotten, not just hidden');
  delete shas.demo; // uninstalled
  boxes.demo.innerHTML = '';
  store.reapply();
  assert.equal(boxes.demo.innerHTML, '');
});
