'use strict';

const { POOL } = require('../../../config/solver');

// What FlareSolverr said, and what a failed request to it means. Pure: no state,
// no clock, no I/O, so every rule here is unit-tested on recorded strings
// (tests/unit/solver-classify.test.js, solver-pool-classify.test.js).

// Only a refused or unroutable connection means the solver is gone; a reset
// socket, a TLS or a DNS failure is something else (same rule as fetch-utils).
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

// Classified on the `message` of FlareSolverr's JSON error. The strings are what
// the 3.5.2 sources and Selenium print. `blocked`, `timeout`, the dead-proxy text
// (net::ERR_PROXY_CONNECTION_FAILED) and the 'invalid session id' answer of a destroy on a
// dead driver were seen on a real FlareSolverr; the failed-launch and other dead-driver texts
// are still read from the sources only. An answer that
// matches none of them is just 'other': it never recycles anything by itself
// (three in a row on one session do, see navigation.js).
// \bdisconnected\b, not a bare "disconnected": Chrome's net::ERR_INTERNET_DISCONNECTED
// is a page problem, not a dead driver.
const MESSAGE_KINDS = Object.freeze([
  ['blocked', /Cloudflare has blocked this request/i],
  ['timeout', /Timeout after [\d.]+ seconds/i],
  ['unsupported', /Request parameter 'cmd'[^]*?is invalid|invalid cmd/i],
  ['driver', /invalid session id|no such window|target window already closed|web view not found|chrome not reachable|\bdisconnected\b|not connected to DevTools|session deleted|page crash|unexpected alert|Max retries exceeded|Connection refused|RemoteDisconnected/i],
  ['launch', /PermissionError|Error starting Chrome|chromedriver.*(locked|in use|denied)/i],
  // ERR_TUNNEL_CONNECTION_FAILED is the proxy refusing to open the tunnel to the site: the proxy's doing, like ERR_PROXY_.
  ['proxy', /ERR_PROXY_|ERR_TUNNEL_CONNECTION_FAILED/i],
  ['navigation', /net::ERR_/i],
]);

/**
 * 'blocked' | 'timeout' | 'unsupported' | 'driver' | 'launch' | 'proxy' |
 * 'navigation' | 'other' for the message of a FlareSolverr error. First match in
 * that order wins, so a proxy failure is not also a navigation error.
 */
function classifyFlareSolverrMessage(message) {
  const text = String(message ?? '');
  for (const [kind, pattern] of MESSAGE_KINDS) {
    if (pattern.test(text)) return kind;
  }
  return 'other';
}

// What must not reach a user, or the error log, from a FlareSolverr message: an address of any
// scheme (a proxy URL such as socks5://user:pass@host carries credentials), the same credentials
// without a scheme (user:pass@host, as Chrome or Selenium may echo a proxy), and a path on this
// computer or its network (a drive letter, \\server\share, or an absolute Unix path with at least a
// folder in it). A path is cut together with the rest of its line: a folder name with a space in it
// would otherwise be left half shown. The Unix path must start a word (not follow a letter, a
// digit, a colon, a dot or a slash), so 'and/or', '12/05/2024' and 'localhost:8191/v1/x' stay.
const ADDRESS = /[a-z][a-z0-9+.-]*:\/\/\S*/gi;
const SCHEMELESS_CREDENTIALS = /[^\s@/:]+:\S*@\S+/g;
const LOCAL_PATH = /(?:\b[a-z]:[\\/]|\\\\[^\s\\])[^\n]*/gi;
const UNIX_PATH = /(?<![\w/:.])\/[\w.~-]+\/[^\n]*/g;

// The first line of a message, FlareSolverr escapes the newlines of the cause as the two
// characters \n, so both spellings end it. Only its start is kept (the patterns below
// are quadratic on a long unbroken run, and a user sees solverTextMaxChars at most); a
// cut that lands inside a word drops that whole word, so half of a credential is never
// what is left to show.
function firstLineOf(message) {
  const line = String(message ?? '').split(/\\n|\r?\n/)[0];
  if (line.length <= POOL.solverLineMaxChars) return line;
  const head = line.slice(0, POOL.solverLineMaxChars);
  return head.slice(0, Math.max(0, head.search(/\s\S*$/)));
}

// The first line of a FlareSolverr message with addresses and paths removed: what a user
// may see of it.
function describeSolverMessage(message) {
  const firstLine = firstLineOf(message);
  const text = firstLine.replace(ADDRESS, '').replace(SCHEMELESS_CREDENTIALS, '').replace(LOCAL_PATH, '').replace(UNIX_PATH, '').replace(/\s+/g, ' ').trim().slice(0, POOL.solverTextMaxChars);
  return text || 'Unknown error';
}

// ok: FlareSolverr says so. Otherwise the kind of its error message, or 'http'
// when there is no usable JSON body at all (a relay answering 502, say). The
// body is read whatever the HTTP status: FlareSolverr 3.5.2 carries its errors as
// HTTP 500 with a JSON body {status: 'error', message} (seen live).
function interpret(res) {
  const { httpStatus, body } = res;
  if (body && body.status === 'ok') return { kind: 'ok', body, httpStatus };
  if (body && typeof body.message === 'string') {
    return { kind: classifyFlareSolverrMessage(body.message), message: body.message, httpStatus };
  }
  return { kind: 'http', httpStatus };
}

// Whether an answer to a blank page blames the page itself (the address is invalid, the argument is
// refused), which is what says THIS FlareSolverr will not park a session on a blank page. A failure of the
// browser (a dead driver, a launch that failed, a timeout, a proxy error) or of whatever answered
// (no usable body, text nobody knows) says nothing about the page: the session is simply thrown away.
const BLANK_PAGE_REFUSAL = /url|invalid argument|about:blank|data:text/i;

function refusesBlankPage(seen) {
  return (seen.kind === 'other' || seen.kind === 'navigation') && BLANK_PAGE_REFUSAL.test(String(seen.message || ''));
}

function isTimeoutError(err) {
  return !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

// A refused or unreachable connection, also when it is inside the AggregateError
// Node raises for "localhost" resolving to both ::1 and 127.0.0.1.
function isSolverDown(err) {
  const cause = err && err.cause;
  const codes = [cause && cause.code, ...(Array.isArray(cause && cause.errors) ? cause.errors.map((e) => e && e.code) : [])];
  return codes.some((code) => UNREACHABLE_CODES.has(code));
}

module.exports = {
  classifyFlareSolverrMessage,
  describeSolverMessage,
  interpret,
  refusesBlankPage,
  isTimeoutError,
  isSolverDown,
};
