'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createThemePresetService } = require('../../server/modules/theme-presets/service');
const { THEME_PRESET_FAILED } = require('../../server/modules/errors/error-codes');

function makeService(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-presets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createThemePresetService();
  service.configure({ presetsDir: dir });
  return { service, file: path.join(dir, 'custom-presets.json') };
}

// The Customize view builds id="preset-card-<id>" and onclick="applyCustomPreset('<id>')"
// from these ids without escaping, and PUT /api/theme-presets is open to anyone on the
// network while no Access Password is set: an id is script if it is allowed to be.
test('presets with an id outside [A-Za-z0-9_-] are dropped, the client-style id is kept', async (t) => {
  const { service } = makeService(t);
  const result = await service.replacePresets({
    presets: [
      { id: 'custom-1760000000000', name: 'fine' },
      { id: "x');alert(1);//", name: 'quote breakout' },
      { id: '"><img src=x onerror=alert(1)>', name: 'attribute breakout' },
      { id: 'a b', name: 'space' },
      { id: '', name: 'empty' },
      { name: 'no id' },
    ],
  });
  assert.deepEqual(result.presets.map((p) => p.id), ['custom-1760000000000']);
  assert.deepEqual((await service.getPresets()).presets.map((p) => p.id), ['custom-1760000000000']);
});

test('an id that was stored before the rule existed is filtered out on read', async (t) => {
  const { service, file } = makeService(t);
  fs.writeFileSync(file, JSON.stringify({ presets: [{ id: 'ok_1', name: 'a' }, { id: '"><svg onload=alert(1)>', name: 'b' }, null] }));
  assert.deepEqual((await service.getPresets()).presets.map((p) => p.id), ['ok_1']);
});

// The client keeps a focus point (X/Y, 0-100) per image; a sync through this service used to drop them.
test('focus-point keys survive the round trip and are clamped to 0-100', async (t) => {
  const { service } = makeService(t);
  const { presets } = await service.replacePresets({
    presets: [{ id: 'custom-1', bgPosX: 12, bgPosY: 999, charPosX: -5, charPosY: 'x', cornerPosX: 70, cornerPosY: 30, headerPosX: 1, headerPosY: 2 }],
  });
  assert.deepEqual(
    [presets[0].bgPosX, presets[0].bgPosY, presets[0].charPosX, presets[0].charPosY, presets[0].cornerPosX, presets[0].cornerPosY, presets[0].headerPosX, presets[0].headerPosY],
    [12, 100, 0, 50, 70, 30, 1, 2],
  );
});

test('the menu text colour survives the round trip (the server keeps a fixed list of fields)', async (t) => {
  const { service } = makeService(t);
  const { presets } = await service.replacePresets({ presets: [{ id: 'custom-1', sidebarTextColor: '#ff8800' }, { id: 'custom-2' }] });
  assert.equal(presets[0].sidebarTextColor, '#ff8800');
  assert.equal(presets[1].sidebarTextColor, '', 'a preset made before it existed reads as none');
  assert.equal((await service.getPresets()).presets[0].sidebarTextColor, '#ff8800');
});

// A rename the system refuses for a moment (antivirus, sync client, indexer: EPERM seen live on the mapped drive) is
// tried again, so the browser never keeps a theme the server did not get. The fs layer is a wrapper that fails on demand.
function failingFsp(failures) {
  const calls = { writeFile: 0, rename: 0 };
  const queue = [...failures];
  const wrapped = {
    mkdir: (...args) => fs.promises.mkdir(...args),
    readFile: (...args) => fs.promises.readFile(...args),
    writeFile: (...args) => { calls.writeFile += 1; return fs.promises.writeFile(...args); },
    rename: async (...args) => {
      calls.rename += 1;
      if (queue.length) { const code = queue.shift(); throw Object.assign(new Error(`${code}: operation not permitted, rename`), { code }); }
      return fs.promises.rename(...args);
    },
  };
  return { wrapped, calls };
}

function serviceOver(t, fspImpl, writeRetryDelaysMs = [1, 1, 1]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-presets-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = createThemePresetService();
  service.configure({ presetsDir: dir, fsp: fspImpl, writeRetryDelaysMs });
  return { service, file: path.join(dir, 'custom-presets.json') };
}

test('a rename the system refuses twice is retried, and the preset is saved', async (t) => {
  const { wrapped, calls } = failingFsp(['EPERM', 'EBUSY']);
  const { service, file } = serviceOver(t, wrapped);
  const result = await service.replacePresets({ presets: [{ id: 'custom-1', name: 'Ippo', charPosY: 100 }] });
  assert.equal(result.ok, true);
  assert.equal(calls.rename, 3, 'two refusals and the rename that worked');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).presets[0].charPosY, 100);
});

test('a rename that stays refused is reported with the theme-preset error code, after the tries run out', async (t) => {
  const { wrapped, calls } = failingFsp(['EACCES', 'EACCES', 'EACCES', 'EACCES', 'EACCES']);
  const { service } = serviceOver(t, wrapped);
  await assert.rejects(service.replacePresets({ presets: [{ id: 'custom-1' }] }), (err) => err.code === THEME_PRESET_FAILED && /EACCES/.test(err.message));
  assert.equal(calls.rename, 4, 'the first try and three more');
});

test('any other failure (a full disk) is not retried', async (t) => {
  const { wrapped, calls } = failingFsp(['ENOSPC', 'ENOSPC']);
  const { service } = serviceOver(t, wrapped);
  await assert.rejects(service.replacePresets({ presets: [{ id: 'custom-1' }] }), (err) => err.code === THEME_PRESET_FAILED);
  assert.equal(calls.rename, 1);
});
