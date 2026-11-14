// ============================================================================
// API HELPER
// Thin wrapper around fetch that handles JSON parsing and error propagation.
// All network requests to the ScrollScape backend go through this function.
// ============================================================================

/**
 * Send a request to the ScrollScape backend API.
 *
 * @param {string} path - Absolute path, e.g. "/api/state"
 * @param {RequestInit} [opts] - Optional fetch options (method, body, …)
 * @returns {Promise<any>} Parsed JSON response
 * @throws {Error} When the server returns a non-2xx status
 */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    // The status and the parsed body ride along for a caller that needs more than the message (a refusal that lists
    // its reasons, or one that is told apart by its code). Callers that only read err.message are unaffected.
    const err = new Error(data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}
