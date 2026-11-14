'use strict';

// Looking at a site before writing a source for it (server/modules/source-import/site-*.js): what each kind of answer is read
// as (a Cloudflare challenge, a CAPTCHA, a login, an empty shell, ad networks, robots.txt) and what that means for the verdict.
// The "site" is a function from a URL to a Response, so every case can be made on purpose and nothing touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');

const sig = require('../../server/modules/source-import/site-signatures');
const { probeSite, normaliseInput, DEFAULT_LIMITS } = require('../../server/modules/source-import/site-probe');
const { decide } = require('../../server/modules/source-import/site-verdict');

const UA = 'test-agent';
const links = (n, prefix = '/manga/title-') => Array.from({ length: n }, (_, i) => `<a href="${prefix}${i}">Title ${i}</a>`).join('');
const page = (body, title = 'A Manga Site') => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
const REAL = page(`<form action="/search" method="get"><input type="text" name="q"></form>${links(24)}`);
const CF_HEADERS = { server: 'cloudflare', 'cf-ray': '8a1b2c3d-AMS', 'content-type': 'text/html' };
const CF_CHALLENGE = '<!doctype html><html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script><noscript>Enable JavaScript</noscript></body></html>';

const read = (body, { status = 200, headers = {}, url = 'https://manga.example/' } = {}) => sig.readSignals({ status, headers, body, url });

// ── What one answer says ──────────────────────────────────────────────────

test('a Cloudflare "Just a moment" page is a JavaScript challenge, and Cloudflare is named', () => {
  const s = read(CF_CHALLENGE, { status: 403, headers: CF_HEADERS });
  assert.equal(s.challenge, 'js');
  assert.deepEqual(s.vendors, ['Cloudflare']);
  assert.ok(s.signals.includes('just-a-moment'));
});

test('Cloudflare in front of a real page (its script on the page, 24 links) is information, not a challenge', () => {
  const body = page(`<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>${links(24)}`);
  const s = read(body, { headers: CF_HEADERS });
  assert.equal(s.challenge, 'none');
  assert.deepEqual(s.vendors, ['Cloudflare']);
  assert.ok(s.links >= 24);
});

test('cf-mitigated: challenge is a challenge even when the body is not recognisable', () => {
  assert.equal(read('<html><body>x</body></html>', { status: 403, headers: { 'cf-mitigated': 'challenge' } }).challenge, 'js');
});

test('a Turnstile / CAPTCHA page with nothing of the site on it is interactive; a CAPTCHA on a comment form of a real page is not', () => {
  const wall = page('<div class="cf-turnstile" data-sitekey="x"></div><p>Verify you are human</p>', 'Security check');
  assert.equal(read(wall, { status: 403, headers: CF_HEADERS }).challenge, 'interactive');
  const form = page(`${links(30)}<form><div class="g-recaptcha"></div></form>`);
  const s = read(form);
  assert.equal(s.challenge, 'none');
  assert.equal(s.captcha, true);
});

test('Cloudflare block pages (error 1020, "Attention Required") are blocks, not challenges to wait out', () => {
  assert.equal(read(page('<h1>Access denied</h1><p>Error code: 1020</p>', 'Attention Required! | Cloudflare'), { status: 403, headers: CF_HEADERS }).challenge, 'blocked');
});

test('other anti-bot services are named, and a refusal that explains nothing is still a refusal', () => {
  const dg = read(page('<p>DDoS-Guard check</p>', 'DDoS-Guard'), { status: 403, headers: { server: 'ddos-guard' } });
  assert.ok(dg.vendors.includes('DDoS-Guard'));
  assert.notEqual(dg.challenge, 'none');
  const bare = read('<html><body>Forbidden</body></html>', { status: 403 });
  assert.equal(bare.challenge, 'blocked');
  assert.deepEqual(bare.signals, ['status-403']);
  const dd = read(page(`${links(30)}`), { headers: { 'x-datadome': 'protected' } });
  assert.ok(dd.vendors.includes('DataDome'));
  assert.equal(dd.challenge, 'none');
});

test('a site\'s own bot-check shell is recognised the way the app\'s fetch does', () => {
  assert.equal(read('<html><script>var cdp_flags = 1;</script></html>').challenge, 'shell');
});

test('a login wall, an empty JavaScript shell, a Next.js page and an age check are told apart', () => {
  assert.equal(read(page('<form><input type="password" name="p"></form>', 'Login')).login, true);
  assert.equal(read(page(`<p>You must be logged in</p>${links(2)}`)).login, true);
  assert.equal(read(REAL).login, false, 'a real page with a search box is not a login');
  const shell = read('<html><head><title>App</title><script src="/a.js"></script><script src="/b.js"></script></head><body><div id="root"></div></body></html>');
  assert.equal(shell.spa, true);
  assert.equal(read(REAL).spa, false);
  const next = read(page(`${links(20)}<script id="__NEXT_DATA__" type="application/json">{}</script>`));
  assert.equal(next.nextData, true);
  assert.equal(read(page(`${links(20)}<p>Are you over 18?</p>`)).ageGate, true);
});

test('ad networks are found in scripts, frames and inline code, once each', () => {
  const body = page(`${links(12)}<script src="https://a.exoclick.com/ad.js"></script><iframe src="https://syndication.exosrv.com/x"></iframe><script>var u="https://popads.net/pop.js"</script>`);
  assert.deepEqual(read(body).adNetworks.sort(), ['ExoClick', 'PopAds']);
  assert.deepEqual(read(REAL).adNetworks, []);
});

test('only links to the site\'s own domain count towards "a real page"', () => {
  const foreign = page(Array.from({ length: 20 }, (_, i) => `<a href="https://elsewhere.example/${i}">x</a>`).join(''));
  assert.equal(read(foreign).links, 0);
  assert.ok(read(page(`<a href="https://www.manga.example/a">a</a><a href="//cdn.manga.example/b">b</a><a href="/c">c</a>`)).links >= 3);
  assert.equal(read(page('<a href="#top">t</a><a href="javascript:void(0)">j</a><a href="mailto:a@b.c">m</a>')).links, 0);
});

test('the registrable domain is told from a subdomain and from a second-level suffix', () => {
  assert.equal(sig.registrableDomain('www.manga.example'), 'manga.example');
  assert.equal(sig.registrableDomain('cdn.eu.manga.example'), 'manga.example');
  assert.equal(sig.registrableDomain('site.co.uk'), 'site.co.uk');
  assert.equal(sig.registrableDomain('a.site.co.uk'), 'site.co.uk');
});

// ── Finding the pages to look at ──────────────────────────────────────────

test('the search address comes from the page\'s own GET search form, and a POST form or a login form is not one', () => {
  assert.equal(sig.searchUrlFrom(REAL, 'https://manga.example/'), 'https://manga.example/search?q=a');
  assert.equal(sig.searchUrlFrom('<form action="/find" method="get"><input type="hidden" name="type" value="manga"><input name="keyword"></form>', 'https://manga.example/x'), 'https://manga.example/find?type=manga&keyword=a');
  assert.equal(sig.searchUrlFrom('<form method="post" action="/s"><input name="q"></form>', 'https://manga.example/'), '');
  assert.equal(sig.searchUrlFrom('<form><input type="password" name="q"></form>', 'https://manga.example/'), '');
  assert.equal(sig.searchUrlFrom('', 'https://manga.example/'), '');
});

test('a title page is the commonest path pattern with at least three pages under it, and never a tag or a login page', () => {
  const html = page(`${links(4, '/tag/')}${links(3, '/series/s-')}${links(2, '/login/')}<a href="https://elsewhere.example/series/x">x</a>`);
  assert.equal(sig.detailUrlFrom(html, 'https://manga.example/'), 'https://manga.example/series/s-0');
  assert.equal(sig.detailUrlFrom(page(links(2, '/series/s-')), 'https://manga.example/'), '');
});

// ── robots.txt ────────────────────────────────────────────────────────────

test('robots.txt: the rules for every robot, the longest match wins and an Allow wins a tie', () => {
  const rules = sig.parseRobots('User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nDisallow: /api/\nDisallow: /search\nAllow: /search/public\n# a comment\nDisallow: /*.json$\nSitemap: https://x/s.xml');
  assert.equal(sig.robotsDisallows(rules, '/api/v2/manga'), true);
  assert.equal(sig.robotsDisallows(rules, '/search?q=a'), true);
  assert.equal(sig.robotsDisallows(rules, '/search/public/x'), false);
  assert.equal(sig.robotsDisallows(rules, '/data/list.json'), true);
  assert.equal(sig.robotsDisallows(rules, '/data/list.json?x=1'), false, 'the $ anchors the end');
  assert.equal(sig.robotsDisallows(rules, '/manga/one'), false);
  assert.equal(sig.robotsDisallows(sig.parseRobots('User-agent: *\nDisallow:'), '/anything'), false, 'an empty Disallow allows everything');
  assert.deepEqual(sig.parseRobots(''), []);
});

// ── The probe, over a fake site ───────────────────────────────────────────

function fakeSite(routes) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(String(url));
    assert.equal(init.redirect, 'manual', 'redirects are followed by the probe, hop by hop');
    const u = new URL(url);
    const hit = routes[`${u.origin}${u.pathname}${u.search}`] || routes[u.pathname + u.search] || routes[u.pathname];
    const res = typeof hit === 'function' ? hit(u) : hit;
    if (!res) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
    if (res instanceof Error) throw res;
    return new Response(res.body, { status: res.status || 200, headers: { 'content-type': 'text/html', ...(res.headers || {}) } });
  };
  return { fetchImpl, seen };
}
const probe = (routes, url = 'https://manga.example/', extra = {}) => {
  const site = fakeSite(routes);
  return probeSite(url, { fetchImpl: site.fetchImpl, userAgent: UA, sleep: async () => {}, ...extra }).then((result) => ({ result, seen: site.seen }));
};
const reasonIds = (result) => result.reasons.map((r) => r.id);

test('an open site: home, robots.txt, its own search and one title are looked at, and nothing is in the way', async () => {
  const { result, seen } = await probe({
    '/': { body: REAL },
    '/robots.txt': { body: 'User-agent: *\nDisallow: /admin/' },
    '/search?q=a': { body: REAL },
    '/manga/title-0': { body: REAL },
  });
  assert.equal(result.verdict, 'open', JSON.stringify(result.reasons));
  assert.deepEqual(result.pages.map((p) => p.label), ['home', 'search', 'detail']);
  assert.equal(result.robots.rules, 1);
  assert.ok(seen.includes('https://manga.example/robots.txt'));
  assert.ok(result.pages.every((p) => p.body === undefined), 'the page bodies are not part of the answer');
  assert.ok(result.requests <= DEFAULT_LIMITS.maxRequests);
});

test('Cloudflare that lets the plain request through is reported as present, and the verdict stays open', async () => {
  const { result } = await probe({ '/': { body: REAL, headers: CF_HEADERS }, '/search?q=a': { body: REAL, headers: CF_HEADERS }, '/manga/title-0': { body: REAL, headers: CF_HEADERS } });
  assert.equal(result.verdict, 'open');
  assert.ok(reasonIds(result).includes('protection-present'));
});

test('a Cloudflare challenge on every page is "needs-solver": it says FlareSolverr, and that the other paths must be checked', async () => {
  const challenge = { status: 403, body: CF_CHALLENGE, headers: CF_HEADERS };
  const { result } = await probe({ '/': challenge, '/robots.txt': { body: 'User-agent: *\nDisallow:' }, '/?s=a': challenge });
  assert.equal(result.verdict, 'needs-solver');
  assert.ok(reasonIds(result).includes('challenge-js'));
  assert.match(result.reasons.find((r) => r.id === 'challenge-js').text, /FlareSolverr/);
});

test('a challenge on only some pages is flagged as partial', async () => {
  const challenge = { status: 403, body: CF_CHALLENGE, headers: CF_HEADERS };
  const { result } = await probe({ '/': { body: REAL, headers: CF_HEADERS }, '/search?q=a': challenge, '/manga/title-0': { body: REAL, headers: CF_HEADERS } });
  assert.equal(result.verdict, 'needs-solver');
  assert.ok(reasonIds(result).includes('challenge-partial'));
});

test('a challenge on a site that also loads ad networks is not viable (the guide\'s rule)', async () => {
  const ads = '<script src="https://a.exoclick.com/x.js"></script>';
  const { result } = await probe({ '/': { status: 403, body: CF_CHALLENGE.replace('</body>', `${ads}</body>`), headers: CF_HEADERS } });
  assert.equal(result.verdict, 'not-viable');
  assert.ok(reasonIds(result).includes('challenge-with-ads'));
});

test('ads on a site that answers plainly are a warning, not a verdict', async () => {
  const ads = '<script src="https://popads.net/pop.js"></script>';
  const { result } = await probe({ '/': { body: REAL + ads }, '/search?q=a': { body: REAL }, '/manga/title-0': { body: REAL } });
  assert.equal(result.verdict, 'open');
  assert.equal(result.reasons.find((r) => r.id === 'ads').severity, 'warn');
});

test('an interactive CAPTCHA, a login wall and a block page are each not viable', async () => {
  const wall = page('<div class="cf-turnstile"></div><p>Verify you are human</p>', 'Security check');
  assert.equal((await probe({ '/': { status: 403, body: wall, headers: CF_HEADERS } })).result.verdict, 'not-viable');
  assert.ok(reasonIds((await probe({ '/': { body: page('<form><input type="password" name="p"></form>') } })).result).includes('login-wall'));
  const blocked = (await probe({ '/': { status: 403, body: page('<p>Error code: 1020</p>', 'Attention Required! | Cloudflare'), headers: CF_HEADERS } })).result;
  assert.equal(blocked.verdict, 'not-viable');
  assert.ok(reasonIds(blocked).includes('challenge-blocked'));
});

test('robots.txt that forbids everything, or the search the source would use, is not viable; the API directory is only a warning', async () => {
  const site = { '/': { body: REAL }, '/search?q=a': { body: REAL }, '/manga/title-0': { body: REAL } };
  const all = (await probe({ ...site, '/robots.txt': { body: 'User-agent: *\nDisallow: /' } })).result;
  assert.equal(all.verdict, 'not-viable');
  assert.ok(reasonIds(all).includes('robots-disallow-all'));
  assert.ok(!reasonIds(all).includes('robots-disallows-home'), 'the same refusal is not said twice');
  const search = (await probe({ ...site, '/robots.txt': { body: 'User-agent: *\nDisallow: /search' } })).result;
  assert.equal(search.verdict, 'open', 'a forbidden text search is common and the source can still list, browse and read');
  assert.equal(search.reasons.find((r) => r.id === 'robots-disallows-search').severity, 'warn');
  assert.match(search.reasons.find((r) => r.id === 'robots-disallows-search').text, /not search by text/);
  const api = (await probe({ ...site, '/robots.txt': { body: 'User-agent: *\nDisallow: /api/' } })).result;
  assert.equal(api.verdict, 'open');
  assert.equal(api.reasons.find((r) => r.id === 'robots-disallows-api').severity, 'warn');
});

test('a domain that redirects is followed hop by hop and reported, with the new base address', async () => {
  const { result, seen } = await probe({
    'https://old.example/': { status: 301, headers: { location: 'https://new.example/' }, body: '' },
    'https://new.example/': { body: REAL.replace(/\/manga\//g, '/manga/') },
    'https://new.example/search?q=a': { body: REAL },
    'https://new.example/manga/title-0': { body: REAL },
  }, 'https://old.example/');
  assert.equal(result.verdict, 'open');
  const changed = result.reasons.find((r) => r.id === 'domain-changed');
  assert.equal(changed.host, 'new.example');
  assert.equal(result.pages[0].redirects.length, 1);
  assert.ok(seen.includes('https://new.example/robots.txt'), 'robots.txt is read from the domain the link lands on');
});

test('a site that does not answer, an address that is not found and a private address are "unreachable", with the reason', async () => {
  assert.equal((await probe({ '/': new Error('fetch failed') })).result.verdict, 'unreachable');
  const dns = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  assert.match((await probe({ '/': dns })).result.reasons[0].text, /DNS/);
  const missing = (await probe({ '/': { status: 404, body: 'x' } })).result;
  assert.equal(missing.verdict, 'unreachable');
  assert.equal(missing.reasons[0].id, 'not-found');
  const priv = await probeSite('http://127.0.0.1:9/', { userAgent: UA, sleep: async () => {} });
  assert.equal(priv.verdict, 'unreachable');
  assert.match(priv.reasons[0].text, /not a public one/);
});

test('an empty JavaScript shell warns that the titles come from an API; a Next.js page says the data is in the HTML', async () => {
  const shell = '<html><head><title>App</title><script src="/a.js"></script><script src="/b.js"></script></head><body><div id="root"></div></body></html>';
  const { result } = await probe({ '/': { body: shell } });
  assert.ok(reasonIds(result).includes('spa-shell'));
  const next = (await probe({ '/': { body: page(`${links(20)}<script id="__NEXT_DATA__" type="application/json">{}</script>`) } })).result;
  assert.ok(reasonIds(next).includes('next-data'));
  assert.ok(!reasonIds(next).includes('spa-shell'));
});

test('the app\'s own fetch is asked only when handed in, and only about challenged pages: success keeps "needs-solver", failure is not viable', async () => {
  const challenge = { status: 403, body: CF_CHALLENGE, headers: CF_HEADERS };
  const routes = { '/': challenge, '/?s=a': challenge };
  const asked = [];
  const ok = (await probe(routes, 'https://manga.example/', { appFetch: async (url) => { asked.push(url); return REAL; } })).result;
  assert.equal(ok.verdict, 'needs-solver');
  assert.ok(reasonIds(ok).includes('app-fetch-ok'));
  assert.ok(asked.length >= 1 && asked.length <= DEFAULT_LIMITS.appFetchPages);
  const failed = (await probe(routes, 'https://manga.example/', { appFetch: async () => CF_CHALLENGE })).result;
  assert.equal(failed.verdict, 'not-viable');
  assert.ok(reasonIds(failed).includes('app-fetch-failed'));
  const thrown = (await probe(routes, 'https://manga.example/', { appFetch: async () => { throw new Error('FlareSolverr is not reachable'); } })).result;
  assert.match(thrown.reasons.find((r) => r.id === 'app-fetch-failed').text, /not reachable/);
  const never = await probe({ '/': { body: REAL }, '/search?q=a': { body: REAL }, '/manga/title-0': { body: REAL } }, 'https://manga.example/', { appFetch: async () => { throw new Error('must not be called'); } });
  assert.equal(never.result.verdict, 'open', 'a site that was not challenged never reaches the solver');
});

test('the number of pages asked for has a ceiling, and the pause between them is asked for', async () => {
  const waits = [];
  let clock = 0;
  const { result, seen } = await probe({ '/': { body: REAL }, '/search?q=a': { body: REAL }, '/manga/title-0': { body: REAL } }, 'https://manga.example/', {
    limits: { maxRequests: 2, spacingMs: 500 }, sleep: async (ms) => { waits.push(ms); }, now: () => (clock += 1),
  });
  assert.equal(result.requests, 2);
  assert.equal(seen.length, 2);
  assert.ok(waits.length >= 1 && waits.every((ms) => ms > 0 && ms <= 500));
});

test('the address a person pastes is normalised, and what is not a web address is refused with a reason', () => {
  assert.equal(normaliseInput('manga.example'), 'https://manga.example/');
  assert.equal(normaliseInput('  http://manga.example/path?x=1#frag '), 'http://manga.example/path?x=1');
  for (const bad of ['', '   ', 'not a url', 'ftp://x.example/', 'javascript:alert(1)', 'file:///etc/passwd', 'https://user:pw@manga.example/', null, undefined]) {
    assert.throws(() => normaliseInput(bad), /address|accepted|looked at/, String(bad));
  }
});

test('the verdict needs a home page to say anything, and never throws on an odd page list', () => {
  assert.equal(decide({ input: 'https://x.example/', pages: [], robots: null, appFetchUsed: false }).verdict, 'unreachable');
  const odd = decide({ input: 'https://x.example/', pages: [{ label: 'home', status: 200, finalUrl: 'https://x.example/', signals: null }], robots: { rules: [], checked: [] }, appFetchUsed: false });
  assert.ok(['open', 'needs-solver', 'not-viable'].includes(odd.verdict));
});

test('a site whose search is guessed but whose robots.txt forbids a search-looking path gets a warning; naming the path makes it a verdict', async () => {
  const site = { '/': { body: page(links(24)) }, '/robots.txt': { body: 'User-agent: *\nAllow: /\nAllow: /search?genre=\nDisallow: /search?' }, '/manga/title-0': { body: REAL } };
  const guessed = (await probe(site)).result;
  assert.equal(guessed.verdict, 'open');
  assert.equal(guessed.reasons.find((r) => r.id === 'robots-search-like').severity, 'warn');
  const named = (await probe(site, 'https://manga.example/', { paths: ['/search?q=a'] })).result;
  assert.equal(named.verdict, 'not-viable');
  assert.ok(reasonIds(named).includes('robots-disallows-path'));
  const allowed = (await probe(site, 'https://manga.example/', { paths: ['/search?genre=action'] })).result;
  assert.ok(!reasonIds(allowed).includes('robots-disallows-path'), 'the longer Allow wins');
  const ownForm = (await probe({ ...site, '/': { body: REAL }, '/search?q=a': { body: REAL } })).result;
  assert.ok(!reasonIds(ownForm).includes('robots-search-like'), 'a search form found on the page is judged on its own address instead');
});

test('the command line reads its flags: --id and --path take a value, the rest are switches', () => {
  const { parseArgs, EXIT } = require('../../tools/source-lab');
  const parsed = parseArgs(['https://x.example', '--path', '/a?q=1', '--path', '/b', '--json', '--id', 'demo', '--app-fetch']);
  assert.deepEqual(parsed.positional, ['https://x.example']);
  assert.deepEqual(parsed.flags, { path: ['/a?q=1', '/b'], json: true, id: 'demo', 'app-fetch': true });
  assert.deepEqual(EXIT, { open: 0, 'needs-solver': 10, 'not-viable': 11, unreachable: 12 });
});

test('a search address that was guessed (the page has no search form) is marked as such, and one from the page\'s own form is not', async () => {
  const guessed = (await probe({ '/': { body: page(links(24)) }, '/?s=a': { body: REAL }, '/manga/title-0': { body: REAL } })).result;
  assert.equal(guessed.pages.find((p) => p.label === 'search').guessed, true);
  const own = (await probe({ '/': { body: REAL }, '/search?q=a': { body: REAL }, '/manga/title-0': { body: REAL } })).result;
  assert.equal(own.pages.find((p) => p.label === 'search').guessed, false);
});

test('every path that was checked against robots.txt is in the answer, allowed or not (the command line prints one line each)', async () => {
  const { result } = await probe({ '/': { body: REAL }, '/robots.txt': { body: 'User-agent: *\nDisallow: /panel/' }, '/search?q=a': { body: REAL }, '/manga/title-0': { body: REAL } }, 'https://manga.example/', { paths: ['/search?keyword=a', '/panel/x'] });
  const named = result.robots.checked.filter((c) => c.label === 'path');
  assert.deepEqual(named.map((c) => [c.path, c.disallowed]), [['/search?keyword=a', false], ['/panel/x', true]]);
});

// ── The path the data comes from (probe --data) ───────────────────────────

const OPEN_SITE = { '/': { body: REAL, headers: CF_HEADERS }, '/search?q=a': { body: REAL, headers: CF_HEADERS }, '/manga/title-0': { body: REAL, headers: CF_HEADERS } };
const API_BLOCK = { status: 403, body: page('<p>Error code: 1020</p>', 'Attention Required! | Cloudflare'), headers: CF_HEADERS };

test('pages that open while the data path is refused: not viable, and the reason says why (what a page-only look called open)', async () => {
  const withoutData = await probe(OPEN_SITE);
  assert.equal(withoutData.result.verdict, 'open', 'the case that used to pass for a good site');
  const { result, seen } = await probe({ ...OPEN_SITE, '/api/secure/pipe?e=abc': API_BLOCK }, 'https://manga.example/', { dataPaths: ['/api/secure/pipe?e=abc'] });
  assert.equal(result.verdict, 'not-viable', JSON.stringify(result.reasons));
  const why = result.reasons.find((r) => r.id === 'data-protected');
  assert.equal(why.severity, 'block');
  assert.match(why.text, /pages answer plain requests, but the data path \(\/api\/secure\/pipe\) is refused \(403\)/);
  assert.match(why.text, /project does not do/);
  assert.ok(!why.text.includes('abc'), 'the query of the path (a payload, maybe a token) is not repeated in the report');
  assert.ok(seen.includes('https://manga.example/api/secure/pipe?e=abc'), 'the path was asked for once');
  assert.equal(result.pages.filter((p) => p.label === 'data').length, 1);
  assert.ok(!reasonIds(result).includes('challenge-blocked'), 'it is said once, as the data path, not again as a blocked page');
});

test('a data path that answers a plain request is information, and the verdict stays open', async () => {
  const { result } = await probe({ ...OPEN_SITE, '/api/list': { body: '{"results":[]}', headers: { ...CF_HEADERS, 'content-type': 'application/json' } } }, 'https://manga.example/', { dataPaths: ['/api/list'] });
  assert.equal(result.verdict, 'open', JSON.stringify(result.reasons));
  assert.ok(reasonIds(result).includes('data-open'));
});

test('a data path behind a JavaScript challenge needs FlareSolverr; one that answers 404 is only unclear', async () => {
  const challenge = { status: 403, body: CF_CHALLENGE, headers: CF_HEADERS };
  const solver = (await probe({ ...OPEN_SITE, '/api/list': challenge }, 'https://manga.example/', { dataPaths: ['/api/list'] })).result;
  assert.equal(solver.verdict, 'needs-solver');
  assert.equal(solver.reasons.find((r) => r.id === 'data-protected').severity, 'warn');
  assert.ok(!reasonIds(solver).includes('challenge-partial'), 'the pages are fine: only the data is challenged');
  const unclear = (await probe(OPEN_SITE, 'https://manga.example/', { dataPaths: ['/api/missing'] })).result;
  assert.equal(unclear.verdict, 'open');
  assert.equal(unclear.reasons.find((r) => r.id === 'data-unclear').severity, 'warn');
});

test('a data path robots.txt forbids is not asked, and is a verdict; a path that is not a path is ignored', async () => {
  const { result, seen } = await probe({ ...OPEN_SITE, '/robots.txt': { body: 'User-agent: *\nDisallow: /api/' }, '/api/list': { body: '{}' } }, 'https://manga.example/', { dataPaths: ['/api/list', 'api/other', 42] });
  assert.equal(result.verdict, 'not-viable');
  assert.ok(reasonIds(result).includes('robots-disallows-path'));
  assert.ok(!seen.some((url) => url.includes('/api/')), 'nothing under /api/ was asked for');
  assert.equal(result.pages.filter((p) => p.label === 'data').length, 0);
});
