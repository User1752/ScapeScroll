'use strict';

// Setting up a Suwayomi-Server on a Windows computer: tools/windows/Setup-Suwayomi.cmd installs one that listens only on this computer and writes how to reach
// it to a file in the person's profile; the app reads that one file and saves it in the settings ("Connect to the Suwayomi on this computer"). What matters:
// the file is at a fixed place and can only name this computer, a password never comes back in an answer, the route stays on this computer, and the script
// pins one version with the SHA-256 GitHub lists for it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { connectionFilePath, suwayomiFolder, bakeSetupScript, setupScriptPath, readLocalConnection, MAX_FILE_BYTES } = require('../../server/modules/suwayomi/local-setup');
const { registerSuwayomiRoutes } = require('../../server/routes/suwayomi');
const { isPrivilegedRoute } = require('../../server/middleware/local-only');

const SCRIPT = path.join(__dirname, '..', '..', 'tools', 'windows', 'Setup-Suwayomi.cmd');
const good = { url: 'http://127.0.0.1:4567', username: 'scrollscape', password: 'Ab3dEfGh7JkLmNpQrStUvWxYz2' };
const reading = (data) => () => Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));

// ── the file ─────────────────────────────────────────────────────────────

test('everything of the script is in a Suwayomi folder inside the ScrollScape folder, so it moves and is deleted with it', () => {
  assert.equal(suwayomiFolder('C:\\Users\\a\\Desktop\\ScrollScape'), path.join('C:\\Users\\a\\Desktop\\ScrollScape', 'Suwayomi'));
  assert.equal(connectionFilePath('C:\\Users\\a\\Desktop\\ScrollScape'), path.join('C:\\Users\\a\\Desktop\\ScrollScape', 'Suwayomi', 'connection.json'));
  for (const none of ['', undefined, null]) assert.equal(connectionFilePath(none), '');
});

test('the app fills its own folder into the script it hands out, and only when that folder is safe to put in a batch file', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.equal(text.split('set "SS_ROOT="').length, 2, 'the script has exactly one place for the folder');
  const baked = bakeSetupScript(text, 'C:\\Users\\a\\Desktop\\ScrollScape');
  assert.ok(baked.includes('set "SS_ROOT=' + path.join('C:\\Users\\a\\Desktop\\ScrollScape', 'Suwayomi') + '"'));
  assert.equal(baked.length - text.length, path.join('C:\\Users\\a\\Desktop\\ScrollScape', 'Suwayomi').length, 'nothing else changed');
  assert.ok(bakeSetupScript(text, '\\\\nas\\media\\ScrollScape').includes('set "SS_ROOT=\\\\nas'), 'a network folder works too');
  for (const unsafe of ['C:\\a"b', 'C:\\100%', 'C:\\a^b', 'C:\\a&b', 'C:\\a|b', 'C:\\a<b', 'C:\\a!b', 'C:\\a\nb', 'relative\\folder', '/home/a', '', null, undefined]) {
    assert.equal(bakeSetupScript(text, unsafe), text, JSON.stringify(unsafe));
  }
  assert.equal(bakeSetupScript('no marker here', 'C:\\a'), 'no marker here');
});

test('what the script writes is read; the password is plain text of the shape the script makes', () => {
  assert.deepEqual(readLocalConnection({ file: 'x', readFile: reading(good) }), good);
  assert.deepEqual(readLocalConnection({ file: 'x', readFile: reading(`\uFEFF${JSON.stringify(good)}`) }), good, 'a byte-order mark does not matter');
  assert.deepEqual(readLocalConnection({ file: 'x', readFile: reading({ ...good, url: 'http://localhost:4600' }) }).url, 'http://localhost:4600');
});

test('a file that is missing, damaged or names another place is refused, each with its own sentence and status', () => {
  const refused = (over, status, re) => assert.throws(() => readLocalConnection({ file: 'x', readFile: reading(over) }), (err) => err.statusCode === status && re.test(err.message), JSON.stringify(over).slice(0, 80));
  assert.throws(() => readLocalConnection({ file: '' }), (err) => err.statusCode === 404);
  assert.throws(() => readLocalConnection({ file: 'x', readFile: () => { throw new Error('ENOENT'); } }), (err) => err.statusCode === 404 && /Setup-Suwayomi/.test(err.message));
  refused('not json', 422, /not readable/);
  refused('[]', 422, /not this computer/);
  for (const url of ['http://evil.example:4567', 'http://127.0.0.1.evil.example:4567', 'https://127.0.0.1:4567', 'http://127.0.0.1', 'http://127.0.0.1:80', 'http://127.0.0.1:99999', 'http://user@127.0.0.1:4567', 'http://127.0.0.1:4567/x', 'http://192.168.1.97:4567', 'javascript:alert(1)', 5, null]) refused({ ...good, url }, 422, /not this computer/);
  for (const bad of ['', 'a b', 'a\nb', 'x'.repeat(101), '"><img>', 7, null]) {
    refused({ ...good, username: bad }, 422, /user or password/);
    refused({ ...good, password: bad }, 422, /user or password/);
  }
  refused({ ...good, padding: 'x'.repeat(MAX_FILE_BYTES) }, 422, /larger/);
});

test('the setup script is found next to the app, and a build without it says so', () => {
  assert.equal(setupScriptPath(path.join(__dirname, '..', '..')), SCRIPT);
  assert.equal(setupScriptPath(path.join(__dirname, 'no-such-folder')), '');
});

// ── the routes ───────────────────────────────────────────────────────────

async function start(t, over = {}) {
  const saved = [];
  const store = {
    readStore: async () => ({ settings: { keep: 'me' } }),
    writeStore: async (data) => { saved.push(JSON.parse(JSON.stringify(data))); },
    flushNow: () => { saved.push('flushed'); },
  };
  const app = express();
  app.use(express.json());
  registerSuwayomiRoutes(app, { userRoot: () => 'C:\\Library', readConnection: () => good, scriptPath: () => SCRIPT, service: { testConnection: async () => ({ ok: true, sourceCount: 3 }) }, store, ...over });
  const server = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  const call = (method, route, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  return { call, saved };
}

test('connecting saves the three settings, keeps the others, never sends the password back, and says whether the server answers', async (t) => {
  const asked = [];
  const { call, saved } = await start(t, { readConnection: (options) => { asked.push(options.file); return good; } });
  const answer = await call('POST', '/api/suwayomi/connect-local');
  assert.equal(answer.status, 200);
  assert.deepEqual(asked, [connectionFilePath('C:\\Library')], 'the file is the one in the Suwayomi folder of this app, never a path from the request');
  const body = JSON.parse(answer.text);
  assert.deepEqual(body, { ok: true, saved: true, reachable: true, sourceCount: 3, url: good.url, username: good.username });
  assert.ok(!answer.text.includes(good.password), 'the password is not in the answer');
  assert.deepEqual(saved[0].settings, { keep: 'me', suwayomiUrl: good.url, suwayomiUsername: good.username, suwayomiPassword: good.password });
  assert.equal(saved[1], 'flushed');
  const down = await start(t, { service: { testConnection: async () => { throw new Error('ECONNREFUSED'); } } });
  const waiting = JSON.parse((await down.call('POST', '/api/suwayomi/connect-local')).text);
  assert.deepEqual({ saved: waiting.saved, reachable: waiting.reachable, sourceCount: waiting.sourceCount }, { saved: true, reachable: false, sourceCount: null }, 'saved even when it is still starting');
});

test('a file that cannot be used saves nothing and answers with its own sentence', async (t) => {
  const { call, saved } = await start(t, { readConnection: () => { throw Object.assign(new Error('No Suwayomi set up on this computer was found. Run Setup-Suwayomi.cmd first.'), { statusCode: 404 }); } });
  const answer = await call('POST', '/api/suwayomi/connect-local');
  assert.equal(answer.status, 404);
  assert.match(JSON.parse(answer.text).error, /Setup-Suwayomi/);
  assert.deepEqual(saved, []);
});

test('the connect route is on the guard list and answers nothing to a request that is not from this computer', async (t) => {
  assert.equal(isPrivilegedRoute({ method: 'POST', originalUrl: '/api/suwayomi/connect-local' }), true);
  const { call, saved } = await start(t);
  const refused = await call('POST', '/api/suwayomi/connect-local', { Host: 'localhost.evil.example' });
  assert.equal(refused.status, 403);
  assert.deepEqual(saved, []);
});

test('the script is offered as a download of exactly that file, and a build without it answers 404', async (t) => {
  const { call } = await start(t);
  const answer = await call('GET', '/api/suwayomi/windows-setup.cmd');
  assert.equal(answer.status, 200);
  assert.match(answer.headers['content-disposition'], /attachment; filename="Setup-Suwayomi\.cmd"/);
  assert.equal(answer.headers['x-content-type-options'], 'nosniff');
  assert.equal(answer.text, bakeSetupScript(fs.readFileSync(SCRIPT, 'utf8'), 'C:\\Library'), 'the folder of this app is filled in');
  assert.ok(answer.text.includes('set "SS_ROOT=' + path.join('C:\\Library', 'Suwayomi') + '"'));
  const none = await start(t, { scriptPath: () => '' });
  assert.equal((await none.call('GET', '/api/suwayomi/windows-setup.cmd')).status, 404);
});

// ── the script itself ────────────────────────────────────────────────────

test('the script pins one version and the SHA-256 GitHub lists for it, is plain ASCII with Windows line ends, and ships in the executable', () => {
  const bytes = fs.readFileSync(SCRIPT);
  assert.ok(bytes.every((b) => b < 128), 'plain ASCII: a batch file read with another code page must not change');
  const text = bytes.toString('ascii');
  assert.ok(!/[^\r]\n/.test(text), 'every line ends with CR LF: a batch file with bare line feeds can misread its labels');
  assert.match(text, /\$Tag\s+= 'v\d+\.\d+\.\d+'/);
  assert.match(text, /\$Sha256\s+= '[0-9a-f]{64}'/);
  assert.match(text, /\$Size\s+= \d{6,}/);
  assert.ok(text.includes('Get-FileHash -Algorithm SHA256') && /-ne \$Sha256/.test(text), 'the download is checked against that SHA-256 and refused when it differs');
  assert.ok(text.includes('server.ip = "127.0.0.1"') && text.includes('server.authMode = "basic_auth"'), 'listens only on this computer, with a login');
  assert.ok(/Ask 'Continue\?'/.test(text), 'it asks before it changes anything');
  assert.ok(/\/dryrun/.test(text) && /\/uninstall/.test(text));
  assert.ok(text.includes('/user') && text.includes('/pass') && text.includes("'^[A-Za-z0-9._-]{1,100}$'"), 'a login of the person own, of the characters the app accepts');
  assert.ok(/\$Secret\s+= \[string\]\$env:SS_PASS/.test(text) && text.includes('New-Secret 28'), 'the default password is long and random, not a preset');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.ok(pkg.pkg.assets.includes('tools/windows/Setup-Suwayomi.cmd'), 'the executable carries the script, so the app can offer it');
});
