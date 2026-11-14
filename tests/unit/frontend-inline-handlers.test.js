'use strict';

// Stored XSS through inline event handlers in the front end.
//
// The page builds HTML strings with onclick="fn('<value>')" where <value> is a
// title, an id or a preset field that came from a third-party source, from
// localStorage or from an imported file. escapeHtml() alone does not make that
// safe: the browser decodes the attribute (&#39; -> ') before the JS parser sees
// it. These tests load the real public/ scripts into a vm sandbox (no browser),
// push hostile values through the real render code, parse the markup the way a
// browser does (cheerio -> parse5) and run the decoded handler text, so a value
// that can still break out shows up as PWN() being called.
//
// The last section is a static guard: it scans every public/**/*.js file and
// fails on an inline handler that interpolates a non-constant without going
// through inlineJsArg / escapeHtml(JSON.stringify(...)).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cheerio = require('cheerio');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MODULES_DIR = path.join(PUBLIC_DIR, 'modules');

const BS = String.fromCharCode(92);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

// Values that break (or used to break) out of a quoted JS string / HTML attribute.
const HOSTILE = [
  BS + "');PWN(1);//",                              // backslash-quote cancels .replace(/'/g, "\\'")
  "x',PWN(2),'",                                    // closes the literal, adds an argument
  'a"b' + BS + 'c</script><img src=x onerror=PWN(3)>',
  '"+PWN(4)+"',
  '`${PWN(5)}`',
  'line1\nline2' + LS + PS + 'end',
  "'; PWN(6); '",
  BS,                                               // lone backslash would eat the closing quote
  BS + BS + "'",
  '</script><script>PWN(7)</script>',
  '&#39;);PWN(8);//',                               // entity text that a double decode would turn into a quote
  '&quot; onmouseover=PWN(9) x=&quot;',
  "');PWN(10);('",
];

// Ordinary values that must keep working exactly as before.
const BENIGN = [
  "Don't Stop Me Now",
  'He said "hi"',
  'C:' + BS + 'path' + BS + 'file',
  'Tokyo Ghoul:re - ' + String.fromCharCode(0x65e5, 0x672c, 0x8a9e) + ' ' + String.fromCharCode(0x201c) + 'quotes' + String.fromCharCode(0x201d) + ' ' + String.fromCharCode(0xf1),
  'a&b <i>c</i>',
  '',
  '12345',
  'f81b0c7e-aaaa-4c7d-9a1e-0123456789ab',
];

// ── vm sandbox ──────────────────────────────────────────────────────────────

function makeEnv(extra = {}) {
  const storage = new Map();
  const elements = new Map();
  const pwn = [];
  const sandbox = {
    console,
    PWN: (n) => { pwn.push(n); },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: (k) => { storage.delete(k); },
    },
    // Disk sync and the debounce timer are not under test; keep them inert.
    fetch: () => Promise.reject(new Error('offline')),
    setTimeout: () => 0,
    clearTimeout: () => {},
    t: (key) => key,
    showToast: () => {},
    ...extra,
  };
  sandbox.window = sandbox;
  sandbox.document = {
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, appendChild() {}, remove() {}, classList: { add() {}, remove() {}, toggle() {} } }),
    addEventListener() {},
    documentElement: { style: { setProperty() {}, removeProperty() {} }, getAttribute: () => '' },
    head: { appendChild() {} },
    body: { appendChild() {}, classList: { toggle() {}, remove() {} } },
  };
  vm.createContext(sandbox);
  return {
    ctx: sandbox,
    pwn,
    storage,
    elements,
    run: (code) => vm.runInContext(code, sandbox),
    // Registers a stand-in DOM element that records innerHTML assignments.
    element(id) {
      const el = { id, innerHTML: '' };
      elements.set(id, el);
      return el;
    },
  };
}

function loadScripts(env, files) {
  for (const file of files) {
    const full = path.join(MODULES_DIR, file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), env.ctx, { filename: full });
  }
  return env;
}

// Brings a value out of the sandbox realm so deepStrictEqual compares plain data.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

// Every on* attribute of a markup string, decoded the way a browser decodes it.
function handlersOf(html) {
  const $ = cheerio.load(html, null, false);
  const handlers = [];
  $('*').each((_, el) => {
    for (const [name, code] of Object.entries(el.attribs || {})) {
      if (/^on/i.test(name)) handlers.push({ tag: el.name, name, code, cls: el.attribs.class || '' });
    }
  });
  return { $, handlers };
}

// Runs decoded handler text like the browser does: `event` in scope, `this` = element.
function runHandler(env, code, thisArg = {}) {
  const fn = vm.runInContext('(function (event) {\n' + code + '\n})', env.ctx);
  fn.call(thisArg, { stopPropagation() {}, preventDefault() {} });
}

// Replaces the named globals with recorders and returns the shared call log.
function recordCalls(env, names) {
  const calls = [];
  for (const name of names) env.ctx[name] = (...args) => { calls.push([name, ...args.map(String)]); };
  return calls;
}

// ── 1. the helper itself ────────────────────────────────────────────────────

test('inlineJsArg: hostile and ordinary values reach the handler unchanged, nothing else runs', () => {
  const env = loadScripts(makeEnv(), ['utils.js', 'ui-discover.js']);
  for (const value of [...HOSTILE, ...BENIGN]) {
    const literal = env.ctx.inlineJsArg(value);
    assert.doesNotMatch(literal, /["<>']/, `attribute-unsafe character left in ${JSON.stringify(literal)}`);

    const calls = recordCalls(env, ['got']);
    const { handlers } = handlersOf(`<button onclick="got(${literal}, ${literal})">x</button>`);
    assert.equal(handlers.length, 1, `markup was split for ${JSON.stringify(value)}`);
    runHandler(env, handlers[0].code);
    assert.deepEqual(calls, [['got', value, value]], `value changed: ${JSON.stringify(value)}`);
  }
  assert.deepEqual(env.pwn, [], 'injected code ran');
});

test('inlineJsArg: null, undefined and numbers become string literals', () => {
  const env = loadScripts(makeEnv(), ['utils.js', 'ui-discover.js']);
  assert.equal(env.ctx.inlineJsArg(null), '&quot;&quot;');
  assert.equal(env.ctx.inlineJsArg(undefined), '&quot;&quot;');
  assert.equal(env.ctx.inlineJsArg(42), '&quot;42&quot;');
});

// ── 2. the sinks, driven through the real source ────────────────────────────

test('mangaCardHTML: Start Reading keeps hostile ids and source ids inside their string', () => {
  const env = loadScripts(makeEnv({
    state: { currentSourceId: 'mangadex', installedSources: {} },
    isMangaInLibrary: () => false,
    getDisplayMangaTitle: (m) => m.title,
  }), ['utils.js', 'ui-discover.js']);

  for (const value of [...HOSTILE, ...BENIGN]) {
    const html = env.ctx.mangaCardHTML({ id: value, sourceId: value, title: value, author: value, cover: '', genres: [] });
    const { $, handlers } = handlersOf(html);
    assert.equal($('[onerror]').length, 0, `an element was injected for ${JSON.stringify(value)}`);
    const start = handlers.find((h) => h.cls === 'btn-start-reading');
    assert.ok(start, 'Start Reading button missing');

    const calls = recordCalls(env, ['startReading']);
    runHandler(env, start.code);
    // An empty source id falls back to the current source, as it always did.
    assert.deepEqual(calls, [['startReading', value, value || 'mangadex']], `args changed for ${JSON.stringify(value)}`);
  }
  assert.deepEqual(env.pwn, []);
});

// Pulls the attribute text of the first inline handler in a source file whose
// text contains `needle`, then evaluates it as the template literal it lives in.
// That runs the real expression (not a copy of it) against the values given.
function renderRealHandler(env, file, needle, vars) {
  const src = fs.readFileSync(path.join(MODULES_DIR, file), 'utf8');
  const hit = findInlineHandlers(src).find((h) => h.raw.includes(needle));
  assert.ok(hit, `no inline handler containing ${needle} in ${file}; was the sink renamed?`);
  Object.assign(env.ctx, vars);
  const html = vm.runInContext('`<div class="probe" onclick="' + hit.raw + '">x</div>`', env.ctx);
  const { handlers } = handlersOf(html);
  assert.equal(handlers.length, 1, 'the handler was split into several attributes');
  return handlers[0].code;
}

test('ui-search: the "Check adaptation" badge passes any title through intact', () => {
  const env = loadScripts(makeEnv(), ['utils.js', 'ui-discover.js']);
  for (const title of [...HOSTILE, ...BENIGN]) {
    const code = renderRealHandler(env, 'ui-search.js', 'checkAnimeAdaptation(', { result: { title } });
    const calls = recordCalls(env, ['checkAnimeAdaptation']);
    runHandler(env, code);
    assert.deepEqual(calls, [['checkAnimeAdaptation', title]], `title changed: ${JSON.stringify(title)}`);
  }
  assert.deepEqual(env.pwn, []);
});

test('ui-search: the source-switch dropdown passes ids and titles through intact', () => {
  const env = loadScripts(makeEnv(), ['utils.js', 'ui-discover.js']);
  for (const value of [...HOSTILE, ...BENIGN]) {
    const code = renderRealHandler(env, 'ui-search.js', 'switchToSourceSearch(', { s: { id: value, name: 'n' }, title: value });
    const calls = recordCalls(env, ['switchToSourceSearch']);
    runHandler(env, code);
    assert.deepEqual(calls, [['switchToSourceSearch', value, value]], `args changed: ${JSON.stringify(value)}`);
  }
  assert.deepEqual(env.pwn, []);
});

test('ui-search: the choice-modal rows pass source and manga ids through intact', () => {
  const env = loadScripts(makeEnv(), ['utils.js', 'ui-discover.js']);
  for (const value of [...HOSTILE, ...BENIGN]) {
    const code = renderRealHandler(env, 'ui-search.js', "getElementById('sourceSwitchChoiceModal').remove()", { sourceId: value, c: { id: value } });
    env.ctx.state = { currentSourceId: '' };
    env.element('sourceSwitchChoiceModal').remove = () => {};
    const selects = [env.element('sourceSelect'), env.element('advancedSourceSelect')];
    const calls = recordCalls(env, ['loadMangaDetails']);
    runHandler(env, code);
    assert.deepEqual(calls, [['loadMangaDetails', value]], `manga id changed: ${JSON.stringify(value)}`);
    assert.equal(env.ctx.state.currentSourceId, value);
    assert.deepEqual(selects.map((el) => el.value), [value, value]);
  }
  assert.deepEqual(env.pwn, []);
});

// ── 3. preset data: one normaliser at every read ────────────────────────────

const PRESET_SCRIPTS = ['utils.js', 'ui-discover.js', 'ui-shop-view.js', 'ui-ui-binding.js'];

function presetEnv(extra) {
  return loadScripts(makeEnv(extra), PRESET_SCRIPTS);
}

test('getCustomPresets drops ids outside [A-Za-z0-9_-] and does not let the array index make an id optional', () => {
  const env = presetEnv();
  env.storage.set('scrollscape_custom_presets', JSON.stringify([
    { id: 'custom-1', name: 'first' },
    { name: 'second has no id' },                       // index 1: .map(normalise) would have kept this
    { id: 'x"><img src=x onerror=PWN(1)>', name: 'bad' },
    { id: "a'b", name: 'quote' },
    { id: 'custom-2', name: 'last' },
    null,
    'string',
    [],
  ]));
  assert.deepEqual(plain(env.ctx.getCustomPresets()).map((p) => p.id), ['custom-1', 'custom-2']);
});

test('getCustomPresets copes with a stored value that is not a list, or not JSON', () => {
  const env = presetEnv();
  for (const raw of ['{"id":"x"}', '"text"', '5', 'null', '{broken']) {
    env.storage.set('scrollscape_custom_presets', raw);
    assert.deepEqual(plain(env.ctx.getCustomPresets()), [], raw);
  }
});

test('getActiveCustom keeps an id-less working config but never a hostile id', () => {
  const env = presetEnv();
  env.storage.set('scrollscape_active_custom', JSON.stringify({ bgUrl: 'https://a/b.png', bgDim: 30 }));
  assert.deepEqual(plain(env.ctx.getActiveCustom()), { bgUrl: 'https://a/b.png', bgDim: 30 });

  env.storage.set('scrollscape_active_custom', JSON.stringify({ id: 'x"><img src=x onerror=PWN(1)>', bgDim: 30 }));
  const active = plain(env.ctx.getActiveCustom());
  assert.equal(active.id, undefined);
  assert.equal(active.bgDim, 30);

  for (const raw of ['null', '5', '"s"', '[1]', '{broken']) {
    env.storage.set('scrollscape_active_custom', raw);
    assert.equal(env.ctx.getActiveCustom(), null, raw);
  }
});

test('_normalizeCustomPreset: numbers are coerced and clamped, unknown keys dropped', () => {
  const env = presetEnv();
  const n = plain(env.ctx._normalizeCustomPreset({
    id: 'custom-1',
    name: 'N',
    bgDim: '0</span><img src=x onerror=PWN(1)>',    // not a number -> left out, default applies
    bgOpac: '40',
    bgPosX: -20,
    bgPosY: 250,
    charDim: Infinity,
    charDark: null,
    cornerDim: 12.5,
    evil: '<script>',
  }));
  assert.deepEqual(n, { id: 'custom-1', name: 'N', bgOpac: 40, bgPosX: 0, bgPosY: 100, cornerDim: 12.5 });
});

test('_normalizeCustomPreset ignores a __proto__ key coming from JSON', () => {
  const env = presetEnv();
  const parsed = JSON.parse('{"id":"a","__proto__":{"bgUrl":"https://evil/x.png"},"constructor":{"prototype":{"polluted":1}}}');
  assert.deepEqual(plain(env.ctx._normalizeCustomPreset(parsed)), { id: 'a', name: '' });
  assert.equal(({}).polluted, undefined);
});

test('_normalizeCustomPreset: url fields keep http(s), relative and data:image, and lose everything scriptable', () => {
  const env = presetEnv();
  const url = (v) => plain(env.ctx._normalizeCustomPreset({ id: 'a', bgUrl: v })).bgUrl;
  assert.equal(url('https://cdn.example/a(1).png?x=1&y=2'), 'https://cdn.example/a(1).png?x=1&y=2');
  assert.equal(url('http://cdn.example/a.png'), 'http://cdn.example/a.png');
  assert.equal(url('/api/proxy-image?url=abc'), '/api/proxy-image?url=abc');
  assert.equal(url('//cdn.example/a.png'), '//cdn.example/a.png');
  assert.equal(url('images/a.png'), 'images/a.png');
  assert.equal(url('data:image/png;base64,iVBORw0KGgo='), 'data:image/png;base64,iVBORw0KGgo=');
  for (const bad of [
    'javascript:PWN(1)', 'JaVaScRiPt:PWN(1)', ' javascript:PWN(1)', 'java' + String.fromCharCode(9) + 'script:PWN(1)',
    'java' + String.fromCharCode(10) + 'script:PWN(1)', 'vbscript:x', 'data:text/html,<script>PWN(1)</script>',
    'file:///etc/passwd', 'blob:https://x/y', 'ftp://x/y',
  ]) {
    assert.equal(url(bad), '', JSON.stringify(bad));
  }
  // Characters that would end url('...') or the attribute are encoded, not dropped.
  assert.equal(url("https://a/b.png');background:url(//evil/x"), 'https://a/b.png%27);background:url(//evil/x');
  assert.equal(url('https://a/"onmouseover=PWN(1)'), 'https://a/%22onmouseover=PWN(1)');
  assert.equal(url('https://a/<b>' + BS), 'https://a/%3Cb%3E%5C');
  assert.equal(url('https://a/x y'), 'https://a/x%20y');
  assert.ok(url('https://a/' + 'x'.repeat(5000)).length <= 1500);
});

test('_normalizeCustomPreset: colours must be #rrggbb and the font must be one of the offered fonts', () => {
  const env = presetEnv();
  const n = plain(env.ctx._normalizeCustomPreset({
    id: 'a',
    paletteColor: '#A1b2C3',
    buttonColor: 'red;}</style><img src=x onerror=PWN(1)>',
    accentColor: '#A1b2C3', // the Accent colour card is gone: an old preset's value is simply left out
    fontFamily: "'Courier New', monospace",
  }));
  assert.equal(n.paletteColor, '#A1b2C3');
  assert.equal(n.buttonColor, '');
  assert.equal('accentColor' in n, false);
  assert.equal(n.fontFamily, "'Courier New', monospace");
  assert.equal(plain(env.ctx._normalizeCustomPreset({ id: 'a', fontFamily: 'x}</style><img>' })).fontFamily, '');
});

test('_normalizeCustomPreset: the menu text colour is a #rrggbb colour like the other three, and nothing else reaches the style rule', () => {
  const env = presetEnv();
  assert.equal(plain(env.ctx._normalizeCustomPreset({ id: 'a', sidebarTextColor: '#FF8800' })).sidebarTextColor, '#FF8800');
  for (const hostile of ['red', '#12', '#ff880', 'red;}</style><img src=x onerror=PWN(1)>', '#ff8800;}body{display:none']) {
    assert.equal(plain(env.ctx._normalizeCustomPreset({ id: 'a', sidebarTextColor: hostile })).sidebarTextColor, '', hostile);
  }
  assert.equal('sidebarTextColor' in plain(env.ctx._normalizeCustomPreset({ id: 'a' })), false, 'a preset without one gets none');
});

test('_normalizeCustomPreset is idempotent', () => {
  const env = presetEnv();
  const once = env.ctx._normalizeCustomPreset({
    id: 'custom-9', name: 'N', bgUrl: "https://a/b.png'x", bgDim: 33, paletteColor: '#112233', fontFamily: "'Orbitron', sans-serif",
  });
  assert.deepEqual(plain(env.ctx._normalizeCustomPreset(once)), plain(once));
});

test('importing presets: hostile entries are skipped and counted, valid ones kept, __proto__ is just an id', () => {
  const env = presetEnv();
  const merged = plain(env.ctx._mergeImportedCustomPresets(
    [{ id: 'custom-1', name: 'old', bgDim: 10 }],
    [
      { id: 'custom-1', name: 'replaced', bgDim: 20 },
      { id: 'custom-2', name: 'new' },
      { id: 'x"><img src=x onerror=PWN(1)>', name: 'bad' },
      { name: 'no id' },
      null,
      { id: '__proto__', name: 'proto' },
    ],
  ));
  assert.equal(merged.skipped, 3);
  assert.deepEqual(merged.presets.map((p) => p.id), ['custom-1', 'custom-2', '__proto__']);
  assert.equal(merged.presets[0].name, 'replaced');
});

test('importing presets: at most 200 are kept', () => {
  const env = presetEnv();
  const many = Array.from({ length: 300 }, (_, i) => ({ id: 'p' + i, name: 'n' }));
  assert.equal(plain(env.ctx._mergeImportedCustomPresets([], many)).presets.length, 200);
});

test('Customize preset rows: every handler hands the exact id back, even for an id the normaliser would reject', () => {
  const env = presetEnv();
  const rows = ['custom-1700000000000', ...HOSTILE];
  for (const id of rows) {
    const html = env.ctx._customPresetCardHtml({ id, name: id }, false, (k) => k);
    const { $, handlers } = handlersOf(html);
    assert.equal($('[onerror]').length + $('img').length + $('script').length, 0, `element injected for ${JSON.stringify(id)}`);
    assert.equal(handlers.length, 4);
    const calls = recordCalls(env, ['togglePresetInThemes', 'applyCustomPreset', 'editCustomPreset', 'deleteCustomPreset']);
    for (const h of handlers) runHandler(env, h.code);
    assert.deepEqual(calls, [
      ['togglePresetInThemes', id], ['applyCustomPreset', id], ['editCustomPreset', id], ['deleteCustomPreset', id],
    ]);
  }
  assert.deepEqual(env.pwn, []);
});

// Hostile data planted in localStorage the way the skeptic did it: a valid id
// (so the id filter alone cannot help) with payloads in every other field.
function plantHostilePresets(env) {
  const html = '</span><img src=x onerror=PWN(1)>';
  const hostile = {
    id: 'custom-1',
    name: 'N' + html,
    bgUrl: "https://a/b.png');}</div>" + html,
    charUrl: 'javascript:PWN(2)',
    headerUrl: 'https://a/h.png"' + html,
    cornerUrl: "https://a/c.png'" + html,
    bgDim: '0' + html, bgOpac: '0' + html, bgPosX: '0' + html, bgPosY: '0' + html,
    charDim: '0' + html, charDark: '0' + html, charPosX: '0' + html, charPosY: '0' + html,
    headerDim: '0' + html, headerOpac: '0' + html, headerPosX: '0' + html, headerPosY: '0' + html,
    cornerDim: '0' + html, cornerDark: '0' + html, cornerPosX: '0' + html, cornerPosY: '0' + html,
    paletteColor: '#12345g"' + html, buttonColor: 'x"' + html,
    fontFamily: 'z"' + html,
  };
  env.storage.set('scrollscape_custom_presets', JSON.stringify([
    hostile,
    { id: 'x"><img src=x onerror=PWN(3)>', name: 'bad id' },
  ]));
  env.storage.set('scrollscape_active_custom', JSON.stringify(hostile));
  env.storage.set('scrollscape_theme_preset_ids', JSON.stringify(['custom-1', 'x"><img src=x onerror=PWN(3)>']));
  return hostile;
}

test('Customize view: hostile preset fields and ids cannot add elements or handlers', () => {
  const env = presetEnv();
  plantHostilePresets(env);
  const view = env.element('view-customize');
  try {
    env.ctx.renderCustomizeView();
  } catch (err) {
    // The stand-in DOM has no buttons to wire up; only a failure before the
    // markup was produced would be a real problem.
    if (!view.innerHTML) throw err;
  }
  assert.ok(view.innerHTML.includes('custom-preset-card'), 'the valid preset row was not rendered');

  const { $, handlers } = handlersOf(view.innerHTML);
  assert.equal($('img, script, iframe, svg').length, 0, 'an element was injected');
  assert.equal($('.custom-preset-card').length, 1, 'the hostile-id preset should not be listed');
  assert.deepEqual(handlers.map((h) => h.name), ['onclick', 'onclick', 'onclick', 'onclick']);
  for (const el of $('*').toArray()) {
    for (const [name, value] of Object.entries(el.attribs)) {
      if (name === 'onclick') continue;
      assert.doesNotMatch(name, /^on/i, `unexpected attribute ${name}`);
      if (name === 'style') assert.doesNotMatch(value, /[<>]/, 'markup inside a style attribute');
    }
  }
  assert.deepEqual(env.pwn, []);
});

test('Customize view: slider labels and values stay numeric when the stored value is not', () => {
  const env = presetEnv();
  env.storage.set('scrollscape_active_custom', JSON.stringify({ bgDim: '0</span><img src=x onerror=PWN(1)>', bgOpac: 40, charDark: '17' }));
  const view = env.element('view-customize');
  try { env.ctx.renderCustomizeView(); } catch (err) { if (!view.innerHTML) throw err; }
  const { $ } = handlersOf(view.innerHTML);
  assert.equal($('#customBgDim').attr('value'), '0');
  assert.equal($('#customBgDimVal').text(), '0');
  assert.equal($('#customBgOpac').attr('value'), '40');
  assert.equal($('#customCharDark').attr('value'), '17');
  assert.equal($('img').length, 0);
});

// A tiny recording DOM for applyCustomization.
function layerEnv() {
  const layers = [];
  const env = presetEnv();
  env.ctx.document.createElement = (tag) => {
    const el = { tag, style: {}, appendChild() {}, remove() {}, classList: { add() {}, remove() {}, toggle() {} } };
    layers.push(el);
    return el;
  };
  return { env, layers };
}

test('applyCustomization: a url cannot leave url(...) and add CSS or a second resource', () => {
  const { env, layers } = layerEnv();
  env.ctx.applyCustomization({
    bgUrl: "https://a/b.png');background:url(//evil/x.png);--x:('",
    bgDim: '10</style>',
    charUrl: 'javascript:PWN(1)',
  });
  const bg = layers.find((l) => l.style.cssText && l.style.cssText.includes('url('));
  assert.ok(bg, 'the background layer was not built');
  const css = bg.style.cssText;
  // Exactly the two quotes that delimit the url string: the ones in the value are encoded.
  assert.equal((css.match(/'/g) || []).length, 2, css);
  assert.ok(css.includes("url('https://a/b.png%27);background:url(//evil/x.png);--x:(%27')"), css);
  assert.equal(layers.filter((l) => l.tag === 'img').length, 0, 'a javascript: image overlay was built');
});

test('applyCustomization: the menu text colour becomes one rule for the left menu, and nothing without a colour', () => {
  const ruleOf = (cfg) => {
    const { env, layers } = layerEnv();
    env.ctx.applyCustomization(cfg);
    const el = layers.filter((l) => l.id === 'custom-sidebar-text-style').pop();
    assert.ok(el, 'the menu text style element was not created');
    return el.textContent;
  };
  const rule = ruleOf({ sidebarTextColor: '#ff8800' });
  assert.ok(rule.includes('.sidebar .nav-link.active'), 'the active link keeps the chosen colour too');
  assert.ok(rule.includes('.sidebar .sidebar-nav-label') && rule.includes('.sidebar .sidebar-brand-text'), rule);
  assert.ok(rule.endsWith('{color:#ff8800!important;}'), rule);
  assert.equal(ruleOf({ bgDim: 10 }), '', 'no colour, no rule: the theme keeps its own');
  assert.equal(ruleOf({ sidebarTextColor: 'red;}body{display:none' }), '', 'a value that is not #rrggbb never reaches the rule');
  assert.equal(ruleOf(null), '', 'clearing the customisation clears the rule');
});

// ── 4. Themes / Shop views ──────────────────────────────────────────────────

function shopEnv(themes) {
  const env = presetEnv({
    SHOP_THEMES: themes,
    getPurchasedThemes: () => themes.map((x) => x.id),
    getActiveTheme: () => 'none',
    getAvailableAP: () => 100000,
    updateApBadge: () => {},
    setView: () => {},
    addPurchasedTheme: () => {},
    setActiveTheme: () => {},
  });
  return { env, owned: env.element('themesOwnedGrid'), custom: env.element('themesCustomGrid'), shop: env.element('shopGrid') };
}

test('Themes view: preset buttons pass the exact id, and planted hostile presets render nothing hostile', () => {
  const { env, owned, custom } = shopEnv([{ id: 'plain', name: 'Plain', desc: 'd', cost: 0, preview: '#000' }]);
  plantHostilePresets(env);
  // No preset is the active one, so every row offers Apply (an active row has none).
  env.storage.set('scrollscape_active_custom', JSON.stringify({ bgDim: '0</span><img src=x onerror=PWN(4)>' }));
  env.ctx.renderThemesView();

  const { $, handlers } = handlersOf(owned.innerHTML + custom.innerHTML);
  assert.equal($('img, script, iframe, svg').length, 0, 'an element was injected');
  assert.equal($('[onerror]').length, 0);
  assert.equal($('.shop-card-preview').length, 2, 'one theme and the one valid preset');
  for (const el of $('.shop-card-preview').toArray()) assert.doesNotMatch(el.attribs.style, /[<>]/);

  const calls = recordCalls(env, ['setActiveTheme', 'applyCustomPreset', 'openPresetThemeSettings', 'removePresetFromThemes', 'renderThemesView']);
  for (const h of handlers) runHandler(env, h.code);
  assert.deepEqual(calls.filter((c) => c[0] !== 'renderThemesView'), [
    ['setActiveTheme', 'plain'],
    ['applyCustomPreset', 'custom-1'],
    ['openPresetThemeSettings', 'custom-1'],
    ['removePresetFromThemes', 'custom-1'],
  ]);
  assert.deepEqual(env.pwn, []);
});

test('Shop and Themes views: even a hostile theme id stays inside its string', () => {
  for (const id of HOSTILE) {
    const { env, owned, shop } = shopEnv([
      { id, name: id, desc: id, cost: 0, preview: '#000' },
      { id: id + 'paid', name: 'Paid', desc: 'd', cost: 5, preview: '#000' },
      { id: id + 'free', name: 'Free', desc: 'd', cost: 0, preview: '#000' },
    ]);
    env.ctx.getPurchasedThemes = () => [id];
    env.ctx.renderThemesView();
    env.ctx.renderShopView();
    const calls = recordCalls(env, ['setActiveTheme', 'addPurchasedTheme', 'buyTheme', 'renderThemesView', 'renderShopView']);
    for (const html of [owned.innerHTML, shop.innerHTML]) {
      const { $, handlers } = handlersOf(html);
      assert.equal($('[onerror]').length, 0, JSON.stringify(id));
      for (const h of handlers) runHandler(env, h.code);
    }
    const ids = new Set(calls.filter((c) => ['setActiveTheme', 'addPurchasedTheme', 'buyTheme'].includes(c[0])).map((c) => c[1]));
    assert.deepEqual([...ids].sort(), [id, id + 'free', id + 'paid'].sort(), `arguments changed for ${JSON.stringify(id)}`);
    assert.deepEqual(env.pwn, []);
  }
});

test('getThemePresetIds survives a planted non-array value', () => {
  const env = presetEnv();
  for (const raw of ['{"a":1}', '"x"', '5', 'null', '{broken']) {
    env.storage.set('scrollscape_theme_preset_ids', raw);
    assert.deepEqual(plain(env.ctx.getThemePresetIds()), [], raw);
  }
  env.storage.set('scrollscape_theme_preset_ids', JSON.stringify(['a', 3, null, 'b']));
  assert.deepEqual(plain(env.ctx.getThemePresetIds()), ['a', 'b']);
});

// ── 5. static guard ─────────────────────────────────────────────────────────
//
// An inline handler may carry data only as ${inlineJsArg(x)} (or the spelled-out
// ${escapeHtml(JSON.stringify(x))}), or, when the markup is built by string
// concatenation, ' + inlineJsArg(x) + '. A handler with no interpolation at all
// (onclick="closeImportModal()") is a constant and is always fine.

// Constants that are interpolated into a handler on purpose and verified safe.
// Key: "<path relative to the repo root, forward slashes> :: <expression>".
// Prefer wrapping the value in inlineJsArg() over adding an entry here.
const ALLOWED_DYNAMIC = new Set([
]);

function prevSignificant(src, j) {
  for (let k = j - 1; k >= 0; k--) if (!/\s/.test(src[k])) return src[k];
  return '';
}

// Returns the index of the closing brace of the `${` expression that starts at src[i].
function skipExpr(src, i) {
  let depth = 0;
  let j = i + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === BS) { j++; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return j; }
    else if (c === '/' && /[(,=:[!&|?{};]/.test(prevSignificant(src, j))) {
      // regex literal such as .replace(/'/g, ...): its quote must not open a string
      for (j++; j < src.length && src[j] !== '/'; j++) if (src[j] === BS) j++;
    } else if (c === '"' || c === "'") {
      const q = c;
      for (j++; j < src.length && src[j] !== q; j++) if (src[j] === BS) j++;
    } else if (c === '`') {
      for (j++; j < src.length && src[j] !== '`'; j++) {
        if (src[j] === BS) { j++; continue; }
        if (src[j] === '$' && src[j + 1] === '{') j = skipExpr(src, j);
      }
    }
  }
  return j;
}

// Every on*="..." / on*='...' attribute in a piece of JS source, with the
// `${...}` expressions found inside it. `raw` is the attribute value as written.
function findInlineHandlers(src) {
  const found = [];
  const re = /(?:^|[\s"'`\\])(on[a-z]{3,})\s*=\s*\\?(["'])/g;
  let m;
  while ((m = re.exec(src))) {
    const quote = m[2];
    const start = m.index + m[0].length;
    const exprs = [];
    let i = start;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === BS) { i++; continue; }
      if (c === '$' && src[i + 1] === '{') {
        const end = skipExpr(src, i);
        exprs.push(src.slice(i + 2, end).trim());
        i = end;
        continue;
      }
      if (c === quote) break;
    }
    const nameAt = m.index + m[0].indexOf(m[1]);
    found.push({
      attr: m[1],
      raw: src.slice(start, i),
      exprs,
      line: src.slice(0, nameAt).split('\n').length,
    });
    re.lastIndex = i;
  }
  return found;
}

// Index of the ")" that closes the "(" at str[open], skipping string literals; -1 if none.
function matchingParen(str, open) {
  let depth = 0;
  for (let j = open; j < str.length; j++) {
    const c = str[j];
    if (c === '"' || c === "'" || c === '`') {
      for (j++; j < str.length && str[j] !== c; j++) if (str[j] === BS) j++;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}

// True when `expr` is exactly one call to inlineJsArg(...) or escapeHtml(JSON.stringify(...)).
// "inlineJsArg(a) + b" and "escapeHtml(JSON.stringify(a) + b)" are not: the extra
// operand would land in the handler's JS unescaped.
function isSafeHandlerExpr(expr) {
  const e = expr.trim();
  let m = /^inlineJsArg\s*\(/.exec(e);
  if (m) return matchingParen(e, m[0].length - 1) === e.length - 1;
  m = /^escapeHtml\s*\(\s*JSON\.stringify\s*\(/.exec(e);
  if (m) {
    const stringifyClose = matchingParen(e, m[0].length - 1);
    return stringifyClose !== -1 && e.slice(stringifyClose + 1).trim() === ')';
  }
  return false;
}

// Concatenated interpolations: ' + expr + '  (either quote style).
function concatExprs(raw) {
  const blanked = raw.split(BS).join(' ');   // an escaped quote must not look like a delimiter
  const out = [];
  const re = /(['"])\s*\+\s*(.+?)\s*\+\s*\1/g;
  let m;
  while ((m = re.exec(blanked))) out.push(m[2].trim());
  return out;
}

function auditSource(src, relPath) {
  const problems = [];
  for (const h of findInlineHandlers(src)) {
    const concatenated = /['"]\s*\+|\+\s*['"]/.test(h.raw.split(BS).join('  '));
    const exprs = [...h.exprs, ...(concatenated ? concatExprs(h.raw) : [])];
    if (concatenated && exprs.length === h.exprs.length) {
      problems.push(`${relPath}:${h.line} ${h.attr}: concatenation the guard cannot parse`);
    }
    for (const expr of exprs) {
      if (isSafeHandlerExpr(expr)) continue;
      if (ALLOWED_DYNAMIC.has(`${relPath} :: ${expr}`)) continue;
      problems.push(`${relPath}:${h.line} ${h.attr}: "${expr.slice(0, 80)}" is interpolated into an inline handler; wrap it in inlineJsArg(...)`);
    }
  }
  return problems;
}

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('guard: no inline handler in public/ interpolates a value without inlineJsArg', () => {
  const problems = [];
  const files = listJsFiles(PUBLIC_DIR);
  assert.ok(files.length > 50, 'the scan found suspiciously few files');
  for (const file of files) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    problems.push(...auditSource(fs.readFileSync(file, 'utf8'), rel));
  }
  assert.deepEqual(problems, []);
});

test('guard: handlers are not assigned from strings with setAttribute, and no javascript: URLs are built', () => {
  const offenders = [];
  for (const file of listJsFiles(PUBLIC_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (/setAttribute\(\s*['"`]on/i.test(src)) offenders.push(`${rel}: setAttribute('on...')`);
    if (/javascript:/i.test(src)) offenders.push(`${rel}: javascript: URL`);
  }
  assert.deepEqual(offenders, []);
});

test('guard: the scanner flags the unsafe spellings and accepts the safe ones', () => {
  const audit = (code) => auditSource(code, 'probe.js');
  const unsafe = [
    "`<b onclick=\"fn('${escapeHtml(x)}')\">`",
    "`<b onclick=\"fn('${x}')\">`",
    "`<b onclick=\"fn('${escapeHtml(x.replace(/'/g, \"" + BS + BS + "'\"))}')\">`",
    "`<b onclick=\"fn(${inlineJsArg(x) + y})\">`",
    "`<b onclick=\"fn(${inlineJsArg(x)}, '${y}')\">`",
    "`<b onclick='fn(${x})'>`",
    "`<b onchange=\"fn(${String(x)})\">`",
    "'<b onclick=\"fn(" + BS + "'' + id + '" + BS + "')\">'",
    "'<b onclick=\"fn(" + BS + "'' + inlineJsArg(a) + b + '" + BS + "')\">'",
    "'<b onerror=\"fn(' + x + ')\">'",
  ];
  for (const code of unsafe) assert.notDeepEqual(audit(code), [], `not flagged: ${code}`);

  const safe = [
    '`<b onclick="closeModal()">`',
    '`<b onclick="fn(${inlineJsArg(x)})">`',
    '`<b onclick="fn(${inlineJsArg(a.b(c))}, ${inlineJsArg(d)})">`',
    '`<b onclick="fn(${escapeHtml(JSON.stringify(String(x)))})">`',
    "`<b onclick=\"event.stopPropagation(); fn(${inlineJsArg(x)})\">`",
    "'<b onclick=\"fn(' + inlineJsArg(x) + ')\">'",
    "'<b onclick=\"fn(' + inlineJsArg(p.id) + ',' + inlineJsArg(q) + ')\">'",
    '`<span data-a="${escapeHtml(a)}" onclick="go(this.dataset.a)">`',
    '`<img onerror="this.style.display=\'none\'">`',
    'el.onclick = () => go(1);',
  ];
  for (const code of safe) assert.deepEqual(audit(code), [], `wrongly flagged: ${code}`);
});
