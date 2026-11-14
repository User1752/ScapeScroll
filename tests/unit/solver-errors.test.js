'use strict';

// server/modules/network/solver/errors.js: the errors the pool hands to a caller.
// The texts themselves are run through the REAL System Health classifier in
// solver-pool-classify.test.js; here it is about codes and flags.

const test = require('node:test');
const assert = require('node:assert/strict');

const { POOL_ERROR_CODES, CALLER_ERROR_CODES, REFUSAL_KINDS, refusal, rejection } = require('../../server/modules/network/solver/errors');
const { assertPublicUrl } = require('../../server/modules/network/safe-fetch');
const { MESSAGES } = require('../../server/config/solver');

test('every refusal carries its code, a text, and the flag fetch-utils reads', () => {
  const rateLimited = refusal(POOL_ERROR_CODES.HOST_COOLDOWN);
  assert.equal(rateLimited.code, POOL_ERROR_CODES.HOST_COOLDOWN);
  assert.equal(rateLimited.message, MESSAGES.hostCooldown);
  assert.equal(rateLimited.rateLimited, true);
  assert.equal(rateLimited.noRetry, undefined);

  for (const code of [POOL_ERROR_CODES.QUEUE_FULL, POOL_ERROR_CODES.QUEUE_TIMEOUT, POOL_ERROR_CODES.RESTARTING, POOL_ERROR_CODES.DOWN, POOL_ERROR_CODES.SHUTTING_DOWN]) {
    const err = refusal(code);
    assert.equal(err.code, code);
    assert.equal(err.noRetry, true, code);
    assert.equal(err.rateLimited, undefined, code);
    assert.ok(err.message.length > 0);
  }
  assert.equal(refusal(POOL_ERROR_CODES.QUEUE_FULL).message, MESSAGES.busy);
  assert.equal(refusal(POOL_ERROR_CODES.QUEUE_TIMEOUT).message, MESSAGES.busy);
});

test('no pool error can be taken for a hung FlareSolverr', () => {
  for (const code of Object.values(POOL_ERROR_CODES)) {
    const err = code === POOL_ERROR_CODES.REJECTED ? rejection('timeout', 'https://cf-site.example/', 'x') : refusal(code);
    assert.notEqual(err.name, 'TimeoutError');
    assert.notEqual(err.name, 'AbortError');
  }
});

test('each refusal code has a kind for the status, except the one that is not a refusal', () => {
  for (const code of Object.values(POOL_ERROR_CODES)) {
    if (code === POOL_ERROR_CODES.REJECTED) assert.equal(REFUSAL_KINDS[code], undefined);
    else assert.equal(typeof REFUSAL_KINDS[code], 'string', code);
  }
});

test('a rejection carries the text a user sees and never the raw message of the solver', () => {
  const blocked = rejection('blocked', 'https://cf-site.example/x', 'Cloudflare has blocked this request');
  assert.equal(blocked.code, POOL_ERROR_CODES.REJECTED);
  assert.equal(blocked.kind, 'blocked');
  assert.equal(blocked.message, MESSAGES.blocked);
  assert.equal('solverMessage' in blocked, false, 'the raw text can hold an address or a path');
  assert.equal(blocked.rateLimited, true);

  for (const kind of ['timeout', 'driver', 'launch', 'proxy']) {
    const err = rejection(kind, 'https://cf-site.example/x', 'raw text');
    assert.equal(err.message, MESSAGES[kind], kind);
    assert.equal(err.kind, kind);
    assert.equal('solverMessage' in err, false, kind);
    assert.equal(err.rateLimited, undefined, kind);
  }
});

test('a navigation problem names the site (without www), an unreadable URL says "This site"', () => {
  assert.equal(
    rejection('navigation', 'https://www.cf-site.example/a?q=1', 'net::ERR_NAME_NOT_RESOLVED').message,
    'cf-site.example unavailable (server unreachable). Try again in a moment.',
  );
  assert.match(rejection('navigation', 'not a url', 'net::ERR_X').message, /^This site unavailable/);
});

test('an unknown answer shows only its first line, without URLs, and is kind "other"', () => {
  const err = rejection('other', 'https://cf-site.example/', 'weird failure at https://cf-site.example/secret?token=1\nstack line');
  assert.equal(err.kind, 'other');
  assert.equal(err.message, 'FlareSolverr failed: weird failure at');
  assert.doesNotMatch(err.message, /example|token|stack/);
  assert.equal('solverMessage' in err, false);
  // Any kind the table does not know is "other".
  assert.equal(rejection('http', 'https://cf-site.example/', 'x').kind, 'other');
});

test('the codes callers compare by name are constants, and none is a code the pool raises itself', () => {
  assert.deepEqual({ ...CALLER_ERROR_CODES }, { UNAVAILABLE: 'FLARESOLVERR_UNAVAILABLE', UNSAFE_URL: 'UNSAFE_URL' });
  assert.equal(Object.isFrozen(CALLER_ERROR_CODES), true);
  for (const code of Object.values(CALLER_ERROR_CODES)) assert.equal(Object.values(POOL_ERROR_CODES).includes(code), false, code);
});

test('UNSAFE_URL is the code safe-fetch really raises for a target that must not be fetched (it does not export one)', async () => {
  for (const target of ['http://127.0.0.1:9/x', 'http://[::1]/x', 'file:///etc/passwd', 'ftp://files.example/x']) {
    await assert.rejects(assertPublicUrl(target), { code: CALLER_ERROR_CODES.UNSAFE_URL }, target);
  }
});
