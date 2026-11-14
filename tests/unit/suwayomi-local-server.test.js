'use strict';

// The Suwayomi-Server that ScrollScape sets up and runs on a Windows computer (server/modules/suwayomi/local-server.js). Nothing is downloaded and nothing
// is started: the network, the process and the disk's free space are replaced, and the package is a small zip made here. What matters: the file is checked
// against the SHA-256 and the size before anything is unpacked, a package that would write outside its folder (or is too big) is refused, the server is
// written to answer this computer only with a login made for it, it is started with the same layout the setup script uses, the folder removed is only
// the Suwayomi folder of the app, and only one set-up runs at a time.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const AdmZip = require('adm-zip');
const config = require('../../server/config/suwayomi-local');
const { createLocalServer, layoutOf, supportOf, findInstall, safeTarget, confText } = require('../../server/modules/suwayomi/local-server');
const { readLocalConnection } = require('../../server/modules/suwayomi/local-setup');

const GOOD_PACKAGE = { 'Suwayomi-Server-v1/jre/bin/javaw.exe': 'java', 'Suwayomi-Server-v1/bin/Suwayomi-Server.jar': 'jar' };
const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function makeZip(entries) {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(entries)) zip.addFile(name, Buffer.from(data));
  return zip.toBuffer();
}

/** A server wired to fakes: `served` is what the download answers with, `state.up` whether the fake server answers its address. */
function rig(t, over = {}) {
  const served = over.served || makeZip(GOOD_PACKAGE);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-suwayomi-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asset = { tag: 'v1', name: 'x.zip', url: 'https://example.test/x.zip', size: served.length, sha256: sha(served), ...(over.asset || {}) };
  const state = { up: false, spawned: [], saved: [], fetched: [], killed: 0 };
  const fetchImpl = async (url) => {
    state.fetched.push(url);
    if (url === asset.url) return new Response(served, { status: over.status || 200, headers: { 'content-length': String(served.length) } });
    if (String(url).endsWith('/api/v1/source/list')) {
      if (!state.up) throw new Error('ECONNREFUSED');
      return { status: 200 };
    }
    return { status: 404 };
  };
  const spawnImpl = (file, args, options) => {
    if (over.spawnThrows) throw new Error('spawn failed');
    const child = new EventEmitter();
    child.pid = 4242;
    child.kill = () => { state.killed += 1; state.up = false; child.emit('exit', 0); };
    state.spawned.push({ file, args, options });
    if (!over.neverAnswers) state.up = true;
    return child;
  };
  const make = (extra = {}) => createLocalServer({
    userRoot: () => root,
    saveConnection: async (connection) => { state.saved.push(connection); },
    fetchImpl,
    spawnImpl,
    randomBytes: (n) => Buffer.alloc(n, 7),
    freeBytes: () => over.free ?? 10 ** 12,
    platform: 'win32',
    arch: 'x64',
    asset,
    readyTimeoutMs: over.readyTimeoutMs ?? 2000,
    pollMs: 5,
    ...(over.deps || {}),
    ...extra,
  });
  return { root, state, asset, server: make(), make };
}

async function finished(server) {
  for (let i = 0; i < 500; i += 1) {
    const status = await server.status();
    if (status.phase === 'done' || status.phase === 'error') return status;
    await sleep(10);
  }
  throw new Error('the set-up did not end');
}

// ── the install ──────────────────────────────────────────────────────────

test('setting up downloads, checks, unpacks, writes a server that answers this computer only, starts it and hands the login to the settings', async (t) => {
  const { server, state, root } = rig(t);
  assert.deepEqual(server.startInstall(), { started: true });
  const status = await finished(server);
  assert.equal(status.phase, 'done', status.message);
  assert.equal(status.installed, true);
  assert.equal(status.running, true);
  const layout = layoutOf(root);
  assert.equal(layout.root, path.join(root, 'Suwayomi'), 'everything is inside one folder of the ScrollScape folder');
  const conf = fs.readFileSync(layout.conf, 'utf8');
  assert.ok(conf.includes('server.ip = "127.0.0.1"'), 'this computer only');
  assert.ok(conf.includes('server.authMode = "basic_auth"') && conf.includes(`server.authUsername = "${config.username}"`), 'with a login');
  assert.ok(conf.includes('server.kcefEnabled = true') && conf.includes('server.systemTrayEnabled = false') && conf.includes('server.initialOpenInBrowserEnabled = false'));
  const [saved] = state.saved;
  assert.equal(state.saved.length, 1);
  assert.deepEqual({ url: saved.url, username: saved.username }, { url: 'http://127.0.0.1:4567', username: 'scrollscape' });
  assert.match(saved.password, /^[A-Za-z0-9]{28}$/, 'a long login made for it');
  assert.ok(conf.includes(`server.authPassword = "${saved.password}"`), 'the same password in the server and in the settings');
  assert.deepEqual(readLocalConnection({ file: layout.connection }), saved, 'the connection file is the one the app and the script both read');
  assert.ok(!fs.existsSync(layout.zip), 'the download is removed once it is unpacked');
  const start = fs.readFileSync(layout.startCmd, 'utf8');
  assert.ok(start.includes('javaw.exe') && start.includes('-jar') && start.includes('\r\n'), 'the same start file the script writes');
  const [spawned] = state.spawned;
  assert.equal(state.spawned.length, 1);
  assert.ok(spawned.file.endsWith('javaw.exe'));
  assert.deepEqual(spawned.args.slice(0, 3), ['--add-exports=java.desktop/sun.awt=ALL-UNNAMED', `-Dsuwayomi.tachidesk.config.server.rootDir=${layout.data}`, '-jar']);
  assert.ok(spawned.args[3].endsWith('Suwayomi-Server.jar'));
  assert.equal(spawned.options.windowsHide, true);
  assert.equal(spawned.options.stdio, 'ignore');
  assert.ok(fs.existsSync(layout.pid), 'the process is written down, so a later run can stop it');
});

test('a file that is not the one GitHub lists is deleted and nothing is installed or started', async (t) => {
  const { server, state, root } = rig(t, { asset: { sha256: 'f'.repeat(64) } });
  server.startInstall();
  const status = await finished(server);
  assert.equal(status.phase, 'error');
  assert.match(status.message, /SHA-256/);
  assert.equal(status.installed, false);
  assert.ok(!fs.existsSync(layoutOf(root).zip), 'the file is deleted');
  assert.ok(!fs.existsSync(layoutOf(root).app), 'nothing was unpacked');
  assert.deepEqual([state.spawned.length, state.saved.length], [0, 0]);
});

test('a size that is not the expected one is refused before the download starts, and a longer body is stopped', async (t) => {
  const wrongSize = rig(t, { asset: { size: 5 } });
  wrongSize.server.startInstall();
  assert.match((await finished(wrongSize.server)).message, /not the size/);
  const served = makeZip(GOOD_PACKAGE);
  const longer = rig(t, { served, asset: { size: served.length - 1 }, deps: { fetchImpl: async () => new Response(served, { status: 200 }) } });
  longer.server.startInstall();
  const status = await finished(longer.server);
  assert.equal(status.phase, 'error');
  assert.match(status.message, /larger than expected/);
  const refused = rig(t, { status: 404 });
  refused.server.startInstall();
  assert.match((await finished(refused.server)).message, /answered 404/);
});

test('a package with a file that would leave its folder is refused and nothing of it is started', async (t) => {
  const buffer = makeZip({ 'xx/xx/evil.txt': 'x', ...GOOD_PACKAGE });
  const planted = Buffer.from(buffer.toString('latin1').split('xx/xx/evil.txt').join('../../evil.txt'), 'latin1');
  assert.equal(planted.length, buffer.length);
  const { server, state, root } = rig(t, { served: planted });
  server.startInstall();
  const status = await finished(server);
  assert.equal(status.phase, 'error');
  assert.match(status.message, /leave its folder/);
  assert.ok(!fs.existsSync(path.join(root, 'evil.txt')) && !fs.existsSync(path.join(path.dirname(root), 'evil.txt')));
  assert.equal(state.spawned.length, 0);
  for (const bad of ['../x', 'a/../../x', '/abs', 'C:/x', 'C:\\x', 'a\\..\\..\\x', '', 'a\0b']) assert.equal(safeTarget('/app/dir', bad), null, JSON.stringify(bad));
  assert.ok(safeTarget(path.resolve('/app/dir'), 'jre/bin/javaw.exe').endsWith(path.join('jre', 'bin', 'javaw.exe')));
});

test('a package with too many files, or that unpacks to too much, is refused before it is unpacked', async (t) => {
  const many = rig(t, { deps: { maxEntries: 1 } });
  many.server.startInstall();
  assert.match((await finished(many.server)).message, /more files/);
  const big = rig(t, { deps: { maxUnpackedBytes: 3 } });
  big.server.startInstall();
  assert.match((await finished(big.server)).message, /unpacks to more/);
  assert.ok(!fs.existsSync(path.join(many.root, 'Suwayomi', 'app', 'Suwayomi-Server-v1')), 'nothing was written');
});

test('a package that is not laid out as expected is not used', async (t) => {
  const { server, state } = rig(t, { served: makeZip({ 'readme.txt': 'hello' }) });
  server.startInstall();
  const status = await finished(server);
  assert.equal(status.phase, 'error');
  assert.match(status.message, /laid out/);
  assert.equal(state.spawned.length, 0);
});

test('not enough free space stops it before anything is downloaded', async (t) => {
  const { server, state } = rig(t, { free: 100 });
  server.startInstall();
  const status = await finished(server);
  assert.match(status.message, /free space/);
  assert.equal(state.fetched.length, 0);
});

test('only where the package runs, one at a time, and not over a set-up that exists', async (t) => {
  assert.deepEqual(supportOf('win32', 'x64'), { supported: true, reason: '' });
  assert.equal(supportOf('linux', 'x64').supported, false);
  assert.equal(supportOf('darwin', 'arm64').supported, false);
  assert.equal(supportOf('win32', 'arm64').supported, false);
  const other = rig(t, { deps: { platform: 'linux' } });
  assert.throws(() => other.server.startInstall(), (err) => err.statusCode === 409 && /only available on Windows/.test(err.message));
  const status = await other.server.status();
  assert.deepEqual([status.supported, status.installed, status.running], [false, false, false]);
  await assert.rejects(other.server.start(), (err) => err.statusCode === 409);
  const { server } = rig(t);
  server.startInstall();
  assert.throws(() => server.startInstall(), (err) => err.statusCode === 409 && /already running/.test(err.message));
  await assert.rejects(server.uninstall(), (err) => err.statusCode === 409, 'it is not removed while it is being set up');
  await finished(server);
  assert.throws(() => server.startInstall(), (err) => err.statusCode === 409 && /already set up/.test(err.message));
});

test('the progress is visible while it runs, and a failure leaves the sentence for the person', async (t) => {
  const { server } = rig(t, { asset: { sha256: '0'.repeat(64) } });
  assert.equal((await server.status()).phase, 'idle');
  server.startInstall();
  assert.ok(['downloading', 'unpacking', 'error'].includes((await server.status()).phase));
  const end = await finished(server);
  assert.equal(end.phase, 'error');
  assert.ok(end.message.length > 10 && end.message.length <= 300);
  assert.ok(!end.message.includes(os.tmpdir()), 'no path of the computer in the sentence');
});

// ── running it ───────────────────────────────────────────────────────────

test('start does nothing when it already answers, and says so when it does not answer in time', async (t) => {
  const { server, state, make } = rig(t);
  server.startInstall();
  await finished(server);
  assert.deepEqual(await server.start(), { already: true });
  assert.equal(state.spawned.length, 1, 'not started twice');
  const quiet = rig(t, { neverAnswers: true, readyTimeoutMs: 60 });
  quiet.server.startInstall();
  const status = await finished(quiet.server);
  assert.equal(status.phase, 'error');
  assert.match(status.message, /did not answer in time/);
  assert.ok(make);
});

test('stop ends the process this app started and removes the pid file; stopNow does it without waiting', async (t) => {
  const { server, state, root } = rig(t);
  server.startInstall();
  await finished(server);
  await server.stop();
  assert.equal(state.killed, 1);
  assert.ok(!fs.existsSync(layoutOf(root).pid));
  assert.equal((await server.status()).running, false);
  await server.start();
  server.stopNow();
  assert.equal(state.killed, 2);
  server.stopNow();
  assert.equal(state.killed, 2, 'a second call has nothing to stop');
});

test('at the start of the app what is set up is started, nothing else is, and it never throws', async (t) => {
  const none = rig(t);
  await none.server.autoStart();
  assert.equal(none.state.spawned.length, 0, 'nothing set up, nothing started');
  const first = rig(t);
  first.server.startInstall();
  await finished(first.server);
  await first.server.stop();
  const again = first.make();
  await again.autoStart();
  assert.equal(first.state.spawned.length, 2, 'a new run of the app starts it again');
  assert.equal((await again.status()).running, true);
  const broken = rig(t, { spawnThrows: true });
  fs.mkdirSync(path.dirname(layoutOf(broken.root).conf), { recursive: true });
  await assert.doesNotReject(broken.server.autoStart());
});

// ── removing it ──────────────────────────────────────────────────────────

test('removing deletes the Suwayomi folder and only that: the library next to it stays', async (t) => {
  const { server, state, root } = rig(t);
  fs.writeFileSync(path.join(root, 'library.json'), '{}');
  fs.mkdirSync(path.join(root, 'data'));
  server.startInstall();
  await finished(server);
  assert.deepEqual(await server.uninstall(), { removed: true });
  assert.equal(state.killed, 1, 'stopped first');
  assert.ok(!fs.existsSync(path.join(root, 'Suwayomi')));
  assert.ok(fs.existsSync(path.join(root, 'library.json')) && fs.existsSync(path.join(root, 'data')));
  const status = await server.status();
  assert.deepEqual([status.installed, status.running, status.phase], [false, false, 'idle']);
});

test('the folder to remove must be the Suwayomi folder inside a ScrollScape folder that is a full path, never a relative one', async (t) => {
  const relative = rig(t, { deps: { userRoot: () => 'some/relative/folder' } });
  await assert.rejects(relative.server.uninstall(), (err) => err.statusCode === 409 && /not the Suwayomi folder/.test(err.message));
  const empty = rig(t, { deps: { userRoot: () => '' } });
  await assert.rejects(empty.server.uninstall(), (err) => err.statusCode === 409);
  const mine = rig(t);
  fs.mkdirSync(path.join(mine.root, 'Suwayomi'));
  fs.writeFileSync(path.join(mine.root, 'Suwayomi', 'x'), '1');
  await mine.server.uninstall();
  assert.ok(!fs.existsSync(path.join(mine.root, 'Suwayomi')));
});

// ── what it writes, and where it is the same as the script ──────────────

test('the configuration names this computer, a login and nothing that opens a window', () => {
  const text = confText({ port: 4567, username: 'u', password: 'p' });
  assert.deepEqual(text.split('\r\n').filter(Boolean), [
    'server.ip = "127.0.0.1"', 'server.port = 4567', 'server.authMode = "basic_auth"', 'server.authUsername = "u"', 'server.authPassword = "p"',
    'server.kcefEnabled = true', 'server.systemTrayEnabled = false', 'server.initialOpenInBrowserEnabled = false',
  ]);
});

test('the program and the jar are found anywhere inside the unpacked folder, and a folder without them is not an install', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-suwayomi-find-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = layoutOf(root);
  assert.equal(findInstall(layout), null);
  fs.mkdirSync(path.join(layout.app, 'top', 'jre', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(layout.app, 'top', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(layout.app, 'top', 'jre', 'bin', 'javaw.exe'), '');
  assert.equal(findInstall(layout), null, 'the jar is missing');
  fs.writeFileSync(path.join(layout.app, 'top', 'bin', 'Suwayomi-Server.jar'), '');
  const found = findInstall(layout);
  assert.ok(found.javaw.endsWith(path.join('jre', 'bin', 'javaw.exe')) && found.jar.endsWith('Suwayomi-Server.jar'));
});

test('the app and the setup script pin the same package, the same address and the same login name', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'windows', 'Setup-Suwayomi.cmd'), 'utf8');
  for (const [label, value] of [['tag', config.asset.tag], ['sha256', config.asset.sha256], ['size', String(config.asset.size)], ['name', config.asset.name.replace(config.asset.tag, '$Tag')], ['port', String(config.port)], ['user', config.username]]) {
    assert.ok(script.includes(value), `the script has the same ${label}`);
  }
  assert.ok(config.asset.url === `https://github.com/Suwayomi/Suwayomi-Server/releases/download/${config.asset.tag}/${config.asset.name}`, 'the package is the project\'s own release');
  assert.match(config.asset.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(config) && Object.isFrozen(config.asset) && Object.isFrozen(config.blockedRanges), 'nothing can change it while the app runs');
  assert.equal(config.host, '127.0.0.1');
});
