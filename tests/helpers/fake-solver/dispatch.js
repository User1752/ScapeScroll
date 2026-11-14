'use strict';

const { Failure } = require('./signals');
const { MESSAGES } = require('./texts');
const { forever } = require('./waits');
const { COMMANDS, pickRule } = require('./rules');
const { closeEntry } = require('./log');
const { sendText, sendJson, envelope } = require('./replies');
const { sessionsCreate, sessionsList, sessionsDestroy } = require('./session-commands');
const { requestGet } = require('./request-get');

// One /v1 call: pick the scripted rule for it, run the command, and answer the way the
// rule says (the call's effect on the state has already happened by then; `drop`,
// `rawBody` and `httpStatus` replace only the reply).

// { fields } for an answer, { failure } for an error FlareSolverr answers with; a bug in the fake throws.
async function execute(state, body, entry, outcome, callEpoch) {
  try {
    if (entry.cmd === null) throw new Failure("Request parameter 'cmd' is mandatory.");
    if (!COMMANDS.has(entry.cmd)) throw new Failure(MESSAGES.invalidCmd(entry.cmd));
    if (entry.cmd === 'sessions.create') return { fields: await sessionsCreate(state, entry, outcome, callEpoch) };
    if (entry.cmd === 'sessions.list') return { fields: await sessionsList(state, entry, outcome, callEpoch) };
    if (entry.cmd === 'sessions.destroy') return { fields: await sessionsDestroy(state, entry, outcome, callEpoch) };
    return { fields: await requestGet(state, body, entry, outcome, callEpoch) };
  } catch (err) {
    if (!(err instanceof Failure)) throw err;
    return { failure: err };
  }
}

async function runCommand(state, body, entry, res, callEpoch) {
  const rule = COMMANDS.has(entry.cmd) ? pickRule(state, entry.cmd, entry.url) : null;
  const outcome = rule ? rule.outcome : {};
  const status = outcome.httpStatus;
  if (outcome.hang) await forever(state, callEpoch);
  const { fields, failure } = await execute(state, body, entry, outcome, callEpoch);

  if (outcome.drop) {
    state.ownDrops.add(res);
    closeEntry(state, entry, 'drop');
    res.socket.destroy();
    return;
  }
  if (outcome.rawBody !== undefined) {
    closeEntry(state, entry, 'raw', status ?? 200);
    sendText(res, status ?? 200, String(outcome.rawBody), 'text/html');
    return;
  }
  if (failure) {
    // HTTP 500 as the carrier of an error body is unverified until live check 5.
    closeEntry(state, entry, 'error', status ?? 500, failure.message);
    sendJson(res, status ?? 500, envelope(state, entry, { status: 'error', message: `Error: ${failure.message}` }));
    return;
  }
  closeEntry(state, entry, 'ok', status ?? 200);
  sendJson(res, status ?? 200, envelope(state, entry, { status: 'ok', ...fields }));
}

module.exports = { runCommand };
