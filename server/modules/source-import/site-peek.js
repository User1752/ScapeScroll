'use strict';

const cheerio = require('cheerio');
const { blockedReason } = require('./site-denylist');

// Reading a page of a live site WITHOUT putting it on disk. A page of a manga site, above all an ad-heavy or protected one, can
// carry malicious JavaScript, and an antivirus quarantines it the moment it is written to a file (it happened: a `curl -o`
// of such a page was flagged INFECTED_JS and the person saw the alarm). So studying a site is done through this, in memory:
// the page is fetched with the app's own private-address-checked request, and what comes back is only a SMALL, plain-text
// answer to a question (the text around a pattern, the values of a selector, a summary), never the page.
//
//   summary  the status, the title, how many scripts, a few links
//   grep     the text around each match of a pattern (the raw HTML, with the markup of the match shown as text)
//   select   the text (or one attribute) of each element a CSS selector finds
//
// The answer is cleaned (control characters and escape sequences removed, whitespace collapsed) and capped, so what is printed
// cannot do anything to a terminal either. Nothing here writes a file.

const BODY_CAP = 2_500_000;
const OUTPUT_CAP = 6000;
const ITEM_CAP = 240;
const MAX_ITEMS = 40;
const WINDOW = 110;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** Text that is safe to print: no control or bidi characters, one line, capped. */
function clean(value, max = ITEM_CAP) {
  return String(value === undefined || value === null ? '' : value).replace(CONTROL_RE, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function summarise($, res, url, body) {
  const links = [];
  $('a[href]').slice(0, 400).each((_, a) => { if (links.length < 8) links.push(`${clean($(a).text(), 40)} -> ${clean($(a).attr('href'), 100)}`); });
  return [
    `status ${res.status}  ${clean(res.contentType, 60)}  ${body.length} bytes`,
    `title: ${clean($('title').first().text(), 120)}`,
    `scripts: ${$('script[src]').length} external, ${$('script:not([src])').length} inline; iframes: ${$('iframe').length}; forms: ${$('form').length}`,
    `links: ${$('a[href]').length}`,
    ...links.map((l) => `  ${l}`),
  ];
}

function grepLines(body, pattern, limit) {
  let re;
  try { re = new RegExp(pattern, 'gi'); } catch (_) { return ['that is not a valid pattern']; }
  const out = [];
  for (const match of body.matchAll(re)) {
    if (out.length >= limit) { out.push('... more matches not shown'); break; }
    const from = Math.max(0, match.index - WINDOW);
    out.push(clean(body.slice(from, match.index + match[0].length + WINDOW)));
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return out.length ? out : ['no match'];
}

function selectLines($, selector, attr, limit) {
  let nodes;
  try { nodes = $(selector).toArray(); } catch (_) { return ['that is not a valid selector']; }
  if (!nodes.length) return ['no element'];
  const lines = nodes.slice(0, limit).map((node, i) => `${i + 1}. ${clean(attr ? $(node).attr(attr) : $(node).text())}`);
  if (nodes.length > limit) lines.push(`... ${nodes.length - limit} more elements not shown`);
  return lines;
}

/**
 * @param {string} rawUrl
 * @param {{ grep?: string, select?: string, attr?: string, limit?: number, method?: string }} [question]
 * @param {{ fetchImpl?: Function, userAgent?: string }} [deps]
 * @returns {Promise<{ url: string, status: number, lines: string[] }>}
 */
async function peekPage(rawUrl, question = {}, deps = {}) {
  const url = new URL(String(rawUrl));
  const refused = blockedReason(url.href, deps.denylist || []);
  if (refused) throw new Error(`Not asked, it is on the list of dangerous sites (${refused}).`);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Only plain http(s) addresses can be looked at.');
  const fetchImpl = deps.fetchImpl || require('../network/safe-fetch').safeFetch;
  const userAgent = deps.userAgent || require('../network/fetch-utils').DEFAULT_USER_AGENT;
  const method = String(question.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';
  const limit = Math.max(1, Math.min(MAX_ITEMS, Number(question.limit) || 20));
  const res = await fetchImpl(url.href, {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
    headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', ...(method === 'POST' ? { 'X-Requested-With': 'XMLHttpRequest' } : {}) },
  });
  const body = (await res.text()).slice(0, BODY_CAP);
  const info = { status: res.status, contentType: res.headers.get('content-type') || '' };
  const $ = cheerio.load(body);
  let lines;
  if (question.grep) lines = grepLines(body, String(question.grep), limit);
  else if (question.select) lines = selectLines($, String(question.select), question.attr ? String(question.attr) : '', limit);
  else lines = summarise($, info, url.href, body);
  let used = 0;
  const kept = [];
  for (const line of lines) { used += line.length + 1; if (used > OUTPUT_CAP) { kept.push('... output cut'); break; } kept.push(line); }
  return { url: url.href, status: res.status, lines: kept };
}

/**
 * The text of a page, for code that reads it in this process (the generator's discovery): in memory, never printed, never written;
 * the same address checks as peekPage (a plain public https/http address, not on the list of dangerous sites).
 */
async function readPageText(rawUrl, deps = {}) {
  const url = new URL(String(rawUrl));
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Only plain http(s) addresses can be looked at.');
  const refused = blockedReason(url.href, deps.denylist || []);
  if (refused) throw new Error(`Not asked, it is on the list of dangerous sites (${refused}).`);
  const fetchImpl = deps.fetchImpl || require('../network/safe-fetch').safeFetch;
  const userAgent = deps.userAgent || require('../network/fetch-utils').DEFAULT_USER_AGENT;
  const res = await fetchImpl(url.href, { redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': userAgent, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, BODY_CAP);
}

module.exports = { peekPage, readPageText, clean };
