'use strict';

// Regressions that only show up in the packaged exe and that no other unit test notices:
//  - a module the server requires but pkg does not bundle (the exe dies at start with
//    "Cannot find module"),
//  - /api/error-log reading the read-only snapshot instead of the file the logger writes,
//  - server.js dropping the start-up guards (data-folder choice, single instance).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const ROOT = path.resolve(__dirname, '..', '..');

function filesUnder(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// "dir/**/*.js" and "dir/**/*" style patterns from package.json, as a prefix + optional extension.
function bundled(relativePath, patterns) {
  const normal = relativePath.split(path.sep).join('/');
  return patterns.some((pattern) => {
    const [prefix] = pattern.split('**');
    if (!normal.startsWith(prefix)) return false;
    return !pattern.endsWith('.js') || normal.endsWith('.js');
  });
}

test('every file the server requires by a relative path is bundled into the exe by package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).pkg;
  const patterns = [...pkg.assets, ...pkg.scripts];
  const sources = [path.join(ROOT, 'server.js'), ...filesUnder(path.join(ROOT, 'server'))];
  const requireRe = /require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  const missing = [];
  let checked = 0;
  for (const file of sources) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(requireRe)) {
      const target = path.resolve(path.dirname(file), match[1]);
      const resolved = [target, `${target}.js`, path.join(target, 'index.js'), `${target}.json`].find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (!resolved) continue; // a runtime-only or optional path; the unit suite loads the real ones
      checked++;
      const relative = path.relative(ROOT, resolved);
      if (!bundled(relative, patterns)) missing.push(`${path.relative(ROOT, file)} -> ${relative}`);
    }
  }
  assert.ok(checked > 100, `expected to check the whole require graph, checked ${checked}`);
  assert.deepEqual(missing, []);
});

test('the start-up guards are still wired into server.js', () => {
  const text = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(text, /resolveUserRootOrExit\(\{/, 'the data folder must be resolved (and a conflict reported) before anything reads it');
  assert.match(text, /guardSingleInstance\(\{/, 'a second copy on the same library must be refused');
  assert.ok(text.indexOf('resolveUserRootOrExit(') < text.indexOf('const DATA_DIR'), 'resolved before DATA_DIR is derived');
});

test('/api/error-log reads and clears the file the logger really writes (not the snapshot path)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-errlog-route-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logger = require('../../server/modules/error-logger');
  logger.configure(dir);
  await logger.recordError({ code: 'X', area: 'wiring', message: 'seen through the route' });

  const { registerHealthCheckRoutes } = require('../../server/routes/health-check');
  const app = express();
  registerHealthCheckRoutes(app);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const listed = await (await fetch(`${base}/api/error-log`)).json();
  assert.equal(JSON.stringify(listed).includes('seen through the route'), true);

  assert.equal((await fetch(`${base}/api/error-log`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'error-log.json'), 'utf8')), []);
});

// The FlareSolverr session pool is built switched OFF (every call is then the plain one-off request of
// 3.1.2), so forgetting to tell it the settings would quietly turn the feature off for good. These pin the
// three places that tell it, and the order that matters in each.
test('server.js tells the pool the settings after the library is read, and sweeps old sessions once FlareSolverr is up, before the startup health log', () => {
  const text = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const at = (needle) => {
    const index = text.indexOf(needle);
    assert.notEqual(index, -1, `server.js must contain ${needle}`);
    return index;
  };
  const read = at('storeModule.readStore()');
  const apply = at('applySolverSettings(getSolverPool(), store.settings');
  const sweep = at('sweepSolverOrphans(getSolverPool(), getFlaresolverrUrl)');
  const health = at('systemHealthService.logStartupHealth()');
  assert.ok(read < apply, 'the settings are applied to what was read from the library');
  assert.ok(apply < sweep, 'the pool is on before anything sweeps or probes');
  assert.ok(sweep < health, 'the sweep comes before the startup probes, which are the first jobs');
  assert.match(text.slice(read, apply), /\.then\(\(store\) =>/, 'applied inside the step that receives the store');
  assert.match(text.slice(apply, sweep), /flaresolverrReady/, 'the sweep waits for FlareSolverr to have had its chance to come up');
  assert.ok(at('server/modules/network/fetch-utils') < apply, 'the pool is required before the settings are applied to it');
  assert.ok(at('server/modules/network/solver-wiring') < apply, 'applySolverSettings is required before it is called');
});

test('POST /api/settings judges the pool settings before it reads the library and tells the pool after the disk write, before Discord', () => {
  const text = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'settings.js'), 'utf8');
  const index = (needle, from = 0) => {
    const found = text.indexOf(needle, from);
    assert.notEqual(found, -1, `routes/settings.js must contain ${needle}`);
    return found;
  };
  index('parseSolverSettingsUpdate(req.body');
  const judged = index("app.post('/api/settings', judgeSolverSettings");
  const readFirst = index('await readStore();', judged);
  const patched = index('Object.assign(store.settings, req.solverSettingsPatch)');
  const written = index('await writeStore(store)');
  const flushed = index('flushNow();', written);
  const told = index('applySolver(store.settings)');
  const discord = index('discordRpc.applySettings(store.settings)');
  assert.ok(judged < readFirst, 'a bad value is refused in the first step of the route, before anything is read');
  assert.ok(readFirst < patched && patched < written, 'the validated values are stored with the save');
  assert.ok(flushed < told && told < discord, 'the pool is told once the settings are safely on disk');
});

test('every module the pool is built from is bundled into the exe by package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).pkg;
  const patterns = [...pkg.assets, ...pkg.scripts];
  const files = [
    'server/config/solver.js',
    'server/modules/common/host-utils.js',
    'server/modules/common/env-flags.js',
    'server/modules/common/solver-settings.js',
    'server/modules/common/settings-fields.js',
    'server/modules/network/solver-pool.js',
    'server/modules/network/solver-context.js',
    'server/modules/network/solver-call.js',
    'server/modules/network/single-flight.js',
    'server/modules/network/solver-wiring.js',
    'server/modules/network/solver/intake.js',
    'server/modules/network/solver/site-limit.js',
    'server/modules/system-health/solver-rows.js',
  ];
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    assert.ok(bundled(file, patterns), `${file} would be missing from the exe`);
  }
});
