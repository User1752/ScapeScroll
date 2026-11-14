'use strict';

// What a source declares about itself in meta.ui (server/modules/common/source-ui.js): the validation that keeps a
// declaration from being more than data, the registry the calendar and the image proxy ask, and the literal reader the
// Check step uses on text it never runs.

const test = require('node:test');
const assert = require('node:assert/strict');

const ui = require('../../server/modules/common/source-ui');

const errors = (verdict) => verdict.problems.filter((p) => p.level === 'error').map((p) => p.message);
const warnings = (verdict) => verdict.problems.filter((p) => p.level === 'warning').map((p) => p.message);

// ── sanitizeSourceUi ───────────────────────────────────────────────────────

test('nothing declared is not a problem, and a declaration that is not an object is refused', () => {
  assert.deepEqual(ui.sanitizeSourceUi(undefined), { present: false, ui: null, problems: [] });
  assert.deepEqual(ui.sanitizeSourceUi(null), { present: false, ui: null, problems: [] });
  for (const bad of ['text', 5, true, ['a']]) {
    const verdict = ui.sanitizeSourceUi(bad);
    assert.equal(verdict.present, true);
    assert.equal(verdict.ui, null);
    assert.equal(errors(verdict).length, 1, `${JSON.stringify(bad)} is refused`);
  }
});

test('a good declaration is kept as it is, with the genre list making the genre filter real', () => {
  const verdict = ui.sanitizeSourceUi({
    filters: { orderBy: ['relevance', { value: 'createdAt', label: 'Newest' }], format: true, publicationStatus: false },
    genres: ['Action', 'Sci-Fi', 'Slice of Life'],
    nsfwGenres: ['Action'],
    adultOnly: true,
    nativeDates: true,
    imageReferers: [{ host: 'cdn.example.com', referer: 'https://example.com' }, { host: '*.img.example.com', referer: 'https://example.com/' }],
  }, { knownHosts: new Set(['example.com']) });
  assert.deepEqual(verdict.problems, []);
  assert.deepEqual(verdict.ui.orderBy, [{ value: 'relevance', label: 'Best Match' }, { value: 'createdAt', label: 'Newest' }]);
  assert.deepEqual(verdict.ui.filters, { orderBy: true, format: true, publicationStatus: false, genres: true });
  assert.deepEqual(verdict.ui.genres, ['Action', 'Sci-Fi', 'Slice of Life']);
  assert.deepEqual(verdict.ui.nsfwGenres, ['Action']);
  assert.equal(verdict.ui.adultOnly, true);
  assert.equal(verdict.ui.nativeDates, true);
  assert.deepEqual(verdict.ui.imageReferers, [
    { host: 'cdn.example.com', referer: 'https://example.com' },
    { host: '*.img.example.com', referer: 'https://example.com' },
  ]);
});

test('a declaration may say a genre filter is off even with a genre list; false flags are simply not kept', () => {
  const verdict = ui.sanitizeSourceUi({ genres: ['Action'], filters: { genres: false }, adultOnly: false, nativeDates: false });
  assert.equal(verdict.ui.filters.genres, false);
  assert.equal(verdict.ui.adultOnly, undefined);
  assert.equal(verdict.ui.nativeDates, undefined);
});

test('what is not understood is dropped with a reason, never kept', () => {
  const verdict = ui.sanitizeSourceUi({
    colour: 'red',
    filters: { orderBy: ['nonsense', 'title', 'title'], format: 'yes', teleport: true },
    genres: ['  Romance  ', '<b>Evil</b>', 'x'.repeat(41), 7, '', 'romance'],
    nsfwGenres: ['Hentai'],
    adultOnly: 'yes',
  });
  assert.deepEqual(verdict.ui.genres, ['Romance'], 'trimmed, deduplicated ignoring case, markup and long names refused');
  assert.deepEqual(verdict.ui.orderBy, [{ value: 'title', label: 'Title (A-Z)' }]);
  assert.equal(verdict.ui.filters.format, undefined);
  assert.equal(verdict.ui.filters.teleport, undefined);
  assert.equal(verdict.ui.adultOnly, undefined);
  assert.equal(verdict.ui.nsfwGenres, undefined, 'an adult genre that is not in the list is dropped');
  assert.equal(errors(verdict).length, 0);
  assert.ok(warnings(verdict).length >= 8);
});

test('an order-by list with nothing usable is treated as off, and a bad label falls back to the standard one', () => {
  const none = ui.sanitizeSourceUi({ filters: { orderBy: ['x', 'y'] } });
  assert.equal(none.ui.filters.orderBy, false);
  assert.equal(none.ui.orderBy, undefined);
  const label = ui.sanitizeSourceUi({ filters: { orderBy: [{ value: 'rating', label: '<script>' }] } });
  assert.deepEqual(label.ui.orderBy, [{ value: 'rating', label: 'Highest Rating' }]);
});

test('a category about sexualised minors in the genre list is an error, wherever the words start in the name', () => {
  for (const name of ['Loli', 'Lolicon', 'oppai loli', 'Low Shotacon', 'shota', 'Toddlercon']) {
    const verdict = ui.sanitizeSourceUi({ genres: ['Action', name] });
    assert.equal(errors(verdict).length, 1, `${name} must be refused`);
    assert.deepEqual(verdict.ui.genres, ['Action'], `${name} is not kept`);
  }
  assert.equal(errors(ui.sanitizeSourceUi({ genres: ['Action', 'Solo', 'Sci-Fi'] })).length, 0);
});

test('the genre list is capped', () => {
  const many = Array.from({ length: 260 }, (_, i) => `Genre ${i}`);
  const verdict = ui.sanitizeSourceUi({ genres: many });
  assert.equal(verdict.ui.genres.length, 200);
  assert.ok(warnings(verdict).some((m) => m.includes('200')));
});

test('a Referer rule only names hosts the source\'s own code names, as a plain https origin', () => {
  const known = new Set(['example.com']);
  const verdict = ui.sanitizeSourceUi({
    imageReferers: [
      { host: 'cdn.example.com', referer: 'https://example.com' },
      { host: 'cdn.other.com', referer: 'https://unrelated.com' },
      { host: 'cdn.example.com', referer: 'http://example.com' },
      { host: 'cdn.example.com', referer: 'https://example.com/path?x=1' },
      { host: 'cdn.example.com', referer: 'https://user:pw@example.com' },
      { host: '*.com', referer: 'https://example.com' },
      { host: 'not a host', referer: 'https://example.com' },
      { host: 'EXAMPLE.org', referer: 'https://example.com:8443' },
    ],
  }, { knownHosts: known });
  assert.deepEqual(verdict.ui.imageReferers, [{ host: 'cdn.example.com', referer: 'https://example.com' }]);
  assert.equal(warnings(verdict).length, 7);
  // Without the code's hosts to judge by, nothing is held back by this check (the loader always passes them).
  const unjudged = ui.sanitizeSourceUi({ imageReferers: [{ host: 'cdn.x.com', referer: 'https://anything.com' }] });
  assert.equal(unjudged.ui.imageReferers.length, 1);
});

test('key names that could poison objects are only ever unknown fields', () => {
  const raw = JSON.parse('{"__proto__": {"polluted": true}, "constructor": 1, "filters": {"__proto__": true}}');
  const verdict = ui.sanitizeSourceUi(raw);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(verdict.ui, {});
  assert.ok(warnings(verdict).length >= 2);
});

test('the browser is handed everything except the Referer rules', () => {
  const full = ui.sanitizeSourceUi({ genres: ['Action'], imageReferers: [{ host: 'a.example.com', referer: 'https://example.com' }] }).ui;
  const view = ui.clientViewOfUi(full);
  assert.equal(view.imageReferers, undefined);
  assert.deepEqual(view.genres, ['Action']);
  assert.equal(ui.clientViewOfUi(null), null);
});

// ── registry ───────────────────────────────────────────────────────────────

test('the registry answers by source id and forgets a source that is unregistered or cleared', (t) => {
  t.after(() => ui.clearSourceUiRegistry());
  ui.clearSourceUiRegistry();
  ui.registerSourceUi('alpha', { nativeDates: true });
  ui.registerSourceUi('beta', { genres: ['Action'] });
  assert.equal(ui.sourceHasNativeDates('alpha'), true);
  assert.equal(ui.sourceHasNativeDates('beta'), false);
  assert.equal(ui.sourceHasNativeDates('missing'), false);
  assert.deepEqual(ui.getSourceUi('beta'), { genres: ['Action'] });
  ui.registerSourceUi('alpha', null);
  assert.equal(ui.getSourceUi('alpha'), null, 'registering nothing forgets the entry');
  ui.unregisterSourceUi('beta');
  assert.equal(ui.getSourceUi('beta'), null);
  ui.registerSourceUi('gamma', {});
  ui.clearSourceUiRegistry();
  assert.equal(ui.getSourceUi('gamma'), null);
});

test('a declared Referer is found by host: an exact rule beats a wildcard one, and nothing matches by accident', (t) => {
  t.after(() => ui.clearSourceUiRegistry());
  ui.clearSourceUiRegistry();
  ui.registerSourceUi('one', { imageReferers: [{ host: '*.cdn.example.com', referer: 'https://wild.example.com' }] });
  ui.registerSourceUi('two', { imageReferers: [{ host: 'img.cdn.example.com', referer: 'https://exact.example.com' }] });
  assert.equal(ui.declaredRefererForHost('img.cdn.example.com'), 'https://exact.example.com');
  assert.equal(ui.declaredRefererForHost('other.cdn.example.com'), 'https://wild.example.com');
  assert.equal(ui.declaredRefererForHost('cdn.example.com'), '', 'a wildcard rule does not cover its own apex');
  assert.equal(ui.declaredRefererForHost('evilcdn.example.com.attacker.net'), '');
  assert.equal(ui.declaredRefererForHost(''), '');
});

// ── readDeclaredUiLiteral ──────────────────────────────────────────────────

test('a declaration written as a plain literal is read without running anything', () => {
  const text = `
    const BASE = 'https://example.com';
    exports.meta = {
      id: 'demo', name: 'Demo',
      // what the app should know
      ui: {
        filters: { orderBy: ['relevance', { value: 'title', label: "A \\"quoted\\" label {" }], genres: true, },
        genres: ['Action', 'Sci-Fi'], /* two */
        nativeDates: true,
        imageReferers: [{ host: 'cdn.example.com', referer: 'https://example.com' }],
      },
    };`;
  const read = ui.readDeclaredUiLiteral(text);
  assert.equal(read.found, true);
  assert.equal(read.readable, true);
  assert.equal(read.value.nativeDates, true);
  assert.deepEqual(read.value.genres, ['Action', 'Sci-Fi']);
  assert.equal(read.value.filters.orderBy[1].label, 'A "quoted" label {');
});

test('the meta.ui = { ... } form is read too, and a missing declaration is simply not found', () => {
  assert.equal(ui.readDeclaredUiLiteral("exports.meta = { id: 'x' };\nexports.meta.ui = { adultOnly: true };").value.adultOnly, true);
  assert.deepEqual(ui.readDeclaredUiLiteral("exports.meta = { id: 'x' };"), { found: false, readable: false });
  assert.equal(ui.readDeclaredUiLiteral("const menu = { build: 1 };").found, false, 'a word ending in ui is not the field');
});

test('a declaration that is computed cannot be read before installing, and says why', () => {
  for (const text of [
    "exports.meta = { ui: { genres: [...ALL_GENRES] } };",
    "exports.meta = { ui: { genres: makeGenres() } };",
    "exports.meta = { ui: { genres: `Action${x}` } };",
    "exports.meta = { ui: { nativeDates: true } } ; exports.meta.ui = { genres: [A, B] };".replace('{ ui: { nativeDates: true } }', '{}'),
    "exports.meta = { id: 'x', ui: CONSTANT_UI };",
    "exports.meta = { id: 'x', ui: Object.freeze({ adultOnly: true }) };",
    "exports.meta = { id: 'x', ui: cond ? { adultOnly: true } : undefined };",
  ]) {
    const read = ui.readDeclaredUiLiteral(text);
    assert.equal(read.found, true, text);
    assert.equal(read.readable, false, text);
    assert.ok(typeof read.reason === 'string' && read.reason.length > 0, text);
  }
});

test('a hostile literal is only ever data: no code runs, odd keys stay own properties', () => {
  const read = ui.readDeclaredUiLiteral('exports.meta = { ui: { "__proto__": { "polluted": 1 }, genres: [process.exit(1)] } };');
  assert.equal(read.readable, false);
  assert.equal({}.polluted, undefined);
  for (const hostile of ['exports.meta = { ui: { "__proto__": { "polluted": 1 } } };', 'exports.meta = { ui: { __proto__: { adultOnly: true } } };']) {
    const proto = ui.readDeclaredUiLiteral(hostile);
    assert.equal(proto.readable, false, 'a __proto__ key is refused, not read as a field');
    assert.match(proto.reason, /__proto__/);
    assert.equal({}.polluted, undefined);
  }
});
