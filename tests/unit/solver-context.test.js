'use strict';

// The solver context lets callers that cannot change a signature (source probes,
// cover search, the comic lookup, the image proxy) say how patient they are, and
// the pool read it back. What matters: nothing leaks outside the call, nesting
// resolves the way the pool relies on, and the context survives awaits.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRIORITIES,
  DEFAULT_PRIORITY,
  cleanContext,
  runWithSolverContext,
  getSolverContext,
  mergeSolverContext,
  backgroundProbeContext,
} = require('../../server/modules/network/solver-context');
const { CALLER_PATIENCE } = require('../../server/config/solver');

// Not unref'd: the test is waiting on it, and it fires within milliseconds.
const tick = (ms = 1) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('outside any context there is nothing declared', () => {
  assert.deepEqual(getSolverContext(), {});
});

test('a declared context is visible inside the call and gone after it', async () => {
  const seen = await runWithSolverContext({ priority: 'background', deadlineAt: 5000, label: 'health' }, async () => getSolverContext());
  assert.deepEqual(seen, { priority: 'background', deadlineAt: 5000, label: 'health' });
  assert.deepEqual(getSolverContext(), {}, 'nothing leaks out of the call');
});

test('the context survives awaits, timers and promise chains', async () => {
  const ctx = { priority: 'background', deadlineAt: 123, boundSolve: true };
  const seen = [];
  await runWithSolverContext(ctx, async () => {
    seen.push(getSolverContext());
    await tick();
    seen.push(getSolverContext());
    await Promise.all([tick(2), tick(3)]).then(() => seen.push(getSolverContext()));
    await new Promise((resolve) => setImmediate(resolve));
    seen.push(getSolverContext());
    await new Promise((resolve) => process.nextTick(resolve));
    seen.push(getSolverContext());
  });
  assert.equal(seen.length, 5);
  for (const one of seen) assert.deepEqual(one, ctx);
});

test('concurrent calls each see their own context', async () => {
  const run = (priority, wait) => runWithSolverContext({ priority }, async () => {
    await tick(wait);
    return getSolverContext().priority;
  });
  const [slowBackground, fastInteractive] = await Promise.all([run('background', 15), run('interactive', 1)]);
  assert.equal(slowBackground, 'background');
  assert.equal(fastInteractive, 'interactive');
  assert.deepEqual(getSolverContext(), {});
});

test('what the function returns, resolves or throws comes back as a promise', async () => {
  assert.equal(await runWithSolverContext({}, () => 7), 7, 'a plain return value is wrapped');
  assert.equal(await runWithSolverContext({}, async () => 'x'), 'x');

  const boom = new Error('boom');
  const sync = runWithSolverContext({}, () => { throw boom; });
  assert.ok(sync instanceof Promise, 'a synchronous throw does not escape the caller');
  await assert.rejects(sync, (err) => err === boom, 'and it is the very same error');
  await assert.rejects(runWithSolverContext({}, async () => { throw boom; }), (err) => err === boom);
});

test('nesting: the inner priority wins', async () => {
  const seen = await runWithSolverContext({ priority: 'background' }, () => runWithSolverContext({ priority: 'interactive' }, () => getSolverContext()));
  assert.equal(seen.priority, 'interactive');
  const flipped = await runWithSolverContext({ priority: 'interactive' }, () => runWithSolverContext({ priority: 'background' }, () => getSolverContext()));
  assert.equal(flipped.priority, 'background');
});

test('nesting: the deadline is the earlier of the two, whichever is declared first', async () => {
  const outerEarlier = await runWithSolverContext({ deadlineAt: 1000 }, () => runWithSolverContext({ deadlineAt: 9000 }, () => getSolverContext()));
  assert.equal(outerEarlier.deadlineAt, 1000, 'an inner caller cannot make the outer one wait longer');
  const innerEarlier = await runWithSolverContext({ deadlineAt: 9000 }, () => runWithSolverContext({ deadlineAt: 1000 }, () => getSolverContext()));
  assert.equal(innerEarlier.deadlineAt, 1000);
});

test('nesting: boundSolve and label go to the inner caller', async () => {
  const seen = await runWithSolverContext({ boundSolve: true, label: 'outer' }, () => runWithSolverContext({ boundSolve: false, label: 'inner' }, () => getSolverContext()));
  assert.deepEqual(seen, { boundSolve: false, label: 'inner' });
});

test('nesting: a field the inner caller does not declare is inherited from the outer one', async () => {
  const seen = await runWithSolverContext({ priority: 'background', deadlineAt: 4000, label: 'health', boundSolve: true }, () => runWithSolverContext({ deadlineAt: 6000 }, () => getSolverContext()));
  assert.deepEqual(seen, { priority: 'background', deadlineAt: 4000, label: 'health', boundSolve: true });

  const added = await runWithSolverContext({ priority: 'background' }, () => runWithSolverContext({ deadlineAt: 6000 }, () => getSolverContext()));
  assert.deepEqual(added, { priority: 'background', deadlineAt: 6000 });
});

test('leaving an inner context restores the outer one', async () => {
  await runWithSolverContext({ priority: 'background', deadlineAt: 100 }, async () => {
    await runWithSolverContext({ priority: 'interactive', deadlineAt: 50 }, async () => {
      assert.deepEqual(getSolverContext(), { priority: 'interactive', deadlineAt: 50 });
    });
    assert.deepEqual(getSolverContext(), { priority: 'background', deadlineAt: 100 });
  });
});

test('a value that is not well-formed is ignored, never stored and never hides an outer value', async () => {
  const junk = {
    priority: 'urgent', deadlineAt: 'soon', label: 42, boundSolve: 'yes', oneOff: 'yes',
  };
  assert.deepEqual(await runWithSolverContext(junk, () => getSolverContext()), {});
  for (const bad of [null, undefined, 'x', 5, []]) {
    assert.deepEqual(await runWithSolverContext(bad, () => getSolverContext()), {}, String(bad));
  }
  assert.deepEqual(await runWithSolverContext({ deadlineAt: NaN }, () => getSolverContext()), {});
  assert.deepEqual(await runWithSolverContext({ deadlineAt: Infinity }, () => getSolverContext()), {});

  const kept = await runWithSolverContext({ priority: 'background', deadlineAt: 700, boundSolve: true }, () => runWithSolverContext(junk, () => getSolverContext()));
  assert.deepEqual(kept, { priority: 'background', deadlineAt: 700, boundSolve: true });
});

test('an unknown field is dropped', async () => {
  assert.deepEqual(await runWithSolverContext({ priority: 'background', sneaky: 1 }, () => getSolverContext()), { priority: 'background' });
});

test('a navigation timeout is not something the context carries: the pool reads it from the request only', async () => {
  assert.deepEqual(await runWithSolverContext({ priority: 'background', maxTimeoutMs: 9000 }, () => getSolverContext()), { priority: 'background' });
  assert.deepEqual(mergeSolverContext({ maxTimeoutMs: 9000 }, { maxTimeoutMs: 4000 }), {});
});

test('what getSolverContext returns is a copy: changing it changes nothing', async () => {
  await runWithSolverContext({ priority: 'background' }, async () => {
    const first = getSolverContext();
    first.priority = 'interactive';
    first.deadlineAt = 1;
    assert.deepEqual(getSolverContext(), { priority: 'background' });
  });
});

test('the object a caller passes in is not kept or changed', async () => {
  const declared = { priority: 'background', deadlineAt: 800 };
  await runWithSolverContext(declared, async () => {
    declared.priority = 'interactive';
    declared.deadlineAt = 1;
    assert.deepEqual(getSolverContext(), { priority: 'background', deadlineAt: 800 });
  });
  assert.deepEqual(declared, { priority: 'interactive', deadlineAt: 1 });
});

test('mergeSolverContext is the same nesting rule, for laying a per-call context over the ambient one', () => {
  assert.deepEqual(mergeSolverContext({}, {}), {});
  assert.deepEqual(mergeSolverContext(undefined, undefined), {});
  assert.deepEqual(
    mergeSolverContext({ priority: 'background', deadlineAt: 9000, label: 'a' }, { priority: 'interactive', deadlineAt: 3000, boundSolve: true }),
    { priority: 'interactive', deadlineAt: 3000, label: 'a', boundSolve: true },
  );
  assert.deepEqual(mergeSolverContext({ deadlineAt: 2000 }, { deadlineAt: 7000 }), { deadlineAt: 2000 });
  assert.deepEqual(mergeSolverContext({ deadlineAt: 2000 }, {}), { deadlineAt: 2000 });
  assert.deepEqual(mergeSolverContext({}, { deadlineAt: 7000 }), { deadlineAt: 7000 });
  // Neither argument is changed.
  const outer = { priority: 'background' };
  const inner = { priority: 'interactive' };
  mergeSolverContext(outer, inner);
  assert.deepEqual(outer, { priority: 'background' });
  assert.deepEqual(inner, { priority: 'interactive' });
});

test('the priorities are named once, strongest first, and an undeclared call gets the first', () => {
  assert.deepEqual([...PRIORITIES], ['interactive', 'background']);
  assert.equal(DEFAULT_PRIORITY, 'interactive');
  assert.equal(Object.isFrozen(PRIORITIES), true);
});

test('cleanContext keeps what is well formed and drops the rest, so a bad value cannot reach the pool', () => {
  assert.deepEqual(cleanContext({ priority: 'urgent', deadlineAt: NaN, boundSolve: 'yes', label: 42, extra: 1 }), {});
  assert.deepEqual(cleanContext({ priority: 'background', deadlineAt: 5, boundSolve: false, label: 'x' }), { priority: 'background', deadlineAt: 5, boundSolve: false, label: 'x' });
  for (const nothing of [undefined, null, 'text', 3, []]) assert.deepEqual(cleanContext(nothing), {});
});

test('a background probe waits behind people and is dropped from the queue a moment before its own timeout', () => {
  const before = Date.now();
  const ctx = backgroundProbeContext(15_000);
  const after = Date.now();
  assert.equal(ctx.priority, 'background');
  assert.equal(ctx.label, 'health');
  assert.ok(ctx.deadlineAt >= before + 15_000 - CALLER_PATIENCE.probeGiveUpMarginMs && ctx.deadlineAt <= after + 15_000 - CALLER_PATIENCE.probeGiveUpMarginMs);
  assert.equal('boundSolve' in ctx, false, 'a probe must go on solving so the cookie is warmed');
  assert.deepEqual(cleanContext(ctx), ctx, 'it is well formed as it is');
});

// oneOff is for a caller whose page must never be served from, or leave anything in, a browser other callers share
// (cover search: the image engines keep SafeSearch in cookies). Saying it is all there is to it; not saying it,
// or saying it is false, are the same, and nothing a caller calls can take it back.
test('oneOff: only a true survives, it nests, and an inner context cannot switch it off', async () => {
  assert.deepEqual(cleanContext({ oneOff: true }), { oneOff: true });
  for (const notTrue of [false, 'true', 1, null, undefined, {}]) assert.deepEqual(cleanContext({ oneOff: notTrue }), {}, String(notTrue));

  assert.deepEqual(await runWithSolverContext({ oneOff: true, priority: 'background' }, () => getSolverContext()), { oneOff: true, priority: 'background' });
  assert.deepEqual(await runWithSolverContext({ oneOff: false }, () => getSolverContext()), {});
  const nested = await runWithSolverContext({ oneOff: true }, () => runWithSolverContext({ oneOff: false, label: 'inner' }, () => getSolverContext()));
  assert.deepEqual(nested, { oneOff: true, label: 'inner' }, 'what a one-off caller calls is one-off too');
  assert.deepEqual(mergeSolverContext({}, { oneOff: true }), { oneOff: true });
  assert.deepEqual(mergeSolverContext({ oneOff: true }, { priority: 'interactive' }), { oneOff: true, priority: 'interactive' });
  assert.deepEqual(getSolverContext(), {}, 'and nothing leaks out of the call');
});
