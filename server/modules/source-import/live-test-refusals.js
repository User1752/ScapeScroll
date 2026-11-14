'use strict';

const { namesNeverListedCategory } = require('../common/source-ui');
const {
  isBadInputStatus, looksLikeSiteProblem, safeMessage, text, pass, fail, warn, rethrowRunEnders, genreNames,
} = require('./live-test-support');

// The checks of what a source must REFUSE or never give: a title that does not exist, a path-like id, the categories that are
// never listed. A site that did not answer is "inconclusive", never a pass: silence is not a refusal.

const MISSING_TITLE_ID = 'definitely-not-a-title-9x7q2';
const TRAVERSAL_ID = '../../etc/passwd';
// Category names a source must give nothing for. They are sent to the site as a search and the answer is only counted.
const NEVER_LISTED_PROBES = Object.freeze(['Loli', 'Shota', 'Lolicon', 'Shotacon']);

async function checkMissingTitle(ctx) {
  const { mod, state, call } = ctx;
  // An id the source would accept if the title existed: a site with numeric ids checks the format first and answers 400
  // to a word, which says nothing about a title that is missing. So the probe has the shape of the ids it listed.
  const probe = state.target && /^\d{2,}$/.test(String(state.target.id)) ? '9'.repeat(String(state.target.id).length) : MISSING_TITLE_ID;
  try {
    await call('mangaDetails', () => mod.mangaDetails(probe), { expected: true });
  } catch (err) {
    rethrowRunEnders(err);
    if (err && err.statusCode === 404) return pass('a title that does not exist answers 404');
    if (err && err.statusCode === 400) return warn('a title that does not exist answers 400 (404 is what it means)');
    if (looksLikeSiteProblem(err)) return warn(`inconclusive: the site did not answer (${text(safeMessage(err), 60)})`);
    return warn(`a title that does not exist answers an error without a status (${text(safeMessage(err), 60)}): use a 404`);
  }
  return fail('mangaDetails() answered a title for an id that does not exist');
}

async function checkBadIds(ctx) {
  const { mod, call } = ctx;
  const probes = [['mangaDetails', TRAVERSAL_ID], ['pages', TRAVERSAL_ID], ['chapters', 'x/../../y']];
  const loose = [];
  const inconclusive = [];
  for (const [method, value] of probes) {
    if (typeof mod[method] !== 'function') continue;
    try {
      await call(method, () => mod[method](value), { expected: true });
      return fail(`${method}("${value}") was answered instead of refused`);
    } catch (err) {
      rethrowRunEnders(err);
      if (isBadInputStatus(err)) continue;
      if (looksLikeSiteProblem(err)) inconclusive.push(method); else loose.push(method);
    }
  }
  if (inconclusive.length) return warn(`inconclusive: ${inconclusive.join(', ')} got no answer from the site`);
  return loose.length ? warn(`${loose.join(', ')} refuse a bad id with an error that has no 400/404 status (it shows up as a 500 in the error log)`) : pass('a path-like id is refused by details, chapters and pages');
}

// Asks the genre search for each never-listed name. Returns { failure } when one of them gave titles, else what was learned.
async function probeNeverListed(ctx) {
  const { mod, call, collect, filtersWith } = ctx;
  const probed = [];
  let inconclusive = 0;
  if (typeof mod.byGenres !== 'function') return { probed, inconclusive };
  for (const name of NEVER_LISTED_PROBES) {
    try {
      const result = await call('byGenres', () => mod.byGenres([name], '', filtersWith(), 1), { expected: true });
      collect(result);
      if (result && Array.isArray(result.results) && result.results.length > 0) return { failure: `byGenres(["${name}"]) returned ${result.results.length} titles: that category is never listed` };
      probed.push(name);
    } catch (err) {
      rethrowRunEnders(err);
      if (looksLikeSiteProblem(err) && !isBadInputStatus(err)) inconclusive += 1; else probed.push(name); // a refusal is also "not listed"
    }
  }
  return { probed, inconclusive };
}

async function checkNeverListed(ctx) {
  const { run } = ctx;
  const asked = await probeNeverListed(ctx);
  if (asked.failure) return fail(asked.failure);
  const tagged = run.seen.filter((item) => genreNames(item).some((g) => namesNeverListedCategory(g)));
  if (tagged.length) return fail(`${tagged.length} of the ${run.seen.length} titles it returned carry a category that is never listed`);
  if (asked.inconclusive > 0 && asked.probed.length === 0) return warn(`inconclusive: the site did not answer the ${asked.inconclusive} category searches`);
  const withTags = run.seen.filter((item) => genreNames(item).length > 0).length;
  return pass(`${asked.probed.length ? `${asked.probed.join(', ')} give nothing; ` : 'no genre search to probe; '}${withTags} of ${run.seen.length} titles carry tags and none is a never-listed one`);
}

const REFUSAL_CHECKS = Object.freeze([['missing-title', checkMissingTitle], ['bad-ids', checkBadIds], ['never-listed', checkNeverListed]]);

module.exports = { REFUSAL_CHECKS };
