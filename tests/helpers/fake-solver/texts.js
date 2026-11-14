'use strict';

// The fixed texts of the fake FlareSolverr: what it answers with, the page it
// serves for a URL nobody scripted, the user agent it reports. Pure.

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 FakeFlareSolverr';
const BLANK_HTML = '<html><head></head><body></body></html>';

// Python prints 35000 / 1000 as "35.0"; FlareSolverr's timeout text is built from that.
function pythonFloat(value) {
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

// The texts FlareSolverr answers with. blocked, timeout, sessionMissing and invalidCmd were read from the
// 3.5.2 sources; the rest are the wording Selenium / undetected_chromedriver use and are unverified until live
// check 5, so the pool's classifier is only as good as these guesses until then.
const MESSAGES = Object.freeze({
  blocked: 'Cloudflare has blocked this request. Probably your IP is banned for this site, check in your web browser.',
  sessionMissing: "The session doesn't exist.",
  timeout: (maxTimeoutMs) => `Timeout after ${pythonFloat(maxTimeoutMs / 1000)} seconds.`,
  invalidCmd: (cmd) => `Request parameter 'cmd' = '${cmd}' is invalid.`,
  driverDead: 'invalid session id: session deleted as the browser has closed the connection\nfrom disconnected: not connected to DevTools',
  windowClosed: 'no such window: target window already closed\nfrom unknown error: web view not found',
  launchConflict: "PermissionError: [WinError 32] The process cannot access the file because it is being used by another process: 'chromedriver.exe'",
  proxyUnreachable: 'unknown error: net::ERR_PROXY_CONNECTION_FAILED',
  tunnelFailed: 'unknown error: net::ERR_TUNNEL_CONNECTION_FAILED',
  navigation: 'unknown error: net::ERR_CONNECTION_REFUSED',
});

// What an unscripted URL answers. It contains the URL, so a test can tell whose page it got back.
function pageHtml(url) {
  return `<html><head><title>fake page</title></head><body><p>fake page for ${url}</p></body></html>`;
}

module.exports = { USER_AGENT, BLANK_HTML, MESSAGES, pageHtml };
