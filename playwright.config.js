'use strict';

const { defineConfig, devices } = require('@playwright/test');

// E2E smoke tests against a real running ScrollScape instance. These are
// intentionally READ-ONLY (navigate + assert, never favorite/delete/change
// settings) because the app has no test-mode data directory — DATA_DIR is
// hardcoded relative to the app root (see server.js), so a test run always
// exercises whatever real library/store data the developer has on disk.
// Anything that needs to mutate state should get its own isolated fixture
// instead of running against this config.
module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,

  use: {
    baseURL: process.env.SCROLLSCAPE_BASE_URL || 'http://localhost:4000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  // If nothing is already answering at baseURL, spin up the real server for
  // the run. When a dev instance is already running (the common case while
  // iterating), reuseExistingServer skips this and tests hit that instance.
  //
  // Re-invokes process.execPath rather than a bare "node" — this repo ships
  // a portable Node under tools/node/ for the packaged-exe/Windows dev flow,
  // and that machine may have no system-wide "node" on PATH at all (a plain
  // "node server.js" here reliably fails with ENOENT in that setup). Reusing
  // whatever binary is already running Playwright itself works everywhere:
  // the portable copy, a system install, or nvm — no PATH assumptions.
  webServer: {
    command: `"${process.execPath}" server.js`,
    url: process.env.SCROLLSCAPE_BASE_URL || 'http://localhost:4000',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
