'use strict';

const limits = require('../../config/limits');
const { createFailure } = require('./failure');

const SHA256_RE = /^[a-f0-9]{64}$/;

/** The source text of a request: text, not empty, no NUL, within the size limit (in bytes, not characters). */
function checkCode(code) {
  if (typeof code !== 'string' || !code.trim()) throw createFailure('Choose a .js file or paste the source code first.');
  if (code.includes('\u0000')) throw createFailure('The text contains a NUL character, so it is not a source file.');
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > limits.sourceImportMaxBytes) {
    throw createFailure(`The file is ${bytes} bytes; the most a source may have is ${limits.sourceImportMaxBytes}.`, 413);
  }
  return code;
}

/** The fingerprint a request names: exactly 64 lower-case hex characters, so it can never be a path. */
function checkSha256(sha256) {
  if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
    throw createFailure('Missing or invalid file fingerprint: check the file again.');
  }
  return sha256;
}

module.exports = { checkCode, checkSha256, SHA256_RE };
