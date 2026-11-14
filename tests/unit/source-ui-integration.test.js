'use strict';

// meta.ui end to end: the Check reads it without running the file, the install validates it on the loaded module,
// the loader hands it to the registry, and the places that only know a source id (the image proxy's Referer, the
// calendar) and the browser's lookups use it. The registry is process-wide, so every test cleans it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceUi = require('../../server/modules/common/source-ui');
const { makeRig, rejection, sourceText } = require('../helpers/source-import-server-rig');
const { inferRefererForUrl } = require('../../server/modules/network/fetch-utils');

const ROOT = path.join(__dirname, '..', '..');

test.afterEach(() => sourceUi.clearSourceUiRegistry());

const withUi = (ui, extra = '') => sourceText('demo', { body: "const BASE = 'https://example.com';", meta: `, ui: ${ui}${extra}` });

// ── Check ──────────────────────────────────────────────────────────────────

test('the Check shows a literal declaration, validated, without running the file', async (t) => {
  const rig = makeRig(t);
  const code = withUi("{ filters: { format: true }, genres: ['Action', 'Comedy'], nsfwGenres: ['Action'], adultOnly: true, nativeDates: true }");
  const report = await rig.service.preview({ code, id: 'demo' });
  assert.equal(report.canInstall, true);
  assert.equal(report.declaration.present, true);
  assert.equal(report.declaration.readable, true);
  assert.deepEqual(report.declaration.ui.genres, ['Action', 'Comedy']);
  assert.equal(report.declaration.ui.adultOnly, true);
  assert.deepEqual(report.declaration.problems, []);
  assert.equal(report.declaration.ui.imageReferers, undefined, 'the browser-facing view carries no Referer rules');
});

test('the Check lists the Referer rules separately, so the person approving the install sees them', async (t) => {
  const rig = makeRig(t);
  const code = withUi("{ imageReferers: [{ host: 'cdn.example.com', referer: 'https://example.com' }] }");
  const report = await rig.service.preview({ code, id: 'demo' });
  assert.deepEqual(report.declaration.imageReferers, [{ host: 'cdn.example.com', referer: 'https://example.com' }]);
  assert.equal(report.declaration.ui.imageReferers, undefined);
});

test('the Check says plainly when a file declares nothing, and when the declaration is computed', async (t) => {
  const rig = makeRig(t);
  const none = await rig.service.preview({ code: sourceText('demo'), id: 'demo' });
  assert.deepEqual(none.declaration, { present: false, readable: false, ui: null, problems: [] });
  const computed = await rig.service.preview({ code: withUi('{ genres: [...ALL] }'), id: 'demo' });
  assert.equal(computed.declaration.present, true);
  assert.equal(computed.declaration.readable, false);
  assert.equal(computed.canInstall, true, 'a computed declaration is read and validated at install time instead');
});

test('a declaration with a category that is never offered blocks the install at the Check', async (t) => {
  const rig = makeRig(t);
  const report = await rig.service.preview({ code: withUi("{ genres: ['Action', 'Oppai Loli'] }"), id: 'demo' });
  assert.equal(report.canInstall, false);
  assert.ok(report.blockers.some((text) => text.includes('Oppai Loli')));
  assert.deepEqual(rig.stagedFiles(), [], 'a blocked file is not staged');
});

test('the Check reports what it would drop: a Referer for a host the code never names', async (t) => {
  const rig = makeRig(t);
  const report = await rig.service.preview({
    code: withUi("{ imageReferers: [{ host: 'cdn.example.com', referer: 'https://example.com' }, { host: 'x.bank.com', referer: 'https://bank.com' }] }"),
    id: 'demo',
  });
  assert.equal(report.canInstall, true);
  assert.equal(report.declaration.problems.length, 1);
  assert.match(report.declaration.problems[0].message, /bank\.com/);
});

// ── Install ────────────────────────────────────────────────────────────────

test('install checks the declaration on the loaded module too: a computed one with a forbidden genre is refused', async (t) => {
  const rig = makeRig(t);
  const code = sourceText('demo', { body: "const G = ['Action', 'Shotacon'];", meta: ', ui: { genres: G }' });
  const report = await rig.service.preview({ code, id: 'demo' });
  assert.equal(report.canInstall, true, 'not readable before installing, so the Check cannot see it');
  const err = await rejection(rig.service.install({ sha256: report.sha256, id: 'demo' }));
  assert.equal(err.statusCode, 400);
  assert.ok(JSON.stringify(err.details || err).includes('Shotacon'));
  assert.deepEqual(rig.liveFiles(), [], 'nothing reached the sources folder');
  assert.equal(sourceUi.getSourceUi('demo'), null);
});

test('an installed source is registered with what it declared; uninstalling forgets it', async (t) => {
  const rig = makeRig(t);
  const code = withUi("{ genres: ['Action'], nativeDates: true, imageReferers: [{ host: 'cdn.example.com', referer: 'https://example.com' }] }");
  const report = await rig.service.preview({ code, id: 'demo' });
  const done = await rig.service.install({ sha256: report.sha256, id: 'demo' });
  assert.equal(done.ok, true);
  assert.deepEqual(done.declared.genres, ['Action']);
  assert.equal(done.declared.imageReferers, undefined, 'the browser never gets the Referer rules');
  assert.equal(sourceUi.sourceHasNativeDates('demo'), true);
  assert.equal(sourceUi.declaredRefererForHost('cdn.example.com'), 'https://example.com');
  rig.core.clearSourceCache('demo');
  assert.equal(sourceUi.getSourceUi('demo'), null, 'unloading a source forgets its declaration');
  rig.core.loadSourceFromFile('demo');
  assert.equal(sourceUi.sourceHasNativeDates('demo'), true, 'loading it again registers it again');
});

test('the loader holds a Referer rule to the hosts the file\'s own text names, even when the declaration is computed', async (t) => {
  const rig = makeRig(t);
  const code = sourceText('demo', {
    // The addresses are built at run time, so the text names only example.com (BASE): victim.com cannot vouch for itself.
    body: "const BASE = 'https://example.com'; const RULES = [{ host: 'cdn.example.com', referer: 'https://' + 'example.com' }, { host: 'img.victim.com', referer: 'https://' + 'victim.com' }];",
    meta: ', ui: { imageReferers: RULES }',
  });
  const report = await rig.service.preview({ code, id: 'demo' });
  const done = await rig.service.install({ sha256: report.sha256, id: 'demo' });
  assert.ok(done.warnings.some((text) => text.includes('victim.com')), 'the install reports what it dropped');
  assert.equal(sourceUi.declaredRefererForHost('cdn.example.com'), 'https://example.com');
  assert.equal(sourceUi.declaredRefererForHost('img.victim.com'), '');
});

test('a source that declares nothing installs as before and registers nothing', async (t) => {
  const rig = makeRig(t);
  const report = await rig.service.preview({ code: sourceText('demo'), id: 'demo' });
  const done = await rig.service.install({ sha256: report.sha256, id: 'demo' });
  assert.equal(done.ok, true);
  assert.equal(done.declared, null);
  assert.equal(sourceUi.getSourceUi('demo'), null);
});

// ── Places that only know a source id ──────────────────────────────────────

test('the image proxy uses a declared Referer, but never over a rule the app already has', () => {
  sourceUi.registerSourceUi('demo', {
    imageReferers: [
      { host: 'cdn.example.com', referer: 'https://example.com' },
      { host: 'cdn.mangakatana.com', referer: 'https://elsewhere.example' },
    ],
  });
  assert.equal(inferRefererForUrl('https://cdn.example.com/a.webp'), 'https://example.com/');
  assert.equal(inferRefererForUrl('https://cdn.mangakatana.com/a.webp'), 'https://mangakatana.com', 'the built-in rule stays first');
  assert.equal(inferRefererForUrl('https://unlisted.example.org/a.webp'), 'https://unlisted.example.org', 'no rule: the image\'s own origin, as before');
});

test('the calendar asks the registry as well as its own list', () => {
  const text = fs.readFileSync(path.join(ROOT, 'server', 'modules', 'calendar', 'service.js'), 'utf8');
  assert.match(text, /NATIVE_DATE_SOURCES\.has\(manga\.sourceId\) \|\| sourceHasNativeDates\(manga\.sourceId\)/);
});

// ── The browser's lookups (ui-advanced-search.js, utils.js), run on their real text ─────────────────────────

function functionText(file, name) {
  const text = fs.readFileSync(path.join(ROOT, 'public', 'modules', file), 'utf8');
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} is in ${file}`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return assert.fail(`${name} is not closed`);
}

function browserContext(installedSources) {
  const context = {
    state: { installedSources },
    PER_SOURCE_GENRES: { legacy: { genres: ['Old Genre'], nsfw: new Set(['Old Genre']) } },
    CUSTOM_ORDER_BY_OPTIONS: { legacy: [{ value: 'title', label: 'Old Sort' }] },
    ADV_SOURCE_CAPABILITIES: { default: { orderBy: true, publicationStatus: true, contentRating: false, format: true, genres: true }, legacy: { format: false } },
    isNsfwOverridden: () => undefined,
    isNsfwTag: (tag) => /hentai|erotica/i.test(String(tag)),
    NSFW_TEXT_HINTS: [],
  };
  vm.createContext(context);
  const names = [['ui-advanced-search.js', ['getDeclaredUi', 'getSourceGenreConfig', 'getSourceOrderByOptions', 'getAdvancedSourceCapabilities']], ['utils.js', ['isNsfwManga']]];
  for (const [file, list] of names) for (const name of list) vm.runInContext(functionText(file, name), context);
  return context;
}

test('the browser takes genres, sort options and filters from the declaration first, then from the old tables, then the defaults', () => {
  const ctx = browserContext({
    declared: { id: 'declared', ui: { genres: ['Action', 'Hentai'], nsfwGenres: ['Hentai'], orderBy: [{ value: 'createdAt', label: 'Newest' }], filters: { orderBy: true, publicationStatus: false, genres: true } } },
    legacy: { id: 'legacy' },
    plain: { id: 'plain' },
  });
  const genres = vm.runInContext("getSourceGenreConfig('declared')", ctx);
  assert.deepEqual([...genres.genres], ['Action', 'Hentai']);
  assert.equal(genres.nsfw.has('Hentai'), true);
  assert.equal(vm.runInContext("getSourceGenreConfig('legacy')", ctx).genres[0], 'Old Genre');
  assert.equal(vm.runInContext("getSourceGenreConfig('plain')", ctx), null);
  assert.equal(vm.runInContext("getSourceOrderByOptions('declared')", ctx)[0].label, 'Newest');
  assert.equal(vm.runInContext("getSourceOrderByOptions('legacy')", ctx)[0].label, 'Old Sort');
  assert.equal(vm.runInContext("getSourceOrderByOptions('plain')", ctx), null);
  assert.deepEqual({ ...vm.runInContext("getAdvancedSourceCapabilities('declared')", ctx) }, { orderBy: true, publicationStatus: false, contentRating: false, format: true, genres: true });
  assert.equal(vm.runInContext("getAdvancedSourceCapabilities('legacy')", ctx).format, false);
  assert.equal(vm.runInContext("getAdvancedSourceCapabilities('plain')", ctx).publicationStatus, true, 'the default, as before');
  assert.equal(vm.runInContext("getAdvancedSourceCapabilities('not-installed')", ctx).orderBy, true);
});

test('Hide NSFW treats every title of a source that declares adultOnly as adult, and a declaration can only add restrictions', () => {
  const ctx = browserContext({ adult: { id: 'adult', ui: { adultOnly: true } }, plain: { id: 'plain', ui: { genres: ['Action'] } } });
  assert.equal(vm.runInContext("isNsfwManga({ sourceId: 'adult', id: '1', genres: [] })", ctx), true);
  assert.equal(vm.runInContext("isNsfwManga({ sourceId: 'plain', id: '1', genres: ['Action'] })", ctx), false);
  assert.equal(vm.runInContext("isNsfwManga({ sourceId: 'plain', id: '1', genres: ['Hentai'] })", ctx), true, 'tags still count');
  const overridden = browserContext({ adult: { id: 'adult', ui: { adultOnly: true } } });
  overridden.isNsfwOverridden = () => false;
  assert.equal(vm.runInContext("isNsfwManga({ sourceId: 'adult', id: '1' })", overridden), false, 'the person\'s own override still wins');
});
