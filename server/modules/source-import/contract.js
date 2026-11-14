'use strict';

const { safeId } = require('../common/identity');
const { ALLOWED_METHODS } = require('../sources/dispatch-service');

// What a manga source module has to export, as the dispatcher and the loader really use it (positional arguments, see
// sources/dispatch-service.js; the loader's own load-time check is the four REQUIRED functions plus a truthy meta.id).
// This is the stricter check the import tool runs BEFORE a file is installed. The loader is left as it was: a source
// that works today must keep loading even if its meta is sloppier than this asks of a new one.
const REQUIRED_METHODS = Object.freeze(['search', 'mangaDetails', 'chapters', 'pages']);
// Optional calls: the whitelisted ones minus the required ones, plus the two that only System Health reads
// (healthCheck(), firstPage(); manual-tecnico/04) and are deliberately not in the dispatcher's whitelist.
const OPTIONAL_METHODS = Object.freeze([
  ...[...ALLOWED_METHODS].filter((name) => !REQUIRED_METHODS.includes(name)),
  'healthCheck',
  'firstPage',
]);
const BOOLEAN_META_FLAGS = Object.freeze([
  'beta', 'supportsTrending', 'supportsRecentlyAdded', 'supportsLatestUpdates', 'supportsPopularAllTime',
]);
const TEXT_META_FIELDS = Object.freeze(['name', 'version', 'author', 'icon']);
const META_TEXT_MAX = 200;
const META_ICON_MAX = 2000;

function describeText(value) {
  return typeof value === 'string' ? value : (typeof value === 'number' ? String(value) : '');
}

/**
 * Judges the module a candidate file exported. Never throws and never calls any of the source's functions: it only
 * looks at what was exported, so it is as safe as the require() that produced the module (which has already run).
 *
 * @param {unknown} mod         what the file exports
 * @param {string}  expectedId  the id the file would be installed as (already validated with safeId)
 * @returns {{ ok: boolean, errors: string[], warnings: string[], summary: object }}
 */
function checkSourceContract(mod, expectedId) {
  try {
    return judgeSourceContract(mod, expectedId);
  } catch (err) {
    // An export that is a getter can throw when it is read.
    const message = String((err && err.message) || err).split('\n')[0].slice(0, 200);
    return {
      ok: false,
      errors: [`The exports could not be read: ${message}`],
      warnings: [],
      summary: { id: '', name: '', version: '', author: '', icon: '', methods: [], optionalMethods: [], flags: {} },
    };
  }
}

function judgeSourceContract(mod, expectedId) {
  const errors = [];
  const warnings = [];
  const summary = { id: '', name: '', version: '', author: '', icon: '', methods: [], optionalMethods: [], flags: {} };

  if (!mod || (typeof mod !== 'object' && typeof mod !== 'function')) {
    errors.push('The file does not export a module object (module.exports / exports.meta = { ... }).');
    return { ok: false, errors, warnings, summary };
  }

  const meta = mod.meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    errors.push('meta is missing: export meta = { id, name, version }.');
  } else {
    const metaId = typeof meta.id === 'string' ? meta.id : '';
    summary.id = metaId;
    if (!metaId) {
      errors.push('meta.id is missing: it must be the same text as the id the source is installed as.');
    } else if (!safeId(metaId)) {
      errors.push('meta.id may only hold letters, digits, "_" and "-" (up to 80 characters).');
    } else if (metaId !== expectedId) {
      errors.push(`meta.id is "${metaId}" but the source would be installed as "${expectedId}": they must be the same text.`);
    }

    for (const field of TEXT_META_FIELDS) {
      const value = meta[field];
      if (value === undefined || value === null || value === '') continue;
      const text = describeText(value);
      if (!text) {
        warnings.push(`meta.${field} is not text and is ignored.`);
        continue;
      }
      summary[field] = text.slice(0, field === 'icon' ? META_ICON_MAX : META_TEXT_MAX);
      if (text.length > (field === 'icon' ? META_ICON_MAX : META_TEXT_MAX)) {
        warnings.push(`meta.${field} is very long and is cut when it is shown.`);
      }
    }
    if (!summary.name) errors.push('meta.name is missing: it is the name shown in the app.');
    if (!summary.version) warnings.push('meta.version is missing: "1.0.0" is shown instead.');

    for (const flag of BOOLEAN_META_FLAGS) {
      if (meta[flag] === undefined) continue;
      if (typeof meta[flag] !== 'boolean') warnings.push(`meta.${flag} should be true or false.`);
      else summary.flags[flag] = meta[flag];
    }
  }

  for (const name of REQUIRED_METHODS) {
    if (typeof mod[name] === 'function') summary.methods.push(name);
    else errors.push(`${name}() is missing: every source has to export search, mangaDetails, chapters and pages.`);
  }
  for (const name of OPTIONAL_METHODS) {
    if (mod[name] === undefined) continue;
    if (typeof mod[name] === 'function') summary.optionalMethods.push(name);
    else errors.push(`${name} is exported but is not a function.`);
  }

  return { ok: errors.length === 0, errors, warnings, summary };
}

module.exports = { checkSourceContract, REQUIRED_METHODS, OPTIONAL_METHODS };
