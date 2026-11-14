'use strict';

// The rig shared by the three frontend-source-import-*.test.js files: the real public/ scripts of the "Import a
// source" card run in a vm sandbox, with a DOM stand-in built from the card's real markup (an id that markup and glue
// disagree on fails in a test). No network: the api() wrapper is a stub, so the requests the card makes are what is
// asserted, and the server's answers are the shapes of server/modules/source-import/service.js.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const cheerio = require('cheerio');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MODULES_DIR = path.join(PUBLIC_DIR, 'modules');
const HTML_FILE = path.join(MODULES_DIR, 'ui-settings-source-import-html.js');
const LOGIC_FILE = path.join(MODULES_DIR, 'ui-settings-source-import.js');
const SCRIPTS = ['i18n/locales/en-GB.js', 'i18n/locales/pt-PT.js', 'i18n/index.js', 'utils.js', 'ui-settings-source-import-html.js', 'ui-settings-source-import.js'];
const SHA = 'a'.repeat(64);
const HOSTILE = ['"><img src=x onerror=PWN(1)>', '<script>PWN(2)</script>', "' onfocus='PWN(3)", '</div><svg onload=PWN(4)>'];

const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { const d = {}; d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; }); return d; };
const plain = (value) => JSON.parse(JSON.stringify(value));
const lines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/);

// What preview() of the server answers for a source that can be installed; `over` changes fields.
const report = (over = {}) => ({
  ok: true, id: 'demo', idSource: 'given', detectedId: 'demo', sha256: SHA, bytes: 512, lines: 20,
  requires: [{ specifier: 'cheerio', kind: 'npm', line: 1 }, { specifier: '../../server/modules/network/fetch-utils', kind: 'relative', line: 2 }],
  dynamicRequires: 0, hosts: ['example.com'], risks: [], existing: null, replace: false, blockers: [], canInstall: true,
  ...over,
});

// An error the way api.js throws it: the message of the server's JSON, with the status and the body on it.
function httpError(status, data) {
  const err = new Error(data && data.error ? data.error : `HTTP ${status}`);
  err.status = status;
  err.data = data;
  return err;
}

// ── DOM stand-ins ───────────────────────────────────────────────────────────

function fakeElement(attribs = {}) {
  const attrs = new Map(Object.entries(attribs));
  const listeners = new Map();
  const children = [];
  const el = {
    value: String(attribs.value ?? ''),
    disabled: false,
    textContent: '',
    innerHTML: '',
    className: '',
    files: null,
    clicked: 0,
    valueWhenClicked: [],
    children,
    setAttribute: (name, value) => { attrs.set(name, String(value)); },
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
    appendChild: (child) => { children.push(child); },
    click() { el.clicked += 1; el.valueWhenClicked.push(el.value); },
    addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    async fire(type, event = {}) { for (const fn of listeners.get(type) || []) await fn({ type, ...event }); },
  };
  return el;
}

// The card: takes markup and makes a stand-in for every element with an id in it.
function fakeCard() {
  const children = new Map();
  let html = '';
  const card = fakeElement();
  Object.defineProperty(card, 'innerHTML', {
    configurable: true,
    get: () => html,
    set: (value) => {
      html = String(value);
      children.clear();
      cheerio.load(html, null, false)('[id]').each((_, node) => { children.set(node.attribs.id, fakeElement(node.attribs)); });
    },
  });
  card.querySelector = (selector) => children.get(selector.slice(1)) || null;
  return card;
}

// A click on the button with this data-si-action (and data-source-id), the way the delegated listener sees it.
function click(card, action, sourceId) {
  const attrs = { 'data-si-action': action, ...(sourceId ? { 'data-source-id': sourceId } : {}) };
  const target = { disabled: false, getAttribute: (name) => (name in attrs ? attrs[name] : null) };
  return card.fire('click', { target: { closest: (selector) => (selector === '[data-si-action]' ? target : null) } });
}

// A Settings modal whose Sources tab holds the Anime Sources card (the anchor).
function fakeModal({ withTab = true, withAnchor = true } = {}) {
  const added = [];
  const anchor = { insertAdjacentElement: (position, el) => { added.push([position, el]); } };
  const tab = {
    appendChild: (el) => { added.push(['end', el]); },
    querySelector: (selector) => {
      if (selector === '#animeSetProvidersList') return withAnchor ? { closest: (s) => (s === '.settings-section-card' ? anchor : null) } : null;
      return (added[0] || [])[1] || null;
    },
  };
  return { added, querySelector: (selector) => (selector === '#tab-sources' && withTab ? tab : null) };
}

// `confirmAnswer`: what the native confirm() answers; every question asked is kept in `confirms`.
function makeEnv({ apiImpl, installed = {}, confirmAnswer = true, scripts = SCRIPTS } = {}) {
  const calls = [];
  const toasts = [];
  const confirms = [];
  const pwn = [];
  const sandbox = {
    console,
    PWN: (n) => { pwn.push(n); },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    confirm: (question) => { confirms.push(question); return confirmAnswer; },
    state: { installedSources: installed, settings: {} },
    document: {
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: (tag) => (tag === 'div' ? fakeCard() : fakeElement()),
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const rel of scripts) vm.runInContext(fs.readFileSync(path.join(MODULES_DIR, rel), 'utf8'), sandbox, { filename: rel });
  // After the scripts: utils.js declares its own showToast, which would replace one given up front.
  sandbox.showToast = (...args) => { toasts.push(args); };
  if (apiImpl) sandbox.api = (route, opts) => { calls.push({ route, body: opts && opts.body ? JSON.parse(opts.body) : undefined, opts }); return apiImpl(route, opts); };
  return { ctx: sandbox, calls, toasts, confirms, pwn };
}

const markup = (html) => cheerio.load('<div>' + html + '</div>', null, false);

function locale(name) {
  const sandbox = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(MODULES_DIR, 'i18n', 'locales', name + '.js'), 'utf8'), sandbox);
  return plain(sandbox.window.ScrollScapeI18nLocales[name]);
}
const EN = locale('en-GB');
const PT = locale('pt-PT');
const importKeys = (strings) => Object.keys(strings).filter((k) => k.startsWith('settings.sourceImport.')).sort();

// A view for the controller that records what it was told and holds the form the person would have typed.
function fakeView(form = { code: 'source text', id: '' }) {
  const log = [];
  const view = {
    form: { ...form },
    log,
    read: () => ({ ...view.form }),
    busy: (on) => log.push(['busy', on]),
    showReport: (r) => log.push(['showReport', plain(r)]),
    clearReport: () => log.push(['clearReport']),
    invalidated: () => log.push(['invalidated']),
    error: (text, details) => log.push(['error', text, plain(details)]),
    tooLarge: (bytes, max) => log.push(['tooLarge', bytes, max]),
    success: (result) => log.push(['success', plain(result)]),
    uninstalled: () => log.push(['uninstalled']),
    resetForm: () => { view.form = { code: '', id: '' }; log.push(['resetForm']); },
    setId: (value) => { view.form.id = value; log.push(['setId', value]); },
    refreshImported: () => log.push(['refreshImported']),
    testing: (id, on) => log.push(['testing', id, on]),
    showTest: (id, result) => log.push(['showTest', id, plain(result)]),
    last: (name) => [...log].reverse().find((entry) => entry[0] === name),
    count: (name) => log.filter((entry) => entry[0] === name).length,
  };
  return view;
}

function controllerOver(apiImpl, { form, onChanged } = {}) {
  const env = makeEnv({ apiImpl });
  const view = fakeView(form);
  const controller = env.ctx.createSourceImportController({ api: env.ctx.api, view, onChanged });
  return { env, view, controller, calls: env.calls };
}

const okInstall = (over = {}) => ({ ok: true, installed: { id: 'demo', name: 'Demo' }, replaced: false, warnings: [], methods: [], optionalMethods: [], ...over });
const routeOf = (apiImpl) => async (route, opts) => apiImpl(route, opts && opts.body ? JSON.parse(opts.body) : undefined);

// The card mounted on a fake modal; `byId` reaches the elements of its real markup.
function mounted(apiImpl, { installed = {}, onChanged, confirmAnswer, ...modalOptions } = {}) {
  const env = makeEnv({ apiImpl, installed, confirmAnswer });
  const modal = fakeModal(modalOptions);
  const result = env.ctx.mountSourceImportCard(modal, onChanged);
  const byId = (id) => result.card.querySelector('#' + id);
  return { env, modal, result, byId, card: result && result.card };
}

module.exports = {
  PUBLIC_DIR, MODULES_DIR, HTML_FILE, LOGIC_FILE, SCRIPTS, SHA, HOSTILE, EN, PT,
  settle, deferred, plain, lines, report, httpError, fakeElement, fakeCard, click, fakeModal, makeEnv,
  markup, locale, importKeys, fakeView, controllerOver, okInstall, routeOf, mounted,
};
