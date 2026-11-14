'use strict';

/**
 * Races `promise` against a timeout of `ms`. Rejects with `message` if the
 * timeout wins; the original promise is left to settle on its own (its
 * eventual result/rejection is simply not awaited) rather than being
 * cancelled, since fetch-based operations here have no abort hook wired
 * through to this level.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // .then(onFulfilled, onRejected) — unlike .finally(), a non-throwing
  // rejection handler here "handles" the rejection, so this cleanup
  // subscription resolves either way instead of re-rejecting into an
  // unobserved promise. Promise.race below still independently rejects
  // with `promise`'s real error if it loses the race by rejecting.
  const clearTimer = () => clearTimeout(timer);
  promise.then(clearTimer, clearTimer);
  return Promise.race([promise, timeout]);
}

/**
 * Resolves after `ms`. The timer keeps the process alive (the work waiting for it has to finish); code that
 * must not hold the process open, or that runs on an injected clock (the FlareSolverr pool, solver/ports.js),
 * has its own.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

module.exports = { withTimeout, sleep };
