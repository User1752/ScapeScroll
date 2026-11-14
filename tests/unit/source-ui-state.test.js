'use strict';

// What /api/state hands the browser about a source's declaration, and the loader's registry bookkeeping: the parts of
// meta.ui that sit between the loader and the browser.

const test = require('node:test');
const assert = require('node:assert/strict');

const sourceUi = require('../../server/modules/common/source-ui');
const { createRepoService } = require('../../server/modules/repos/service');
const { makeRig, sourceText } = require('../helpers/source-import-server-rig');

test.afterEach(() => sourceUi.clearSourceUiRegistry());

function stateServiceFor(rig, storeSources) {
  return createRepoService({
    readStore: async () => ({ repos: [], installedSources: storeSources }),
    writeStore: async () => {},
    listAvailableSourcesFromRepos: async () => [],
    detectRepoKind: () => 'jsrepo',
    autoInstallLocalSources: async () => {},
    loadSourceFromFile: (id) => rig.core.loadSourceFromFile(id),
    isSafeUrl: () => true,
    fetchJson: async () => ({}),
    sha1Short: () => 'x',
  });
}

test('/api/state carries the declaration of a source, without its Referer rules, and a stored "ui" is never passed on', async (t) => {
  const rig = makeRig(t);
  const code = sourceText('demo', {
    body: "const BASE = 'https://example.com';",
    meta: ", ui: { genres: ['Action'], adultOnly: true, imageReferers: [{ host: 'cdn.example.com', referer: 'https://example.com' }] }",
  });
  const plain = sourceText('plain');
  for (const [id, text] of [['demo', code], ['plain', plain]]) {
    const report = await rig.service.preview({ code: text, id });
    await rig.service.install({ sha256: report.sha256, id });
  }
  const service = stateServiceFor(rig, {
    demo: { id: 'demo', name: 'Demo', installedVia: 'imported' },
    // a hand-edited store or a restored backup that carries its own `ui`
    plain: { id: 'plain', name: 'Plain', installedVia: 'imported', ui: { adultOnly: true, genres: ['Loli'] } },
  });
  const { installedSources } = await service.getState();
  assert.deepEqual(installedSources.demo.ui, { genres: ['Action'], adultOnly: true, filters: { genres: true } });
  assert.equal(installedSources.demo.ui.imageReferers, undefined);
  assert.equal(installedSources.plain.ui, undefined, 'a source that declares nothing has no ui, whatever the store says');
});

test('clearing the whole source cache forgets every declaration, and one id forgets only its own', (t) => {
  const rig = makeRig(t);
  sourceUi.registerSourceUi('a', { nativeDates: true });
  sourceUi.registerSourceUi('b', { nativeDates: true });
  rig.core.clearSourceCache('a');
  assert.equal(sourceUi.getSourceUi('a'), null);
  assert.equal(sourceUi.sourceHasNativeDates('b'), true);
  rig.core.clearSourceCache();
  assert.equal(sourceUi.getSourceUi('b'), null);
});

test('a source loaded as a candidate leaves no declaration behind', async (t) => {
  const rig = makeRig(t);
  const report = await rig.service.preview({ code: sourceText('demo', { meta: ', ui: { nativeDates: true }' }), id: 'demo' });
  assert.equal(report.canInstall, true);
  assert.equal(sourceUi.getSourceUi('demo'), null, 'a Check registers nothing');
});
