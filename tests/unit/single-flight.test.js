'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSingleFlight } = require('../../server/modules/network/single-flight');

// A call that finishes when the test says so, and the controller (a pool handle's two methods) it is queued in.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function recordingController() {
  const calls = [];
  return {
    calls,
    promote: (priority) => calls.push(['promote', priority]),
    extendDeadline: (epochMs) => calls.push(['extendDeadline', epochMs]),
  };
}

test('callers for the same key share one run and one answer', async () => {
  const flights = createSingleFlight();
  const gate = deferred();
  let runs = 0;
  const start = () => { runs += 1; return gate.promise; };

  const first = flights.run('k', {}, start);
  const second = flights.run('k', {}, start);
  const third = flights.run('k', {}, start);
  assert.equal(flights.size(), 1);
  gate.resolve('the page');

  assert.deepEqual(await Promise.all([first, second, third]), ['the page', 'the page', 'the page']);
  assert.equal(runs, 1);
});

test('different keys never share: each gets its own run, and one failing does not touch the other', async () => {
  const flights = createSingleFlight();
  const failure = new Error('A failed');
  const a = flights.run('a', {}, async () => { throw failure; });
  const b = flights.run('b', {}, async () => 'B');

  await assert.rejects(a, (err) => err === failure);
  assert.equal(await b, 'B');
});

test('a flight leaves the registry however it ends, so a failure is never replayed', async () => {
  const flights = createSingleFlight();
  const boom = new Error('boom');

  await assert.rejects(flights.run('k', {}, async () => { throw boom; }), (err) => err === boom);
  assert.equal(flights.size(), 0);

  // a start() that throws before it returns anything is a rejection like any other
  await assert.rejects(flights.run('k', {}, () => { throw boom; }), (err) => err === boom);
  assert.equal(flights.size(), 0);

  let runs = 0;
  assert.equal(await flights.run('k', {}, async () => { runs += 1; return 'fresh'; }), 'fresh');
  assert.equal(await flights.run('k', {}, async () => { runs += 1; return 'fresh again'; }), 'fresh again');
  assert.equal(runs, 2, 'a settled flight is not joined');
  assert.equal(flights.size(), 0);
});

test('every caller of a failed flight gets the same error object', async () => {
  const flights = createSingleFlight();
  const gate = deferred();
  const first = flights.run('k', {}, () => gate.promise);
  const second = flights.run('k', {}, () => gate.promise);
  const failure = new Error('shared');
  gate.reject(failure);

  const results = await Promise.allSettled([first, second]);
  assert.deepEqual(results.map((r) => r.reason), [failure, failure]);
});

test('a joiner brings its own patience to the queued call; the first caller\'s is not applied again', async () => {
  const flights = createSingleFlight();
  const gate = deferred();
  const controller = recordingController();
  const first = flights.run('k', { priority: 'background', deadlineAt: 1000 }, (flight) => { flight.attach(controller); return gate.promise; });
  assert.deepEqual(controller.calls, [], 'the first caller\'s own priority and deadline were given when the call was queued');

  const joined = flights.run('k', { priority: 'interactive', deadlineAt: 9000 }, () => assert.fail('a joiner never starts a run'));
  assert.deepEqual(controller.calls, [['promote', 'interactive'], ['extendDeadline', 9000]]);

  // a joiner that declared nothing is interactive (the pool's default) and only promotes
  flights.run('k', undefined, () => assert.fail('a joiner never starts a run'));
  assert.deepEqual(controller.calls.slice(2), [['promote', 'interactive']]);

  // a joiner no more urgent than the group still gets its own wait budget, but not a stronger class
  flights.run('k', { priority: 'background', deadlineAt: 500 }, () => assert.fail('a joiner never starts a run'));
  assert.deepEqual(controller.calls.slice(3), [['promote', 'background'], ['extendDeadline', 500]]);

  gate.resolve('x');
  await Promise.all([first, joined]);
});

test('what the group asks for: strongest priority, latest deadline, boundSolve only if every member set it', () => {
  const flights = createSingleFlight();
  let flight;
  const gate = deferred();
  flights.run('k', { priority: 'background', deadlineAt: 5000, boundSolve: true, label: 'cover' }, (f) => { flight = f; return gate.promise; });
  assert.deepEqual(flight.patience(), { priority: 'background', deadlineAt: 5000, boundSolve: true, label: 'cover' });

  flights.run('k', { priority: 'background', deadlineAt: 8000, boundSolve: true }, () => {});
  assert.deepEqual(flight.patience(), { priority: 'background', deadlineAt: 8000, boundSolve: true, label: 'cover' });

  flights.run('k', { priority: 'interactive', deadlineAt: 6000 }, () => {});
  assert.deepEqual(flight.patience(), { priority: 'interactive', deadlineAt: 8000, boundSolve: false, label: 'cover' });

  gate.resolve();
});

test('oneOff is part of what the group asks for: one member that needs a browser of its own makes it so', () => {
  const flights = createSingleFlight();
  let flight;
  const gate = deferred();
  flights.run('k', { priority: 'background', oneOff: true }, (f) => { flight = f; return gate.promise; });
  assert.deepEqual(flight.patience(), { priority: 'background', boundSolve: false, oneOff: true });
  flights.run('k', { priority: 'interactive' }, () => {});
  assert.equal(flight.patience().oneOff, true, 'a joiner that did not say it does not take it back');

  let plain;
  flights.run('plain', {}, (f) => { plain = f; return gate.promise; });
  assert.equal('oneOff' in plain.patience(), false, 'nobody said it: nothing is added');
  gate.resolve();
});

test('junk patience is ignored: no priority means interactive, a deadline must be a finite number', () => {
  const flights = createSingleFlight();
  let flight;
  const gate = deferred();
  flights.run('k', { priority: 'urgent', deadlineAt: 'soon', boundSolve: 'yes', label: 42 }, (f) => { flight = f; return gate.promise; });
  assert.deepEqual(flight.patience(), { priority: 'interactive', boundSolve: false });
  gate.resolve();
});

test('a call queued again inside the same flight gets what the joiners asked for, once attached', async () => {
  const flights = createSingleFlight();
  const gate = deferred();
  const firstQueued = recordingController();
  const queuedAgain = recordingController();
  let flight;
  const first = flights.run('k', { priority: 'background', deadlineAt: 1000 }, (f) => { flight = f; f.attach(firstQueued); return gate.promise; });
  flights.run('k', { priority: 'interactive', deadlineAt: 7000 }, () => {});
  flights.run('k', { priority: 'background', deadlineAt: 9000 }, () => {});

  flight.attach(queuedAgain);
  // the two joiners combined: interactive, deadline 9000. Nothing of the first caller's own.
  assert.deepEqual(queuedAgain.calls, [['promote', 'interactive'], ['extendDeadline', 9000]]);

  gate.resolve();
  await first;
});

test('a controller that throws never fails the caller that joined', async () => {
  const flights = createSingleFlight();
  const gate = deferred();
  const angry = { promote() { throw new Error('too late'); }, extendDeadline() { throw new Error('too late'); } };
  const first = flights.run('k', {}, (flight) => { flight.attach(angry); return gate.promise; });
  const joined = flights.run('k', { deadlineAt: 10 }, () => {});
  gate.resolve('page');
  assert.equal(await joined, 'page');
  assert.equal(await first, 'page');
});
