// ============================================================================
// WHICH ANILIST TITLE IS THIS MANGA? (one answer for every place that has to ask)
// ============================================================================
// AniList's search ranks by TEXT, so for a short or common name its first answer is often another title: "Sugar" (2001, Arai Hideki) found "SUG*R" (2025), a boxing
// manga called "RRR" found a horror manhwa. Taking that first answer sent the cover's link to the wrong page, showed another title's recommendations, and, worst,
// linked the manga to the wrong entry, so the progress was written to someone else's title. Every place that has a title and needs the AniList id goes through here:
//
//   - the candidates are asked for (eight of them, with every name, the year, the popularity and the first staff);
//   - one is accepted only if it is CLEARLY the same title: any of its names alike enough to any name the page has (the app's own comparison, full-width letters
//     folded, a parenthesis compared apart), and, when both years are known, within a year of each other (two titles can share a name);
//   - the author is a soft signal: the same author raises the candidate, a different one lowers it, an unknown one changes nothing;
//   - between equally good candidates the more popular one wins ("Real" is a famous manga and a dozen doujinshi);
//   - with no clear candidate the answer is 0, and the caller does what it does for "not found" (a search page, no link written, no row) rather than guessing.
// The decisions are pure functions (anilistMatchPick, anilistSameAuthor), tested without a page.

const ANILIST_MATCH = Object.freeze({
  minSimilarity: 0.7,
  tieMargin: 0.02,    // names this close count as equally alike
  authorWeight: 0.15, // what a known author, the same or another, adds to or takes from a candidate's score
  searches: 2,        // the title, then the alternative title: at most two requests
});

const ANILIST_MATCH_QUERY = 'query ($search: String) { Page(perPage: 8) { media(search: $search, type: MANGA) { id title { romaji english native } synonyms popularity startDate { year } staff(perPage: 4) { nodes { name { full native } } } } } }';

const _anilistMatchText = (value, max) => String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
const _anilistMatchNorm = (text) => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** How alike two titles are, 0..1: the app's title comparison (ui-migrate.js) when the page has it, else equal after folding case and punctuation. */
function _anilistMatchSimilarity(a, b) {
  if (typeof _titleSimilarity === 'function') return _titleSimilarity(a, b);
  const x = _anilistMatchNorm(a);
  return x && x === _anilistMatchNorm(b) ? 1 : 0;
}

/** The forms of a name worth comparing: with full-width letters folded (the full-width RRR is RRR), whole, without a parenthesis, and the parenthesis alone. */
function anilistNameForms(name) {
  const whole = _anilistMatchText(name, 200).normalize('NFKC');
  if (!whole) return [];
  const forms = new Set([whole, whole.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()]);
  for (const inside of whole.matchAll(/\(([^)]+)\)/g)) forms.add(inside[1].trim());
  return [...forms].filter(Boolean);
}

const _anilistTokens = (text) => new Set(_anilistMatchNorm(text).split(' ').filter(Boolean));

/**
 * Whether a page's author is one of the people AniList lists for a title. Names are compared as sets of words, so "Arai Hideki" is "Hideki Arai"; a name written in
 * the native script counts when the page has it anywhere in its names.
 * @param {string} author   as the page has it (may be several people: "A, B")
 * @param {Array<{ name?: { full?: string, native?: string } }>} staff   AniList's staff nodes
 * @param {string[]} [pageNames]   the names the page has for the title (an alternative title may carry the author's native name)
 * @returns {boolean|null} null when it cannot be told (no author, or AniList lists nobody)
 */
function anilistSameAuthor(author, staff, pageNames = []) {
  const wanted = _anilistMatchText(author, 300).split(/[,;/&]| and /i).map((n) => _anilistTokens(n)).filter((t) => t.size > 0);
  const theirs = (Array.isArray(staff) ? staff : []).map((n) => (n && n.name) || {}).filter((n) => n.full || n.native);
  if (!wanted.length || !theirs.length) return null;
  const folded = (Array.isArray(pageNames) ? pageNames : []).map((n) => String(n || '').normalize('NFKC'));
  for (const person of theirs) {
    const full = _anilistTokens(person.full);
    for (const mine of wanted) {
      const common = [...mine].filter((w) => full.has(w)).length;
      if (full.size && common === mine.size && (mine.size >= 2 || full.size === 1)) return true; // all of the page's words are in the person's name
      if (full.size && common === full.size && full.size >= 2) return true;                       // or all of the person's words are in the page's
    }
    const native = String(person.native || '').normalize('NFKC').trim();
    if (native && folded.some((n) => n.includes(native))) return true;
  }
  return false;
}

/**
 * Which of the candidates AniList found is the title the page means: the id, or 0 when none is clearly it.
 * @param {Array<{ id: number, title?: object, synonyms?: string[], popularity?: number, startDate?: { year?: number }, staff?: { nodes?: Array } }>} candidates
 * @param {string[]} names   the title and the alternative titles the page knows
 * @param {{ year?: number, author?: string }} [known]
 */
function anilistMatchPick(candidates, names, known = {}) {
  const wanted = (Array.isArray(names) ? names : []).flatMap(anilistNameForms);
  const year = Number(known && known.year) || 0;
  const author = known && known.author;
  let best = { id: 0, score: 0, pop: -1 };
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const id = Number(candidate && candidate.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const theirYear = Number(candidate.startDate && candidate.startDate.year) || 0;
    if (year && theirYear && Math.abs(year - theirYear) > 1) continue;
    const t = candidate.title || {};
    const theirs = [t.romaji, t.english, t.native, ...(Array.isArray(candidate.synonyms) ? candidate.synonyms : [])].flatMap(anilistNameForms);
    let top = 0;
    for (const mine of wanted) for (const other of theirs) top = Math.max(top, _anilistMatchSimilarity(mine, other));
    if (top < ANILIST_MATCH.minSimilarity) continue;
    const same = anilistSameAuthor(author, candidate.staff && candidate.staff.nodes, names);
    const score = top + (same === true ? ANILIST_MATCH.authorWeight : (same === false ? -ANILIST_MATCH.authorWeight : 0));
    const pop = Number(candidate.popularity) || 0;
    if (score > best.score + ANILIST_MATCH.tieMargin || (Math.abs(score - best.score) <= ANILIST_MATCH.tieMargin && pop > best.pop)) best = { id, score, pop };
  }
  return best.id;
}

/**
 * Asks AniList for the candidates of a name and picks the one that is clearly the title (the title first, then, if that found no clear one, the alternative title).
 * @param {{ names: string[], year?: number, author?: string }} wanted
 * @returns {Promise<number>} the AniList id, or 0 (no clear match, nothing to search for, or AniList cannot be asked)
 */
async function anilistFindMediaId({ names, year, author } = {}) {
  const ask = typeof anilistGQL === 'function' ? anilistGQL : null;
  const list = (Array.isArray(names) ? names : []).map((n) => _anilistMatchText(n, 200)).filter(Boolean);
  if (!ask || !list.length) return 0;
  for (const search of [...new Set(list)].slice(0, ANILIST_MATCH.searches)) {
    const found = await ask(ANILIST_MATCH_QUERY, { search });
    const id = anilistMatchPick(found && found.data && found.data.Page && found.data.Page.media, list, { year, author });
    if (id) return id;
  }
  return 0;
}

/**
 * The AniList id of a manga the page shows: what the library linked it to, what the card that opened it said, else the checked match by name.
 * @param {{ id?: string, sourceId?: string, title?: string, altTitle?: string, year?: number|string, author?: string }} manga
 * @returns {Promise<number>} 0 when it is not known and no candidate is clearly it
 */
async function anilistMediaIdForManga(manga) {
  const m = manga && typeof manga === 'object' ? manga : { title: String(manga || '') };
  const linked = typeof _alGetLink === 'function' && m.id ? _alGetLink(m.id) : null;
  if (linked) return Number(linked) || 0;
  const hint = typeof similarAlHintFor === 'function' && m.sourceId && m.id ? similarAlHintFor(m.sourceId, m.id) : 0;
  if (hint) return hint;
  return anilistFindMediaId({ names: [m.title, m.altTitle], year: m.year, author: m.author });
}

window.ANILIST_MATCH = ANILIST_MATCH;
window.anilistNameForms = anilistNameForms;
window.anilistSameAuthor = anilistSameAuthor;
window.anilistMatchPick = anilistMatchPick;
window.anilistFindMediaId = anilistFindMediaId;
window.anilistMediaIdForManga = anilistMediaIdForManga;
