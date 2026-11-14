'use strict';

// Host-name helpers shared by the solver pool (which site a navigation belongs
// to), the saved Cloudflare cookies and System Health. Pure functions on
// strings: no I/O, nothing starts at require() time.

const net = require('net');
const { TWO_LEVEL_SUFFIXES } = require('../../config/solver');

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:\/\//i;

function stripBrackets(text) {
  return text.replace(/^\[|\]$/g, '');
}

// The URL parser's spelling of an IPv6 address (compressed, lower-case), so a bare "2001:0db8::7"
// and the host of "http://[2001:0db8::7]/" give the same key. An address URL() refuses (one with a
// zone id, fe80::1%eth0) keeps its own spelling.
function ipv6Normal(address) {
  try {
    return stripBrackets(new URL(`http://[${address}]/`).hostname);
  } catch {
    return address.toLowerCase();
  }
}

// The host name inside a URL or a bare host ("example.com", "example.com:8443",
// "[::1]"), lower-case, without brackets, port or trailing dot; '' when there is
// none. Going through URL() gives IDN and odd IPv4 spellings (2130706433,
// 0x7f.1) the same normal form the rest of the app sees.
function hostnameOf(value) {
  try {
    const text = String(value ?? '').trim();
    if (!text) return '';
    // A bare IPv6 address is full of colons: URL() would read it as a scheme.
    const bare = stripBrackets(text);
    if (net.isIPv6(bare)) return ipv6Normal(bare);
    if (net.isIPv4(bare)) return bare;
    const { hostname } = new URL(SCHEME_PREFIX.test(text) ? text : `http://${text}`);
    return stripBrackets(hostname).replace(/\.$/, '').toLowerCase();
  } catch {
    return '';
  }
}

// A country-code pair such as co.th, com.pl, or.id or com.eg: a second-level label of at most
// three letters under a two-letter top level. Registries all over the world sell names under
// these, and a hand-written list can never hold them all, so the shape decides. The price is a
// real site that happens to look like one (cdn.fox.tv is read as a site of its own, not as part
// of fox.tv): its subdomains then stop sharing saved cookies, which is the safe way to be wrong.
// Letters only, so an internationalised label (xn--...) or a digit never makes one.
const COUNTRY_CODE_PAIR = /^[a-z]{1,3}\.[a-z]{2}$/;

// The site a host belongs to: the last two labels, or the last three under a
// two-level suffix (TWO_LEVEL_SUFFIXES, or a country-code pair like co.th). IP
// literals and single labels are their own site.
function scopeOf(hostname) {
  if (!hostname) return 'default';
  if (net.isIP(hostname)) return hostname;
  let labels = hostname.split('.');
  if (labels.includes('')) return 'default';
  // "www.com" is a site of its own; only a longer name loses its www.
  if (labels.length > 2 && labels[0] === 'www') labels = labels.slice(1);
  if (labels.length <= 2) return labels.join('.');
  const suffix = labels.slice(-2).join('.');
  const twoLevel = TWO_LEVEL_SUFFIXES.has(suffix) || COUNTRY_CODE_PAIR.test(suffix);
  return labels.slice(twoLevel ? -3 : -2).join('.');
}

/**
 * The key for "same site" everywhere a host is compared: the pool's spacing and
 * cooldown, single-flight, saved Cloudflare cookies. Accepts a URL or a bare
 * host. 'default' when nothing parses. Never throws.
 *
 * Replaces the "last two labels" copies in fetch-utils.js, which gave every
 * site under co.uk the one key "co.uk" and so shared their saved cookies.
 */
function hostKeyOf(urlOrHostname) {
  return scopeOf(hostnameOf(urlOrHostname));
}

/**
 * True when the URL points at this computer: localhost, 127.0.0.0/8 or [::1].
 * Judged on the parsed host, so "127.0.0.1.evil.com" and "localhost.evil.com"
 * are not loopback. A string with no scheme is not a URL here.
 */
function isLoopbackUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === 'localhost'
      || hostname === '[::1]'
      || (net.isIPv4(hostname) && hostname.startsWith('127.'));
  } catch {
    return false;
  }
}

module.exports = {
  hostKeyOf,
  isLoopbackUrl,
};
