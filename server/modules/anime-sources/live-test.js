'use strict';

const {
  createRun, pass, fail, warn, skip, text, safeMessage, isBadInputStatus, looksLikeSiteProblem, rethrowRunEnders,
} = require('../source-import/live-test-support');

// "Test" of an anime source: the checklist of what has to hold for an episode to PLAY, run against the REAL site, by the person's own
// request, with a small budget. It asks the source for a stream exactly as the player does (the registry, the same fields), then follows
// what it was given through the app's own relay: the playlist, a variant, the first segment, a subtitle file. Nothing is played and
// nothing is decoded: no sound is ever produced. What it looks at is whether each step answers and has the shape a player needs.
//
// The source has no "list" to read, so a few well-known titles are tried for episode 1 until one resolves (a title missing from one
// catalogue is normal). Like the manga test it stops after three failures in a row, or when its time runs out, and it never solves a
// challenge or logs in. A source is "verified" when nothing failed and the stream, the playlist and the first segment passed.

const LIMITS = Object.freeze({
  maxCalls: 24,
  spacingMs: 600,
  callTimeoutMs: 60_000,   // a source that needs the hidden browser can take this long to find a stream
  maxConsecutiveFailures: 3,
  maxDurationMs: 4 * 60_000,
});
const TITLES = Object.freeze([
  { title: 'Sousou no Frieren', malId: 52991 },
  { title: 'One Piece', malId: 21 },
  { title: 'Naruto', malId: 20 },
  { title: 'Bleach', malId: 269 },
]);
const NO_SUCH = Object.freeze({ title: 'zzqx no such anime 7f3a91', malId: 999_999_999 });
const CORE_CHECKS = Object.freeze(['anime-stream', 'anime-playlist', 'anime-segment']);
const CHECK_IDS = Object.freeze(['anime-stream', 'anime-playlist', 'anime-variant', 'anime-segment', 'anime-subtitles', 'anime-bad-input', 'anime-past-end']);

// A byte order mark in front of a playlist or a subtitle file is not a reason to refuse it.
const withoutBom = (value) => (String(value).charCodeAt(0) === 0xfeff ? String(value).slice(1) : String(value));
const isPlaylist = (body) => withoutBom(body).startsWith('#EXTM3U');
const mediaLines = (body) => String(body).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const sizeText = (bytes) => (bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The real address and Referer behind a link of the app (`/api/anime/<id>/hls-proxy?url=…&ref=…`), or null when it is not one. */
function targetOf(link) {
  try {
    const parsed = new URL(String(link), 'http://app.local');
    const url = parsed.searchParams.get('url');
    return parsed.pathname.startsWith('/api/anime/') && url ? { url, ref: parsed.searchParams.get('ref') || undefined } : null;
  } catch (_) { return null; }
}

/** What the first bytes of a segment say it is, or '' when it is not video: MPEG-TS, fragmented or plain MP4, WebM. */
function mediaKind(buffer) {
  if (!buffer || buffer.length < 12) return '';
  if (buffer[0] === 0x47 && (buffer.length < 189 || buffer[188] === 0x47)) return 'mpeg-ts';
  const box = buffer.slice(4, 8).toString('latin1');
  if (['ftyp', 'styp', 'moof', 'moov'].includes(box)) return 'mp4';
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'webm';
  return '';
}

const NO_STREAM = skip('there was no stream to follow');
const through = async (c, link, label) => {
  const target = targetOf(link);
  if (!target) throw new Error(`${label} is not an address of the app (${text(link, 60)}): the player could not read it`);
  try {
    return await c.call(label, () => c.registry.relay(c.id, target.url, target.ref));
  } catch (err) {
    rethrowRunEnders(err); // the end of the run is not a failure of this step
    throw new Error(`${label} could not be fetched: ${safeMessage(err)}`, { cause: err });
  }
};

async function checkStream(c) {
  const tried = [];
  for (const candidate of TITLES) {
    try {
      // `expected`: a title that is not in this catalogue is a normal answer (and does not count towards the three failures in a row);
      // a block, a timeout or a network fault still does.
      const result = await c.call(`"${candidate.title}" episode 1`, () => c.registry.resolveStream(c.id, { ...candidate, episode: 1 }), { expected: true });
      if (!targetOf(result.src)) return fail(`the stream address is not one of the app (${text(result.src, 60)}): the player could not read it`);
      c.state.found = { ...candidate, result };
      return pass(`"${candidate.title}" episode 1 resolved${result.subtitles.length ? `, with ${result.subtitles.length} subtitle file(s)` : ''}`);
    } catch (err) {
      rethrowRunEnders(err);
      tried.push(`${candidate.title}: ${text(safeMessage(err), 50)}`);
    }
  }
  return fail(`no stream for any of the titles tried (${tried.join('; ')})`);
}

async function checkPlaylist(c) {
  if (!c.state.found) return NO_STREAM;
  const { body } = await through(c, c.state.found.result.src, 'the playlist');
  if (!isPlaylist(body)) return fail(`it is not an HLS playlist (it starts with "${text(String(body).slice(0, 30), 30)}")`);
  const lines = mediaLines(body);
  const outside = lines.filter((l) => /^https?:\/\//i.test(l)).length;
  if (outside) return fail(`${outside} address(es) in the playlist do not go through the app: the browser could not read them`);
  c.state.master = String(body);
  c.state.lines = lines;
  return pass(String(body).includes('#EXT-X-STREAM-INF') ? `a master playlist with ${lines.length} variant(s)` : `a media playlist with ${lines.length} segment(s)`);
}

async function checkVariant(c) {
  if (!c.state.master) return NO_STREAM;
  if (!c.state.master.includes('#EXT-X-STREAM-INF')) { c.state.media = c.state.master; return skip('the first playlist already lists the segments'); }
  const { body } = await through(c, c.state.lines[0], 'the first variant');
  if (!isPlaylist(body)) return fail(`the variant is not an HLS playlist (it starts with "${text(String(body).slice(0, 30), 30)}")`);
  if (mediaLines(body).some((l) => /^https?:\/\//i.test(l))) return fail('the segments of the variant do not go through the app');
  c.state.media = String(body);
  return pass(`the first variant lists ${mediaLines(body).length} segment(s)`);
}

// An encrypted stream plays only if the player can get the key: it has to come through the app, and an AES-128 key is 16 bytes. The
// segment itself is not decrypted here (that needs the player), so this is what can be proved without one.
async function checkKey(c, line, segmentBytes) {
  const uri = /URI="([^"]+)"/.exec(line);
  const sizeNote = `the first segment is encrypted and was fetched (${sizeText(segmentBytes)})`;
  if (!uri) return warn(`${sizeNote}, but the playlist names no key address to check`);
  const { body } = await through(c, uri[1], 'the key');
  const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(String(body));
  if (/AES-128/.test(line) && length !== 16) return fail(`${sizeNote}, but its key is ${length} bytes, not 16: the player could not decrypt it`);
  return pass(`${sizeNote}, and so is its key (${length} bytes); it is not decrypted here`);
}

async function checkSegment(c) {
  if (!c.state.media) return NO_STREAM;
  const first = mediaLines(c.state.media)[0];
  if (!first) return fail('the playlist lists no segment');
  const { body, contentType } = await through(c, first, 'the first segment');
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  if (!bytes.length) return fail('the first segment is empty');
  const encrypted = /#EXT-X-KEY:[^\n]*METHOD=(?!NONE)[^\n]*/.exec(c.state.media);
  if (encrypted) return checkKey(c, encrypted[0], bytes.length);
  const kind = mediaKind(bytes);
  if (!kind) return fail(`the first segment is not video (${text(contentType, 30) || 'no type'}, it starts with "${text(bytes.slice(0, 24).toString('latin1'), 24)}")`);
  return pass(`the first segment is ${kind}, ${sizeText(bytes.length)}`);
}

async function checkSubtitles(c) {
  const subtitles = c.state.found ? c.state.found.result.subtitles : [];
  if (!c.state.found) return NO_STREAM;
  if (!subtitles.length) return skip('the source returned no subtitle files');
  const { body } = await through(c, subtitles[0].src, 'the first subtitle file');
  const head = withoutBom(Buffer.isBuffer(body) ? body.slice(0, 200).toString('utf8') : body);
  if (head.startsWith('WEBVTT')) return pass('the first subtitle file is WebVTT');
  if (/^\[Script Info\]/i.test(head)) return warn('the first subtitle file is ASS: the player\'s subtitle tracks cannot show it');
  return warn(`the first subtitle file is not WebVTT (it starts with "${text(head.slice(0, 20), 20)}")`);
}

// A title (or an episode) that does not exist must be refused, not answered with a stream. A site that is not answering is a failure.
async function checkRefused(c, request, what) {
  try {
    await c.call(what, () => c.registry.resolveStream(c.id, request), { expected: true });
    return warn(`a stream came back for ${what}: the source answers anything`);
  } catch (err) {
    rethrowRunEnders(err);
    if (looksLikeSiteProblem(err) && !isBadInputStatus(err)) throw err;
    return pass(`${what} is refused (${text(safeMessage(err), 70)})`);
  }
}

const checkBadInput = (c) => checkRefused(c, { ...NO_SUCH, episode: 1 }, 'a title that does not exist');
async function checkPastEnd(c) {
  if (!c.state.found) return NO_STREAM;
  return checkRefused(c, { malId: c.state.found.malId, title: c.state.found.title, episode: 9999 }, 'an episode far past the end');
}

const CHECKS = [
  ['anime-stream', checkStream], ['anime-playlist', checkPlaylist], ['anime-variant', checkVariant], ['anime-segment', checkSegment],
  ['anime-subtitles', checkSubtitles], ['anime-bad-input', checkBadInput], ['anime-past-end', checkPastEnd],
];

/**
 * @param {{ registry: object, sleep: Function, withTimeout: Function, now?: () => number, limits?: object }} deps
 * @returns {(request: { id: string }) => Promise<object>}  the same shape of result as the manga test, so the same card shows it
 */
function createAnimeLiveTest({ registry, sleep, withTimeout, now = Date.now, limits = {} }) {
  const cap = { ...LIMITS, ...limits };
  return async function runLiveTest({ id }) {
    const { run, call, step } = createRun({ cap, now, sleep, withTimeout });
    const c = { registry, id, call, state: {} };
    for (const [checkId, check] of CHECKS) await step(checkId, () => check(c));
    const counts = { pass: 0, fail: 0, warn: 0, skip: 0 };
    for (const check of run.checks) counts[check.status] += 1;
    const byId = new Map(run.checks.map((check) => [check.id, check.status]));
    const verified = counts.fail === 0 && !run.aborted && CORE_CHECKS.every((checkId) => byId.get(checkId) === 'pass' || byId.get(checkId) === 'warn');
    return {
      id, depth: 'basic', startedAt: new Date(run.started).toISOString(), durationMs: Math.round(now() - run.started),
      calls: run.calls, images: 0, aborted: run.aborted, checks: run.checks, counts, verified,
    };
  };
}

module.exports = { createAnimeLiveTest, CHECK_IDS: CHECK_IDS, CORE_CHECKS, LIMITS, TITLES, targetOf, mediaKind };
