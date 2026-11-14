'use strict';

// Reading and validating the three settings of the FlareSolverr session pool
// (config/solver.js lists them). Two entry points with different manners, because
// they sit on different sides of the trust line:
//   - normalizeSolverSettings reads whatever is stored: it never refuses, an absent
//     key or junk is the default (what the pool and the Settings card use);
//   - repairSolverSettings cleans what is stored (store load, backup import): junk
//     is removed, nothing is ever added, so a default is never written into the
//     library;
//   - parseSolverSettingsUpdate judges what a client is saving: all-or-nothing,
//     with a message that names the key and the bounds.
// Neither touches the store or the pool. Any other key (an old or a future
// setting, a typo) is an ordinary unknown key: not read, not copied, not refused.

const { SETTINGS_DEFAULTS, SETTINGS_BOUNDS } = require('../../config/solver');

function isBoolean(value) {
  return typeof value === 'boolean';
}

function wholeNumberIn({ min, max }) {
  return (value) => Number.isInteger(value) && value >= min && value <= max;
}

function wholeNumberMessage(key) {
  const { min, max } = SETTINGS_BOUNDS[key];
  return `${key} must be a whole number from ${min} to ${max}.`;
}

// One rule per key. A bad value is never clamped: 1e9 pool sessions is a
// mistake or an attack, not "3".
const RULES = {
  solverSessionsEnabled: {
    accepts: isBoolean,
    message: 'solverSessionsEnabled must be true or false.',
  },
  solverSessionPoolSize: {
    accepts: wholeNumberIn(SETTINGS_BOUNDS.solverSessionPoolSize),
    message: wholeNumberMessage('solverSessionPoolSize'),
  },
  solverSessionIdleMinutes: {
    accepts: wholeNumberIn(SETTINGS_BOUNDS.solverSessionIdleMinutes),
    message: wholeNumberMessage('solverSessionIdleMinutes'),
  },
};

// In the order of SETTINGS_DEFAULTS, which is the order results are built in.
const KEYS = Object.keys(SETTINGS_DEFAULTS);

// Only a property the object owns counts: a polluted prototype, or a
// "__proto__" key from JSON.parse, must never feed a setting.
function ownValue(source, key) {
  try {
    if (source && typeof source === 'object' && Object.prototype.hasOwnProperty.call(source, key)) {
      return { present: true, value: source[key] };
    }
  } catch (_) {
    // A getter or proxy that throws is treated as "not there".
  }
  return { present: false, value: undefined };
}

/**
 * Settings as the app will use them. Never throws. Junk (wrong type, a number
 * out of range) falls back to the default; keys that are not the feature's are
 * not in the result.
 *
 * @param {object} raw store.settings, or anything a hostile backup put there
 * @returns {{ solverSessionsEnabled: boolean, solverSessionPoolSize: number,
 *             solverSessionIdleMinutes: number }}
 */
function normalizeSolverSettings(raw) {
  const settings = {};
  for (const key of KEYS) {
    const { present, value } = ownValue(raw, key);
    settings[key] = present && RULES[key].accepts(value) ? value : SETTINGS_DEFAULTS[key];
  }
  return settings;
}

/**
 * What is stored, repaired in place: a pool key that holds junk (wrong type, a number out of range) is REMOVED,
 * so the default applies when the settings are read (normalizeSolverSettings). A key that is absent stays absent
 * and a valid one stays as it is: only what the user set is ever stored, so a default that changes later reaches
 * every store that never set it, and a stored value is always a choice. Never throws; anything that is not an
 * object is left alone; keys that are not the feature's are not touched.
 *
 * @param {object} settings store.settings
 * @returns {object} the same object
 */
function repairSolverSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  for (const key of KEYS) {
    const { present, value } = ownValue(settings, key);
    if (present && !RULES[key].accepts(value)) {
      try {
        delete settings[key];
      } catch (_) {
        // A frozen or sealed object cannot be repaired; reading it still gives the default (normalizeSolverSettings).
      }
    }
  }
  return settings;
}

/**
 * Validates the part of a settings update that belongs to this feature.
 * Unknown keys are ignored (the settings route handles its own). The first
 * problem returns { patch: {}, error } and nothing is applied; a clean update
 * returns the values to store.
 *
 * @param {unknown} updates the request body
 * @returns {{ patch: object, error: string|null }}
 */
function parseSolverSettingsUpdate(updates) {
  const patch = {};
  for (const key of KEYS) {
    const { present, value } = ownValue(updates, key);
    if (!present) continue;
    if (!RULES[key].accepts(value)) return { patch: {}, error: RULES[key].message };
    patch[key] = value;
  }
  return { patch, error: null };
}

module.exports = {
  normalizeSolverSettings,
  repairSolverSettings,
  parseSolverSettingsUpdate,
};
