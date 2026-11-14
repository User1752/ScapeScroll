'use strict';

// Injects build-assets/app-icon.ico into a packaged .exe as a post-build
// step (npm run build:win) — pkg itself has no built-in --icon option, so
// this is a separate pass over the already-compiled binary. Uses
// resedit-cli (pure JS, reads/writes PE resources directly - no native
// Windows-only binary dependency, unlike the older rcedit wrapper) via its
// CLI entry point rather than its ESM-only programmatic API, to avoid
// require()/import interop friction from this file's own CommonJS context.
//
// pkg-built executables are NOT a clean PE file - the whole packaged app is
// appended as a custom binary payload, not a normal PE section - and
// confirmed live, empirically, that a too-large icon (originally tried: 7
// sizes up to 256px, 372KB) makes ANY PE resource editor's rewrite corrupt
// that payload: the exe still "succeeds" (resedit-cli reports no error, the
// icon really is embedded, Explorer shows it correctly) but silently can no
// longer start at all - it flashes a console window and exits instantly,
// throwing "SyntaxError: Invalid or unexpected token" from pkg's own
// bootstrap prelude. This matches a well-documented, long-standing pkg
// community issue (vercel/pkg#149) naming >100KB icons specifically as the
// trigger. Both defenses below exist because that failure mode is silent at
// the tool level - it takes actually launching the exe to notice.

const { execFileSync, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const MAX_ICON_BYTES = 80 * 1024; // safety margin under the ~100KB trigger

const exePath = process.argv[2];
if (!exePath || !fs.existsSync(exePath)) {
  console.error('Usage: node tools/set-exe-icon.js <path-to-exe>');
  process.exit(1);
}

const iconPath = path.join(__dirname, '..', 'build-assets', 'app-icon.ico');
if (!fs.existsSync(iconPath)) {
  console.error(`Icon not found at ${iconPath} — run tools/build-icon.js first.`);
  process.exit(1);
}

const iconSize = fs.statSync(iconPath).size;
if (iconSize > MAX_ICON_BYTES) {
  console.error(
    `Icon at ${iconPath} is ${iconSize} bytes — over the ${MAX_ICON_BYTES}-byte safety margin ` +
    `known to corrupt pkg-built executables (see this file's own header comment). ` +
    `Regenerate it with fewer/smaller sizes in tools/build-icon.js's SIZES list instead of proceeding.`
  );
  process.exit(1);
}

const cliPath = path.join(__dirname, '..', 'node_modules', 'resedit-cli', 'dist', 'cli.js');

// Written to a temp copy first, never straight over the only good copy of
// the exe - if resedit-cli's rewrite corrupts it despite the size guard
// above, the original stays intact and this script fails loudly instead of
// silently handing back a broken build.
const tmpPath = `${exePath}.icon-tmp`;
fs.copyFileSync(exePath, tmpPath);
try {
  execFileSync(process.execPath, [cliPath, '--in', tmpPath, '--out', tmpPath, '--icon', `1,${iconPath}`], { stdio: 'inherit' });
} catch (err) {
  fs.rmSync(tmpPath, { force: true });
  throw err;
}

// A corrupted pkg payload doesn't fail resedit-cli's own write - the only
// way to actually know the exe still works is to launch it and confirm it
// doesn't immediately exit (pkg's bootstrap crash happens in well under a
// second; a real ScrollScape startup takes noticeably longer to even reach
// its own first log line, so "still running after 3s" is a safe, cheap signal).
function verifyExeStarts(candidatePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(candidatePath, [], { stdio: 'ignore' });
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`exited immediately with code ${code} - icon injection likely corrupted the packaged payload`));
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve();
    }, 3000);
  });
}

verifyExeStarts(tmpPath)
  .then(() => {
    fs.copyFileSync(tmpPath, exePath);
    fs.rmSync(tmpPath, { force: true });
    console.log(`Icon set on ${exePath} (verified: still launches after injection)`);
  })
  .catch((err) => {
    fs.rmSync(tmpPath, { force: true });
    console.error(`Icon injection produced a broken executable, original left untouched: ${err.message}`);
    process.exit(1);
  });
