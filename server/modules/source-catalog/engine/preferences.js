'use strict';

// Some extensions that make one chapter per picture (an album of single images) have a setting that joins them into long chapters, so a reader does not
// have to move on after every image. The Suwayomi-Server lists an extension's settings (GET /api/v1/source/<id>/preferences) and accepts a change
// (POST, with the position in that list and the new value). This only recognises that one setting, by what it is called; every other setting of an
// extension is left alone, and a list it does not understand is "nothing to change".

const BOOLEAN_TYPES = Object.freeze(['CheckBoxPreference', 'SwitchPreferenceCompat', 'SwitchPreference']);
const MERGE_RE = /merge|combine|join/i;
const CHAPTER_RE = /chapter/i;

/**
 * @param {Array<{ type: string, key: string, title: string, currentValue: unknown }>} preferences   as the service lists them
 * @returns {{ position: number, enabled: boolean } | null}   the position of the "merge chapters" switch and whether it is on, or null when there is none
 */
function findMergedChaptersPreference(preferences) {
  const list = Array.isArray(preferences) ? preferences : [];
  for (let position = 0; position < list.length; position += 1) {
    const pref = list[position];
    if (!pref || typeof pref !== 'object' || !BOOLEAN_TYPES.includes(pref.type)) continue;
    const text = `${pref.key || ''} ${pref.title || ''}`;
    if (MERGE_RE.test(text) && CHAPTER_RE.test(text)) return { position, enabled: pref.currentValue === true };
  }
  return null;
}

module.exports = { findMergedChaptersPreference, BOOLEAN_TYPES };
