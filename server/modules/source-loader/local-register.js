'use strict';

const { readValidImportMarker } = require('../common/import-marker');

// What the scan of the sources folder (core.js autoInstallLocalSources) does with each file it finds: register it in the store.
//
// A file the command line imported (tools/source-lab.js) leaves a marker with its sha256: while that still matches the file, the
// source is an IMPORTED one (listed with Test and Uninstall in the Import card), also when it was registered as a plain local
// ("bundled") one before the marker existed. Every other file is a "bundled" source, as before.

/**
 * @param {object} ctx
 * @param {object} ctx.store  the store, changed in place
 * @param {string[]} ctx.ids  the ids found on disk
 * @param {(id: string) => object} ctx.loadSourceFromFile
 * @param {(id: string) => string} ctx.sourcePath
 * @param {(message: string) => void} [ctx.warn]
 */
async function registerLocalSources({ store, ids, loadSourceFromFile, sourcePath, warn = () => {} }) {
  const markerOf = (id) => { try { return readValidImportMarker(sourcePath(id)); } catch (_) { return null; } };
  await Promise.all(ids.map(async (id) => {
    const known = store.installedSources[id];
    if (known) {
      const marker = known.installedVia === 'bundled' ? markerOf(id) : null;
      if (marker) Object.assign(known, { installedVia: 'imported', sha256: marker.sha256 });
      return;
    }
    try {
      const mod = loadSourceFromFile(id);
      const marker = markerOf(id);
      store.installedSources[id] = {
        id,
        name: mod.meta.name || id,
        version: mod.meta.version || '1.0.0',
        author: mod.meta.author || 'Local',
        icon: mod.meta.icon || '',
        installedAt: marker && marker.importedAt ? marker.importedAt : new Date().toISOString(),
        installedVia: marker ? 'imported' : 'bundled',
        ...(marker ? { sha256: marker.sha256 } : {}),
      };
    } catch (e) {
      warn(`[WARN] Auto-install failed for ${id}: ${e.message}`);
    }
  }));
}

module.exports = { registerLocalSources };
