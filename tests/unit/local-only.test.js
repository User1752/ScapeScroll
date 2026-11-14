'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isLoopbackAddress,
  isLocalHostHeader,
  isLocalRequest,
  isProxiedRequest,
  isAdminLocalOnly,
  isPrivilegedRoute,
  addPrivilegedRoutes,
  requireLocalRequest,
  PRIVILEGED_ROUTES,
} = require('../../server/middleware/local-only');

const req = (overrides = {}) => ({
  method: 'GET',
  originalUrl: '/api/state',
  socket: { remoteAddress: '127.0.0.1' },
  headers: { host: 'localhost:4000' },
  ...overrides,
});

test('isLoopbackAddress accepts the three loopback spellings and nothing else', () => {
  for (const ok of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(isLoopbackAddress(ok), true, ok);
  for (const bad of ['192.168.1.20', '10.0.0.5', '::ffff:192.168.1.20', '0.0.0.0', '', undefined, null]) {
    assert.equal(isLoopbackAddress(bad), false, String(bad));
  }
});

test('isLocalHostHeader accepts this machine by name, with or without a port', () => {
  for (const ok of ['localhost', 'localhost:4000', 'LOCALHOST:4000', '127.0.0.1', '127.0.0.1:61746', '[::1]', '[::1]:4000']) {
    assert.equal(isLocalHostHeader(ok), true, ok);
  }
});

test('isLocalHostHeader rejects anything else, including look-alikes (DNS rebinding)', () => {
  for (const bad of ['evil.example', 'evil.example:4000', 'localhost.evil.example', 'localhost.', '192.168.1.20:4000', '127.0.0.1.evil.example', '', undefined, 'localhost@evil.example']) {
    assert.equal(isLocalHostHeader(bad), false, String(bad));
  }
});

test('isLocalRequest needs BOTH a loopback peer and a local Host header', () => {
  assert.equal(isLocalRequest(req()), true);
  // Loopback peer but a rebound hostname: a page on evil.example re-resolved to 127.0.0.1.
  assert.equal(isLocalRequest(req({ headers: { host: 'evil.example:4000' } })), false);
  // Local-looking Host header but a remote peer (a LAN device spoofing the header).
  assert.equal(isLocalRequest(req({ socket: { remoteAddress: '192.168.1.20' } })), false);
  assert.equal(isLocalRequest({}), false);
});

test('isPrivilegedRoute matches method + exact path, ignoring the query string and a trailing slash', () => {
  assert.equal(isPrivilegedRoute(req({ method: 'POST', originalUrl: '/api/repos' })), true);
  assert.equal(isPrivilegedRoute(req({ method: 'DELETE', originalUrl: '/api/repos?url=https%3A%2F%2Fx' })), true);
  assert.equal(isPrivilegedRoute(req({ method: 'POST', originalUrl: '/api/sources/install/' })), true);
  assert.equal(isPrivilegedRoute(req({ method: 'get', originalUrl: '/api/settings' })), true);
});

test('isPrivilegedRoute does not flag ordinary reader routes', () => {
  for (const [method, url] of [
    ['GET', '/api/state'],
    ['GET', '/api/library'],
    ['POST', '/api/source/mangadex/search'],
    ['POST', '/api/favorites/toggle'],
    ['GET', '/api/repos'], // listing is read-only; only POST/DELETE change anything
    ['POST', '/api/sources/installed'], // longer path, not the install route
    ['GET', '/api/auth/status'],
  ]) {
    assert.equal(isPrivilegedRoute(req({ method, originalUrl: url })), false, `${method} ${url}`);
  }
});

// Express routes case-insensitively, answers HEAD from the GET handler and routes
// an absolute-form target ("GET http://host/api/x") by the path inside it. An
// exact, case-sensitive string match missed all three, so any LAN client could
// read the settings or install a source just by changing the spelling.
test('isPrivilegedRoute sees through the spellings Express routes the same way', () => {
  for (const [method, url] of [
    ['GET', '/API/SETTINGS'],
    ['GET', '/api/Settings'],
    ['POST', '/Api/Repos'],
    ['DELETE', '/API/REPOS/?url=x'],
    ['POST', '/api/Sources/INSTALL'],
    ['HEAD', '/api/settings'],
    ['HEAD', '/api/backup/export'],
    ['GET', '/api/settings#frag'],
  ]) {
    assert.equal(isPrivilegedRoute(req({ method, originalUrl: url })), true, `${method} ${url}`);
  }
});

test('isPrivilegedRoute treats any non-origin-form target as privileged (parsers disagree on its path)', () => {
  for (const url of [
    'http://evil.example/api/settings',
    'http:///api/settings',
    'HTTP://x/API/settings',
    'ws:///api/sources/install',
    '*',
    'api/settings',
  ]) {
    assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: url })), true, url);
    assert.equal(isPrivilegedRoute(req({ method: 'POST', originalUrl: url })), true, url);
  }
});

// Express falls back to the legacy url.parse() when the target holds a '#' (or a tab,
// space...), and that parser turns backslashes into slashes — so this reaches the
// settings handler. Found by an attacker pass after the case/absolute-form fix.
test('isPrivilegedRoute treats a backslash or whitespace in the path as privileged', () => {
  const bs = String.fromCharCode(92);
  for (const [method, url] of [
    ['GET', `/api${bs}settings#x`],
    ['GET', `/api${bs}settings`],
    ['POST', `/api${bs}repos#`],
    ['POST', `/api/sources${bs}install#frag`],
    ['GET', '/api/settings\t#x'],
    ['GET', '/api/ settings#x'],
    ['GET', `/api/settings${String.fromCharCode(0xa0)}#x`],
  ]) {
    assert.equal(isPrivilegedRoute(req({ method, originalUrl: url })), true, JSON.stringify(url));
  }
  // The same characters AFTER the '?' belong to the query string and are fine.
  assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: `/api/library?q=a${bs}b c` })), false);
});

test('the backup export carries the stored credentials, so it is privileged too', () => {
  assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: '/api/backup/export' })), true);
  assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: '/api/backup' })), false);
});

test('HEAD on a reader route stays unprivileged', () => {
  assert.equal(isPrivilegedRoute(req({ method: 'HEAD', originalUrl: '/api/library' })), false);
});

test('every privileged route entry is a unique method+path', () => {
  const keys = PRIVILEGED_ROUTES.map((r) => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length);
  // isPrivilegedRoute compares against the lower-cased request path, so an
  // entry with capitals could never match.
  for (const r of PRIVILEGED_ROUTES) {
    assert.match(r.path, /^\/api\//);
    assert.equal(r.path, r.path.toLowerCase());
  }
});

test('requireLocalRequest lets a local request through and answers 403 LOCAL_ONLY otherwise', () => {
  let nextCalled = false;
  requireLocalRequest(req(), {}, () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  nextCalled = false;
  requireLocalRequest(req({ socket: { remoteAddress: '192.168.1.20' } }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'LOCAL_ONLY');
  assert.equal(res.body.ok, false);
  assert.doesNotMatch(res.body.error, /set an Access Password/, 'a route that no password opens must not say that one would');
  assert.match(res.body.error, /never available from another device/);
});

test('a request relayed by a local reverse proxy (tailscale serve, Caddy...) is never local', () => {
  // The proxy makes the peer 127.0.0.1, and the remote client chooses Host, so
  // "loopback + local Host" alone would let any proxied client through.
  for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'tailscale-user-login', 'tailscale-funnel-request']) {
    const proxied = req({ headers: { host: 'localhost:4000', [header]: 'x' } });
    assert.equal(isProxiedRequest(proxied), true, header);
    assert.equal(isLocalRequest(proxied), false, header);
  }
  assert.equal(isProxiedRequest(req()), false);
  assert.equal(isProxiedRequest({}), false);
});

test('the full-store backup export is a privileged route, like the settings it contains', () => {
  assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: '/api/backup/export' })), true);
});

test('isPrivilegedRoute sees the path the way Express routes it', () => {
  // Express matches case-insensitively, ignores #fragments, accepts absolute-form targets and serves HEAD from GET.
  for (const [method, url] of [
    ['GET', '/API/settings'],
    ['GET', '/Api/Backup/Export'],
    ['POST', '/API/REPOS/'],
    ['POST', '/api/repos#frag'],
    ['GET', 'http://anything/api/settings'],
    ['HEAD', '/api/settings'],
    ['head', '/api/backup/export?x=1'],
  ]) {
    assert.equal(isPrivilegedRoute(req({ method, originalUrl: url })), true, `${method} ${url}`);
  }
  for (const [method, url] of [
    ['HEAD', '/api/repos'], // HEAD maps to GET, and GET /api/repos is only a listing
    ['GET', '/api/settingsx'],
    ['GET', '/api/state'],
  ]) {
    assert.equal(isPrivilegedRoute(req({ method, originalUrl: url })), false, `${method} ${url}`);
  }
});

test('isAdminLocalOnly is off unless SCROLLSCAPE_ADMIN_LOCAL_ONLY=1', () => {
  assert.equal(isAdminLocalOnly({}), false);
  assert.equal(isAdminLocalOnly({ SCROLLSCAPE_ADMIN_LOCAL_ONLY: '0' }), false);
  assert.equal(isAdminLocalOnly({ SCROLLSCAPE_ADMIN_LOCAL_ONLY: '1' }), true);
});

test('isPrivilegedRoute cannot be fooled by request targets that parsers read differently', () => {
  // WHATWG URL reads "http:///api/settings" as host "api" + path "/settings"; Express reads path "/api/settings".
  for (const url of [
    'http:///api/settings',
    'HTTP:///api/settings',
    'https:///api/backup/export',
    'ftp:///api/settings',
    'ws:///api/settings',
    'http://anyhost/api/settings',
    'http://anyhost:4000/API/Settings?x=1#y',
    'http:/api/settings',
  ]) {
    assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: url })), true, url);
  }
  // Any non-origin-form target is privileged outright (the parsers disagree on its path),
  // even when it names an ordinary route; origin-form targets are matched exactly.
  for (const url of ['http:///api/state', 'http://host/api/settingsx']) {
    assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: url })), true, url);
  }
  for (const url of ['/api/state', '/api/settingsx', '/api/library?next=/api/settings']) {
    assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: url })), false, url);
  }
  // The shape an earlier "try every parser" matcher missed: empty authority + backslash.
  const backslash = String.fromCharCode(92);
  for (const url of [`http:///api${backslash}settings`, `ws:///api${backslash}sources/install`, `http:///api${backslash}auth/set-password`]) {
    assert.equal(isPrivilegedRoute(req({ method: 'POST', originalUrl: url })), true, url);
  }
});

test('isPrivilegedRoute stays cheap and fails closed on absurdly long paths', () => {
  // A path of thousands of slashes stalled the event loop when trailing slashes
  // were stripped with a regex; the check must be linear and treat it as privileged.
  const hostile = `/api${'/'.repeat(200000)}x`;
  const started = process.hrtime.bigint();
  assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: hostile })), true);
  assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: `/api/library?${'a'.repeat(200000)}` })), false);
  assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: `/api/settings${'/'.repeat(1000)}` })), true);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 200, `took ${elapsedMs} ms`);
});

// A loopback socket + local Host is also what the owner's browser produces when a page
// from another site (or FlareSolverr's Chrome following a redirect) makes the request.
// Browsers label those with Sec-Fetch-Site / Origin; curl, the Suwayomi bridge and the
// server's own calls send neither.
test('a browser-marked cross-site request is not local, whatever the socket says', () => {
  const withHeaders = (headers) => req({ headers: { host: 'localhost:4000', ...headers } });
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'Cross-Site' },
    { origin: 'null' },
    { origin: 'https://evil.example' },
    { origin: 'http://localhost:4001' },
    { origin: 'not a url' },
  ]) {
    assert.equal(isLocalRequest(withHeaders(headers)), false, JSON.stringify(headers));
  }
  for (const headers of [
    {},
    { 'sec-fetch-site': 'none' },
    { 'sec-fetch-site': 'same-origin' },
    { origin: 'http://localhost:4000', 'sec-fetch-site': 'same-origin' },
    { origin: 'HTTP://LOCALHOST:4000' },
  ]) {
    assert.equal(isLocalRequest(withHeaders(headers)), true, JSON.stringify(headers));
  }
});

test('addPrivilegedRoutes lets one edition guard its own routes, normalised and without duplicates', () => {
  const before = PRIVILEGED_ROUTES.length;
  addPrivilegedRoutes([{ method: 'post', path: '/API/Edition/Only' }, { method: 'POST', path: '/api/edition/only' }]);
  assert.equal(PRIVILEGED_ROUTES.length, before + 1);
  assert.equal(isPrivilegedRoute(req({ method: 'POST', originalUrl: '/api/EDITION/only' })), true);
  PRIVILEGED_ROUTES.splice(before); // leave the shared list as it was for the other tests
});

test('the error log (request URLs inside) is privileged', () => {
  assert.equal(isPrivilegedRoute(req({ method: 'GET', originalUrl: '/api/error-log?area=x' })), true);
  assert.equal(isPrivilegedRoute(req({ method: 'DELETE', originalUrl: '/api/error-log' })), true);
});

// A restriction that silently did nothing because of how it was spelled would fail open.
test('isAdminLocalOnly turns ON for anything that is not clearly "off"', () => {
  for (const on of ['1', 'true', 'TRUE', 'yes', 'on', 'y', 'enabled']) {
    assert.equal(isAdminLocalOnly({ SCROLLSCAPE_ADMIN_LOCAL_ONLY: on }), true, on);
  }
  for (const off of [undefined, '', '  ', '0', 'false', 'no', 'off', 'n']) {
    assert.equal(isAdminLocalOnly({ SCROLLSCAPE_ADMIN_LOCAL_ONLY: off }), false, String(off));
  }
});
