'use strict';

// "Connect to the Suwayomi set up on this computer": on Windows, tools/windows/Setup-Suwayomi.cmd installs a Suwayomi-Server that listens only on this
// computer, in a "Suwayomi" folder inside the ScrollScape folder, and writes how to reach it (address, user, password) to a small file there. This reads that one file and hands the three values
// to the settings, so the person does not copy a password by hand.
//
// The file is at a fixed place (never a path from the request), is read only when it is small and exactly the shape the script writes, and its address can only be
// this computer: a file that names another host is refused, so nothing can point the app's Suwayomi settings at a server the person did not set up here.

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 4096;
const URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})$/;
const TEXT_RE = /^[A-Za-z0-9._-]{1,100}$/; // letters, digits and a few marks: the only characters the script uses for the user and the password

/** The folder the script installs into: a "Suwayomi" folder inside the ScrollScape folder (the one that holds the library). */
const suwayomiFolder = (userRoot) => (userRoot ? path.join(String(userRoot), 'Suwayomi') : '');

/** Where the script keeps the connection file, or '' when the app does not know its folder. */
function connectionFilePath(userRoot) {
  const folder = suwayomiFolder(userRoot);
  return folder ? path.join(folder, 'connection.json') : '';
}

// A folder that can go into a batch file as it is: a drive or a network path, and none of the characters a batch line reads (quote, percent, caret, ...).
const BAKEABLE_FOLDER_RE = /^(?:[A-Za-z]:\\|\\\\)[^"%^!&|<>]*$/;
// (a control character, a line break included, is checked apart: it cannot be written in the pattern above without tripping the linter)
const hasControlCharacter = (text) => [...text].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

/**
 * The text of the setup script with the folder of this app filled in, so the script installs next to the library wherever it was downloaded to.
 * A folder that cannot go into a batch file safely leaves the text as it is (the script then installs into the person's profile).
 */
function bakeSetupScript(text, userRoot) {
  const folder = suwayomiFolder(userRoot);
  const marker = 'set "SS_ROOT="';
  if (!folder || !BAKEABLE_FOLDER_RE.test(folder) || hasControlCharacter(folder) || String(text).split(marker).length !== 2) return String(text);
  return String(text).replace(marker, () => `set "SS_ROOT=${folder}"`);
}

/** The setup script that ships with the app, or '' when this build has none. */
function setupScriptPath(baseDir = path.join(__dirname, '..', '..', '..')) {
  const file = path.join(baseDir, 'tools', 'windows', 'Setup-Suwayomi.cmd');
  try {
    return fs.statSync(file).isFile() ? file : '';
  } catch (_) {
    return '';
  }
}

/**
 * @param {{ file?: string, readFile?: (file: string) => Buffer|string }} [deps]
 * @returns {{ url: string, username: string, password: string }}
 * @throws {Error} with a statusCode: 404 when there is no file, 422 when it is not what the script writes
 */
function readLocalConnection({ file = '', readFile = fs.readFileSync } = {}) {
  const fail = (message, statusCode) => Object.assign(new Error(message), { statusCode });
  if (!file) throw fail('No Suwayomi set up on this computer was found. Run Setup-Suwayomi.cmd first.', 404);
  let raw;
  try {
    raw = readFile(file);
  } catch (_) {
    throw fail('No Suwayomi set up on this computer was found. Run Setup-Suwayomi.cmd first.', 404);
  }
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  if (text.length > MAX_FILE_BYTES) throw fail('The connection file is larger than the one the setup script writes.', 422);
  let data;
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); // a byte-order mark (what Windows editors add) is not part of the text
  } catch (_) {
    throw fail('The connection file is not readable. Run Setup-Suwayomi.cmd again.', 422);
  }
  const url = data && typeof data.url === 'string' ? data.url : '';
  const match = URL_RE.exec(url);
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw fail('The connection file names an address that is not this computer, so it was not used.', 422);
  const username = data && typeof data.username === 'string' ? data.username : '';
  const password = data && typeof data.password === 'string' ? data.password : '';
  if (!TEXT_RE.test(username) || !TEXT_RE.test(password)) throw fail('The connection file has a user or password in a form the setup script does not write.', 422);
  return { url, username, password };
}

module.exports = { suwayomiFolder, connectionFilePath, bakeSetupScript, setupScriptPath, readLocalConnection, MAX_FILE_BYTES };
