'use strict';

// Writing a reply on the HTTP response.

function sendText(res, status, text, contentType) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function sendJson(res, status, payload) {
  sendText(res, status, JSON.stringify(payload), 'application/json');
}

// Every answer of /v1 carries when the call started and ended, and the version.
function envelope(state, entry, fields) {
  return { ...fields, startTimestamp: entry.t, endTimestamp: Date.now(), version: state.version };
}

module.exports = { sendText, sendJson, envelope };
