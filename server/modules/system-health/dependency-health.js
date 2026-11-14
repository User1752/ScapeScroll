'use strict';

/**
 * dependency-health.js — "is this install running stale/outdated tooling"
 * check, on-demand (like image-quality-health.js), not run on every regular
 * health poll: every check here reaches an external registry, so it's slow
 * and rate-limit-sensitive (see GUIDELINES.md "Rate limiting for external
 * services" — same reasoning services-health.js's 20s cache follows, just
 * with a much longer TTL since these barely ever change minute-to-minute).
 *
 * Deliberately scoped to what's meaningful from INSIDE a running instance —
 * dev server or packaged .exe alike:
 *   - the Node.js runtime actually executing this process (process.version
 *     works identically whether that's tools/node's Node in dev mode or the
 *     Node build pkg embedded in the .exe)
 *   - the app's shipped npm `dependencies` (not devDependencies — eslint/
 *     playwright/pkg do real work for this repo but never run inside a
 *     shipped instance, dev or packaged, so a staleness check on them
 *     wouldn't reflect anything an end user is actually exposed to)
 *   - the CDN-pinned frontend libraries baked into public/index.html
 *   - the FlareSolverr the app talks to, when it is running (the session pool
 *     relies on how that version's sessions behave)
 * The bundled tools/node/ folder and .github/workflows/ci.yml are
 * repo-maintenance concerns with no equivalent inside a packaged .exe (no
 * .github/ or tools/ ships in it) — intentionally out of scope here; that
 * stays a manual audit task, not something this in-app check can speak to.
 */

const fs = require('fs');
const path = require('path');
const { FLARESOLVERR_RELEASES_URL, FLARESOLVERR_VERIFIED_VERSION, SOLVER_VERSION_TIMEOUT_MS, solverStatusUrl } = require('../../config/solver');

const REGISTRY_TIMEOUT_MS = 6_000;
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h — version staleness doesn't change minute to minute

const IS_PKG = typeof process.pkg !== 'undefined';
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');

// name -> how to find its pinned version string in public/index.html
const PINNED_CDN_LIBS = [
  // cdnjsName: this one is served from cdnjs, which lags npm (6.5.438 was on npm and a 404 on cdnjs): "latest" is what cdnjs has, or the update
  // would pin a version that does not exist there and the reader would not load at all.
  { id: 'pdfjs-dist', name: 'pdf.js (PDF reader)', registryName: 'pdfjs-dist', cdnjsName: 'pdf.js', pattern: /pdf\.js\/(\d+\.\d+\.\d+)\/pdf\.min\.mjs/ },
  { id: 'jszip', name: 'JSZip (EPUB reader dependency)', registryName: 'jszip', pattern: /jszip@(\d+\.\d+\.\d+)/ },
  { id: 'epubjs', name: 'epub.js (EPUB reader)', registryName: 'epubjs', pattern: /epubjs@(\d+\.\d+\.\d+)/ },
];

/** @returns {boolean} true if `a` is an older version than `b` (dotted numeric compare, ignores any -pre/-lts suffix) */
function isOlder(a, b) {
  const clean = v => String(v).replace(/^[\^~]/, '').split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
  const pa = clean(a), pb = clean(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da !== db) return da < db;
  }
  return false;
}

async function fetchLatestNpmVersion(pkgName) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkgName)}/latest`, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
  const data = await res.json();
  if (!data.version) throw new Error('registry response had no version field');
  return data.version;
}

async function fetchLatestCdnjsVersion(libName) {
  const res = await fetch(`https://api.cdnjs.com/libraries/${encodeURIComponent(libName)}?fields=version`, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`cdnjs HTTP ${res.status}`);
  const data = await res.json();
  if (!data.version) throw new Error('cdnjs response had no version field');
  return data.version;
}

// The latest version of a CDN-pinned library, from the place that actually serves it.
function fetchLatestCdnLibVersion(lib) {
  return lib.cdnjsName ? fetchLatestCdnjsVersion(lib.cdnjsName) : fetchLatestNpmVersion(lib.registryName);
}

async function fetchNodeReleases() {
  const res = await fetch('https://nodejs.org/dist/index.json', {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`nodejs.org HTTP ${res.status}`);
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) throw new Error('no releases listed');
  return list;
}

// Node's own policy: a line that has an LTS gets 12 months of Active LTS and 18 of Maintenance LTS, counted from its first LTS
// release, and then no more fixes. A line that never became LTS (an odd number) is dropped within months.
const NODE_LTS_SUPPORT_MONTHS = 30;

const nodeMajor = (version) => parseInt(String(version).replace(/^v/, ''), 10);
const bare = (version) => String(version).replace(/^v/, '');

/**
 * What the release list (nodejs.org/dist/index.json, newest first) says about the version that is running:
 *   'current'      it is the newest LTS, or newer
 *   'patch'        its own line has a newer release (a fix is out)
 *   'newer-lts'    a newer LTS line exists, and this one still gets fixes (`supportEnds` says until when)
 *   'unsupported'  this line no longer gets fixes
 * A pure function of the list and the date, so it is tested without the network.
 */
function judgeNodeRuntime(current, list, now = new Date()) {
  const latestLts = list.find((r) => r.lts);
  if (!latestLts) throw new Error('no LTS entry found');
  const latest = bare(latestLts.version);
  const major = nodeMajor(current);
  const sameLine = list.find((r) => nodeMajor(r.version) === major);
  const base = { latest, sameLine: sameLine ? bare(sameLine.version) : null, supportEnds: null };
  if (!isOlder(current, latest)) return { ...base, state: 'current' };
  if (major === nodeMajor(latest)) return { ...base, state: 'patch' };

  const firstLts = [...list].reverse().find((r) => r.lts && nodeMajor(r.version) === major);
  if (!firstLts) return { ...base, state: major < nodeMajor(latest) ? 'unsupported' : 'current' };
  const ends = new Date(firstLts.date);
  ends.setUTCMonth(ends.getUTCMonth() + NODE_LTS_SUPPORT_MONTHS);
  base.supportEnds = ends.toISOString().slice(0, 7);
  return { ...base, state: now >= ends ? 'unsupported' : 'newer-lts' };
}

// Updating the Node runtime in place only makes sense when this process IS
// the portable tools/node copy this project manages itself — a packaged
// .exe has none (its Node is baked in by pkg at build time), a non-Windows
// dev checkout has no portable copy at all (tools/node is a Windows-only
// convenience, see GUIDELINES.md's portability section), and even on
// Windows, someone running dev mode against a system-installed Node isn't
// running the file this feature would actually replace.
function isRunningPortableToolsNode() {
  if (IS_PKG || process.platform !== 'win32') return false;
  const toolsNodeExe = path.join(PROJECT_ROOT, 'tools', 'node', 'node.exe');
  return path.resolve(process.execPath).toLowerCase() === path.resolve(toolsNodeExe).toLowerCase();
}

// A newer version is a warning while this one still gets fixes: nothing is broken, an update is just available. Only a line that no
// longer gets security fixes is a failure.
function describeNodeRuntime(current, verdict, updatable) {
  const row = { id: 'node-runtime', name: 'Node.js runtime', latestVersion: verdict.latest, updatable };
  switch (verdict.state) {
    case 'patch':
      return { ...row, ok: false, severity: 'warning', error: `Running v${current} - a newer v${nodeMajor(current)} release is out (v${verdict.sameLine}); the latest LTS is v${verdict.latest}` };
    case 'newer-lts':
      return { ...row, ok: false, severity: 'warning', error: `Running v${current}, which still gets fixes until ${verdict.supportEnds} - the latest LTS is v${verdict.latest}` };
    case 'unsupported':
      return { ...row, ok: false, error: `Running v${current}, which no longer gets security fixes - the latest LTS is v${verdict.latest}` };
    default:
      return { ...row, ok: true, details: `v${current} (current LTS)`, updatable: false };
  }
}

async function checkNodeRuntime(fetchReleases = fetchNodeReleases, now = new Date()) {
  const current = process.version.replace(/^v/, '');
  try {
    const verdict = judgeNodeRuntime(current, await fetchReleases(), now);
    return describeNodeRuntime(current, verdict, isRunningPortableToolsNode());
  } catch (err) {
    return { id: 'node-runtime', name: 'Node.js runtime', ok: true, details: `v${current} (couldn't reach nodejs.org: ${err.message})`, updatable: false };
  }
}

// Two different answers to "which version is installed", and they only
// diverge after an in-place update (dependency-update.js):
//   - onDisk: what node_modules/<dep>/package.json says right now. Dev mode
//     only — a packaged .exe has no node_modules on disk, its dependencies
//     are frozen into the pkg snapshot and can never change underneath it.
//   - loaded: what this running process actually has in memory. require()
//     caches the parsed package.json (and the module itself) for the whole
//     life of the process, so after `npm install express@5.3.0` it keeps
//     answering 5.2.1 until the server restarts — confirmed live: this made
//     every successful npm update look like it had done nothing, because
//     the check kept reporting the pre-update version.
// The check judges "outdated" by what's on disk (that's what the next start
// will run), and separately flags when the running process is behind it.
function readInstalledVersions(depName) {
  let onDisk = null;
  if (!IS_PKG) {
    try {
      const pkgPath = path.join(PROJECT_ROOT, 'node_modules', depName, 'package.json');
      onDisk = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || null;
    } catch { /* not installed where expected — fall through to loaded/declared */ }
  }
  let loaded = null;
  try {
    // Resolves correctly whether node_modules is real files (dev) or bundled
    // into the pkg snapshot (packaged .exe), since these are all real
    // `dependencies` the server code requires and pkg therefore includes.
    loaded = require(`${depName}/package.json`).version || null;
  } catch { /* package doesn't export ./package.json — onDisk (or declared range) still answers */ }
  return { onDisk, loaded };
}

async function checkNpmDependency(depName, declaredRange) {
  const { onDisk, loaded } = readInstalledVersions(depName);
  // The actually-installed version is more accurate than the declared range
  // (a "^5.2.1" range tells us nothing about which 5.x.y actually landed in
  // node_modules), so the range is only the last-resort fallback.
  const installedVersion = onDisk || loaded || declaredRange.replace(/^[\^~]/, '');
  const restartNote = onDisk && loaded && onDisk !== loaded
    ? ` — restart the server to load it (still running ${loaded})`
    : '';

  try {
    const latest = await fetchLatestNpmVersion(depName);
    const outdated = isOlder(installedVersion, latest);
    return outdated
      ? { id: `dep-${depName}`, name: depName, ok: false, error: `${installedVersion} installed — latest is ${latest}${restartNote}`, latestVersion: latest, updatable: !IS_PKG }
      : { id: `dep-${depName}`, name: depName, ok: true, details: `${installedVersion} (latest)${restartNote}`, updatable: false };
  } catch (err) {
    return { id: `dep-${depName}`, name: depName, ok: true, details: `${installedVersion} (couldn't reach npm registry: ${err.message})${restartNote}`, updatable: false };
  }
}

async function checkPinnedCdnLib(lib, indexHtml) {
  const match = indexHtml.match(lib.pattern);
  if (!match) {
    return { id: lib.id, name: lib.name, ok: true, details: 'not found in public/index.html (may have moved)' };
  }
  const pinned = match[1];
  try {
    const latest = await fetchLatestCdnLibVersion(lib);
    const outdated = isOlder(pinned, latest);
    return outdated
      ? { id: lib.id, name: lib.name, ok: false, error: `${pinned} pinned — latest is ${latest}`, latestVersion: latest, updatable: !IS_PKG }
      : { id: lib.id, name: lib.name, ok: true, details: `${pinned} (latest)`, updatable: false };
  } catch (err) {
    return { id: lib.id, name: lib.name, ok: true, details: `${pinned} (couldn't look up the latest version: ${err.message})`, updatable: false };
  }
}

// FlareSolverr is neither an npm dependency nor a CDN library, but the browser-session pool depends
// on how ITS sessions behave (what a recreated session loses, what an unknown id does), which was
// read from one version's source. So the version it runs is watched like the other tooling here.
// The id is never "dep-*" (the update route sends those to npm) and the row is never updatable:
// replacing the folder FlareSolverr lives in stays a manual step.
const SOLVER_ROW = Object.freeze({ id: 'tool-flaresolverr', name: 'FlareSolverr' });
const SOLVER_NOT_RUNNING = 'not running (version unknown)';

// The version the running FlareSolverr reports, or null when nothing answers. Its root (not
// /v1, which only takes POST commands) answers a plain GET with a small status page; the
// same address the External Services row asks (solverStatusUrl).
async function readInstalledSolverVersion(solverUrl) {
  try {
    const res = await fetch(solverStatusUrl(solverUrl), { signal: AbortSignal.timeout(SOLVER_VERSION_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.version === 'string' && data.version ? data.version.replace(/^v/, '') : null;
  } catch {
    return null;
  }
}

async function fetchLatestSolverVersion() {
  const res = await fetch(FLARESOLVERR_RELEASES_URL, {
    headers: { 'User-Agent': 'ScrollScape', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub HTTP ${res.status}`);
  const tag = String((await res.json()).tag_name || '').replace(/^v/, '');
  if (!tag) throw new Error('GitHub response had no tag_name');
  return tag;
}

const majorMinor = (version) => String(version).split('.').slice(0, 2).join('.');

async function checkFlareSolverrVersion(getFlaresolverrUrl) {
  let installed = null;
  try {
    installed = await readInstalledSolverVersion(await getFlaresolverrUrl());
  } catch { /* no URL to ask: treated as not running */ }
  // Nothing answers (switched off by choice, not installed, still starting): no version to judge,
  // and no request to GitHub for a user who is not using FlareSolverr.
  if (!installed) return { ...SOLVER_ROW, ok: true, details: SOLVER_NOT_RUNNING, updatable: false };

  try {
    const latest = await fetchLatestSolverVersion();
    if (isOlder(installed, latest)) {
      return { ...SOLVER_ROW, ok: false, error: `${installed} installed - latest is ${latest}`, latestVersion: latest, updatable: false };
    }
    const verified = majorMinor(FLARESOLVERR_VERIFIED_VERSION);
    const note = majorMinor(installed) === verified
      ? ' (latest)'
      : ` (latest; the browser session pool was verified on ${verified}.x - re-test after updating)`;
    return { ...SOLVER_ROW, ok: true, details: `${installed}${note}`, updatable: false };
  } catch (err) {
    return { ...SOLVER_ROW, ok: true, details: `${installed} (couldn't reach GitHub: ${err.message})`, updatable: false };
  }
}

function createDependencyHealthCheckService({ getFlaresolverrUrl } = {}) {
  /** @type {{ expiresAt: number, results: object[], solverPending: boolean } | null} */
  let cache = null;

  // Every row but one keeps for 12 h. "FlareSolverr is not running" does not: it can change within seconds (it
  // was off or still starting when the first check ran), and keeping it would show "not running" for hours after
  // it is up. So that row alone is asked again on the next call - the local address only, never the registries.
  async function refreshSolverRow(held) {
    const row = await checkFlareSolverrVersion(getFlaresolverrUrl);
    held.results = held.results.map((existing) => (existing.id === row.id ? row : existing));
    held.solverPending = row.details === SOLVER_NOT_RUNNING;
    return held.results;
  }

  async function runDependencyChecks({ force = false } = {}) {
    if (!force && cache && cache.expiresAt > Date.now()) {
      return cache.solverPending ? refreshSolverRow(cache) : cache.results;
    }

    const pkgJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    const deps = pkgJson.dependencies || {};

    let indexHtml = '';
    try {
      indexHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'public', 'index.html'), 'utf8');
    } catch { /* CDN-lib checks below just report "not found" without it */ }

    const checks = [
      checkNodeRuntime(),
      ...Object.entries(deps).map(([name, range]) => checkNpmDependency(name, range)),
      ...PINNED_CDN_LIBS.map(lib => checkPinnedCdnLib(lib, indexHtml)),
      // Needs the address of the FlareSolverr the app uses; without a way to ask for it there is no row.
      ...(typeof getFlaresolverrUrl === 'function' ? [checkFlareSolverrVersion(getFlaresolverrUrl)] : []),
    ];

    const results = await Promise.all(checks);
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, results, solverPending: results.some((row) => row.id === SOLVER_ROW.id && row.details === SOLVER_NOT_RUNNING) };
    return results;
  }

  return { runDependencyChecks };
}

module.exports = { createDependencyHealthCheckService, PINNED_CDN_LIBS, fetchLatestNpmVersion, fetchLatestCdnLibVersion, checkPinnedCdnLib, checkFlareSolverrVersion, judgeNodeRuntime, describeNodeRuntime, checkNodeRuntime };
