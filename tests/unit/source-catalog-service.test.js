'use strict';

// The source catalog service (server/modules/source-catalog/catalog.js) with the network replaced: a made-up repository list, made-up
// build files, a made-up DNS. What is asserted is what the person sees (the rows, their labels, the filters, the pages), what an edition
// may offer (the SAFE-only cap that the browser cannot widen), and what the service refuses to hand to the code that installs sources.

const test = require('node:test');
const assert = require('node:assert/strict');
const baseConfig = require('../../server/config/catalog');
const { createCatalog, createCaches, engineOf } = require('../../server/modules/source-catalog/catalog');
const { FALLBACK_V4, FALLBACK_V6 } = require('../../server/modules/source-catalog/cloudflare');

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const PKG = (lang, name) => `eu.kanade.tachiyomi.extension.${lang}.${name}`;
// Every site has an id of its own, like the 19-digit ones of the real list (text, never a number).
let siteCounter = 0;
const site = (name, url, language = 'en', id) => ({ id: id === undefined ? String(6289731484943310000n + BigInt(siteCounter += 1)) : id, name, language, homeUrl: url });
const ext = (lang, name, warning, sources) => ({ name: name[0].toUpperCase() + name.slice(1), packageName: PKG(lang, name), versionName: '1.0.1', contentWarning: `CONTENT_WARNING_${warning}`, sources });

const INDEX = {
  name: 'Repo',
  extensionList: {
    extensions: [
      ext('en', 'alpha', 'SAFE', [site('Alpha Scans', 'https://alpha.example')]),
      ext('en', 'beta', 'MIXED', [site('Beta Comics', 'https://beta.example')]),
      ext('en', 'gamma', 'NSFW', [site('Gamma Adult', 'https://gamma.example')]),
      ext('en', 'delta', 'SAFE', [site('Delta Own', 'https://delta.example')]),
      ext('en', 'zeta', 'SAFE', [site('Zeta Later', 'https://zeta.example')]),
      ext('en', 'multi', 'SAFE', [site('Multi One', 'https://multi1.example'), site('Multi Two', 'https://multi2.example')]),
      ext('en', 'lost', 'SAFE', [site('Lost Theme', 'https://lost.example')]),
      ext('en', 'blocked', 'SAFE', [site('Blocked Site', 'https://blocked.example')]),
      ext('pt', 'epsilon', 'SAFE', [site('Epsilon PT', 'https://epsilon.example', 'pt')]),
    ],
  },
};
// What each extension is built on; delta names none (a scraper of its own), lost has no build file at all.
const THEMES = { alpha: 'madara', beta: 'madara', gamma: 'madara', delta: null, zeta: 'zeistmanga', multi: 'mangathemesia', epsilon: 'madara', blocked: 'madara' };
// What the DNS answers for a site's name.
const CF = ['104.16.1.1'];
const PLAIN = ['93.184.216.34'];
const DNS = { 'alpha.example': CF, 'beta.example': PLAIN, 'gamma.example': PLAIN, 'multi1.example': CF, 'multi2.example': PLAIN, 'epsilon.example': PLAIN, 'blocked.example': PLAIN };

function rig(over = {}) {
  const { config: configOver = {}, fetchOver, index = INDEX, caches = createCaches(''), denylist = () => ['blocked.example'], now } = over;
  const config = { ...baseConfig, themeSpacingMs: 0, dnsSpacingMs: 0, ...configOver };
  const asked = [];
  const fetchText = async (url) => {
    asked.push(url);
    if (fetchOver) { const answer = await fetchOver(url); if (answer) return answer; }
    if (url === config.repoIndexUrl) return { status: 200, text: JSON.stringify(index) };
    if (url === config.cloudflareRangesUrls.v4) return { status: 200, text: FALLBACK_V4.join('\n') };
    if (url === config.cloudflareRangesUrls.v6) return { status: 200, text: FALLBACK_V6.join('\n') };
    const match = /\/src\/en\/([a-z]+)\/build\.gradle\.kts$|\/src\/pt\/([a-z]+)\/build\.gradle\.kts$/.exec(url);
    const name = match && (match[1] || match[2]);
    if (name && name in THEMES) return { status: 200, text: THEMES[name] ? `ext {\n  theme = "${THEMES[name]}"\n}` : 'ext { extName = "x" }' };
    return { status: 404, text: '' };
  };
  const resolver = {
    resolve4: async (host) => { asked.push(`dns:${host}`); return DNS[host] || []; },
    resolve6: async () => [],
  };
  const catalog = createCatalog({ fetchText, caches, config, resolver, denylist, sleep: tick, ...(now ? { now } : {}) });
  return { catalog, asked, caches, config };
}

/** Lists again until the background reading has nothing left to do. */
async function settled(catalog, params = {}, installed = {}, options = {}) {
  for (let i = 0; i < 400; i += 1) {
    const out = await catalog.list(params, installed, options);
    if (!out.pending.themes && !out.pending.dns) return out;
    await tick();
  }
  throw new Error('the background reading did not finish');
}

const names = (out) => out.rows.map((row) => row.name);

test('the first page of the list is the English sites a source can be written for, each marked with what it is', async () => {
  const { catalog } = rig();
  const first = await catalog.list();
  assert.deepEqual(first.rows, [], 'what the sites are built on is not known yet: nothing is offered on a guess');
  assert.ok(first.pending.themes > 0);
  const out = await settled(catalog);
  assert.deepEqual(names(out), ['Alpha Scans', 'Beta Comics', 'Blocked Site', 'Gamma Adult', 'Multi One', 'Multi Two']);
  const alpha = out.rows[0];
  assert.equal(alpha.key, `${PKG('en', 'alpha')}#0`);
  assert.deepEqual({ engine: alpha.engine, theme: alpha.theme, cloudflare: alpha.cloudflare, warning: alpha.warning, installed: alpha.installed, host: alpha.host }, { engine: 'ready', theme: 'madara', cloudflare: 'yes', warning: 'SAFE', installed: false, host: 'alpha.example' });
  assert.equal(out.rows.find((r) => r.name === 'Beta Comics').cloudflare, 'no');
  assert.equal(out.rows.find((r) => r.name === 'Multi Two').key, `${PKG('en', 'multi')}#1`, 'a second site of the same extension is told apart');
  assert.ok(!('url' in alpha), 'the browser is never given an address to send back');
});

test('a row carries the logo of its extension when the list names one on the CDN, and an empty one otherwise', async () => {
  const logo = 'https://cdn.jsdelivr.net/gh/keiyoushi/extensions@repo/icon/alpha.png';
  const index = { name: 'Repo', extensionList: { extensions: [
    { ...ext('en', 'alpha', 'SAFE', [site('Alpha Scans', 'https://alpha.example')]), resources: { iconUrl: logo } },
    { ...ext('en', 'beta', 'MIXED', [site('Beta Comics', 'https://beta.example')]), resources: { iconUrl: 'https://evil.example/beta.png' } },
  ] } };
  const { catalog } = rig({ index });
  const out = await settled(catalog);
  assert.equal(out.rows.find((r) => r.name === 'Alpha Scans').icon, logo);
  assert.equal(out.rows.find((r) => r.name === 'Beta Comics').icon, '');
});

test('with "only automatic" off, the sites it cannot write are listed with the reason, and the counts say how many of each', async () => {
  const { catalog } = rig();
  const out = await settled(catalog, { nativeOnly: false });
  assert.deepEqual(Object.fromEntries(out.rows.map((r) => [r.name, r.engine])), {
    'Alpha Scans': 'ready', 'Beta Comics': 'ready', 'Gamma Adult': 'ready', 'Delta Own': 'handwritten', 'Zeta Later': 'later', 'Multi One': 'ready', 'Multi Two': 'ready', 'Lost Theme': 'unknown', 'Blocked Site': 'ready',
  });
  assert.deepEqual(out.counts, { ready: 6, later: 1, handwritten: 1, checking: 0, unknown: 1, failed: 0 });
  assert.equal(out.rows.find((r) => r.name === 'Delta Own').cloudflare, 'n/a', 'Cloudflare is only looked up for a site that can be added');
});

test('the language filter: English by default, another on request, and the list of languages with their counts', async () => {
  const { catalog } = rig();
  const pt = await settled(catalog, { lang: 'pt' });
  assert.deepEqual(names(pt), ['Epsilon PT']);
  const en = await settled(catalog);
  assert.deepEqual(en.languages, [{ lang: 'en', count: 9 }, { lang: 'pt', count: 1 }]);
  assert.equal((await catalog.list({ lang: '<script>' })).lang, 'en', 'a value that is not a language code falls back to English');
});

test('Light: an edition that offers only SAFE content never lists more, whatever the browser asks for', async () => {
  const { catalog } = rig({ config: { allowedWarnings: ['SAFE'] } });
  for (const warnings of [undefined, ['SAFE'], ['SAFE', 'MIXED', 'NSFW'], ['NSFW'], ['MIXED', 'NSFW'], [], 'NSFW']) {
    const out = await settled(catalog, { nativeOnly: false, warnings });
    assert.ok(out.rows.every((row) => row.warning === 'SAFE'), JSON.stringify(warnings));
    assert.ok(!names(out).includes('Beta Comics') && !names(out).includes('Gamma Adult'), JSON.stringify(warnings));
  }
  await assert.rejects(catalog.siteOf(`${PKG('en', 'gamma')}#0`), (err) => err.statusCode === 403 && /not available in this edition/.test(err.message));
  await assert.rejects(catalog.siteOf(`${PKG('en', 'beta')}#0`), (err) => err.statusCode === 403);
  assert.equal((await catalog.siteOf(`${PKG('en', 'alpha')}#0`)).url, 'https://alpha.example');
});

test('Complete: the person can narrow the content (Hide NSFW asks for SAFE only), never widen it past the edition', async () => {
  const { catalog } = rig();
  const all = await settled(catalog);
  assert.deepEqual(all.rows.map((r) => r.warning).sort(), ['MIXED', 'NSFW', 'SAFE', 'SAFE', 'SAFE', 'SAFE']);
  const safe = await settled(catalog, { warnings: ['SAFE'] });
  assert.deepEqual(names(safe), ['Alpha Scans', 'Blocked Site', 'Multi One', 'Multi Two']);
  const noise = await settled(catalog, { warnings: ['SAFE', 'BOGUS', 7, null] });
  assert.deepEqual(names(noise), ['Alpha Scans', 'Blocked Site', 'Multi One', 'Multi Two'], 'a warning that does not exist is ignored');
});

test('"hide sites behind Cloudflare" leaves out the ones whose name answers a Cloudflare address, and keeps those not known yet', async () => {
  const { catalog } = rig();
  const out = await settled(catalog, { hideCloudflare: true });
  assert.deepEqual(names(out), ['Beta Comics', 'Blocked Site', 'Gamma Adult', 'Multi Two']);
  const early = rig();
  await early.catalog.list();
  await tick();
  const during = await early.catalog.list({ hideCloudflare: true });
  assert.ok(during.rows.every((row) => row.cloudflare !== 'yes'));
});

test('search by name, address or extension, and pages of the list', async () => {
  const { catalog } = rig();
  assert.deepEqual(names(await settled(catalog, { q: 'multi' })), ['Multi One', 'Multi Two']);
  assert.deepEqual(names(await settled(catalog, { q: ' ALPHA.EXAMPLE ' })), ['Alpha Scans']);
  assert.deepEqual(names(await settled(catalog, { q: 'nothing like this' })), []);
  const page1 = await settled(catalog, { limit: 2 });
  const page2 = await settled(catalog, { limit: 2, offset: 2 });
  const page3 = await settled(catalog, { limit: 2, offset: 4 });
  assert.equal(page1.total, 6);
  assert.deepEqual([...names(page1), ...names(page2), ...names(page3)], ['Alpha Scans', 'Beta Comics', 'Blocked Site', 'Gamma Adult', 'Multi One', 'Multi Two']);
  assert.equal((await settled(catalog, { limit: 100000 })).limit, baseConfig.maxPageSize, 'a page is never longer than the cap');
  assert.equal((await settled(catalog, { offset: -5 })).offset, 0);
});

test('a site already installed is marked: by the id a source for it would get, or by the address of a source written from a link', async () => {
  const { catalog } = rig();
  const out = await settled(catalog, {}, { ids: new Set(['alpha']), bases: new Set(['https://multi2.example']) });
  assert.deepEqual(out.rows.filter((r) => r.installed).map((r) => r.name), ['Alpha Scans', 'Multi Two']);
});

test('"hide 18+" leaves out the adult sites only, and "hide added" leaves out the sites already installed, both before the pages are cut', async () => {
  const { catalog } = rig();
  const all = await settled(catalog);
  assert.ok(names(all).includes('Gamma Adult'));
  const noAdult = await settled(catalog, { hideAdult: true });
  assert.ok(!names(noAdult).includes('Gamma Adult'));
  assert.ok(names(noAdult).includes('Beta Comics'), 'mixed content is not adult content: it keeps its badge instead');
  assert.equal(noAdult.total, all.total - 1);
  const installed = { ids: new Set(['alpha']), bases: new Set(['https://multi2.example']) };
  const fresh = await settled(catalog, { hideInstalled: true }, installed);
  assert.ok(!names(fresh).includes('Alpha Scans') && !names(fresh).includes('Multi Two'));
  assert.equal(fresh.total, all.total - 2);
  assert.ok(fresh.rows.every((r) => !r.installed));
  assert.equal((await settled(catalog, { hideInstalled: 'yes', hideAdult: 1 }, installed)).total, all.total, 'only the value true switches a filter on');
});

test('"show only added" lists the sites that are added whatever the app could do with them, each with the id of its source; others have none', async () => {
  const { catalog } = rig();
  const delta = INDEX.extensionList.extensions.find((e) => e.packageName === PKG('en', 'delta')).sources[0];
  const installed = { ids: new Set(['alpha', `sw-${delta.id}`]), bases: new Set(['https://multi2.example']), byBase: new Map([['https://multi2.example', 'multi-two']]) };
  const out = await settled(catalog, { onlyInstalled: true, nativeOnly: true }, installed, { extensionEngine: true });
  assert.deepEqual(names(out), ['Alpha Scans', 'Delta Own', 'Multi Two']);
  assert.deepEqual(out.rows.map((r) => r.installedId), ['alpha', `sw-${delta.id}`, 'multi-two']);
  const all = await settled(catalog, {}, installed);
  assert.ok(all.rows.filter((r) => !r.installed).every((r) => r.installedId === ''));
  const nobody = await settled(catalog, { onlyInstalled: true }, {});
  assert.equal(nobody.total, 0);
  assert.equal((await settled(catalog, { onlyInstalled: 'yes' }, installed)).total, all.total, 'only the value true switches it on');
});

test('a site that could not be added is not offered as automatic for a while: through the engine when that is set up, else not at all; the others are untouched', async () => {
  const { catalog, caches } = rig();
  await settled(catalog);
  assert.equal(await catalog.markFailed(`${PKG('en', 'alpha')}#0`, 'probe'), true);
  assert.equal(await catalog.markFailed('not a key', 'x'), false);
  assert.equal(await catalog.markFailed(`${PKG('en', 'alpha')}#9`, 'x'), false, 'a position that is not a row');
  const out = await settled(catalog);
  assert.ok(!names(out).includes('Alpha Scans'), 'hidden from the automatic list');
  assert.ok(names(out).includes('Beta Comics'));
  const all = await settled(catalog, { nativeOnly: false });
  const alpha = all.rows.find((r) => r.name === 'Alpha Scans');
  assert.deepEqual({ engine: alpha.engine, via: alpha.via }, { engine: 'failed', via: '' });
  assert.equal(all.counts.failed, 1);
  const viaEngine = await settled(catalog, {}, {}, { extensionEngine: true });
  assert.equal(viaEngine.rows.find((r) => r.name === 'Alpha Scans').via, 'engine', 'with a Suwayomi-Server the site can still be added through it');
  assert.ok(caches.failed.getFresh('alpha.example', 24 * 3_600_000), 'it is kept by the name of the site');
});

test('a site on the person\'s list of dangerous sites is shown as blocked, and its name is never looked up in the DNS', async () => {
  const { catalog, asked } = rig();
  const out = await settled(catalog, { nativeOnly: false });
  const blocked = out.rows.find((r) => r.name === 'Blocked Site');
  assert.equal(blocked.blocked, true);
  assert.ok(!asked.includes('dns:blocked.example'));
  assert.ok(asked.includes('dns:alpha.example'));
  await assert.rejects(catalog.siteOf(`${PKG('en', 'blocked')}#0`), (err) => err.statusCode === 403 && /dangerous/.test(err.message));
});

test('each repository file is asked for once: the list, every build file, every name in the DNS', async () => {
  const { catalog, asked } = rig();
  await settled(catalog);
  const before = asked.length;
  await settled(catalog);
  await settled(catalog, { q: 'alpha' });
  assert.equal(asked.length, before, 'nothing is asked again while what was learned is fresh');
  assert.equal(asked.filter((url) => url === baseConfig.repoIndexUrl).length, 1);
  assert.equal(asked.filter((url) => /alpha\/build\.gradle\.kts$/.test(url)).length, 1);
  assert.equal(asked.filter((url) => url === 'dns:alpha.example').length, 1);
});

test('two requests at the same moment read the repository once', async () => {
  const { catalog, asked } = rig();
  await Promise.all([catalog.list(), catalog.list(), catalog.loadIndex()]);
  assert.equal(asked.filter((url) => url === baseConfig.repoIndexUrl).length, 1);
});

test('siteOf hands over the repository\'s address and the id a source would get, only for a site a source can be written for', async () => {
  const { catalog } = rig();
  assert.deepEqual(await catalog.siteOf(`${PKG('en', 'multi')}#1`), { url: 'https://multi2.example', name: 'Multi Two', pkg: PKG('en', 'multi'), theme: 'mangathemesia', warning: 'SAFE', id: 'multi2' });
  await assert.rejects(catalog.siteOf(`${PKG('en', 'delta')}#0`), (err) => err.statusCode === 409 && /by hand/.test(err.message));
  await assert.rejects(catalog.siteOf(`${PKG('en', 'zeta')}#0`), (err) => err.statusCode === 409 && /no template for yet/.test(err.message));
  await assert.rejects(catalog.siteOf(`${PKG('en', 'lost')}#0`), (err) => err.statusCode === 409 && /could not be found/.test(err.message));
});

test('siteOf takes only a key of the list: anything else, and a site that is not there, is refused', async () => {
  const { catalog } = rig();
  for (const key of ['', undefined, null, 42, 'https://evil.example', '../x#0', `${PKG('en', 'alpha')}`, `${PKG('en', 'alpha')}#`, `${PKG('en', 'alpha')}#1x`, 'alpha#0 ']) {
    await assert.rejects(catalog.siteOf(key), (err) => err.statusCode === 400, String(key));
  }
  await assert.rejects(catalog.siteOf(`${PKG('en', 'alpha')}#5`), (err) => err.statusCode === 404);
  await assert.rejects(catalog.siteOf(`${PKG('en', 'nosuch')}#0`), (err) => err.statusCode === 404);
});

test('siteOf reads the theme itself when the background has not got to it, and says so when GitHub does not answer', async () => {
  const { catalog, asked } = rig();
  assert.equal((await catalog.siteOf(`${PKG('en', 'alpha')}#0`)).theme, 'madara');
  assert.ok(asked.some((url) => /alpha\/build\.gradle\.kts$/.test(url)));
  const down = rig({ fetchOver: async (url) => { if (/build\.gradle\.kts$/.test(url)) throw new Error('offline'); return null; } });
  await assert.rejects(down.catalog.siteOf(`${PKG('en', 'alpha')}#0`), (err) => err.statusCode === 502 && /GitHub did not answer/.test(err.message));
});

test('when the repository cannot be read an older copy is used and said to be old; with no copy the person gets a plain sentence', async () => {
  const caches = createCaches('');
  const first = rig({ caches, config: { indexTtlMs: 1 } });
  await first.catalog.list();
  await new Promise((resolve) => { setTimeout(resolve, 10); });
  const offline = rig({ caches, config: { indexTtlMs: 1 }, fetchOver: async (url) => { if (url === baseConfig.repoIndexUrl) throw new Error('offline'); return null; } });
  const out = await offline.catalog.list();
  assert.equal(out.stale, true);
  const none = rig({ fetchOver: async (url) => { if (url === baseConfig.repoIndexUrl) throw new Error('offline'); return null; } });
  await assert.rejects(none.catalog.list(), (err) => err.statusCode === 502 && /could not be read/.test(err.message));
  const garbage = rig({ fetchOver: async (url) => (url === baseConfig.repoIndexUrl ? { status: 200, text: '<html>not json' } : null) });
  await assert.rejects(garbage.catalog.list(), (err) => err.statusCode === 502);
  const refused = rig({ fetchOver: async (url) => (url === baseConfig.repoIndexUrl ? { status: 503, text: '' } : null) });
  await assert.rejects(refused.catalog.list(), (err) => err.statusCode === 502 && /503/.test(err.message));
});

test('after the breaker opens the screen is told reading is paused, and sites whose theme could not be read are called unknown, not guessed', async () => {
  const { catalog } = rig({
    config: { failureBreakerCount: 2, failureBreakerMs: 60_000, themeConcurrency: 1 },
    fetchOver: async (url) => { if (/build\.gradle\.kts$/.test(url)) throw new Error('offline'); return null; },
  });
  let out;
  for (let i = 0; i < 200; i += 1) { out = await catalog.list({ nativeOnly: false }); if (out.pending.paused) break; await tick(); }
  assert.equal(out.pending.paused, true);
  assert.ok(out.rows.every((row) => row.engine === 'unknown' || row.engine === 'checking'));
  assert.ok(out.rows.every((row) => row.engine !== 'ready'));
  catalog.close(); // the queue would otherwise keep waiting out the pause
});

const idOf = (name) => INDEX.extensionList.extensions.flatMap((e) => e.sources).find((s) => s.name === name).id;

test('with a Suwayomi-Server set up, a site with a scraper of its own can be added through it, and a site with a template stays on the template', async () => {
  const { catalog } = rig();
  const out = await settled(catalog, { nativeOnly: true }, {}, { extensionEngine: true });
  const via = Object.fromEntries(out.rows.map((r) => [r.name, r.via]));
  assert.equal(via['Alpha Scans'], 'native');
  assert.deepEqual({ own: via['Delta Own'], later: via['Zeta Later'], lost: via['Lost Theme'] }, { own: 'engine', later: 'engine', lost: 'engine' });
  assert.deepEqual(out.extensionEngine, { available: true, enabled: true });
  assert.equal(out.rows.find((r) => r.name === 'Delta Own').cloudflare, 'n/a', 'the DNS is only asked about a site that is written from a template');
});

test('with none set up the same sites are not offered at all, and the answer says the engine exists but is not set up', async () => {
  const { catalog } = rig();
  const out = await settled(catalog, { nativeOnly: true }, {}, {});
  assert.ok(out.rows.every((r) => r.via === 'native'));
  assert.ok(!names(out).includes('Delta Own'));
  assert.deepEqual(out.extensionEngine, { available: true, enabled: false });
  const all = await settled(catalog, { nativeOnly: false }, {}, {});
  assert.equal(all.rows.find((r) => r.name === 'Delta Own').via, '', 'listed, but with no way to add it');
});

test('an edition without the engine never offers it, even when a server is set up', async () => {
  const { catalog } = rig({ config: { extensionEngine: false } });
  const out = await settled(catalog, { nativeOnly: false }, {}, { extensionEngine: true });
  assert.ok(out.rows.every((r) => r.via !== 'engine'));
  assert.deepEqual(out.extensionEngine, { available: false, enabled: false });
  await assert.rejects(catalog.engineSiteOf(`${PKG('en', 'delta')}#0`), (err) => err.statusCode === 403 && /not available here/.test(err.message));
});

test('a site added through the engine is marked as added by the id its source has', async () => {
  const { catalog } = rig();
  const out = await settled(catalog, { nativeOnly: true }, { ids: new Set([`sw-${idOf('Delta Own')}`]) }, { extensionEngine: true });
  assert.deepEqual(out.rows.filter((r) => r.installed).map((r) => r.name), ['Delta Own']);
});

test('engineSiteOf hands over the repository\'s package and source id, needs no theme, and refuses what the template route refuses', async () => {
  const { catalog, asked } = rig();
  assert.deepEqual(await catalog.engineSiteOf(`${PKG('en', 'delta')}#0`), { pkg: PKG('en', 'delta'), sourceId: idOf('Delta Own'), name: 'Delta Own', lang: 'en', warning: 'SAFE', id: `sw-${idOf('Delta Own')}` });
  assert.ok(!asked.some((url) => /build\.gradle\.kts$/.test(url)), 'the engine runs any extension: the theme is not read');
  await assert.rejects(catalog.engineSiteOf(`${PKG('en', 'blocked')}#0`), (err) => err.statusCode === 403 && /dangerous/.test(err.message));
  for (const key of ['', undefined, 'https://evil.example', '../x#0', `${PKG('en', 'delta')}#1x`]) await assert.rejects(catalog.engineSiteOf(key), (err) => err.statusCode === 400, String(key));
  await assert.rejects(catalog.engineSiteOf(`${PKG('en', 'delta')}#5`), (err) => err.statusCode === 404);
  await assert.rejects(catalog.engineSiteOf(`${PKG('en', 'nosuch')}#0`), (err) => err.statusCode === 404);
  const light = rig({ config: { allowedWarnings: ['SAFE'] } });
  await assert.rejects(light.catalog.engineSiteOf(`${PKG('en', 'gamma')}#0`), (err) => err.statusCode === 403 && /not available here/.test(err.message));
});

test('a site the repository gives no id for cannot be added through the engine, and is not offered', async () => {
  const noId = { name: 'Repo', extensionList: { extensions: [ext('en', 'orphan', 'SAFE', [site('Orphan', 'https://orphan.example', 'en', '')])] } };
  const { catalog } = rig({ index: noId, fetchOver: async (url) => (/orphan\/build\.gradle\.kts$/.test(url) ? { status: 200, text: 'ext { extName = "x" }' } : null) });
  const out = await settled(catalog, { nativeOnly: false }, {}, { extensionEngine: true });
  assert.equal(out.rows[0].via, '');
  await assert.rejects(catalog.engineSiteOf(`${PKG('en', 'orphan')}#0`), (err) => err.statusCode === 409 && /does not give an id/.test(err.message));
});

test('engineOf: what each theme means for this app', () => {
  assert.equal(engineOf('madara'), 'ready');
  assert.equal(engineOf('mangathemesia'), 'ready');
  assert.equal(engineOf('custom'), 'handwritten');
  assert.equal(engineOf('unknown'), 'unknown');
  assert.equal(engineOf('zeistmanga'), 'later');
  assert.equal(engineOf(null), 'checking');
  assert.equal(engineOf(undefined), 'checking');
});
