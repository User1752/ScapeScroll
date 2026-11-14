'use strict';

// The repositories a person adds to the catalog besides the default one: the address they type (server/modules/source-catalog/repo-url.js), the registry that
// checks and keeps them (repos.js), the catalog that merges them (catalog.js) and the routes (routes/source-catalog.js). The network is replaced. What matters:
// an address is judged strictly BEFORE anything is asked (https only, no login, no port, no number, no computer name), a repository is kept only when a list of
// extensions is really there, what is stored is read back with the same strictness, the sites of an added repository are offered as "check" (the generator
// judges the site itself, no theme is read for them), an unreadable repository is left out and said so, and only this computer may change the list.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const baseConfig = require('../../server/config/catalog');
const { repoCandidates, repoIdentity, isPublicName } = require('../../server/modules/source-catalog/repo-url');
const { createRepoRegistry, cleanEntry, MAX_REPOS } = require('../../server/modules/source-catalog/repos');
const { createCatalog, createCaches } = require('../../server/modules/source-catalog/catalog');
const catalogRoutes = require('../../server/routes/source-catalog');
const { isPrivilegedRoute } = require('../../server/middleware/local-only');

// ── the address ──────────────────────────────────────────────────────────

test('the list is looked for where the form of the address says: the file itself, next to an index.pb, in a folder, or on the "repo" branch of a GitHub project', () => {
  const both = (base) => [`${base}index.min.json`, `${base}index.json`];
  assert.deepEqual(repoCandidates('https://repo.example/x/index.min.json'), { candidates: ['https://repo.example/x/index.min.json'], label: 'repo.example' });
  assert.deepEqual(repoCandidates('https://repo.example/x/index.json').candidates, ['https://repo.example/x/index.json']);
  assert.deepEqual(repoCandidates('https://repo.example/x/index.pb').candidates, both('https://repo.example/x/'));
  assert.deepEqual(repoCandidates('https://repo.example/x/y').candidates, both('https://repo.example/x/y/'));
  assert.deepEqual(repoCandidates('https://repo.example/x/y/').candidates, both('https://repo.example/x/y/'));
  assert.deepEqual(repoCandidates('https://repo.example/').candidates, both('https://repo.example/'));
  assert.deepEqual(repoCandidates('  https://REPO.example  ').candidates, both('https://repo.example/'));
  assert.deepEqual(repoCandidates('https://github.com/owner/name'), { candidates: both('https://raw.githubusercontent.com/owner/name/repo/'), label: 'owner/name' });
  assert.deepEqual(repoCandidates('https://github.com/owner/name/raw/repo/index.min.json'), { candidates: ['https://github.com/owner/name/raw/repo/index.min.json'], label: 'owner/name' });
  assert.equal(repoCandidates('https://raw.githubusercontent.com/o/n/repo/index.pb').label, 'o/n');
});

test('an address that is not a plain https name on the internet, or that names something that is not a repository, is refused with a sentence before anything is asked', () => {
  const bad = [
    '', '   ', null, undefined, 'not a url', 'repo.example/x', 'http://repo.example/x/', 'ftp://repo.example/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x',
    'https://user:pass@repo.example/', 'https://user@repo.example/', 'https://repo.example:8443/', 'https://repo.example/?q=1', 'https://repo.example/#x',
    'https://127.0.0.1/x/', 'https://192.168.1.97/x/', 'https://10.0.0.1/', 'https://[::1]/', 'https://localhost/x/', 'https://nas/x/', 'https://nas.local/x/', 'https://printer.lan/', 'https://x.internal/',
    'https://repo.example/a/./../x/y/z/w/v/u/t/s/r/q/p/o/n/', `https://repo.example/${'a/'.repeat(14)}`, `https://repo.example/${'x'.repeat(300)}`,
    'https://repo.example/x/data.zip', 'https://repo.example/x/index.xml', 'https://repo.example/x/other.json', 'https://repo.example/x/list.pb', 'https://-bad-.example/', 'https://a..b.example/',
  ];
  for (const input of bad) assert.throws(() => repoCandidates(input), (err) => err.statusCode === 400 && err.message.length > 10, JSON.stringify(String(input).slice(0, 50)));
  assert.equal(isPublicName('repo.example'), true);
  assert.equal(isPublicName('a.b.c.example.org'), true);
  for (const no of ['localhost', '1.2.3.4', 'nas', 'x.local', 'a:b.example', '']) assert.equal(isPublicName(no), false, no);
});

test('the same repository written another way is the same one', () => {
  const same = [
    ['https://github.com/keiyoushi/extensions/raw/repo/index.json', 'https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json'],
    ['https://github.com/Owner/Name/raw/repo/index.json', 'https://raw.githubusercontent.com/owner/name/repo/index.pb'],
    ['https://repo.example/x/index.json', 'https://repo.example/x/index.min.json'],
    ['https://repo.example/x/index.json', 'https://REPO.example/x/'],
  ];
  for (const [a, b] of same) assert.equal(repoIdentity(a), repoIdentity(b), `${a} ${b}`);
  const different = [
    ['https://github.com/keiyoushi/extensions/raw/repo/index.json', 'https://github.com/keiyoushi/extensions/raw/other/index.json'],
    ['https://github.com/keiyoushi/extensions/raw/repo/index.json', 'https://github.com/other/extensions/raw/repo/index.json'],
    ['https://repo.example/x/index.json', 'https://repo.example/y/index.json'],
    ['https://repo.example/x/index.json', 'https://other.example/x/index.json'],
  ];
  for (const [a, b] of different) assert.notEqual(repoIdentity(a), repoIdentity(b), `${a} ${b}`);
  assert.equal(repoIdentity('not a url'), '');
});

// ── the registry ─────────────────────────────────────────────────────────

const PKG = (name) => `eu.kanade.tachiyomi.extension.en.${name}`;
const extension = (name, url, warning = 'SAFE') => ({ name, packageName: PKG(name), versionName: '1.0', contentWarning: `CONTENT_WARNING_${warning}`, sources: [{ id: '1000000000000000001', name: `${name} Site`, language: 'en', homeUrl: url }] });
const indexOf = (...exts) => JSON.stringify({ name: 'R', extensionList: { extensions: exts } });

function memoryStore(settings = {}) {
  const data = { settings: { ...settings } };
  const writes = [];
  return { data, writes, readStore: async () => data, writeStore: async (d) => { writes.push(JSON.parse(JSON.stringify(d.settings.catalogRepos || []))); }, flushNow: () => { writes.push('flushed'); } };
}

test('a repository is kept only when a list of extensions is really there; the first of the two names that works is the one kept; nothing else is stored', async () => {
  const store = memoryStore();
  const asked = [];
  const answers = {
    'https://repo.example/x/index.min.json': { status: 404, text: '' },
    'https://repo.example/x/index.json': { status: 200, text: indexOf(extension('aone', 'https://one.example'), extension('btwo', 'https://two.example')) },
  };
  const fetchText = async (url) => { asked.push(url); return answers[url] || { status: 404, text: '' }; };
  const registry = createRepoRegistry({ store, fetchText, config: baseConfig });
  const added = await registry.add('https://repo.example/x/');
  assert.deepEqual(added, { url: 'https://repo.example/x/index.json', name: 'repo.example', count: 2, sites: 2 });
  assert.deepEqual(asked, ['https://repo.example/x/index.min.json', 'https://repo.example/x/index.json'], 'both names were tried, in order');
  assert.deepEqual(store.writes[0], [{ url: 'https://repo.example/x/index.json', name: 'repo.example' }]);
  assert.equal(store.writes[1], 'flushed');
  store.data.settings.catalogRepos = store.writes[0];
  assert.deepEqual(await registry.list(), [{ url: 'https://repo.example/x/index.json', name: 'repo.example' }]);
  await assert.rejects(registry.add('https://repo.example/x/index.json'), (err) => err.statusCode === 409 && /already/.test(err.message));
  assert.equal(await registry.remove('https://repo.example/x/index.json'), true);
  assert.equal(await registry.remove('https://repo.example/x/index.json'), false, 'a second removal has nothing to remove');
});

test('a repository that answers one name with a small stub and the other with the real list is kept with the real list, whichever name comes first', async () => {
  const stub = indexOf(extension('stuba', 'https://stub-a.example'), extension('stubb', 'https://stub-b.example'));
  const real = indexOf(...['one', 'two', 'three', 'four', 'five'].map((n) => extension(n, `https://${n}.example`)));
  const make = (minText, jsonText) => {
    const store = memoryStore();
    const answers = {
      'https://raw.githubusercontent.com/owner/name/repo/index.min.json': minText === null ? { status: 404, text: '' } : { status: 200, text: minText },
      'https://raw.githubusercontent.com/owner/name/repo/index.json': jsonText === null ? { status: 404, text: '' } : { status: 200, text: jsonText },
    };
    return { store, registry: createRepoRegistry({ store, fetchText: async (url) => answers[url] || { status: 404, text: '' }, config: baseConfig }) };
  };
  const a = make(stub, real);
  const added = await a.registry.add('https://github.com/owner/name');
  assert.deepEqual([added.url, added.count], ['https://raw.githubusercontent.com/owner/name/repo/index.json', 5], 'the stub under index.min.json is not the repository');
  const b = make(real, stub);
  const other = await b.registry.add('https://github.com/owner/name');
  assert.deepEqual([other.url, other.count], ['https://raw.githubusercontent.com/owner/name/repo/index.min.json', 5], 'and the other way round');
  const c = make(real, real);
  assert.equal((await c.registry.add('https://github.com/owner/name')).url, 'https://raw.githubusercontent.com/owner/name/repo/index.min.json', 'equal lists: the first name');
  const d = make(null, stub);
  assert.equal((await d.registry.add('https://github.com/owner/name')).count, 2, 'a stub that is all there is stays what there is');
});

test('an address with no list of extensions behind it is refused and not stored: other answers, other shapes, an error, an empty list', async () => {
  const cases = {
    'a page, not JSON': async () => ({ status: 200, text: '<html>hi</html>' }),
    'JSON of another shape': async () => ({ status: 200, text: JSON.stringify({ hello: 'world' }) }),
    'a list with nothing this app can read': async () => ({ status: 200, text: indexOf({ name: 'x', packageName: 'not.a.package', sources: [] }) }),
    'an error': async () => ({ status: 500, text: '' }),
    'a refusal of the address check': async () => { throw new Error('Blocked unsafe URL'); },
  };
  for (const [label, fetchText] of Object.entries(cases)) {
    const store = memoryStore();
    const registry = createRepoRegistry({ store, fetchText, config: baseConfig });
    await assert.rejects(registry.add('https://repo.example/x/'), (err) => err.statusCode === 422 && /No list of extensions was found/.test(err.message), label);
    assert.deepEqual(store.writes, [], `${label}: nothing was stored`);
  }
  const store = memoryStore();
  const registry = createRepoRegistry({ store, fetchText: async () => { throw new Error('must not be asked'); }, config: baseConfig });
  await assert.rejects(registry.add('http://repo.example/x/'), (err) => err.statusCode === 400, 'a bad address is refused before any request');
  await assert.rejects(registry.add(baseConfig.repoIndexUrl), (err) => err.statusCode === 409, 'the default repository is already there');
  await assert.rejects(registry.add('https://github.com/keiyoushi/extensions'), (err) => err.statusCode === 409, 'and so is the same repository written another way');
  await assert.rejects(registry.add('https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json'), (err) => err.statusCode === 409);
});

test('no more than the cap are kept, and what is stored is read back as strictly as it was accepted: a hand-edited entry cannot make the server fetch what was refused', async () => {
  const store = memoryStore({ catalogRepos: Array.from({ length: MAX_REPOS }, (_, i) => ({ url: `https://r${i}.example/index.min.json`, name: `R${i}` })) });
  const registry = createRepoRegistry({ store, fetchText: async () => ({ status: 200, text: indexOf(extension('a', 'https://a.example')) }), config: baseConfig });
  await assert.rejects(registry.add('https://new.example/'), (err) => err.statusCode === 409 && /At most/.test(err.message));
  const dirty = memoryStore({ catalogRepos: [
    { url: 'https://ok.example/index.min.json', name: 'Ok <b>x</b> "q"' }, { url: 'http://insecure.example/index.min.json' }, { url: 'https://user:p@x.example/index.min.json' }, { url: 'https://127.0.0.1/index.min.json' },
    { url: 'https://x.example:99/index.min.json' }, { url: 'https://x.example/evil.zip' }, { url: 'https://ok.example/index.min.json' }, { url: baseConfig.repoIndexUrl }, null, 'text', 5, { url: 'https://y.example/index.json?x=1' },
    { url: 'https://z.example/a/index.json', name: 'Z'.repeat(200) },
  ] });
  const kept = await createRepoRegistry({ store: dirty, fetchText: async () => ({ status: 404, text: '' }), config: baseConfig }).list();
  assert.deepEqual(kept.map((e) => e.url), ['https://ok.example/index.min.json', 'https://z.example/a/index.json']);
  assert.ok(!/[<>"]/.test(kept[0].name) && kept[1].name.length <= 60, 'a name is plain and short');
  assert.equal(cleanEntry({ url: 'https://ok.example/index.min.json' }).name, 'ok.example');
  assert.equal(cleanEntry(null), null);
});

// ── the catalog that merges them ──────────────────────────────────────────

const DEFAULT_INDEX = JSON.stringify({ name: 'Default', extensionList: { extensions: [extension('alpha', 'https://alpha.example'), extension('shared', 'https://shared.example')] } });
const EXTRA_INDEX = JSON.stringify({ name: 'Extra', extensionList: { extensions: [extension('shared', 'https://shared.example'), extension('omega', 'https://omega.example'), extension('mixed', 'https://mixed.example', 'MIXED'), extension('adult', 'https://adult.example', 'NSFW')] } });
const EXTRA_URL = 'https://extra.example/repo/index.min.json';

function rig({ extras = [{ url: EXTRA_URL, name: 'extra.example' }], answers = {}, warnings } = {}) {
  const asked = [];
  const config = { ...baseConfig, themeSpacingMs: 0, dnsSpacingMs: 0, ...(warnings ? { allowedWarnings: warnings } : {}) };
  const fetchText = async (url) => {
    asked.push(url);
    if (url in answers) { const a = answers[url]; if (a instanceof Error) throw a; return a; }
    if (url === config.repoIndexUrl) return { status: 200, text: DEFAULT_INDEX };
    if (url === EXTRA_URL) return { status: 200, text: EXTRA_INDEX };
    if (/\/src\/en\/([a-z]+)\/build\.gradle\.kts$/.test(url)) return { status: 200, text: ['ext {', '  theme = "madara"', '}'].join('\n') };
    return { status: 404, text: '' };
  };
  const resolver = { resolve4: async () => ['93.184.216.34'], resolve6: async () => [] };
  const catalog = createCatalog({ fetchText, caches: createCaches(''), config, resolver, denylist: () => [], sleep: async () => {}, getExtraRepos: async () => extras });
  return { catalog, asked };
}
async function settled(catalog, params = {}) {
  for (let i = 0; i < 300; i += 1) {
    const out = await catalog.list({ nativeOnly: false, ...params }, {}, {});
    if (!out.pending.themes && !out.pending.dns) return out;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  throw new Error('did not settle');
}

test('the catalog is the default list and the added ones together: each extension once (the first repository wins), the added ones offered to be checked, with the name of their repository', async () => {
  const { catalog, asked } = rig();
  const out = await settled(catalog);
  const byName = Object.fromEntries(out.rows.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(byName).sort(), ['adult Site', 'alpha Site', 'mixed Site', 'omega Site', 'shared Site']);
  assert.equal(byName['omega Site'].via, 'check');
  assert.equal(byName['omega Site'].engine, 'unknown');
  assert.equal(byName['omega Site'].repo, 'extra.example');
  assert.equal(byName['omega Site'].theme, '');
  assert.equal(byName['alpha Site'].repo, '', 'a site of the default repository carries no repository name');
  assert.equal(byName['alpha Site'].via, 'native');
  assert.equal(byName['shared Site'].repo, '', 'an extension in both lists is the default one');
  assert.ok(!asked.some((u) => /build\.gradle/.test(u) && /omega|mixed|adult/.test(u)), 'no theme was read for the extensions of an added repository');
  assert.equal(out.counts.unknown, 3);
  const nativeOnly = await settled(catalog, { nativeOnly: true });
  assert.ok(nativeOnly.rows.some((r) => r.name === 'omega Site'), 'a site to check is offered even when only the addable ones are asked for');
});

test('the edition\'s cap on content still applies to an added repository, and a site chosen from it goes to the generator as one to check', async () => {
  const { catalog } = rig({ warnings: ['SAFE', 'MIXED'] });
  const out = await settled(catalog);
  assert.ok(!out.rows.some((r) => r.name === 'adult Site'), 'an adult site is not offered where the edition does not offer adult sites');
  const omega = out.rows.find((r) => r.name === 'omega Site');
  const site = await catalog.siteOf(omega.key);
  assert.deepEqual([site.url, site.theme, site.warning], ['https://omega.example', 'unknown', 'SAFE']);
  const adult = (await catalog.loadIndex()).extensions.find((e) => e.pkg === PKG('adult'));
  await assert.rejects(catalog.siteOf(`${adult.pkg}#0`), (err) => err.statusCode === 403);
  await assert.rejects(catalog.engineSiteOf(omega.key), (err) => err.statusCode === 403 || err.statusCode === 409, 'the extension engine is only for the default repository');
});

test('a repository that cannot be read is left out and said so, the default one still works, and a changed list of repositories changes the catalog', async () => {
  const down = rig({ answers: { [EXTRA_URL]: new Error('ECONNREFUSED') } });
  const out = await settled(down.catalog);
  assert.ok(out.rows.some((r) => r.name === 'alpha Site') && !out.rows.some((r) => r.name === 'omega Site'));
  assert.deepEqual(await down.catalog.reposStatus(), [{ url: EXTRA_URL, name: 'extra.example', ok: false, count: 0, stale: false }]);
  const up = rig();
  assert.deepEqual(await up.catalog.reposStatus(), [{ url: EXTRA_URL, name: 'extra.example', ok: true, count: 4, stale: false }]);
  let extras = [];
  const asked = [];
  const config = { ...baseConfig, themeSpacingMs: 0, dnsSpacingMs: 0 };
  const fetchText = async (url) => { asked.push(url); return url === EXTRA_URL ? { status: 200, text: EXTRA_INDEX } : { status: 200, text: DEFAULT_INDEX }; };
  const catalog = createCatalog({ fetchText, caches: createCaches(''), config, resolver: { resolve4: async () => [], resolve6: async () => [] }, denylist: () => [], sleep: async () => {}, getExtraRepos: async () => extras });
  assert.equal((await catalog.loadIndex()).extensions.length, 2);
  extras = [{ url: EXTRA_URL, name: 'extra.example' }];
  assert.equal((await catalog.loadIndex()).extensions.length, 5, 'the added repository is in the catalog at once, with no wait for the day-long copy to expire');
  extras = [];
  assert.equal((await catalog.loadIndex()).extensions.length, 2, 'and out of it when it is removed');
  assert.equal(asked.filter((u) => u === EXTRA_URL).length, 1, 'its list was asked once, not on every change');
});

test('the default repository can be removed and put back like any other; without it only the added ones are read, and with none the catalog is empty', async () => {
  const store = memoryStore();
  const registry = createRepoRegistry({ store, fetchText: async () => ({ status: 200, text: DEFAULT_INDEX }), config: baseConfig });
  assert.equal(await registry.defaultOn(), true);
  // The same repository written another way is still the default one.
  assert.equal(await registry.remove('https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json'), true);
  assert.equal(store.data.settings.catalogDefaultOff, true);
  assert.equal(await registry.defaultOn(), false);
  assert.equal(await registry.remove(baseConfig.repoIndexUrl), false, 'a second removal has nothing to remove');
  const back = await registry.add('https://github.com/keiyoushi/extensions');
  assert.deepEqual([back.default, back.url, back.count], [true, baseConfig.repoIndexUrl, 2]);
  assert.equal(await registry.defaultOn(), true);
  assert.equal(store.data.settings.catalogDefaultOff, false, 'put back is a choice too, kept as false (the edition without sources starts without it, so "nothing chosen" is not "on")');
  await assert.rejects(registry.add(baseConfig.repoIndexUrl), (err) => err.statusCode === 409, 'while it is on it cannot be added twice');
  // Putting it back needs the list to be really there, like any other repository, and is not held back by the cap of added ones.
  const full = memoryStore({ catalogDefaultOff: true, catalogRepos: Array.from({ length: MAX_REPOS }, (_, i) => ({ url: `https://r${i}.example/index.min.json`, name: `R${i}` })) });
  const fullRegistry = createRepoRegistry({ store: full, fetchText: async () => ({ status: 404, text: '' }), config: baseConfig });
  await assert.rejects(fullRegistry.add(baseConfig.repoIndexUrl), (err) => err.statusCode === 422);
  assert.equal(await fullRegistry.defaultOn(), false, 'an unreadable address does not switch it on');
  const fullOk = createRepoRegistry({ store: full, fetchText: async () => ({ status: 200, text: DEFAULT_INDEX }), config: baseConfig });
  assert.equal((await fullOk.add(baseConfig.repoIndexUrl)).default, true);

  const asked = [];
  const config = { ...baseConfig, themeSpacingMs: 0, dnsSpacingMs: 0 };
  const fetchText = async (url) => { asked.push(url); return url === EXTRA_URL ? { status: 200, text: EXTRA_INDEX } : { status: 200, text: DEFAULT_INDEX }; };
  let on = false;
  let extras = [{ url: EXTRA_URL, name: 'extra.example' }];
  const catalog = createCatalog({ fetchText, caches: createCaches(''), config, resolver: { resolve4: async () => [], resolve6: async () => [] }, denylist: () => [], sleep: async () => {}, getExtraRepos: async () => extras, getDefaultOn: async () => on });
  const without = await catalog.loadIndex();
  assert.deepEqual(without.extensions.map((e) => e.pkg).sort(), ['alpha', 'shared', 'omega', 'mixed', 'adult'].filter((n) => n !== 'alpha').map(PKG).sort(), 'only the added repository is in the catalog');
  assert.ok(!asked.includes(config.repoIndexUrl), 'the default list was not asked for');
  assert.equal(await catalog.defaultStatus(), null);
  extras = [];
  const empty = await catalog.loadIndex();
  assert.deepEqual([empty.extensions.length, empty.format], [0, null]);
  const out = await catalog.list({ nativeOnly: false }, {}, {});
  assert.deepEqual([out.rows.length, out.total], [0, 0], 'nothing to choose from until a repository is added');
  on = true;
  assert.equal((await catalog.loadIndex()).extensions.length, 2, 'and the default list is read again once it is back');
  assert.deepEqual(await catalog.defaultStatus(), { ok: true, count: 2 });
});

test('the sites of an extension published for every language are also under "all" (Multi), like in the Mihon app; the other languages keep their own', async () => {
  const multi = { name: 'Multi', packageName: 'eu.kanade.tachiyomi.extension.all.multi', versionName: '1.0', contentWarning: 'CONTENT_WARNING_SAFE', sources: [
    { id: '1000000000000000011', name: 'Multi EN', language: 'en', homeUrl: 'https://multi-en.example' },
    { id: '1000000000000000012', name: 'Multi FR', language: 'fr', homeUrl: 'https://multi-fr.example' },
    { id: '1000000000000000013', name: 'Multi All', language: 'all', homeUrl: 'https://multi-all.example' },
  ] };
  const text = indexOf(multi, extension('alpha', 'https://alpha.example'));
  const config = { ...baseConfig, themeSpacingMs: 0, dnsSpacingMs: 0 };
  const catalog = createCatalog({ fetchText: async (url) => (url === config.repoIndexUrl ? { status: 200, text } : { status: 404, text: '' }), caches: createCaches(''), config, resolver: { resolve4: async () => [], resolve6: async () => [] }, denylist: () => [], sleep: async () => {} });
  const names = async (lang) => (await catalog.list({ lang, nativeOnly: false }, {}, {})).rows.map((r) => r.name).sort();
  assert.deepEqual(await names('all'), ['Multi All', 'Multi EN', 'Multi FR'], 'all three, the one in every language and the two of one language each');
  assert.deepEqual(await names('en'), ['Multi EN', 'alpha Site'], 'and English still has its own');
  assert.deepEqual(await names('fr'), ['Multi FR']);
  const counts = Object.fromEntries((await catalog.list({ nativeOnly: false }, {}, {})).languages.map((l) => [l.lang, l.count]));
  assert.deepEqual([counts.all, counts.en, counts.fr], [3, 2, 1], 'a site is counted once under "all", not twice');
});

// ── the routes ───────────────────────────────────────────────────────────

function call(port, method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

async function start(t, { entries = [], fail } = {}) {
  const store = memoryStore();
  const stored = entries.slice();
  const flags = { defaultOn: true };
  const registry = {
    MAX_REPOS: 8,
    defaultOn: async () => flags.defaultOn,
    list: async () => stored.slice(),
    add: async (input) => { if (fail) throw Object.assign(new Error(fail.message), { statusCode: fail.statusCode }); const entry = { url: `https://${String(input).replace(/\W/g, '')}.example/index.min.json`, name: 'added' }; stored.push(entry); return { ...entry, count: 3, sites: 4 }; },
    remove: async (url) => { if (url === baseConfig.repoIndexUrl) { const was = flags.defaultOn; flags.defaultOn = false; return was; } const i = stored.findIndex((e) => e.url === url); if (i < 0) return false; stored.splice(i, 1); return true; },
  };
  const catalog = { reposStatus: async () => stored.map((e) => ({ url: e.url, name: e.name, ok: true, count: 3, stale: false })), defaultStatus: async () => (flags.defaultOn ? { ok: true, count: 900 } : null) };
  catalogRoutes.configure({ catalog, registry });
  const app = express();
  app.use(express.json());
  catalogRoutes.registerSourceCatalogRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return { port: server.address().port, stored, store, flags };
}

test('the routes list, add and remove repositories, only for this computer, and a refusal comes back as the sentence of the registry', async (t) => {
  for (const method of ['GET', 'POST', 'DELETE']) assert.equal(isPrivilegedRoute({ method, originalUrl: '/api/sources/catalog/repos' }), true, method);
  const { port, stored } = await start(t, { entries: [{ url: 'https://one.example/index.min.json', name: 'one' }] });
  const first = await call(port, 'GET', '/api/sources/catalog/repos');
  assert.deepEqual([first.status, first.body.ok, first.body.max, first.body.default], [200, true, 8, baseConfig.repoIndexUrl]);
  assert.equal(first.body.defaultOn, true);
  assert.deepEqual(first.body.repos, [
    { url: baseConfig.repoIndexUrl, name: 'keiyoushi/extensions', ok: true, count: 900, default: true },
    { url: 'https://one.example/index.min.json', name: 'one', ok: true, count: 3 },
  ], 'the default repository is the first row, like the others');
  const added = await call(port, 'POST', '/api/sources/catalog/repos', { input: 'two' });
  assert.deepEqual([added.status, added.body.repo.count, added.body.repo.sites], [200, 3, 4]);
  assert.equal(stored.length, 2);
  const removed = await call(port, 'DELETE', '/api/sources/catalog/repos', { url: 'https://two.example/index.min.json' });
  assert.deepEqual([removed.status, removed.body.removed], [200, true]);
  assert.equal((await call(port, 'DELETE', '/api/sources/catalog/repos', { url: 'https://nothing.example/index.min.json' })).body.removed, false);
  assert.equal((await call(port, 'POST', '/api/sources/catalog/repos', { input: 5 })).status, 200, 'a body that is not text is read as empty, and the registry says what to do');
  const before = stored.length;
  for (const [method, body] of [['GET'], ['POST', { input: 'x' }], ['DELETE', { url: 'x' }]]) {
    const refused = await call(port, method, '/api/sources/catalog/repos', body, { Host: 'localhost.evil.example' });
    assert.equal(refused.status, 403, method);
  }
  assert.equal(stored.length, before, 'nothing changed for a request that was not from this computer');
});

test('removing the default repository takes its row away, and the answer says it is off', async (t) => {
  const { port, flags } = await start(t, { entries: [{ url: 'https://one.example/index.min.json', name: 'one' }] });
  const removed = await call(port, 'DELETE', '/api/sources/catalog/repos', { url: baseConfig.repoIndexUrl });
  assert.deepEqual([removed.status, removed.body.removed, flags.defaultOn], [200, true, false]);
  const after = await call(port, 'GET', '/api/sources/catalog/repos');
  assert.equal(after.body.defaultOn, false);
  assert.deepEqual(after.body.repos.map((r) => r.name), ['one']);
});

test('a refusal of the registry reaches the person with its status; the route is limited, so a page cannot ask a third party over and over', async (t) => {
  const { port } = await start(t, { fail: { statusCode: 422, message: 'No list of extensions was found there (it answered 404).' } });
  const refused = await call(port, 'POST', '/api/sources/catalog/repos', { input: 'x' });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /No list of extensions was found there/);
  let last = 0;
  for (let i = 0; i < 30 && last !== 429; i += 1) last = (await call(port, 'POST', '/api/sources/catalog/repos', { input: 'x' })).status;
  assert.equal(last, 429);
});
