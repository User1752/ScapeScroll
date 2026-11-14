'use strict';

const { BLANK_HTML, pageHtml } = require('./texts');

// What a site shows and sets, and how a URL or a cookie is matched. Pure: no state, no clock.

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

function cookieMatchesHost(cookie, host) {
  const domain = String(cookie.domain || '').replace(/^\./, '');
  return !!host && !!domain && (host === domain || host.endsWith(`.${domain}`));
}

function matchesUrl(matcher, url) {
  if (matcher instanceof RegExp) {
    matcher.lastIndex = 0;
    return matcher.test(url);
  }
  return matcher === url;
}

const clone = (value) => (value === undefined || value === null ? null : JSON.parse(JSON.stringify(value)));

function setCookie(jar, cookie, host) {
  const stored = { ...cookie, name: String(cookie.name), value: String(cookie.value ?? ''), domain: cookie.domain ? String(cookie.domain) : host, path: cookie.path || '/' };
  jar.set(`${stored.domain}|${stored.path}|${stored.name}`, stored);
}

// The cookies the SITE sets: the scripted ones, or one cf_clearance for the host.
function siteCookies(outcome, url) {
  const host = hostOf(url);
  if (Array.isArray(outcome.cookies)) return outcome.cookies.map((cookie) => ({ ...cookie, domain: cookie.domain || host }));
  if (!host) return [];
  return [{ name: 'cf_clearance', value: `clearance-${host}`, domain: host, path: '/', secure: true, httpOnly: true }];
}

function pageFor(url, outcome) {
  // An empty shell for about:blank / data: is unverified until live check 1.
  const blank = url === 'about:blank' || url.startsWith('data:');
  return { url, html: outcome.html !== undefined ? outcome.html : (blank ? BLANK_HTML : pageHtml(url)) };
}

module.exports = { hostOf, cookieMatchesHost, matchesUrl, clone, setCookie, siteCookies, pageFor };
