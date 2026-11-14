// ============================================================================
// ACTIVITY TRACKER — tab focus/visibility, feeds AFK time + Discord Sleeping
// ============================================================================
// "AFK" here means the tab isn't visible/focused (Page Visibility API +
// window focus/blur), deliberately NOT mouse-stillness-based — someone
// reading a long chapter without touching the mouse is normal engagement,
// not absence. The same unfocused signal drives two independent things:
//   1. totalTimeAfk (server/modules/analytics/service.js's recordAfkTime),
//      flushed periodically so a crashed tab or sleeping machine only loses
//      at most one flush interval's worth of time, not the whole session.
//   2. Discord's "Sleeping" presence (ui-discord-presence.js), which only
//      switches in after ACTIVITY_SLEEP_THRESHOLD_MS of continuous
//      unfocus — a quick alt-tab shouldn't flip Discord to Sleeping.

const ACTIVITY_SLEEP_THRESHOLD_MS = 5 * 60 * 1000; // matches discord-rpc/service.js's own IDLE_TIMEOUT_MS
const ACTIVITY_AFK_FLUSH_INTERVAL_MS = 30_000;

let _activityUnfocusedSince = null; // ms timestamp, or null while focused
let _activitySleepTimer = null;

function _activityIsFocused() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function _activityPostAfkMinutes(minutes, keepalive) {
  if (!minutes || minutes <= 0) return;
  fetch('/api/analytics/afk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minutes }),
    keepalive: !!keepalive,
  }).catch(() => {});
}

// Sends whatever unfocused time has accumulated since the last flush (or
// since going unfocused) and resets the baseline, rather than waiting for
// focus to return — a machine left asleep for hours with the tab never
// refocused would otherwise never report any AFK time at all.
function _activityFlushAfk(keepalive) {
  if (_activityUnfocusedSince == null) return;
  const now = Date.now();
  const minutes = (now - _activityUnfocusedSince) / 60_000;
  _activityUnfocusedSince = now;
  _activityPostAfkMinutes(minutes, keepalive);
}

function _activityHandleUnfocused() {
  if (_activityUnfocusedSince != null) return;
  _activityUnfocusedSince = Date.now();
  _activitySleepTimer = setTimeout(() => {
    if (typeof discordPresenceEnterSleep === 'function') discordPresenceEnterSleep();
  }, ACTIVITY_SLEEP_THRESHOLD_MS);
}

function _activityHandleFocused() {
  if (_activitySleepTimer) {
    clearTimeout(_activitySleepTimer);
    _activitySleepTimer = null;
  }
  if (_activityUnfocusedSince != null) {
    _activityFlushAfk(false);
    _activityUnfocusedSince = null;
  }
  // No-op if Discord wasn't actually sleeping (discordPresenceWake() checks
  // its own state) — safe to call unconditionally on every refocus.
  if (typeof discordPresenceWake === 'function') discordPresenceWake();
}

function _activityCheckFocusState() {
  if (_activityIsFocused()) _activityHandleFocused();
  else _activityHandleUnfocused();
}

function initActivityTracker() {
  document.addEventListener('visibilitychange', _activityCheckFocusState);
  window.addEventListener('focus', _activityCheckFocusState);
  window.addEventListener('blur', _activityCheckFocusState);

  setInterval(() => {
    if (_activityUnfocusedSince != null) _activityFlushAfk(false);
  }, ACTIVITY_AFK_FLUSH_INTERVAL_MS);

  window.addEventListener('beforeunload', () => _activityFlushAfk(true));

  // Covers a tab opened directly in the background (e.g. restored by the
  // browser without ever gaining focus) — otherwise it would report as
  // focused until the first real visibilitychange/blur event.
  _activityCheckFocusState();
}

window.initActivityTracker = initActivityTracker;
