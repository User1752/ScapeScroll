'use strict';

// Regenerates build-assets/app-icon.ico — the SMALL (16/32/48 only, kept
// under ~100KB on purpose, see SIZES below) icon injected into the packaged
// .exe by tools/set-exe-icon.js. Deliberately NOT the same file as
// public/favicon.ico (the browser tab icon): that one can be as rich as it
// wants (currently 7 sizes up to 256px) since a browser has no trouble with
// a larger multi-res ICO — only the exe-injection step is size-constrained.
// If icon-source.jpg ever changes, regenerate public/favicon.ico separately
// with a fuller SIZES list (e.g. copy this script, don't just re-run it).
//
// Run manually whenever build-assets/icon-source.jpg (the master image)
// changes. Regenerate the per-size PNGs first (ffmpeg, already a project
// dependency for other things — see data/sources & the video pipeline),
// then this script:
//   for %s in (16 32 48) do ffmpeg -y -i build-assets/icon-source.jpg -vf scale=%s:%s -frames:v 1 build-assets/icon-%s.png
//   tools/node/node.exe tools/build-icon.js

const fs = require('fs');
const path = require('path');
// png-to-ico ships as an ESM-only package ("type": "module") - Node's CJS
// require() of it returns the module namespace object, with the actual
// default export under .default, not the function itself.
const pngToIco = require('png-to-ico').default;

const ASSETS_DIR = path.join(__dirname, '..', 'build-assets');
// Kept small deliberately: pkg-built executables aren't a "clean" PE file
// (the whole packaged app is appended as a custom binary payload, not a
// normal PE section) — confirmed live, empirically, that a larger icon
// (originally 7 sizes up to 256px, 372KB) makes any PE resource editor's
// rewrite corrupt that payload and the exe won't start at all
// ("SyntaxError: Invalid or unexpected token" in pkg's own bootstrap
// prelude). This matches a well-documented, long-standing pkg community
// issue (vercel/pkg#149) that names >100KB icons specifically as the
// trigger. 16/32/48 is also just the classic Windows icon size set most
// contexts (taskbar, Explorer list view) actually use.
const SIZES = [16, 32, 48];

async function main() {
  const pngPaths = SIZES.map((size) => path.join(ASSETS_DIR, `icon-${size}.png`));
  for (const p of pngPaths) {
    if (!fs.existsSync(p)) {
      throw new Error(`Missing ${p} - regenerate the PNG sizes first (see this file's own header comment for the ffmpeg commands used originally).`);
    }
  }
  const icoBuffer = await pngToIco(pngPaths);
  const outPath = path.join(ASSETS_DIR, 'app-icon.ico');
  fs.writeFileSync(outPath, icoBuffer);
  console.log(`Wrote ${outPath} (${icoBuffer.length} bytes, ${SIZES.length} sizes: ${SIZES.join(', ')})`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
