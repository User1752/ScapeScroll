// ============================================================================
// SETTINGS > ADVANCED > SOURCES > "DISABLED SOURCES": TELLING THE SERVER
// ============================================================================
// The sources the user turned off are kept in this browser (state.settings.disabledSourceIds, saved with the other
// settings) and filter the source pickers. The server keeps a copy of its own for one reason: System Health's live
// source test and its image-quality check skip a source that is turned off instead of opening it again on every
// refresh (a source that keeps timing out restarts the hidden browser that the Cloudflare-protected sources go
// through, and breaks the others tested at the same time). The server never reads the browser's storage, so the
// browser tells it.
//
// Rule: toggling replaces the server list with this browser's list; start-up only adds.
//   - a toggle is the user deciding about THIS list, so the server's copy becomes exactly what the browser now shows
//     (turning a source back on has to be able to take it off the server too);
//   - start-up must not undo a decision made somewhere else: it only adds the ids this browser has and the server
//     lacks, and a browser with an empty list sends nothing, so a fresh browser cannot wipe the list of another one.
//     It never changes this browser's own list either.
//
// Both go through one queue, so a toggle made while the start-up read is still in flight is sent after it (the
// start-up cannot put back an id the user just turned on again) and two quick toggles finish in the order they were
// made: the last one wins. A failure is never shown to the user (the pickers already work without the server): it is
// logged once and the next toggle simply tries again.
//
// Layers, so that all but the last are testable without a browser:
//   cleanDisabledSourceIds / unionDisabledSourceIds / disabledSourcesNeedPush   pure helpers
//   createDisabledSourcesSync                                                   queue and logic, over injected ports
//   pushDisabledSourcesToServer / syncDisabledSourcesAtStart                    the thin glue to api() and state

const DISABLED_SOURCES_ENDPOINT = '/api/settings';
// Where the list is READ: a route of its own, so the start-up of every page does not pull the whole settings
// object (proxy password, API keys) into the browser to read one field. Saving it still goes to the settings route.
const DISABLED_SOURCES_READ_ENDPOINT = '/api/settings/disabled-sources';
const DISABLED_SOURCES_KEY = 'disabledSourceIds';
const DISABLED_SOURCES_WARNING = 'Could not tell the server which sources are turned off';
// Mirror of what the server accepts in this list (server/modules/sources/disabled-sources.js and limits.disabledSourceIdsMax):
// an id is what safeId() accepts (letters, digits, "_" and "-", up to this many characters) except three names every
// object has a slot for, and the list holds at most this many ids. The route ignores a whole list that holds one thing
// it would refuse, so one odd id must not cost the others; tests/unit/frontend-disabled-sources-sync.test.js checks
// every rule against the server's own function and fails when the two drift apart.
const DISABLED_SOURCE_ID_MAX_CHARS = 80;
const DISABLED_SOURCE_ID_PATTERN = new RegExp('^[a-z0-9_-]{1,' + DISABLED_SOURCE_ID_MAX_CHARS + '}$', 'i');
const DISABLED_SOURCE_RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const DISABLED_SOURCES_MAX_IDS = 200;

// ── Pure helpers ──────────────────────────────────────────────────────────

function isDisabledSourceId(value) {
  return typeof value === 'string' && DISABLED_SOURCE_ID_PATTERN.test(value) && !DISABLED_SOURCE_RESERVED_IDS.has(value);
}

/** The valid ids of a list, in order, each once, no more than the server keeps. Anything that is not a list gives an empty one. */
function cleanDisabledSourceIds(list) {
  if (!Array.isArray(list)) return [];
  const ids = new Set();
  for (const id of list) {
    if (ids.size >= DISABLED_SOURCES_MAX_IDS) break;
    if (isDisabledSourceId(id)) ids.add(id);
  }
  return [...ids];
}

/**
 * The browser's ids in the browser's order (the order the user turned them off in), then the ids only the server has.
 * Over the cap it is cut from the end, so the user's own choices are the ones that survive.
 */
function unionDisabledSourceIds(serverList, browserList) {
  return cleanDisabledSourceIds([...cleanDisabledSourceIds(browserList), ...cleanDisabledSourceIds(serverList)]);
}

/**
 * True when the browser has an id the server lacks and the union still fits under the cap. Fewer ids in the browser is
 * never a reason to push, and neither is a union too long to send: cutting it would take ids off the server, and start-up
 * only adds.
 */
function disabledSourcesNeedPush(serverList, browserList) {
  const onServer = new Set(cleanDisabledSourceIds(serverList));
  const extra = cleanDisabledSourceIds(browserList).filter((id) => !onServer.has(id));
  return extra.length > 0 && onServer.size + extra.length <= DISABLED_SOURCES_MAX_IDS;
}

// ── Queue and logic ───────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {(path: string, opts?: object) => Promise<any>} deps.api   the api() wrapper: rejects with the server's error text on a non-2xx
 * @param {() => any} deps.getBrowserList   this browser's list, read when it is needed (never stored)
 * @param {(message: string, err: any) => void} deps.warn
 * @returns {{push: (list: any) => Promise<boolean>, syncAtStart: () => Promise<boolean>}} neither ever rejects
 */
function createDisabledSourcesSync({ api: request, getBrowserList, warn }) {
  let queue = Promise.resolve();
  let warned = false;

  function warnOnce(err) {
    if (warned) return;
    warned = true;
    try { warn(DISABLED_SOURCES_WARNING, err); } catch (_) { /* a warning that cannot be shown is not a reason to fail */ }
  }

  async function post(ids) {
    try {
      const res = await request(DISABLED_SOURCES_ENDPOINT, { method: 'POST', body: JSON.stringify({ [DISABLED_SOURCES_KEY]: ids }) });
      if (res && res.ok === false) throw new Error(res.error || 'not saved');
      return true;
    } catch (err) {
      warnOnce(err);
      return false;
    }
  }

  // The server's copy, or null when it could not be read: not knowing the list is not the same as it being empty.
  async function readServerCopy() {
    try {
      const body = await request(DISABLED_SOURCES_READ_ENDPOINT);
      if (!(body && body.ok === true && body.data && typeof body.data === 'object')) throw new Error('unreadable');
      return { ids: body.data[DISABLED_SOURCES_KEY] };
    } catch (err) {
      warnOnce(err);
      return null;
    }
  }

  // A step that threw must not block the ones behind it, and the caller never sees the throw.
  function enqueue(step) {
    const run = queue.then(step).catch(() => false);
    queue = run;
    return run;
  }

  /** Toggle: the server's list becomes this list. Resolves true when the server accepted it. */
  function push(list) {
    if (!Array.isArray(list)) return Promise.resolve(false); // posting "nothing" would clear the server's list by accident
    const ids = cleanDisabledSourceIds(list); // copied now: a later change to the caller's list is a later push
    return enqueue(() => post(ids));
  }

  /** Start-up: add what the browser has and the server lacks. Resolves true when something was sent and accepted. */
  function syncAtStart() {
    return enqueue(async () => {
      const server = await readServerCopy();
      if (!server) return false;
      const browserIds = getBrowserList();
      if (!disabledSourcesNeedPush(server.ids, browserIds)) return false;
      return post(unionDisabledSourceIds(server.ids, browserIds));
    });
  }

  return { push, syncAtStart };
}

// ── Glue ──────────────────────────────────────────────────────────────────

function disabledSourcesWarn(message, err) {
  if (typeof dbg !== 'undefined' && dbg && typeof dbg.warn === 'function') dbg.warn(dbg.ERR_SETTINGS, message, err);
  else console.warn(message, err);
}

// The ports look the globals up when they are called, so nothing here needs api() or state to exist at load time.
const disabledSourcesSync = createDisabledSourcesSync({
  api: (path, opts) => api(path, opts),
  getBrowserList: () => (typeof state !== 'undefined' && state && state.settings ? state.settings.disabledSourceIds : []),
  warn: disabledSourcesWarn,
});

/** Called after the user toggles a source: the server's list becomes `list`. Never throws; resolves true when it was saved. */
function pushDisabledSourcesToServer(list) {
  try { return disabledSourcesSync.push(list); } catch (_) { return Promise.resolve(false); }
}

/** Called once when the page starts, fire and forget. Never throws; resolves true when it had to add something. */
function syncDisabledSourcesAtStart() {
  try { return disabledSourcesSync.syncAtStart(); } catch (_) { return Promise.resolve(false); }
}

window.cleanDisabledSourceIds = cleanDisabledSourceIds;
window.unionDisabledSourceIds = unionDisabledSourceIds;
window.disabledSourcesNeedPush = disabledSourcesNeedPush;
window.createDisabledSourcesSync = createDisabledSourcesSync;
window.pushDisabledSourcesToServer = pushDisabledSourcesToServer;
window.syncDisabledSourcesAtStart = syncDisabledSourcesAtStart;
