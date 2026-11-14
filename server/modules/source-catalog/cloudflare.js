'use strict';

const net = require('net');
const dns = require('dns').promises;

// Whether a site sits behind Cloudflare, WITHOUT contacting the site: its name is looked up in the DNS and the addresses it answers
// are compared with the address ranges Cloudflare publishes. Behind Cloudflare is not the same as blocked by a challenge (many sites
// use it only to be served faster and open without any), so this is a label and a filter, never a verdict.
//
// The published ranges are fetched and kept for a week; the list below is the one known when this was written and is used only when
// they cannot be fetched.

const FALLBACK_V4 = Object.freeze([
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
]);
const FALLBACK_V6 = Object.freeze([
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]);
const RANGE_RE = /^([0-9a-f:.]{2,45})\/(\d{1,3})$/i;
const RANGES_KEY = 'ranges';

/** The ranges in a published list (one per line); a line that is not an address range is dropped. */
function parseRanges(text, family) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = RANGE_RE.exec(line.trim());
    if (!match) continue;
    const prefix = Number(match[2]);
    if (net.isIP(match[1]) !== (family === 'ipv4' ? 4 : 6) || prefix > (family === 'ipv4' ? 32 : 128)) continue;
    out.push(`${match[1]}/${prefix}`);
  }
  return out;
}

function buildBlockList({ v4, v6 }) {
  const list = new net.BlockList();
  for (const range of v4) { const [addr, prefix] = range.split('/'); list.addSubnet(addr, Number(prefix), 'ipv4'); }
  for (const range of v6) { const [addr, prefix] = range.split('/'); list.addSubnet(addr, Number(prefix), 'ipv6'); }
  return list;
}

/**
 * @param {{ urls: { v4: string, v6: string }, fetchText: (url: string, maxBytes: number) => Promise<{ status: number, text: string }>, cache: { getFresh: Function, set: Function, ensureLoaded: Function }, ttlMs: number, maxBytes: number, dnsTtlMs: number, resolver?: { resolve4: Function, resolve6: Function } }} deps
 */
function createCloudflareCheck({ urls, fetchText, cache, ttlMs, maxBytes, dnsTtlMs, resolver }) {
  const dnsResolver = resolver || new dns.Resolver({ timeout: 4000, tries: 1 });
  let blockList = null;

  async function ranges() {
    if (blockList) return blockList;
    await cache.ensureLoaded();
    let found = cache.getFresh(RANGES_KEY, ttlMs);
    if (!found) {
      try {
        const [v4, v6] = await Promise.all([fetchText(urls.v4, maxBytes), fetchText(urls.v6, maxBytes)]);
        const parsed = { v4: v4.status === 200 ? parseRanges(v4.text, 'ipv4') : [], v6: v6.status === 200 ? parseRanges(v6.text, 'ipv6') : [] };
        // A list that came back empty or half empty is not trusted: the known one is used.
        if (parsed.v4.length >= 5 && parsed.v6.length >= 3) { found = parsed; cache.set(RANGES_KEY, parsed); }
      } catch (_) { /* the known ranges below */ }
    }
    blockList = buildBlockList(found || { v4: FALLBACK_V4, v6: FALLBACK_V6 });
    return blockList;
  }

  async function addressesOf(host) {
    const settle = (promise) => promise.then((list) => (Array.isArray(list) ? list : []), () => []);
    const [a, aaaa] = await Promise.all([settle(dnsResolver.resolve4(host)), settle(dnsResolver.resolve6(host))]);
    return { v4: a, v6: aaaa };
  }

  /** 'yes' | 'no' | 'unknown' (the name did not answer). Remembered for a day. */
  async function check(host) {
    const name = String(host || '').toLowerCase();
    if (!name || net.isIP(name) || name === 'localhost' || !name.includes('.')) return 'unknown';
    await cache.ensureLoaded();
    const kept = cache.getFresh(name, dnsTtlMs);
    if (kept) return kept;
    const { v4, v6 } = await addressesOf(name);
    let verdict;
    if (!v4.length && !v6.length) verdict = 'unknown';
    else {
      const list = await ranges();
      verdict = v4.some((ip) => list.check(ip, 'ipv4')) || v6.some((ip) => list.check(ip, 'ipv6')) ? 'yes' : 'no';
    }
    cache.set(name, verdict);
    return verdict;
  }

  /** What is already known for the host, without asking anything: 'yes' | 'no' | 'unknown' | null. */
  async function known(host) {
    await cache.ensureLoaded();
    return cache.getFresh(String(host || '').toLowerCase(), dnsTtlMs) || null;
  }

  /** The same as known(), for a cache that is already loaded (the caller awaited cache.ensureLoaded()). */
  const peek = (host) => cache.getFresh(String(host || '').toLowerCase(), dnsTtlMs) || null;

  return { check, known, peek, ranges };
}

module.exports = { createCloudflareCheck, parseRanges, FALLBACK_V4, FALLBACK_V6 };
