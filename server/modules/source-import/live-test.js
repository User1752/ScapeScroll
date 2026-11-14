'use strict';

const { getSourceUi } = require('../common/source-ui');
const {
  DEFAULT_LIMITS, CORE_CHECKS, CHECK_IDS, createRun, genreNames, imageKind, chapterNumber,
} = require('./live-test-support');
const { READING_CHECKS } = require('./live-test-reading');
const { REFUSAL_CHECKS } = require('./live-test-refusals');
const { BASIC_DECLARED_CHECKS, fullDeclaredChecks } = require('./live-test-declared');

// "Test": the manual checklist of docs/adicionar-source-completo.md (section 8) run against the REAL site, by the person's
// own request, with a small budget. It calls the installed source exactly as the app does (the same functions, the same
// arguments, the app's own image fetch) and says, check by check, what held and what did not. A source is only "verified"
// when nothing failed and the core of reading (search, details, chapters, pages, images) passed.
//
// What it will not do: anything the source's own contract does not already allow. No login, no challenge is solved, and it
// stops after three failures in a row (a block or a challenge repeats on every call, so more calls only hammer the site) or
// when its time limit is reached. The budget counts calls to the source, not requests: one call can make several (a source
// that checks every card of a list makes dozens), which is why the person starts it and why 'basic' leaves out the extra
// measurements.
//
// Not the same as the reader: an image is fetched with the Referer rules and the image fetch of the app, but not with the
// saved session cookies of the reader's proxy, so a CDN that needs those can fail here and still work when reading.
//
// The parts: live-test-support.js (limits, the machinery of a run), and the checks themselves in live-test-reading.js (the
// list to the images), live-test-refusals.js (what must be refused) and live-test-declared.js (what meta.ui declares).

/**
 * @param {object} deps
 * @param {(id: string) => object} deps.loadSourceFromFile
 * @param {(page: any) => ({ url: string, referer: string } | null)} deps.resolvePageUrl  what the app does with a page address
 * @param {(url: string, referer: string) => Promise<Buffer>} deps.fetchImage
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {() => number} [deps.now]
 * @param {(promise: Promise<any>, ms: number, message: string) => Promise<any>} deps.withTimeout
 * @param {Partial<typeof DEFAULT_LIMITS>} [deps.limits]
 */
function createLiveTest({ loadSourceFromFile, resolvePageUrl, fetchImage, sleep, now = Date.now, withTimeout, limits = {} }) {
  const cap = { ...DEFAULT_LIMITS, ...limits };
  // What the app sends as filters (sources/dispatch-service.js): always the three, always strings.
  const filtersWith = (key, value) => ({ publicationStatus: '', contentRating: '', format: '', ...(key ? { [key]: value } : {}) });

  return async function runLiveTest({ id, depth = 'basic' }) {
    let mod;
    try { mod = loadSourceFromFile(id); } catch (err) { err.liveTestLoad = true; throw err; }
    const { run, call, collect, step } = createRun({ cap, now, sleep, withTimeout });
    // What one check finds for the next: the first title, its chapters, its pages.
    const state = { browse: null, target: null, chapterList: [], pageList: [] };
    const ctx = { mod, ui: getSourceUi(id) || {}, cap, now, sleep, withTimeout, fetchImage, resolvePageUrl, run, call, collect, state, filtersWith };

    const checks = [...READING_CHECKS, ...REFUSAL_CHECKS, ...BASIC_DECLARED_CHECKS, ...(depth === 'full' ? fullDeclaredChecks(mod) : [])];
    for (const [checkId, check] of checks) await step(checkId, () => check(ctx));

    const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
    for (const check of run.checks) counts[check.status] += 1;
    const byId = new Map(run.checks.map((check) => [check.id, check.status]));
    const verified = counts.fail === 0 && !run.aborted && CORE_CHECKS.every((checkId) => byId.get(checkId) === 'pass' || byId.get(checkId) === 'warn');
    return {
      id,
      depth,
      startedAt: new Date(run.started).toISOString(),
      durationMs: Math.round(now() - run.started),
      calls: run.calls,
      images: run.images,
      aborted: run.aborted,
      checks: run.checks,
      counts,
      verified,
    };
  };
}

module.exports = { createLiveTest, DEFAULT_LIMITS, CORE_CHECKS, CHECK_IDS, imageKind, chapterNumber, genreNames };
