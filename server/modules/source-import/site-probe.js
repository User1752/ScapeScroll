'use strict';

const { readSignals, searchUrlFrom, detailUrlFrom, parseRobots, robotsDisallows, lowerHeaders } = require('./site-signatures');
const { detectEngine } = require('./site-engines');
const { blockedReason } = require('./site-denylist');
const { analyzeChapterPage, chapterLinksFrom, chapterListRequest } = require('./site-chapter');
const { decide } = require('./site-verdict');

// The first thing done with a link: look at the site, before a line of a source is written. A handful of plain requests (the
// home page, robots.txt, the site's own search, one title page) read for what stands in front of the content: Cloudflare and the
// other anti-bot services, interactive CAPTCHAs, a login wall, an empty JavaScript shell, ad networks, what robots.txt forbids,
// a domain that redirects. The answer is one of site-verdict.js's verdicts with the reasons, so a site that cannot work is
// known in seconds and not after an hour of writing selectors.
//
// It OBSERVES protections and does not solve them: the requests are the app's plain ones (every hop checked against private
// addresses), no cookies, no browser. Whether the app's own fetch (with FlareSolverr) can get past a challenge is asked only
// when the caller hands in `appFetch`, because that starts a real browser.

const DEFAULT_LIMITS = Object.freeze({
  maxRequests: 11,      // pages and images asked for (a redirect hop is not one)
  maxHops: 6,           // redirects followed for one page
  spacingMs: 600,       // pause between two pages
  timeoutMs: 20_000,    // one request
  appFetchPages: 3,     // pages handed to the app's fetch when the plain request was challenged
});
const SEARCH_FALLBACKS = Object.freeze(['/?s=a', '/search?q=a']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MIN_REAL_LINKS = 5;
const SEARCH_LIKE = /search|[?&](s|q|keyword|query)=/i;

class BadUrl extends Error {}

/** What a person pasted, as an http(s) address with no credentials and no fragment. */
function normaliseInput(raw) {
  let text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text || /\s/.test(text)) throw new BadUrl('That is not a web address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch (_) { throw new BadUrl('That is not a web address.'); }
  if (!/^https?:$/.test(url.protocol)) throw new BadUrl('Only http and https addresses can be looked at.');
  if (url.username || url.password) throw new BadUrl('An address with a user name or a password in it is not accepted.');
  url.hash = '';
  return url.href;
}

function describeNetworkError(err) {
  const cause = err && err.cause ? err.cause : err;
  const code = String((cause && cause.code) || (err && err.code) || '');
  if (code === 'UNSAFE_URL') return 'the address is not a public one (it points inside a private network)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the name does not exist (DNS)';
  if (code === 'ECONNREFUSED') return 'the connection was refused';
  if (code === 'DENYLISTED') return String((err && err.message) || 'refused').replace(/^refused, not asked: /, 'not asked, it is on the list of dangerous sites: ');
  if (code === 'ECONNRESET') return 'the connection was reset (if your security software warned about this site, it is dangerous: do not go on)';
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY/i.test(code)) return `the certificate could not be verified (${code})`;
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'it did not answer in time';
  return String((err && err.message) || 'the request failed').slice(0, 140);
}

/**
 * The one place that asks a site for a page: a pause before each, a ceiling on how many, redirects followed by hand so every hop
 * is seen (a domain that changed is worth knowing) and checked against private addresses. Never throws: a network failure is
 * the page's `error`.
 */
function createPageGetter({ fetchImpl, userAgent, cap, now, sleep, denylist = [] }) {
  // A site on the list (the security software flagged it) is not asked for anything: not the page, not a redirect to it, not an image.
  const refuse = (url) => { const why = blockedReason(url, denylist); if (why) throw Object.assign(new Error(`refused, not asked: ${why}`), { code: 'DENYLISTED' }); };
  let requests = 0;
  let lastAt = 0;
  const headers = { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' };

  async function follow(page, label, method = 'GET') {
    let current = page.url;
    for (let hop = 0; ; hop += 1) {
      refuse(current);
      const res = await fetchImpl(current, { method, redirect: 'manual', signal: AbortSignal.timeout(cap.timeoutMs), headers: method === 'POST' ? { ...headers, 'X-Requested-With': 'XMLHttpRequest' } : headers });
      const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null;
      if (location && hop < cap.maxHops) {
        page.redirects.push({ status: res.status, url: current });
        if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
        current = new URL(location, current).href;
        continue;
      }
      const body = await res.text();
      Object.assign(page, { finalUrl: current, status: res.status, bytes: body.length, contentType: String(res.headers.get('content-type') || '').split(';')[0], body });
      page.signals = label === 'robots' ? null : readSignals({ status: res.status, headers: res.headers, body, url: current });
      if (label === 'home') page.engine = detectEngine(body, lowerHeaders(res.headers));
      return;
    }
  }

  async function get(label, url, method = 'GET') {
    if (requests >= cap.maxRequests) return null;
    requests += 1;
    const wait = lastAt + cap.spacingMs - now();
    if (lastAt && wait > 0) await sleep(wait);
    lastAt = now();
    const page = { label, url, finalUrl: url, status: 0, redirects: [], ms: 0, bytes: 0, contentType: '' };
    const since = now();
    try { await follow(page, label, method); } catch (err) { page.error = describeNetworkError(err); }
    page.ms = Math.round(now() - since);
    return page;
  }
  // One image, asked for with a given Referer (or none): only the answer's status and kind, never the picture (a one byte range
  // is asked for, and the body is dropped unread).
  async function image(url, referer) {
    if (requests >= cap.maxRequests) return null;
    requests += 1;
    const wait = lastAt + cap.spacingMs - now();
    if (lastAt && wait > 0) await sleep(wait);
    lastAt = now();
    try {
      refuse(url);
      const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(cap.timeoutMs), headers: { 'User-Agent': userAgent, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8', Range: 'bytes=0-0', ...(referer ? { Referer: referer } : {}) } });
      if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
      return { status: res.status, ok: res.status === 200 || res.status === 206, contentType: String(res.headers.get('content-type') || '').split(';')[0] };
    } catch (err) {
      return { status: 0, ok: false, error: describeNetworkError(err) };
    }
  }
  return { get, image, requests: () => requests };
}

/**
 * Opens a chapter of the title page (the first link and the last: usually the newest and the oldest, which some sites serve
 * differently) and reads how it delivers its images.
 */
async function findChapters(get, detail, engine) {
  const found = [];
  if (!detail || detail.error || !detail.body) return found;
  let links = chapterLinksFrom(detail.body, detail.finalUrl);
  // No chapter link in the HTML: the list may be fetched by a call (Madara), which is worth telling the author, and which the
  // probe makes once (a POST to <title address>/ajax/chapters/, no body: what the theme's own script does) to reach a chapter.
  if (!links.length) {
    detail.chapterListRequest = chapterListRequest(detail.body) || (engine && engine.id === 'madara' ? chapterListRequest('manga_get_chapters') : null);
    if (detail.chapterListRequest && detail.chapterListRequest.kind === 'madara') {
      const list = await get('chapter-list', new URL('ajax/chapters/', detail.finalUrl.endsWith('/') ? detail.finalUrl : `${detail.finalUrl}/`).href, 'POST');
      if (list) { found.push(list); if (!list.error && list.body) links = chapterLinksFrom(list.body, detail.finalUrl); }
    }
  }
  for (const url of links) {
    const page = await get('chapter', url);
    if (!page) break;
    if (!page.error && page.body) page.chapter = analyzeChapterPage(page.body, page.finalUrl);
    found.push(page);
  }
  return found;
}

/** Whether the images of the first chapter that has some can be fetched with no Referer, with a foreign one, with the site's own. */
async function checkHotlink(getter, chapters, origin) {
  const page = chapters.find((p) => p.chapter && p.chapter.sample && (p.chapter.kind === 'inline' || p.chapter.kind === 'script'));
  if (!page) return;
  const url = page.chapter.sample;
  const bare = await getter.image(url, '');
  const foreign = bare && await getter.image(url, 'https://referer-check.invalid/');
  if (!bare || !foreign) return;
  let result = 'open';
  if (bare.ok && !foreign.ok) result = 'foreign-blocked';
  else if (!bare.ok && !foreign.ok) {
    const own = await getter.image(url, `${origin}/`);
    result = own && own.ok ? 'referer-required' : 'blocked';
  } else if (!bare.ok && foreign.ok) result = 'unclear';
  let host;
  try { host = new URL(url).hostname; } catch (_) { host = ''; }
  page.hotlink = { result, host, statuses: { none: bare.status, foreign: foreign.status } };
}

/** robots.txt of the site the link really lands on: the rules that apply to every robot. */
async function readRobots(get, home, origin) {
  const robots = { status: 0, rules: [], disallowAll: false, checked: [], searchLike: [], searchFromForm: false };
  if (home.error) return robots;
  const page = await get('robots', `${origin}/robots.txt`);
  if (!page) return robots;
  robots.status = page.status;
  if (page.status === 200 && !/<html/i.test(page.body || '')) robots.rules = parseRobots(page.body);
  return robots;
}

/** The pages a source will use: the site's own search and one title page, found on the home page when it is a real page. */
async function findPages(get, home, origin, robots) {
  const found = [];
  if (home.error || !home.signals) return found;
  const homeIsReal = home.signals.challenge === 'none' && home.status < 400;
  const own = homeIsReal ? searchUrlFrom(home.body, home.finalUrl) : '';
  robots.searchFromForm = !!own;
  const guesses = SEARCH_FALLBACKS.slice(0, homeIsReal ? 2 : 1).map((p) => new URL(p, origin).href);
  for (const url of own ? [own] : guesses) {
    const page = await get('search', url);
    if (!page) break;
    page.guessed = !own;
    found.push(page);
    if (!page.error && page.status === 200 && page.signals && page.signals.links >= MIN_REAL_LINKS) break;
  }
  const detail = homeIsReal ? detailUrlFrom(home.body, home.finalUrl) : '';
  if (detail) { const page = await get('detail', detail); if (page) found.push(page); }
  return found;
}

/** What robots.txt says about the pages that were looked at, the API directory most sites keep, and the paths the caller names. */
function judgeRobots(robots, pages, paths) {
  if (!robots.rules.length) return;
  robots.disallowAll = robotsDisallows(robots.rules, '/') && robots.rules.some((r) => !r.allow && r.pattern === '/');
  const wanted = [['home', '/'], ['api', '/api/']];
  for (const page of pages.filter((p) => p.label === 'search' || p.label === 'detail')) {
    try { const u = new URL(page.finalUrl); wanted.push([page.label, u.pathname + u.search]); } catch (_) { /* an address that does not parse is not checked */ }
  }
  // Paths the caller says the source will use (its own search, its API): a refusal there is a verdict, not a warning.
  for (const path of paths || []) wanted.push(['path', String(path)]);
  for (const [label, path] of wanted) robots.checked.push({ label, path, disallowed: robotsDisallows(robots.rules, path) });
  // A site whose search is not a plain form (so it was guessed) may still say in robots.txt that its search is off limits.
  robots.searchLike = robots.rules.filter((r) => !r.allow && SEARCH_LIKE.test(r.pattern)).map((r) => r.pattern);
}

/**
 * The paths the source's DATA comes from (its API), asked for once each. A site can open its pages to a plain request and keep
 * its data behind a protection of its own, meant for the site's own page in a real browser; a probe that only looks at pages
 * would call such a site open. A path robots.txt forbids is not asked (judgeRobots reports it).
 */
async function askDataPaths(get, origin, robots, paths) {
  const found = [];
  if (!origin) return found;
  for (const path of paths || []) {
    if (typeof path !== 'string' || !path.startsWith('/')) continue;
    if (robots.rules.length && robotsDisallows(robots.rules, path)) continue;
    const page = await get('data', new URL(path, origin).href);
    if (!page) break;
    found.push(page);
  }
  return found;
}

/** Only when the caller allows it: does the app's own fetch get through what the plain request could not? */
async function askAppFetch(pages, appFetch, cap) {
  const challenged = pages.filter((p) => p.signals && (p.signals.challenge === 'js' || p.signals.challenge === 'shell')).slice(0, cap.appFetchPages);
  for (const page of challenged) {
    try {
      const after = readSignals({ status: 200, headers: {}, body: await appFetch(page.finalUrl), url: page.finalUrl });
      const ok = after.challenge === 'none' && after.links >= MIN_REAL_LINKS;
      page.appFetch = { ok, message: ok ? '' : `it still got ${after.challenge === 'none' ? 'a page with almost no links' : 'a challenge page'}` };
    } catch (err) {
      page.appFetch = { ok: false, message: String((err && err.message) || 'it failed').slice(0, 160) };
    }
  }
  return challenged.length > 0;
}

/**
 * @param {string} rawUrl  what the person pasted
 * @param {object} [deps]
 * @param {Function} [deps.fetchImpl]  fetch(url, init) with the private-address check on every hop (default: safeFetch)
 * @param {(url: string) => Promise<string>} [deps.appFetch]  the app's own fetch (solves challenges through FlareSolverr)
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {() => number} [deps.now]
 * @param {string} [deps.userAgent]
 * @param {string[]} [deps.paths]  paths (with their query) the source is going to use, checked against robots.txt
 * @param {string[]} [deps.dataPaths]  paths the source's DATA is read from (its API): checked against robots.txt and asked for once
 * @param {Partial<typeof DEFAULT_LIMITS>} [deps.limits]
 */
async function probeSite(rawUrl, deps = {}) {
  const input = normaliseInput(rawUrl);
  const cap = { ...DEFAULT_LIMITS, ...(deps.limits || {}) };
  const now = deps.now || Date.now;
  const started = now();
  const getter = createPageGetter({
    fetchImpl: deps.fetchImpl || require('../network/safe-fetch').safeFetch,
    userAgent: deps.userAgent || require('../network/fetch-utils').DEFAULT_USER_AGENT,
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    cap,
    now,
    denylist: deps.denylist || [],
  });
  const home = await getter.get('home', input);
  let origin;
  try { origin = new URL(home.finalUrl).origin; } catch (_) { origin = ''; }
  const robots = await readRobots(getter.get, home, origin);
  const pages = [home, ...(await findPages(getter.get, home, origin, robots))];
  const chapters = await findChapters(getter.get, pages.find((p) => p.label === 'detail'), home.engine);
  pages.push(...chapters);
  await checkHotlink(getter, chapters, origin);
  judgeRobots(robots, pages, [...(deps.paths || []), ...(deps.dataPaths || [])]);
  pages.push(...(await askDataPaths(getter.get, origin, robots, deps.dataPaths)));
  const appFetchUsed = deps.appFetch ? await askAppFetch(pages, deps.appFetch, cap) : false;

  const { verdict, reasons } = decide({ input, pages, robots, appFetchUsed });
  return {
    input,
    verdict,
    reasons,
    engine: home.engine || null,
    requests: getter.requests(),
    durationMs: Math.round(now() - started),
    robots: { status: robots.status, rules: robots.rules.length, disallowAll: robots.disallowAll, checked: robots.checked, searchLike: robots.searchLike },
    // The body is not part of the answer: only what was read from it.
    pages: pages.map(({ body: _body, ...rest }) => rest),
  };
}

module.exports = { probeSite, normaliseInput, describeNetworkError, DEFAULT_LIMITS, BadUrl };
