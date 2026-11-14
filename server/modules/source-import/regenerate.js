'use strict';

const { sha256Of } = require('./static-report');
const { IMPORTED, checkId } = require('./ids');
const { createFailure } = require('./failure');
const { readOrigin, sameApartFromOrigin } = require('./generator/origin');
const { supportedEngines } = require('./generator');

// "Regenerate": a source this app wrote from a link (its file carries the origin line of generator/origin.js) is written again from
// the same address, so a site that changed its markup, its genres or its robots.txt can be followed. Nothing is replaced here: the
// answer is the same as for a pasted link (the text of a source), which the card puts in its box and Checks; the person then
// confirms the replacement of the installed source, the same confirmed replacement every re-import goes through.
//
// What counts as "generated": an IMPORTED source whose file is still the file that was installed (its sha256 is the one the store
// holds: a file edited by hand afterwards is the person's, not ours to overwrite) and that names its origin. The address comes from
// that file, never from the request.
//
// `readText(id)` returns the installed file's text, or '' when there is none.

/**
 * @param {{ readStore: () => Promise<object>, readText: (id: string) => string, generate: (url: string, options: object) => Promise<object> }} deps
 */
function createRegenerate({ readStore, readText, generate }) {
  function originOf(id, entry) {
    if (!entry || entry.installedVia !== IMPORTED || !/^[0-9a-f]{64}$/.test(String(entry.sha256 || ''))) return null;
    let text;
    try { text = readText(id); } catch (_) { return null; }
    if (!text || sha256Of(text) !== entry.sha256) return null;
    const origin = readOrigin(text);
    return origin && supportedEngines().includes(origin.engine) ? { ...origin, text } : null;
  }

  /** The generated sources among the installed ones: [{ id, name, engine, base, on }]. */
  async function list() {
    const store = await readStore();
    const out = [];
    for (const [id, entry] of Object.entries((store && store.installedSources) || {})) {
      const origin = originOf(id, entry);
      if (origin) out.push({ id, name: String(entry.name || id).slice(0, 80), engine: origin.engine, base: origin.base, on: origin.on });
    }
    return out;
  }

  /** The source written again for `id`, with `regenerated: true` and whether it differs from the installed one. */
  async function regenerate(rawId, { denylist = [] } = {}) {
    const id = checkId(rawId);
    const store = await readStore();
    const entry = store && store.installedSources && store.installedSources[id];
    if (!entry) throw createFailure(`"${id}" is not installed.`, 404);
    const origin = originOf(id, entry);
    if (!origin) throw createFailure(`"${id}" was not written from a link, or its file was changed after it was installed, so there is nothing to regenerate.`, 409);
    const result = await generate(origin.base, { id, denylist });
    if (result.status !== 'generated') return { ...result, regenerated: true };
    const notes = result.engine === origin.engine ? result.notes : [`The site now looks like a ${result.engine} site (it was written as ${origin.engine}).`, ...result.notes];
    return { ...result, notes, regenerated: true, unchanged: sameApartFromOrigin(origin.text, result.code) };
  }

  return { list, regenerate };
}

module.exports = { createRegenerate };
