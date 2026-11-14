'use strict';

// A Suwayomi-Server on this Windows computer, set up and run by ScrollScape (the extension engine's server, for a person with no Docker and no server at home).
// "Install and use": one confirmation, and the app downloads ONE tested version, checks it against the SHA-256 GitHub lists for that file, unpacks it into a
// "Suwayomi" folder inside the ScrollScape folder, makes it listen only on this computer with a login made for it, starts it, and hands the login to the
// settings. It starts it when the app starts and stops it when the app stops, like the browser solver. It is the same layout as
// tools/windows/Setup-Suwayomi.cmd, so either can start what the other made.
//
// Everything that touches the outside is injected (the network, the process, the disk's free space) so that a test can drive the whole thing without
// downloading anything. What it never does: take an address, a path or a name from a request; run anything but the program of that one package.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const AdmZip = require('adm-zip');
const config = require('../../config/suwayomi-local');
const { readLocalConnection } = require('./local-setup');

const PASSWORD_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const failure = (message, statusCode = 500) => Object.assign(new Error(message), { statusCode });

/** The places of everything the setup makes, all inside one folder. */
function layoutOf(userRoot) {
  const root = path.join(String(userRoot), config.folderName);
  return {
    root,
    app: path.join(root, 'app'),
    data: path.join(root, 'data'),
    zip: path.join(root, 'download.zip'),
    connection: path.join(root, 'connection.json'),
    conf: path.join(root, 'data', 'server.conf'),
    startCmd: path.join(root, 'Start-Suwayomi.cmd'),
    pid: path.join(root, 'suwayomi.pid'),
  };
}

/** Only Windows on a 64-bit processor: the package is the Windows one. */
function supportOf(platform, arch) {
  if (platform !== 'win32') return { supported: false, reason: 'Setting up a server from here is only available on Windows.' };
  if (arch !== 'x64') return { supported: false, reason: 'The Suwayomi package this app installs is for 64-bit Windows.' };
  return { supported: true, reason: '' };
}

/** The Java program and the server's jar inside the unpacked package, or null when it is not a package of the layout this expects. */
function findInstall(layout) {
  let names;
  try {
    names = fs.readdirSync(layout.app, { recursive: true });
  } catch (_) {
    return null;
  }
  const norm = (name) => String(name).replace(/\\/g, '/');
  const javaw = names.map(norm).find((n) => /(^|\/)jre\/bin\/javaw\.exe$/i.test(n));
  const jar = names.map(norm).find((n) => /(^|\/)Suwayomi-Server\.jar$/i.test(n));
  return javaw && jar ? { javaw: path.join(layout.app, javaw), jar: path.join(layout.app, jar) } : null;
}

const newSecret = (length, randomBytes) => Array.from(randomBytes(length), (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');

/** The text of server.conf: this computer only, a login, and nothing that opens a window. */
function confText({ port, username, password }) {
  return [
    `server.ip = "${config.host}"`,
    `server.port = ${port}`,
    'server.authMode = "basic_auth"',
    `server.authUsername = "${username}"`,
    `server.authPassword = "${password}"`,
    'server.kcefEnabled = true',
    'server.systemTrayEnabled = false',
    'server.initialOpenInBrowserEnabled = false',
    '',
  ].join('\r\n');
}

/** Where a file of the package would land, or null when its name would leave the folder (or is not an ordinary name). */
function safeTarget(appDir, entryName) {
  const name = String(entryName).replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..') || name.includes('\0')) return null;
  const target = path.resolve(appDir, ...name.split('/').filter(Boolean));
  const relative = path.relative(appDir, target);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? target : null;
}

/**
 * @param {object} deps
 * @param {() => string} deps.userRoot   the ScrollScape folder (the one that holds the library)
 * @param {(connection: { url: string, username: string, password: string }) => Promise<void>} [deps.saveConnection]   hands the login to the settings
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(file: string, args: string[], options: object) => import('child_process').ChildProcess} [deps.spawnImpl]
 * @param {(bytes: number) => Buffer} [deps.randomBytes]
 * @param {(dir: string) => number} [deps.freeBytes]
 * @param {string} [deps.platform]
 * @param {string} [deps.arch]
 * @param {object} [deps.asset]   replaced in tests (as are the readiness wait and the two caps on the package)
 */
function createLocalServer(deps = {}) {
  const {
    userRoot,
    saveConnection = async () => {},
    fetchImpl = (...args) => fetch(...args),
    spawnImpl = (...args) => require('child_process').spawn(...args),
    randomBytes = (n) => crypto.randomBytes(n),
    freeBytes = (dir) => { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); },
    platform = process.platform,
    arch = process.arch,
    asset = config.asset,
    readyTimeoutMs = config.readyTimeoutMs,
    pollMs = 1000,
    maxEntries = config.maxEntries,
    maxUnpackedBytes = config.maxUnpackedBytes,
  } = deps;

  const layout = () => layoutOf(userRoot());
  let child = null;
  let job = null;
  let progress = { phase: 'idle', received: 0, total: asset.size, message: '' };

  const setPhase = (phase, message = '', extra = {}) => { progress = { ...progress, ...extra, phase, message }; };

  function readConnection() {
    try {
      return readLocalConnection({ file: layout().connection });
    } catch (_) {
      return null;
    }
  }

  /** Whether the server answers at its address with its login. */
  async function probe(connection) {
    if (!connection) return false;
    const auth = Buffer.from(`${connection.username}:${connection.password}`).toString('base64');
    try {
      const res = await fetchImpl(`${connection.url}/api/v1/source/list`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(config.probeTimeoutMs) });
      return res.status === 200;
    } catch (_) {
      return false;
    }
  }

  function installed() {
    const l = layout();
    return !!(findInstall(l) && fs.existsSync(l.conf) && readConnection());
  }

  async function status() {
    const support = supportOf(platform, arch);
    const base = { ...support, version: asset.tag, sizeBytes: asset.size, ...progress };
    if (!support.supported) return { ...base, installed: false, running: false };
    const isInstalled = installed();
    return { ...base, installed: isInstalled, running: isInstalled && (await probe(readConnection())) };
  }

  async function waitUntilReady(connection) {
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (await probe(connection)) return true;
      if (!child) return false;
      await new Promise((resolve) => { setTimeout(resolve, pollMs); });
    }
    return false;
  }

  /** Starts what is installed, unless it already answers. Resolves when it answers (or says why it does not). */
  async function start() {
    const support = supportOf(platform, arch);
    if (!support.supported) throw failure(support.reason, 409);
    const l = layout();
    const found = findInstall(l);
    const connection = readConnection();
    if (!found || !connection || !fs.existsSync(l.conf)) throw failure('Suwayomi is not set up on this computer yet.', 409);
    if (await probe(connection)) return { already: true };
    if (!child) {
      const args = ['--add-exports=java.desktop/sun.awt=ALL-UNNAMED', `-Dsuwayomi.tachidesk.config.server.rootDir=${l.data}`, '-jar', found.jar];
      child = spawnImpl(found.javaw, args, { cwd: l.root, windowsHide: true, stdio: 'ignore' });
      const mine = child;
      mine.once('exit', () => { if (child === mine) child = null; });
      mine.once('error', () => { if (child === mine) child = null; });
      try { fs.writeFileSync(l.pid, String(mine.pid || '')); } catch (_) { /* a missing pid file only means a stop has to go through the child */ }
    }
    if (!(await waitUntilReady(connection))) throw failure('Suwayomi did not answer in time. Its logs are in the Suwayomi folder (data\\logs).', 504);
    return { already: false };
  }

  /** Stops it: the process this app started, or one a previous run left (by the pid it wrote). */
  async function stop() {
    const l = layout();
    if (child) {
      const mine = child;
      child = null;
      try { mine.kill(); } catch (_) { /* already gone */ }
    } else {
      let pid = 0;
      try { pid = Number(fs.readFileSync(l.pid, 'utf8').trim()); } catch (_) { /* no pid file */ }
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid); } catch (_) { /* not running */ }
      }
    }
    try { fs.rmSync(l.pid, { force: true }); } catch (_) { /* nothing to remove */ }
  }

  /** Stops it at once, for the moment the app itself is closing. */
  function stopNow() {
    if (!child) return;
    const mine = child;
    child = null;
    try { mine.kill(); } catch (_) { /* already gone */ }
  }

  async function download(l, onProgress) {
    const res = await fetchImpl(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(config.downloadTimeoutMs), headers: { 'User-Agent': 'ScrollScape-setup' } });
    if (res.status !== 200 || !res.body) throw failure(`GitHub answered ${res.status} for the Suwayomi download.`, 502);
    const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 0 && declared !== asset.size) throw failure('The file GitHub offers is not the size this app expects, so it was not downloaded.', 502);
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(l.zip);
    let received = 0;
    try {
      for await (const chunk of Readable.fromWeb(res.body)) {
        received += chunk.length;
        if (received > asset.size) throw failure('The download is larger than expected: it was stopped.', 502);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((resolve) => { out.once('drain', resolve); });
        onProgress(received);
      }
    } finally {
      await new Promise((resolve) => { out.end(resolve); });
    }
    if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
      fs.rmSync(l.zip, { force: true });
      throw failure('The downloaded file is not the one GitHub lists (its SHA-256 or its size differs). It was deleted and nothing was installed.', 502);
    }
  }

  function unpack(l, onProgress) {
    fs.rmSync(l.app, { recursive: true, force: true });
    fs.mkdirSync(l.app, { recursive: true });
    const zip = new AdmZip(l.zip);
    const entries = zip.getEntries();
    if (entries.length > maxEntries) throw failure('The package has more files than a Suwayomi-Server has, so it was not unpacked.', 502);
    let total = 0;
    for (const entry of entries) total += Number(entry.header.size) || 0;
    if (total > maxUnpackedBytes) throw failure('The package unpacks to more than a Suwayomi-Server needs, so it was not unpacked.', 502);
    let done = 0;
    for (const entry of entries) {
      const target = safeTarget(l.app, entry.entryName);
      if (!target) throw failure('The package has a file with a name that would leave its folder, so nothing was unpacked.', 502);
      if (entry.isDirectory) {
        fs.mkdirSync(target, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, entry.getData());
      }
      done += 1;
      if (done % 200 === 0 || done === entries.length) onProgress(done, entries.length);
    }
  }

  async function runInstall() {
    const l = layout();
    fs.mkdirSync(l.root, { recursive: true });
    try {
      if (freeBytes(l.root) < config.minFreeBytes) throw failure('There is not enough free space here (about 1.5 GB are needed).', 507);
    } catch (err) {
      if (err && err.statusCode) throw err;
    }
    setPhase('downloading', 'Downloading Suwayomi...', { received: 0, total: asset.size });
    await download(l, (received) => { progress = { ...progress, received }; });
    setPhase('unpacking', 'Unpacking...', { received: 0, total: 0 });
    unpack(l, (done, total) => { progress = { ...progress, received: done, total }; });
    fs.rmSync(l.zip, { force: true });
    const found = findInstall(l);
    if (!found) throw failure('The package is not laid out the way this app expects (jre\\bin\\javaw.exe and Suwayomi-Server.jar), so it was not used.', 502);

    setPhase('configuring', 'Setting it up on this computer only...');
    const connection = { url: `http://${config.host}:${config.port}`, username: config.username, password: newSecret(config.passwordLength, randomBytes) };
    fs.mkdirSync(l.data, { recursive: true });
    fs.writeFileSync(l.conf, confText({ port: config.port, username: connection.username, password: connection.password }));
    fs.writeFileSync(l.connection, JSON.stringify(connection));
    // The same start file the setup script writes, so either can start what the other made.
    fs.writeFileSync(l.startCmd, `@echo off\r\nstart "" /min "${found.javaw}" --add-exports=java.desktop/sun.awt=ALL-UNNAMED "-Dsuwayomi.tachidesk.config.server.rootDir=${l.data}" -jar "${found.jar}"\r\n`);

    setPhase('starting', 'Starting Suwayomi (the first start takes a minute or two)...');
    await start();
    await saveConnection(connection);
    setPhase('done', 'Suwayomi is running and connected.');
  }

  /**
   * Begins the install and returns at once; status() says how far it is. One at a time, and only where the package runs.
   * @returns {{ started: true }}
   */
  function startInstall() {
    const support = supportOf(platform, arch);
    if (!support.supported) throw failure(support.reason, 409);
    if (job) throw failure('The setup is already running.', 409);
    if (installed()) throw failure('Suwayomi is already set up on this computer.', 409);
    job = runInstall()
      .catch((err) => { setPhase('error', String((err && err.message) || err).slice(0, 300)); })
      .finally(() => { job = null; });
    return { started: true };
  }

  /** Stops it and removes the whole folder. The folder is only ever the "Suwayomi" folder inside the ScrollScape folder. */
  async function uninstall() {
    if (job) throw failure('The setup is running: wait for it to end.', 409);
    const l = layout();
    const relative = path.relative(String(userRoot()), l.root);
    if (!path.isAbsolute(String(userRoot())) || path.basename(l.root) !== config.folderName || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw failure('That is not the Suwayomi folder of this app.', 409);
    await stop();
    try {
      // A process that was just stopped lets go of its files a moment later.
      fs.rmSync(l.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (_) {
      throw failure('Some files are still in use. Close Suwayomi (javaw.exe in the Task Manager) and try again.', 409);
    }
    progress = { phase: 'idle', received: 0, total: asset.size, message: '' };
    return { removed: true };
  }

  /** At the start of the app: start what is installed. Never throws. */
  async function autoStart() {
    try {
      if (supportOf(platform, arch).supported && installed()) await start();
    } catch (_) { /* it is started from the settings, or by hand */ }
  }

  return { status, start, stop, stopNow, startInstall, uninstall, autoStart, installed, layout };
}

module.exports = { createLocalServer, layoutOf, supportOf, findInstall, safeTarget, confText };
