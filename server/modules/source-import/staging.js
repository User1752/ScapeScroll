'use strict';

const path = require('path');
const nodeCrypto = require('crypto');
const limits = require('../../config/limits');
const { sha256Of } = require('./static-report');
const { createFailure, diskFailure } = require('./failure');

// The folder where a source file waits between "Check" and "Install", named by its sha256. Only files this module
// names are ever touched: <64 hex>.js and the <64 hex>.js.tmp-<hex> it writes through.
const STAGED_FILE_RE = /^([a-f0-9]{64})\.js$/;
const STAGED_TMP_RE = /^([a-f0-9]{64})\.js\.tmp-[a-f0-9]+$/;

// The files this module made, oldest first: { name, sha256, tmp, mtimeMs }.
async function listStaged(stagingDir, fsImpl) {
  let names;
  try { names = await fsImpl.readdir(stagingDir); } catch { return []; }
  const staged = [];
  for (const name of names) {
    const match = STAGED_FILE_RE.exec(name) || STAGED_TMP_RE.exec(name);
    if (!match) continue;
    try {
      const stat = await fsImpl.stat(path.join(stagingDir, name));
      staged.push({ name, sha256: match[1], tmp: !STAGED_FILE_RE.test(name), mtimeMs: stat.mtimeMs });
    } catch { /* gone already */ }
  }
  return staged.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// `retry` runs a filesystem step again when the system refuses it for a moment (common/fs-retry.js).
function createStaging({ stagingDir, fsImpl, now, retry = (task) => task() }) {
  // A file an install is working on right now is never pruned from under it.
  const inUse = new Set();
  const pathOf = (sha256) => path.join(stagingDir, `${sha256}.js`);

  // Expired files go, and the oldest go first when too many wait.
  async function prune() {
    const staged = (await listStaged(stagingDir, fsImpl)).filter((file) => !inUse.has(file.sha256));
    const expired = staged.filter((file) => now() - file.mtimeMs > limits.sourceImportStagingTtlMs);
    const waiting = staged.filter((file) => !file.tmp && !expired.includes(file));
    const surplus = waiting.slice(0, Math.max(0, waiting.length - (limits.sourceImportStagingMaxFiles - 1)));
    for (const file of [...expired, ...surplus]) {
      await fsImpl.unlink(path.join(stagingDir, file.name)).catch(() => {});
    }
  }

  // Written through a temporary name and renamed into place, so a reader never sees a half-written file and writing
  // the same text again never truncates one an install is reading.
  async function put(sha256, text) {
    const tmp = `${pathOf(sha256)}.tmp-${nodeCrypto.randomBytes(6).toString('hex')}`;
    try {
      await fsImpl.mkdir(stagingDir, { recursive: true });
      await prune();
      await fsImpl.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
      await retry(() => fsImpl.rename(tmp, pathOf(sha256)));
    } catch (err) {
      await fsImpl.unlink(tmp).catch(() => {});
      throw diskFailure(err, stagingDir);
    }
  }

  async function remove(sha256) {
    await fsImpl.unlink(pathOf(sha256)).catch(() => {});
  }

  /** The staged text, verified against its name: a missing or expired file is a 404, a changed one a 409. */
  async function read(sha256) {
    const gone = () => createFailure('The checked file is no longer available (checked files are not kept for long): choose it again.', 404);
    let stat;
    let text;
    try {
      stat = await retry(() => fsImpl.stat(pathOf(sha256)));
      text = await retry(() => fsImpl.readFile(pathOf(sha256), 'utf8'));
    } catch (err) {
      // Only a missing file means "gone"; a refusal that did not lift is a disk fault, not an expired check.
      if (err && err.code === 'ENOENT') throw gone();
      throw diskFailure(err, stagingDir);
    }
    if (now() - stat.mtimeMs > limits.sourceImportStagingTtlMs) {
      await remove(sha256);
      throw gone();
    }
    if (sha256Of(text) !== sha256) {
      await remove(sha256);
      throw createFailure('The checked file changed on disk, so it was discarded: choose it again.', 409);
    }
    return text;
  }

  async function whileInUse(sha256, task) {
    inUse.add(sha256);
    try {
      return await task();
    } finally {
      inUse.delete(sha256);
    }
  }

  return { pathOf, put, read, remove, prune, whileInUse };
}

module.exports = { createStaging };
