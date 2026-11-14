'use strict';

// The source catalog (server/modules/source-catalog/): which repository it reads, which content it may offer in this edition,
// and how long what it learned is kept. Every address here is fixed: nothing the browser sends ever becomes one of them.
const edition = require('./edition');

module.exports = Object.freeze({
  // The list of extensions and the sites each one covers (the format the Mihon-compatible repositories publish).
  repoIndexUrl: 'https://github.com/keiyoushi/extensions/raw/repo/index.json',
  // Where the same project keeps the source of each extension: src/<language>/<name>/build.gradle.kts names the theme it is built on.
  themeBaseUrl: 'https://raw.githubusercontent.com/keiyoushi/extensions-source/main/src/',
  // The address ranges Cloudflare publishes for the sites it fronts.
  cloudflareRangesUrls: Object.freeze({ v4: 'https://www.cloudflare.com/ips-v4', v6: 'https://www.cloudflare.com/ips-v6' }),

  // The content warnings of the repository this edition may offer. A browser may ask for fewer, never for more.
  // The edition without sources names its own (edition.js).
  allowedWarnings: edition.catalogWarnings || Object.freeze(['SAFE', 'MIXED', 'NSFW']),
  // Whether the repository the app knows is in the catalog until the person removes it (the edition without sources starts with none).
  defaultRepoOn: edition.defaultRepoOn !== false,
  // The language the list opens on.
  defaultLanguage: 'en',
  // The only hosts a logo may be shown from: where the repository keeps the icon of each extension (a public CDN, never a manga site).
  iconHosts: Object.freeze(['cdn.jsdelivr.net']),

  // The extension engine: a site that has a scraper of its own can be added through the person's own Suwayomi-Server, which runs the
  // extension (server/routes/source-engine.js). Off where the engine is not offered.
  extensionEngine: edition.extensionEngine !== false,
  // Ids of the sources written for the engine: 'sw-' + the id Suwayomi gives the source.
  engineIdPrefix: 'sw-',
  // The repository the person's Suwayomi-Server is asked to know before it installs an extension (the same one the catalog lists).
  engineStoreUrl: 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb',

  // Where an extension's history can be read (its folder in the project that builds them): a link for "what changed", and the text of a CHANGELOG.md when
  // the folder has one. Only the language and the name of the package, both checked, are ever added to these.
  changelogHistoryBase: 'https://github.com/keiyoushi/extensions-source/commits/main/src/',
  changelogMaxBytes: 32 * 1024,
  changelogMaxChars: 1500,
  changelogTtlMs: 24 * 3_600_000,

  indexTtlMs: 24 * 3_600_000,
  // When the repository cannot be reached and an older copy is kept, the older copy is used and the repository is asked again after this.
  indexRetryMs: 5 * 60_000,
  themeTtlMs: 7 * 24 * 3_600_000,
  // A theme that could not be read is asked for again after this, not after a week.
  themeRetryMs: 30 * 60_000,
  dnsTtlMs: 24 * 3_600_000,
  // A site the template could not be written for when the person tried is not offered as automatic for this long (it may have been a bad moment).
  failedTtlMs: 24 * 3_600_000,
  rangesTtlMs: 7 * 24 * 3_600_000,

  fetchTimeoutMs: 20_000,
  indexMaxBytes: 8 * 1024 * 1024,
  themeMaxBytes: 128 * 1024,
  rangesMaxBytes: 16 * 1024,

  // Reading the themes and asking the DNS happen in the background, a few at a time and not all at once.
  themeConcurrency: 4,
  themeSpacingMs: 120,
  dnsConcurrency: 6,
  dnsSpacingMs: 60,
  dnsTimeoutMs: 4_000,
  // After this many failures in a row the background reading stops for a while (offline, or the host is refusing).
  failureBreakerCount: 8,
  failureBreakerMs: 10 * 60_000,

  pageSize: 60,
  maxPageSize: 120,
  cacheMaxEntries: 6000,
});
