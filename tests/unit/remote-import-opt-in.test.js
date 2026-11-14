'use strict';

// Using the source import tool (and the source catalog and extension engine that hang from it) from another device. They install code, so they answer
// only the computer that runs the app, even with an Access Password set. An app that runs in a container can never be "this computer" for the browser of
// another one, so there is an opt-in: the saved setting "Allow installing sources from other devices" (Settings > Security) or the environment variable
// SCROLLSCAPE_ALLOW_REMOTE_IMPORT. With either on, a request from another device is answered when it carries a valid login. What matters: it is off
// unless it plainly says on, a login is required (the gate marks the session, the route does not guess), a request a browser marks as cross-site is
// refused even then, the "admin local only" mode switches it off again, and every route of the tool is behind the same check.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createAuthGate, SESSION_COOKIE } = require('../../server/middleware/auth-gate');
const {
  requireThisComputer,
  isRemoteImportAllowed,
  configureRemoteImportSetting,
  ADMIN_LOCAL_ONLY_MESSAGE,
  REMOTE_IMPORT_MESSAGE,
} = require('../../server/middleware/local-only');

const NAMES = ['SCROLLSCAPE_ALLOW_REMOTE_IMPORT', 'SCROLLSCAPE_ADMIN_LOCAL_ONLY'];
const saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
test.before(() => { NAMES.forEach((n) => { delete process.env[n]; }); configureRemoteImportSetting(async () => false); });
test.after(() => {
  NAMES.forEach((n) => { if (saved[n] === undefined) delete process.env[n]; else process.env[n] = saved[n]; });
  configureRemoteImportSetting(async () => false);
});

// Runs fn with the variables set (and the rest of the two cleared) until it has finished, then puts back what was there.
async function withEnv(values, fn) {
  const before = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  NAMES.forEach((n) => { delete process.env[n]; });
  Object.assign(process.env, values);
  try { return await fn(); } finally { NAMES.forEach((n) => { if (before[n] === undefined) delete process.env[n]; else process.env[n] = before[n]; }); }
}

// Runs fn with the saved setting reading as `reader` says, and always leaves it off afterwards.
async function withSetting(reader, fn) {
  configureRemoteImportSetting(reader);
  try { return await fn(); } finally { configureRemoteImportSetting(async () => false); }
}

const LAN = { remoteAddress: '192.168.1.20' };
const request = ({ url = '/api/sources/import/preview', socket = LAN, host = '192.168.1.97:4000', headers = {}, session } = {}) => {
  const req = { method: 'POST', originalUrl: url, socket, headers: { host, ...headers } };
  if (session !== undefined) req.scrollscapeSession = session;
  return req;
};
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } });
const run = async (req) => { const res = response(); let passed = false; await requireThisComputer(req, res, () => { passed = true; }); return { passed, res }; };
const ON = async () => true;

test('off by default: another device is refused even with a login, and this computer still passes without waiting', async () => {
  assert.equal(isRemoteImportAllowed({}), false);
  const refused = await run(request({ session: true }));
  assert.equal(refused.passed, false);
  assert.equal(refused.res.statusCode, 403);
  assert.equal(refused.res.body.code, 'LOCAL_ONLY');
  assert.equal(refused.res.body.error, REMOTE_IMPORT_MESSAGE);
  assert.match(refused.res.body.error, /Allow installing sources from other devices/);
  assert.match(refused.res.body.error, /SCROLLSCAPE_ALLOW_REMOTE_IMPORT=1/);
  // this computer: next() is called before the function returns, as it always was
  let passedAtOnce = false;
  requireThisComputer(request({ socket: { remoteAddress: '127.0.0.1' }, host: 'localhost:4000' }), response(), () => { passedAtOnce = true; });
  assert.equal(passedAtOnce, true);
});

test('environment on: a request from another device that carries a login passes; one without a login does not', async () => {
  await withEnv({ SCROLLSCAPE_ALLOW_REMOTE_IMPORT: '1' }, async () => {
    assert.equal((await run(request({ session: true }))).passed, true);
    for (const session of [undefined, false, 'true', 1, null]) {
      const out = await run(request({ session }));
      assert.equal(out.passed, false, String(session));
      assert.equal(out.res.statusCode, 403);
    }
  });
});

test('only a value that plainly says on turns the environment switch on; anything else, a misspelling included, leaves the restriction in place', async () => {
  for (const on of ['1', 'true', 'TRUE', ' yes ', 'on', 'Y']) assert.equal(isRemoteImportAllowed({ SCROLLSCAPE_ALLOW_REMOTE_IMPORT: on }), true, on);
  for (const off of ['', '0', 'false', 'no', 'off', 'n', 'maybe', 'enable', 'enabled', '2', 'tru', 'ligado']) {
    assert.equal(isRemoteImportAllowed({ SCROLLSCAPE_ALLOW_REMOTE_IMPORT: off }), false, off);
    await withEnv({ SCROLLSCAPE_ALLOW_REMOTE_IMPORT: off }, async () => assert.equal((await run(request({ session: true }))).passed, false, off));
  }
});

test('the saved setting works the same way: on and a login passes; a login with it off, or it on with no login, does not', async () => {
  await withSetting(ON, async () => {
    assert.equal((await run(request({ session: true }))).passed, true);
    for (const session of [undefined, false, 'true']) assert.equal((await run(request({ session }))).passed, false, `no login (${session})`);
  });
  await withSetting(async () => false, async () => assert.equal((await run(request({ session: true }))).passed, false));
});

test('only a real true counts as the saved setting, and a setting that cannot be read means off', async () => {
  for (const value of [undefined, null, false, 'true', 1, 'yes', {}, []]) {
    await withSetting(async () => value, async () => assert.equal((await run(request({ session: true }))).passed, false, String(value)));
  }
  await withSetting(async () => { throw new Error('store not ready'); }, async () => {
    const out = await run(request({ session: true }));
    assert.equal(out.passed, false);
    assert.equal(out.res.statusCode, 403);
  });
});

test('a request a browser marks as cross-site (or whose Origin is not this server) is refused even with a switch on and a login', async () => {
  const hostile = [{ 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { origin: 'https://evil.example' }, { origin: 'null' }];
  await withEnv({ SCROLLSCAPE_ALLOW_REMOTE_IMPORT: '1' }, async () => {
    for (const headers of hostile) assert.equal((await run(request({ session: true, headers }))).passed, false, JSON.stringify(headers));
    assert.equal((await run(request({ session: true, headers: { 'sec-fetch-site': 'same-origin', origin: 'http://192.168.1.97:4000' } }))).passed, true, 'the app\'s own page is the one that is let through');
  });
  await withSetting(ON, async () => {
    for (const headers of hostile) assert.equal((await run(request({ session: true, headers }))).passed, false, `setting: ${JSON.stringify(headers)}`);
  });
});

test('"admin local only" wins over both: the remote way is off again, and the refusal says it cannot be opened', async () => {
  await withSetting(ON, async () => {
    await withEnv({ SCROLLSCAPE_ALLOW_REMOTE_IMPORT: '1', SCROLLSCAPE_ADMIN_LOCAL_ONLY: '1' }, async () => {
      assert.equal(isRemoteImportAllowed(), false);
      const out = await run(request({ session: true }));
      assert.equal(out.passed, false);
      assert.equal(out.res.body.error, ADMIN_LOCAL_ONLY_MESSAGE);
      assert.doesNotMatch(out.res.body.error, /ALLOW_REMOTE_IMPORT|Allow installing/);
    });
  });
});

// ── through the auth gate ─────────────────────────────────────────────────

const noPassword = { isGateEnabled: async () => false, isValidSession: () => false };
const withPassword = (valid) => ({ isGateEnabled: async () => true, isValidSession: (token) => token === valid });

async function throughGate(authService, req) {
  const res = response();
  let gatePassed = false;
  await createAuthGate(authService)(req, res, () => { gatePassed = true; });
  if (!gatePassed) return { gatePassed, routePassed: false, res };
  let routePassed = false;
  await requireThisComputer(req, res, () => { routePassed = true; });
  return { gatePassed, routePassed, res };
}

test('through the gate: with the switch on, a logged-in remote request reaches the route; without a login the gate answers 401 first', async () => {
  await withSetting(ON, async () => {
    const good = await throughGate(withPassword('abc'), request({ headers: { cookie: `${SESSION_COOKIE}=abc` } }));
    assert.deepEqual({ gate: good.gatePassed, route: good.routePassed }, { gate: true, route: true });
    const wrong = await throughGate(withPassword('abc'), request({ headers: { cookie: `${SESSION_COOKIE}=wrong` } }));
    assert.equal(wrong.gatePassed, false);
    assert.equal(wrong.res.statusCode, 401);
    const none = await throughGate(withPassword('abc'), request());
    assert.equal(none.res.statusCode, 401);
  });
});

test('through the gate: with no Access Password a switch does nothing, because the gate refuses a remote request to these routes first', async () => {
  const urls = ['/api/sources/import/preview', '/api/sources/import/install', '/api/sources/catalog/list', '/api/sources/engine/prepare'];
  await withSetting(ON, async () => withEnv({ SCROLLSCAPE_ALLOW_REMOTE_IMPORT: '1' }, async () => {
    for (const url of urls) {
      const out = await throughGate(noPassword, request({ url, session: true }));
      assert.equal(out.gatePassed, false, url);
      assert.equal(out.res.statusCode, 403, url);
      assert.equal(out.res.body.code, 'LOCAL_ONLY', url);
    }
  }));
});

test('through the gate: with the switch off a logged-in remote request gets past the gate and is refused at the route, with the way to open it', async () => {
  const out = await throughGate(withPassword('abc'), request({ headers: { cookie: `${SESSION_COOKIE}=abc` } }));
  assert.deepEqual({ gate: out.gatePassed, route: out.routePassed }, { gate: true, route: false });
  assert.equal(out.res.body.error, REMOTE_IMPORT_MESSAGE);
});

test('the gate says a login was presented only after the session was checked, and never for a request without one', async () => {
  const good = request({ headers: { cookie: `${SESSION_COOKIE}=abc` } });
  await throughGate(withPassword('abc'), good);
  assert.equal(good.scrollscapeSession, true);
  const bad = request({ headers: { cookie: `${SESSION_COOKIE}=nope` } });
  await throughGate(withPassword('abc'), bad);
  assert.equal(bad.scrollscapeSession, undefined);
  const open = request({ url: '/api/state', socket: { remoteAddress: '127.0.0.1' }, host: 'localhost:4000' });
  await throughGate(noPassword, open);
  assert.equal(open.scrollscapeSession, undefined, 'with no password there is no login to have presented');
  // a header of the same name sent by a client is not the flag: the flag is a property of the request object, set by the gate alone
  await withSetting(ON, async () => {
    const forged = request({ headers: { scrollscapeSession: 'true', 'x-scrollscape-session': 'true' } });
    assert.equal((await run(forged)).passed, false);
  });
});

// ── every route of the tool is behind the same check, and the switch is wired ──

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ROUTE_FILES = ['source-import.js', 'anime-source-import.js', 'source-catalog.js', 'source-engine.js'].map((f) => read('server', 'routes', f));
const TOOL_PATHS = ['/api/sources/import/preview', '/api/sources/import/install', '/api/sources/import/link', '/api/sources/import/generated', '/api/sources/import/test',
  '/api/anime/sources/import/preview', '/api/anime/sources/import/install', '/api/anime/sources/import/test', '/api/anime/sources/uninstall',
  '/api/sources/catalog/list', '/api/sources/engine/prepare'];

test('every route of the import tool, the catalog and the engine is behind requireThisComputer and on the guard list, so one switch governs them all', () => {
  const text = ROUTE_FILES.join('\n');
  const { PRIVILEGED_ROUTES } = require('../../server/middleware/local-only');
  for (const route of TOOL_PATHS) {
    assert.ok(new RegExp(`router\\.post\\('${route.replace(/\//g, '\\/')}', requireThisComputer`).test(text), `${route} is not behind requireThisComputer`);
    assert.ok(PRIVILEGED_ROUTES.some((r) => r.method === 'POST' && r.path === route), `${route} is not on the guard list`);
  }
});

test('the switch is a saved setting that the server reads, that the Security tab shows and saves as a real true/false, and that both languages explain', () => {
  assert.match(read('server.js'), /configureRemoteImportSetting\(async \(\) => \{[\s\S]*allowRemoteImport === true/);
  assert.match(read('server', 'modules', 'common', 'settings-fields.js'), /\['allowRemoteImport', 'boolean'\]/);
  assert.match(read('public', 'modules', 'ui-settings-cards-system.js'), /id="allowRemoteImportToggle"/);
  assert.match(read('public', 'modules', 'ui-settings-modal.js'), /allowRemoteImport: e\.target\.checked === true/);
  for (const file of ['en-GB.js', 'pt-PT.js']) assert.match(read('public', 'modules', 'i18n', 'locales', file), /"settings\.sourceImport\.localOnly": "[^"]*Allow installing sources from other devices/, file);
  assert.match(read('README.md'), /SCROLLSCAPE_ALLOW_REMOTE_IMPORT/);
  assert.match(read('README.md'), /Allow installing sources from other devices/);
});
