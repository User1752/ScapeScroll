'use strict';

// The two checks on plain objects the pool's modules share: is this value a
// plain object, and lay one configuration object over another.

const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

// A copy of base with `over` laid on it, one level deep (queue, circuit and
// blockCooldown are objects), so a test override never mutates the shared POOL.
function mergeConfig(base, over) {
  const merged = {};
  for (const [key, value] of Object.entries(base)) merged[key] = isPlainObject(value) ? { ...value } : value;
  for (const [key, value] of Object.entries(over || {})) {
    merged[key] = isPlainObject(merged[key]) && isPlainObject(value) ? { ...merged[key], ...value } : value;
  }
  return merged;
}

module.exports = { isPlainObject, mergeConfig };
