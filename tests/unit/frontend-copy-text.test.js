'use strict';

// "Copy Diagnostics" on a server on the home network (http://192.168.x.x:4000, a CasaOS box, a Tailscale address): the page is not a
// secure context, so navigator.clipboard does not exist and the button used to say "Failed to copy diagnostics". public/modules/utils.js
// now copies the old way (a hidden textarea and the browser's copy command) and, when even that is refused, shows the text to select.
// The real script runs in a vm sandbox with a fake document: no browser, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const MODULES_DIR = path.join(__dirname, '..', '..', 'public', 'modules');
const read = (...parts) => fs.readFileSync(path.join(MODULES_DIR, ...parts), 'utf8');

function fakeElement(tag = 'div') {
  const listeners = new Map();
  const el = {
    tag, value: '', style: {}, attrs: {}, removed: false, selected: false, focused: false, innerHTMLSet: '', children: [],
    setAttribute(name, value) { el.attrs[name] = value; },
    select() { el.selected = true; },
    setSelectionRange() {},
    focus() { el.focused = true; },
    remove() { el.removed = true; },
    appendChild(child) { el.children.push(child); },
    addEventListener(type, fn) { listeners.set(type, fn); },
    fire(type, event) { return listeners.get(type)(event); },
    querySelector(selector) { return (el.found = el.found || {})[selector] || (el.found[selector] = fakeElement(selector)); },
    set innerHTML(value) { el.innerHTMLSet = value; },
    get innerHTML() { return el.innerHTMLSet; },
  };
  return el;
}

// The utils.js script with a document that records what it is asked to do.
function load({ clipboard, secure = true, copyCommand = () => true }) {
  const created = [];
  const docListeners = new Map();
  const body = fakeElement('body');
  const document = {
    body,
    activeElement: fakeElement('button'),
    getElementById: () => null,
    createElement: (tag) => { const el = fakeElement(tag); created.push(el); return el; },
    execCommand: (name) => (name === 'copy' ? copyCommand(created[created.length - 1]) : false),
    addEventListener: (type, fn) => docListeners.set(type, fn),
    removeEventListener: (type) => docListeners.delete(type),
  };
  const context = { document, window: { isSecureContext: secure }, navigator: clipboard ? { clipboard } : {}, localStorage: { getItem: () => null, setItem() {} }, console, setTimeout };
  vm.createContext(context);
  vm.runInContext(read('utils.js'), context, { filename: 'utils.js' });
  return { context, created, body, document, docListeners };
}

test('a secure page uses the clipboard of the browser and builds nothing', async () => {
  const written = [];
  const { context, created } = load({ clipboard: { writeText: async (text) => written.push(text) } });
  assert.equal(await context.copyTextToClipboard('hello'), true);
  assert.deepEqual(written, ['hello']);
  assert.equal(created.length, 0);
});

test('a page with no clipboard (opened by the address of a server on the home network) copies with a hidden textarea', async () => {
  const { context, created, document } = load({ clipboard: null, secure: false });
  const before = document.activeElement;
  assert.equal(await context.copyTextToClipboard('diagnostics {"a":1}'), true);
  assert.equal(created.length, 1);
  const area = created[0];
  assert.equal(area.tag, 'textarea');
  assert.equal(area.value, 'diagnostics {"a":1}');
  assert.equal(area.attrs.readonly, '', 'read only, so a phone keeps its keyboard down');
  assert.equal(area.selected, true);
  assert.equal(area.removed, true, 'nothing is left in the page');
  assert.equal(before.focused, true, 'and the focus goes back to where it was');
});

test('a clipboard that refuses falls back too, and a copy the browser refuses answers false instead of throwing', async () => {
  const refusing = load({ clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } });
  assert.equal(await refusing.context.copyTextToClipboard('x'), true, 'the old way worked');
  const nothing = load({ clipboard: null, secure: false, copyCommand: () => false });
  assert.equal(await nothing.context.copyTextToClipboard('x'), false);
  const throwing = load({ clipboard: null, secure: false, copyCommand: () => { throw new Error('boom'); } });
  assert.equal(await throwing.context.copyTextToClipboard('x'), false);
  assert.equal(throwing.created[0].removed, true, 'the textarea goes even when the command throws');
});

test('the text shown to select is put in with .value, never as markup, and the box closes three ways', () => {
  const hostile = '</textarea><img src=x onerror=PWN(1)>';
  const title = '<b>"Copy"</b>';
  const { context, body, docListeners } = load({ clipboard: null, secure: false });
  context.showTextToCopy(title, hostile);
  const overlay = body.children[0];
  assert.equal(overlay.className, 'modal-overlay');
  assert.ok(!overlay.innerHTMLSet.includes('<b>'), 'the title is escaped');
  assert.ok(!overlay.innerHTMLSet.includes('PWN'), 'the text is not part of the markup');
  const area = overlay.querySelector('textarea');
  assert.equal(area.value, hostile);
  assert.equal(area.selected, true);
  assert.ok(docListeners.has('keydown'));

  docListeners.get('keydown')({ key: 'a' });
  assert.equal(overlay.removed, false, 'another key does not close it');
  docListeners.get('keydown')({ key: 'Escape' });
  assert.equal(overlay.removed, true);
  assert.equal(docListeners.has('keydown'), false, 'and the listener goes with it');

  const second = load({ clipboard: null, secure: false });
  second.context.showTextToCopy('t', 'x');
  const box = second.body.children[0];
  box.fire('click', { target: {} });
  assert.equal(box.removed, false, 'a click inside the box does not close it');
  box.fire('click', { target: box });
  assert.equal(box.removed, true, 'a click outside does');
  const third = load({ clipboard: null, secure: false });
  third.context.showTextToCopy('t', 'x');
  third.body.children[0].querySelector('.btn-close-modal').fire('click', {});
  assert.equal(third.body.children[0].removed, true, 'so does the close button');
});

test('System Health and the OPDS URL use the helper, and both languages have the sentence that says what happened', () => {
  const page = read('system-health', 'system-health-page.js');
  assert.ok(!/navigator\.clipboard/.test(page), 'no direct use of the clipboard that a plain-http page does not have');
  assert.match(page, /copyTextToClipboard\(text\)/);
  assert.match(page, /showTextToCopy\(/);
  assert.ok(!/navigator\.clipboard/.test(read('ui-settings-modal.js').slice(read('ui-settings-modal.js').indexOf('btnCopyOpdsUrl'), read('ui-settings-modal.js').indexOf('btnImportMihon'))));
  for (const locale of ['en-GB', 'pt-PT']) assert.match(read('i18n', 'locales', `${locale}.js`), /"systemHealth\.copyErrorsManual": "[^"]{20,}"/);
});
