'use strict';

// The "Protected sites" card (public/modules/ui-settings-solver.js): a save that finishes while the user is already
// typing a new number into the same field must not write its own value over the characters being typed. Typing fires
// only "input" (the controller's edit()); the value is committed later by "change". The controller is run over a view
// that only records what it was told to show, so no DOM is needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULE_FILE = path.join(__dirname, '..', '..', 'public', 'modules', 'ui-settings-solver.js');
const POOL = 'solverSessionPoolSize';

function loadController(request) {
  const sandbox = { t: (key) => key, escapeHtml: String, document: {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_FILE, 'utf8'), sandbox);
  const log = [];
  const view = {
    show: (key, value) => log.push(['show', key, value]),
    error: (key, text) => log.push(['error', key, text]),
    busy() {},
    loadFailed() {},
  };
  const controller = sandbox.createSolverSettingsController({ api: request, view });
  return { controller, log, screen: (kind) => log.filter(([what, key]) => what === kind && key === POOL) };
}

const deferred = () => { const d = {}; d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; }); return d; };

test('a save that finishes while the user is typing the next value does not reset the field', async () => {
  const answer = deferred();
  const { controller, log, screen } = loadController(() => answer.promise);

  const saved = controller.change(POOL, '3'); // the POST is in flight
  controller.edit(POOL); // the user selects the field and types: only "input" fires
  log.length = 0;
  answer.resolve({ ok: true });

  assert.equal(await saved, true);
  assert.deepEqual(screen('show'), [], 'the confirmed 3 is not written over what is being typed');
  assert.equal(controller.committed()[POOL], 3, 'the server did confirm it');
});

test('a refused save that finishes while the user is typing neither resets the field nor shows its refusal', async () => {
  const answer = deferred();
  const { controller, log, screen } = loadController(() => answer.promise);

  const saved = controller.change(POOL, '9');
  controller.edit(POOL);
  log.length = 0;
  answer.reject(new Error('solverSessionPoolSize must be a whole number from 1 to 3.'));

  assert.equal(await saved, false);
  assert.deepEqual(screen('show'), []);
  assert.deepEqual(screen('error'), [], 'the refusal belonged to the value the user is replacing');
  assert.equal(controller.committed()[POOL], 2, 'still the default: nothing was confirmed');
});

test('once the typed value is committed it is saved and shown like any other', async () => {
  const first = deferred();
  const posts = [];
  const { controller, log, screen } = loadController((route, opts) => {
    if (!opts) return Promise.resolve({ ok: true, data: {} });
    posts.push(JSON.parse(opts.body));
    return posts.length === 1 ? first.promise : Promise.resolve({ ok: true });
  });

  const one = controller.change(POOL, '3');
  controller.edit(POOL);
  const two = controller.change(POOL, '1'); // the user commits what they typed
  log.length = 0;
  first.resolve({ ok: true });
  await Promise.all([one, two]);

  assert.deepEqual(posts, [{ [POOL]: 3 }, { [POOL]: 1 }]);
  assert.deepEqual(screen('show'), [['show', POOL, 1]], 'only the last save touches the screen, with its own value');
  assert.equal(controller.committed()[POOL], 1);
});

test('without any typing a finished save still confirms the value on screen', async () => {
  const { controller, screen } = loadController(() => Promise.resolve({ ok: true }));
  assert.equal(await controller.change(POOL, '3'), true);
  assert.deepEqual(screen('show'), [['show', POOL, 3]]);
});
