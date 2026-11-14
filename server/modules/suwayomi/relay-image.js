'use strict';

// The images of a source that reads through the person's own Suwayomi-Server (the sources written for the extension
// engine) are not addresses on the internet: they are this app's own relay, /api/suwayomi/..., which adds the login the server needs. The
// browser loads them as they are. Anything that fetches an image from the server side (the source Test, a chapter download, "save offline")
// would refuse them as "not an address the app can fetch", so it asks here instead: only these two exact shapes of path are accepted, they
// are never joined to another address, and the bytes come from the server the person set up in Settings, through the same service the relay uses.

const RELAY_IMAGE_RE = /^\/api\/suwayomi\/(?:thumbnail\/(\d{1,12})|page\/(\d{1,12})\/(\d{1,6})\/(\d{1,6}))$/;
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

const isRelayImage = (value) => typeof value === 'string' && RELAY_IMAGE_RE.test(value);

let sharedService = null;
function defaultService() {
  if (!sharedService) {
    // Required here, not at the top: this file is loaded by the network helpers, which the store and the service in turn depend on.
    const { readStore } = require('../../store');
    sharedService = require('./service').createSuwayomiService({ readStore });
  }
  return sharedService;
}

/**
 * @param {string} relayPath   one of the two shapes above
 * @param {{ service?: { getThumbnail: Function, getPage: Function } }} [deps]
 * @returns {Promise<Buffer>}
 */
async function fetchRelayImage(relayPath, { service } = {}) {
  const match = RELAY_IMAGE_RE.exec(String(relayPath));
  if (!match) throw new Error('Not an image of the Suwayomi relay');
  const suwayomi = service || defaultService();
  const { body } = match[1] !== undefined ? await suwayomi.getThumbnail(match[1]) : await suwayomi.getPage(match[2], match[3], match[4]);
  const chunks = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MAX_IMAGE_BYTES) throw new Error('The image is too large');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

module.exports = { isRelayImage, fetchRelayImage, RELAY_IMAGE_RE };
