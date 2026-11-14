'use strict';

// Settings > Advanced > Sources > "Disabled sources": public/modules/ui-disabled-sources-sync.js tells the server which
// sources the user turned off, so System Health stops probing them. As in frontend-solver-ui.test.js the real public/
// script runs in a vm sandbox (no browser, no network): the server is a stub that judges every save with the real
// strictSourceIdList(), the way the route does (a list with one thing it refuses, or over the cap, is ignored whole).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { strictSourceIdList } = require('../../server/modules/sources/disabled-sources');
const limits = require('../../server/config/limits');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const MODULES_DIR = path.join(PUBLIC_DIR, 'modules');
const MODULE_FILE = path.join(MODULES_DIR, 'ui-disabled-sources-sync.js');
const KEY = 'disabledSourceIds';
const HOSTILE = ['"><img src=x onerror=PWN(1)>', '<script>PWN(2)</script>', "' onfocus='PWN(3)", '../etc/passwd', 'a b', ' a', 'a\n', 'ü', 'a.b', 'a/b', ''];

const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { const d = {}; d.promise = new Promise((resolve) => { d.resolve = resolve; }); return d; };
const lines = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/);
const hookLines = (file, needle) => lines(file).filter((line) => line.includes(needle));

// Stores what it is sent. A save the route would refuse changes nothing, like the route. A read also returns an
// unrelated secret: the sync must never send it back.
function serverStub(initial) {
  const store = { [KEY]: initial, proxyPassword: 'hunter2-not-for-the-sync' };
  const posts = [];
  const reads = [];
  const impl = async (route, opts) => {
    if (!opts) {
      reads.push(route);
      // The narrow read gives the list and nothing else; the whole settings (secret included) must never be asked for.
      if (route === '/api/settings/disabled-sources') return { ok: true, data: { [KEY]: store[KEY] } };
      return { ok: true, data: { ...store } };
    }
    const body = JSON.parse(opts.body);
    posts.push(body);
    const accepted = strictSourceIdList(body[KEY]);
    if (accepted) store[KEY] = accepted;
    return { ok: true };
  };
  return { impl, store, posts, reads };
}

function makeEnv({ apiImpl, browser, withDbg = false } = {}) {
  const calls = [];
  const warnings = [];
  const dbgWarnings = [];
  const sandbox = {
    console: { warn: (...args) => { warnings.push(args); } },
    state: { settings: browser === undefined ? undefined : { [KEY]: browser, unrelated: 'kept' } },
  };
  if (withDbg) sandbox.dbg = { ERR_SETTINGS: 'SETTINGS', warn: (...args) => { dbgWarnings.push(args); } };
  if (apiImpl) sandbox.api = (route, opts) => { calls.push({ route, opts }); return apiImpl(route, opts); };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_FILE, 'utf8'), sandbox, { filename: MODULE_FILE });
  return { ctx: sandbox, calls, warnings, dbgWarnings, writes: () => calls.filter((c) => c.opts) };
}

const withServer = (initial, browser, extra) => {
  const server = serverStub(initial);
  return { server, env: makeEnv({ apiImpl: server.impl, browser, ...extra }) };
};

// ── pure helpers ──────────────────────────────────────────────────────────

test('cleaning keeps valid ids in order, drops duplicates, junk and anything that is not a list', () => {
  const { ctx } = makeEnv();
  const clean = (value) => plain(ctx.cleanDisabledSourceIds(value));
  assert.deepEqual(clean(['b', 'a', 'b', 'c-1', 'D_2', 'a']), ['b', 'a', 'c-1', 'D_2']);
  assert.deepEqual(clean(['a', 'A']), ['a', 'A'], 'ids are compared exactly');
  assert.deepEqual(clean(['__proto__', 'a', 'constructor', 'toString', 'prototype', 'hasOwnProperty']), ['a', 'toString', 'hasOwnProperty'], 'the three names the server refuses are not ids');
  assert.deepEqual(clean([...HOSTILE, null, undefined, 5, {}, ['a'], true, 'x'.repeat(81)]), []);
  assert.deepEqual(clean(['ok', ...HOSTILE, 'x'.repeat(80)]), ['ok', 'x'.repeat(80)]);
  for (const notAList of [undefined, null, 'a', 5, {}, { 0: 'a', length: 1 }, new Set(['a'])]) assert.deepEqual(clean(notAList), []);
  const input = ['a', 'a'];
  assert.notEqual(ctx.cleanDisabledSourceIds(input), input, 'a new list, never the caller\'s');
  assert.deepEqual(input, ['a', 'a'], 'the input is left alone');
});

test('an id is valid in the browser exactly when the server accepts it, and a cleaned list is always accepted', () => {
  const { ctx } = makeEnv();
  const clean = (value) => plain(ctx.cleanDisabledSourceIds(value));
  const probes = ['a', 'A-b_9', '9', '-', '_', 'x'.repeat(80), 'x'.repeat(81), ...HOSTILE, 'a\u0000', 'a ', 'é', '0x', 'a-', '\ta', '__proto__', 'constructor', 'prototype', 'Constructor', 'toString', 5, null, {}, ['a']];
  for (const id of probes) {
    assert.equal(clean([id]).length === 1, strictSourceIdList([id]) !== undefined, JSON.stringify(id));
    assert.notEqual(strictSourceIdList(clean([id, 'ok'])), undefined, JSON.stringify(id));
  }
  const many = Array.from({ length: limits.disabledSourceIdsMax + 50 }, (_, i) => 'id' + i);
  assert.equal(clean(many).length, limits.disabledSourceIdsMax, 'the cap is the server\'s');
  assert.equal(strictSourceIdList(many), undefined, 'the server refuses a longer list whole');
  assert.notEqual(strictSourceIdList(clean(many)), undefined);
  assert.deepEqual(clean(many), many.slice(0, limits.disabledSourceIdsMax), 'cut from the end');
});

test('the union keeps the browser\'s order, then adds what only the server has, with no duplicates and no junk', () => {
  const { ctx } = makeEnv();
  const union = (server, browser) => plain(ctx.unionDisabledSourceIds(server, browser));
  assert.deepEqual(union(['s1', 'b2'], ['b1', 'b2']), ['b1', 'b2', 's1']);
  assert.deepEqual(union(['b', 'a'], ['a', 'b']), ['a', 'b'], 'the browser\'s order wins for ids both have');
  assert.deepEqual(union([], ['a']), ['a']);
  assert.deepEqual(union(['a'], []), ['a'], 'start-up never takes anything away');
  assert.deepEqual(union(undefined, ['a', 'a']), ['a']);
  assert.deepEqual(union('junk', null), []);
  assert.deepEqual(union(['s', ...HOSTILE, 7], ['b', null, ...HOSTILE]), ['b', 's']);
  const cap = limits.disabledSourceIdsMax;
  const ids = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + i);
  const over = union(ids('s', cap), ids('b', 10));
  assert.deepEqual([over.length, over.slice(0, 10)], [cap, ids('b', 10)], 'over the cap the browser\'s own ids are the ones kept');
});

test('"needs a push" is true only when the browser has an id the server lacks', () => {
  const { ctx } = makeEnv();
  const needs = (server, browser) => ctx.disabledSourcesNeedPush(server, browser);
  assert.equal(needs([], ['a']), true);
  assert.equal(needs(undefined, ['a']), true, 'a server that never stored the key');
  assert.equal(needs(['b'], ['a', 'b']), true);
  assert.equal(needs(['a', 'b'], ['b', 'a']), false, 'same ids in another order');
  assert.equal(needs(['a', 'b', 'c'], ['a']), false, 'the server has more: nothing to add');
  assert.equal(needs(['a'], []), false, 'an empty browser must not clobber another device\'s list');
  assert.equal(needs(['a'], undefined), false);
  assert.equal(needs(['a'], HOSTILE), false, 'junk is not an id');
  assert.equal(needs('a', ['a']), true, 'a server value that is not a list counts as empty');
  const cap = limits.disabledSourceIdsMax;
  const ids = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + i);
  assert.equal(needs(ids('s', cap - 1), ['b']), true, 'the union just fits');
  assert.equal(needs(ids('s', cap), ['b']), false, 'a union over the cap would have to drop ids from the server: start-up only adds');
  assert.equal(needs(ids('s', cap - 1), ['b', 'c']), false);
});

// ── toggling: pushDisabledSourcesToServer ─────────────────────────────────

test('a push posts exactly one key, the cleaned list, through POST /api/settings', async () => {
  const { server, env } = withServer([], []);
  const list = ['b', 'a', 'b', ...HOSTILE, null];
  assert.equal(await env.ctx.pushDisabledSourcesToServer(list), true);
  assert.deepEqual(server.posts, [{ [KEY]: ['b', 'a'] }]);
  assert.deepEqual(Object.keys(server.posts[0]), [KEY]);
  assert.deepEqual(env.writes().map((c) => [c.route, c.opts.method]), [['/api/settings', 'POST']]);
  assert.equal(env.calls.length, 1, 'a push does not read first');
  assert.deepEqual(plain(server.store[KEY]), ['b', 'a']);
  assert.ok(!JSON.stringify(env.calls).includes('hunter2'));
});

test('a list longer than the server keeps is cut, not sent whole to be refused whole', async () => {
  const { server, env } = withServer([], []);
  const many = Array.from({ length: limits.disabledSourceIdsMax + 100 }, (_, i) => 'id' + i);
  assert.equal(await env.ctx.pushDisabledSourcesToServer(many), true);
  assert.equal(server.posts[0][KEY].length, limits.disabledSourceIdsMax);
  assert.equal(server.store[KEY].length, limits.disabledSourceIdsMax, 'the stub (the route\'s own rule) accepted it');
});

test('an empty list is posted too: turning the last source back on clears the server\'s list', async () => {
  const { server, env } = withServer(['a'], ['a']);
  assert.equal(await env.ctx.pushDisabledSourcesToServer([]), true);
  assert.deepEqual(server.posts, [{ [KEY]: [] }]);
  assert.deepEqual(plain(server.store[KEY]), []);
});

test('something that is not a list is not posted: it would clear the server\'s list by accident', async () => {
  const { server, env } = withServer(['a'], ['a']);
  for (const junk of [undefined, null, 'a', 5, {}]) assert.equal(await env.ctx.pushDisabledSourcesToServer(junk), false);
  assert.deepEqual(env.calls, []);
  assert.deepEqual(plain(server.store[KEY]), ['a']);
});

test('the list is copied when the push is called, not when it is sent', async () => {
  const { server, env } = withServer([], []);
  const list = ['a'];
  const done = env.ctx.pushDisabledSourcesToServer(list);
  list.push('b');
  await done;
  assert.deepEqual(server.posts, [{ [KEY]: ['a'] }]);
});

test('two quick pushes are sent one after the other, and the last one wins', async () => {
  const server = serverStub([]);
  const gate = deferred();
  let writes = 0;
  const env = makeEnv({ apiImpl: async (route, opts) => { if (opts && ++writes === 1) await gate.promise; return server.impl(route, opts); } });
  const one = env.ctx.pushDisabledSourcesToServer(['a']);
  const two = env.ctx.pushDisabledSourcesToServer(['a', 'b']);
  const three = env.ctx.pushDisabledSourcesToServer(['b']);
  await settle();
  assert.equal(env.calls.length, 1, 'the second push waits for the first');
  gate.resolve();
  assert.deepEqual(await Promise.all([one, two, three]), [true, true, true]);
  assert.deepEqual(server.posts, [{ [KEY]: ['a'] }, { [KEY]: ['a', 'b'] }, { [KEY]: ['b'] }]);
  assert.deepEqual(plain(server.store[KEY]), ['b']);
});

test('a push that fails never throws, says so once, and does not block the pushes behind it', async () => {
  const failures = [new Error('HTTP 500'), new TypeError('Failed to fetch'), 'text', null];
  let n = 0;
  const server = serverStub([]);
  const env = makeEnv({ apiImpl: (route, opts) => { if (opts && n < failures.length) throw failures[n++]; return server.impl(route, opts); } });
  for (const failure of failures) assert.equal(await env.ctx.pushDisabledSourcesToServer(['a']), false, String(failure));
  assert.equal(env.warnings.length, 1, 'one warning for the whole session');
  assert.match(String(env.warnings[0][0]), /sources/i);
  assert.equal(await env.ctx.pushDisabledSourcesToServer(['b']), true, 'the queue is not stuck');
  assert.deepEqual(server.posts, [{ [KEY]: ['b'] }]);
});

test('an ok:false answer, a rejected promise and a missing api() are failures, not crashes', async () => {
  const notOk = makeEnv({ apiImpl: async () => ({ ok: false, error: 'nope' }) });
  assert.equal(await notOk.ctx.pushDisabledSourcesToServer(['a']), false);
  const rejects = makeEnv({ apiImpl: () => Promise.reject(new Error('HTTP 502')) });
  assert.equal(await rejects.ctx.pushDisabledSourcesToServer(['a']), false);
  const absent = makeEnv();
  assert.equal(await absent.ctx.pushDisabledSourcesToServer(['a']), false);
  assert.equal(await absent.ctx.syncDisabledSourcesAtStart(), false);
  assert.equal(notOk.warnings.length + rejects.warnings.length + absent.warnings.length, 3);
});

test('the warning goes through the debug panel when there is one, and is still only one', async () => {
  const env = makeEnv({ apiImpl: async () => { throw new Error('HTTP 500'); }, withDbg: true });
  await env.ctx.pushDisabledSourcesToServer(['a']);
  await env.ctx.pushDisabledSourcesToServer(['a']);
  assert.equal(env.dbgWarnings.length, 1);
  assert.equal(env.dbgWarnings[0][0], 'SETTINGS');
  assert.equal(env.warnings.length, 0, 'the debug panel already forwards to the console');
});

// ── start-up: syncDisabledSourcesAtStart ──────────────────────────────────

test('start-up pushes the union when the browser has ids the server lacks, after reading the server', async () => {
  const { server, env } = withServer(['s1', 'shared'], ['b1', 'shared', 'b2']);
  assert.equal(await env.ctx.syncDisabledSourcesAtStart(), true);
  assert.deepEqual(env.calls.map((c) => [c.route, c.opts && c.opts.method]), [['/api/settings/disabled-sources', undefined], ['/api/settings', 'POST']]);
  assert.deepEqual(server.reads, ['/api/settings/disabled-sources'], 'the start-up never reads the whole settings (credentials)');
  assert.deepEqual(server.posts, [{ [KEY]: ['b1', 'shared', 'b2', 's1'] }]);
  assert.deepEqual(Object.keys(server.posts[0]), [KEY]);
});

test('start-up pushes the whole browser list to a server that has never stored one', async () => {
  for (const initial of [undefined, null, 'junk', {}]) {
    const { server, env } = withServer(initial, ['a', 'b']);
    assert.equal(await env.ctx.syncDisabledSourcesAtStart(), true, String(initial));
    assert.deepEqual(server.posts, [{ [KEY]: ['a', 'b'] }]);
  }
});

test('start-up pushes nothing for an empty browser list, a missing one, or when the server already has everything', async () => {
  for (const [serverList, browser] of [[['a'], []], [['a'], undefined], [['a'], 'junk'], [['a', 'b'], ['b']], [['a', 'b'], ['b', 'a']], [[], []]]) {
    const { server, env } = withServer(serverList, browser);
    assert.equal(await env.ctx.syncDisabledSourcesAtStart(), false, JSON.stringify([serverList, browser]));
    assert.deepEqual(server.posts, []);
    assert.equal(env.calls.length, 1, 'only the read');
  }
  const noSettings = withServer(['a'], undefined);
  noSettings.env.ctx.state.settings = undefined;
  assert.equal(await noSettings.env.ctx.syncDisabledSourcesAtStart(), false);
});

test('start-up sends nothing when the union would not fit under the cap, so it never takes an id off the server', async () => {
  const full = Array.from({ length: limits.disabledSourceIdsMax }, (_, i) => 's' + i);
  const { server, env } = withServer(full, ['b']);
  assert.equal(await env.ctx.syncDisabledSourcesAtStart(), false);
  assert.deepEqual(server.posts, []);
  assert.equal(server.store[KEY].length, limits.disabledSourceIdsMax);
});

test('start-up with an unreadable answer does nothing at all, quietly', async () => {
  const unreadable = [
    async () => { throw new Error('HTTP 500'); }, async () => { throw new TypeError('Failed to fetch'); },
    async () => ({ ok: false, error: 'nope' }), async () => ({ ok: true }), async () => ({ ok: true, data: 'text' }), async () => null,
  ];
  for (const answer of unreadable) {
    const env = makeEnv({ apiImpl: answer, browser: ['a'] });
    assert.equal(await env.ctx.syncDisabledSourcesAtStart(), false);
    assert.equal(env.writes().length, 0, 'not knowing the server\'s list is no reason to replace it');
    assert.equal(env.warnings.length, 1);
  }
});

test('start-up never changes the browser\'s settings', async () => {
  const { env } = withServer(['s1', 'b1'], ['b1', 'b2']);
  const list = env.ctx.state.settings[KEY];
  const before = JSON.stringify(env.ctx.state);
  await env.ctx.syncDisabledSourcesAtStart();
  assert.equal(JSON.stringify(env.ctx.state), before);
  assert.equal(env.ctx.state.settings[KEY], list, 'the same array object, untouched');
});

test('a toggle made while the start-up read is in flight is sent after it, so the start-up cannot undo it', async () => {
  const server = serverStub(['old']);
  const gate = deferred();
  let reads = 0;
  const env = makeEnv({ apiImpl: async (route, opts) => { if (!opts && ++reads === 1) await gate.promise; return server.impl(route, opts); }, browser: ['b'] });
  const start = env.ctx.syncDisabledSourcesAtStart();
  env.ctx.state.settings[KEY] = ['b', 'c'];
  const toggle = env.ctx.pushDisabledSourcesToServer(['b', 'c']);
  await settle();
  assert.equal(env.calls.length, 1, 'the toggle waits for the read');
  gate.resolve();
  await Promise.all([start, toggle]);
  assert.deepEqual(server.posts, [{ [KEY]: ['b', 'c', 'old'] }, { [KEY]: ['b', 'c'] }]);
  assert.deepEqual(plain(server.store[KEY]), ['b', 'c'], 'toggling replaces the server\'s list with this browser\'s');
});

// ── wiring ────────────────────────────────────────────────────────────────

test('the toggle hook is one guarded line after saveSettings(), and the modal still works when the file is missing', () => {
  const file = path.join(MODULES_DIR, 'ui-settings-modal.js');
  const hooks = hookLines(file, 'pushDisabledSourcesToServer');
  assert.equal(hooks.length, 1);
  assert.match(hooks[0], /^\s*if \(typeof pushDisabledSourcesToServer === 'function'\) pushDisabledSourcesToServer\(state\.settings\.disabledSourceIds\);$/);
  const source = fs.readFileSync(file, 'utf8');
  const handler = source.slice(source.indexOf("querySelectorAll('.disabledSourceToggle')"));
  const at = handler.indexOf(hooks[0].trim());
  assert.ok(handler.indexOf('state.settings.disabledSourceIds = [...list];') < handler.indexOf('saveSettings();') && handler.indexOf('saveSettings();') < at, 'after the list is stored and saved');
  assert.ok(at < handler.indexOf('renderSourceSelect();'), 'before the pickers are redrawn, inside the same handler');

  const seen = [];
  const run = (globals) => vm.runInNewContext(hooks[0], { state: { settings: { [KEY]: ['a'] } }, ...globals });
  assert.doesNotThrow(() => run({}));
  run({ pushDisabledSourcesToServer: (...args) => seen.push(args) });
  assert.deepEqual(plain(seen), [[['a']]]);
});

test('the start-up hook is one guarded, un-awaited line right after the settings are loaded', () => {
  const file = path.join(MODULES_DIR, 'ui-initialization.js');
  const hooks = hookLines(file, 'syncDisabledSourcesAtStart');
  assert.equal(hooks.length, 1);
  assert.match(hooks[0], /^\s*if \(typeof syncDisabledSourcesAtStart === 'function'\) syncDisabledSourcesAtStart\(\);$/);
  const source = fs.readFileSync(file, 'utf8');
  const at = source.indexOf(hooks[0].trim());
  assert.ok(source.indexOf('await checkAuthGate();') < source.indexOf('loadSettings();') && source.indexOf('loadSettings();') < at, 'after the gate and the load');
  assert.ok(at < source.indexOf('await refreshState();'), 'before the long fan-out of source calls');
  let calls = 0;
  assert.doesNotThrow(() => vm.runInNewContext(hooks[0], {}));
  vm.runInNewContext(hooks[0], { syncDisabledSourcesAtStart: () => { calls++; } });
  assert.equal(calls, 1);
});

test('index.html loads the file once, after the settings scripts and before the page starts', () => {
  const page = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.equal(page.split('<script src="./modules/ui-disabled-sources-sync.js').length - 1, 1);
  assert.match(page, /<script src="\.\/modules\/ui-disabled-sources-sync\.js\?v=\d+" defer><\/script>/);
  const at = page.indexOf('ui-disabled-sources-sync.js');
  for (const before of ['api.js', 'utils.js', 'ui-settings.js', 'ui-settings-modal.js']) assert.ok(page.indexOf('/modules/' + before) < at, before);
  assert.ok(at < page.indexOf('ui-initialization.js'));
});

test('the Disabled sources text comes from an i18n key, in both languages, and says System Health and the image-quality check skip a source that is turned off', () => {
  const html = fs.readFileSync(path.join(MODULES_DIR, 'ui-settings-cards-sources.js'), 'utf8');
  const block = html.slice(html.indexOf('<label>Disabled sources</label>'), html.indexOf('id="disabledSourcesList"'));
  assert.ok(block.length > 50 && block.length < 600, 'the block was found');
  assert.match(block, /data-i18n="settings\.disabledSourcesDesc">\$\{t\('settings\.disabledSourcesDesc'\)\}</, 'the paragraph is the key, not literal text');
  assert.doesNotMatch(block, /System Health/, 'no English sentence left in the markup');

  const text = {};
  for (const name of ['en-GB', 'pt-PT']) {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MODULES_DIR, 'i18n', 'locales', name + '.js'), 'utf8'), sandbox);
    text[name] = sandbox.window.ScrollScapeI18nLocales[name]['settings.disabledSourcesDesc'];
    assert.equal(typeof text[name], 'string', name);
  }
  assert.match(text['en-GB'], /Turn a source off without uninstalling it/, 'the old text is still there');
  assert.match(text['en-GB'], /System Health/);
  assert.match(text['en-GB'], /image-quality/);
  assert.match(text['en-GB'], /skip a source that is turned off/);
  assert.match(text['en-GB'], /timing out/);
  assert.match(text['pt-PT'], /Saúde do Sistema/);
  assert.match(text['pt-PT'], /qualidade das imagens/);
  assert.notEqual(text['pt-PT'], text['en-GB']);
});

test('source guards: two endpoints through api() (the list to read, the settings to save), no fetch, no storage, no timers, no DOM, no write to the settings', () => {
  const source = fs.readFileSync(MODULE_FILE, 'utf8');
  assert.deepEqual([...new Set(source.match(/['"`]\/api\/[^'"`]*['"`]/g))], ["'/api/settings'", "'/api/settings/disabled-sources'"]);
  assert.doesNotMatch(source, /\bfetch\s*\(|localStorage|sessionStorage|setInterval|setTimeout|innerHTML|document\.|EventSource|WebSocket/);
  assert.doesNotMatch(source, /state(?:\??\.settings)?\??\.\w+\s*=[^=]|\.disabledSourceIds\s*=[^=]/, 'the sync reads the browser\'s list and never writes it');
  assert.match(source, /toggling replaces the server list with this browser's list/i);
  assert.ok(source.split('\n').length <= 450, 'file size');
});
