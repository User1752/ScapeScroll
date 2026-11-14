'use strict';

const { SOURCE_IMPORT_FAILED } = require('../errors/error-codes');

const MESSAGE_MAX = 300;

/**
 * An error the shared async handler turns into `{ ok:false, code, error, ...details }`.
 * `expected` (default true) keeps it out of the error log: a refusal is the tool working. A disk fault is not expected
 * and is logged, so it passes `expected: false`.
 */
function createFailure(message, statusCode = 400, details, { expected = true } = {}) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = SOURCE_IMPORT_FAILED;
  if (expected) err.expected = true;
  if (details) err.details = details;
  return err;
}

// What reaches a person must not carry where things are on this computer. Order matters: a quoted path first (Node
// quotes the paths in its messages, and this project's own folder has spaces in it: "Vault 1.0"), then UNC paths, then
// drive paths (a drive letter only at a word edge, so "https://site" is not one), then POSIX paths of two or more
// segments (a "/" that follows a word character, ":" or "/" is part of a URL, not a path).
function stripLocalPaths(text, stagingDir) {
  let out = String(text);
  if (stagingDir) out = out.split(stagingDir).join('<staging>');
  return out
    .replace(/(['"`])(?:[A-Za-z]:[\\/](?![\\/])|\\\\|\/[\w.@-]+\/)[^'"`\n]*\1/g, '$1<path>$1')
    .replace(/\\\\[^\s'"`)]+/g, '<path>')
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/](?![\\/])[^\s'"`)]*/g, '<path>')
    .replace(/(?<![\w:/.])\/(?:[\w.@-]+\/)+[\w.@-]*/g, '<path>');
}

/** One line of an error's message, with paths removed and the length capped. */
function describeError(err, stagingDir) {
  const first = String((err && err.message) || err || 'Unknown error').split('\n')[0];
  return stripLocalPaths(first, stagingDir).slice(0, MESSAGE_MAX);
}

/** A filesystem step failed (disk full, permissions, a lock that did not clear): a 500 that is logged, without paths. */
function diskFailure(err, stagingDir) {
  return createFailure(`The file could not be saved: ${describeError(err, stagingDir)}`, 500, undefined, { expected: false });
}

module.exports = { createFailure, describeError, diskFailure, stripLocalPaths, MESSAGE_MAX };
