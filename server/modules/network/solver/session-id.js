'use strict';

const { POOL } = require('../../../config/solver');

// Whose session is this? The id of every session the pool creates carries the
// pid of the ScrollScape process that made it, which is how the orphan sweep
// (orphans.js) tells a session left by a dead process from one in use, and from
// anyone else's. Pure apart from the default liveness probe.

/** `ss-<pid>-<startTag>-<n>`: never deterministic, and carries the pid the orphan sweep judges. */
function buildSessionId(pid, tag, n, prefix = POOL.orphanIdPrefix) {
  return `${prefix}${pid}-${tag}-${n}`;
}

/** The parts of an id built by buildSessionId, or null for any id that is not ours (other clients' sessions stay untouched). */
function parseSessionId(id, prefix = POOL.orphanIdPrefix) {
  if (typeof id !== 'string' || !id.startsWith(prefix)) return null;
  const match = /^(\d+)-([0-9a-z]+)-(\d+)$/.exec(id.slice(prefix.length));
  if (!match) return null;
  const pid = Number(match[1]);
  const n = Number(match[3]);
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(n)) return null;
  return { pid, tag: match[2], n };
}

// Real process liveness: signal 0 only checks. EPERM means the process exists
// but belongs to someone else, which is still "alive".
function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !(err && err.code === 'ESRCH');
  }
}

module.exports = { buildSessionId, parseSessionId, defaultIsPidAlive };
