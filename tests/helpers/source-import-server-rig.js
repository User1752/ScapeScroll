'use strict';

// A source import service on a real temporary folder with the real loader core, for the source-import-*.test.js files
// (the server side; the Settings card has its own rig, source-import-rig.js). Faults are injected through the options:
// `loadSource` replaces the loader's final load, `fsOverrides` wraps single fs.promises calls, `writeStoreImpl`
// replaces the store write, `loadCandidate` the staged run, `now` moves the clock, `liveTest` the helpers of the live test
// (the image fetch and the pauses).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSourceImportService } = require('../../server/modules/source-import/service');
const { createSourceLoaderCore } = require('../../server/modules/source-loader/core');
const { safeId } = require('../../server/modules/common/identity');

const RUNS = '__SS_IMPORT_RUNS__';

/** The text of a minimal valid source; `omit` leaves one of the four calls out, `body` goes before meta. */
const sourceText = (id = 'demo', { body = '', meta = '', omit = '' } = {}) => `${body}
exports.meta = { id: '${id}', name: 'Demo ${id}', version: '1.0.0', author: 'Me'${meta} };
${['search', 'mangaDetails', 'chapters', 'pages'].filter((name) => name !== omit).map((name) => `exports.${name} = async () => ({});`).join('\n')}
`;

/** Top-level code that counts how many times a file ran. */
const countRun = `globalThis.${RUNS} = (globalThis.${RUNS} || 0) + 1;`;

function makeRig(t, { loadSource, fsOverrides, writeStoreImpl, now, retryDelaysMs = [1, 1, 1], loadCandidate, liveTest } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-import-'));
  const sourcesDir = path.join(root, 'data', 'sources');
  const stagingDir = path.join(root, 'data', 'source-staging');
  fs.mkdirSync(sourcesDir, { recursive: true });
  const core = createSourceLoaderCore({ safeId });
  core.configure({ sourcesDir, snapSourcesDir: path.join(root, 'snap', 'data', 'sources'), isPkg: false });
  const store = { installedSources: {} };
  const writes = [];
  const counters = { flushed: 0, invalidated: 0 };
  const fsImpl = { ...fs.promises, ...(fsOverrides || {}) };
  const service = createSourceImportService({
    stagingDir,
    sourcePath: core.sourcePath,
    loadCandidateFromFile: loadCandidate || core.loadCandidateFromFile,
    loadSourceFromFile: loadSource ? (id, opts) => loadSource(core, id, opts) : core.loadSourceFromFile,
    clearSourceCache: core.clearSourceCache,
    readStore: async () => store,
    writeStore: writeStoreImpl || (async (value) => { writes.push(JSON.parse(JSON.stringify(value))); }),
    flushNow: () => { counters.flushed += 1; },
    invalidatePopularAll: () => { counters.invalidated += 1; },
    fsImpl,
    now,
    retryDelaysMs,
    liveTest,
  });
  delete globalThis[RUNS];
  t.after(() => {
    delete globalThis[RUNS];
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, sourcesDir, stagingDir, core, store, writes, counters, service,
    live: (id) => path.join(sourcesDir, `${id}.js`),
    stagedFiles: () => (fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : []),
    liveFiles: () => fs.readdirSync(sourcesDir).sort(),
  };
}

async function rejection(promise) {
  try { await promise; } catch (err) { return err; }
  return assert.fail('expected a rejection');
}

/** An fs error as Node makes it: a code, and the paths in the message. */
function fsError(code, message) {
  const err = new Error(message || `${code}: simulated, '${os.tmpdir()}${path.sep}x'`);
  err.code = code;
  return err;
}

module.exports = { makeRig, rejection, fsError, sourceText, countRun, RUNS };
