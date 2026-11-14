'use strict';

// The login screen (public/modules/ui-auth-gate.js): the app opens by itself as soon as the field holds the right
// password (after a pause in typing, or when a password manager fills it), or on Enter; a wrong guess made while typing
// is silent. The real script runs in a vm sandbox with a stand-in DOM, a stub server and timers the test drives.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FILE = path.join(__dirname, '..', '..', 'public', 'modules', 'ui-auth-gate.js');
const RIGHT = 'correct horse';
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeElement() {
  const classes = new Set(['hidden']);
  const listeners = new Map();
  return {
    value: '',
    textContent: '',
    disabled: false,
    focused: 0,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    focus() { this.focused += 1; },
    addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    fire(type) { for (const fn of listeners.get(type) || []) fn({ type }); },
  };
}

// `serverAnswer(password)` -> 'ok' | 'wrong' | 'slow-down'
// `hold`: a promise the stub server waits for before it answers a login, to keep a try in flight.
function makeEnv({ withButton = false, passwordSet = true, authenticated = false, serverAnswer = (p) => (p === RIGHT ? 'ok' : 'wrong'), hold = null } = {}) {
  const els = { authGateOverlay: fakeElement(), authGateForm: fakeElement(), authGatePasswordInput: fakeElement(), authGateError: fakeElement(), ...(withButton ? { authGateSubmitBtn: fakeElement() } : {}) };
  const logins = [];
  const timers = [];
  const sandbox = {
    document: { getElementById: (id) => els[id] || null },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    fetch: async (url, opts) => {
      if (url === '/api/auth/status') return { json: async () => ({ passwordSet, authenticated }) };
      const password = JSON.parse(opts.body).password;
      logins.push(password);
      if (hold) await hold;
      const answer = serverAnswer(password);
      if (answer === 'ok') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (answer === 'slow-down') return { ok: false, status: 429, json: async () => ({ ok: false, error: 'Too many requests' }) };
      return { ok: false, status: 401, json: async () => ({ ok: false, error: 'Incorrect password' }) };
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FILE, 'utf8'), sandbox, { filename: FILE });
  const input = els.authGatePasswordInput;
  return {
    els, logins, input,
    open: sandbox.checkAuthGate(),
    // Types a value the way a keyboard or a paste does, then lets the pause pass.
    async type(value, event = 'input') {
      input.value = value;
      input.fire(event);
      await this.pause();
    },
    async pause() {
      const due = timers.filter(Boolean);
      timers.length = 0;
      for (const fn of due) fn();
      await settle();
      await settle();
    },
    async submit() {
      let prevented = false;
      await els.authGateForm.onsubmit({ preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true);
      await settle();
    },
    isOpen: () => els.authGateOverlay.classList.contains('hidden'),
  };
}

async function shown(env) {
  await settle();
  assert.equal(env.isOpen(), false, 'the login screen is showing');
}

test('no password set, or already signed in: no screen, the app goes straight on', async () => {
  for (const state of [{ passwordSet: false }, { authenticated: true }]) {
    const env = makeEnv(state);
    assert.equal(await env.open, true);
    assert.deepEqual(env.logins, []);
  }
});

test('the right password opens the app by itself after a pause, with no click, and only once', async () => {
  const env = makeEnv();
  await shown(env);
  await env.type(RIGHT);
  assert.equal(await env.open, true);
  assert.equal(env.isOpen(), true, 'the screen is hidden');
  assert.deepEqual(env.logins, [RIGHT]);
  await env.type(RIGHT);
  await env.submit();
  assert.deepEqual(env.logins, [RIGHT], 'nothing is asked again once it is open');
});

test('a password manager that fills the field and fires only "change" opens it too', async () => {
  const env = makeEnv();
  await shown(env);
  await env.type(RIGHT, 'change');
  assert.equal(await env.open, true);
});

test('typing is not a try: nothing is asked until the pause, and only what the field holds then', async () => {
  const env = makeEnv();
  await shown(env);
  for (const partial of ['c', 'co', 'cor']) {
    env.input.value = partial;
    env.input.fire('input');
  }
  await settle();
  assert.deepEqual(env.logins, [], 'no request while the keys are still coming');
  await env.type(RIGHT);
  assert.deepEqual(env.logins, [RIGHT], 'one request, with the final text');
});

test('a wrong guess found by a pause is silent: no message, the text stays, and the same text is not asked twice', async () => {
  const env = makeEnv();
  await shown(env);
  await env.type('wrong one');
  assert.deepEqual(env.logins, ['wrong one']);
  assert.equal(env.els.authGateError.classList.contains('hidden'), true, 'no error shown');
  assert.equal(env.input.value, 'wrong one', 'the text is still there');
  env.input.fire('input');
  await env.pause();
  assert.deepEqual(env.logins, ['wrong one'], 'the same text is not tried again');
  await env.type(RIGHT);
  assert.equal(await env.open, true);
});

test('Enter is an explicit try: right opens the app, wrong says so and empties the field', async () => {
  const env = makeEnv();
  await shown(env);
  env.input.value = 'nope';
  await env.submit();
  assert.equal(env.els.authGateError.textContent, 'Incorrect password');
  assert.equal(env.els.authGateError.classList.contains('hidden'), false);
  assert.equal(env.input.value, '');
  env.input.value = RIGHT;
  await env.submit();
  assert.equal(await env.open, true);
  assert.deepEqual(env.logins, ['nope', RIGHT]);
});

test('typing again hides the old message', async () => {
  const env = makeEnv();
  await shown(env);
  env.input.value = 'nope';
  await env.submit();
  env.input.value = 'n';
  env.input.fire('input');
  assert.equal(env.els.authGateError.classList.contains('hidden'), true);
});

test('Enter while a silent try is still being answered waits for it instead of asking twice', async () => {
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  const env = makeEnv({ hold });
  await shown(env);
  env.input.value = RIGHT;
  env.input.fire('input');
  env.pause(); // the pause passes: the silent try is now asking, and the server is holding its answer
  await settle();
  assert.deepEqual(env.logins, [RIGHT]);
  let submitted = false;
  const submit = env.submit().then(() => { submitted = true; });
  await settle();
  assert.equal(submitted, false, 'Enter waits for the try in flight');
  release();
  await submit;
  assert.equal(await env.open, true);
  assert.equal(env.logins.length, 1, 'one request served both');
});

test('silent tries are capped, and stop for good when the server says to slow down', async () => {
  const capped = makeEnv();
  await shown(capped);
  for (let n = 0; n < 15; n += 1) await capped.type(`guess ${n}`);
  assert.equal(capped.logins.length, 10);
  capped.input.value = RIGHT;
  await capped.submit();
  assert.equal(await capped.open, true, 'Enter still works after the cap');

  const limited = makeEnv({ serverAnswer: () => 'slow-down' });
  await shown(limited);
  await limited.type('a');
  await limited.type('b');
  assert.equal(limited.logins.length, 1, 'no more silent tries after a 429');
});

test('the one network call that is not JSON or a failed fetch is treated as a wrong answer, never a crash', async () => {
  const env = makeEnv({ serverAnswer: () => { throw new Error('offline'); } });
  await shown(env);
  await env.type('whatever');
  assert.equal(env.els.authGateError.classList.contains('hidden'), true);
  env.input.value = 'x';
  await env.submit();
  assert.equal(env.els.authGateError.textContent, 'offline');
});

test('the lock screen has no button: only the text box, and Enter and the silent try are the ways in', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
  const form = /<form id="authGateForm"[\s\S]*?<\/form>/.exec(html);
  assert.ok(form, 'the form is in the page');
  assert.doesNotMatch(form[0], /<button|type="submit"|authGateSubmitBtn/, 'no button inside the lock screen');
  assert.match(form[0], /<input type="password" id="authGatePasswordInput"/);
  const env = makeEnv();
  await shown(env);
  env.input.value = RIGHT;
  await env.submit();
  assert.equal(await env.open, true, 'Enter opens it without any button');
});

test('a button added by a skin still works: it is disabled while a try runs and enabled again after a wrong answer', async () => {
  const env = makeEnv({ withButton: true });
  await shown(env);
  env.input.value = 'nope';
  await env.submit();
  assert.equal(env.els.authGateSubmitBtn.disabled, false);
  assert.equal(env.els.authGateError.textContent, 'Incorrect password');
});
