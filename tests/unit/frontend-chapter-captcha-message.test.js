'use strict';

// A site that puts a CAPTCHA in front of its chapters answers with a code ending in NEED_CAPTCHA (see captcha-limit-not-an-error.test.js) and a message
// that already says what to do. The reader used to throw that away and show the generic "try Migrate" text, so the person never learnt WHY the chapter
// did not open.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'modules', 'ui-add-to-list-modal.js'), 'utf8').replace(/\r\n/g, '\n');

test('a chapter that failed behind a CAPTCHA shows the real message of the server, anything else the generic one', () => {
  const i = src.indexOf('const captchaWall = ');
  assert.ok(i > 0, 'the reader decides on the code the server sends');
  const block = src.slice(i, i + 700);
  assert.match(block, /\(\?:\^\|_\)NEED_CAPTCHA\$\/\.test\(String\(e\?\.data\?\.code \|\| ''\)\)/, 'a code ending in NEED_CAPTCHA');
  assert.match(block, /captchaWall && e\.message\s+\? e\.message/, 'the message of the server');
  assert.match(block, /t\('reader\.pagesLoadFailed'\)/, 'the generic text stays for every other failure');
});

test('the code and the message do reach the page: api() keeps the body on the error', () => {
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'modules', 'api.js'), 'utf8');
  assert.match(api, /new Error\(data\?\.error \|\| `HTTP \$\{res\.status\}`\)/);
  assert.match(api, /err\.data = data;/);
});
