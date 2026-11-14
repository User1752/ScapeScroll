'use strict';

const { blockedReason } = require('./site-denylist');
const { parseRobots, robotsDisallows } = require('./site-signatures');

// Engines that a page does not give away: the site is a Next.js (or other) front end that gets everything from a JSON API, so the HTML
// says "Next.js" and nothing about what the site is. Each of these is told by ONE small request to the API, asked the way the site's own
// page asks it, and by the SHAPE of the answer (named fields of the right type), never by a word on a page. Only what is asked of the
// site's API is read, in memory; nothing is saved.
//
// A probe here is a description, not code that comes from a site: the addresses are built from the site's own host and the fields it
// looks for are fixed in this file.

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 2_000_000;

/** Hosts a site's API may be on: the site's own name with api. in front (www removed), then the site itself. */
function apiOrigins(origin) {
  let url;
  try { url = new URL(origin); } catch (_) { return []; }
  const bare = url.hostname.replace(/^www\./, '');
  const list = [`https://api.${bare}`, url.origin];
  return [...new Set(list)];
}

const ENGINES = Object.freeze([
  {
    id: 'iken',
    name: 'Iken (Next.js reader with a JSON API)',
    // GET <api>/api/query: { posts: [{ slug, postTitle, ... }], totalCount: number }
    host: 'api',
    path: '/api/query?page=1&perPage=2&searchTerm=&orderBy=lastChapterAddedAt&orderDirection=desc&seriesStatus=&seriesType=&genreIds=',
    // Every path the source asks (checked against the robots.txt of the host the requests go to).
    paths: ['/api/query', '/api/post', '/api/chapters', '/api/chapter', '/api/genres'],
    matches: (json) => !!json && Array.isArray(json.posts) && Number.isFinite(Number(json.totalCount)) && json.posts.length > 0
      && json.posts.every((p) => p && typeof p.slug === 'string' && typeof p.postTitle === 'string'),
  },
  {
    // The Keyoapp reader theme. Its first version is server-rendered: the series page lists every title in one page (a container, a script that
    // sets up the genre dropdown, and a button per title that carries its tags). Its newer versions fill pages in with scripts (V2) or with
    // Livewire, which this app cannot read yet: they are named, so the person is told why, instead of being told nothing.
    id: 'keyoapp',
    name: 'Keyoapp reader theme',
    host: 'site',
    accept: 'text',
    path: '/series',
    paths: ['/series', '/latest/', '/chapter/'],
    matches: (html) => {
      const text = String(html || '');
      const v1 = /id="searched_series_page"/.test(text) && /initializeDropdownMenu/.test(text) && (text.match(/\btags=['"]/g) || []).length >= 3;
      if (v1) return true;
      return false;
    },
  },
  {
    // VineTheme: a Next.js reader whose pages are asked with the "rsc" header and answer with the data they are made of. Its series page is told by the
    // list it carries (the titles, and the paging that goes with them), never by a word. Only pages are asked (the site's /api/ directory is its own).
    id: 'vinetheme',
    name: 'VineTheme (Next.js reader)',
    host: 'site',
    accept: 'text',
    path: '/series?sort=popular&page=1',
    headers: { rsc: '1', Accept: 'text/x-component, */*' },
    paths: ['/series', '/series/comic/'],
    matches: (text) => /"initialSeries":\s*\[/.test(String(text || '')) && /"totalPages":\s*\d/.test(String(text || '')) && /"hasMore":\s*(?:true|false)/.test(String(text || ''))
      && /"slug":\s*"[^"]+"/.test(String(text || '')) && /"coverImage":/.test(String(text || '')),
  },
  {
    // The newer version of the same theme fills its lists in by a script: the page asks ?_ajax=search and gets { html, has_more }. That answer is
    // its signature (a page of the first version answers this address with an ordinary HTML page). It is named and refused, never read as the old one.
    id: 'keyoapp',
    name: 'Keyoapp reader theme (newer version)',
    host: 'site',
    path: '/?_ajax=search&sort=popular&offset=0',
    headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/html' },
    paths: ['/'],
    matches: (json) => (!!json && typeof json.html === 'string' && 'has_more' in json
      ? { unsupported: 'a newer version of the Keyoapp theme (its pages are filled in by scripts), which this app cannot read yet' }
      : false),
  },
]);

/** The headers a browser sends to the site's own API: the site as the origin and the referrer, JSON as the answer. */
const headersFor = (origin, userAgent) => ({ 'User-Agent': userAgent, Accept: 'application/json, text/plain, */*', Origin: origin, Referer: `${origin}/` });

async function readJson(fetchImpl, url, headers) {
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers });
  if (!res.ok) return { status: res.status, json: null, text: '' };
  const text = (await res.text()).slice(0, MAX_BYTES);
  try { return { status: res.status, json: JSON.parse(text), text }; } catch (_) { return { status: res.status, json: null, text }; }
}

/**
 * The rules of the robots.txt of a host that apply to every robot. No robots.txt (or one that is not a text file) is no rule; a host that cannot be
 * asked leaves the answer unchecked (the probe goes on: an unreachable robots.txt is not a refusal).
 * @returns {Promise<{ checked: boolean, rules: object[] }>}
 */
async function robotsOf(fetchImpl, origin, headers) {
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers });
    if (!res.ok) return { checked: true, rules: [] };
    const text = (await res.text()).slice(0, MAX_BYTES);
    return { checked: true, rules: /<html/i.test(text) ? [] : parseRobots(text) };
  } catch (_) {
    return { checked: false, rules: [] };
  }
}

/** What those rules forbid among the paths the source asks. */
const forbidden = (robots, paths) => paths.filter((p) => robots.rules.length && robotsDisallows(robots.rules, p));

/** What the robots.txt of the host the requests go to says about the paths a source asks (kept for the callers that only want that). */
async function checkApiRobots(fetchImpl, api, paths, headers) {
  const robots = await robotsOf(fetchImpl, api, headers);
  return { checked: robots.checked, disallowed: forbidden(robots, paths) };
}

/**
 * Which API engine, if any, answers at this site.
 * @param {string} origin   the site's origin (https://host)
 * @param {{ fetchImpl?: Function, userAgent?: string, denylist?: string[], engines?: object[] }} [deps]
 * @returns {Promise<{ id: string, name: string, api: string, evidence: string, robots: { checked: boolean, disallowed: string[] } } | null>}
 */
async function detectApiEngine(origin, deps = {}) {
  const fetchImpl = deps.fetchImpl || require('../network/safe-fetch').safeFetch;
  const userAgent = deps.userAgent || require('../network/fetch-utils').DEFAULT_USER_AGENT;
  const denylist = deps.denylist || [];
  const engines = deps.engines || ENGINES;
  const baseHeaders = headersFor(origin, userAgent);
  const robotsCache = new Map();
  for (const engine of engines) {
    const headers = { ...baseHeaders, ...(engine.headers || {}) };
    // An engine told by an API is asked on an api. host first; one told by a page only on the site itself.
    const hosts = engine.host === 'site' ? [new URL(origin).origin] : apiOrigins(origin);
    for (const api of hosts) {
      // A host the person's own list of dangerous sites names is never asked (the same rule as every page of the probe).
      if (blockedReason(api + '/', denylist)) continue;
      try {
        // The robots.txt of the host is read first: a path it closes to robots is not asked, not even to find out what the site is.
        if (!robotsCache.has(api)) robotsCache.set(api, await robotsOf(fetchImpl, api, baseHeaders));
        const robots = robotsCache.get(api);
        if (forbidden(robots, [engine.path.split('?')[0]]).length) continue;
        const answer = await readJson(fetchImpl, api + engine.path, headers);
        const verdict = engine.matches(engine.accept === 'text' ? answer.text : answer.json);
        if (!verdict) continue;
        if (verdict.unsupported) return { id: engine.id, name: engine.name, api, evidence: `${new URL(api).host}${engine.path.split('?')[0]}`, unsupported: verdict.unsupported, robots: { checked: robots.checked, disallowed: [] } };
        return { id: engine.id, name: engine.name, api, evidence: `${new URL(api).host}${engine.path.split('?')[0]} answered with the shape of the ${engine.id} ${engine.accept === 'text' ? 'page' : 'API'}`, robots: { checked: robots.checked, disallowed: forbidden(robots, engine.paths || []) } };
      } catch (_) { /* this host does not answer: the next one is tried */ }
    }
  }
  return null;
}

module.exports = { detectApiEngine, checkApiRobots, apiOrigins, ENGINES };
