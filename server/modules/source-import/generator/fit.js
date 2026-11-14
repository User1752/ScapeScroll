'use strict';

const cheerio = require('cheerio');

// Does a template FIT the site it was picked for? An engine name says which software the site runs, not that its pages have the
// shape the template reads: a customised theme keeps the engine's scripts and changes its markup (measured: a site that is
// Madara by every fingerprint had none of the title-page, list or chapter-list markup of the theme). A source generated from a
// template that does not fit would "work" only by accident, so the generator looks for the few markers the template cannot do
// without, on the same pages the source will read, and refuses when one is missing.

// What each template needs, and on which page: [what, page, selector].
const MARKERS = Object.freeze({
  madara: [
    ['the title on a title page', 'detail', '.post-title h1, .post-title h3'],
    ['the cards of the title list', 'list', '.page-item-detail'],
    ['the cards of the text search', 'search', '.c-tabs-item__content'],
    // Where the theme puts a title's chapters (in the page, or in the answer of its own call): a site that fills the list in by a script of its own has none.
    ['the chapter list of a title', 'chapters', 'li.wp-manga-chapter'],
  ],
  mangathemesia: [
    ['the title on a title page', 'detail', 'h1.entry-title'],
    ['the chapter list on a title page', 'detail', '#chapterlist li'],
    ['the cards of the title list', 'list', '.listupd .bsx'],
  ],
  keyoapp: [
    ['the title on a title page', 'detail', 'div.grid > h1'],
    ['the chapter list on a title page', 'detail', '#chapters'],
    ['the cards of the title list', 'list', '#searched_series_page > button'],
  ],
});

/**
 * @param {string} engineId
 * @param {{ detail: string, list: string, search: string }} pages  the text of each page (a missing page is '')
 * @returns {{ fits: boolean, missing: string[] }}
 */
function checkFit(engineId, pages) {
  const wanted = MARKERS[engineId];
  if (!wanted) return { fits: false, missing: [`a template for "${engineId}"`] };
  const missing = [];
  for (const [what, page, selector] of wanted) {
    const html = String((pages && pages[page]) || '');
    if (!html) { missing.push(`${what} (the page could not be read)`); continue; }
    let found;
    try { found = cheerio.load(html.slice(0, 1_500_000))(selector).length; } catch (_) { found = 0; }
    if (!found) missing.push(what);
  }
  return { fits: missing.length === 0, missing };
}

module.exports = { checkFit, MARKERS };
