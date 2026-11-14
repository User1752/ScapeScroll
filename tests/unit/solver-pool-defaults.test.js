'use strict';

// The size the pool has when nobody chose one. Two, so that a System Health probe or an interactive
// read does not queue behind one long Cloudflare solve; but slots are opened lazily, so an app that is
// idle (or only ever asks for one site) still holds at most one browser.
// Real fake FlareSolverr on loopback; the rig checks the session discipline when each test ends.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL, SETTINGS_DEFAULTS, SETTINGS_BOUNDS } = require('../../server/config/solver');
const { A, B, until, creates, rig } = require('../helpers/solver-pool-rig');

test('the default size is two and sits inside the bounds of the setting (1 to 3)', () => {
  assert.equal(SETTINGS_DEFAULTS.solverSessionPoolSize, 2);
  assert.equal(POOL.defaultMaxSessions, 2);
  assert.deepEqual({ ...SETTINGS_BOUNDS.solverSessionPoolSize }, { min: 1, max: 3 });
});

// No size passed: the pool takes its own default, which is the thing under test.
async function defaultRig(t, options = {}) {
  const r = await rig(t, { apply: false, ...options });
  r.pool.applySettings({ enabled: true, disabledBy: null, idleMinutes: 10 });
  return r;
}

test('an idle pool holds no browser, and one site asked for twice at once still uses one', async (t) => {
  const r = await defaultRig(t, { fakeOptions: { latencyMs: 40 } });
  assert.deepEqual(r.pool.getStatus().sessions, [], 'nothing is opened up front');
  assert.equal(r.fake.log.length, 0);

  await Promise.all([r.run(A, '/one').promise, r.run(A, '/two').promise]);
  await r.settled();
  assert.equal(creates(r.fake).length, 1, 'the second call of the site waits for the browser that holds its cookies');
  assert.equal(r.pool.getStatus().sessions.length, 1);
});

test('a second browser appears only when a different site has to wait for the first', async (t) => {
  const r = await defaultRig(t, { fakeOptions: { latencyMs: 80 } });
  const first = r.run(A, '/slow').promise;
  await until(() => creates(r.fake).length === 1, 'the first browser');
  const second = r.run(B, '/other').promise;
  await Promise.all([first, second]);
  await r.settled();

  assert.equal(creates(r.fake).length, 2, 'the probe of another site did not queue behind the first solve');
  assert.equal(r.fake.peakInFlight, 2);
  assert.equal(r.pool.getStatus().sessions.length, 2);
});

test('a third site still waits: the pool never grows beyond the default', async (t) => {
  const r = await defaultRig(t, { fakeOptions: { latencyMs: 60 } });
  const jobs = [r.run(A, '/a').promise, r.run(B, '/b').promise, r.run('https://third-site.example', '/c').promise];
  await Promise.all(jobs);
  await r.settled();
  assert.equal(creates(r.fake).length, 2);
  assert.equal(r.fake.peakInFlight, 2);
});
