'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { sendProxyImageResponse } = require('../../server/routes/proxy');

// A browser that leaves while a cover is still being fetched destroys `res`. pipeline() then refuses it before listening to the
// source, so the source's later timeout used to be an unhandled 'error' that ended the whole process.
function fakeRes({ destroyed }) {
  const res = new PassThrough();
  res.set = () => res;
  res.setHeader = () => res;
  if (destroyed) res.destroy();
  return res;
}

function slowBody() {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  return { body, fail: (err) => controller.error(err) };
}

test('a destroyed response is not an error and a late timeout on the source cannot crash the process', async () => {
  const { body, fail } = slowBody();
  const unhandled = [];
  const onUncaught = (err) => unhandled.push(err);
  process.on('uncaughtException', onUncaught);
  try {
    await sendProxyImageResponse(fakeRes({ destroyed: true }), { contentType: 'image/png', cacheControl: 'no-store', body });
    fail(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('uncaughtException', onUncaught);
  }
  assert.deepEqual(unhandled, []);
});

test('a failure while the browser is still there is still thrown', async () => {
  const { body, fail } = slowBody();
  const pending = sendProxyImageResponse(fakeRes({ destroyed: false }), { contentType: 'image/png', cacheControl: 'no-store', body });
  fail(new Error('upstream broke'));
  await assert.rejects(pending, /upstream broke/);
});
