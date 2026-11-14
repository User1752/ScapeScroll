'use strict';

// The whole-app Host / cross-site guard (createLocalHostGuard in local-only.js).
//
// What it closes: while the server is bound to loopback with no Access Password,
// a DNS-rebinding page (loopback socket, Host: its own name, Sec-Fetch-Site:
// same-origin, Origin == Host) used to pass every /api route except the 13
// privileged ones, so it could READ the library and wipe it; and a cross-site
// multipart post needs no CORS preflight, so it could WRITE through the import
// routes. The unit half pins the decision table with fake req/res/next; the
// differential half sends raw requests to a real Express app on port 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAuthGate, SESSION_COOKIE } = require('../../server/middleware/auth-gate');
const { createAuthService } = require('../../server/modules/auth/service');
const {
  createLocalHostGuard,
  isTopLevelPageLoad,
  HOST_NOT_LOCAL_MESSAGE,
  CROSS_SITE_MESSAGE,
} = require('../../server/middleware/local-only');

const { before, after } = test;

// The auth gate reads this from the real environment on every request.
const ENV_NAME = 'SCROLLSCAPE_ADMIN_LOCAL_ONLY';
let originalEnv;
before(() => { originalEnv = process.env[ENV_NAME]; delete process.env[ENV_NAME]; });
after(() => {
  if (originalEnv === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = originalEnv;
});

// ── Unit half: fake req / res / next ─────────────────────────────────────────

function fakeRequest({ method = 'GET', url = '/api/library', host = 'localhost:4000', headers = {} } = {}) {
  // host: null leaves the header out entirely (undefined would pick the default).
  const all = { ...(host === null ? {} : { host }), ...headers };
  return { method, originalUrl: url, url, socket: { remoteAddress: '127.0.0.1' }, headers: all };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

async function run(guard, req) {
  const res = fakeResponse();
  let passed = false;
  await guard(req, res, () => { passed = true; });
  return { passed, res };
}

// A password probe that counts how often it was asked.
function probe(value) {
  const state = { calls: 0, value };
  state.fn = () => {
    state.calls++;
    if (typeof state.value === 'function') return state.value();
    return state.value;
  };
  return state;
}

const BROWSER = {
  sameOrigin: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
  typedUrl: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
  crossFetch: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
  crossImage: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
  crossLink: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
  crossIframe: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
  siblingPort: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
};

test('server not bound to loopback: the guard does nothing, and never reads the store', async () => {
  const password = probe(false);
  const guard = createLocalHostGuard({ loopbackOnly: false, isPasswordSet: password.fn });
  for (const req of [
    fakeRequest({ host: 'evil.example' }),
    fakeRequest({ host: '192.168.1.149:4000' }),
    fakeRequest({ host: null }),
    fakeRequest({ method: 'POST', headers: BROWSER.crossFetch }),
    fakeRequest({ method: 'POST', headers: { origin: 'http://evil.example' } }),
  ]) {
    const { passed, res } = await run(guard, req);
    assert.equal(passed, true, JSON.stringify(req.headers));
    assert.equal(res.statusCode, 200);
  }
  assert.equal(password.calls, 0);
});

test('loopback, no password: the ways the owner really opens the app all pass', async () => {
  const password = probe(false);
  const guard = createLocalHostGuard({ loopbackOnly: true, isPasswordSet: password.fn });
  const hosts = ['localhost:4000', 'localhost', '127.0.0.1:4000', '127.0.0.1', '[::1]:4000', '[::1]', 'LOCALHOST:4001', ' localhost:4000 '];
  for (const host of hosts) {
    for (const headers of [{}, BROWSER.typedUrl, BROWSER.sameOrigin]) {
      for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'DELETE']) {
        const { passed } = await run(guard, fakeRequest({ method, host, headers }));
        assert.equal(passed, true, `${method} Host=${JSON.stringify(host)} ${JSON.stringify(headers)}`);
      }
    }
  }
  // Same-origin POST with an Origin that matches the Host (the app's own fetch).
  assert.equal((await run(guard, fakeRequest({ method: 'POST', host: 'localhost:4000', headers: { origin: 'http://localhost:4000', ...BROWSER.sameOrigin } }))).passed, true);
  assert.equal((await run(guard, fakeRequest({ method: 'POST', host: '127.0.0.1:4000', headers: { origin: 'http://127.0.0.1:4000' } }))).passed, true);
  // The common, allowed case must not even look at the store.
  assert.equal(password.calls, 0);
});

test('loopback, no password: curl, the Suwayomi bridge, the dashboard and the exe\'s own browser window pass', async () => {
  const guard = createLocalHostGuard({ loopbackOnly: true, isPasswordSet: probe(false).fn });
  // No Sec-Fetch-*, no Origin: only a Host that names this machine.
  const curl = fakeRequest({ host: '127.0.0.1:4000', headers: { 'user-agent': 'curl/8.4.0', accept: '*/*' } });
  const bridge = fakeRequest({ method: 'POST', host: '127.0.0.1:4000', headers: { 'content-type': 'application/json' } });
  // `start http://localhost:PORT` from the packaged exe: a typed-URL style load.
  const exeWindow = fakeRequest({ url: '/', host: 'localhost:4000', headers: BROWSER.typedUrl });
  for (const req of [curl, bridge, exeWindow]) assert.equal((await run(guard, req)).passed, true);
});

test('loopback, no password: a foreign Host is refused on every kind of path and method', async () => {
  const password = probe(false);
  const guard = createLocalHostGuard({ loopbackOnly: true, isPasswordSet: password.fn });
  const hosts = ['evil.example', 'evil.example:4000', 'rebind.evil.example:4000', '192.168.1.149:4000', 'foo.localhost:4000',
    'localhost.evil.example', 'localhost:4000.evil.example', 'evil.example:4000@localhost', 'localhost:abc', '0.0.0.0:4000', '[::2]:4000', '', null];
  const requests = [
    { method: 'GET', url: '/api/library' },
    { method: 'GET', url: '/API/Library' },
    { method: 'GET', url: '/api/state' },
    { method: 'DELETE', url: '/api/library/clear' },
    { method: 'POST', url: '/api/local/import' },
    { method: 'GET', url: '/local-media/x/1.jpg' },
    { method: 'GET', url: '/opds' },
    { method: 'GET', url: '/sources-repo/index.json' },
    { method: 'GET', url: '/app.js' },
    { method: 'GET', url: '/' },
    { method: 'HEAD', url: '/api/library' },
  ];
  for (const host of hosts) {
    for (const r of requests) {
      const req = fakeRequest({ ...r, host, headers: { ...BROWSER.sameOrigin, origin: host ? `http://${host}` : undefined } });
      if (req.headers.origin === undefined) delete req.headers.origin;
      const { passed, res } = await run(guard, req);
      assert.equal(passed, false, `${r.method} ${r.url} Host=${JSON.stringify(host)}`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.code, 'HOST_NOT_LOCAL');
      assert.equal(res.body.ok, false);
      assert.equal(res.body.error, HOST_NOT_LOCAL_MESSAGE);
    }
  }
});

test('loopback, no password: relay headers do not make a foreign Host acceptable (they are page-settable)', async () => {
  const guard = createLocalHostGuard({ loopbackOnly: true, isPasswordSet: probe(false).fn });
  // X-Forwarded-For is not a forbidden request header: same-origin page script can add it.
  for (const headers of [
    { 'x-forwarded-for': '203.0.113.9' },
    { 'x-forwarded-for': '100.64.0.7', 'x-forwarded-host': 'pc.tailnet.ts.net', 'x-forwarded-proto': 'https' },
    { forwarded: 'for=203.0.113.9;host=evil.example' },
    { 'tailscale-user-login': 'me@example.com', 'tailscale-user-name': 'Me' },
  ]) {
    const { passed, res } = await run(guard, fakeRequest({ host: 'pc.tailnet.ts.net', headers }));
    assert.equal(passed, false, JSON.stringify(headers));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, 'HOST_NOT_LOCAL');
  }
});

test('loopback, no password: tailscale serve without an Access Password keeps being refused, and says what to do', async () => {
  const guard = createLocalHostGuard({ loopbackOnly: true, isPasswordSet: probe(false).fn });
  const { passed, res } = await run(guard, fakeRequest({
    host: 'pc.tailnet.ts.net',
    headers: { 'x-forwarded-for': '100.64.0.7', 'x-forwarded-proto': 'https', 'tailscale-user-login': 'me@example.com' },
  }));
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /Access Password/);
  assert.match(res.body.error, /localhost/);
});

test('loopback, no password: browser requests marked cross-site or same-site are refused', async () => {
  const guard = createLocalHostGuard({ loopbackOnly: true, isPasswordSet: probe(false).fn });
  const cases = [
    ['POST', BROWSER.crossFetch],
    ['DELETE', BROWSER.crossFetch],
    ['PUT', BROWSER.crossFetch],
    ['POST', { ...BROWSER.crossLink }],                     // a form post is a navigation, but not a GET
    ['GET', BROWSER.crossFetch],                            // a CORS fetch
    ['GET', BROWSER.crossImage],                            // <img src="http://localhost:4000/api/proxy-image?...">
    ['GET', BROWSER.crossIframe],
    ['OPTIONS', BROWSER.crossFetch],                        // CORS preflight
    ['POST', BROWSER.siblingPort],                          // a page on localhost:3000
    ['GET', BROWSER.siblingPort],
    ['POST', { origin: 'http://evil.example' }],            // old browser: no Sec-Fetch, but an Origin
    ['POST', { origin: 'null' }],                           // sandboxed iframe / data: URL
    ['POST', { origin: 'http://localhost:3000' }],
    ['GET', { origin: 'http://evil.example' }],             // a CORS GET carries an Origin
  ];
  for (const [method, headers] of cases) {
    for (const url of ['/api/local/import', '/api/library', '/app.js']) {
      const { passed, res } = await run(guard, fakeRequest({ method, url, headers }));
      assert.equal(passed, false, `${method} ${url} ${JSON.stringify(headers)}`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.code, 'CROSS_SITE_BLOCKED');
      assert.equal(res.body.error, CROSS_SITE_MESSAGE);
    }
  }
});

test('loopback, no password: clicking a link to localhost from another page still loads it (top-level GET only)', async () => {
  const guard = createLocalHostGuard({ loopbackOnly: true, isPasswordSet: probe(false).fn });
  for (const method of ['GET', 'HEAD']) {
    for (const headers of [BROWSER.crossLink, { ...BROWSER.crossLink, 'sec-fetch-site': 'same-site' }]) {
      assert.equal((await run(guard, fakeRequest({ method, url: '/manga/x/1/slug', headers }))).passed, true);
    }
  }
  assert.equal(isTopLevelPageLoad(fakeRequest({ headers: BROWSER.crossLink })), true);
  assert.equal(isTopLevelPageLoad(fakeRequest({ method: 'POST', headers: BROWSER.crossLink })), false);
  assert.equal(isTopLevelPageLoad(fakeRequest({ headers: BROWSER.crossIframe })), false);
  assert.equal(isTopLevelPageLoad(fakeRequest({ headers: BROWSER.crossFetch })), false);
  assert.equal(isTopLevelPageLoad({}), false);
  // ...but the exemption never rescues a foreign Host: that is rebinding, not a link.
  const { passed, res } = await run(guard, fakeRequest({ host: 'evil.example', headers: BROWSER.crossLink }));
  assert.equal(passed, false);
  assert.equal(res.body.code, 'HOST_NOT_LOCAL');
});

test('an Access Password set switches the guard off, checked per request', async () => {
  const password = probe(true);
  const guard = createLocalHostGuard({ loopbackOnly: true, isPasswordSet: password.fn });
  const foreign = () => fakeRequest({ host: 'pc.tailnet.ts.net', headers: { 'x-forwarded-for': '100.64.0.7' } });
  const crossSite = () => fakeRequest({ method: 'POST', headers: BROWSER.crossFetch });

  assert.equal((await run(guard, foreign())).passed, true);
  assert.equal((await run(guard, crossSite())).passed, true);

  // Removed at runtime: the very next request is refused again.
  password.value = false;
  assert.equal((await run(guard, foreign())).passed, false);
  assert.equal((await run(guard, crossSite())).passed, false);

  // Set at runtime: and the next one passes.
  password.value = () => Promise.resolve(true); // an async probe, like authService.isGateEnabled
  assert.equal((await run(guard, foreign())).passed, true);
  assert.equal(password.calls, 5);
});

test('if the password state cannot be read the guard stays closed', async () => {
  const throwing = createLocalHostGuard({ loopbackOnly: true, isPasswordSet: () => { throw new Error('store unreadable'); } });
  const rejecting = createLocalHostGuard({ loopbackOnly: true, isPasswordSet: () => Promise.reject(new Error('store unreadable')) });
  const missing = createLocalHostGuard({ loopbackOnly: true });
  const noArgs = createLocalHostGuard();
  for (const guard of [throwing, rejecting, missing]) {
    const { passed, res } = await run(guard, fakeRequest({ host: 'evil.example' }));
    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
  }
  // No options at all means "not loopback-only": nothing to guard.
  assert.equal((await run(noArgs, fakeRequest({ host: 'evil.example' }))).passed, true);
  // And a store that cannot be read never blocks a legitimate local request.
  assert.equal((await run(throwing, fakeRequest({ host: 'localhost:4000' }))).passed, true);
});

// ── server.js wiring (it cannot be started in a test, so the order is read) ──

test('server.js mounts the guard first, with the same loopback decision listen() uses', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const at = (needle) => {
    const index = text.indexOf(needle);
    assert.notEqual(index, -1, `server.js no longer contains ${needle}`);
    return index;
  };
  const guard = at('app.use(createLocalHostGuard(');
  assert.ok(at('const app = express()') < guard, 'the guard goes on the app, right after it is created');
  for (const later of ['app.use(compression())', 'app.use(express.json(', "app.use('/api', createAuthGate(", "app.use('/', express.static(", "app.use('/sources-repo'", 'registerAppRoutes(app)']) {
    assert.ok(guard < at(later), `the guard must run before ${later}`);
  }
  // It asks the real auth service, which therefore has to exist by then.
  assert.ok(at('const authService = createAuthService(') < guard);
  assert.match(text, /isPasswordSet:\s*\(\)\s*=>\s*authService\.isGateEnabled\(\)/);
  // One value decides both the guard and the bind.
  assert.match(text, /const LISTEN_HOST\s*=\s*resolveListenHost\(/);
  assert.match(text, /const LOOPBACK_ONLY\s*=\s*isLoopbackHost\(LISTEN_HOST\)/);
  assert.match(text, /loopbackOnly:\s*LOOPBACK_ONLY/);
  assert.match(text, /const host\s*=\s*LISTEN_HOST/);
  assert.match(text, /app\.listen\(port,\s*host,/);
});

// ── Differential half: a real Express app, raw sockets, port 0 ───────────────

// Sends one request exactly as written (so Host and every Sec-Fetch-* header are
// ours, not fetch()'s) over a loopback socket, the way a rebinding page reaches
// the server, and returns the status line and body.
function rawHttp(port, { method = 'GET', target = '/', headers = {}, body = '' }) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [`${method} ${target} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
      lines.push('Connection: close', `Content-Length: ${Buffer.byteLength(body)}`, '', body);
      socket.write(lines.join('\r\n'));
    });
    let received = '';
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('data', (chunk) => { received += chunk; });
    const done = () => {
      const status = Number((received.match(/^HTTP\/1\.1 (\d{3})/) || [])[1] || 0);
      resolve({ status, text: received, body: received.slice(received.indexOf('\r\n\r\n') + 4) });
    };
    socket.on('close', done);
    socket.on('error', done);
  });
}

// What a rebinding page sends: same-origin as far as the browser is concerned.
const rebinding = (port, extra = {}) => ({
  Host: `rebind.evil.example:${port}`,
  Origin: `http://rebind.evil.example:${port}`,
  'Sec-Fetch-Site': 'same-origin',
  'Sec-Fetch-Mode': 'cors',
  ...extra,
});

function buildApp({ withGuard, authService, loopbackOnly = true }) {
  const hits = { clear: 0, importLocal: 0 };
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-hostguard-'));
  fs.writeFileSync(path.join(staticDir, 'app.js'), 'STATIC_FILE_BODY');
  fs.writeFileSync(path.join(staticDir, 'index.html'), 'SHELL_BODY');

  const app = express();
  // Same order as server.js: guard first, then the parsers, the /api gate, the routes, static.
  if (withGuard) app.use(createLocalHostGuard({ loopbackOnly, isPasswordSet: () => authService.isGateEnabled() }));
  app.use(express.json());
  app.use('/api', createAuthGate(authService));
  app.get('/api/library', (_req, res) => res.json({ favorites: ['OWNER_LIBRARY_ROW'] }));
  app.delete('/api/library/clear', (_req, res) => { hits.clear++; res.json({ cleared: true }); });
  app.post('/api/local/import', (_req, res) => { hits.importLocal++; res.json({ imported: true }); });
  app.get('/local-media/x', (_req, res) => res.send('LOCAL_MEDIA_BODY'));
  app.use('/', express.static(staticDir));
  return { app, hits, staticDir };
}

async function listen(app) {
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
}

function newAuthService() {
  let store = { settings: {} };
  return createAuthService({ readStore: async () => store, writeStore: async (next) => { store = next; } });
}

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

test('control: without the guard a rebinding-style request reads the library, wipes it, and loads static files', async () => {
  const { app, hits, staticDir } = buildApp({ withGuard: false, authService: newAuthService() });
  const server = await listen(app);
  try {
    const port = server.address().port;
    assert.equal((await rawHttp(port, { target: '/api/library', headers: rebinding(port) })).status, 200);
    assert.equal((await rawHttp(port, { method: 'DELETE', target: '/api/library/clear', headers: rebinding(port) })).status, 200);
    assert.equal(hits.clear, 1);
    assert.match((await rawHttp(port, { target: '/app.js', headers: rebinding(port) })).body, /STATIC_FILE_BODY/);
  } finally {
    await closeServer(server);
    fs.rmSync(staticDir, { recursive: true, force: true });
  }
});

test('with the guard: a rebinding-style request is refused everywhere, localhost still works', async () => {
  const { app, hits, staticDir } = buildApp({ withGuard: true, authService: newAuthService() });
  const server = await listen(app);
  try {
    const port = server.address().port;
    const refused = async (options) => {
      const response = await rawHttp(port, options);
      assert.equal(response.status, 403, `${options.method || 'GET'} ${options.target}`);
      assert.match(response.body, /HOST_NOT_LOCAL/);
      assert.doesNotMatch(response.text, /OWNER_LIBRARY_ROW|STATIC_FILE_BODY|SHELL_BODY|LOCAL_MEDIA_BODY/);
    };

    await refused({ target: '/api/library', headers: rebinding(port) });
    await refused({ target: '/API/library', headers: rebinding(port) });
    await refused({ target: '/app.js', headers: rebinding(port) });
    await refused({ target: '/', headers: rebinding(port) });
    await refused({ target: '/local-media/x', headers: rebinding(port) });
    await refused({ method: 'DELETE', target: '/api/library/clear', headers: rebinding(port) });
    // Naming the relay headers does not help: a page can set them itself.
    await refused({ target: '/api/library', headers: rebinding(port, { 'X-Forwarded-For': '203.0.113.9' }) });
    await refused({ method: 'DELETE', target: '/api/library/clear', headers: rebinding(port, { 'X-Forwarded-For': '203.0.113.9' }) });
    await refused({ target: '/api/library', headers: { Host: 'evil.example' } });
    assert.equal(hits.clear, 0, 'a refused request must never reach the destructive handler');

    // The owner's own ways in.
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'localhost']) {
      const library = await rawHttp(port, { target: '/api/library', headers: { Host: host } });
      assert.equal(library.status, 200, host);
      assert.match(library.body, /OWNER_LIBRARY_ROW/);
    }
    const appJs = await rawHttp(port, { target: '/app.js', headers: { Host: `localhost:${port}`, 'Sec-Fetch-Site': 'same-origin' } });
    assert.match(appJs.body, /STATIC_FILE_BODY/);
    const shell = await rawHttp(port, { target: '/', headers: { Host: `localhost:${port}`, 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } });
    assert.match(shell.body, /SHELL_BODY/);
    // curl / the Suwayomi bridge: a local Host and nothing else.
    const cleared = await rawHttp(port, { method: 'DELETE', target: '/api/library/clear', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(cleared.status, 200);
    assert.equal(hits.clear, 1);
  } finally {
    await closeServer(server);
    fs.rmSync(staticDir, { recursive: true, force: true });
  }
});

test('with the guard: a cross-site multipart post to localhost is refused before the import handler', async () => {
  const { app, hits, staticDir } = buildApp({ withGuard: true, authService: newAuthService() });
  const server = await listen(app);
  try {
    const port = server.address().port;
    const boundary = '----x';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.cbz"\r\n\r\nzip\r\n--${boundary}--\r\n`;
    const multipart = {
      Host: `localhost:${port}`,
      Origin: 'http://evil.example',
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'no-cors',
      'Sec-Fetch-Dest': 'empty',
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    };
    const response = await rawHttp(port, { method: 'POST', target: '/api/local/import', headers: multipart, body });
    assert.equal(response.status, 403);
    assert.match(response.body, /CROSS_SITE_BLOCKED/);
    assert.equal(hits.importLocal, 0);

    // An old browser without Sec-Fetch-* still sends the foreign Origin on a post.
    const legacy = Object.fromEntries(Object.entries(multipart).filter(([name]) => !name.startsWith('Sec-Fetch-')));
    assert.equal((await rawHttp(port, { method: 'POST', target: '/api/local/import', headers: legacy, body })).status, 403);
    assert.equal(hits.importLocal, 0);

    // The app's own page doing the same upload is fine.
    const own = { ...multipart, Origin: `http://localhost:${port}`, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors' };
    assert.equal((await rawHttp(port, { method: 'POST', target: '/api/local/import', headers: own, body })).status, 200);
    assert.equal(hits.importLocal, 1);
  } finally {
    await closeServer(server);
    fs.rmSync(staticDir, { recursive: true, force: true });
  }
});

test('with the guard: not bound to loopback means unchanged behaviour', async () => {
  const { app, staticDir } = buildApp({ withGuard: true, authService: newAuthService(), loopbackOnly: false });
  const server = await listen(app);
  try {
    const port = server.address().port;
    assert.equal((await rawHttp(port, { target: '/api/library', headers: rebinding(port) })).status, 200);
    assert.equal((await rawHttp(port, { target: '/app.js', headers: { Host: '192.168.1.149:4000' } })).status, 200);
  } finally {
    await closeServer(server);
    fs.rmSync(staticDir, { recursive: true, force: true });
  }
});

test('with the guard: setting the Access Password at runtime hands a relayed request to the auth gate', async () => {
  const authService = newAuthService();
  const { app, hits, staticDir } = buildApp({ withGuard: true, authService });
  const server = await listen(app);
  try {
    const port = server.address().port;
    const tailscale = (extra = {}) => ({
      Host: 'pc.tailnet.ts.net',
      'X-Forwarded-For': '100.64.0.7',
      'X-Forwarded-Proto': 'https',
      ...extra,
    });

    // No password yet: the relay is refused (the safe behaviour).
    assert.equal((await rawHttp(port, { target: '/api/library', headers: tailscale() })).status, 403);

    // The owner sets a password from localhost. No restart, and the guard sees it on the next request.
    await authService.setPassword({ newPassword: 'correct horse' });
    const { token } = await authService.login('correct horse');

    // Without a session the auth gate answers, not the guard.
    const anonymous = await rawHttp(port, { target: '/api/library', headers: tailscale() });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.body, /AUTH_REQUIRED/);
    // A rebinding page has no session cookie either (host-bound, SameSite): still locked out.
    const rebound = await rawHttp(port, { method: 'DELETE', target: '/api/library/clear', headers: rebinding(port) });
    assert.equal(rebound.status, 401);
    assert.equal(hits.clear, 0);
    // With the session the relayed request works, as tailscale serve needs.
    const signedIn = await rawHttp(port, { target: '/api/library', headers: tailscale({ Cookie: `${SESSION_COOKIE}=${token}` }) });
    assert.equal(signedIn.status, 200);
    assert.match(signedIn.body, /OWNER_LIBRARY_ROW/);

    // Removing the password puts the guard back, again without a restart.
    await authService.setPassword({ newPassword: '', currentPassword: 'correct horse' });
    assert.equal((await rawHttp(port, { target: '/api/library', headers: tailscale() })).status, 403);
  } finally {
    await closeServer(server);
    fs.rmSync(staticDir, { recursive: true, force: true });
  }
});
