'use strict';

// The Discord settings of the Settings window (public/modules/ui-settings-modal.js). The Client ID used to be saved by a "change" event only, with a call whose answer
// nobody read: closing Settings with the ID just pasted could lose it, and a refusal of the server looked exactly like a setting that "does not save". What must hold:
//  - the ID is saved while it is typed (after a pause), when the field is left, and when Settings is closed with the cursor still in it;
//  - nothing is sent for a field the person did not touch (an empty box whose stored value has not arrived must never wipe the stored ID on close);
//  - a failure is said (a toast with the reason), and a switch that could not be saved goes back to what the server has;
//  - what is sent is exactly the trimmed text, and it is sent once for one edit.
// The real block runs in a vm sandbox with a fake page and a fake server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'modules', 'ui-settings-modal.js'), 'utf8').replace(/\r\n/g, '\n');
const from = source.indexOf('const saveDiscordSetting = async');
const to = source.indexOf('// Protected-sites card');
assert.ok(from > 0 && to > from, 'the Discord block is where the test expects it');
const block = source.slice(from, to);

function sandbox({ answer = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) } = {}) {
  const posts = [];
  const toasts = [];
  const timers = [];
  const calls = { saveSettings: 0, poll: 0, removed: 0 };
  const input = { value: '', oninput: null, onchange: null };
  const toggle = { checked: false, onchange: null };
  const modal = { remove() { calls.removed += 1; } };
  const ctx = {
    console, JSON, String, Promise,
    discordToggle: toggle,
    discordClientIdInput: input,
    modal,
    saveSettings: () => { calls.saveSettings += 1; },
    pollDiscordStatus: () => { calls.poll += 1; },
    showToast: (...args) => toasts.push(args),
    fetch: async (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); return answer(posts.length); },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
  };
  vm.createContext(ctx);
  vm.runInContext(block, ctx, { filename: 'ui-settings-modal.js' });
  const settle = () => new Promise((resolve) => { setImmediate(resolve); });
  const fireTimers = async () => { const pending = timers.splice(0).filter(Boolean); for (const fn of pending) await fn(); await settle(); };
  return { input, toggle, modal, posts, toasts, calls, fireTimers, settle };
}

test('the ID is saved after a pause in typing, once, as the trimmed text', async () => {
  const s = sandbox();
  s.input.value = '  119123456789012345';
  s.input.oninput();
  s.input.value = '  1191234567890123456  ';
  s.input.oninput();
  assert.equal(s.posts.length, 0, 'nothing is sent while typing goes on');
  await s.fireTimers();
  assert.equal(s.posts.length, 1, 'one request for one edit, not one per key');
  assert.deepEqual(s.posts[0].body, { discordClientId: '1191234567890123456' });
  assert.equal(s.posts[0].url, '/api/settings');
  assert.deepEqual([s.calls.saveSettings, s.calls.poll], [1, 1]);
  assert.deepEqual(s.toasts.map((t) => t[1]), ['Client ID saved.']);
});

test('it is saved when the field is left, and not sent again for the same edit', async () => {
  const s = sandbox();
  s.input.value = '123';
  s.input.oninput();
  s.input.onchange();
  await s.settle();
  assert.equal(s.posts.length, 1);
  await s.fireTimers();
  assert.equal(s.posts.length, 1, 'the pause that was waiting is cancelled');
  s.modal.remove();
  await s.settle();
  assert.equal(s.posts.length, 1, 'and closing the window after it was saved sends nothing more');
});

test('closing Settings with the cursor still in the field saves what was typed, and closes', async () => {
  const s = sandbox();
  s.input.value = '777';
  s.input.oninput();
  s.modal.remove();
  await s.settle();
  assert.deepEqual(s.posts.map((p) => p.body), [{ discordClientId: '777' }]);
  assert.equal(s.calls.removed, 1, 'the window closes');
});

test('closing Settings without touching the field sends nothing, so a stored ID is never wiped by an empty box that has not been filled yet', async () => {
  const s = sandbox();
  s.modal.remove();
  await s.settle();
  assert.equal(s.posts.length, 0);
  assert.equal(s.calls.removed, 1);
  s.input.value = '';
  s.modal.remove();
  await s.settle();
  assert.equal(s.posts.length, 0, 'still nothing: the box was never edited');
});

test('clearing the ID on purpose is saved as an empty text', async () => {
  const s = sandbox();
  s.input.value = '';
  s.input.oninput();
  await s.fireTimers();
  assert.deepEqual(s.posts.map((p) => p.body), [{ discordClientId: '' }]);
  assert.deepEqual(s.toasts.map((t) => t[1]), ['Client ID cleared.']);
});

test('a refusal of the server is said with its reason, and the text stays to be sent again', async () => {
  let n = 0;
  const s = sandbox({ answer: () => { n += 1; return n === 1 ? { ok: false, status: 403, json: async () => ({ ok: false, error: 'This action is only available from the computer running ScrollScape.' }) } : { ok: true, status: 200, json: async () => ({ ok: true }) }; } });
  s.input.value = '555';
  s.input.oninput();
  await s.fireTimers();
  assert.equal(s.toasts.length, 1);
  assert.deepEqual([s.toasts[0][0], s.toasts[0][2]], ['Discord', 'error']);
  assert.match(s.toasts[0][1], /Could not save the Client ID: This action is only available from the computer/);
  assert.equal(s.calls.saveSettings, 0, 'nothing is reported as saved');
  s.modal.remove(); // still dirty: closing tries again
  await s.settle();
  assert.equal(s.posts.length, 2, 'it was sent again on close');
  assert.equal(s.toasts.length, 2);
  assert.equal(s.toasts[1][1], 'Client ID saved.');
  // a server that cannot be reached at all
  const down = sandbox({ answer: () => { throw new Error('Failed to fetch'); } });
  down.input.value = '9';
  down.input.oninput();
  await down.fireTimers();
  assert.match(down.toasts[0][1], /Could not save the Client ID: Failed to fetch/);
  // an answer with no JSON still carries its status
  const odd = sandbox({ answer: () => ({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }) });
  odd.input.value = '9';
  odd.input.oninput();
  await odd.fireTimers();
  assert.match(odd.toasts[0][1], /the server answered 502/);
});

test('the switch goes back to what the server has when it could not be saved, and says why', async () => {
  const refused = sandbox({ answer: () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'disk full' }) }) });
  refused.toggle.checked = true;
  await refused.toggle.onchange({ target: refused.toggle });
  assert.equal(refused.toggle.checked, false, 'it shows what the server has');
  assert.match(refused.toasts[0][1], /Could not save the switch: disk full/);
  const fine = sandbox();
  fine.toggle.checked = true;
  await fine.toggle.onchange({ target: fine.toggle });
  assert.equal(fine.toggle.checked, true);
  assert.deepEqual(fine.posts.map((p) => p.body), [{ discordRichPresenceEnabled: true }]);
  assert.equal(fine.toasts.length, 0, 'no toast for a switch that worked');
});
