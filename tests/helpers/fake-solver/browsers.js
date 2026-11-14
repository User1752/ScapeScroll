'use strict';

const { pause } = require('./waits');

// The browsers behind the sessions: what one is, and what starting one costs.

function makeBrowser(id, proxy, lazy) {
  return {
    id,
    proxy,
    lazy,
    createdAt: Date.now(),
    requests: 0,
    inflight: 0,
    jar: new Map(),
    page: null,
    dead: false,
    deadMessage: null,
    removed: false,
  };
}

// Starting Chrome takes launchMs. The count of launches and of launches that overlapped another one is what
// the pool's "one launch at a time" rule is checked against; whether overlapping launches really collide on
// chromedriver's file is unverified until live check 3, so the fake only counts them and never fails them.
async function launchBrowser(state, entry, callEpoch) {
  const { fake } = state;
  entry.launched = true;
  fake.launches += 1;
  if (state.launching > 0) fake.launchOverlaps += 1;
  state.launching += 1;
  try {
    await pause(state, fake.launchMs, callEpoch);
  } finally {
    state.launching -= 1;
  }
}

module.exports = { makeBrowser, launchBrowser };
