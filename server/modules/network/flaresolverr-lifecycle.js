'use strict';

const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { getAppRoot } = require('../common/app-root');
const { flagState, warnOnce, shown } = require('../common/env-flags');
const choiceStore = require('./flaresolverr-choice');
const { registerRestartListener, emitRestart } = require('./flaresolverr-restart-events');
const { createRestartBrake } = require('./flaresolverr-restart-brake');

// Known to be too big for one module: it grew by accretion (consent, PowerShell, the port's holders,
// install, restart, idle watcher), and all of it shares one injectable `io`, which its tests drive.
// A new concern gets a module of its own, as the restart notifications did (flaresolverr-restart-events.js).

// Same IS_PKG/process.execPath pattern server.js already establishes for
// USER_ROOT — __dirname resolves to a virtual path inside pkg's snapshot
// for a packaged exe, never a real on-disk location, so a plain __dirname-
// relative join here could never find (or correctly write) a real
// tools/flaresolverr/ folder sitting next to the actual .exe file. Confirmed
// live this was silently broken for the packaged build specifically:
// resolveExePath() always returned null there, even with a real
// tools/flaresolverr/flaresolverr.exe sitting right next to the .exe.
const IS_PKG = typeof process.pkg !== 'undefined';
// getAppRoot() is process.execPath's folder, or the "ScrollScape" folder
// beside it (see app-root.js), and is the same root server.js uses.
const REAL_ROOT = IS_PKG ? getAppRoot() : path.join(__dirname, '..', '..', '..');
const TOOLS_DIR = path.join(REAL_ROOT, 'tools');

// FlareSolverr has no authentication of its own and listens on 0.0.0.0 unless
// its HOST variable says otherwise, so a copy launched with the app's
// inherited environment was reachable by anyone on the same network (it is
// only ever used by this app, over 127.0.0.1). The app's own HOST variable
// (e.g. HOST=0.0.0.0 in Docker, or a Tailscale address) must never leak
// through to it, so the bind address is pinned here rather than inherited.
const FLARESOLVERR_BIND_HOST = '127.0.0.1';

// Variables this module owns. Windows environment names are case-insensitive,
// so a stray "Host" would otherwise sit next to the pinned "HOST"; they are
// dropped before the pinned values go in. PROMETHEUS_ENABLED is forced off
// because FlareSolverr's metrics exporter binds every interface.
const PINNED_ENV_KEYS = new Set(['HOST', 'PORT', 'PROMETHEUS_ENABLED']);

function flaresolverrSpawnEnv(baseEnv, port) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (!PINNED_ENV_KEYS.has(key.toUpperCase())) env[key] = value;
  }
  return { ...env, PORT: String(port), HOST: FLARESOLVERR_BIND_HOST, PROMETHEUS_ENABLED: 'false' };
}

// True for a local address as printed by `netstat -ano` ("127.0.0.1",
// "[::1]"); anything else, including the wildcards "0.0.0.0" and "[::]", is
// reachable from the network. All of 127.0.0.0/8 is loopback.
function isLoopbackListenAddress(address) {
  const value = String(address || '').trim();
  return ['[::1]', '::1'].includes(value) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}

// ── Consent ──────────────────────────────────────────────────────────────────
// Downloading and launching a third-party browser-automation tool is opt-in.
// The answer comes from, in order: FLARESOLVERR_DISABLED (never),
// FLARESOLVERR_AUTO_INSTALL (yes), then the choice saved by the first-run
// question (data/setup.json: "install" or "skip"). With none of those nothing
// is downloaded.
//
// What data/setup.json said when the app started (see readSetupState). A file
// that exists but cannot be understood is "invalid": it counts as UNANSWERED
// and, because an unanswered question must not start anything, it also keeps an
// existing install switched off until the user answers.
let setupState = choiceStore.readSetupState(REAL_ROOT);

function setupDamaged(setup = setupState) {
  return !!setup && setup.status === 'invalid';
}

// FLARESOLVERR_DISABLED is the user's brake, so a value that is not understood
// still applies it: staying off is the safe way to be wrong.
function envDisabled(env) {
  const state = flagState(env, 'FLARESOLVERR_DISABLED');
  if (state === 'unknown') {
    warnOnce(`disabled=${env.FLARESOLVERR_DISABLED}`,
      `[FlareSolverr] FLARESOLVERR_DISABLED=${shown(env.FLARESOLVERR_DISABLED)} is not understood (use 1 or 0); treating it as 1, so FlareSolverr stays off.`);
  }
  return state !== 'off';
}

// The opposite way round: a value that is not understood is NOT consent.
function envAutoInstall(env) {
  const state = flagState(env, 'FLARESOLVERR_AUTO_INSTALL');
  if (state === 'unknown') {
    warnOnce(`autoinstall=${env.FLARESOLVERR_AUTO_INSTALL}`,
      `[FlareSolverr] FLARESOLVERR_AUTO_INSTALL=${shown(env.FLARESOLVERR_AUTO_INSTALL)} is not understood (use 1 or 0); treating it as 0, so nothing is downloaded without your answer.`);
  }
  return state === 'on';
}

// When Launch-ScrollScape.bat started the server it set FLARESOLVERR_EXE_PATH:
// the launcher owns the install, so a choice saved by an earlier interactive
// run must not switch off the server-side restart/recovery of that copy. Only
// the explicit environment variables apply then. (The launcher itself reads
// data/setup.json and sets that variable only for a copy the user agreed to.)
function launcherOwnsInstall(env) {
  return !!String(env.FLARESOLVERR_EXE_PATH || '').trim();
}

// Launch-ScrollScape.bat sets SCROLLSCAPE_LAUNCHER=1 and has already asked the
// question on its own console, so the hidden server window must not ask again.
function launcherAsked(env) {
  return flagState(env, 'SCROLLSCAPE_LAUNCHER') === 'on';
}

// True turns every mechanism in this file off.
function isDisabled(env = process.env, choice = setupState.choice, damaged = setupDamaged()) {
  if (envDisabled(env)) return true;
  if (envAutoInstall(env)) return false;
  if (launcherOwnsInstall(env)) return false;
  if (damaged) return true;
  return choice === 'skip';
}

function isAutoInstallEnabled(env = process.env, choice = setupState.choice, damaged = setupDamaged()) {
  if (envAutoInstall(env)) return true;
  if (launcherOwnsInstall(env)) return false;
  if (damaged) return false;
  return choice === 'install';
}

// Which mechanism switched it off, so the hint names the one that can undo it:
// deleting setup.json does nothing while FLARESOLVERR_DISABLED is set.
function describeOff(env, setup, setupFile) {
  if (envDisabled(env)) {
    return `[FlareSolverr] Off: FLARESOLVERR_DISABLED is set. To turn it on, unset that variable - deleting ${setupFile} changes nothing while it is set.`;
  }
  if (setupDamaged(setup)) {
    return `[FlareSolverr] Off: ${setupFile} ${setup.reason}. Nothing is downloaded or started until you answer: fix or delete that file and restart to be asked again, or set FLARESOLVERR_AUTO_INSTALL=1.`;
  }
  return `[FlareSolverr] Off: you answered no. To be asked again delete ${setupFile}; to turn it on without being asked set FLARESOLVERR_AUTO_INSTALL=1.`;
}

// FlareSolverr keeps its browser (and every Chrome child process it spawned
// for the most recent solve) resident indefinitely after a one-shot
// `request.get` completes — confirmed live: 17 chrome/chromedriver processes,
// ~840MB, still sitting there several minutes after the triggering search had
// already returned. That's deliberate on FlareSolverr's side (a warm browser
// answers the next Cloudflare challenge faster than a cold one), so this
// module doesn't fight that — it only reclaims the memory after the app has
// gone genuinely unused for a while, never mid-session.
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_IDLE_MINUTES = 20;

let lastUsedAt = null;
let watcherStarted = false;
let knownExePath = null;
let knownPort = '8191';
let restartInFlight = null;
// How often the app restarts a hung FlareSolverr by itself (flaresolverr-restart-brake.js); `brakeNoted` keeps the console to one line per pause.
const recoveryBrake = createRestartBrake({ now: () => Date.now() });
let brakeNoted = false;

function noteFlaresolverrUsed() {
  lastUsedAt = Date.now();
}

// ── Everything that touches the machine ─────────────────────────────────────
// Processes, files, the network and the clock all go through this one object,
// so the tests can drive restartFlaresolverr / ensureFlaresolverrRunning with
// fakes (no FlareSolverr, no PowerShell, no download) and still reach the calls
// that matter: the spawn environment, who gets killed, what gets downloaded.
// Each public function takes an optional `io` and defaults to the real thing.

// Runs a program and always resolves: { error, stdout, stderr }.
function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// True once port 8191 answers a real FlareSolverr request, not just "some
// process is listening" (a stray unrelated service on the same port would
// pass a plain TCP check but fail every real solve) - checked before
// assuming a (re)start actually worked, and used by ensureFlaresolverrRunning
// to tell "genuinely down" apart from "already fine, don't touch it".
function probeReachable(port, timeoutMs = 8000) {
  return fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) })
    .then(() => true)
    .catch(() => false);
}

function makeIo(overrides = {}) {
  return {
    env: process.env,
    platform: process.platform,
    fs,
    exec: execFileAsync,
    spawn,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    probe: probeReachable,
    fetchAsset: fetchLatestReleaseAsset,
    startWatcher: () => startFlaresolverrIdleWatcher(),
    setInterval: (fn, ms) => setInterval(fn, ms).unref(),
    toolsDir: TOOLS_DIR,
    setup: () => setupState,
    log: (message) => console.log(message),
    warn: (message) => console.error(message),
    ...overrides,
  };
}

function consentOf(io) {
  const setup = io.setup();
  const damaged = setupDamaged(setup);
  return {
    setup,
    disabled: isDisabled(io.env, setup.choice, damaged),
    autoInstall: isAutoInstallEnabled(io.env, setup.choice, damaged),
  };
}

// ── PowerShell ───────────────────────────────────────────────────────────────
// Values (paths, a download address, a PID) never go into the script text: they
// travel as SS_<NAME> environment variables that the script reads as
// $env:SS_<NAME>. There is nothing to quote, so no apostrophe, curly quote,
// backtick or "$(...)" in a path can break out of a string - and no quoting
// function whose own escapes could be lost. (The first version of this patch
// interpolated values through a quoting helper whose character class had lost
// its \u escapes, which corrupted every path containing a digit or A/B.)
function psEnv(baseEnv, vars) {
  const env = { ...baseEnv };
  for (const [name, value] of Object.entries(vars)) env[`SS_${name}`] = String(value);
  return env;
}

// The trimmed output of a short PowerShell script, or null when it failed or
// timed out - so "printed nothing" and "could not run" stay distinguishable.
async function runPs(io, script, vars = {}, timeoutMs = 15000) {
  const { error, stdout } = await io.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: timeoutMs,
    windowsHide: true,
    env: psEnv(io.env, vars),
  });
  return error ? null : stdout.trim();
}

// First line of PowerShell's complaint that is not the CLIXML framing it adds
// when its output is redirected.
function firstErrorLine(stderr, fallback) {
  const line = String(stderr || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#<') && !l.startsWith('<Objs'));
  return line || fallback;
}

// Runs a long PowerShell script (a download) without blocking the event loop
// (the previous execSync froze the whole server, browser tab included, for the
// length of the download), with a generous timeout. Rejects with PowerShell's
// own message. $ProgressPreference is silenced: Windows PowerShell 5.1 draws a
// progress bar per chunk even when hidden, which made a large download roughly
// 60x slower. 'Stop' turns a failed cmdlet into a failed exit code.
async function runPsAsync(io, script, vars, timeoutMs = 60 * 60 * 1000) {
  const { error, stderr } = await io.exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`,
  ], { timeout: timeoutMs, windowsHide: true, env: psEnv(io.env, vars) });
  if (error) throw new Error(firstErrorLine(stderr, error.message));
}

// ── Finding and identifying whatever holds the port ─────────────────────────

/**
 * Every listening TCP socket on `port` in the text of `netstat -ano`.
 * Rows are read by column structure - Proto, Local, Foreign, State..., PID - not
 * by the English word LISTENING, which a localized Windows translates (and
 * sometimes splits into several words). A listening row is a TCP row whose
 * foreign address is the unspecified one, ending in ":0".
 * @returns {{ pid: number, address: string }[]} all of them: a loopback listener
 *   must not hide a wildcard one behind it
 */
function parseNetstatListeners(text, port) {
  const listeners = [];
  const seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue;
    const local = parts[1];
    if (!parts[2].endsWith(':0')) continue;
    const cut = local.lastIndexOf(':');
    if (cut < 0 || local.slice(cut + 1) !== String(port)) continue;
    const pid = Number.parseInt(parts[parts.length - 1], 10);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const address = local.slice(0, cut);
    const key = `${pid}|${address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    listeners.push({ pid, address });
  }
  return listeners;
}

// Windows-only (matches the rest of this project's process-management code,
// e.g. Launch-ScrollScape.bat's own taskkill-by-PID cleanup).
async function findListeners(port, io) {
  const { error, stdout } = await io.exec('netstat', ['-ano'], { timeout: 10000, windowsHide: true });
  return error ? [] : parseNetstatListeners(stdout, port);
}

async function findListeningPid(port, io) {
  const listeners = await findListeners(port, io);
  return listeners.length ? listeners[0].pid : null;
}

function killTree(pid, io) {
  return io.exec('taskkill', ['/pid', String(pid), '/t', '/f'], { timeout: 10000, windowsHide: true });
}

// The program that owns `pid`: { status: 'ok', name, path } (name without
// ".exe"; path '' when Windows would not say), 'gone' when no such process
// exists any more, or 'unreadable' when the query itself failed or timed out.
const PS_PROCESS_INFO = "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$env:SS_PID) -ErrorAction SilentlyContinue; if ($p) { $p.Name; $p.ExecutablePath }";

async function processInfoOf(pid, io) {
  const out = await runPs(io, PS_PROCESS_INFO, { PID: Number(pid) }, 8000);
  if (out === null) return { status: 'unreadable' };
  const [name = '', exePath = ''] = out.split(/\r?\n/).map((line) => line.trim());
  if (!name) return { status: 'gone' };
  return { status: 'ok', name: name.replace(/\.exe$/i, ''), path: exePath };
}

function sameFile(a, b) {
  return path.win32.resolve(String(a)).toLowerCase() === path.win32.resolve(String(b)).toLowerCase();
}

// Is the process behind `pid` this app's own FlareSolverr? Name alone is not
// enough: a copy someone runs from another folder is also called
// "flaresolverr", and the one the .bat staged elsewhere is not the one this
// server was told to manage. Anything that cannot be confirmed is NOT ours.
//   ours | gone | unreadable | other (different program) |
//   other-copy (a FlareSolverr from a different path) | path-unreadable
async function judgeOwner(pid, expectedExePath, io) {
  const info = await processInfoOf(pid, io);
  const finding = { pid, ...info };
  if (info.status === 'gone') return { ...finding, verdict: 'gone' };
  if (info.status === 'unreadable') return { ...finding, verdict: 'unreadable' };
  if (info.name.toLowerCase() !== 'flaresolverr') return { ...finding, verdict: 'other' };
  if (!expectedExePath) return { ...finding, verdict: 'ours' };
  if (!info.path) return { ...finding, verdict: 'path-unreadable' };
  return { ...finding, verdict: sameFile(info.path, expectedExePath) ? 'ours' : 'other-copy' };
}

async function inspectListeners(listeners, expectedExePath, io) {
  const findings = [];
  for (const pid of new Set(listeners.map((l) => l.pid))) {
    findings.push(await judgeOwner(pid, expectedExePath, io));
  }
  return findings;
}

const isBlocker = (finding) => finding.verdict !== 'ours' && finding.verdict !== 'gone';

function blockerMessage(port, finding, expectedExePath) {
  const who = `${finding.name || 'a program'} (PID ${finding.pid})`;
  switch (finding.verdict) {
    case 'unreadable':
      return `[FlareSolverr] Port ${port} is in use by PID ${finding.pid}, but Windows would not say which program that is (the check timed out or was denied), so it is left alone. Close that program or free the port, then restart ScrollScape.`;
    case 'path-unreadable':
      return `[FlareSolverr] Port ${port} is held by ${who}, but where it runs from could not be read, so it cannot be confirmed as this app's FlareSolverr; leaving it alone.`;
    case 'other-copy':
      return `[FlareSolverr] Port ${port} is held by a different FlareSolverr (${finding.path}, PID ${finding.pid}) than the one this app manages (${expectedExePath}); leaving it alone.`;
    default:
      return `[FlareSolverr] Port ${port} is held by ${who}, not FlareSolverr; leaving it alone.`;
  }
}

// Something is answering on the FlareSolverr port from a network-reachable
// address. Reported, never killed here: whoever started it on purpose (a
// container, a copy run by hand) owns it, and a copy left over from an older
// build is only touched once the user has said yes.
function exposedMessage(port, finding, listener) {
  const name = finding.name || 'A program';
  return `[FlareSolverr] WARNING: ${name} (PID ${finding.pid}) is listening on ${listener.address}:${port}, so other devices on the network can reach it, and FlareSolverr has no password. ScrollScape leaves it running. `
    + `To stop it, run  taskkill /pid ${finding.pid} /t /f  in a Command Prompt (or end "${name}" in Task Manager); or block port ${port} in the Windows firewall.`;
}

async function warnAboutExposedListener(port, io, expectedExePath = null) {
  const exposed = (await findListeners(port, io)).filter((l) => !isLoopbackListenAddress(l.address));
  if (!exposed.length) return;
  for (const finding of await inspectListeners(exposed, expectedExePath, io)) {
    if (finding.verdict === 'gone') continue;
    const listener = exposed.find((l) => l.pid === finding.pid);
    io.warn(exposedMessage(port, finding, listener));
  }
}

// ── Cleaning up before a (re)launch ─────────────────────────────────────────

// Real, confirmed root cause of a startup failure this session:
// FlareSolverr's own `undetected_chromedriver` step copies its driver binary
// to a fixed per-user path (%APPDATA%\undetected_chromedriver\chromedriver.exe)
// on every launch, and fails with a Python PermissionError if that exact file
// is locked by ANY running process — logged as a plain "Error getting browser
// User-Agent" crash with no FlareSolverr-side retry. A leftover chromedriver
// there is either this same FlareSolverr instance's own now-dead session (we're
// about to replace it) or an orphan blocking the shared cache file either way —
// safe to clear right before every (re)launch attempt, since a fresh
// FlareSolverr spawns its own replacement immediately after.
//
// Scoped by where the process runs from, like killStaleFlaresolverrChrome()
// below: only a chromedriver under that cache folder or under this project's
// FlareSolverr folder is stopped. It used to be `taskkill /im chromedriver.exe`,
// which killed every chromedriver on the machine - and the browser each one was
// driving - including Selenium/Puppeteer/Karma runs that have nothing to do with
// this app. The roots are joined with "|", a character no Windows path holds.
const PS_KILL_CHROMEDRIVER = '$roots = @($env:SS_ROOTS.Split(\'|\') | Where-Object { $_ }); '
  + 'Get-CimInstance Win32_Process -Filter "Name=\'chromedriver.exe\'" -ErrorAction SilentlyContinue | '
  + 'Where-Object { $p = $_.ExecutablePath; $p -and ($roots | Where-Object { $p.StartsWith($_, [System.StringComparison]::OrdinalIgnoreCase) }) } | '
  + 'ForEach-Object { & taskkill.exe /pid $_.ProcessId /t /f 2>&1 | Out-Null }';

function chromedriverRoots(io) {
  const roots = [path.join(io.toolsDir, 'flaresolverr') + path.sep];
  if (io.env.APPDATA) roots.unshift(path.join(io.env.APPDATA, 'undetected_chromedriver') + path.sep);
  return roots;
}

function killStaleChromedriver(io) {
  return runPs(io, PS_KILL_CHROMEDRIVER, { ROOTS: chromedriverRoots(io).join('|') }, 15000);
}

// FlareSolverr's own bundled Chrome (tools/flaresolverr/_internal/chrome/
// chrome.exe, a dedicated copy distinct from any browser the user has
// installed) can survive killTree() above - confirmed live: 40+ orphaned
// instances, several with 30+ minutes of accumulated CPU time, growing
// across repeated wedge-recovery restarts within a single session (Windows'
// `taskkill /t` on the FlareSolverr PID alone never reached any of them,
// most likely because undetected_chromedriver launches Chrome detached from
// FlareSolverr's own process tree). Left unchecked this both wastes memory
// and, as the count grows, appears to make FlareSolverr itself increasingly
// likely to wedge again - a vicious cycle. Path-scoped to this project's own
// FlareSolverr install so a real Chrome browser the user has open (a
// completely different executable, never running from this path) is never
// at risk - same reasoning as killStaleChromedriver() above, extended to
// this same tool's own browser, not just its driver.
//
// .StartsWith() rather than -like: an install path containing any of -like's
// own wildcard metacharacters ([, ], *, ?, #) - e.g. a versioned folder name
// like "ScrollScape [v3]" - would otherwise be parsed as a pattern instead of a
// literal path, silently breaking the match. OrdinalIgnoreCase restores
// -like's own case-insensitivity, which a bare .StartsWith() lacks by .NET
// default (case-sensitive) - needed because WMI's reported ExecutablePath can
// differ in case from the Node-computed folder (a known Windows/WMI
// path-casing quirk), which would otherwise silently fail the match and leave
// orphaned Chrome processes unkilled.
const PS_KILL_FLARESOLVERR_CHROME = 'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" -ErrorAction SilentlyContinue | '
  + 'Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:SS_DIR, [System.StringComparison]::OrdinalIgnoreCase) } | '
  + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';

function killStaleFlaresolverrChrome(io) {
  return runPs(io, PS_KILL_FLARESOLVERR_CHROME, { DIR: path.join(io.toolsDir, 'flaresolverr', '_internal', 'chrome') + path.sep }, 15000);
}

// Windows re-flags a freshly-extracted/copied exe with the "Mark of the Web"
// and SmartScreen then blocks an unattended launch behind an interactive
// dialog that never shows up in a headless context - it just hangs forever.
// Launch-ScrollScape.bat's own launch strips this before every start (see
// its comment near the FlareSolverr Start-Process call); this mirrors that
// so a relaunch doesn't quietly hang the same way.
function unblockFile(exePath, io) {
  return runPs(io, 'Unblock-File -LiteralPath $env:SS_FILE -ErrorAction SilentlyContinue', { FILE: exePath }, 10000);
}

function setPriorityBelowNormal(pid, io) {
  return runPs(io, "try { (Get-Process -Id ([int]$env:SS_PID)).PriorityClass = 'BelowNormal' } catch {}", { PID: Number(pid) }, 8000);
}

// Falls back to the project's own bundled copy when FLARESOLVERR_EXE_PATH
// isn't set (i.e. `node server.js` directly, outside Launch-ScrollScape.bat -
// confirmed this exact setup during a real session: every mechanism below
// silently no-op'd for this reason, and a stale-lock startup failure sat
// undiagnosed until someone happened to read FlareSolverr's own log by hand).
// Only used as a fallback - the env var still wins when the .bat set it,
// since that path is staged onto local disk (see the .bat's own comment on
// why) and may differ from this one.
function defaultExePath(io) {
  const candidate = path.join(io.toolsDir, 'flaresolverr', 'flaresolverr.exe');
  return io.fs.existsSync(candidate) ? candidate : null;
}

// Env var wins when Launch-ScrollScape.bat set it (its copy is staged onto
// local disk, which may legitimately differ from the project-tree one) -
// otherwise falls back to the bundled copy so every mechanism in this file
// stays armed even in plain `node server.js` dev mode, where the env var is
// never set at all. A variable that names a file that is not there means "no
// install": falling back to some other copy would manage a FlareSolverr the
// launcher never vouched for.
function resolveExePath(io = makeIo()) {
  const fromEnv = String(io.env.FLARESOLVERR_EXE_PATH || '').trim();
  if (fromEnv) {
    if (io.fs.existsSync(fromEnv)) return fromEnv;
    warnOnce(`exe-missing=${fromEnv}`, `[FlareSolverr] FLARESOLVERR_EXE_PATH points to ${fromEnv}, which does not exist; nothing to manage.`, io.warn);
    return null;
  }
  return defaultExePath(io);
}

// True when this app is expected to have a FlareSolverr running: not switched
// off, and either one is installed or the user asked for one (a saved "install",
// FLARESOLVERR_AUTO_INSTALL). System Health uses it to tell "off by choice" (a
// declined question, FLARESOLVERR_DISABLED, a damaged setup.json, nothing
// installed and nothing requested) from "should be up but is not". Read-only:
// it starts, downloads and kills nothing.
function isManaged(io = makeIo()) {
  const consent = consentOf(io);
  return !consent.disabled && (consent.autoInstall || !!resolveExePath(io));
}

// ── Restarting ──────────────────────────────────────────────────────────────
// Stops the FlareSolverr processes the caller identified as ours. Nothing is
// killed when there are none (a first-ever launch, or a port nobody holds).
async function killOwnInstances(findings, reason, io) {
  const ours = findings.filter((f) => f.verdict === 'ours');
  if (!ours.length) {
    io.log(`[FlareSolverr] ${reason} (not currently running)...`);
    return;
  }
  io.log(`${reason} (PID ${ours.map((f) => f.pid).join(', ')})...`);
  for (const finding of ours) await killTree(finding.pid, io);
  await io.sleep(1500);
}

// A direct child_process.spawn instead of PowerShell's Start-Process -
// confirmed live that Start-Process is unreliable for this exact exe
// (worked once, then silently failed to ever launch on a later run, no
// error surfaced) while a plain detached spawn is the same mechanism
// that reliably launches this same exe everywhere else this project
// needs to start it unattended. False when the spawn itself throws.
function spawnFlaresolverr(exePath, port, io) {
  try {
    const child = io.spawn(exePath, [], {
      env: flaresolverrSpawnEnv(io.env, port),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    child.on('error', (err) => {
      io.warn(`[FlareSolverr] Idle restart failed to spawn: ${err.message}`);
    });
    return true;
  } catch (err) {
    io.warn(`[FlareSolverr] Could not start ${exePath}: ${err.message}`);
    return false;
  }
}

// FlareSolverr itself takes several seconds to launch its bundled Chrome
// and start listening - poll instead of trusting the spawn call alone.
// The PID that answers the port, or null when none does in time.
async function waitForListeningPid(port, io) {
  for (let i = 0; i < 10; i++) {
    await io.sleep(1500);
    const pid = await findListeningPid(port, io);
    if (pid) return pid;
  }
  return null;
}

async function reportRestarted(pid, port, io) {
  await setPriorityBelowNormal(pid, io);
  io.log(`[FlareSolverr] Restarted (PID ${pid}), listening again on ${port}.`);
  const stillExposed = (await findListeners(port, io)).filter((l) => !isLoopbackListenAddress(l.address));
  for (const listener of stillExposed) {
    io.warn(`[FlareSolverr] WARNING: it is still listening on ${listener.address}:${port}, reachable from the network, even though HOST was pinned to ${FLARESOLVERR_BIND_HOST}. `
      + `To stop it, run  taskkill /pid ${listener.pid} /t /f  in a Command Prompt; or block port ${port} in the Windows firewall.`);
  }
}

// Kills what is ours, clears what a previous run left behind, starts a fresh
// FlareSolverr and waits for its port. `findings` is what inspectListeners said
// about the port's current holders. True when it answers again.
async function relaunchFlaresolverr(exePath, port, reason, findings, io) {
  await killOwnInstances(findings, reason, io);
  // Clears the lock behind the one confirmed startup-failure cause (see
  // killStaleChromedriver's own comment) before every attempt, whether this
  // is a restart or a first-ever launch - cheap and always safe here since
  // we're about to spawn a fresh chromedriver right after regardless.
  await killStaleChromedriver(io);
  // Same reasoning, for orphaned Chrome instances left behind by a previous
  // wedge/restart cycle - see killStaleFlaresolverrChrome()'s own comment.
  await killStaleFlaresolverrChrome(io);
  await unblockFile(exePath, io);

  if (!spawnFlaresolverr(exePath, port, io)) return false;
  const pid = await waitForListeningPid(port, io);
  if (pid === null) {
    io.warn(`[FlareSolverr] Restart did not come back up on port ${port} - Cloudflare-protected sources will fail until it's restarted manually.`);
    return false;
  }
  await reportRestarted(pid, port, io);
  return true;
}

// Bootstraps a never-started instance exactly the same way it restarts a
// wedged one - a cold "port never came up" and a "was up, now hung" both end
// at the identical fresh-launch sequence (relaunchFlaresolverr), they just skip
// different steps to get there (no existing PID to kill for the former).
async function restartFlaresolverr(exePath, port, reason, io = makeIo()) {
  // Every caller has already checked, but this is the function that kills and
  // spawns, so it checks again: switched off means nothing is touched.
  if (consentOf(io).disabled) {
    io.log('[FlareSolverr] Restart skipped: FlareSolverr is switched off.');
    return;
  }
  if (!io.fs.existsSync(exePath)) {
    io.warn(`[FlareSolverr] Cannot start it: ${exePath} does not exist.`);
    return;
  }
  // Whatever else holds the port (a container's forwarder, some other
  // service, another copy of FlareSolverr) is not ours to kill, whichever
  // caller asked for the restart. Every listener is checked: one foreign
  // owner anywhere on the port means nothing is killed and nothing started.
  const listeners = await findListeners(port, io);
  const findings = listeners.length ? await inspectListeners(listeners, exePath, io) : [];
  const blocker = findings.find(isBlocker);
  if (blocker) {
    io.warn(blockerMessage(port, blocker, exePath));
    return;
  }

  // Only from here does a kill and a spawn really happen, so only from here are the listeners told
  // (a restart that stopped at a check above must not pause anything). 'end' follows whatever happens
  // next, a spawn that fails included, so nobody is left waiting for a restart that is already over.
  const warn = (message) => io.warn(message);
  emitRestart('begin', { reason }, warn);
  let ok = false;
  try {
    ok = await relaunchFlaresolverr(exePath, port, reason, findings, io);
  } finally {
    emitRestart('end', { ok }, warn);
  }
}

// First interactive launch: ask once whether to set FlareSolverr up. Skipped
// when an environment variable already decided it, when a choice is saved, when
// the .bat launcher owns the install or has already asked (it sets
// FLARESOLVERR_EXE_PATH / SCROLLSCAPE_LAUNCHER), when FlareSolverr is already
// installed (an existing setup keeps working exactly as before), on anything
// but Windows (the installer is Windows-only), and when there is no console to
// ask on. The one exception to "installed means not asked" is a setup.json that
// exists but cannot be understood: nobody has answered, so an existing install
// stays off until somebody does. Everything it looks at can be injected so the
// tests do not depend on the machine they run on.
async function resolveFlaresolverrChoice({
  env = process.env,
  platform = process.platform,
  choice = () => setupState.choice,
  problem = () => (setupDamaged() ? setupState.reason : null),
  exeExists = () => { const p = resolveExePath(); return !!p && fs.existsSync(p); },
  interactive = () => !!(process.stdin.isTTY && process.stdout.isTTY),
  ask = choiceStore.askChoice,
  save = (answer) => {
    // In memory first: an answer given this run holds even if the disk is read-only.
    setupState = { status: 'ok', data: {}, choice: answer };
    choiceStore.writeChoice(REAL_ROOT, answer);
  },
  log = (message) => console.log(message),
  warn = (message) => console.error(message),
} = {}) {
  if (platform !== 'win32') return null;
  if (envDisabled(env) || envAutoInstall(env)) return choice();
  if (launcherOwnsInstall(env) || launcherAsked(env)) return choice();
  const setupFile = choiceStore.setupPath(REAL_ROOT);
  const broken = problem();
  if (broken) {
    warn(`[Setup] ${setupFile} ${broken}. Treating the FlareSolverr question as unanswered: it stays off until you answer.`);
  } else {
    if (choice()) return choice();
    if (exeExists()) return null;
  }
  if (!interactive()) {
    if (broken) warn(`[Setup] There is no console to ask on. Fix or delete ${setupFile}, or set FLARESOLVERR_AUTO_INSTALL=1.`);
    return null;
  }
  const answer = await ask({ toolsDir: TOOLS_DIR, setupFile });
  if (answer) {
    save(answer);
  } else {
    log('[Setup] The FlareSolverr question was shown but not answered; it stays off for this run and you will be asked again next launch.');
  }
  return answer;
}

// One restart at a time: the idle watcher, hang recovery and the startup check share the one in flight
// (two would kill and spawn over each other). `failure` names the caller in the line logged if it throws.
function restartOnce(exePath, port, reason, io, failure) {
  if (restartInFlight) return restartInFlight;
  restartInFlight = restartFlaresolverr(exePath, port, reason, io)
    .catch((err) => io.warn(`[FlareSolverr] ${failure}: ${err.message}`))
    .finally(() => { restartInFlight = null; });
  return restartInFlight;
}

// One tick of the idle watcher: restarts FlareSolverr when the app has not used it for `idleMinutes`.
function checkFlaresolverrIdle(io, idleMinutes) {
  // Never used this run - nothing to reclaim; used recently - not idle yet.
  if (lastUsedAt === null || Date.now() - lastUsedAt < idleMinutes * 60 * 1000) return undefined;
  lastUsedAt = null; // Reset first so a slow/failed restart can't loop every tick.
  if (consentOf(io).disabled) return undefined;
  return restartOnce(knownExePath, knownPort, `Idle ${idleMinutes}+ min, restarting to free the resident browser pool`, io, 'Idle restart failed');
}

// Call once at server startup. No-ops when no FlareSolverr install can be
// found at all (env var unset AND no bundled copy in tools/flaresolverr/) -
// there's genuinely nothing this module could manage in that case.
function startFlaresolverrIdleWatcher(io = makeIo()) {
  knownExePath = resolveExePath(io);
  knownPort = io.env.FLARESOLVERR_PORT || '8191';
  if (consentOf(io).disabled) return;
  if (watcherStarted || !knownExePath) return;
  const idleMinutes = Number(io.env.FLARESOLVERR_IDLE_RESTART_MINUTES) || DEFAULT_IDLE_MINUTES;

  watcherStarted = true;
  io.setInterval(() => checkFlaresolverrIdle(io, idleMinutes), CHECK_INTERVAL_MS);
}

// True when a new recovery may start now, and then counts it. A refusal because of the limit is said once per pause; one because
// a restart has just finished is the normal case of a timeout that was already in flight and says nothing.
function recoveryAllowed(io) {
  const verdict = recoveryBrake.check();
  if (verdict.allowed) {
    brakeNoted = false;
    recoveryBrake.record();
    return true;
  }
  if (verdict.why === 'limit' && !brakeNoted) {
    brakeNoted = true;
    const { restarts, windowMinutes } = recoveryBrake.status();
    io.warn(`[FlareSolverr] It stopped answering again, but it was already restarted ${restarts} times in ${windowMinutes} min; not restarting it again for ${Math.ceil(verdict.retryInMs / 60_000)} min. Protected sites fail until then.`);
  }
  return false;
}

// Counts and times only, for System Health.
function getRecoveryStatus() {
  return recoveryBrake.status();
}

// For tests that share this module's state: forgets the recoveries counted so far.
function resetRecoveryBrake() {
  recoveryBrake.reset();
  brakeNoted = false;
}

// Some target sites' challenges (confirmed live: batcave.biz's Cloudflare
// Turnstile) get stuck mid-solve in a way FlareSolverr's own maxTimeout
// can't recover from - the underlying Chrome/Selenium call never returns
// control to FlareSolverr's Python process, so it stops answering ANY
// request at all, not just the one that triggered it (confirmed live: even
// a trivial sessions.list call got no response, minutes later, and Chrome
// processes kept accumulating into the hundreds). A source's own request
// timing out against FlareSolverr (see fetch-utils.js's executeFlareSolverr)
// is the signal that this has happened - restart to un-wedge it for every
// OTHER source, rather than leaving the shared instance poisoned until
// someone notices and restarts it by hand (concurrent callers share one restart: restartOnce).
//
// Not without limit, though: a site that wedges it every time it is asked would make this a kill-and-relaunch loop of a hidden
// browser. A recovery already running is joined; a NEW one has to pass the brake (recoveryAllowed).
function recoverFromHang(io = makeIo()) {
  if (consentOf(io).disabled) return;
  // Resolved afresh each time: an install finished (or removed) since boot counts.
  knownExePath = resolveExePath(io);
  knownPort = io.env.FLARESOLVERR_PORT || '8191';
  if (!knownExePath) return;
  if (!restartInFlight && !recoveryAllowed(io)) return;
  return restartOnce(knownExePath, knownPort, 'Appears wedged (no response to a request), restarting to recover', io, 'Recovery failed');
}

// ── The consented install ───────────────────────────────────────────────────
// Ports install_flaresolverr.js's download/extract logic in here as an
// async function instead of that standalone script's callback style, so
// ensureFlaresolverrRunning() below can await it directly. That standalone
// script only ever ran as an explicit step of Launch-ScrollScape.bat's own
// first-run setup — never invoked by the packaged .exe on its own, which is
// exactly why a fresh machine with just the .exe (no .bat alongside it) had
// no FlareSolverr and no way to ever get one. Same GitHub-release-asset +
// PowerShell Invoke-WebRequest/Expand-Archive approach, same TOOLS_DIR
// shape, just resolved against REAL_ROOT (see the top of this file) so it
// installs next to wherever the real .exe file actually lives, packaged or
// not. install_flaresolverr.js now calls this same function, so there is one
// implementation to harden.
let installInFlight = null;

function fetchLatestReleaseAsset() {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const req = https.request({
      hostname: 'api.github.com',
      path: '/repos/FlareSolverr/FlareSolverr/releases/latest',
      method: 'GET',
      headers: { 'User-Agent': 'ScrollScape' },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub API HTTP ${res.statusCode}`));
        try {
          const release = JSON.parse(body);
          const asset = (release.assets || []).find((a) => String(a.name).includes('windows_x64') && String(a.name).endsWith('.zip'));
          if (!asset) return reject(new Error('No windows_x64 zip found in latest FlareSolverr release'));
          resolve(asset);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('GitHub API timeout')));
    req.on('error', reject);
    req.end();
  });
}

// The release asset must come from FlareSolverr's own GitHub releases over
// https before a 700 MB executable that will later be run is fetched from it.
function isExpectedAssetUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.startsWith('/FlareSolverr/FlareSolverr/releases/download/');
  } catch (_) {
    return false;
  }
}

// WebClient.DownloadFile rather than Invoke-WebRequest -OutFile: in Windows
// PowerShell 5.1 -OutFile reads its path as a wildcard pattern and has no
// -LiteralPath form, so an install folder such as "ScrollScape [v3]" (the very
// example the Chrome sweep's comment gives) fails with "wildcard path ... did
// not resolve" - confirmed against the real PowerShell. DownloadFile takes the
// path as it is, and uses the same HTTP stack (proxy, TLS, redirects) as
// Invoke-WebRequest does there.
const PS_DOWNLOAD = "$w = New-Object System.Net.WebClient; $w.Headers.Add('User-Agent', 'ScrollScape'); $w.DownloadFile($env:SS_URL, $env:SS_OUT)";
const PS_EXTRACT = 'Expand-Archive -LiteralPath $env:SS_ZIP -DestinationPath $env:SS_DEST -Force';

async function installFlaresolverr(io = makeIo()) {
  // The installer drives Windows PowerShell and downloads a Windows build: on
  // anything else there is nothing to do, so don't even ask GitHub.
  if (io.platform !== 'win32') throw new Error('the automatic FlareSolverr install only works on Windows');
  if (installInFlight) return installInFlight;
  installInFlight = (async () => {
    io.log('[FlareSolverr] Not found locally - downloading a fresh copy (first run on this machine)...');
    const asset = await io.fetchAsset();
    if (!isExpectedAssetUrl(asset.browser_download_url)) {
      throw new Error(`Refusing to download from an unexpected address: ${asset.browser_download_url}`);
    }
    io.log(`[FlareSolverr] Found release asset: ${asset.name}`);

    io.fs.mkdirSync(io.toolsDir, { recursive: true });
    const zipPath = path.join(io.toolsDir, 'flaresolverr.zip');
    const extractDir = path.join(io.toolsDir, 'flaresolverr');
    const tempExtract = path.join(io.toolsDir, 'fs_temp');

    try {
      io.log('[FlareSolverr] Downloading...');
      io.log('[FlareSolverr] This can take a few minutes; ScrollScape stays usable meanwhile.');
      await runPsAsync(io, PS_DOWNLOAD, { URL: asset.browser_download_url, OUT: zipPath });

      if (io.fs.existsSync(extractDir)) io.fs.rmSync(extractDir, { recursive: true, force: true });
      if (io.fs.existsSync(tempExtract)) io.fs.rmSync(tempExtract, { recursive: true, force: true });
      io.fs.mkdirSync(tempExtract, { recursive: true });

      io.log('[FlareSolverr] Extracting...');
      await runPsAsync(io, PS_EXTRACT, { ZIP: zipPath, DEST: tempExtract });

      const innerFolder = path.join(tempExtract, 'flaresolverr');
      if (!io.fs.existsSync(innerFolder)) throw new Error(`Unexpected zip structure in ${tempExtract}`);
      io.fs.renameSync(innerFolder, extractDir);

      const exePath = path.join(extractDir, 'flaresolverr.exe');
      if (!io.fs.existsSync(exePath)) throw new Error(`flaresolverr.exe missing after extract at ${exePath}`);
      io.log(`[FlareSolverr] Installed to ${extractDir}`);
      return exePath;
    } finally {
      // Hundreds of MB that a failed or half-finished attempt must not leave
      // behind to be tripped over by the next one.
      for (const target of [zipPath, tempExtract]) {
        try { io.fs.rmSync(target, { recursive: true, force: true }); } catch (_) { /* best effort */ }
      }
    }
  })();
  try {
    return await installInFlight;
  } finally {
    installInFlight = null;
  }
}

// ── Startup ─────────────────────────────────────────────────────────────────
// Call once at server startup (in addition to startFlaresolverrIdleWatcher,
// not instead of it - this only covers the moment of boot). Closes the one
// gap none of the mechanisms above did: a FlareSolverr that never came up in
// the first place has no PID for restartFlaresolverr to find, so nothing
// above would ever have noticed or fixed it - confirmed live this session,
// a stale chromedriver.exe lock (see killStaleChromedriver) crashed
// FlareSolverr on its very first launch attempt and nothing caught it until
// a human happened to read its log by hand. Probes real reachability first
// so a healthy instance (started by Launch-ScrollScape.bat moments earlier,
// or already warm from a previous run) is never needlessly restarted.
async function ensureFlaresolverrRunning(overrides = {}) {
  const io = makeIo(overrides);
  knownExePath = resolveExePath(io);
  knownPort = io.env.FLARESOLVERR_PORT || '8191';
  const consent = consentOf(io);
  if (consent.disabled) {
    io.log(describeOff(io.env, consent.setup, choiceStore.setupPath(REAL_ROOT)));
    await warnAboutExposedListener(knownPort, io);
    return;
  }
  if (!knownExePath && !consent.autoInstall) {
    io.log('[FlareSolverr] Not installed and not requested; nothing is downloaded. Cloudflare-protected sources stay unavailable. '
      + `To change this set FLARESOLVERR_AUTO_INSTALL=1 or edit ${choiceStore.setupPath(REAL_ROOT)}.`);
    return;
  }
  if (!knownExePath) {
    // Nothing installed anywhere this module knows about - genuinely fresh
    // machine, or the .exe running with no Launch-ScrollScape.bat alongside
    // it. Best-effort: download one now rather than leaving every
    // Cloudflare-gated source silently broken until someone runs the .bat
    // (or notices and installs FlareSolverr by hand). Only reached with the
    // user's yes (a saved "install" or FLARESOLVERR_AUTO_INSTALL). Never blocks
    // startup - this whole function is already called fire-and-forget from
    // server.js.
    if (io.platform !== 'win32') {
      io.log('[FlareSolverr] The automatic FlareSolverr install only works on Windows; nothing is downloaded. '
        + 'Install FlareSolverr yourself and point the FlareSolverr URL in Settings at it.');
      return;
    }
    try {
      knownExePath = await installFlaresolverr(io);
    } catch (err) {
      io.warn(`[FlareSolverr] Auto-install failed, Cloudflare-gated sources will stay unavailable until it's installed manually: ${err.message}`);
      return;
    }
  }
  // startFlaresolverrIdleWatcher() already ran once at boot, before this install
  // could have finished or this run's answer was known, and no-ops permanently
  // (watcherStarted latches true/false once) when it found nothing or was off
  // that first time - re-running it now that an exe genuinely exists and the
  // answer is yes is what actually arms the watcher for this server run,
  // instead of leaving it dormant until the next full restart.
  io.startWatcher();

  let reason = 'Not reachable at startup, attempting to bring it up';
  if (await io.probe(knownPort)) {
    // A copy started by an older build listens on every interface and still
    // answers on 127.0.0.1, so "reachable" is not enough: restart it pinned
    // to loopback instead of leaving it open to the network. Every listener on
    // the port is looked at, not just the first one: a loopback copy must not
    // hide a wildcard one behind it.
    const exposed = (await findListeners(knownPort, io)).filter((l) => !isLoopbackListenAddress(l.address));
    if (!exposed.length) return;
    // Only ever restart our own FlareSolverr; anything else on that port (a
    // container's port forwarder, say, or a FlareSolverr from another folder)
    // is just reported.
    const findings = await inspectListeners(exposed, knownExePath, io);
    const foreign = findings.filter(isBlocker);
    if (foreign.length) {
      for (const finding of foreign) io.warn(exposedMessage(knownPort, finding, exposed.find((l) => l.pid === finding.pid)));
      return;
    }
    const ours = findings.find((f) => f.verdict === 'ours');
    if (!ours) return;
    reason = `Already running on ${exposed.find((l) => l.pid === ours.pid).address}, reachable from the network; restarting bound to ${FLARESOLVERR_BIND_HOST}`;
  }

  return restartOnce(knownExePath, knownPort, reason, io, 'Startup check failed');
}

module.exports = {
  DEFAULT_IDLE_MINUTES,
  noteFlaresolverrUsed,
  startFlaresolverrIdleWatcher,
  recoverFromHang,
  getRecoveryStatus,
  resetRecoveryBrake,
  checkFlaresolverrIdle,
  ensureFlaresolverrRunning,
  resolveFlaresolverrChoice,
  restartFlaresolverr,
  registerRestartListener,
  installFlaresolverr,
  flaresolverrSpawnEnv,
  isLoopbackListenAddress,
  isDisabled,
  isAutoInstallEnabled,
  isManaged,
  isExpectedAssetUrl,
  parseNetstatListeners,
};
