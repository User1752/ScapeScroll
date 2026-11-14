'use strict';

// Builds a same-origin /api/proxy-image URL for a source-provided image URL.
// A plain <img src> pointed straight at most manga CDNs gets rejected because
// the browser sends no Referer for it — routing through our own server lets
// it attach the CDN's expected Referer/User-Agent/session cookies instead.
function proxyImageUrl(url, ref) {
  if (!url) return '';
  const refPart = ref ? `&ref=${encodeURIComponent(ref)}` : '';
  return `/api/proxy-image?url=${encodeURIComponent(url)}${refPart}`;
}

module.exports = { proxyImageUrl };
