'use strict';

const { strictSourceIdList } = require('../sources/disabled-sources');

// The settings POST /api/settings copies from the request exactly as they come: a table of
// [key, type] and the one rule that applies it. A value is copied when it has the type the setting
// has (so an empty string or false clears a setting, and a number where a string belongs is ignored),
// and only the keys of the table are ever written, never one the request chose. The settings that
// need a judgement of their own (the FlareSolverr pool's three, solver-settings.js) are not here.
//
// The types: 'string', 'boolean' (the value must be of that type) and 'idList' (a list of source ids, all or nothing).
//
// Interface:
//   COMMON_SETTINGS_FIELDS            the table every edition saves
//   copySettingsFields(settings, updates, fields = COMMON_SETTINGS_FIELDS)   copies, returns `settings`
// A route that has fields of its own passes a longer table.

const COMMON_SETTINGS_FIELDS = Object.freeze([
  ['flaresolverrUrl', 'string'],
  ['proxyUrl', 'string'],
  ['proxyUsername', 'string'],
  ['proxyPassword', 'string'],
  ['comicVineApiKey', 'string'],
  ['suwayomiUrl', 'string'],
  ['suwayomiUsername', 'string'],
  ['suwayomiPassword', 'string'],
  ['discordRichPresenceEnabled', 'boolean'],
  ['discordClientId', 'string'],
  // Lets the source import tool answer another device that is logged in (middleware/local-only.js, requireThisComputer).
  ['allowRemoteImport', 'boolean'],
].map((field) => Object.freeze(field)));

// The value to store for `value` under `type`, or undefined when the value is not of that type (the key is then left
// alone). 'idList' is a list of source ids, judged all or nothing: one entry that is not an id, or a list over the cap,
// refuses the whole list, and an empty list is a valid one (it clears the setting). It is copied as the cleaned,
// de-duplicated list, never as the array the request carried.
function acceptedValue(type, value) {
  if (type === 'idList') return strictSourceIdList(value);
  return typeof value === type ? value : undefined;
}

function copySettingsFields(settings, updates, fields = COMMON_SETTINGS_FIELDS) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return settings;
  for (const [key, type] of fields) {
    const value = acceptedValue(type, updates[key]);
    if (value !== undefined) settings[key] = value;
  }
  return settings;
}

module.exports = { COMMON_SETTINGS_FIELDS, copySettingsFields };
