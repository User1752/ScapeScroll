'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const express = require('express');
const { createAuthGate, EXEMPT_PATHS } = require('../../server/middleware/auth-gate');
const {
  PRIVILEGED_ROUTES,
  LOCAL_ONLY_MESSAGE,
  ADMIN_LOCAL_ONLY_MESSAGE,
  isAdminLocalOnly,
  isPrivilegedRoute,
  isLocalRequest,
} = require('../../server/middleware/local-only');

const { before, after } = test;

// The gate reads SCROLLSCAPE_ADMIN_LOCAL_ONLY from the real environment on every
// request, and the README tells people to export it for the Tailscale setup. A
// developer who did would see the "no password / password set" tests below fail
// for a reason that has nothing to do with the code, so the whole file starts
// from a clean variable and puts back whatever it found. Tests that need the
// mode on set it themselves and delete it again.
const ENV_NAME = 'SCROLLSCAPE_ADMIN_LOCAL_ONLY';
let originalEnv;

before(() => {
  originalEnv = process.env[ENV_NAME];
  delete process.env[ENV_NAME];
});

after(() => {
  if (originalEnv === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = originalEnv;
});

// Runs fn with the admin-local mode on and always leaves the variable unset
// (the state before() established) afterwards.
async function withAdminLocalOnly(fn) {
  process.env[ENV_NAME] = '1';
  try {
    return await fn();
  } finally {
    delete process.env[ENV_NAME];
  }
}

const BS = String.fromCharCode(92); // a backslash, without relying on escapes surviving a file transfer

const LOCAL = { remoteAddress: '127.0.0.1' };
const LAN = { remoteAddress: '192.168.1.20' };

function request({ method = 'GET', url = '/api/state', socket = LOCAL, host = 'localhost:4000', cookie } = {}) {
  return { method, originalUrl: url, socket, headers: { host, ...(cookie ? { cookie } : {}) } };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// Runs one request through the gate and reports what happened.
async function run(authService, req) {
  const res = response();
  let passed = false;
  await createAuthGate(authService)(req, res, () => { passed = true; });
  return { passed, res };
}

const noPassword = { isGateEnabled: async () => false, isValidSession: () => false };
const withPassword = (valid) => ({ isGateEnabled: async () => true, isValidSession: (token) => token === valid });

test('the file starts with the admin-local mode off, whatever the developer exported', () => {
  assert.equal(process.env[ENV_NAME], undefined);
  assert.equal(isAdminLocalOnly(), false);
});

test('no password: a remote client cannot reach a privileged route (this is the LAN remote-code-install hole)', async () => {
  for (const [method, url] of [
    ['POST', '/api/repos'],
    ['POST', '/api/sources/install'],
    ['POST', '/api/backup/import'],
    ['POST', '/api/settings'],
    ['GET', '/api/settings'],
    ['GET', '/api/settings/disabled-sources'],
    ['POST', '/api/auth/set-password'],
    ['POST', '/api/system/dependency-update'],
  ]) {
    const { passed, res } = await run(noPassword, request({ method, url, socket: LAN, host: '192.168.1.5:4000' }));
    assert.equal(passed, false, `${method} ${url} should be blocked`);
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.equal(res.body.code, 'LOCAL_ONLY');
    // Without the mode, setting a password IS the way to lift this refusal, so
    // the message may say so.
    assert.equal(res.body.error, LOCAL_ONLY_MESSAGE, `${method} ${url}`);
  }
});

test('no password: the same privileged routes still work from the machine itself', async () => {
  const { passed } = await run(noPassword, request({ method: 'POST', url: '/api/repos' }));
  assert.equal(passed, true);
});

test('no password: a DNS-rebinding page (loopback peer, foreign Host) is also blocked', async () => {
  const { passed, res } = await run(noPassword, request({ method: 'POST', url: '/api/sources/install', host: 'evil.example:4000' }));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
});

test('no password: ordinary reader routes stay open to the LAN', async () => {
  for (const [method, url] of [['GET', '/api/state'], ['GET', '/api/library'], ['POST', '/api/favorites/toggle'], ['POST', '/api/source/mangadex/search']]) {
    const { passed } = await run(noPassword, request({ method, url, socket: LAN, host: '192.168.1.5:4000' }));
    assert.equal(passed, true, `${method} ${url}`);
  }
});

test('no password: a store read failure does not open privileged routes to remote clients', async () => {
  const broken = { isGateEnabled: async () => { throw new Error('store not ready'); }, isValidSession: () => false };
  const privileged = await run(broken, request({ method: 'POST', url: '/api/repos', socket: LAN, host: '192.168.1.5:4000' }));
  assert.equal(privileged.passed, false);
  assert.equal(privileged.res.statusCode, 403);
  // ...while ordinary routes keep failing open so the app can still bootstrap.
  const ordinary = await run(broken, request({ url: '/api/state', socket: LAN, host: '192.168.1.5:4000' }));
  assert.equal(ordinary.passed, true);
});

test('with a password set, the normal session check applies and the local-only rule steps aside', async () => {
  const service = withPassword('good-token');

  const anonymous = await run(service, request({ method: 'POST', url: '/api/repos', socket: LAN, host: '192.168.1.5:4000' }));
  assert.equal(anonymous.passed, false);
  assert.equal(anonymous.res.statusCode, 401);
  assert.equal(anonymous.res.body.code, 'AUTH_REQUIRED');

  const loggedIn = await run(service, request({
    method: 'POST', url: '/api/repos', socket: LAN, host: '192.168.1.5:4000', cookie: 'scrollscape_session=good-token',
  }));
  assert.equal(loggedIn.passed, true);
});

test('login/status/logout stay reachable without a session', async () => {
  const service = withPassword('good-token');
  for (const url of ['/api/auth/login', '/api/auth/status', '/api/auth/logout']) {
    const { passed } = await run(service, request({ method: 'POST', url, socket: LAN, host: '192.168.1.5:4000' }));
    assert.equal(passed, true, url);
  }
});

test('admin-local mode: privileged routes stay local-only even with a password and a valid session', async () => {
  await withAdminLocalOnly(async () => {
    const service = withPassword('good-token');
    const cookie = 'scrollscape_session=good-token';

    // Logged in, but arriving over the tailnet (loopback peer via a proxy): blocked.
    const proxied = request({ method: 'POST', url: '/api/repos', cookie });
    proxied.headers['x-forwarded-for'] = '100.64.0.7';
    const blocked = await run(service, proxied);
    assert.equal(blocked.passed, false);
    assert.equal(blocked.res.statusCode, 403);
    assert.equal(blocked.res.body.code, 'LOCAL_ONLY');

    // Path-case tricks do not get around it.
    const shouted = request({ method: 'GET', url: '/API/backup/export', socket: LAN, host: '192.168.1.5:4000', cookie });
    assert.equal((await run(service, shouted)).res.statusCode, 403);

    // From the machine itself, with the session, it works; ordinary routes are unaffected.
    assert.equal((await run(service, request({ method: 'POST', url: '/api/repos', cookie }))).passed, true);
    const ordinary = request({ url: '/api/state', socket: LAN, host: '192.168.1.5:4000', cookie });
    assert.equal((await run(service, ordinary)).passed, true);
  });
});

test('admin-local mode: the refusal says it is not lifted by a password (the ordinary text points the operator at a remedy that does nothing)', async () => {
  await withAdminLocalOnly(async () => {
    const cookie = 'scrollscape_session=good-token';
    const remote = { method: 'POST', url: '/api/sources/install', socket: LAN, host: '192.168.1.5:4000' };

    // Password set, valid session: the case that used to answer "...or after you set an Access Password".
    const withSession = await run(withPassword('good-token'), request({ ...remote, cookie }));
    assert.equal(withSession.passed, false);
    assert.equal(withSession.res.statusCode, 403);
    assert.equal(withSession.res.body.code, 'LOCAL_ONLY');
    assert.equal(withSession.res.body.error, ADMIN_LOCAL_ONLY_MESSAGE);
    assert.doesNotMatch(withSession.res.body.error, /after you set an Access Password/);

    // Password set, no session: the mode answers before the login check does.
    const anonymous = await run(withPassword('good-token'), request(remote));
    assert.equal(anonymous.res.statusCode, 403);
    assert.equal(anonymous.res.body.error, ADMIN_LOCAL_ONLY_MESSAGE);

    // No password at all: setting one would not lift this either.
    const noPass = await run(noPassword, request(remote));
    assert.equal(noPass.res.statusCode, 403);
    assert.equal(noPass.res.body.error, ADMIN_LOCAL_ONLY_MESSAGE);

    // A store that cannot be read yet does not change the answer.
    const broken = { isGateEnabled: async () => { throw new Error('store not ready'); }, isValidSession: () => true };
    const unreadable = await run(broken, request({ ...remote, cookie }));
    assert.equal(unreadable.res.statusCode, 403);
    assert.equal(unreadable.res.body.error, ADMIN_LOCAL_ONLY_MESSAGE);
  });

  // Mode off again: the ordinary refusal and the ordinary 401 are back.
  const ordinary = await run(noPassword, request({ method: 'POST', url: '/api/sources/install', socket: LAN, host: '192.168.1.5:4000' }));
  assert.equal(ordinary.res.body.error, LOCAL_ONLY_MESSAGE);
});

// What the gate has to hold for a client that is NOT this machine and has a
// valid session, with the mode on. Each target is a way to write a privileged
// route that Express still routes to its handler (or that is not origin-form,
// which the guard refuses outright).
const ODD_TARGETS = [
  ['GET', '/api/settings'],
  ['GET', '/API/SETTINGS'],
  ['GET', '/Api/Backup/Export'],
  ['HEAD', '/api/settings'],
  ['HEAD', '/api/backup/export'],
  ['POST', '/api/settings/'],
  ['POST', '/api/settings?x=1'],
  ['POST', '/api/settings#frag'],
  ['POST', '/api/sources/install/'],
  ['POST', '/API/sources/INSTALL'],
  // The shape the first version of the guard missed: absolute-form with an empty
  // authority and a backslash after /api, which Express's router still routes.
  ['GET', 'http:///api' + BS + 'settings'],
  ['POST', 'http:///api' + BS + 'sources/install'],
  ['POST', 'ws:///api' + BS + 'sources/install'],
  ['POST', 'http:///api' + BS + 'auth/set-password'],
  ['POST', 'http:///api' + BS + 'backup/import'],
  ['DELETE', 'http:///api' + BS + 'repos'],
  ['POST', 'http://h/api/repos'],
  ['POST', 'HTTP://H/api/repos'],
  ['POST', 'http://localhost/api/repos'],
  ['POST', 'http://[::1]/api/repos'],
  ['GET', 'http:/api/settings'],
  ['POST', '/api/system/dependency-update'],
];

test('admin-local mode: a valid session cannot get a remote client past the guard with any odd spelling of the target', async () => {
  await withAdminLocalOnly(async () => {
    const service = withPassword('good-token');
    const cookie = 'scrollscape_session=good-token';
    const remotes = [
      { socket: LAN, host: '192.168.1.5:4000', headers: {} },
      { socket: LOCAL, host: 'evil.example:4000', headers: {} },
      { socket: LOCAL, host: 'localhost:4000', headers: { 'x-forwarded-for': '100.64.0.7' } },
      { socket: LOCAL, host: 'pc.tailnet.ts.net', headers: { 'tailscale-user-login': 'a@example.com', 'x-forwarded-proto': 'https' } },
    ];
    for (const [method, url] of ODD_TARGETS) {
      for (const remote of remotes) {
        const req = request({ method, url, socket: remote.socket, host: remote.host, cookie });
        Object.assign(req.headers, remote.headers);
        const { passed, res } = await run(service, req);
        const label = `${method} ${JSON.stringify(url)} from ${remote.host}`;
        assert.equal(passed, false, label);
        assert.equal(res.statusCode, 403, label);
        assert.equal(res.body.error, ADMIN_LOCAL_ONLY_MESSAGE, label);
      }
    }
  });
});

test('admin-local mode: the same odd spellings are fine from the machine itself with a session, and need that session', async () => {
  await withAdminLocalOnly(async () => {
    const service = withPassword('good-token');
    const cookie = 'scrollscape_session=good-token';
    for (const [method, url] of ODD_TARGETS) {
      const label = `${method} ${JSON.stringify(url)}`;
      assert.equal((await run(service, request({ method, url, cookie }))).passed, true, label);
      const anonymous = await run(service, request({ method, url }));
      assert.equal(anonymous.passed, false, label);
      assert.equal(anonymous.res.statusCode, 401, label);
    }
  });
});

test('the paths exempt from the gate never overlap a privileged route, in any spelling the guard folds together', () => {
  const privileged = new Set(PRIVILEGED_ROUTES.map((r) => r.path.toLowerCase()));
  assert.ok(EXEMPT_PATHS.size >= 3);
  for (const path of EXEMPT_PATHS) {
    assert.equal(privileged.has(path.toLowerCase()), false, path);
    for (const method of ['GET', 'HEAD', 'POST', 'DELETE']) {
      assert.equal(isPrivilegedRoute({ method, originalUrl: path }), false, `${method} ${path}`);
    }
  }
});

test('an exempt path is matched exactly: other spellings of it go through the gate', async () => {
  const service = withPassword('good-token');
  for (const url of [
    '/API/auth/login',
    '/api/AUTH/status',
    '/api/auth/login/',
    '/api/auth/logout//',
    '/api/auth/login;x=1',
    '/api/auth/login#f',
    '/api/auth/login' + BS,
    'http://h/api/auth/login',
    'http:///api' + BS + 'auth/login',
    '/api/auth/login/../settings',
    '/api/auth/status/%2e%2e/settings',
  ]) {
    const { passed, res } = await run(service, request({ method: 'POST', url, socket: LAN, host: '192.168.1.5:4000' }));
    assert.equal(passed, false, url);
    assert.equal(res.statusCode, 401, url);
  }
  // A query string is not part of the path, so it does not break the exemption.
  const withQuery = await run(service, request({ method: 'POST', url: '/api/auth/login?next=/api/settings', socket: LAN, host: '192.168.1.5:4000' }));
  assert.equal(withQuery.passed, true);
});

// ---------------------------------------------------------------------------
// Differential check against a real Express router: the gate decides by text,
// Express decides which handler runs, and the two must agree. Raw request
// lines, loopback only. The scenario here is the one the Tailscale setup runs
// in: Access Password set, SCROLLSCAPE_ADMIN_LOCAL_ONLY=1, and a client that
// holds a VALID session but is not this machine. (tests/unit/local-only-routing
// covers the no-password configuration.)

function makeRandom(seed) {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const AUTHORITIES = ['http://h', 'http://', 'http:///', 'ws:///', 'HTTP://H', 'http://h:80', 'http://u@h', 'https://h', 'http:/', '//h', '///', 'http://[::1]', 'http://localhost'];
const SUFFIXES = ['', '/', '//', '?x=1', '/?x=1', '#f', ';a=b', '.', '%20', '%00', '/.', '/%2e', BS, '%5c', '?'];
const SWEEP_METHODS = ['GET', 'POST', 'DELETE', 'HEAD', 'PUT'];

function variantsOf(route, rnd) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const mixCase = (text) => [...text].map((c) => (rnd() < 0.5 ? c.toUpperCase() : c.toLowerCase())).join('');
  const percentEncode = (text) => [...text].map((c) => (c !== '/' && rnd() < 0.25 ? '%' + c.charCodeAt(0).toString(16) : c)).join('');
  const rest = route.path.slice('/api'.length);
  const exempt = [...EXEMPT_PATHS];
  const out = new Set([
    route.path,
    route.path.toUpperCase(),
    '/api' + BS + rest.slice(1),
    'http://' + '/api' + BS + rest.slice(1),
    'ws://' + '/api' + BS + rest.slice(1),
    'http://' + route.path,
    'http://h' + route.path,
    route.path + '/',
    route.path + '?x=1',
    route.path + '#f',
    // Prefixed with something the gate exempts, in the ways a router could still fold away.
    pick(exempt) + '/..' + rest,
    pick(exempt) + '/%2e%2e' + rest,
    pick(exempt) + ';' + rest,
    pick(exempt) + '?' + route.path,
  ]);
  for (let i = 0; i < 14; i++) {
    let path = route.path;
    const roll = rnd();
    if (roll < 0.3) path = mixCase(path);
    else if (roll < 0.5) path = percentEncode(path);
    else if (roll < 0.7) path = path.split('/').join(pick(['//', '/./', BS, '%2f', '/;/', '/../api/']));
    else path = path.replace('/api', pick(['/api/.', '/api/x/..', '/./api', '//api', '/%61pi']));
    if (rnd() < 0.4) path = pick(AUTHORITIES) + (path.startsWith('/') ? '' : '/') + path;
    out.add(path + pick(SUFFIXES));
  }
  return [...out];
}

function rawRequest(port, method, target, headers) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
      socket.write(`${method} ${target} HTTP/1.1\r\n${lines}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    let received = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('data', (chunk) => { received += chunk; });
    socket.on('close', () => resolve(received));
    socket.on('error', () => resolve(received));
  });
}

const SESSION = 'scrollscape_session=good-token';
// A client that is not this machine but reaches its loopback socket one way or
// another: a rebinding page, a LAN-style Host, tailscale serve's headers.
const REMOTE_HEADER_SETS = [
  { Host: 'evil.example', Cookie: SESSION },
  { Host: 'evil.example:4000', Cookie: SESSION },
  { Host: '192.168.1.149:4000', Cookie: SESSION },
  { Host: 'localhost:4000', 'X-Forwarded-For': '100.64.0.7', Cookie: SESSION },
  { Host: 'pc.tailnet.ts.net', 'Tailscale-User-Login': 'a@example.com', 'X-Forwarded-Proto': 'https', Cookie: SESSION },
];

// Reaches the router with `gate` mounted exactly as server.js mounts it, every
// privileged route answering with a marker header (a HEAD response has no body).
async function withRouter(gate, fn) {
  const app = express();
  app.use('/api', gate);
  for (const route of PRIVILEGED_ROUTES) {
    app[route.method.toLowerCase()](route.path, (req, res) => {
      res.set('X-Reached', `${route.method} ${route.path}`).json({ REACHED: `${route.method} ${route.path}` });
    });
  }
  for (const path of EXEMPT_PATHS) app.all(path, (req, res) => res.set('X-Exempt', path).json({ EXEMPT: path }));
  app.get('/api/library', (req, res) => res.json({ public: true }));

  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const reached = (response) => /^x-reached:/im.test(response);

async function sweepLeaks(port) {
  const rnd = makeRandom(20261021);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const jobs = [];
  for (const route of PRIVILEGED_ROUTES) {
    for (const target of variantsOf(route, rnd)) {
      for (const method of SWEEP_METHODS) jobs.push({ method, target, headers: pick(REMOTE_HEADER_SETS) });
    }
  }
  const leaks = [];
  let refused = 0;
  for (let i = 0; i < jobs.length; i += 25) {
    const batch = jobs.slice(i, i + 25);
    const responses = await Promise.all(batch.map((j) => rawRequest(port, j.method, j.target, j.headers)));
    responses.forEach((response, k) => {
      if (reached(response)) leaks.push(`${batch[k].method} ${JSON.stringify(batch[k].target)} Host=${batch[k].headers.Host}`);
      if (response.startsWith('HTTP/1.1 403')) refused++;
    });
  }
  return { leaks, refused, sent: jobs.length };
}

test('admin-local mode + password + valid session: no spelling of a privileged route reaches its handler from a remote client', async () => {
  await withAdminLocalOnly(() => withRouter(createAuthGate(withPassword('good-token')), async (port) => {
    const { leaks, refused, sent } = await sweepLeaks(port);
    assert.ok(sent > 1000, `expected a broad sweep, sent ${sent}`);
    // The sweep has to be exercising the guard, not bouncing off 404s and 400s.
    assert.ok(refused > 200, `only ${refused} of ${sent} requests were refused by the guard`);
    assert.deepEqual(leaks, []);

    // The guard must not have turned into a blanket refusal: the same session
    // works from the machine itself, and the public and exempt routes are open.
    const local = { Host: 'localhost:4000', Cookie: SESSION };
    assert.ok(reached(await rawRequest(port, 'GET', '/api/settings', local)));
    assert.ok(reached(await rawRequest(port, 'POST', '/api/sources/install', local)));
    assert.equal(reached(await rawRequest(port, 'GET', '/api/settings', { Host: 'localhost:4000' })), false); // no session
    assert.match(await rawRequest(port, 'GET', '/api/library', { ...REMOTE_HEADER_SETS[0] }), /"public":true/);
    assert.match(await rawRequest(port, 'POST', '/api/auth/login', { Host: 'evil.example' }), /"EXEMPT"/);
  }));
});

test('the sweep is a real detector: with the mode off the same remote session does reach the handlers, and a naive path comparison leaks', async () => {
  // Mode off, password set: a remote client WITH a session may use the privileged routes.
  await withRouter(createAuthGate(withPassword('good-token')), async (port) => {
    assert.ok(reached(await rawRequest(port, 'GET', '/api/settings', REMOTE_HEADER_SETS[0])));
    assert.equal(reached(await rawRequest(port, 'GET', '/api/settings', { Host: 'evil.example' })), false);
  });

  // A gate that compares the raw path text with the privileged list (the shape
  // of check the fix replaced) is beaten by this very sweep.
  const naive = async (req, res, next) => {
    const full = String(req.originalUrl || '').split('?')[0];
    const privileged = PRIVILEGED_ROUTES.some((r) => r.method === req.method && r.path === full);
    if (isAdminLocalOnly() && privileged && !isLocalRequest(req)) {
      return res.status(403).json({ code: 'LOCAL_ONLY' });
    }
    return req.headers.cookie === SESSION ? next() : res.status(401).json({});
  };
  await withAdminLocalOnly(() => withRouter(naive, async (port) => {
    const { leaks } = await sweepLeaks(port);
    assert.ok(leaks.length > 20, `the naive gate should leak widely, leaked ${leaks.length}`);
  }));
});

// ---------------------------------------------------------------------------
// Start-ScrollScape-Safe.ps1 is the other half of the admin-local mode: it is
// what sets the variable this gate reads. Nothing in the suite runs it (it
// starts real processes), so its text is pinned here instead. It has already
// lost a backslash and named a file that does not exist, in the same transfer:
// damage a parser does not notice.

const REPO_ROOT = path.join(__dirname, '../..');
const LAUNCHER = fs.readFileSync(path.join(REPO_ROOT, 'Start-ScrollScape-Safe.ps1'), 'utf8');
const launcherHeader = LAUNCHER.slice(0, LAUNCHER.indexOf('param('));

// Text of the launcher between two markers.
function between(text, from, to) {
  const start = text.indexOf(from);
  assert.notEqual(start, -1, `launcher lost: ${from}`);
  const end = text.indexOf(to, start + from.length);
  assert.notEqual(end, -1, `launcher lost: ${to}`);
  return text.slice(start + from.length, end);
}

test('launcher: the run command in the header keeps its backslash and only files that exist are named', () => {
  assert.ok(launcherHeader.includes('-File .' + BS + 'Start-ScrollScape-Safe.ps1'));
  const named = new Set(launcherHeader.match(/[A-Za-z0-9-]+[.](?:bat|ps1|js)/g) || []);
  assert.ok(named.has('Start-ScrollScape-Safe.ps1'));
  for (const name of named) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, name)), `the header names ${name}, which is not in the repository`);
  }
});

test('launcher: plain ASCII only (Windows PowerShell 5.1 reads a file without a BOM as ANSI and garbles anything else)', () => {
  for (let i = 0; i < LAUNCHER.length; i++) {
    assert.ok(LAUNCHER.charCodeAt(i) < 128, `non-ASCII character at offset ${i}: ${JSON.stringify(LAUNCHER.slice(i, i + 12))}`);
  }
});

test('launcher: switches the admin-local mode on with the value the gate accepts', () => {
  const value = LAUNCHER.match(/[$]env:SCROLLSCAPE_ADMIN_LOCAL_ONLY = '([^']*)'/);
  assert.ok(value, 'the launcher no longer sets SCROLLSCAPE_ADMIN_LOCAL_ONLY');
  assert.equal(isAdminLocalOnly({ SCROLLSCAPE_ADMIN_LOCAL_ONLY: value[1] }), true);
});

test('launcher: every variable it sets or clears for the child is in the list it restores for the caller', () => {
  const restored = new Set(
    between(LAUNCHER, "foreach ($name in ", ")").match(/'([A-Z_]+)'/g).map((q) => q.slice(1, -1)),
  );
  const touched = new Set([
    ...[...LAUNCHER.matchAll(/^[ \t]*[$]env:([A-Z_]+) = /gm)].map((m) => m[1]),
    ...[...LAUNCHER.matchAll(/SetEnvironmentVariable[(]'([A-Z_]+)', [$]null/g)].map((m) => m[1]),
  ]);
  assert.ok(touched.has('HOST') && touched.has('SCROLLSCAPE_ADMIN_LOCAL_ONLY'));
  for (const name of touched) assert.ok(restored.has(name), `${name} is changed for the child but never restored for the caller`);
});

// The two branches of the FlareSolverr switch: from the -AllowFlareSolverr
// consent line to the else, and from the else to the line that starts the app.
function flaresolverrBranches() {
  const consent = "$env:FLARESOLVERR_AUTO_INSTALL = '1'";
  const at = LAUNCHER.indexOf(consent);
  assert.notEqual(at, -1, 'the launcher no longer sets FLARESOLVERR_AUTO_INSTALL for -AllowFlareSolverr');
  const fromConsent = LAUNCHER.slice(at);
  return {
    allow: between(fromConsent, consent, '} else {'),
    off: between(fromConsent, '} else {', '$proc = Start-Process'),
  };
}

test('launcher: -AllowFlareSolverr also clears an inherited FLARESOLVERR_DISABLED and FLARESOLVERR_EXE_PATH', () => {
  const { allow, off } = flaresolverrBranches();
  assert.ok(allow.includes("SetEnvironmentVariable('FLARESOLVERR_DISABLED', $null"), 'an inherited FLARESOLVERR_DISABLED=1 would beat the consent');
  assert.ok(allow.includes("SetEnvironmentVariable('FLARESOLVERR_EXE_PATH', $null"), 'an inherited FLARESOLVERR_EXE_PATH would point the app at another copy');
  // ...and the default run still switches it off.
  assert.ok(off.includes("$env:FLARESOLVERR_DISABLED = '1'"));
});

test('launcher: the bogus FLARESOLVERR_EXE_PATH is not described as harmless (old builds kill every chromedriver on it)', () => {
  const { off } = flaresolverrBranches();
  assert.ok(off.includes('$env:FLARESOLVERR_EXE_PATH = '));
  assert.doesNotMatch(off, /harmless/i);
  assert.match(off, /chromedriver/i);
});

test('launcher: never picks between several executables, and says so with its own exit code', () => {
  const selection = between(LAUNCHER, 'if (-not $Exe) {', 'Write-Host "Using');
  assert.ok(selection.includes('exit 6'));
  assert.doesNotMatch(selection, /Select-Object -First 1/);
  assert.ok(LAUNCHER.includes('Write-Host "Using $Exe"'), 'the chosen exe must be printed');
});

test('launcher: every exit code it uses is documented in the header', () => {
  const exitCodesParagraph = launcherHeader.slice(launcherHeader.indexOf('Exit codes:'));
  const documented = new Set(exitCodesParagraph.split(/[^0-9]+/).filter(Boolean).map(Number));
  const code = LAUNCHER.slice(launcherHeader.length).split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  const used = new Set([...code.matchAll(/(?:^|[^A-Za-z0-9_-])exit ([0-9]+)/g)].map((m) => Number(m[1])));
  assert.ok(used.has(6) && used.has(10));
  for (const n of used) assert.ok(documented.has(n), `exit ${n} is not documented in the header`);
});

test('launcher: tailscale is only ever invoked inside the -TailscaleServe branch', () => {
  const branch = LAUNCHER.indexOf('if ($TailscaleServe) {');
  assert.notEqual(branch, -1);
  const calls = [...LAUNCHER.matchAll(/& [$]ts /g)].map((m) => m.index);
  assert.ok(calls.length > 0);
  for (const at of calls) assert.ok(at > branch, 'a tailscale call sits outside the -TailscaleServe branch');
  assert.equal(LAUNCHER.slice(0, branch).includes('tailscale.exe'), false);
});
