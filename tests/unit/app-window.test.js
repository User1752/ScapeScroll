'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openUrl, findAppBrowser, browserCandidates, isSafeUrl } = require('../../server/modules/common/app-window');

const ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LocalAppData: 'C:\\Users\\me\\AppData\\Local',
};
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function recorder() {
  const calls = { spawn: [], exec: [], log: [] };
  return {
    calls,
    spawn: (cmd, args, opts) => { calls.spawn.push({ cmd, args, opts }); return { on() {}, unref() {} }; },
    exec: (command, cb) => { calls.exec.push(command); if (cb) cb(null); },
    log: (m) => calls.log.push(m),
  };
}

test('Chrome is preferred over Edge, in the same places the .bat looks', () => {
  const both = (p) => p === CHROME || p === EDGE;
  assert.equal(findAppBrowser({ env: ENV, exists: both }), CHROME);
  assert.equal(findAppBrowser({ env: ENV, exists: (p) => p === EDGE }), EDGE);
  assert.equal(findAppBrowser({ env: ENV, exists: () => false }), null);
  assert.equal(findAppBrowser({ env: ENV, exists: (p) => p === 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe' }),
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe');
});

test('missing environment variables never produce relative paths', () => {
  assert.deepEqual(browserCandidates({}), []);
  assert.equal(findAppBrowser({ env: {}, exists: () => true }), null);
});

test('on Windows with Chrome installed it opens its own --app window, not a tab', () => {
  const r = recorder();
  const how = openUrl('http://localhost:4000', { platform: 'win32', env: ENV, exists: (p) => p === CHROME, spawn: r.spawn, exec: r.exec, log: r.log });
  assert.equal(how, 'app');
  assert.equal(r.calls.spawn.length, 1);
  assert.equal(r.calls.spawn[0].cmd, CHROME);
  assert.deepEqual(r.calls.spawn[0].args, ['--app=http://localhost:4000', '--window-size=1280,832']);
  assert.equal(r.calls.spawn[0].opts.detached, true);
  assert.equal(r.calls.exec.length, 0);
});

test('without Chrome or Edge it falls back to the default browser, quoted', () => {
  const r = recorder();
  const how = openUrl('http://localhost:4000', { platform: 'win32', env: ENV, exists: () => false, spawn: r.spawn, exec: r.exec, log: r.log });
  assert.equal(how, 'default');
  assert.deepEqual(r.calls.exec, ['start "" "http://localhost:4000"']);
  assert.equal(r.calls.spawn.length, 0);
});

test('SCROLLSCAPE_BROWSER_WINDOW=tab keeps the old tab behaviour', () => {
  const r = recorder();
  const how = openUrl('http://localhost:4000', { platform: 'win32', env: { ...ENV, SCROLLSCAPE_BROWSER_WINDOW: 'tab' }, exists: () => true, spawn: r.spawn, exec: r.exec, log: r.log });
  assert.equal(how, 'default');
  assert.equal(r.calls.spawn.length, 0);
});

test('other platforms use their normal opener', () => {
  const mac = recorder();
  openUrl('http://localhost:4000', { platform: 'darwin', env: {}, exists: () => true, spawn: mac.spawn, exec: mac.exec, log: mac.log });
  assert.deepEqual(mac.calls.exec, ['open "http://localhost:4000"']);
  const linux = recorder();
  openUrl('http://localhost:4000', { platform: 'linux', env: {}, exists: () => true, spawn: linux.spawn, exec: linux.exec, log: linux.log });
  assert.deepEqual(linux.calls.exec, ['xdg-open "http://localhost:4000"']);
});

test('a spawn that throws falls back to the default browser', () => {
  const r = recorder();
  const how = openUrl('http://localhost:4000', {
    platform: 'win32', env: ENV, exists: (p) => p === CHROME, exec: r.exec, log: r.log,
    spawn: () => { throw new Error('EACCES'); },
  });
  assert.equal(how, 'default');
  assert.equal(r.calls.exec.length, 1);
});

test('only plain http(s) addresses are ever put on a command line', () => {
  for (const ok of ['http://localhost:4000', 'http://127.0.0.1:4601/', 'https://localhost:8443/path', 'http://[::1]:4000']) assert.equal(isSafeUrl(ok), true, ok);
  for (const bad of ['file:///C:/x', 'javascript:alert(1)', 'http://x" & calc & "', 'http://localhost:4000 --evil', 'http://a/b"c', 'calc.exe', '', 'http://a/%PATH%']) {
    assert.equal(isSafeUrl(bad), false, bad);
  }
  const r = recorder();
  assert.equal(openUrl('http://x" & calc & "', { platform: 'win32', env: ENV, exists: () => true, spawn: r.spawn, exec: r.exec, log: r.log }), 'none');
  assert.equal(r.calls.spawn.length + r.calls.exec.length, 0);
});
