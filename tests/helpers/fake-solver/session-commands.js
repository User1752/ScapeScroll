'use strict';

const { Failure } = require('./signals');
const { MESSAGES } = require('./texts');
const { clone } = require('./site-data');
const { pause } = require('./waits');
const { makeBrowser, launchBrowser } = require('./browsers');

// The three commands that manage sessions. Each resolves the fields of its answer
// or throws a Failure; the reply itself is built by dispatch.js.

// Only a create that came without an id uses up a number.
function madeUpId(state) {
  state.sessionCounter += 1;
  return `fake-session-${state.sessionCounter}`;
}

async function sessionsCreate(state, entry, outcome, callEpoch) {
  const { fake, sessions } = state;
  const id = entry.session || madeUpId(state);
  entry.session = id;
  const existing = sessions.get(id);
  const failure = outcome.errorMessage !== undefined ? new Failure(outcome.errorMessage) : null;
  let reply;
  if (existing) {
    // The new proxy is NOT applied to the session that is already there.
    entry.existed = true;
    entry.usedProxy = existing.proxy;
    reply = { message: 'Session already exists.', session: id };
  } else {
    await launchBrowser(state, entry, callEpoch);
    if (!failure) {
      const proxy = clone(entry.proxy);
      sessions.set(id, makeBrowser(id, proxy, false));
      entry.usedProxy = proxy;
    }
    reply = { message: 'Session created successfully.', session: id };
  }
  await pause(state, fake.latencyMs + (outcome.delayMs || 0), callEpoch);
  if (failure) throw failure;
  return reply;
}

async function sessionsList(state, entry, outcome, callEpoch) {
  const ids = [...state.sessions.keys()];
  await pause(state, state.fake.latencyMs + (outcome.delayMs || 0), callEpoch);
  if (outcome.errorMessage !== undefined) throw new Failure(outcome.errorMessage);
  return { message: '', sessions: ids };
}

async function sessionsDestroy(state, entry, outcome, callEpoch) {
  const { sessions } = state;
  const failure = outcome.errorMessage !== undefined ? new Failure(outcome.errorMessage) : null;
  const browser = entry.session ? sessions.get(entry.session) : undefined;
  // FlareSolverr takes the session out of its table first and only then quits the browser (which is the slow
  // part), so the id is already free to be recreated while this call is still waiting to answer.
  if (browser && !failure) {
    sessions.delete(entry.session);
    browser.removed = true;
  }
  await pause(state, state.fake.latencyMs + (outcome.delayMs || 0), callEpoch);
  if (failure) throw failure;
  if (!browser) throw new Failure(MESSAGES.sessionMissing);
  // Closing a dead driver raises, but the session was already removed above.
  if (browser.dead) throw new Failure(browser.deadMessage);
  return { message: 'The session has been removed.' };
}

module.exports = { sessionsCreate, sessionsList, sessionsDestroy };
