'use strict';

// The note under the "Protected sites" switch says when the environment variable overrides it. The server lets the
// switch decide for every value that means off (unset, empty, 0, false, no, off, n), so the note must not say that the
// variable overrides the switch whenever it is "set". The truth is read from the server's own resolver.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { ENV_NAMES } = require('../../server/config/solver');
const { FLAG_OFF, FLAG_ON } = require('../../server/modules/common/env-flags');
const { resolveSolverSettings } = require('../../server/modules/network/solver-wiring');

const NAME = ENV_NAMES.solverSessionsDisabled;
const LOCALES_DIR = path.join(__dirname, '..', '..', 'public', 'modules', 'i18n', 'locales');

function locale(name) {
  const sandbox = vm.createContext({ window: {} });
  vm.runInContext(fs.readFileSync(path.join(LOCALES_DIR, name + '.js'), 'utf8'), sandbox);
  return sandbox.window.ScrollScapeI18nLocales[name];
}

const EN = locale('en-GB');
const PT = locale('pt-PT');

test('the server lets the switch decide for every off value, and the variable decides for an on value', () => {
  const switchedOn = { solverSessionsEnabled: true };
  const resolve = (env) => resolveSolverSettings(switchedOn, env);
  for (const value of FLAG_OFF) assert.equal(resolve({ [NAME]: value }).enabled, true, `"${value}" leaves the switch in charge`);
  for (const value of FLAG_ON) assert.equal(resolve({ [NAME]: value }).disabledBy, 'env', `"${value}" overrides the switch`);
  assert.equal(resolve({}).enabled, true);
});

test('the card note says what the variable does in both languages, and not just that it is "set"', () => {
  assert.ok(EN['settings.solver.envNote'].includes(NAME));
  assert.ok(PT['settings.solver.envNote'].includes(NAME));
  assert.match(EN['settings.solver.envNote'], /turned on[^.]*overrides this switch; unset or set to 0, it does not\.$/);
  assert.match(PT['settings.solver.envNote'], /ativada[^.]*sobrepõe-se a este interruptor; não definida ou definida como 0, não se sobrepõe\.$/);
  assert.ok(!/is set, it overrides/.test(EN['settings.solver.envNote']));
  assert.ok(!/estiver definida, sobrepõe/.test(PT['settings.solver.envNote']));
});

test('the two languages still carry the same card keys', () => {
  const keys = (strings) => Object.keys(strings).filter((key) => key.startsWith('settings.solver.')).sort();
  assert.deepEqual(keys(PT), keys(EN));
});
