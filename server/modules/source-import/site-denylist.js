'use strict';

// Sites the probe and peek never ask for anything. The security software on this computer flagged them when the tool (or an agent
// using it) reached for them, so they are dangerous to touch even with plain requests that run no script: a block page of the
// antivirus is the lucky outcome. The list is short and grows by hand: add a domain here (or one per line in data/site-denylist.txt,
// read by tools/source-lab.js) when a security product warns about it. A subdomain of a listed domain is listed too.

const BUILT_IN = Object.freeze([
  ['sushiscan.fr', 'the antivirus blocked it as an infected web resource (2026-10-28)'],
  ['snowscans.com', 'the antivirus blocked it as a phishing page (2026-10-28)'],
  // Not Cloudflare's: its CAPTCHA lives at challenges.cloudflare.com. A look-alike used by fake "verify you are human" pages.
  ['cloudflarecaptcha.com', 'a look-alike of Cloudflare\'s CAPTCHA address with a revoked certificate; the antivirus blocked a connection to it (2026-10-30)'],
]);

const hostOf = (raw) => { try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) { return ''; } };

/** A reason when `url` is on the list (or `extra`, a list of domains), else ''. */
function blockedReason(url, extra = []) {
  const host = hostOf(url);
  if (!host) return '';
  const entries = [...BUILT_IN, ...extra.map((d) => [String(d).trim().toLowerCase().replace(/^www\./, ''), 'it is on this computer\'s own list of dangerous sites'])];
  for (const [domain, reason] of entries) {
    if (domain && (host === domain || host.endsWith(`.${domain}`))) return `${domain}: ${reason}`;
  }
  return '';
}

/** The domains of a data/site-denylist.txt text: one per line, "#" starts a comment. */
function parseDenylist(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.replace(/#.*$/, '').trim().toLowerCase()).filter((line) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(line));
}

module.exports = { blockedReason, parseDenylist, BUILT_IN };
