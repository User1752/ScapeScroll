'use strict';

// Image hosts whose own rules differ from the request the image proxy makes by default (a browser User-Agent, and a Referer: the one the
// page asked for, or the one inferRefererForUrl() infers, which is the host's own address when nothing better is known). Each list says
// what the host was MEASURED to do; a host is added only after a real request showed it. Matched on the host name of the image.
module.exports = {
  // 403 when the request claims to be a browser, 200 for a plain one. Measured 2026-11-01 on the library's own covers: the same address
  // answered 403 with a Chrome User-Agent (with or without a Referer) and 200 with no User-Agent at all. A browser loading the cover
  // directly is refused too, which is why these covers went blank.
  withoutUserAgentHosts: [/^uploads\.mangadex\.org$/i],
  // 403 when its OWN address is the Referer, 200 with none. Measured 2026-11-01.
  withoutRefererHosts: [/(^|\.)mancover\.xyz$/i, /(^|\.)anime-planet\.com$/i],
  // Covers a BROWSER cannot load from the host directly (measured 2026-11-01 from this app's own page, whatever Referer policy): the page asks
  // this app's image proxy for them instead, which sends what each host accepts. The first refuses a browser's User-Agent; the others want
  // the site's own address as Referer, which a page's <img> never sends. public/modules/utils.js keeps the same list (a test keeps them equal).
  browserBlockedHosts: [/^uploads\.mangadex\.org$/i, /(^|\.)readdetectiveconan\.com$/i, /(^|\.)2xstorage\.com$/i],
};
