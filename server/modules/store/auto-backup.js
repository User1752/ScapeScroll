'use strict';

/**
 * server/modules/store/auto-backup.js — automatic copies of data/store.json
 *
 * The library, the reading statuses, the lists and the settings all live in one file, and until now the only copy was the one
 * a person remembered to export by hand (Settings → Data & Backup). Two kinds of copy, both plain copies of the file as it is on
 * disk (it is written by renaming a finished temporary file, so what is on disk is always whole):
 *
 *   daily    data/backups/store-YYYY-MM-DD.json    once a day (at start, then re-checked every few hours). Kept: the newest
 *                                                    `keepDaily` days, then the newest copy of each of the `keepWeekly` weeks before.
 *   safety   data/backups/store-before-<what>-YYYYMMDD-HHMMSS.json
 *                                                    taken just before something replaces much of the library at once (restoring a
 *                                                    backup file, importing from AniList). Kept: the newest `keepSafety`. Taken at
 *                                                    most once per `safetyThrottleMs` for one reason, so a flow that calls the
 *                                                    route many times keeps the copy of the state BEFORE it started.
 *
 * A copy is only made of a file that parses as a JSON object: a damaged store never replaces a good copy, and nothing here ever
 * writes to store.json. Restoring is deliberate and manual: stop the app, copy a file over data/store.json.
 */

const fs = require('fs');
const path = require('path');
const { sleep } = require('../common/async-utils');

// The names of the copies of one file: `<prefix>-YYYY-MM-DD.json` and `<prefix>-before-<what>-YYYYMMDD-HHMMSS.json`. The store's
// are prefixed `store`, the reading progress's `progress`; each is pruned on its own and never touches the other's.
const namesFor = (prefix) => ({
  daily: new RegExp(`^${prefix}-(\\d{4})-(\\d{2})-(\\d{2})\\.json$`),
  safety: new RegExp(`^${prefix}-before-([a-z0-9-]+)-(\\d{8}-\\d{6})\\.json$`),
});
const STORE_NAMES = namesFor('store');

const DEFAULTS = Object.freeze({
  keepDaily: 7,
  keepWeekly: 4,
  keepSafety: 5,
  safetyThrottleMs: 10 * 60_000,
  checkEveryMs: 6 * 60 * 60_000,
  firstCheckDelayMs: 15_000,
});

// ISO 8601 week of a 'YYYY-MM-DD' date ("2026-W44"), by UTC arithmetic so no time zone can move a day.
function isoWeekKey(dateText) {
  const [y, m, d] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

const dailyDateIn = (re) => (name) => { const m = re.exec(name); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };

// Which of the files in the backups folder to delete. Only names this module made are ever returned: anything else in the folder
// (a copy the person put there by hand) is left alone.
function selectBackupsToDelete(names, options = {}) {
  const { keepDaily, keepWeekly, keepSafety, prefix = 'store' } = { ...DEFAULTS, ...options };
  const re = prefix === 'store' ? STORE_NAMES : namesFor(prefix);
  const dailyDate = dailyDateIn(re.daily);
  const remove = [];

  const dailies = names.filter((n) => dailyDate(n)).sort((a, b) => dailyDate(b).localeCompare(dailyDate(a)));
  const older = dailies.slice(keepDaily);
  const weeks = new Set();
  for (const name of older) { // newest first, so the first of a week is the newest of it
    const week = isoWeekKey(dailyDate(name));
    if (!weeks.has(week) && weeks.size < keepWeekly) { weeks.add(week); continue; }
    remove.push(name);
  }

  const safeties = names.filter((n) => re.safety.test(n)).sort((a, b) => re.safety.exec(b)[2].localeCompare(re.safety.exec(a)[2]));
  remove.push(...safeties.slice(keepSafety));
  return remove;
}

const pad = (n) => String(n).padStart(2, '0');
const dateText = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stampText = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

function createAutoBackup({ storePath, backupDir, prefix = 'store', flush = () => {}, now = () => new Date(), fsp = fs.promises, log = console, ...options }) {
  const cfg = { ...DEFAULTS, ...options, prefix };
  const re = prefix === 'store' ? STORE_NAMES : namesFor(prefix);
  const lastSafetyAt = new Map();
  let timers = [];

  async function readStoreFile() {
    // The store is renamed over while it is written: a copy that runs at that very moment can be refused for a moment on Windows.
    for (let attempt = 0; ; attempt++) {
      try { return await fsp.readFile(storePath); }
      catch (err) {
        if (err.code === 'ENOENT') return null;
        if (!RETRYABLE.has(err.code) || attempt >= 3) throw err;
        await sleep(200 * (attempt + 1));
      }
    }
  }

  async function prune() {
    let names;
    try { names = await fsp.readdir(backupDir); } catch (_) { return 0; }
    const doomed = selectBackupsToDelete(names, cfg);
    for (const name of doomed) await fsp.unlink(path.join(backupDir, name)).catch(() => {});
    return doomed.length;
  }

  async function writeCopy(fileName, raw) {
    await fsp.mkdir(backupDir, { recursive: true });
    const target = path.join(backupDir, fileName);
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, raw);
    await fsp.rename(tmp, target);
    return target;
  }

  // A copy of the store as it is on disk right now (after asking the store to write what it still holds in memory).
  // `reason` null = the daily copy; a word = a safety copy before that thing.
  async function snapshot(reason = null) {
    const when = now();
    let fileName;
    let label = null;
    if (reason) {
      label = String(reason).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'change';
      const last = lastSafetyAt.get(label);
      if (last && when.getTime() - last < cfg.safetyThrottleMs) return { ok: false, skipped: 'recent' };
      fileName = `${prefix}-before-${label}-${stampText(when)}.json`;
    } else {
      fileName = `${prefix}-${dateText(when)}.json`;
      try { await fsp.access(path.join(backupDir, fileName)); return { ok: false, skipped: 'exists' }; } catch (_) { /* not there yet */ }
    }
    try { flush(); } catch (_) { /* the copy of what is on disk is still worth making */ }
    const raw = await readStoreFile();
    if (!raw) return { ok: false, skipped: 'no-store' };
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.keys(parsed).length) throw new Error('not a store');
    } catch (_) {
      return { ok: false, skipped: 'invalid-store' };
    }
    const target = await writeCopy(fileName, raw);
    if (label) lastSafetyAt.set(label, when.getTime());
    const removed = await prune();
    return { ok: true, file: target, bytes: raw.length, removed };
  }

  async function list() {
    let names;
    try { names = await fsp.readdir(backupDir); } catch (_) { return []; }
    const files = [];
    for (const name of names.filter((n) => re.daily.test(n) || re.safety.test(n))) {
      try {
        const st = await fsp.stat(path.join(backupDir, name));
        files.push({ name, bytes: st.size, modified: st.mtime.toISOString(), kind: re.daily.test(name) ? 'daily' : 'before-change', of: prefix });
      } catch (_) { /* gone meanwhile */ }
    }
    return files.sort((a, b) => b.modified.localeCompare(a.modified));
  }

  async function runDaily() {
    try {
      const r = await snapshot(null);
      if (r.ok) log.log(`[BACKUP] ${path.basename(r.file)} saved (${Math.round(r.bytes / 1024)} KB)${r.removed ? `, ${r.removed} old removed` : ''}`);
      else if (r.skipped === 'invalid-store') log.warn('[BACKUP] store.json is not a valid store: no copy made, the existing copies are untouched');
      return r;
    } catch (err) {
      log.warn(`[BACKUP] could not make the daily copy: ${err.message}`);
      return { ok: false, skipped: 'error' };
    }
  }

  // Checks at start (after a short delay, off the start-up path) and again every few hours, so a server that is never restarted still
  // gets a copy each day. The timers do not keep the process alive.
  function start() {
    if (timers.length) return;
    timers = [
      setTimeout(runDaily, cfg.firstCheckDelayMs),
      setInterval(runDaily, cfg.checkEveryMs),
    ];
    for (const t of timers) t.unref?.();
  }

  function stop() {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers = [];
  }

  return { snapshot, runDaily, list, start, stop };
}

// The instance server.js configures; routes call snapshot() on it and it does nothing before it is configured (so a route
// can be used in a test that never starts the whole server).
// `extraFiles`: other files kept the same way, each { path, prefix, flush? } (the reading progress is one).
let instances = [];
const configure = (opts) => {
  for (const i of instances) i.stop();
  const { extraFiles = [], ...main } = opts;
  instances = [
    createAutoBackup(main),
    ...extraFiles.map((f) => createAutoBackup({ ...main, storePath: f.path, prefix: f.prefix, flush: f.flush || (() => {}) })),
  ];
  return instances[0];
};
const safetySnapshot = async (reason) => {
  if (!instances.length) return { ok: false, skipped: 'not-configured' };
  let first = null;
  for (const i of instances) {
    let r;
    try { r = await i.snapshot(reason); } catch (err) { r = { ok: false, skipped: 'error', error: err.message }; }
    first = first || r; // the answer is the store's; the others are taken alongside it
  }
  return first;
};
const listBackups = async () => (await Promise.all(instances.map((i) => i.list()))).flat().sort((a, b) => b.modified.localeCompare(a.modified));
const start = () => instances.forEach((i) => i.start());

module.exports = { createAutoBackup, selectBackupsToDelete, isoWeekKey, configure, safetySnapshot, listBackups, start, DEFAULTS };
