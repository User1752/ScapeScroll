'use strict';

const { registrableDomain, hostOf } = require('./site-signatures');

// What the answers of a site (site-probe.js) mean for writing a source for it. Three verdicts, with the reasons that led to
// each, every one with an id (so a screen can translate it), a severity and a sentence:
//
//   open          the plain request gets the real pages: a source can be written with the app's ordinary fetch;
//   needs-solver  a JavaScript challenge stands in front of some or all pages: it only works while FlareSolverr (a real browser)
//                 is running, which is slower and has to be started, so the person is told before anything is written;
//   not-viable    something the project does not get around (the guide's first rules): an interactive CAPTCHA, a login, a
//                 refusal in robots.txt, a challenge on a site full of ad networks, a block page.
//   unreachable   the address did not answer at all (not a verdict about the site: nothing was learned).
//
// "block" reasons decide not-viable; "warn" reasons are what to keep in mind while writing; "info" is what was seen.

const reason = (id, severity, text, extra = {}) => ({ id, severity, text, ...extra });
const labelList = (pages) => pages.map((p) => p.label).join(', ');

// What the chapter pages that were opened say about how the images are delivered, and what the image host says about hotlinking.
// These do not decide a verdict (a site is not unusable because its images come from a request); they tell the author what to do.
function chapterReasons(pages, home) {
  const reasons = [];
  const engine = home.engine;
  if (engine) reasons.push(reason('engine', 'info', `It looks like ${engine.name} (${engine.confidence} confidence): ${engine.hint}.`, { engine: engine.id, confidence: engine.confidence }));
  const listed = pages.find((p) => p.chapterListRequest);
  if (listed) reasons.push(reason('chapter-list-ajax', 'info', `The title page has no chapter links in its HTML: the list is fetched by a call (${listed.chapterListRequest.hint}).`, { request: listed.chapterListRequest }));
  const chapters = pages.filter((p) => p.chapter);
  if (!chapters.length) return reasons;
  const kinds = [...new Set(chapters.map((p) => p.chapter.kind))];
  const ajax = chapters.find((p) => p.chapter.kind === 'ajax');
  if (ajax) {
    const c = ajax.chapter;
    reasons.push(reason('chapter-images-ajax', 'warn', `The HTML of a chapter page holds only placeholders (${c.placeholders} "loading" pictures); the page fills the images in from a request${c.endpoints.length ? ` (${c.endpoints.slice(0, 2).join(', ')}${c.chapterId ? `, with the chapter id ${c.chapterId}` : ''})` : ''}. The source has to make that request: reading the HTML shows broken pages.`, { endpoints: c.endpoints, chapterId: c.chapterId }));
  }
  if (kinds.length > 1) reasons.push(reason('chapter-images-mixed', 'warn', `The chapters tried are served in different ways (${kinds.join(' and ')}): test the oldest, one in the middle and the newest.`, { kinds }));
  const script = chapters.find((p) => p.chapter.kind === 'script');
  if (script && !ajax) reasons.push(reason('chapter-images-script', 'info', `The chapter's images are listed inside a script of the page (${script.chapter.scriptImages} addresses): read them from there.`));
  const inline = chapters.find((p) => p.chapter.kind === 'inline');
  if (inline && !ajax && !script) reasons.push(reason('chapter-images-inline', 'info', `The chapter's images are in its HTML (${inline.chapter.real}, ${inline.chapter.lazyAttr ? `in ${inline.chapter.lazyAttr}` : 'in src'}).`));
  if (kinds.every((k) => k === 'none')) reasons.push(reason('chapter-images-unconfirmed', 'warn', 'No chapter images were found in the chapter page(s) tried: confirm by hand how the site delivers them (the page\'s scripts, the network calls a reader makes).'));
  const hot = chapters.find((p) => p.hotlink);
  if (hot) {
    const { result, host } = hot.hotlink;
    if (result === 'referer-required') reasons.push(reason('images-referer-required', 'warn', `The image host ${host} refuses a request without the site's own Referer: declare it in meta.ui imageReferers.`, { host }));
    else if (result === 'blocked') reasons.push(reason('images-blocked', 'warn', `The image host ${host} refused plain requests even with the site's Referer: images may need something this probe cannot send.`, { host }));
    else if (result === 'foreign-blocked') reasons.push(reason('images-foreign-blocked', 'info', `The image host ${host} refuses a foreign Referer but accepts none: the app's own requests are fine.`, { host }));
    else if (result === 'open') reasons.push(reason('images-open', 'info', `The image host ${host} serves images with no Referer: nothing to declare.`, { host }));
  }
  return reasons;
}

// What the paths the source reads its DATA from answered (probe --data). Pages that open while the data is refused is the case a
// page-only look cannot see: the data sits behind a protection of its own, meant for the site's own page in a real browser.
function dataReasons(pages, home) {
  const data = pages.filter((p) => p.label === 'data' && !p.error && p.signals);
  const where = (list) => list.map((p) => { try { return new URL(p.finalUrl).pathname; } catch (_) { return p.url; } }).join(', ');
  const reasons = [];
  const refused = data.filter((p) => p.signals.challenge !== 'none');
  if (refused.length) {
    const hard = refused.some((p) => p.signals.challenge === 'blocked' || p.signals.challenge === 'interactive');
    const lead = home.signals && home.signals.challenge === 'none' ? 'The pages answer plain requests, but the data path' : 'The data path';
    reasons.push(reason('data-protected', hard ? 'block' : 'warn', hard
      ? `${lead} (${where(refused)}) is refused (${refused[0].status}): the data sits behind a protection of its own, meant for the site's own page in a real browser. A source would have to imitate that page, which the project does not do.`
      : `${lead} (${where(refused)}) is challenged: it can only work through FlareSolverr, which is slower.`, { paths: refused.map((p) => p.url) }));
  }
  const answered = data.filter((p) => p.signals.challenge === 'none');
  const open = answered.filter((p) => p.status < 400);
  if (open.length) reasons.push(reason('data-open', 'info', `The data path (${where(open)}) answered a plain request (${open[0].status}).`));
  const unclear = answered.filter((p) => p.status >= 400);
  if (unclear.length) reasons.push(reason('data-unclear', 'warn', `The data path (${where(unclear)}) answered ${unclear[0].status}: it may need parameters or a header the probe does not send; confirm it by hand.`));
  return reasons;
}

// What robots.txt says about the site, the pages that were looked at and the paths the caller named.
function robotsReasons(robots) {
  const reasons = [];
  if (robots && robots.rules && robots.rules.length) {
    if (robots.disallowAll) reasons.push(reason('robots-disallow-all', 'block', 'robots.txt forbids every robot from the whole site ("Disallow: /").'));
    for (const check of robots.checked || []) {
      if (!check.disallowed || (check.label === 'home' && robots.disallowAll)) continue; // already said above
      // The pages a source cannot do without (the home page, or a path the caller says it will use) decide. A forbidden TEXT SEARCH
      // does not: it is very common (WordPress sites forbid /?s= by default) and the source can still list, browse and read; it
      // just cannot search by text, which the person should know before choosing to write it.
      const blocking = check.label === 'home' || check.label === 'path';
      const note = check.label === 'search' ? ' A source must not use it: it could list, browse and read, but not search by text.' : (blocking ? '' : ' A source must not depend on it.');
      reasons.push(reason(`robots-disallows-${check.label}`, blocking ? 'block' : 'warn', `robots.txt forbids ${check.path} (${check.label}).${note}`, { path: check.path }));
    }
  }

  if (robots && robots.searchLike && robots.searchLike.length && !robots.searchFromForm && !(robots.checked || []).some((c) => c.label === 'search' && c.disallowed)) {
    reasons.push(reason('robots-search-like', 'warn', `robots.txt forbids what looks like this site's search (${robots.searchLike.slice(0, 3).join(', ')}): confirm the path the source will use with --path before writing it.`, { patterns: robots.searchLike }));
  }
  return reasons;
}

function decide({ input, pages, robots, appFetchUsed }) {
  const reasons = [];
  const home = pages.find((p) => p.label === 'home');

  if (!home || home.error) {
    return { verdict: 'unreachable', reasons: [reason('unreachable', 'block', `The site did not answer: ${home && home.error ? home.error : 'no response'}.`)] };
  }
  if (home.status === 404 || home.status === 410) {
    return { verdict: 'unreachable', reasons: [reason('not-found', 'block', `The address answers ${home.status}: there is nothing at ${input}. Check the link.`)] };
  }

  // The address people paste is often an old domain: the final one is what a source must use.
  const finalHost = hostOf(home.finalUrl);
  if (finalHost && registrableDomain(finalHost) !== registrableDomain(hostOf(input))) {
    reasons.push(reason('domain-changed', 'warn', `The link redirects to another domain (${finalHost}): that one is the base address of the source, and it may change again.`, { host: finalHost }));
  }

  reasons.push(...robotsReasons(robots));

  // ── Protection ──
  const present = new Set();
  for (const page of pages) for (const v of page.signals ? page.signals.vendors : []) present.add(v);
  // The data paths are judged on their own (dataReasons): a refused API next to open pages is not "a challenge on some pages".
  const siteWide = pages.filter((p) => p.label !== 'data');
  const challenged = siteWide.filter((p) => p.signals && p.signals.challenge !== 'none');
  const interactive = challenged.filter((p) => p.signals.challenge === 'interactive');
  const blocked = challenged.filter((p) => p.signals.challenge === 'blocked');
  const passable = challenged.filter((p) => p.signals.challenge === 'js' || p.signals.challenge === 'shell');
  const adNetworks = [...new Set(pages.flatMap((p) => (p.signals ? p.signals.adNetworks : [])))];

  if (present.size && !challenged.length) {
    reasons.push(reason('protection-present', 'info', `${[...present].join(', ')} is in front of the site, but it let the plain requests through (${labelList(siteWide)}).`));
  }
  if (interactive.length) reasons.push(reason('challenge-interactive', 'block', `A CAPTCHA / Turnstile check stands in the way (${labelList(interactive)}). The project does not solve CAPTCHAs.`));
  if (blocked.length) reasons.push(reason('challenge-blocked', 'block', `The protection refused the request outright (${labelList(blocked)}: ${[...new Set(blocked.flatMap((p) => p.signals.signals))].join(', ')}).`));
  if (passable.length) {
    const solved = pages.filter((p) => p.appFetch);
    const everyone = passable.length === siteWide.length;
    reasons.push(reason('challenge-js', 'warn', `${[...present].join(', ') || 'The site'} serves a JavaScript challenge${everyone ? ' on every page tried' : ` on some pages (${labelList(passable)})`}: the plain request gets a "just a moment" page, not the content. It can only work through FlareSolverr (a real browser the app starts), which is slower.`));
    if (!everyone) reasons.push(reason('challenge-partial', 'info', `Only some pages are challenged (${labelList(passable)}): confirm every path the source will use, not just the home page.`));
    if (appFetchUsed) {
      const failed = solved.filter((p) => p.appFetch && !p.appFetch.ok);
      if (failed.length) reasons.push(reason('app-fetch-failed', 'block', `The app's own fetch (with FlareSolverr) did not get through either (${labelList(failed)}): ${failed[0].appFetch.message}.`));
      else if (solved.length) reasons.push(reason('app-fetch-ok', 'info', `The app's own fetch got the real page through the challenge (${labelList(solved)}).`));
    }
  }

  // ── What is on the pages ──
  if (adNetworks.length) {
    const rule = passable.length || interactive.length || blocked.length;
    reasons.push(reason(rule ? 'challenge-with-ads' : 'ads', rule ? 'block' : 'warn', rule
      ? `The site is challenged and also loads ad networks (${adNetworks.join(', ')}): reading it through a browser would run their code. The guide's rule: not viable.`
      : `The site loads ad networks (${adNetworks.join(', ')}): never open it in a browser to study it; plain requests only.`, { networks: adNetworks }));
  }
  if (pages.some((p) => p.signals && p.signals.login)) reasons.push(reason('login-wall', 'block', 'The pages ask for a login. The project does not log in to sites.'));
  if (pages.some((p) => p.signals && p.signals.ageGate)) reasons.push(reason('age-gate', 'info', 'The site shows an age check. If the content is behind it for plain requests, the source has to read the page as it comes.'));
  if (pages.some((p) => p.status === 429)) reasons.push(reason('rate-limited', 'warn', 'The site answered 429 (too many requests): the test spaces its requests and stops on repeats, but expect to be slow.'));
  if (home.signals && home.signals.spa && !home.signals.nextData) {
    reasons.push(reason('spa-shell', 'warn', 'The home page is an empty shell filled in by JavaScript: the titles come from a JSON API, which has to be found (and checked against robots.txt) before a source is possible.'));
  }
  if (home.signals && home.signals.nextData) reasons.push(reason('next-data', 'info', 'A Next.js site: the data is in the HTML (see the guide\'s section on Next.js sites).'));
  if (home.signals && !home.signals.spa && home.signals.challenge === 'none' && home.signals.links < 5 && !home.signals.login) {
    reasons.push(reason('few-links', 'warn', `The home page has hardly any links to the site's own pages (${home.signals.links}): it may be a landing page, a redirect or a shell.`));
  }

  reasons.push(...dataReasons(pages, home));
  reasons.push(...chapterReasons(pages, home));

  const dataNeedsSolver = reasons.some((r) => r.id === 'data-protected' && r.severity === 'warn');
  const verdict = reasons.some((r) => r.severity === 'block') ? 'not-viable' : (passable.length || dataNeedsSolver ? 'needs-solver' : 'open');
  return { verdict, reasons };
}

module.exports = { decide, reason };
