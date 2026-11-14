'use strict';

const { probeSite, BadUrl } = require('../site-probe');
const { readPageText } = require('../site-peek');
const { buildSource, supportedEngines } = require('./index');
const { discoverMadara, discoverMangaThemesia, discoverIken, discoverKeyoapp, discoverVineTheme, titleFolderFrom } = require('./discover');
const { detectApiEngine } = require('../api-engines');
const { checkFit } = require('./fit');
const { dateOrderOf, titlePageOf, titleLinksFrom, hasMadaraChapters } = require('./measure');
const { blockedReason } = require('../site-denylist');

// From a link to a source file, with no AI and no step left to the person: probe the site (Cloudflare and other anti-bot services,
// a login, robots.txt, ads, an empty JavaScript shell), name its engine, check the engine's template fits the markup, read the name
// and genres, fill the template. The command line (tools/source-lab.js generate) and the Import card (routes/source-import.js) both
// run this one function, so they can never disagree. It writes nothing and installs nothing: it returns the text of the file, which
// then goes through the same Check as any other file before it can be installed.
//
// Every page it reads is read in memory (readPageText); nothing is saved to disk.

// Engines told by a JSON API: there is no markup to fit, the shape of the API's answer was the check.
const API_ENGINES = Object.freeze(['iken', 'vinetheme']);

const STEP = Object.freeze({ probe: 'probe', engine: 'engine', fit: 'fit', generate: 'generate' });
// The title index of a site whose robots.txt forbids the text search covers this many list pages (see the templates).
const INDEX_PAGES = 15;

/** One JSON answer of the site's API, read in memory with the app's own address check; a host the person's list names is never asked. */
async function readApiJson(url, denylist) {
  if (blockedReason(url, denylist)) throw new Error('that address is on your list of dangerous sites');
  const { safeFetch } = require('../../network/safe-fetch');
  const res = await safeFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': require('../../network/fetch-utils').DEFAULT_USER_AGENT, Accept: 'application/json, text/plain, */*' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse((await res.text()).slice(0, 2_000_000));
}

/**
 * The address of one title page of a Keyoapp site, from its series page. The probe finds a "title page" by the address shape that most links of the home page
 * share, and on this theme that is the chapter pages (the home page lists latest chapters), so it would check the wrong page.
 */
async function firstSeriesPage(read, base) {
  try {
    const m = /href="((?:https?:\/\/[^"/]+)?\/series\/[a-z0-9][\w-]{0,100}\/?)"/i.exec(await read(`${base}/series`));
    return m ? new URL(m[1], base).href : '';
  } catch (_) {
    return '';
  }
}

/** The chapter list a Madara site gives to the theme's own call (a POST with no body and the XMLHttpRequest header), read in memory; '' when it does not answer. */
async function postChapterList(titleUrl, denylist) {
  try {
    const url = new URL('ajax/chapters/', titleUrl);
    if (blockedReason(url.href, denylist)) return '';
    const { safeFetch } = require('../../network/safe-fetch');
    const res = await safeFetch(url.href, { method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': require('../../network/fetch-utils').DEFAULT_USER_AGENT, 'X-Requested-With': 'XMLHttpRequest', Referer: `${url.origin}/`, Accept: 'text/html,*/*' } });
    return res.ok ? (await res.text()).slice(0, 2_000_000) : '';
  } catch (_) {
    return '';
  }
}

/** The rows of a page asked with the rsc header, read in memory with the app's own address check; a host the person's list names is never asked. */
async function readRscRows(url, denylist) {
  if (blockedReason(url, denylist)) throw new Error('that address is on your list of dangerous sites');
  const { safeFetch } = require('../../network/safe-fetch');
  const res = await safeFetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': require('../../network/fetch-utils').DEFAULT_USER_AGENT, rsc: '1', Accept: 'text/x-component, */*', Referer: `${new URL(url).origin}/` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return require('../rsc-reader').rscRows((await res.text()).slice(0, 4_000_000));
}

const refused = (stage, message, extra = {}) => ({ status: 'refused', stage, message, ...extra });

/** The engine's discovery function; the probe and fit have already agreed that the template fits. */
const discoverOf = (engineId) => (engineId === 'madara' ? discoverMadara : (engineId === 'keyoapp' ? discoverKeyoapp : discoverMangaThemesia));

/**
 * @param {string} input   the address the person pasted
 * @param {{ id?: string, denylist?: string[], deps?: object }} [options]  `deps` replaces the network helpers in tests
 * @returns {Promise<object>}  { status: 'generated', code, id, name, ... } | { status: 'refused', stage, message, ... } | { status: 'bad-url', message }
 */
async function generateFromLink(input, { id, denylist = [], deps = {} } = {}) {
  const probe = deps.probeSite || probeSite;
  const readText = deps.readPageText || readPageText;
  let found;
  try { found = await probe(input, { denylist }); } catch (err) {
    if (err instanceof BadUrl) return { status: 'bad-url', message: err.message };
    throw err;
  }
  const summary = { verdict: found.verdict, engine: found.engine ? { id: found.engine.id, name: found.engine.name, confidence: found.engine.confidence } : null, reasons: found.reasons.filter((r) => r.severity !== 'info').map((r) => ({ severity: r.severity, text: r.text })) };
  if (found.verdict !== 'open') {
    // The person sees only this sentence (a toast), so it names the site and says why: "unreachable" alone leaves them guessing whether the site is down, the
    // address is wrong or their network refused it.
    let host = '';
    try { host = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`).hostname; } catch (_) { /* no name to give */ }
    const why = (found.reasons || []).filter((r) => r.severity === 'block' && r.text).slice(0, 2).map((r) => String(r.text).replace(/\s+/g, ' ').trim().slice(0, 220)).join(' ');
    return refused(STEP.probe, `The site${host ? ` ${host}` : ''} cannot be added from a link: the check came out "${found.verdict}".${why ? ` ${why}` : ''}`, { probe: summary });
  }
  let engineId = found.engine ? found.engine.id : '';
  // A page does not always say what the site is (a Next.js front end gets everything from a JSON API): when the page names no engine
  // that has a template, the site's API is asked, once, and its answer's shape names the engine.
  let api = null;
  if (!supportedEngines().includes(engineId)) {
    const origin = new URL(found.pages[0].finalUrl).origin;
    api = await (deps.detectApiEngine || detectApiEngine)(origin, { denylist });
    if (api) engineId = api.id;
  }
  // The API is read by a robot, so the robots.txt of the host it is on decides (not the site's: an api. host has its own). A path it forbids is a refusal.
  if (api && api.unsupported) return refused(STEP.engine, `This site is built on ${api.unsupported}. A source for it has to be written by hand.`, { probe: summary });
  if (api && api.robots && api.robots.disallowed.length) {
    return refused(STEP.engine, `This site's robots.txt closes what a source has to read (${api.robots.disallowed.join(', ')} on ${new URL(api.api).host}), and a source must not use it.`, { probe: summary });
  }
  // The probe looked at the site's own robots.txt: what it forbids under /api/ is the site's, not the API host's that was just checked (Iken), and a source
  // that reads pages only (Keyoapp, VineTheme) never asks /api/ at all.
  if (api && (api.id !== 'iken' || new URL(api.api).origin !== new URL(found.pages[0].finalUrl).origin)) {
    summary.reasons = summary.reasons.filter((r) => !/robots\.txt forbids \/api\//.test(r.text));
  }
  if (!supportedEngines().includes(engineId)) {
    return refused(STEP.engine, `This site's engine (${engineId || 'not recognised'}) has no template yet; templates exist for ${supportedEngines().join(' and ')}. A source for it has to be written by hand.`, { probe: summary });
  }

  const base = new URL(found.pages[0].finalUrl).origin;
  const read = (url) => readText(url, { denylist });
  const quietly = (url) => (url ? read(url).catch(() => '') : Promise.resolve(''));
  // An engine name is not a fit: a customised theme keeps the engine's scripts and changes the markup the template reads.
  const detail = found.pages.find((p) => p.label === 'detail');
  // The folder the site keeps its titles in, read from the title page the probe found ("manga" when it names none).
  const folder = titleFolderFrom(detail && detail.finalUrl);
  // An engine told by its API has no markup to fit: the shape of the API's answer was the check.
  const detailUrl = engineId === 'keyoapp' ? await firstSeriesPage(read, base) : detail && detail.finalUrl;
  const detailHtml = await quietly(detailUrl);
  // Madara: the chapters are in the title page or in the answer of the theme's own call; the page that holds them is what the date order is measured on.
  const listHtml = await quietly(engineId === 'keyoapp' ? `${base}/series` : `${base}/${folder}/`);
  let chaptersHtml = '';
  if (engineId === 'madara') {
    // One title proves nothing (a new one has no chapter yet): up to four titles are tried, the probe's first, then the ones the list page shows.
    const candidates = [...new Set([titlePageOf(detailUrl), ...titleLinksFrom(listHtml, base, folder, 6)].filter(Boolean))].slice(0, 4);
    for (const [i, title] of candidates.entries()) {
      if (i > 0) await (deps.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); })))(800); // one request at a time, not in a burst
      const page = i === 0 ? detailHtml : await quietly(title);
      chaptersHtml = hasMadaraChapters(page) ? page : await (deps.postChapterList || postChapterList)(title, denylist);
      if (hasMadaraChapters(chaptersHtml)) break;
    }
  } else if (engineId === 'mangathemesia') {
    chaptersHtml = detailHtml;
  }
  const fit = api && API_ENGINES.includes(api.id) ? { fits: true, missing: [] } : checkFit(engineId, {
    detail: detailHtml,
    list: listHtml,
    search: engineId === 'madara' ? await quietly(`${base}/?s=a&post_type=wp-manga`) : '',
    chapters: chaptersHtml,
  });
  if (!fit.fits) {
    return refused(STEP.fit, `The ${engineId} template does not fit this site (missing: ${fit.missing.join('; ')}). It uses a customised theme, so nothing is generated; a source for it has to be written by hand.`, { probe: summary });
  }

  const fetchJson = deps.fetchJson || ((url) => readApiJson(url, denylist));
  let discovered;
  if (api && api.id === 'iken') discovered = await discoverIken(base, read, api.api, fetchJson);
  else if (api && api.id === 'vinetheme') discovered = await discoverVineTheme(base, read, deps.fetchRows || ((url) => readRscRows(url, denylist)));
  else discovered = await discoverOf(engineId)(base, read, folder);
  const searchForbidden = (found.robots.checked || []).some((c) => c.label === 'search' && c.disallowed);
  let built;
  try {
    built = buildSource({ engine: engineId, base, id, name: discovered.name, genres: discovered.genres, textSearch: !searchForbidden, adultOnly: discovered.adultOnly, subpath: folder, api: api && api.id === 'iken' ? api.api : undefined, dateOrder: dateOrderOf(engineId, chaptersHtml, await quietly(`${base}/`)) });
  } catch (err) {
    return refused(STEP.generate, `The source could not be written: ${err.message}`, { probe: summary });
  }
  const notes = [...discovered.notes];
  if (searchForbidden) notes.push(`The site's robots.txt forbids its text search, so searching scans the first ${INDEX_PAGES} pages of its list (about ${INDEX_PAGES * 20} titles); a title further down is found by browsing.`);
  if (built.neverListedGenres) notes.push(`The site has ${built.neverListedGenres} genre(s) this app never lists: their titles are kept out of every list, search and detail page.`);
  if (built.adultOnly) notes.push('The site presents itself as adult-only: every title is declared adult, and Hide NSFW hides the whole source.');
  return { status: 'generated', ...built, engine: engineId, base, notes, probe: summary };
}

module.exports = { generateFromLink, INDEX_PAGES, STEP };
