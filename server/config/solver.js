'use strict';

const limits = require('./limits');

// Everything tunable about the FlareSolverr session pool and the settings that
// drive it. Values marked "tbm" (to be measured) are first guesses chosen so the
// code has a number; trying the pool against a real FlareSolverr replaces them
// with measured ones, so changing one here is the intended way to tune it. Every
// "unverified" note names what only a real FlareSolverr can show.

// FlareSolverr restarts itself after 20 idle minutes (flaresolverr-lifecycle.js),
// so the pool must close its sessions first: the idle bound stays below that.
const SETTINGS_BOUNDS = Object.freeze({
  solverSessionPoolSize: Object.freeze({ min: 1, max: 3 }),
  solverSessionIdleMinutes: Object.freeze({ min: 1, max: 15 }),
});

// The three settings keys of the feature, and the only ones the settings schema and
// POST /api/settings know about: any other key is an ordinary unknown key.
// solverSessionsEnabled: false, so an install that has never chosen runs as 3.1.2 did (the pool
// switched off, solver/passthrough.js). The pool itself was tried against a real FlareSolverr
// 3.5.2 (ComicHubFree and AnimePahe: a cold solve in a session takes about 12 s, the next calls
// about 0.3 s; the traps read from its source behave as read). Still unverified: that the System
// Health probes at startup survive its queue, which only a real run of the app shows. Once one
// does, ship it true (the one line to flip); until then it is a choice on the "Protected sites"
// card (the Settings > Network & Anti-Bot tab).
// solverSessionPoolSize: 2, so a System Health probe or an interactive read does not queue
// behind one long Cloudflare solve. Slots are opened lazily: an idle app holds no browser,
// an app that only asks for one site holds one, and the second appears when another site waits.
const SETTINGS_DEFAULTS = Object.freeze({
  solverSessionsEnabled: false,
  solverSessionPoolSize: 2,
  solverSessionIdleMinutes: 10,
});

const ENV_NAMES = Object.freeze({
  solverSessionsDisabled: 'SCROLLSCAPE_SOLVER_SESSIONS_DISABLED',
});

const DEFAULT_FLARESOLVERR_URL = 'http://127.0.0.1:8191/v1';

// The status page of a FlareSolverr is its root: the address kept in Settings ends in /v1,
// which only takes POST commands.
const solverStatusUrl = (solverUrl) => String(solverUrl).replace(/\/v1\/?$/, '/');

// The FlareSolverr version whose session semantics (sessions.*, what a recreated
// session loses) were read from source when the pool was designed. The System
// Health dependency row warns when the installed major.minor differs.
const FLARESOLVERR_VERIFIED_VERSION = '3.5.2';
const FLARESOLVERR_RELEASES_URL = 'https://api.github.com/repos/FlareSolverr/FlareSolverr/releases/latest';
// How long the dependency row waits for the running FlareSolverr to say its version. Shorter than the
// External Services row (8 s): the row only has a version to show when FlareSolverr is already up.
const SOLVER_VERSION_TIMEOUT_MS = 3_000;

const POOL = {
  // A navigation is aborted by FlareSolverr after requestMaxTimeoutMs; our own
  // abort sits requestAbortGraceMs behind it (40 s in total, as before the pool).
  requestMaxTimeoutMs: 35_000,
  requestAbortGraceMs: 5_000,
  sessionCreateTimeoutMs: 60_000,
  sessionListTimeoutMs: 8_000,
  sessionDestroyTimeoutMs: 15_000,
  blankResetMaxTimeoutMs: 10_000,
  // tbm: unverified until a real FlareSolverr shows how often a navigation that timed out is
  // followed by a blank page that answers (the stuck worker may still hold chromedriver)
  blankResetSettleMs: 400,
  // The page a session is parked on between two jobs; the second is the fallback for a
  // FlareSolverr that refuses about:blank. Seen live on 3.5.2: about:blank is accepted, answers
  // in 0.3 to 0.8 s and sets no cookie (the fallback has never been needed).
  blankUrls: Object.freeze(['about:blank', 'data:text/html,']),

  // Derived from the settings bounds so the card and the pool cannot disagree.
  defaultMaxSessions: SETTINGS_DEFAULTS.solverSessionPoolSize,
  maxSessionsMin: SETTINGS_BOUNDS.solverSessionPoolSize.min,
  maxSessionsCap: SETTINGS_BOUNDS.solverSessionPoolSize.max,
  defaultIdleMinutes: SETTINGS_DEFAULTS.solverSessionIdleMinutes,
  idleMinutesMin: SETTINGS_BOUNDS.solverSessionIdleMinutes.min,
  idleMinutesMax: SETTINGS_BOUNDS.solverSessionIdleMinutes.max,
  // Upper bound of the idle-check interval; the pool ticks every
  // min(idleTickMs, idleMs / 2).
  idleTickMs: 60_000,

  // tbm: unverified until a real FlareSolverr shows whether a popup or an extra tab survives a
  // blank page (Chrome process count and memory over many jobs on an ad-heavy page)
  maxSessionAgeMs: 3_600_000,
  maxSessionUses: 150,
  // sessions.list before a request is skipped when the last answer is this fresh.
  // Seen live on 3.5.2: sessions.list answers in 3 to 4 ms while a request is in flight on the
  // same driver, so it is cheap and safe; the 2 s itself is not tuned.
  verifySkipWithinMs: 2_000,
  // Every session id starts with this, which is how the orphan sweep tells ours
  // from anything else sitting in FlareSolverr.
  orphanIdPrefix: 'ss-',

  queue: {
    maxQueued: 24,
    // tbm: unverified until a real FlareSolverr shows what share of the protected-site probes at
    // startup is dropped as "busy" and how long a real request waits right after boot
    interactiveWaitMaxMs: limits.sourceCallTimeoutMs,
    backgroundWaitMaxMs: 15_000,
  },
  restartWaitMaxMs: 120_000,
  downAfterWedgeMs: 30_000,
  // How long shutdown() waits for the running jobs before it closes the sessions anyway.
  shutdownTimeoutMs: 5_000,
  circuit: { failures: 3, windowMs: 300_000, openMs: 300_000 },

  // Minimum gap between two navigations to the same site.
  // tbm: unverified until a real FlareSolverr shows the smallest gap (1000 / 1500 / 2000 ms)
  // with no Cloudflare block on the sites the app uses
  hostSpacingMs: 1_500,
  // After "Cloudflare has blocked this request": the site is left alone for
  // initialMs, doubling per consecutive block up to maxMs.
  // tbm: unverified until a real FlareSolverr shows how long a block really lasts
  blockCooldown: { initialMs: 60_000, maxMs: 300_000 },
  shellResolveRetries: 1,
  affinityWaitMs: 20_000,
  driverRetryMinBudgetMs: 10_000,
  launchRetryDelayMs: 2_000,

  // The call layer around the pool (solver-call.js): the plain request that tries a saved cookie
  // (the preflight of a waiting call, the retry of a proof-of-work page) and the wait before that retry.
  directFetchTimeoutMs: 15_000,
  powRetryDelayMs: 2_000,

  // The pool switched off sends every call straight to FlareSolverr, one stateless Chrome each (solver/passthrough.js).
  // Calls for the same page are already one call; this is how many DIFFERENT pages of one site may be in flight at once, so
  // that the way back to 3.1.2's behaviour cannot start twenty Chromes for twenty lookups (3.1.2's per-site lock allowed one,
  // by handing the first caller's page to the rest, which was the bug). The rest wait their turn, first come first served.
  passThroughSiteLimit: 2,

  // Numbers the pool's rules are built on, named here so the pool carries no bare literals.
  gatePruneAfterMs: 600_000,
  blankResetAbortGraceMs: 3_000,
  restartWatchdogGraceMs: 30_000,
  preflightMinBudgetMs: 3_000,
  boundSolveMarginMs: 1_000,
  boundSolveMinMs: 5_000,
  // Consecutive answers FlareSolverr gives that match no known class on one
  // session before it is recycled defensively; consecutive failed blank
  // resets, across sessions, before every job recycles after use instead.
  otherFailuresBeforeRecycle: 3,
  blankFailuresBeforeUnsupported: 3,

  // Lengths of what is shown or logged of something longer: the first line of a
  // FlareSolverr error a caller may see, the reason a restart gives in the log,
  // and how much of a proxy's hash is kept as its fingerprint. solverLineMaxChars is
  // how much of that first line is looked at before the address and path patterns run:
  // their cost grows with the square of a long unbroken run of characters.
  solverTextMaxChars: 160,
  solverLineMaxChars: 2048,
  logReasonMaxChars: 80,
  fingerprintHexChars: 8,
};

// How patient the callers that declare their patience are (solver-context.js): how long before
// its own timeout a caller stops queueing for the browser, so the pool drops the job from the
// queue and the caller's timeout does not fire first on a job that never started.
const CALLER_PATIENCE = Object.freeze({
  // The probes of System Health and of startup (sources and anime providers).
  probeGiveUpMarginMs: 1_000,
  // Cover search asks the browser first and falls back to a plain fetch: how long the browser gets,
  // and the margin before that. Measured 2026-11-01 on a real FlareSolverr 3.5.2: the Brave images page takes about 12 s when the
  // browser is cold and 7 s when it is warm (each search gets a browser of its own), and 8 s made every search give up just before the
  // page arrived, to fall back to a plain request that Brave refuses (429). coverTotalMs is what the whole search may take: /api answers
  // within 30 s, so the plain fallback only gets what is left of it.
  coverTryMs: 24_000,
  coverGiveUpMarginMs: 500,
  coverTotalMs: 27_000,
});

// Registrable-domain suffixes made of two labels: "foo.co.uk" is its own site,
// but taking the last two labels of every host would give all of them "co.uk".
// Not the public suffix list (GUIDELINES.md's "Dependencies": nothing new for a
// lookup this small): the countries a manga or anime site is likely to sit
// under, and the shared hosts where every tenant is a different site
// ("one.github.io" and "two.github.io" must never share cookies, spacing or a
// cooldown), which is all hostKeyOf() needs. A country-code pair that is NOT
// listed (co.th, com.pl, or.id, com.eg) is still a suffix: host-utils.js
// recognises its shape, so this list is only what the shape cannot say, the
// shared hosts, and the countries written out for the reader.
const TWO_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'ltd.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au',
  'co.nz', 'org.nz', 'net.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp',
  'com.br', 'net.br', 'org.br',
  'co.kr', 'or.kr',
  'com.cn', 'net.cn', 'org.cn',
  'com.tw', 'com.hk', 'com.sg', 'com.my', 'com.ph', 'com.vn',
  'com.mx', 'com.ar', 'com.tr', 'com.ua',
  'co.za', 'co.in', 'co.id', 'co.il',
  'github.io', 'pages.dev', 'vercel.app', 'workers.dev', 'netlify.app',
  'blogspot.com', 'herokuapp.com', 'web.app', 'firebaseapp.com',
]);

// User-facing texts of the pool, one per outcome. Each is asserted against the
// real classifySourceError (solver-pool-classify.test.js, which loops over every
// entry): they avoid the substrings that steer it into the wrong bucket ("api",
// "http 500", "maintenance", "temporarily unavailable") and never name a host.
// The proxy text says "the proxy" and no more: the only one the browser can be
// pointed at today is the one in Settings, so naming a kind would be wrong.
// An entry that is a function is a template for the one value only the caller has
// (the site, FlareSolverr's own wording, an HTTP status). The navigation text names
// the site on purpose: that is its wording from before the pool.
const BROWSER_RESTARTED = 'This site is protected by Cloudflare and the browser solver had to restart its browser. Try again in a moment.';

const MESSAGES = Object.freeze({
  blocked: 'Cloudflare blocked the browser solver for this site; cooling down before the next try.',
  hostCooldown: 'This site is rate-limited, cooling down before the next try.',
  // A site that keeps leaving the solver without an answer (solver/wedge-memory.js); no site is named, and the others are why it waits.
  sitePaused: 'The browser solver kept stalling on this site, so it is rate-limited for a while to keep the other protected sites working.',
  timeout: 'The browser solver timed out loading this page.',
  driver: BROWSER_RESTARTED,
  launch: BROWSER_RESTARTED,
  proxy: 'Cloudflare solver: the proxy was not reachable.',
  busy: 'This site is protected by Cloudflare and the browser solver is busy. Try again in a moment.',
  // A local state the pool is in. A caller sees these as they are: FlareSolverr is switched on, it is
  // only restarting or not answering, which "not reachable" below would deny.
  restarting: 'This site is protected by Cloudflare and the browser solver is restarting. Try again in a moment.',
  down: 'This site is protected by Cloudflare and the browser solver is not answering. Try again in a moment.',
  shuttingDown: 'The browser solver is shutting down.',
  sessionNotReady: 'The browser session was not ready.',
  // The proxy in Settings could not be read, so the job was not sent: running it without the proxy
  // would send the user out on their own address.
  proxyUnreadable: 'This site is protected by Cloudflare and the proxy setting could not be read, so the browser solver was not used. Try again in a moment.',
  // What a source's user sees when a Cloudflare-protected site has to be solved but FlareSolverr cannot be
  // reached (switched off by choice, not installed, not up yet). Node's own wording for a refused connection
  // is just "fetch failed", which says nothing about the site, Cloudflare or FlareSolverr, and lands in System
  // Health as an unexplained "Unknown error" instead of the Cloudflare/challenge bucket it really is.
  //  - "Cloudflare" stays in the wording on purpose: it is what the error classifier
  //    (config/system-health.js) recognises.
  //  - The host name is NOT in it: the classifier matches substrings of the whole text and tries
  //    the "api" bucket first, so a host such as api.example.com would be filed as an API error.
  unreachable: 'This site is protected by Cloudflare and FlareSolverr is not reachable (it is switched off, not installed, or still starting). Turn FlareSolverr on to use this source.',
  // Templates. `site` is the page's host without www, or null when the URL is unreadable;
  // `detail` is FlareSolverr's own first line, addresses and paths removed (describeSolverMessage); `status`
  // is the HTTP status of an answer that carried no usable JSON.
  navigation: (site) => `${site || 'This site'} unavailable (server unreachable). Try again in a moment.`,
  other: (detail) => `FlareSolverr failed: ${detail}`,
  http: (status) => `FlareSolverr HTTP ${status}`,
});

// How often the app may restart FlareSolverr by itself when it stops answering (flaresolverr-restart-brake.js).
const RECOVERY_BRAKE = Object.freeze({ maxPerWindow: 3, windowMs: 900_000, minGapMs: 30_000 });

// A site whose request leaves FlareSolverr without an answer (it is wedged) `after` times within windowMs is left alone for pauseMs
// (solver/wedge-memory.js): every wedge costs a restart of the browser and of every other protected source with it. A stall within
// collateralMs of another site's is the same wedge seen from a second caller and is not counted against the second site.
// tbm: unverified until a real FlareSolverr shows how long a site that wedges it stays that way
const WEDGE_PAUSE = Object.freeze({ after: 2, windowMs: 1_800_000, pauseMs: 1_200_000, collateralMs: 60_000 });

module.exports = {
  POOL,
  RECOVERY_BRAKE,
  WEDGE_PAUSE,
  SETTINGS_DEFAULTS,
  SETTINGS_BOUNDS,
  ENV_NAMES,
  DEFAULT_FLARESOLVERR_URL,
  solverStatusUrl,
  FLARESOLVERR_VERIFIED_VERSION,
  FLARESOLVERR_RELEASES_URL,
  SOLVER_VERSION_TIMEOUT_MS,
  CALLER_PATIENCE,
  TWO_LEVEL_SUFFIXES,
  MESSAGES,
};
