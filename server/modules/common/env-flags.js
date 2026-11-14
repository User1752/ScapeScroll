'use strict';

// One spelling rule for every on/off environment variable (FLARESOLVERR_DISABLED,
// SCROLLSCAPE_SOLVER_SESSIONS_DISABLED, ...), moved here unchanged from
// flaresolverr-lifecycle.js so a second feature does not grow its own copy.
//
// The caller decides what an unrecognised value means: a brake (a *_DISABLED
// switch) treats 'unknown' as on, a consent (an *_AUTO_* switch) treats it as
// off, because staying off is the safe way to be wrong in both cases.

const FLAG_ON = new Set(['1', 'true', 'yes', 'on', 'y']);
// The empty string is "off" on purpose: an UNSET variable must read as off.
const FLAG_OFF = new Set(['', '0', 'false', 'no', 'off', 'n']);
const warnedOnce = new Set();

function warnOnce(key, message, warn = (text) => console.error(text)) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  warn(message);
}

// 'on' | 'off' | 'unknown'
function flagState(env, name) {
  const raw = String((env && env[name]) ?? '').trim().toLowerCase();
  if (FLAG_ON.has(raw)) return 'on';
  if (FLAG_OFF.has(raw)) return 'off';
  return 'unknown';
}

// A value echoed back in a warning: quoted and cut short, so a long or odd
// value cannot flood the console.
function shown(value) {
  return JSON.stringify(String(value).slice(0, 40));
}

module.exports = {
  FLAG_ON,
  FLAG_OFF,
  flagState,
  warnOnce,
  shown,
};
