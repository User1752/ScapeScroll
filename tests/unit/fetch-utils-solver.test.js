'use strict';

// How fetch-utils talks to FlareSolverr: the real module and the real session pool against a fake
// FlareSolverr on loopback, with the lifecycle module replaced by a stand-in that only counts
// (exactly as flaresolverr-unreachable.test.js does), so nothing here starts or restarts a real
// FlareSolverr, opens a browser or reaches the network. The sites do not exist: every name resolves
// to a public address, and the plain requests to them are answered by the test (or, when it says
// nothing, with a Cloudflare challenge). tests/helpers/fetch-utils-rig.js guards the whole file: a
// request to anything else is refused and fails the test that made it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL, MESSAGES } = require('../../server/config/solver');
const { runWithSolverContext } = require('../../server/modules/network/solver-context');
const { USER_AGENT } = require('../helpers/fake-flaresolverr');
const { navigations, creates, destroys, commands, until } = require('../helpers/solver-pool-rig');
const { SITE, loadFetchUtils, stubDns, stubSite, rig, guard } = require('../helpers/fetch-utils-rig');
const { classifySourceError } = require('../../server/modules/system-health/service');

// Real timers with tiny values: nothing in this file waits for the real 1.5 s between two
// navigations to one site. The pool copies POOL when fetch-utils builds it.
Object.assign(POOL, { hostSpacingMs: 30, blankResetSettleMs: 5, launchRetryDelayMs: 5 });

const BAT_SHELL = '<html><script>({ webdriver: navigator.webdriver===true })</script></html>';

// The requests that went to a page (not a session command, not a blank reset).
const visits = (fake, path) => navigations(fake).filter((e) => new URL(e.url).pathname === path);

// The cookie argument is optional: where it is not there, the tests that need it are skipped.
const HAS_COOKIES_ARG = loadFetchUtils().executeFlareSolverr.length >= 3;
const cookieTest = { skip: !HAS_COOKIES_ARG && 'no cookies argument in this build' };

// The regression this whole change starts from (written first; it failed on 3.1.2, where both calls
// came back with page A): the per-domain lock handed the page of the first caller to every caller for the
// site, so a burst of different pages (cover enrichment) cached wrong pages.
test('two concurrent calls for different pages of one site each get their own page, pool off', async (t) => {
  const { fake, executeFlareSolverr } = await rig(t, { pool: false, fakeOptions: { latencyMs: 20 } });
  fake.page(/\/a$/, { html: '<html>PAGE-A</html>' });
  fake.page(/\/b$/, { html: '<html>PAGE-B</html>' });

  const [a, b] = await Promise.all([
    executeFlareSolverr(`${SITE}/a`, fake.url),
    executeFlareSolverr(`${SITE}/b`, fake.url),
  ]);

  assert.equal(a, '<html>PAGE-A</html>');
  assert.equal(b, '<html>PAGE-B</html>');
});

test('the same with the pool on: each gets its own page, one after the other in one browser session', async (t) => {
  const { fake, executeFlareSolverr } = await rig(t, { fakeOptions: { latencyMs: 20 } });
  fake.page(/\/a$/, { html: '<html>PAGE-A</html>' });
  fake.page(/\/b$/, { html: '<html>PAGE-B</html>' });

  const [a, b] = await Promise.all([
    executeFlareSolverr(`${SITE}/a`, fake.url),
    executeFlareSolverr(`${SITE}/b`, fake.url),
  ]);

  assert.equal(a, '<html>PAGE-A</html>');
  assert.equal(b, '<html>PAGE-B</html>');
  assert.equal(creates(fake).length, 1);
  assert.equal(fake.collisions, 0, 'two navigations never overlapped inside one session');
});

test('callers asking for the very same page share one navigation, with the pool on or off', async (t) => {
  for (const pool of [false, true]) {
    const { fake, executeFlareSolverr } = await rig(t, { pool, fakeOptions: { latencyMs: 60 } });
    const pages = await Promise.all([1, 2, 3].map(() => executeFlareSolverr(`${SITE}/same`, fake.url)));
    assert.equal(new Set(pages).size, 1);
    assert.equal(visits(fake, '/same').length, 1, `pool ${pool ? 'on' : 'off'}`);
  }
});

test('a page that fails does not fail the caller asking for another page of the site', async (t) => {
  for (const pool of [false, true]) {
    const { fake, executeFlareSolverr } = await rig(t, { pool, fakeOptions: { latencyMs: 30 } });
    fake.page(/\/bad$/, { errorMessage: 'Error solving the challenge. boom' });
    const [bad, good] = await Promise.allSettled([
      executeFlareSolverr(`${SITE}/bad`, fake.url),
      executeFlareSolverr(`${SITE}/good`, fake.url),
    ]);
    assert.equal(bad.status, 'rejected', `pool ${pool ? 'on' : 'off'}`);
    assert.equal(good.status, 'fulfilled');
    assert.match(good.value, /fake page for https:\/\/cf-site\.example\/good/);
  }
});

test('the pool is off until it is told otherwise: the plain one-off request of 3.1.2, nothing else', async (t) => {
  const { fake, fu, calls, executeFlareSolverr } = await rig(t, { pool: false });
  assert.equal(fu.getSolverPool().getStatus().state, 'disabled');

  const html = await executeFlareSolverr(`${SITE}/legacy`, fake.url);

  assert.match(html, /fake page for https:\/\/cf-site\.example\/legacy/);
  assert.equal(fake.log.length, 1, 'no sessions.* command of any kind');
  const [entry] = fake.log;
  assert.deepEqual([entry.cmd, entry.session, entry.maxTimeout, entry.proxy, entry.hadCookies], ['request.get', null, 35000, null, false]);
  assert.equal(calls.used, 1);
});

test('the page comes back, and the cookie and user agent of the solve are saved for the site', async (t) => {
  const { fake, fu, executeFlareSolverr } = await rig(t);
  assert.equal(fu.getDomainSession(`${SITE}/page`), null);

  await executeFlareSolverr(`${SITE}/page`, fake.url);

  const session = fu.getDomainSession(`${SITE}/other-page`);
  assert.match(session.cookieHeader, /cf_clearance=clearance-cf-site\.example/);
  assert.equal(session.userAgent, USER_AGENT);
});

test('sites under a two-level suffix such as co.uk no longer share each other\'s saved cookies', async (t) => {
  const { fu } = await rig(t, { pool: false });
  fu.saveDomainSession('https://one.co.uk/x', [{ name: 'k', value: '1' }], 'UA');

  assert.equal(fu.getDomainSession('https://two.co.uk/y'), null, 'it used to be found under "co.uk"');
  assert.equal(fu.getDomainSession('https://www.one.co.uk/y').cookieHeader, 'k=1');
  assert.equal(fu.getDomainSession('https://sub.one.co.uk/y').cookieHeader, 'k=1', 'a subdomain of the site shares the site\'s cookie');
  assert.equal(fu.getDomainSession('https://elsewhere.example/', 'https://one.co.uk/ref').cookieHeader, 'k=1', 'the referer counts too');
});

test('a target that is not safe never reaches FlareSolverr; a resolver that fails does not stop the call', async (t) => {
  const { fake, executeFlareSolverr } = await rig(t);
  stubDns(t, {
    'internal.example': '10.0.0.5',
    'slow-dns.example': Object.assign(new Error('lookup timed out'), { code: 'DNS_TIMEOUT' }),
    'gone.example': Object.assign(new Error('not found'), { code: 'ENOTFOUND' }),
  });

  await assert.rejects(executeFlareSolverr('http://127.0.0.1:9/x', fake.url), { code: 'UNSAFE_URL' });
  await assert.rejects(executeFlareSolverr('http://[::1]:9/x', fake.url), { code: 'UNSAFE_URL' });
  await assert.rejects(executeFlareSolverr('https://internal.example/x', fake.url), { code: 'UNSAFE_URL' });
  await assert.rejects(executeFlareSolverr('file:///etc/passwd', fake.url), { code: 'UNSAFE_URL' });
  assert.equal(fake.log.length, 0, 'not one request reached the solver');

  assert.match(await executeFlareSolverr('https://slow-dns.example/x', fake.url), /slow-dns\.example/);
  assert.match(await executeFlareSolverr('https://gone.example/x', fake.url), /gone\.example/);
});

test('the pool is paused while FlareSolverr restarts: the lifecycle\'s begin and end reach it', async (t) => {
  const listeners = [];
  const { pool } = await rig(t, { lifecycle: { registerRestartListener(listener) { listeners.push(listener); return () => {}; } } });

  assert.equal(listeners.length, 1, 'fetch-utils registers the pool once');
  listeners[0]({ phase: 'begin', reason: 'test restart' });
  assert.equal(pool.getStatus().state, 'restarting');
  listeners[0]({ phase: 'end', ok: true });
  assert.equal(pool.getStatus().state, 'idle');
});

test('queued calls are answered without a browser when the cookie saved meanwhile lets a plain request through', async (t) => {
  // The calls queue behind a busy one. When it finishes and its cookie is saved, each waiting call is
  // tried with a plain request carrying that cookie, one at a time, before it would take the browser.
  const { fake, executeFlareSolverr } = await rig(t, { fakeOptions: { latencyMs: 150 } });
  const plain = stubSite(t, async () => new Response('<html>PLAIN PAGE</html>', { status: 200 }));

  const busy = executeFlareSolverr(`${SITE}/busy`, fake.url);
  await until(() => visits(fake, '/busy').length === 1, 'the browser to be taken');
  const paths = ['/q1', '/q2', '/q3'];
  const queued = paths.map((path) => executeFlareSolverr(`${SITE}${path}`, fake.url));

  await busy; // saves a cookie for the site
  const pages = await Promise.all(queued);

  assert.deepEqual(pages, ['<html>PLAIN PAGE</html>', '<html>PLAIN PAGE</html>', '<html>PLAIN PAGE</html>']);
  for (const path of paths) assert.equal(visits(fake, path).length, 0, `${path} never took the browser`);
  assert.deepEqual(plain.map((request) => request.url), paths.map((path) => `${SITE}${path}`), 'one plain request each, one at a time');
  assert.match(plain[0].headers.Cookie, /cf_clearance=/, 'carrying the cookie the first call saved');
  assert.equal(creates(fake).length, 1);
});

test('a bot-check shell inside a session is asked for once more; a one-off browser returns it as it is', async (t) => {
  const on = await rig(t, { fakeOptions: {} });
  on.fake.page(`${SITE}/bat`, { html: BAT_SHELL, times: 1 });
  assert.match(await on.executeFlareSolverr(`${SITE}/bat`, on.fake.url), /fake page for https:\/\/cf-site\.example\/bat/);
  assert.equal(visits(on.fake, '/bat').length, 2, 'asked twice, in the same session');
  assert.equal(creates(on.fake).length, 1);

  const off = await rig(t, { pool: false });
  off.fake.page(`${SITE}/bat`, { html: BAT_SHELL });
  assert.equal(await off.executeFlareSolverr(`${SITE}/bat`, off.fake.url), BAT_SHELL);
  assert.equal(visits(off.fake, '/bat').length, 1);

  const stuck = await rig(t, { fakeOptions: {} });
  stuck.fake.page(`${SITE}/bat`, { html: BAT_SHELL });
  assert.equal(await stuck.executeFlareSolverr(`${SITE}/bat`, stuck.fake.url), BAT_SHELL, 'the shell is left for the caller to report');
  assert.equal(visits(stuck.fake, '/bat').length, 2, 'asked once more, not forever');
});

test('a proof-of-work page is retried with the saved cookie after the browser was released', async (t) => {
  const { fake, executeFlareSolverr } = await rig(t);
  fake.page(`${SITE}/pow`, { html: '<html><script>/_v powNonce</script></html>' });
  const plain = stubSite(t, async () => new Response('<html>REAL PAGE</html>', { status: 200 }));

  const first = executeFlareSolverr(`${SITE}/pow`, fake.url);
  // The blank reset is sent after the call was answered, so by then its cookie is saved and the call
  // is waiting out its 2 s; a call queued now is not answered from that cookie (it is older than the call).
  await until(() => fake.log.some((entry) => entry.url === 'about:blank'), 'the first call to be answered');
  const startedAt = Date.now();
  const other = await executeFlareSolverr(`${SITE}/other`, fake.url);

  assert.match(other, /fake page for https:\/\/cf-site\.example\/other/);
  assert.ok(Date.now() - startedAt < 1500, 'the browser was free while the first call waits out its 2 s');
  assert.equal(await first, '<html>REAL PAGE</html>');
  assert.equal(plain.length, 1);
  assert.match(plain[0].headers.Cookie, /cf_clearance=/);
});

test('a caller that joins a queued call keeps it alive past the short deadline of the caller who queued it', async (t) => {
  const { fake, executeFlareSolverr } = await rig(t, { fakeOptions: { latencyMs: 120 } });
  const busy = executeFlareSolverr(`${SITE}/busy`, fake.url);
  await until(() => visits(fake, '/busy').length === 1, 'the browser to be taken');

  // Control: alone, a background call with a 40 ms deadline is dropped from the queue.
  const alone = runWithSolverContext({ priority: 'background', deadlineAt: Date.now() + 40 }, () => executeFlareSolverr(`${SITE}/alone`, fake.url));
  await assert.rejects(alone, (err) => err.code === 'SOLVER_QUEUE_TIMEOUT' && err.noRetry === true);

  const impatient = runWithSolverContext({ priority: 'background', deadlineAt: Date.now() + 40 }, () => executeFlareSolverr(`${SITE}/shared`, fake.url));
  const patient = runWithSolverContext({ priority: 'interactive', deadlineAt: Date.now() + 8000 }, () => executeFlareSolverr(`${SITE}/shared`, fake.url));
  const [a, b] = await Promise.all([impatient, patient]);

  assert.equal(a, b);
  assert.match(a, /\/shared/);
  assert.equal(visits(fake, '/shared').length, 1);
  await busy;
});

test('a declared deadline only bounds the wait in the queue: the navigation keeps its 35 s unless the caller asks (boundSolve)', async (t) => {
  const { fake, executeFlareSolverr } = await rig(t);

  await runWithSolverContext({ priority: 'background', deadlineAt: Date.now() + 8000 }, () => executeFlareSolverr(`${SITE}/patient`, fake.url));
  await runWithSolverContext({ priority: 'background', deadlineAt: Date.now() + 8000, boundSolve: true }, () => executeFlareSolverr(`${SITE}/bound`, fake.url));

  assert.equal(visits(fake, '/patient')[0].maxTimeout, 35000);
  const bound = visits(fake, '/bound')[0].maxTimeout;
  assert.ok(bound >= 5000 && bound <= 7000, `derived from the deadline, floor 5 s: ${bound}`);
});

test('the proxy of Settings goes to sessions.create only; a new password recycles the session; nothing shows in the status', async (t) => {
  const settings = { flaresolverrUrl: null, proxyUrl: 'http://proxy.example:8080', proxyUsername: 'alice-proxy', proxyPassword: 'pw-secret-one' };
  const { fake, pool, executeFlareSolverr } = await rig(t, { readStore: async () => ({ settings }) });
  settings.flaresolverrUrl = fake.url;

  await executeFlareSolverr(`${SITE}/p1`, fake.url);
  assert.deepEqual(creates(fake)[0].proxy, { url: 'http://proxy.example:8080', username: 'alice-proxy', password: 'pw-secret-one' });
  assert.equal(visits(fake, '/p1')[0].proxy, null, 'FlareSolverr ignores a proxy on a session request, so none is sent');

  settings.proxyPassword = 'pw-secret-two';
  await executeFlareSolverr(`${SITE}/p2`, fake.url);
  assert.equal(creates(fake).length, 2, 'a new password means a new session');
  assert.equal(creates(fake)[1].proxy.password, 'pw-secret-two');
  assert.equal(destroys(fake).length, 1, 'and the old one was closed');

  const shown = JSON.stringify(pool.getStatus());
  for (const secret of ['alice-proxy', 'pw-secret', 'proxy.example']) assert.ok(!shown.includes(secret), secret);
});

test('a proxy that was configured and a library that cannot be read any more: the job fails, nothing leaves on the own address', async (t) => {
  for (const pool of [true, false]) {
    let broken = false;
    const settings = { flaresolverrUrl: null, proxyUrl: 'http://proxy.example:8080' };
    const readStore = async () => {
      if (broken) throw new Error('library unreadable');
      return { settings };
    };
    const { fake, pool: instance, executeFlareSolverr } = await rig(t, { pool, readStore });
    settings.flaresolverrUrl = fake.url;

    await executeFlareSolverr(`${SITE}/while-readable`, fake.url);
    await until(() => instance.getStatus().sessions.every((session) => !session.busy), 'the browser to be parked');
    const sent = fake.log.length;

    broken = true;
    await assert.rejects(executeFlareSolverr(`${SITE}/while-broken`, fake.url), { message: MESSAGES.proxyUnreadable }, `pool ${pool ? 'on' : 'off'}`);
    assert.equal(fake.log.length, sent, 'not one request reached FlareSolverr, so no browser ran without the proxy');

    broken = false;
    assert.match(await executeFlareSolverr(`${SITE}/readable-again`, fake.url), /readable-again/, 'and it works again as soon as the setting can be read');
  }
});

test('with the pool off the proxy rides the one-off request, as it always did', async (t) => {
  const settings = { flaresolverrUrl: null, proxyUrl: 'http://proxy.example:8080' };
  const { fake, executeFlareSolverr } = await rig(t, { pool: false, readStore: async () => ({ settings }) });
  await executeFlareSolverr(`${SITE}/p`, fake.url);
  assert.deepEqual(fake.log[0].proxy, { url: 'http://proxy.example:8080' });
});

test('a pool refusal that retrying cannot fix stops fetchText at once (noRetry)', async (t) => {
  const savedQueue = POOL.queue.maxQueued;
  POOL.queue.maxQueued = 0; // every call is refused as "queue full"; read when fetch-utils builds the pool
  t.after(() => { POOL.queue.maxQueued = savedQueue; });
  const { fu } = await rig(t);
  const site = stubSite(t, async () => new Response('forbidden', { status: 403 }));

  const startedAt = Date.now();
  await assert.rejects(fu.fetchText(`${SITE}/list`), (err) => err.code === 'SOLVER_QUEUE_FULL' && err.noRetry === true);
  assert.equal(site.length, 1, 'one plain attempt: no second round after a back-off');
  assert.ok(Date.now() - startedAt < 1000);
});

// With FlareSolverr off the pool is still ON (the default). Its fail-fast window is for a wedged solver only: a refused
// connection must keep giving every call the 3.1.2 words, and must not take the retry of a blip away.
test('with FlareSolverr refusing connections every protected-site call gets the "not reachable" words, and a blip is still retried', async (t) => {
  const { fake, fu } = await rig(t);
  await fake.switchOff();

  stubSite(t, async () => new Response('forbidden', { status: 403 }));
  for (const page of ['one', 'two', 'three', 'four']) {
    await assert.rejects(fu.fetchText(`${SITE}/${page}`), (err) => {
      assert.equal(err.code, 'FLARESOLVERR_UNAVAILABLE', page);
      assert.equal(err.message, MESSAGES.unreachable);
      assert.equal(err.noRetry, undefined);
      return true;
    });
  }
  assert.notEqual(fu.getSolverPool().getStatus().state, 'down');

  let asked = 0;
  stubSite(t, async () => (++asked === 1 ? new Response('busy', { status: 503 }) : new Response('<html>the page</html>', { status: 200 })));
  assert.equal(await fu.fetchText(`${SITE}/blip`), '<html>the page</html>');
  assert.equal(asked, 2, 'the second attempt happened: the refused solver did not take the retry away');
});

test('a Chrome error page about the proxy is an error, not the site\'s content', async (t) => {
  const { fake, fu, executeFlareSolverr } = await rig(t);
  for (const marker of ['ERR_TUNNEL_CONNECTION_FAILED', 'ERR_PROXY_CONNECTION_FAILED']) {
    assert.equal(fu.isChromeErrorPage(`<html>net::${marker}</html>`), true, marker);
    fake.page(`${SITE}/${marker}`, { html: `<html><body>This site can't be reached net::${marker}</body></html>` });
    await assert.rejects(executeFlareSolverr(`${SITE}/${marker}`, fake.url), { message: 'cf-site.example unavailable (server unreachable). Try again in a moment.' });
  }
  assert.equal(fu.isChromeErrorPage('<html>an ordinary page</html>'), false);
  assert.equal(fu.isChromeErrorPage('<html>ERR_CONNECTION_REFUSED</html>'), true, 'the old markers still count');
});

test('a call carrying cookies goes to a one-off browser of its own and never joins or feeds the shared session', cookieTest, async (t) => {
  const { fake, executeFlareSolverr } = await rig(t, { fakeOptions: { latencyMs: 40 } });
  const jar = [{ name: 'sid', value: 'mine', domain: 'cf-site.example' }];

  const [mine, anonymous] = await Promise.all([
    executeFlareSolverr(`${SITE}/account`, fake.url, jar),
    executeFlareSolverr(`${SITE}/account`, fake.url),
  ]);
  assert.match(mine, /\/account/);
  assert.match(anonymous, /\/account/);

  const entries = visits(fake, '/account');
  assert.equal(entries.length, 2, 'two different requests, not one shared answer');
  const withCookies = entries.filter((e) => e.hadCookies);
  assert.equal(withCookies.length, 1);
  assert.equal(withCookies[0].session, null, 'cookies never go into a shared session');
  assert.equal(withCookies[0].stateless, true);
  assert.equal(entries.find((e) => !e.hadCookies).hadCookies, false);
});

test('the pool\'s commands never carry anything FlareSolverr would read wrongly, over a whole mixed run', async (t) => {
  const { fake, executeFlareSolverr } = await rig(t, { settings: { maxSessions: 2 }, fakeOptions: { latencyMs: 15 } });
  await Promise.all([`${SITE}/m1`, `${SITE}/m2`, 'https://other-site.example/m3', `${SITE}/m1`].map((url) => executeFlareSolverr(url, fake.url)));
  assert.ok(commands(fake, 'sessions.create').length >= 1);
  // assertSessionDiscipline runs when the test ends: no lazily created session, no ttl, no proxy or cookies on a session request.
});

test('a pool that is restarting says so and is not retried, instead of claiming FlareSolverr is switched off', async (t) => {
  const listeners = [];
  const { fu } = await rig(t, { lifecycle: { registerRestartListener(listener) { listeners.push(listener); return () => {}; } } });
  const site = stubSite(t, async () => new Response('forbidden', { status: 403 }));
  listeners[0]({ phase: 'begin', reason: 'test restart' });

  const startedAt = Date.now();
  const err = await runWithSolverContext({ deadlineAt: Date.now() + 80 }, () => fu.fetchText(`${SITE}/list`)).then(() => assert.fail('expected a refusal'), (e) => e);

  assert.equal(err.code, 'SOLVER_RESTARTING');
  assert.equal(err.noRetry, true);
  assert.equal(err.message, MESSAGES.restarting);
  assert.doesNotMatch(err.message, /switched off|not installed|not reachable|Turn FlareSolverr on/i);
  assert.equal(classifySourceError(err.message).key, 'cloudflare_or_challenge');
  assert.equal(site.length, 1, 'one plain attempt: a restart is not something a second round after a back-off can fix');
  assert.ok(Date.now() - startedAt < 1500);
  listeners[0]({ phase: 'end', ok: true });
});

test('this file cannot reach the real network: anything but the fake solver and the made-up sites is refused and fails the test', async (t) => {
  await rig(t, { pool: false });
  // The test that makes such a call fails when it ends (the rig checks the guard); this one makes
  // two on purpose, so it clears the record itself.
  await assert.rejects(fetch('https://www.iana.org/domains/reserved'), /test guard/);
  await assert.rejects(fetch('http://127.0.0.1:9/not-the-fake'), /test guard/);
  assert.equal(guard.strays.length, 2);
  guard.strays.length = 0;
  const challenge = await fetch(`${SITE}/anything`); // a made-up site answers, as the protected site it stands for
  assert.equal(challenge.status, 403);
});

test('the pool is told whether the user switched FlareSolverr off: a refused connection is then not reported on the console', async (t) => {
  const warns = [];
  t.mock.method(console, 'warn', (message) => warns.push(String(message)));
  for (const disabled of [true, false]) {
    warns.length = 0;
    const { fake, executeFlareSolverr } = await rig(t, { lifecycle: { isDisabled: () => disabled } });
    await fake.switchOff();
    await assert.rejects(executeFlareSolverr(`${SITE}/closed`, fake.url), { code: 'FLARESOLVERR_UNAVAILABLE' });
    assert.equal(warns.some((line) => /FlareSolverr is not reachable/.test(line)), !disabled, disabled ? 'switched off on purpose: silent' : 'on, and refusing connections: said');
  }
});
