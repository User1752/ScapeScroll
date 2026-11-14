'use strict';

/**
 * dependency-update.js — the "do something about it" half of
 * dependency-health.js's findings. Dev-mode only (!IS_PKG): a packaged .exe
 * has no package.json/node_modules/tools to update — its dependencies and
 * runtime are baked in at build time by pkg, not something this running
 * process could ever change from the inside. Every function here throws
 * immediately if called inside a packaged build; the route layer also
 * checks this before ever calling in, so this is belt-and-suspenders, not
 * the only guard.
 *
 * Three different update mechanisms live here, because "outdated" meant
 * three structurally different things in dependency-health.js:
 *   - npm `dependencies`      -> updateNpmDependency(): a real `npm install`
 *   - CDN-pinned frontend libs -> updatePinnedCdnLib(): a text edit to
 *     public/index.html (the version lives in the URL itself)
 *   - the Node.js runtime      -> updateNodeRuntime(): see its own big
 *     comment below — this one is genuinely dangerous and handled very
 *     differently from the other two.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { PINNED_CDN_LIBS, fetchLatestNpmVersion, fetchLatestCdnLibVersion } = require('./dependency-health');

const IS_PKG = typeof process.pkg !== 'undefined';
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');
const NETWORK_TIMEOUT_MS = 20_000;
const NPM_INSTALL_TIMEOUT_MS = 180_000;

// Deliberately strict — every version string here ends up as a shell/argv
// token (npm install pkg@X) or a URL path segment (nodejs.org/dist/vX/...).
// Rejecting anything that isn't a plain dotted-numeric (optionally
// -prerelease-tagged) version closes off injection through either path,
// regardless of where the string originated (registry response, request
// body — both are "external" as far as this check is concerned).
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function assertDevMode() {
  if (IS_PKG) {
    const err = new Error('Updates are only available when running from source, not inside a packaged build.');
    err.statusCode = 400;
    throw err;
  }
}

function assertValidVersion(version) {
  if (typeof version !== 'string' || !SEMVER_RE.test(version)) {
    const err = new Error(`Invalid version string: ${JSON.stringify(version)}`);
    err.statusCode = 400;
    throw err;
  }
}

// The version to install is ALWAYS decided here, from the npm registry — never
// taken from the request. An earlier version of this module accepted
// `latestVersion` from the POST body and only regex-checked its shape, which
// let any caller pin a runtime dependency (or a CDN-pinned frontend library)
// to an OLD, vulnerable release: a downgrade is "valid semver" too. The
// registry is also the only source the "outdated" check itself trusts, so
// this installs exactly what the panel reported as latest.
async function resolveLatestVersion(registryName, fetchLatest = () => fetchLatestNpmVersion(registryName)) {
  let latest;
  try {
    latest = await fetchLatest();
  } catch (cause) {
    const err = new Error(`Couldn't look up the latest version of ${registryName} (${cause.message}).`);
    err.statusCode = 502;
    throw err;
  }
  assertValidVersion(latest);
  return latest;
}

// Each mechanism below reads-modifies-writes shared state on disk (npm's own
// node_modules/package-lock.json; the single public/index.html file; the
// single tools/node-staged folder) — two concurrent calls to the SAME
// mechanism (e.g. two "Update" clicks before the first row's button
// disables itself, or two open System Health tabs) would race on that
// shared state. Confirmed live: two overlapping updateNodeRuntime() calls
// really did race on the same extraction folder and one died with a raw,
// confusing PowerShell "already exists" error instead of a clean message.
// A per-mechanism mutex turns that into the same clean 400-shaped error
// every other guard in this file already produces.
function makeMutex(label) {
  let busy = false;
  return async function withLock(fn) {
    if (busy) {
      const err = new Error(`${label} is already in progress — wait for it to finish before starting another.`);
      err.statusCode = 409;
      throw err;
    }
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };
}

const withNpmLock = makeMutex('An npm dependency update');
const withCdnLock = makeMutex('A CDN-pinned library update');
const withNodeRuntimeLock = makeMutex('A Node.js runtime update');

// ──────────────────────────────────────────────────────────────────────────
// npm dependencies
// ──────────────────────────────────────────────────────────────────────────

function findNpmInvocation() {
  // Whatever Node binary is running this process (tools/node/node.exe in a
  // Windows dev checkout, a system node elsewhere) ships npm right next to
  // itself — resolving relative to process.execPath works regardless of
  // which install is actually running this server, instead of hardcoding
  // tools/node specifically.
  //
  // On Windows, npm's entry point is npm.cmd, a batch-file wrapper — since
  // Node's CVE-2024-27980 fix, execFile() refuses to launch a .bat/.cmd
  // directly (throws EINVAL) unless shell:true is set, and shell:true joins
  // command+args into one unescaped string for cmd.exe to parse, which is
  // exactly the injection shape that CVE existed to close (even though
  // depName/expectedVersion are already tightly validated above, so it
  // would be safe here in practice). Sidestepping the question entirely:
  // run the real npm-cli.js — a plain .js file npm ships right next to
  // npm.cmd — through this same node.exe directly. No shell, no .cmd.
  if (process.platform === 'win32') {
    const npmCliJs = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(npmCliJs)) return { command: process.execPath, prefixArgs: [npmCliJs] };
  }
  const npmBin = path.join(path.dirname(process.execPath), 'npm');
  return { command: fs.existsSync(npmBin) ? npmBin : 'npm', prefixArgs: [] }; // fall back to whatever's on PATH
}

async function updateNpmDependency(depName) {
  return withNpmLock(() => doUpdateNpmDependency(depName));
}

async function doUpdateNpmDependency(depName) {
  assertDevMode();

  const pkgJsonPath = path.join(PROJECT_ROOT, 'package.json');
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const deps = pkgJson.dependencies || {};
  // Allow-list against this project's own declared dependencies — depName
  // becomes an argv token passed to npm install, so accepting an arbitrary
  // client-supplied string here would let a request install ANY npm
  // package under this project, not just update a known one.
  if (!Object.prototype.hasOwnProperty.call(deps, depName)) {
    const err = new Error(`"${depName}" is not one of this project's own dependencies.`);
    err.statusCode = 400;
    throw err;
  }

  const expectedVersion = await resolveLatestVersion(depName);

  const { command, prefixArgs } = findNpmInvocation();
  await execFileAsync(command, [...prefixArgs, 'install', `${depName}@${expectedVersion}`], {
    cwd: PROJECT_ROOT,
    timeout: NPM_INSTALL_TIMEOUT_MS,
    windowsHide: true,
  });

  // "the command exited 0" isn't proof npm actually landed on the version
  // asked for — a peer-dependency conflict can make it silently resolve
  // something else. Read the real installed package.json back off disk
  // (not require()'s cache, which may already hold a stale value from
  // server startup) to confirm.
  const installedPkgJsonPath = path.join(PROJECT_ROOT, 'node_modules', depName, 'package.json');
  const installed = JSON.parse(fs.readFileSync(installedPkgJsonPath, 'utf8')).version;

  const matched = installed === expectedVersion;
  return {
    depName,
    requestedVersion: expectedVersion,
    installedVersion: installed,
    matched,
    // The running server keeps the previous version in memory (require()
    // caches it for the life of the process), so a successful install only
    // takes effect after a restart — say so instead of leaving the user
    // wondering why nothing changed.
    message: matched
      ? `Installed ${depName} ${installed}. Restart the server to load it — the running process still has the previous version in memory.`
      : `npm installed ${depName} ${installed} instead of the requested ${expectedVersion} (a dependency conflict probably held it back) — check package.json. Restart the server to load it.`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// CDN-pinned frontend libraries
// ──────────────────────────────────────────────────────────────────────────

async function updatePinnedCdnLib(libId) {
  return withCdnLock(() => doUpdatePinnedCdnLib(libId));
}

async function doUpdatePinnedCdnLib(libId) {
  assertDevMode();

  const lib = PINNED_CDN_LIBS.find((l) => l.id === libId);
  if (!lib) {
    const err = new Error(`Unknown pinned library: ${libId}`);
    err.statusCode = 400;
    throw err;
  }

  const expectedVersion = await resolveLatestVersion(lib.registryName, () => fetchLatestCdnLibVersion(lib));

  const indexPath = path.join(PROJECT_ROOT, 'public', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const match = html.match(lib.pattern);
  if (!match) {
    throw new Error(`Could not find ${lib.name}'s pinned version in public/index.html — it may have moved.`);
  }

  const oldVersion = match[1];
  const updatedHtml = html.slice(0, match.index) + match[0].replace(oldVersion, expectedVersion) + html.slice(match.index + match[0].length);
  fs.writeFileSync(indexPath, updatedHtml, 'utf8');

  return {
    libId,
    name: lib.name,
    fromVersion: oldVersion,
    toVersion: expectedVersion,
    file: 'public/index.html',
    message: `Updated ${lib.name} ${oldVersion} → ${expectedVersion} in public/index.html. Hard-refresh the page (Ctrl+F5) to load it.`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Node.js runtime (tools/node) — the dangerous one
// ──────────────────────────────────────────────────────────────────────────

// Confirmed live on this project's own setup (a network-drive checkout):
// renaming/moving a directory that contains the currently-executing
// node.exe fails outright ("Access to the path ... is denied") — you
// cannot swap tools/node out from under the very process serving this
// request. So this function only ever does the safe half: download,
// checksum-verify, and extract the new build into a SEPARATE staging
// folder (tools/node-staged) — entirely safe to do from inside this
// running process, touches nothing currently in use.
//
// The actual swap (tools/node -> node-previous, node-staged -> node)
// happens in Launch-ScrollScape.bat, at the very top, before it ever
// touches tools/node/node.exe — the one guaranteed moment nothing is
// running out of that folder, so the rename needs no waiting at all. A
// detached background helper that waited for this process to exit, then
// performed the rename itself, was tried and abandoned here: confirmed
// live, a genuinely detached child process (spawn with detached:true, and
// the classic `cmd /c start /b` equivalent) doesn't reliably survive or
// run in every hosting environment this project runs under — it reported
// a real PID and then silently died without ever executing its payload,
// which is worse than not automating the swap at all (a promised update
// that silently never happens, with no error anywhere).
function isRunningPortableToolsNode() {
  if (IS_PKG || process.platform !== 'win32') return false;
  const toolsNodeExe = path.join(PROJECT_ROOT, 'tools', 'node', 'node.exe');
  return path.resolve(process.execPath).toLowerCase() === path.resolve(toolsNodeExe).toLowerCase();
}

async function downloadFile(url, destPath) {
  const res = await fetch(url, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buf);
  return buf;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function updateNodeRuntime() {
  return withNodeRuntimeLock(doUpdateNodeRuntime);
}

async function doUpdateNodeRuntime() {
  assertDevMode();
  if (process.platform !== 'win32') {
    const err = new Error('Automatic Node.js runtime updates are only supported on Windows — tools/node is a Windows-only portable copy (see GUIDELINES.md).');
    err.statusCode = 400;
    throw err;
  }
  if (!isRunningPortableToolsNode()) {
    const err = new Error('This server process is not running tools/node/node.exe, so an in-place update would not take effect for it.');
    err.statusCode = 400;
    throw err;
  }

  const indexRes = await fetch('https://nodejs.org/dist/index.json', { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) });
  if (!indexRes.ok) throw new Error(`nodejs.org HTTP ${indexRes.status}`);
  const list = await indexRes.json();
  const lts = Array.isArray(list) ? list.find((r) => r.lts) : null;
  if (!lts) throw new Error('Could not determine the latest Node.js LTS release from nodejs.org.');
  const version = String(lts.version); // e.g. "v24.20.0"

  const zipName = `node-${version}-win-x64.zip`;
  const baseUrl = `https://nodejs.org/dist/${version}/`;

  const toolsDir = path.join(PROJECT_ROOT, 'tools');
  const scratchDir = path.join(toolsDir, '.node-update-staging');
  await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(scratchDir, { recursive: true });

  try {
    const zipPath = path.join(scratchDir, zipName);
    const zipBuf = await downloadFile(`${baseUrl}${zipName}`, zipPath);
    const shasumsBuf = await downloadFile(`${baseUrl}SHASUMS256.txt`, path.join(scratchDir, 'SHASUMS256.txt'));

    const shasumsText = shasumsBuf.toString('utf8');
    const line = shasumsText.split('\n').find((l) => l.includes(zipName));
    if (!line) throw new Error(`Could not find a published checksum for ${zipName} in nodejs.org's SHASUMS256.txt.`);
    const expectedHash = line.trim().split(/\s+/)[0].toLowerCase();
    const actualHash = sha256(zipBuf);
    if (actualHash !== expectedHash) {
      throw new Error(`Checksum mismatch for ${zipName}: expected ${expectedHash}, got ${actualHash}. Aborting — refusing to install an unverified Node.js build.`);
    }

    const extractDir = path.join(scratchDir, 'extracted');
    await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    ], { windowsHide: true, timeout: 120_000 });

    const innerDir = path.join(extractDir, `node-${version}-win-x64`);
    if (!fs.existsSync(path.join(innerDir, 'node.exe'))) {
      throw new Error('Extracted Node.js archive did not contain node.exe where expected.');
    }

    const stagedDir = path.join(toolsDir, 'node-staged');
    await fsp.rm(stagedDir, { recursive: true, force: true }).catch(() => {});
    await fsp.rename(innerDir, stagedDir);

    return {
      version,
      checksumVerified: true,
      message: `Downloaded and checksum-verified Node.js ${version}. It's staged — quit the server and relaunch via Launch-ScrollScape.bat to apply it (the .bat swaps it in automatically before starting Node).`,
    };
  } finally {
    await fsp.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { updateNpmDependency, updatePinnedCdnLib, updateNodeRuntime, isRunningPortableToolsNode };
