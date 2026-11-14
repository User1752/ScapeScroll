'use strict';

// The version of the app, as package.json says it (the packaged exe carries package.json too, so the same line works in both). It is a label
// for the corner of Settings, never a reason to fail: anything that is not a plain version number, or cannot be read, is ''.

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** @param {() => { version?: unknown }} [load] where package.json comes from (a test passes its own) */
function getAppVersion(load = () => require('../../../package.json')) {
  try {
    const version = load() && load().version;
    return typeof version === 'string' && VERSION_RE.test(version) ? version : '';
  } catch (_) {
    return '';
  }
}

module.exports = { getAppVersion };
