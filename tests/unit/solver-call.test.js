'use strict';

// Everything the app does around one call to the FlareSolverr pool (solver-call.js), against a
// scripted pool and fakes for every collaborator: nothing here touches the network, the real pool
// or a file. The real pool and a fake FlareSolverr meet this module in fetch-utils-solver.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSolverCaller, flightKey } = require('../../server/modules/network/solver-call');
const { createSingleFlight } = require('../../server/modules/network/single-flight');
const { runWithSolverContext, getSolverContext } = require('../../server/modules/network/solver-context');
const { POOL, MESSAGES } = require('../../server/config/solver');
const { refusal, POOL_ERROR_CODES, CALLER_ERROR_CODES } = require('../../server/modules/network/solver/errors');
const { classifySourceError, isTransientSourceErrorKey } = require('../../server/modules/system-health/service');

const SOLVER = 'http://127.0.0.1:8191/v1';
const URL_A = 'https://cf-site.example/a';
const SHELL = '<html>SHELL</html>';

const sentinelUnreachable = () => assert.fail('no plain request was expected');

function pageOutcome(html, extra = {}) {
  return {
    data: { status: 'ok', solution: { response: html, cookies: [{ name: 'cf_clearance', value: 'c1' }], userAgent: 'solver-UA' } },
    mode: 'session',
    proxyMode: 'none',
    fingerprint: 'none',
    queuedMs: 0,
    solveMs: 1,
    ...extra,
  };
}

// A pool whose answers the test scripts, one per run(): a value resolves, an Error rejects, a function is called.
function scriptedPool(answers) {
  const runs = [];
  const handles = [];
  return {
    runs,
    handles,
    run(request, ctx) {
      runs.push({ request, ctx });
      const answer = answers.shift();
      const calls = [];
      const promise = typeof answer === 'function' ? answer() : (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer));
      promise.catch(() => {});
      const handle = {
        calls,
        promise,
        promote: (priority) => calls.push(['promote', priority]),
        extendDeadline: (epochMs) => calls.push(['extendDeadline', epochMs]),
      };
      handles.push(handle);
      return handle;
    },
  };
}

function makeCaller(answers, overrides = {}) {
  const spy = { used: 0, recovered: 0, saved: [], order: [] };
  const pool = overrides.pool || scriptedPool(answers);
  const deps = {
    pool,
    flights: createSingleFlight(),
    assertPublicUrl: async () => { spy.order.push('assert'); },
    getSolverContext,
    noteUsed: () => { spy.used += 1; spy.order.push('used'); },
    recoverFromHang: () => { spy.recovered += 1; },
    saveDomainSession: (url, cookies, userAgent) => spy.saved.push({ url, cookies, userAgent }),
    getDomainSession: () => null,
    safeFetch: sentinelUnreachable,
    isChromeErrorPage: (html) => html.includes('chrome-error://'),
    isBotChallengePage: (html) => html.includes('SHELL'),
    needsChallengeSolve: (text) => !text || text.includes('SHELL') || text.includes('Just a moment'),
    siteLabel: (url) => new URL(url).hostname,
    userAgent: 'default-UA',
    ...overrides,
  };
  return { call: createSolverCaller(deps), spy, pool, deps };
}

const flushAll = () => new Promise((resolve) => { setImmediate(resolve); });

test('the caller is a function of three parameters (url, solver, cookies) and refuses to be built without its parts', () => {
  const { call } = makeCaller([]);
  assert.equal(call.length, 3, 'callers and tests tell the editions apart by this');
  assert.throws(() => createSolverCaller({}), (err) => err instanceof TypeError && /pool/.test(err.message) && /flights/.test(err.message));
  assert.throws(() => createSolverCaller(undefined), TypeError);
});

test('flightKey is the site, the exact URL and the exact cookies: never the site alone', () => {
  const key = flightKey('https://cf-site.example/a?x=1', undefined);
  assert.equal(flightKey('https://cf-site.example/a?x=1', []), key, 'an empty cookie list is no cookies');
  assert.equal(flightKey('https://cf-site.example/a?x=1#section', undefined), key, 'the fragment is never sent to the site');
  assert.notEqual(flightKey('https://cf-site.example/b?x=1', undefined), key, 'another page of the same site');
  assert.notEqual(flightKey('https://cf-site.example/a?x=2', undefined), key, 'another query');
  assert.notEqual(flightKey('https://www.cf-site.example/a?x=1', undefined), key, 'another host spelling is another URL');
  assert.ok(key.startsWith('cf-site.example\n'), 'it starts with the site, as the pool keys its spacing');

  const jar = [{ name: 'sid', value: 'one' }, { name: 'theme', value: 'dark' }];
  const withCookies = flightKey('https://cf-site.example/a?x=1', jar);
  assert.notEqual(withCookies, key);
  assert.equal(flightKey('https://cf-site.example/a?x=1', [...jar].reverse()), withCookies, 'the order of the cookies does not matter');
  assert.notEqual(flightKey('https://cf-site.example/a?x=1', [{ name: 'sid', value: 'two' }, jar[1]]), withCookies, 'another account');
  assert.ok(!withCookies.includes('one') && !withCookies.includes('sid'), 'the key holds a hash, never a cookie');
});

test('flightKey cannot be fooled by a character in a cookie that looks like the separator between two cookies', () => {
  const url = 'https://cf-site.example/a';
  const one = flightKey(url, [{ name: 'a', value: '1\nb=2' }]);
  const two = flightKey(url, [{ name: 'a', value: '1' }, { name: 'b', value: '2' }]);
  assert.notEqual(one, two, 'one cookie with a newline in its value is not two cookies');
  assert.notEqual(flightKey(url, [{ name: 'a=1', value: 'b' }]), flightKey(url, [{ name: 'a', value: '1=b' }]), 'nor does the = of a pair move between name and value');
  assert.notEqual(flightKey(url, [{ name: 'a', value: 'b,c' }]), flightKey(url, [{ name: 'a', value: 'b' }, { name: 'c', value: '' }]));
  assert.equal(flightKey(url, [{ name: 'b', value: '2' }, { name: 'a', value: '1' }]), two, 'the order still does not matter');
  assert.equal(flightKey(url, [null, undefined]).split('\n')[2].length, 40, 'a list of junk is still a hash');
});

test('flightKey keeps two sites under the same two-level suffix apart and survives text that is not a URL', () => {
  assert.notEqual(flightKey('https://one.co.uk/x', undefined), flightKey('https://two.co.uk/x', undefined));
  assert.equal(typeof flightKey('not a url', undefined), 'string');
  assert.equal(typeof flightKey(undefined, undefined), 'string');
});

test('the usage hook runs first, then the target is judged, then the pool is asked', async () => {
  const { call, spy } = makeCaller([pageOutcome('<html>ok</html>')]);
  await call(URL_A, SOLVER);
  assert.deepEqual(spy.order, ['used', 'assert']);
  assert.equal(spy.used, 1);
});

test('a target that is not safe never reaches the solver, and its error is the one the check raised', async () => {
  const verdict = Object.assign(new Error('Blocked unsafe URL'), { code: 'UNSAFE_URL' });
  const { call, spy, pool } = makeCaller([], { assertPublicUrl: async () => { throw verdict; } });
  await assert.rejects(call('http://127.0.0.1:9/x', SOLVER), (err) => err === verdict);
  assert.equal(pool.runs.length, 0);
  assert.equal(spy.used, 1, 'the idle watcher still saw the attempt');
});

test('a resolver that is down or slow does not stop the call: only a verdict does', async () => {
  for (const code of ['DNS_TIMEOUT', 'ENOTFOUND', undefined]) {
    const { call, pool } = makeCaller([pageOutcome('<html>ok</html>')], {
      assertPublicUrl: async () => { throw Object.assign(new Error('lookup failed'), { code }); },
    });
    assert.equal(await call(URL_A, SOLVER), '<html>ok</html>', String(code));
    assert.equal(pool.runs.length, 1);
  }
});

test('the page comes back and the cookies of the solve are saved for the site', async () => {
  const { call, spy, pool } = makeCaller([pageOutcome('<html>the page</html>')]);
  assert.equal(await call(URL_A, SOLVER), '<html>the page</html>');
  assert.deepEqual(spy.saved, [{ url: URL_A, cookies: [{ name: 'cf_clearance', value: 'c1' }], userAgent: 'solver-UA' }]);
  assert.deepEqual(pool.runs[0].request, { url: URL_A, solverUrl: SOLVER, cookies: undefined, preflight: pool.runs[0].request.preflight });
  assert.equal(typeof pool.runs[0].request.preflight, 'function');
});

test('a page the preflight fetched (mode direct) saves nothing: it carries no cookies of its own', async () => {
  const { call, spy } = makeCaller([pageOutcome('<html>direct</html>', { mode: 'direct' })]);
  assert.equal(await call(URL_A, SOLVER), '<html>direct</html>');
  assert.deepEqual(spy.saved, []);
});

test('a Chrome error page is an error naming the site, after its cookies were saved as before', async () => {
  const { call, spy } = makeCaller([pageOutcome('<html>chrome-error://chromewebdata/</html>')]);
  await assert.rejects(call(URL_A, SOLVER), { message: 'cf-site.example unavailable (server unreachable). Try again in a moment.' });
  assert.equal(spy.saved.length, 1);
});

test('an answer that is not a page fails with FlareSolverr\'s own words', async () => {
  const failed = { data: { status: 'error', message: 'Error solving the challenge. Timeout after 35.0 seconds.' }, mode: 'stateless' };
  await assert.rejects(makeCaller([failed]).call(URL_A, SOLVER), { message: 'FlareSolverr failed: Error solving the challenge. Timeout after 35.0 seconds.' });
  await assert.rejects(makeCaller([{ data: { status: 'error' }, mode: 'stateless' }]).call(URL_A, SOLVER), { message: 'FlareSolverr failed: Unknown error' });
  await assert.rejects(makeCaller([pageOutcome('')]).call(URL_A, SOLVER), { message: 'FlareSolverr failed: Unknown error' });
});

test('the words of an answer that is not a page lose their addresses and local paths on the way to the user', async () => {
  const failed = { data: { status: 'error', message: 'Error: cannot use proxy socks5://user:secret@10.0.0.1:1080\nstack line at C:\\Users\\me\\x.py' }, mode: 'stateless' };
  await assert.rejects(makeCaller([failed]).call(URL_A, SOLVER), (err) => {
    assert.equal(err.message, 'FlareSolverr failed: Error: cannot use proxy');
    assert.doesNotMatch(err.message, /secret|10\.0\.0\.1|Users|stack/);
    return true;
  });
});

test('our own timeout or abort restarts a wedged FlareSolverr once and is rethrown as the same object', async () => {
  for (const name of ['TimeoutError', 'AbortError']) {
    const timeout = Object.assign(new Error('aborted'), { name });
    const { call, spy } = makeCaller([timeout]);
    await assert.rejects(call(URL_A, SOLVER), (err) => err === timeout);
    assert.equal(spy.recovered, 1, name);
  }
});

test('a refused connection becomes "FlareSolverr is not reachable", keeps its cause, and restarts it', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const { call, spy } = makeCaller([refused]);
  await assert.rejects(call(URL_A, SOLVER), (err) => {
    assert.equal(err.code, 'FLARESOLVERR_UNAVAILABLE');
    assert.equal(err.code, CALLER_ERROR_CODES.UNAVAILABLE);
    assert.equal(err.message, MESSAGES.unreachable);
    assert.match(err.message, /Cloudflare/);
    assert.doesNotMatch(err.message, /cf-site\.example/);
    assert.equal(err.cause, refused);
    assert.equal(Object.keys(err).includes('cause'), false);
    return true;
  });
  assert.equal(spy.recovered, 1);
});

test('any other failed connection keeps Node\'s error but still asks for a restart; other errors are left alone', async () => {
  const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  const first = makeCaller([reset]);
  await assert.rejects(first.call(URL_A, SOLVER), (err) => err === reset);
  assert.equal(first.spy.recovered, 1);

  for (const other of [new Error('FlareSolverr HTTP 502'), Object.assign(new Error('busy'), { code: 'SOLVER_QUEUE_TIMEOUT', noRetry: true })]) {
    const { call, spy } = makeCaller([other]);
    await assert.rejects(call(URL_A, SOLVER), (err) => err === other);
    assert.equal(spy.recovered, 0, other.message);
  }
});

test('a pool that is restarting or known to be down says so: its own words, no retry, no new restart, and never "switched off"', async () => {
  const cases = [
    [POOL_ERROR_CODES.RESTARTING, MESSAGES.restarting],
    [POOL_ERROR_CODES.DOWN, MESSAGES.down],
  ];
  for (const [code, words] of cases) {
    const refused = refusal(code);
    const { call, spy } = makeCaller([refused]);
    await assert.rejects(call(URL_A, SOLVER), (err) => {
      assert.equal(err, refused, 'the refusal of the pool, as it is');
      assert.equal(err.code, code);
      assert.equal(err.message, words);
      assert.equal(err.noRetry, true, 'fetchText must not retry a state that a second try cannot change');
      assert.doesNotMatch(err.message, /switched off|not installed|not reachable|Turn FlareSolverr on/i, 'FlareSolverr is on; telling the user to turn it on would be false');
      assert.notEqual(err.code, CALLER_ERROR_CODES.UNAVAILABLE);
      // The wording lands in the same System Health bucket as the rest of the Cloudflare problems, as a warning.
      const classified = classifySourceError(err.message);
      assert.equal(classified.key, 'cloudflare_or_challenge');
      assert.equal(isTransientSourceErrorKey(classified.key), true);
      return true;
    });
    assert.equal(spy.recovered, 0, code);
  }
});

test('only a refused connection is "switched off or not installed"; the pool refusing is not', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  await assert.rejects(makeCaller([refused]).call(URL_A, SOLVER), (err) => err.code === CALLER_ERROR_CODES.UNAVAILABLE && /switched off/.test(err.message));
  for (const code of [POOL_ERROR_CODES.QUEUE_FULL, POOL_ERROR_CODES.QUEUE_TIMEOUT, POOL_ERROR_CODES.HOST_COOLDOWN, POOL_ERROR_CODES.SHUTTING_DOWN]) {
    await assert.rejects(makeCaller([refusal(code)]).call(URL_A, SOLVER), (err) => err.code === code && !/switched off/.test(err.message), code);
  }
});

test('callers asking for the very same page share one browser call; a different page or other cookies do not', async () => {
  const gate = [];
  const answer = () => new Promise((resolve) => gate.push(resolve));
  const { call, pool } = makeCaller([answer, answer, answer, answer]);

  const same = [call(URL_A, SOLVER), call(URL_A, SOLVER), call(`${URL_A}#frag`, SOLVER)];
  const otherPage = call('https://cf-site.example/b', SOLVER);
  const otherJar = call(URL_A, SOLVER, [{ name: 'sid', value: 'me' }]);
  await flushAll();
  assert.equal(pool.runs.length, 3, 'one for the three identical callers, one per page, one per cookie jar');

  gate.forEach((resolve, index) => resolve(pageOutcome(`<html>page ${index}</html>`)));
  const [a1, a2, a3] = await Promise.all(same);
  assert.equal(a1, a2);
  assert.equal(a2, a3);
  assert.notEqual(await otherPage, a1);
  assert.notEqual(await otherJar, a1);
});

test('a failure is not replayed: the next caller for the same page starts a new call', async () => {
  const { call, pool } = makeCaller([new Error('FlareSolverr HTTP 500'), pageOutcome('<html>second try</html>')]);
  await assert.rejects(call(URL_A, SOLVER), { message: 'FlareSolverr HTTP 500' });
  assert.equal(await call(URL_A, SOLVER), '<html>second try</html>');
  assert.equal(pool.runs.length, 2);
});

test('a caller that joins is as patient as it said: its priority and deadline reach the queued call', async () => {
  let release;
  const { call, pool } = makeCaller([() => new Promise((resolve) => { release = resolve; })]);

  const first = runWithSolverContext({ priority: 'background', deadlineAt: 1000, label: 'health' }, () => call(URL_A, SOLVER));
  const second = runWithSolverContext({ priority: 'interactive', deadlineAt: 9000 }, () => call(URL_A, SOLVER));
  await flushAll();
  release(pageOutcome('<html>shared</html>'));

  assert.deepEqual(await Promise.all([first, second]), ['<html>shared</html>', '<html>shared</html>']);
  assert.equal(pool.runs.length, 1);
  assert.deepEqual(pool.runs[0].ctx, { priority: 'background', boundSolve: false, deadlineAt: 1000, label: 'health' }, 'the first caller\'s own patience');
  assert.deepEqual(pool.handles[0].calls, [['promote', 'interactive'], ['extendDeadline', 9000]]);
});

test('a bot-check shell inside a session is asked for once more, and what the first attempt earned is kept', async () => {
  const { call, spy, pool } = makeCaller([pageOutcome(SHELL), pageOutcome('<html>real page</html>')]);
  assert.equal(await call(URL_A, SOLVER), '<html>real page</html>');
  assert.equal(pool.runs.length, 2);
  assert.equal(pool.runs[1].request.url, URL_A, 'the same page, in the same browser session');
  assert.equal(spy.saved.length, 2, 'the cookies of the shell attempt were saved too, as a one-off browser always did');
});

test('the shell is asked for once and no more: a second shell is returned for the caller to report', async () => {
  const { call, pool } = makeCaller([pageOutcome(SHELL), pageOutcome(SHELL), pageOutcome('<html>never asked</html>')]);
  assert.equal(await call(URL_A, SOLVER), SHELL);
  assert.equal(pool.runs.length, 1 + POOL.shellResolveRetries);

  const saved = POOL.shellResolveRetries;
  POOL.shellResolveRetries = 0;
  try {
    const none = makeCaller([pageOutcome(SHELL), pageOutcome('<html>never asked</html>')]);
    assert.equal(await none.call(URL_A, SOLVER), SHELL);
    assert.equal(none.pool.runs.length, 1);
  } finally {
    POOL.shellResolveRetries = saved;
  }
});

test('a one-off browser keeps its old behaviour: the shell is returned as it is, never asked for again', async () => {
  const { call, pool } = makeCaller([pageOutcome(SHELL, { mode: 'stateless' }), pageOutcome('<html>never asked</html>')]);
  assert.equal(await call(URL_A, SOLVER), SHELL);
  assert.equal(pool.runs.length, 1);
});

test('a joiner who arrives during the second ask is applied to it as well', async () => {
  let releaseFirst;
  const { call, pool } = makeCaller([
    () => new Promise((resolve) => { releaseFirst = resolve; }),
    () => new Promise(() => {}),
  ]);
  call(URL_A, SOLVER).catch(() => {});
  runWithSolverContext({ priority: 'interactive', deadlineAt: 7000 }, () => call(URL_A, SOLVER)).catch(() => {});
  await flushAll();
  releaseFirst(pageOutcome(SHELL));
  await flushAll();

  assert.equal(pool.runs.length, 2);
  assert.deepEqual(pool.handles[1].calls, [['promote', 'interactive'], ['extendDeadline', 7000]]);
});

test('a call carrying cookies is a request of its own: no preflight, because an anonymous page would be the wrong page', async () => {
  const jar = [{ name: 'sid', value: 'me' }];
  const { call, pool } = makeCaller([pageOutcome('<html>my page</html>', { mode: 'stateless' })]);
  assert.equal(await call(URL_A, SOLVER, jar), '<html>my page</html>');
  assert.equal(pool.runs[0].request.cookies, jar);
  assert.equal('preflight' in pool.runs[0].request, false);
});

function preflightOf(pool) {
  return pool.runs[0].request.preflight;
}

test('the preflight answers a queued call only when a cookie was saved after the call was queued, and tries each cookie once', async () => {
  const html = '<html>the real page</html>';
  const fetched = [];
  let session = null;
  const { call, pool } = makeCaller([() => new Promise(() => {})], {
    getDomainSession: () => session,
    safeFetch: async (url, init) => { fetched.push({ url, headers: init.headers }); return { ok: true, text: async () => html }; },
  });
  call(URL_A, SOLVER).catch(() => {});
  await flushAll();
  const preflight = preflightOf(pool);

  assert.equal(await preflight(), undefined, 'no cookie saved at all: nothing to try');
  session = { cookieHeader: 'cf_clearance=old', userAgent: 'old-UA', timestamp: 0 };
  assert.equal(await preflight(), undefined, 'a cookie from before the call was queued says nothing new');
  assert.deepEqual(fetched, []);

  session = { cookieHeader: 'cf_clearance=fresh', userAgent: 'fresh-UA', timestamp: Date.now() + 60_000 };
  assert.deepEqual(await preflight(), { data: { status: 'ok', solution: { response: html, cookies: [], userAgent: 'fresh-UA' } } });
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0].url, URL_A);
  assert.equal(fetched[0].headers.Cookie, 'cf_clearance=fresh');
  assert.equal(fetched[0].headers['User-Agent'], 'fresh-UA');

  assert.equal(await preflight(), undefined, 'the same cookie is not tried twice by one call');
  assert.equal(fetched.length, 1);
  session = { cookieHeader: 'cf_clearance=fresher', userAgent: 'fresher-UA', timestamp: Date.now() + 120_000 };
  assert.ok((await preflight()).data, 'a newer cookie is a new try');
  assert.equal(fetched.length, 2);
  assert.equal(fetched[1].headers.Cookie, 'cf_clearance=fresher');
});

test('the preflight says "no" for anything but a real page, and never throws', async () => {
  const session = { cookieHeader: 'c=1', userAgent: 'UA', timestamp: Date.now() + 60_000 };
  const answers = [
    async () => ({ ok: false, text: async () => 'forbidden' }),
    async () => ({ ok: true, text: async () => SHELL }),
    async () => ({ ok: true, text: async () => 'Just a moment...' }),
    async () => ({ ok: true, text: async () => '' }),
    async () => { throw new Error('socket hang up'); },
    async () => ({ ok: true, text: async () => { throw new Error('body aborted'); } }),
  ];
  for (const safeFetch of answers) {
    const { call, pool } = makeCaller([() => new Promise(() => {})], { getDomainSession: () => session, safeFetch });
    call(URL_A, SOLVER).catch(() => {});
    await flushAll();
    assert.equal(await preflightOf(pool)(), null);
  }
});

test('a proof-of-work page is retried with the cookies just saved, after the call has been answered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pow = '<html><script>/_v powNonce</script></html>';
  const seen = [];
  const { call, pool } = makeCaller([pageOutcome(pow)], {
    getDomainSession: () => ({ cookieHeader: 'cf_clearance=c1', userAgent: 'solver-UA', timestamp: 1 }),
    safeFetch: async (url, init) => { seen.push({ url, headers: init.headers }); return { ok: true, text: async () => '<html>real</html>' }; },
  });

  const pending = call(URL_A, SOLVER);
  await flushAll();
  assert.equal(pool.runs.length, 1);
  assert.deepEqual(seen, [], 'it waits first');
  t.mock.timers.tick(2000);

  assert.equal(await pending, '<html>real</html>');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.Cookie, 'cf_clearance=c1');
  assert.equal(seen[0].headers['User-Agent'], 'solver-UA');
});

test('when the plain retry does not give the page the proof-of-work page is returned as it was', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pow = '<html><script>/_v pow_hash</script></html>';
  const bad = [
    async () => ({ ok: true, text: async () => '<html>/_v still</html>' }),
    async () => ({ ok: false, text: async () => 'no' }),
    async () => { throw new Error('refused'); },
  ];
  for (const safeFetch of bad) {
    const { call } = makeCaller([pageOutcome(pow)], { safeFetch });
    const pending = call(URL_A, SOLVER);
    await flushAll();
    t.mock.timers.tick(2000);
    assert.equal(await pending, pow);
  }
});

test('an ordinary page is returned at once: no wait and no plain request', async () => {
  const { call } = makeCaller([pageOutcome('<html>/_v alone is not a challenge</html>')]);
  assert.equal(await call(URL_A, SOLVER), '<html>/_v alone is not a challenge</html>');
});
