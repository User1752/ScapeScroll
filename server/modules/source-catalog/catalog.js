'use strict';

const path = require('path');
const crypto = require('crypto');
const baseConfig = require('../../config/catalog');
const { createTtlDiskCache } = require('../common/ttl-disk-cache');
const { createFailure } = require('../source-import/failure');
const { supportedEngines, idFromBase } = require('../source-import/generator');
const { blockedReason } = require('../source-import/site-denylist');
const { parseRepoIndex } = require('./index-format');
const { createThemeResolver, CUSTOM, UNKNOWN } = require('./themes');
const { createCloudflareCheck } = require('./cloudflare');
const { createWorkQueue } = require('./work-queue');

// The source catalog: the sites a Mihon-compatible repository lists, with, for each, whether this app can write a source for it by
// itself (the theme of its extension names an engine that has a template), whether it sits behind Cloudflare, and whether it is
// already installed. It is the list behind the "Source catalog" block of Settings; choosing a site there hands its address to the same
// generator, Check and Install the "add from a link" block uses, so nothing is installed that the person did not see checked.
//
// What is asked of the network, and of whom: the list itself (once a day) and the build file of each extension (once a week) from
// GitHub, Cloudflare's published address ranges (once a week), and the DNS for the NAME of a site that can be added automatically
// (once a day). A site is only contacted after the person chooses it, one at a time, by the generator.

const KEY_RE = /^([a-z0-9._]{1,120})#(\d{1,3})$/;
// What an extension's repository is called when it is the one the app knows (the others carry the address of their list).
const DEFAULT_REPO = 'default';
// The key the parsed list is kept under on disk. Changed when what is kept changes shape (2: the logo of each extension), so an older copy is read again.
const INDEX_KEY = 'index-2';
const LANG_RE = /^[A-Za-z]{2,4}(?:-[A-Za-z0-9]{2,8})?$/;
// An extension published for every language (its package says `all`) is what the Mihon app lists under "Multi": all its sites are under the language `all` too.
const MULTI_PACKAGE_RE = /^eu\.kanade\.tachiyomi\.extension\.all\./;
const MULTI_LANG = 'all';
const QUERY_MAX = 80;

/** What this app can do for a site, from the theme of its extension. */
function engineOf(theme) {
  if (theme === null || theme === undefined) return 'checking';
  if (supportedEngines().includes(theme)) return 'ready';
  if (theme === CUSTOM) return 'handwritten';
  if (theme === UNKNOWN) return 'unknown';
  return 'later';
}

// Control, separator and bidi characters (built from code points, never typed); the line break and the tab stay.
const UNSAFE_TEXT = new RegExp(`[${[[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]].map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`, 'g');

/** Text from a third party as plain lines: control and bidi characters out, markup characters left as text (the screen only ever sets it as text), cut. */
function plainText(value, max) {
  return String(value || '').replace(UNSAFE_TEXT, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

const ENGINE_REFUSALS = Object.freeze({
  handwritten: 'This site has its own scraper in the repository (it is not built on a shared theme), so a source for it has to be written by hand.',
  later: 'This site is built on a theme this app has no template for yet.',
  unknown: 'What this site is built on could not be found, so no source can be written for it.',
});

/** The caches the catalog keeps on disk (one small file each), or in memory only when no folder is given. */
function createCaches(cacheDir, config = baseConfig) {
  const make = (file) => {
    const cache = createTtlDiskCache({ maxEntries: config.cacheMaxEntries });
    if (cacheDir) cache.configure({ cacheFilePath: path.join(cacheDir, file) });
    return cache;
  };
  return { index: make('catalog-index.json'), themes: make('catalog-themes.json'), dns: make('catalog-dns.json'), failed: make('catalog-failed.json') };
}

/**
 * @param {object} deps
 * @param {(url: string, maxBytes: number) => Promise<{ status: number, text: string }>} deps.fetchText
 * @param {{ index: object, themes: object, dns: object, failed: object }} deps.caches   from createCaches()
 * @param {object} [deps.config]
 * @param {{ resolve4: Function, resolve6: Function }} [deps.resolver]   the DNS (replaced in tests)
 * @param {() => string[]} [deps.denylist]   the person's own list of dangerous sites, read when needed
 * @param {() => Promise<Array<{ url: string, name: string }>>} [deps.getExtraRepos]   the repositories the person added besides the default one
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 */
function createCatalog({ fetchText, caches, config = baseConfig, resolver, denylist = () => [], now = Date.now, sleep, getExtraRepos = async () => [], getDefaultOn = async () => true }) {
  const allowedWarnings = new Set(config.allowedWarnings);
  const themes = createThemeResolver({ baseUrl: config.themeBaseUrl, fetchText, cache: caches.themes, ttlMs: config.themeTtlMs, retryMs: config.themeRetryMs, maxBytes: config.themeMaxBytes });
  const cloudflare = createCloudflareCheck({ urls: config.cloudflareRangesUrls, fetchText, cache: caches.dns, ttlMs: config.rangesTtlMs, maxBytes: config.rangesMaxBytes, dnsTtlMs: config.dnsTtlMs, resolver });
  const queueBase = { breakerCount: config.failureBreakerCount, breakerMs: config.failureBreakerMs, now, ...(sleep ? { sleep } : {}) };
  const themeQueue = createWorkQueue({ concurrency: config.themeConcurrency, spacingMs: config.themeSpacingMs, ...queueBase });
  const dnsQueue = createWorkQueue({ concurrency: config.dnsConcurrency, spacingMs: config.dnsSpacingMs, ...queueBase });

  // Every repository (the default one and those the person added) is read and kept on its own; the catalog is their merge.
  const repoStates = new Map(); // the address of a list -> { memory, loading }
  let merged = null; // { sources, index }
  const keyOfRepo = (url) => `${INDEX_KEY}:${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}`;

  function remember(state, value, at) {
    state.memory = { ...value, byPkg: new Map(value.extensions.map((ext) => [ext.pkg, ext])), at };
    return state.memory;
  }

  /** The list of one repository: the copy kept in memory or on disk while it is fresh, else read again; an older copy when it cannot be read. */
  async function loadRepo(url, key) {
    let state = repoStates.get(url);
    if (!state) { state = { memory: null, loading: null }; repoStates.set(url, state); }
    if (state.memory && now() - state.memory.at < config.indexTtlMs) return state.memory;
    if (!state.loading) {
      state.loading = (async () => {
        await caches.index.ensureLoaded();
        const fresh = caches.index.getFresh(key, config.indexTtlMs);
        if (fresh) return remember(state, fresh, fresh.fetchedAt || now());
        try {
          const res = await fetchText(url, config.indexMaxBytes);
          if (res.status !== 200) throw new Error(`the repository answered ${res.status}`);
          const parsed = parseRepoIndex(JSON.parse(res.text));
          const value = { format: parsed.format, extensions: parsed.extensions, fetchedAt: now(), stale: false };
          caches.index.set(key, value);
          return remember(state, value, now());
        } catch (err) {
          const old = caches.index.getFresh(key, Infinity);
          // Asked again after a few minutes, not on every request.
          if (old) return remember(state, { ...old, stale: true }, now() - config.indexTtlMs + config.indexRetryMs);
          throw createFailure(`The list of extensions could not be read (${String((err && err.message) || err).slice(0, 120)}). Check the connection and try again.`, 502);
        }
      })().finally(() => { state.loading = null; });
    }
    return state.loading;
  }

  /**
   * The catalog: the default repository's list (which must be readable) merged with the lists of the repositories the person added (one that cannot be read
   * is left out, and said so in `repos`). An extension in two repositories is listed once, from the first. Each extension says which repository it is from.
   */
  async function loadIndex() {
    // The default repository can be removed by the person (then only the ones they added are read); while it is on, it must be readable.
    const main = (await getDefaultOn()) ? await loadRepo(config.repoIndexUrl, INDEX_KEY) : null;
    const extras = [];
    for (const entry of await getExtraRepos()) {
      if (!entry || typeof entry.url !== 'string' || entry.url === config.repoIndexUrl) continue;
      let data = null;
      try { data = await loadRepo(entry.url, keyOfRepo(entry.url)); } catch (_) { /* left out; the list says so */ }
      extras.push({ entry, data });
    }
    const sources = [main, ...extras.map((e) => e.data)];
    if (merged && merged.sources.length === sources.length && merged.sources.every((source, i) => source === sources[i])) return merged.index;
    const seen = new Set();
    const extensions = [];
    const take = (data, repo) => {
      for (const ext of data.extensions) {
        if (seen.has(ext.pkg)) continue;
        seen.add(ext.pkg);
        ext.repo = repo;
        extensions.push(ext);
      }
    };
    if (main) take(main, DEFAULT_REPO);
    for (const { entry, data } of extras) if (data) take(data, entry.url);
    const index = {
      format: main ? main.format : null,
      main: main ? { count: main.extensions.length, stale: main.stale === true } : null,
      extensions,
      byPkg: new Map(extensions.map((ext) => [ext.pkg, ext])),
      stale: sources.some((source) => source && source.stale === true),
      fetchedAt: main ? main.fetchedAt : now(),
      at: main ? main.at : now(),
      repos: extras.map(({ entry, data }) => ({ url: entry.url, name: entry.name, ok: !!data, count: data ? data.extensions.length : 0, stale: !!(data && data.stale) })),
    };
    merged = { sources, index };
    return index;
  }

  function enqueueTheme(pkg) {
    themeQueue.add(pkg, async () => {
      const answer = await themes.resolve(pkg);
      if (!answer.ok) throw new Error('theme not read');
    });
  }

  function enqueueDns(host) {
    if (blockedReason(`https://${host}/`, denylist())) return;
    dnsQueue.add(host, async () => { await cloudflare.check(host); });
  }

  /** The warnings this list may hold: what the person asked for, within what this edition offers. */
  function effectiveWarnings(requested) {
    const asked = Array.isArray(requested) ? requested.filter((w) => allowedWarnings.has(w)) : [];
    return asked.length ? new Set(asked) : new Set(allowedWarnings);
  }

  /**
   * One page of the catalog: a row per site.
   * @param {{ lang?: string, q?: string, warnings?: string[], nativeOnly?: boolean, hideCloudflare?: boolean, hideAdult?: boolean, hideInstalled?: boolean, onlyInstalled?: boolean, offset?: number, limit?: number }} [params]
   * @param {{ ids?: Set<string>, bases?: Set<string>, byBase?: Map<string, string> }} [installed]   what is installed, to mark the rows (byBase: the id of the source written for an address)
   * @param {{ extensionEngine?: boolean }} [options]   whether the person has set up a Suwayomi-Server: then a site with a scraper of its own can be added through it
   */
  async function list(params = {}, installed = {}, options = {}) {
    const index = await loadIndex();
    await Promise.all([caches.themes.ensureLoaded(), caches.dns.ensureLoaded(), caches.failed.ensureLoaded()]);
    const warnings = effectiveWarnings(params.warnings);
    const lang = (LANG_RE.test(String(params.lang || '')) ? String(params.lang) : config.defaultLanguage).toLowerCase();
    const query = String(params.q || '').toLowerCase().trim().slice(0, QUERY_MAX);
    const nativeOnly = params.nativeOnly !== false;
    const hideCloudflare = params.hideCloudflare === true;
    const hideAdult = params.hideAdult === true;
    const hideInstalled = params.hideInstalled === true;
    const onlyInstalled = params.onlyInstalled === true;
    const byBase = installed.byBase instanceof Map ? installed.byBase : new Map();
    const ids = installed.ids || new Set();
    const bases = installed.bases || new Set();
    const blockedList = denylist();
    const repoNames = new Map((index.repos || []).map((r) => [r.url, r.name]));
    const engineOn = config.extensionEngine === true && options.extensionEngine === true;

    const languages = new Map();
    const counts = { ready: 0, later: 0, handwritten: 0, checking: 0, unknown: 0, failed: 0 };
    const rows = [];
    for (const ext of index.extensions) {
      if (!warnings.has(ext.warning) || (hideAdult && ext.warning === 'NSFW')) continue;
      // A repository the person added has no source code of the extensions to read a theme from: its sites are judged by the generator when chosen ('check').
      const extra = ext.repo !== DEFAULT_REPO;
      const multi = MULTI_PACKAGE_RE.test(ext.pkg);
      const found = extra ? null : themes.peek(ext.pkg);
      const theme = extra ? UNKNOWN : (found ? found.theme : null);
      const engine = engineOf(theme);
      ext.sites.forEach((site, position) => {
        const siteLang = site.lang.toLowerCase();
        languages.set(site.lang, (languages.get(site.lang) || 0) + 1);
        // The sites of a multi-language extension are also under `all`, like the Multi group of the Mihon app.
        if (multi && siteLang !== MULTI_LANG) languages.set(MULTI_LANG, (languages.get(MULTI_LANG) || 0) + 1);
        if (siteLang !== lang && !(multi && lang === MULTI_LANG)) return;
        if (engine === 'checking') enqueueTheme(ext.pkg);
        // How a source can be added: written from a template ('native'), or read through the person's Suwayomi-Server ('engine'), which runs any extension.
        const viaEngine = engineOn && !extra && engine !== 'checking' && site.sourceId ? 'engine' : '';
        // A site the template could not be written for when the person tried (it did not answer, or it uses a customised theme) is not offered
        // as automatic for a while: only through the engine, when that is set up, and else not at all.
        const failed = (engine === 'ready' || extra) && !!caches.failed.getFresh(site.host, config.failedTtlMs);
        const via = engine === 'ready' && !failed ? 'native' : (extra && !failed ? 'check' : viaEngine);
        counts[failed ? 'failed' : engine] += 1;
        // The id of the source already added for this site (written from its address, from a link, or through the engine), or ''.
        const nativeId = idFromBase(site.url);
        const engineId = site.sourceId ? `${config.engineIdPrefix}${site.sourceId}` : '';
        const installedId = ids.has(nativeId) ? nativeId : (byBase.get(site.url) || (engineId && ids.has(engineId) ? engineId : ''));
        const installedHere = !!installedId || bases.has(site.url);
        // "Only added" shows what is added, whatever the app could do with it today.
        if (onlyInstalled && !installedHere) return;
        if (nativeOnly && !via && !onlyInstalled) return;
        if (query && !`${site.name} ${site.host} ${ext.name}`.toLowerCase().includes(query)) return;
        let cf = 'n/a';
        if (engine === 'ready') {
          cf = cloudflare.peek(site.host);
          if (!cf) { cf = 'checking'; enqueueDns(site.host); }
        }
        if (hideCloudflare && cf === 'yes') return;
        if (hideInstalled && installedHere) return;
        rows.push({
          key: `${ext.pkg}#${position}`,
          name: site.name,
          host: site.host,
          lang: site.lang,
          warning: ext.warning,
          version: ext.version,
          icon: ext.icon || '',
          theme: extra ? '' : (theme || ''),
          engine: failed ? 'failed' : engine,
          via,
          cloudflare: cf,
          installed: installedHere,
          installedId,
          blocked: !!blockedReason(site.url, blockedList),
          repo: extra ? repoNames.get(ext.repo) || '' : '',
        });
      });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.host.localeCompare(b.host));
    const limit = Math.max(1, Math.min(config.maxPageSize, Math.floor(Number(params.limit)) || config.pageSize));
    const offset = Math.max(0, Math.floor(Number(params.offset)) || 0);
    return {
      rows: rows.slice(offset, offset + limit),
      total: rows.length,
      offset,
      limit,
      lang,
      languages: [...languages].map(([code, count]) => ({ lang: code, count })).sort((a, b) => b.count - a.count || a.lang.localeCompare(b.lang)).slice(0, 40),
      counts,
      extensionEngine: { available: config.extensionEngine === true, enabled: engineOn },
      pending: { themes: themeQueue.size(), dns: dnsQueue.size(), paused: themeQueue.paused() || dnsQueue.paused() },
      stale: index.stale === true,
      fetchedAt: index.fetchedAt || 0,
    };
  }

  /**
   * The site a row stands for, and that a source can be written for it. The address is the repository's, never one the browser sent.
   * @param {string} key   'package#position' from a row
   * @returns {Promise<{ url: string, name: string, pkg: string, theme: string, warning: string, id: string }>}
   */
  async function siteOf(key) {
    const match = KEY_RE.exec(String(key || ''));
    if (!match) throw createFailure('That is not an entry of the catalog.', 400);
    const index = await loadIndex();
    const ext = index.byPkg.get(match[1]);
    const site = ext && ext.sites[Number(match[2])];
    if (!site) throw createFailure('That entry is no longer in the catalog. Refresh the list.', 404);
    if (!allowedWarnings.has(ext.warning)) throw createFailure('This entry is not available in this edition.', 403);
    const refused = blockedReason(site.url, denylist());
    if (refused) throw createFailure(`Not asked, it is on the list of dangerous sites (${refused}).`, 403);
    // A site of a repository the person added has no theme to read: the generator looks at the site itself and says whether a source can be written.
    if (ext.repo !== DEFAULT_REPO) return { url: site.url, name: site.name, pkg: ext.pkg, theme: UNKNOWN, warning: ext.warning, id: idFromBase(site.url) };
    await caches.themes.ensureLoaded();
    let found = themes.peek(ext.pkg);
    if (!found) found = await themes.resolve(ext.pkg);
    if (!found.ok) throw createFailure('What this site is built on could not be read (GitHub did not answer). Try again in a moment.', 502);
    const engine = engineOf(found.theme);
    if (engine !== 'ready') throw createFailure(ENGINE_REFUSALS[engine] || ENGINE_REFUSALS.unknown, 409);
    return { url: site.url, name: site.name, pkg: ext.pkg, theme: found.theme, warning: ext.warning, id: idFromBase(site.url) };
  }

  /**
   * The extension and source a row stands for, to add through the person's Suwayomi-Server (the extension engine). Unlike siteOf it needs no theme:
   * the extension engine runs any extension. The package and the source id are the repository's, never the browser's.
   * @param {string} key   'package#position' from a row
   * @returns {Promise<{ pkg: string, sourceId: string, name: string, lang: string, warning: string, id: string }>}
   */
  async function engineSiteOf(key) {
    if (config.extensionEngine !== true) throw createFailure('The extension engine is not available here.', 403);
    const match = KEY_RE.exec(String(key || ''));
    if (!match) throw createFailure('That is not an entry of the catalog.', 400);
    const index = await loadIndex();
    const ext = index.byPkg.get(match[1]);
    const site = ext && ext.sites[Number(match[2])];
    if (!site) throw createFailure('That entry is no longer in the catalog. Refresh the list.', 404);
    if (!allowedWarnings.has(ext.warning)) throw createFailure('This entry is not available here.', 403);
    const refused = blockedReason(site.url, denylist());
    if (refused) throw createFailure(`Not asked, it is on the list of dangerous sites (${refused}).`, 403);
    if (ext.repo !== DEFAULT_REPO) throw createFailure('Through the Suwayomi-Server only the sites of the default repository can be added for now.', 409);
    if (!site.sourceId) throw createFailure('The repository does not give an id for this site, so the extension engine cannot find it.', 409);
    return { pkg: ext.pkg, sourceId: site.sourceId, name: site.name, lang: site.lang, warning: ext.warning, id: `${config.engineIdPrefix}${site.sourceId}` };
  }

  /**
   * Remembers that no source could be written for a row's site when the person chose it (it did not answer, or the template does not fit), so the
   * list stops offering it as automatic for a while. Only the site's name is kept, with a short reason; a key that is not a row is ignored.
   * @param {string} key   'package#position' from a row
   * @param {string} reason   one short line, for the file only
   */
  async function markFailed(key, reason) {
    const match = KEY_RE.exec(String(key || ''));
    if (!match) return false;
    const index = await loadIndex();
    const ext = index.byPkg.get(match[1]);
    const site = ext && ext.sites[Number(match[2])];
    if (!site) return false;
    await caches.failed.ensureLoaded();
    caches.failed.set(site.host, String(reason || 'refused').replace(/\s+/g, ' ').slice(0, 80));
    return true;
  }

  /**
   * The extension and site the app wrote an engine source for, by the id Suwayomi gave the source (the digits after the prefix of the source's own id),
   * to update it. The same checks as engineSiteOf: the repository's package, never one the browser sent; the edition's content cap; the dangerous list.
   * @param {string} sourceId   digits, as text
   * @returns {Promise<{ pkg: string, sourceId: string, name: string, lang: string, warning: string, id: string }>}
   */
  async function engineSiteOfSourceId(sourceId) {
    if (config.extensionEngine !== true) throw createFailure('The extension engine is not available here.', 403);
    if (!/^\d{1,20}$/.test(String(sourceId || ''))) throw createFailure('That is not the id of a source written for the extension engine.', 400);
    const index = await loadIndex();
    if (!index.bySourceId) {
      index.bySourceId = new Map();
      for (const ext of index.extensions) for (const site of ext.sites) if (ext.repo === DEFAULT_REPO && site.sourceId && !index.bySourceId.has(site.sourceId)) index.bySourceId.set(site.sourceId, { ext, site });
    }
    const found = index.bySourceId.get(String(sourceId));
    if (!found) throw createFailure('The repository no longer lists this source, so there is nothing to update it from.', 404);
    const { ext, site } = found;
    if (!allowedWarnings.has(ext.warning)) throw createFailure('This entry is not available here.', 403);
    const refused = blockedReason(site.url, denylist());
    if (refused) throw createFailure(`Not asked, it is on the list of dangerous sites (${refused}).`, 403);
    return { pkg: ext.pkg, sourceId: site.sourceId, name: site.name, lang: site.lang, warning: ext.warning, id: `${config.engineIdPrefix}${site.sourceId}` };
  }

  const changelogs = new Map();

  /**
   * What changed in an extension: a link to its history in the project that builds it and, when its folder has a CHANGELOG.md, the start of that text
   * (plain text, cut). The repository does not carry changelogs, so this is best effort: no file is not an error. Kept for a day.
   * @param {string} pkg   a package of the repository's list
   * @returns {Promise<{ url: string, text: string }>}
   */
  async function changelogFor(pkg) {
    const match = /^eu\.kanade\.tachiyomi\.extension\.([a-z]{2,4})\.([a-z0-9_]{1,60})$/.exec(String(pkg || ''));
    if (!match) return { url: '', text: '' };
    const kept = changelogs.get(pkg);
    if (kept && now() - kept.at < config.changelogTtlMs) return kept.value;
    const folder = `${match[1]}/${match[2]}`;
    const value = { url: `${config.changelogHistoryBase}${folder}`, text: '' };
    try {
      const res = await fetchText(`${config.themeBaseUrl}${folder}/CHANGELOG.md`, config.changelogMaxBytes);
      if (res.status === 200) value.text = plainText(res.text, config.changelogMaxChars);
    } catch (_) { /* no file, or the project did not answer: the link is still there */ }
    if (changelogs.size >= 100) changelogs.clear();
    changelogs.set(pkg, { value, at: now() });
    return value;
  }

  /** Drops the background work that has not started (the app is closing, or a test is over). */
  function close() {
    themeQueue.clear();
    dnsQueue.clear();
  }

  /** How each repository the person added is doing (readable or not, how many extensions); an empty list when the catalog itself cannot be read. */
  async function reposStatus() {
    try { return (await loadIndex()).repos || []; } catch (_) { return []; }
  }

  /** How the default repository is doing: { ok, count } when it is on, null when the person removed it. */
  async function defaultStatus() {
    try {
      const index = await loadIndex();
      return index.main ? { ok: true, count: index.main.count } : null;
    } catch (_) { return (await getDefaultOn()) ? { ok: false, count: 0 } : null; }
  }

  return { list, siteOf, engineSiteOf, engineSiteOfSourceId, changelogFor, markFailed, engineOf, loadIndex, reposStatus, defaultStatus, close };
}

module.exports = { createCatalog, createCaches, engineOf };
