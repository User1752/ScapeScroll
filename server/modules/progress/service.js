'use strict';

/**
 * server/modules/progress/service.js — the reading progress, kept on the server
 *
 * The chapters read, the page and chapter each manga was left at, the highest chapter number and the flagged chapters lived only in
 * the browser's localStorage, which made them per address (localhost:4000 and 192.168.1.97:4000 are two libraries), per browser, and
 * outside every backup of the server. They live here now, in data/reading-progress.json (its own file: the store is rewritten whole
 * and over a network share a progress change every few seconds must not rewrite it).
 *
 * The browser keeps its copy for speed and offline use and sends CHANGES (ops), never state, so two browsers cannot overwrite each
 * other's reading with an old picture of the library:
 *   readAdd / readRemove / flaggedAdd / flaggedRemove   lists of keys ("<mangaId>:<chapterId>", opaque: ids may contain ':')
 *   last      { mangaId: { c: chapterId, at: ms } | null }   the chapter a manga was left at; the newer `at` wins; null forgets it
 *   highest   { mangaId: number | null }                     only goes up (null forgets it)
 *   pages / totals   { key: number | null }                  the page left at and the page count of a chapter
 *   reset: true   forget everything first (the person chose to replace the server's copy with this browser's)
 *   init:  true   marks the server's copy as started, even when it is empty
 *   legacy: true  the chapters in readAdd were read BEFORE this existed (a browser's first upload): their day is recorded as unknown
 *                 (0) instead of today, so a year-in-review does not see a whole library "read today"
 * Every op is idempotent, so a request sent twice (a retry) changes nothing the second time.
 *
 * The day each chapter was first marked read is kept next to its key (epoch day, UTC; 0 = read before this was recorded). It is
 * not sent to browsers; it is what a year-in-review can be built from.
 */

const fs = require('fs');
const path = require('path');

const MAX_KEY = 600;
const MAX_ID = 400;
const MAX_LIST = 20_000;
const MAX_READ_TOTAL = 500_000;
const MAX_NUMBER = 10_000_000;       // a chapter number, a page, a page count
const MAX_TIME = 8.64e15;            // the largest time a Date holds, in ms: what a browser stamps `last` with
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RETRY_DELAYS_MS = Object.freeze([100, 300, 800, 2000]);

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400, expected: true });
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const epochDay = (ms) => Math.floor(ms / 86_400_000);

const keyList = (v) => (Array.isArray(v) ? v.filter((k) => typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY).slice(0, MAX_LIST) : []);
const number = (v, max = MAX_NUMBER) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null);

// { id: value|null } with every entry checked by `valueOf` (which returns the cleaned value, or undefined to drop the entry)
function entries(v, maxKey, valueOf) {
  if (!isPlainObject(v)) return [];
  const out = [];
  for (const [k, raw] of Object.entries(v).slice(0, MAX_LIST)) {
    if (!k || k.length > maxKey) continue;
    if (raw === null) { out.push([k, null]); continue; }
    const cleaned = valueOf(raw);
    if (cleaned !== undefined) out.push([k, cleaned]);
  }
  return out;
}

function sanitizeOps(input) {
  if (!isPlainObject(input)) throw badRequest('The progress changes must be an object.');
  return {
    reset: input.reset === true,
    init: input.init === true,
    legacy: input.legacy === true,
    readAdd: keyList(input.readAdd),
    readRemove: keyList(input.readRemove),
    flaggedAdd: keyList(input.flaggedAdd),
    flaggedRemove: keyList(input.flaggedRemove),
    last: entries(input.last, MAX_ID, (v) => {
      if (!isPlainObject(v) || typeof v.c !== 'string' || !v.c || v.c.length > MAX_ID) return undefined;
      const at = number(v.at, MAX_TIME);
      return { c: v.c, at: at === null ? 0 : at };
    }),
    highest: entries(input.highest, MAX_ID, (v) => number(v) ?? undefined),
    pages: entries(input.pages, MAX_KEY, (v) => number(v) ?? undefined),
    totals: entries(input.totals, MAX_KEY, (v) => number(v) ?? undefined),
  };
}

function emptyState() {
  return { rev: 0, initialized: false, read: new Map(), flagged: new Set(), last: new Map(), highest: new Map(), pages: new Map(), totals: new Map() };
}

function parseFile(text) {
  const raw = JSON.parse(text);
  if (!isPlainObject(raw)) throw new Error('not an object');
  const s = emptyState();
  s.rev = Number.isInteger(raw.rev) && raw.rev >= 0 ? raw.rev : 0;
  s.initialized = raw.initialized === true;
  if (isPlainObject(raw.read)) for (const [k, d] of Object.entries(raw.read)) s.read.set(k, Number.isInteger(d) && d >= 0 ? d : 0);
  for (const k of keyList(raw.flagged)) s.flagged.add(k);
  if (isPlainObject(raw.last)) for (const [m, v] of Object.entries(raw.last)) if (isPlainObject(v) && typeof v.c === 'string') s.last.set(m, { c: v.c, at: number(v.at, MAX_TIME) ?? 0 });
  for (const [name, map] of [['highest', s.highest], ['pages', s.pages], ['totals', s.totals]]) {
    if (isPlainObject(raw[name])) for (const [k, n] of Object.entries(raw[name])) if (number(n) !== null) map.set(k, n);
  }
  return s;
}

function createProgressService({ filePath, now = () => Date.now(), debounceMs = 5000, log = console, fsImpl = fs, flushOnExit = false } = {}) {
  if (!filePath) throw new Error('createProgressService needs a filePath');
  let state = null;
  let dirty = false;
  let timer = null;
  let writing = Promise.resolve();
  let lastWriteAt = null;

  function load() {
    if (state) return state;
    let text = null;
    try { text = fsImpl.readFileSync(filePath, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') log.warn(`[PROGRESS] could not read ${path.basename(filePath)}: ${err.message}`); }
    if (text === null) { state = emptyState(); return state; }
    try {
      state = parseFile(text);
    } catch (err) {
      // Never start empty over a file that is there: keep it aside (the browsers still hold their copy and upload it again).
      const aside = `${filePath}.corrupt-${now()}`;
      try { fsImpl.renameSync(filePath, aside); } catch (_) { /* the daily copies are the other safety */ }
      log.warn(`[PROGRESS] ${path.basename(filePath)} is not a valid progress file (${err.message}); kept aside as ${path.basename(aside)} and started empty`);
      state = emptyState();
    }
    return state;
  }

  function serialize(s) {
    return JSON.stringify({
      version: 1,
      rev: s.rev,
      initialized: s.initialized,
      updatedAt: new Date(now()).toISOString(),
      read: Object.fromEntries(s.read),
      flagged: [...s.flagged],
      last: Object.fromEntries(s.last),
      highest: Object.fromEntries(s.highest),
      pages: Object.fromEntries(s.pages),
      totals: Object.fromEntries(s.totals),
    });
  }

  async function writeOnce(json) {
    const tmp = `${filePath}.tmp`;
    await fsImpl.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fsImpl.promises.writeFile(tmp, json, 'utf8');
    await fsImpl.promises.rename(tmp, filePath);
  }

  function flush() {
    if (!dirty) return writing;
    dirty = false;
    const json = serialize(load());
    writing = writing.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try { await writeOnce(json); lastWriteAt = now(); return; } catch (err) {
          if (!RETRYABLE.has(err.code) || attempt >= RETRY_DELAYS_MS.length) {
            dirty = true; // not lost: the next change (or the exit) writes it again
            log.warn(`[PROGRESS] could not save the progress file: ${err.message}`);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
        }
      }
    });
    return writing;
  }

  // The write at exit: synchronous, because nothing runs after the exit handlers.
  function flushSync() {
    if (!dirty) return;
    try {
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.sync.tmp`;
      fsImpl.writeFileSync(tmp, serialize(load()), 'utf8');
      fsImpl.renameSync(tmp, filePath);
      dirty = false;
      lastWriteAt = now();
    } catch (err) {
      log.warn(`[PROGRESS] could not save the progress file at exit: ${err.message}`);
    }
  }

  function markDirty() {
    dirty = true;
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, debounceMs);
    timer.unref?.();
  }

  function get() {
    const s = load();
    return {
      rev: s.rev,
      initialized: s.initialized,
      read: [...s.read.keys()],
      flagged: [...s.flagged],
      last: Object.fromEntries(s.last),
      highest: Object.fromEntries(s.highest),
      pages: Object.fromEntries(s.pages),
      totals: Object.fromEntries(s.totals),
    };
  }

  function status() {
    const s = load();
    return { rev: s.rev, initialized: s.initialized, read: s.read.size, flagged: s.flagged.size, mangas: s.last.size, lastWriteAt: lastWriteAt ? new Date(lastWriteAt).toISOString() : null };
  }

  function applyOps(input) {
    const ops = sanitizeOps(input);
    const s = load();
    if (ops.reset) {
      s.read.clear(); s.flagged.clear(); s.last.clear(); s.highest.clear(); s.pages.clear(); s.totals.clear();
    }
    for (const k of ops.readRemove) s.read.delete(k);
    const day = ops.legacy ? 0 : epochDay(now());
    for (const k of ops.readAdd) {
      if (s.read.has(k)) continue;
      if (s.read.size >= MAX_READ_TOTAL) throw Object.assign(new Error('Too many chapters are marked read.'), { statusCode: 413, expected: true });
      s.read.set(k, day);
    }
    for (const k of ops.flaggedRemove) s.flagged.delete(k);
    for (const k of ops.flaggedAdd) s.flagged.add(k);
    for (const [m, v] of ops.last) {
      if (v === null) { s.last.delete(m); continue; }
      const have = s.last.get(m);
      if (!have || v.at >= have.at) s.last.set(m, v);
    }
    for (const [m, v] of ops.highest) {
      if (v === null) { s.highest.delete(m); continue; }
      if (v > (s.highest.get(m) || 0)) s.highest.set(m, v);
    }
    for (const [name, list] of [['pages', ops.pages], ['totals', ops.totals]]) {
      for (const [k, v] of list) { if (v === null) s[name].delete(k); else s[name].set(k, v); }
    }
    const touched = ops.reset || ops.init || ops.readAdd.length || ops.readRemove.length || ops.flaggedAdd.length || ops.flaggedRemove.length
      || ops.last.length || ops.highest.length || ops.pages.length || ops.totals.length;
    if (touched) {
      s.initialized = true;
      s.rev++;
      markDirty();
    }
    return { rev: s.rev, initialized: s.initialized, read: s.read.size };
  }

  // What a year-in-review is built from: chapters first marked read per UTC day (0 = before the day was recorded).
  function readDays() {
    const days = new Map();
    for (const [, day] of load().read) {
      if (!day) continue;
      days.set(day, (days.get(day) || 0) + 1);
    }
    return days;
  }
  function readEntries() { return [...load().read.entries()]; }

  if (flushOnExit) process.on('exit', flushSync);
  return { get, status, applyOps, flush, flushSync, readDays, readEntries, sanitizeOps };
}

module.exports = { createProgressService, sanitizeOps, MAX_LIST, MAX_KEY };
