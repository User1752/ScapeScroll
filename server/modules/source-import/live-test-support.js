'use strict';

const { stripLocalPaths } = require('./failure');

// What every check of the live test (live-test.js and the three files of checks beside it) shares: the limits, the ids of the
// checks, the small readers of what a source answers, and the machinery of a run: one budgeted, spaced, timed call to the
// source; one check that turns a throw into a result; the counters. Nothing here knows what a check looks for.

const DEFAULT_LIMITS = Object.freeze({
  maxCalls: 45,            // calls to the source's own functions
  maxImages: 5,            // images fetched: the first, the last, the middle and two more
  spacingMs: 600,          // pause between two calls (the shared fetch helpers also space requests per host)
  imageSpacingMs: 400,
  callTimeoutMs: 45_000,   // what the app itself allows a call (routes/sources.js)
  pagesTimeoutMs: 90_000,
  maxConsecutiveFailures: 3,
  maxDurationMs: 5 * 60_000, // the whole run
});

const CORE_CHECKS = Object.freeze(['browse', 'details', 'chapters', 'pages', 'images']);
// Every id a check can have: the Settings card has a translated title for each (a test keeps the two lists equal).
const CHECK_IDS = Object.freeze([
  'browse', 'search-page-2', 'search-past-end', 'search-text', 'details', 'chapters', 'pages', 'images', 'missing-title', 'bad-ids',
  'never-listed', 'declared-genres', 'declared-sort', 'declared-publicationStatus', 'declared-contentRating', 'declared-format',
  'list-trending', 'list-latestUpdates', 'list-recentlyAdded', 'list-popularAllTime',
  // the checks of an anime source (modules/anime-sources/live-test.js), shown by the same card
  'anime-stream', 'anime-playlist', 'anime-variant', 'anime-segment', 'anime-subtitles', 'anime-bad-input', 'anime-past-end',
]);

class Abort extends Error {}
class Budget extends Error {}

const isBadInputStatus = (err) => !!err && (err.statusCode === 400 || err.statusCode === 404);
// An error that says the SITE is not answering (a block, a challenge, a timeout, a network fault), as opposed to the source
// refusing an input in its own words. It counts towards the three-in-a-row stop even on a call that was meant to be refused.
const SITE_PROBLEM_RE = /^HTTP \d{3}|did not answer|timed out|timeout|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|Cloudflare|rate-limited|protected by|fetch failed|network|socket/i;

// An error's message without ever letting a hostile getter escape.
function safeMessage(err) {
  try { return String((err && err.message) !== undefined ? err.message : err); } catch (_) { return 'an error that could not be read'; }
}
// A refusal by the site's bot protection, as the solver words it (config/solver.js MESSAGES.blocked). Said plainly when a run stops
// on it: the cooldown that follows a block is worded as a rate limit, which hides what really happened.
const BOT_BLOCK_RE = /Cloudflare blocked the browser solver/i;
const BOT_BLOCK_TEXT = 'the site\'s bot protection refused the app\'s browser (Cloudflare blocked the solver). Not necessarily a ban of this IP: if the site opens in a normal browser, only its data is protected, and the project does not imitate a browser to get past that';
const looksLikeSiteProblem = (err) => !!err && (err.rateLimited === true || SITE_PROBLEM_RE.test(safeMessage(err)));
// Text for a report line: one line, no local paths, capped.
const text = (value, max = 160) => stripLocalPaths(String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ')).slice(0, max);
const idsOf = (items) => (Array.isArray(items) ? items : []).map((item) => String(item && item.id));
const signatureOf = (result, n = 6) => idsOf(result && result.results).slice(0, n).join('|');

// What a check answers with.
const pass = (detail) => ({ status: 'pass', detail });
const fail = (detail) => ({ status: 'fail', detail });
const warn = (detail) => ({ status: 'warn', detail });
const skip = (detail) => ({ status: 'skip', detail });
const rethrowRunEnders = (err) => { if (err instanceof Abort || err instanceof Budget) throw err; };

// The names of the genres of an item or of a details answer, whatever shape the source gave them: a list of names, a list of
// { name | title | label | value }, a comma separated string, and a separate `tags` list.
function genreNames(item) {
  const out = [];
  const take = (value) => {
    if (typeof value === 'string') out.push(...value.split(/[,;/|]/).map((s) => s.trim()).filter(Boolean));
    else if (Array.isArray(value)) value.forEach(take);
    else if (value && typeof value === 'object') ['name', 'title', 'label', 'value'].forEach((key) => { if (typeof value[key] === 'string') out.push(value[key].trim()); });
  };
  if (item && typeof item === 'object') { take(item.genres); take(item.tags); }
  return out;
}

// The first bytes of the image formats a reader can show.
function imageKind(buffer) {
  if (!buffer || buffer.length < 12) return '';
  const head = (from, to) => buffer.slice(from, to).toString('latin1');
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (head(0, 4) === '\x89PNG') return 'png';
  if (head(0, 4) === 'GIF8') return 'gif';
  if (head(0, 4) === 'RIFF' && head(8, 12) === 'WEBP') return 'webp';
  if (head(0, 2) === 'BM') return 'bmp';
  if (buffer[0] === 0xff && buffer[1] === 0x0a) return 'jxl';
  if (head(4, 8) === 'ftyp' && /^(avif|avis|heic|heix|mif1|msf1)/.test(head(8, 12))) return head(8, 12).startsWith('av') ? 'avif' : 'heic';
  return '';
}

// The number of a chapter, for the order check: its own `chapter` field, else the number after "Ch"/"Chapter" in its name,
// else the LAST number in the name ("Vol.2 Ch.11" is chapter 11, not 2).
function chapterNumber(chapter) {
  if (chapter.chapter !== undefined && chapter.chapter !== '') {
    const n = parseFloat(chapter.chapter);
    if (Number.isFinite(n)) return n;
  }
  const name = String(chapter.name || chapter.title || '');
  const after = /ch(?:apter)?\.?\s*(\d+(?:\.\d+)?)/i.exec(name);
  const all = name.match(/\d+(?:\.\d+)?/g);
  const n = parseFloat(after ? after[1] : (all ? all[all.length - 1] : ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * The machinery of one run. `call` is one call to the source: budgeted, spaced, timed. `expected` is for a call that is meant
 * to be refused (a missing title): a refusal with a 400/404 is the site answering, and the source's own error is judged by the
 * check; but a timeout, a block or a network fault is still the site not answering, and counts. `step` runs one check: a throw
 * becomes a failure; an Abort or the budget ends the run, and what is left is skipped.
 */
function createRun({ cap, now, sleep, withTimeout }) {
  const run = { started: now(), checks: [], seen: [], calls: 0, images: 0, aborted: '', failuresInARow: 0, lastCallAt: 0, botBlocked: false };

  async function call(label, fn, { timeoutMs = cap.callTimeoutMs, expected = false } = {}) {
    if (now() - run.started > cap.maxDurationMs) { run.aborted = `the time limit of ${Math.round(cap.maxDurationMs / 60_000)} minutes was reached`; throw new Abort(run.aborted); }
    if (run.calls >= cap.maxCalls) throw new Budget('the call budget is used up');
    run.calls += 1;
    const wait = run.lastCallAt + cap.spacingMs - now();
    if (run.lastCallAt && wait > 0) await sleep(wait);
    run.lastCallAt = now();
    try {
      const result = await withTimeout(Promise.resolve().then(fn), timeoutMs, `${label} did not answer in ${Math.round(timeoutMs / 1000)} s`);
      run.failuresInARow = 0;
      return result;
    } catch (err) {
      if (expected && isBadInputStatus(err)) { run.failuresInARow = 0; throw err; }
      if (expected && !looksLikeSiteProblem(err)) throw err;
      run.failuresInARow += 1;
      if (BOT_BLOCK_RE.test(safeMessage(err))) run.botBlocked = true;
      if (run.failuresInARow >= cap.maxConsecutiveFailures) {
        run.aborted = run.botBlocked
          ? `${cap.maxConsecutiveFailures} calls failed in a row: ${BOT_BLOCK_TEXT}`
          : `${cap.maxConsecutiveFailures} calls failed in a row (${text(safeMessage(err), 80)})`;
        throw new Abort(run.aborted);
      }
      throw err;
    }
  }

  // Every item and details answer any call returned, for the never-listed scan.
  const collect = (result) => {
    for (const item of (result && Array.isArray(result.results) ? result.results : [])) if (item && typeof item === 'object') run.seen.push(item);
    return result;
  };

  const record = (checkId, status, detail, since) => run.checks.push({ id: checkId, status, detail: text(detail, 300), ms: Math.round(now() - since) });

  async function step(checkId, fn) {
    if (run.aborted) { record(checkId, 'skip', `not run: ${run.aborted}`, now()); return; }
    const since = now();
    try {
      const outcome = await fn();
      record(checkId, outcome.status, outcome.detail, since);
    } catch (err) {
      if (err instanceof Abort) record(checkId, 'fail', err.message, since);
      else if (err instanceof Budget) { run.aborted = err.message; record(checkId, 'skip', `not run: ${err.message}`, since); } else record(checkId, 'fail', safeMessage(err) || 'failed', since);
    }
  }

  return { run, call, collect, step };
}

module.exports = {
  DEFAULT_LIMITS, CORE_CHECKS, CHECK_IDS, Abort, Budget, createRun,
  isBadInputStatus, looksLikeSiteProblem, safeMessage, text, idsOf, signatureOf, pass, fail, warn, skip, rethrowRunEnders,
  genreNames, imageKind, chapterNumber,
};
