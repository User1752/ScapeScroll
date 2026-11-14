'use strict';

module.exports = {
  jsonBodyLimit: '5mb',
  maxUploadSizeBytes: 500 * 1024 * 1024,
  apiRateLimitWindowMs: 600_000,
  apiRateLimitMaxRequests: 6000,
  fetchTimeoutMs: 10_000,
  // How long Node waits for ONE address of a site before trying the next (its own default, 250 ms, makes a busy network fail every call
  // with ETIMEDOUT): see server/modules/network/connect-patience.js.
  connectAttemptTimeoutMs: 2_000,
  sourceCallTimeoutMs: 30_000,
  repoCacheTtlMs: 3_600_000,
  // Most source ids the "disabled sources" list may hold (server/modules/sources/disabled-sources.js).
  // A list longer than this is not a list of sources the user switched off.
  disabledSourceIdsMax: 200,
  // The local copy of the library's covers (server/modules/covers/): the largest cover it keeps (covers are kept as the site sends them, with
  // no recompression, because quality matters more than space: the biggest of a 250-title library was 2 MB, one PNG over 8 MB; the ceiling only
  // refuses what cannot be a cover), the gap between two downloads (a library of 250 is fetched in about two minutes, politely), how long a cover
  // that could not be fetched is left alone before the next try, how long after the library changes it looks again, and how long after
  // start-up it first looks (the health probes go first).
  libraryCoverMaxBytes: 32 * 1024 * 1024,
  libraryCoverSpacingMs: 400,
  libraryCoverRetryMs: 6 * 3_600_000,
  libraryCoverDebounceMs: 10_000,
  libraryCoverStartDelayMs: 30_000,
  // Web cover search (server/modules/cover-search): one real search at a time, at least this far apart. 8 s because the wait counts inside the 30 s the API
  // allows (a cold browser needs 12 s), so a longer gap would make the search itself time out.
  coverSearchSpacingMs: 8_000,
  // Asking the user's own Suwayomi-Server to install an extension (server/modules/suwayomi/service.js): it downloads and converts the file, so it is slow.
  engineInstallTimeoutMs: 120_000,
  // Source import (server/modules/source-import/): the largest source file it takes (the biggest bundled source
  // is well under 100 KB), how long a checked-but-not-installed file is kept, and how many may wait at once.
  sourceImportMaxBytes: 512 * 1024,
  sourceImportStagingTtlMs: 3_600_000,
  sourceImportStagingMaxFiles: 20
};
