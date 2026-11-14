'use strict';

/**
 * server/modules/system-health/image-quality-health.js — Cover/page image
 * quality regression check
 *
 * A source can pass every other health check (reachable, search works,
 * chapters list fine) while silently degrading the actual images it
 * serves — e.g. switching its CDN to a compressed/thumbnail tier, or (the
 * real bug this check exists because of) a scraper accidentally requesting
 * a downscaled variant instead of the original. None of that shows up as a
 * failure anywhere else in System Health, since the source is still
 * completely functional, just worse.
 *
 * Per installed source, this picks ONE real sample manga and pins it in
 * store.imageHealthBaseline so every run measures the same cover + first
 * chapter/first page rather than a different random one each time (file
 * sizes are only comparable run-to-run if it's the same image). Both are
 * fetched through the exact same fetchProxyImage() path a real reader
 * request uses, so this measures what actually gets served, not just what
 * the scraper module claims. If the current size is under half the last
 * *healthy* size recorded for that source, that's flagged as a likely
 * regression — the baseline only advances on a healthy result, so a real
 * drop keeps showing on every subsequent check until quality actually
 * recovers, rather than quietly resetting the moment nobody's watching.
 *
 * File size alone is not quality: a site that cuts the same chapter into other
 * pieces (one tall strip, then 83 slices of 800x1365) changes the size of page 1
 * with no change in quality. The page's width and height are stored next to its
 * size, and a smaller page is let through when it is as wide as before and as
 * dense (bytes per pixel); a narrower page (downscaled) or a denser-compressed
 * one is still reported.
 */

const { withTimeout } = require('../common/async-utils');
const { readImageSize } = require('../common/image-dimensions');
const { disabledSourceSetOf } = require('../sources/disabled-sources');

const PROBE_TIMEOUT_MS = 60_000; // generous — some sources need a FlareSolverr solve
// One source's whole probe has up to three sequential stages (sample search, chapter list,
// page list), each allowed PROBE_TIMEOUT_MS, so a Cloudflare-slow source could run for
// minutes and drag the whole request past its 90 s limit (/api/system/image-quality answered
// 504 and showed nothing at all). Every source gets this overall deadline instead: the slow
// one reports "Probe timed out." and the rest of the results still arrive.
const SOURCE_DEADLINE_MS = 75_000;
const REGRESSION_RATIO = 0.5; // current size under 50% of last healthy size = regression
const WIDTH_TOLERANCE = 0.05; // a page this much narrower than the baseline's was downscaled, not re-cut
const MIN_ACCEPTABLE_BYTES = 8_000; // smallest legitimate image seen across every source audited so far is ~18KB

// A source that puts a CAPTCHA in front of its chapters declares it with an error code ending in NEED_CAPTCHA.
// ScrollScape cannot solve a CAPTCHA and does not try, so this is a known limit of that site, not a fault of the
// source or a regression: the row passes and says so (a real change, a failure of another kind, still shows).
// The code is the declaration; the text of an error is never matched.
const CAPTCHA_WALL_CODE = /(?:^|_)NEED_CAPTCHA$/;
const CAPTCHA_WALL_DETAILS = 'Known limit: the site asks for a CAPTCHA to read chapters, which ScrollScape cannot solve (nothing to measure).';
const isCaptchaWall = (err) => typeof err?.code === 'string' && CAPTCHA_WALL_CODE.test(err.code);
const captchaWallRow = (id, name) => ({ id, name, ok: true, error: '', details: CAPTCHA_WALL_DETAILS });

// A candidate sample that could not be read, for the list of what was tried. A declared wall is about the site, not
// about this title: it is thrown on for checkSource to report as a known limit, not flattened into the text of a failure.
function noteCandidateFailure(tried, candidateId, err) {
  if (isCaptchaWall(err)) throw err;
  tried.push(`${candidateId} (${err.message})`);
}

// The row for a pinned sample that could not be read again: it is dropped so the next run picks a fresh one, unless
// the cause is a declared wall (a limit of the site, not a lost sample): then the row passes and the baseline stays.
function pinnedSampleLost(id, name, err) {
  if (isCaptchaWall(err)) return captchaWallRow(id, name);
  return { id, name, ok: false, error: `Sample unreachable (${err.message === 'timeout' ? 'timed out' : err.message}) — will pick a new sample next run.`, _clear: true };
}

// Most data/sources/*.js modules wrap covers/pages as
// "/api/proxy-image?url=ENCODED&ref=ENCODED" (see proxyImg() in each file),
// but a few older ones (confirmed live: batcave, asurascans, comichubfree)
// return the raw absolute CDN URL directly instead, leaving the wrap-at-
// render-time job to the frontend. Both need to resolve to a real, fetchable
// URL here — for the raw case, fetchProxyImage() already falls back to
// inferRefererForUrl() internally when no ref is given, the same as the
// real /api/proxy-image route does for these sources today.
function parseProxiedUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  if (raw.startsWith('/api/proxy-image')) {
    const qIdx = raw.indexOf('?');
    if (qIdx === -1) return null;
    const params = new URLSearchParams(raw.slice(qIdx + 1));
    const url = params.get('url');
    if (!url) return null;
    return { url, ref: params.get('ref') || undefined };
  }
  if (/^https?:\/\//i.test(raw)) return { url: raw, ref: undefined };
  return null;
}

// The chapter whose first page is measured, and the page size it is compared with. Sizes only compare
// like with like, so it is the chapter the baseline was taken on while that one is still listed (seen
// live: a new chapter at the top of the list made a colour page look like a "drop" from a black-and-
// white one). Otherwise the newest chapter, with nothing to compare its page with: the baseline moves to
// it at the end of the run.
function chapterToMeasure(baseline, chapters) {
  const pinned = baseline?.chapterId ? chapters.find((c) => c.id === baseline.chapterId) : null;
  if (pinned) return { chapterId: pinned.id, baselinePageBytes: baseline.pageBytes ?? null };
  return { chapterId: chapters[0].id, baselinePageBytes: null };
}

// Whether a page smaller than the baseline's only comes from the chapter being cut into other pieces: as wide as before and
// at least as dense in bytes per pixel as the ratio allows. Without the size of the page there is nothing to say (false: report it
// as before). A baseline taken before sizes were stored has nothing to compare with: this once the drop is let through, and the
// baseline moves to this page with its size.
function pageDropIsRecut(baseline, page) {
  if (!page?.width || !page?.height) return false;
  if (!baseline?.pageWidth || !baseline?.pageHeight) return true;
  if (Math.abs(page.width - baseline.pageWidth) > baseline.pageWidth * WIDTH_TOLERANCE) return false;
  const was = baseline.pageBytes / (baseline.pageWidth * baseline.pageHeight);
  const now = page.bytes / (page.width * page.height);
  return now >= was * REGRESSION_RATIO;
}

function createImageQualityHealthCheckService({ readStore, writeStore, loadSourceFromFile, fetchProxyImage, sourceDeadlineMs = SOURCE_DEADLINE_MS }) {
  // { bytes, width, height } of one image as the reader would get it; width and height are null when the format is not recognised.
  async function measureImage(proxiedUrl) {
    const parsed = parseProxiedUrl(proxiedUrl);
    if (!parsed) return null;
    try {
      const result = await fetchProxyImage({ ...parsed, measureBytes: true });
      if (typeof result?.contentLength !== 'number') return null;
      const type = String(result.contentType || '').split(';')[0].trim();
      const size = Buffer.isBuffer(result.body) ? readImageSize(result.body, type) : null;
      return { bytes: result.contentLength, width: size?.width ?? null, height: size?.height ?? null };
    } catch (_) {
      return null;
    }
  }

  async function measureOne(proxiedUrl) {
    return (await measureImage(proxiedUrl))?.bytes ?? null;
  }

  async function pickCandidates(mod) {
    // trending() first — fast and needs no query, and for sources whose
    // search() sits behind a slow Cloudflare/FlareSolverr path (e.g.
    // MangaNato), this avoids paying that cost just to pick a sample.
    let ids = [];
    let lastErr = null;
    if (typeof mod.trending === 'function') {
      const listing = await mod.trending().catch((e) => { lastErr = e; return null; });
      ids.push(...(listing?.results || []).map((r) => r?.id).filter(Boolean));
    }
    // trending() alone can be a bad sample pool on its own — confirmed live
    // that weebcentral.js's Popularity-sorted trending() surfaced 6
    // DIFFERENT titles in a row (across unrelated genres) that each
    // genuinely have zero chapters on the site itself (not a scraper bug:
    // their own series pages don't even render a "show chapters" trigger).
    // Blending in a second, independent pool from search() gives
    // findWorkingSample() a real chance of finding a usable sample instead
    // of exhausting a trending list that happens to be mostly chapter-less
    // right now, without needing to special-case which source has this quirk.
    if (ids.length < 6 && typeof mod.search === 'function') {
      const listing = await mod.search('a', 1).catch((e) => { lastErr = e; return null; });
      for (const r of (listing?.results || [])) {
        if (r?.id && !ids.includes(r.id)) ids.push(r.id);
      }
    }
    if (!ids.length && lastErr) throw lastErr; // surface the real cause instead of a bare "no sample" message
    return ids;
  }

  // Tries candidates in order, returning the first whose chapters() actually
  // resolves with at least one chapter. A listing can include a title that's
  // genuinely live on the site but currently has zero chapters (confirmed
  // live: a real "Most Viewed Today" #1 entry that happens to be broken on
  // the site itself, an empty page for its own visitors too) — always
  // trusting candidate #1 would deterministically fail on exactly that one
  // broken title, run after run, since it stays #1 in the ranking.
  async function findWorkingSample(mod, candidateIds) {
    const tried = [];
    for (const candidateId of candidateIds.slice(0, 10)) {
      try {
        const [details, chaptersResult] = await Promise.all([mod.mangaDetails(candidateId), mod.chapters(candidateId)]);
        if (chaptersResult?.chapters?.length) return { mangaId: candidateId, details, chaptersResult };
        tried.push(`${candidateId} (no chapters)`);
      } catch (e) {
        noteCandidateFailure(tried, candidateId, e);
      }
    }
    return { tried };
  }

  // Runs one source's probe in isolation. Never touches the store directly —
  // returns a plain {id,name,ok,error} result plus an internal _advance/
  // _clear instruction, which the caller applies in a single batched write
  // after every source's parallel probe has settled (avoids N concurrent
  // read-modify-write races against the same JSON store file).
  async function checkSource(id, name, mod, baseline) {
    if (typeof mod.mangaDetails !== 'function' || typeof mod.chapters !== 'function' || typeof mod.pages !== 'function') {
      return { id, name, ok: true, error: '', details: 'No page-image contract to probe (skipped).' };
    }

    try {
      let mangaId = baseline?.mangaId || null;
      let details, chaptersResult;

      if (mangaId) {
        // Reuse the pinned sample so sizes stay comparable run-to-run.
        try {
          [details, chaptersResult] = await withTimeout(
            Promise.all([mod.mangaDetails(mangaId), mod.chapters(mangaId)]),
            PROBE_TIMEOUT_MS,
            'timeout'
          );
        } catch (e) {
          // The pinned sample may no longer exist on the source — clear it
          // so the next run picks a fresh one instead of failing forever.
          return pinnedSampleLost(id, name, e);
        }
        if (!chaptersResult?.chapters?.length) {
          return { id, name, ok: false, error: 'Pinned sample manga now has no chapters — will pick a new sample next run.', _clear: true };
        }
      } else {
        const candidateIds = await withTimeout(pickCandidates(mod), PROBE_TIMEOUT_MS, 'timeout');
        if (!candidateIds.length) {
          // Several sources (e.g. allmanga.js's safeListCall) deliberately
          // swallow trending()/search() failures into a valid-but-empty
          // {results:[]} instead of throwing - a defensive choice that keeps
          // their own discover UI usable when the upstream API is rate-
          // limited or briefly down, but means pickCandidates() never sees
          // the real cause to report it. An empty result here is genuinely
          // ambiguous (could be a real empty listing too), so say so instead
          // of stating "no sample" as if it were a permanent condition.
          return { id, name, ok: false, error: 'No sample manga available to probe (trending/search returned no results - may be a temporary rate limit rather than a real outage).' };
        }
        const found = await withTimeout(findWorkingSample(mod, candidateIds), PROBE_TIMEOUT_MS, 'timeout');
        if (!found.mangaId) {
          return { id, name, ok: false, error: `No candidate had usable chapters (tried ${found.tried.length}: ${found.tried.join('; ')}).` };
        }
        mangaId = found.mangaId;
        details = found.details;
        chaptersResult = found.chaptersResult;
      }

      const { chapterId, baselinePageBytes } = chapterToMeasure(baseline, chaptersResult.chapters);
      // Only pages[0].img is ever measured, but pages() has to resolve every page of the
      // chapter - for a source that does that one request per page behind a throttle, a long
      // chapter outlasts PROBE_TIMEOUT_MS, and withTimeout() cannot cancel the abandoned call,
      // which keeps draining the source's shared request queue and stalls its next call too.
      // A source like that can export an optional firstPage(chapterId) returning the same
      // { pages: [{ img }] } shape for just the first page; everything else keeps using pages().
      const pagesCall = typeof mod.firstPage === 'function' ? mod.firstPage(chapterId) : mod.pages(chapterId);
      const pagesResult = await withTimeout(pagesCall, PROBE_TIMEOUT_MS, 'timeout');
      const firstPageImg = pagesResult?.pages?.[0]?.img;

      let [coverBytes, page] = await Promise.all([
        measureOne(details?.cover),
        measureImage(firstPageImg),
      ]);

      if (coverBytes == null && page == null) {
        return { id, name, ok: false, error: 'Could not fetch either the sample cover or page image.' };
      }

      function findIssues(cover, shot) {
        const found = [];
        const pageNow = shot?.bytes ?? null;
        if (cover != null && cover < MIN_ACCEPTABLE_BYTES) found.push(`cover is only ${cover}B`);
        if (pageNow != null && pageNow < MIN_ACCEPTABLE_BYTES) found.push(`page is only ${pageNow}B`);
        if (baseline?.coverBytes && cover != null && cover < baseline.coverBytes * REGRESSION_RATIO) {
          found.push(`cover dropped from ${Math.round(baseline.coverBytes / 1024)}KB to ${Math.round(cover / 1024)}KB`);
        }
        if (baselinePageBytes && pageNow != null && pageNow < baselinePageBytes * REGRESSION_RATIO && !pageDropIsRecut({ ...baseline, pageBytes: baselinePageBytes }, shot)) {
          found.push(`page dropped from ${Math.round(baselinePageBytes / 1024)}KB to ${Math.round(pageNow / 1024)}KB`);
        }
        return found;
      }

      let issues = findIssues(coverBytes, page);

      if (issues.length) {
        // Re-measure once before declaring a regression — confirmed live
        // that a single flaky fetch (BatCave in particular, the source most
        // prone to transient Cloudflare/network blips — chapter 4) can
        // return a truncated image far under its real, currently-healthy
        // size, wrongly flagging a "regression" that doesn't reproduce even
        // one retry later (verified: 4 back-to-back fetches of the exact
        // same asset all returned the real, full size). Only the specific
        // asset(s) that actually triggered an issue get re-measured — no
        // reason to spend a second request on one that was already fine.
        const recheckCover = issues.some((i) => i.startsWith('cover')) ? await measureOne(details?.cover) : coverBytes;
        const recheckPage = issues.some((i) => i.startsWith('page')) ? await measureImage(firstPageImg) : page;
        const stillIssues = findIssues(recheckCover, recheckPage);

        if (stillIssues.length) {
          // Deliberately does NOT advance the baseline — a real regression
          // keeps failing this check on every future run until the
          // source's quality actually recovers back above the threshold.
          return { id, name, ok: false, error: `Possible image quality regression: ${stillIssues.join('; ')}.` };
        }

        // Recovered on retry — treat as the transient blip it was, and use
        // the recheck values (not the flaky first ones) for the rest of
        // this function, including the baseline advance below.
        coverBytes = recheckCover;
        page = recheckPage;
        issues = [];
      }

      const parts = [];
      if (coverBytes != null) parts.push(`cover ${Math.round(coverBytes / 1024)}KB`);
      if (page != null) parts.push(`page ${Math.round(page.bytes / 1024)}KB${page.width ? ` (${page.width}x${page.height})` : ''}`);

      return {
        id, name, ok: true, error: '', details: parts.join(', '),
        _advance: {
          mangaId,
          chapterId,
          coverBytes: coverBytes ?? baseline?.coverBytes ?? null,
          pageBytes: page?.bytes ?? baselinePageBytes ?? null,
          // The size goes with the bytes it describes: a page that could not be measured keeps the baseline's pair.
          pageWidth: page ? page.width : (baselinePageBytes ? baseline?.pageWidth ?? null : null),
          pageHeight: page ? page.height : (baselinePageBytes ? baseline?.pageHeight ?? null : null),
          sampledAt: new Date().toISOString(),
        },
      };
    } catch (e) {
      if (isCaptchaWall(e)) return captchaWallRow(id, name);
      return { id, name, ok: false, error: e.message === 'timeout' ? 'Probe timed out.' : e.message };
    }
  }

  async function runImageQualityChecks() {
    let store;
    try {
      store = await readStore();
    } catch (e) {
      return [{ id: 'store', name: 'Store', ok: false, error: `Failed to read store: ${e.message}` }];
    }

    // A source the user switched off is not sampled at all: no module load, no request to its site, no
    // row, and its pinned baseline is neither advanced nor cleared (so switching it on again compares
    // against the last healthy size). When every installed source is disabled the result is [].
    const disabled = disabledSourceSetOf(store);
    const ids = Object.keys(store.installedSources || {}).filter((id) => !disabled.has(id));
    if (!ids.length) return [];

    const baselines = store.imageHealthBaseline || {};

    const rawResults = await Promise.all(ids.map(async (id) => {
      const name = store.installedSources[id]?.name || id;
      let mod;
      try {
        mod = loadSourceFromFile(id);
      } catch (e) {
        return { id, name, ok: false, error: `Failed to load module: ${e.message}` };
      }
      try {
        return await withTimeout(checkSource(id, name, mod, baselines[id] || null), sourceDeadlineMs, 'timeout');
      } catch (e) {
        return { id, name, ok: false, error: e.message === 'timeout' ? 'Probe timed out.' : e.message };
      }
    }));

    const advances = rawResults.filter((r) => r._advance);
    const clears = rawResults.filter((r) => r._clear);
    if (advances.length || clears.length) {
      try {
        const fresh = await readStore();
        fresh.imageHealthBaseline = fresh.imageHealthBaseline || {};
        for (const r of advances) fresh.imageHealthBaseline[r.id] = r._advance;
        for (const r of clears) delete fresh.imageHealthBaseline[r.id];
        await writeStore(fresh);
      } catch (_) { /* best-effort — a missed baseline write just means the next run re-samples */ }
    }

    return rawResults.map(({ id, name, ok, error, details }) => ({ id, name, ok, error, details }));
  }

  return { runImageQualityChecks };
}

module.exports = { createImageQualityHealthCheckService, parseProxiedUrl, MIN_ACCEPTABLE_BYTES, SOURCE_DEADLINE_MS };
