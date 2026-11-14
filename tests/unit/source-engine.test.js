'use strict';

// The extension engine: a site with a scraper of its own is added through the person's own Suwayomi-Server. Covered here, with no real server:
// the Suwayomi client (install an extension, list its sources), the source the app writes for one of its sources (loaded and RUN against a
// made-up Suwayomi), and the route that does both after the person confirmed. What matters: nothing is installed without the confirmation,
// the browser never names a package or an address, a refusal leaves the Suwayomi-Server untouched, and the written source behaves like any other.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { createSuwayomiService } = require('../../server/modules/suwayomi/service');
const { buildEngineSource, engineSourceId } = require('../../server/modules/source-catalog/engine');
const { checkSourceContract } = require('../../server/modules/source-import/contract');
const engineRoutes = require('../../server/routes/source-engine');
const { isPrivilegedRoute } = require('../../server/middleware/local-only');
const { createFailure } = require('../../server/modules/source-import/failure');

const SOURCE_ID = '6289731484943315811';
const PKG = 'eu.kanade.tachiyomi.extension.en.alpha';
const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-engine-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const closeAfter = (t, server) => t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

// ── the Suwayomi client ───────────────────────────────────────────────────

function clientWith(answer, settings = { suwayomiUrl: 'http://suwayomi.local:4567/', suwayomiUsername: 'u', suwayomiPassword: 'p' }) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return answer(url, init); };
  return { calls, service: createSuwayomiService({ readStore: async () => ({ settings }), fetchImpl }) };
}
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });

// What the server answers to the call that makes it read its repositories (the list of extensions) and to the install itself.
const installReply = (status, listed = [{ pkgName: PKG }]) => (url) => (String(url).endsWith('/api/v1/extension/list') ? reply(200, listed) : reply(status));

test('installing an extension first has the server read its repositories, then asks it, with the login of the person, and does not follow a redirect', async () => {
  const { service, calls } = clientWith(installReply(201));
  assert.deepEqual(await service.installExtension(PKG), { already: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'http://suwayomi.local:4567/api/v1/extension/list');
  assert.equal(calls[1].url, `http://suwayomi.local:4567/api/v1/extension/install/${PKG}`);
  assert.equal(calls[1].init.redirect, 'manual');
  assert.equal(calls[1].init.headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.ok(calls[1].init.signal, 'it has a time limit');
});

test('an extension the server already has installed is not installed again: its own list says so, and that is not an error', async () => {
  const { service, calls } = clientWith(installReply(500, [{ pkgName: PKG, installed: true }]));
  assert.deepEqual(await service.installExtension(PKG), { already: true });
  assert.equal(calls.length, 1, 'only the list was asked');
});

test('an extension that the repositories of the server do not list is said so, before anything is installed; a list that cannot be read does not stop the install', async () => {
  const missing = clientWith(installReply(201, [{ pkgName: 'eu.kanade.tachiyomi.extension.en.other' }]));
  await assert.rejects(missing.service.installExtension(PKG), (err) => err.statusCode === 404 && /not in them/.test(err.message));
  assert.equal(missing.calls.length, 1, 'no install was asked');
  const unreadable = clientWith((url) => (String(url).endsWith('/api/v1/extension/list') ? reply(500) : reply(201)));
  assert.deepEqual(await unreadable.service.installExtension(PKG), { already: false });
  await assert.rejects(clientWith((url) => (String(url).endsWith('/api/v1/extension/list') ? reply(401) : reply(201))).service.installExtension(PKG), (err) => err.statusCode === 401);
});

test('any success code of the server is an install (201, or a plain 200), and a 3xx is "already installed"', async () => {
  for (const status of [200, 201, 202, 204]) assert.deepEqual(await clientWith(installReply(status)).service.installExtension(PKG), { already: false }, String(status));
});

test('an extension that is already installed (the server answers 302) is not an error', async () => {
  for (const status of [302, 301, 308]) assert.deepEqual(await clientWith(installReply(status)).service.installExtension(PKG), { already: true }, String(status));
});

test('a failed install says why, in the person\'s terms: the login, or that the server looks in its own repositories', async () => {
  await assert.rejects(clientWith(installReply(401)).service.installExtension(PKG), (err) => err.statusCode === 401 && /username or password/.test(err.message));
  await assert.rejects(clientWith(installReply(500)).service.installExtension(PKG), (err) => err.statusCode === 502 && /HTTP 500/.test(err.message) && /repositories it is set up with/.test(err.message));
});

test('the filters of a source are asked for by its id as digits; a server that cannot say gives none, and only a refused login is an answer of its own', async () => {
  const list = [{ type: 'Select', filter: { name: 'Status', values: ['All'], state: 0 } }];
  const { service, calls } = clientWith(() => reply(200, list));
  assert.deepEqual(await service.getSourceFilters(SOURCE_ID), list);
  assert.equal(calls[0].url, `http://suwayomi.local:4567/api/v1/source/${SOURCE_ID}/filters`);
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  for (const bad of ['', undefined, '../x', 'a b', '1/2', 'x'.repeat(30)]) assert.deepEqual(await service.getSourceFilters(bad), [], String(bad));
  assert.equal(calls.length, 1, 'an id that is not digits asks nothing');
  assert.deepEqual(await clientWith(() => reply(500)).service.getSourceFilters(SOURCE_ID), []);
  assert.deepEqual(await clientWith(() => reply(200, { not: 'a list' })).service.getSourceFilters(SOURCE_ID), []);
  await assert.rejects(clientWith(() => reply(401)).service.getSourceFilters(SOURCE_ID), (err) => err.statusCode === 401);
});

test('a failed install carries the one short line of text the server gave, without markup', async () => {
  const answer = (url) => (String(url).endsWith('/api/v1/extension/list') ? reply(200, [{ pkgName: PKG }]) : { ...reply(500), text: async () => '<html><body>No such element\n  in the   table</body></html>' });
  await assert.rejects(clientWith(answer).service.installExtension(PKG), (err) => err.statusCode === 502 && /It said: No such element in the table$/.test(err.message) && !/</.test(err.message));
});

test('a package name that is not one is refused before anything is asked, and so is a missing server address', async () => {
  const { service, calls } = clientWith(() => reply(201));
  for (const bad of ['', undefined, '../x', 'a b', 'a/b', `${PKG};rm`, 'x'.repeat(200)]) await assert.rejects(service.installExtension(bad), (err) => err.statusCode === 400, String(bad));
  assert.equal(calls.length, 0);
  const none = clientWith(() => reply(201), { suwayomiUrl: '' });
  await assert.rejects(none.service.installExtension(PKG), (err) => err.statusCode === 400 && /not configured/.test(err.message));
  assert.equal(none.calls.length, 0);
});

test('the list of sources comes back as plain values: whole-number ids as text only, capped fields', async () => {
  const { service } = clientWith(() => reply(200, [
    { id: SOURCE_ID, name: 'Alpha', displayName: 'Alpha (EN)', lang: 'en', supportsLatest: true, isNsfw: false, baseUrl: 'https://alpha.example' },
    { id: '12', name: 'B'.repeat(300), lang: 'pt-BR', supportsLatest: 1, isNsfw: 1 },
    { id: '-5', name: 'negative' }, { id: 'abc', name: 'text' }, { id: SOURCE_ID + '9999', name: 'too long' }, null,
  ]));
  const list = await service.listSources();
  assert.deepEqual(list.map((s) => s.id), [SOURCE_ID, '12']);
  assert.deepEqual(list[0], { id: SOURCE_ID, name: 'Alpha (EN)', lang: 'en', supportsLatest: true, isNsfw: false, baseUrl: 'https://alpha.example' });
  assert.equal(list[1].name.length, 120);
  assert.equal(list[1].supportsLatest, true);
  assert.deepEqual((await clientWith(() => reply(200, { not: 'a list' })).service.listSources()), []);
});

const STORE = 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb';

test('the repository is registered through the server\'s own GraphQL call, once per server and repository, with the login', async () => {
  const { service, calls } = clientWith(() => reply(200, { data: { addExtensionStore: { extensionStore: { indexUrl: STORE, name: 'Keiyoushi' } } } }));
  assert.deepEqual(await service.ensureExtensionStore(STORE), { already: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://suwayomi.local:4567/api/graphql');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  const sent = JSON.parse(calls[0].init.body);
  assert.match(sent.query, /addExtensionStore\(input: \{ indexUrl: \$indexUrl \}\)/);
  assert.deepEqual(sent.variables, { indexUrl: STORE }, 'the address travels as a variable, never inside the query text');
  assert.deepEqual(await service.ensureExtensionStore(STORE), { already: true });
  assert.equal(calls.length, 1, 'not asked again by the same process');
});

test('a refusal to register the repository says why, is not remembered, and a bad address is refused before anything is asked', async () => {
  let mode = 'graphql';
  const { service, calls } = clientWith(() => {
    if (mode === 'graphql') return reply(200, { errors: [{ message: 'Could not fetch the store\nstack line' }] });
    if (mode === '401') return reply(401);
    if (mode === '500') return reply(500);
    return reply(200, { data: {} });
  });
  await assert.rejects(service.ensureExtensionStore(STORE), (err) => err.statusCode === 502 && /could not add the extension repository: Could not fetch the store$/.test(err.message));
  mode = '401';
  await assert.rejects(service.ensureExtensionStore(STORE), (err) => err.statusCode === 401 && /username or password/.test(err.message));
  mode = '500';
  await assert.rejects(service.ensureExtensionStore(STORE), (err) => err.statusCode === 502 && /HTTP 500/.test(err.message));
  mode = 'ok';
  assert.deepEqual(await service.ensureExtensionStore(STORE), { already: false }, 'a failure earlier did not stop a later success');
  const before = calls.length;
  for (const bad of ['', undefined, 'http://plain.example/index.pb', 'https://x.example/a b', 'https://x.example/"; drop', "https://x.example/'x", 'ftp://x.example/i', 'https://x.example/\\x']) {
    await assert.rejects(service.ensureExtensionStore(bad), (err) => err.statusCode === 400, String(bad));
  }
  assert.equal(calls.length, before);
  await assert.rejects(clientWith(() => reply(200, {}), { suwayomiUrl: '' }).service.ensureExtensionStore(STORE), (err) => err.statusCode === 400 && /not configured/.test(err.message));
});

// ── the source the app writes ─────────────────────────────────────────────

test('the written file raises no warning in the Check of the card: no process, no requires, no web address of its own', () => {
  const { analyzeSourceCode } = require('../../server/modules/source-import/static-report');
  const built = buildEngineSource({ sourceId: SOURCE_ID, name: 'Alpha Scans', supportsLatest: true, isNsfw: false, date: '2026-11-10' });
  const report = analyzeSourceCode(built.code);
  assert.deepEqual(report.risks, []);
  assert.deepEqual(report.requires, []);
  assert.equal(report.syntaxError, null);
});

test('the written source is the same shape for the same source, has the engine\'s id, and passes the contract of an installed source', (t) => {
  const built = buildEngineSource({ sourceId: SOURCE_ID, name: 'Alpha Scans', supportsLatest: true, isNsfw: false, date: '2026-11-10' });
  assert.equal(built.id, `sw-${SOURCE_ID}`);
  assert.equal(built.id, engineSourceId(SOURCE_ID));
  assert.equal(built.name, 'Alpha Scans');
  assert.match(built.code, /^'use strict';\n\/\/ scrollscape-engine engine=suwayomi source=6289731484943315811 on=2026-11-10\n/);
  assert.equal(buildEngineSource({ sourceId: SOURCE_ID, name: 'Alpha Scans', supportsLatest: true, isNsfw: false, date: '2026-11-10' }).code, built.code, 'the same input gives the same file (and fingerprint)');
  const file = path.join(tmpDir(t), `${built.id}.js`);
  fs.writeFileSync(file, built.code);
  const mod = require(file);
  const verdict = checkSourceContract(mod, built.id);
  assert.deepEqual(verdict.errors, []);
  assert.ok(['search', 'mangaDetails', 'chapters', 'pages', 'trending', 'popularAllTime', 'latestUpdates', 'healthCheck'].every((name) => verdict.summary.methods.concat(verdict.summary.optionalMethods).includes(name)));
  assert.equal(mod.meta.supportsLatestUpdates, true);
  assert.equal(mod.meta.ui.adultOnly, false);
  assert.equal(mod.meta.ui.filters.genres, false, 'no filter is declared that the server cannot honour');
});

test('a source the extension marks adult is declared adult-only, and one with no "latest" list says so', (t) => {
  const built = buildEngineSource({ sourceId: '77', name: 'Adults', supportsLatest: false, isNsfw: true });
  const file = path.join(tmpDir(t), `${built.id}.js`);
  fs.writeFileSync(file, built.code);
  const mod = require(file);
  assert.equal(mod.meta.ui.adultOnly, true);
  assert.equal(mod.meta.supportsLatestUpdates, false);
  assert.equal(built.adultOnly, true);
});

test('what a server or repository says cannot put code in the file: a hostile name is cut to plain text, a bad id is refused', (t) => {
  const evil = '"); process.exit(1); //`${require("fs")}` \n  * / <script>';
  const built = buildEngineSource({ sourceId: '5', name: evil, supportsLatest: 'yes', isNsfw: 'yes' });
  assert.doesNotMatch(built.name, /["`$;\\/<>(){}]/);
  assert.doesNotMatch(built.code, /process\.exit\(1\)/);
  assert.doesNotMatch(built.code, /require\("fs"\)/);
  assert.equal(built.adultOnly, false, 'only a real true counts');
  const file = path.join(tmpDir(t), `${built.id}.js`);
  fs.writeFileSync(file, built.code);
  assert.deepEqual(checkSourceContract(require(file), built.id).errors, []);
  for (const bad of ['', undefined, 'abc', '12 34', '-1', '1'.repeat(21), '5; process.exit()', 5]) assert.throws(() => buildEngineSource({ sourceId: bad, name: 'x' }), /not a Suwayomi source id/, String(bad));
  assert.equal(buildEngineSource({ sourceId: '5', name: '   ' }).name, 'sw-5', 'a source with no name is called by its id');
});

// ── the written source, run against a made-up Suwayomi ────────────────────

const manga = (id, over = {}) => ({ id, sourceId: SOURCE_ID, title: `Title ${id}`, realUrl: `https://alpha.example/m/${id}`, genre: ['Action'], status: 'ONGOING', author: 'A', artist: 'B', description: 'About', ...over });

/** A made-up Suwayomi-Server and a made-up "this app" that serves the settings, and the written source loaded to use them. */
async function engineRig(t, { settings, over = {} } = {}) {
  const requests = [];
  const suwayomi = await listen((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization || '' });
    const send = (status, body) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (over.status && over.status !== 200) return send(over.status, {});
    let m;
    if (p === `/api/v1/source/${SOURCE_ID}`) return send(200, { id: SOURCE_ID });
    if ((m = /\/popular\/(\d+)$/.exec(p)) && over.failPages && over.failPages.includes(Number(m[1]))) return send(500, {});
    if ((m = new RegExp(`^/api/v1/source/${SOURCE_ID}/popular/(\\d+)$`).exec(p))) return send(200, { mangaList: over.popular || [manga(1), manga(2, { genre: ['Loli'] }), manga(3, { genre: [] })], hasNextPage: m[1] === '1' });
    if (p === `/api/v1/source/${SOURCE_ID}/latest/1`) return send(200, { mangaList: [manga(4)], hasNextPage: false });
    if (p === `/api/v1/source/${SOURCE_ID}/search`) return send(200, { mangaList: [manga(5, { title: url.searchParams.get('searchTerm') })], hasNextPage: url.searchParams.get('pageNum') === '1' });
    if ((m = /^\/api\/v1\/manga\/(\d+)\/full$/.exec(p))) return send(200, manga(Number(m[1]), over.detail || {}));
    if (/^\/api\/v1\/manga\/\d+\/chapters$/.test(p)) return send(200, over.chapters || []);
    if ((m = /^\/api\/v1\/manga\/\d+\/chapter\/(\d+)$/.exec(p))) return send(200, { pageCount: over.pageCount === undefined ? 3 : over.pageCount, index: Number(m[1]) });
    return send(404, {});
  });
  closeAfter(t, suwayomi);
  const self = await listen((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: settings === undefined ? { suwayomiUrl: `http://127.0.0.1:${suwayomi.address().port}/`, suwayomiUsername: 'u', suwayomiPassword: 'p' } : settings }));
  });
  closeAfter(t, self);
  const built = buildEngineSource({ sourceId: SOURCE_ID, name: 'Alpha Scans', supportsLatest: true });
  const file = path.join(tmpDir(t), `${built.id}-${Math.random().toString(16).slice(2)}.js`);
  fs.writeFileSync(file, built.code);
  const before = globalThis.ScrollScapePort;
  globalThis.ScrollScapePort = self.address().port;
  const mod = require(file);
  if (before === undefined) delete globalThis.ScrollScapePort; else globalThis.ScrollScapePort = before;
  return { mod, requests };
}

test('with no word, search is the source\'s popular list; titles of a never-listed genre are left out; the images come through this app', async (t) => {
  const { mod, requests } = await engineRig(t);
  const out = await mod.search('', 1);
  assert.deepEqual(out.results.map((r) => r.id), ['1', '3'], 'the title whose genre is never listed is gone');
  assert.equal(out.hasNextPage, true);
  assert.equal(out.results[0].cover, '/api/suwayomi/thumbnail/1');
  assert.deepEqual({ title: out.results[0].title, genres: out.results[0].genres, status: out.results[0].status, url: out.results[0].url }, { title: 'Title 1', genres: ['Action'], status: 'ongoing', url: 'https://alpha.example/m/1' });
  assert.equal(requests[0].auth, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.equal(requests[0].url, `/api/v1/source/${SOURCE_ID}/popular/1`);
});

test('a page past the last one is answered with nothing, without asking the server (a site with one page repeats the first otherwise); a list that has more is still read', async (t) => {
  const { mod, requests } = await engineRig(t);
  assert.equal((await mod.search('', 1)).hasNextPage, true);
  assert.equal((await mod.search('', 2)).hasNextPage, false, 'the second page is the last one');
  const asked = requests.length;
  assert.deepEqual(await mod.search('', 9), { results: [], hasNextPage: false });
  assert.equal(requests.length, asked, 'nothing was asked for the page past the end');
  assert.equal((await mod.search('', 2)).results.length > 0, true, 'a page up to the last one is still read');
  assert.equal((await mod.search('word', 1)).hasNextPage, true, 'another list has its own end');
  assert.equal((await mod.search('word', 2)).hasNextPage, false);
  assert.deepEqual(await mod.search('word', 5), { results: [], hasNextPage: false });
});

test('a page past the first that the server fails on is the end of the list for that request only; the first page failing is still an error', async (t) => {
  const { mod, requests } = await engineRig(t, { over: { failPages: [1, 7] } });
  assert.deepEqual(await mod.search('', 7), { results: [], hasNextPage: false });
  assert.deepEqual(await mod.search('', 7), { results: [], hasNextPage: false });
  assert.equal(requests.filter((r) => r.url.endsWith('/popular/7')).length, 2, 'nothing was remembered: the page was asked for again');
  await assert.rejects(mod.search('', 1), /answered 500/);
});

test('a word searches the source, a page past the first is asked for, and a word that is a never-listed category asks nothing at all', async (t) => {
  const { mod, requests } = await engineRig(t);
  const hit = await mod.search('one piece', 2);
  assert.equal(hit.results[0].title, 'one piece');
  assert.equal(requests.at(-1).url, `/api/v1/source/${SOURCE_ID}/search?searchTerm=one%20piece&pageNum=2`);
  const before = requests.length;
  for (const word of ['loli', 'some shota stuff', 'toddlercon']) assert.deepEqual(await mod.search(word, 1), { results: [], hasNextPage: false });
  assert.equal(requests.length, before);
});

test('trending and popular are the popular list, latest is its own list, and a source with no latest list gives none', async (t) => {
  const { mod } = await engineRig(t);
  assert.deepEqual((await mod.trending()).results.map((r) => r.id), ['1', '3']);
  assert.deepEqual((await mod.popularAllTime()).results.map((r) => r.id), ['1', '3']);
  assert.deepEqual((await mod.latestUpdates()).results.map((r) => r.id), ['4']);
  const built = buildEngineSource({ sourceId: SOURCE_ID, name: 'No Latest', supportsLatest: false });
  const file = path.join(tmpDir(t), 'sw-nolatest.js');
  fs.writeFileSync(file, built.code);
  assert.deepEqual(await require(file).latestUpdates(), { results: [] });
});

test('details, chapters and pages are read through the same server, and nothing but whole numbers is ever put in a path', async (t) => {
  const { mod, requests } = await engineRig(t, { over: {
    chapters: [{ index: 2, name: 'Chapter 2', chapterNumber: 2, uploadDate: 1_700_000_000_000 }, { index: 1, name: 'Chapter 1', chapterNumber: 1, uploadDate: 0 }],
  } });
  const d = await mod.mangaDetails('7');
  assert.deepEqual({ id: d.id, title: d.title, author: d.author, description: d.description, status: d.status, cover: d.cover }, { id: '7', title: 'Title 7', author: 'A, B', description: 'About', status: 'ongoing', cover: '/api/suwayomi/thumbnail/7' });
  const c = await mod.chapters('7');
  assert.deepEqual(c.chapters.map((x) => [x.id, x.name, x.chapter]), [['7-2', 'Chapter 2', '2'], ['7-1', 'Chapter 1', '1']]);
  assert.equal(c.chapters[0].publishAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(c.chapters[1].publishAt, null, 'an unknown date is null, never invented');
  assert.deepEqual((await mod.pages('7-2')).pages, [0, 1, 2].map((i) => ({ index: i, img: `/api/suwayomi/page/7/2/${i}` })));
  assert.ok(requests.some((r) => r.url === '/api/v1/manga/7/full?onlineFetch=true'));
  assert.ok(requests.some((r) => r.url === '/api/v1/manga/7/chapters?onlineFetch=true'));
  for (const bad of ['', '../1', '1/2', 'x', '1'.repeat(13), '7 ']) await assert.rejects(mod.mangaDetails(bad), (err) => err.statusCode === 400, String(bad));
  for (const bad of ['', '7', '7-', '-2', '7-2-3', '../7-2', '7-2 ']) await assert.rejects(mod.pages(bad), (err) => err.statusCode === 400, String(bad));
});

test('the people an extension lists among its tags ("Artist: Name") are the author of the title, not genres; each person once, and the other tags stay', async (t) => {
  const tagged = { genre: ['Action', 'Artist: Sakamata Nerimono', 'author: Someone Else', 'Parody: Something', 'Artists: Sakamata Nerimono'], author: '', artist: '' };
  const { mod } = await engineRig(t, { over: { detail: tagged, popular: [manga(1, tagged)] } });
  const details = await mod.mangaDetails('7');
  assert.deepEqual(details.genres, ['Action', 'Parody: Something']);
  assert.equal(details.author, 'Sakamata Nerimono, Someone Else');
  const list = (await mod.search('', 1)).results[0];
  assert.deepEqual(list.genres, ['Action', 'Parody: Something']);
  assert.equal(list.author, 'Sakamata Nerimono, Someone Else', 'the card has the author too');
  const given = await engineRig(t, { over: { detail: { genre: ['Action', 'Artist: B'], author: 'A', artist: 'B' } } });
  assert.equal((await given.mod.mangaDetails('7')).author, 'A, B', 'an author the extension gave is kept first, and a person named twice is listed once');
});

test('a date shared by four chapters in the same hour is a batch import, not a publication time', async (t) => {
  const stamp = 1_700_000_000_000;
  const { mod } = await engineRig(t, { over: { chapters: [1, 2, 3, 4, 5].map((i) => ({ index: i, name: `C${i}`, chapterNumber: i, uploadDate: stamp + i * 1000 })) } });
  assert.ok((await mod.chapters('7')).chapters.every((c) => c.publishAt === null));
});

test('a title that belongs to another source, or whose genre is never listed, is not found; a chapter with no pages is an error', async (t) => {
  const other = await engineRig(t, { over: { detail: { sourceId: '999' } } });
  await assert.rejects(other.mod.mangaDetails('7'), (err) => err.statusCode === 404);
  const another = await engineRig(t, { over: { detail: { id: 99 } } });
  await assert.rejects(another.mod.mangaDetails('7'), (err) => err.statusCode === 404, 'a title with another id than the one asked for is not that title');
  const never = await engineRig(t, { over: { detail: { genre: ['Action', 'Shota'] } } });
  await assert.rejects(never.mod.mangaDetails('7'), (err) => err.statusCode === 404);
  const nopages = await engineRig(t, { over: { pageCount: -1 } });
  await assert.rejects(nopages.mod.pages('7-1'), /returned no pages/);
});

test('the settings come from the running app itself, so an Access Password (which makes its HTTP settings route answer 401) does not stop the source', async (t) => {
  const suwayomi = await listen((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ mangaList: [manga(1)], hasNextPage: false })); });
  closeAfter(t, suwayomi);
  let httpAsked = 0;
  const self = await listen((req, res) => { httpAsked += 1; res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'Authentication required', code: 'AUTH_REQUIRED' })); });
  closeAfter(t, self);
  const built = buildEngineSource({ sourceId: SOURCE_ID, name: 'Alpha Scans', supportsLatest: true });
  const file = path.join(tmpDir(t), `${built.id}-host.js`);
  fs.writeFileSync(file, built.code);
  const beforePort = globalThis.ScrollScapePort;
  globalThis.ScrollScapePort = self.address().port;
  globalThis.ScrollScapeHost = Object.freeze({ readSettings: async () => ({ suwayomiUrl: `http://127.0.0.1:${suwayomi.address().port}`, suwayomiUsername: '', suwayomiPassword: '' }) });
  t.after(() => { delete globalThis.ScrollScapeHost; if (beforePort === undefined) delete globalThis.ScrollScapePort; else globalThis.ScrollScapePort = beforePort; });
  const mod = require(file);
  assert.deepEqual((await mod.search('', 1)).results.map((r) => r.id), ['1']);
  assert.equal(httpAsked, 0, 'the HTTP route was never asked');
});

test('server.js offers that to the sources, and the written source reads its settings the same way', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  assert.match(server, /globalThis\.ScrollScapeHost = Object\.freeze\(\{\s*readSettings: async \(\) => \{/);
  for (const file of [path.join(__dirname, '..', '..', 'server', 'modules', 'source-catalog', 'engine', 'suwayomi-source.template.txt')]) {
    assert.match(fs.readFileSync(file, 'utf8'), /globalThis\.ScrollScapeHost/, path.basename(file));
  }
});

test('health check only asks whether the server still has the source; the login and the address are the person\'s', async (t) => {
  const { mod, requests } = await engineRig(t);
  assert.deepEqual(await mod.healthCheck(), { ok: true });
  assert.equal(requests.at(-1).url, `/api/v1/source/${SOURCE_ID}`);
  const refused = await engineRig(t, { over: { status: 401 } });
  await assert.rejects(refused.mod.search('x', 1), (err) => err.statusCode === 401 && /username or password/.test(err.message));
  const missing = await engineRig(t, { over: { status: 404 } });
  await assert.rejects(missing.mod.healthCheck(), (err) => err.statusCode === 404);
  const unset = await engineRig(t, { settings: { suwayomiUrl: '' } });
  await assert.rejects(unset.mod.search('x', 1), (err) => err.statusCode === 400 && /not configured/.test(err.message));
});

// ── the route ─────────────────────────────────────────────────────────────

function fakeEngine(over = {}) {
  const calls = { install: [], list: 0, site: [], ensure: [], order: [] };
  const suwayomi = {
    getConfig: async () => ({ baseUrl: 'http://suwayomi.local:4567' }),
    ensureExtensionStore: async (url) => { calls.ensure.push(url); calls.order.push('ensure'); return { already: false }; },
    installExtension: async (pkg) => { calls.install.push(pkg); calls.order.push('install'); return { already: false }; },
    listSources: async () => { calls.list += 1; return [{ id: SOURCE_ID, name: 'Alpha Scans', lang: 'en', supportsLatest: true, isNsfw: false, baseUrl: '' }]; },
    ...over.suwayomi,
  };
  const catalog = {
    engineSiteOf: async (key) => { calls.site.push(key); return { pkg: PKG, sourceId: SOURCE_ID, name: 'Alpha Scans', lang: 'en', warning: 'SAFE', id: `sw-${SOURCE_ID}` }; },
    ...over.catalog,
  };
  return { calls, suwayomi, catalog };
}

async function startRoute(t, rig) {
  engineRoutes.configure({ suwayomi: rig.suwayomi, catalog: () => rig.catalog });
  const app = express();
  app.use(express.json());
  engineRoutes.registerSourceEngineRoutes(app);
  const server = await listen(app);
  closeAfter(t, server);
  const port = server.address().port;
  return (body, headers = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/sources/engine/prepare', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const KEY = `${PKG}#0`;

test('the route is on the guard list, stays on this computer, and asks nothing of any server for a request that is not from it', async (t) => {
  assert.equal(isPrivilegedRoute({ method: 'POST', originalUrl: '/api/sources/engine/prepare' }), true);
  assert.equal(isPrivilegedRoute({ method: 'POST', originalUrl: '/API/Sources/Engine/PREPARE/' }), true);
  const rig = fakeEngine();
  const send = await startRoute(t, rig);
  for (const headers of [{ Host: 'localhost.evil.example' }, { 'X-Forwarded-For': '203.0.113.9' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const answer = await send({ key: KEY, acknowledge: true }, headers);
    assert.equal(answer.status, 403, JSON.stringify(headers));
    assert.equal(answer.body.code, 'LOCAL_ONLY');
  }
  assert.deepEqual(rig.calls.install, []);
});

test('nothing is installed unless the person confirmed: the body must say so, and "true" as text or any other value does not count', async (t) => {
  const rig = fakeEngine();
  const send = await startRoute(t, rig);
  for (const acknowledge of [undefined, false, 'true', 1, null, {}]) {
    const answer = await send({ key: KEY, acknowledge });
    assert.equal(answer.status, 400, String(acknowledge));
    assert.match(answer.body.error, /Confirm first/);
  }
  assert.deepEqual(rig.calls.install, []);
  assert.deepEqual(rig.calls.site, [], 'not even the catalog is asked');
});

test('a confirmed row installs the catalog\'s package, finds the source by the repository\'s id, and returns the written source in the shape of a link answer', async (t) => {
  const rig = fakeEngine();
  const send = await startRoute(t, rig);
  const answer = await send({ key: KEY, acknowledge: true, pkg: 'evil.package', sourceId: '1', url: 'https://evil.example' });
  assert.equal(answer.status, 200);
  const body = answer.body;
  assert.deepEqual({ ok: body.ok, status: body.status, id: body.id, name: body.name, engine: body.engine }, { ok: true, status: 'generated', id: `sw-${SOURCE_ID}`, name: 'Alpha Scans', engine: 'suwayomi' });
  assert.equal(body.probe.engine.name, 'Suwayomi');
  assert.deepEqual(rig.calls.install, [PKG], 'the package is the catalog\'s, whatever the browser sent');
  assert.deepEqual(rig.calls.ensure, ['https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb'], 'the repository is the app\'s, never the browser\'s');
  assert.deepEqual(rig.calls.order, ['ensure', 'install'], 'the server knows the repository before it is asked to install from it');
  assert.deepEqual(rig.calls.site, [KEY]);
  assert.match(body.code, new RegExp(`source=${SOURCE_ID}`));
  assert.ok(body.notes.some((n) => /was installed in your Suwayomi-Server/.test(n)));
  assert.ok(body.notes.some((n) => /stop opening/.test(n)));
  const file = path.join(tmpDir(t), `${body.id}.js`);
  fs.writeFileSync(file, body.code);
  assert.deepEqual(checkSourceContract(require(file), body.id).errors, []);
});

test('the filters the server lists for the source are read into the written file, and said in the notes; a server that cannot say gives a source with none', async (t) => {
  const filters = [
    { type: 'Select', filter: { name: 'Status', values: ['All', 'Ongoing', 'Completed'], state: 0 } },
    { type: 'Group', filter: { name: 'Genres', state: [{ type: 'CheckBox', filter: { name: 'Action', state: false } }, { type: 'CheckBox', filter: { name: 'Drama', state: false } }] } },
  ];
  const asked = [];
  const rig = fakeEngine({ suwayomi: { getSourceFilters: async (id) => { asked.push(id); return filters; } } });
  const body = (await (await startRoute(t, rig))({ key: KEY, acknowledge: true })).body;
  assert.deepEqual(asked, [SOURCE_ID], 'asked for the source Suwayomi gave, not one of the browser\'s');
  assert.match(body.code, /"genres":\{"position":1/);
  assert.ok(body.notes.some((n) => /offers what the extension has: genres, status\./.test(n)), body.notes.join(' | '));
  const none = fakeEngine({ suwayomi: { getSourceFilters: async () => { throw new Error('older server'); } } });
  const plain = (await (await startRoute(t, none))({ key: KEY, acknowledge: true })).body;
  assert.equal(plain.ok, true);
  assert.ok(plain.notes.some((n) => /has no genre, status or sort filter/.test(n)));
});

test('an extension that was already installed is said to be, and an adult source is declared adult', async (t) => {
  const rig = fakeEngine({ suwayomi: {
    installExtension: async () => ({ already: true }),
    listSources: async () => [{ id: SOURCE_ID, name: 'Alpha Scans', lang: 'en', supportsLatest: false, isNsfw: true, baseUrl: '' }],
  } });
  const send = await startRoute(t, rig);
  const { body } = await send({ key: KEY, acknowledge: true });
  assert.ok(body.notes.some((n) => /already installed/.test(n)));
  assert.ok(body.notes.some((n) => /adult/.test(n)));
  assert.match(body.code, /const ADULT_ONLY = true;/);
  assert.match(body.code, /const SUPPORTS_LATEST = false;/);
});

test('a refusal of the catalog (an entry this app does not offer, a dangerous site, a stale key) installs nothing', async (t) => {
  for (const [status, message] of [[403, 'not available here'], [403, 'dangerous sites'], [404, 'no longer in the catalog'], [400, 'not an entry'], [409, 'does not give an id']]) {
    const rig = fakeEngine({ catalog: { engineSiteOf: async () => { throw createFailure(message, status); } } });
    const send = await startRoute(t, rig);
    const answer = await send({ key: KEY, acknowledge: true });
    assert.equal(answer.status, status, message);
    assert.match(answer.body.error, new RegExp(message));
    assert.deepEqual(rig.calls.install, [], message);
  }
});

test('with no Suwayomi-Server set up nothing is asked, and each way the server can fail is its own sentence', async (t) => {
  const none = fakeEngine({ suwayomi: { getConfig: async () => null } });
  const a = await (await startRoute(t, none))({ key: KEY, acknowledge: true });
  assert.equal(a.status, 400);
  assert.match(a.body.error, /Set the address of your Suwayomi-Server/);
  assert.deepEqual(none.calls.install, []);

  const login = fakeEngine({ suwayomi: { installExtension: async () => { throw Object.assign(new Error('Suwayomi-Server refused the username or password.'), { statusCode: 401 }); } } });
  const b = await (await startRoute(t, login))({ key: KEY, acknowledge: true });
  assert.equal(b.status, 401);

  const refused = fakeEngine({ suwayomi: { installExtension: async () => { throw Object.assign(new Error('Suwayomi-Server could not install the extension (HTTP 500).'), { statusCode: 502 }); } } });
  const c = await (await startRoute(t, refused))({ key: KEY, acknowledge: true });
  assert.equal(c.status, 502);
  assert.match(c.body.error, /could not install/);

  const unlisted = fakeEngine({ suwayomi: { listSources: async () => [{ id: '1', name: 'Other', lang: 'en', supportsLatest: false, isNsfw: false, baseUrl: '' }] } });
  const d = await (await startRoute(t, unlisted))({ key: KEY, acknowledge: true });
  assert.equal(d.status, 409);
  assert.match(d.body.error, /does not list this site/);

  const unreadable = fakeEngine({ suwayomi: { listSources: async () => { throw new Error('boom'); } } });
  const e = await (await startRoute(t, unreadable))({ key: KEY, acknowledge: true });
  assert.equal(e.status, 502);
  assert.match(e.body.error, /list of sources could not be read/);
});

test('if the server cannot be told about the repository, nothing is installed and the sentence says what failed', async (t) => {
  for (const [statusCode, expected] of [[401, 401], [502, 502], [400, 400], [undefined, 502]]) {
    const rig = fakeEngine({ suwayomi: { ensureExtensionStore: async () => { throw Object.assign(new Error('Suwayomi-Server could not add the extension repository: boom'), { statusCode }); } } });
    const answer = await (await startRoute(t, rig))({ key: KEY, acknowledge: true });
    assert.equal(answer.status, expected, String(statusCode));
    assert.match(answer.body.error, /could not add the extension repository/);
    assert.deepEqual(rig.calls.install, [], 'the extension is not installed from a repository the server does not know');
  }
});

test('the route is rate limited: a few a minute, since each one asks a server to download and convert a file', async (t) => {
  const send = await startRoute(t, fakeEngine());
  const statuses = [];
  for (let i = 0; i < 8; i += 1) statuses.push((await send({ key: KEY, acknowledge: true })).status);
  assert.deepEqual(statuses.slice(0, 6), [200, 200, 200, 200, 200, 200]);
  assert.ok(statuses.slice(6).every((s) => s === 429), `got ${statuses}`);
});
