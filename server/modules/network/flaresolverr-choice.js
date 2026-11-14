'use strict';

/**
 * The one-time "set up FlareSolverr?" question, and the file that remembers it.
 *
 * FlareSolverr is a third-party browser-automation tool that Cloudflare-
 * protected sources need. Downloading and running it is the user's call, so the
 * first interactive launch asks once and remembers the answer in
 * data/setup.json ("install" or "skip").
 *
 *   s / y / yes / sim  -> saves "install"
 *   n / no / nao       -> saves "skip" (never asked again)
 *   Enter, or no answer in time -> "not now": nothing is saved, asked again next launch
 *
 * Delete data/setup.json to be asked again. The file is also meant to be edited
 * by hand, so it is read leniently (see readSetupState) - but a file that
 * exists and cannot be understood is never read as "no answer" quietly: that
 * would let a declined install start anyway.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SETUP_FILE = 'setup.json';
const ASK_TIMEOUT_MS = 30000;
// Keys pressed while the exe was still unpacking are already waiting in the
// console buffer when the question appears; this is how long they get to arrive
// so they can be thrown away instead of being taken as the answer.
const DRAIN_MS = 150;
const MAX_TRIES = 3;

// What a hand-edited (or tool-edited) setup.json may say. Compared lower-case.
const INSTALL_WORDS = new Set(['install', 'yes', 'y', 's', 'sim', 'true', 'on']);
const SKIP_WORDS = new Set(['skip', 'no', 'n', 'nao', 'não', 'false', 'off']);

function setupPath(root) {
  return path.join(root, 'data', SETUP_FILE);
}

/**
 * @param {unknown} value what setup.json holds under "flaresolverr"
 * @returns {'install'|'skip'|null} null when the value is not a recognised answer
 */
function normalizeChoice(value) {
  if (value === true) return 'install';
  if (value === false) return 'skip';
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase();
  if (INSTALL_WORDS.has(word)) return 'install';
  if (SKIP_WORDS.has(word)) return 'skip';
  return null;
}

// Windows tools write setup.json with a byte-order mark more often than not:
// Set-Content -Encoding UTF8 and most editors add the UTF-8 one, and
// PowerShell 5.1's ">" / Out-File write UTF-16LE. JSON.parse chokes on both,
// which used to turn a saved "skip" into "no answer".
function decodeText(raw) {
  if (typeof raw === 'string') return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  if (raw[0] === 0xFF && raw[1] === 0xFE) return raw.subarray(2).toString('utf16le');
  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) return raw.subarray(3).toString('utf8');
  return raw.toString('utf8');
}

/**
 * Reads data/setup.json.
 *   missing - there is no file: the question has never been answered
 *   ok      - it parsed; `choice` is the answer, or null when it holds none
 *   invalid - it exists but cannot be used (unreadable, not JSON, not an object,
 *             or an answer that is not install/skip). Callers must treat this as
 *             "unanswered, and do not start anything until the user answers".
 * @returns {{ status: 'missing'|'ok'|'invalid', data: object, choice: 'install'|'skip'|null, reason?: string }}
 */
function readSetupState(root, fsImpl = fs) {
  let raw;
  try {
    raw = fsImpl.readFileSync(setupPath(root));
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { status: 'missing', data: {}, choice: null };
    return { status: 'invalid', data: {}, choice: null, reason: `cannot be read (${err && err.message})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(decodeText(raw));
  } catch (err) {
    return { status: 'invalid', data: {}, choice: null, reason: `is not valid JSON (${err.message})` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'invalid', data: {}, choice: null, reason: 'must hold a JSON object such as {"flaresolverr":"skip"}' };
  }
  const value = parsed.flaresolverr;
  if (value === undefined || value === null || value === '') return { status: 'ok', data: parsed, choice: null };
  const choice = normalizeChoice(value);
  if (!choice) {
    return { status: 'invalid', data: parsed, choice: null, reason: `has "flaresolverr": ${JSON.stringify(value)}, expected "install" or "skip"` };
  }
  return { status: 'ok', data: parsed, choice };
}

/** @returns {'install'|'skip'|null} */
function readChoice(root, fsImpl = fs) {
  return readSetupState(root, fsImpl).choice;
}

/**
 * Saves the answer next to whatever else setup.json holds. Written to a
 * temporary file and renamed over the real one, so a crash or a full disk can
 * never leave a half-written (and therefore "unanswered") setup.json behind.
 * @returns {boolean} whether the answer reached the disk
 */
function writeChoice(root, choice, fsImpl = fs, log = console.log) {
  const file = setupPath(root);
  const temp = `${file}.${process.pid}.tmp`;
  try {
    const current = readSetupState(root, fsImpl);
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    if (current.status === 'invalid') {
      // The user's hand-edited file is about to be replaced: keep a copy.
      try { fsImpl.copyFileSync(file, `${file}.bad`); } catch (_) { /* nothing to keep, or the copy failed */ }
    }
    fsImpl.writeFileSync(temp, JSON.stringify({ ...current.data, flaresolverr: choice }, null, 2));
    fsImpl.renameSync(temp, file);
    return true;
  } catch (err) {
    try { fsImpl.rmSync(temp, { force: true }); } catch (_) { /* best effort */ }
    log(`[Setup] Could not save your FlareSolverr choice (${err.message}); you will be asked again next time.`);
    return false;
  }
}

/**
 * @param {string} text what the user typed
 * @returns {'install'|'skip'|'later'|undefined} undefined = not understood; 'later' = just Enter
 */
function parseAnswer(text) {
  const answer = String(text || '').trim().toLowerCase();
  if (['y', 'yes', 's', 'sim'].includes(answer)) return 'install';
  if (['n', 'no', 'nao', 'não'].includes(answer)) return 'skip';
  if (answer === '') return 'later'; // a stray Enter must not opt out for good
  return undefined;
}

// Throws away anything already sitting in `input`. A stream that holds data in
// its own buffer is emptied at once; a real console is given `settleMs` to
// deliver its type-ahead, which is discarded as it arrives.
function drainInput(input, settleMs) {
  try {
    while (typeof input.read === 'function' && input.read() !== null) { /* thrown away on purpose */ }
  } catch (_) { /* a stream that cannot be read has nothing buffered */ }
  if (!settleMs || typeof input.on !== 'function') return Promise.resolve();
  return new Promise((resolve) => {
    const discard = () => {};
    input.on('data', discard);
    if (typeof input.resume === 'function') input.resume();
    setTimeout(() => {
      input.off('data', discard);
      resolve();
    }, settleMs);
  });
}

/**
 * Asks on the console. Answer rules are in the file header: Enter is "not now"
 * (nothing saved), n/no saves "skip", s/y/yes/sim saves "install".
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, timeoutMs?: number, drainMs?: number, toolsDir?: string, setupFile?: string }} [options]
 * @returns {Promise<'install'|'skip'|null>} null when nobody (or nobody clearly) answered; nothing is saved then
 */
async function askChoice({ input = process.stdin, output = process.stdout, timeoutMs = ASK_TIMEOUT_MS, drainMs = DRAIN_MS, toolsDir, setupFile } = {}) {
  // Only a real console has type-ahead that arrives late; a plain stream is
  // already fully buffered, so the wait would only swallow its next write.
  await drainInput(input, input.isTTY ? drainMs : 0);
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    let tries = 0;
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off('data', onKey);
      rl.close();
      resolve(value);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        output.write('\n[Setup] No answer: continuing without FlareSolverr this time. You will be asked again next launch.\n');
        finish(null);
      }, timeoutMs);
      timer.unref?.();
    };
    // Someone who is typing has not walked away: every key (or pasted chunk)
    // gives them the full time again instead of cutting them off mid-word.
    function onKey() { if (!done) arm(); }
    input.on('data', onKey);
    arm();
    // Ctrl+C at the prompt means "stop", not "no answer": hand it to the normal
    // shutdown path (store flush, Discord clear) instead of carrying on booting.
    rl.on('SIGINT', () => {
      output.write('\n');
      done = true;
      clearTimeout(timer);
      process.emit('SIGINT');
      process.exit(130);
    });
    rl.on('close', () => finish(null));

    output.write('\n[Setup] First run / Primeira execucao\n'
      + '        FlareSolverr (optional): a third-party tool from github.com/FlareSolverr/FlareSolverr,\n'
      + '        several hundred MB, that opens sources protected by Cloudflare. It only listens on this\n'
      + '        computer (127.0.0.1). Without it those sources stay unavailable.\n'
      + (toolsDir ? `        It would be installed in ${toolsDir}\n` : '')
      + '        Install it? / Instalar?\n');
    const prompt = () => {
      rl.question('        [y/s = yes/sim, n = no/nao (remembered), Enter = not now]: ', (text) => {
        const choice = parseAnswer(text);
        if (choice === 'install') {
          output.write('        Installing... this can take a few minutes; ScrollScape stays usable meanwhile.\n');
        } else if (choice === 'skip') {
          output.write(`        Skipped.${setupFile ? ` To change your mind delete ${setupFile}.` : ''}\n`);
        } else if (choice === 'later') {
          output.write('        Not now. You will be asked again next launch; type n to stop being asked.\n');
          return finish(null);
        }
        if (choice) return finish(choice);
        tries += 1;
        if (tries >= MAX_TRIES) {
          output.write('        Not understood; continuing without FlareSolverr this time (you will be asked again).\n');
          return finish(null);
        }
        output.write('        Not understood. Answer y / s (yes) or n (no).\n');
        return prompt();
      });
    };
    prompt();
  });
}

/**
 * The command line Launch-ScrollScape.bat uses (through install_flaresolverr.js),
 * so the launcher reads and writes data/setup.json with exactly the rules the
 * server uses instead of re-implementing JSON parsing in batch.
 *   --choice            prints one word on stdout: install | skip | none | invalid
 *   --save install|skip saves the answer
 * Diagnostics go to stderr so they stay visible when the .bat captures stdout.
 * @returns {number} the process exit code
 */
function runLauncherCommand(args, { root, fsImpl = fs, out = console.log, err = console.error } = {}) {
  const [command, value] = args;
  if (command === '--choice') {
    const state = readSetupState(root, fsImpl);
    if (state.status === 'invalid') {
      err(`[Setup] ${setupPath(root)} ${state.reason}. FlareSolverr stays off until you fix or delete that file.`);
      out('invalid');
    } else {
      out(state.choice || 'none');
    }
    return 0;
  }
  if (command === '--save') {
    if (value !== 'install' && value !== 'skip') {
      err('[Setup] Usage: --save install|skip');
      return 2;
    }
    return writeChoice(root, value, fsImpl, err) ? 0 : 1;
  }
  err('[Setup] Usage: --choice | --save install|skip');
  return 2;
}

module.exports = { readChoice, readSetupState, normalizeChoice, writeChoice, parseAnswer, askChoice, setupPath, runLauncherCommand };
