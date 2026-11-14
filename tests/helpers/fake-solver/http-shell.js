'use strict';

const http = require('http');
const { CANCELLED } = require('./signals');
const { openEntry, closeEntry } = require('./log');
const { sendJson, envelope } = require('./replies');
const { runCommand } = require('./dispatch');

// The HTTP side: read a request, route it, listen on the port. GET / and /health
// answer like FlareSolverr's; POST /v1 is the command endpoint.

const MAX_BODY_BYTES = 1024 * 1024;
// Longer than any test: undici must not find a connection the fake closed for idleness mid-test.
const KEEP_ALIVE_MS = 60_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('close', () => { if (!req.complete) reject(new Error('the client went away')); });
  });
}

// The command, or null when the body is not a JSON object.
function parseCommandBody(text) {
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch (_) {
    return null;
  }
}

async function answerCommand(state, body, res, callEpoch) {
  const entry = openEntry(state, body, res, callEpoch);
  try {
    await runCommand(state, body, entry, res, callEpoch);
  } catch (err) {
    if (err === CANCELLED) {
      closeEntry(state, entry, 'cancelled');
      return;
    }
    // A bug in the fake: say so loudly instead of answering like a FlareSolverr would.
    closeEntry(state, entry, 'error', 500, err.message);
    sendJson(res, 500, envelope(state, entry, { status: 'error', message: `Error: fake FlareSolverr bug: ${err.stack}` }));
  }
}

async function handleV1(state, req, res, callEpoch) {
  state.inFlight += 1;
  state.fake.peakInFlight = Math.max(state.fake.peakInFlight, state.inFlight);
  try {
    let text;
    try {
      text = await readBody(req);
    } catch (_) {
      return; // the client went away before the request was complete: nothing to answer
    }
    if (callEpoch !== state.epoch) return;
    const body = parseCommandBody(text);
    if (!body) {
      sendJson(res, 400, { status: 'error', message: 'Error: Invalid JSON body.', version: state.version });
      return;
    }
    await answerCommand(state, body, res, callEpoch);
  } finally {
    state.inFlight -= 1;
  }
}

function handle(state, req, res) {
  const path = new URL(req.url, 'http://fake').pathname;
  if (req.method === 'GET' && path === '/') {
    sendJson(res, 200, { msg: 'FlareSolverr is ready!', version: state.version, userAgent: state.fake.userAgent });
  } else if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { status: 'ok' });
  } else if (req.method === 'POST' && path === '/v1') {
    handleV1(state, req, res, state.epoch);
  } else {
    req.resume();
    sendJson(res, 404, { status: 'error', message: 'Not found' });
  }
}

// Listens on `port` (0: any free one) and records where in fake.port / url / baseUrl.
function listen(state, port) {
  const { fake } = state;
  return new Promise((resolve, reject) => {
    const listening = http.createServer((req, res) => handle(state, req, res));
    listening.keepAliveTimeout = KEEP_ALIVE_MS;
    listening.headersTimeout = KEEP_ALIVE_MS + 5_000; // Node wants it above keepAliveTimeout
    listening.once('error', reject);
    listening.listen(port, '127.0.0.1', () => {
      listening.off('error', reject);
      listening.on('error', () => {});
      state.server = listening;
      fake.port = listening.address().port;
      fake.url = `http://127.0.0.1:${fake.port}/v1`;
      fake.baseUrl = `http://127.0.0.1:${fake.port}/`;
      resolve();
    });
  });
}

module.exports = { listen };
