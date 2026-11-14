'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const limits = require('../../config/limits');
const sourceUi = require('../common/source-ui');
const { collectHostsOutsideDeclaration } = require('../source-import/static-report');
const { registerLocalSources } = require('./local-register');

function createSourceLoaderCore({ safeId, fetchJson, readStore, writeStore } = {}) {
  let SOURCES_DIR = '';
  let SNAP_SOURCES_DIR = '';
  let BUILTIN_SOURCES_DIR = '';
  let IS_PKG = false;
  const sourceCache = new Map();
  const declarationWarned = new Set();
  const reposCache = new Map();
  // Single-flight guard for autoInstallLocalSources(): concurrent calls
  // (e.g. two browser tabs' GET /api/state landing close together) would
  // otherwise each run their own readStore() → mutate → writeStore(store)
  // cycle against an independent in-memory snapshot of the store, racing on
  // the final writeStore() and silently discarding whichever call's
  // pruning/install changes lost the race.
  let autoInstallInFlight = null;

  function configure(opts) {
    SOURCES_DIR = opts.sourcesDir;
    SNAP_SOURCES_DIR = opts.snapSourcesDir;
    BUILTIN_SOURCES_DIR = opts.builtinSourcesDir || '';
    IS_PKG = opts.isPkg;
  }

  function requireFresh(modPath) {
    try { delete require.cache[require.resolve(modPath)]; } catch (_) {}
    return require(modPath);
  }

  // Compiles `src` as a CommonJS module that lives at `filename`: its relative requires resolve from there and nothing
  // is left in require.cache.
  function compileAsModule(filename, src) {
    const mod = new Module(filename, module.parent);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod._compile(src, filename);
    return mod.exports;
  }

  // A source file dropped onto real disk (SOURCES_DIR) requires() its own
  // deps — npm packages like cheerio, and this app's own shared helpers via
  // relative paths like '../../server/modules/network/fetch-utils' — from
  // its own real location, which can't see anything bundled into the
  // read-only pkg snapshot. Compiling it with a filename that PRETENDS it
  // lives inside the snapshot's own sources folder makes every require()
  // it makes resolve exactly like an already-bundled source's does, with
  // no disk copying and no snapshot changes needed.
  function requireAsSnapshotModule(realPath, id, source) {
    // Match the real file's own layout (flat vs subfolder) so its relative
    // requires resolve at the same depth they would if it were genuinely
    // bundled that way - faking a subfolder-layout source at
    // the flat depth resolves one directory short, breaking every relative
    // require() the file makes. A subfolder source is <id>/<id>.js, so both
    // names are checked: a staged candidate <sha256>.js in a folder that
    // happens to be called like the id (an id of "source-staging") is flat,
    // and so is a source sitting directly in the sources folder whose id is
    // that folder's own name (an id of "sources").
    const dir = path.resolve(path.dirname(realPath));
    const inSourcesRoot = dir === path.resolve(SOURCES_DIR) || dir === path.resolve(SNAP_SOURCES_DIR);
    const isSubfolder = !inSourcesRoot && path.basename(dir) === id && path.basename(realPath) === `${id}.js`;
    const fakeFilename = isSubfolder
      ? path.join(SNAP_SOURCES_DIR, id, `${id}.js`)
      : path.join(SNAP_SOURCES_DIR, `${id}.js`);
    const src = typeof source === 'string' ? source : fs.readFileSync(realPath, 'utf8');
    return compileAsModule(fakeFilename, src);
  }

  // Shared by sourcePath()'s own snapshot probe and loadSourceFromFile()'s
  // self-heal fallback below — both need the identical flat-then-subfolder,
  // containment-checked resolution, and had drifted out of sync once
  // already (the self-heal copy had lost the containment check sourcePath()
  // itself already applies).
  function resolveSnapPath(id) {
    const flatSnapPath = path.resolve(path.join(SNAP_SOURCES_DIR, `${id}.js`));
    const inFlatSnap = flatSnapPath.startsWith(path.resolve(SNAP_SOURCES_DIR) + path.sep);
    if (inFlatSnap && fs.existsSync(flatSnapPath)) return flatSnapPath;

    const subSnapPath = path.resolve(path.join(SNAP_SOURCES_DIR, id, `${id}.js`));
    const inSubSnap = subSnapPath.startsWith(path.resolve(SNAP_SOURCES_DIR) + path.sep);
    if (inSubSnap && fs.existsSync(subSnapPath)) return subSnapPath;

    return null;
  }

  function sourcePath(id) {
    // Primary location: sources/<id>.js (flat layout)
    const userPath = path.join(SOURCES_DIR, `${id}.js`);
    const resolvedUser = path.resolve(userPath);
    const inSources = resolvedUser.startsWith(path.resolve(SOURCES_DIR) + path.sep);
    if (inSources && fs.existsSync(resolvedUser)) return resolvedUser;

    // Secondary location: sources/<id>/<id>.js (subfolder layout)
    const subPath = path.join(SOURCES_DIR, id, `${id}.js`);
    const resolvedSub = path.resolve(subPath);
    const inSourcesSub = resolvedSub.startsWith(path.resolve(SOURCES_DIR) + path.sep);
    if (inSourcesSub && fs.existsSync(resolvedSub)) return resolvedSub;

    if (IS_PKG) {
      // Bundled snapshot copy, flat or subfolder layout —
      // see resolveSnapPath() above.
      const snapPath = resolveSnapPath(id);
      if (snapPath) return snapPath;
    }

    // Fall back to the flat path so the caller gets a clear "not found" error
    // (or, for installSource(), a concrete write target) — but never a path
    // that escapes SOURCES_DIR, even if some future caller ever reached here
    // with an id that skipped safeId() validation upstream. Every current
    // caller already validates id via safeId() before this point, so this is
    // defense-in-depth, not a fix for a reachable bug today.
    if (!inSources) throw new Error(`Invalid source id: ${id}`);
    return resolvedUser;
  }

  function loadSourceFromFile(id, { allowSelfHeal = true } = {}) {
    if (sourceCache.has(id)) return sourceCache.get(id);

    const p = sourcePath(id);
    if (!fs.existsSync(p)) throw new Error(`Source not found: ${id}`);

    // Outside a packaged exe there's no snapshot-vs-disk split to work
    // around at all - a plain require() already resolves correctly,
    // subfolder layout or not. Inside one, p resolves inside SNAP_SOURCES_DIR
    // only when sourcePath() fell back to the bundled snapshot copy (no
    // on-disk override exists) - that case is already a normal,
    // already-working require(). Anything else is a real on-disk file
    // (dropped in, or seeded on first run) and needs its requires resolved
    // as if it lived in the snapshot.
    const inSnap = !IS_PKG || p.startsWith(path.resolve(SNAP_SOURCES_DIR) + path.sep);

    let mod;
    let loadedFrom = p;
    try {
      mod = inSnap ? requireFresh(p) : requireAsSnapshotModule(p, id);
    } catch (loadErr) {
      // Self-heal is meant to silently recover from EXTERNAL corruption of
      // an on-disk copy (confirmed antivirus deletions this project has hit
      // repeatedly) — desirable there. But when installSource() (in
      // server/modules/sources/lifecycle.js) writes a FRESH copy during a
      // reinstall/update and THAT fails to load, this same silent fallback
      // would instead mask a genuinely broken reinstall behind a silent
      // revert to the stale old version, with no error ever reaching the
      // user — so that specific call site opts out via allowSelfHeal: false.
      const snapPath = (IS_PKG && allowSelfHeal) ? resolveSnapPath(id) : null;
      if (snapPath && snapPath !== p) {
        mod = requireFresh(snapPath);
        loadedFrom = snapPath;
        try { fs.unlinkSync(p); } catch (_) {}
      } else {
        throw loadErr;
      }
    }

    if (!mod?.meta?.id) throw new Error('Invalid source: missing meta.id');
    if (typeof mod.search !== 'function') throw new Error('Source missing search()');
    if (typeof mod.mangaDetails !== 'function') throw new Error('Source missing mangaDetails()');
    if (typeof mod.chapters !== 'function') throw new Error('Source missing chapters()');
    if (typeof mod.pages !== 'function') throw new Error('Source missing pages()');

    sourceCache.set(id, mod);
    declareSourceUi(id, mod, loadedFrom);
    return mod;
  }

  // Registers what the source declared in meta.ui (sanitised, see common/source-ui.js) for the places that only know its
  // id. A Referer rule is held to the hosts the file's own text names; if the text cannot be read, none is accepted.
  function declareSourceUi(id, mod, filePath) {
    try {
      let knownHosts = new Set();
      try { knownHosts = collectHostsOutsideDeclaration(fs.readFileSync(filePath, 'utf8')); } catch (_) { /* no text, no Referer rules */ }
      const verdict = sourceUi.sanitizeSourceUi(mod.meta.ui, { knownHosts });
      sourceUi.registerSourceUi(id, verdict.ui);
      // A file put in the folder by hand gets no Check: say once what was left out of its declaration.
      if (verdict.problems.length > 0 && !declarationWarned.has(id)) {
        declarationWarned.add(id);
        console.warn(`[WARN] ${id}: parts of meta.ui were not used: ${verdict.problems.slice(0, 5).map((p) => p.message).join(' | ')}`);
      }
    } catch (_) {
      sourceUi.unregisterSourceUi(id);
    }
  }

  // Runs a candidate source file that is NOT in the live folder (the import tool's staging area), so a file that
  // fails to load never has to sit in SOURCES_DIR, where the scan would re-run it on every GET /api/state. Nothing is
  // cached: a candidate that is never installed leaves no trace in sourceCache or require.cache. `source` is the text
  // to run: the caller passes the text whose hash it verified, so what runs is exactly what was checked and not
  // whatever the file holds a moment later; without it the file is read. `id` is where the candidate pretends to live:
  // inside a packaged exe the fake snapshot location (see requireAsSnapshotModule), outside it the place it will be
  // installed at (SOURCES_DIR/<id>.js), so __filename, __dirname and its relative requires are the ones the installed
  // source will have. The caller has already validated the id and confined candidatePath.
  function loadCandidateFromFile(candidatePath, id, source) {
    const real = path.resolve(candidatePath);
    if (IS_PKG) return requireAsSnapshotModule(real, id, source);
    const src = typeof source === 'string' ? source : fs.readFileSync(real, 'utf8');
    return compileAsModule(path.join(SOURCES_DIR, `${id}.js`), src);
  }

  function clearSourceCache(id) {
    if (id !== undefined) { sourceCache.delete(id); sourceUi.unregisterSourceUi(id); }
    else { sourceCache.clear(); sourceUi.clearSourceUiRegistry(); }
  }

  function detectRepoKind(data) {
    if (data?.sources && Array.isArray(data.sources)) return 'jsrepo';
    if (Array.isArray(data)) return 'tachiyomi';
    if (data?.extensions && Array.isArray(data.extensions)) return 'tachiyomi';
    return 'unknown';
  }

  async function getRepoDataWithCache(repo, ttl = limits.repoCacheTtlMs) {
    const cached = reposCache.get(repo.url);
    if (cached && Date.now() - cached.time < ttl) return cached.data;

    if (repo.url.startsWith('localrepo:')) return { sources: [] };

    try {
      const data = await fetchJson(repo.url);
      reposCache.set(repo.url, { data, time: Date.now() });
      return data;
    } catch (e) {
      console.warn(`Failed to load repo ${repo.url}:`, e.message);
      return cached?.data || {};
    }
  }

  // Reads sources-repo/repo.json straight off disk — no HTTP fetch, no
  // isSafeUrl check, no network/GitHub dependency. Unlike getRepoDataWithCache
  // below, this deliberately has no TTL cache: the whole point of a builtin,
  // locally-edited catalog is that bumping a version here is reflected
  // immediately, not after a stale HTTP-fetch-style cache window expires.
  // A local fs.readFileSync is cheap enough that re-reading every call is fine.
  async function getBuiltinRepoData() {
    if (!BUILTIN_SOURCES_DIR) return { name: 'Official Extras', sources: [] };
    try {
      const raw = fs.readFileSync(path.join(BUILTIN_SOURCES_DIR, 'repo.json'), 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      console.warn('Failed to load builtin repo.json:', e.message);
      return { name: 'Official Extras', sources: [] };
    }
  }

  async function listAvailableSourcesFromRepos(repos) {
    const sources = [];

    const builtin = await getBuiltinRepoData();
    for (const s of builtin.sources || []) {
      if (s?.id && s?.name && s?.version && safeId(s.id)) {
        sources.push({
          kind: 'js',
          installable: true,
          repoUrl: 'builtin',
          repoName: builtin.name || 'Official Extras',
          id: s.id,
          name: s.name,
          version: s.version,
          author: s.author || '',
          icon: s.icon || '',
        });
      }
    }

    for (const repo of repos) {
      try {
        const data = await getRepoDataWithCache(repo);
        const kind = repo.kind || detectRepoKind(data);
        if (kind === 'jsrepo' && data.sources) {
          for (const s of data.sources) {
            if (s?.id && s?.name && s?.version && s?.codeUrl && safeId(s.id)) {
              sources.push({
                kind: 'js',
                installable: true,
                repoUrl: repo.url,
                repoName: repo.name,
                id: s.id,
                name: s.name,
                version: s.version,
                codeUrl: s.codeUrl,
                author: s.author || '',
                icon: s.icon || '',
              });
            }
          }
        }
      } catch (e) {
        console.warn(`Repo error ${repo.url}:`, e.message);
      }
    }
    return sources;
  }

  async function autoInstallLocalSources() {
    if (autoInstallInFlight) return autoInstallInFlight;
    autoInstallInFlight = (async () => {
    const store = await readStore();
    const seen = new Set();
    const allIds = [];

    const scanDir = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        const entryPath = path.join(dir, entry);
        // An entry listed a moment ago can be gone by now (an install's temporary file renamed into place, an
        // uninstall): skip it instead of failing the whole scan.
        let stat;
        try {
          stat = fs.statSync(entryPath);
        } catch (err) {
          if (err && err.code === 'ENOENT') continue;
          throw err;
        }

        if (stat.isFile() && entry.endsWith('.js')) {
          // Flat layout: sources/<id>.js
          const id = entry.replace('.js', '');
          if (!seen.has(id)) {
            seen.add(id);
            allIds.push(id);
          }
        } else if (stat.isDirectory()) {
          // Subfolder layout: sources/<id>/<id>.js
          // Only the canonical file (same name as the folder) is registered,
          // so helper modules inside the subfolder are not mistakenly treated
          // as independent sources.
          const canonical = path.join(entryPath, `${entry}.js`);
          if (fs.existsSync(canonical) && !seen.has(entry)) {
            seen.add(entry);
            allIds.push(entry);
          }
        }
      }
    };

    scanDir(SOURCES_DIR);
    if (IS_PKG) scanDir(SNAP_SOURCES_DIR);

    // A non-'repo' entry (registered by this same scan in a past run against
    // a different build/edition sharing this data folder — 'bundled', or no
    // installedVia at all for data older than that field) whose backing
    // file has since disappeared would otherwise stay listed forever —
    // uninstallById() only ever removes a 'repo'-installed source. Prune it
    // here instead, the same place that would have (re-)registered it.
    for (const id of Object.keys(store.installedSources)) {
      if (store.installedSources[id]?.installedVia !== 'repo' && !seen.has(id)) {
        delete store.installedSources[id];
      }
    }

    // Registers every file found (and notes which ones the command line imported: source-loader/local-register.js).
    await registerLocalSources({ store, ids: allIds, loadSourceFromFile, sourcePath, warn: (message) => console.warn(message) });

    await writeStore(store);
    })().finally(() => { autoInstallInFlight = null; });
    return autoInstallInFlight;
  }

  return {
    configure,
    sourcePath,
    builtinSourcePath: (id) => path.join(BUILTIN_SOURCES_DIR, `${id}.js`),
    loadSourceFromFile,
    loadCandidateFromFile,
    clearSourceCache,
    detectRepoKind,
    getRepoDataWithCache,
    listAvailableSourcesFromRepos,
    autoInstallLocalSources,
  };
}

module.exports = { createSourceLoaderCore };