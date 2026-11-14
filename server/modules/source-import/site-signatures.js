'use strict';

const cheerio = require('cheerio');
const { AD_NETWORKS, adNetworksIn } = require('./ad-networks');

// What one answer from a site says about the protection in front of it, read from the status, the headers and the page only
// (nothing here touches the network). site-probe.js asks the questions, site-verdict.js decides what they mean.
//
// The line this draws: a protection that is merely PRESENT (Cloudflare in front of a site that answered with its real page) is
// information; one that stands IN THE WAY (a challenge page instead of the content) is what decides whether a source is
// possible. A challenge page is told apart from a normal one by its shape: it has hardly any links to the site's own pages.

const BODY_CAP = 1_500_000;
const CONTENT_LINKS = 10; // a page with this many internal links is a real page, whatever scripts it carries
const FEW_LINKS = 5;

// Anti-bot services other than Cloudflare: [name, header test, body test].
const VENDORS = Object.freeze([
  ['DDoS-Guard', (h) => /ddos-guard/i.test(h.server || ''), /ddos-guard|\/\.well-known\/ddos-guard/i],
  ['Sucuri', (h) => !!h['x-sucuri-id'] || /sucuri/i.test(h.server || ''), /sucuri website firewall|sucuri\.net\/privacy/i],
  ['Imperva', (h) => !!h['x-iinfo'], /_incapsula_resource|incapsula incident/i],
  ['Akamai', (h) => /akamaighost/i.test(h.server || ''), /reference #[0-9a-f.]+|errors\.edgesuite\.net/i],
  ['PerimeterX', () => false, /px-captcha|_pxappid|perimeterx/i],
  ['DataDome', (h) => !!h['x-datadome'] || /datadome/i.test(h['set-cookie'] || ''), /datadome|geo\.captcha-delivery\.com/i],
  ['AWS WAF', (h) => !!h['x-amzn-waf-action'], /aws-waf|awswaf/i],
]);

const LOGIN_WORDS = /sign in to (continue|view|read)|log in to (continue|view|read)|login required|members only|you must be (logged|signed) in/i;
const AGE_GATE = /are you (over )?18|age verification|verify your age|i am (over )?18|over 18 years/i;
const SEARCH_FIELD = /^(q|s|search|keyword|keywords|query|title|term|name)$/i;

const lowerHeaders = (headers) => {
  const out = {};
  if (headers && typeof headers.forEach === 'function') headers.forEach((value, key) => { out[String(key).toLowerCase()] = String(value); });
  else if (headers && typeof headers === 'object') for (const [key, value] of Object.entries(headers)) out[String(key).toLowerCase()] = String(value);
  return out;
};

const hostOf = (raw) => { try { return new URL(raw).hostname.toLowerCase(); } catch (_) { return ''; } };

// The last two labels of a host, three for the common second-level suffixes: enough to tell "another domain" from "www.".
// What a person would read on the page: the body's text without its scripts, styles and <noscript> blocks.
function visibleText($) {
  const body = $('body').clone();
  body.find('script, style, noscript').remove();
  return body.text().replace(/\s+/g, ' ').trim();
}

function registrableDomain(host) {
  const labels = String(host || '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const secondLevel = new Set(['co', 'com', 'org', 'net', 'gov', 'ac']);
  return (secondLevel.has(labels[labels.length - 2]) && labels[labels.length - 1].length === 2 ? labels.slice(-3) : labels.slice(-2)).join('.');
}

/**
 * Reads one answer.
 * @param {{ status: number, headers: any, body: string, url: string }} res
 * @returns {{
 *   vendors: string[], challenge: 'none'|'js'|'interactive'|'blocked'|'shell', signals: string[], title: string,
 *   links: number, login: boolean, spa: boolean, nextData: boolean, captcha: boolean, ageGate: boolean, adNetworks: string[],
 * }}
 */
function readSignals({ status, headers, body, url }) {
  const h = lowerHeaders(headers);
  const html = String(body || '').slice(0, BODY_CAP);
  const signals = [];
  const vendors = new Set();
  let $;
  try { $ = cheerio.load(html); } catch (_) { $ = cheerio.load(''); }
  const title = $('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 120);

  // Links to the site's own pages (the same registrable domain): what a real page has and a challenge page does not.
  const own = registrableDomain(hostOf(url));
  let links = 0;
  $('a[href]').each((_, a) => {
    const href = String($(a).attr('href') || '');
    if (!href || href.startsWith('#') || /^(javascript|mailto|tel):/i.test(href)) return;
    if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) { links += 1; return; }
    if (registrableDomain(hostOf(href.startsWith('//') ? `https:${href}` : href)) === own) links += 1;
  });
  const shaped = links < FEW_LINKS; // challenge-shaped: nothing of the site's own on it

  // ── Cloudflare ──
  const cloudflare = /cloudflare/i.test(h.server || '') || !!h['cf-ray'];
  if (cloudflare) vendors.add('Cloudflare');
  let challenge = 'none';
  if (/challenge/i.test(h['cf-mitigated'] || '')) { challenge = 'js'; signals.push('cf-mitigated'); }
  if (/^just a moment/i.test(title) || /<title>\s*just a moment/i.test(html)) { challenge = 'js'; signals.push('just-a-moment'); }
  if (shaped && /cdn-cgi\/challenge-platform\/(?!scripts\/jsd)|_cf_chl_opt|cf-chl-/i.test(html)) { challenge = 'js'; signals.push('challenge-platform'); }
  const captcha = /cf-turnstile|challenges\.cloudflare\.com\/turnstile|g-recaptcha|h-captcha|hcaptcha\.com|px-captcha/i.test(html);
  if (shaped && captcha && (challenge !== 'none' || status >= 400 || /verify you are human|are you a robot|security check/i.test(html))) { challenge = 'interactive'; signals.push('captcha'); }
  if (/attention required!? \| cloudflare|error code:? 10(0[5-9]|1[05]|20)\b|sorry, you have been blocked/i.test(`${title} ${html.slice(0, 20000)}`)) { challenge = 'blocked'; signals.push('cloudflare-block'); vendors.add('Cloudflare'); }

  // ── Other anti-bot services ──
  for (const [name, inHeaders, inBody] of VENDORS) {
    const present = inHeaders(h);
    const named = inBody.test(html);
    if (present || named) vendors.add(name);
    if (named && shaped && (status >= 400 || present)) { if (challenge === 'none') challenge = 'blocked'; signals.push(`${name.toLowerCase()}-page`); }
  }

  // ── A site's own bot-check shell (the app already knows two: a proof of work and a webdriver probe) ──
  if (html.includes('cdp_flags') || html.includes('webdriver: navigator.webdriver===true') || (html.includes('/_v') && (html.includes('powNonce') || html.includes('pow_hash')))) {
    if (challenge === 'none') challenge = 'shell';
    signals.push('bot-check-shell');
  }
  // A refusal with no explanation: the protection answered for the site.
  if (challenge === 'none' && [401, 403, 429, 503].includes(status) && shaped) { challenge = vendors.size ? 'js' : 'blocked'; signals.push(`status-${status}`); }

  // ── What kind of page it is ──
  const scripts = $('script[src]').length;
  // An empty page that a bundle fills in: a known mount point and two scripts, or a module script (Vite and friends) alone.
  const bundled = $('script[type=module][src]').length > 0;
  const spa = links < FEW_LINKS && challenge === 'none' && (scripts >= 2 || bundled) && ($('#root, #app, #__next, #__nuxt, [ng-version], [data-reactroot]').length > 0 || bundled) && visibleText($).length < 400;
  const nextData = $('script#__NEXT_DATA__').length > 0 || /self\.__next_f\.push/.test(html);
  const login = (!!$('input[type=password]').length && links < CONTENT_LINKS) || (LOGIN_WORDS.test($('body').text().slice(0, 6000)) && links < CONTENT_LINKS);
  const ageGate = AGE_GATE.test($('body').text().slice(0, 4000));
  const hasFormCaptcha = captcha && challenge !== 'interactive';

  const adMarkup = [];
  $('script[src], iframe[src], link[href], img[src]').each((_, el) => adMarkup.push($(el).attr('src') || $(el).attr('href') || ''));
  $('script:not([src])').each((_, el) => adMarkup.push($(el).html() || ''));
  return {
    vendors: [...vendors], challenge, signals, title, links, login, spa, nextData,
    captcha: hasFormCaptcha || challenge === 'interactive', ageGate, adNetworks: adNetworksIn(adMarkup.join('\n')),
  };
}

/** The address a page's own search form would be asked at, or '' when it has none. Only a GET form counts. */
function searchUrlFrom(html, pageUrl) {
  let $;
  try { $ = cheerio.load(String(html || '').slice(0, BODY_CAP)); } catch (_) { return ''; }
  for (const form of $('form').toArray()) {
    const method = String($(form).attr('method') || 'get').toLowerCase();
    if (method !== 'get') continue;
    const field = $(form).find('input[name]').toArray().find((input) => SEARCH_FIELD.test(String($(input).attr('name'))) && !/^(hidden|submit|checkbox|radio|password)$/i.test(String($(input).attr('type') || 'text')));
    if (!field) continue;
    try {
      const url = new URL($(form).attr('action') || pageUrl, pageUrl);
      $(form).find('input[type=hidden][name]').each((_, hidden) => url.searchParams.set($(hidden).attr('name'), $(hidden).attr('value') || ''));
      url.searchParams.set($(field).attr('name'), 'a');
      return url.href;
    } catch (_) { /* a form whose action is not an address */ }
  }
  return '';
}

const NOT_A_TITLE_SEGMENT = /^(tag|tags|category|categories|genre|genres|page|search|login|register|signin|signup|about|contact|privacy|dmca|terms|user|users|blog|news|faq|help|forum|az-list|latest|popular|trending|rss|feed|wp-content|wp-json|cdn-cgi)$/i;

/** The address of one page that looks like a title or a chapter (the commonest first path segment that has pages under it). */
function detailUrlFrom(html, pageUrl) {
  let $;
  try { $ = cheerio.load(String(html || '').slice(0, BODY_CAP)); } catch (_) { return ''; }
  const own = registrableDomain(hostOf(pageUrl));
  const bySegment = new Map();
  $('a[href]').each((_, a) => {
    let url;
    try { url = new URL($(a).attr('href'), pageUrl); } catch (_) { return; }
    if (!/^https?:$/.test(url.protocol) || registrableDomain(url.hostname) !== own) return;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || NOT_A_TITLE_SEGMENT.test(parts[0])) return;
    const list = bySegment.get(parts[0]) || [];
    list.push(url.href.split('#')[0]);
    bySegment.set(parts[0], list);
  });
  const best = [...bySegment.entries()].filter(([, list]) => list.length >= 3).sort((a, b) => b[1].length - a[1].length)[0];
  return best ? best[1][0] : '';
}

// ── robots.txt ─────────────────────────────────────────────────────────────

/** The rules that apply to every robot ("User-agent: *"): [{ allow: boolean, pattern: string }]. */
function parseRobots(text) {
  const rules = [];
  let applies = false;
  let inAgents = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!inAgents) applies = false;
      inAgents = true;
      if (value === '*') applies = true;
    } else {
      inAgents = false;
      if (applies && (key === 'disallow' || key === 'allow') && value) rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  return rules;
}

function patternMatcher(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/** Whether `pathAndQuery` is off limits: the longest matching rule wins, and an Allow wins a tie. */
function robotsDisallows(rules, pathAndQuery) {
  let best = null;
  for (const rule of rules) {
    if (!patternMatcher(rule.pattern).test(pathAndQuery)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return !!best && !best.allow;
}

module.exports = { readSignals, searchUrlFrom, detailUrlFrom, parseRobots, robotsDisallows, registrableDomain, adNetworksIn, lowerHeaders, hostOf, AD_NETWORKS };
