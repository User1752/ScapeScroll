'use strict';

const { USER_AGENT } = require('./texts');

// The one object the parts of the fake share (rules, waits, log, browsers, commands,
// HTTP): they take it as their first argument and keep nothing of their own between
// calls. `fake` is the public face tests use; the rest is bookkeeping.

function createFakeState({ version, latencyMs, launchMs }) {
  const sessions = new Map();
  const state = {
    version,
    sessions,
    rules: [],
    pending: new Set(), // waits that a restart() / stop() must release
    logWaiters: new Set(),
    ownDrops: new WeakSet(), // responses whose connection the fake itself closed
    server: null,
    epoch: 0, // bumped by restart() / stop(): a call from an older epoch never touches the new state
    seq: 0,
    sessionCounter: 0,
    launching: 0,
    inFlight: 0,
    fake: null,
  };
  state.fake = {
    version,
    latencyMs,
    launchMs,
    userAgent: USER_AGENT,
    port: 0,
    url: '',
    baseUrl: '',
    sessions,
    log: [],
    lazyCreated: [],
    ttlDropped: [],
    collisions: 0,
    launches: 0,
    launchOverlaps: 0,
    peakInFlight: 0,
    get inFlight() { return state.inFlight; },
  };
  return state;
}

module.exports = { createFakeState };
