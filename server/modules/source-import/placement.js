'use strict';

const nodeCrypto = require('crypto');
const { diskFailure } = require('./failure');

// Puts a checked source file in the sources folder, and takes it out again when the install has to be undone.
// The text goes to a temporary name first and is renamed into place; when replacing, the file that was there is kept
// as <id>.js.bak (the scan only reads names ending in ".js", so neither the .bak nor a left-over temporary file is
// ever taken for a source).
function createPlacement({ sourcePath, fsImpl, existsSync, retry }) {
  /** @returns {Promise<{ target: string, backup: string, hadPrevious: boolean }>} */
  async function place({ id, text, replace }) {
    const target = sourcePath(id);
    const tmp = `${target}.tmp-${nodeCrypto.randomBytes(6).toString('hex')}`;
    const backup = `${target}.bak`;
    let hadPrevious = false;
    try {
      await fsImpl.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
      // The step an antivirus or a sync client can refuse for a moment: tried again before giving up.
      await retry(async () => {
        if (replace && existsSync(target)) {
          await fsImpl.copyFile(target, backup);
          hadPrevious = true;
        }
        await fsImpl.rename(tmp, target);
      });
    } catch (err) {
      await fsImpl.unlink(tmp).catch(() => {});
      throw diskFailure(err);
    }
    return { target, backup, hadPrevious };
  }

  /** Puts the sources folder back as it was. True when it is, false when the undo itself was refused. */
  async function undo({ target, backup, hadPrevious }) {
    try {
      await retry(async () => {
        if (hadPrevious) {
          await fsImpl.copyFile(backup, target);
          return;
        }
        // A file that is already gone is the state the undo wants.
        await fsImpl.unlink(target).catch((err) => { if (!err || err.code !== 'ENOENT') throw err; });
      });
      return true;
    } catch {
      return false;
    }
  }

  return { place, undo };
}

module.exports = { createPlacement };
