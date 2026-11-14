'use strict';

const fs = require('fs');
const path = require('path');
const { checkAnimeSource, ID_RE } = require('./contract');

// At start, the anime sources the person imported earlier (data/anime-sources/<id>.js) are loaded and added to the registry. Each file is
// judged exactly as at install: it must follow the contract, its meta.id must be its file name, and it must declare meta.stream (an imported
// source never brings its own relay). A file that does not pass is skipped with a warning, never fatal: one broken file must not take the
// others, or the app, down with it. Files that are not "<id>.js" (a .bak, a temporary name) are never read.

/**
 * @param {{ dir: string, registry: object, loadCandidate: Function, warn?: Function, readdir?: Function, readFile?: Function }} deps
 * @returns {{ loaded: string[], skipped: { file: string, reason: string }[] }}
 */
function loadInstalledAnimeSources({ dir, registry, loadCandidate, warn = () => {}, readdir = fs.readdirSync, readFile = fs.readFileSync }) {
  const loaded = [];
  const skipped = [];
  let names;
  try { names = readdir(dir); } catch (_) { return { loaded, skipped }; } // no folder yet: nothing imported
  for (const name of names.filter((n) => /\.js$/.test(n)).sort()) {
    const id = name.slice(0, -3);
    const skip = (reason) => { skipped.push({ file: name, reason }); warn(`[anime-sources] ${name} skipped: ${reason}`); };
    if (!ID_RE.test(id)) { skip('the file name is not a valid anime source id'); continue; }
    try {
      const file = path.join(dir, name);
      const mod = loadCandidate(file, id, readFile(file, 'utf8'));
      const verdict = checkAnimeSource(mod);
      if (!verdict.ok) { skip(verdict.problems.join(' ')); continue; }
      if (verdict.meta.id !== id) { skip(`meta.id is "${verdict.meta.id}", not the file name`); continue; }
      if (!verdict.meta.stream) { skip('it does not declare meta.stream'); continue; }
      registry.register(mod, { origin: 'imported' });
      loaded.push(id);
    } catch (err) {
      skip(String((err && err.message) || err).split('\n')[0].slice(0, 160));
    }
  }
  return { loaded, skipped };
}

module.exports = { loadInstalledAnimeSources };
