'use strict';

// Keyed single-flight: while a call for a key is running, every other caller for the
// SAME key waits for that call's answer instead of starting its own. A burst of
// identical requests (a grid of covers hosted on one page, a probe and a reader asking
// for the same URL) costs one run.
//
// What the key stands for is the caller's business: for FlareSolverr it is
// "this site + this exact URL + these exact cookies" (solver-call.js). It is never just
// the site: the per-domain lock this replaces handed the page of the first caller to
// every caller for that domain, so different pages of one site came back as one page.
//
// A caller that joins brings its own patience (how urgent it is, how long it can wait).
// The running call must not be shorter-lived than its most patient member, so the
// patience of a joiner is passed on to whatever the running call is queued in: `attach`
// hands the flight a controller with the two methods of a pool handle, promote(priority)
// and extendDeadline(epochMs), and every join is applied to it. A call may be queued more
// than once inside one flight (a page that has to be asked for again); the joiners seen so
// far are applied to each new controller as well. The FIRST caller's own patience is never
// applied again: it was declared when the call was queued, and a deadline it chose must
// keep meaning "do not start this for me after then".
//
// Interface:
//   run(key, patience, start)   Promise of start(flight), shared by every caller of the key
//   size()                      flights running right now (tests, System Health)
//   flight.patience()           what the group asks for so far: { priority, deadlineAt?, boundSolve, label?, oneOff? }
//   flight.attach(controller)   the queued call; what joiners asked for is applied to it now
// Private state: the running flights. A flight leaves the map when its promise settles,
// whatever way it settles, so a failure is never replayed to a later caller.

const { PRIORITIES, DEFAULT_PRIORITY, cleanContext } = require('./solver-context');

// A caller that declared nothing is interactive, like in the pool; what it declared is cleaned by the
// same function the pool uses.
function cleanPatience(patience) {
  const source = cleanContext(patience);
  const clean = { priority: source.priority || DEFAULT_PRIORITY, boundSolve: source.boundSolve === true };
  if (source.deadlineAt !== undefined) clean.deadlineAt = source.deadlineAt;
  if (source.label) clean.label = source.label;
  if (source.oneOff) clean.oneOff = true;
  return clean;
}

// The group's patience: the strongest priority, the latest declared deadline, and
// boundSolve (cut a started navigation at the deadline) only if EVERY member asked for it. oneOff
// (a browser of its own) if ANY member did: one that needs it must not be served from a shared one.
function combine(group, member) {
  const merged = {
    priority: PRIORITIES[Math.min(PRIORITIES.indexOf(group.priority), PRIORITIES.indexOf(member.priority))],
    boundSolve: group.boundSolve && member.boundSolve,
  };
  const deadlines = [group.deadlineAt, member.deadlineAt].filter(Number.isFinite);
  if (deadlines.length) merged.deadlineAt = Math.max(...deadlines);
  if (group.label || member.label) merged.label = group.label || member.label;
  if (group.oneOff || member.oneOff) merged.oneOff = true;
  return merged;
}

// Telling the controller must never fail the caller that triggered it.
function applyPatience(controller, patience) {
  if (!controller) return;
  try {
    controller.promote(patience.priority);
    if (Number.isFinite(patience.deadlineAt)) controller.extendDeadline(patience.deadlineAt);
  } catch (_) {
    // the call may already be running or finished; there is nothing left to extend
  }
}

function createFlight(first) {
  let group = cleanPatience(first);
  let joined = null; // what the callers who joined asked for, without the first caller's
  let controller = null;
  return {
    promise: null,
    patience: () => ({ ...group }),
    attach(next) {
      controller = next;
      if (joined) applyPatience(controller, joined);
    },
    join(member) {
      const wanted = cleanPatience(member);
      group = combine(group, wanted);
      joined = joined ? combine(joined, wanted) : wanted;
      applyPatience(controller, wanted);
    },
  };
}

function createSingleFlight() {
  const flights = new Map();

  /**
   * The first caller for `key` runs start(flight); the others get the same promise (and the
   * same rejection). `patience` = { priority?, deadlineAt?, boundSolve?, label? }.
   */
  function run(key, patience, start) {
    const running = flights.get(key);
    if (running) {
      running.join(patience);
      return running.promise;
    }
    const flight = createFlight(patience);
    // start() runs synchronously up to its first await, so the controller is attached before
    // anyone can join; a synchronous throw becomes a rejection like any other.
    flight.promise = (async () => start(flight))().finally(() => {
      if (flights.get(key) === flight) flights.delete(key);
    });
    flights.set(key, flight);
    return flight.promise;
  }

  return { run, size: () => flights.size };
}

module.exports = { createSingleFlight };
