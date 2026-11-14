'use strict';

// server/modules/network/flaresolverr-restart-events.js: who hears about a FlareSolverr restart.
// The lifecycle tests (flaresolverr-lifecycle.test.js) cover it through restartFlaresolverr; this file
// holds the registry to its own contract, with its own `warn`. It loads nothing but the registry: no
// process, no timer, and not the lifecycle module (which reads data/setup.json when it is loaded).

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerRestartListener, emitRestart } = require('../../server/modules/network/flaresolverr-restart-events');

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

test('a listener hears the phase and the detail, as a copy it can change without harming the next listener', () => {
  const heard = [];
  const stopFirst = registerRestartListener((event) => { heard.push(event); event.reason = 'tampered'; });
  const stopSecond = registerRestartListener((event) => { heard.push({ ...event }); });
  const detail = { reason: 'idle' };
  emitRestart('begin', detail, () => assert.fail('nothing failed'));
  stopFirst();
  stopSecond();
  assert.deepEqual(heard.map((e) => e.phase), ['begin', 'begin']);
  assert.equal(heard[1].reason, 'idle');
  assert.equal(detail.reason, 'idle');
});

test('unsubscribing is idempotent, takes effect at once, and leaves a second registration of the same function in place', () => {
  const calls = [];
  const listener = (event) => calls.push(event.phase);
  const stopA = registerRestartListener(listener);
  const stopB = registerRestartListener(listener);
  emitRestart('begin', {}, () => {});
  assert.equal(calls.length, 2, 'registered twice, heard twice');
  stopA();
  stopA();
  emitRestart('end', { ok: true }, () => {});
  assert.equal(calls.length, 3);
  stopB();
  emitRestart('end', { ok: true }, () => {});
  assert.equal(calls.length, 3);
});

test('a listener that throws, or rejects, is reported through warn and does not stop the ones after it', async () => {
  const warned = [];
  const heard = [];
  const stops = [
    registerRestartListener(() => { throw new Error('sync boom'); }),
    registerRestartListener(async () => { throw new Error('async boom'); }),
    registerRestartListener((event) => heard.push(event.phase)),
  ];
  emitRestart('begin', { reason: 'x' }, (message) => warned.push(message));
  await tick();
  for (const stop of stops) stop();
  assert.deepEqual(heard, ['begin']);
  assert.equal(warned.length, 2);
  assert.match(warned[0], /^\[FlareSolverr\] A restart listener failed on 'begin': sync boom$/);
  assert.match(warned[1], /failed on 'begin': async boom/);
});

test('a listener that unsubscribes itself, or adds another, while it is being called does not disturb this round', () => {
  const heard = [];
  let stopSelf = null;
  let stopLate = null;
  stopSelf = registerRestartListener(() => {
    heard.push('self');
    stopSelf();
    stopLate = registerRestartListener(() => heard.push('late'));
  });
  const stopOther = registerRestartListener(() => heard.push('other'));
  emitRestart('begin', {}, () => {});
  assert.deepEqual(heard, ['self', 'other'], 'the late one only hears the next phase');
  emitRestart('end', { ok: true }, () => {});
  assert.deepEqual(heard, ['self', 'other', 'other', 'late']);
  stopOther();
  stopLate();
});

test('only a function can be registered', () => {
  for (const bad of [undefined, null, 'x', 5, {}, []]) assert.throws(() => registerRestartListener(bad), TypeError, String(bad));
});
