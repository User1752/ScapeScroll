'use strict';

const { createLiveTest } = require('./live-test');
const { checkId } = require('./ids');
const { createFailure, describeError } = require('./failure');

// "Test" as the service offers it: runs the live test (live-test.js) of an installed source when the person asks, one at a
// time, and remembers the outcome on the installed entry so the card can show "Verified". The remembering is tied to the file:
// the outcome carries the sha256 of the file that STARTED the test and is stored only if that file is still the installed one
// when the test ends, so a result is never credited to a file it was not about.

/**
 * @param {object} ctx  { readStore, writeStore, flushNow, loadSourceFromFile, liveTestDeps }
 *   liveTestDeps replaces the network helpers ({ resolvePageUrl, fetchImage, sleep, withTimeout, limits, now }) in a test.
 */
function createTestRunner({ readStore, writeStore, flushNow, loadSourceFromFile, liveTestDeps }) {
  // The helpers the live test needs from the network layer, loaded on first use (the module pulls in the whole fetch stack).
  const helpers = () => {
    if (liveTestDeps) return liveTestDeps;
    const fetchUtils = require('../network/fetch-utils');
    const { isSafeUrl } = require('../common/sanitize');
    const { withTimeout, sleep } = require('../common/async-utils');
    return {
      resolvePageUrl: fetchUtils.createPageUrlResolver({ isSafeUrl }).resolvePageUrl,
      fetchImage: fetchUtils.fetchImageBuffer,
      sleep,
      withTimeout,
    };
  };

  async function remember(id, depth, startSha, result) {
    try {
      const fresh = await readStore();
      const entry = fresh.installedSources && fresh.installedSources[id];
      if (entry && startSha && String(entry.sha256 || '') === startSha) {
        entry.liveTest = { at: result.startedAt, depth, verified: result.verified, fail: result.counts.fail, warn: result.counts.warn, sha256: startSha };
        await writeStore(fresh);
        flushNow();
      }
    } catch (_) { /* the result is still shown; it just is not remembered */ }
  }

  // One test at a time: it calls the real site, and two at once would double the requests the person agreed to.
  let testing = false;
  return async function test(input = {}) {
    const id = checkId(input.id);
    const depth = input.depth === 'full' ? 'full' : 'basic';
    const store = await readStore();
    const startEntry = store.installedSources && store.installedSources[id];
    if (!startEntry) throw createFailure(`"${id}" is not installed.`, 404);
    if (testing) throw createFailure('A test is already running: wait for it to finish.', 409);
    testing = true;
    try {
      let result;
      try {
        result = await createLiveTest({ loadSourceFromFile, ...helpers() })({ id, depth });
      } catch (err) {
        // Only a source that would not load is the person's file being wrong; anything else is ours and stays a 500.
        if (err && err.liveTestLoad) throw createFailure(`The source could not be loaded: ${describeError(err)}`, 400);
        throw err;
      }
      await remember(id, depth, String(startEntry.sha256 || ''), result);
      return { ok: true, ...result };
    } finally {
      testing = false;
    }
  };
}

module.exports = { createTestRunner };
