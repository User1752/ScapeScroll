'use strict';

// The REAL System Health error classifier (classifySourceError, isTransientSourceErrorKey), for the tests that pin the texts users see:
// a text is only as good as the bucket it lands in (the lesson of 3.1.2).
//
// It lives in the System Health service, which reaches the FlareSolverr lifecycle module, and that one reads
// data/setup.json when it is loaded. A test must not touch the data folder, so a stand-in takes the lifecycle's place while
// the service is loaded (the same device flaresolverr-unreachable.test.js uses, there to keep the real one from starting a FlareSolverr).

const LIFECYCLE_PATH = require.resolve('../../server/modules/network/flaresolverr-lifecycle');
const SERVICE_PATH = require.resolve('../../server/modules/system-health/service');

function loadClassifier() {
  const original = require.cache[LIFECYCLE_PATH];
  require.cache[LIFECYCLE_PATH] = {
    id: LIFECYCLE_PATH,
    filename: LIFECYCLE_PATH,
    loaded: true,
    exports: { noteFlaresolverrUsed() {}, recoverFromHang() {}, isManaged: () => false, registerRestartListener: () => () => {} },
  };
  try {
    return require(SERVICE_PATH);
  } finally {
    if (original) require.cache[LIFECYCLE_PATH] = original; else delete require.cache[LIFECYCLE_PATH];
  }
}

const { classifySourceError, isTransientSourceErrorKey } = loadClassifier();

// The substrings that steer the classifier into the wrong bucket, plus the host names the tests use: a text must never
// name the site (the classifier matches substrings of the whole message).
const STEERING = [/api/i, /http 500/i, /maintenance/i, /temporarily unavailable/i, /cf-site\.example/i, /other-site\.example/i];

module.exports = { classifySourceError, isTransientSourceErrorKey, STEERING };
