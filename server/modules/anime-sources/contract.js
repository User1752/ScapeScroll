'use strict';

// The contract of an anime source: what a module has to export so the app can offer it next to the others, whoever wrote it.
//
//   module.exports = {
//     meta: {
//       id: 'mysite',                 // letters, digits, "_" and "-"; the id the player and the settings use
//       name: 'My Site',              // shown in the source list
//       keyedBy: 'mal' | 'title',     // what the source finds a show by: its MyAnimeList id, or its title
//       features: { dub, quality, format },  // which of those requests the source understands (default: none)
//       warning: '…',                 // optional: shown next to the source, for a risk the person should read before enabling it
//       health: true,                 // optional: false keeps it out of System Health (it needs a hidden browser, say)
//       stream: {                     // only for a source that does NOT relay its own video (see fetchHlsResource)
//         hosts: ['cdn.example'],     //   the ONLY hosts the app may fetch video from for this source (and their subdomains)
//         referer: 'https://example/',//   a Referer to send, or
//         refererFromLink: true,      //   take it from the link of each resource (set by the source in `referer` of its answer)
//       },
//     },
//     getStreamSources({ malId, title, episode, dub, quality, format }) -> { src, subtitles?, availableQualities?, quality?, referer? },
//     fetchHlsResource(url, referer?) -> { contentType, body },   // the source's own relay; or declare meta.stream instead
//     healthCheck() -> { ok, error? },                            // optional
//   }
//
// A source that declares `meta.stream` returns the real addresses (https) and the app relays them: it fetches only from the hosts
// declared, on the source's behalf, and every address the source returned has to be on them. A source with its own relay
// (fetchHlsResource) is trusted with its own fetching (the ones that ship with the app are).

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const KEYED_BY = ['mal', 'title'];
const FEATURES = ['dub', 'quality', 'format'];
const MAX_HOSTS = 12;

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
// eslint-disable-next-line no-control-regex
const oneLine = (value, max) => String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function cleanStream(raw, problems) {
  if (raw === undefined) return null;
  if (!isObject(raw)) { problems.push('meta.stream must be an object.'); return null; }
  const hosts = (Array.isArray(raw.hosts) ? raw.hosts : []).map((h) => String(h).trim().toLowerCase());
  if (!hosts.length || hosts.length > MAX_HOSTS || hosts.some((h) => !HOST_RE.test(h))) {
    problems.push(`meta.stream.hosts must list 1 to ${MAX_HOSTS} host names (like "cdn.example"), with no scheme, port or path.`);
    return null;
  }
  let referer = '';
  if (raw.referer !== undefined) {
    try {
      const url = new URL(String(raw.referer));
      if (url.protocol !== 'https:') throw new Error('not https');
      referer = url.href.slice(0, 300);
    } catch (_) { problems.push('meta.stream.referer must be an https address.'); }
  }
  return { hosts: [...new Set(hosts)], referer, refererFromLink: raw.refererFromLink === true };
}

/**
 * Judges a module against the contract. Never throws and never runs the source: it only reads what the module exports.
 *
 * @returns {{ ok: boolean, problems: string[], meta: object|null }} `meta` is the clean declaration, only when ok
 */
function checkAnimeSource(mod) {
  const problems = [];
  const meta = mod && mod.meta;
  if (!isObject(meta)) return { ok: false, problems: ['The source does not export meta.'], meta: null };
  const id = String(meta.id || '');
  if (!ID_RE.test(id)) problems.push('meta.id must be 2 to 40 characters: lower-case letters, digits, "_" and "-".');
  const name = oneLine(meta.name, 60);
  if (!name) problems.push('meta.name is missing.');
  if (!KEYED_BY.includes(meta.keyedBy)) problems.push(`meta.keyedBy must be one of: ${KEYED_BY.join(', ')}.`);
  const features = {};
  for (const feature of FEATURES) features[feature] = !!(isObject(meta.features) && meta.features[feature] === true);
  const stream = cleanStream(meta.stream, problems);
  if (typeof mod.getStreamSources !== 'function') problems.push('The source does not export getStreamSources().');
  const ownRelay = typeof mod.fetchHlsResource === 'function';
  if (!ownRelay && !stream) problems.push('The source needs either fetchHlsResource() or meta.stream (the hosts its video comes from).');
  if (ownRelay && stream) problems.push('Declare meta.stream or export fetchHlsResource(), not both.');
  if (mod.healthCheck !== undefined && typeof mod.healthCheck !== 'function') problems.push('healthCheck must be a function.');
  if (problems.length) return { ok: false, problems, meta: null };
  return {
    ok: true,
    problems,
    meta: {
      id,
      name,
      version: oneLine(meta.version, 20) || '1.0.0',
      author: oneLine(meta.author, 60),
      keyedBy: meta.keyedBy,
      features,
      warning: oneLine(meta.warning, 400),
      health: meta.health !== false,
      stream,
    },
  };
}

module.exports = { checkAnimeSource, ID_RE, HOST_RE, KEYED_BY, FEATURES };
