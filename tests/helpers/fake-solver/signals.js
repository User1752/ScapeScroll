'use strict';

// The two exceptions that steer the fake's control flow, told apart from a bug in
// the fake by what they are.

// An error FlareSolverr answers with, as opposed to a bug in the fake.
class Failure extends Error {}

// Thrown into every call that a restart() or stop() cuts off.
const CANCELLED = new Error('the fake FlareSolverr restarted or stopped');

module.exports = { Failure, CANCELLED };
