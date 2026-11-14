'use strict';

// Cases from the adversarial review of meta.ui: the Check and the runtime must read the SAME declaration, a hostile or
// odd value must never throw or hide an error, look-alike letters must not get a never-offered name through, and a
// Referer rule must not vouch for itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ui = require('../../server/modules/common/source-ui');
const { collectHostsOutsideDeclaration } = require('../../server/modules/source-import/static-report');

const errors = (verdict) => verdict.problems.filter((p) => p.level === 'error');
const ROOT = path.join(__dirname, '..', '..');

// ── The Check reads what the runtime will see ─────────────────────────────

test('a `ui: {` in a comment or in a string is not the declaration', () => {
  const decoy = '// ui: { adultOnly: false }\nmodule.exports = { meta: { id: \'x\', ui: { adultOnly: true } } };';
  const read = ui.readDeclaredUiLiteral(decoy);
  assert.equal(read.readable, true);
  assert.equal(read.value.adultOnly, true, 'the real declaration, not the one in the comment');
  const inString = "const note = 'ui: { adultOnly: false }'; module.exports = { meta: { id: 'x', ui: { nativeDates: true } } };";
  assert.deepEqual(ui.readDeclaredUiLiteral(inString).value, { nativeDates: true });
  const block = "/* meta.ui = { genres: ['X'] } */ exports.meta = { id: 'x' };";
  assert.equal(ui.readDeclaredUiLiteral(block).found, false);
});

test('a comment that only talks about the field does not make a declaration, and an unrelated `ui` object does not either', () => {
  assert.equal(ui.readDeclaredUiLiteral("// meta.ui: see the guide. Shape:  ui: { filters, genres }\nexports.meta = { id: 'x' };").found, false);
  assert.equal(ui.readDeclaredUiLiteral("const defaults = { ui: { genres: ['Loli'] } };\nexports.meta = { id: 'x' };").found, false);
  assert.equal(ui.readDeclaredUiLiteral("exports.meta = { id: 'x', nested: { ui: { adultOnly: true } } };").found, false, 'only a property of meta itself');
});

test('a declaration made twice is ambiguous and is not guessed', () => {
  const twice = "exports.meta = { id: 'x', ui: { genres: ['Action'] } };\nexports.meta.ui = { genres: ['Other'] };";
  const read = ui.readDeclaredUiLiteral(twice);
  assert.equal(read.found, true);
  assert.equal(read.readable, false);
  assert.match(read.reason, /more than once/);
});

test('a file saved with Windows line endings is read the same, comments and all', () => {
  const lf = "// a note\nexports.meta = {\n  id: 'x', // inline\n  ui: {\n    /* block\n       comment */\n    genres: ['Action', 'Comedy'],\n    adultOnly: true,\n  },\n};\n";
  const crlf = lf.replace(/\n/g, '\r\n');
  const fromLf = ui.readDeclaredUiLiteral(lf);
  const fromCrlf = ui.readDeclaredUiLiteral(crlf);
  assert.equal(fromCrlf.readable, true, fromCrlf.reason);
  assert.deepEqual(fromCrlf.value, fromLf.value);
  assert.deepEqual([...collectHostsOutsideDeclaration(crlf + "const BASE = 'https://example.com';\r\n")], ['example.com']);
});

test('a declaration that is not a literal is present, never mistaken for "declares nothing"', () => {
  for (const text of [
    "exports.meta = { id: 'x', ui: UI };",
    "exports.meta = { id: 'x', ui: Object.freeze({ adultOnly: true }) };",
    "exports.meta = { id: 'x', ui: cond ? { adultOnly: true } : undefined };",
  ]) {
    const read = ui.readDeclaredUiLiteral(text);
    assert.equal(read.found, true, text);
    assert.equal(read.readable, false, text);
  }
  assert.equal(ui.readDeclaredUiLiteral("exports.meta = { id: 'x', \"ui\": { adultOnly: true } };").value.adultOnly, true, 'a quoted key');
  assert.equal(ui.readDeclaredUiLiteral("exports.meta = { id: 'x' };\nmeta['ui'] = { adultOnly: true };").value.adultOnly, true, 'a bracket assignment');
});

test('a Referer rule cannot vouch for itself with a URL in a comment or in the declaration', () => {
  const code = `// https://my-own-site.example/ is where the images come from\nconst BASE = 'https://real.example';\nexports.meta = { id: 'x', ui: { imageReferers: [{ host: 'cdn.victim.com', referer: 'https://my-own-site.example' }] } };`;
  const hosts = collectHostsOutsideDeclaration(code);
  assert.deepEqual([...hosts], ['real.example']);
  const verdict = ui.sanitizeSourceUi(ui.readDeclaredUiLiteral(code).value, { knownHosts: hosts });
  assert.equal(verdict.ui.imageReferers, undefined);
});

test('a wildcard Referer rule may not cover a public suffix or a CDN shared by unrelated sites', () => {
  const verdict = ui.sanitizeSourceUi({
    imageReferers: [
      { host: '*.co.uk', referer: 'https://a.example' },
      { host: '*.cloudfront.net', referer: 'https://a.example' },
      { host: '*.cdn.a.example', referer: 'https://a.example' },
    ],
  });
  assert.deepEqual(verdict.ui.imageReferers, [{ host: '*.cdn.a.example', referer: 'https://a.example' }]);
});

test('a regular expression after `return` does not swallow the rest of the file', () => {
  const code = "function f(s) { return /&(?:#\\d+);/i.test(s) ? `<b>${s}</b>` : s; }\nmodule.exports = { meta: { id: 'x', ui: { adultOnly: true } } };";
  assert.equal(ui.readDeclaredUiLiteral(code).value.adultOnly, true);
  assert.equal(ui.readDeclaredUiLiteral('const half = a / b; const q = c / d; exports.meta = { id: "x", ui: { nativeDates: true } };').value.nativeDates, true, 'a division is not a regular expression');
});

test('the model in the guide is read by the Check: its own declaration is found and valid', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'docs', 'adicionar-source-completo.md'), 'utf8');
  // (a checkout with Windows line endings has \r\n in the guide)
  const blocks = [...guide.matchAll(/```js\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
  const template = blocks.find((block) => block.includes('CHAPTER_ID_RE'));
  assert.ok(template, 'the template is in the guide');
  const read = ui.readDeclaredUiLiteral(template);
  assert.equal(read.readable, true, read.reason);
  assert.deepEqual(ui.sanitizeSourceUi(read.value).problems, []);
  const example = blocks.find((block) => block.includes('imageReferers: [{ host'));
  const declared = ui.readDeclaredUiLiteral(example);
  assert.equal(declared.readable, true, declared.reason);
  assert.deepEqual(ui.sanitizeSourceUi(declared.value, { knownHosts: new Set(['exemplo.com']) }).problems, []);
});

// ── The sanitiser never throws and never hides an error ───────────────────

test('a value built to break a conversion is only an unusable name, not an exception', () => {
  for (const raw of [
    { genres: [{ toString: 1 }] },
    { filters: { orderBy: [{ value: { toString: 1 } }] } },
    { imageReferers: [{ host: { toString: 1 }, referer: 'https://a.example' }] },
    { genres: ['A'], ['x'.repeat(300000)]: 1 },
  ]) {
    const verdict = ui.sanitizeSourceUi(raw);
    assert.ok(Array.isArray(verdict.problems));
    for (const p of verdict.problems) assert.ok(p.message.length < 400, 'a message never echoes an unbounded key');
  }
});

test('an object whose prototype was replaced is refused, since fields could be read through it', () => {
  const verdict = ui.sanitizeSourceUi({ __proto__: { adultOnly: true, genres: ['Action'] } });
  assert.equal(verdict.ui, null);
  assert.equal(errors(verdict).length, 1);
  const bare = Object.create(null);
  bare.nativeDates = true;
  assert.deepEqual(ui.sanitizeSourceUi(bare).ui, { nativeDates: true }, 'a null-prototype object is fine');
});

test('more than thirty warnings never push out the error that blocks the install', () => {
  const raw = { genres: ['Action', 'Loli'] };
  for (let i = 0; i < 40; i++) raw[`junk${i}`] = 1;
  const verdict = ui.sanitizeSourceUi(raw);
  assert.equal(errors(verdict).length, 1, 'the error stays');
  assert.ok(verdict.problems.length <= 32, 'the warnings are cut and say so');
  assert.ok(verdict.problems.some((p) => /more warnings/.test(p.message)));
  assert.deepEqual(verdict.ui.genres, ['Action']);
});

test('look-alike letters and separators do not get a never-offered name through, and ordinary names are left alone', () => {
  const blocked = ['Lolì', 'Shōta', 'lоli', 'ｌｏｌｉ', 'ſhota', 'Lolı', 'Sho-ta', 'Toddler', 'oppai loli', 'Low Shotacon'];
  for (const name of blocked) assert.equal(errors(ui.sanitizeSourceUi({ genres: [name] })).length, 1, `${name} must be blocked`);
  for (const name of ['Hololive', 'Solo', 'Sci-Fi', 'Slice of Life', 'Shounen', 'Josei', 'Smut']) {
    assert.equal(errors(ui.sanitizeSourceUi({ genres: [name] })).length, 0, `${name} must stay allowed`);
  }
});

test('a sort value of the source\'s own needs a label; a genre name may start with a plus sign; the option cap is said', () => {
  const custom = ui.sanitizeSourceUi({ filters: { orderBy: [{ value: 'favorites', label: 'Popular' }, 'mystery', { value: 'relevance' }] } });
  assert.deepEqual(custom.ui.orderBy, [{ value: 'favorites', label: 'Popular' }, { value: 'relevance', label: 'Best Match' }]);
  assert.ok(custom.problems.some((p) => p.message.includes('mystery') && /needs a label/.test(p.message)));
  assert.deepEqual(ui.sanitizeSourceUi({ genres: ['+100 Chapter'] }).ui.genres, ['+100 Chapter']);
  const many = ui.sanitizeSourceUi({ filters: { orderBy: Array.from({ length: 14 }, (_, i) => ({ value: `sort${i}`, label: `Sort ${i}` })) } });
  assert.equal(many.ui.orderBy.length, 12);
  assert.ok(many.problems.some((p) => /more than 12/.test(p.message)));
});

// ── The browser: the grid follows what is declared NOW ────────────────────

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

function gridContext(installedSources) {
  const grid = { innerHTML: '<label class="genre-check"><input type="checkbox" value="Action"><span>Action</span></label>' };
  const select = { innerHTML: '<option value="relevance">Best Match</option>' };
  const context = {
    state: { installedSources },
    grid, select,
    $: (id) => (id === 'genreGrid' ? grid : id === 'advancedOrderBy' ? select : null),
    escapeHtml: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    PER_SOURCE_GENRES: {}, CUSTOM_ORDER_BY_OPTIONS: {},
    isNsfwTag: (tag) => /^(hentai|smut|ecchi)$/i.test(String(tag)),
  };
  vm.createContext(context);
  vm.runInContext('let _defaultGenreGridHtml = null, _genreGridSource = null, _defaultOrderByHtml = null, _orderBySource = null;', context);
  for (const name of ['getDeclaredUi', 'getSourceGenreConfig', 'getSourceOrderByOptions', 'applyGenreGridForSource', 'applyOrderByOptionsForSource', 'buildMergedGenreList', 'applyMergedGenreGrid', 'getDefaultGenreList']) {
    vm.runInContext(functionText('ui-advanced-search.js', name), context);
  }
  return context;
}

const values = (html) => [...html.matchAll(/value="([^"]*)"/g)].map((m) => m[1]);

test('the genre grid and the sort list are rebuilt when the same source id declares something else', () => {
  const ctx = gridContext({ s: { id: 's', ui: { genres: ['A', 'B'], orderBy: [{ value: 'title', label: 'T' }] } } });
  vm.runInContext("applyGenreGridForSource('s'); applyOrderByOptionsForSource('s');", ctx);
  assert.deepEqual(values(ctx.grid.innerHTML), ['A', 'B']);
  assert.deepEqual(values(ctx.select.innerHTML), ['title']);
  ctx.state.installedSources.s.ui = { genres: ['A', 'C'], orderBy: [{ value: 'rating', label: 'R' }] };
  vm.runInContext("applyGenreGridForSource('s'); applyOrderByOptionsForSource('s');", ctx);
  assert.deepEqual(values(ctx.grid.innerHTML), ['A', 'C'], 'not the old list');
  assert.deepEqual(values(ctx.select.innerHTML), ['rating']);
  vm.runInContext("applyGenreGridForSource('s');", ctx);
  ctx.grid.innerHTML = '<ticked>';
  vm.runInContext("applyGenreGridForSource('s');", ctx);
  assert.equal(ctx.grid.innerHTML, '<ticked>', 'an unchanged list is left alone, so ticked boxes survive');
});

test('a source called "default" or "merged" cannot shadow the built-in lists', () => {
  const ctx = gridContext({ default: { id: 'default', ui: { genres: ['Mine'] } }, plain: { id: 'plain' } });
  vm.runInContext("applyGenreGridForSource('default');", ctx);
  assert.deepEqual(values(ctx.grid.innerHTML), ['Mine']);
  vm.runInContext("applyGenreGridForSource('plain');", ctx);
  assert.deepEqual(values(ctx.grid.innerHTML), ['Action'], 'a source without its own list shows the default one');
});

test('the merged list follows sources that are installed or changed while it is showing', () => {
  const ctx = gridContext({ a: { id: 'a', ui: { genres: ['Alpha'] } } });
  vm.runInContext('applyMergedGenreGrid();', ctx);
  assert.ok(values(ctx.grid.innerHTML).includes('Alpha'));
  ctx.state.installedSources.b = { id: 'b', ui: { genres: ['Beta'] } };
  vm.runInContext('applyMergedGenreGrid();', ctx);
  assert.ok(values(ctx.grid.innerHTML).includes('Beta'));
});

test('a genre the app knows as adult is flagged even when the declaration forgot to say so; markup in a name stays text', () => {
  const ctx = gridContext({ s: { id: 's', ui: { genres: ['Hentai', 'Action', '<b>x</b>'], nsfwGenres: [] } } });
  vm.runInContext("applyGenreGridForSource('s');", ctx);
  assert.match(ctx.grid.innerHTML, /data-nsfw="1"[^>]*><input type="checkbox" value="Hentai"/);
  assert.doesNotMatch(ctx.grid.innerHTML.replace(/<label[^>]*>|<input[^>]*>|<span>|<\/span>|<\/label>/g, ''), /<b>/);
});
