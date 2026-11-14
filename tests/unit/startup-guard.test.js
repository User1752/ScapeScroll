'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { resolveUserRootOrExit, exitWithMessage, guardSingleInstance } = require('../../server/modules/common/startup-guard');

const config = { fatalPauseMs: 11, closePromptTimeoutMs: 22 };

test('resolveUserRootOrExit returns the folder when it can be resolved', () => {
  assert.equal(resolveUserRootOrExit({ getAppRoot: () => '/lib/ScrollScape' }), '/lib/ScrollScape');
});

test('resolveUserRootOrExit explains a refusal, waits only on a console, then exits 1', () => {
  for (const interactive of [true, false]) {
    const logged = [];
    const pauses = [];
    const exits = [];
    resolveUserRootOrExit({
      getAppRoot: () => { throw new Error('two libraries: set SCROLLSCAPE_HOME'); },
      interactive: () => interactive,
      pause: (ms) => pauses.push(ms),
      log: (message) => logged.push(message),
      exit: (code) => { exits.push(code); },
      config,
    });
    assert.deepEqual(logged, ['[Setup] two libraries: set SCROLLSCAPE_HOME']);
    assert.deepEqual(pauses, interactive ? [11] : []);
    assert.deepEqual(exits, [1]);
  }
});

test('exitWithMessage exits at once without a console, waits for Enter (or a timeout) with one', () => {
  const quiet = [];
  exitWithMessage('stopping', 3, { interactive: () => false, log: () => {}, exit: (c) => quiet.push(c), config });
  assert.deepEqual(quiet, [3]);

  const stdin = Object.assign(new EventEmitter(), { resume() { this.resumed = true; } });
  const exits = [];
  let timerFn;
  let timerMs;
  let cleared = false;
  exitWithMessage('stopping', 1, {
    interactive: () => true,
    stdin,
    log: () => {},
    exit: (c) => exits.push(c),
    setTimer: (fn, ms) => { timerFn = fn; timerMs = ms; return 'timer'; },
    clearTimer: (t) => { cleared = t === 'timer'; },
    config,
  });
  assert.equal(stdin.resumed, true);
  assert.equal(timerMs, 22);
  assert.deepEqual(exits, []);
  stdin.emit('data', 'x');
  assert.deepEqual(exits, [1]);
  assert.equal(cleared, true);
  timerFn(); // the timeout also leaves, should nobody press Enter
  assert.deepEqual(exits, [1, 1]);
});

test('guardSingleInstance does nothing outside the packaged exe', async () => {
  let asked = false;
  assert.equal(await guardSingleInstance({ isPkg: false, userRoot: '/x', acquireInstanceLock: () => { asked = true; } }), true);
  assert.equal(asked, false);
});

test('guardSingleInstance lets boot continue and releases the lock on exit', async () => {
  const warnings = [];
  let released = false;
  let registered;
  const ok = await guardSingleInstance({
    isPkg: true,
    userRoot: '/lib',
    acquireInstanceLock: () => ({ ok: true, warning: 'lock folder is read-only', release: () => { released = true; } }),
    onProcessExit: (fn) => { registered = fn; },
    warn: (message) => warnings.push(message),
  });
  assert.equal(ok, true);
  assert.deepEqual(warnings, ['[Setup] Single-instance check skipped: lock folder is read-only.']);
  registered();
  assert.equal(released, true);
});

test('guardSingleInstance refuses a live second instance, names who holds it, and never resolves', async () => {
  const reports = [];
  for (const [lock, expected] of [
    [{ ok: false, pid: 4242, file: '/lib/data/.scrollscape.lock' }, ' (PID 4242)'],
    [{ ok: false, pid: NaN, host: 'OFFICE-PC', file: '/lib/data/.scrollscape.lock' }, ' on the PC named OFFICE-PC'],
    [{ ok: false, pid: NaN, file: '/lib/data/.scrollscape.lock' }, ''],
  ]) {
    const outcome = await Promise.race([
      guardSingleInstance({ isPkg: true, userRoot: '/lib', acquireInstanceLock: () => lock, report: (m) => reports.push(m) }).then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 20)),
    ]);
    assert.equal(outcome, 'pending', 'a refused start must never carry on booting');
    assert.match(reports.at(-1), new RegExp(`already running from /lib${expected.replace(/[()]/g, '\\$&')}\\. `));
    assert.match(reports.at(-1), /delete \/lib\/data\/\.scrollscape\.lock/);
  }
});
