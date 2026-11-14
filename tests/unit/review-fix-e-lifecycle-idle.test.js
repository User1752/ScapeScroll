'use strict';

// The idle watcher's restart. checkFlaresolverrIdle restarts with the exe path and the port the
// lifecycle learned at startup (startFlaresolverrIdleWatcher), not with anything in the `io` it is
// handed, so a test that does not set that up itself only passes after another test happened to.
// Every test here loads its own copy of the module (nothing remembered: no last use, no restart in
// flight, no exe path) and arms it the way server.js does before it runs the idle check, so the
// tests pass in any order and alone with --test-name-pattern.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const LIFECYCLE_PATH = require.resolve('../../server/modules/network/flaresolverr-lifecycle');
const TOOLS = path.resolve('/fake-app/tools');
const EXE = path.join(TOOLS, 'flaresolverr', 'flaresolverr.exe');

function freshLifecycle() {
  delete require.cache[LIFECYCLE_PATH];
  return require(LIFECYCLE_PATH);
}

// What server.js does at startup, and the only way the lifecycle learns where FlareSolverr lives.
function arm(lifecycle, world) {
  lifecycle.startFlaresolverrIdleWatcher(world.io);
  return lifecycle;
}

// A fake machine with just enough for one restart: netstat shows the listeners, taskkill removes one,
// a spawn adds one, PowerShell says every process is our FlareSolverr. Nothing real is touched.
function makeWorld(options = {}) {
  const port = options.port || '8191';
  const w = {
    spawns: [], kills: [], warns: [],
    listeners: (options.listeners || []).map((l) => ({ ...l })),
    files: new Set(options.files || []),
  };
  const netstat = () => [
    '  Proto  Local Address          Foreign Address        State           PID',
    ...w.listeners.map((l) => `  TCP    ${l.address}:${port}     0.0.0.0:0     LISTENING       ${l.pid}`),
  ].join('\r\n');
  w.io = {
    env: options.env || {},
    platform: 'win32',
    fs: { existsSync: (p) => w.files.has(p) },
    exec: async (file, args) => {
      const ok = (stdout = '') => ({ error: null, stdout, stderr: '' });
      if (file === 'netstat') return ok(netstat());
      if (file === 'taskkill') {
        const pid = Number(args[1]);
        w.kills.push(pid);
        w.listeners = w.listeners.filter((l) => l.pid !== pid);
        return ok();
      }
      return ok(args[args.length - 1].includes('$p.ExecutablePath') ? `flaresolverr.exe\r\n${EXE}` : '');
    },
    spawn: (file, args, opts) => {
      w.spawns.push({ file, env: opts.env });
      if (options.spawnThrows) throw new Error(options.spawnThrows);
      w.listeners.push({ pid: 900 + w.spawns.length, address: '127.0.0.1' });
      return { unref() {}, on() {} };
    },
    sleep: async () => {},
    probe: async () => false,
    setInterval: () => {},
    toolsDir: TOOLS,
    setup: () => ({ status: 'missing', data: {}, choice: null }),
    log: () => {},
    warn: (message) => w.warns.push(message),
  };
  return w;
}

// A machine whose clock is a gate: every sleep waits until the test lets it go, which keeps a restart "in flight".
function gatedWorld(options) {
  const w = makeWorld(options);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  w.io.sleep = () => gate;
  return { w, open: release };
}

// Every restart event the lifecycle announces, until the test ends (the listener registry is module-wide).
function watchRestarts(t, lifecycle) {
  const events = [];
  t.after(lifecycle.registerRestartListener((event) => events.push(event)));
  return events;
}

const phases = (events) => events.map((event) => event.phase);
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('an idle restart launches the exe and port the watcher was armed with', async () => {
  const w = makeWorld({ files: [EXE], env: { FLARESOLVERR_PORT: '8200' }, port: '8200' });
  const lifecycle = arm(freshLifecycle(), w);
  lifecycle.noteFlaresolverrUsed();
  await lifecycle.checkFlaresolverrIdle(w.io, 0);
  assert.equal(w.spawns.length, 1);
  assert.equal(w.spawns[0].file, EXE);
  assert.equal(w.spawns[0].env.PORT, '8200');
});

test('an idle restart that arrives while a hang recovery is restarting shares it: one kill, one spawn, begin and end once', async (t) => {
  const lifecycle = freshLifecycle();
  const { w, open } = gatedWorld({ files: [EXE], listeners: [{ pid: 10, address: '127.0.0.1' }] });
  const events = watchRestarts(t, lifecycle);

  const recovering = lifecycle.recoverFromHang(w.io);
  await flush();
  lifecycle.noteFlaresolverrUsed();
  const idle = lifecycle.checkFlaresolverrIdle(w.io, 0);
  assert.equal(idle, recovering, 'the same restart, not a second one');

  open();
  await recovering;
  assert.equal(w.spawns.length, 1);
  assert.deepEqual(w.kills, [10]);
  assert.deepEqual(phases(events), ['begin', 'end']);
});

test('a hang recovery that arrives while an idle restart is restarting shares it too, and a restart that ended leaves room for the next', async (t) => {
  const lifecycle = freshLifecycle();
  const { w, open } = gatedWorld({ files: [EXE], listeners: [{ pid: 10, address: '127.0.0.1' }] });
  const events = watchRestarts(t, lifecycle);

  arm(lifecycle, w);
  lifecycle.noteFlaresolverrUsed();
  const idle = lifecycle.checkFlaresolverrIdle(w.io, 0);
  await flush();
  assert.equal(lifecycle.recoverFromHang(w.io), idle);
  open();
  await idle;
  assert.deepEqual(phases(events.splice(0)), ['begin', 'end']);

  const next = makeWorld({ files: [EXE] });
  arm(lifecycle, next);
  lifecycle.noteFlaresolverrUsed();
  await lifecycle.checkFlaresolverrIdle(next.io, 0);
  assert.deepEqual(phases(events), ['begin', 'end'], 'the guard was released when the first restart ended');
  assert.equal(next.spawns.length, 1);
});

test('the idle check does nothing for an app that was not used, not idle long enough, or switched off; and it forgets the use that triggered it', async () => {
  const unused = makeWorld({ files: [EXE] });
  const neverUsed = arm(freshLifecycle(), unused);
  assert.equal(neverUsed.checkFlaresolverrIdle(unused.io, 0), undefined, 'idle time is measured from the last use');

  const recent = makeWorld({ files: [EXE] });
  const justUsed = arm(freshLifecycle(), recent);
  justUsed.noteFlaresolverrUsed();
  assert.equal(justUsed.checkFlaresolverrIdle(recent.io, 60), undefined, 'used a moment ago');

  const off = makeWorld({ files: [EXE], env: { FLARESOLVERR_DISABLED: '1' } });
  const switchedOff = arm(freshLifecycle(), off);
  switchedOff.noteFlaresolverrUsed();
  assert.equal(switchedOff.checkFlaresolverrIdle(off.io, 0), undefined);
  assert.deepEqual(off.spawns, []);

  const on = makeWorld({ files: [EXE] });
  const lifecycle = arm(freshLifecycle(), on);
  lifecycle.noteFlaresolverrUsed();
  await lifecycle.checkFlaresolverrIdle(on.io, 0);
  assert.equal(on.spawns.length, 1);
  assert.equal(lifecycle.checkFlaresolverrIdle(on.io, 0), undefined, 'a restart does not repeat on the next tick for the same use');
});

test('a failed idle restart is reported once, not thrown, and does not keep the guard', async () => {
  const lifecycle = freshLifecycle();
  const w = makeWorld({ files: [EXE], spawnThrows: 'EACCES' });
  arm(lifecycle, w);
  lifecycle.noteFlaresolverrUsed();
  await lifecycle.checkFlaresolverrIdle(w.io, 0);
  assert.match(w.warns.join(' | '), /Could not start .*EACCES/);

  const again = makeWorld({ files: [EXE] });
  arm(lifecycle, again);
  lifecycle.noteFlaresolverrUsed();
  await lifecycle.checkFlaresolverrIdle(again.io, 0);
  assert.equal(again.spawns.length, 1);
});
