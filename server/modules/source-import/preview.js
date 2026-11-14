'use strict';

const { analyzeSourceCode, collectHostsOutsideDeclaration } = require('./static-report');
const { sanitizeSourceUi, readDeclaredUiLiteral, clientViewOfUi } = require('../common/source-ui');
const { checkCode } = require('./input');
const { chooseId } = require('./ids');

// "Check": reads the text WITHOUT running it, stages it under its sha256 when it can be installed, and answers with
// what it found. Nothing reaches the sources folder.

function syntaxBlocker(syntaxError) {
  const where = syntaxError.line ? ` (line ${syntaxError.line})` : '';
  return `The file does not parse${where}: ${syntaxError.message}`;
}

// What the file says about itself in meta.ui, read from the text without running it. A declaration written as a plain
// literal is shown and validated here; a computed one can only be read after installing (it is validated again then).
// `problems` with level 'error' block the install (the same check runs on the loaded module at install time).
function describeDeclaration(text) {
  const found = readDeclaredUiLiteral(text);
  if (!found.found) return { present: false, readable: false, ui: null, problems: [] };
  if (!found.readable) return { present: true, readable: false, reason: found.reason || '', ui: null, problems: [] };
  const verdict = sanitizeSourceUi(found.value, { knownHosts: collectHostsOutsideDeclaration(text) });
  return { present: true, readable: true, ui: clientViewOfUi(verdict.ui), imageReferers: (verdict.ui && verdict.ui.imageReferers) || [], problems: verdict.problems };
}

function previewResponse({ report, choice, existing, blockers, canInstall, declaration }) {
  return {
    ok: true,
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
    declaration,
    existing: existing && existing.state !== 'new' ? existing : null,
    replace: !!(existing && existing.state === 'replaceable'),
    blockers,
    canInstall,
  };
}

/**
 * @param {{ staging: object, existingOf: (id: string, store: object) => object, readStore: () => Promise<object> }} ctx
 * @returns {(request: { code?: unknown, id?: unknown }) => Promise<object>}
 */
function createPreview({ staging, existingOf, readStore }) {
  return async function preview({ code, id } = {}) {
    const text = checkCode(code);
    const report = analyzeSourceCode(text);
    const choice = chooseId(id, text);
    const blockers = [];
    if (report.syntaxError) blockers.push(syntaxBlocker(report.syntaxError));
    if (choice.problem) blockers.push(choice.problem);
    const existing = choice.id ? existingOf(choice.id, await readStore()) : null;
    if (existing && existing.state === 'blocked') blockers.push(existing.reason);
    const declaration = describeDeclaration(text);
    for (const problem of declaration.problems) if (problem.level === 'error') blockers.push(problem.message);
    const canInstall = blockers.length === 0;
    if (canInstall) await staging.put(report.sha256, text);
    return previewResponse({ report, choice, existing, blockers, canInstall, declaration });
  };
}

module.exports = { createPreview };
