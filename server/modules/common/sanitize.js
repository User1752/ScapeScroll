'use strict';

const net = require('net');

// Every address range a server-side fetch must never reach: loopback, the
// three RFC1918 blocks, link-local (cloud metadata lives at 169.254.169.254),
// "this network" (0.0.0.0/8), carrier-grade NAT (100.64.0.0/10 — also where
// Tailscale peers live) and the IPv6 equivalents. net.BlockList does the
// matching on parsed addresses, so a hostname that merely STARTS with digits
// ("10.example.com") is no longer mistaken for an IP and an address written
// in an unusual way can't slip past a string prefix test.
const PRIVATE_RANGES = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
]) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv4');
  // NAT64 (RFC 6052): the IPv4 address sits in the last 32 bits of 64:ff9b::/96,
  // so "64:ff9b::7f00:1" means 127.0.0.1 on a network that translates it. A DNS64
  // resolver answers exactly like this for EVERY IPv4-only public host (phone
  // tethering, some ISPs), so the prefix as a whole must stay reachable and only
  // the private IPv4 ranges are repeated underneath it.
  const [a, b, c, d] = network.split('.').map(Number);
  const embedded = `64:ff9b::${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  PRIVATE_RANGES.addSubnet(embedded, 96 + prefix, 'ipv6');
}
// 6to4 (2002::/16, deprecated by RFC 7526) embeds an IPv4 address too, but nothing
// real is reached that way any more: refuse the whole prefix.
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['2002::', 16]]) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv6');
}

// True for an IP literal (v4 or v6, brackets tolerated) inside one of the
// ranges above. IPv4-mapped IPv6 ("::ffff:127.0.0.1") is checked as the v4
// address it wraps. Anything that isn't an IP literal returns false — a
// DNS name has to be resolved first (see network/safe-fetch.js).
function isPrivateAddress(address) {
  const host = String(address ?? '').replace(/^\[|\]$/g, '');
  const family = net.isIP(host);
  if (!family) return false;
  if (family === 4) return PRIVATE_RANGES.check(host, 'ipv4');
  const mapped = extractMappedIPv4(host);
  if (mapped) return PRIVATE_RANGES.check(mapped, 'ipv4');
  return PRIVATE_RANGES.check(host, 'ipv6');
}

// "localhost", "localhost." (a trailing dot is still the loopback name) and
// anything under .localhost, which resolvers send to loopback (RFC 6761).
function isLocalhostName(host) {
  const name = String(host).toLowerCase().replace(/\.$/, '');
  return name === 'localhost' || name.endsWith('.localhost');
}

function safeManga(manga) {
  if (!manga || typeof manga !== 'object') return {};
  const str = (value, max = 300) => String(value ?? '').slice(0, max);
  const arr = (value) => (Array.isArray(value) ? value.map(entry => str(entry, 100)).slice(0, 50) : []);
  return {
    id: str(manga.id, 100),
    title: str(manga.title),
    cover: str(manga.cover, 500),
    author: str(manga.author),
    description: str(manga.description, 1000),
    status: str(manga.status, 50),
    url: str(manga.url, 500),
    genres: arr(manga.genres),
    type: str(manga.type, 20),
  };
}

// The WHATWG URL parser always normalizes an IPv4-mapped IPv6 host (however
// it was written — dotted "::ffff:127.0.0.1", full "0:0:0:0:0:ffff:127.0.0.1",
// whatever) down to this one compressed hex form, e.g. "::ffff:7f00:1" for
// 127.0.0.1 — so matching just this shape after the fact is enough to catch
// every input spelling, without needing a full IPv6 parser.
function extractMappedIPv4(host) {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isSafeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.replace(/\[|\]/g, '');
    if (isLocalhostName(host) || isPrivateAddress(host)) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  safeManga,
  isSafeUrl,
  isPrivateAddress,
  isLocalhostName,
};