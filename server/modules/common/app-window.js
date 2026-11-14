'use strict';

/**
 * Opens ScrollScape in its own window, the way Launch-ScrollScape.bat does.
 *
 * `start <url>` (what the packaged .exe used to do) opens a TAB in whatever the
 * default browser is. Chrome and Edge can instead open a bare application
 * window with `--app=<url>`: no tabs, no address bar, its own taskbar entry,
 * independent of the browsing windows already open. The .bat has always done
 * that (Chrome first, then Edge); this module gives the .exe the same
 * behaviour. When neither is installed the default browser is used as before.
 *
 * SCROLLSCAPE_BROWSER_WINDOW=tab keeps the old behaviour (a tab in the default
 * browser).
 */

const path = require('path');
const fs = require('fs');

const WINDOW_SIZE = '--window-size=1280,832';

/** Chrome first, then Edge: the same order and locations as Launch-ScrollScape.bat. */
function browserCandidates(env = process.env) {
  const join = (...parts) => (parts[0] ? path.win32.join(...parts) : null);
  return [
    join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env.LocalAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
}

/** @returns {string|null} path of the first installed Chrome/Edge */
function findAppBrowser({ env = process.env, exists = fs.existsSync } = {}) {
  return browserCandidates(env).find((p) => {
    try { return exists(p); } catch { return false; }
  }) || null;
}

/** Only http(s) URLs are ever opened: the value ends up on a command line. */
function isSafeUrl(url) {
  return /^https?:\/\/[A-Za-z0-9.\-[\]:]+(:\d{1,5})?(\/[^\s"'<>^&|%]*)?$/.test(String(url));
}

/**
 * @param {string} url
 * @returns {'app'|'default'|'none'} how it was opened ('none' = refused)
 */
function openUrl(url, {
  platform = process.platform,
  env = process.env,
  exists = fs.existsSync,
  spawn = (...a) => require('child_process').spawn(...a),
  exec = (...a) => require('child_process').exec(...a),
  log = console.log,
} = {}) {
  if (!isSafeUrl(url)) { log(`  (Not opening an unexpected address: ${url})`); return 'none'; }

  const viaDefaultBrowser = () => {
    const command = platform === 'win32' ? `start "" "${url}"`
      : platform === 'darwin' ? `open "${url}"`
        : `xdg-open "${url}"`; // Linux & Android (Termux)
    exec(command, (err) => {
      // Not critical to operation.
      if (err) log(`  (Auto-open failed; navigate manually to ${url})`);
    });
    return 'default';
  };

  const wantTab = String(env.SCROLLSCAPE_BROWSER_WINDOW || '').trim().toLowerCase() === 'tab';
  if (platform !== 'win32' || wantTab) return viaDefaultBrowser();

  const browser = findAppBrowser({ env, exists });
  if (!browser) return viaDefaultBrowser();
  try {
    const child = spawn(browser, [`--app=${url}`, WINDOW_SIZE], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on?.('error', () => viaDefaultBrowser());
    child.unref?.();
    return 'app';
  } catch {
    return viaDefaultBrowser();
  }
}

module.exports = { openUrl, findAppBrowser, browserCandidates, isSafeUrl };
