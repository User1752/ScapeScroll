'use strict';

// "Is this address a loading picture and not a page of the chapter?" One place for the rule, used by the live Test (the pages a
// source returned) and by the probe (the pages a site's chapter HTML holds), so they cannot disagree.

// loading / placeholder / spinner / lazy / blank as a word of the file name or of a folder of its path ("/Loading/Loading.gif",
// "img/placeholder.png", "lazy-1.gif"), not as letters inside another word ("reloading-title.webp").
const PLACEHOLDER_RE = /(^|[/_.-])(loading|placeholder|spinner|lazy|blank|preloader)([/_.-]|\d|$)/i;
// A tiny inline picture is a placeholder too.
const DATA_URI_RE = /^data:image\/(gif|png|svg\+xml)[;,]/i;

/** True when `address` (a URL, a path or a data URI) is a loading placeholder. The query string is not looked at. */
function isPlaceholderAddress(address) {
  const text = String(address || '');
  if (!text) return false;
  if (DATA_URI_RE.test(text)) return true;
  return PLACEHOLDER_RE.test(text.split('?')[0]);
}

module.exports = { isPlaceholderAddress, PLACEHOLDER_RE };
