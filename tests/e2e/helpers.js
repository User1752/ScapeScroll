'use strict';

// Shared helpers for the read-only e2e smoke suite. See playwright.config.js
// for why these tests never mutate state (favorites, settings, covers...).

// External cover-image CDNs are frequently unreachable from CI/sandboxed
// networks (geo-blocks, rate limits, a source's own outages — several are
// documented in the `todo` file at the repo root). That noise is expected
// and unrelated to app correctness, so it's filtered out here; anything
// else on the console (uncaught exceptions, real script errors) still fails
// the test that calls this.
const IGNORED_ERROR_PATTERNS = [
  /ERR_CONNECTION_REFUSED/,
  /ERR_NAME_NOT_RESOLVED/,
  /ERR_CONNECTION_TIMED_OUT/,
  /net::ERR_/,
  /Failed to load resource/,
];

function isIgnorableError(text) {
  return IGNORED_ERROR_PATTERNS.some((re) => re.test(text));
}

/** Attach a console/pageerror listener and return a function that asserts none fired. */
function trackConsoleErrors(page) {
  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isIgnorableError(msg.text())) {
      errors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    errors.push(err.message);
  });
  return () => errors;
}

module.exports = { trackConsoleErrors, isIgnorableError };
