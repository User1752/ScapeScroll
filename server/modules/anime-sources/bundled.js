'use strict';

// No anime source ships with the app in this edition: the registry starts empty and the person adds the ones they want (import.js).
// The list stays so that the registry still has one place to ask for what ships.

const BUNDLED = [];

/** Registers the sources that ship with the app (none in this edition). */
function registerBundled(registry) {
  for (const source of BUNDLED) registry.register(source, { origin: 'bundled' });
  return registry;
}

module.exports = { registerBundled, BUNDLED };
