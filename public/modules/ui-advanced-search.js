// ============================================================================
// ADVANCED SEARCH
// ============================================================================

// Every source module now internally stitches its own native pages up to
// a fixed size per dispatch call — 50 for all sources except BatCave,
// which is capped at 20 (2 native pages) because 50 there means 5 native
// pages each carrying its own ComicVine/LOCG enrichment pass, measured
// live at ~91s, well past the server's 30s per-call timeout (see
// data/sources/batcave.js's APP_PAGE_SIZE comment). Matching this value to
// the *largest* single-call size (50) means the fast path (no client-side
// filter active) needs exactly one dispatch call per app-page for 9 of the
// 10 sources, and the fill-up path below only needs extra iterations for
// BatCave or when a client-side filter is actually removing items.
const ADV_PAGE_SIZE = 50;
const ADV_MAX_API_PAGES = 20; // safety limit per "load more" chunk

// Infinite-scroll controller for Advanced Search results — see
// createLoadMoreController() in ui-search.js.
const _advSearchLoadMore = createLoadMoreController("advancedSearchPagination");

// Capability matrix based on practical API smoke tests per source.
// Only filters that are known to work are shown/enabled in the UI.
const ADV_SOURCE_CAPABILITIES = {
  default: {
    orderBy: true,
    publicationStatus: true,
    contentRating: false,
    format: true,
    genres: true,
  },
  mangadex: {
    orderBy: true,
    publicationStatus: true,
    contentRating: true,
    format: true,
    genres: true,
  },
  suwayomi: {
    // This source aggregates every Suwayomi-Server source's own search
    // endpoint, which only takes a search term + page number - no sort or
    // status/format/genre query params. Richer per-source Tachiyomi filters
    // exist behind a separate, stateful get/set-filters API this bridge
    // doesn't drive, so every control here would be decorative if enabled.
    orderBy: false,
    publicationStatus: false,
    contentRating: false,
    format: false,
    genres: false,
  },
  mangapill: {
    // orderBy declared true but reduced (see MANGAPILL_ORDER_BY_OPTIONS) -
    // the source's own code comments admit no server-side sort support
    // beyond a client-side title re-sort; everything else genuinely works
    // (buildSearchParams forwards real status/type/genre query params, and
    // enrichGenres() tags every result with real per-item genres/status/
    // format from detail pages, so the client-side re-filter never
    // wrongly rejects a correctly-filtered result here).
    orderBy: true,
    publicationStatus: true,
    contentRating: false,
    format: true,
    genres: true,
  },
  mangakatana: {
    // orderBy reduced (see MANGAKATANA_ORDER_BY_OPTIONS) - only a
    // client-side title re-sort is real. publicationStatus/format go
    // through a real but slow/capped enrichListMeta+applyLocalFilters
    // pass (first 24 rows only). genres is FALSE, not a capability gap but
    // a correctness one: byGenres() doesn't query a real genre endpoint at
    // all - it locally filters the homepage's small trending() list
    // (enriched for only its first 8 items), so a selected genre only ever
    // matches whatever happens to already be trending, never the real
    // catalog. Showing the control would look like genre search while
    // actually searching ~8-20 items - worse than hiding it.
    orderBy: true,
    publicationStatus: true,
    contentRating: false,
    format: true,
    genres: false,
  },
  allmanga: {
    // orderBy reduced (see ALLMANGA_ORDER_BY_OPTIONS) - sortResults() only
    // handles title/-title/relevance; the GraphQL query itself carries no
    // sort arg, so the other generic values are pure no-ops.
    // publicationStatus/contentRating/format/genres are all real (real
    // GraphQL genres arg + applyFilters() checking real per-item
    // status/contentRating/format, all populated by mapEdge on every item).
    orderBy: true,
    publicationStatus: true,
    contentRating: true,
    format: true,
    genres: true,
  },
  kingofshojo: {
    // genres IS real server-side (byGenres() hits a real /genre(s)/{slug}/
    // URL) - data/sources/kingofshojo.js now tags every returned item with
    // the requested genre name(s) after fetching, so the client-side
    // re-filter doesn't reject them for carrying only a type badge
    // ("Manhwa"/"Manhua") in the genres field, which is all parseCards()
    // has to offer on its own.
    orderBy: false,
    publicationStatus: false,
    contentRating: false,
    format: false,
    genres: true,
  },
  vortexscans: {
    // genres flipped to true - byGenres() already had real, working
    // GENRE_NAME_TO_ID-based filtering and correctly tagged its own
    // results, it just wasn't declared here (previously silently
    // defaulting the control to hidden despite working). Genre names with
    // no entry in that map now return an empty result instead of the
    // unfiltered trending() fallback the code used to silently fall back
    // to (see data/sources/vortexscans.js).
    orderBy: false,
    publicationStatus: false,
    contentRating: false,
    format: false,
    genres: true,
  },
  batcave: {
    // BatCave's own site-native "sort by" widget doesn't work (confirmed by
    // replaying its exact form submit through a real browser — the result
    // order never changes). orderBy IS enabled here, but only for the two
    // values backed by real, distinct data from BatCave's own homepage
    // widgets — see applyOrderByOptionsForSource, which swaps in a reduced
    // option list so the other generic values (title, year, follows...)
    // — which have no BatCave-side data — are never shown as decoration.
    orderBy: true,
    publicationStatus: false,
    contentRating: false,
    format: false,
    genres: true,
  },
  weebcentral: {
    // Genuinely supported server-side (data/sources/weebcentral.js's
    // mapOrderBy/mapFilters) — orderBy uses a reduced option list (see
    // WEEBCENTRAL_ORDER_BY_OPTIONS) since Year Asc/Desc has no analogue.
    // publicationStatus/format now also tag every result with the applied
    // filter value (search()/byGenres()) - parseResultCards() only ever
    // had a hardcoded 'unknown' status and no format field at all, so the
    // client-side re-filter used to reject every correctly-filtered result
    // for those two categories despite the server-side param genuinely
    // working - same underlying bug class the MangaFox source had.
    orderBy: true,
    publicationStatus: true,
    contentRating: false,
    format: true,
    genres: true,
  },
  demonicscans: {
    // Nothing beyond plain text search works on this site: search()/
    // trending() take no orderBy/filters params at all, and byGenres()
    // doesn't query a genre endpoint - it ignores the requested genre
    // entirely and returns unfiltered trending() instead, which would be
    // actively misleading if left enabled (looks like genre search, is
    // actually just "whatever's trending"). Previously undeclared here,
    // silently inheriting `default`'s optimistic capabilities though none
    // of them were ever implemented.
    orderBy: false,
    publicationStatus: false,
    contentRating: false,
    format: false,
    genres: false,
  },
  asurascans: {
    // /browse has no sort/status/format query params — only q/genre/page —
    // so those controls would silently do nothing if left enabled.
    orderBy: false,
    publicationStatus: false,
    contentRating: false,
    format: false,
    genres: true,
  },
  comichubfree: {
    // No query-param-driven sort or status/format filtering on this site
    // (popular-comic/new-comic/search-comic/{genre}-comic are the only
    // listing endpoints, none of them take a sort/status/format param).
    orderBy: false,
    publicationStatus: false,
    contentRating: false,
    format: false,
    genres: true,
  },
  mangahub: {
    // orderBy reduced (see MANGAHUB_ORDER_BY_OPTIONS) - resolveOrder() only
    // recognizes values containing "latest"/"update" (plus the literal
    // string "-createdat") as LATEST; every other value, including the
    // positive "createdAt" ("Recently Added") the generic dropdown offers,
    // silently falls through to ALPHABET - a source claiming to sort by
    // rating/year/follows but actually always sorting A-Z is exactly the
    // "decorative control" this matrix exists to prevent. publicationStatus
    // and format are entirely unused (filters.publicationStatus/filters.
    // format never referenced anywhere in the file, no `format` field ever
    // returned) despite previously inheriting `default`'s optimistic true -
    // genres is the one real, working, correctly-tagged filter here
    // (byGenres() slugifies into a real `genre=` query param).
    orderBy: true,
    publicationStatus: false,
    contentRating: false,
    format: false,
    genres: true,
  },
  manganato: {
    // Same "mangabox" site family as MangaFox, but never received the same
    // treatment - search() doesn't even accept orderBy/filters params, and
    // byGenres(), despite hitting a real /genre/{slug} URL server-side,
    // tagged every returned item with a hardcoded genres:[] (parseListCards
    // et al never set real per-item genres/status), so the client-side
    // re-filter rejected 100% of otherwise-correctly-filtered genre
    // results. byGenres() now tags results with the requested genre name.
    // Previously undeclared here, silently inheriting `default`.
    orderBy: false,
    publicationStatus: false,
    contentRating: false,
    format: false,
    genres: true,
  },
  mangafox: {
    // /search genuinely supports type=/st=/genres= as real, combinable
    // server-side filters (data/sources/mangafox.js's siteSearch) - status
    // is a plain completed/not-completed binary (no hiatus/cancelled
    // equivalent, those two values just come back empty, same as an
    // unsupported genre would on any source). No content-rating field
    // exists on the site at all.
    orderBy: true,
    publicationStatus: true,
    contentRating: false,
    format: true,
    genres: true,
  },
  flamecomics: {
    // A small curated catalog (166 series, fetched whole and cached client-
    // side in data/sources/flamecomics.js), not a scraped listing - every
    // filter/sort here is real, in-memory work over rich per-series fields
    // (likes/time/last_edit/year/status/type), not a guess or a decorative
    // control. No content-rating field exists on the site at all.
    orderBy: true,
    publicationStatus: true,
    contentRating: false,
    format: true,
    genres: true,
  },
  comizy: {
    // Confirmed live, param by param (fetched two different values, diffed
    // the actual results - not just the URLs): status=ongoing vs completed
    // and type=manga vs manhwa both return genuinely different, correctly-
    // tagged results (mapCard() carries real per-item status/genres from the
    // API, so the client-side re-filter never wrongly rejects a correctly
    // server-filtered result here). orderBy is real but reduced (see
    // COMIZY_ORDER_BY_OPTIONS) - ?sort=alphabetical returns 0 results every
    // time despite being a real option in Comizy's own dropdown, a bug on
    // their end (same class as ?sort=best_match, see resolveSort's comment
    // in the source file), and no "sort by year" equivalent exists at all.
    // publicationStatus only filters server-side through /search, not
    // through /genres/{slug} (confirmed live: status= is silently ignored
    // there) - left enabled anyway since the client-side re-filter still
    // correctly narrows byGenres() results, just less efficiently, matching
    // the same accepted partial-support pattern MangaKatana already uses.
    // No content-rating field exists on the site at all.
    orderBy: true,
    publicationStatus: true,
    contentRating: false,
    format: true,
    genres: true,
  },
};

// BatCave's own genre taxonomy (comics, not manga) — swapped in for the
// generic manga genre list below while it's the selected source, since most
// of those manga-specific tags (Doujinshi, Isekai, Shounen, ...) don't exist
// on BatCave and several of its own (Superhero, Zombies, Robots, ...) aren't
// in the generic list at all.
const BATCAVE_GENRES = [
  'Action', 'Adventure', 'Anthology', 'Anthropomorphic', 'Biography', 'Children',
  'Comedy', 'Crime', 'Drama', 'Family', 'Fantasy', 'Fighting', 'Graphic Novels',
  'Historical', 'Horror', 'Leading Ladies', 'LGBTQ', 'Literature', 'Manga',
  'Martial Arts', 'Mature', 'Military', 'Mini-Series', 'Movies & TV', 'Music',
  'Mystery', 'Mythology', 'Personal', 'Political', 'Post-Apocalyptic',
  'Psychological', 'Pulp', 'Religious', 'Robots', 'Romance', 'Satire',
  'School Life', 'Sci-Fi', 'Slice of Life', 'Sport', 'Spy', 'Superhero',
  'Supernatural', 'Suspense', 'Teen', 'Thriller', 'Vampires', 'Video Games',
  'War', 'Western', 'Zombies',
];

const NSFW_BATCAVE_GENRES = new Set(['Mature']);

// Comizy's own complete real genre list (71 total) — fetched live from
// /genres (the site's own genre index page carries the full taxonomy with
// slugs), not guessed or trimmed down to whatever the generic manga list
// already had. Explicit user request after finding the generic list only
// covered ~35 of these: each installed source should offer its own site's
// full genre set for browsing, not a lowest-common-denominator subset —
// "Search all sources" is the one place a merged/union list belongs
// (buildMergedGenreList below), not the per-source view. Comizy's own slugs
// are a plain lowercase-hyphenate of these display names throughout
// (confirmed against the real slug list, e.g. "Gender bender" -> "gender-
// bender"), so comizy.js's existing slugify() already reproduces every one
// of them correctly — no separate name->slug map needed here.
const COMIZY_GENRES = [
  'Action', 'Adaptation', 'Adult', 'Adventure', 'Anthology', 'Comedy', 'Comic',
  'Cooking', 'Demons', 'Doujinshi', 'Drama', 'Ecchi', 'Fantasy', 'Full Color',
  'Game', 'Gender Bender', 'Ghosts', 'Harem', 'Hentai', 'Historical', 'Horror',
  'Isekai', 'Josei', 'Long Strip', 'Magic', 'Manga', 'Manhua', 'Manhwa',
  'Martial Arts', 'Mature', 'Mecha', 'Medical', 'Military', 'Monster',
  'Monster Girls', 'Monsters', 'Music', 'Mystery', 'Office Workers', 'One Shot',
  'Police', 'Psychological', 'Reincarnation', 'Romance', 'School Life',
  'Sci-fi', 'Science Fiction', 'Shoujo', 'Shoujo Ai', 'Shounen', 'Shounen Ai',
  'Slice of Life', 'Smut', 'Soft Yaoi', 'Sports', 'Super Power', 'Superhero',
  'Supernatural', 'Thriller', 'Time Travel', 'Tragedy', 'Vampire', 'Vampires',
  'Video Games', 'Villainess', 'Web Comic', 'Webtoons', 'Worth the Read',
  'Yaoi', 'Yuri', 'Zombies',
];

// Same NSFW-flag convention the default list already uses for Ecchi/Mature/
// Smut (isNsfwTag() in utils.js does the actual result-side filtering off a
// fixed value set — this is the separate, checkbox-hiding half: which boxes
// even show up when "hide NSFW" is on).
const NSFW_COMIZY_GENRES = new Set([
  'Adult', 'Ecchi', 'Hentai', 'Mature', 'Monster Girls', 'Smut', 'Soft Yaoi',
  'Yaoi', 'Yuri',
]);

// Every list below (KingOfShojo through FlameComics) follows the exact same
// research methodology as COMIZY_GENRES above: each site's
// own genre/tag taxonomy was fetched live (site nav, filter UI, or API) and
// cross-checked against its scraper in data/sources/, not assumed to match
// the generic list. A handful of confirmed typos/duplicates/spam entries
// found on the live sites (e.g. KingOfShojo's "Zinchangmanga.net", "Moder")
// were dropped; everything else is kept verbatim, including odd casing,
// since that's what the real site actually uses as its filter value.

// KingOfShojo (kingofshojo.com) — 150 raw genre slugs found on the site's
// own Advanced Search dropdown, minus 10 confirmed typos/dupes/spam ("18"
// folded into "Adult", "Zinchangmanga.net", "Unknown", "Moder", "Rommance",
// "Voilence", "Si-fi", "Shojo" dup of "Shoujo", "ecchi 2"/"mature - 2" dupe
// fragments) and "Completed" (a status, not a genre — same reasoning
// ComicHubFree's Publisher/Status facets were kept out of its list below).
// The scraper (kingofshojo.js) has no hardcoded list of its own — it blindly
// slugifies whatever name it's given — so every one of these already works
// today, the gap was entirely on this app's side.
const KINGOFSHOJO_GENRES = [
  'Academy', 'Adaptation', 'Action', 'Adult', 'Adventure', 'Animal',
  'Apocalypse', 'Aristocracy', 'Artifact', 'Assassin', 'Blood', 'Bloody',
  'Boys Love', 'Business', 'childcare', 'Childhood Friends', 'College life',
  'Comedy', 'Comic', 'Cooking', 'Crazy MC', 'Crime', 'Crossdressin',
  'Dark Fantasy', 'Demon', 'Demons', 'Doujinshi', 'Drama', 'Dungeons',
  'Ecchi', 'Employee', 'Family', 'Fantasy', 'Fight', 'Fighting',
  'Full Color', 'Game', 'Gender Bender', 'GENDERSWAP', 'Ghosts', 'Growth',
  'Grumpy guy', 'Harem', 'healing', 'Historical', 'Horror', 'Hunter',
  'Hunters', 'Isekai', 'Josei', 'kids', 'Korean', 'Liexing', 'Loli',
  'LONG STRIP', 'MAfia', 'Magic', 'Magical', 'Manga', 'MANGATOON', 'Manhua',
  'Manhwa', 'Manhwa Hot', 'Martial Arts', 'Mature', 'Medical', 'Medicaldrama',
  'Military', 'Modern', 'Modern Fantasy', 'modern Romance', 'Monster',
  'Monsters', 'Murim', 'Music', 'Mystery', 'Necromancer', 'Ninja',
  'Nobility', 'Office Workers', 'Omegaverse', 'One shot', 'overpower',
  'Overpowered', 'Philosophical', 'Ping Ping Jun', 'Police', 'Political',
  'Psychological', 'Psychology', 'Rebirth', 'Regression', 'Reincarnation',
  'Returner', 'Reunion', 'Revenge', 'Reverse', 'Reverse harem', 'Romance',
  'Romantic Comedy', 'Royal family', 'Royalty', 'School Life', 'Sci-fi',
  'Seinen', 'Shoujo', 'Shoujo ai', 'Shounen', 'Shounen Ai', 'Shounentural',
  'Showbiz', 'Slice of life', 'SM/BDSM', 'Smut', 'Sports', 'Super power',
  'Superhero', 'Supernatural', 'superpower', 'Survival', 'Suspense',
  'System', 'Thriller', 'Time Travel', 'Tragedy', 'Transmigration',
  'Tsundere-gong', 'Urban', 'Vampire', 'Villainess', 'Violence', 'Web comic',
  'Webtoon', 'Webtoons', 'Wuxia', 'Yaoi', 'Yaoi(BL)', 'Yuri', 'Yuri (GL)',
];
const NSFW_KINGOFSHOJO_GENRES = new Set([
  'Adult', 'Ecchi', 'Loli', 'Mature', 'SM/BDSM', 'Smut',
]);

// VortexScans (vortexscans.org) — filters by numeric term ID, not a slug
// (see GENRE_NAME_TO_ID in vortexscans.js). 84 of the 91 real IDs found live
// are kept here; 7 confirmed duplicates/typos dropped ("terror" dup of
// "Horror", "shojo" dup of "Shoujo", "Fantas" typo of "Fantasy", "WEB COMIC"
// dup of "Webtoon"/"Webtoons", "bully" dup of "Bullying", "SciFi" dup of
// "Sci-Fi", "the proactive" — meaningless on its own). vortexscans.js's own
// GENRE_NAME_TO_ID map was extended to cover every name kept here.
const VORTEXSCANS_GENRES = [
  'Action', 'Drama', 'Shounen', 'Sports', 'Manhwa', 'Martial Arts', 'Comedy',
  'Fantasy', 'Horror', 'Seinen', 'Supernatural', 'Mature', 'Adventure',
  'Monsters', 'System', 'Reincarnation', 'Revenge', 'Slice Of Life',
  'Historical', 'Romance', 'Josei', 'Shoujo', 'School Life', 'elf',
  'Video Games', 'Webtoons', 'Murim', 'Restaurant', 'Webtoon',
  '+100 Chapter', 'Tower', 'Legendary', 'Dungeons', 'orphan', 'Sci-Fi',
  'Gore', 'Isekai', 'magic', 'blood', 'war', 'magic and sword', 'academy',
  'violence', 'Harem', 'Myth', 'OverpoweredMC', 'TerritoryManagement',
  'Swordsman', 'Necromancer', 'Mage', 'JackOfAllTrades', 'Artifacts',
  'CharacterGrowth', 'Mercenary', 'Elementals', 'Genius', 'Psychological',
  'Tragedy', 'Gender Bender', 'Streamer', 'office', 'Modern Fantasy',
  'super powers', 'mystery', 'Steampunk', 'SciFiAction', 'cyperpunk',
  'edgerunner', 'Neo-Noir', 'Thriller', 'Crime Mystery', 'Survival',
  'Corporate Conspiracy', 'Bullying', 'Delinquents', 'Twins',
  'Identity Switch', 'Family', 'Shonen', 'Urban', 'High IQ', 'Decisive',
  'Ruthless', 'the death game',
];
const NSFW_VORTEXSCANS_GENRES = new Set(['Mature']);

// WeebCentral (weebcentral.com) — the site calls this single 38-item
// taxonomy "Tag(s)" everywhere (no separate genre/tag split). Values are
// exact, case-sensitive strings sent straight through as `included_tag`
// (weebcentral.js's mapFilters/byGenres are pure pass-throughs) — casing
// here must match the site exactly (e.g. "Sci-fi" not "Sci-Fi").
const WEEBCENTRAL_GENRES = [
  'Action', 'Adult', 'Adventure', 'Comedy', 'Doujinshi', 'Drama', 'Ecchi',
  'Fantasy', 'Gender Bender', 'Harem', 'Hentai', 'Historical', 'Horror',
  'Isekai', 'Josei', 'Lolicon', 'Martial Arts', 'Mature', 'Mecha',
  'Mystery', 'Psychological', 'Romance', 'School Life', 'Sci-fi', 'Seinen',
  'Shotacon', 'Shoujo', 'Shoujo Ai', 'Shounen', 'Shounen Ai',
  'Slice of Life', 'Smut', 'Sports', 'Supernatural', 'Tragedy', 'Yaoi',
  'Yuri', 'Other',
];
const NSFW_WEEBCENTRAL_GENRES = new Set([
  'Adult', 'Ecchi', 'Hentai', 'Lolicon', 'Mature', 'Shotacon', 'Smut',
]);

// AsuraScans (asurascans.com) — all 34 genres the site's own filter dropdown
// has, confirmed exhaustive. No adult-tagged genre exists on this site at
// all. asurascans.js's byGenres() already slugifies any name correctly, no
// scraper change needed.
const ASURASCANS_GENRES = [
  'Action', 'Adventure', 'Comedy', 'Crazy MC', 'Dark Fantasy', 'Demon',
  'Drama', 'Dungeons', 'Fantasy', 'Game', 'Genius MC', 'Isekai', 'Kuchikuchi',
  'Magic', 'Martial Arts', 'Murim', 'Mystery', 'Necromancer', 'Overpowered',
  'Psychological', 'Regression', 'Reincarnation', 'Revenge', 'Romance',
  'School Life', 'Sci-fi', 'Shoujo', 'Shounen', 'System', 'Tower', 'Tragedy',
  'Transmigration', 'Villain', 'Violence',
];
const NSFW_ASURASCANS_GENRES = new Set();

// ComicHubFree (comichubfree.com) — genre-only subset of its homepage genre
// links (49 total); its Publisher facet (Marvel/DC Comics/Dark Horse) and
// Status facet (Ongoing/Completed) share the same `{slug}-comic` URL shape
// but are a different filter dimension, kept out of the genre grid on
// purpose. No adult-tagged genre exists on this site.
const COMICHUBFREE_GENRES = [
  'Action', 'Adventure', 'Anthology', 'Anthropomorphic', 'Biography',
  'Children', 'Comedy', 'Crime', 'Drama', 'Family', 'Fantasy', 'Fighting',
  'Graphic Novels', 'Historical', 'Horror', 'Leading Ladies', 'LGBTQ',
  'Literature', 'Manga', 'Martial Arts', 'Military', 'Mini-Series',
  'Movies & TV', 'Music', 'Mystery', 'Mythology', 'Personal', 'Political',
  'Post-Apocalyptic', 'Psychological', 'Pulp', 'Religious', 'Robots',
  'Romance', 'School Life', 'Sci-Fi', 'Slice of Life', 'Sport', 'Spy',
  'Superhero', 'Supernatural', 'Suspense', 'Teen', 'Thriller', 'Vampires',
  'Video Games', 'War', 'Western', 'Zombies',
];
const NSFW_COMICHUBFREE_GENRES = new Set();

// Manganato (manganato.gg) — the 56 genres in the site's own curated
// "Genres" nav widget (confirmed exhaustive). Deliberately excludes the
// separate /genre/all tag cloud (283 entries, mostly auto-aggregated
// near-duplicates and typos like "acton"/"supernatura"/literal years) —
// same call already made for the generic list elsewhere in this app: a
// maintained taxonomy beats an uncurated long tail. manganato.js's
// byGenres() already tags results with the requested genre, no scraper
// change needed.
const MANGANATO_GENRES = [
  'Action', 'Adaptation', 'Adult', 'Adventure', 'Boys Love',
  'Childhood Friends', 'Comedy', 'Demons', 'Doujinshi', 'Drama', 'Ecchi',
  'Erotica', 'Fantasy', 'Full Color', 'Gender Bender', 'Harem',
  'Heartwarming', 'Hentai', 'Historical', 'Isekai', 'Josei', 'Long Strip',
  'Magic', 'Manga', 'Manhua', 'Manhwa', 'Martial Arts', 'Mature', 'Mecha',
  'Monsters', 'Mystery', 'Netorare', 'Office Workers', 'One Shot',
  'Pornographic', 'Psychological', 'Reincarnation', 'Revenge', 'Romance',
  'School Life', 'Shoujo', 'Shounen', 'Slice of Life', 'Smut', 'SM/BDSM',
  'Super Power', 'Supernatural', 'Survival', 'Time Travel', 'Tragedy',
  'Transmigration', 'Vampires', 'Villainess', 'Webtoons', 'Yaoi', 'Yuri',
];
const NSFW_MANGANATO_GENRES = new Set([
  'Adult', 'Ecchi', 'Erotica', 'Hentai', 'Mature', 'Netorare',
  'Pornographic', 'Smut', 'SM/BDSM', 'Yaoi', 'Yuri',
]);

// MangaDex (api.mangadex.org) — MangaDex splits its own taxonomy into
// named groups (genre/theme/format/content, 77 tags total, each a UUID —
// Shounen/Seinen/Shoujo/Josei are a *different* API field,
// publicationDemographic, and already routed there separately in
// mangadex.js's byGenres()). All 4 non-demographic groups are combined
// here into one browsable list, matching how every other source's list
// already mixes genre/theme/format concepts together (e.g. Comizy's list
// includes "Doujinshi"/"Full Color" alongside "Action"/"Romance"). Every
// name below is mangadex.js's own live /manga/tag response's exact display
// name, so its existing live tagMap lookup resolves each one without any
// further mapping.
const MANGADEX_GENRES = [
  'Action', 'Adventure', "Boys' Love", 'Comedy', 'Crime', 'Drama', 'Fantasy',
  "Girls' Love", 'Historical', 'Horror', 'Isekai', 'Magical Girls', 'Mecha',
  'Medical', 'Mystery', 'Philosophical', 'Psychological', 'Romance',
  'Sci-Fi', 'Slice of Life', 'Sports', 'Superhero', 'Thriller', 'Tragedy',
  'Wuxia',
  'Aliens', 'Animals', 'Cooking', 'Crossdressing', 'Delinquents', 'Demons',
  'Genderswap', 'Ghosts', 'Gyaru', 'Harem', 'Incest', 'Loli', 'Mafia',
  'Magic', 'Mahjong', 'Martial Arts', 'Military', 'Monster Girls',
  'Monsters', 'Music', 'Ninja', 'Office Workers', 'Police',
  'Post-Apocalyptic', 'Reincarnation', 'Reverse Harem', 'Samurai',
  'School Life', 'Shota', 'Supernatural', 'Survival', 'Time Travel',
  'Traditional Games', 'Vampires', 'Video Games', 'Villainess',
  'Virtual Reality', 'Zombies',
  '4-Koma', 'Adaptation', 'Anthology', 'Award Winning', 'Doujinshi',
  'Fan Colored', 'Full Color', 'Long Strip', 'Official Colored', 'Oneshot',
  'Self-Published', 'Web Comic',
  'Gore', 'Sexual Violence',
];
const NSFW_MANGADEX_GENRES = new Set([
  'Gore', 'Sexual Violence', 'Incest', 'Loli', 'Shota',
]);

// MangaPill (mangapill.com) — all 46 checkbox values from its /search form,
// display label == the exact URL value (repeatable `?genre=` param). No
// separate tags taxonomy on this site.
const MANGAPILL_GENRES = [
  'Action', 'Adventure', 'Cars', 'Comedy', 'Dementia', 'Demons', 'Doujinshi',
  'Drama', 'Ecchi', 'Fantasy', 'Game', 'Gender Bender', 'Harem',
  'Historical', 'Horror', 'Isekai', 'Josei', 'Kids', 'Magic', 'Martial Arts',
  'Mecha', 'Military', 'Music', 'Mystery', 'Parody', 'Police',
  'Psychological', 'Romance', 'Samurai', 'School', 'Sci-Fi', 'Seinen',
  'Shoujo', 'Shoujo Ai', 'Shounen', 'Shounen Ai', 'Slice of Life', 'Space',
  'Sports', 'Super Power', 'Supernatural', 'Thriller', 'Tragedy', 'Vampire',
  'Yaoi', 'Yuri',
];
const NSFW_MANGAPILL_GENRES = new Set(['Ecchi', 'Yaoi', 'Yuri']);

// AllManga (allanime.day) — genres are free-text on this site (no enum),
// so this 72-entry list is an empirically-sampled union across ~400 real
// manga rather than a fixed catalog page — confirmed near-saturated (new
// values stopped appearing past ~300 samples). Filtering is case-sensitive
// exact-match server-side (verified live: "sci-fi" returns 0 results,
// "Sci-Fi" doesn't) — giving AllManga this dedicated list with the exact
// real casing fixes that silent-failure gap without needing an alias/case
// map in allmanga.js itself.
const ALLMANGA_GENRES = [
  'Action', 'Adult', 'Adventure', 'Cars', 'Comedy', 'Cooking', 'Crime',
  'Crossdressing', 'Dementia', 'Demons', 'Doujinshi', 'Drama', 'Ecchi',
  'Fantasy', 'Game', 'Gender Bender', "Girls' Love", 'Gyaru', 'Harem',
  'Hentai', 'Historical', 'Horror', 'Isekai', 'Josei', 'Kids', 'Loli',
  'Magic', 'Magical Girls', 'Manhua', 'Manhwa', 'Martial Arts', 'Mature',
  'Mecha', 'Medical', 'Military', 'Monster Girls', 'Music', 'Mystery',
  'One Shot', 'Parody', 'Philosophical', 'Police', 'Psychological',
  'Reincarnation', 'Reverse Harem', 'Romance', 'Samurai', 'School',
  'Sci-Fi', 'Seinen', 'Shota', 'Shoujo', 'Shoujo Ai', 'Shounen',
  'Shounen Ai', 'Slice of Life', 'Smut', 'Space', 'Sports', 'Super Power',
  'Superhero', 'Supernatural', 'Thriller', 'Tragedy', 'Vampire', 'Webtoons',
  'Wuxia', 'Yaoi', 'Youkai', 'Yuri', 'Zombies',
  "Boys' Love",
];
const NSFW_ALLMANGA_GENRES = new Set([
  'Adult', "Boys' Love", 'Crossdressing', 'Doujinshi', 'Ecchi',
  'Gender Bender', "Girls' Love", 'Harem', 'Hentai', 'Loli', 'Mature',
  'Reverse Harem', 'Shota', 'Shoujo Ai', 'Shounen Ai', 'Smut', 'Yaoi',
  'Yuri',
]);

// MangaHub (mangahub.io) — mirrors the MangaDex tag taxonomy almost 1:1
// plus its own demographic/content-rating/origin tags, all flattened into
// one `/genre/{slug}` filter surface (97 confirmed real, live-probed
// slugs). "Oneshot" is deliberately one word here (not "One Shot") —
// confirmed live the hyphenated "one-shot" slug returns 0 results, only
// the unhyphenated one works; mangahub.js's own slugifyGenre() produces
// the right slug from this exact spelling. No scraper change needed for
// every other entry — plain lowercase-hyphenate already matches.
const MANGAHUB_GENRES = [
  'Action', 'Adaptation', 'Adult', 'Adventure', 'Aliens', 'Animals',
  'Anthology', 'Award Winning', "Boys Love", 'Comedy', 'Cooking', 'Crime',
  'Crossdressing', 'Delinquents', 'Demons', 'Doujinshi', 'Drama', 'Ecchi',
  'Erotica', 'Fan Colored', '4-Koma', 'Fantasy', 'Full Color',
  'Gender Bender', 'Genderswap', 'Ghosts', 'Girls Love', 'Gore', 'Gyaru',
  'Harem', 'Hentai', 'Historical', 'Horror', 'Incest', 'Isekai', 'Josei',
  'Loli', 'Long Strip', 'Magic', 'Magical Girls', 'Mafia', 'Mahjong',
  'Manhua', 'Manhwa', 'Martial Arts', 'Mature', 'Mecha', 'Medical',
  'Military', 'Monster Girls', 'Monsters', 'Music', 'Mystery', 'Ninja',
  'Office Workers', 'Official Colored', 'Oneshot', 'Philosophical',
  'Police', 'Pornographic', 'Post-Apocalyptic', 'Psychological',
  'Reincarnation', 'Reverse Harem', 'Romance', 'Safe', 'Samurai',
  'School Life', 'Sci-fi', 'Seinen', 'Self-Published', 'Sexual Violence',
  'Shota', 'Shoujo', 'Shoujo Ai', 'Shounen', 'Shounen Ai', 'Slice of Life',
  'Smut', 'Sports', 'Suggestive', 'Superhero', 'Supernatural', 'Survival',
  'Thriller', 'Time Travel', 'Traditional Games', 'Tragedy', 'Vampires',
  'Video Games', 'Villainess', 'Virtual Reality', 'Web Comic', 'Webtoons',
  'Wuxia', 'Yaoi', 'Yuri', 'Zombies',
];
const NSFW_MANGAHUB_GENRES = new Set([
  'Adult', 'Ecchi', 'Erotica', 'Gore', 'Hentai', 'Incest', 'Loli', 'Mature',
  'Pornographic', 'Sexual Violence', 'Shota', 'Smut',
]);

// FlameComics (flamecomics.xyz) — 62 real category values aggregated across
// the entire live catalog (not sampled — every series has a `categories`
// field, `byGenres()` already matches these display strings directly,
// case-insensitively, no slug/id transform needed). This is a genuinely
// clean, non-explicit catalog — only the 3 borderline entries below are
// flagged NSFW, nothing pornographic exists in the data.
const FLAMECOMICS_GENRES = [
  'Academy', 'Action', 'Adventure', 'Apocalypse', 'Betrayal',
  'Calm Protagonist', 'Comedy', 'Cultivation', 'Dragons', 'Drama',
  'Dungeons', 'Ecchi', 'Ecchi comedy', 'Fantasy', 'Fusion Fantasy', 'Games',
  'Harem', 'Historical', 'Horror', 'Hunter', 'Isekai', 'Josei', 'Leveling',
  'Magic', 'Martial Arts', 'Mature', 'Military', 'Modern Fantasy',
  'Monster', 'Murim', 'Mystery', 'Noir', 'Novel', 'Official', 'Pokemon',
  'Post-Apocalyptic', 'Psychological', 'Regression', 'Reincarnation',
  'Revenge', 'Romance', 'School Life', 'Sci-fi', 'Seinen', 'Shoujo',
  'Shoujo Ai', 'Shounen', 'Slice of Life', 'Supernatural', 'Survival',
  'Sword and Magic', 'Swordmaster', 'System', 'Thriller', 'Time Travel',
  'Tragedy', 'Transmigration', 'Vampires', 'Video Games', 'VR', 'Youth',
  'Zombies',
];
const NSFW_FLAMECOMICS_GENRES = new Set(['Ecchi', 'Ecchi comedy', 'Mature']);

// One lookup covering every source with its own real taxonomy instead of
// the generic default list — batcave was the only entry here for a long
// time (comics, not manga genres); comizy followed the same
// pattern once its own full genre list was actually fetched and
// confirmed live rather than assumed to match the generic list.
const PER_SOURCE_GENRES = {
  batcave: { genres: BATCAVE_GENRES, nsfw: NSFW_BATCAVE_GENRES },
  comizy: { genres: COMIZY_GENRES, nsfw: NSFW_COMIZY_GENRES },
  kingofshojo: { genres: KINGOFSHOJO_GENRES, nsfw: NSFW_KINGOFSHOJO_GENRES },
  vortexscans: { genres: VORTEXSCANS_GENRES, nsfw: NSFW_VORTEXSCANS_GENRES },
  weebcentral: { genres: WEEBCENTRAL_GENRES, nsfw: NSFW_WEEBCENTRAL_GENRES },
  asurascans: { genres: ASURASCANS_GENRES, nsfw: NSFW_ASURASCANS_GENRES },
  comichubfree: { genres: COMICHUBFREE_GENRES, nsfw: NSFW_COMICHUBFREE_GENRES },
  manganato: { genres: MANGANATO_GENRES, nsfw: NSFW_MANGANATO_GENRES },
  mangadex: { genres: MANGADEX_GENRES, nsfw: NSFW_MANGADEX_GENRES },
  mangapill: { genres: MANGAPILL_GENRES, nsfw: NSFW_MANGAPILL_GENRES },
  allmanga: { genres: ALLMANGA_GENRES, nsfw: NSFW_ALLMANGA_GENRES },
  mangahub: { genres: MANGAHUB_GENRES, nsfw: NSFW_MANGAHUB_GENRES },
  flamecomics: { genres: FLAMECOMICS_GENRES, nsfw: NSFW_FLAMECOMICS_GENRES },
};

// What a source says about itself in meta.ui (server/modules/common/source-ui.js), as /api/state hands it over after
// validating it: its own filters, genre list and sort options. It comes BEFORE the per-id tables in this file, which stay
// as they were for the sources that have an entry there; a source that is only installed (the Import tool) needs none.
function getDeclaredUi(sourceId) {
  const ui = typeof state !== 'undefined' && state.installedSources ? state.installedSources[sourceId]?.ui : null;
  return ui && typeof ui === 'object' ? ui : null;
}

// The genre list of a source: { genres: [...], nsfw: Set } from its own declaration, else its entry in
// PER_SOURCE_GENRES, else null (the default list applies).
function getSourceGenreConfig(sourceId) {
  const ui = getDeclaredUi(sourceId);
  if (ui && Array.isArray(ui.genres) && ui.genres.length > 0) {
    // A declaration can only add to what the app already treats as adult (Hide NSFW): a genre the app itself knows as an adult
    // tag is flagged even when the declaration forgot to say so.
    const nsfw = new Set(Array.isArray(ui.nsfwGenres) ? ui.nsfwGenres : []);
    if (typeof isNsfwTag === 'function') ui.genres.forEach((name) => { if (isNsfwTag(name)) nsfw.add(name); });
    return { genres: ui.genres, nsfw };
  }
  return PER_SOURCE_GENRES[sourceId] || null;
}

let _defaultGenreGridHtml = null;
// The box above the genre list narrows the list to the names that contain what was typed (a class, not display, so the Hide NSFW and blacklist rules,
// which set display, are not undone). A list that is drawn again starts with an empty box.
function filterGenreList() {
  const box = $('genreSearchInput');
  const needle = box ? box.value.trim().toLowerCase() : '';
  document.querySelectorAll('#genreGrid .genre-check').forEach((label) => {
    label.classList.toggle('genre-filtered-out', needle !== '' && !String(label.textContent || '').toLowerCase().includes(needle));
  });
}

function resetGenreSearch() {
  const box = $('genreSearchInput');
  if (box) {
    box.value = '';
    // A source that takes tags typed by the person (meta.ui.customTags, validated by the server) says so in the box.
    box.placeholder = acceptsTypedTags() ? 'Search genres, or type a tag and press Enter' : 'Search genres...';
  }
  filterGenreList();
}

// Whether the source being searched lets the person type a tag of their own next to its genre list. Never in "search all sources": there is no one source.
function acceptsTypedTags() {
  const all = $('advancedSearchAllSourcesToggle');
  if (all && all.checked) return false;
  return getDeclaredUi(state.currentSourceId)?.customTags === true;
}

// Plain words only (the source reads a comma as the end of a tag and a leading dash as "leave out"), and never a category that is never offered.
const TYPED_TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N} '&.+!:()-]{0,38}$/u;
const TYPED_TAG_NEVER_RE = /(^|[^a-z])(loli|shota|toddler)/i;

// Enter in the genre box: a name that is in the list is ticked; any other word becomes a tag of the person's own (a ticked entry at the top of the list),
// when the source takes them. The entry is built from the text with DOM calls, never as markup.
function addTypedGenre() {
  const box = $('genreSearchInput');
  const grid = $('genreGrid');
  const raw = box ? box.value.trim() : '';
  if (!raw || !grid) return;
  const same = [...grid.querySelectorAll('input[type="checkbox"]')].find((cb) => cb.value.toLowerCase() === raw.toLowerCase());
  let target = same;
  if (!target) {
    if (!acceptsTypedTags()) return;
    if (!TYPED_TAG_RE.test(raw) || TYPED_TAG_NEVER_RE.test(raw)) {
      if (typeof showToast === 'function') showToast('Tags', 'That is not a tag this search can use.', 'error');
      return;
    }
    const label = document.createElement('label');
    label.className = 'genre-check genre-custom';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = raw;
    const name = document.createElement('span');
    name.textContent = raw;
    label.append(input, name);
    grid.prepend(label);
    target = input;
  }
  box.value = '';
  filterGenreList();
  if (!target.checked) {
    target.checked = true;
    target.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function removeTypedGenres() {
  document.querySelectorAll('#genreGrid .genre-custom').forEach((label) => label.remove());
}

let _genreGridSource = null; // which list is currently rendered: a source id with its own genre list, 'default', or 'merged'

function applyGenreGridForSource(sourceId) {
  const grid = $('genreGrid');
  if (!grid) return;

  if (_defaultGenreGridHtml === null) {
    _defaultGenreGridHtml = grid.innerHTML;
    _genreGridSource = 'default';
  }

  // advancedSearch() calls this on every search (not just on source
  // change) to keep filters in sync — rebuilding the list unconditionally
  // would wipe out whatever the user had just checked a moment earlier,
  // right before those checkboxes get read.
  const custom = getSourceGenreConfig(sourceId);
  // Keyed on what is rendered and not only on the id: a source that is replaced or updated while the page is open can declare
  // other genres under the same id, and a source id can never collide with the 'default' / 'merged' markers.
  const targetSource = custom ? `source:${sourceId}:${custom.genres.join('|')}:${[...custom.nsfw].join('|')}` : 'default';
  if (_genreGridSource === targetSource) return;

  if (custom) {
    grid.innerHTML = custom.genres.map(name => {
      const nsfwAttr = custom.nsfw.has(name) ? ' data-nsfw="1"' : '';
      return `<label class="genre-check"${nsfwAttr}><input type="checkbox" value="${escapeHtml(name)}"><span>${escapeHtml(name)}</span></label>`;
    }).join('');
  } else {
    grid.innerHTML = _defaultGenreGridHtml;
  }
  _genreGridSource = targetSource;
  if (typeof resetGenreSearch === 'function') resetGenreSearch();
}

// Parses the cached default genre grid HTML into a plain list instead of
// hardcoding a second copy of index.html's genre checkboxes that could
// silently drift out of sync with the markup there.
function getDefaultGenreList() {
  if (_defaultGenreGridHtml === null) return [];
  const tmp = document.createElement('div');
  tmp.innerHTML = _defaultGenreGridHtml;
  return [...tmp.querySelectorAll('.genre-check')]
    .map(label => ({ name: label.querySelector('input')?.value || '', nsfw: label.dataset.nsfw === '1' }))
    .filter(g => g.name);
}

// The taxonomy a genre value can belong to for a given source — a source
// with its own entry in PER_SOURCE_GENRES uses that; every other installed
// source shares the default manga list.
function getSourceGenreTaxonomy(sourceId) {
  const own = getSourceGenreConfig(sourceId);
  return own ? own.genres : getDefaultGenreList().map(g => g.name);
}

// Union of every taxonomy for "Search all sources", alphabetised so a
// merged list (default manga genres + every PER_SOURCE_GENRES entry,
// overlapping ones like "Horror"/"Romance" collapsed into one) is actually
// browsable instead of several unrelated lists awkwardly concatenated. This
// is the one place a merged/all-in-one genre list belongs — every
// individual per-source view uses that source's own full, real list
// instead (see PER_SOURCE_GENRES above).
function buildMergedGenreList() {
  const byKey = new Map(); // lowercase name -> { name, nsfw }
  const add = (name, nsfw) => {
    const key = name.toLowerCase();
    const existing = byKey.get(key);
    if (existing) existing.nsfw = existing.nsfw || nsfw;
    else byKey.set(key, { name, nsfw });
  };
  getDefaultGenreList().forEach(g => add(g.name, g.nsfw));
  Object.values(PER_SOURCE_GENRES).forEach(({ genres, nsfw }) => {
    genres.forEach(name => add(name, nsfw.has(name)));
  });
  // The genre lists the installed sources declared themselves (meta.ui).
  Object.keys(state.installedSources || {}).forEach((id) => {
    const declared = getDeclaredUi(id);
    if (declared && Array.isArray(declared.genres)) {
      const nsfw = new Set(Array.isArray(declared.nsfwGenres) ? declared.nsfwGenres : []);
      declared.genres.forEach(name => add(name, nsfw.has(name)));
    }
  });
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function applyMergedGenreGrid() {
  const grid = $('genreGrid');
  if (!grid) return;
  // Guard against wiping out checkboxes the user already ticked, same
  // reasoning as applyGenreGridForSource (called on every search, not
  // just when the toggle is first switched on).
  // The list changes when a source is installed, replaced or removed, so the marker carries what went into it.
  const mergedKey = 'merged:' + Object.keys(state.installedSources || {}).sort().map((id) => `${id}=${(getDeclaredUi(id)?.genres || []).length}`).join(',');
  if (_genreGridSource === mergedKey) return;
  grid.innerHTML = buildMergedGenreList().map(g => {
    const nsfwAttr = g.nsfw ? ' data-nsfw="1"' : '';
    return `<label class="genre-check"${nsfwAttr}><input type="checkbox" value="${escapeHtml(g.name)}"><span>${escapeHtml(g.name)}</span></label>`;
  }).join('');
  _genreGridSource = mergedKey;
  if (typeof resetGenreSearch === 'function') resetGenreSearch();
}

// "Search all sources" doesn't have one real source to gate filter
// visibility by. A previous version of this only showed a control when
// EVERY currently selectable source genuinely supported it, which made
// Sort By / Publication Status disappear entirely for the real 14-source
// install (only a couple of sources support each one) - correct but not
// what was actually wanted: every control is shown again, and instead the
// *value sent per source* is gated by that source's own capability matrix
// down in advancedSearchAllSources()'s worker, mirroring what
// advancedSearch() already does for a single selected source (see caps.*
// there). A source that can't honor a filter just never receives it and is
// never judged by it in the client-side re-filter, so its results show up
// unfiltered by that criterion instead of being wrongly emptied out -
// genuine per-source compatibility rather than an all-or-nothing gate.
function showAllAdvancedFilterControls() {
  const toggle = (id, enabled) => {
    const group = $(id)?.closest('.filter-group');
    if (group) group.style.display = enabled ? '' : 'none';
  };
  toggle('advancedFormat', true);
  toggle('advancedPublicationStatus', true);

  // Full generic list, not any one source's reduced set - a value a given
  // source doesn't support just falls back to that source's own default
  // order (see the per-source gating below), never empties its results.
  applyOrderByOptionsForSource('default');
  const orderByGroup = $('advancedOrderBy')?.closest('.filter-group');
  if (orderByGroup) orderByGroup.style.display = '';

  const contentRatingGroup = $('advancedContentRatingGroup');
  if (contentRatingGroup) contentRatingGroup.style.display = state.settings.hideNsfw ? 'none' : '';

  // Genres: already a multi-pick with its own real per-source degradation
  // (advancedSearchAllSources() only sends a source the genres that exist
  // in ITS taxonomy, and skips it outright if none match) - left untouched.
  const genreGroup = $('genreFilterGroup');
  if (genreGroup) genreGroup.style.display = '';
}

// The values here are the only ones batcave.js actually has real data for
// (see search() there) — BatCave's own site-native sort widget doesn't
// work, so the other generic options (Title, Year, Most Follows...) would
// just silently do nothing if left in the dropdown for this source.
const BATCAVE_ORDER_BY_OPTIONS = [
  { value: 'relevance', label: 'Best Match' },
  { value: 'latestUploadedChapter', label: 'Latest Upload' },
  { value: 'rating', label: 'Highest Rating' },
];

// WeebCentral genuinely supports server-side sorting (see data/sources/
// weebcentral.js's mapOrderBy) for exactly these values — Year Asc/Desc has
// no analogue on that site, so it's left out rather than silently no-op'ing.
const WEEBCENTRAL_ORDER_BY_OPTIONS = [
  { value: 'relevance', label: 'Best Match' },
  { value: 'latestUploadedChapter', label: 'Latest Updates' },
  { value: 'createdAt', label: 'Recently Added' },
  { value: 'followedCount', label: 'Most Subscribers' },
  { value: 'rating', label: 'Most Popular' },
  { value: 'title', label: 'Title (A-Z)' },
  { value: '-title', label: 'Title (Z-A)' },
];

// MangaFox's own "sort" query param is decorative (confirmed live: any
// non-empty value returns identical results to the last one tried, and the
// reference Kotlin extension never wired a real SortFilter for it either).
// These two values are the only ones with genuine, distinct backing - they
// route to the site's own separate /directory/ views instead of a sort
// param (see search()'s comment in data/sources/mangafox.js) - so Title/
// Rating/Most Follows/Year, which have no MangaFox-side equivalent, are
// left out rather than silently no-op'ing.
const MANGAFOX_ORDER_BY_OPTIONS = [
  { value: 'relevance', label: 'Best Match' },
  { value: 'latestUploadedChapter', label: 'Latest Updates' },
  { value: 'createdAt', label: 'Recently Added' },
];

// mangapill.js's own comment: no server-side sort support at all — only a
// client-side title re-sort. Every other generic value would silently no-op.
const MANGAPILL_ORDER_BY_OPTIONS = [
  { value: 'relevance', label: 'Best Match' },
  { value: 'title', label: 'Title (A-Z)' },
  { value: '-title', label: 'Title (Z-A)' },
];

// mangakatana.js's sortLocal() only re-sorts by title client-side — same
// reasoning as MangaFox/MangaPill above.
const MANGAKATANA_ORDER_BY_OPTIONS = [
  { value: 'relevance', label: 'Best Match' },
  { value: 'title', label: 'Title (A-Z)' },
  { value: '-title', label: 'Title (Z-A)' },
];

// allmanga.js's sortResults() only handles title/-title (client-side) and
// relevance (no-op passthrough) — the GraphQL query itself carries no sort
// arg, so rating/followedCount/createdAt/year would silently no-op.
const ALLMANGA_ORDER_BY_OPTIONS = [
  { value: 'relevance', label: 'Best Match' },
  { value: 'title', label: 'Title (A-Z)' },
  { value: '-title', label: 'Title (Z-A)' },
];

// mangahub.js's resolveOrder() only recognizes values containing "latest"/
// "update" (plus the literal string "-createdat") as its real LATEST sort -
// everything else, including the positive "createdAt" the generic dropdown
// offers, silently collapses to an alphabetical fallback.
const MANGAHUB_ORDER_BY_OPTIONS = [
  { value: 'relevance', label: 'Best Match' },
  { value: 'latestUploadedChapter', label: 'Latest Updates' },
];

// comizy.js's own resolveSort() comment has the full story: ?sort=
// alphabetical is a real option in Comizy's own UI but returns 0 results
// live (a site-side bug), and no "sort by year" equivalent exists at all -
// so Title A-Z/Z-A and Year Asc/Desc are left out entirely rather than
// silently falling back to relevance for a control that claims to do
// something else.
const COMIZY_ORDER_BY_OPTIONS = [
  { value: 'relevance', label: 'Best Match' },
  { value: 'latestUploadedChapter', label: 'Latest Upload' },
  { value: 'createdAt', label: 'Recently Added' },
  { value: 'rating', label: 'Highest Rating' },
  { value: 'followedCount', label: 'Most Follows' },
];

const CUSTOM_ORDER_BY_OPTIONS = {
  batcave: BATCAVE_ORDER_BY_OPTIONS,
  weebcentral: WEEBCENTRAL_ORDER_BY_OPTIONS,
  mangafox: MANGAFOX_ORDER_BY_OPTIONS,
  mangapill: MANGAPILL_ORDER_BY_OPTIONS,
  mangakatana: MANGAKATANA_ORDER_BY_OPTIONS,
  allmanga: ALLMANGA_ORDER_BY_OPTIONS,
  mangahub: MANGAHUB_ORDER_BY_OPTIONS,
  comizy: COMIZY_ORDER_BY_OPTIONS,
};

let _defaultOrderByHtml = null;
let _orderBySource = null; // which option list is currently rendered: a key of CUSTOM_ORDER_BY_OPTIONS, or 'default'

function applyOrderByOptionsForSource(sourceId) {
  const select = $('advancedOrderBy');
  if (!select) return;

  if (_defaultOrderByHtml === null) {
    _defaultOrderByHtml = select.innerHTML;
    _orderBySource = 'default';
  }

  // Same reasoning as applyGenreGridForSource: this runs on every search,
  // not just on source change, so skip the rebuild once the right list is
  // already showing or it would reset whatever the user just picked.
  const options = getSourceOrderByOptions(sourceId);
  const targetSource = options ? `source:${sourceId}:${options.map((o) => `${o.value}=${o.label}`).join('|')}` : 'default';
  if (_orderBySource === targetSource) return;

  select.innerHTML = options
    ? options.map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('')
    : _defaultOrderByHtml;
  _orderBySource = targetSource;
}

// The sort options of a source: the list it declared (meta.ui), else its entry in CUSTOM_ORDER_BY_OPTIONS, else null.
function getSourceOrderByOptions(sourceId) {
  const ui = getDeclaredUi(sourceId);
  if (ui && Array.isArray(ui.orderBy) && ui.orderBy.length > 0) return ui.orderBy;
  return CUSTOM_ORDER_BY_OPTIONS[sourceId] || null;
}

// Which filters a source really honours: the default, then its entry in ADV_SOURCE_CAPABILITIES, then what it declared
// in meta.ui.filters (the declaration is the closest to the code that does the filtering, so it wins).
function getAdvancedSourceCapabilities(sourceId) {
  const declared = getDeclaredUi(sourceId)?.filters;
  return { ...ADV_SOURCE_CAPABILITIES.default, ...(ADV_SOURCE_CAPABILITIES[sourceId] || {}), ...(declared && typeof declared === 'object' ? declared : {}) };
}

function updateAdvancedSearchFilterVisibility(sourceId = state.currentSourceId) {
  const caps = getAdvancedSourceCapabilities(sourceId);
  applyGenreGridForSource(sourceId);
  applyOrderByOptionsForSource(sourceId);

  const toggleGroupBySelectId = (selectId, enabled) => {
    const sel = $(selectId);
    const group = sel?.closest('.filter-group');
    if (group) group.style.display = enabled ? '' : 'none';
    if (!enabled && sel) {
      sel.value = (selectId === 'advancedOrderBy') ? 'relevance' : '';
    }
  };

  toggleGroupBySelectId('advancedOrderBy', caps.orderBy);
  toggleGroupBySelectId('advancedFormat', caps.format);
  toggleGroupBySelectId('advancedPublicationStatus', caps.publicationStatus);

  const contentRatingGroup = $('advancedContentRatingGroup');
  if (contentRatingGroup) contentRatingGroup.style.display = caps.contentRating ? '' : 'none';
  const contentRatingSel = $('advancedContentRating');
  if (!caps.contentRating && contentRatingSel) contentRatingSel.value = '';

  const genreGroup = $('genreFilterGroup');
  if (genreGroup) genreGroup.style.display = caps.genres ? '' : 'none';
  if (!caps.genres) {
    document.querySelectorAll('#genreGrid input[type="checkbox"]').forEach(cb => cb.checked = false);
  }

  // Source capability changes can affect pagination/fill-up cache validity.
  state._advAcc = null;

  // Keep NSFW hiding rules on top of capability visibility.
  applyAdvancedSearchNsfwVisibility();
}

function applyAdvancedSearchNsfwVisibility() {
  const hideNsfw = state.settings.hideNsfw === true;
  const blacklist = state.settings.genreBlacklist || [];
  let changed = false;

  const contentRatingGroup = $("advancedContentRatingGroup");
  if (contentRatingGroup) {
    const caps = getAdvancedSourceCapabilities(state.currentSourceId);
    contentRatingGroup.style.display = (hideNsfw || !caps.contentRating) ? "none" : "";
  }

  const contentRatingSel = $("advancedContentRating");
  if (hideNsfw && contentRatingSel && contentRatingSel.value) {
    contentRatingSel.value = "";
    changed = true;
  }

  document.querySelectorAll('#genreGrid .genre-check').forEach(label => {
    const cb = label.querySelector('input[type="checkbox"]');
    const isNsfw = label.dataset.nsfw === "1";
    const val = (cb?.value || "").toLowerCase();
    const isBlacklisted = blacklist.includes(val);

    const shouldHide = (hideNsfw && isNsfw) || isBlacklisted;
    label.style.display = shouldHide ? "none" : "";

    if (shouldHide && cb?.checked) {
      cb.checked = false;
      changed = true;
    }
  });

  return changed;
}

function _normalizeFormat(value) {
  const raw = String(value || '').toLowerCase().trim();
  if (!raw) return '';
  if (raw.includes('one') && raw.includes('shot')) return 'oneshot';
  if (raw.includes('manhwa') || raw.includes('webtoon')) return 'manhwa';
  if (raw.includes('manhua')) return 'manhua';
  if (raw.includes('doujin')) return 'doujinshi';
  if (raw.includes('manga')) return 'manga';
  return raw;
}

function _inferFormat(manga) {
  const fromField = _normalizeFormat(manga?.format);
  if (fromField) return fromField;
  const genres = Array.isArray(manga?.genres) ? manga.genres : [];
  for (const g of genres) {
    const n = _normalizeFormat(g);
    if (['manga', 'manhwa', 'manhua', 'doujinshi', 'oneshot'].includes(n)) return n;
  }
  return '';
}

function _inferContentRating(manga) {
  const explicit = String(manga?.contentRating || '').toLowerCase();
  if (['safe', 'suggestive', 'erotica', 'pornographic'].includes(explicit)) return explicit;

  const tags = new Set((Array.isArray(manga?.genres) ? manga.genres : []).map(g => String(g).toLowerCase()));
  if (tags.has('hentai') || tags.has('smut') || tags.has('mature') || tags.has('adult') || tags.has('ecchi')) return 'erotica';
  if (tags.has('suggestive')) return 'suggestive';
  return 'safe';
}

function _normalizeStatus(value) {
  const s = String(value || '').toLowerCase();
  if (s.includes('ongoing') || s.includes('publishing') || s.includes('releasing')) return 'ongoing';
  if (s.includes('complet') || s.includes('finished')) return 'completed';
  if (s.includes('hiatus')) return 'hiatus';
  if (s.includes('cancel')) return 'cancelled';
  return s;
}

/**
 * Apply client-side filters to a batch of results.
 * Returns only items that pass all active filter criteria.
 */
function _applyAdvFilters(results, query, selectedGenres, publicationStatus, contentRating, format) {
  let out = results;
  const hideNsfw = state.settings.hideNsfw === true;

  if (hideNsfw) {
    out = out.filter(m => !isNsfwManga(m));
  }

  const blacklist = state.settings.genreBlacklist || [];
  if (blacklist.length > 0) {
    out = out.filter(m => {
      if (!Array.isArray(m.genres)) return true;
      const lowerGenres = m.genres.map(g => typeof g === 'string' ? g.toLowerCase() : '');
      return !lowerGenres.some(g => blacklist.includes(g));
    });
  }

  if (query) {
    const q = query.toLowerCase();
    out = out.filter(m => (m.title || "").toLowerCase().includes(q));
  }
  if (selectedGenres.length > 0) {
    const wanted = new Set(selectedGenres.map(g => String(g).toLowerCase()));
    out = out.filter(m => {
      const genres = Array.isArray(m.genres) ? m.genres.map(g => String(g).toLowerCase()) : [];
      return genres.some(g => wanted.has(g));
    });
  }
  if (publicationStatus) {
    const targetStatus = _normalizeStatus(publicationStatus);
    out = out.filter(m => _normalizeStatus(m.status) === targetStatus);
  }
  if (contentRating) {
    out = out.filter(m => _inferContentRating(m) === contentRating.toLowerCase());
  }
  if (format) {
    const target = _normalizeFormat(format);
    out = out.filter(m => _inferFormat(m) === target);
  }
  return out;
}

async function advancedSearch(page = 1, isLoadMore = false) {
  const advAllToggle = $("advancedSearchAllSourcesToggle");
  if (advAllToggle && advAllToggle.checked) {
    // Don't gate filter visibility/genre taxonomy by whichever single
    // source happens to be parked in the (now disabled) source dropdown —
    // show every control and the merged genre list instead.
    applyMergedGenreGrid();
    showAllAdvancedFilterControls();
    applyAdvancedSearchNsfwVisibility();
    _advSearchLoadMore.clear(); // all-sources mode has no pagination of its own
    return advancedSearchAllSources();
  }

  // Load-more retries reuse the exact same source/filters as the search
  // they're continuing — re-syncing filter visibility here is redundant,
  // and actively wrong for it: this function unconditionally nulls
  // state._advAcc (its own comment: "capability changes can affect
  // pagination/fill-up cache validity"), which is the SAME accumulator the
  // favorites branch below relies on to remember its page cursor across
  // calls. Confirmed live: every single "Load More" click was wiping it
  // right back to page 1 before the favorites branch ever got to check it,
  // so scrolling for more favorites just re-fetched and re-appended the
  // same first page forever.
  if (!isLoadMore) {
    updateAdvancedSearchFilterVisibility(state.currentSourceId);
  } else {
    // updateAdvancedSearchFilterVisibility() itself is skipped above (it
    // nulls the pagination accumulator this load-more relies on), but the
    // NSFW/genre-blacklist visibility sync it would also have applied still
    // needs to run — otherwise a Settings change made while scrolled mid-list
    // keeps using stale checkbox/content-rating visibility until the next
    // fresh search.
    applyAdvancedSearchNsfwVisibility();
  }
  $("advancedResults")?.classList.remove("grouped-by-source");

  const caps = getAdvancedSourceCapabilities(state.currentSourceId);
  const query   = $("advancedSearchInput").value.trim();
  const orderBy = caps.orderBy ? $("advancedOrderBy").value : "relevance";
  const publicationStatus = caps.publicationStatus ? ($("advancedPublicationStatus")?.value || "") : "";
  const contentRating = (caps.contentRating && !state.settings.hideNsfw) ? ($("advancedContentRating")?.value || "") : "";
  const format = caps.format ? ($("advancedFormat")?.value || "") : "";
  let selectedGenres = caps.genres
    ? Array.from(document.querySelectorAll('#genreGrid input[type="checkbox"]:checked')).map(cb => cb.value)
    : [];
  if (state.settings.hideNsfw) {
    selectedGenres = selectedGenres.filter(g => !isNsfwTag(g));
  }

  // "local" is not a plugin source — fall back to the dropdown value or first installed source
  if (!state.currentSourceId || !state.installedSources[state.currentSourceId]) {
    const sel = $("advancedSourceSelect");
    const installed = getSelectableSourceIds();
    const fallback = (sel && installed.includes(sel.value)) ? sel.value : installed[0];
    if (!fallback) {
      $("advancedSearchStatus").textContent = "Select a source first.";
      return;
    }
    state.currentSourceId = fallback;
    if (sel) sel.value = fallback;
    const mainSel = $("sourceSelect");
    if (mainSel) mainSel.value = fallback;
  }

  state.advSearchPage = page;
  if (!isLoadMore) $("advancedSearchStatus").textContent = "Searching...";

  // ── Favorites sort option: filter user's library for this source ───────────
  if (orderBy === 'favorites') {
    state._advAcc = null;
    const favList = (state.favorites || []).filter(m => (m.sourceId || state.currentSourceId) === state.currentSourceId);
    let results = favList;
    if (query) {
      const q = query.toLowerCase();
      results = results.filter(m => (m.title || '').toLowerCase().includes(q));
    }
    if (selectedGenres.length > 0) {
      const wanted = new Set(selectedGenres.map(g => String(g).toLowerCase()));
      results = results.filter(m => {
        const genres = Array.isArray(m.genres) ? m.genres.map(g => String(g).toLowerCase()) : [];
        return genres.some(g => wanted.has(g));
      });
    }
    const resultsDiv = $("advancedResults");
    if (resultsDiv) {
      if (!results.length) {
        resultsDiv.innerHTML = `<div class="muted">No favorites found in your library for ${escapeHtml(state.currentSourceId)}</div>`;
        $("advancedSearchStatus").textContent = "0 result(s) found in Favorites";
        _advSearchLoadMore.clear();
        return;
      }
      renderMangaGrid(resultsDiv, results);
      $("advancedSearchStatus").textContent = `${results.length} favorite(s) found in library`;
      _advSearchLoadMore.clear();
    }
    return;
  }

  // Determine if any client-side filter is active
  const needsClientFilter = !!(publicationStatus || contentRating || format || selectedGenres.length > 0);
  const resultsDiv = $("advancedResults");

  // ── Fast path: no client filtering, use native API pagination ────────────
  if (!needsClientFilter) {
    state._advAcc = null; // invalidate accumulator cache
    try {
      let result;
      if (selectedGenres.length > 0) {
        result = await api(`/api/source/${state.currentSourceId}/byGenres`, {
          method: "POST",
          body: JSON.stringify({ genres: selectedGenres, page, orderBy, publicationStatus, contentRating, format })
        });
      } else {
        result = await api(`/api/source/${state.currentSourceId}/search`, {
          method: "POST",
          body: JSON.stringify({ query: query || "", page, orderBy, publicationStatus, contentRating, format })
        });
      }
      const rawResults = result.results || [];
      const normalizedResults = typeof normalizeSourceSearchResult === 'function' ? rawResults.map(m => normalizeSourceSearchResult(m, state.currentSourceId)).filter(Boolean) : rawResults;
      const results = await _filterMangaWithoutChapters(normalizedResults, state.currentSourceId);
      const hasNextPage = result.hasNextPage || false;
      state.advSearchHasNextPage = hasNextPage;

      if (!isLoadMore && !results.length) {
        resultsDiv.innerHTML = `<div class="muted">No results found</div>`;
        $("advancedSearchStatus").textContent = "0 result(s) found";
        _advSearchLoadMore.show(hasNextPage, () => advancedSearch(page + 1, true));
        return;
      }
      if (!isLoadMore) {
        renderMangaGrid(resultsDiv, results);
      } else if (results.length) {
        resultsDiv.insertAdjacentHTML("beforeend", results.map(m => mangaCardHTML(m)).join(""));
        bindMangaCards(resultsDiv);
        if (typeof _hydrateMissingGenres === 'function') _hydrateMissingGenres(resultsDiv);
      }
      $("advancedSearchStatus").textContent = formatLoadedStatus(resultsDiv.querySelectorAll(".manga-card").length);
      _advSearchLoadMore.show(hasNextPage, () => advancedSearch(page + 1, true));
    } catch (e) {
      if (!isLoadMore) {
        $("advancedSearchStatus").textContent = "Could not search manga.";
        _advSearchLoadMore.clear();
      } else {
        throw e; // propagates to the load-more controller's own error state
      }
    }
    return;
  }

  // ── Fill-up path: accumulate filtered results across API pages ────────────
  // Cache key: invalidate accumulator when source or any filter changes.
  const filterKey = [state.currentSourceId, query, selectedGenres.join(','), publicationStatus, contentRating, format, orderBy].join('|');

  // Reset accumulator on a fresh search (not a scroll-triggered load-more) —
  // renderedCount tracks how much of acc.results has already been painted
  // into #advancedResults, since infinite scroll always appends the delta
  // rather than re-slicing a specific "page".
  // Tracked separately from isLoadMore: a filter/genre change made mid-load-more
  // (e.g. by the NSFW visibility sync unchecking a now-blacklisted genre) can
  // also force a reset here even though isLoadMore itself is still true, and the
  // render decision below needs to know that happened.
  const accWasReset = !state._advAcc || state._advAcc.filterKey !== filterKey || !isLoadMore;
  if (accWasReset) {
    state._advAcc = { results: [], apiPage: 0, hasMore: true, filterKey, renderedCount: 0, fetching: false };
  }

  const acc = state._advAcc;
  // Same re-entrancy guard as the Favorites branch above, and for the same
  // reason: a fast scroll can fire the load-more sentinel more than once
  // before the shared controller's own "loading" flag blocks the next call.
  if (acc.fetching) return;
  acc.fetching = true;
  try {
  const target = acc.renderedCount + ADV_PAGE_SIZE;
  let fetchError = null;
  // ADV_MAX_API_PAGES bounds how many native-page fetches ONE load-more
  // round can make (so a heavily filtered search can't spin forever on a
  // single scroll trigger) — it's a per-round budget, not a lifetime one,
  // so acc.apiPage itself (which must keep advancing through the source's
  // real pagination across the whole scroll session) is never the thing
  // being capped here.
  let attemptsThisRound = 0;

  // Keep fetching API pages until we have enough filtered results (or run out)
  while (acc.results.length < target && acc.hasMore && attemptsThisRound < ADV_MAX_API_PAGES) {
    acc.apiPage++;
    attemptsThisRound++;
    // Each iteration below can take several seconds (cover enrichment against
    // ComicVine/LOCG runs server-side per item) — without this, the status
    // text sits frozen on "Searching..." for that whole time and looks stuck.
    $("advancedSearchStatus").textContent = `A procurar resultados... (${acc.results.length}/${target})`;
    try {
      let result;
      if (selectedGenres.length > 0) {
        result = await api(`/api/source/${state.currentSourceId}/byGenres`, {
          method: "POST",
          body: JSON.stringify({ genres: selectedGenres, page: acc.apiPage, orderBy, publicationStatus, contentRating, format })
        });
        acc.hasMore = result.hasNextPage || false;
      } else {
        result = await api(`/api/source/${state.currentSourceId}/search`, {
          method: "POST",
          body: JSON.stringify({ query: query || "", page: acc.apiPage, orderBy, publicationStatus, contentRating, format })
        });
        acc.hasMore = result.hasNextPage || false;
      }
      const rawResults = result.results || [];
      const normalizedResults = typeof normalizeSourceSearchResult === 'function' ? rawResults.map(m => normalizeSourceSearchResult(m, state.currentSourceId)).filter(Boolean) : rawResults;
      const filteredBatch = _applyAdvFilters(normalizedResults, query, selectedGenres, publicationStatus, contentRating, format);
      const batch = await _filterMangaWithoutChapters(filteredBatch, state.currentSourceId);
      acc.results.push(...batch);
    } catch (e) {
      fetchError = e;
      break;
    }
  }

  // The while loop above can await several times across multiple native
  // pages. If state._advAcc was replaced by a fresh search in the meantime,
  // acc now points at an accumulator belonging to a view that's no longer
  // showing — drop this round's results instead of writing them into the DOM.
  if (state._advAcc !== acc) return;

  if (fetchError && acc.results.length === acc.renderedCount) {
    if (!isLoadMore) {
      resultsDiv.innerHTML = `<div class="muted">Could not search manga.</div>`;
      $("advancedSearchStatus").textContent = "Could not search manga.";
      _advSearchLoadMore.clear();
      return;
    }
    throw fetchError; // propagates to the load-more controller's own error state
  }

  const newItems = acc.results.slice(acc.renderedCount);
  const hasNextPage = acc.hasMore;
  state.advSearchHasNextPage = hasNextPage;

  if (accWasReset && !acc.results.length) {
    resultsDiv.innerHTML = `<div class="muted">No results found</div>`;
    $("advancedSearchStatus").textContent = "0 result(s) found";
    _advSearchLoadMore.show(hasNextPage, () => advancedSearch(page, true));
    return;
  }
  if (accWasReset) {
    renderMangaGrid(resultsDiv, acc.results);
  } else if (newItems.length) {
    resultsDiv.insertAdjacentHTML("beforeend", newItems.map(m => mangaCardHTML(m)).join(""));
    bindMangaCards(resultsDiv);
    if (typeof _hydrateMissingGenres === 'function') _hydrateMissingGenres(resultsDiv);
  }
  acc.renderedCount = acc.results.length;
  $("advancedSearchStatus").textContent = formatLoadedStatus(acc.renderedCount);
  _advSearchLoadMore.show(hasNextPage, () => advancedSearch(page, true));
  } finally {
    acc.fetching = false;
  }
}

// Same "Search all sources" idea as the home search (see searchAllSources()
// and createSourceRevealController() in ui-search.js), adapted for Advanced
// Search's filters. Scoped down the same way: each source reveals results
// ADV_ALL_SOURCES_REVEAL_CHUNK at a time via a "+N more" button, not the
// multi-page "fill-up" accumulation advancedSearch() does for a single
// source — running that fill-up loop (up to ADV_MAX_API_PAGES native calls)
// across every source at once would be far too slow/heavy. Non-genre
// filters (sort, status, format) are sent as-is to every source — a source
// that doesn't support one already ignores it server-side (see
// ADV_SOURCE_CAPABILITIES). Genres are the one filter that isn't just
// "supported or not": the merged grid (see buildMergedGenreList) mixes two
// real taxonomies, so each source only gets sent the genres that actually
// exist in its own list (see getSourceGenreTaxonomy) — sources with none of
// the selected genres are skipped outright rather than queried with a
// wrong filter.
const ADV_ALL_SOURCES_REVEAL_CHUNK = 20;
const ADV_ALL_SOURCES_CONCURRENCY = 3;

async function advancedSearchAllSources() {
  const resultsDiv = $("advancedResults");
  const pg = $("advancedSearchPagination");
  if (pg) pg.innerHTML = "";
  if (!resultsDiv) return;

  const sources = getSelectableSources();
  if (!sources.length) {
    $("advancedSearchStatus").textContent = "No installed sources to search.";
    resultsDiv.classList.remove("grouped-by-source");
    resultsDiv.innerHTML = "";
    return;
  }

  const query = $("advancedSearchInput").value.trim();
  const orderBy = $("advancedOrderBy")?.value || "relevance";
  const publicationStatus = $("advancedPublicationStatus")?.value || "";
  const contentRating = state.settings.hideNsfw ? "" : ($("advancedContentRating")?.value || "");
  const format = $("advancedFormat")?.value || "";
  let selectedGenres = Array.from(document.querySelectorAll('#genreGrid input[type="checkbox"]:checked')).map(cb => cb.value);
  if (state.settings.hideNsfw) selectedGenres = selectedGenres.filter(g => !isNsfwTag(g));
  const needsClientFilter = !!(publicationStatus || contentRating || format || selectedGenres.length > 0);

  state.advSearchPage = 1;
  state._advAcc = null; // all-sources mode doesn't use the single-source fill-up accumulator
  $("advancedSearchStatus").textContent = `Searching ${sources.length} source(s)...`;

  resultsDiv.classList.add("grouped-by-source");
  resultsDiv.innerHTML = sources.map(s => `
    <div class="search-source-group" data-source-id="${escapeHtml(s.id)}">
      <div class="search-source-group-header">
        <span class="search-source-group-name">${escapeHtml(s.name)}</span>
        <span class="search-source-group-status">Searching…</span>
      </div>
      <div class="search-source-group-grid"></div>
      <div class="search-source-group-more"></div>
    </div>
  `).join("");

  let totalShown = 0;
  let doneCount = 0;
  let cursor = 0;

  function bumpStatus() {
    $("advancedSearchStatus").textContent = doneCount < sources.length
      ? `Searching... (${doneCount}/${sources.length} sources done, ${totalShown} result(s) so far)`
      : `${totalShown} result(s) shown across ${sources.length} source(s)`;
  }

  async function worker() {
    while (cursor < sources.length) {
      const source = sources[cursor++];
      const groupEl = resultsDiv.querySelector(`.search-source-group[data-source-id="${source.id}"]`);

      // The merged genre grid mixes two taxonomies (default manga genres +
      // BatCave's own comic genres) — only pass a source the genres that
      // actually exist in ITS taxonomy, so e.g. picking "Superhero" doesn't
      // get sent to MangaDex, which has no idea what that is.
      const sourceTaxonomy = selectedGenres.length ? new Set(getSourceGenreTaxonomy(source.id).map(g => g.toLowerCase())) : null;
      const sourceGenres = sourceTaxonomy ? selectedGenres.filter(g => sourceTaxonomy.has(g.toLowerCase())) : [];
      const genreMismatch = selectedGenres.length > 0 && sourceGenres.length === 0;

      if (genreMismatch) {
        const statusEl = groupEl?.querySelector(".search-source-group-status");
        if (statusEl) statusEl.textContent = "No matching genres";
        if (groupEl) groupEl.style.display = "none";
        doneCount++;
        bumpStatus();
        continue;
      }

      // Gate every single-value filter by what THIS source's own capability
      // matrix says it genuinely supports - same gating advancedSearch()
      // applies for a single selected source (see caps.orderBy/
      // publicationStatus/contentRating/format there). A source that can't
      // honor a filter never receives it server-side and is never judged by
      // it in _applyAdvFilters below, so it contributes its normal results
      // instead of having all of them wrongly rejected for an untagged
      // criterion it was never going to be able to satisfy.
      const caps = getAdvancedSourceCapabilities(source.id);
      const srcOrderBy = caps.orderBy ? orderBy : 'relevance';
      const srcPublicationStatus = caps.publicationStatus ? publicationStatus : '';
      const srcContentRating = (caps.contentRating && !state.settings.hideNsfw) ? contentRating : '';
      const srcFormat = caps.format ? format : '';

      const controller = createSourceRevealController({
        groupEl,
        chunkSize: ADV_ALL_SOURCES_REVEAL_CHUNK,
        fetchPage: async (nativePage) => {
          let result;
          if (sourceGenres.length > 0) {
            result = await api(`/api/source/${source.id}/byGenres`, {
              method: "POST",
              body: JSON.stringify({ genres: sourceGenres, page: nativePage, orderBy: srcOrderBy, publicationStatus: srcPublicationStatus, contentRating: srcContentRating, format: srcFormat })
            });
          } else {
            result = await api(`/api/source/${source.id}/search`, {
              method: "POST",
              body: JSON.stringify({ query: query || "", page: nativePage, orderBy: srcOrderBy, publicationStatus: srcPublicationStatus, contentRating: srcContentRating, format: srcFormat })
            });
          }
          const rawResults = result.results || [];
          let normalizedResults = rawResults.map(m => normalizeSourceSearchResult(m, source.id)).filter(Boolean);
          if (needsClientFilter) {
            normalizedResults = _applyAdvFilters(normalizedResults, query, sourceGenres, srcPublicationStatus, srcContentRating, srcFormat);
          }
          const items = await _filterMangaWithoutChapters(normalizedResults, source.id);
          return { items, hasNextPage: result.hasNextPage || false };
        },
      });

      try {
        totalShown += await controller.loadFirstPage();
      } catch (e) {
        // controller already set the "Unavailable" state on the group
      }

      doneCount++;
      bumpStatus();
    }
  }

  await Promise.all(Array.from({ length: Math.min(ADV_ALL_SOURCES_CONCURRENCY, sources.length) }, worker));
}

async function randomManga(options = {}) {
  const sourceIds = getSelectableSourceIds().filter(id => id !== 'local');
  const statusEl = $('advancedSearchStatus');
  const mode = options.mode || 'mixed'; // mixed | library | sources
  const selectedSourceIds = (options.sourceIds || []).filter(id => sourceIds.includes(id));
  const poolSourceIds = selectedSourceIds.length ? selectedSourceIds : sourceIds;

  // Build a combined pool: library + online results from selected sources
  let pool = [];

  // Add library when enabled in mode
  if (mode !== 'sources') {
    for (const m of (state.favorites || [])) {
      if (!m.sourceId || m.sourceId === 'local') continue;
      if (mode === 'library' || poolSourceIds.includes(m.sourceId)) {
        pool.push({ id: m.id, sourceId: m.sourceId });
      }
    }
  }

  // Add online results from a random selected source on a random page
  if (mode !== 'library' && poolSourceIds.length > 0) {
    const src = poolSourceIds[Math.floor(Math.random() * poolSourceIds.length)];
    const pg  = Math.floor(Math.random() * 15) + 1;
    if (statusEl) statusEl.textContent = 'Finding random manga...';
    try {
      const res = await api(`/api/source/${src}/search`, {
        method: 'POST',
        body: JSON.stringify({ query: '', page: pg })
      });
      for (const m of (res.results || [])) pool.push({ id: m.id, sourceId: src });
    } catch (_) { /* use library only if network fails */ }
  }

  if (!pool.length) {
    if (statusEl) statusEl.textContent = 'No manga found. Install a source or add manga to your library.';
    return;
  }

  const pick = pool[Math.floor(Math.random() * pool.length)];
  const prevSource = state.currentSourceId;
  state.currentSourceId = pick.sourceId;
  state._fromRandom = true;
  if (statusEl) statusEl.textContent = '';
  try {
    await loadMangaDetails(pick.id, 'random');
  } catch (e) {
    state.currentSourceId = prevSource;
    state._fromRandom = false;
    if (statusEl) statusEl.textContent = "Could not load manga details.";
  }
}

function closeRandomPickerDrawer() {
  document.getElementById('randomPickerBackdrop')?.remove();
  document.getElementById('randomPickerDrawer')?.remove();
}

function openRandomPickerDrawer() {
  closeRandomPickerDrawer();

  const sourceIds = getSelectableSourceIds().filter(id => id !== 'local');
  const sourceItems = sourceIds.map(id => {
    const label = state.installedSources[id]?.name || id;
    return `
      <label class="random-picker-source-item">
        <input type="checkbox" class="random-picker-source" value="${escapeHtml(id)}" checked>
        <span>${escapeHtml(label)}</span>
      </label>`;
  }).join('');

  const backdrop = document.createElement('div');
  backdrop.id = 'randomPickerBackdrop';
  backdrop.className = 'random-picker-backdrop';

  const drawer = document.createElement('div');
  drawer.id = 'randomPickerDrawer';
  drawer.className = 'random-picker-drawer';
  drawer.innerHTML = `
    <div class="random-picker-head">
      <h3>Random Manga</h3>
      <button class="btn secondary" id="randomPickerClose">\u2715</button>
    </div>
    <div class="random-picker-body">
      <div class="random-picker-mode-group">
        <label><input type="radio" name="randomMode" value="mixed" checked> Library + Sources</label>
        <label><input type="radio" name="randomMode" value="sources"> Sources only</label>
        <label><input type="radio" name="randomMode" value="library"> Library only</label>
      </div>
      <div class="random-picker-subtitle">Sources</div>
      <div class="random-picker-source-list">${sourceItems || '<div class="muted">No online sources installed.</div>'}</div>
      <div class="random-picker-actions">
        <button class="btn primary" id="randomPickerGo">Pick Random</button>
      </div>
    </div>`;

  document.body.appendChild(backdrop);
  document.body.appendChild(drawer);

  backdrop.onclick = closeRandomPickerDrawer;
  drawer.querySelector('#randomPickerClose').onclick = closeRandomPickerDrawer;

  drawer.querySelector('#randomPickerGo').onclick = async () => {
    const mode = drawer.querySelector('input[name="randomMode"]:checked')?.value || 'mixed';
    const selected = [...drawer.querySelectorAll('.random-picker-source:checked')].map(el => el.value);
    closeRandomPickerDrawer();
    await randomManga({ mode, sourceIds: selected });
  };
}

function initAdvancedFilters() {
  updateAdvancedSearchFilterVisibility(state.currentSourceId);

  const advSourceSel = $("advancedSourceSelect");
  if (advSourceSel) {
    advSourceSel.addEventListener("change", () => {
      updateAdvancedSearchFilterVisibility(advSourceSel.value);
    });
  }

  // Auto-refresh on dropdown changes
  const dropdownFilters = [
    "advancedOrderBy",
    "advancedPublicationStatus",
    "advancedContentRating",
    "advancedFormat"
  ];

  dropdownFilters.forEach(id => {
    const el = $(id);
    if (el) {
      el.onchange = () => {
        const view = document.querySelector("#view-advanced-search");
        if (view && !view.classList.contains("hidden")) advancedSearch();
      };
    }
  });

  // Genre checkboxes — debounced auto-search
  const genreGrid = $("genreGrid");
  if (genreGrid) {
    genreGrid.addEventListener("change", () => {
      const view = document.querySelector("#view-advanced-search");
      if (view && !view.classList.contains("hidden")) advancedSearch();
    });
  }

  const genreSearch = $("genreSearchInput");
  if (genreSearch) {
    genreSearch.addEventListener("input", filterGenreList);
    genreSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTypedGenre(); } });
  }

  // Clear genres button
  const clearBtn = $("clearGenresBtn");
  if (clearBtn) {
    clearBtn.onclick = () => {
      document.querySelectorAll('#genreGrid input[type="checkbox"]').forEach(cb => cb.checked = false);
      removeTypedGenres();
      const view = document.querySelector("#view-advanced-search");
      if (view && !view.classList.contains("hidden")) advancedSearch();
    };
  }

  // Genre section collapse toggle — persisted in localStorage
  const genreToggle = $("genreFilterToggle");
  const genreGroup  = $("genreFilterGroup");
  if (genreToggle && genreGroup) {
    // Restore saved state
    if (localStorage.getItem("genreFilterCollapsed") === "1") {
      genreGroup.classList.add("collapsed");
    }
    genreToggle.onclick = (e) => {
      if (e.target.closest('#clearGenresBtn')) return; // don't collapse when clearing
      genreGroup.classList.toggle("collapsed");
      localStorage.setItem("genreFilterCollapsed", genreGroup.classList.contains("collapsed") ? "1" : "0");
    };
  }
}

