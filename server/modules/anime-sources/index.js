'use strict';

const { createAnimeRegistry } = require('./registry');
const { registerBundled } = require('./bundled');

// The one registry of the running app, with the sources that ship with it already in. Built on first use.
let registry = null;

function getAnimeRegistry() {
  if (!registry) registry = registerBundled(createAnimeRegistry());
  return registry;
}

module.exports = { getAnimeRegistry };
