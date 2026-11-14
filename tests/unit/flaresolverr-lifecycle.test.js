'use strict';

const test = require('node:test');
const { beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  flaresolverrSpawnEnv,
  isLoopbackListenAddress,
  resolveFlaresolverrChoice,
  isDisabled,
  isAutoInstallEnabled,
  isManaged,
  isExpectedAssetUrl,
  parseNetstatListeners,
  restartFlaresolverr,
  registerRestartListener,
  installFlaresolverr,
  ensureFlaresolverrRunning,
  recoverFromHang,
  getRecoveryStatus,
  resetRecoveryBrake,
  startFlaresolverrIdleWatcher,
} = require('../../server/modules/network/flaresolverr-lifecycle');

// Every call passes the saved choice explicitly (null = nothing saved) so the
// results do not depend on a data/setup.json that may exist on this machine.

// Silences, and records, console.error for the warn-once messages.
function captureConsoleError(fn) {
  const original = console.error;
  const lines = [];
  console.error = (message) => lines.push(String(message));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return lines;
}

test('FlareSolverr is always pinned to loopback, whatever HOST the app was given', () => {
  for (const host of [undefined, '', '0.0.0.0', '::', '100.68.10.126', '192.168.1.5']) {
    const env = flaresolverrSpawnEnv({ HOST: host, PATH: 'x' }, 8191);
    assert.equal(env.HOST, '127.0.0.1');
    assert.equal(env.PORT, '8191');
    assert.equal(env.PATH, 'x');
  }
});

test('the spawn env does not mutate the environment it was built from', () => {
  const base = { HOST: '0.0.0.0' };
  flaresolverrSpawnEnv(base, 9000);
  assert.deepEqual(base, { HOST: '0.0.0.0' });
});

test('the spawn env drops differently-cased HOST/PORT and forces the metrics exporter off', () => {
  const env = flaresolverrSpawnEnv({ Host: '0.0.0.0', port: '1', PROMETHEUS_ENABLED: 'true', Prometheus_Port: '9' }, 8191);
  assert.deepEqual(Object.keys(env).filter((k) => /^host$/i.test(k)), ['HOST']);
  assert.deepEqual(Object.keys(env).filter((k) => /^port$/i.test(k)), ['PORT']);
  assert.equal(env.PROMETHEUS_ENABLED, 'false');
  assert.equal(env.Prometheus_Port, '9');
});

test('only loopback listener addresses count as private', () => {
  for (const ok of ['127.0.0.1', '127.0.0.2', '[::1]']) assert.equal(isLoopbackListenAddress(ok), true, ok);
  for (const bad of ['0.0.0.0', '[::]', '192.168.1.5', '100.68.10.126', '1127.0.0.1', '127.0.0', '', undefined]) {
    assert.equal(isLoopbackListenAddress(bad), false, String(bad));
  }
});

test('automatic download is off unless the environment or a saved "install" asks for it', () => {
  assert.equal(isAutoInstallEnabled({}, null), false);
  assert.equal(isAutoInstallEnabled({ FLARESOLVERR_AUTO_INSTALL: '0' }, null), false);
  for (const yes of ['1', 'true', 'TRUE', 'yes', 'on', 'y', 'Y', ' 1 ']) {
    assert.equal(isAutoInstallEnabled({ FLARESOLVERR_AUTO_INSTALL: yes }, null), true, yes);
  }
  assert.equal(isAutoInstallEnabled({}, 'install'), true);
  assert.equal(isAutoInstallEnabled({}, 'skip'), false);
});

test('FLARESOLVERR_DISABLED switches the lifecycle off, and accepts the same spellings as the other flag', () => {
  assert.equal(isDisabled({}, null), false);
  assert.equal(isDisabled({ FLARESOLVERR_DISABLED: '' }, null), false);
  for (const off of ['0', 'false', 'no', 'off', 'n', 'N']) {
    assert.equal(isDisabled({ FLARESOLVERR_DISABLED: off }, null), false, off);
  }
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on', 'y', 'Y', ' 1 ']) {
    assert.equal(isDisabled({ FLARESOLVERR_DISABLED: on }, null), true, on);
  }
});

test('a flag value that is not understood warns once, and fails on the side of doing nothing', () => {
  const lines = captureConsoleError(() => {
    // Not consent to download...
    assert.equal(isAutoInstallEnabled({ FLARESOLVERR_AUTO_INSTALL: 'perhaps' }, null), false);
    assert.equal(isAutoInstallEnabled({ FLARESOLVERR_AUTO_INSTALL: 'perhaps' }, null), false);
    // ...and a brake that was meant to be one still brakes.
    assert.equal(isDisabled({ FLARESOLVERR_DISABLED: 'switched-off' }, null), true);
    assert.equal(isDisabled({ FLARESOLVERR_DISABLED: 'switched-off' }, null), true);
  });
  assert.equal(lines.length, 2, 'one warning per distinct bad value, not one per call');
  assert.match(lines[0], /FLARESOLVERR_AUTO_INSTALL="perhaps".*not understood.*treating it as 0/);
  assert.match(lines[1], /FLARESOLVERR_DISABLED="switched-off".*not understood.*treating it as 1/);
});

test('the saved first-run choice decides, but the environment can always override it', () => {
  assert.equal(isDisabled({}, 'skip'), true);
  assert.equal(isDisabled({}, 'install'), false);
  assert.equal(isDisabled({}, null), false);
  // AUTO_INSTALL wins over a saved "skip"; DISABLED wins over everything.
  assert.equal(isDisabled({ FLARESOLVERR_AUTO_INSTALL: '1' }, 'skip'), false);
  assert.equal(isDisabled({ FLARESOLVERR_DISABLED: '1', FLARESOLVERR_AUTO_INSTALL: '1' }, 'install'), true);
});

test('an unreadable setup.json counts as unanswered: off, and never a reason to download', () => {
  assert.equal(isDisabled({}, null, true), true);
  assert.equal(isAutoInstallEnabled({}, 'install', true), false);
  // Only an explicit environment variable overrides a damaged file.
  assert.equal(isDisabled({ FLARESOLVERR_AUTO_INSTALL: '1' }, null, true), false);
  assert.equal(isDisabled({ FLARESOLVERR_DISABLED: '1' }, null, true), true);
});

test('when the .bat launcher owns the install a saved choice is ignored', () => {
  const env = { FLARESOLVERR_EXE_PATH: 'C:\\app\\tools\\flaresolverr\\flaresolverr.exe' };
  assert.equal(isDisabled(env, 'skip'), false);
  assert.equal(isAutoInstallEnabled(env, 'install'), false);
  assert.equal(isDisabled({ ...env, FLARESOLVERR_DISABLED: '1' }, null), true);
});

// resolveFlaresolverrChoice with every input injected.
function scenario(overrides = {}) {
  const calls = { asked: 0, saved: [], logs: [], warns: [] };
  const options = {
    env: {},
    platform: 'win32',
    choice: () => null,
    problem: () => null,
    exeExists: () => false,
    interactive: () => true,
    ask: async () => { calls.asked += 1; return 'install'; },
    save: (answer) => calls.saved.push(answer),
    log: (m) => calls.logs.push(m),
    warn: (m) => calls.warns.push(m),
    ...overrides,
  };
  return { calls, run: () => resolveFlaresolverrChoice(options) };
}

test('the first-run question is asked once on an interactive Windows console and the answer is saved', async () => {
  const s = scenario();
  assert.equal(await s.run(), 'install');
  assert.equal(s.calls.asked, 1);
  assert.deepEqual(s.calls.saved, ['install']);

  const no = scenario({ ask: async () => 'skip' });
  assert.equal(await no.run(), 'skip');
  assert.deepEqual(no.calls.saved, ['skip']);
});

test('an unanswered question saves nothing and says so in the log', async () => {
  const s = scenario({ ask: async () => null });
  assert.equal(await s.run(), null);
  assert.deepEqual(s.calls.saved, []);
  assert.equal(s.calls.logs.length, 1);
  assert.match(s.calls.logs[0], /shown but not answered.*asked again next launch/);
});

test('the question is never asked when something else already decided', async () => {
  const cases = {
    'no console': { interactive: () => false },
    'not Windows': { platform: 'linux' },
    'already installed': { exeExists: () => true },
    'saved choice': { choice: () => 'skip' },
    'env says yes': { env: { FLARESOLVERR_AUTO_INSTALL: '1' } },
    'env says off': { env: { FLARESOLVERR_DISABLED: '1' } },
    'launcher owns the install': { env: { FLARESOLVERR_EXE_PATH: 'C:\\x\\flaresolverr.exe' } },
    'launcher already asked on its own console': { env: { SCROLLSCAPE_LAUNCHER: '1' } },
  };
  for (const [name, overrides] of Object.entries(cases)) {
    const s = scenario(overrides);
    await s.run();
    assert.equal(s.calls.asked, 0, name);
    assert.deepEqual(s.calls.saved, [], name);
  }
});

test('an unreadable setup.json is a reason to ask even though FlareSolverr is installed', async () => {
  const s = scenario({ exeExists: () => true, problem: () => 'is not valid JSON (Unexpected token)' });
  assert.equal(await s.run(), 'install');
  assert.equal(s.calls.asked, 1);
  assert.deepEqual(s.calls.saved, ['install']);
  assert.match(s.calls.warns.join('\n'), /setup\.json is not valid JSON.*unanswered.*stays off/);

  // With nobody to ask, it stays unanswered - and the warning says how to fix it.
  const quiet = scenario({ exeExists: () => true, problem: () => 'is not valid JSON', interactive: () => false });
  assert.equal(await quiet.run(), null);
  assert.equal(quiet.calls.asked, 0);
  assert.match(quiet.calls.warns.join('\n'), /no console to ask on.*fix or delete/i);
});

// ── A fake machine ───────────────────────────────────────────────────────────
// netstat, the process table, the file system, spawn, PowerShell and the clock
// are all fakes, so restartFlaresolverr / ensureFlaresolverrRunning can be
// driven without FlareSolverr, PowerShell, a download or a network.

const TOOLS = path.resolve('/fake-app/tools');
const EXE = path.join(TOOLS, 'flaresolverr', 'flaresolverr.exe');
const APPDATA = path.resolve('/fake-home/AppData/Roaming');
const ASSET = {
  name: 'flaresolverr_windows_x64.zip',
  browser_download_url: 'https://github.com/FlareSolverr/FlareSolverr/releases/download/v3.3.21/flaresolverr_windows_x64.zip',
};
const SETUP_NONE = { status: 'missing', data: {}, choice: null };
const SETUP_SKIP = { status: 'ok', data: {}, choice: 'skip' };
const SETUP_INSTALL = { status: 'ok', data: {}, choice: 'install' };
const SETUP_BROKEN = { status: 'invalid', data: {}, choice: null, reason: 'is not valid JSON (Unexpected end of JSON input)' };

function netstatText(listeners) {
  const rows = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000',
    '  TCP    127.0.0.1:50000        127.0.0.1:8191         ESTABLISHED     4242',
    '  UDP    0.0.0.0:8191           *:*                                    4343',
  ];
  for (const l of listeners) {
    const foreign = l.address.startsWith('[') ? '[::]:0' : '0.0.0.0:0';
    rows.push(`  TCP    ${l.address}:8191     ${foreign}     LISTENING       ${l.pid}`);
  }
  return rows.join('\r\n');
}

function makeWorld(options = {}) {
  const w = {
    execs: [], spawns: [], kills: [], logs: [], warns: [], scripts: [], removed: [], intervals: [],
    downloads: 0, watcherArmed: 0,
    listeners: (options.listeners || []).map((l) => ({ ...l })),
    processes: { ...(options.processes || {}) },
    files: new Set(options.files || []),
    reachable: options.reachable === true,
  };
  const exists = (p) => w.files.has(p) || [...w.files].some((f) => f.startsWith(p + path.sep));
  w.io = {
    env: options.env || {},
    platform: options.platform || 'win32',
    fs: {
      existsSync: exists,
      mkdirSync: () => {},
      rmSync: (p) => {
        w.removed.push(p);
        for (const f of [...w.files]) if (f === p || f.startsWith(p + path.sep)) w.files.delete(f);
      },
      renameSync: (from, to) => {
        for (const f of [...w.files]) {
          if (f === from || f.startsWith(from + path.sep)) { w.files.delete(f); w.files.add(to + f.slice(from.length)); }
        }
      },
    },
    exec: async (file, args, opts = {}) => {
      const call = { file, args, env: opts.env || {}, timeout: opts.timeout };
      w.execs.push(call);
      const ok = (stdout = '') => ({ error: null, stdout, stderr: '' });
      if (file === 'netstat') return ok(netstatText(w.listeners));
      if (file === 'taskkill') {
        const pid = Number(args[1]);
        w.kills.push({ pid, args });
        w.listeners = w.listeners.filter((l) => l.pid !== pid);
        return ok();
      }
      if (file !== 'powershell.exe') throw new Error(`unexpected command: ${file}`);
      const script = args[args.length - 1];
      call.script = script;
      w.scripts.push(script);
      if (options.failOn && script.includes(options.failOn)) {
        return { error: new Error('exit 1'), stdout: '', stderr: options.failStderr || 'it failed' };
      }
      if (script.includes('DownloadFile')) { w.files.add(call.env.SS_OUT); return ok(); }
      if (script.includes('Expand-Archive')) { w.files.add(path.join(call.env.SS_DEST, 'flaresolverr', 'flaresolverr.exe')); return ok(); }
      if (script.includes('$p.ExecutablePath')) {
        const info = w.processes[Number(call.env.SS_PID)];
        if (info === 'timeout') return { error: new Error('timed out'), stdout: '', stderr: '' };
        if (!info) return ok('');
        return ok([info.name, info.path].filter((x) => x !== undefined).join('\r\n'));
      }
      return ok('');
    },
    spawn: (file, args, opts) => {
      w.spawns.push({ file, args, opts });
      if (options.spawnThrows) throw new Error(options.spawnThrows);
      const pid = 900 + w.spawns.length;
      const bind = options.spawnedBinds === undefined ? '127.0.0.1' : options.spawnedBinds;
      if (bind) {
        w.listeners.push({ pid, address: bind });
        w.processes[pid] = { name: 'flaresolverr.exe', path: file };
      }
      return { unref() {}, on() {} };
    },
    sleep: async () => {},
    probe: async () => w.reachable,
    fetchAsset: async () => { w.downloads += 1; return options.asset || ASSET; },
    startWatcher: () => { w.watcherArmed += 1; },
    setInterval: (fn, ms) => { w.intervals.push({ fn, ms }); },
    toolsDir: options.toolsDir || TOOLS,
    setup: () => options.setup || SETUP_NONE,
    log: (m) => w.logs.push(m),
    warn: (m) => w.warns.push(m),
  };
  return w;
}

const ours = (exePath = EXE) => ({ name: 'flaresolverr.exe', path: exePath });
const taskkills = (w) => w.execs.filter((e) => e.file === 'taskkill');

// ── restartFlaresolverr: what it launches, and what it refuses to touch ─────

test('restart launches FlareSolverr pinned to loopback with the metrics exporter off, whatever the parent environment says', async () => {
  const w = makeWorld({
    files: [EXE],
    env: { HOST: '0.0.0.0', Host: '10.0.0.5', PROMETHEUS_ENABLED: 'true', prometheus_enabled: '1', PATH: 'p' },
  });
  await restartFlaresolverr(EXE, '8191', 'test restart', w.io);
  assert.equal(w.spawns.length, 1);
  const { file, args, opts } = w.spawns[0];
  assert.equal(file, EXE);
  assert.deepEqual(args, []);
  assert.equal(opts.env.HOST, '127.0.0.1');
  assert.equal(opts.env.PROMETHEUS_ENABLED, 'false');
  assert.equal(opts.env.PORT, '8191');
  assert.equal(opts.env.PATH, 'p');
  assert.deepEqual(Object.keys(opts.env).filter((k) => /^(host|prometheus_enabled)$/i.test(k)).sort(), ['HOST', 'PROMETHEUS_ENABLED']);
  assert.equal(opts.detached, true);
  assert.equal(opts.windowsHide, true);
  assert.match(w.logs.join('\n'), /Restarted \(PID 901\)/);
  assert.deepEqual(w.warns, []);
});

test('restart leaves a port held by some other program alone: nothing killed, nothing started', async () => {
  const others = {
    'a container forwarder': { name: 'com.docker.backend.exe', path: 'C:\\Program Files\\Docker\\Docker\\com.docker.backend.exe' },
    'python': { name: 'python.exe', path: 'C:\\Python312\\python.exe' },
  };
  for (const [label, info] of Object.entries(others)) {
    const w = makeWorld({ files: [EXE], listeners: [{ pid: 77, address: '0.0.0.0' }], processes: { 77: info } });
    await restartFlaresolverr(EXE, '8191', 'wedged', w.io);
    assert.deepEqual(taskkills(w), [], label);
    assert.equal(w.spawns.length, 0, label);
    // The program is named without its ".exe".
    assert.ok(w.warns.join('\n').includes(`${info.name.replace(/\.exe$/, '')} (PID 77), not FlareSolverr; leaving it alone`), `${label}: ${w.warns}`);
    assert.equal(w.scripts.some((s) => s.includes('chromedriver') || s.includes('chrome.exe')), false, `${label}: no cleanup either`);
  }
});

test('restart tells "could not read the owner" apart from "a different program"', async () => {
  const slow = makeWorld({ files: [EXE], listeners: [{ pid: 77, address: '127.0.0.1' }], processes: { 77: 'timeout' } });
  await restartFlaresolverr(EXE, '8191', 'wedged', slow.io);
  assert.deepEqual(taskkills(slow), []);
  assert.equal(slow.spawns.length, 0);
  assert.match(slow.warns.join('\n'), /PID 77, but Windows would not say which program.*timed out or was denied.*left alone/);
  assert.doesNotMatch(slow.warns.join('\n'), /not FlareSolverr/);

  const other = makeWorld({ files: [EXE], listeners: [{ pid: 77, address: '127.0.0.1' }], processes: { 77: { name: 'nginx.exe', path: 'C:\\nginx\\nginx.exe' } } });
  await restartFlaresolverr(EXE, '8191', 'wedged', other.io);
  assert.match(other.warns.join('\n'), /nginx \(PID 77\), not FlareSolverr/);
  assert.doesNotMatch(other.warns.join('\n'), /would not say/);
});

test('restart compares the owner\'s executable path, not just its name', async () => {
  // Same name, different folder: somebody else's FlareSolverr.
  const stranger = makeWorld({
    files: [EXE],
    listeners: [{ pid: 55, address: '127.0.0.1' }],
    processes: { 55: ours('D:\\elsewhere\\flaresolverr\\flaresolverr.exe') },
  });
  await restartFlaresolverr(EXE, '8191', 'wedged', stranger.io);
  assert.deepEqual(taskkills(stranger), []);
  assert.equal(stranger.spawns.length, 0);
  assert.match(stranger.warns.join('\n'), /different FlareSolverr \(D:\\elsewhere\\flaresolverr\\flaresolverr\.exe, PID 55\)/);

  // Right name but Windows will not say where it runs from: cannot be confirmed, so it is left alone.
  const nameless = makeWorld({ files: [EXE], listeners: [{ pid: 55, address: '127.0.0.1' }], processes: { 55: { name: 'flaresolverr.exe', path: '' } } });
  await restartFlaresolverr(EXE, '8191', 'wedged', nameless.io);
  assert.deepEqual(taskkills(nameless), []);
  assert.match(nameless.warns.join('\n'), /where it runs from could not be read/);

  // The very same file, spelled in another case and with a ".." segment: ours.
  const respelled = (path.dirname(EXE) + path.sep + '..' + path.sep + 'flaresolverr' + path.sep + 'flaresolverr.exe').toUpperCase();
  const sameFileDifferentSpelling = makeWorld({
    files: [EXE],
    listeners: [{ pid: 55, address: '127.0.0.1' }],
    processes: { 55: ours(respelled) },
  });
  await restartFlaresolverr(EXE, '8191', 'wedged', sameFileDifferentSpelling.io);
  assert.deepEqual(taskkills(sameFileDifferentSpelling).map((k) => k.args[1]), ['55']);
  assert.equal(sameFileDifferentSpelling.spawns.length, 1);
});

test('restart looks at every listener on the port: one foreign owner anywhere stops it', async () => {
  const w = makeWorld({
    files: [EXE],
    listeners: [{ pid: 10, address: '127.0.0.1' }, { pid: 20, address: '0.0.0.0' }],
    processes: { 10: ours(), 20: { name: 'node.exe', path: 'C:\\node\\node.exe' } },
  });
  await restartFlaresolverr(EXE, '8191', 'wedged', w.io);
  assert.deepEqual(taskkills(w), []);
  assert.equal(w.spawns.length, 0);
  assert.match(w.warns.join('\n'), /node \(PID 20\), not FlareSolverr/);
});

test('restart kills its own wedged copy (and only that), then starts a fresh one', async () => {
  const w = makeWorld({ files: [EXE], listeners: [{ pid: 10, address: '127.0.0.1' }], processes: { 10: ours() } });
  await restartFlaresolverr(EXE, '8191', 'Appears wedged', w.io);
  assert.deepEqual(taskkills(w).map((k) => k.args), [['/pid', '10', '/t', '/f']]);
  assert.equal(w.spawns.length, 1);
  assert.match(w.logs.join('\n'), /Appears wedged \(PID 10\)/);
});

test('restart does nothing when FlareSolverr is switched off, or the exe is not there', async () => {
  const off = makeWorld({ files: [EXE], env: { FLARESOLVERR_DISABLED: '1' }, listeners: [{ pid: 10, address: '127.0.0.1' }], processes: { 10: ours() } });
  await restartFlaresolverr(EXE, '8191', 'x', off.io);
  assert.deepEqual(off.execs, []);
  assert.equal(off.spawns.length, 0);

  const gone = makeWorld({ files: [] });
  await restartFlaresolverr(EXE, '8191', 'x', gone.io);
  assert.deepEqual(gone.execs, []);
  assert.match(gone.warns.join('\n'), /does not exist/);
});

test('restart reports a spawn that fails, and one that comes up reachable from the network', async () => {
  const broken = makeWorld({ files: [EXE], spawnThrows: 'EACCES' });
  await restartFlaresolverr(EXE, '8191', 'x', broken.io);
  assert.match(broken.warns.join('\n'), /Could not start .*EACCES/);

  const stubborn = makeWorld({ files: [EXE], spawnedBinds: '0.0.0.0' });
  await restartFlaresolverr(EXE, '8191', 'x', stubborn.io);
  assert.match(stubborn.warns.join('\n'), /still listening on 0\.0\.0\.0:8191.*taskkill \/pid 901 \/t \/f/);

  const never = makeWorld({ files: [EXE], spawnedBinds: null });
  await restartFlaresolverr(EXE, '8191', 'x', never.io);
  assert.match(never.warns.join('\n'), /did not come back up on port 8191/);
});

// ── chromedriver is cleared by where it runs from, never by name alone ──────

test('clearing a stale chromedriver is scoped to FlareSolverr\'s own folders; nothing is killed by image name', async () => {
  const w = makeWorld({ files: [EXE], env: { APPDATA } });
  await restartFlaresolverr(EXE, '8191', 'x', w.io);
  assert.deepEqual(taskkills(w), [], 'no direct taskkill at all when nothing owned the port');
  assert.equal(w.execs.some((e) => e.args.includes('/im')), false);
  assert.equal(w.scripts.some((s) => /taskkill(\.exe)?\s+\/im/i.test(s)), false);

  const driver = w.execs.find((e) => e.script && e.script.includes('SS_ROOTS'));
  assert.ok(driver, 'a chromedriver cleanup ran');
  assert.match(driver.script, /ExecutablePath/);
  assert.match(driver.script, /chromedriver\.exe/);
  assert.match(driver.script, /StartsWith\(\$_, \[System\.StringComparison\]::OrdinalIgnoreCase\)/);
  assert.deepEqual(driver.env.SS_ROOTS.split('|'), [
    path.join(APPDATA, 'undetected_chromedriver') + path.sep,
    path.join(TOOLS, 'flaresolverr') + path.sep,
  ]);

  const chrome = w.execs.find((e) => e.script && e.script.includes('SS_DIR'));
  assert.equal(chrome.env.SS_DIR, path.join(TOOLS, 'flaresolverr', '_internal', 'chrome') + path.sep);
});

// ── Values never become part of PowerShell script text ──────────────────────

const HOSTILE = "O'Brien Vault 1.0 AppData \u2018A\u2019 \u201AB\u201B $(calc) `x";
const HOSTILE_TOOLS = path.resolve('/Users', HOSTILE, 'tools');
const HOSTILE_PIECES = ["O'Brien", 'Vault 1.0', '\u2018', '\u2019', '\u201A', '\u201B', '$(calc)', '`x'];

test('a path full of quotes, digits and capitals reaches PowerShell byte for byte and never inside the script text', async () => {
  const hostileExe = path.join(HOSTILE_TOOLS, 'flaresolverr', 'flaresolverr.exe');
  const w = makeWorld({ files: [hostileExe], toolsDir: HOSTILE_TOOLS, env: { APPDATA: path.join(HOSTILE_TOOLS, 'Roaming') } });
  await restartFlaresolverr(hostileExe, '8191', 'x', w.io);

  assert.ok(w.scripts.length >= 4, 'chromedriver, chrome, unblock and priority scripts ran');
  for (const script of w.scripts) {
    for (const piece of HOSTILE_PIECES) assert.equal(script.includes(piece), false, `${piece} must not be in: ${script}`);
  }
  const byMarker = (marker) => w.execs.find((e) => e.script && e.script.includes(marker));
  assert.equal(byMarker('Unblock-File').env.SS_FILE, hostileExe);
  assert.equal(byMarker('SS_DIR').env.SS_DIR, path.join(HOSTILE_TOOLS, 'flaresolverr', '_internal', 'chrome') + path.sep);
  assert.ok(byMarker('SS_ROOTS').env.SS_ROOTS.includes(path.join(HOSTILE_TOOLS, 'flaresolverr') + path.sep));
});

test('the install passes the address and every path to PowerShell untouched, and none of them appears in the script', async () => {
  const w = makeWorld({ toolsDir: HOSTILE_TOOLS, setup: SETUP_INSTALL, env: { FLARESOLVERR_AUTO_INSTALL: '1' } });
  const exePath = await installFlaresolverr(w.io);
  assert.equal(exePath, path.join(HOSTILE_TOOLS, 'flaresolverr', 'flaresolverr.exe'));

  const download = w.execs.find((e) => e.script && e.script.includes('DownloadFile'));
  const extract = w.execs.find((e) => e.script && e.script.includes('Expand-Archive'));
  assert.equal(download.env.SS_URL, ASSET.browser_download_url);
  assert.equal(download.env.SS_OUT, path.join(HOSTILE_TOOLS, 'flaresolverr.zip'));
  assert.equal(extract.env.SS_ZIP, path.join(HOSTILE_TOOLS, 'flaresolverr.zip'));
  assert.equal(extract.env.SS_DEST, path.join(HOSTILE_TOOLS, 'fs_temp'));
  for (const call of [download, extract]) {
    assert.doesNotMatch(call.script, /release|github|flaresolverr\.zip|fs_temp/i, 'no value is interpolated');
    for (const piece of HOSTILE_PIECES) assert.equal(call.script.includes(piece), false, piece);
    assert.match(call.script, /^\$ErrorActionPreference='Stop'; \$ProgressPreference='SilentlyContinue'; /);
  }
  assert.match(extract.script, /-LiteralPath/, 'a path with [ ] must not be read as a wildcard');
});

// ── Consent: nothing is downloaded or started without a yes ────────────────

test('with no answer and no install, nothing is downloaded, started or even probed', async () => {
  const w = makeWorld({ setup: SETUP_NONE, env: {} });
  await ensureFlaresolverrRunning(w.io);
  assert.equal(w.downloads, 0);
  assert.equal(w.spawns.length, 0);
  assert.deepEqual(w.execs, []);
  assert.equal(w.watcherArmed, 0);
  assert.match(w.logs.join('\n'), /Not installed and not requested; nothing is downloaded/);
});

test('a saved "skip", an unreadable setup.json or a bad AUTO_INSTALL value never reach the downloader', async () => {
  const cases = {
    'saved skip': { setup: SETUP_SKIP },
    'unreadable setup.json': { setup: SETUP_BROKEN },
    'AUTO_INSTALL=0': { env: { FLARESOLVERR_AUTO_INSTALL: '0' } },
    'AUTO_INSTALL=nope': { env: { FLARESOLVERR_AUTO_INSTALL: 'nope' } },
  };
  for (const [label, options] of Object.entries(cases)) {
    const w = makeWorld(options);
    // console.error is silenced only to keep the unrecognised-value warning out of the test output.
    const original = console.error;
    console.error = () => {};
    try { await ensureFlaresolverrRunning(w.io); } finally { console.error = original; }
    assert.equal(w.downloads, 0, label);
    assert.equal(w.spawns.length, 0, label);
    assert.equal(w.execs.some((e) => e.file === 'powershell.exe'), false, label);
  }
});

test('a saved "install" downloads once, from the pinned address, cleans up, then starts it on loopback', async () => {
  const w = makeWorld({ setup: SETUP_INSTALL });
  await ensureFlaresolverrRunning(w.io);
  assert.equal(w.downloads, 1);
  const download = w.execs.find((e) => e.script && e.script.includes('DownloadFile'));
  assert.equal(download.env.SS_URL, ASSET.browser_download_url);
  assert.ok(w.removed.includes(path.join(TOOLS, 'flaresolverr.zip')), 'the zip is removed');
  assert.ok(w.removed.includes(path.join(TOOLS, 'fs_temp')), 'the temp folder is removed');
  assert.equal(w.files.has(path.join(TOOLS, 'flaresolverr.zip')), false);
  assert.equal(w.spawns.length, 1);
  assert.equal(w.spawns[0].file, EXE);
  assert.equal(w.spawns[0].opts.env.HOST, '127.0.0.1');
  assert.equal(w.watcherArmed, 1);
});

test('FLARESOLVERR_AUTO_INSTALL=y is consent to download', async () => {
  const w = makeWorld({ env: { FLARESOLVERR_AUTO_INSTALL: 'y' } });
  await ensureFlaresolverrRunning(w.io);
  assert.equal(w.downloads, 1);
  assert.equal(w.spawns.length, 1);
});

test('off Windows nothing is downloaded and PowerShell is never invoked, even with AUTO_INSTALL', async () => {
  const w = makeWorld({ platform: 'linux', env: { FLARESOLVERR_AUTO_INSTALL: '1' }, setup: SETUP_INSTALL });
  await ensureFlaresolverrRunning(w.io);
  assert.equal(w.downloads, 0, 'no GitHub call');
  assert.deepEqual(w.execs, [], 'no PowerShell, no netstat');
  assert.equal(w.spawns.length, 0);
  assert.match(w.logs.join('\n'), /only works on Windows; nothing is downloaded/);
  await assert.rejects(installFlaresolverr(w.io), /only works on Windows/);
  assert.equal(w.downloads, 0);
});

test('a failed install leaves no zip or temp folder behind and reports why', async () => {
  const w = makeWorld({ setup: SETUP_INSTALL, failOn: 'Expand-Archive', failStderr: '#< CLIXML\nExpand-Archive : the archive is corrupt\n<Objs Version="1.1.0.1">' });
  await ensureFlaresolverrRunning(w.io);
  assert.equal(w.spawns.length, 0);
  assert.match(w.warns.join('\n'), /Auto-install failed.*the archive is corrupt/);
  assert.doesNotMatch(w.warns.join('\n'), /CLIXML/);
  assert.ok(w.removed.includes(path.join(TOOLS, 'flaresolverr.zip')));
  assert.ok(w.removed.includes(path.join(TOOLS, 'fs_temp')));
  assert.equal(w.files.has(path.join(TOOLS, 'flaresolverr.zip')), false);

  const download = makeWorld({ setup: SETUP_INSTALL, failOn: 'DownloadFile' });
  await ensureFlaresolverrRunning(download.io);
  assert.ok(download.removed.includes(path.join(TOOLS, 'flaresolverr.zip')), 'cleans up after a failed download too');
});

test('the download only comes from FlareSolverr\'s own GitHub releases over https', async () => {
  for (const good of [ASSET.browser_download_url]) assert.equal(isExpectedAssetUrl(good), true, good);
  for (const bad of [
    'http://github.com/FlareSolverr/FlareSolverr/releases/download/v1/x.zip',
    'https://github.com.evil.example/FlareSolverr/FlareSolverr/releases/download/v1/x.zip',
    'https://evil.example/FlareSolverr/FlareSolverr/releases/download/v1/x.zip',
    'https://github.com/someone-else/FlareSolverr/releases/download/v1/x.zip',
    'https://github.com/FlareSolverr/FlareSolverr/archive/main.zip',
    'file:///C:/x.zip', 'not a url', '', undefined,
  ]) assert.equal(isExpectedAssetUrl(bad), false, String(bad));

  const w = makeWorld({ setup: SETUP_INSTALL, asset: { name: 'x.zip', browser_download_url: 'https://evil.example/x.zip' } });
  await ensureFlaresolverrRunning(w.io);
  assert.match(w.warns.join('\n'), /Auto-install failed.*unexpected address/);
  assert.equal(w.scripts.some((s) => s.includes('DownloadFile')), false, 'nothing was downloaded');
});

// ── Off means off ───────────────────────────────────────────────────────────

test('FLARESOLVERR_DISABLED short-circuits everything, however it is spelled', async () => {
  for (const spelling of ['1', 'true', 'yes', 'on', 'y', 'Y', ' 1 ']) {
    const w = makeWorld({ files: [EXE], env: { FLARESOLVERR_DISABLED: spelling, FLARESOLVERR_AUTO_INSTALL: '1' }, setup: SETUP_INSTALL, reachable: false });
    await ensureFlaresolverrRunning(w.io);
    assert.equal(w.spawns.length, 0, spelling);
    assert.equal(w.downloads, 0, spelling);
    assert.deepEqual(taskkills(w), [], spelling);
    assert.equal(w.watcherArmed, 0, spelling);
    assert.ok(w.execs.every((e) => e.file === 'netstat'), `${spelling}: the only thing it may do is look`);
  }
});

test('the "turn it on" hint names the mechanism that switched it off', async () => {
  const viaEnv = makeWorld({ files: [EXE], env: { FLARESOLVERR_DISABLED: '1' } });
  await ensureFlaresolverrRunning(viaEnv.io);
  const envMessage = viaEnv.logs.join('\n');
  assert.match(envMessage, /FLARESOLVERR_DISABLED is set\. To turn it on, unset that variable/);
  assert.match(envMessage, /deleting .*setup\.json changes nothing while it is set/);
  assert.doesNotMatch(envMessage, /set FLARESOLVERR_AUTO_INSTALL/);

  const viaAnswer = makeWorld({ files: [EXE], setup: SETUP_SKIP });
  await ensureFlaresolverrRunning(viaAnswer.io);
  assert.match(viaAnswer.logs.join('\n'), /you answered no\. To be asked again delete .*setup\.json.*FLARESOLVERR_AUTO_INSTALL=1/);

  const viaDamage = makeWorld({ files: [EXE], setup: SETUP_BROKEN });
  await ensureFlaresolverrRunning(viaDamage.io);
  assert.match(viaDamage.logs.join('\n'), /setup\.json is not valid JSON.*Nothing is downloaded or started until you answer.*fix or delete that file/);
});

test('a saved "skip" with FlareSolverr already installed means it is NOT started, restarted or watched', async () => {
  const w = makeWorld({ files: [EXE], setup: SETUP_SKIP, reachable: false });
  await ensureFlaresolverrRunning(w.io);
  assert.equal(w.spawns.length, 0);
  assert.deepEqual(taskkills(w), []);
  assert.equal(w.watcherArmed, 0);
  assert.equal(w.scripts.length, 0);

  // The two other ways the server would start it later are shut the same way.
  const hang = makeWorld({ files: [EXE], setup: SETUP_SKIP });
  assert.equal(recoverFromHang(hang.io), undefined);
  assert.deepEqual(hang.execs, []);
});

test('an unreadable setup.json keeps an installed FlareSolverr off until the user answers (fail closed)', async () => {
  const w = makeWorld({ files: [EXE], setup: SETUP_BROKEN, reachable: false });
  await ensureFlaresolverrRunning(w.io);
  assert.equal(w.spawns.length, 0);
  assert.deepEqual(taskkills(w), []);
  assert.equal(w.watcherArmed, 0);
  assert.equal(recoverFromHang(makeWorld({ files: [EXE], setup: SETUP_BROKEN }).io), undefined);

  // An explicit environment variable is an answer; the damaged file is not.
  const answered = makeWorld({ files: [EXE], setup: SETUP_BROKEN, env: { FLARESOLVERR_AUTO_INSTALL: '1' } });
  await ensureFlaresolverrRunning(answered.io);
  assert.equal(answered.spawns.length, 1);
});

test('answered no (or disabled) with an old exposed copy running only warns, and says exactly how to stop it', async () => {
  const w = makeWorld({ files: [EXE], setup: SETUP_SKIP, listeners: [{ pid: 55, address: '0.0.0.0' }], processes: { 55: ours() } });
  await ensureFlaresolverrRunning(w.io);
  assert.deepEqual(taskkills(w), [], 'never killed on the "no" path');
  assert.equal(w.spawns.length, 0);
  assert.equal(w.warns.length, 1);
  assert.match(w.warns[0], /flaresolverr \(PID 55\) is listening on 0\.0\.0\.0:8191/);
  assert.match(w.warns[0], /other devices on the network can reach it/);
  assert.match(w.warns[0], /taskkill \/pid 55 \/t \/f/);
  assert.match(w.warns[0], /end "flaresolverr" in Task Manager/);
  assert.match(w.warns[0], /block port 8191 in the Windows firewall/);

  const loopback = makeWorld({ files: [EXE], setup: SETUP_SKIP, listeners: [{ pid: 55, address: '127.0.0.1' }], processes: { 55: ours() } });
  await ensureFlaresolverrRunning(loopback.io);
  assert.deepEqual(loopback.warns, []);
});

test('the idle watcher and hang recovery stay inert while it is off, and arm once when it is on', async () => {
  const off = makeWorld({ files: [EXE], env: { FLARESOLVERR_DISABLED: '1' } });
  startFlaresolverrIdleWatcher(off.io);
  assert.equal(off.intervals.length, 0);

  const on = makeWorld({ files: [EXE] });
  startFlaresolverrIdleWatcher(on.io);
  assert.equal(on.intervals.length, 1);
  assert.equal(on.intervals[0].ms, 5 * 60 * 1000);
  const again = makeWorld({ files: [EXE] });
  startFlaresolverrIdleWatcher(again.io);
  assert.equal(again.intervals.length, 0, 'armed only once per run');

  const hung = makeWorld({ files: [EXE] });
  await recoverFromHang(hung.io);
  assert.equal(hung.spawns.length, 1, 'a wedged copy is recovered when FlareSolverr is on');
  const nothing = makeWorld({ files: [] });
  assert.equal(recoverFromHang(nothing.io), undefined);
  assert.deepEqual(nothing.execs, []);
});

// ── ensureFlaresolverrRunning: the exposed-copy decision ────────────────────

test('an old copy listening on every interface is restarted bound to loopback', async () => {
  const w = makeWorld({
    files: [EXE],
    reachable: true,
    env: { HOST: '0.0.0.0', PROMETHEUS_ENABLED: 'true' },
    listeners: [{ pid: 10, address: '0.0.0.0' }],
    processes: { 10: ours(EXE.toUpperCase()) },
  });
  await ensureFlaresolverrRunning(w.io);
  assert.deepEqual(taskkills(w).map((k) => k.args[1]), ['10']);
  assert.equal(w.spawns.length, 1);
  assert.equal(w.spawns[0].opts.env.HOST, '127.0.0.1');
  assert.equal(w.spawns[0].opts.env.PROMETHEUS_ENABLED, 'false');
  assert.match(w.logs.join('\n'), /Already running on 0\.0\.0\.0, reachable from the network; restarting bound to 127\.0\.0\.1 \(PID 10\)/);
  assert.deepEqual(w.warns, []);
  assert.equal(w.watcherArmed, 1);
});

test('a healthy loopback copy is left running untouched', async () => {
  const w = makeWorld({ files: [EXE], reachable: true, listeners: [{ pid: 10, address: '127.0.0.1' }], processes: { 10: ours() } });
  await ensureFlaresolverrRunning(w.io);
  assert.equal(w.spawns.length, 0);
  assert.deepEqual(taskkills(w), []);
  assert.deepEqual(w.warns, []);
});

test('an exposed listener that is not this app\'s FlareSolverr is reported, never killed', async () => {
  const w = makeWorld({
    files: [EXE],
    reachable: true,
    listeners: [{ pid: 20, address: '[::]' }],
    processes: { 20: { name: 'com.docker.backend.exe', path: 'C:\\Docker\\com.docker.backend.exe' } },
  });
  await ensureFlaresolverrRunning(w.io);
  assert.deepEqual(taskkills(w), []);
  assert.equal(w.spawns.length, 0);
  assert.match(w.warns.join('\n'), /com\.docker\.backend \(PID 20\) is listening on \[::\]:8191/);
});

test('a wildcard listener behind a loopback one is not missed', async () => {
  const w = makeWorld({
    files: [EXE],
    reachable: true,
    listeners: [{ pid: 10, address: '127.0.0.1' }, { pid: 30, address: '0.0.0.0' }],
    processes: { 10: ours(), 30: { name: 'python.exe', path: 'C:\\Python312\\python.exe' } },
  });
  await ensureFlaresolverrRunning(w.io);
  assert.deepEqual(taskkills(w), []);
  assert.match(w.warns.join('\n'), /python \(PID 30\) is listening on 0\.0\.0\.0:8191/);
});

test('an environment path that names a missing file means nothing to manage, not a fallback to another copy', async () => {
  const w = makeWorld({ files: [EXE], env: { FLARESOLVERR_EXE_PATH: path.resolve('/nowhere/flaresolverr.exe') } });
  const lines = [];
  await ensureFlaresolverrRunning({ ...w.io, warn: (m) => lines.push(m), log: (m) => w.logs.push(m) });
  assert.equal(w.spawns.length, 0);
  assert.equal(w.downloads, 0);
  assert.match(lines.join('\n'), /FLARESOLVERR_EXE_PATH points to .*which does not exist/);
});

// ── isManaged: is the app expected to be running FlareSolverr? ──────────────
// System Health reads this to tell "off by choice" from "down". Read-only: the
// fake machine must see no process, download or spawn.

function managed(options) {
  const w = makeWorld(options);
  const answer = isManaged(w.io);
  assert.deepEqual(w.execs, [], 'asking never runs a command');
  assert.equal(w.spawns.length, 0);
  assert.equal(w.downloads, 0);
  return answer;
}

test('isManaged is false whenever the user switched FlareSolverr off, installed or not', () => {
  // FLARESOLVERR_DISABLED, a saved "skip", an unreadable setup.json: each wins over an existing install.
  assert.equal(managed({ files: [EXE], env: { FLARESOLVERR_DISABLED: '1' } }), false);
  assert.equal(managed({ files: [EXE], setup: SETUP_SKIP }), false);
  assert.equal(managed({ files: [EXE], setup: SETUP_BROKEN }), false);
  // ...and DISABLED wins over a "yes" too.
  assert.equal(managed({ files: [EXE], setup: SETUP_INSTALL, env: { FLARESOLVERR_DISABLED: '1', FLARESOLVERR_AUTO_INSTALL: '1' } }), false);
});

test('isManaged is false when nothing is installed and nothing was asked for', () => {
  assert.equal(managed({}), false);
  assert.equal(managed({ setup: SETUP_NONE }), false);
  assert.equal(managed({ setup: SETUP_BROKEN }), false);
});

test('isManaged is true for an installed copy, whether or not the question was ever answered', () => {
  assert.equal(managed({ files: [EXE] }), true);
  assert.equal(managed({ files: [EXE], setup: SETUP_INSTALL }), true);
  // An explicit environment answer overrides a damaged file.
  assert.equal(managed({ files: [EXE], setup: SETUP_BROKEN, env: { FLARESOLVERR_AUTO_INSTALL: '1' } }), true);
});

test('isManaged is true when the user said yes but the download has not finished or failed', () => {
  assert.equal(managed({ setup: SETUP_INSTALL }), true);
  assert.equal(managed({ env: { FLARESOLVERR_AUTO_INSTALL: '1' } }), true);
});

test('isManaged follows the launcher: its copy counts only when the file is there', () => {
  const launcherExe = path.resolve('/staged/flaresolverr.exe');
  assert.equal(managed({ files: [launcherExe], env: { FLARESOLVERR_EXE_PATH: launcherExe }, setup: SETUP_SKIP }), true);
  assert.equal(managed({ files: [EXE], env: { FLARESOLVERR_EXE_PATH: launcherExe } }), false);
});

// ── netstat is read by column structure, in any language ────────────────────

test('netstat rows are recognised by their shape, not by the English word LISTENING', () => {
  const text = [
    'Aktive Verbindungen',
    '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
    '  TCP    0.0.0.0:8191           0.0.0.0:0              ABHÖREN         1111',
    '  TCP    [::]:8191              [::]:0                 ABHÖREN         2222',
    "  TCP    127.0.0.1:8191         0.0.0.0:0              À L'ÉCOUTE      3333",
    '  TCP    192.168.1.5:8191       0.0.0.0:0              OUVINDO         4444',
    '  TCP    127.0.0.1:8191         127.0.0.1:50000        ESTABLISHED     5555',
    '  TCP    0.0.0.0:81910          0.0.0.0:0              LISTENING       6666',
    '  TCP    0.0.0.0:18191          0.0.0.0:0              LISTENING       7777',
    '  UDP    0.0.0.0:8191           *:*                                    8888',
    '  TCP    0.0.0.0:8191           0.0.0.0:0              LISTENING       0',
    '  TCP    0.0.0.0:8191           0.0.0.0:0              LISTENING       1111',
    '',
  ].join('\r\n');
  assert.deepEqual(parseNetstatListeners(text, 8191), [
    { pid: 1111, address: '0.0.0.0' },
    { pid: 2222, address: '[::]' },
    { pid: 3333, address: '127.0.0.1' },
    { pid: 4444, address: '192.168.1.5' },
  ]);
  assert.deepEqual(parseNetstatListeners('', 8191), []);
  assert.deepEqual(parseNetstatListeners(undefined, 8191), []);
  assert.deepEqual(parseNetstatListeners('  TCP    0.0.0.0:8191   0.0.0.0:0   LISTENING   9', '8191'), [{ pid: 9, address: '0.0.0.0' }]);
});

// ── The PowerShell this module writes is real PowerShell ────────────────────
// One Windows PowerShell run (it is slow to start) that parses every script the
// module builds - nothing in them runs - then runs the two cleanup scripts
// against stubbed Get-CimInstance / Stop-Process / taskkill, so no real process
// is looked at or touched (the process ids are far outside what Windows hands
// out), and finally runs the real download and extract scripts between local
// files, with an install folder full of quotes and brackets: no network, but the
// real cmdlets and the real path handling.

// Replaces the three commands the cleanup scripts use, and refuses to go on
// unless the stubs really shadow the real ones.
const PS_STUBS = [
  '$global:killed = @();',
  'function Get-CimInstance { [CmdletBinding()] param([Parameter(Position=0)]$ClassName, $Filter) $wanted = \'\'; if ($Filter -match "Name=\'([^\']+)\'") { $wanted = $Matches[1] }; $list = $env:SS_FAKE | ConvertFrom-Json; $list | Where-Object { $_.Name -eq $wanted } };',
  'function Stop-Process { [CmdletBinding()] param($Id, [switch]$Force) $global:killed += $Id };',
  'function taskkill.exe { $global:killed += $args[1] };',
  "foreach ($n in 'Get-CimInstance','Stop-Process','taskkill.exe') { if ((Get-Command $n).CommandType -ne 'Function') { throw 'stub does not shadow ' + $n } };",
].join(' ');

const PS_HARNESS = [
  PS_STUBS,
  // The "release" the download script fetches: a local zip holding flaresolverr\flaresolverr.exe.
  'if ($env:SS_SRC) { Compress-Archive -LiteralPath $env:SS_SRC -DestinationPath $env:SS_SRCZIP };',
  '$cases = $env:SS_CASES | ConvertFrom-Json;',
  'foreach ($s in $cases.scripts) { $t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($s, [ref]$t, [ref]$e); '
    + 'if ($e.Count) { "PARSE ERR " + (($e | ForEach-Object { $_.Message }) -join " / ") } else { "PARSE OK" } };',
  'foreach ($c in $cases.runs) { foreach ($p in $c.env.PSObject.Properties) { Set-Item ("env:" + $p.Name) $p.Value }; '
    + '$env:SS_FAKE = $c.fake; $global:killed = @(); Invoke-Expression $c.script; "RUN " + $c.name + " " + ($global:killed -join ",") }',
].join(' ');

const onlySsVars = (env) => Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('SS_')));

test('the PowerShell scripts parse, and the cleanups stop only processes under FlareSolverr\'s own folders', async (t) => {
  if (process.platform !== 'win32') return t.skip('needs Windows PowerShell');

  const restarted = makeWorld({ files: [EXE], env: { APPDATA }, listeners: [{ pid: 10, address: '127.0.0.1' }], processes: { 10: ours() } });
  await restartFlaresolverr(EXE, '8191', 'x', restarted.io);
  const installed = makeWorld({ setup: SETUP_INSTALL });
  await installFlaresolverr(installed.io);
  const scripts = [...restarted.scripts, ...installed.scripts];
  assert.ok(scripts.length >= 7, `expected the whole set of scripts, got ${scripts.length}`);

  // The cleanups, with Windows-style paths so the comparison is the real one.
  const windows = makeWorld({ files: [EXE], env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, toolsDir: 'C:\\app\\tools' });
  await restartFlaresolverr(EXE, '8191', 'x', windows.io);
  const [driver, sweep] = ['SS_ROOTS', 'SS_DIR'].map((marker) => windows.execs.find((e) => e.script && e.script.includes(marker)));
  const runs = [
    {
      name: 'driver',
      script: driver.script,
      env: onlySsVars(driver.env),
      fake: JSON.stringify([
        { Name: 'chromedriver.exe', ProcessId: 3999999001, ExecutablePath: 'C:\\Users\\x\\AppData\\Roaming\\undetected_chromedriver\\chromedriver.exe' },
        { Name: 'chromedriver.exe', ProcessId: 3999999002, ExecutablePath: 'C:\\APP\\TOOLS\\FLARESOLVERR\\_internal\\chromedriver.exe' },
        { Name: 'chromedriver.exe', ProcessId: 3999999003, ExecutablePath: 'C:\\Selenium\\chromedriver.exe' },
        { Name: 'chromedriver.exe', ProcessId: 3999999004, ExecutablePath: 'C:\\app\\tools\\flaresolverr2\\chromedriver.exe' },
        { Name: 'chromedriver.exe', ProcessId: 3999999005, ExecutablePath: null },
        { Name: 'chrome.exe', ProcessId: 3999999006, ExecutablePath: 'C:\\app\\tools\\flaresolverr\\_internal\\chrome\\chrome.exe' },
      ]),
    },
    {
      name: 'sweep',
      script: sweep.script,
      env: onlySsVars(sweep.env),
      fake: JSON.stringify([
        { Name: 'chrome.exe', ProcessId: 3999999101, ExecutablePath: 'C:\\app\\tools\\flaresolverr\\_internal\\chrome\\chrome.exe' },
        { Name: 'chrome.exe', ProcessId: 3999999102, ExecutablePath: 'c:\\APP\\tools\\FlareSolverr\\_internal\\chrome\\chrome.exe' },
        { Name: 'chrome.exe', ProcessId: 3999999103, ExecutablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
        { Name: 'chrome.exe', ProcessId: 3999999104, ExecutablePath: null },
        { Name: 'chromedriver.exe', ProcessId: 3999999105, ExecutablePath: 'C:\\app\\tools\\flaresolverr\\_internal\\chrome\\chromedriver.exe' },
      ]),
    },
  ];

  // The download and extract scripts exactly as the installer sends them, run between
  // local files in a folder that would break every quoting scheme and, for
  // Invoke-WebRequest -OutFile, the wildcard parser too.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-ps-'));
  try {
    const home = path.join(sandbox, "O'Brien [v3] 1.0 ‘A’ ‚B‛ $(calc) AB");
    const source = path.join(sandbox, 'release', 'flaresolverr');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'flaresolverr.exe'), 'stub');
    fs.mkdirSync(home, { recursive: true });
    const zip = path.join(home, 'flaresolverr.zip');
    const extracted = path.join(home, 'fs_temp');
    const download = installed.execs.find((e) => e.script && e.script.includes('DownloadFile'));
    const extract = installed.execs.find((e) => e.script && e.script.includes('Expand-Archive'));
    runs.push(
      { name: 'download', script: download.script, env: { SS_URL: `file:///${path.join(sandbox, 'release.zip').replace(/\\/g, '/')}`, SS_OUT: zip }, fake: '[]' },
      { name: 'extract', script: extract.script, env: { SS_ZIP: zip, SS_DEST: extracted }, fake: '[]' },
    );

    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_HARNESS], {
      encoding: 'utf8',
      env: {
        ...process.env,
        SS_SRC: source,
        SS_SRCZIP: path.join(sandbox, 'release.zip'),
        SS_CASES: JSON.stringify({ scripts: [...scripts, driver.script, sweep.script], runs }),
      },
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const lines = result.stdout.trim().split(/\r?\n/).map((line) => line.trimEnd());
    const parseCount = scripts.length + 2;
    assert.deepEqual(lines.slice(0, parseCount), Array(parseCount).fill('PARSE OK'), `a script failed to parse:\n${lines.join('\n')}`);
    assert.deepEqual(lines.slice(parseCount), [
      'RUN driver 3999999001,3999999002',
      'RUN sweep 3999999101,3999999102',
      'RUN download',
      'RUN extract',
    ]);
    assert.ok(fs.existsSync(zip), 'the zip landed in the hostile folder');
    assert.ok(fs.existsSync(path.join(extracted, 'flaresolverr', 'flaresolverr.exe')), 'and was extracted there');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

// ── Restart notifications ───────────────────────────────────────────────────
// The solver pool holds browser sessions inside FlareSolverr's process, so it is
// told when that process is about to be replaced ('begin') and when the new one
// is up or has failed to come up ('end'). The registry is module-wide, not part
// of `io`, so every test that listens unsubscribes when it ends: a listener left
// behind would hear the restarts of the tests that follow.

// Every event in order, plus what the fake machine had done by the time each one
// arrived, so "begin comes before the kill and the spawn" can be asserted.
function watchRestarts(t, w) {
  const events = [];
  const snapshots = [];
  const unsubscribe = registerRestartListener((event) => {
    events.push(event);
    snapshots.push({ execs: w.execs.length, kills: taskkills(w).length, spawns: w.spawns.length });
  });
  t.after(unsubscribe);
  return { events, snapshots };
}

// The brake of the recoveries counts in the module, which every test of this file shares: each starts with none counted.
beforeEach(() => resetRecoveryBrake());

const netstats = (w) => w.execs.filter((e) => e.file === 'netstat').length;
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('a restart tells its listeners when it begins and when it is over, in that order and once each', async (t) => {
  const w = makeWorld({ files: [EXE], listeners: [{ pid: 10, address: '127.0.0.1' }], processes: { 10: ours() } });
  const { events, snapshots } = watchRestarts(t, w);
  await restartFlaresolverr(EXE, '8191', 'Appears wedged', w.io);

  assert.deepEqual(events, [{ phase: 'begin', reason: 'Appears wedged' }, { phase: 'end', ok: true }]);
  // 'begin' arrives after the port was inspected but before anything is killed or started...
  assert.ok(netstats(w) >= 1 && snapshots[0].execs >= 2, 'the port and its owner were looked at first');
  assert.equal(snapshots[0].kills, 0);
  assert.equal(snapshots[0].spawns, 0);
  // ...and 'end' only once the new copy is spawned and answering.
  assert.equal(snapshots[1].kills, 1);
  assert.equal(snapshots[1].spawns, 1);
});

test('a first launch with nothing on the port is a restart too: begin once, then end', async (t) => {
  const w = makeWorld({ files: [EXE] });
  const { events, snapshots } = watchRestarts(t, w);
  await restartFlaresolverr(EXE, '8191', 'Not reachable at startup', w.io);

  assert.deepEqual(events, [{ phase: 'begin', reason: 'Not reachable at startup' }, { phase: 'end', ok: true }]);
  assert.equal(snapshots[0].execs, 1, 'only the look at the port came before it');
  assert.equal(snapshots[0].spawns, 0);
});

test('nothing is announced when the restart stops at one of its checks', async (t) => {
  const cases = {
    'switched off': { env: { FLARESOLVERR_DISABLED: '1' }, listeners: [{ pid: 10, address: '127.0.0.1' }], processes: { 10: ours() } },
    'exe missing': { files: [] },
    'port held by another program': { listeners: [{ pid: 77, address: '0.0.0.0' }], processes: { 77: { name: 'python.exe', path: 'C:\\Python312\\python.exe' } } },
    'owner could not be read': { listeners: [{ pid: 77, address: '127.0.0.1' }], processes: { 77: 'timeout' } },
    'a different FlareSolverr': { listeners: [{ pid: 55, address: '127.0.0.1' }], processes: { 55: ours('D:\\elsewhere\\flaresolverr\\flaresolverr.exe') } },
    'one foreign owner among ours': { listeners: [{ pid: 10, address: '127.0.0.1' }, { pid: 20, address: '0.0.0.0' }], processes: { 10: ours(), 20: { name: 'node.exe', path: 'C:\\node\\node.exe' } } },
  };
  for (const [label, options] of Object.entries(cases)) {
    const w = makeWorld({ files: [EXE], ...options });
    const { events } = watchRestarts(t, w);
    await restartFlaresolverr(EXE, '8191', 'wedged', w.io);
    assert.deepEqual(events, [], label);
    assert.equal(w.spawns.length, 0, label);
    assert.deepEqual(taskkills(w), [], label);
  }
});

test('begin comes after the foreign-owner check, never before it', async (t) => {
  // The check really ran (the port was read, the owner looked up) and found a
  // blocker; had 'begin' been sent first, the pool would have paused for a
  // restart that never happened.
  const w = makeWorld({ files: [EXE], listeners: [{ pid: 77, address: '0.0.0.0' }], processes: { 77: { name: 'python.exe', path: 'C:\\Python312\\python.exe' } } });
  const { events } = watchRestarts(t, w);
  await restartFlaresolverr(EXE, '8191', 'wedged', w.io);
  assert.ok(netstats(w) >= 1 && w.execs.some((e) => e.script && e.script.includes('$p.ExecutablePath')), 'the owner was inspected');
  assert.match(w.warns.join('\n'), /python \(PID 77\), not FlareSolverr/);
  assert.deepEqual(events, []);
});

test('a spawn that throws still ends the restart, with ok false', async (t) => {
  const w = makeWorld({ files: [EXE], spawnThrows: 'EACCES' });
  const { events } = watchRestarts(t, w);
  await restartFlaresolverr(EXE, '8191', 'x', w.io);
  assert.match(w.warns.join('\n'), /Could not start .*EACCES/);
  assert.deepEqual(events, [{ phase: 'begin', reason: 'x' }, { phase: 'end', ok: false }]);
});

test('a copy that never comes back up ends the restart with ok false after the whole poll', async (t) => {
  const w = makeWorld({ files: [EXE], spawnedBinds: null });
  const { events } = watchRestarts(t, w);
  await restartFlaresolverr(EXE, '8191', 'x', w.io);
  assert.equal(netstats(w), 1 + 10, 'one look before, then the ten polls');
  assert.match(w.warns.join('\n'), /did not come back up on port 8191/);
  assert.deepEqual(events, [{ phase: 'begin', reason: 'x' }, { phase: 'end', ok: false }]);
});

test('a copy that comes up reachable from the network still counts as up', async (t) => {
  const w = makeWorld({ files: [EXE], spawnedBinds: '0.0.0.0' });
  const { events } = watchRestarts(t, w);
  await restartFlaresolverr(EXE, '8191', 'x', w.io);
  assert.match(w.warns.join('\n'), /still listening on 0\.0\.0\.0:8191/);
  assert.deepEqual(events, [{ phase: 'begin', reason: 'x' }, { phase: 'end', ok: true }]);
});

test('a step that throws in the middle still ends the restart, and the error still reaches the caller', async (t) => {
  const w = makeWorld({ files: [EXE], listeners: [{ pid: 10, address: '127.0.0.1' }], processes: { 10: ours() } });
  const { events } = watchRestarts(t, w);
  const exec = w.io.exec;
  w.io.exec = async (file, args, opts) => {
    if (file === 'taskkill') throw new Error('taskkill exploded');
    return exec(file, args, opts);
  };
  await assert.rejects(restartFlaresolverr(EXE, '8191', 'wedged', w.io), /taskkill exploded/);
  assert.equal(w.spawns.length, 0);
  assert.deepEqual(events, [{ phase: 'begin', reason: 'wedged' }, { phase: 'end', ok: false }]);
});

test('a listener that throws, or rejects, neither breaks the restart nor hides it from the others', async (t) => {
  const w = makeWorld({ files: [EXE] });
  t.after(registerRestartListener(() => { throw new Error('sync boom'); }));
  t.after(registerRestartListener(async () => { throw new Error('async boom'); }));
  const { events } = watchRestarts(t, w);
  await restartFlaresolverr(EXE, '8191', 'x', w.io);
  await flush();

  assert.equal(w.spawns.length, 1, 'the restart went through');
  assert.deepEqual(events.map((e) => e.phase), ['begin', 'end'], 'the listener after the broken ones still heard both');
  const warned = w.warns.join('\n');
  assert.match(warned, /restart listener failed on 'begin': sync boom/);
  assert.match(warned, /restart listener failed on 'end': sync boom/);
  assert.match(warned, /restart listener failed on 'begin': async boom/);
  assert.match(warned, /restart listener failed on 'end': async boom/);
});

test('every listener is handed its own copy of the event', async (t) => {
  const w = makeWorld({ files: [EXE] });
  t.after(registerRestartListener((event) => { event.reason = 'tampered'; event.extra = true; }));
  const { events } = watchRestarts(t, w);
  await restartFlaresolverr(EXE, '8191', 'original', w.io);
  assert.deepEqual(events, [{ phase: 'begin', reason: 'original' }, { phase: 'end', ok: true }]);
});

test('unsubscribing stops the events for that listener only, and doing it twice is harmless', async (t) => {
  const w = makeWorld({ files: [EXE] });
  const first = [];
  const unsubscribeFirst = registerRestartListener((event) => first.push(event.phase));
  t.after(unsubscribeFirst);
  const { events } = watchRestarts(t, w);

  unsubscribeFirst();
  unsubscribeFirst();
  await restartFlaresolverr(EXE, '8191', 'x', w.io);
  assert.deepEqual(first, []);
  assert.deepEqual(events.map((e) => e.phase), ['begin', 'end']);
});

test('the same function registered twice is two registrations, each with its own unsubscribe', async (t) => {
  const w = makeWorld({ files: [EXE] });
  const heard = [];
  const listener = (event) => heard.push(event.phase);
  const unsubscribeA = registerRestartListener(listener);
  const unsubscribeB = registerRestartListener(listener);
  t.after(unsubscribeA);
  t.after(unsubscribeB);

  await restartFlaresolverr(EXE, '8191', 'x', w.io);
  assert.deepEqual(heard, ['begin', 'begin', 'end', 'end']);

  unsubscribeA();
  heard.length = 0;
  await restartFlaresolverr(EXE, '8191', 'x', makeWorld({ files: [EXE] }).io);
  assert.deepEqual(heard, ['begin', 'end'], 'the other registration is still in place');
});

test('a listener that unsubscribes while it is being called does not make the next one miss the event', async (t) => {
  const w = makeWorld({ files: [EXE] });
  const unsubscribeSelf = registerRestartListener(() => unsubscribeSelf());
  t.after(unsubscribeSelf);
  const { events } = watchRestarts(t, w);
  await restartFlaresolverr(EXE, '8191', 'x', w.io);
  assert.deepEqual(events.map((e) => e.phase), ['begin', 'end']);
});

test('a listener registered while an event is being delivered hears the next event, not that one', async (t) => {
  const w = makeWorld({ files: [EXE] });
  const late = [];
  let added = false;
  t.after(registerRestartListener(() => {
    if (added) return;
    added = true;
    t.after(registerRestartListener((event) => late.push(event.phase)));
  }));
  await restartFlaresolverr(EXE, '8191', 'x', w.io);
  assert.deepEqual(late, ['end'], 'and a listener that keeps registering more cannot make the delivery loop');
});

test('only a function can be registered as a restart listener', () => {
  for (const bad of [undefined, null, 'listener', 42, {}, []]) {
    assert.throws(() => registerRestartListener(bad), TypeError, String(bad));
  }
});

test('hang recovery and the startup check announce their restart like any other', async (t) => {
  const hung = makeWorld({ files: [EXE] });
  const hungEvents = watchRestarts(t, hung).events;
  await recoverFromHang(hung.io);
  assert.deepEqual(hungEvents.map((e) => e.phase), ['begin', 'end']);
  assert.match(hungEvents[0].reason, /Appears wedged/);

  const cold = makeWorld({ files: [EXE], reachable: false });
  const coldEvents = watchRestarts(t, cold).events;
  await ensureFlaresolverrRunning(cold.io);
  assert.deepEqual(coldEvents.map((e) => e.phase), ['begin', 'end']);
  assert.match(coldEvents[0].reason, /Not reachable at startup/);

  // And a healthy copy that is left alone announces nothing.
  const healthy = makeWorld({ files: [EXE], reachable: true, listeners: [{ pid: 10, address: '127.0.0.1' }], processes: { 10: ours() } });
  const healthyEvents = watchRestarts(t, healthy).events;
  await ensureFlaresolverrRunning(healthy.io);
  assert.deepEqual(healthyEvents, []);
});

// The idle watcher's restarts (checkFlaresolverrIdle, and how it shares a restart with hang recovery) are
// tested in review-fix-e-lifecycle-idle.test.js: they depend on state the module keeps between calls.

// ── The brake on the restarts the app starts by itself ───────────────────────

// The brake reads the clock when it is asked, so a test can move it.
function withClock(t, start) {
  const clock = { now: start };
  t.mock.method(Date, 'now', () => clock.now);
  return clock;
}

test('a hang that is reported again right after a restart is not restarted a second time', async (t) => {
  withClock(t, 1_000_000);
  const w = makeWorld({ files: [EXE] });
  const { events } = watchRestarts(t, w);
  await recoverFromHang(w.io);
  await recoverFromHang(w.io); // the timeout of a call that was already in flight when the first restart finished
  assert.deepEqual(events.map((e) => e.phase), ['begin', 'end'], 'one restart, not two');
  assert.equal(getRecoveryStatus().restarts, 1);
  assert.deepEqual(w.warns.filter((m) => /not restarting it again/.test(m)), [], 'a restart that has just finished is normal and says nothing');
});

test('the fourth hang inside the window is not restarted, and the console hears of the pause once', async (t) => {
  const clock = withClock(t, 1_000_000);
  const w = makeWorld({ files: [EXE] });
  const { events } = watchRestarts(t, w);
  for (let i = 0; i < 3; i += 1) {
    await recoverFromHang(w.io);
    clock.now += 60_000;
  }
  assert.equal(events.filter((e) => e.phase === 'begin').length, 3);
  await recoverFromHang(w.io);
  clock.now += 60_000;
  await recoverFromHang(w.io);
  assert.equal(events.filter((e) => e.phase === 'begin').length, 3, 'no fourth restart');
  assert.equal(w.warns.filter((m) => /not restarting it again for \d+ min/.test(m)).length, 1, 'said once for the pause');
  assert.equal(getRecoveryStatus().paused, true);
});

test('once the oldest restart has aged out of the window the app may restart it again', async (t) => {
  const clock = withClock(t, 1_000_000);
  const w = makeWorld({ files: [EXE] });
  const { events } = watchRestarts(t, w);
  for (let i = 0; i < 3; i += 1) {
    await recoverFromHang(w.io);
    clock.now += 60_000;
  }
  clock.now += 15 * 60_000;
  await recoverFromHang(w.io);
  assert.equal(events.filter((e) => e.phase === 'begin').length, 4);
  assert.equal(getRecoveryStatus().paused, false);
});

test('the start-up check and the idle restart are not braked: they happen once and on purpose', async (t) => {
  withClock(t, 1_000_000);
  const w = makeWorld({ files: [EXE], reachable: false });
  const { events } = watchRestarts(t, w);
  await recoverFromHang(w.io);
  await ensureFlaresolverrRunning(w.io);
  assert.equal(events.filter((e) => e.phase === 'begin').length, 2, 'the start-up restart goes ahead right behind a recovery');
});
