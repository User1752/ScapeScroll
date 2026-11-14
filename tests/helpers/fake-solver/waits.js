'use strict';

const { CANCELLED } = require('./signals');

// Time in the fake: a wait that a restart() or stop() releases, with CANCELLED, so
// no call survives into the next process. `state.epoch` is bumped by every restart
// or stop; a call from an older epoch never touches the new state. Every timer is
// unref'd.

function pause(state, ms, callEpoch) {
  return new Promise((resolve, reject) => {
    if (callEpoch !== state.epoch) {
      reject(CANCELLED);
      return;
    }
    const waiter = { reject, timer: null };
    const finish = () => {
      state.pending.delete(waiter);
      if (callEpoch === state.epoch) resolve(); else reject(CANCELLED);
    };
    state.pending.add(waiter);
    if (ms > 0) {
      waiter.timer = setTimeout(finish, ms);
      waiter.timer.unref();
    } else {
      setImmediate(finish);
    }
  });
}

function forever(state, callEpoch) {
  return new Promise((_, reject) => {
    if (callEpoch !== state.epoch) reject(CANCELLED); else state.pending.add({ reject });
  });
}

function cancelPending(state) {
  state.epoch += 1;
  for (const waiter of state.pending) {
    clearTimeout(waiter.timer);
    waiter.reject(CANCELLED);
  }
  state.pending.clear();
}

module.exports = { pause, forever, cancelPending };
