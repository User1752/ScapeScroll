'use strict';

// From a link to a source file (generator/from-link.js) and its route (POST /api/sources/import/link). The network is replaced: the
// probe answers what a probe of a site would, and the pages are hand-written Madara / MangaThemesia markup. What is asserted is
// the decision at each step (refused at the probe, at the engine, at the fit; generated), that nothing is ever installed or
// written, and that the route stays on this computer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { generateFromLink } = require('../../server/modules/source-import/generator/from-link');
const { BadUrl } = require('../../server/modules/source-import/site-probe');
const importRoutes = require('../../server/routes/source-import');
const { isPrivilegedRoute } = require('../../server/middleware/local-only');

const BASE = 'https://mangas.example';
const MADARA_PAGES = {
  [`${BASE}/manga/t-one/`]: '<html><body><div class="post-title"><h1>T One</h1></div><ul><li class="wp-manga-chapter"><a href="https://mangas.example/manga/t-one/chapter-1/">Chapter 1</a><span class="chapter-release-date"><i>13/03/2026</i></span></li></ul></body></html>',
  [`${BASE}/manga/`]: '<html><body><div class="page-item-detail"></div></body></html>',
  [`${BASE}/?s=a&post_type=wp-manga`]: '<html><body><div class="c-tabs-item__content"></div></body></html>',
  [`${BASE}/`]: '<html><head><title>Home - Mangas Example</title></head><body></body></html>',
  [`${BASE}/?s=&post_type=wp-manga`]: '<form><input type="checkbox" name="genre[]" value="action" id="g1"><label for="g1">Action</label><input type="checkbox" name="genre[]" value="loli" id="g2"><label for="g2">Loli</label></form>',
};

const probeAnswer = (over = {}) => ({
  verdict: 'open',
  engine: { id: 'madara', name: 'Madara', confidence: 'high' },
  reasons: [{ severity: 'warn', text: 'A warning.' }, { severity: 'info', text: 'Only information.' }],
  robots: { checked: [] },
  pages: [{ label: 'home', finalUrl: `${BASE}/` }, { label: 'detail', finalUrl: `${BASE}/manga/t-one/` }],
  ...over,
});
const readerOf = (pages) => async (url) => { if (pages[url] === undefined) throw new Error('HTTP 404'); return pages[url]; };
const deps = (over = {}, pages = MADARA_PAGES) => ({ probeSite: async () => probeAnswer(over), readPageText: readerOf(pages) });

test('a site that is open, of a known engine, whose markup fits, gets a source written; nothing else happens', async () => {
  const result = await generateFromLink('mangas.example', { deps: deps() });
  assert.equal(result.status, 'generated');
  assert.equal(result.id, 'mangas');
  assert.equal(result.name, 'Mangas Example');
  assert.equal(result.engine, 'madara');
  assert.equal(result.dateOrder, 'dmy', 'a date whose first part is above 12 settles the order the site prints');
  assert.ok(result.code.includes('const DATE_ORDER = "dmy";'));
  assert.match(result.code, /module\.exports\s*=/);
  assert.equal(result.genres, 1, 'the never-listed genre is not offered');
  assert.equal(result.neverListedGenres, 1);
  assert.ok(result.notes.some((n) => /never lists/.test(n)), 'the person is told titles of a never-listed genre are left out');
  assert.deepEqual(result.probe.reasons.map((r) => r.severity), ['warn'], 'information is not repeated to the person');
});

test('a site that keeps its titles in another folder gets a source written for that folder; one that names a folder the list is not in is refused, not written', async () => {
  const inFolder = (folder) => Object.fromEntries(Object.entries(MADARA_PAGES).map(([url, html]) => [url.replace(`${BASE}/manga/`, `${BASE}/${folder}/`), html]));
  const pages = inFolder('series');
  const answer = { pages: [{ label: 'home', finalUrl: `${BASE}/` }, { label: 'detail', finalUrl: `${BASE}/series/t-one/` }] };
  const result = await generateFromLink('mangas.example', { deps: deps(answer, pages) });
  assert.equal(result.status, 'generated');
  assert.equal(result.subpath, 'series');
  assert.ok(result.code.includes('const SUB = "series";'));
  // The title page is in /series/ but the cards are not where the folder says: the fit check refuses it.
  const wrong = await generateFromLink('mangas.example', { deps: deps(answer, { ...pages, [`${BASE}/series/`]: '<html><body><div class="card"></div></body></html>' }) });
  assert.equal(wrong.status, 'refused');
  assert.equal(wrong.stage, 'fit');
  assert.match(wrong.message, /cards of the title list/);
  // The usual folder is still the default.
  assert.equal((await generateFromLink('mangas.example', { deps: deps() })).subpath, 'manga');
});

test('a site whose first title has no chapter yet is judged on the next ones; it is refused only when none of up to four titles has a readable chapter list', async () => {
  const row = (date) => `<ul><li class="wp-manga-chapter"><a href="${BASE}/manga/two/chapter-1/">Chapter 1</a><span class="chapter-release-date"><i>${date}</i></span></li></ul>`;
  const title = (extra = '') => `<html><body><div class="post-title"><h1>T</h1></div>${extra}</body></html>`;
  const list = `<html><body><div class="page-item-detail"><a href="${BASE}/manga/t-one/">1</a><a href="${BASE}/manga/two/">2</a><a href="${BASE}/manga/three/">3</a><a href="${BASE}/manga/four/">4</a><a href="${BASE}/manga/five/">5</a></div></body></html>`;
  const base = { ...MADARA_PAGES, [`${BASE}/manga/`]: list, [`${BASE}/manga/t-one/`]: title() };
  const posted = [];
  const emptyFirst = (answers) => ({ postChapterList: async (url) => { posted.push(url); return answers[url] || ''; }, sleep: async () => {} });
  const found = await generateFromLink('mangas.example', { deps: { ...deps({}, { ...base, [`${BASE}/manga/two/`]: title(row('13/03/2026')) }), ...emptyFirst({}) } });
  assert.equal(found.status, 'generated', 'the second title has chapters in its page');
  assert.equal(found.dateOrder, 'dmy', 'the dates are measured on the title that has chapters');
  assert.deepEqual(posted, [`${BASE}/manga/t-one/`], 'the theme\'s own call was made for the title that showed none, and no further once a title had them');
  posted.length = 0;
  const viaCall = await generateFromLink('mangas.example', { deps: { ...deps({}, base), ...emptyFirst({ [`${BASE}/manga/three/`]: row('03/13/2026') }) } });
  assert.equal(viaCall.status, 'generated', 'the third title answers the theme\'s own call with a list');
  assert.equal(viaCall.dateOrder, 'mdy');
  assert.deepEqual(posted, [`${BASE}/manga/t-one/`, `${BASE}/manga/two/`, `${BASE}/manga/three/`]);
  posted.length = 0;
  const none = await generateFromLink('mangas.example', { deps: { ...deps({}, base), ...emptyFirst({}) } });
  assert.equal(none.status, 'refused');
  assert.equal(none.stage, 'fit');
  assert.match(none.message, /the chapter list of a title/);
  assert.equal(posted.length, 4, 'no more than four titles are tried');
});

test('a robots.txt that forbids the text search is explained, with the size of the title index', async () => {
  const robots = { checked: [{ label: 'search', disallowed: true }] };
  const result = await generateFromLink('mangas.example', { deps: deps({ robots }) });
  assert.equal(result.status, 'generated');
  assert.equal(result.textSearch, false);
  assert.ok(result.notes.some((n) => /forbids its text search/.test(n) && /15 pages/.test(n)));
});

test('it stops at the probe when the site is not open, and says which verdict', async () => {
  for (const verdict of ['needs-solver', 'not-viable', 'unreachable']) {
    const result = await generateFromLink('mangas.example', { deps: deps({ verdict }) });
    assert.equal(result.status, 'refused');
    assert.equal(result.stage, 'probe');
    assert.match(result.message, new RegExp(verdict));
    assert.equal(result.code, undefined, 'no file is written for a site that is not open');
  }
});

test('a refusal at the probe names the site and says why, because the person only sees that sentence', async () => {
  const down = await generateFromLink('https://gone.example/path', { deps: deps({ verdict: 'unreachable', reasons: [{ severity: 'block', text: 'The site did not answer: fetch failed (ENOTFOUND).' }, { severity: 'info', text: 'Only information.' }] }) });
  assert.equal(down.status, 'refused');
  assert.equal(down.message, 'The site gone.example cannot be added from a link: the check came out "unreachable". The site did not answer: fetch failed (ENOTFOUND).');
  const bare = await generateFromLink('mangas.example', { deps: deps({ verdict: 'not-viable', reasons: [{ severity: 'warn', text: 'Only a warning.' }] }) });
  assert.equal(bare.message, 'The site mangas.example cannot be added from a link: the check came out "not-viable".', 'no blocking reason: the verdict alone, with the name');
  const many = await generateFromLink('mangas.example', { deps: deps({ verdict: 'not-viable', reasons: ['a', 'b', 'c'].map((x) => ({ severity: 'block', text: `Reason ${x}.   ${'x'.repeat(400)}` })) }) });
  assert.match(many.message, /Reason a\./);
  assert.match(many.message, /Reason b\./);
  assert.ok(!/Reason c/.test(many.message), 'two reasons at most');
  assert.ok(many.message.length < 600, 'and each is cut');
  assert.equal(many.probe.reasons.length, 3, 'the full list still travels with the answer');
});

test('it stops when the engine has no template, and when the template does not fit the markup', async () => {
  const unknown = await generateFromLink('mangas.example', { deps: deps({ engine: { id: 'nextjs', name: 'Next.js', confidence: 'high' } }) });
  assert.equal(unknown.stage, 'engine');
  assert.match(unknown.message, /by hand/);
  const none = await generateFromLink('mangas.example', { deps: deps({ engine: null }) });
  assert.equal(none.stage, 'engine');
  const custom = await generateFromLink('mangas.example', { deps: deps({}, { ...MADARA_PAGES, [`${BASE}/manga/`]: '<html><body><div class="card"></div></body></html>' }) });
  assert.equal(custom.status, 'refused');
  assert.equal(custom.stage, 'fit');
  assert.match(custom.message, /customised theme/);
});

test('an address that is not a site is a bad url, and the denylist reaches the probe', async () => {
  const bad = await generateFromLink('not a url', { deps: { probeSite: async () => { throw new BadUrl('That is not a web address.'); } } });
  assert.deepEqual(bad, { status: 'bad-url', message: 'That is not a web address.' });
  let seen = null;
  await generateFromLink('mangas.example', { denylist: ['danger.example'], deps: { ...deps(), probeSite: async (input, options) => { seen = options; return probeAnswer(); } } });
  assert.deepEqual(seen.denylist, ['danger.example']);
  await assert.rejects(generateFromLink('mangas.example', { deps: { probeSite: async () => { throw new Error('boom'); } } }), /boom/, 'a real fault is not hidden as a refusal');
});

// ── The route ─────────────────────────────────────────────────────────────

async function startRoute(t, generate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-link-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const denylistFile = path.join(dir, 'site-denylist.txt');
  fs.writeFileSync(denylistFile, '# my list\ndanger.example\n');
  importRoutes.configure({ stagingDir: path.join(dir, 'staging'), denylistFile, generate });
  const app = express();
  app.use(express.json());
  importRoutes.registerSourceImportRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  return (body, headers = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/sources/import/link', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('the link route is in the guard list and answers a generated source, a refusal, and a bad address', async (t) => {
  assert.equal(isPrivilegedRoute({ method: 'POST', originalUrl: '/api/sources/import/LINK/' }), true);
  const calls = [];
  const send = await startRoute(t, async (url, options) => {
    calls.push({ url, ...options });
    if (url === 'bad') return { status: 'bad-url', message: 'That is not a web address.' };
    if (url === 'closed.example') return { status: 'refused', stage: 'probe', message: 'Not open.', probe: { verdict: 'not-viable', reasons: [] } };
    return { status: 'generated', id: 'demo', name: 'Demo', code: 'exports.meta = {};', notes: [] };
  });
  const ok = await send({ url: '  mangas.example ', id: 'mine' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.status, 'generated');
  assert.equal(calls[0].url, 'mangas.example', 'the address is trimmed');
  assert.equal(calls[0].id, 'mine');
  assert.deepEqual(calls[0].denylist, ['danger.example'], 'the person\'s own list of dangerous sites is read from the data folder');
  const refused = await send({ url: 'closed.example' });
  assert.equal(refused.status, 200, 'a refusal is an answer, not an error');
  assert.equal(refused.body.status, 'refused');
  assert.equal(refused.body.stage, 'probe');
  const bad = await send({ url: 'bad' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.ok, false);
});

test('the link route needs an address that is text', async (t) => {
  const send = await startRoute(t, async () => { throw new Error('must not be reached'); });
  for (const body of [{}, { url: '' }, { url: 42 }]) assert.equal((await send(body)).status, 400, JSON.stringify(body));
});

test('the link route refuses a request that is not from this computer, before anything is asked of a site', async (t) => {
  let asked = 0;
  const send = await startRoute(t, async () => { asked += 1; return { status: 'generated', id: 'x', name: 'X', code: 'x', notes: [] }; });
  for (const headers of [{ Host: 'localhost.evil.example' }, { 'X-Forwarded-For': '203.0.113.9' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const answer = await send({ url: 'mangas.example' }, headers);
    assert.equal(answer.status, 403, JSON.stringify(headers));
    assert.equal(answer.body.code, 'LOCAL_ONLY');
  }
  assert.equal(asked, 0);
});

test('the link route is rate limited: a few per minute, since each one asks a third-party site for pages', async (t) => {
  const send = await startRoute(t, async () => ({ status: 'refused', stage: 'probe', message: 'x', probe: {} }));
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await send({ url: 'mangas.example' })).status);
  assert.deepEqual(statuses.slice(0, 4), [200, 200, 200, 200]);
  assert.ok(statuses.slice(4).every((s) => s === 429), `got ${statuses}`);
});
