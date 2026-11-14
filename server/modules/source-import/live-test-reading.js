'use strict';

const {
  isBadInputStatus, safeMessage, text, idsOf, pass, fail, warn, skip, rethrowRunEnders, imageKind, chapterNumber,
} = require('./live-test-support');
const { isPlaceholderAddress } = require('./placeholder');

// The checks that read one title the way a reader does, from the list to the images: each is `(ctx) => { status, detail }`
// (see live-test.js for what ctx holds). What one finds (the first title, its chapters, its pages) is left in ctx.state for
// the next, so a failure early on skips what cannot be judged without it.

// A chapter list "looks like today's date" when this many chapters all carry the same day and it is today's (a warning:
// a new series can really have all its chapters out today).
const SAME_DAY_AS_TODAY_MIN = 4;
const FUTURE_TOLERANCE_MS = 2 * 86_400_000;
const RATE_LIMITED_RE = /\b429\b|rate-limited|too many requests/i;

async function checkBrowse(ctx) {
  const { mod, state, call, collect, filtersWith } = ctx;
  let result;
  let firstError = null;
  try { result = await call('search', () => mod.search('', 1, '', filtersWith())); } catch (err) { rethrowRunEnders(err); firstError = err; }
  if (!result || !Array.isArray(result.results) || result.results.length === 0) {
    // Some sites cannot list without a text (they refuse it or answer nothing): one more try with a common one.
    try { result = await call('search', () => mod.search('a', 1, '', filtersWith())); } catch (err) { rethrowRunEnders(err); throw firstError || err; }
  }
  if (!result || !Array.isArray(result.results)) return fail('search() did not answer { results: [...] }');
  collect(result);
  state.browse = result;
  if (result.results.length === 0) return fail('the search returned no titles, with an empty text and with "a"');
  const bad = result.results.slice(0, 10).filter((item) => !item || typeof item.id !== 'string' || !item.id || typeof item.title !== 'string' || !item.title.trim());
  if (bad.length) return fail(`${bad.length} of the first ${Math.min(10, result.results.length)} items lack an id or a title`);
  state.target = result.results[0];
  const noCover = result.results.slice(0, 10).filter((item) => !item.cover).length;
  return noCover ? warn(`${result.results.length} titles; ${noCover} of the first 10 have no cover`) : pass(`${result.results.length} titles on page 1`);
}

async function checkPageTwo(ctx) {
  const { mod, state, call, collect, filtersWith } = ctx;
  if (!state.browse) return skip('no first page to compare with');
  if (state.browse.hasNextPage !== true) return skip('the source says there is only one page');
  const second = collect(await call('search', () => mod.search('', 2, '', filtersWith())));
  const first = new Set(idsOf(state.browse.results));
  const secondIds = idsOf(second && second.results);
  if (secondIds.length === 0) return fail('hasNextPage was true but page 2 is empty');
  const repeated = secondIds.filter((x) => first.has(x)).length;
  if (repeated === secondIds.length) return fail('page 2 is page 1 again');
  return repeated ? warn(`page 2 repeats ${repeated} of ${secondIds.length} titles from page 1`) : pass(`${secondIds.length} different titles`);
}

async function checkPastEnd(ctx) {
  const { mod, state, call, filtersWith } = ctx;
  if (!state.browse) return skip('no first page to compare with');
  let result;
  try { result = await call('search', () => mod.search('', 99999, '', filtersWith()), { expected: true }); } catch (err) {
    if (isBadInputStatus(err)) return pass('a page past the end is refused');
    throw err;
  }
  const list = idsOf(result && result.results);
  if (list.length === 0) return pass('a page past the end is empty');
  const first = new Set(idsOf(state.browse.results));
  return list.every((x) => first.has(x)) ? fail('a page past the end repeats page 1 (it must be empty)') : warn(`a page past the end returned ${list.length} titles`);
}

async function checkSearchText(ctx) {
  const { mod, state, call, collect, filtersWith } = ctx;
  if (!state.target) return skip('no title to take a word from');
  const word = String(state.target.title).split(/[^\p{L}\p{N}]+/u).find((w) => w.length >= 4);
  if (!word) return skip('the first title has no word of 4 letters');
  const result = collect(await call('search', () => mod.search(word, 1, '', filtersWith())));
  const list = (result && result.results) || [];
  if (list.length === 0) return fail(`searching "${word}" (a word of a title the site just listed) found nothing`);
  const hit = list.some((item) => String(item.title || '').toLowerCase().includes(word.toLowerCase()));
  return hit ? pass(`"${word}": ${list.length} results`) : warn(`"${word}" returned ${list.length} results and none has it in its title (the app drops those)`);
}

async function checkDetails(ctx) {
  const { mod, state, run, call } = ctx;
  if (!state.target) return skip('no title to open');
  const details = await call('mangaDetails', () => mod.mangaDetails(state.target.id));
  if (!details || typeof details.title !== 'string' || !details.title.trim()) return fail('mangaDetails() answered no title');
  run.seen.push(details);
  const missing = ['status', 'genres', 'description'].filter((key) => details[key] === undefined);
  return missing.length ? warn(`"${text(details.title, 60)}": no ${missing.join(', ')}`) : pass(`"${text(details.title, 60)}"`);
}

async function checkChapters(ctx) {
  const { mod, state, call, now } = ctx;
  if (!state.target) return skip('no title to list the chapters of');
  const result = await call('chapters', () => mod.chapters(state.target.id));
  const list = result && Array.isArray(result.chapters) ? result.chapters : [];
  state.chapterList = list;
  if (list.length === 0) return fail('chapters() returned no chapters for a title the site lists');
  if (list.some((c) => !c || typeof c.id !== 'string' || !c.id)) return fail('a chapter has no id');
  const unique = new Set(idsOf(list));
  if (unique.size !== list.length) return fail(`${list.length - unique.size} chapter ids are repeated`);
  const firstN = chapterNumber(list[0]);
  const lastN = chapterNumber(list[list.length - 1]);
  if (firstN !== null && lastN !== null && list.length > 1 && firstN < lastN) return fail(`the list is oldest first (chapter ${firstN} before ${lastN}); it must be newest first`);
  const dates = list.map((c) => c.publishAt).filter(Boolean);
  const bad = dates.filter((d) => !Number.isFinite(Date.parse(d)));
  if (bad.length) return fail(`${bad.length} chapter dates are not dates`);
  const future = dates.filter((d) => Date.parse(d) > now() + FUTURE_TOLERANCE_MS);
  if (future.length) return fail(`${future.length} chapter dates are in the future`);
  const today = new Date(now()).toISOString().slice(0, 10);
  if (dates.length >= SAME_DAY_AS_TODAY_MIN && dates.every((d) => String(d).slice(0, 10) === today)) return warn(`every one of ${dates.length} chapter dates is today: fine for a new series, but a date that is not the real one must be null`);
  return pass(`${list.length} chapters, newest first, ${dates.length} with a date`);
}

// What is wrong with the pages of one chapter, as a sentence ('' when nothing is).
function pageListProblem(pages, which) {
  if (pages.length === 0) return `pages() returned no pages for the ${which} chapter`;
  const empty = pages.filter((p) => !p || !(typeof p === 'string' ? p : p.img)).length;
  if (empty) return `${empty} of ${pages.length} pages of the ${which} chapter have no image address`;
  const placeholder = placeholderProblem(pages);
  return placeholder ? `${which} chapter: ${placeholder}` : '';
}

// The newest chapter (whose images are fetched next) and, when there is more than one, the oldest: a site can serve the two in
// different ways (a recent chapter in the HTML, an old one filled in by a call the page makes), and a reader opens either.
// An error that says the chapter exists but the site keeps it back (a lock, a paywall, early access).
const isLockedChapter = (err) => !!err && (err.statusCode === 403 || /\b(locked|premium|paywall|early access)\b/i.test(safeMessage(err)));

async function checkPages(ctx) {
  const { mod, state, cap, call } = ctx;
  const chapters = state.chapterList;
  if (chapters.length === 0) return skip('no chapter to open');
  const askPages = async (chapter) => { const result = await call('pages', () => mod.pages(chapter.id), { timeoutMs: cap.pagesTimeoutMs }); return result && Array.isArray(result.pages) ? result.pages : []; };
  // A site can keep its newest chapters for subscribers (a lock plugin): that is the site's rule, not a broken source, so the next
  // chapters are tried (at most three in all) and the report says which one was read.
  let newest;
  let at = 0;
  for (; ; at += 1) {
    try { newest = await askPages(chapters[at]); break; } catch (err) {
      if (!isLockedChapter(err) || at >= 2 || at + 1 >= chapters.length) throw err;
    }
  }
  state.newestRead = at;
  const newestProblem = pageListProblem(newest, 'newest');
  state.pageList = newestProblem ? [] : newest; // nothing to fetch for pages that are known to be wrong
  if (newestProblem) return fail(newestProblem);
  if (chapters.length < 2 || chapters[chapters.length - 1].id === chapters[0].id) return pass(`${newest.length} pages`);
  const oldest = await askPages(chapters[chapters.length - 1]);
  const oldestProblem = pageListProblem(oldest, 'oldest');
  if (oldestProblem) return fail(oldestProblem);
  const which = at ? `chapter ${at + 1} from the top (the newest ${at === 1 ? 'is' : 'are'} locked on the site)` : 'the newest chapter';
  return pass(`${newest.length} pages in ${which}, ${oldest.length} in the oldest`);
}

// The real address behind a page: the app's proxy wraps it as /api/proxy-image?url=<address>.
function innerAddress(page) {
  const raw = typeof page === 'string' ? page : (page && page.img) || '';
  try {
    const url = new URL(raw, 'http://localhost');
    return url.pathname === '/api/proxy-image' ? (url.searchParams.get('url') || raw) : raw;
  } catch (_) {
    return raw;
  }
}

// A chapter whose pages are all one picture, or a "loading" picture, was read from a page that fills its images in with
// JavaScript: the placeholder is what the HTML holds, the real addresses come from a call the page makes (the images still
// "load", so only the addresses give it away).
function placeholderProblem(pages) {
  const addresses = pages.map(innerAddress);
  if (addresses.length >= 2 && new Set(addresses).size === 1) return `all ${addresses.length} pages point at the same image (${text(addresses[0], 80)}): a loading placeholder, not the chapter?`;
  const loading = addresses.filter((a) => isPlaceholderAddress(a));
  if (loading.length) return `${loading.length} of ${addresses.length} pages are a loading placeholder (${text(loading[0], 80)}), not a page of the chapter`;
  return '';
}

// One image: how it went, as the line the report shows when it did not go well ('' when it did).
async function fetchOneImage(ctx, page, number) {
  const resolved = ctx.resolvePageUrl(page);
  if (!resolved) return `page ${number}: not an address the app can fetch`;
  try {
    const buffer = await ctx.withTimeout(ctx.fetchImage(resolved.url, resolved.referer), ctx.cap.callTimeoutMs, 'the image did not answer');
    return imageKind(buffer) ? '' : `page ${number}: ${buffer ? buffer.length : 0} bytes that are not an image`;
  } catch (err) {
    return `page ${number}: ${text(safeMessage(err), 60)}`;
  }
}

async function checkImages(ctx) {
  const { state, run, cap, sleep } = ctx;
  const pages = state.pageList;
  if (pages.length === 0) return skip('no pages to fetch');
  const wanted = [...new Set([0, pages.length - 1, Math.floor(pages.length / 2), 1, pages.length - 2].filter((i) => i >= 0 && i < pages.length))].slice(0, cap.maxImages);
  const problems = [];
  let ok = 0;
  let inARow = 0;
  for (const index of wanted) {
    if (run.images >= cap.maxImages || inARow >= cap.maxConsecutiveFailures) break;
    run.images += 1;
    if (ok + problems.length > 0) await sleep(cap.imageSpacingMs);
    const problem = await fetchOneImage(ctx, pages[index], index + 1);
    if (problem) { problems.push(problem); inARow += 1; } else { ok += 1; inARow = 0; }
  }
  // A CDN that answers 429 is rate limiting the test, not showing that the images are wrong: with some images fetched it is a
  // warning (wait and test again); with none it is a failure, because nothing was seen.
  const real = problems.filter((p) => !RATE_LIMITED_RE.test(p.replace(/^page \d+: /, ''))); // not the page number: "page 429"
  if (real.length || (problems.length && ok === 0)) return fail(`${ok} of ${ok + problems.length} images fetched; ${problems.slice(0, 2).join('; ')}`);
  if (problems.length) return warn(`${ok} of ${ok + problems.length} images fetched; the rest were rate limited (${problems[0]}): wait a few minutes and test again`);
  return pass(`${ok} images fetched and recognised (pages ${wanted.map((i) => i + 1).join(', ')} of ${pages.length})`);
}

const READING_CHECKS = Object.freeze([
  ['browse', checkBrowse], ['search-page-2', checkPageTwo], ['search-past-end', checkPastEnd], ['search-text', checkSearchText],
  ['details', checkDetails], ['chapters', checkChapters], ['pages', checkPages], ['images', checkImages],
]);

module.exports = { READING_CHECKS };
