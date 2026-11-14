'use strict';

// The live Test as the controller of the "Import a source" card runs it (ui-settings-source-import.js, controller.test): what it
// sends, what it shows, what it re-reads, and what it does to a pending Check report. The rest of the controller is in
// frontend-source-import-controller.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const rig = require('../helpers/source-import-rig');

const { plain, deferred, report, httpError, controllerOver, okInstall, routeOf } = rig;

// ── the live test ──────────────────────────────────────────

const testAnswer = (over = {}) => ({ ok: true, verified: true, depth: 'basic', calls: 9, images: 3, durationMs: 4000, counts: { pass: 9, fail: 0, warn: 0, skip: 0 }, checks: [], ...over });

test('Test sends the id and the depth, shows the answer for that source, and re-reads the state so the tag updates', async () => {
  const order = [];
  const { controller, view, calls } = controllerOver(routeOf(async () => testAnswer()), { onChanged: async () => { order.push('onChanged'); } });
  assert.equal(await controller.test('demo', 'full'), true);
  assert.equal(calls[0].route, '/api/sources/import/test');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(plain(calls[0].body), { id: 'demo', depth: 'full' });
  const names = view.log.map((entry) => entry[0]);
  assert.ok(names.indexOf('testing') < names.indexOf('showTest'), 'the "testing" line comes first');
  assert.deepEqual(view.log.find((entry) => entry[0] === 'testing'), ['testing', 'demo', true]);
  assert.equal(view.last('showTest')[1], 'demo');
  assert.equal(view.last('showTest')[2].verified, true);
  assert.deepEqual(order, ['onChanged']);
  assert.ok(names.lastIndexOf('refreshImported') > names.lastIndexOf('showTest'), 'the list is redrawn after the state was re-read');
  assert.equal(await controller.test('demo', 'nonsense'), true);
  assert.equal(plain(calls[1].body).depth, 'basic', 'anything but "full" is the basic test');
  assert.deepEqual(view.log.filter((entry) => entry[0] === 'busy').map((entry) => entry[1]), [true, false, true, false]);
});

test('Test refuses an id that is not an id and starts nothing while another request runs', async () => {
  const gate = deferred();
  const { controller, calls } = controllerOver(routeOf(async () => { await gate.promise; return testAnswer(); }));
  for (const bad of ['', '../x', 'a b', 'a/b', undefined, null, {}, []]) assert.equal(await controller.test(bad, 'basic'), false);
  assert.equal(calls.length, 0);
  const first = controller.test('demo', 'basic');
  assert.equal(await controller.test('other', 'basic'), false, 'one request at a time');
  assert.equal(calls.length, 1);
  gate.resolve();
  assert.equal(await first, true);
});

test('a test that fails shows the reason, clears the "testing" line, and leaves the card usable', async () => {
  const { controller, view } = controllerOver(routeOf(async () => { throw httpError(409, { error: 'A test is already running: wait for it to finish.' }); }));
  assert.equal(await controller.test('demo', 'basic'), false);
  assert.deepEqual(view.log.filter((entry) => entry[0] === 'testing'), [['testing', 'demo', true], ['testing', 'demo', false]]);
  assert.match(String(view.last('error')[1]), /already running/);
  assert.equal(view.count('showTest'), 0);
  assert.equal(view.last('busy')[1], false);
  assert.equal(await controller.test('demo', 'basic'), false, 'and it can be tried again');
});

test('a test answer that is not ok is an error, not a result', async () => {
  const { controller, view } = controllerOver(routeOf(async () => ({ ok: false, error: 'nope' })));
  assert.equal(await controller.test('demo', 'basic'), false);
  assert.equal(view.count('showTest'), 0);
  assert.ok(view.count('error') >= 1);
});

test('text edited while a test runs still drops the pending report, so the old report cannot be installed afterwards', async () => {
  let viewRef;
  const route = routeOf(async (path) => {
    if (path.endsWith('preview')) return report();
    if (path.endsWith('test')) { viewRef.form.code = 'source text, edited during the test'; return testAnswer(); }
    return okInstall();
  });
  const { controller, view, calls } = controllerOver(route, { form: { code: 'source text', id: '' } });
  viewRef = view;
  await controller.check();
  assert.equal(await controller.test('demo', 'basic'), true);
  assert.equal(view.count('invalidated'), 1, 'the report was about text that is no longer in the box');
  assert.equal(await controller.install(), false);
  assert.equal(calls.filter((c) => c.route.endsWith('install')).length, 0, 'no install request for text that was not checked');
});

test('a test that fails also notices an edit made meanwhile', async () => {
  let viewRef;
  const route = routeOf(async (path) => {
    if (path.endsWith('preview')) return report();
    viewRef.form.id = 'another';
    throw httpError(409, { error: 'A test is already running: wait for it to finish.' });
  });
  const { controller, view } = controllerOver(route, { form: { code: 'source text', id: '' } });
  viewRef = view;
  await controller.check();
  assert.equal(await controller.test('demo', 'basic'), false);
  assert.equal(view.count('invalidated'), 1);
});
