'use strict';

// The edition without sources ships no anime source, but the registry still has a notion of "one that ships" (origin 'bundled'): it cannot be replaced or removed.
// The tests of that rule register these stand-ins instead of real sites.

const stub = (id, keyedBy) => ({
  meta: { id, name: id, keyedBy },
  getStreamSources: async () => ({ sources: [] }),
  fetchHlsResource: async () => ({ body: Buffer.alloc(0), contentType: 'application/vnd.apple.mpegurl' }),
  healthCheck: async () => ({ ok: true }),
});

const BUNDLED = [stub('shipped-a', 'title'), stub('shipped-b', 'title'), stub('shipped-c', 'mal')];

function registerBundled(registry) {
  for (const source of BUNDLED) registry.register(source, { origin: 'bundled' });
  return registry;
}

module.exports = { registerBundled, BUNDLED };
