'use strict';
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

// Defaults to __dirname-relative for standalone use (e.g. a bare require in
// a test), but server.js calls configure() with the real, writable DATA_DIR
// on startup — required in a packaged .exe, where __dirname sits inside a
// read-only snapshot and every write here would otherwise fail silently.
let LOG_PATH = path.join(path.resolve(__dirname, '../../data'), 'error-log.json');
let configured = false;

function configure(dataDir) {
  LOG_PATH = path.join(dataDir, 'error-log.json');
  configured = true;
  ensureLogFile();
}

// The file recordError() actually writes to. The /api/error-log route reads it
// from here: it used to rebuild "<repo>/data/error-log.json" from __dirname,
// which inside a packaged exe is the read-only snapshot — so the exe showed an
// empty log and could not clear it, while errors piled up in the real data folder.
function getLogPath() {
  return LOG_PATH;
}

// A brand-new install has no error-log.json until the first error happens to
// be recorded, and System Health lists it as a REQUIRED data file — so every
// fresh install (a new clone, a new .exe next to an empty data folder) opened
// on a "warning: Missing required data files: error-log.json" that meant
// nothing. Creating the empty log up front makes "missing" mean "deleted".
function ensureLogFile() {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    if (!fs.existsSync(LOG_PATH)) fs.writeFileSync(LOG_PATH, '[]', 'utf8');
  } catch {
    // Read-only location etc. — recordError() already tolerates that.
  }
}

// That __dirname default is a trap for tests: a bare require() plus any code
// path that calls recordError() (e.g. createAsyncHandler turning a thrown
// 500 into a log entry) wrote straight into the owner's REAL
// data/error-log.json — confirmed live, every `npm test` run bumped the
// count of a "boom" entry there, from the async-handler unit test. node's
// test runner marks its child processes with NODE_TEST_CONTEXT, so under it
// an unconfigured logger refuses to touch the default path; a test that
// wants to exercise real writes calls configure(<temp dir>) first.
function writesAreBlocked() {
  return !configured && !!process.env.NODE_TEST_CONTEXT;
}

let writePromise = Promise.resolve();

/**
 * Records an error to data/error-log.json safely (with mutex)
 */
async function recordError(errObj) {
  if (writesAreBlocked()) return;
  const op = writePromise.then(async () => {
    try {
      let entries = [];
      try {
        const raw = await fsp.readFile(LOG_PATH, 'utf8');
        entries = JSON.parse(raw);
        if (!Array.isArray(entries)) entries = [];
      } catch {
        entries = [];
      }

      const existing = entries.find(e => e.area === errObj.area && e.message === errObj.message);
      if (existing) {
        existing.count = (existing.count || 1) + 1;
        existing.lastSeenAt = new Date().toISOString();
        if (errObj.details) Object.assign(existing.details, errObj.details);
      } else {
        entries.unshift({
          code: errObj.code || 'ERR',
          area: errObj.area || 'system',
          message: errObj.message,
          details: errObj.details || {},
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          count: 1
        });
      }

      if (entries.length > 50) entries.length = 50;
      await fsp.writeFile(LOG_PATH, JSON.stringify(entries, null, 2), 'utf8');
    } catch (e) {
      console.error('[ErrorLogger] fail:', e.message);
    }
  });

  writePromise = op;
  return op;
}

async function clearErrors() {
  if (writesAreBlocked()) return;
  const op = writePromise.then(async () => {
    try {
      await fsp.writeFile(LOG_PATH, JSON.stringify([], null, 2), 'utf8');
    } catch (e) {
      console.error('[ErrorLogger] fail clear:', e.message);
    }
  });
  writePromise = op;
  return op;
}

module.exports = { configure, getLogPath, recordError, clearErrors };
