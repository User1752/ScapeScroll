'use strict';

// server/modules/common/settings-fields.js: the settings POST /api/settings copies from the request as they are. The table is data,
// so what is pinned here is the table itself and the one rule that applies it: a value is copied when it has the type the
// setting has, and ignored otherwise. Pure objects; no store, no route, no I/O.

const test = require('node:test');
const assert = require('node:assert/strict');

const { COMMON_SETTINGS_FIELDS, copySettingsFields } = require('../../server/modules/common/settings-fields');

test('the table names every plain setting once, with the type it has', () => {
  assert.deepEqual(COMMON_SETTINGS_FIELDS.map(([key]) => key), [
    'flaresolverrUrl', 'proxyUrl', 'proxyUsername', 'proxyPassword', 'comicVineApiKey',
    'suwayomiUrl', 'suwayomiUsername', 'suwayomiPassword', 'discordRichPresenceEnabled', 'discordClientId', 'allowRemoteImport',
  ]);
  assert.equal(COMMON_SETTINGS_FIELDS.find(([key]) => key === 'allowRemoteImport')[1], 'boolean', 'the switch is a real true/false: the text "true" does not turn it on');
  assert.equal(new Set(COMMON_SETTINGS_FIELDS.map(([key]) => key)).size, COMMON_SETTINGS_FIELDS.length, 'no key twice');
  for (const [key, type] of COMMON_SETTINGS_FIELDS) {
    assert.ok(type === 'string' || type === 'boolean', `${key} is a ${type}`);
  }
  assert.equal(COMMON_SETTINGS_FIELDS.find(([key]) => key === 'discordRichPresenceEnabled')[1], 'boolean');
  assert.equal(Object.isFrozen(COMMON_SETTINGS_FIELDS), true, 'a table other code relies on is not edited by it');
});

test('a value of the right type is copied, including the empty string and false: clearing a setting is saving it', () => {
  const settings = { proxyUrl: 'http://old.example:1', discordRichPresenceEnabled: true };
  const returned = copySettingsFields(settings, { proxyUrl: '', flaresolverrUrl: 'http://127.0.0.1:8191/v1', discordRichPresenceEnabled: false });
  assert.equal(returned, settings, 'the settings object it was given');
  assert.deepEqual(settings, { proxyUrl: '', flaresolverrUrl: 'http://127.0.0.1:8191/v1', discordRichPresenceEnabled: false });
});

test('a value of another type, a key that is not there and a key nobody knows change nothing', () => {
  const settings = { proxyUrl: 'kept', discordRichPresenceEnabled: true };
  copySettingsFields(settings, {
    proxyUrl: 5, proxyUsername: null, proxyPassword: ['x'], comicVineApiKey: { k: 1 }, discordClientId: undefined, discordRichPresenceEnabled: 'false', notASetting: 'x',
  });
  assert.deepEqual(settings, { proxyUrl: 'kept', discordRichPresenceEnabled: true });
});

test('what is not an object of updates changes nothing and never throws', () => {
  for (const updates of [undefined, null, 'proxyUrl', 5, true]) {
    const settings = { proxyUrl: 'kept' };
    assert.doesNotThrow(() => copySettingsFields(settings, updates), String(updates));
    assert.deepEqual(settings, { proxyUrl: 'kept' });
  }
  const settings = {};
  copySettingsFields(settings, ['proxyUrl']);
  assert.deepEqual(settings, {}, 'an array is no object of updates');
});

test('only the keys of the table are ever written, so a hostile body cannot reach the prototype', () => {
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":"x","prototype":"y","proxyUrl":"http://ok.example"}');
  const settings = {};
  copySettingsFields(settings, hostile);
  assert.deepEqual(Object.keys(settings), ['proxyUrl']);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(settings), Object.prototype);
});

test('a table of the edition\'s own can be laid over the common one, in the order given', () => {
  const settings = {};
  copySettingsFields(settings, { alpha: 'a', beta: true, proxyUrl: 'p' }, [...COMMON_SETTINGS_FIELDS, ['alpha', 'string'], ['beta', 'boolean']]);
  assert.deepEqual(settings, { proxyUrl: 'p', alpha: 'a', beta: true });
  const only = {};
  copySettingsFields(only, { alpha: 'a', proxyUrl: 'p' }, [['alpha', 'string']]);
  assert.deepEqual(only, { alpha: 'a' }, 'a table of its own replaces the common one');
});

// The 'idList' type (the disabled sources list): an update is copied only when the whole list is a valid one.
const ID_TABLE = [['ids', 'idList'], ['label', 'string']];

test('an idList is copied as the cleaned list: de-duplicated, in order, and not the array the request carried', () => {
  const settings = {};
  const sent = ['beta', 'alpha', 'beta'];
  copySettingsFields(settings, { ids: sent }, ID_TABLE);
  assert.deepEqual(settings.ids, ['beta', 'alpha']);
  assert.notEqual(settings.ids, sent);
  sent.push('late');
  assert.deepEqual(settings.ids, ['beta', 'alpha'], 'a request object is not kept by the settings');
});

test('an empty list clears an idList: [] is saved, not ignored', () => {
  const settings = { ids: ['alpha', 'beta'] };
  copySettingsFields(settings, { ids: [] }, ID_TABLE);
  assert.deepEqual(settings.ids, []);
});

test('an idList with one bad entry, a list over the cap or a value that is no list changes nothing: all or nothing', () => {
  const tooLong = Array.from({ length: 10_000 }, (_, i) => `s${i}`);
  const refused = [
    ['alpha', 5], ['alpha', null], ['alpha', 'two words'], ['alpha', ''], ['alpha', {}], ['alpha', '__proto__'], ['alpha', 'x'.repeat(5000)],
    tooLong, 'alpha', 5, null, true, { 0: 'alpha', length: 1 }, JSON.parse('{"__proto__":["alpha"]}'), undefined,
  ];
  for (const ids of refused) {
    const settings = { ids: ['kept'] };
    copySettingsFields(settings, { ids }, ID_TABLE);
    assert.deepEqual(settings.ids, ['kept'], JSON.stringify(ids)?.slice(0, 60));
  }
  const fresh = {};
  copySettingsFields(fresh, { ids: ['alpha', 5] }, ID_TABLE);
  assert.equal('ids' in fresh, false, 'a refused list does not even create the key');
});

test('a refused idList does not stop the other keys of the same update from being copied', () => {
  const settings = { ids: ['kept'] };
  copySettingsFields(settings, { ids: ['alpha', 5], label: 'new' }, ID_TABLE);
  assert.deepEqual(settings, { ids: ['kept'], label: 'new' });
});

test('the string and boolean rules are unchanged next to an idList', () => {
  const settings = { label: 'old', ids: ['a'] };
  copySettingsFields(settings, { label: '', ids: [] }, ID_TABLE);
  assert.deepEqual(settings, { label: '', ids: [] });
  copySettingsFields(settings, { label: 5 }, ID_TABLE);
  assert.equal(settings.label, '', 'a number where a string belongs is still ignored');
});
