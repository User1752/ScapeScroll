'use strict';

// The sources the user switched off (Settings > Sources > Manga Sources > Disabled sources). The browser keeps
// its own copy for the pickers; this is the server's copy, store.settings.disabledSourceIds, which the live
// probes of System Health read so that a source nobody uses is not opened in the solver's browser.
//
// Interface:
//   parseDisabledSourceIds(value)   what is stored: the usable ids of an array, de-duplicated, at most the cap
//   strictSourceIdList(value)       what an update from the browser must be: every entry an id, within the cap
//                                   (returns the de-duplicated list), otherwise undefined: all or nothing
//   disabledSourceSetOf(store)      a new Set of the ids stored in `store`; never throws, an unreadable store is empty
//   enabledSourceIdsOf(store)       the installed ids that are not in that set, in installed order
//
// An id is what safeId() accepts: the same rule an installed source's id had to pass, so a list that holds
// anything else holds no source. Three names are refused on top, since they name a slot every object has and
// a list that carries one is not a list of sources.

const limits = require('../../config/limits');
const { safeId } = require('../common/identity');

const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);

function isSourceId(value) {
  return safeId(value) !== null && !RESERVED_IDS.has(value);
}

function parseDisabledSourceIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  for (const entry of value) {
    if (ids.size >= limits.disabledSourceIdsMax) break;
    if (isSourceId(entry)) ids.add(entry);
  }
  return [...ids];
}

function strictSourceIdList(value) {
  // The length is judged first, so a list that is far too long is never walked.
  if (!Array.isArray(value) || value.length > limits.disabledSourceIdsMax) return undefined;
  const entries = Array.from(value); // a hole becomes undefined, which is not an id
  return entries.every(isSourceId) ? [...new Set(entries)] : undefined;
}

function disabledSourceSetOf(store) {
  const settings = store && typeof store === 'object' ? store.settings : undefined;
  const list = settings && typeof settings === 'object' ? settings.disabledSourceIds : undefined;
  return new Set(parseDisabledSourceIds(list));
}

function enabledSourceIdsOf(store) {
  const disabled = disabledSourceSetOf(store);
  const installed = store && typeof store === 'object' ? store.installedSources : undefined;
  const ids = installed && typeof installed === 'object' ? Object.keys(installed) : [];
  return ids.filter((id) => !disabled.has(id));
}

module.exports = { parseDisabledSourceIds, strictSourceIdList, disabledSourceSetOf, enabledSourceIdsOf };
