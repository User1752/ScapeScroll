'use strict';

// server/modules/common/image-dimensions.js — reads only the header bytes of
// a JPEG/PNG/WEBP/GIF (the same four formats proxy/service.js's
// sniffImageType() already recognizes by magic bytes) far enough to pull out
// pixel width/height, without decoding the actual image. Exists because file
// size alone is a poor proxy for resolution — a small, cleanly-compressed
// webp thumbnail can outweigh, in bytes, a much larger and genuinely better
// image (see system-health/image-quality-health.js's MIN_ACCEPTABLE_BYTES,
// which is deliberately a "not corrupt/truncated" floor, not a quality bar).

function readPngSize(buf) {
  if (buf.length < 24) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readGifSize(buf) {
  if (buf.length < 10) return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function readJpegSize(buf) {
  let i = 2; // skip SOI (0xFFD8)
  while (i + 9 <= buf.length) {
    if (buf[i] !== 0xFF) return null;
    // JPEG allows one or more fill bytes (extra 0xFF) between the 0xFF
    // prefix and the real marker code — some real-world encoders/re-savers
    // emit these. Skip past them so `marker` is never itself 0xFF (which
    // would otherwise be misread as a segment-length byte below).
    let m = i + 1;
    while (m < buf.length && buf[m] === 0xFF) m++;
    const marker = buf[m];
    // SOF0-SOF3 (baseline/extended-sequential/progressive/lossless) — by far
    // the markers real-world encoders emit; covers the height/width fields.
    if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2 || marker === 0xC3) {
      return { height: buf.readUInt16BE(m + 4), width: buf.readUInt16BE(m + 6) };
    }
    if (marker === 0xD8 || marker === 0xD9) { i = m + 1; continue; }
    const len = buf.readUInt16BE(m + 1);
    if (len < 2) return null;
    i = m + 1 + len;
  }
  return null;
}

function readWebpSize(buf) {
  if (buf.length < 30) return null;
  const fourCC = buf.toString('ascii', 12, 16);
  if (fourCC === 'VP8X') {
    return {
      width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)),
      height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)),
    };
  }
  if (fourCC === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3FFF, height: buf.readUInt16LE(28) & 0x3FFF };
  }
  if (fourCC === 'VP8L') {
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    return {
      width: 1 + (((b1 & 0x3F) << 8) | b0),
      height: 1 + (((b3 & 0x0F) << 10) | (b2 << 2) | ((b1 & 0xC0) >> 6)),
    };
  }
  return null;
}

// Returns {width, height} or null (unrecognized format, truncated buffer, or
// a malformed header) — callers should treat null as "unknown", never as
// "small", since a parse failure isn't evidence the image itself is bad.
function readImageSize(buf, contentType) {
  try {
    if (contentType === 'image/png') return readPngSize(buf);
    if (contentType === 'image/gif') return readGifSize(buf);
    if (contentType === 'image/jpeg') return readJpegSize(buf);
    if (contentType === 'image/webp') return readWebpSize(buf);
  } catch (_) {
    return null;
  }
  return null;
}

module.exports = { readImageSize };
