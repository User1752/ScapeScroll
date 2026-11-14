'use strict';

// The reading progress kept on the server only works if the pieces stay connected, and each of these is a one-line connection that a
// later change could drop without any test of the pieces themselves failing:
//  - saveSettings() (where every change of the progress passes) tells the sync, and so does the AniList code that writes the keys itself;
//  - the sync starts with the app, before the AniList reconcile, and its script loads before the start-up script;
//  - restoring a backup file makes its progress replace the server's;
//  - the card is in Settings → Data & Backup;
//  - the server configures the file and its routes, and keeps daily copies of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8').replace(/\r\n/g, '\n'); // the sources may be CRLF
const modules = (f) => read('public', 'modules', f);

test('saveSettings() and the AniList writer of the progress keys tell the sync', () => {
  const save = modules('ui-settings.js').match(/function saveSettings\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(save, /progressSyncMarkDirty\(\)/);
  assert.match(save, /scrollscapeReadingProgress/, 'it is still the function that writes the progress');
  const persist = modules('anilist.js').match(/function _persistLocalReadingState\(\) \{[\s\S]*?\n\}\n/)[0];
  assert.match(persist, /progressSyncMarkDirty\(\)/);
});

test('the sync starts at launch, ahead of the AniList reconcile, and its script is loaded before the start-up one', () => {
  const init = modules('ui-initialization.js');
  const started = init.indexOf('progressSyncInit()');
  const reconcile = init.indexOf('anilistStartupReconcileProgress()');
  assert.ok(started > 0 && reconcile > 0 && started < reconcile, 'progressSyncInit() is called before the reconcile');
  assert.match(init, /Promise\.race\(\[progressSyncStarted/, 'and the app never waits long for the server');
  const html = read('public', 'index.html');
  assert.ok(html.indexOf('progress-sync.js') > 0, 'the script is in the page');
  assert.ok(html.indexOf('progress-sync.js') < html.indexOf('ui-initialization.js'), 'and loads before the start-up script');
});

test('a restored backup file replaces the server\'s progress, and only when the file carries progress', () => {
  const backup = modules('ui-backup.js');
  assert.match(backup, /hasOwnProperty\.call\(backup\.localStorage, 'scrollscapeReadChapters'\)[\s\S]{0,200}progressSyncForceUploadOnNextStart\(\)/);
});

test('the card is in Data & Backup and is bound when the modal opens', () => {
  assert.match(modules('ui-settings-modal-html.js'), /id: 'tab-data'[^\n]*'settingsCardProgressSync'/);
  assert.match(modules('ui-settings-modal.js'), /bindProgressSyncCard\(\)/);
  assert.match(modules('progress-sync.js'), /function settingsCardProgressSync\(\)/);
});

test('the server configures the progress file, registers the routes, and keeps daily copies of it', () => {
  const server = read('server.js');
  assert.match(server, /reading-progress\.json/);
  assert.match(server, /progressRoutes\.configure\(/);
  assert.match(server, /extraFiles: \[\{ path: PROGRESS_PATH, prefix: 'progress'/);
  assert.match(read('server', 'routes', 'bootstrap.js'), /registerProgressRoutes\(app\)/);
  assert.match(read('.gitignore'), /^data\/reading-progress\.json/m, 'the file is not committed');
});
