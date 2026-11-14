'use strict';

// The rig the solver pool's integration tests share (tests/unit/solver-pool*.test.js):
// a pool wired to a fake FlareSolverr 3.5.2 on loopback (no browser, no network), a
// clock the test can move, and the proof of the rule the pool is built around, which
// the rig checks on EVERY test when it ends:
//   no `request.get` ever reaches a session id that was not confirmed in the current
//   FlareSolverr process or that is being / has been destroyed - not even when an
//   idle close, a recycle, closeAll or a restart races a new job.
// Hosts are never resolved: the fake answers whatever URL it is given.

const assert = require('node:assert/strict');

const { startFakeFlareSolverr } = require('./fake-flaresolverr');
const { createSolverPool } = require('../../server/modules/network/solver-pool');

const A = 'https://cf-site.example';
const B = 'https://other-site.example';

// Not unref'd on purpose: the test is waiting on it.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const unrefSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

async function until(check, what = 'the condition', timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(2);
  }
}

// A clock the test moves by hand, for everything that is about minutes rather
// than milliseconds. Its timers are handed to the pool, which must unref them
// (hasRef() is what the tests look at). The HTTP to the fake stays real.
function makeClock(start = 1_700_000_000_000) {
  let current = start;
  let nextId = 1;
  const timers = new Map();
  const turns = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  };
  return {
    now: () => current,
    setTimer(fn, ms) {
      const handle = { id: nextId, at: current + Math.max(0, ms), fn, ref: true, hasRef() { return this.ref; }, unref() { this.ref = false; return this; } };
      nextId += 1;
      timers.set(handle.id, handle);
      return handle;
    },
    clearTimer(handle) {
      if (handle) timers.delete(handle.id);
    },
    get pending() { return timers.size; },
    async advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.values()].filter((h) => h.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        current = Math.max(current, due.at);
        due.fn();
        await turns();
      }
      current = target;
      await turns();
    },
  };
}

// The calls the fake saw, as short words: create, list, destroy, get /path, blank.
const label = (e) => {
  if (e.cmd === 'request.get') return e.url === 'about:blank' || e.url.startsWith('data:') ? 'blank' : `get ${new URL(e.url).pathname}`;
  return e.cmd.replace('sessions.', '');
};
const sequence = (fake) => fake.log.map(label);
const navigations = (fake) => fake.log.filter((e) => e.cmd === 'request.get' && e.url && e.url !== 'about:blank' && !e.url.startsWith('data:'));
const commands = (fake, cmd) => fake.log.filter((e) => e.cmd === cmd);
const creates = (fake) => commands(fake, 'sessions.create');
const destroys = (fake) => commands(fake, 'sessions.destroy');

// Proof of rule 1, over everything the fake saw: a session request only for an id
// created earlier and not yet destroyed; every create under a new id; and nothing
// on a session request that FlareSolverr would read wrongly (a proxy it ignores, a
// ttl that drops the proxy, cookies that stay in the shared jar).
function assertSessionDiscipline(fake, earlier = []) {
  assert.deepEqual(fake.lazyCreated, [], 'FlareSolverr was asked about an id it did not have, and created it without the proxy');
  assert.deepEqual(fake.ttlDropped, [], 'a session_ttl_minutes recreated a session without its proxy');
  const created = new Set();
  const destroyed = new Set();
  for (const e of [...earlier, ...fake.log]) {
    if (e.cmd === 'sessions.create') {
      assert.ok(!created.has(e.session), `session id ${e.session} was created twice`);
      created.add(e.session);
    } else if (e.cmd === 'sessions.destroy') {
      destroyed.add(e.session);
    } else if (e.cmd === 'request.get' && e.session) {
      assert.ok(created.has(e.session), `a request for ${e.session}, which had not been created`);
      assert.ok(!destroyed.has(e.session), `a request for ${e.session} after its destroy was sent`);
      assert.equal(e.proxy, null, 'a proxy sent with a session request is ignored by FlareSolverr');
      assert.equal(e.ttl, null, 'session_ttl_minutes drops the proxy when it expires');
      assert.equal(e.hadCookies, false, 'cookies sent on a session stay in it for every later caller');
    }
  }
}

// A post that remembers when each navigation was SENT, by this process's own clock (or by `now`, when
// the test moves the pool's time by hand). Spacing is the pool's promise about when it sends; the fake's
// arrival times add the event loop's jitter. Real HTTP to the fake, like the default post (which the
// other tests exercise).
function timedPost(sends, now = Date.now) {
  return async (solverUrl, payload, { timeoutMs }) => {
    if (payload.cmd === 'request.get' && payload.url !== 'about:blank' && !payload.url.startsWith('data:')) {
      sends.push({ path: new URL(payload.url).pathname, at: now() });
    }
    const res = await fetch(solverUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (_) {
      // not JSON: the pool reads that as a relay's answer
    }
    return { httpStatus: res.status, body };
  };
}

// A post that sends everything to the fake over real HTTP, except the navigation to a path the test parked with
// hold(path). A parked navigation does not reach the fake until the test lets it: release() sends it on and it
// is answered as any other, timeout() ends it as our own abort firing would (the original TimeoutError, which is
// what a wedged FlareSolverr looks like from here). The test chooses WHEN, instead of racing a real timer of a few
// dozen milliseconds that a loaded machine can fire early or late.
function holdablePost() {
  const forward = timedPost([]);
  const parked = new Map();
  const isPage = (payload) => payload.cmd === 'request.get' && typeof payload.url === 'string' && payload.url.startsWith('http');
  function hold(path) {
    const entry = {};
    entry.waiting = new Promise((resolve, reject) => { entry.answer = resolve; entry.fail = reject; });
    entry.waiting.catch(() => {}); // the pool awaits it once the navigation is sent; a test that never ends it is not a crash
    entry.arrived = new Promise((resolve) => { entry.arrive = resolve; });
    parked.set(path, entry);
    return {
      arrived: entry.arrived,
      release: () => entry.answer(entry.send()),
      timeout: () => entry.fail(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })),
    };
  }
  const post = (solverUrl, payload, options) => {
    const entry = isPage(payload) ? parked.get(new URL(payload.url).pathname) : null;
    if (!entry) return forward(solverUrl, payload, options);
    entry.send = () => forward(solverUrl, payload, options);
    entry.arrive();
    return entry.waiting;
  };
  return { post, hold };
}

// Timers and Date.now() round to the millisecond, and a process that the machine pauses for a few
// milliseconds between the pool's decision to send and the post that records it moves a gap by as
// much: a gap may come out a few short. Sends that were not spaced at all are about 0 ms apart.
const TIMER_SLACK_MS = 12;

// The test's own copy of fetch that remembers what it threw, so "the very same
// error object" can be asserted at the other end.
function captureFetchErrors(t) {
  const real = globalThis.fetch;
  const thrown = [];
  globalThis.fetch = async (...args) => {
    try {
      return await real(...args);
    } catch (err) {
      thrown.push(err);
      throw err;
    }
  };
  t.after(() => { globalThis.fetch = real; });
  return thrown;
}

// A pool wired to a fresh fake. `config` overrides POOL; with `clock` all of the
// pool's time is the test's. Timers are real unless a clock is given, and are
// NOT unref'd here: the pool must do that itself.
async function rig(t, {
  config = {}, settings = {}, proxy = null, fakeOptions = {}, clock = null, deps = {}, hooks = {}, apply = true, discipline = true,
} = {}) {
  const fake = await startFakeFlareSolverr(fakeOptions);
  // A test that clears the log still has its history checked at the end.
  const archive = [];
  const clearLog = fake.clearLog;
  fake.clearLog = () => { archive.push(...fake.log); clearLog(); };
  const events = { used: 0, recovered: 0, faults: [], logs: [], warns: [], errors: [] };
  const handles = [];
  const live = new Set();
  const timing = clock
    ? {
      now: clock.now,
      setTimer: (fn, ms) => { const handle = clock.setTimer(fn, ms); handles.push(handle); return handle; },
      clearTimer: (handle) => clock.clearTimer(handle),
    }
    : {
      setTimer: (fn, ms) => {
        const handle = setTimeout(() => { live.delete(handle); fn(); }, ms);
        handles.push(handle);
        live.add(handle);
        return handle;
      },
      clearTimer: (handle) => { live.delete(handle); clearTimeout(handle); },
    };
  const pool = createSolverPool({
    config: { hostSpacingMs: 0, blankResetSettleMs: 5, launchRetryDelayMs: 5, ...config },
    getSolverProxy: async () => proxy,
    hooks: {
      noteUsed() { events.used += 1; },
      recoverFromHang() { events.recovered += 1; },
      onProxyFault(info) { events.faults.push(info); },
      ...hooks,
    },
    log: (m) => events.logs.push(m),
    warn: (m) => events.warns.push(m),
    recordError: async (entry) => { events.errors.push(entry); },
    ...timing,
    ...deps,
  });
  if (apply) pool.applySettings({ enabled: true, disabledBy: null, maxSessions: 1, idleMinutes: 10, ...settings });

  t.after(async () => {
    fake.clearRules();
    await Promise.race([pool.shutdown({ timeoutMs: 1000 }), unrefSleep(2500)]);
    await fake.stop();
    for (const handle of live) clearTimeout(handle);
    if (discipline) assertSessionDiscipline(fake, archive);
  });

  return {
    fake,
    pool,
    events,
    solverUrl: fake.url,
    run: (base, path, request = {}, ctx) => pool.run({ url: `${base}${path}`, solverUrl: fake.url, ...request }, ctx),
    liveTimers: () => live.size,
    assertTimersUnref: () => {
      assert.ok(handles.length > 0, 'the test expected the pool to have used a timer');
      for (const handle of handles) assert.equal(handle.hasRef(), false, 'a pool timer keeps the process alive');
    },
    // Everything the pool was doing has finished, blank resets included.
    settled: () => until(() => {
      const status = pool.getStatus();
      return status.inFlight === 0 && status.queued.interactive + status.queued.background === 0 && status.sessions.every((s) => !s.busy);
    }, 'the pool to settle'),
  };
}

async function rejectionOf(handleOrPromise) {
  try {
    await (handleOrPromise.promise || handleOrPromise);
  } catch (err) {
    return err;
  }
  return assert.fail('the job was expected to fail');
}

// How a job ended, or { stuck: true } when it was not answered in time: a job that is never
// answered must fail its test, not hang it. The timer is unref'd; the fake keeps the loop alive.
const outcomeOf = (handle, ms = 2000) => Promise.race([
  handle.promise.then((value) => ({ value }), (error) => ({ error })),
  unrefSleep(ms).then(() => ({ stuck: true })),
]);

module.exports = {
  A,
  B,
  sleep,
  unrefSleep,
  until,
  makeClock,
  label,
  sequence,
  navigations,
  commands,
  creates,
  destroys,
  assertSessionDiscipline,
  timedPost,
  holdablePost,
  TIMER_SLACK_MS,
  captureFetchErrors,
  rig,
  rejectionOf,
  outcomeOf,
};
