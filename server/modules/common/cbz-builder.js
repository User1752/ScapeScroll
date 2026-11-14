'use strict';

// The "guess a file extension from an image URL" one-liner used to be
// copy-pasted verbatim in downloads/service.js (x2), local/service.js, and
// routes/opds.js — small, but a bug fix (e.g. supporting .avif) previously
// had to be applied in four places to actually take effect everywhere.
function guessImageExt(url) {
  return ((String(url || '').match(/\.(jpe?g|png|webp|gif)/i) || ['', 'jpg'])[1]).replace(/jpeg/i, 'jpg');
}

/**
 * Fetches each already-resolved page ({ url, referer }) and adds it to
 * `zip`, 1-indexed and zero-padded, optionally under `folder` — the same
 * "fetch pages -> zip.addFile" loop that used to be its own copy inside
 * downloads/service.js's downloadChapter, inside its processBulkJob (once
 * per chapter, with a folder prefix), and inside routes/opds.js's on-demand
 * CBZ endpoint. A page that fails to fetch is skipped, not fatal — one bad
 * page shouldn't fail the whole archive; pass `onSkip(index, error)` to log it.
 *
 * Pages are fetched `concurrency`-at-a-time rather than one at a time: a
 * chapter with 60+ pages fetched sequentially can take longer than the
 * app's global 30s per-request API timeout (server.js's apiTimeout), so the
 * whole save would 504 even though every individual page fetch was fine —
 * confirmed live once the pages actually started succeeding (see
 * fetch-utils.js's inferRefererForUrl for the bug that used to make them
 * fail instantly instead, which was accidentally why this never surfaced).
 * zip.addFile still happens in original page order regardless of which
 * fetch finished first.
 *
 * @returns {Promise<number>} how many pages were actually added
 */
async function addPagesToZip(zip, resolvedPages, { fetchImageBuffer, folder = '', pad = 3, onSkip, concurrency = 6 } = {}) {
  const buffers = new Array(resolvedPages.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= resolvedPages.length) return;
      const page = resolvedPages[i];
      if (!page) continue;
      try {
        buffers[i] = await fetchImageBuffer(page.url, page.referer);
      } catch (e) {
        if (onSkip) onSkip(i, e);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, resolvedPages.length));
  await Promise.all(Array.from({ length: workerCount }, worker));

  let added = 0;
  for (let i = 0; i < resolvedPages.length; i++) {
    if (!buffers[i]) continue;
    const ext = guessImageExt(resolvedPages[i].url);
    const name = `${String(i + 1).padStart(pad, '0')}.${ext}`;
    zip.addFile(folder ? `${folder}/${name}` : name, buffers[i]);
    added++;
  }
  return added;
}

module.exports = { guessImageExt, addPagesToZip };
