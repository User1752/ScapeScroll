'use strict';

const { matchesUrl } = require('./site-data');

// The scripting rules (fake.page / fake.command): written with addRule, looked up
// by pickRule for every call. The newest matching rule wins.

const COMMANDS = new Set(['sessions.create', 'sessions.list', 'sessions.destroy', 'request.get']);
const OUTCOME_KEYS = new Set(['html', 'cookies', 'delayMs', 'errorMessage', 'kill', 'httpStatus', 'rawBody', 'hang', 'drop', 'times']);

function addRule(state, cmd, url, outcome) {
  if (!COMMANDS.has(cmd)) throw new TypeError(`the fake FlareSolverr has no command '${cmd}'`);
  const given = outcome || {};
  for (const key of Object.keys(given)) {
    if (!OUTCOME_KEYS.has(key)) throw new TypeError(`unknown outcome field '${key}'`);
  }
  if (given.kill && (cmd !== 'request.get' || given.errorMessage === undefined)) {
    throw new TypeError("'kill' needs an errorMessage and only applies to request.get");
  }
  const rule = {
    cmd,
    url,
    outcome: given,
    times: given.times ?? Infinity,
    hits: 0,
    remove() {
      const at = state.rules.indexOf(rule);
      if (at !== -1) state.rules.splice(at, 1);
    },
  };
  state.rules.push(rule);
  return rule;
}

function pickRule(state, cmd, url) {
  for (let i = state.rules.length - 1; i >= 0; i -= 1) {
    const rule = state.rules[i];
    if (rule.cmd !== cmd) continue;
    if (rule.url !== undefined && !(url !== null && matchesUrl(rule.url, url))) continue;
    rule.hits += 1;
    if (rule.hits >= rule.times) rule.remove();
    return rule;
  }
  return null;
}

module.exports = { COMMANDS, addRule, pickRule };
