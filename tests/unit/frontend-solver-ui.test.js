'use strict';

// The "Protected sites" card in Settings > Integrations (public/modules/ui-settings-solver.js): the three settings of
// the FlareSolverr session pool. As in frontend-inline-handlers.test.js the real public/ scripts run in a vm sandbox,
// with a DOM stand-in built from the card's real markup (an id that markup and glue disagree on fails here). No
// network: the server is a stub judging every save with the real validator, so refusal texts are the server's own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cheerio = require('cheerio');

const { SETTINGS_DEFAULTS, SETTINGS_BOUNDS, ENV_NAMES } = require('../../server/config/solver');
const { normalizeSolverSettings, parseSolverSettingsUpdate } = require('../../server/modules/common/solver-settings');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MODULES_DIR = path.join(PUBLIC_DIR, 'modules');
const MODULE_FILE = path.join(MODULES_DIR, 'ui-settings-solver.js');
const CSS_FILE = path.join(PUBLIC_DIR, 'css-modules', 'solver-settings.css');
const SCRIPTS = ['i18n/locales/en-GB.js', 'i18n/locales/pt-PT.js', 'i18n/index.js', 'utils.js', 'ui-settings-solver.js'];

const KEYS = Object.keys(SETTINGS_DEFAULTS);
const [TOGGLE, POOL, IDLE] = KEYS;
const INPUT_ID = { [TOGGLE]: 'solverSessionsEnabledToggle', [POOL]: 'solverSessionPoolSizeInput', [IDLE]: 'solverSessionIdleMinutesInput' };
const ERROR_ID = { [TOGGLE]: 'solverSessionsEnabledError', [POOL]: 'solverSessionPoolSizeError', [IDLE]: 'solverSessionIdleMinutesError' };
const HOSTILE = ['"><img src=x onerror=PWN(1)>', '<script>PWN(2)</script>', "' onfocus='PWN(3)", '</div><svg onload=PWN(4)>'];

// A control. Writing innerHTML on it throws: anything the server said must go in through textContent.
function fakeElement(attribs = {}) {
  const attrs = new Map(Object.entries(attribs));
  const classes = new Set();
  const listeners = new Map();
  const el = {
    value: String(attribs.value ?? ''),
    checked: 'checked' in attribs,
    disabled: false,
    textContent: '',
    classList: { toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name) },
    setAttribute: (name, value) => { attrs.set(name, String(value)); },
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    removeAttribute: (name) => { attrs.delete(name); },
    addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    listenerTypes: () => [...listeners.keys()].sort(),
    async fire(type) { for (const fn of listeners.get(type) || []) await fn({ type }); },
  };
  Object.defineProperty(el, 'innerHTML', { configurable: true, set() { throw new Error('innerHTML written on a control'); } });
  return el;
}

// The card: takes markup, and makes a stand-in for every element with an id in it.
function fakeCard() {
  const children = new Map();
  let html = '';
  const card = fakeElement();
  const parse = (value) => {
    html = String(value);
    children.clear();
    cheerio.load(html, null, false)('[id]').each((_, node) => { children.set(node.attribs.id, fakeElement(node.attribs)); });
  };
  Object.defineProperty(card, 'innerHTML', { configurable: true, get: () => html, set: parse });
  card.querySelector = (selector) => children.get(selector.slice(1)) || null;
  return card;
}

// A Settings modal whose Integrations tab holds one card (the anchor). `added` records [position, element].
function fakeModal({ withTab = true, withAnchor = true } = {}) {
  const added = [];
  const anchor = { insertAdjacentElement: (position, el) => { added.push([position, el]); } };
  const tab = {
    appendChild: (el) => { added.push(['end', el]); },
    querySelector: (selector) => (selector === '.settings-section-card' ? (withAnchor ? anchor : null) : (added[0] || [])[1] || null),
  };
  return { added, querySelector: (selector) => (selector === '#tab-network' && withTab ? tab : null) };
}

const deferred = () => { const d = {}; d.promise = new Promise((resolve) => { d.resolve = resolve; }); return d; };
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Stores what it is sent, judging each save with the real validator. A read also returns an unrelated secret:
// the card must never show or send it.
function serverStub(stored = {}) {
  const store = { proxyPassword: 'hunter2-not-for-the-card', ...stored };
  const posts = [];
  const impl = async (route, opts) => {
    if (!opts) return { ok: true, data: { ...store, ...normalizeSolverSettings(store) } };
    const body = JSON.parse(opts.body);
    posts.push(body);
    const { patch, error } = parseSolverSettingsUpdate(body);
    if (error) throw new Error(error);
    Object.assign(store, patch);
    return { ok: true };
  };
  return { impl, store, posts };
}

function makeEnv(apiImpl) {
  const calls = [];
  const pwn = [];
  const sandbox = {
    console,
    PWN: (n) => { pwn.push(n); },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: () => fakeCard() },
  };
  if (apiImpl) sandbox.api = (route, opts) => { calls.push({ route, opts }); return apiImpl(route, opts); };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const rel of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(MODULES_DIR, rel), 'utf8'), sandbox);
  return { ctx: sandbox, calls, pwn };
}

// The module added to a fake modal. el(key) is the control of a setting, err(key) its error line.
function mountCard(apiImpl, { onSaved, language, ...modalOptions } = {}) {
  const env = makeEnv(apiImpl);
  if (language) env.ctx.setLanguage(language);
  const modal = fakeModal(modalOptions);
  const mounted = env.ctx.mountSolverSettingsCard(modal, onSaved);
  const byId = (id) => mounted.card.querySelector('#' + id);
  return { env, modal, mounted, el: (key) => byId(INPUT_ID[key]), err: (key) => byId(ERROR_ID[key]), loadError: () => byId('solverSettingsLoadError') };
}

const markup = (env, values) => cheerio.load('<div>' + env.ctx.buildSolverSettingsCardHtml(values) + '</div>', null, false);

function locale(name) {
  const sandbox = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(MODULES_DIR, 'i18n', 'locales', name + '.js'), 'utf8'), sandbox);
  return JSON.parse(JSON.stringify(sandbox.window.ScrollScapeI18nLocales[name]));
}

const EN = locale('en-GB');
const PT = locale('pt-PT');
const solverKeys = (strings) => Object.keys(strings).filter((k) => k.startsWith('settings.solver.')).sort();

test('renders with the defaults, every text from the locale, every control labelled and described', () => {
  const $ = markup(makeEnv());
  const attrs = (key, names) => names.map((name) => $('#' + INPUT_ID[key]).attr(name));
  assert.deepEqual(attrs(TOGGLE, ['type', 'role']), ['checkbox', 'switch']);
  assert.equal($('#' + INPUT_ID[TOGGLE]).attr('checked'), undefined, 'the switch starts off: nobody has the pool on without choosing so');
  assert.deepEqual(attrs(POOL, ['type', 'min', 'max', 'step', 'value']), ['number', '1', '3', '1', '2']);
  assert.deepEqual(attrs(IDLE, ['type', 'min', 'max', 'step', 'value']), ['number', '1', '15', '1', '10']);

  const texts = {
    '.settings-section-title': EN['settings.solver.title'],
    [`label[for="${INPUT_ID[TOGGLE]}"] .toggle-text`]: EN['settings.solver.enabledLabel'],
    [`label[for="${INPUT_ID[POOL]}"]`]: EN['settings.solver.poolSizeLabel'],
    [`label[for="${INPUT_ID[IDLE]}"]`]: EN['settings.solver.idleMinutesLabel'],
    '#solverSessionsHint': EN['settings.solver.hint'],
    '#solverSessionPoolSizeRange': 'From 1 to 3.',
    '#solverSessionIdleMinutesRange': 'From 1 to 15.',
  };
  for (const [selector, text] of Object.entries(texts)) assert.equal($(selector).text(), text, selector);
  assert.ok($('.solver-settings-env').text().includes('SCROLLSCAPE_SOLVER_SESSIONS_DISABLED'));
  assert.ok($.root().text().includes('Live status is shown in System Health > External Services.'));
  assert.doesNotMatch($.root().text(), /settings\.solver\.|\{\w+\}/, 'a key or a placeholder leaked into the page');
  // The hint: one sentence saying what the switch does.
  const hint = EN['settings.solver.hint'];
  assert.ok(/faster/.test(hint) && /memory/.test(hint) && /previous behaviour/.test(hint), hint);
  assert.equal(hint.split(/[.!?](?:\s|$)/).filter(Boolean).length, 1, hint);

  for (const key of KEYS) {
    assert.equal($('label[for="' + INPUT_ID[key] + '"]').length, 1, `no label for ${key}`);
    assert.deepEqual([$('#' + ERROR_ID[key]).attr('role'), $('#' + ERROR_ID[key]).text()], ['alert', ''], 'a live error line, empty at first');
    for (const id of $('#' + INPUT_ID[key]).attr('aria-describedby').split(' ')) assert.equal($('#' + id).length, 1, `aria-describedby points nowhere: ${id}`);
  }
  const ids = $('[id]').toArray().map((node) => node.attribs.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
});

test('renders the stored values, and the defaults for anything that is not a valid value', () => {
  const env = makeEnv();
  const shown = (values) => { const $ = markup(env, values); return [$('#' + INPUT_ID[TOGGLE]).attr('checked') !== undefined, $('#' + INPUT_ID[POOL]).attr('value'), $('#' + INPUT_ID[IDLE]).attr('value')]; };
  assert.deepEqual(shown({ [TOGGLE]: true, [POOL]: 3, [IDLE]: 15 }), [true, '3', '15']);
  for (const junk of [{ [POOL]: 0, [IDLE]: 16 }, { [POOL]: 1.5, [IDLE]: '7' }, { [POOL]: null, [IDLE]: NaN }, { [TOGGLE]: 'yes' }, ...HOSTILE.map((evil) => ({ [TOGGLE]: evil, [POOL]: evil, [IDLE]: evil })), null, 'text', 5]) {
    assert.deepEqual(shown(junk), [false, '2', '10'], JSON.stringify(junk));
  }
});

test('hostile values and hostile translations add no element and no attribute', () => {
  const env = makeEnv();
  const strings = env.ctx.ScrollScapeI18nLocales['en-GB'];
  for (const key of [...solverKeys(strings), 'nav.systemHealth', 'systemHealth.section.services']) strings[key] = HOSTILE[0] + HOSTILE[3];
  const $ = markup(env, { [POOL]: HOSTILE[1] });
  assert.equal($('img, script, svg, iframe').length, 0, 'markup came out of data');
  assert.ok($('.settings-section-title').text().includes('<img src=x'), 'the hostile text is shown as text');
  for (const node of $('*').toArray()) {
    for (const name of Object.keys(node.attribs)) assert.doesNotMatch(name, /^on/i, `${node.name} has ${name}`);
  }
  assert.deepEqual(env.pwn, []);
});

test('the defaults, bounds and environment variable the card carries are the server\'s', () => {
  const fields = JSON.parse(JSON.stringify(makeEnv().ctx.SOLVER_CARD_FIELDS));
  assert.deepEqual(fields.map((f) => f.key), KEYS);
  for (const f of fields) {
    assert.equal(f.fallback, SETTINGS_DEFAULTS[f.key], f.key);
    if (f.kind === 'number') assert.deepEqual([f.min, f.max], [SETTINGS_BOUNDS[f.key].min, SETTINGS_BOUNDS[f.key].max], f.key);
    assert.match(f.inputId, /^[A-Za-z][A-Za-z0-9]*$/, 'an id that ends up in an attribute is a plain constant');
  }
  assert.deepEqual(fields.map((f) => [f.inputId, f.errorId]), KEYS.map((k) => [INPUT_ID[k], ERROR_ID[k]]));
  for (const strings of [EN, PT]) assert.ok(strings['settings.solver.envNote'].includes(ENV_NAMES.solverSessionsDisabled));
});

test('loads the stored values from GET /api/settings; the controls wait for the answer, and nothing else is shown', async () => {
  const server = serverStub({ [TOGGLE]: true, [POOL]: 3, [IDLE]: 7 });
  const gate = deferred();
  const card = mountCard(async (route, opts) => { await gate.promise; return server.impl(route, opts); });

  assert.deepEqual(card.modal.added.map(([position]) => position), ['afterend'], 'the card goes right after the first Integrations card');
  assert.equal(card.mounted.card.getAttribute('aria-busy'), 'true');
  for (const key of KEYS) assert.equal(card.el(key).disabled, true, `${key} should wait for the answer`);

  gate.resolve();
  assert.equal(await card.mounted.loaded, true);
  assert.deepEqual([card.el(TOGGLE).checked, card.el(POOL).value, card.el(IDLE).value], [true, '3', '7']);
  assert.equal(card.mounted.card.getAttribute('aria-busy'), 'false');
  for (const key of KEYS) assert.equal(card.el(key).disabled, false, key);
  assert.equal(card.loadError().textContent, '');
  assert.deepEqual(card.env.calls.map((c) => [c.route, c.opts]), [['/api/settings', undefined]]);
  assert.ok(!card.mounted.card.innerHTML.includes('hunter2'), 'another setting leaked into the card');
});

test('an unreadable answer or stored junk shows the defaults, says so when it could not read, and leaves the controls usable', async () => {
  const unreadable = [
    async () => { throw new Error('HTTP 500'); }, async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ ok: false, error: 'nope' }), async () => ({ ok: true }), async () => null,
  ];
  for (const answer of unreadable) {
    const card = mountCard(answer);
    assert.equal(await card.mounted.loaded, false);
    assert.equal(card.loadError().textContent, EN['settings.solver.loadFailed']);
    assert.deepEqual([card.el(TOGGLE).checked, card.el(POOL).value, card.el(IDLE).value], [false, '2', '10']);
    for (const key of KEYS) assert.equal(card.el(key).disabled, false);
    assert.equal(card.mounted.card.getAttribute('aria-busy'), 'false');
  }
  const junk = mountCard(async () => ({ ok: true, data: { [TOGGLE]: HOSTILE[0], [POOL]: 99, [IDLE]: HOSTILE[1] } }));
  assert.equal(await junk.mounted.loaded, true);
  assert.deepEqual([junk.el(TOGGLE).checked, junk.el(POOL).value, junk.el(IDLE).value], [false, '2', '10']);
});

test('a change saves only that key, as the right type, through POST /api/settings', async () => {
  const server = serverStub();
  let saved = 0;
  const card = mountCard(server.impl, { onSaved: () => { saved++; } });
  await card.mounted.loaded;
  assert.deepEqual([card.el(TOGGLE).listenerTypes(), card.el(POOL).listenerTypes()], [['change'], ['change', 'input']]);

  card.el(TOGGLE).checked = false;
  await card.el(TOGGLE).fire('change');
  card.el(POOL).value = '03';
  await card.el(POOL).fire('change');
  card.el(IDLE).value = '15';
  await card.el(IDLE).fire('change');

  assert.deepEqual(server.posts, [{ [TOGGLE]: false }, { [POOL]: 3 }, { [IDLE]: 15 }]);
  const writes = card.env.calls.filter((c) => c.opts);
  for (const call of writes) assert.deepEqual([call.route, call.opts.method], ['/api/settings', 'POST']);
  assert.equal(typeof JSON.parse(writes[1].opts.body)[POOL], 'number', 'a number is sent as a number, not as text');
  assert.equal(card.el(POOL).value, '3', 'the field is written back normalised');
  assert.equal(saved, 3, 'the Saved flash follows each confirmed save');
  assert.deepEqual(JSON.parse(JSON.stringify(card.mounted.controller.committed())), { [TOGGLE]: false, [POOL]: 3, [IDLE]: 15 });
  for (const body of server.posts) assert.ok(Object.keys(body).length === 1 && KEYS.includes(Object.keys(body)[0]));
});

test('saves run in order, and only the last one of a field touches the screen', async () => {
  const server = serverStub();
  const first = deferred();
  let writes = 0;
  const card = mountCard(async (route, opts) => {
    if (opts && ++writes === 1) await first.promise;
    return server.impl(route, opts);
  });
  await card.mounted.loaded;

  card.el(POOL).value = '3';
  const one = card.el(POOL).fire('change');
  card.el(POOL).value = '1';
  const two = card.el(POOL).fire('change');
  await settle();
  assert.equal(writes, 1, 'the second save waits for the first');
  first.resolve();
  await Promise.all([one, two]);
  assert.deepEqual(server.posts, [{ [POOL]: 3 }, { [POOL]: 1 }]);
  assert.equal(card.el(POOL).value, '1', 'the first answer must not reset what the user typed next');
  assert.equal(card.mounted.controller.committed()[POOL], 1);
});

const REFUSED = [
  [POOL, '4'], [POOL, '0'], [POOL, '1.5'], [POOL, ''], [POOL, '1e9'],
  [IDLE, '16'], [IDLE, '0'], [IDLE, '-3'], [IDLE, '2.5'], [IDLE, ''],
];

test('a refused number shows the server\'s own text next to the field, with the field state, and keeps the previous value', async () => {
  for (const [key, typed] of REFUSED) {
    let saved = 0;
    const card = mountCard(serverStub({ [POOL]: 3, [IDLE]: 12 }).impl, { onSaved: () => { saved++; } });
    await card.mounted.loaded;
    const before = card.el(key).value;
    card.el(key).value = typed;
    await card.el(key).fire('change');
    const { min, max } = SETTINGS_BOUNDS[key];
    assert.equal(card.err(key).textContent, `${key} must be a whole number from ${min} to ${max}.`, `${key} = ${JSON.stringify(typed)}`);
    assert.deepEqual([card.el(key).getAttribute('aria-invalid'), card.el(key).classList.contains('is-invalid')], ['true', true]);
    assert.equal(card.el(key).value, before, 'the field goes back to the last confirmed value');
    assert.equal(card.mounted.controller.committed()[key], Number(before));
    assert.equal(saved, 0, 'a refusal is not a save');
    for (const other of KEYS.filter((k) => k !== key)) assert.equal(card.err(other).textContent, '', 'the message belongs to one field');
  }
});

test('the refusal goes away when the user types again or a save works', async () => {
  const server = serverStub();
  const card = mountCard(server.impl);
  await card.mounted.loaded;
  const refuse = async () => { card.el(POOL).value = '9'; await card.el(POOL).fire('change'); assert.notEqual(card.err(POOL).textContent, ''); };
  const clean = () => assert.deepEqual([card.err(POOL).textContent, card.el(POOL).getAttribute('aria-invalid'), card.el(POOL).classList.contains('is-invalid')], ['', null, false]);

  await refuse();
  await card.el(POOL).fire('input');
  clean();
  await refuse();
  card.el(POOL).value = '3';
  await card.el(POOL).fire('change');
  clean();
  assert.equal(server.store[POOL], 3);
});

test('a refused switch goes back, an ok:false answer is a refusal, and a made-up failure is replaced by a translated sentence', async () => {
  const reading = { ok: true, data: { [TOGGLE]: true } };
  const refusing = mountCard(async (route, opts) => { if (opts) throw new Error('solverSessionsEnabled must be true or false.'); return reading; });
  await refusing.mounted.loaded;
  refusing.el(TOGGLE).checked = false;
  await refusing.el(TOGGLE).fire('change');
  assert.deepEqual([refusing.el(TOGGLE).checked, refusing.err(TOGGLE).textContent, refusing.el(TOGGLE).getAttribute('aria-invalid')], [true, 'solverSessionsEnabled must be true or false.', 'true']);

  const notOk = mountCard(async (route, opts) => (opts ? { ok: false, error: 'Not saved.' } : reading));
  await notOk.mounted.loaded;
  notOk.el(IDLE).value = '5';
  await notOk.el(IDLE).fire('change');
  assert.deepEqual([notOk.err(IDLE).textContent, notOk.el(IDLE).value], ['Not saved.', '10']);

  const madeUp = [new TypeError('Failed to fetch'), new Error('HTTP 502'), new Error('   '), Object.assign(new Error('x'), { name: 'TypeError' })];
  for (const [language, strings] of [[undefined, EN], ['pt', PT]]) {
    for (const failure of madeUp) {
      const card = mountCard(async (route, opts) => { if (opts) throw failure; return reading; }, { language });
      await card.mounted.loaded;
      card.el(POOL).value = '3';
      await card.el(POOL).fire('change');
      assert.equal(card.err(POOL).textContent, strings['settings.solver.saveFailed'], `${language} ${failure.message}`);
      assert.equal(card.el(POOL).value, '2');
    }
  }
});

test('a server message is shown as text only, and a runaway one is cut', async () => {
  for (const message of [HOSTILE[0] + ' & "quotes"', 'x'.repeat(5000)]) {
    const card = mountCard(async (route, opts) => { if (opts) throw new Error(message); return { ok: true, data: {} }; });
    await card.mounted.loaded;
    card.el(POOL).value = '3';
    await card.el(POOL).fire('change'); // the fake control throws if anything writes innerHTML on it
    assert.equal(card.err(POOL).textContent, message.slice(0, 300));
    assert.deepEqual(card.env.pwn, []);
  }
});

test('mounting is safe: no tab, twice, no card to follow, a broken document', () => {
  assert.equal(mountCard(serverStub().impl, { withTab: false }).mounted, null, 'no Integrations tab');
  const again = mountCard(serverStub().impl);
  assert.equal(again.env.ctx.mountSolverSettingsCard(again.modal), null, 'a card that is already there is not added twice');
  assert.equal(again.modal.added.length, 1);
  assert.deepEqual(mountCard(serverStub().impl, { withAnchor: false }).modal.added.map(([position]) => position), ['end'], 'with no card to follow it goes at the end');

  const env = makeEnv(serverStub().impl);
  env.ctx.document.createElement = () => { throw new Error('no DOM'); };
  assert.equal(env.ctx.mountSolverSettingsCard(fakeModal()), null, 'a failure must not reach showSettings()');
  assert.equal(env.ctx.mountSolverSettingsCard(null), null);
});

test('source guards: no handler, no timer or polling, one endpoint, every interpolation in the markup escaped or a constant id', () => {
  const source = fs.readFileSync(MODULE_FILE, 'utf8');
  assert.doesNotMatch(source, /\bon[a-z]{3,}\s*=\s*\\?["']|javascript:|setAttribute\(\s*['"`]on|\.on[a-z]+\s*=/i, 'an inline or assigned handler');
  assert.doesNotMatch(source, /setInterval|setTimeout|requestAnimationFrame|EventSource|WebSocket|\bfetch\s*\(/);
  assert.deepEqual([...new Set(source.match(/['"`]\/api\/[^'"`]*['"`]/g))], ["'/api/settings'"]);
  const builders = source.slice(source.indexOf('function solverCardToggleHtml'), source.indexOf('// ── Load / save logic'));
  const exprs = [...builders.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => m[1].trim());
  assert.ok(exprs.length > 10, 'the scan found suspiciously few interpolations');
  for (const expr of exprs) assert.match(expr, /^(?:escapeHtml\(|solverCardText\(|field\.(?:inputId|errorId|rangeId|labelKey)$|SOLVER_CARD_LOAD_ERROR_ID$|solverCard(?:Toggle|Number)Html\(|checked \?)/, expr);
});

test('the hook in showSettings() is one guarded line after the modal exists, and index.html loads the files once', () => {
  const modalSource = fs.readFileSync(path.join(MODULES_DIR, 'ui-settings-modal.js'), 'utf8');
  const hooks = modalSource.split(/\r?\n/).filter((line) => line.includes('mountSolverSettingsCard'));
  assert.equal(hooks.length, 1);
  assert.match(hooks[0], /^\s*if \(typeof mountSolverSettingsCard === 'function'\) mountSolverSettingsCard\(modal, saveSettings\);$/);
  const at = modalSource.indexOf(hooks[0]);
  assert.ok(modalSource.indexOf('modal.innerHTML = buildSettingsModalHtml()') < at && at < modalSource.indexOf('window.showSettings = showSettings'));
  const seen = [];
  const run = (globals) => vm.runInNewContext(hooks[0], { modal: 'M', saveSettings: 'S', ...globals });
  assert.doesNotThrow(() => run({}), 'the modal must still open when the file is missing');
  run({ mountSolverSettingsCard: (...args) => seen.push(args) });
  assert.deepEqual(seen, [['M', 'S']]);

  const page = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const count = (needle) => page.split(needle).length - 1;
  assert.equal(count('<link rel="stylesheet" href="./css-modules/solver-settings.css'), 1);
  assert.equal(count('<script src="./modules/ui-settings-solver.js'), 1);
  assert.match(page, /ui-settings-solver\.js\?v=\d+" defer><\/script>/);
  assert.ok(page.indexOf('ui-settings-solver.js') < page.indexOf('ui-settings-modal.js'));
});

test('locale parity: every key the card uses exists in both languages, is not empty, and is translated', () => {
  const used = [...new Set(fs.readFileSync(MODULE_FILE, 'utf8').match(/settings\.solver\.[A-Za-z]+/g))].sort();
  assert.ok(used.length >= 9, used.join(','));
  assert.deepEqual(solverKeys(EN), used, 'en-GB: a key is missing, or one is never used');
  assert.deepEqual(solverKeys(PT), used, 'pt-PT: a key is missing, or one is never used');
  for (const key of used) {
    for (const strings of [EN, PT]) {
      assert.ok(typeof strings[key] === 'string' && strings[key].trim().length > 0, `${key} is empty`);
      assert.doesNotMatch(strings[key], /[<>]/, `${key} holds markup`);
    }
    assert.notEqual(PT[key], EN[key], `${key} is not translated`);
    assert.deepEqual(PT[key].match(/\{\w+\}/g), EN[key].match(/\{\w+\}/g), `${key}: placeholders differ`);
  }
  for (const key of ['nav.systemHealth', 'systemHealth.section.services']) assert.ok(EN[key] && PT[key], `${key} (named by the status note) is missing`);
});

test('the stylesheet uses only defined variables and no colour of its own, and keeps the switch focusable', () => {
  const css = fs.readFileSync(CSS_FILE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const used = [...new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]))];
  assert.ok(used.length > 0);
  const defined = new Set();
  for (const rel of fs.readdirSync(PUBLIC_DIR, { recursive: true }).filter((name) => /\.(css|js|html)$/.test(name))) {
    const full = path.join(PUBLIC_DIR, rel);
    if (full === CSS_FILE) continue;
    for (const m of fs.readFileSync(full, 'utf8').matchAll(/(--[\w-]+)\s*:|setProperty\(\s*['"`](--[\w-]+)/g)) defined.add(m[1] || m[2]);
  }
  assert.deepEqual(used.filter((name) => !defined.has(name)), [], 'a variable that no stylesheet or theme defines');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\b(?:white|black|red|green|blue|gray|grey|orange|yellow|purple)\b/i, 'a fixed colour');
  assert.doesNotMatch(css, /\[data-theme|\[data-color-theme|prefers-color-scheme/, 'colours follow the theme variables, not a theme of their own');
  assert.match(fs.readFileSync(path.join(PUBLIC_DIR, 'css-modules', 'pagination.css'), 'utf8'), /\[data-theme="light"\]\s*\{[^}]*--text-primary:/, 'the text colour the error mixes in is redefined for the light theme');

  const rule = css.match(/\.solver-settings-card \.toggle-label input\[type="checkbox"\]\s*\{([^}]*)\}/);
  assert.ok(rule && /display:\s*block/.test(rule[1]) && /opacity:\s*0/.test(rule[1]), 'the checkbox must stay focusable (the shared rule uses display:none)');
  assert.match(css, /input\[type="checkbox"\]:focus-visible \+ \.toggle-slider/);
});
