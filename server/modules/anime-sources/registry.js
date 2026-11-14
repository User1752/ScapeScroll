'use strict';

const { checkAnimeSource } = require('./contract');
const { createStreamRelay } = require('./relay');

// The anime sources the app knows, in the order they are offered (the player's fallback order follows it). One place answers
// "which sources are there", "find this episode with that source" and "relay this video address for that source", so a route no
// longer names a provider, and a source that is added later (one the person imports) is only one more entry.
//
// A source is judged against the contract (contract.js) when it is registered; a source that declares `meta.stream` gets the generic
// relay (relay.js), which fetches only from the hosts it declared and only relays addresses on them.

const failure = (message, statusCode) => Object.assign(new Error(message), { statusCode });

const cleanSubtitle = (item) => ({
  lang: String((item && item.lang) || '').slice(0, 20),
  label: String((item && item.label) || '').slice(0, 60),
  default: !!(item && item.default),
  src: String((item && item.src) || ''),
});

// What the source returned, as the player expects it. A source with the generic relay returns real addresses: the one it is
// allowed to relay is rewritten to come back through this app, and anything outside its declared hosts is refused (the video)
// or dropped (a subtitle).
function normalize(entry, raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.src !== 'string' || !raw.src) throw new Error('The source did not return a video address.');
  const subtitles = (Array.isArray(raw.subtitles) ? raw.subtitles : []).map(cleanSubtitle).filter((s) => s.src);
  const { referer, ...rest } = raw;
  const availableQualities = Array.isArray(raw.availableQualities) ? raw.availableQualities : [];
  if (!entry.relay) return { ...rest, src: raw.src, subtitles, availableQualities };
  if (!entry.relay.allowed(raw.src)) throw new Error('The source returned a video address outside the hosts it declares.');
  return {
    ...rest,
    src: entry.relay.proxyUrl(raw.src, referer),
    subtitles: subtitles.filter((s) => entry.relay.allowed(s.src)).map((s) => ({ ...s, src: entry.relay.proxyUrl(s.src, referer) })),
    availableQualities,
  };
}

/**
 * @param {{ relayDeps?: object }} [options]  `relayDeps` replaces the network helpers of the generic relay in tests
 */
function createAnimeRegistry({ relayDeps } = {}) {
  const sources = new Map(); // id -> { meta, mod, origin, relay }

  const lookup = (id) => {
    const entry = sources.get(String(id));
    if (!entry) throw failure(`Unknown anime provider "${String(id).slice(0, 40)}"`, 404);
    return entry;
  };

  /**
   * @param {object} mod  the source's exports (contract.js)
   * @param {{ origin?: 'bundled'|'imported', replace?: boolean }} [options]
   * @returns {object} the clean declaration of the source
   */
  function register(mod, { origin = 'imported', replace = false } = {}) {
    const verdict = checkAnimeSource(mod);
    if (!verdict.ok) throw failure(`That is not an anime source: ${verdict.problems.join(' ')}`, 400);
    const { meta } = verdict;
    const existing = sources.get(meta.id);
    if (existing && (!replace || existing.origin === 'bundled')) throw failure(`An anime source with the id "${meta.id}" already exists.`, 409);
    const relay = meta.stream ? createStreamRelay({ id: meta.id, stream: meta.stream }, relayDeps) : null;
    // A replaced source keeps its place in the order; a new one goes last.
    sources.set(meta.id, { meta, mod, origin, relay });
    return meta;
  }

  /** Removes an imported source. The ones that ship with the app cannot be removed. */
  function unregister(id) {
    const entry = sources.get(String(id));
    if (!entry) return false;
    if (entry.origin === 'bundled') throw failure(`"${entry.meta.id}" ships with the app and cannot be removed.`, 409);
    return sources.delete(entry.meta.id);
  }

  /** What the player and the settings need to know about each source, in order. */
  function list() {
    return [...sources.values()].map(({ meta, origin }) => ({
      id: meta.id, name: meta.name, keyedBy: meta.keyedBy, features: { ...meta.features }, warning: meta.warning, origin,
    }));
  }

  /**
   * Finds the stream of one episode. Only the request fields the source says it understands (meta.features) are passed on.
   *
   * @param {string} id
   * @param {{ malId?: *, title?: string, episode: *, dub?: boolean, quality?: string, format?: string }} request
   */
  async function resolveStream(id, request = {}) {
    const entry = lookup(id);
    const { meta, mod } = entry;
    if (!request.episode) throw failure('episode is required', 400);
    if (meta.keyedBy === 'mal' && !request.malId) throw failure(`malId is required for the ${meta.id} provider`, 400);
    if (meta.keyedBy === 'title' && !request.title) throw failure(`title is required for the ${meta.id} provider`, 400);
    const raw = await mod.getStreamSources({
      malId: request.malId,
      title: request.title,
      episode: request.episode,
      dub: meta.features.dub ? !!request.dub : false,
      quality: meta.features.quality ? request.quality : undefined,
      format: meta.features.format && typeof request.format === 'string' ? request.format : undefined,
    });
    return normalize(entry, raw);
  }

  /** One resource of a source's video (playlist, segment, subtitle file), relayed. */
  async function relay(id, targetUrl, referer) {
    const entry = lookup(id);
    return entry.relay ? entry.relay.fetchResource(targetUrl, referer) : entry.mod.fetchHlsResource(targetUrl, referer);
  }

  /** The sources System Health probes: [{ id, name, check }], `check` is missing when the source has no healthCheck(). */
  function healthTargets() {
    return [...sources.values()].filter(({ meta }) => meta.health)
      .map(({ meta, mod }) => ({ id: meta.id, name: meta.name, check: typeof mod.healthCheck === 'function' ? () => mod.healthCheck() : null }));
  }

  return { register, unregister, list, resolveStream, relay, healthTargets, has: (id) => sources.has(String(id)) };
}

module.exports = { createAnimeRegistry };
