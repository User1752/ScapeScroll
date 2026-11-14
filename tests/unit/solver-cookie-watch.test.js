'use strict';

// server/modules/network/solver/cookie-watch.js: the generation of a site's cookie, and which
// generation a plain request already got a "no" for. Pure bookkeeping on a clock the test moves.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL } = require('../../server/config/solver');
const { mergeConfig } = require('../../server/modules/network/solver/plain-object');
const { createCookieWatch } = require('../../server/modules/network/solver/cookie-watch');

function makeWatch() {
  const clock = { t: 1_700_000_000_000 };
  const cfg = mergeConfig(POOL, {});
  const watch = createCookieWatch({ cfg, ports: { now: () => clock.t } });
  return { clock, cfg, watch };
}

test('a site nobody answered yet is at generation 0, and each answered navigation moves only its own site on', () => {
  const { watch } = makeWatch();
  assert.equal(watch.generation('cf-site.example'), 0);
  watch.noteChange('cf-site.example');
  watch.noteChange('cf-site.example');
  watch.noteChange('other-site.example');
  assert.equal(watch.generation('cf-site.example'), 2);
  assert.equal(watch.generation('other-site.example'), 1);
  assert.equal(watch.generation('third-site.example'), 0);
});

test('a "no" is remembered for the generation it was tried at and ends with the next navigation to the site', () => {
  const { watch } = makeWatch();
  watch.noteChange('cf-site.example');
  assert.equal(watch.isWorthAsking('cf-site.example'), true, 'a cookie nobody tried yet');
  watch.noteMiss('cf-site.example', 1);
  assert.equal(watch.isWorthAsking('cf-site.example'), false);
  assert.equal(watch.isWorthAsking('other-site.example'), true, 'another site is not affected');
  watch.noteChange('cf-site.example');
  assert.equal(watch.isWorthAsking('cf-site.example'), true, 'the cookie may have changed');
});

test('a "no" for a generation that is already behind says nothing about the cookie there is now', () => {
  const { watch } = makeWatch();
  watch.noteChange('cf-site.example');
  watch.noteChange('cf-site.example');
  watch.noteMiss('cf-site.example', 1); // the try began before the second navigation finished
  assert.equal(watch.isWorthAsking('cf-site.example'), true);
});

test('a site nobody asked about for a while is forgotten; one somebody keeps asking about is not', () => {
  const { clock, cfg, watch } = makeWatch();
  watch.noteChange('cf-site.example');
  watch.noteChange('other-site.example');
  clock.t += cfg.gatePruneAfterMs - 1;
  watch.generation('cf-site.example'); // a waiting job looks at it
  clock.t += 1;
  watch.prune(clock.t);
  assert.equal(watch.generation('cf-site.example'), 1, 'still there');
  assert.equal(watch.generation('other-site.example'), 0, 'forgotten: back to generation 0');
});
