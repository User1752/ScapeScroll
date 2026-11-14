'use strict';

// "FlareSolverr is not running", for the fakes that are switched off (fake.switchOff()). A request to one of them with
// fetch is answered, before any socket is opened, with the error a refused connection gives: TypeError 'fetch failed' whose
// cause is the ECONNREFUSED. Installed when this module is first loaded, so it sits under whatever a test or a rig wraps
// around fetch later (the one that remembers what fetch threw sees these errors too).
//
// Why not stop() and a real refused port: stop() gives the port back, and when many test processes run at once another of
// them can bind it before the test connects. The fake it reaches then answers, and "FlareSolverr is off" turns into a
// parse error. A switched-off fake keeps its port.

const switchedOff = new Set(); // 'http://127.0.0.1:<port>/' of every fake that is switched off

const realFetch = globalThis.fetch;

function refusal(base) {
  const port = Number(new URL(base).port);
  const cause = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${port}`), {
    errno: -4078, code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port,
  });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

globalThis.fetch = function fetchThatKnowsSwitchedOffFakes(input, init) {
  if (switchedOff.size) {
    const target = typeof input === 'string' ? input : String((input && input.url) || input);
    for (const base of switchedOff) {
      if (target.startsWith(base)) return Promise.reject(refusal(base));
    }
  }
  return realFetch(input, init);
};

module.exports = { switchedOff };
