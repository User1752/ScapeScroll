'use strict';

// Hosts of ad and pop-under networks. A page that loads these must never be opened in a browser to study it (the guide's rule),
// a site that is challenged AND full of them cannot be read through FlareSolverr's browser safely, and a source file that
// NAMES one is not a source: it was copied from a hostile page (the probe's reading of a site and the Check's reading of a
// source file use the same list).

const AD_NETWORKS = Object.freeze([
  ['PopAds', 'popads.net'], ['PopCash', 'popcash.net'], ['ExoClick', 'exoclick.com'], ['ExoClick', 'exosrv.com'], ['JuicyAds', 'juicyads.com'],
  ['Adsterra', 'adsterra'], ['Adsterra', 'highperformanceformat.com'], ['Adsterra', 'profitablecpm'], ['PropellerAds', 'propellerads'],
  ['PropellerAds', 'onclickads'], ['PropellerAds', 'pushails'], ['HilltopAds', 'hilltopads'], ['Clickadu', 'clickadu'],
  ['TrafficJunky', 'trafficjunky'], ['Adcash', 'adcash'], ['Monetag', 'monetag'], ['RichAds', 'richads'], ['Mgid', 'mgid.com'],
  ['Taboola', 'taboola'], ['Outbrain', 'outbrain'], ['Revcontent', 'revcontent'], ['A-ADS', 'a-ads.com'], ['Google Ads', 'googlesyndication'],
  ['Google Ads', 'doubleclick.net'], ['Media.net', 'media.net'], ['AdMaven', 'ad-maven'], ['ClickAdilla', 'clickadilla'],
  ['TrafficStars', 'trafficstars'], ['Yllix', 'yllix'], ['Ad-Maven', 'admaven'], ['EZMob', 'ezmob'], ['Bidvertiser', 'bidvertiser'],
  ['PubAdx', 'pubadx.one'],
]);

/** The names of the ad networks `markup` (a page, or a source file's text) mentions, once each. */
function adNetworksIn(markup) {
  const found = new Set();
  const text = String(markup || '').toLowerCase();
  for (const [name, fragment] of AD_NETWORKS) if (text.includes(fragment)) found.add(name);
  return [...found];
}

/** Where `markup` first names an ad network (an index), or -1. */
function firstAdNetworkIndex(markup) {
  const text = String(markup || '').toLowerCase();
  const at = AD_NETWORKS.map(([, fragment]) => text.indexOf(fragment)).filter((i) => i >= 0);
  return at.length ? Math.min(...at) : -1;
}

module.exports = { AD_NETWORKS, adNetworksIn, firstAdNetworkIndex };
