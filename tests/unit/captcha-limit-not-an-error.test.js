'use strict';

// A CAPTCHA in front of a source's chapters (AllManga answers NEED_CAPTCHA) is a known limit, not a fault: the source raises an error with
// code ALLMANGA_NEED_CAPTCHA, statusCode 502 and `expected: true` (data/sources/allmanga.js needCaptchaError). The route wrapper must keep it out of the
// error log (so "Recent source errors" never shows it, whatever System Health would make of the word "captcha" in its text) and still tell
// the browser the code; the image-quality check turns the same code into a "Known limit" row (image-quality-captcha-wall.test.js). Anything
// else that fails is logged as before.

const test = require('node:test');
const assert = require('node:assert/strict');

const logger = require('../../server/modules/error-logger');
const recorded = [];
logger.recordError = async (entry) => { recorded.push(entry); };
const { createAsyncHandler } = require('../../server/modules/http/async-handler');
const { classifySourceError } = require('../../server/modules/system-health/service');

function run(error, params = { id: 'allmanga' }) {
  const handler = createAsyncHandler('SOURCES')(async () => { throw error; });
  const res = { headersSent: false, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  const quiet = console.warn;
  console.warn = () => {};
  const done = handler({ method: 'POST', originalUrl: '/api/source/allmanga/pages', params, body: {} }, res, () => {});
  return done.finally(() => { console.warn = quiet; }).then(() => res);
}

const captcha = () => Object.assign(new Error('AllManga now requires a CAPTCHA to read chapters, which ScrollScape cannot solve automatically.'), {
  code: 'ALLMANGA_NEED_CAPTCHA', statusCode: 502, expected: true,
});

test('the CAPTCHA limit reaches the browser with its code and is never written to the error log', async () => {
  recorded.length = 0;
  const res = await run(captcha());
  assert.equal(res.code, 502);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.code, 'ALLMANGA_NEED_CAPTCHA');
  assert.match(res.body.error, /CAPTCHA/);
  assert.deepEqual(recorded, [], 'nothing for "Recent source errors" to classify');
});

test('a real failure of the same source is still logged, so the limit hides nothing else', async () => {
  recorded.length = 0;
  const res = await run(Object.assign(new Error('the page list came back empty'), { statusCode: 500 }));
  assert.equal(res.code, 500);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].area, 'allmanga');
});

test('the display grouping reads text (it is only a label): that is why the limit is kept out of the log by its code instead', () => {
  assert.equal(classifySourceError(captcha().message).key, 'cloudflare_or_challenge');
});
