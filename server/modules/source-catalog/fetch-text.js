'use strict';

const { safeFetch } = require('../network/safe-fetch');

// The one way the catalog asks the network for text: only the fixed addresses in server/config/catalog.js are ever passed to it, with
// the app's own address check on every redirect, a time limit and a size limit.

/**
 * @param {string} url
 * @param {number} maxBytes
 * @param {{ fetchImpl?: Function, timeoutMs?: number, userAgent?: string }} [deps]
 * @returns {Promise<{ status: number, text: string }>}
 */
async function fetchText(url, maxBytes, { fetchImpl = safeFetch, timeoutMs = 20_000, userAgent } = {}) {
  const agent = userAgent || require('../network/fetch-utils').DEFAULT_USER_AGENT;
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': agent, Accept: '*/*' } });
  const declared = Number(res.headers && res.headers.get && res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
    throw new Error('The answer is larger than the catalog reads.');
  }
  const text = await res.text();
  if (text.length > maxBytes) throw new Error('The answer is larger than the catalog reads.');
  return { status: res.status, text };
}

module.exports = { fetchText };
