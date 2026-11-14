'use strict';

// The "Import a source" card in Settings > Advanced, second third: the controller (ui-settings-source-import.js:
// check, install, cancel, uninstall over a view port that records what it is told). The markup and static guards are
// in frontend-source-import-markup.test.js, the DOM glue in frontend-source-import-card.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const limits = require('../../server/config/limits');
const rig = require('../helpers/source-import-rig');

const { SHA, HOSTILE, EN, plain, settle, deferred, report, httpError, controllerOver, okInstall, routeOf } = rig;

const previewOrInstall = (installAnswer = okInstall(), previewAnswer = report()) => routeOf(async (route) => (route.endsWith('preview') ? previewAnswer : installAnswer));

test('check then install: the install sends exactly the fingerprint and id of the checked report, then the form is cleared and the lists refreshed', async () => {
  const order = [];
  const { controller, view, calls } = controllerOver(previewOrInstall(), {
    form: { code: 'the checked text', id: ' demo ' },
    onChanged: async () => { order.push('onChanged'); },
  });
  assert.equal(await controller.check(), true);
  assert.deepEqual(plain(calls[0].body), { code: 'the checked text', id: 'demo' }, 'the id is trimmed');
  assert.equal(calls[0].route, '/api/sources/import/preview');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(view.last('showReport')[1].sha256, SHA);

  assert.equal(await controller.install(), true);
  assert.equal(calls[1].route, '/api/sources/import/install');
  assert.deepEqual(plain(calls[1].body), { sha256: SHA, id: 'demo' }, 'no code, no replace');
  assert.deepEqual(view.last('success')[1], { name: 'Demo', replaced: false, warnings: [] });
  assert.equal(view.count('resetForm'), 1);
  assert.equal(view.form.code, '');
  assert.deepEqual(order, ['onChanged']);
  const names = view.log.map((entry) => entry[0]);
  assert.ok(names.lastIndexOf('refreshImported') > names.lastIndexOf('success'), 'the list is redrawn after the lists were re-read');
  assert.deepEqual(view.log.filter((e) => e[0] === 'busy').map((e) => e[1]), [true, false, true, false]);
});

test('without an id in the box the request carries only the code, and the id comes from the report', async () => {
  const { controller, calls } = controllerOver(previewOrInstall(okInstall(), report({ id: 'found', idSource: 'detected' })));
  await controller.check();
  assert.deepEqual(plain(calls[0].body), { code: 'source text' });
  await controller.install();
  assert.deepEqual(plain(calls[1].body), { sha256: SHA, id: 'found' });
});

test('a replacement is confirmed by the Replace button and sends replace: true; only that report can', async () => {
  const { controller, calls, view } = controllerOver(previewOrInstall(okInstall({ replaced: true }), report({ replace: true, existing: { installedVia: 'imported', name: 'Old', version: '1' } })));
  await controller.check();
  await controller.install();
  assert.deepEqual(plain(calls[1].body), { sha256: SHA, id: 'demo', replace: true });
  assert.equal(view.last('success')[1].replaced, true);
});

test('a report that cannot be installed starts no install request', async () => {
  const { controller, calls } = controllerOver(routeOf(async () => report({ canInstall: false, blockers: ['x'] })));
  await controller.check();
  assert.equal(await controller.install(), false);
  assert.equal(calls.length, 1);
  assert.equal(await controllerOver(routeOf(async () => okInstall())).controller.install(), false, 'and nothing was checked at all');
});

test('editing the text or the id after a check drops the report and blocks the install until it is checked again', async () => {
  const { controller, view, calls } = controllerOver(previewOrInstall());
  await controller.check();
  controller.edit(); // nothing changed yet
  assert.equal(view.count('invalidated'), 0, 'an edit that changed nothing keeps the report');
  view.form.code = 'source text, edited';
  controller.edit();
  assert.equal(view.count('invalidated'), 1);
  assert.equal(await controller.install(), false);
  assert.equal(calls.length, 1, 'no install request for text that was not checked');
  await controller.check();
  assert.deepEqual(plain(calls[1].body), { code: 'source text, edited' });
  view.form.id = 'other';
  controller.edit();
  assert.equal(view.count('invalidated'), 2, 'the id counts too');
  assert.equal(await controller.install(), false);
  view.form.id = '  ';
  controller.edit();
  await controller.check();
  view.form.id = '';
  controller.edit();
  assert.equal(view.count('invalidated'), 2, 'blank spaces around the id are not a change');
});

test('the install uses the checked text\'s fingerprint even if the form was changed back and forth', async () => {
  const { controller, view, calls } = controllerOver(previewOrInstall());
  await controller.check();
  view.form.code = 'x';
  controller.edit();
  view.form.code = 'source text';
  controller.edit();
  assert.equal(await controller.install(), false, 'the report was dropped by the first edit, back to the old text or not');
  assert.equal(calls.length, 1);
});

test('an answer to a check that was edited while it ran is ignored, and a new check can start at once', async () => {
  const first = deferred();
  let n = 0;
  const { controller, view } = controllerOver(async (route) => (route.endsWith('preview') && (n += 1) === 1 ? first.promise : (route.endsWith('preview') ? report({ id: 'second' }) : okInstall())));
  const running = controller.check();
  await settle();
  assert.equal(await controller.check(), false, 'one request at a time');
  view.form.code = 'edited while waiting';
  controller.edit();
  assert.equal(view.last('busy')[1], false, 'the card is free again');
  assert.equal(await controller.check(), true);
  assert.equal(view.last('showReport')[1].id, 'second');
  first.resolve(report({ id: 'stale' }));
  await running;
  assert.equal(view.count('showReport'), 1, 'the stale answer showed nothing');
  assert.equal(controller.checkedReport().id, 'second');
});

test('Cancel discards the report but keeps the text and the id, and an answer that arrives afterwards is ignored', async () => {
  const late = deferred();
  const { controller, view } = controllerOver(async () => late.promise, { form: { code: 'my only copy', id: 'mine' } });
  const running = controller.check();
  await settle();
  controller.cancel();
  assert.equal(view.count('resetForm'), 0, 'the person\'s code is not thrown away');
  assert.deepEqual(view.form, { code: 'my only copy', id: 'mine' });
  assert.equal(view.count('clearReport') >= 1, true);
  late.resolve(report());
  await running;
  assert.equal(view.count('showReport'), 0);
  assert.equal(controller.checkedReport(), null);
  assert.equal(await controller.install(), false);
});

test('Cancel after a check clears the report and the checked state, and the same text can be checked again', async () => {
  const { controller, view, calls } = controllerOver(previewOrInstall());
  await controller.check();
  controller.cancel();
  assert.equal(controller.checkedReport(), null);
  assert.equal(await controller.install(), false);
  assert.equal(view.form.code, 'source text');
  assert.equal(await controller.check(), true);
  assert.equal(calls.length, 2);
});

test('an empty text and a text over the cap start no request', async () => {
  const { controller, view, calls } = controllerOver(routeOf(async () => report()));
  for (const code of ['', '   \n']) {
    view.form.code = code;
    assert.equal(await controller.check(), false);
  }
  assert.equal(view.last('error')[1], EN['settings.sourceImport.emptyCode']);
  view.form.code = 'é'.repeat(limits.sourceImportMaxBytes / 2 + 1);
  assert.equal(await controller.check(), false);
  assert.deepEqual(view.last('tooLarge').slice(1), [limits.sourceImportMaxBytes + 2, limits.sourceImportMaxBytes]);
  view.form.code = 'x'.repeat(limits.sourceImportMaxBytes);
  assert.equal(await controller.check(), true, 'exactly the cap is allowed');
  assert.equal(calls.length, 1);
});

test('a refusal is shown as the server said it, with its reasons; made-up errors and a remote device get plain sentences', async () => {
  const text = async (err) => {
    const r = controllerOver(async () => { throw err; });
    await r.controller.check();
    return r.view.last('error').slice(1);
  };
  assert.deepEqual(await text(httpError(400, { ok: false, error: 'The file does not follow the source contract.', errors: ['pages() is missing: ...', 'meta.name is missing: ...'] })),
    ['The file does not follow the source contract.', ['pages() is missing: ...', 'meta.name is missing: ...']]);
  assert.deepEqual(await text(httpError(409, { ok: false, error: 'A file with this id already exists in the sources folder.' })), ['A file with this id already exists in the sources folder.', []]);
  assert.deepEqual(await text(httpError(403, { ok: false, code: 'LOCAL_ONLY', error: 'This action is only available from the computer running ScrollScape (open it as http://localhost:PORT), or after you set an Access Password in Settings.' })),
    [EN['settings.sourceImport.localOnly'], []]);
  assert.deepEqual(await text(new TypeError('Failed to fetch')), [EN['settings.sourceImport.requestFailed'], []]);
  for (const made of [new Error('HTTP 502'), new Error(''), null]) assert.deepEqual(await text(made), [EN['settings.sourceImport.requestFailed'], []]);
  assert.equal((await text(new Error('x'.repeat(2000))))[0].length, 300);
  assert.equal((await text(httpError(400, { error: 'e', errors: Array.from({ length: 200 }, () => 'r'.repeat(2000)) })))[1].length, 60);
});

test('an answer that is not ok is an error, not a report', async () => {
  for (const answer of [null, undefined, { ok: false, error: 'nope' }, { ok: false }, 'text']) {
    const { controller, view } = controllerOver(async () => answer);
    assert.equal(await controller.check(), false, JSON.stringify(answer));
    assert.equal(view.count('showReport'), 0);
    assert.equal(controller.checkedReport(), null);
  }
});

test('an install that fails keeps the checked report, shows why, and can be tried again', async () => {
  let installs = 0;
  const { controller, view, calls } = controllerOver(async (route) => {
    if (route.endsWith('preview')) return report();
    installs += 1;
    if (installs === 1) throw httpError(400, { ok: false, error: 'The file does not follow the source contract.', errors: ['pages() is missing: x'] });
    return okInstall();
  });
  await controller.check();
  assert.equal(await controller.install(), false);
  assert.deepEqual(view.last('error').slice(1), ['The file does not follow the source contract.', ['pages() is missing: x']]);
  assert.equal(view.count('resetForm'), 0, 'the text stays: the person can fix it');
  assert.equal(await controller.install(), true);
  assert.equal(calls.length, 3);
});

test('an install refused because the checked file is gone (404) or no longer holds (409) drops the check and keeps the text and the error', async () => {
  for (const status of [404, 409]) {
    const { controller, view, calls } = controllerOver(async (route) => {
      if (route.endsWith('preview')) return report();
      throw httpError(status, { ok: false, code: 'ERROR-021', error: 'The checked file is no longer available: choose it again.' });
    });
    await controller.check();
    const clearsBefore = view.count('clearReport');
    assert.equal(await controller.install(), false, String(status));
    assert.equal(controller.checkedReport(), null, `${status}: the report cannot be installed again`);
    assert.equal(view.count('clearReport'), clearsBefore + 1, `${status}: the report is removed from the screen`);
    assert.equal(view.last('error')[1], 'The checked file is no longer available: choose it again.', 'the error stays visible');
    assert.equal(view.form.code, 'source text', 'the text is not touched');
    assert.equal(view.count('invalidated'), 0, 'not the "the text changed" notice: it did not');
    assert.equal(await controller.install(), false);
    assert.equal(calls.filter((c) => c.route.endsWith('install')).length, 1, `${status}: no second install request`);
    assert.equal(await controller.check(), true, 'Check is what comes next');
  }
});

test('any other refusal or failure of an install keeps the report, so it can be tried again', async () => {
  for (const status of [400, 403, 500, 502]) {
    const { controller, view } = controllerOver(async (route) => {
      if (route.endsWith('preview')) return report();
      throw httpError(status, { ok: false, error: 'nope' });
    });
    await controller.check();
    assert.equal(await controller.install(), false);
    assert.equal(controller.checkedReport().id, 'demo', String(status));
    assert.equal(view.count('clearReport'), 1, `${status}: only the one before the check`);
  }
  const offline = controllerOver(async (route) => { if (route.endsWith('preview')) return report(); throw new TypeError('Failed to fetch'); });
  await offline.controller.check();
  await offline.controller.install();
  assert.notEqual(offline.controller.checkedReport(), null, 'a network error has no status and keeps the report');
});

test('a 404 that arrives after a Cancel does not touch what the person has done since', async () => {
  const slow = deferred();
  const { controller, view } = controllerOver(async (route) => (route.endsWith('preview') ? report({ id: 'second' }) : slow.promise));
  await controller.check();
  const installing = controller.install();
  await settle();
  controller.cancel();
  assert.equal(await controller.check(), true);
  const clears = view.count('clearReport');
  slow.reject(httpError(404, { ok: false, error: 'gone' }));
  await installing;
  assert.equal(view.count('clearReport'), clears, 'the newer report stays');
  assert.equal(controller.checkedReport().id, 'second');
});

test('the install button cannot start two installs, and warnings from the server come through as text', async () => {
  const slow = deferred();
  const { controller, view, calls } = controllerOver(async (route) => (route.endsWith('preview') ? report() : slow.promise));
  await controller.check();
  const first = controller.install();
  const second = controller.install();
  slow.resolve(okInstall({ warnings: ['meta.version is missing: "1.0.0" is shown instead.', 5], installed: { name: HOSTILE[0] } }));
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
  assert.equal(calls.filter((c) => c.route.endsWith('install')).length, 1);
  assert.deepEqual(view.last('success')[1].warnings, ['meta.version is missing: "1.0.0" is shown instead.', '5']);
  assert.equal(view.last('success')[1].name, HOSTILE[0], 'a name is data: the view only ever sets it as text');
});

// ── edits made while an install or an uninstall is running ──────────────────

test('text typed while an install runs is not wiped when it succeeds, and the report is not left installable for the old text', async () => {
  const slow = deferred();
  const { controller, view } = controllerOver(async (route) => (route.endsWith('preview') ? report() : slow.promise));
  await controller.check();
  const installing = controller.install();
  await settle();
  view.form.code = 'a fix typed meanwhile';
  controller.edit(); // nothing happens while the install runs: it uses the checked fingerprint
  slow.resolve(okInstall());
  assert.equal(await installing, true);
  assert.equal(view.form.code, 'a fix typed meanwhile', 'the new text is still there');
  assert.equal(view.count('resetForm'), 0);
  assert.equal(controller.checkedReport(), null);
  assert.equal(view.last('success')[0], 'success', 'the toast and the lists still say it was installed');
  assert.equal(view.count('refreshImported'), 1);
});

test('an install that fails after the text was edited drops the old report, so it cannot be installed against the new text', async () => {
  const slow = deferred();
  let installs = 0;
  const { controller, view, calls } = controllerOver(async (route) => {
    if (route.endsWith('preview')) return report();
    installs += 1;
    return slow.promise;
  });
  await controller.check();
  const installing = controller.install();
  await settle();
  view.form.code = 'edited while installing';
  controller.edit();
  slow.reject(httpError(500, { ok: false, error: 'The source failed to load.' }));
  assert.equal(await installing, false);
  assert.equal(view.count('invalidated'), 1, 'the report says it is out of date');
  assert.equal(controller.checkedReport(), null);
  assert.equal(await controller.install(), false);
  assert.equal(installs, 1, 'no second install for text that is not in the box');
  assert.equal(calls.length, 2);
});

test('a late install success after Cancel and a new check neither wipes the box nor clears the newer report', async () => {
  const slow = deferred();
  let previews = 0;
  const { controller, view } = controllerOver(async (route) => {
    if (route.endsWith('install')) return slow.promise;
    previews += 1;
    return report({ id: previews === 1 ? 'demo' : 'second' });
  });
  await controller.check();
  const installing = controller.install();
  await settle();
  controller.cancel();
  view.form.code = 'a second source';
  assert.equal(await controller.check(), true);
  const clearsBefore = view.count('clearReport');
  slow.resolve(okInstall({ warnings: ['a note'] }));
  assert.equal(await installing, true, 'the server did install it');
  assert.equal(view.form.code, 'a second source');
  assert.equal(view.count('resetForm'), 0);
  assert.equal(view.count('clearReport'), clearsBefore, 'the newer report is not cleared');
  assert.equal(controller.checkedReport().id, 'second');
  assert.deepEqual(view.last('success')[1].warnings, [], 'the warnings do not replace the newer report');
  assert.equal(view.count('success'), 1);
});

test('after an install that succeeded for the text still in the box, the box is cleared as before', async () => {
  const { controller, view } = controllerOver(previewOrInstall());
  await controller.check();
  assert.equal(await controller.install(), true);
  assert.equal(view.count('resetForm'), 1);
  assert.deepEqual(view.form, { code: '', id: '' });
});

test('using the id the file names fills the id box and asks for a new check', async () => {
  const { controller, view } = controllerOver(routeOf(async () => report({ id: 'typed', detectedId: 'inside' })), { form: { code: 'c', id: 'typed' } });
  await controller.check();
  controller.adoptDetectedId();
  assert.equal(view.form.id, 'inside');
  assert.equal(view.count('invalidated'), 1);
  assert.equal(await controller.install(), false);
});

test('uninstall sends the id, refreshes the lists afterwards, and never sends something that is not an id', async () => {
  const order = [];
  const { controller, view, calls } = controllerOver(routeOf(async () => ({ ok: true })), { onChanged: async () => { order.push('onChanged'); } });
  assert.equal(await controller.uninstall('demo'), true);
  assert.equal(calls[0].route, '/api/sources/uninstall');
  assert.deepEqual(plain(calls[0].body), { id: 'demo' });
  assert.equal(view.count('uninstalled'), 1);
  assert.deepEqual(order, ['onChanged']);
  for (const bad of [undefined, null, '', '../x', '"><img>', 'a b', 'x'.repeat(81)]) assert.equal(await controller.uninstall(bad), false, String(bad));
  assert.equal(calls.length, 1);

  const failing = controllerOver(async () => { throw httpError(400, { ok: false, error: 'Cannot uninstall a bundled source' }); });
  assert.equal(await failing.controller.uninstall('demo'), false);
  assert.deepEqual(failing.view.last('error').slice(1), ['Cannot uninstall a bundled source', []]);
  assert.equal(failing.view.count('refreshImported'), 0);
});

test('an edit made while an uninstall runs is compared with the checked text when it ends', async () => {
  const slow = deferred();
  const { controller, view } = controllerOver(async (route) => (route.endsWith('preview') ? report() : slow.promise));
  await controller.check();
  const removing = controller.uninstall('demo');
  await settle();
  view.form.code = 'edited while uninstalling';
  controller.edit();
  assert.equal(view.count('invalidated'), 0, 'nothing is dropped while the request runs');
  slow.resolve({ ok: true });
  assert.equal(await removing, true);
  assert.equal(view.count('invalidated'), 1, 'the report for the old text is dropped at the end');
  assert.equal(controller.checkedReport(), null);
});

test('a callback that fails does not stop the install from finishing', async () => {
  const { controller, view } = controllerOver(previewOrInstall(), { onChanged: async () => { throw new Error('refresh failed'); } });
  await controller.check();
  assert.equal(await controller.install(), true);
  assert.equal(view.count('refreshImported'), 1);
});
