/**
 * server.js — ScrollScape application entry point (thin orchestrator)
 *
 * This file is intentionally kept small.  All business logic lives in the
 * modules under server/:
 *
 *   server/helpers.js              — safeId, safeManga, isSafeUrl, fetch helpers
 *   server/store.js                — in-memory store + debounced disk persistence
 *   server/sourceLoader.js         — source module loading, caching, and seeding
 *   server/middleware/security.js  — security headers + IP-based rate limiter
 *   server/routes/proxy.js         — image proxy (/api/proxy-image)
 *   server/routes/repos.js         — repository management (/api/repos, /api/state)
 *   server/routes/sources.js       — source install/uninstall + generic dispatcher
 *   server/routes/local.js         — local manga (CBZ/CBR/ZIP/PDF/EPUB) import + reader
 *   server/routes/library.js       — favorites, history, reading status
 *   server/routes/downloads.js     — CBZ chapter/bulk downloads
 *   server/routes/reviews.js       — per-manga user reviews and ratings
 *   server/routes/lists.js         — custom manga lists
 *   server/routes/analytics.js     — reading analytics aggregation
 *   server/routes/achievements.js  — achievement unlock/query
 *   server/routes/mangaupdates.js  — MangaUpdates metadata lookup
 *
 * Platform support:
 *   • Windows:  standalone exe (pkg) or `node server.js`
 *   • Linux:    `node server.js`, Docker (see docker/), or Termux on Android
 *   • macOS:    `node server.js`
 *   • Android:  Termux — `node server.js`
 *
 * The only OS-specific code path is openBrowser(), which dispatches to the
 * correct system command for each platform.  All other logic is cross-platform.
 */

'use strict';

const express     = require('express');
const compression = require('compression');
const multer      = require('multer');
const path        = require('path');
const fs          = require('fs');
const fsp         = fs.promises;

// Before anything else asks the network for anything: a failed fetch says why ("fetch failed (ETIMEDOUT)"), see server/modules/network/fetch-cause.js.
require('./server/modules/network/fetch-cause').installFetchCause();
// And a busy network no longer fails a call by giving each address of a site only 250 ms: see server/modules/network/connect-patience.js.
require('./server/modules/network/connect-patience').raiseConnectPatience();

// ── Path constants ────────────────────────────────────────────────────────────
// When bundled as an exe via pkg, __dirname is the read-only snapshot root.
// User-writable data (store, cache, downloads) sits next to the exe, inside a
// "ScrollScape" folder unless the exe already lives in one (see app-root.js).
// getAppRoot() throws when SCROLLSCAPE_HOME is unusable or two libraries compete;
// resolveUserRootOrExit says so plainly and stops instead of starting an empty
// library somewhere else.
const { resolveUserRootOrExit, guardSingleInstance, exitWithMessage } = require('./server/modules/common/startup-guard');
const IS_PKG           = typeof process.pkg !== 'undefined';
const USER_ROOT        = IS_PKG
  ? resolveUserRootOrExit({ getAppRoot: () => require('./server/modules/common/app-root').getAppRoot() })
  : __dirname;
const DATA_DIR         = path.join(USER_ROOT, 'data');
// User-writable sources — drop/replace .js files here without rebuilding.
const SOURCES_DIR      = path.join(DATA_DIR, 'sources');
// Bundled snapshot sources — read-only, seeded into SOURCES_DIR on first run.
const SNAP_SOURCES_DIR = path.join(__dirname, 'data', 'sources');
// ScrollScape's own self-served install catalog (Settings → Source
// Repositories → "Official Extras") — read directly off disk, never fetched
// over HTTP, so it works with no GitHub/network dependency at all.
const BUILTIN_SOURCES_DIR = path.join(__dirname, 'sources-repo');
const STORE_PATH       = path.join(DATA_DIR, 'store.json');
const CACHE_DIR        = path.join(DATA_DIR, 'cache');
const LOCAL_DIR        = path.join(USER_ROOT, 'Local');
const TMP_DIR          = path.join(DATA_DIR, 'tmp');
const THEME_PRESETS_DIR = path.join(DATA_DIR, 'theme-presets');
// Source files the import tool has checked but not installed. Must sit as deep as data/sources/: a source's relative
// requires ('../../server/modules/...') are resolved from where the file really is.
const SOURCE_STAGING_DIR = path.join(DATA_DIR, 'source-staging');
// The anime sources the person imported (and where a checked file waits): beside data/sources, so a source's relative requires reach the same place.
const ANIME_SOURCES_DIR = path.join(DATA_DIR, 'anime-sources');
const ANIME_STAGING_DIR = path.join(DATA_DIR, 'anime-source-staging');
const PORT             = process.env.PORT || 4000;

// ── Configure submodules ─────────────────────────────────────────────────────
// Modules must be configured with path constants BEFORE routes are registered.

// Required before store.js: its SIGINT/SIGTERM handler calls process.exit()
// synchronously, which cuts off any listener registered after it. Discord
// RPC's own best-effort shutdown-clear (see its init()) needs to be queued
// ahead of that, not behind it — see service.js's "LESSON 3" comment.
const discordRpcService = require('./server/modules/discord-rpc/service');
discordRpcService.init();

const storeModule = require('./server/store');
storeModule.configure(STORE_PATH);

// What a source file can reach in this process. Sources are loaded in-process and cannot require server/ (a packaged exe keeps data/sources outside its
// snapshot), and the app's own HTTP settings route refuses a call with no login once an Access Password is set, so a source that needs a saved setting
// (the Suwayomi address and login) reads it from here instead.
// The saved switch "Allow installing sources from other devices" (middleware/local-only.js, requireThisComputer).
require('./server/middleware/local-only').configureRemoteImportSetting(async () => {
  const store = await storeModule.readStore();
  return !!(store && store.settings && store.settings.allowRemoteImport === true);
});

globalThis.ScrollScapeHost = Object.freeze({
  readSettings: async () => {
    const store = await storeModule.readStore();
    return (store && store.settings) || {};
  },
});

// Automatic copies of store.json (one a day, and one before something replaces much of the library at once): data/backups/.
// The reading progress (chapters read, where each manga was left): its own file, so the store is not rewritten whole at every page.
const PROGRESS_PATH = path.join(DATA_DIR, 'reading-progress.json');
const progressRoutes = require('./server/routes/progress');
const progressService = progressRoutes.configure({ filePath: PROGRESS_PATH });

// The local copy of the library's covers (data/covers). It fetches through the image proxy, so a host's own rules (User-Agent, Referer, FlareSolverr) are met.
const coverService = require('./server/routes/covers').configure({
  dir: path.join(DATA_DIR, 'covers'),
  readStore: storeModule.readStore,
  fetchImage: require('./server/modules/proxy/service').createProxyService({ isSafeUrl: require('./server/helpers').isSafeUrl }).fetchProxyImage,
});
storeModule.onWrite(() => coverService.scheduleReconcile());

const autoBackup = require('./server/modules/store/auto-backup');
autoBackup.configure({
  storePath: STORE_PATH,
  backupDir: path.join(DATA_DIR, 'backups'),
  flush: () => storeModule.flushNow(),
  extraFiles: [{ path: PROGRESS_PATH, prefix: 'progress', flush: () => progressService.flushSync() }],
});

const errorLogger = require('./server/modules/error-logger');
const { resolveListenHost, isLoopbackHost } = require('./server/modules/http/listen-host');
errorLogger.configure(DATA_DIR);

const limits = require('./server/config/limits');

const sourceLoader = require('./server/sourceLoader');
sourceLoader.configure({ sourcesDir: SOURCES_DIR, snapSourcesDir: SNAP_SOURCES_DIR, builtinSourcesDir: BUILTIN_SOURCES_DIR, isPkg: IS_PKG });

const localRoutes = require('./server/routes/local');
const upload = multer({ dest: TMP_DIR, limits: { fileSize: limits.maxUploadSizeBytes } });
localRoutes.configure({ localDir: LOCAL_DIR, upload });

const opdsRoutes = require('./server/routes/opds');
opdsRoutes.configure({ localDir: LOCAL_DIR });

const mihonImportRoutes = require('./server/routes/mihon-import');
mihonImportRoutes.configure({ upload });

const animeRoutes = require('./server/routes/anime');
animeRoutes.configure({ upload });

const themePresetRoutes = require('./server/routes/theme-presets');
themePresetRoutes.configure({ presetsDir: THEME_PRESETS_DIR });

require('./server/routes/source-import').configure({ stagingDir: SOURCE_STAGING_DIR, denylistFile: path.join(DATA_DIR, 'site-denylist.txt') });
require('./server/routes/source-catalog').configure({ cacheDir: CACHE_DIR, denylistFile: path.join(DATA_DIR, 'site-denylist.txt') });
// The Suwayomi folder of the Windows setup script sits inside the folder that holds the library.
require('./server/routes/suwayomi').configure({ userRoot: USER_ROOT });
require('./server/routes/anime-source-import').configure({ stagingDir: ANIME_STAGING_DIR, sourcesDir: ANIME_SOURCES_DIR, loadCandidate: sourceLoader.loadCandidateFromFile });

const comicVineService = require('./server/modules/comicvine/service');
comicVineService.configure({ cacheFilePath: path.join(CACHE_DIR, 'comicvine.json') });

const leagueOfComicGeeksService = require('./server/modules/leagueofcomicgeeks/service');
leagueOfComicGeeksService.configure({ cacheFilePath: path.join(CACHE_DIR, 'leagueofcomicgeeks.json') });

require('./server/modules/cover-search').configure({ cacheDir: CACHE_DIR, searchSpacingMs: limits.coverSearchSpacingMs });

// achievements.json is a bundled, read-only catalog, not user data — resolve
// it the same __dirname-relative way SNAP_SOURCES_DIR resolves data/sources/,
// so it keeps working from inside a packaged .exe's read-only snapshot.
const achievementsRoutes = require('./server/routes/achievements');
achievementsRoutes.configure({ achievementsJsonPath: path.join(__dirname, 'data', 'achievements.json') });

// ── Express application ──────────────────────────────────────────────────────
// Decided here, once: the host guard below needs to know whether the server is
// reachable from this computer only, and listen() in the bootstrap must bind the
// very same value.
const LISTEN_HOST   = resolveListenHost({ isPkg: IS_PKG, fallback: '0.0.0.0' });
const LOOPBACK_ONLY = isLoopbackHost(LISTEN_HOST);

// Created before the app (rather than next to the /api gate) because the host
// guard is the first middleware and asks it whether an Access Password is set.
const { createAuthService } = require('./server/modules/auth/service');
const authService = createAuthService({ readStore: storeModule.readStore, writeStore: storeModule.writeStore });

const app = express();
// While bound to loopback with no Access Password, refuse any request that does
// not come from this computer's own browser/tools: a foreign Host header (DNS
// rebinding, a relay) or a cross-site browser request. First in the chain on
// purpose, so no route, static file or parser sees such a request. The password
// is read per request because it can be set or removed while the server runs.
const { createLocalHostGuard } = require('./server/middleware/local-only');
app.use(createLocalHostGuard({
  loopbackOnly: LOOPBACK_ONLY,
  isPasswordSet: () => authService.isGateEnabled(),
}));
app.use(compression());                   // gzip all responses
app.use(express.json({ limit: limits.jsonBodyLimit })); // parse JSON bodies

// Resource monitor (CPU/RAM/network footprint of this process, for the
// terminal dashboard) — attached this early so its middleware sees every
// request, including ones a later route rejects or rate-limits. The route
// that actually exposes getSnapshot() lives in server/routes/system-health.js,
// alongside the rest of the diagnostic API.
const { createResourceMonitor } = require('./server/modules/system-health/resource-monitor');
const resourceMonitor = createResourceMonitor();
app.use(resourceMonitor.middleware);
require('./server/routes/system-health').configure({ getResourceSnapshot: resourceMonitor.getSnapshot });

// ── Security middleware ───────────────────────────────────────────────────────
const { applySecurityHeaders, rateLimiter, apiTimeout } = require('./server/middleware/security');
applySecurityHeaders(app);
// Rate-limit API endpoints: configured in limits.js
// Static assets are excluded so the UI loads without restriction.
app.use('/api', rateLimiter(limits.apiRateLimitWindowMs, limits.apiRateLimitMaxRequests));
app.use('/api', apiTimeout(limits.sourceCallTimeoutMs || 30000));
// /opds/* sits outside /api (see server/routes/opds.js) specifically so a
// slow chapter-zip request isn't cut off by apiTimeout — but that also means
// it skips the /api rate limiter above. /opds/download in particular builds
// a real CBZ (or fetches N page images from an external source) per request,
// so it gets its own, stricter limit rather than being left uncapped.
app.use('/opds/download', rateLimiter(60_000, 20));

// Optional single-password gate — off by default (see
// server/modules/auth/service.js). Only guards /api/*; static assets stay
// reachable so the SPA shell can load and render its own login screen.
const { createAuthGate } = require('./server/middleware/auth-gate');
app.use('/api', createAuthGate(authService));

// ── Route registration ────────────────────────────────────────────────────────
// ORDER MATTERS:
//  • /api/source/local/* (virtual source) must be registered BEFORE the
//    generic /api/source/:id/:method handler or the "local" ID matches the
//    generic pattern and is passed to loadSourceFromFile, which throws.
//  • Static files are always last so they never shadow API routes.
const { registerAppRoutes } = require('./server/routes/bootstrap');

registerAppRoutes(app);

// ── Reader wallpapers: list GIF/WebP files from public/ ──────────────────────
app.get('/api/reader-wallpapers', (_req, res) => {
  const publicDir = path.join(__dirname, 'public');
  try {
    const files = require('fs').readdirSync(publicDir)
      .filter(f => /\.(gif|webp|mp4)$/i.test(f))
      .sort();
    res.json({ files });
  } catch {
    res.json({ files: [] });
  }
});

// ── Static file serving ───────────────────────────────────────────────────────

// Which edition this is: the page reads it before anything else (public/index.html), to know the defaults of a person who has set nothing yet.
app.get('/edition.js', (_req, res) => {
  const edition = require('./server/config/edition');
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(edition.editionScript(edition));
});

// Lets another ScrollScape instance add this one as a normal custom repo
// (POST /api/repos with this URL) — not used by this instance's own
// "Official Extras" catalog, which reads BUILTIN_SOURCES_DIR straight off
// disk instead of round-tripping through HTTP.
app.use('/sources-repo', express.static(BUILTIN_SOURCES_DIR));

app.use('/', express.static(path.join(__dirname, 'public'), {
  maxAge:       process.env.NODE_ENV === 'production' ? '7d' : 0,
  etag:         true,
  lastModified: true,
  setHeaders(res, filePath) {
    // CSS/JS/HTML: always revalidate so clients pick up updates immediately.
    if (/\.(css|js|html)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  },
}));

// ── SPA client-routing fallback ───────────────────────────────────────────────
// URLs like /manga/:sourceId/:id/:slug or /library are handled entirely
// client-side (see public/modules/router.js). Serve the app shell for any
// GET request that isn't an API call or an actual static file, so deep links
// and page refreshes on those routes work instead of 404ing.
// Express 5's router (path-to-regexp v8) requires a named wildcard —
// bare '*' throws at route-registration time. /{*splat} (braced = optional)
// matches every path including the bare root, same as '*' did in Express 4.
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (/\.[a-zA-Z0-9]+$/.test(req.path)) return next(); // real file requests (css/js/img/...) 404 normally
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Startup helpers ───────────────────────────────────────────────────────────

/**
 * Creates required directories and initialises a blank store.json if absent.
 */
async function ensureDirs() {
  const oldLocalDir = path.join(DATA_DIR, 'local');
  if (fs.existsSync(oldLocalDir) && !fs.existsSync(LOCAL_DIR)) {
    try {
      await fsp.rename(oldLocalDir, LOCAL_DIR);
    } catch(e) {
      console.log("Migration warning (old local dir to Local):", e.message);
    }
  }

  for (const dir of [DATA_DIR, SOURCES_DIR, CACHE_DIR, LOCAL_DIR, TMP_DIR, THEME_PRESETS_DIR]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  // Bundled sources are loaded directly from the pkg snapshot; no seeding needed.
  // Exclusive create: if the file appears (or exists but could not be stat'ed a moment ago) this can
  // never truncate a real library. EEXIST just means "already there".
  await fsp.writeFile(
    STORE_PATH,
    JSON.stringify({ repos: [], installedSources: {}, history: [], favorites: [] }, null, 2),
    { encoding: 'utf8', flag: 'wx' },
  ).catch((err) => { if (err.code !== 'EEXIST') throw err; });
}

/**
 * Opens the application URL in the OS default browser.
 * Supports Windows, macOS, Linux, and Android (Termux / xdg-open).
 *
 * @param {string} url
 */
function openBrowser(url) {
  // On Windows this opens its own Chrome/Edge application window (like
  // Launch-ScrollScape.bat) instead of a tab in the default browser; see
  // server/modules/common/app-window.js. SCROLLSCAPE_BROWSER_WINDOW=tab keeps a tab.
  require('./server/modules/common/app-window').openUrl(url);
}

/**
 * Convenience for a machine that already has Python plus the dashboard's own
 * deps installed (tools/dashboard/README.md) — mirrors Launch-ScrollScape.bat's
 * own "D" menu option (same py→python fallback, same "import textual, httpx"
 * check), but from the standalone .exe directly instead of needing the .bat.
 * Deliberately silent on any failure: this is a nice-to-have for a dev machine,
 * never something most people running a downloaded .exe would have, and they
 * should never see so much as an error window for it.
 *
 * The dashboard is a separate Python script — pkg bundles it as a readable
 * asset, but Python can't read a file out of pkg's snapshot, so it's seeded
 * to a real file next to the exe first (cheap, tiny files, every launch).
 */
function tryOpenDashboard(port) {
  const { execFile, exec } = require('child_process');
  const tryCmd = (cmd, next) => execFile(cmd, ['--version'], { timeout: 5000 }, (err) => (err ? next() : useCmd(cmd)));

  function useCmd(pyCmd) {
    execFile(pyCmd, ['-c', 'import textual, httpx'], { timeout: 5000 }, (err) => {
      if (err) return; // deps missing - same silent skip as no Python at all

      let dashboardScript;
      try {
        const dashDir = path.join(USER_ROOT, 'tools', 'dashboard');
        fs.mkdirSync(dashDir, { recursive: true });
        const snapDashDir = path.join(__dirname, 'tools', 'dashboard');
        fs.copyFileSync(path.join(snapDashDir, 'dashboard.py'), path.join(dashDir, 'dashboard.py'));
        fs.copyFileSync(path.join(snapDashDir, 'requirements.txt'), path.join(dashDir, 'requirements.txt'));
        dashboardScript = path.join(dashDir, 'dashboard.py');
      } catch (_) {
        return;
      }

      if (process.platform === 'win32') {
        exec(`start "ScrollScape Dashboard" "${pyCmd}" "${dashboardScript}" --url http://localhost:${port}`, () => {});
      } else {
        const child = require('child_process').spawn(pyCmd, [dashboardScript, '--url', `http://localhost:${port}`], { detached: true, stdio: 'ignore' });
        child.unref();
        child.on('error', () => {});
      }
    });
  }

  tryCmd('py', () => tryCmd('python', () => {}));
}

/**
 * Fires one throwaway request to AniList in the background so its
 * connection isn't cold the first time a real feature needs it (e.g. the
 * cover picker's "Search other sources", which queries AniList directly).
 * The equivalent warm-up for each installed manga/comic source already
 * happens as a side effect of the startup health check below, which calls
 * search()/healthCheck() on every one of them — AniList isn't one of those
 * "sources" (it's a separate proxied API), so it needs its own nudge.
 * Errors are swallowed: this is purely a latency optimization, never
 * something that should affect startup or be treated as a real failure.
 */
function warmupAniListConnection() {
  const { createProxyService } = require('./server/modules/proxy/service');
  const { isSafeUrl } = require('./server/helpers');
  const proxyService = createProxyService({ isSafeUrl });
  proxyService
    .proxyAniList({ query: '{ Page(page: 1, perPage: 1) { media(type: MANGA) { id } } }' })
    .catch(() => {});
}

// ── Bootstrap sequence ────────────────────────────────────────────────────────
const { systemHealthService } = require('./server/routes/system-health');
const { startFlaresolverrIdleWatcher, ensureFlaresolverrRunning, resolveFlaresolverrChoice } = require('./server/modules/network/flaresolverr-lifecycle');
startFlaresolverrIdleWatcher();
// The FlareSolverr session pool (built by fetch-utils) starts switched off, exactly as the app
// behaved before it existed; the settings below turn it on.
const { getSolverPool, getFlaresolverrUrl } = require('./server/modules/network/fetch-utils');
const { applySolverSettings, sweepSolverOrphans } = require('./server/modules/network/solver-wiring');

// Settles once ensureFlaresolverrRunning() has finished (or immediately when it does not run).
let flaresolverrReady = Promise.resolve();

Promise.resolve()
  .then(() => guardSingleInstance({
    isPkg: IS_PKG,
    userRoot: USER_ROOT,
    acquireInstanceLock: require('./server/modules/common/app-root').acquireInstanceLock,
  }))
  .then(() => ensureDirs())
  .then(() => storeModule.initStore())
  // First interactive launch only: ask whether to set FlareSolverr up, before
  // the rest of boot starts printing. A failure here must never stop the server.
  .then(() => resolveFlaresolverrChoice().catch((err) => console.warn(`[FlareSolverr] Could not ask about FlareSolverr: ${err.message}`)))
  // Fire-and-forget, same reasoning as logStartupHealth() below - self-heals a
  // FlareSolverr that failed to come up (see ensureFlaresolverrRunning's own
  // comment) without delaying the rest of boot on the ~15s worst case where it
  // actually has to relaunch it.
  .then(() => { flaresolverrReady = ensureFlaresolverrRunning().catch(() => {}); })
  .then(() => storeModule.readStore())
  .then((store) => {
    discordRpcService.applySettings(store.settings || {});
    // Nothing is queued, spaced or opened by the pool until it is told it is wanted.
    applySolverSettings(getSolverPool(), store.settings || {}, process.env);
  })
  .then(() => sourceLoader.autoInstallLocalSources())
  // The Suwayomi-Server this app set up on this computer, if there is one: started in the background (it takes a minute), never awaited.
  .then(() => { require('./server/routes/suwayomi').autoStartLocal(); })
  // Fire-and-forget: log system health at startup without blocking the server.
  // (this also exercises search()/healthCheck() on every installed source,
  // which doubles as the warm-up described above for those sources.)
  // Not returned from this step on purpose: it used to be, which made listen() wait for every
  // source probe (15 s and more with Cloudflare-protected sources) and contradicted the comment
  // above. It starts once FlareSolverr has had its chance to come up, so the log does not report
  // "unreachable" for a copy that is a few seconds from being ready.
  .then(() => {
    flaresolverrReady
      // Closes the browser sessions a previous run left in FlareSolverr, so their Chrome is gone
      // before the probes start new ones. It never rejects and sends nothing while the pool is off.
      .then(() => sweepSolverOrphans(getSolverPool(), getFlaresolverrUrl))
      .then(() => systemHealthService.logStartupHealth())
      .catch(() => {});
  })
  .then(() => warmupAniListConnection())
  .then(() => {
    // Standalone exe: bind only to loopback — never reachable from outside.
    // Docker / Termux / server: bind to all interfaces for port-mapping.
    // HOST overrides either default: HOST=127.0.0.1 keeps a dev/Docker run
    // private to this computer (what you want on a café or office network),
    // HOST=0.0.0.0 lets other devices on the network open it.
    const host = LISTEN_HOST;
    const loopbackOnly = LOOPBACK_ONLY;
    const maxPortAttempts = 20;

    function startServer(port, attempt = 0) {
      const server = app.listen(port, host, () => {
        console.log(`[OK] ScrollScape running on http://localhost:${port}`);
        console.log(loopbackOnly
          ? `[OK] Listening on ${host} - reachable from this computer only.`
          : `[OK] Listening on ${host} - reachable from other devices on this network (set HOST=127.0.0.1 to keep it private).`);
        console.log(`[OK] Sources auto-installed!`);
        autoBackup.start();
        coverService.start();
        if (IS_PKG) {
          openBrowser(`http://localhost:${port}`);
          tryOpenDashboard(port);
        }
      });

      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempt < maxPortAttempts) {
          const nextPort = port + 1;
          console.log(`Port ${port} in use, trying ${nextPort}...`);
          startServer(nextPort, attempt + 1);
        } else {
          const msg = err.code === 'EADDRINUSE'
            ? `Could not find a free port in range ${PORT}–${PORT + maxPortAttempts}.`
            : `Server error: ${err.message}`;
          console.error(msg);
          process.exit(1);
        }
      });
    }

    startServer(Number(PORT));
  })
  .catch(e => {
    // exitWithMessage keeps a double-clicked exe's window open long enough to read why it stopped
    // (an unreadable or corrupt store.json names the file and the copy it kept).
    exitWithMessage(`Fatal startup error: ${e.message}`);
  });
