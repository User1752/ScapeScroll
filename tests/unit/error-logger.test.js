'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOGGER_PATH = require.resolve('../../server/modules/error-logger');

// error-logger keeps its target path in module state, so every test gets its
// own fresh copy instead of inheriting another test's configure() call.
function freshLogger() {
  delete require.cache[LOGGER_PATH];
  return require(LOGGER_PATH);
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-errlog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a configured logger writes to the given directory and de-duplicates by area+message', async (t) => {
  const dir = tempDir(t);
  const logger = freshLogger();
  logger.configure(dir);

  await logger.recordError({ code: 'X', area: 'a', message: 'same thing' });
  await logger.recordError({ code: 'X', area: 'a', message: 'same thing' });
  await logger.recordError({ code: 'X', area: 'a', message: 'something else' });

  const entries = JSON.parse(fs.readFileSync(path.join(dir, 'error-log.json'), 'utf8'));
  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.message === 'same thing').count, 2);

  await logger.clearErrors();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'error-log.json'), 'utf8')), []);
});

test('getLogPath() follows configure(), so routes read the file the logger really writes', (t) => {
  const dir = tempDir(t);
  const logger = freshLogger();
  logger.configure(dir);
  assert.equal(logger.getLogPath(), path.join(dir, 'error-log.json'));
});

test('configure() creates the empty log in a brand-new data folder, and never clobbers an existing one', (t) => {
  const dir = tempDir(t);
  const fresh = path.join(dir, 'does', 'not', 'exist', 'yet');

  freshLogger().configure(fresh);
  assert.equal(fs.readFileSync(path.join(fresh, 'error-log.json'), 'utf8'), '[]');

  const existing = path.join(dir, 'existing');
  fs.mkdirSync(existing);
  fs.writeFileSync(path.join(existing, 'error-log.json'), '[{"area":"a","message":"keep me"}]');
  freshLogger().configure(existing);
  assert.match(fs.readFileSync(path.join(existing, 'error-log.json'), 'utf8'), /keep me/);
});

test('under the test runner, an UNCONFIGURED logger never writes to the default (real data/) path', async (t) => {
  if (!process.env.NODE_TEST_CONTEXT) {
    t.skip('not running under `node --test`, so the safety net is intentionally inactive');
    return;
  }

  const writes = [];
  const originalWriteFile = fs.promises.writeFile;
  fs.promises.writeFile = async (target) => { writes.push(String(target)); };
  t.after(() => { fs.promises.writeFile = originalWriteFile; });

  const logger = freshLogger();
  await logger.recordError({ code: 'HTTP-500', area: 'test', message: 'boom' });
  await logger.clearErrors();

  assert.deepEqual(writes, []);
});
