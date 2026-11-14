'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../../config/catalog');
const { normalizePlan } = require('./filter-plan');

// Writing the source file of a site that is read through the person's own Suwayomi-Server (the extension engine), from the template next to this
// file. Only the id Suwayomi gives the source, its name, whether it lists latest titles and whether the extension marks it adult are filled in;
// every value is validated and enters the file as a JSON literal or as plain text, so nothing a server or a repository says can put code in it.
// The text still goes through the Check of the import card before anything is installed.

const TEMPLATE = path.join(__dirname, 'suwayomi-source.template.txt');
const SOURCE_ID_RE = /^\d{1,20}$/;
const TAG = 'scrollscape-engine';

// Control, separator and bidi characters are removed (the class is built from code points, never typed).
const UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2066, 0x2069]];
const UNSAFE_CHARS = new RegExp(`[${UNSAFE_RANGES.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`, 'g');

/** A name that is safe to print and to put in a comment: letters, digits, spaces and a few marks. */
const cleanName = (value, fallback) => String(value === undefined || value === null ? '' : value)
  .replace(UNSAFE_CHARS, ' ').replace(/[^\p{L}\p{N} '&!+-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || fallback;

/** The id a source gets in this app: the prefix and the id Suwayomi gives it. */
const engineSourceId = (sourceId) => `${config.engineIdPrefix}${sourceId}`;

/**
 * @param {{ sourceId: string, name?: string, supportsLatest?: boolean, isNsfw?: boolean, date?: string, filterPlan?: object }} source   filterPlan: what filter-plan.js read from the extension's filters
 * @returns {{ code: string, id: string, name: string, adultOnly: boolean, supportsLatest: boolean }}
 */
function buildEngineSource(source) {
  // Text only: the ids do not fit a JS number (they have 19 digits), so one that arrived as a number is already wrong.
  const sourceId = source && typeof source.sourceId === 'string' ? source.sourceId : '';
  if (!SOURCE_ID_RE.test(sourceId)) throw new Error('That is not a Suwayomi source id.');
  const id = engineSourceId(sourceId);
  const name = cleanName(source.name, id);
  const on = /^\d{4}-\d{2}-\d{2}$/.test(String(source.date || '')) ? source.date : new Date().toISOString().slice(0, 10);
  // The extension's own filters (genres, status, sort), rebuilt from scratch with every limit applied: only plain names and small numbers get through.
  const plan = normalizePlan(source.filterPlan);
  const fills = {
    __ORIGIN__: `// ${TAG} engine=suwayomi source=${sourceId} on=${on}`,
    __NAME_TEXT__: name,
    __NAME__: JSON.stringify(name),
    __ID__: JSON.stringify(id),
    __SOURCE_ID__: JSON.stringify(sourceId),
    __SUPPORTS_LATEST__: source.supportsLatest === true ? 'true' : 'false',
    __ADULT_ONLY__: source.isNsfw === true ? 'true' : 'false',
    __FILTER_PLAN__: JSON.stringify(plan),
    __UI_ORDER__: plan.sort ? JSON.stringify(plan.sort.options.map(({ value, label }) => ({ value, label }))) : 'false',
    __UI_STATUS__: plan.status ? 'true' : 'false',
    __UI_GENRES_ON__: plan.genres ? 'true' : 'false',
    __UI_GENRES__: JSON.stringify(plan.genres ? plan.genres.items.map((item) => item.name) : []),
    __UI_CUSTOM_TAGS__: plan.tags ? 'true' : 'false',
  };
  // LF whatever the checkout did to the template: the file written is the same on every computer (and its fingerprint with it).
  let code = fs.readFileSync(TEMPLATE, 'utf8').replace(/\r\n/g, '\n');
  // Longest token first: __NAME_TEXT__ must not be eaten by __NAME__.
  for (const token of Object.keys(fills).sort((a, b) => b.length - a.length)) code = code.split(token).join(fills[token]);
  if (/__[A-Z_]+__/.test(code)) throw new Error('A placeholder of the template was left unfilled.');
  return { code, id, name, adultOnly: source.isNsfw === true, supportsLatest: source.supportsLatest === true, filters: { genres: !!plan.genres, status: !!plan.status, sort: !!plan.sort, tags: !!plan.tags } };
}

module.exports = { buildEngineSource, engineSourceId, TAG };
