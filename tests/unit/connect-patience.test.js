'use strict';

// How long Node waits for one address of a site (server/modules/network/connect-patience.js): 250 ms by default, which a busy network
// does not meet and then every call fails with "fetch failed (ETIMEDOUT)". A fake `net`, so the real default is never changed here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { raiseConnectPatience, NODE_DEFAULT_MS } = require('../../server/modules/network/connect-patience');
const limits = require('../../server/config/limits');

const fakeNet = (start) => {
  const net = { value: start, calls: [] };
  net.getDefaultAutoSelectFamilyAttemptTimeout = () => net.value;
  net.setDefaultAutoSelectFamilyAttemptTimeout = (ms) => { net.calls.push(ms); net.value = ms; };
  return net;
};

test('the default of Node (250 ms) is raised to the one the config names, which is comfortably longer', () => {
  assert.equal(NODE_DEFAULT_MS, 250);
  assert.ok(limits.connectAttemptTimeoutMs >= 1000 && limits.connectAttemptTimeoutMs <= 5000, 'seconds, not hundreds of milliseconds, and not a hang');
  const net = fakeNet(250);
  assert.equal(raiseConnectPatience(net), true);
  assert.deepEqual(net.calls, [limits.connectAttemptTimeoutMs]);
});

test('a value the person chose (NODE_OPTIONS) is left alone, and a Node without the setting is not an error', () => {
  const chosen = fakeNet(5000);
  assert.equal(raiseConnectPatience(chosen), false);
  assert.deepEqual(chosen.calls, []);
  assert.equal(raiseConnectPatience({}), false);
  const onlySetter = { calls: [], setDefaultAutoSelectFamilyAttemptTimeout(ms) { this.calls.push(ms); } };
  assert.equal(raiseConnectPatience(onlySetter, 3000), true, 'with no way to read the current value Node\'s own default is assumed');
  assert.deepEqual(onlySetter.calls, [3000]);
});

test('the real Node has the setting, so the call does something on the machines the app runs on', () => {
  const net = require('net');
  assert.equal(typeof net.setDefaultAutoSelectFamilyAttemptTimeout, 'function');
  assert.equal(typeof net.getDefaultAutoSelectFamilyAttemptTimeout, 'function');
});

test('the server raises it first thing, next to the failed-fetch reason', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const call = source.indexOf('raiseConnectPatience()');
  assert.ok(call > 0, 'server.js calls raiseConnectPatience()');
  assert.ok(call < source.indexOf("require('./server/modules/common/startup-guard')"));
});
