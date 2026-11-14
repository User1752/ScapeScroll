'use strict';

const fs = require('fs');
const { retryTransientFs } = require('../common/fs-retry');
const { IMPORTED, RESERVED_IDS, inspectExisting } = require('./ids');
const { createStaging } = require('./staging');
const { createPlacement } = require('./placement');
const { createPreview } = require('./preview');
const { createInstall } = require('./install');
const { createTestRunner } = require('./test-run');

// Import of a source file the person wrote or generated themselves, in two steps the person sees (preview.js, then
// install.js), and an optional third that checks the installed source against the real site (test-run.js, live-test.js).
// This file only wires them to their dependencies, which a test can replace: the filesystem, the loader, the store, the clock,
// the delays of the retry of a passing refusal and the network helpers of the live test (`liveTest`).

function createSourceImportService({
  stagingDir,
  sourcePath,
  loadCandidateFromFile,
  loadSourceFromFile,
  clearSourceCache,
  readStore,
  writeStore,
  flushNow = () => {},
  invalidatePopularAll = () => {},
  fsImpl = fs.promises,
  existsSync = fs.existsSync,
  now = Date.now,
  retryDelaysMs,
  liveTest: liveTestDeps,
} = {}) {
  const retry = (task) => retryTransientFs(task, retryDelaysMs ? { delays: retryDelaysMs } : undefined);
  const staging = createStaging({ stagingDir, fsImpl, now, retry });
  const placement = createPlacement({ sourcePath, fsImpl, existsSync, retry });
  const existingOf = (id, store) => inspectExisting(id, store, { sourcePath, existsSync });
  const preview = createPreview({ staging, existingOf, readStore });
  const install = createInstall({
    stagingDir, staging, placement, existingOf, readStore, writeStore, flushNow, invalidatePopularAll,
    loadCandidateFromFile, loadSourceFromFile, clearSourceCache, now,
  });
  const test = createTestRunner({ readStore, writeStore, flushNow, loadSourceFromFile, liveTestDeps });

  // Installs touch one folder and the store: one at a time, in the order they came.
  let chain = Promise.resolve();
  function serial(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  return {
    preview,
    install: (input = {}) => serial(() => install(input)),
    test,
  };
}

module.exports = { createSourceImportService, IMPORTED, RESERVED_IDS };
