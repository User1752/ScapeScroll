'use strict';

module.exports = {
  // How long a fatal start-up message stays readable in a console that closes the
  // moment the process exits (a double-clicked exe): the root-resolution error is
  // raised while server.js is still loading, so it cannot wait for a key press.
  fatalPauseMs: 10_000,
  // After the "press Enter" prompt of a refused second instance: leave on its own
  // after this long, so a window nobody is looking at does not stay open forever.
  closePromptTimeoutMs: 15_000,
};
