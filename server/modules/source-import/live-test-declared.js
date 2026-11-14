'use strict';

const { genreNames, signatureOf, pass, fail, warn, skip } = require('./live-test-support');

// The checks of what a source DECLARES in meta.ui: the lists must not be decorative. A genre list has to give titles tagged
// with the genre; a sort or a filter that is declared real has to change the list. The sort, the filters and the lists of
// trending / latest / recent cost more calls, so only the full test runs them.

// The formats of the app's own Format menu a sort is tried with when the unfiltered list ignores it (the first that has titles).
const FORMAT_PROBES = Object.freeze(['manga', 'doujinshi', 'manhwa', 'manhua']);
const FILTER_PROBES = Object.freeze([['publicationStatus', ['completed', 'ongoing']], ['format', ['manga', 'manhwa']], ['contentRating', ['safe', 'erotica']]]);
const LIST_METHODS = Object.freeze(['trending', 'latestUpdates', 'recentlyAdded', 'popularAllTime']);

// The tags of a title exactly as the source wrote them: genreNames() cuts a tag at a slash, a comma or a semicolon (a list written as one text), so a
// genre whose own name has one ("3D / Digital Art") can only be matched by the tag as a whole.
function wholeTags(item) {
  const out = [];
  for (const list of [item && item.genres, item && item.tags]) if (Array.isArray(list)) for (const tag of list) if (typeof tag === 'string' && tag.trim()) out.push(tag.trim().toLowerCase());
  return out;
}

async function checkDeclaredGenres(ctx) {
  const { mod, ui, call, collect, filtersWith } = ctx;
  const declared = Array.isArray(ui.genres) ? ui.genres : [];
  if (declared.length === 0) return skip('no genre list declared');
  if (typeof mod.byGenres !== 'function') return fail('genres are declared but the source has no byGenres()');
  for (const name of declared.slice(0, 2)) {
    const result = collect(await call('byGenres', () => mod.byGenres([name], '', filtersWith(), 1)));
    const list = (result && result.results) || [];
    if (list.length === 0) continue;
    const wanted = name.toLowerCase();
    const tagged = list.filter((item) => wholeTags(item).includes(wanted) || genreNames(item).some((g) => g.toLowerCase() === wanted)).length;
    return tagged === list.length ? pass(`"${name}": ${list.length} titles, all tagged with it`) : warn(`"${name}": ${list.length - tagged} of ${list.length} titles are not tagged with it (the app drops those)`);
  }
  return fail(`the first declared genres (${declared.slice(0, 2).join(', ')}) returned no titles`);
}

async function checkDeclaredSort(ctx) {
  const { mod, ui, call, filtersWith } = ctx;
  const options = (ui.orderBy || []).map((o) => o.value).slice(0, 3);
  if (options.length < 2) return skip('fewer than two sort options declared');
  // The lists the sort values give, with the filters of the app and (once) a format chosen.
  const search = async (value, filters) => signatureOf(await call('search', () => mod.search('', 1, value, filters)));
  const listsWith = async (filters, first) => {
    const signatures = [first];
    for (const value of options.slice(1)) signatures.push(await search(value, filters));
    return new Set(signatures);
  };
  const plain = await listsWith(filtersWith(), await search(options[0], filtersWith()));
  if (plain.size > 1) return pass(`${plain.size} different lists for ${options.length} sort values`);
  // A feed that merges several categories (the site cannot sort across them) ignores the sort until a format is chosen: the
  // sort is then real but partial, which is a warning and not the same as decorative. Only a source that declared a real
  // format filter is asked again, with the first few formats of the app's own list that give it any titles.
  if (ui.filters && ui.filters.format === true) {
    for (const format of FORMAT_PROBES) {
      const first = await search(options[0], filtersWith('format', format));
      if (!first) continue;
      if ((await listsWith(filtersWith('format', format), first)).size > 1) return warn(`the sort changes the list only with a format chosen ("${format}"); with every format it is ignored`);
      break;
    }
  }
  return fail('every declared sort value gives the same list: the sort is decorative (declare it false, or fix it)');
}

function filterCheck(key, values) {
  return async (ctx) => {
    const { mod, ui, call, filtersWith } = ctx;
    if (!(ui.filters && ui.filters[key] === true)) return skip(`${key} is not declared as a real filter`);
    const a = await call('search', () => mod.search('', 1, '', filtersWith(key, values[0])));
    const b = await call('search', () => mod.search('', 1, '', filtersWith(key, values[1])));
    if (!signatureOf(a) && !signatureOf(b)) return skip(`both ${key} values returned nothing`);
    // One list empty and the other not is not a measurement: any filter "differs" from nothing. The site may simply have none.
    if (!signatureOf(a) || !signatureOf(b)) return warn(`only one of ${values[0]} / ${values[1]} returned titles (the site may have none of the other): the filter was not measured against two real values`);
    return signatureOf(a) !== signatureOf(b) ? pass(`${values[0]} and ${values[1]} give different lists`) : fail(`${key} is declared real but ${values[0]} and ${values[1]} give the same list (decorative)`);
  };
}

function listCheck(method) {
  return async (ctx) => {
    const result = ctx.collect(await ctx.call(method, () => ctx.mod[method]()));
    const list = (result && result.results) || [];
    return list.length ? pass(`${list.length} titles`) : warn(`${method}() returned no titles`);
  };
}

/** The declared-genres check, which the basic test runs too. */
const BASIC_DECLARED_CHECKS = Object.freeze([['declared-genres', checkDeclaredGenres]]);

/** What only the full test runs: the sort, the filters, and the lists the source offers (only those it has). */
function fullDeclaredChecks(mod) {
  return [
    ['declared-sort', checkDeclaredSort],
    ...FILTER_PROBES.map(([key, values]) => [`declared-${key}`, filterCheck(key, values)]),
    ...LIST_METHODS.filter((method) => typeof mod[method] === 'function').map((method) => [`list-${method}`, listCheck(method)]),
  ];
}

module.exports = { BASIC_DECLARED_CHECKS, fullDeclaredChecks };
