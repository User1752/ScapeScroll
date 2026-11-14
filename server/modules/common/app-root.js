'use strict';

/**
 * Where the packaged .exe keeps the files it creates (data/, Local/, tools/).
 *
 * Next to the .exe is the only sensible place for a portable build, but people
 * run it straight from Downloads or the Desktop, and then data/, Local/ and
 * tools/ end up loose among everything else in that folder. So a NEW install
 * gets its own "ScrollScape" folder beside the .exe, unless the .exe already
 * lives in a folder with ScrollScape in its name.
 *
 * Nothing is ever deleted, moved or rewritten here: resolving only looks (and
 * creates the empty "ScrollScape" folder for a brand-new install). An install
 * that already sits loose next to the .exe keeps being used where it is
 * (renaming a library out from under a running app, an open FlareSolverr or
 * antivirus is not worth the risk); the log says how to relocate it.
 *
 * The one failure this file must never cause is HIDING a library: starting a
 * blank one beside the real one, so the user opens the app and finds it empty.
 * So every question about "does something live here?" is answered
 * pessimistically. Only a definite "no such file" (ENOENT) means missing; any
 * other error (antivirus, a sync client, a flaky share) means "exists, cannot
 * look right now" and counts as a library.
 *
 * Which folder wins, when none of the overrides below is set:
 *   - only one of "next to the .exe" and "ScrollScape\" holds an install: that one;
 *   - neither: a new ScrollScape\ is created;
 *   - both: the one holding real data. If ScrollScape\ is blank (an earlier
 *     start that found nothing and created it), the loose one wins. If BOTH hold
 *     data the app refuses to start and says how to choose, because guessing
 *     wrong looks exactly like losing the library.
 * A loose install is recognised by ANY of: data\store.json, a non-empty
 * data\sources, Local, data\cache or tools\flaresolverr. The old code looked at
 * store.json alone, so loose books and sources without one were orphaned.
 *
 * Overrides: SCROLLSCAPE_HOME=<full path> uses that folder as is (and the app
 * stops if it is not an absolute path or cannot be written, rather than quietly
 * starting a blank library elsewhere); SCROLLSCAPE_PORTABLE=1|true|yes|on keeps
 * everything right next to the .exe. When an override (or the project-folder
 * shortcut) skips a folder that holds a library, the log says so.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const PROJECT_DIR_NAME = 'ScrollScape';
const INSTALL_MARKER = path.join('data', 'store.json');
const LOCK_FILE = path.join('data', '.scrollscape.lock');
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 30 * 1000;
// A lock file whose owner cannot be read yet, younger than this, is another
// process in the middle of writing it.
const LOCK_MID_START_MS = 2000;
// How long the takeover guard may sit before it is assumed to be a crash leftover.
const GUARD_STALE_MS = 10 * 1000;
const LOCK_ATTEMPTS = 6;

const ENV_ON = /^(1|true|yes|on)$/i;

// Folders that make a place "a ScrollScape install" even when store.json is
// gone. PRECIOUS ones hold things the app cannot recreate (sources the user
// dropped in, imported books), so a place that has them counts as holding data.
// REGENERABLE ones are rebuilt on demand (cover cache, the FlareSolverr
// download): they prove an install lived there, but are not worth refusing to
// start over.
const PRECIOUS_DIRS = [path.join('data', 'sources'), 'Local'];
const REGENERABLE_DIRS = [path.join('data', 'cache'), path.join('tools', 'flaresolverr')];

// Top-level store keys the app fills in on its own, or that are preferences
// rather than library content. A store that only differs from a fresh one in
// these (a session that browsed sources and changed a setting) is still "blank";
// anything else holding a value counts as the user's data, including keys this
// file has never heard of.
const NOT_LIBRARY_KEYS = new Set([
  'installedSources', 'settings', 'analytics', 'anilistSync', 'imageHealthBaseline', 'activeTheme',
]);

function looksLikeProjectDir(dir) {
  return /scrollscape/i.test(path.basename(dir));
}

const isMissing = (err) => !!err && err.code === 'ENOENT';

function hasContent(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.values(value).some(hasContent);
  return !!value; // 0, '', false, null and undefined are the empty values of a fresh store
}

/**
 * True for a parsed store that holds nothing of the user's: favorites, history,
 * custom lists, reading status, categories, tags, overrides, reviews, repos,
 * achievements and downloads all empty (see server/modules/store/schema.js for
 * the shape). The defaults normaliseStore fills in (zeroed counters, the
 * 'default' theme) do not count.
 */
function isBlankLibrary(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) return false;
  return !Object.keys(store).some((key) => {
    if (NOT_LIBRARY_KEYS.has(key)) return false;
    if (key === 'purchasedThemes') {
      return Array.isArray(store[key]) ? store[key].some((theme) => theme !== 'default') : hasContent(store[key]);
    }
    return hasContent(store[key]);
  });
}

/**
 * What is at `file`, and is it blank?
 *  - 'library' : a JSON object. Whatever keys it has, it is the user's library
 *                (an older or newer ScrollScape may lack ours, a hand edit may
 *                add others); hiding it would be worse than a wrong guess
 *  - 'corrupt' : not parseable, or not an object. Treated as the user's library
 *                too: the app's own startup deals with a corrupt store, and a
 *                sibling library is never created beside it
 *  - 'empty'   : zero bytes or whitespace only. Nothing to lose
 *  - 'missing' : ENOENT, and only ENOENT
 *  - 'unknown' : exists but could not be stat'ed or read right now (antivirus or
 *                a sync client holding it, an I/O error on a share). Treated as
 *                the user's library by the callers
 */
function readStoreInfo(file, fsImpl = fs) {
  try {
    fsImpl.statSync(file);
  } catch (err) {
    return { state: isMissing(err) ? 'missing' : 'unknown', blank: false };
  }
  let text;
  try {
    text = String(fsImpl.readFileSync(file, 'utf8'));
  } catch (err) {
    return { state: isMissing(err) ? 'missing' : 'unknown', blank: false };
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // a hand edit in Notepad can leave a BOM
  if (text.trim() === '') return { state: 'empty', blank: true };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { state: 'corrupt', blank: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'corrupt', blank: false };
  return { state: 'library', blank: isBlankLibrary(parsed) };
}

function classifyStore(file, fsImpl = fs) {
  return readStoreInfo(file, fsImpl).state;
}

/** 'missing' | 'empty' | 'nonempty' | 'unknown' (cannot be listed right now, so assume something is there). */
function dirState(dir, fsImpl = fs) {
  try {
    return fsImpl.readdirSync(dir).length > 0 ? 'nonempty' : 'empty';
  } catch (err) {
    return isMissing(err) ? 'missing' : 'unknown';
  }
}

/**
 * Looks at one candidate root without touching it.
 *  - present : anything there says "a ScrollScape install lives here"
 *  - real    : it holds data that must not be hidden (see the file header)
 * `storeOnly` skips the folder markers; it is for places where a generic name
 * such as "Local" would only produce false alarms.
 */
function inspectRoot(dir, fsImpl = fs, { storeOnly = false } = {}) {
  const { state, blank } = readStoreInfo(path.join(dir, INSTALL_MARKER), fsImpl);
  const reasons = [];
  if (state === 'library' && !blank) reasons.push(`${INSTALL_MARKER} with your library in it`);
  else if (state === 'corrupt') reasons.push(`${INSTALL_MARKER} (not a readable library file)`);
  else if (state === 'unknown') reasons.push(`${INSTALL_MARKER} (could not be read just now)`);

  const found = (names) => (storeOnly ? [] : names.flatMap((name) => {
    const s = dirState(path.join(dir, name), fsImpl);
    if (s === 'nonempty') return [name];
    return s === 'unknown' ? [`${name} (could not be read just now)`] : [];
  }));
  const precious = found(PRECIOUS_DIRS);
  const leftovers = found(REGENERABLE_DIRS);

  return {
    dir,
    store: state,
    blank,
    precious,
    leftovers,
    present: state !== 'missing' || precious.length > 0 || leftovers.length > 0,
    real: reasons.length > 0 || precious.length > 0,
    reasons: [...reasons, ...precious],
  };
}

function isAbsoluteEnough(p) {
  if (!path.isAbsolute(p)) return false;
  // On Windows "\data" counts as absolute but still depends on the current drive.
  const { root } = path.parse(p);
  return !(path.sep === '\\' && (root === '\\' || root === '/'));
}

function pathKey(p) {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** The folder must really accept files: creating one is the only reliable test (a read-only folder passes mkdir -p). */
function assertWritable(dir, fsImpl) {
  const probe = path.join(dir, `.scrollscape-write-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  fsImpl.writeFileSync(probe, '', { flag: 'wx' });
  try {
    fsImpl.unlinkSync(probe);
  } catch { /* a stray empty file is harmless, and the write already proved the folder works */ }
}

/**
 * Logs a warning for every candidate that holds a library but is not the
 * folder being used, so a choice made by an override is never silent.
 */
function warnAboutBypassed(chosen, candidates, fsImpl, log, hint) {
  const seen = new Set([pathKey(chosen)]);
  for (const candidate of candidates) {
    const key = pathKey(candidate.dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (inspectRoot(candidate.dir, fsImpl, { storeOnly: !!candidate.storeOnly }).real) {
      log(`[Setup] Warning: a library also exists at ${candidate.dir} and is NOT being used. ${hint}`);
    }
  }
}

function conflictError(loose, home) {
  const describe = (info) => `    ${info.dir}\n      holds: ${info.reasons.join(', ')}`;
  return Object.assign(new Error(
    'Two ScrollScape libraries were found and both hold data:\n'
    + `${describe(loose)}\n${describe(home)}\n`
    + 'ScrollScape will not guess which one is yours: starting the wrong one would look as if your library had '
    + 'been wiped (nothing has been deleted or changed). To choose, either set SCROLLSCAPE_HOME to the full path '
    + `of the folder you want (for example SCROLLSCAPE_HOME=${home}), or move the other folder somewhere else and `
    + 'start again.',
  ), { code: 'SCROLLSCAPE_LIBRARY_CONFLICT' });
}

function resolveHomeOverride(override, exeDir, fsImpl, log) {
  if (!isAbsoluteEnough(override)) {
    throw new Error(`SCROLLSCAPE_HOME="${override}" is not a full path. A relative path would point at a different `
      + 'folder depending on where ScrollScape is started from, so it is not accepted. Use the full path, for example '
      + `${path.join(exeDir, PROJECT_DIR_NAME)}, or unset the variable.`);
  }
  const dir = path.resolve(override);
  let created = false;
  try {
    fsImpl.statSync(dir);
  } catch (err) {
    created = isMissing(err);
  }
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    assertWritable(dir, fsImpl);
  } catch (err) {
    throw new Error(`SCROLLSCAPE_HOME=${dir} cannot be used (${err.message}). `
      + 'Fix the path or unset the variable; refusing to start an empty library somewhere else.', { cause: err });
  }
  log(`[Setup] Data folder: ${dir} (SCROLLSCAPE_HOME)`);
  if (created) log(`[Setup] Note: ${dir} did not exist and was created. If SCROLLSCAPE_HOME has a typo, your library is not here.`);
  warnAboutBypassed(dir, [
    { dir: exeDir },
    { dir: path.join(exeDir, PROJECT_DIR_NAME) },
  ], fsImpl, log, 'To use it, point SCROLLSCAPE_HOME at that folder (or unset it).');
  return dir;
}

/**
 * @param {{ execPath?: string, env?: NodeJS.ProcessEnv, fsImpl?: typeof fs, log?: (msg: string) => void }} [options]
 * @returns {string} the folder to use as the app's user root
 * @throws when SCROLLSCAPE_HOME is set but cannot be used, or when two libraries
 *   both hold data (err.code === 'SCROLLSCAPE_LIBRARY_CONFLICT'). The caller
 *   (server.js resolveUserRootOrExit) prints err.message and exits.
 */
function resolveAppRoot({ execPath = process.execPath, env = process.env, fsImpl = fs, log = console.log } = {}) {
  const exeDir = path.dirname(execPath);
  const home = path.join(exeDir, PROJECT_DIR_NAME);

  const override = String(env.SCROLLSCAPE_HOME || '').trim();
  if (override) return resolveHomeOverride(override, exeDir, fsImpl, log);

  const portable = ENV_ON.test(String(env.SCROLLSCAPE_PORTABLE || '').trim());
  const inProjectDir = looksLikeProjectDir(exeDir);
  if (portable || inProjectDir) {
    log(`[Setup] Data folder: ${exeDir}`);
    const candidates = [{ dir: home }];
    // An exe moved into a folder named after the project often leaves its old
    // library one level up. Only a store.json is checked there: the parent is
    // usually Downloads or the Desktop, where "Local" would be a false alarm.
    if (inProjectDir && !portable) candidates.push({ dir: path.dirname(exeDir), storeOnly: true });
    warnAboutBypassed(exeDir, candidates, fsImpl, log, 'To use it, set SCROLLSCAPE_HOME to that folder.');
    return exeDir;
  }

  const loose = inspectRoot(exeDir, fsImpl);
  const scoped = inspectRoot(home, fsImpl);
  const looseStore = path.join(exeDir, INSTALL_MARKER);
  if (loose.store === 'unknown') log(`[Setup] Warning: could not read ${looseStore} right now; treating it as your library.`);
  if (loose.store === 'corrupt') log(`[Setup] Warning: ${looseStore} is not a readable library file; keeping this folder so nothing is hidden.`);

  if (loose.present && scoped.present) {
    // Never prefer ScrollScape\ blindly: an earlier start may have created it
    // blank while the real library sat beside the exe.
    if (loose.real && scoped.real) {
      // "Local" and "data\sources" are generic names. Next to the exe they only say
      // "something is here"; with no store.json beside them there is no second
      // LIBRARY to hide, so refusing to start would be a false alarm (a Downloads
      // folder with an unrelated "Local" folder next to a working ScrollScape\).
      // The folders are named in the log so nothing is silently ignored.
      if (loose.store === 'missing') {
        log(`[Setup] Data folder: ${home}. Warning: ${exeDir} also has ${loose.precious.join(', ')} but no `
          + `${INSTALL_MARKER}, so it is not used. If those hold your books or sources, set SCROLLSCAPE_HOME to ${exeDir}.`);
        return home;
      }
      throw conflictError(loose, scoped);
    }
    if (loose.real) {
      log(`[Setup] Data folder: ${exeDir}. ${home} exists but holds no library data, so it is not used.`);
      return exeDir;
    }
    // ScrollScape\ holds the data, or neither side does and the designated home wins.
    log(`[Setup] Data folder: ${home}. ${exeDir} also has a ScrollScape install, but no library data, so it is not used.`);
    return home;
  }
  if (loose.present) {
    log(`[Setup] Data folder: ${exeDir} (an existing library is already here). To tidy it into ${home}, close `
      + 'ScrollScape and FlareSolverr, move the data, Local and tools\\flaresolverr folders there, and start again.');
    return exeDir;
  }
  log(`[Setup] Data folder: ${home}`);
  if (scoped.present) return home;
  try {
    fsImpl.mkdirSync(home, { recursive: true });
    return home;
  } catch (err) {
    log(`[Setup] Could not create ${home} (${err.message}); using ${exeDir}.`);
    return exeDir;
  }
}

let cached = null;
/** The resolved root for this process; computed once. */
function getAppRoot() {
  if (cached === null) cached = resolveAppRoot();
  return cached;
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function currentHostname() {
  try {
    return os.hostname();
  } catch {
    return '';
  }
}

/** Reads the lock file once: who owns it, how old it is. `gone` means it vanished (ENOENT). */
function inspectLock(file, fsImpl, now) {
  let raw = null;
  let mtimeMs = NaN;
  try {
    raw = String(fsImpl.readFileSync(file, 'utf8'));
  } catch (err) {
    if (isMissing(err)) return { gone: true };
    /* unreadable: judged below as an owner we know nothing about */
  }
  try {
    mtimeMs = fsImpl.statSync(file).mtimeMs;
  } catch (err) {
    if (isMissing(err)) return { gone: true };
  }
  const lines = raw === null ? [] : raw.split('\n');
  return {
    gone: false,
    raw,
    mtimeMs,
    ageMs: Number.isFinite(mtimeMs) ? now() - mtimeMs : Infinity,
    owner: parseInt(String(lines[0] ?? '').trim(), 10),
    host: String(lines[1] ?? '').trim(),
  };
}

/**
 * One running ScrollScape per library: two processes keep separate in-memory
 * copies of store.json and overwrite each other.
 *
 * The lock is ADVISORY and SAME-MACHINE: a file holding the owner's PID and
 * hostname is created exclusively and its modification time is refreshed while
 * the owner runs. It counts as stale when the PID is gone OR the file has not
 * been touched for two minutes (a killed process, a closed console window and a
 * reused PID all leave a lock behind). A PID is only meaningful on the PC that
 * wrote it, so a lock written by another host (a library on a share, a synced
 * folder) is never checked against this PC's process table; only how recently it
 * was refreshed counts. Clock skew between PCs and a suspended owner can still
 * fool it. It protects against a double click, not against two machines.
 *
 * If the lock cannot be taken for an environmental reason (read-only folder,
 * antivirus), the app starts anyway. Contention is different and fails CLOSED:
 * a stale lock is only removed by whoever holds a short-lived guard file and
 * after re-reading it unchanged; our own lock is read back after it is created;
 * and running out of attempts reports "already running" rather than starting
 * without a lock.
 *
 * @returns {{ ok: true, release: () => void } | { ok: false, pid: number, file: string, host?: string } | { ok: true, release: () => void, warning: string }}
 */
function acquireInstanceLock(root, {
  pid = process.pid,
  fsImpl = fs,
  isAlive = defaultIsAlive,
  now = () => Date.now(),
  startHeartbeat = true,
  hostname = currentHostname(),
} = {}) {
  const file = path.join(root, LOCK_FILE);
  const guard = `${file}.takeover`;
  const mine = `${pid}\n${hostname}\n`;
  const noop = { ok: true, release() {} };
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  } catch (err) {
    return { ...noop, warning: `could not prepare ${path.dirname(file)} (${err.message})` };
  }

  const owned = () => {
    let timer = null;
    if (startHeartbeat) {
      timer = setInterval(() => {
        try {
          const t = new Date(now());
          fsImpl.utimesSync(file, t, t);
        } catch { /* best effort */ }
      }, LOCK_HEARTBEAT_MS);
      timer.unref?.();
    }
    return {
      ok: true,
      release() {
        if (timer) clearInterval(timer);
        try {
          if (String(fsImpl.readFileSync(file, 'utf8')) === mine) fsImpl.unlinkSync(file);
        } catch { /* already gone */ }
      },
    };
  };

  // After our exclusive create, the file must still hold exactly what we wrote:
  // a contender that judged the previous lock stale may have removed ours.
  const stillMine = () => {
    try {
      return String(fsImpl.readFileSync(file, 'utf8')) === mine;
    } catch (err) {
      // Gone means retry. Merely unreadable proves nothing: the exclusive create worked.
      return !isMissing(err);
    }
  };

  const sameHost = (seen) => !seen.host || !hostname || seen.host.toLowerCase() === hostname.toLowerCase();

  const isLive = (seen) => {
    // Owner not readable yet and the file brand new: another process mid-start.
    if (!Number.isFinite(seen.owner)) return seen.ageMs < LOCK_MID_START_MS;
    if (seen.ageMs >= LOCK_STALE_MS) return false;
    // A PID from another PC says nothing about this one; the fresh mtime is all there is.
    if (!sameHost(seen)) return true;
    return seen.owner !== pid && isAlive(seen.owner);
  };

  // Removes the lock we judged stale. Returns undefined to go round again, or a final result.
  const takeOver = (seen) => {
    try {
      fsImpl.writeFileSync(guard, mine, { flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') return { ...noop, warning: `could not prepare to replace the stale ${file} (${err.message})` };
      // Someone else is replacing the stale lock right now; they are about to be the running instance.
      let guardAge = 0;
      try {
        guardAge = now() - fsImpl.statSync(guard).mtimeMs;
      } catch (statErr) {
        if (isMissing(statErr)) return undefined;
      }
      if (guardAge < GUARD_STALE_MS) return { ok: false, pid: NaN, file: guard };
      try {
        fsImpl.unlinkSync(guard); // left behind by a crash mid-takeover
      } catch { /* the next attempt reports it */ }
      return undefined;
    }
    try {
      const again = inspectLock(file, fsImpl, now);
      // Only remove what we judged stale: if it changed, somebody replaced it first.
      if (again.gone) return undefined;
      if (again.raw !== seen.raw || !Object.is(again.mtimeMs, seen.mtimeMs)) return undefined;
      try {
        fsImpl.unlinkSync(file);
      } catch (err) {
        if (!isMissing(err)) return { ...noop, warning: `a stale ${file} could not be removed (${err.message})` };
      }
      return undefined;
    } finally {
      try {
        fsImpl.unlinkSync(guard);
      } catch { /* best effort; it expires */ }
    }
  };

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    let created = false;
    try {
      fsImpl.writeFileSync(file, mine, { flag: 'wx' });
      created = true;
    } catch (err) {
      if (err.code !== 'EEXIST') return { ...noop, warning: `could not create ${file} (${err.message})` };
    }
    if (created) {
      if (stillMine()) return owned();
      continue;
    }

    const seen = inspectLock(file, fsImpl, now);
    if (seen.gone) continue; // removed between our create and our read: just create it again
    if (isLive(seen)) {
      const local = sameHost(seen);
      return { ok: false, pid: local ? seen.owner : NaN, file, ...(local ? {} : { host: seen.host }) };
    }
    const result = takeOver(seen);
    if (result) return result;
  }
  return { ok: false, pid: NaN, file };
}

module.exports = {
  resolveAppRoot,
  getAppRoot,
  acquireInstanceLock,
  classifyStore,
  inspectRoot,
  isBlankLibrary,
  looksLikeProjectDir,
  PROJECT_DIR_NAME,
  LOCK_STALE_MS,
  GUARD_STALE_MS,
};
