'use strict';

// The address of an extension repository a person types (or pastes) into the catalog: what is accepted, and where the list of extensions is looked for.
// The text is the person's, but it decides what the server fetches, so it is judged strictly before anything is asked: a plain https address with no login, no
// port, no query and no address of a computer (an IP number, a name with no dot, localhost). What it names is asked later through the app's own request, which
// checks every address again (private networks, redirects), has a time limit and a size limit.
//
// Forms accepted:
//   https://host/path/index.min.json   the list itself (index.json, index.min.json)
//   https://host/path/index.pb         the Suwayomi form of the same repository: its list is next to it
//   https://host/path/                 the folder of the repository
//   https://github.com/owner/name      a GitHub project that publishes its repository on the "repo" branch (the Mihon convention)

const MAX_LENGTH = 300;
const JSON_NAMES = Object.freeze(['index.min.json', 'index.json']);
const SEGMENT_RE = /^[A-Za-z0-9._~%@+-]{1,100}$/;
const GITHUB_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

const failure = (message) => Object.assign(new Error(message), { statusCode: 400 });

/** Whether a host name is a name on the internet: letters, digits and hyphens in labels joined by dots, at least two labels, and not an IP number. */
function isPublicName(host) {
  if (host.length > 253 || !host.includes('.')) return false;
  if (/^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) return false; // an IPv4 or IPv6 number
  if (/\.(?:local|localhost|internal|lan|home|intranet|corp|test|invalid)$/i.test(host)) return false;
  return host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

/**
 * The addresses to try for the list of extensions of a repository, in order, and a short name for it.
 * @param {string} input
 * @returns {{ candidates: string[], label: string }}
 * @throws {Error} (statusCode 400) with a sentence for the person when the address cannot be used
 */
function repoCandidates(input) {
  const text = String(input === undefined || input === null ? '' : input).trim();
  if (!text) throw failure('Paste the address of a repository first.');
  if (text.length > MAX_LENGTH) throw failure('That address is too long.');
  let url;
  try { url = new URL(text); } catch (_) { throw failure('That is not a web address. It starts with https://'); }
  if (url.protocol !== 'https:') throw failure('Only https addresses are accepted.');
  if (url.username || url.password) throw failure('An address with a user name or a password is not accepted.');
  if (url.port) throw failure('An address with a port is not accepted.');
  if (url.search || url.hash) throw failure('An address with a query or a fragment is not accepted: paste the address of the repository itself.');
  const host = url.hostname.toLowerCase();
  if (!isPublicName(host)) throw failure('That address is not a name on the internet.');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length > 12 || segments.some((s) => s === '.' || s === '..' || !SEGMENT_RE.test(s))) throw failure('That path is not a path of a repository.');

  // GitHub: a project (owner and name, nothing more) publishes its repository on the "repo" branch.
  if (host === 'github.com' && segments.length === 2 && GITHUB_NAME_RE.test(segments[0]) && GITHUB_NAME_RE.test(segments[1])) {
    const folder = `https://raw.githubusercontent.com/${segments[0]}/${segments[1]}/repo/`;
    return { candidates: JSON_NAMES.map((name) => folder + name), label: `${segments[0]}/${segments[1]}` };
  }
  const last = segments[segments.length - 1] || '';
  const label = host === 'github.com' || host === 'raw.githubusercontent.com' ? segments.slice(0, 2).join('/') || host : host;
  if (/\.json$/i.test(last)) {
    if (!JSON_NAMES.includes(last.toLowerCase())) throw failure('The list of a repository is called index.min.json or index.json.');
    return { candidates: [url.href], label };
  }
  const folder = /\.pb$/i.test(last) ? segments.slice(0, -1) : segments;
  if (/\.pb$/i.test(last) && last.toLowerCase() !== 'index.pb') throw failure('The Suwayomi list of a repository is called index.pb.');
  if (/\.[A-Za-z0-9]{2,5}$/.test(folder[folder.length - 1] || '')) throw failure('That looks like a file, not a repository. Paste the address of the repository or of its index.min.json.');
  const base = `https://${host}/${folder.join('/')}${folder.length ? '/' : ''}`;
  return { candidates: JSON_NAMES.map((name) => base + name), label };
}

/**
 * Which repository an address of its list belongs to, so the same repository written two ways is one: a GitHub project on a branch is
 * "github:owner/name/branch" whether it is written github.com/owner/name/raw/branch/... or raw.githubusercontent.com/owner/name/branch/...
 * (and index.json or index.min.json); any other address is its host and folder.
 * @param {string} url   the address of a list of extensions
 * @returns {string} lower-case, or '' when it is not an address
 */
function repoIdentity(url) {
  let u;
  try { u = new URL(String(url)); } catch (_) { return ''; }
  const parts = u.pathname.split('/').filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (host === 'github.com' && parts.length >= 4 && parts[2] === 'raw') return `github:${parts[0]}/${parts[1]}/${parts[3]}`.toLowerCase();
  if (host === 'raw.githubusercontent.com' && parts.length >= 3) return `github:${parts[0]}/${parts[1]}/${parts[2]}`.toLowerCase();
  return `${host}/${parts.slice(0, /\.(?:json|pb)$/i.test(parts[parts.length - 1] || '') ? -1 : undefined).join('/')}`.toLowerCase();
}

module.exports = { repoCandidates, repoIdentity, isPublicName, JSON_NAMES, MAX_LENGTH };
