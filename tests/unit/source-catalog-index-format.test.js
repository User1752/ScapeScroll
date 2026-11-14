'use strict';

// Reading the list a repository of Mihon-compatible extensions publishes (server/modules/source-catalog/index-format.js). The text is
// third-party data: what matters is that both layouts are understood, that nothing but short plain strings comes out, and that a site
// a source cannot be written for (not plain https) is left out.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRepoIndex, warningOf, httpsOrigin } = require('../../server/modules/source-catalog/index-format');

const PKG = (lang, name) => `eu.kanade.tachiyomi.extension.${lang}.${name}`;
const ext = (over = {}) => ({
  name: 'Alpha Scans', packageName: PKG('en', 'alpha'), versionName: '1.4.2', contentWarning: 'CONTENT_WARNING_SAFE',
  sources: [{ id: '1', name: 'Alpha Scans', language: 'en', homeUrl: 'https://alpha.example/' }],
  ...over,
});
const current = (extensions) => ({ name: 'Repo', badgeLabel: 'R', extensionList: { extensions } });

test('the current layout: an extension, its sites, its content warning and its version', () => {
  const out = parseRepoIndex(current([ext(), ext({ name: 'Beta', packageName: PKG('en', 'beta'), contentWarning: 'CONTENT_WARNING_NSFW', sources: [{ id: '2', name: 'Beta', language: 'en', homeUrl: 'https://beta.example/path?x=1' }] })]));
  assert.equal(out.format, 'current');
  assert.equal(out.extensions.length, 2);
  assert.deepEqual(out.extensions[0], { pkg: PKG('en', 'alpha'), name: 'Alpha Scans', version: '1.4.2', icon: '', warning: 'SAFE', sites: [{ sourceId: '1', name: 'Alpha Scans', lang: 'en', url: 'https://alpha.example', host: 'alpha.example' }] });
  assert.equal(out.extensions[1].warning, 'NSFW');
  assert.equal(out.extensions[1].sites[0].url, 'https://beta.example', 'only the origin of the address is kept');
});

test('the old layout (a plain array) is understood, and its adult flag becomes a content warning', () => {
  const out = parseRepoIndex([
    { name: 'Old', pkg: PKG('en', 'old'), version: '1.0', nsfw: 0, sources: [{ name: 'Old', lang: 'en', id: '1', baseUrl: 'https://old.example' }] },
    { name: 'Adult', pkg: PKG('en', 'adult'), version: '1.0', nsfw: 1, sources: [{ name: 'Adult', lang: 'en', id: '2', baseUrl: 'https://adult.example' }] },
  ]);
  assert.equal(out.format, 'old');
  assert.deepEqual(out.extensions.map((e) => e.warning), ['SAFE', 'NSFW']);
});

test('the content warning is read in every spelling the repositories use, and an unknown one is the careful middle, never SAFE', () => {
  assert.equal(warningOf('CONTENT_WARNING_SAFE'), 'SAFE');
  assert.equal(warningOf('CONTENT_WARNING_MIXED'), 'MIXED');
  assert.equal(warningOf('nsfw'), 'NSFW');
  assert.equal(warningOf(3), 'NSFW');
  assert.equal(warningOf('CONTENT_WARNING_UNSPECIFIED'), 'SAFE');
  for (const odd of ['', 'whatever', null, undefined, 9, {}]) assert.equal(warningOf(odd), 'MIXED', String(odd));
});

test('a site that is not a plain https address is left out, and an extension left with no site is left out', () => {
  for (const homeUrl of ['http://plain.example/', 'https://user:pw@login.example/', 'https://port.example:8443/', 'ftp://files.example/', 'not a url', '', undefined, 42]) {
    assert.equal(httpsOrigin(homeUrl), '', String(homeUrl));
  }
  const out = parseRepoIndex(current([
    ext(),
    ext({ name: 'Plain', packageName: PKG('en', 'plain'), sources: [{ id: '1', name: 'Plain', language: 'en', homeUrl: 'http://plain.example' }] }),
  ]));
  assert.deepEqual(out.extensions.map((e) => e.name), ['Alpha Scans']);
});

test('an extension whose package is not shaped like one is dropped (the package is later used to build an address)', () => {
  const hostile = ['../../etc/passwd', 'eu.kanade.tachiyomi.extension.en.a/b', 'eu.kanade.tachiyomi.extension.en.', 'eu.kanade.tachiyomi.extension.EN.alpha', 'com.evil.alpha', '', undefined];
  const out = parseRepoIndex(current([ext(), ...hostile.map((packageName) => ext({ packageName }))]));
  assert.equal(out.extensions.length, 1);
});

test('names are plain one-line text: control and bidi characters go, long names are cut, a missing name falls back', () => {
  // Built from code points: an escape typed in this file could be turned into the character itself by an editor.
  const c = (code) => String.fromCharCode(code);
  const evil = `Evil${c(0)} ${c(0x202e)}Name${c(0x2028)}with${c(0x2029)}breaks\n\tand ${'x'.repeat(200)}`;
  const out = parseRepoIndex(current([ext({ name: evil, sources: [{ id: '1', name: evil, language: 'en', homeUrl: 'https://alpha.example' }, { id: '2', name: '', language: 'en', homeUrl: 'https://beta.example' }] })]));
  const [a, b] = out.extensions[0].sites;
  const forbidden = new RegExp(`[${c(0)}-${c(0x1f)}${c(0x202e)}${c(0x2028)}${c(0x2029)}]`);
  assert.doesNotMatch(a.name, forbidden);
  assert.doesNotMatch(out.extensions[0].name, forbidden);
  assert.equal(a.name.length, 80);
  assert.ok(out.extensions[0].name.length <= 80);
  assert.equal(b.name, 'beta.example', 'a site with no name is called by its host');
});

test('a site language that is not a language code is replaced by the one in the package; "all" is kept', () => {
  const out = parseRepoIndex(current([ext({ sources: [
    { id: '1', name: 'A', language: 'en', homeUrl: 'https://a.example' },
    { id: '2', name: 'B', language: '<script>', homeUrl: 'https://b.example' },
    { id: '3', name: 'C', language: 'all', homeUrl: 'https://c.example' },
    { id: '4', name: 'D', language: 'pt-BR', homeUrl: 'https://d.example' },
  ] })]));
  assert.deepEqual(out.extensions[0].sites.map((s) => s.lang), ['en', 'en', 'all', 'pt-BR']);
});

test('the id of a source is kept only as a whole number written as text: a JS number, a sign, letters or a long run of digits are not an id', () => {
  const sourceIds = (ids) => parseRepoIndex(current([ext({ sources: ids.map((id, i) => ({ id, name: `S${i}`, language: 'en', homeUrl: `https://s${i}.example` })) })])).extensions[0].sites.map((s) => s.sourceId);
  assert.deepEqual(sourceIds(['6289731484943315811', '12', 12, -5, 'abc', '1'.repeat(21), '', null, undefined, '12 34', '1e5']), ['6289731484943315811', '12', '', '', '', '', '', '', '', '', '']);
  const old = parseRepoIndex([{ name: 'Old', pkg: PKG('en', 'old'), version: '1.0', nsfw: 0, sources: [{ name: 'Old', lang: 'en', id: '77', baseUrl: 'https://old.example' }] }]);
  assert.equal(old.extensions[0].sites[0].sourceId, '77', 'the old layout names it the same way');
});

test('what is not a list of extensions is refused with a plain sentence', () => {
  assert.throws(() => parseRepoIndex(null), /not a list/);
  assert.throws(() => parseRepoIndex('text'), /not a list/);
  assert.throws(() => parseRepoIndex({ name: 'x' }), /not a list/);
  assert.throws(() => parseRepoIndex({ extensionListUrl: 'https://x.example/list' }), /separate file/);
  assert.throws(() => parseRepoIndex([]), /no extension/);
  assert.throws(() => parseRepoIndex(current([{ garbage: true }])), /no extension/);
});

test('a very long list is cut instead of read whole', () => {
  const many = Array.from({ length: 5200 }, (_, i) => ext({ packageName: PKG('en', `ext${i}`), name: `E${i}` }));
  assert.equal(parseRepoIndex(current(many)).extensions.length, 5000);
  const sites = Array.from({ length: 450 }, (_, i) => ({ id: String(i), name: `S${i}`, language: 'en', homeUrl: `https://s${i}.example` }));
  assert.equal(parseRepoIndex(current([ext({ sources: sites })])).extensions[0].sites.length, 400);
});

test('the icon of an extension is kept only when it is a plain https address on the CDN the logos come from; anything else leaves the initial', () => {
  const good = 'https://cdn.jsdelivr.net/gh/keiyoushi/extensions@repo/icon/eu.kanade.tachiyomi.extension.en.alpha.png';
  const icon = (iconUrl) => parseRepoIndex(current([ext({ resources: { iconUrl } })])).extensions[0].icon;
  assert.equal(icon(good), good);
  const bad = ['http://cdn.jsdelivr.net/a.png', 'https://evil.example/a.png', 'https://cdn.jsdelivr.net/a.png?x=1', 'https://cdn.jsdelivr.net/a.png#x', 'https://user:pw@cdn.jsdelivr.net/a.png', 'https://cdn.jsdelivr.net:8443/a.png', 'javascript:alert(1)', `https://cdn.jsdelivr.net/${'a'.repeat(400)}`, 42, null, undefined];
  for (const value of bad) assert.equal(icon(value), '', String(value));
  assert.equal(parseRepoIndex(current([ext()])).extensions[0].icon, '', 'an extension with no resources has no icon');
});
