'use strict';

// The Windows Firewall rules of the Suwayomi-Server this app runs (server/modules/suwayomi/local-firewall.js) and the routes that drive the set-up
// (server/routes/suwayomi.js, /api/suwayomi/local/*). Nothing is installed or started: the server and the firewall are replaced. What matters: a program
// path can only ever be quoted text in the script, Windows' own prompt is what grants the rights, nothing is downloaded without the person's yes, and every
// one of these routes starts, stops or removes a program, so they answer this computer only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const config = require('../../server/config/suwayomi-local');
const { createFirewall, rulesScript } = require('../../server/modules/suwayomi/local-firewall');
const { registerSuwayomiRoutes } = require('../../server/routes/suwayomi');
const { isPrivilegedRoute } = require('../../server/middleware/local-only');
const { copySettingsFields } = require('../../server/modules/common/settings-fields');
const { SAVED_SETTINGS_FIELDS } = require('../../server/routes/settings');

// ── the rules ────────────────────────────────────────────────────────────

test('the script blocks the home network for each program, and removing it adds nothing', () => {
  const add = rulesScript('add', ['C:\\S\\jre\\bin\\javaw.exe', 'C:\\S\\jre\\bin\\java.exe']);
  assert.equal((add.match(/New-NetFirewallRule/g) || []).length, 2);
  for (const range of config.blockedRanges) assert.ok(add.includes(`'${range}'`), range);
  assert.ok(add.includes('-Direction Outbound -Action Block') && add.includes(`'${config.firewallRuleName}'`));
  assert.ok(add.indexOf('Remove-NetFirewallRule') < add.indexOf('New-NetFirewallRule'), 'the old rules go first, so adding twice does not pile up');
  const remove = rulesScript('remove', ['C:\\S\\javaw.exe']);
  assert.ok(remove.includes('Remove-NetFirewallRule') && !remove.includes('New-NetFirewallRule'));
});

test('a program path is only ever quoted text: a quote in a folder name cannot end the quote', () => {
  const script = rulesScript('add', ["C:\\it's\\javaw.exe"]);
  assert.ok(script.includes("-Program 'C:\\it''s\\javaw.exe'"));
  const nasty = rulesScript('add', ["C:\\a'; Remove-Item C:\\ -Recurse; '\\javaw.exe"]);
  assert.ok(nasty.includes("'C:\\a''; Remove-Item C:\\ -Recurse; ''\\javaw.exe'"), 'every quote is doubled, so the whole path stays one string');
});

test('the rules are asked about with no rights, and only on Windows', async () => {
  const asked = [];
  const present = createFirewall({ platform: 'win32', execFileImpl: async (file, args) => { asked.push([file, ...args]); return { stdout: `Rule Name:  ${config.firewallRuleName}\nEnabled: Yes` }; } });
  assert.equal(await present.status(), true);
  assert.deepEqual(asked[0].slice(0, 5), ['netsh', 'advfirewall', 'firewall', 'show', 'rule']);
  assert.equal(await createFirewall({ platform: 'win32', execFileImpl: async () => ({ stdout: 'No rules match the specified criteria.' }) }).status(), false);
  assert.equal(await createFirewall({ platform: 'win32', execFileImpl: async () => { throw new Error('boom'); } }).status(), false);
  assert.equal(await createFirewall({ platform: 'linux' }).status(), null, 'it cannot be asked on another system');
});

test('applying the rules writes the script, asks Windows through its own prompt, and trusts the rules only if they are there afterwards', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-fw-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  let there = false;
  const make = (code) => createFirewall({
    platform: 'win32',
    execFileImpl: async () => ({ stdout: there ? config.firewallRuleName : 'No rules match the specified criteria.' }),
    runElevated: async (file, args, options) => { calls.push({ file, args, options }); if (code === 0) there = !there; return code; },
  });
  assert.deepEqual(await make(0).apply('add', { root, programs: ['C:\\S\\javaw.exe'] }), { ok: true });
  const [call] = calls;
  assert.equal(call.file, 'powershell.exe');
  assert.ok(call.args.join(' ').includes('-Verb RunAs'), 'Windows asks the person');
  assert.equal(call.options.env.SCROLLSCAPE_FIREWALL_SCRIPT, path.join(root, 'firewall-rules.ps1'), 'the path travels in the environment, not in the command');
  assert.ok(!call.args.join(' ').includes(root), 'the command text holds no path');
  assert.ok(fs.readFileSync(path.join(root, 'firewall-rules.ps1'), 'utf8').includes('New-NetFirewallRule'));
  there = false;
  assert.deepEqual(await make(1).apply('add', { root, programs: ['C:\\S\\javaw.exe'] }), { ok: false }, 'a refusal is an answer');
  assert.deepEqual(await make(0).apply('add', { root, programs: ['C:\\S\\javaw.exe'] }), { ok: true });
  assert.deepEqual(await make(0).apply('remove', { root, programs: [] }), { ok: true });
});

test('the firewall is only for Windows, only add or remove, and only with a server to name', async () => {
  const win = createFirewall({ platform: 'win32', runElevated: async () => 0, execFileImpl: async () => ({ stdout: '' }) });
  await assert.rejects(createFirewall({ platform: 'linux' }).apply('add', { root: os.tmpdir(), programs: ['x'] }), (err) => err.statusCode === 409);
  await assert.rejects(win.apply('flush', { root: os.tmpdir(), programs: ['x'] }), (err) => err.statusCode === 400);
  await assert.rejects(win.apply('add', { root: os.tmpdir(), programs: [] }), (err) => err.statusCode === 409);
});

// ── the routes ───────────────────────────────────────────────────────────

function fakeServer(root, over = {}) {
  const calls = [];
  const server = {
    calls,
    layout: () => ({ root, app: path.join(root, 'app') }),
    status: async () => ({ supported: true, reason: '', version: 'v1', sizeBytes: 5, installed: false, running: false, phase: 'idle', received: 0, total: 5, message: '' }),
    startInstall: () => { calls.push('install'); return { started: true }; },
    start: async () => { calls.push('start'); return { already: false }; },
    stop: async () => { calls.push('stop'); },
    uninstall: async () => { calls.push('uninstall'); return { removed: true }; },
    ...over,
  };
  return server;
}

async function startApp(t, { server, firewall, settings = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app', 'top', 'jre', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app', 'top', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'top', 'jre', 'bin', 'javaw.exe'), '');
  fs.writeFileSync(path.join(root, 'app', 'top', 'bin', 'Suwayomi-Server.jar'), '');
  const saved = [];
  const store = {
    readStore: async () => ({ settings: { ...settings } }),
    writeStore: async (data) => { saved.push(JSON.parse(JSON.stringify(data))); },
    flushNow: () => {},
  };
  const localServer = server || fakeServer(root);
  const fw = firewall || { calls: [], status: async () => null, apply: async () => ({ ok: true }) };
  const app = express();
  app.use(express.json());
  registerSuwayomiRoutes(app, { userRoot: () => root, store, localServer, firewall: fw, service: { testConnection: async () => ({ ok: true, sourceCount: 1 }) } });
  const http_ = await new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => { http_.closeAllConnections(); http_.close(resolve); }));
  const port = http_.address().port;
  const call = (method, route, body, headers = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  return { call, saved, localServer, fw, root };
}

test('the status says where it stands and whether it starts with the app, and asks the firewall only once there is a server', async (t) => {
  const idle = await startApp(t);
  const first = (await idle.call('GET', '/api/suwayomi/local/status')).json();
  assert.deepEqual([first.ok, first.installed, first.firewall, first.autoStart], [true, false, null, true]);
  const asked = [];
  const there = await startApp(t, {
    settings: { suwayomiLocalAutoStart: false },
    server: fakeServer('C:\\x', { status: async () => ({ supported: true, installed: true, running: true, phase: 'done' }) }),
    firewall: { status: async () => { asked.push(1); return true; }, apply: async () => ({ ok: true }) },
  });
  const second = (await there.call('GET', '/api/suwayomi/local/status')).json();
  assert.deepEqual([second.installed, second.running, second.firewall, second.autoStart], [true, true, true, false]);
  assert.equal(asked.length, 1);
  assert.ok(!JSON.stringify(second).toLowerCase().includes('password'), 'no password in a status');
});

test('nothing is downloaded without the yes, and a set-up that cannot start says why', async (t) => {
  const { call, localServer } = await startApp(t);
  for (const body of [undefined, {}, { acknowledge: 'yes' }, { acknowledge: 1 }]) {
    const refused = await call('POST', '/api/suwayomi/local/install', body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(localServer.calls, []);
  const answer = await call('POST', '/api/suwayomi/local/install', { acknowledge: true });
  assert.deepEqual([answer.status, answer.json()], [200, { ok: true, started: true }]);
  assert.deepEqual(localServer.calls, ['install']);
  const busy = await startApp(t, { server: fakeServer('C:\\x', { startInstall: () => { throw Object.assign(new Error('The setup is already running.'), { statusCode: 409 }); } }) });
  const conflict = await busy.call('POST', '/api/suwayomi/local/install', { acknowledge: true });
  assert.equal(conflict.status, 409);
  assert.match(conflict.json().error, /already running/);
});

test('start, stop and remove do what they say; remove asks to be confirmed and says when files are in use', async (t) => {
  const { call, localServer } = await startApp(t);
  assert.equal((await call('POST', '/api/suwayomi/local/start')).status, 200);
  assert.equal((await call('POST', '/api/suwayomi/local/stop')).status, 200);
  assert.equal((await call('POST', '/api/suwayomi/local/uninstall', {})).status, 400);
  assert.equal((await call('POST', '/api/suwayomi/local/uninstall', { confirm: 'true' })).status, 400);
  assert.deepEqual(localServer.calls, ['start', 'stop']);
  assert.equal((await call('POST', '/api/suwayomi/local/uninstall', { confirm: true })).status, 200);
  assert.deepEqual(localServer.calls, ['start', 'stop', 'uninstall']);
  const down = await startApp(t, { server: fakeServer('C:\\x', { start: async () => { throw Object.assign(new Error('Suwayomi is not set up on this computer yet.'), { statusCode: 409 }); } }) });
  const answer = await down.call('POST', '/api/suwayomi/local/start');
  assert.deepEqual([answer.status, answer.json().ok], [409, false]);
});

test('the firewall route names the programs of the server itself, never a path from the request', async (t) => {
  const applied = [];
  const { call, root } = await startApp(t, { firewall: { status: async () => true, apply: async (action, where) => { applied.push([action, where]); return { ok: true }; } } });
  const answer = await call('POST', '/api/suwayomi/local/firewall', { action: 'add', programs: ['C:\\Windows\\System32\\cmd.exe'], root: 'C:\\' });
  assert.deepEqual([answer.status, answer.json().applied, answer.json().firewall], [200, true, true]);
  const [[action, where]] = applied;
  assert.equal(action, 'add');
  assert.equal(where.root, root);
  assert.deepEqual(where.programs.map((p) => path.basename(p)), ['javaw.exe', 'java.exe'], 'what the app found in the Suwayomi folder');
  assert.ok(where.programs.every((p) => p.startsWith(root)));
  assert.equal((await call('POST', '/api/suwayomi/local/firewall', { action: 'delete' })).status, 400);
  assert.equal((await call('POST', '/api/suwayomi/local/firewall', {})).status, 400);
  assert.equal(applied.length, 1);
});

test('start with the app is saved as a setting and only a true or a false is taken', async (t) => {
  const { call, saved } = await startApp(t, { settings: { keep: 'me' } });
  const off = await call('POST', '/api/suwayomi/local/autostart', { enabled: false });
  assert.deepEqual(off.json(), { ok: true, autoStart: false });
  assert.deepEqual(saved[0].settings, { keep: 'me', suwayomiLocalAutoStart: false });
  for (const bad of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }]) assert.equal((await call('POST', '/api/suwayomi/local/autostart', bad)).status, 400, JSON.stringify(bad));
  assert.equal(saved.length, 1);
  const kept = {};
  copySettingsFields(kept, { suwayomiLocalAutoStart: false }, SAVED_SETTINGS_FIELDS);
  assert.equal(kept.suwayomiLocalAutoStart, false, 'the settings screen can read and keep it');
  copySettingsFields(kept, { suwayomiLocalAutoStart: 'no' }, SAVED_SETTINGS_FIELDS);
  assert.equal(kept.suwayomiLocalAutoStart, false, 'a value of another type changes nothing');
  assert.ok(SAVED_SETTINGS_FIELDS.some(([key, type]) => key === 'suwayomiLocalAutoStart' && type === 'boolean'));
});

test('every route of the set-up is on the guard list and answers nothing to a request that is not from this computer', async (t) => {
  const routes = [['GET', 'status'], ['POST', 'install'], ['POST', 'start'], ['POST', 'stop'], ['POST', 'uninstall'], ['POST', 'firewall'], ['POST', 'autostart']];
  const { call, localServer, saved } = await startApp(t);
  for (const [method, name] of routes) {
    const route = `/api/suwayomi/local/${name}`;
    assert.equal(isPrivilegedRoute({ method, originalUrl: route }), true, route);
    const refused = await call(method, route, method === 'POST' ? { acknowledge: true, confirm: true, action: 'add', enabled: true } : undefined, { Host: 'localhost.evil.example' });
    assert.equal(refused.status, 403, route);
    const proxied = await call(method, route, method === 'POST' ? { acknowledge: true } : undefined, { 'X-Forwarded-For': '203.0.113.9' });
    assert.equal(proxied.status, 403, `${route} relayed by a proxy`);
  }
  assert.deepEqual([localServer.calls, saved], [[], []], 'nothing was done for any of them');
});

test('the install route is limited, so a page cannot ask it over and over', async (t) => {
  const { call } = await startApp(t);
  let last = 0;
  for (let i = 0; i < 40 && last !== 429; i += 1) last = (await call('POST', '/api/suwayomi/local/start')).status;
  assert.equal(last, 429);
});
