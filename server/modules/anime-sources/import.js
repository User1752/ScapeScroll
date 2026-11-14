'use strict';

const fs = require('fs');
const path = require('path');
const { retryTransientFs } = require('../common/fs-retry');
const { analyzeSourceCode } = require('../source-import/static-report');
const { createStaging } = require('../source-import/staging');
const { createPlacement } = require('../source-import/placement');
const { createFailure, describeError } = require('../source-import/failure');
const { checkCode, checkSha256 } = require('../source-import/input');
const { chooseId } = require('../source-import/ids');
const { checkAnimeSource, ID_RE } = require('./contract');

// Import of an anime source file the person supplies, in the two steps the manga import has (Check, then Install), over the same
// parts: the staging folder named by sha256, the placement with its .bak, the static report, the failure helpers. What differs:
//
//  - the file goes to its own folder (data/anime-sources/) and is registered in the anime registry, not in the manga store;
//  - an IMPORTED anime source has to declare `meta.stream` (the hosts its video lives on) and cannot bring its own relay: the app
//    fetches the video, only from those hosts (relay.js). The source's code still runs here (it finds the stream), which is why the
//    Check shows what the file contains and the person confirms, as for a manga source;
//  - the sources that ship with the app can never be replaced or removed, and only an anime source imported earlier can be replaced.

const IMPORTED = 'imported';

const idProblem = (id) => (ID_RE.test(id) ? '' : 'An anime source id is 2 to 40 characters: lower-case letters, digits, "_" and "-".');

// The file's exports, judged. This is the one moment its code runs before it is in place: the top level, to read what it exports.
function judgeCandidate({ loadCandidate, stagingDir }, file, id, text) {
  let candidate;
  try { candidate = loadCandidate(file, id, text); } catch (err) {
    throw createFailure(`The file could not be loaded: ${describeError(err, stagingDir)}`);
  }
  const verdict = checkAnimeSource(candidate);
  const problems = [...verdict.problems];
  if (verdict.ok && verdict.meta.id !== id) problems.push(`meta.id is "${verdict.meta.id}", not "${id}".`);
  if (verdict.ok && !verdict.meta.stream) problems.push('An imported anime source has to declare meta.stream (the hosts its video comes from) and use the relay of the app; it cannot bring its own.');
  if (problems.length) throw createFailure('The file does not follow the anime source contract.', 400, { errors: problems });
  return { candidate, meta: verdict.meta };
}

function checkResponse({ report, choice, existing, blockers, canInstall }) {
  return {
    ok: true,
    kind: 'anime',
    id: choice.id,
    idSource: choice.idSource,
    detectedId: choice.detectedId,
    sha256: report.sha256,
    bytes: report.bytes,
    lines: report.lines,
    requires: report.requires,
    requiresMore: report.requiresMore,
    dynamicRequires: report.dynamicRequires,
    hosts: report.hosts,
    hostsMore: report.hostsMore,
    risks: report.risks,
    existing: existing && existing.state !== 'new' ? existing : null,
    replace: !!(existing && existing.state === 'replaceable'),
    blockers,
    canInstall,
  };
}

/** 'new', 'replaceable' (imported earlier) or 'blocked' with the reason. */
function existingFor({ registry, sourcePath, existsSync }, id) {
  const found = registry.list().find((source) => source.id === id);
  if (found && found.origin === IMPORTED) return { state: 'replaceable', name: found.name };
  if (found) return { state: 'blocked', name: found.name, reason: 'An anime source with this id ships with the app and is never replaced.' };
  let onDisk = false;
  try { onDisk = existsSync(sourcePath(id)); } catch { /* an id sourcePath refuses cannot be on disk */ }
  return onDisk ? { state: 'blocked', reason: 'A file with this id already exists in the anime sources folder.' } : { state: 'new' };
}

/**
 * @param {object} deps
 * @param {string} deps.stagingDir            where a checked file waits (not the manga staging folder: a file checked as one kind is never installed as the other)
 * @param {(id: string) => string} deps.sourcePath   where the installed file of `id` lives
 * @param {object} deps.registry              the anime registry (registry.js)
 * @param {(file: string, id: string, text?: string) => object} deps.loadCandidate   runs a source file and returns its exports (sourceLoader.loadCandidateFromFile)
 */
function createAnimeImportService({ stagingDir, sourcePath, registry, loadCandidate, fsImpl = fs.promises, existsSync = fs.existsSync, now = Date.now, retryDelaysMs }) {
  const retry = (task) => retryTransientFs(task, retryDelaysMs ? { delays: retryDelaysMs } : undefined);
  const staging = createStaging({ stagingDir, fsImpl, now, retry });
  const placement = createPlacement({ sourcePath, fsImpl, existsSync, retry });

  const existingOf = (id) => existingFor({ registry, sourcePath, existsSync }, id);

  /** "Check": reads the text WITHOUT running it, stages it when it can be installed, and says what it found. */
  async function preview({ code, id } = {}) {
    const text = checkCode(code);
    const report = analyzeSourceCode(text);
    const choice = chooseId(id, text);
    const blockers = [];
    if (report.syntaxError) blockers.push(`The file does not parse${report.syntaxError.line ? ` (line ${report.syntaxError.line})` : ''}: ${report.syntaxError.message}`);
    if (choice.problem) blockers.push(choice.problem);
    else if (idProblem(choice.id)) blockers.push(idProblem(choice.id));
    const existing = choice.id && !idProblem(choice.id) ? existingOf(choice.id) : null;
    if (existing && existing.state === 'blocked') blockers.push(existing.reason);
    const canInstall = blockers.length === 0;
    if (canInstall) await staging.put(report.sha256, text);
    return checkResponse({ report, choice, existing, blockers, canInstall });
  }

  async function installChecked({ sha256, id, replace }) {
    const text = await staging.read(sha256);
    const syntaxError = analyzeSourceCode(text).syntaxError;
    if (syntaxError) throw createFailure(`The file does not parse: ${syntaxError.message}`);
    if (idProblem(id)) throw createFailure(idProblem(id));
    const existing = existingOf(id);
    if (existing.state === 'blocked') throw createFailure(existing.reason, 409);
    const replacing = existing.state === 'replaceable';
    if (replacing && replace !== true) throw createFailure(`"${id}" is already installed from an earlier import: confirm the replacement to continue.`, 409);
    const { meta } = judgeCandidate({ loadCandidate, stagingDir }, staging.pathOf(sha256), id, text);

    const placed = await placement.place({ id, text, replace: replacing });
    try {
      // From its final place, as it will run at every start. A failure here puts the folder back as it was.
      registry.register(loadCandidate(placed.target, id), { origin: IMPORTED, replace: replacing });
    } catch (err) {
      const undone = await placement.undo(placed);
      throw createFailure(`The source failed to load in its final place and was ${undone ? 'rolled back' : 'NOT rolled back (remove it from the anime sources folder by hand)'}: ${describeError(err, stagingDir)}`, 500, undefined, { expected: false });
    }
    await staging.remove(sha256);
    return { ok: true, installed: { id, name: meta.name }, replaced: replacing, stream: meta.stream };
  }

  // Installs touch one folder and the registry: one at a time, in the order they came.
  let chain = Promise.resolve();
  const serial = (task) => { const run = chain.then(task, task); chain = run.catch(() => {}); return run; };

  function install({ sha256, id, replace } = {}) {
    const hash = checkSha256(sha256);
    const name = String(id || '');
    return serial(() => staging.whileInUse(hash, () => installChecked({ sha256: hash, id: name, replace })));
  }

  /** Removes an anime source imported earlier: its file (and .bak), then its place in the registry. */
  function uninstall({ id } = {}) {
    const name = String(id || '');
    return serial(async () => {
      const found = ID_RE.test(name) ? registry.list().find((source) => source.id === name) : null;
      if (!found) throw createFailure(`"${name.slice(0, 40)}" is not an installed anime source.`, 404);
      if (found.origin !== IMPORTED) throw createFailure(`"${name}" ships with the app and cannot be removed.`, 409);
      const file = sourcePath(name);
      try {
        await retry(() => fsImpl.unlink(file).catch((err) => { if (!err || err.code !== 'ENOENT') throw err; }));
        await fsImpl.unlink(`${file}.bak`).catch(() => {});
      } catch (err) {
        throw createFailure(`The file could not be removed: ${describeError(err, stagingDir)}`, 500, undefined, { expected: false });
      }
      registry.unregister(name);
      return { ok: true, removed: name };
    });
  }

  return { preview, install, uninstall, existingOf };
}

/** Where the anime source `id` lives under `dir`; the id is checked, so it can never be a path. */
function sourcePathIn(dir) {
  return (id) => {
    if (!ID_RE.test(String(id))) throw new Error('Invalid anime source id');
    return path.join(dir, `${id}.js`);
  };
}

module.exports = { createAnimeImportService, sourcePathIn, IMPORTED };
