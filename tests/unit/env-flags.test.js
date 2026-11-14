'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FLAG_ON, FLAG_OFF, flagState, warnOnce, shown } = require('../../server/modules/common/env-flags');

// flagState moved here unchanged from flaresolverr-lifecycle.js, so these are
// the spellings its tests (FLARESOLVERR_DISABLED, FLARESOLVERR_AUTO_INSTALL)
// already rely on.

// The definitions as flaresolverr-lifecycle.js had them (lines 70-90 of v3.1.2)
// before they moved here, kept verbatim as the reference the move is held to.
// The lifecycle tests (isDisabled / isAutoInstallEnabled) go on proving the same
// behaviour from the other side once that module imports this one.
const FORMER_FLAG_ON = new Set(['1', 'true', 'yes', 'on', 'y']);
const FORMER_FLAG_OFF = new Set(['', '0', 'false', 'no', 'off', 'n']);

function formerFlagState(env, name) {
  const raw = String((env && env[name]) ?? '').trim().toLowerCase();
  if (FORMER_FLAG_ON.has(raw)) return 'on';
  if (FORMER_FLAG_OFF.has(raw)) return 'off';
  return 'unknown';
}

// Every spelling flaresolverr-lifecycle.test.js feeds FLARESOLVERR_DISABLED and
// FLARESOLVERR_AUTO_INSTALL, with what the lifecycle reads from it.
const LIFECYCLE_SPELLINGS = {
  on: ['1', 'true', 'TRUE', 'yes', 'on', 'y', 'Y', ' 1 '],
  off: ['', '0', 'false', 'no', 'off', 'n', 'N'],
  unknown: ['perhaps', 'switched-off', 'nope'],
};

test('the lifecycle tests\' spellings read exactly as they did before the move', () => {
  assert.deepEqual([...FLAG_ON], [...FORMER_FLAG_ON]);
  assert.deepEqual([...FLAG_OFF], [...FORMER_FLAG_OFF]);
  for (const [expected, spellings] of Object.entries(LIFECYCLE_SPELLINGS)) {
    for (const spelling of spellings) {
      const env = { FLARESOLVERR_DISABLED: spelling };
      assert.equal(flagState(env, 'FLARESOLVERR_DISABLED'), expected, JSON.stringify(spelling));
      assert.equal(flagState(env, 'FLARESOLVERR_DISABLED'), formerFlagState(env, 'FLARESOLVERR_DISABLED'), JSON.stringify(spelling));
    }
  }
  assert.equal(flagState({}, 'FLARESOLVERR_DISABLED'), 'off', 'unset');
  assert.equal(flagState({ FLARESOLVERR_AUTO_INSTALL: 'y' }, 'FLARESOLVERR_AUTO_INSTALL'), 'on');
});

test('flagState agrees with the former definition on every short string over the characters that matter', () => {
  const pieces = ['', ' ', '\t', '0', '1', '2', 'y', 'Y', 'e', 's', 'n', 'N', 'o', 'f', 'r', 'u', 't', '-'];
  let checked = 0;
  for (const a of pieces) {
    for (const b of pieces) {
      for (const c of pieces) {
        const spelling = a + b + c;
        const env = { SWITCH: spelling };
        assert.equal(flagState(env, 'SWITCH'), formerFlagState(env, 'SWITCH'), JSON.stringify(spelling));
        checked++;
      }
    }
  }
  assert.equal(checked, pieces.length ** 3);
  for (const word of ['true', 'false', 'yes', 'no', 'on', 'off', 'TRUE', 'False', ' yes ', 'oN', 'nO', 'trUe ']) {
    const env = { SWITCH: word };
    assert.equal(flagState(env, 'SWITCH'), formerFlagState(env, 'SWITCH'), JSON.stringify(word));
  }
  for (const odd of [undefined, null, 0, 1, 2, true, false, {}, [], NaN]) {
    const env = { SWITCH: odd };
    assert.equal(flagState(env, 'SWITCH'), formerFlagState(env, 'SWITCH'), String(odd));
  }
  for (const env of [undefined, null, {}, 'not an object', 5]) {
    assert.equal(flagState(env, 'SWITCH'), formerFlagState(env, 'SWITCH'), String(env));
  }
});

test('the on and off spellings are the ones the FlareSolverr switches always had', () => {
  assert.deepEqual([...FLAG_ON].sort(), ['1', 'on', 'true', 'y', 'yes']);
  assert.deepEqual([...FLAG_OFF].sort(), ['', '0', 'false', 'n', 'no', 'off']);
  for (const spelling of FLAG_ON) assert.equal(FLAG_OFF.has(spelling), false, spelling);
});

test('flagState reads the usual yes spellings as on, whatever the case or padding', () => {
  for (const on of ['1', 'true', 'TRUE', 'True', 'yes', 'YES', 'on', 'ON', 'y', 'Y', ' 1 ', '\ttrue\n']) {
    assert.equal(flagState({ SWITCH: on }, 'SWITCH'), 'on', JSON.stringify(on));
  }
});

test('flagState reads the usual no spellings as off', () => {
  for (const off of ['0', 'false', 'FALSE', 'no', 'NO', 'off', 'OFF', 'n', 'N', ' 0 ']) {
    assert.equal(flagState({ SWITCH: off }, 'SWITCH'), 'off', JSON.stringify(off));
  }
});

test('an unset, empty or blank variable reads as off, so "not configured" never switches anything', () => {
  assert.equal(flagState({}, 'SWITCH'), 'off');
  assert.equal(flagState({ SWITCH: undefined }, 'SWITCH'), 'off');
  assert.equal(flagState({ SWITCH: null }, 'SWITCH'), 'off');
  assert.equal(flagState({ SWITCH: '' }, 'SWITCH'), 'off');
  assert.equal(flagState({ SWITCH: '   ' }, 'SWITCH'), 'off');
  assert.equal(flagState({ OTHER: '1' }, 'SWITCH'), 'off');
  assert.equal(flagState(undefined, 'SWITCH'), 'off');
  assert.equal(flagState(null, 'SWITCH'), 'off');
});

test('a value that is neither yes nor no is "unknown", for the caller to fail safe on', () => {
  for (const odd of ['perhaps', 'switched-off', '2', '-1', 'enabled', 'disable', 'tru', 'o n', '1 1', 'ｙ']) {
    assert.equal(flagState({ SWITCH: odd }, 'SWITCH'), 'unknown', JSON.stringify(odd));
  }
});

test('flagState tolerates non-string values from a hand-built environment', () => {
  assert.equal(flagState({ SWITCH: 1 }, 'SWITCH'), 'on');
  assert.equal(flagState({ SWITCH: 0 }, 'SWITCH'), 'off');
  assert.equal(flagState({ SWITCH: true }, 'SWITCH'), 'on');
  assert.equal(flagState({ SWITCH: false }, 'SWITCH'), 'off');
  assert.equal(flagState({ SWITCH: 2 }, 'SWITCH'), 'unknown');
});

test('flagState reads only the variable it is asked about', () => {
  const env = { A_DISABLED: '1', B_DISABLED: '0', C_DISABLED: 'maybe' };
  assert.equal(flagState(env, 'A_DISABLED'), 'on');
  assert.equal(flagState(env, 'B_DISABLED'), 'off');
  assert.equal(flagState(env, 'C_DISABLED'), 'unknown');
  assert.equal(flagState(env, 'D_DISABLED'), 'off');
});

test('warnOnce says each key once and hands the message to the warner it is given', () => {
  const lines = [];
  const warn = (message) => lines.push(message);
  warnOnce('env-flags-test:a', 'first', warn);
  warnOnce('env-flags-test:a', 'first again', warn);
  warnOnce('env-flags-test:b', 'second', warn);
  warnOnce('env-flags-test:a', 'first once more', warn);
  assert.deepEqual(lines, ['first', 'second']);
});

test('warnOnce prints to the console by default', () => {
  const original = console.error;
  const lines = [];
  console.error = (message) => lines.push(String(message));
  try {
    warnOnce('env-flags-test:console', 'to the console');
    warnOnce('env-flags-test:console', 'to the console');
  } finally {
    console.error = original;
  }
  assert.deepEqual(lines, ['to the console']);
});

test('warnOnce is keyed by the caller, so one bad value warns once however often it is read', () => {
  const lines = [];
  const warn = (message) => lines.push(message);
  const check = (value) => {
    if (flagState({ SWITCH: value }, 'SWITCH') === 'unknown') {
      warnOnce(`env-flags-test:switch=${value}`, `SWITCH=${shown(value)} is not understood`, warn);
    }
  };
  check('perhaps');
  check('perhaps');
  check('maybe');
  check('perhaps');
  assert.deepEqual(lines, ['SWITCH="perhaps" is not understood', 'SWITCH="maybe" is not understood']);
});

test('shown quotes a value for a message and cuts it at 40 characters', () => {
  assert.equal(shown('perhaps'), '"perhaps"');
  assert.equal(shown('x'.repeat(100)), `"${'x'.repeat(40)}"`);
  assert.equal(shown('say "hi"\n'), '"say \\"hi\\"\\n"');
  assert.equal(shown(5), '"5"');
  assert.equal(shown(undefined), '"undefined"');
  assert.equal(shown(''), '""');
});
