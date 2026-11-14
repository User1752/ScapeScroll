'use strict';

const { repoCandidates, repoIdentity, isPublicName } = require('./repo-url');
const { parseRepoIndex } = require('./index-format');
const { createFailure } = require('../source-import/failure');

// The extension repositories a person added to the catalog, besides the one the app knows. They live in the settings (settings.catalogRepos) as
// { url, name }: the address of the repository's list and a short name. What is stored is read back with the same strictness it was accepted with, so a
// settings file edited by hand (or a backup from somewhere else) cannot make the server fetch an address this file would have refused.

const MAX_REPOS = 8;

/** A stored entry as a clean { url, name }, or null when it is not one this file would have accepted. */
function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let url;
  try { url = new URL(String(raw.url)); } catch (_) { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || !isPublicName(url.hostname.toLowerCase())) return null;
  if (!/\/index(?:\.min)?\.json$/i.test(url.pathname) || url.href.length > 300) return null;
  const name = String(raw.name || url.hostname).replace(/[^\p{L}\p{N} ._/@-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || url.hostname;
  return { url: url.href, name };
}

/**
 * @param {object} deps
 * @param {{ readStore: Function, writeStore: Function, flushNow: Function }} deps.store
 * @param {(url: string, maxBytes: number) => Promise<{ status: number, text: string }>} deps.fetchText   the catalog's own request (address check, time and size limits)
 * @param {{ repoIndexUrl: string, indexMaxBytes: number }} deps.config
 */
function createRepoRegistry({ store, fetchText, config }) {
  const readEntries = async () => {
    const data = await store.readStore();
    const list = data && data.settings && Array.isArray(data.settings.catalogRepos) ? data.settings.catalogRepos : [];
    const seen = new Set();
    const out = [];
    for (const raw of list.slice(0, MAX_REPOS * 2)) {
      const entry = cleanEntry(raw);
      const identity = entry ? repoIdentity(entry.url) : '';
      if (entry && identity !== repoIdentity(config.repoIndexUrl) && !seen.has(identity)) { seen.add(identity); out.push(entry); }
      if (out.length >= MAX_REPOS) break;
    }
    return out;
  };

  // The repository the app knows can be removed too, and pasting its address again puts it back. settings.catalogDefaultOff says what the person chose (true: removed,
  // false: put back); with no choice yet the edition decides (config.defaultRepoOn: the edition without sources starts without it).
  const defaultIdentity = repoIdentity(config.repoIndexUrl);
  const defaultOn = async () => {
    const data = await store.readStore();
    const chosen = data && data.settings && data.settings.catalogDefaultOff;
    return typeof chosen === 'boolean' ? !chosen : config.defaultRepoOn !== false;
  };
  const setDefault = async (on) => {
    const data = await store.readStore();
    data.settings = data.settings || {};
    data.settings.catalogDefaultOff = !on;
    await store.writeStore(data);
    store.flushNow();
  };

  const save = async (entries) => {
    const data = await store.readStore();
    data.settings = data.settings || {};
    data.settings.catalogRepos = entries;
    await store.writeStore(data);
    store.flushNow();
  };

  /** The repositories added, as [{ url, name }]. */
  const list = () => readEntries();

  /**
   * Checks the address (what it is, then that a list of extensions really is there) and keeps it.
   * @param {string} input
   * @returns {Promise<{ url: string, name: string, count: number, sites: number }>}
   */
  async function add(input) {
    const { candidates, label } = repoCandidates(input);
    const entries = await readEntries();
    // Every form of one repository is the same repository (github.com/o/n/raw/repo/ or raw.githubusercontent.com/o/n/repo/, index.json or index.min.json).
    const identity = repoIdentity(candidates[0]);
    const isDefault = identity === defaultIdentity;
    if ((isDefault && (await defaultOn())) || entries.some((e) => repoIdentity(e.url) === identity)) throw createFailure('That repository is already in the catalog.', 409);
    if (!isDefault && entries.length >= MAX_REPOS) throw createFailure(`At most ${MAX_REPOS} repositories can be added. Remove one first.`, 409);
    // Every form is asked for and the BIGGEST list wins, not the first that reads: a repository can keep a small stub under one of the names (the biggest
    // repository of its kind answers index.min.json with two entries that tell an old app to update, and keeps the real list in index.json).
    let best = null;
    let lastProblem = '';
    for (const candidate of candidates) {
      try {
        const res = await fetchText(candidate, config.indexMaxBytes);
        if (res.status !== 200) { lastProblem = `it answered ${res.status}`; continue; }
        let parsed;
        try { parsed = parseRepoIndex(JSON.parse(res.text)); } catch (err) { lastProblem = String(err.message).slice(0, 120); continue; }
        if (!best || parsed.extensions.length > best.parsed.extensions.length) best = { candidate, parsed };
      } catch (err) {
        if (err && err.statusCode) throw err;
        lastProblem = String((err && err.message) || err).slice(0, 120);
      }
    }
    if (!best) throw createFailure(`No list of extensions was found there${lastProblem ? ` (${lastProblem})` : ''}. Paste the address of the repository or of its index.min.json.`, 422);
    const entry = cleanEntry({ url: best.candidate, name: label });
    if (!entry) throw createFailure('That address cannot be used.', 400);
    const counted = { count: best.parsed.extensions.length, sites: best.parsed.extensions.reduce((n, e) => n + e.sites.length, 0) };
    if (isDefault) { await setDefault(true); return { url: config.repoIndexUrl, name: entry.name, ...counted, default: true }; }
    await save([...entries, entry]);
    return { ...entry, ...counted };
  }

  /** Removes a repository by the address of its list; false when it was not there. */
  async function remove(url) {
    if (repoIdentity(String(url || '')) === defaultIdentity) {
      if (!(await defaultOn())) return false;
      await setDefault(false);
      return true;
    }
    const entries = await readEntries();
    const kept = entries.filter((e) => e.url !== String(url || ''));
    if (kept.length === entries.length) return false;
    await save(kept);
    return true;
  }

  return { list, add, remove, defaultOn, MAX_REPOS };
}

module.exports = { createRepoRegistry, cleanEntry, MAX_REPOS };
