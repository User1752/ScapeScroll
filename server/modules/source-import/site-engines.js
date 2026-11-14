'use strict';

// Which site software a page was built with. Hundreds of manga sites are clones of a few engines, so naming the engine tells a
// source author where the search, the lists, the chapters and the images usually are, before a line of the source is written.
// It is a reading of the HTML and the headers only (nothing here touches the network), it says how sure it is, and it never
// decides a verdict: an unrecognised site is a custom one, not a wrong one.
//
// Every engine lists the signals it is known by; the number that matched gives the confidence (one weak signal is "low").

const ENGINES = Object.freeze([
  {
    id: 'madara', name: 'Madara (WordPress)',
    hint: 'search /?s=<q>&post_type=wp-manga, titles /manga/<slug>/, chapters by a POST to admin-ajax.php (action manga_get_chapters), images in .reading-content',
    signals: [/\/wp-content\/themes\/[^"'/]*madara/i, /\bwp-manga\b/, /class="[^"]*\bmanga-chapters-holder\b/, /\bwp-manga-chapter\b/, /\bmadara-(?:core|js)|madara\.js/i],
  },
  {
    id: 'mangathemesia', name: 'MangaThemesia / Mangastream (WordPress)',
    hint: 'search /?s=<q>, list /manga/?page=N&order=..., chapter images in a ts_reader.run({...}) JSON in the page, cards .bsx / .listupd',
    signals: [/ts_reader\.run\s*\(/, /\/wp-content\/themes\/(?:mangastream|mangareader|mangathemesia)/i, /id="readerarea"/, /class="[^"]*\blistupd\b/, /class="[^"]*\bbsx\b/, /\bts-main-image\b/],
  },
  {
    id: 'nettruyen', name: 'NetTruyen-style theme',
    hint: 'search /search?keyword=<q>, cards .items .item, filters /filter/<n>/?genres=<ids>, chapter images filled by /ajax/image/list/chap/<id>',
    signals: [/\/themes\/(?:nettruyen|liliana)\//i, /class="[^"]*\bpage-chapter\b/, /id="image_container"/, /\/ajax\/image\/list\/chap\//, /class="items"/],
  },
  {
    id: 'mangabox', name: 'MangaBox (Manganato family)',
    hint: 'search /search/story/<q>, chapter lists in .row-content-chapter, images in .container-chapter-reader',
    signals: [/row-content-chapter/, /container-chapter-reader/, /panel-story-chapter-list/, /\bmanganato\b|\bchapmanganato\b/i, /class="[^"]*\bstory_item\b/],
  },
  {
    id: 'foolslide', name: 'FoOlSlide',
    hint: 'reader under /read/<series>/<lang>/<vol>/<chapter>/, JSON in a `var pages = [...]` of the page',
    signals: [/FoOlSlide/i, /var\s+pages\s*=\s*\[/, /\/reader\/series\//i],
  },
  {
    id: 'htmx', name: 'htmx (server-rendered fragments)',
    hint: 'pages are made of fragments the page asks for with hx-get / hx-post: the chapter\'s images are usually one such fragment, found in the network calls of the reader (not in the chapter page itself)',
    signals: [/\bhx-(?:get|post)="/, /\bhx-trigger="/, /htmx(?:\.min)?\.js|unpkg\.com\/htmx/i],
  },
  {
    id: 'nextjs', name: 'Next.js',
    hint: 'the data is in the HTML (__NEXT_DATA__ or the self.__next_f payload): read it from the page, no JSON API needed',
    signals: [/<script id="__NEXT_DATA__"/, /self\.__next_f\.push/, /\/_next\/static\//],
  },
  {
    id: 'nuxt', name: 'Nuxt',
    hint: 'the state is in window.__NUXT__ in the page; an API behind it may need to be found in the scripts',
    signals: [/window\.__NUXT__/, /\/_nuxt\//],
  },
  {
    id: 'wordpress', name: 'WordPress (unknown theme)',
    hint: 'the REST API /wp-json/wp/v2/ is usually there and is a cleaner source of titles than the HTML',
    signals: [/\/wp-content\//, /\/wp-includes\//, /<meta name="generator" content="WordPress/i, /wp-json/],
    generic: true,
  },
]);

/**
 * @param {string} html
 * @param {Record<string, string>} [headers]  lower-cased response headers
 * @returns {{ id: string, name: string, hint: string, confidence: 'high'|'medium'|'low', evidence: string[] } | null}
 */
function detectEngine(html, headers = {}) {
  const text = String(html || '').slice(0, 1_500_000);
  const scored = [];
  for (const engine of ENGINES) {
    const evidence = engine.signals.filter((re) => re.test(text)).map((re) => String(re).slice(0, 60));
    if (headers['x-powered-by'] && /next\.js/i.test(headers['x-powered-by']) && engine.id === 'nextjs') evidence.push('x-powered-by: Next.js');
    if (evidence.length) scored.push({ engine, evidence });
  }
  if (!scored.length) return null;
  // A specific engine beats the generic WordPress one whenever it matched at all; then the most signals win.
  scored.sort((a, b) => (Number(!!a.engine.generic) - Number(!!b.engine.generic)) || (b.evidence.length - a.evidence.length));
  const top = scored[0];
  const confidence = top.evidence.length >= 3 ? 'high' : top.evidence.length === 2 ? 'medium' : 'low';
  return { id: top.engine.id, name: top.engine.name, hint: top.engine.hint, confidence, evidence: top.evidence };
}

module.exports = { detectEngine, ENGINES };
