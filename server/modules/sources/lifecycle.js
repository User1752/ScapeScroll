'use strict';

const { safeId, isSafeUrl, fetchText } = require('../../helpers');
const { removeImportMarker } = require('../common/import-marker');

/**
 * Creates source lifecycle operations (install/uninstall) decoupled from routes.
 */
function createSourceLifecycleService({
  readStore,
  writeStore,
  sourcePath,
  builtinSourcePath,
  loadSourceFromFile,
  clearSourceCache,
  listAvailableSourcesFromRepos,
  invalidatePopularAll,
}) {
  async function installSource(rawId, repos = []) {
    const sid = safeId(rawId);
    if (!sid) {
      const err = new Error('Invalid source ID');
      err.statusCode = 400;
      throw err;
    }

    const available = await listAvailableSourcesFromRepos(repos);
    const source = available.find(entry => entry.id === sid);
    if (!source) {
      const err = new Error('Source not found in any repo');
      err.statusCode = 404;
      throw err;
    }
    if (source.kind !== 'js') {
      const err = new Error('Source type not supported');
      err.statusCode = 400;
      throw err;
    }

    // Official Extras are read straight off local disk — no HTTP fetch, no
    // isSafeUrl check, so installing them has no network/GitHub dependency.
    let code;
    if (source.repoUrl === 'builtin') {
      code = await require('fs').promises.readFile(builtinSourcePath(sid), 'utf8');
    } else {
      if (!isSafeUrl(source.codeUrl)) {
        const err = new Error('Source code URL is not valid');
        err.statusCode = 400;
        throw err;
      }
      code = await fetchText(source.codeUrl);
    }

    const targetPath = sourcePath(sid);
    await require('fs').promises.writeFile(targetPath, code, 'utf8');
    // Must run before loadSourceFromFile() below — on a re-install/update
    // the module is already cached from the previous version, and without
    // this the freshly-written file's meta (esp. version) would never
    // actually be read back.
    clearSourceCache(sid);

    // allowSelfHeal: false — the file just written above is a FRESH copy for
    // this reinstall/update, not a pre-existing on-disk copy that could have
    // been externally corrupted (e.g. by antivirus). If it fails to load,
    // core.js's default self-heal would silently fall back to the old
    // bundled snapshot and delete this fresh file, masking a genuinely
    // broken reinstall as a silent no-op. Let it throw so the real error
    // reaches the route's error handler / the user instead.
    const mod = loadSourceFromFile(sid, { allowSelfHeal: false });
    return {
      sid,
      installed: {
        id: sid,
        name: mod.meta.name || source.name,
        version: mod.meta.version || source.version,
        author: mod.meta.author || source.author || '',
        icon: mod.meta.icon || source.icon || '',
        installedAt: new Date().toISOString(),
        installedVia: 'repo',
      },
    };
  }

  async function removeSource(rawId) {
    const sid = safeId(rawId);
    if (!sid) {
      const err = new Error('Invalid source ID');
      err.statusCode = 400;
      throw err;
    }

    const fs = require('fs');
    const filePath = sourcePath(sid);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
    // The copy the import tool keeps when it replaces a file: uninstalling on purpose leaves no orphan behind.
    await fs.promises.unlink(`${filePath}.bak`).catch(() => {});
    // And the marker the command line leaves next to an imported file (common/import-marker.js).
    await removeImportMarker(filePath);

    return { sid };
  }

  async function installById(rawId) {
    const store = await readStore();
    const { sid, installed } = await installSource(rawId, store.repos);

    invalidatePopularAll();

    store.installedSources[sid] = installed;
    await writeStore(store);

    return { ok: true, installed: store.installedSources[sid] };
  }

  async function uninstallById(rawId) {
    const sid = safeId(rawId);
    const store = await readStore();
    // 'repo' (installed from a repository) and 'imported' (a file the person imported, server/modules/source-import/)
    // are the two origins this app put on disk itself; a bundled source is a file the person or the build placed.
    const via = store.installedSources[sid]?.installedVia;
    if (via !== 'repo' && via !== 'imported') {
      const err = new Error('Cannot uninstall a bundled source');
      err.statusCode = 400;
      throw err;
    }

    await removeSource(sid);

    delete store.installedSources[sid];
    await writeStore(store);

    clearSourceCache(sid);
    invalidatePopularAll();

    return { ok: true };
  }

  return {
    installById,
    uninstallById,
  };
}

module.exports = {
  createSourceLifecycleService,
};
