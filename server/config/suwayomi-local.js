'use strict';

// The Suwayomi-Server that ScrollScape can set up and run on this Windows computer (server/modules/suwayomi/local-server.js), and the same one that
// tools/windows/Setup-Suwayomi.cmd sets up: ONE tested version, and the SHA-256 and size GitHub lists for that file. A test pins the two places to the
// same values. Nothing here is ever taken from a request.
module.exports = Object.freeze({
  asset: Object.freeze({
    tag: 'v2.4.2366',
    name: 'Suwayomi-Server-v2.4.2366-windows-x64.zip',
    sha256: 'b955f374a8d94b8d1c2750ae28fa7eb2066b479957561b5ba9cf8ac993c8fc13',
    size: 343828201,
    url: 'https://github.com/Suwayomi/Suwayomi-Server/releases/download/v2.4.2366/Suwayomi-Server-v2.4.2366-windows-x64.zip',
  }),
  // The folder inside the ScrollScape folder, and the address it listens on: this computer only.
  folderName: 'Suwayomi',
  host: '127.0.0.1',
  port: 4567,
  username: 'scrollscape',
  passwordLength: 28,
  // Free space the download, the unpacked files and some room need.
  minFreeBytes: 1.5 * 1024 ** 3,
  // The most the package may unpack to, and how many files: a package that asks for more than a Suwayomi-Server needs is refused.
  maxUnpackedBytes: 2.5 * 1024 ** 3,
  maxEntries: 20_000,
  downloadTimeoutMs: 30 * 60_000,
  readyTimeoutMs: 180_000,
  probeTimeoutMs: 3_000,
  firewallRuleName: 'ScrollScape Suwayomi - no home network',
  // Never reached by the Suwayomi-Server (and so by an extension): the home network, link-local and the Tailscale range.
  blockedRanges: Object.freeze(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10']),
});
