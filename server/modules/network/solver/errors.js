'use strict';

const { MESSAGES } = require('../../../config/solver');
const { describeSolverMessage } = require('./classify');

// The errors the pool hands to a caller: their codes, the flags fetch-utils reads
// (noRetry, rateLimited) and the texts users see, which all live in
// config/solver.js MESSAGES. Pure: an error is built from a code or a kind and
// nothing else.

// err.code of every error the pool raises itself. None of them is a
// TimeoutError / AbortError, so none can be taken for a hung FlareSolverr.
const POOL_ERROR_CODES = Object.freeze({
  QUEUE_FULL: 'SOLVER_QUEUE_FULL',
  QUEUE_TIMEOUT: 'SOLVER_QUEUE_TIMEOUT',
  HOST_COOLDOWN: 'SOLVER_HOST_COOLDOWN',
  RESTARTING: 'SOLVER_RESTARTING',
  DOWN: 'SOLVER_DOWN',
  SHUTTING_DOWN: 'SOLVER_SHUTTING_DOWN',
  REJECTED: 'SOLVER_REJECTED',
});

// err.code of the two errors that are not the pool's own but that the callers of the pool tell
// apart by name, kept here so nobody compares a literal: UNAVAILABLE is what solver-call.js
// raises when FlareSolverr cannot be reached at all (fetchText reads it to stop retrying), and
// UNSAFE_URL is the verdict of safe-fetch.js on a target that must not be fetched (a test pins it to
// what assertPublicUrl really raises, since safe-fetch.js does not export it).
const CALLER_ERROR_CODES = Object.freeze({
  UNAVAILABLE: 'FLARESOLVERR_UNAVAILABLE',
  UNSAFE_URL: 'UNSAFE_URL',
});

// What System Health sees as the last error when the pool itself refused a job
// (kind only, never the message).
const REFUSAL_KINDS = Object.freeze({
  [POOL_ERROR_CODES.QUEUE_FULL]: 'queue-full',
  [POOL_ERROR_CODES.QUEUE_TIMEOUT]: 'queue-timeout',
  [POOL_ERROR_CODES.HOST_COOLDOWN]: 'host-cooldown',
  [POOL_ERROR_CODES.RESTARTING]: 'restarting',
  [POOL_ERROR_CODES.DOWN]: 'down',
  [POOL_ERROR_CODES.SHUTTING_DOWN]: 'shutting-down',
});

// The page's host without www, or null when the URL cannot be read.
function siteLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
}

function poolError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  return Object.assign(err, extra);
}

// The pool refused the job before it reached FlareSolverr.
function refusal(code) {
  switch (code) {
    case POOL_ERROR_CODES.HOST_COOLDOWN:
      return poolError(code, MESSAGES.hostCooldown, { rateLimited: true });
    case POOL_ERROR_CODES.RESTARTING:
      return poolError(code, MESSAGES.restarting, { noRetry: true });
    case POOL_ERROR_CODES.DOWN:
      return poolError(code, MESSAGES.down, { noRetry: true });
    case POOL_ERROR_CODES.SHUTTING_DOWN:
      return poolError(code, MESSAGES.shuttingDown, { noRetry: true });
    default: // QUEUE_FULL, QUEUE_TIMEOUT
      return poolError(code, MESSAGES.busy, { noRetry: true });
  }
}

// What the caller sees for each kind of FlareSolverr answer. The raw text of the answer is not
// attached to the error: it can hold an address, a proxy's credentials or a path on this computer,
// and an error travels to System Health and the error log. Only describeSolverMessage's cleaned
// first line is ever shown, and only for an answer the pool has no wording of its own for.
function rejection(kind, url, message) {
  switch (kind) {
    case 'blocked':
      return poolError(POOL_ERROR_CODES.REJECTED, MESSAGES.blocked, { kind, rateLimited: true });
    case 'timeout':
    case 'driver':
    case 'launch':
    case 'proxy':
      return poolError(POOL_ERROR_CODES.REJECTED, MESSAGES[kind], { kind });
    case 'navigation':
      return poolError(POOL_ERROR_CODES.REJECTED, MESSAGES.navigation(siteLabel(url)), { kind });
    default:
      return poolError(POOL_ERROR_CODES.REJECTED, MESSAGES.other(describeSolverMessage(message)), { kind: 'other' });
  }
}

module.exports = {
  POOL_ERROR_CODES,
  CALLER_ERROR_CODES,
  REFUSAL_KINDS,
  refusal,
  rejection,
};
