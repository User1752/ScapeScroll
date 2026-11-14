'use strict';

// The "Import a source" card in Settings > Advanced, first third: the pure half (ui-settings-source-import-html.js:
// the cleaning of what the server answered, the markup, the translated risk sentences) and the static guards over the
// card's files, stylesheet, translations and index.html. The controller and the DOM glue are in
// frontend-source-import-controller.test.js and frontend-source-import-card.test.js; the shared rig is
// tests/helpers/source-import-rig.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const limits = require('../../server/config/limits');
const { RISK_IDS } = require('../../server/modules/source-import/static-report');
const { CHECK_IDS } = require('../../server/modules/source-import/live-test');
const rig = require('../helpers/source-import-rig');

const { PUBLIC_DIR, HTML_FILE, LOGIC_FILE, SHA, HOSTILE, EN, PT, plain, report, makeEnv, markup, importKeys } = rig;

// ── pure helpers ────────────────────────────────────────────────────────────

test('the byte length is the server\'s (UTF-8), for ASCII, accents, CJK, emoji and a lone surrogate', () => {
  const { ctx } = makeEnv();
  for (const text of ['', 'abc', 'é', 'ção', '日本語', '😀', 'a😀b', '\ud800', 'x\udc00y', 'line\nbreak', 'ñ'.repeat(1000)]) {
    assert.equal(ctx.sourceImportByteLength(text), Buffer.byteLength(text, 'utf8'), JSON.stringify(text));
  }
});

test('the size cap the card carries is the server\'s', () => {
  const { ctx } = makeEnv();
  assert.equal(ctx.SOURCE_IMPORT_MAX_BYTES, limits.sourceImportMaxBytes);
});

test('a file name is not an id: nothing of the old name-to-id helper is left', () => {
  const { ctx } = makeEnv();
  assert.equal(ctx.sourceImportIdFromFileName, undefined);
  for (const file of [HTML_FILE, LOGIC_FILE]) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /IdFromFileName/);
});

test('a report from the server is cleaned: strings are text, numbers whole, lists capped, the fingerprint well formed', () => {
  const { ctx } = makeEnv();
  const clean = (raw) => plain(ctx.sourceImportNormalizeReport(raw));
  for (const junk of [undefined, null, 'text', 5, [], {}]) {
    const r = clean(junk);
    assert.equal(r.canInstall, false, JSON.stringify(junk));
    assert.deepEqual([r.id, r.sha256, r.bytes, r.requires, r.hosts, r.risks, r.blockers, r.existing, r.replace], ['', '', 0, [], [], [], [], null, false]);
  }
  const r = clean(report({ bytes: '7', lines: -3, dynamicRequires: 1.9, requires: [null, { specifier: 5, kind: 'evil', line: 'x' }], hosts: [5, null], risks: ['x'], blockers: [{ a: 1 }] }));
  assert.deepEqual([r.bytes, r.lines, r.dynamicRequires], [7, 0, 1]);
  assert.deepEqual(r.requires[1], { specifier: '5', kind: 'npm', line: 0 });
  assert.equal(r.canInstall, true);
  assert.equal(clean(report({ sha256: 'not-a-fingerprint' })).canInstall, false, 'no well-formed fingerprint, nothing to install');
  assert.equal(clean(report({ sha256: SHA.toUpperCase() })).canInstall, false);
  assert.equal(clean(report({ id: '' })).canInstall, false);
  assert.equal(clean(report({ canInstall: 'yes' })).canInstall, false, 'only true is true');
  assert.equal(clean(report({ replace: 'true' })).replace, false);
  assert.equal(clean({ requires: Array.from({ length: 500 }, () => ({ specifier: 'x', kind: 'npm' })) }).requires.length, 60);
  assert.equal(clean({ blockers: ['x'.repeat(5000)] }).blockers[0].length, 300);
});

test('a report that was cleaned once is not cleaned again: the card cleans the answer and the markup cleans what it is given', () => {
  const { ctx } = makeEnv();
  const declaration = {
    present: true, readable: true,
    ui: { orderBy: [{ value: 'views', label: 'Most Viewed' }], filters: { orderBy: true, genres: true }, genres: ['Action', 'Adult'], nsfwGenres: ['Adult'] },
    imageReferers: [{ host: 'cdn.example', referer: 'https://example.org/' }],
    problems: [{ level: 'warning', message: 'A problem.' }],
  };
  const once = ctx.sourceImportNormalizeReport(report({ declaration }));
  assert.equal(ctx.sourceImportNormalizeReport(once), once, 'a clean report passes through unchanged');
  // What the screen does: the check cleans the answer, then showReport hands that clean report to the markup.
  const html = ctx.buildSourceImportReportHtml(once);
  assert.doesNotMatch(html, /declaration is empty|declEmpty/i);
  const $ = markup(html);
  assert.match($.text(), /Most Viewed/);
  assert.match($.text(), /2 in total/);
  assert.match($.text(), /cdn\.example/, 'the Referer rules, the part of a declaration that changes requests, are shown to the person approving');
  assert.match($.text(), /A problem\./);
  assert.notEqual(ctx.sourceImportNormalizeReport(plain(once)), once, 'a copy that merely looks clean is cleaned like any answer');
});

test('a risk keeps its id when it is a short lower-case word with dashes, and loses it otherwise', () => {
  const { ctx } = makeEnv();
  const risks = plain(ctx.sourceImportNormalizeReport(report({
    risks: [{ id: 'child-process', text: 't', line: 2 }, { id: 'Eval', text: 'u' }, { id: HOSTILE[0], text: 'v' }, { text: 'w' }, { id: 5, text: 'x' }, { id: 'a'.repeat(60), text: 'y' }],
  })).risks);
  assert.deepEqual(risks.map((r) => r.id), ['child-process', '', '', '', '', '']);
  assert.deepEqual(risks[0], { id: 'child-process', text: 't', line: 2 });
});

test('imported sources are the store entries with installedVia "imported" and a valid id', () => {
  const { ctx } = makeEnv();
  const entries = ctx.sourceImportImportedEntries({
    a: { id: 'a', name: 'A', version: '1.0.0', installedVia: 'imported' },
    b: { id: 'b', name: 'B', installedVia: 'repo' },
    c: { id: 'c', name: 'C', installedVia: 'bundled' },
    d: { id: '"><img>', name: 'D', installedVia: 'imported' },
    e: null,
    f: { id: 'f', installedVia: 'imported' },
  });
  assert.deepEqual(plain(entries), [{ id: 'a', name: 'A', version: '1.0.0', tested: null }, { id: 'f', name: 'f', version: '', tested: null }]);
  for (const junk of [undefined, null, 'x', 5, []]) assert.deepEqual(plain(ctx.sourceImportImportedEntries(junk)), []);
});

// ── markup ──────────────────────────────────────────────────────────────────

test('the card renders with every text from the locale, every control labelled, no duplicate id', () => {
  const { ctx } = makeEnv();
  const $ = markup(ctx.buildSourceImportCardHtml([]));
  assert.equal($('.settings-section-title').text(), EN['settings.sourceImport.title']);
  assert.ok($('.source-import-notice').text().includes('full access to this computer'));
  assert.ok($('.source-import-notice').text().includes('never runs the file'));
  assert.equal($('input[type="file"]').attr('accept'), '.js,text/javascript');
  assert.notEqual($('input[type="file"]').attr('hidden'), undefined, 'the real file input is hidden behind the button');
  for (const id of ['sourceImportCode', 'sourceImportId']) {
    assert.equal($(`label[for="${id}"]`).length, 1, `no label for ${id}`);
    for (const described of $('#' + id).attr('aria-describedby').split(' ')) assert.equal($('#' + described).length, 1, `aria-describedby points nowhere: ${described}`);
  }
  assert.equal($('#sourceImportReport').attr('aria-live'), 'polite');
  assert.equal($('#sourceImportError').attr('role'), 'alert');
  assert.equal($('#sourceImportCode').is('textarea'), true);
  assert.equal($('#sourceImportCheckBtn').text(), EN['settings.sourceImport.checkButton']);
  assert.ok($('#sourceImportCodeHint').text().includes('512 KB'));
  assert.equal($('#sourceImportImported').text().trim(), EN['settings.sourceImport.importedNone']);
  assert.doesNotMatch($.root().text(), /settings\.sourceImport\.|\{\w+\}/, 'a key or a placeholder leaked into the page');
  const ids = $('[id]').toArray().map((node) => node.attribs.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
  for (const node of $('[data-si-action]').toArray()) assert.equal(node.name === 'button' && node.attribs.type, 'button', 'a button that could submit a form');
});

test('the card follows the language', () => {
  const env = makeEnv();
  env.ctx.setLanguage('pt');
  const $ = markup(env.ctx.buildSourceImportCardHtml([]));
  assert.equal($('.settings-section-title').text(), PT['settings.sourceImport.title']);
  assert.equal($('#sourceImportCheckBtn').text(), PT['settings.sourceImport.checkButton']);
});

test('a report shows the facts, the lists and the buttons, and a short fingerprint with the whole one in the title', () => {
  const { ctx } = makeEnv();
  const $ = markup(ctx.buildSourceImportReportHtml(report({
    risks: [{ id: 'eval', text: 'builds code from text (eval / new Function)', line: 7 }], dynamicRequires: 2,
  })));
  assert.equal($('.source-import-facts code').first().text(), 'demo');
  assert.ok($('.source-import-facts').text().includes('512 bytes, 20 lines'));
  const fingerprint = $('.source-import-facts code[title]');
  assert.equal(fingerprint.attr('title'), SHA);
  assert.equal(fingerprint.text(), SHA.slice(0, 12) + '…');
  assert.deepEqual($('.source-import-list li').toArray().map((li) => $(li).find('code').first().text()).filter(Boolean), ['cheerio', '../../server/modules/network/fetch-utils', 'example.com']);
  assert.ok($.root().text().includes('package') && $.root().text().includes('app file'));
  assert.ok($.root().text().includes('line 1'));
  assert.ok($.root().text().includes('builds code from text') && $.root().text().includes('line 7'));
  assert.ok($.root().text().includes('2 require() call(s)'));
  assert.equal($('[data-si-action="install"]').text(), 'Install');
  assert.equal($('[data-si-action="install"]').attr('disabled'), undefined);
  assert.equal($('[data-si-action="cancel"]').length, 1);
  assert.equal($('.source-import-blockers').length, 0);
  assert.equal($('.source-import-replace').length, 0);
});

test('blockers are shown as the reason, and the install button is disabled when the report says it cannot be installed', () => {
  const { ctx } = makeEnv();
  const $ = markup(ctx.buildSourceImportReportHtml(report({ canInstall: false, blockers: ['The file does not parse (line 3): Unexpected token'] })));
  assert.equal($('.source-import-blockers li').text(), 'The file does not parse (line 3): Unexpected token');
  assert.notEqual($('[data-si-action="install"]').attr('disabled'), undefined);
  assert.ok($.root().text().includes(EN['settings.sourceImport.noId']) === false, 'an id is there');
  const noId = markup(ctx.buildSourceImportReportHtml(report({ id: '', canInstall: false })));
  assert.ok(noId.root().text().includes(EN['settings.sourceImport.noId']));
});

test('a replacement says so and the button reads Replace; a file naming another id offers to use it', () => {
  const { ctx } = makeEnv();
  const $ = markup(ctx.buildSourceImportReportHtml(report({
    replace: true, existing: { installedVia: 'imported', name: 'Old name', version: '1.0.0' }, id: 'typed', detectedId: 'inside',
  })));
  assert.equal($('.source-import-replace').length, 1);
  assert.ok($('.source-import-replace').text().includes('Old name v1.0.0'));
  assert.ok($('.source-import-replace').text().includes('.bak'));
  assert.equal($('[data-si-action="install"]').text(), 'Replace');
  assert.ok($('.source-import-detected').text().includes('"inside"'));
  assert.equal($('[data-si-action="adopt-id"]').length, 1);
  assert.equal(markup(ctx.buildSourceImportReportHtml(report())).root().find('[data-si-action="adopt-id"]').length, 0, 'same id: nothing to adopt');
});

test('a risk is shown in the language of the page, found by its id; an unknown or missing id shows the server\'s own sentence', () => {
  const env = makeEnv();
  // The text of the "Risky calls found" section only (the page language is whatever the env was set to).
  const riskText = (risks) => {
    const $ = markup(env.ctx.buildSourceImportReportHtml(report({ risks })));
    const sections = $('.source-import-section').toArray().map((node) => $(node));
    const mine = sections.find((section) => section.find('.source-import-subtitle').first().text() === t(env, 'settings.sourceImport.risksTitle'));
    return mine ? mine.text() : '';
  };
  const t = (e, key) => e.ctx.t(key);
  for (const id of RISK_IDS) {
    const text = riskText([{ id, text: 'SERVER SENTENCE', line: 4 }]);
    assert.ok(text.includes(EN['settings.sourceImport.risk.' + id]), `en-GB sentence for ${id}`);
    assert.ok(!text.includes('SERVER SENTENCE'), `the server sentence replaced for ${id}`);
  }
  env.ctx.setLanguage('pt');
  for (const id of RISK_IDS) assert.ok(riskText([{ id, text: 'SERVER SENTENCE' }]).includes(PT['settings.sourceImport.risk.' + id]), `pt-PT sentence for ${id}`);
  for (const risk of [{ id: 'brand-new-check', text: 'SERVER SENTENCE' }, { text: 'SERVER SENTENCE' }, { id: HOSTILE[0], text: 'SERVER SENTENCE' }]) {
    assert.ok(riskText([risk]).includes('SERVER SENTENCE'), JSON.stringify(risk));
  }
});

test('hostile values from the server add no element and no attribute anywhere in the report', () => {
  const env = makeEnv();
  const [a, b, c, d] = HOSTILE;
  const html = env.ctx.buildSourceImportReportHtml(report({
    id: a, detectedId: b, sha256: c,
    requires: [{ specifier: a, kind: b, line: c }, { specifier: d, kind: 'npm', line: 1 }],
    hosts: [b, c], risks: [{ text: d, line: a }, { text: a }, { id: a, text: b }], blockers: [a, b, c, d],
    existing: { name: a, version: b, installedVia: c }, replace: true, canInstall: true,
  }));
  const $ = markup(html);
  assert.equal($('img, script, svg, iframe').length, 0, 'markup came out of data');
  for (const node of $('*').toArray()) {
    for (const name of Object.keys(node.attribs)) assert.doesNotMatch(name, /^on/i, `${node.name} has ${name}`);
  }
  assert.ok($.root().text().includes('<img src=x'), 'the hostile text is shown as text');
  assert.equal($('[data-si-action="install"]').attr('disabled') !== undefined, true, 'a hostile fingerprint is no fingerprint');
  assert.deepEqual(env.pwn, []);
});

test('hostile names in the imported list and hostile translations add no element and no attribute', () => {
  const env = makeEnv();
  const [a, b, c] = HOSTILE;
  const entries = env.ctx.sourceImportImportedEntries({
    x: { id: 'x', name: a, version: b, installedVia: 'imported' },
    y: { id: c, name: 'ignored', installedVia: 'imported' },
  });
  const $ = markup(env.ctx.buildSourceImportImportedHtml(entries));
  assert.equal($('li').length, 1, 'an id that is not an id is not listed');
  assert.equal($('img, script, svg, iframe').length, 0);
  assert.equal($('[data-si-action="uninstall"]').attr('data-source-id'), 'x');

  const strings = env.ctx.ScrollScapeI18nLocales['en-GB'];
  for (const key of importKeys(strings)) strings[key] = a + HOSTILE[3] + key.length;
  const card = markup(env.ctx.buildSourceImportCardHtml(entries) + env.ctx.buildSourceImportReportHtml(report({
    replace: true, detectedId: 'other', risks: [{ id: 'eval', text: 'r', line: 1 }, { text: 'r', line: 1 }], dynamicRequires: 1,
  })));
  assert.equal(card('img, script, svg, iframe').length, 0, 'markup came out of a translation');
  for (const node of card('*').toArray()) {
    for (const name of Object.keys(node.attribs)) assert.doesNotMatch(name, /^on/i, `${node.name} has ${name}`);
  }
  assert.deepEqual(env.pwn, []);
});

test('what the server cut off the lists is cleaned to a whole number, and zero when it is missing or not a number', () => {
  const { ctx } = makeEnv();
  const more = (over) => { const r = plain(ctx.sourceImportNormalizeReport(report(over))); return [r.requiresMore, r.hostsMore]; };
  assert.deepEqual(more({}), [0, 0]);
  assert.deepEqual(more({ requiresMore: 12, hostsMore: 3 }), [12, 3]);
  assert.deepEqual(more({ requiresMore: '7', hostsMore: 4.9 }), [7, 4]);
  for (const junk of [-1, 'x', null, undefined, {}, [], NaN, HOSTILE[0]]) assert.deepEqual(more({ requiresMore: junk, hostsMore: junk }), [0, 0], String(junk));
});

test('a list the server cut short says how many it left out, under that list, and says nothing when nothing was cut', () => {
  const { ctx } = makeEnv();
  const sectionOf = ($, title) => $('.source-import-section').toArray().map((node) => $(node)).find((s) => s.find('.source-import-subtitle').first().text() === title);
  const $ = markup(ctx.buildSourceImportReportHtml(report({ requiresMore: 12, hostsMore: 3 })));
  const requires = sectionOf($, EN['settings.sourceImport.requiresTitle']);
  const hosts = sectionOf($, EN['settings.sourceImport.hostsTitle']);
  assert.equal(requires.find('.source-import-more').text(), '… and 12 more require() names not shown.');
  assert.equal(hosts.find('.source-import-more').text(), '… and 3 more web addresses not shown.');
  assert.equal($('.source-import-more').length, 2);
  assert.equal(requires.find('.source-import-list').nextAll('.source-import-more').length, 1, 'right after the list it belongs to');
  const none = markup(ctx.buildSourceImportReportHtml(report()));
  assert.equal(none('.source-import-more').length, 0);
  const onlyHosts = markup(ctx.buildSourceImportReportHtml(report({ hostsMore: 1 })));
  assert.equal(onlyHosts('.source-import-more').length, 1);
  ctx.setLanguage('pt');
  const pt = markup(ctx.buildSourceImportReportHtml(report({ requiresMore: 2, hostsMore: 5 })));
  assert.deepEqual(pt('.source-import-more').toArray().map((n) => pt(n).text()), [
    PT['settings.sourceImport.requiresMore'].replace('{count}', '2'),
    PT['settings.sourceImport.hostsMore'].replace('{count}', '5'),
  ]);
});

test('a list that is empty but was cut still shows the line, and a hostile count is shown as nothing', () => {
  const { ctx } = makeEnv();
  const $ = markup(ctx.buildSourceImportReportHtml(report({ requires: [], hosts: [], requiresMore: 4 })));
  assert.equal($('.source-import-more').length, 1);
  const hostile = markup(ctx.buildSourceImportReportHtml(report({ requiresMore: HOSTILE[0], hostsMore: HOSTILE[1] })));
  assert.equal(hostile('.source-import-more').length, 0);
  assert.equal(hostile('img, script').length, 0);
});

// ── wiring and static guards ────────────────────────────────────────────────

test('index.html loads the markup script, then the logic script, after the solver card and before the modal, plus the stylesheet', () => {
  const page = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  for (const name of ['ui-settings-source-import-html.js', 'ui-settings-source-import.js']) {
    assert.equal(page.split(`<script src="./modules/${name}?`).length - 1, 1, name);
    assert.match(page, new RegExp(`<script src="\\./modules/${name.replace(/\./g, '\\.')}\\?v=\\d+" defer></script>`));
  }
  const html = page.indexOf('ui-settings-source-import-html.js');
  const logic = page.indexOf('ui-settings-source-import.js');
  assert.ok(page.indexOf('/modules/ui-settings-solver.js') < html, 'after the solver card');
  assert.ok(html < logic, 'the markup file first: the logic file calls its functions');
  assert.ok(logic < page.indexOf('/modules/ui-settings-modal.js'), 'before the modal');
  assert.ok(page.indexOf('/modules/utils.js') < html && page.indexOf('/modules/api.js') < html && page.indexOf('/modules/i18n/index.js') < html);
  assert.match(page, /<link rel="stylesheet" href="\.\/css-modules\/source-import\.css\?v=\d+">/);
  assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'css-modules', 'source-import.css')));
});

test('the live regions are never taken out of the layout when empty: an announced change is not lost', () => {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'css-modules', 'source-import.css'), 'utf8');
  assert.doesNotMatch(css, /display:\s*none/, 'a live region that is display:none when empty is not announced when it fills');
  for (const selector of ['.source-import-error:empty', '.source-import-report:empty']) {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, selector);
    assert.match(css.slice(at, css.indexOf('}', at)), /margin:\s*0/);
  }
});

test('the Check card says what the app will do with the declaration, counts a long genre list in full, and shows a warning when nothing is declared', () => {
  const { ctx } = makeEnv();
  const genres = Array.from({ length: 78 }, (_, i) => `tag ${i}`);
  const declared = markup(ctx.buildSourceImportReportHtml(report({
    declaration: {
      present: true, readable: true,
      ui: { filters: { orderBy: true, publicationStatus: false }, orderBy: [{ value: 'relevance', label: 'Newest' }], genres, nsfwGenres: ['tag 1', 'tag 2'], adultOnly: true, nativeDates: true },
      imageReferers: [{ host: 'cdn.example.com', referer: 'https://example.com' }],
      problems: [{ level: 'warning', message: '<img src=x onerror=alert(1)> dropped' }, { level: 'error', message: 'a blocking reason' }],
    },
  }))).root().text();
  assert.match(declared, /How the app will use it/);
  assert.match(declared, /sort: real, status: hidden/);
  assert.match(declared, /Sort options: Newest/);
  assert.match(declared, /78 in total/, 'the whole list is counted, not the part shown');
  assert.match(declared, /Marked as adult: 2/);
  assert.match(declared, /requested with a Referer: cdn\.example\.com → https:\/\/example\.com/, 'the one part of a declaration that changes network requests is shown');
  assert.match(declared, /Every title is treated as adult content/);
  assert.match(declared, /chapter dates are real/);
  assert.ok(declared.includes('<img src=x onerror=alert(1)> dropped'), 'a problem is shown as text, never as markup');
  const html = ctx.buildSourceImportReportHtml(report({ declaration: { present: true, readable: true, ui: {}, problems: [{ level: 'warning', message: '<img src=x>' }] } }));
  assert.doesNotMatch(html, /<img src=x>/);
  const none = markup(ctx.buildSourceImportReportHtml(report({ declaration: { present: false, readable: false, ui: null, problems: [] } }))).root().text();
  assert.match(none, /declares nothing about itself/);
  const computed = markup(ctx.buildSourceImportReportHtml(report({ declaration: { present: true, readable: false, ui: null, problems: [] } }))).root().text();
  assert.match(computed, /only be read after installing/);
});

test('every translation key the card uses exists in both languages, both languages hold the same keys, and none is unused', () => {
  const source = fs.readFileSync(HTML_FILE, 'utf8') + fs.readFileSync(LOGIC_FILE, 'utf8');
  const used = new Set();
  for (const match of source.matchAll(/['"](settings\.sourceImport\.[A-Za-z.]+)['"]/g)) {
    if (match[1] === 'settings.sourceImport.kind.') for (const kind of ['relative', 'npm', 'builtin']) used.add(match[1] + kind);
    else if (match[1] === 'settings.sourceImport.risk.') for (const id of RISK_IDS) used.add(match[1] + id);
    else if (match[1] === 'settings.sourceImport.test.check.') for (const id of CHECK_IDS) used.add(match[1] + id);
    else if (match[1] === 'settings.sourceImport.testStatus.') for (const status of ['pass', 'fail', 'warn', 'skip']) used.add(match[1] + status);
    else if (match[1] === 'settings.sourceImport.declFilterName.') for (const key of ['orderBy', 'publicationStatus', 'contentRating', 'format', 'genres']) used.add(match[1] + key);
    else used.add(match[1]);
  }
  for (const key of ['title', 'description', 'noticeTitle', 'notice']) used.add('settings.sourceImport.' + key); // set through sourceImportText in the markup
  assert.ok(used.size > 50);
  assert.ok(used.has('settings.sourceImport.uninstallConfirm'));
  assert.deepEqual(importKeys(EN), importKeys(PT), 'the two languages hold the same keys');
  for (const key of used) {
    assert.equal(typeof EN[key], 'string', `en-GB lacks ${key}`);
    assert.equal(typeof PT[key], 'string', `pt-PT lacks ${key}`);
    assert.ok(EN[key].length > 0 && PT[key].length > 0);
  }
  for (const key of importKeys(EN)) assert.ok(used.has(key), `${key} is defined but never used`);
  for (const key of importKeys(EN)) {
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(placeholders(PT[key]), placeholders(EN[key]), `${key} has other placeholders in Portuguese`);
  }
});

test('the card has a translated sentence for every risk id the server can report, and for no other', () => {
  assert.ok(RISK_IDS.length >= 10);
  for (const id of RISK_IDS) {
    for (const [name, strings] of [['en-GB', EN], ['pt-PT', PT]]) {
      assert.equal(typeof strings['settings.sourceImport.risk.' + id], 'string', `${name} lacks the sentence for ${id}`);
    }
  }
  for (const key of importKeys(EN).filter((k) => k.startsWith('settings.sourceImport.risk.'))) {
    assert.ok(RISK_IDS.includes(key.slice('settings.sourceImport.risk.'.length)), `${key} names a risk the server no longer reports`);
  }
});

test('source guards: four endpoints through api(), no fetch, no storage, no inline handler, no data in an event attribute', () => {
  const html = fs.readFileSync(HTML_FILE, 'utf8');
  const logic = fs.readFileSync(LOGIC_FILE, 'utf8');
  const source = html + logic;
  assert.deepEqual([...new Set(source.match(/['"`]\/api\/[^'"`]*['"`]/g))].sort(), ["'/api/sources/import/install'", "'/api/sources/import/preview'", "'/api/sources/import/test'", "'/api/sources/uninstall'"]);
  assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|sessionStorage|setInterval|\beval\s*\(|new Function/);
  assert.doesNotMatch(source, /\bon(?:click|change|input|error|load)\s*=/i, 'an inline handler');
  const assigned = [...source.matchAll(/\.innerHTML\s*=\s*([^;]*);/g)].map((m) => m[1]);
  assert.ok(assigned.length >= 4, 'the assignments were found');
  for (const rhs of assigned) assert.doesNotMatch(rhs, /\b(?:err|answer|raw|message)\b/, 'server text written as markup: ' + rhs.slice(0, 60));
  assert.ok(logic.includes('escapeHtml(text)'), 'a list of server sentences goes through escapeHtml');
  assert.doesNotMatch(html, /document\.|querySelector|addEventListener/, 'the markup file is pure: no DOM access');
});

test('size rule (GUIDELINES section 16): each file of the card is at most 450 lines and each function at most 80', () => {
  for (const file of [HTML_FILE, LOGIC_FILE]) {
    const text = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    assert.ok(text.length <= 450, `${path.basename(file)} has ${text.length} lines`);
    let start = -1;
    let depth = 0;
    text.forEach((line, i) => {
      if (depth === 0 && /^(?:async )?function \w+|^const \w+ = (?:async )?\(.*\) => \{$/.test(line)) start = i;
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth === 0 && start >= 0 && /^\}/.test(line)) {
        assert.ok(i - start + 1 <= 80, `${path.basename(file)} line ${start + 1}: a function of ${i - start + 1} lines`);
        start = -1;
      }
    });
  }
});
