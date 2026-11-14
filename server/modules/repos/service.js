'use strict';

const { getSourceUi, clientViewOfUi } = require('../common/source-ui');

function createRepoService({
  readStore,
  writeStore,
  listAvailableSourcesFromRepos,
  detectRepoKind,
  autoInstallLocalSources,
  loadSourceFromFile,
  isSafeUrl,
  fetchJson,
  sha1Short,
}) {
  async function getState() {
    await autoInstallLocalSources();
    const store = await readStore();
    const availableSources = await listAvailableSourcesFromRepos(store.repos);

    const availableBySid = new Map(availableSources.map(s => [s.id, s]));

    const installedSources = { ...(store.installedSources || {}) };
    for (const sid of Object.keys(installedSources)) {
      const entry = installedSources[sid];
      const updateAvailable = entry.installedVia === 'repo'
        && availableBySid.has(sid)
        && String(availableBySid.get(sid).version) !== String(entry.version);

      try {
        const mod = loadSourceFromFile(sid);
        // What the source declared in meta.ui, already validated by the loader (common/source-ui.js); the browser never
        // sees the server-side Referer rules.
        const ui = clientViewOfUi(getSourceUi(sid));
        // `ui` comes from the loaded source only: a stored entry (a hand-edited store, a restored backup) must not pass one on.
        const { ui: _storedUi, ...stored } = installedSources[sid];
        installedSources[sid] = {
          ...stored,
          beta: mod.meta?.beta === true,
          ...(ui ? { ui } : {}),
          updateAvailable,
          capabilities: {
            trending: typeof mod.trending === 'function' && mod.meta?.supportsTrending !== false,
            recentlyAdded: typeof mod.recentlyAdded === 'function' && mod.meta?.supportsRecentlyAdded !== false,
            latestUpdates: typeof mod.latestUpdates === 'function' && mod.meta?.supportsLatestUpdates !== false,
            popularAllTime: mod.meta?.supportsPopularAllTime === true,
          },
        };
      } catch (_) {
        const { ui: _staleUi, ...stored } = installedSources[sid];
        installedSources[sid] = {
          ...stored,
          updateAvailable,
          capabilities: {
            trending: false,
            recentlyAdded: false,
            latestUpdates: false,
            popularAllTime: false,
          },
        };
      }
    }

    return {
      repos: store.repos,
      availableSources,
      installedSources,
    };
  }

  async function addRepo({ url, repoJson } = {}) {
    let repoData;
    let repoUrl;

    if (typeof url === 'string' && url.startsWith('http')) {
      if (!isSafeUrl(url)) {
        const err = new Error('URL is not allowed (private/loopback)');
        err.statusCode = 400;
        throw err;
      }
      repoData = await fetchJson(url);
      repoUrl = url;
    } else if (repoJson) {
      repoData = repoJson;
      repoUrl = `localrepo:${sha1Short(JSON.stringify(repoData))}`;
    } else {
      const err = new Error('Valid URL or repoJson required');
      err.statusCode = 400;
      throw err;
    }

    const kind = detectRepoKind(repoData);
    if (kind === 'unknown') {
      const err = new Error('Unrecognised repo format');
      err.statusCode = 400;
      throw err;
    }

    const store = await readStore();
    if (!store.repos.some(r => r.url === repoUrl)) {
      const name = repoData?.name || (kind === 'tachiyomi' ? 'Tachiyomi Repo' : repoUrl);
      store.repos.push({ url: repoUrl, name, kind });
      await writeStore(store);
    }

    return { ok: true, kind };
  }

  async function deleteRepo(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!url) {
      const err = new Error('url query parameter required');
      err.statusCode = 400;
      throw err;
    }

    const store = await readStore();
    store.repos = store.repos.filter(r => r.url !== url);
    await writeStore(store);
    return { ok: true };
  }

  return {
    getState,
    addRepo,
    deleteRepo,
  };
}

module.exports = { createRepoService };