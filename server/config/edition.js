'use strict';

// Which edition this build is. The code line of a branch has its own behaviour (what `standard` means); the edition WITHOUT SOURCES is one more way to build
// the same code: no source is bundled, the catalog starts empty and the person adds the repositories they want. It is named by `edition.json` at the root of the
// app (the build tool writes it into the folder it packages; the file in the repository says `standard`) or, for trying it out, by SCROLLSCAPE_EDITION.
// An unknown name is the standard edition: a typo can never loosen anything.
//
//   hideNsfwDefault   Hide NSFW is on for a person who has never set it (the browser reads this from /edition.js).
//   defaultRepoOn     the repository the app knows is in the catalog until the person removes it (false: the catalog starts empty).
//   catalogWarnings   the content the catalog may offer from the repositories the person added (null: what the code line says). With Hide NSFW on by
//                     default nothing adult is shown until the person turns it off.
//   extensionEngine   false: this edition has no Suwayomi engine (null: what the code line says).

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

const EDITIONS = Object.freeze({
  standard: Object.freeze({ id: 'standard', sourceless: false, hideNsfwDefault: false, defaultRepoOn: true, catalogWarnings: null, extensionEngine: null }),
  sourceless: Object.freeze({
    id: 'sourceless',
    sourceless: true,
    hideNsfwDefault: true,
    defaultRepoOn: false,
    catalogWarnings: Object.freeze(['SAFE', 'MIXED', 'NSFW']),
    extensionEngine: false,
  }),
});

/**
 * @param {{ env?: object, rootDir?: string, readFile?: (file: string, encoding: string) => string }} [options]
 * @returns {typeof EDITIONS.standard}
 */
function readEdition({ env = process.env, rootDir = ROOT_DIR, readFile = fs.readFileSync } = {}) {
  let name = String(env.SCROLLSCAPE_EDITION || '').trim().toLowerCase();
  if (!name) {
    try {
      const parsed = JSON.parse(readFile(path.join(rootDir, 'edition.json'), 'utf8'));
      name = String((parsed && parsed.edition) || '').trim().toLowerCase();
    } catch (_) { /* no file, or not readable: the standard edition */ }
  }
  return Object.prototype.hasOwnProperty.call(EDITIONS, name) ? EDITIONS[name] : EDITIONS.standard;
}

/** The script the page loads first (/edition.js): only what the browser needs to know, as one frozen object. */
function editionScript(edition) {
  const e = edition || EDITIONS.standard;
  return `window.SCROLLSCAPE_EDITION = Object.freeze(${JSON.stringify({ id: e.id, sourceless: e.sourceless === true, hideNsfwDefault: e.hideNsfwDefault === true })});\n`;
}

module.exports = Object.freeze({ ...readEdition(), readEdition, editionScript, EDITIONS });
