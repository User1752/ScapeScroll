'use strict';

const { analyzeSourceCode, collectHostsOutsideDeclaration } = require('./static-report');
const { sanitizeSourceUi, clientViewOfUi } = require('../common/source-ui');
const { checkSourceContract } = require('./contract');
const { createFailure, describeError, stripLocalPaths } = require('./failure');
const { checkSha256 } = require('./input');
const { IMPORTED, checkId } = require('./ids');

// "Install": takes only the sha256 of a checked file back, so what is installed is exactly the text that was checked.
// It runs that text once to read its exports, judges them against the contract and only then puts the file in the
// sources folder; if anything after that fails, the previous state is put back (placement.js).
//
// `ctx` is the service's wiring: { stagingDir, staging, placement, existingOf, readStore, writeStore, flushNow,
// invalidatePopularAll, loadCandidateFromFile, loadSourceFromFile, clearSourceCache, now }.

// Whether this id is being replaced. Throws when it is blocked, or when it is an earlier import and the request did
// not confirm the replacement.
function judgeExisting(ctx, id, store, confirmed) {
  const existing = ctx.existingOf(id, store);
  if (existing.state === 'blocked') throw createFailure(existing.reason, 409);
  if (existing.state === 'replaceable' && !confirmed) {
    throw createFailure(`"${id}" is already installed from an earlier import: confirm the replacement to continue.`, 409);
  }
  return existing.state === 'replaceable';
}

// The one moment the file's code runs before it is in place: its top level, to read what it exports. It runs the very
// text whose hash was just verified.
function judgeCandidate(ctx, { sha256, id, text }) {
  let candidate;
  try {
    candidate = ctx.loadCandidateFromFile(ctx.staging.pathOf(sha256), id, text);
  } catch (err) {
    throw createFailure(`The file could not be loaded: ${describeError(err, ctx.stagingDir)}`);
  }
  const verdict = checkSourceContract(candidate, id);
  if (!verdict.ok) {
    // The reasons can quote text the file's own code produced (a getter that throws): no path of this computer in them.
    const clean = (list) => list.map((reason) => stripLocalPaths(reason, ctx.stagingDir));
    throw createFailure('The file does not follow the source contract.', 400, { errors: clean(verdict.errors), warnings: clean(verdict.warnings) });
  }
  // meta.ui is data about the source (filters, genres, adult flag, Referer rules): validated like the rest, and a
  // declaration that must never be installed as it is (a genre that names sexualised minors) stops the install.
  const declaration = sanitizeSourceUi(candidate.meta && candidate.meta.ui, { knownHosts: collectHostsOutsideDeclaration(text) });
  const declarationErrors = declaration.problems.filter((problem) => problem.level === 'error').map((problem) => problem.message);
  if (declarationErrors.length > 0) {
    throw createFailure('The declaration in meta.ui is not valid.', 400, { errors: declarationErrors, warnings: verdict.warnings });
  }
  return { ...verdict, declaration };
}

// Undoes a placement and builds the failure to throw. It only says "rolled back" when the undo really worked.
async function rollBack(ctx, id, placed, cause, stage) {
  ctx.clearSourceCache(id);
  const undone = await ctx.placement.undo(placed);
  ctx.clearSourceCache(id);
  const reason = describeError(cause, ctx.stagingDir);
  let message = `The source ${stage} and was rolled back: ${reason}`;
  if (!undone) {
    // For a replacement the file in place is the new one and the person's working copy is the .bak: never tell them to
    // delete the only file that works.
    const byHand = placed.hadPrevious
      ? `restore ${id}.js from ${id}.js.bak by hand (rename it over ${id}.js)`
      : `delete ${id}.js from the sources folder by hand`;
    message = `The source ${stage} and could not be rolled back: ${byHand} (${reason})`;
  }
  return createFailure(message, 500, undefined, { expected: false });
}

async function loadInPlace(ctx, id, placed) {
  try {
    ctx.clearSourceCache(id);
    const verdict = checkSourceContract(ctx.loadSourceFromFile(id, { allowSelfHeal: false }), id);
    if (!verdict.ok) throw new Error(verdict.errors.join(' '));
    return verdict;
  } catch (err) {
    throw await rollBack(ctx, id, placed, err, 'failed to load in its final place');
  }
}

async function register(ctx, { id, sha256, store, placed, summary }) {
  const previous = store.installedSources[id];
  const entry = {
    id,
    name: summary.name || id,
    version: summary.version || '1.0.0',
    author: summary.author || 'Imported',
    icon: summary.icon || '',
    installedAt: new Date(ctx.now()).toISOString(),
    installedVia: IMPORTED,
    sha256,
  };
  try {
    store.installedSources[id] = entry;
    await ctx.writeStore(store);
    ctx.flushNow();
    ctx.invalidatePopularAll();
  } catch (err) {
    if (previous === undefined) delete store.installedSources[id];
    else store.installedSources[id] = previous;
    throw await rollBack(ctx, id, placed, err, 'could not be registered');
  }
  return entry;
}

async function installChecked(ctx, { sha256, id, replace }) {
  const text = await ctx.staging.read(sha256);
  const syntaxError = analyzeSourceCode(text).syntaxError;
  if (syntaxError) throw createFailure(`The file does not parse: ${syntaxError.message}`);

  const store = await ctx.readStore();
  const replacing = judgeExisting(ctx, id, store, replace === true);
  const verdict = judgeCandidate(ctx, { sha256, id, text });
  const declarationWarnings = verdict.declaration.problems.map((problem) => problem.message);

  const placed = await ctx.placement.place({ id, text, replace: replacing });
  const loaded = await loadInPlace(ctx, id, placed);
  const entry = await register(ctx, { id, sha256, store, placed, summary: loaded.summary });
  await ctx.staging.remove(sha256);
  return {
    ok: true,
    installed: entry,
    replaced: replacing,
    warnings: [...verdict.warnings, ...declarationWarnings],
    declared: verdict.declaration.present ? clientViewOfUi(verdict.declaration.ui) : null,
    methods: loaded.summary.methods,
    optionalMethods: loaded.summary.optionalMethods,
  };
}

/** @returns {(request: { sha256?: unknown, id?: unknown, replace?: unknown }) => Promise<object>} */
function createInstall(ctx) {
  return async function install(input = {}) {
    const sha256 = checkSha256(input.sha256);
    const id = checkId(input.id);
    return ctx.staging.whileInUse(sha256, () => installChecked(ctx, { sha256, id, replace: input.replace }));
  };
}

module.exports = { createInstall };
