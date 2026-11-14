'use strict';

/**
 * Discord Rich Presence — server-side RPC client lifecycle.
 *
 * WHY THIS LIVES ON THE SERVER, NOT THE FRONTEND
 * ------------------------------------------------
 * Discord's Rich Presence protocol talks over a local IPC channel — a named
 * pipe on Windows (\\?\pipe\discord-ipc-0..9), a Unix domain socket on
 * macOS/Linux — that only the Discord desktop client listens on. A browser
 * tab has no raw socket/pipe access (sandboxing sees to that), so nothing
 * under public/modules/ could ever open this connection directly. This
 * server process can, and since ScrollScape is meant to be launched locally
 * alongside the user's own Discord client (README's Quick Start /
 * Launch-ScrollScape.bat), "same machine" is the only case this needs to
 * support — a headless/Docker/remote deployment simply has no Discord
 * client on the other end of that pipe, and this module has to fail
 * silently in that case rather than hang or throw into the request path.
 *
 * LIBRARY CHOICE
 * ------------------------------------------------
 * `@xhayper/discord-rpc` — an actively maintained fork of the archived
 * `discordjs/RPC` (which itself replaced Discord's own now-unmaintained
 * `discord-rpc` npm package). At the time this was written: v1.3.4,
 * published within the last few months, Node >=20 (this project already
 * bundles Node 20), TypeScript source with real .d.ts typings. Confirmed
 * via its actual installed source (node_modules/@xhayper/discord-rpc/dist)
 * rather than assumed from docs — see the two lessons below, both found by
 * reading dist/structures/ClientUser.js and dist/transport/IPC.js directly.
 *
 * LESSON 1 — image assets: largeImageUrl/smallImageUrl are real, and that's
 * what makes "Crunchyroll-style" presence possible at all.
 * Discord's classic RPC asset model only supports `largeImageKey`/
 * `smallImageKey` referencing an asset pre-uploaded through the Developer
 * Portal — fine for a fixed app icon, useless for "this specific manga's
 * cover," which is a different image per title and can't be pre-uploaded.
 * `@xhayper/discord-rpc`'s SetActivity type also exposes `largeImageUrl`/
 * `smallImageUrl`, which ClientUser.setActivity() maps straight onto
 * `assets.large_url`/`assets.small_url` in the wire payload — an
 * undocumented-but-real RPC field Discord added specifically so apps can
 * point Rich Presence at an arbitrary externally-hosted image with no
 * upload step. That's what makes largeImageUrl = the manga/anime's own
 * cover URL work here.
 *
 * The catch: Rich Presence isn't only rendered by the local Discord client
 * — it's broadcast to the user's friends' clients (desktop/mobile) too, and
 * those fetch the image from wherever the URL points, not from this
 * machine. A cover URL from a manga/anime source or AniList's CDN is a
 * real public HTTPS image, so it works everywhere. This server's own
 * `http://localhost:PORT/...` would NOT — it's only reachable from this
 * machine, so a friend's client trying to render it would just get a
 * broken image. That's the reason the small badge icon (see setPresence
 * below) uses `smallImageKey` (a pre-uploaded Developer Portal asset, or
 * nothing) instead of trying to serve one from this server.
 *
 * LESSON 2 — activity.type: left at the library default (Playing, type 0)
 * on purpose. Discord's RPC has historically restricted third-party apps
 * to type 0 — the Watching/Listening/Competing types are reserved for a
 * short first-party allowlist (Spotify gets Listening, YouTube gets
 * Watching, etc.); a normal registered app requesting them can get silently
 * coerced back to Playing or rejected outright. "Reading"/"Watching" as a
 * *label* is written directly into the `details` text field instead (see
 * setPresence), which sidesteps the whole restriction — the header line
 * Discord actually bolds above `details`/`state` is the registered
 * application's own name from the Developer Portal, exactly like Crunchyroll
 * or any other RPC integration.
 *
 * LESSON 3 — nothing clears presence on its own when this dies.
 * It's tempting to assume Discord notices the IPC socket close (process
 * exited, crashed, force-killed) and clears the stale presence for you.
 * It doesn't, reliably — real user reports (discord/discord-rpc#189,
 * discordjs/RPC#80) describe presence staying frozen on whatever was last
 * set until something else overwrites it or the user restarts Discord.
 * That's why this module (a) always treats "no heartbeat in N minutes" as
 * "user is gone, clear it" — see the idle watchdog below — rather than
 * counting on a connection-drop signal, and (b) makes a best-effort clear
 * attempt on SIGINT/SIGTERM (see attemptShutdownClear). It's explicitly
 * best-effort: this project's launcher Stop/Restart force-kills the process
 * on Windows (see store.js's flushNow() comment for the same constraint
 * hitting the store's own shutdown flush) — a force-kill skips every
 * shutdown handler, ours included, so a presence left showing after a hard
 * stop is a known, accepted gap that the idle watchdog bounds to at most
 * IDLE_TIMEOUT_MS of staleness the next time anything else touches it.
 */

const MIN_RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
// How long without a heartbeat before a still-set presence is treated as
// abandoned (tab closed, browser crashed, laptop slept) and cleared. Kept
// generous relative to the ~30s heartbeat interval the frontend uses
// (ui-discord-presence.js) since backgrounded tabs get throttled by the
// browser and can miss a beat or two without actually being "closed".
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_WATCHDOG_INTERVAL_MS = 30_000;

// Fixed, documented asset keys — see the Settings UI copy for what these
// mean. Discord silently omits an image whose key/url isn't set or doesn't
// resolve to anything real; it does not error the whole activity out, so
// referencing an asset name the user hasn't uploaded is a safe no-op, not
// a crash risk.
const SMALL_IMAGE_KEYS = { manga: 'manga_icon', anime: 'anime_icon' };
const LARGE_IMAGE_FALLBACK_KEY = 'scrollscape_logo';
const MAX_TEXT_LEN = 128; // Discord's own limit on details/state/image text

const { withTimeout } = require('../common/async-utils');

// If Discord accepts the IPC connection but the handshake itself never
// completes (a half-alive named pipe — a real failure mode for local IPC,
// distinct from "pipe doesn't exist at all", which login() rejects immediately
// for), login() would otherwise never settle. Without a bound on it,
// connectionState gets stuck in 'connecting' forever, and connect()'s own
// re-entrancy guard (below) then silently blocks every future attempt,
// including scheduleReconnect()'s — Rich Presence goes dark with no
// self-recovery until something else happens to call disconnect() first.
const LOGIN_TIMEOUT_MS = 10_000;

// Same reasoning as LOGIN_TIMEOUT_MS, for the clear-before-disconnect call
// applySettings() makes below: a hung clearActivity() (Discord-side hiccup,
// half-dead pipe) must not block the toggle from actually turning off —
// disconnect() still runs either way once this settles or times out.
const CLEAR_TIMEOUT_MS = 3_000;

let Client = null;
let loadError = null;
try {
  ({ Client } = require('@xhayper/discord-rpc'));
} catch (e) {
  // Missing/broken dependency should never take the whole server down —
  // every exported function below already checks `Client` and no-ops if
  // it's null, same posture as "not configured" or "Discord not running".
  loadError = e;
}

let client = null;
let connectionState = 'disconnected'; // 'disconnected' | 'connecting' | 'connected'
let reconnectTimer = null;
let reconnectDelay = MIN_RECONNECT_DELAY_MS;
let idleWatchdogTimer = null;
let watchdogStarted = false;

let featureEnabled = false;
let currentClientId = '';

let desiredActivity = null; // last built Discord activity payload, re-sent on (re)connect
let lastHeartbeatAt = 0;
let lastActivityError = null; // set by pushActivity's catch, surfaced via getStatus() for remote diagnosis
let lastActivitySetAt = 0;

// Discord's own SET_ACTIVITY RPC call is rate-limited client-side (observed
// live: a generic view label sent immediately followed by a more specific
// one — e.g. setView("manga-details")'s label, then showReader()'s "Reading
// X" a few hundred ms later when a chapter opens straight away — leaves the
// FIRST one showing, stuck, even though pushActivity()'s own promise
// resolves cleanly for both and getStatus() reports no error at all. Discord
// isn't rejecting the second call, it's silently coalescing/ignoring a call
// that arrives too soon after the last one actually took effect. Debouncing
// the outbound push (not the local desiredActivity/lastHeartbeatAt
// bookkeeping, which still update immediately) means a rapid burst from one
// user action only ever sends its FINAL settled value to Discord, instead of
// racing it against Discord's own rate limit and losing.
const PUSH_DEBOUNCE_MS = 700;
let _pushDebounceTimer = null;

function truncate(text) {
  const s = String(text || '');
  return s.length > MAX_TEXT_LEN ? s.slice(0, MAX_TEXT_LEN - 1) + '…' : s;
}

function log(msg) {
  console.log(`[Discord RPC] ${msg}`);
}

function checkIdle() {
  if (!desiredActivity) return;
  if (Date.now() - lastHeartbeatAt > IDLE_TIMEOUT_MS) {
    log('No heartbeat received in time — clearing stale presence.');
    clearPresence().catch(() => {});
  }
}

/**
 * Call once at server startup. Starts the idle watchdog (harmless/no-op
 * while nothing has ever been set) and registers a best-effort clear on
 * SIGINT/SIGTERM. Must be called before applySettings() so a boot-time
 * "already enabled" config actually connects.
 */
function init() {
  if (!watchdogStarted) {
    watchdogStarted = true;
    idleWatchdogTimer = setInterval(checkIdle, IDLE_WATCHDOG_INTERVAL_MS);
    idleWatchdogTimer.unref?.();
  }
  // Best-effort only — see "LESSON 3" above for why this can't be relied
  // on, and why that's an accepted, bounded gap rather than a bug to chase.
  // Registered here (called from server.js before store.js is required) so
  // this listener is queued ahead of store.js's own SIGINT/SIGTERM handler,
  // which calls process.exit() synchronously and would otherwise cut this
  // one off before it runs at all.
  process.on('SIGINT', attemptShutdownClear);
  process.on('SIGTERM', attemptShutdownClear);
}

function attemptShutdownClear() {
  if (client && connectionState === 'connected' && desiredActivity) {
    // Not awaited — this handler cannot block whatever *other* SIGINT/SIGTERM
    // listener runs next (e.g. store.js's own, which exits the process
    // synchronously). Calling clearActivity() still gets its underlying
    // socket.write() issued synchronously before this function returns
    // (the async function body runs synchronously up to its first real
    // await), which is the best this can do without restructuring the
    // shared shutdown sequence in server.js for one feature's benefit.
    try { client.user.clearActivity().catch(() => {}); } catch (_) { /* ignore */ }
  }
}

/**
 * Called at boot (with the freshly-loaded store.settings) and again every
 * time POST /api/settings persists a change to discordRichPresenceEnabled
 * or discordClientId — lets a toggle/Client-ID edit take effect immediately
 * instead of requiring a full server restart.
 */
function applySettings(settings) {
  if (!Client) return; // dependency failed to load — see loadError below
  const enabled = !!(settings && settings.discordRichPresenceEnabled);
  const clientId = String((settings && settings.discordClientId) || '').trim();

  const changed = enabled !== featureEnabled || clientId !== currentClientId;
  // Captured before featureEnabled is overwritten below — this is exactly
  // the "user just flipped the Settings toggle off" case, as opposed to
  // e.g. editing the Client ID while staying enabled (where disconnect()
  // is immediately followed by a fresh connect() anyway, so there's
  // nothing stale left showing to worry about).
  const turningOff = featureEnabled && !enabled;
  const c = client;
  const hadLiveActivity = turningOff && c && connectionState === 'connected' && !!desiredActivity;
  featureEnabled = enabled;
  currentClientId = clientId;
  if (!changed) return;

  const teardownAndMaybeReconnect = () => {
    // Any config change invalidates whatever connection/attempt is in
    // flight — tear down unconditionally and let the block below start a
    // clean attempt (or none, if now disabled/unconfigured) rather than
    // trying to patch a live client's identity.
    disconnect();
    clearLocalPresenceState();

    if (featureEnabled && currentClientId) {
      reconnectDelay = MIN_RECONNECT_DELAY_MS;
      log('Enabled — attempting to connect to Discord.');
      connect();
    }
  };

  if (!hadLiveActivity) {
    teardownAndMaybeReconnect();
    return;
  }

  // Being turned off with something actually showing on Discord right now —
  // disconnect() below only closes ScrollScape's own IPC connection, it
  // does not tell Discord to clear the activity that connection last set.
  // Per LESSON 3 at the top of this file, Discord doesn't do that on its
  // own either: a plain disconnect() here would leave the last "Reading
  // X"/"In Manga Library" text frozen on the user's profile indefinitely
  // (until something else overwrites it), which reads as "the toggle
  // didn't actually do anything" even though the connection genuinely did
  // close. clearActivity() first, THEN tear down — bounded by
  // CLEAR_TIMEOUT_MS so a hung call can't block the toggle from taking
  // effect at all.
  log('Disabled — clearing presence before disconnecting.');
  withTimeout(c.user.clearActivity(), CLEAR_TIMEOUT_MS, 'Clear activity timed out')
    .catch(() => {})
    .finally(teardownAndMaybeReconnect);
}

function clearLocalPresenceState() {
  desiredActivity = null;
  lastHeartbeatAt = 0;
  // Otherwise a setPresence() debounced just before this (e.g. the reader
  // closing right on the heels of one last chapter-switch report) would
  // still fire late and silently resurrect a "Reading X" activity right
  // after this clear was supposed to be the final word.
  if (_pushDebounceTimer) { clearTimeout(_pushDebounceTimer); _pushDebounceTimer = null; }
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (client) {
    const c = client;
    client = null;
    try { c.destroy().catch(() => {}); } catch (_) { /* already gone */ }
  }
  connectionState = 'disconnected';
}

function connect() {
  if (!Client || !featureEnabled || !currentClientId) return;
  if (connectionState === 'connecting' || connectionState === 'connected') return;

  connectionState = 'connecting';
  const c = new Client({ clientId: currentClientId });

  // Fires when the IPC transport's socket closes after having been open —
  // the ordinary "Discord was quit while ScrollScape kept running" case,
  // not an exceptional one. login()'s own rejection (caught below) covers
  // "Discord was never running to begin with."
  c.on('disconnected', () => {
    if (client !== c) return; // stale listener from a superseded attempt
    log('Disconnected from Discord — will retry.');
    connectionState = 'disconnected';
    client = null;
    scheduleReconnect();
  });

  client = c;
  withTimeout(c.login(), LOGIN_TIMEOUT_MS, 'Handshake timed out')
    .then(() => {
      if (client !== c) return; // superseded by a newer connect() before this resolved
      connectionState = 'connected';
      reconnectDelay = MIN_RECONNECT_DELAY_MS;
      log('Connected.');
      if (desiredActivity) pushActivity(desiredActivity);
    })
    .catch((err) => {
      // By far the most common real-world outcome: Discord simply isn't
      // running, so the named pipe/socket doesn't exist. Never throws past
      // here — connect() is only ever invoked from contexts that don't
      // await it (applySettings, scheduleReconnect's timer). Logged (once
      // per attempt, backing off up to MAX_RECONNECT_DELAY_MS apart) rather
      // than swallowed silently — same "still say something, just don't
      // crash" posture as flaresolverr-lifecycle.js uses for its own
      // expected-but-noteworthy failures.
      if (client !== c) return;
      connectionState = 'disconnected';
      client = null;
      // Only reachable via the LOGIN_TIMEOUT_MS path above (the ordinary
      // "pipe doesn't exist" rejection never gets this far into a real
      // connection) — c itself is still holding a half-open transport, so
      // it needs the same explicit teardown disconnect() gives a normal
      // connection instead of just being dropped.
      try { c.destroy().catch(() => {}); } catch (_) { /* already gone */ }
      log(`Could not connect (${(err && err.message) || 'Discord not running, or rejected the connection'}) — retrying in ${Math.round(reconnectDelay / 1000)}s.`);
      scheduleReconnect();
    });
}

function scheduleReconnect() {
  if (!featureEnabled || !currentClientId) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectTimer.unref?.();
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
}

function pushActivity(activity) {
  if (!client || connectionState !== 'connected') return;
  return client.user.setActivity(activity).then(() => {
    lastActivityError = null;
    lastActivitySetAt = Date.now();
  }).catch((err) => {
    // A rejected SET_ACTIVITY (malformed payload, Discord-side hiccup) is
    // not a connection failure — leave the reconnect loop out of it. But it
    // must not be swallowed silently either: this was previously a bare
    // `.catch(() => {})`, which made "the connection succeeds but nothing
    // ever shows in Discord" undiagnosable from the outside — surfaced via
    // getStatus() instead so the Settings status line (or a direct
    // /api/discord-presence/status check) can show the real reason.
    lastActivityError = (err && err.message) || String(err);
    log(`setActivity failed: ${lastActivityError}`);
  });
}

// Most scraped sources' mangaDetails()/search() return a cover already
// wrapped in this app's own same-origin image proxy (/api/proxy-image?
// url=<encoded>) — needed for the in-app <img> tag (many CDNs 403 a direct
// hotlink without the right Referer, which the proxy adds server-side) but
// useless to Discord, which fetches largeImageUrl itself, from Discord's own
// infrastructure, with no way to carry that Referer. Confirmed live: sending
// a relative /api/proxy-image URL as largeImageUrl doesn't just show a
// broken image — Discord's RPC validation rejects the ENTIRE setActivity
// call ("large_url must be a valid uri"), so nothing in the payload takes
// effect and whatever was showing before stays stuck. Unwrapping back to
// the real external URL here — not fixable client-side, since
// ui-discord-presence.js has no reason to know this app-internal detail —
// is what actually lets a "Reading X" report with a cover reach Discord at
// all for sources whose scraper proxies covers (most of them).
function resolveExternalCoverUrl(cover) {
  const raw = String(cover || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    const url = new URL(raw, 'http://localhost');
    if (url.pathname === '/api/proxy-image') {
      // URLSearchParams.get() already percent-decodes the value (turning
      // e.g. %20 back into a literal space) — confirmed live this alone
      // still fails Discord's own URI validation the exact same way an
      // un-resolved local path does, so the decoded string needs
      // re-encoding, not just extracting, before it's usable again.
      const inner = url.searchParams.get('url');
      if (inner && /^https?:\/\//i.test(inner)) {
        try { return new URL(inner).href; } catch (_) { return ''; }
      }
    }
  } catch (_) { /* fall through */ }
  return '';
}

function buildActivity({ details, subtitle, cover, iconKind, largeText }) {
  const activity = {
    details: truncate(details),
    instance: false,
    startTimestamp: new Date(),
  };
  // Only reading/watching get the small badge (manga_icon/anime_icon) —
  // every other "aba" (Library, Advanced Search, ...) has no dedicated
  // asset uploaded for it, and Discord just omits a smallImageKey that
  // doesn't resolve rather than erroring, so leaving it unset here for
  // those is the correct no-op, not a bug.
  if (iconKind && SMALL_IMAGE_KEYS[iconKind]) {
    activity.smallImageKey = SMALL_IMAGE_KEYS[iconKind];
    activity.smallImageText = truncate(iconKind === 'anime' ? 'Watching on ScrollScape' : 'Reading on ScrollScape');
  }
  if (subtitle) activity.state = truncate(subtitle);

  const externalCover = resolveExternalCoverUrl(cover);
  if (externalCover) {
    // See "LESSON 1" above — an external, publicly-reachable image URL,
    // not a pre-uploaded Developer Portal asset.
    activity.largeImageUrl = externalCover;
  } else {
    activity.largeImageKey = LARGE_IMAGE_FALLBACK_KEY;
  }
  activity.largeImageText = truncate(largeText || details);

  return activity;
}

/**
 * Report the app's current status — a chapter/episode actively being
 * read/watched, or (per the "always active" requirement) any other "aba"
 * the user is browsing (Library, Advanced Search, ...). Every navigation
 * event calls this with a fresh `details` string rather than this module
 * synthesizing "Reading X"/"Watching X" itself — see ui-discord-presence.js
 * for where each label comes from. No-ops cleanly if the feature is off,
 * unconfigured, or the dependency failed to load.
 *
 * @param {{details: string, subtitle?: string, cover?: string, iconKind?: 'manga'|'anime', largeText?: string}} payload
 */
function setPresence({ details, subtitle, cover, iconKind, largeText }) {
  if (!Client || !featureEnabled || !currentClientId || !details) return;
  const activity = buildActivity({ details, subtitle, cover, iconKind, largeText });
  desiredActivity = activity;
  lastHeartbeatAt = Date.now();
  // See PUSH_DEBOUNCE_MS's own comment — only the last call in a rapid
  // burst actually reaches Discord's RPC; every call still updates
  // desiredActivity/lastHeartbeatAt above immediately regardless, so a
  // reconnect mid-burst or the idle watchdog both see current, correct state.
  if (_pushDebounceTimer) clearTimeout(_pushDebounceTimer);
  _pushDebounceTimer = setTimeout(() => {
    _pushDebounceTimer = null;
    pushActivity(activity);
  }, PUSH_DEBOUNCE_MS);
}

/**
 * "Still active" ping — does NOT touch Discord or rebuild the activity
 * (so startTimestamp / elapsed-time keeps counting from the original
 * setPresence() call). Purely resets the idle watchdog's clock.
 */
function heartbeat() {
  if (!desiredActivity) return;
  lastHeartbeatAt = Date.now();
}

/**
 * Explicit "stopped reading/watching" — reader closed, navigated away from
 * anime-details, or the idle watchdog decided the session went stale.
 */
async function clearPresence() {
  clearLocalPresenceState();
  if (client && connectionState === 'connected') {
    try { await client.user.clearActivity(); } catch (_) { /* non-fatal */ }
  }
}

function getStatus() {
  return {
    ok: true,
    dependencyLoaded: !!Client,
    dependencyError: Client ? null : (loadError && loadError.message) || null,
    configured: !!currentClientId,
    enabled: featureEnabled,
    connected: connectionState === 'connected',
    hasActivity: !!desiredActivity,
    lastActivityError,
    lastActivitySetAt: lastActivitySetAt || null,
  };
}

module.exports = { init, applySettings, setPresence, heartbeat, clearPresence, getStatus };
