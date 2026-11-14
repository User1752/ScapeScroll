'use strict';

// "Merge chapters": an extension that makes one chapter per picture may have a setting that joins them into long chapters. The source written for it
// turns that setting on in the person's Suwayomi-Server (the reader then does not stop after every image) and says so in the notes. Only that one
// setting is ever touched, found by what it is called and what it is; anything the server does not answer is "nothing to change".

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { findMergedChaptersPreference } = require('../../server/modules/source-catalog/engine/preferences');
const { createSuwayomiService } = require('../../server/modules/suwayomi/service');
const engineRoutes = require('../../server/routes/source-engine');

const SOURCE_ID = '6289731484943315811';
const PKG = 'eu.kanade.tachiyomi.extension.en.alpha';
const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
const closeAfter = (t, server) => t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

const pref = (type, key, title, currentValue) => ({ type, key, title, currentValue });

// ── recognising the setting ──────────────────────────────────────────────

test('the switch that joins pictures into long chapters is found by what it is and what it is called, with its position and whether it is on', () => {
  const list = [pref('ListPreference', 'RESOLUTION', 'Image resolution', '1'), pref('CheckBoxPreference', 'MERGE_CHAPTER_all', 'Merge Chapter', false), pref('ListPreference', 'SORT', 'Page Sort', 'date_oldest')];
  assert.deepEqual(findMergedChaptersPreference(list), { position: 1, enabled: false });
  assert.deepEqual(findMergedChaptersPreference([pref('SwitchPreferenceCompat', 'merge_chapters', 'Merge chapters', true)]), { position: 0, enabled: true });
  assert.deepEqual(findMergedChaptersPreference([pref('SwitchPreference', 'x', 'Join chapters together', false)]), { position: 0, enabled: false });
});

test('anything else is left alone: a setting that is not a switch, one that is not about chapters, a list that is not a list', () => {
  assert.equal(findMergedChaptersPreference([pref('ListPreference', 'MERGE_CHAPTER', 'Merge chapter', '1')]), null, 'not a switch');
  assert.equal(findMergedChaptersPreference([pref('CheckBoxPreference', 'MERGE_RESULTS', 'Merge search results', false)]), null, 'not about chapters');
  assert.equal(findMergedChaptersPreference([pref('CheckBoxPreference', 'SHOW_CHAPTER_DATES', 'Show chapter dates', false)]), null, 'not about merging');
  assert.equal(findMergedChaptersPreference([pref('CheckBoxPreference', 'MERGE_CHAPTER', 'Merge chapter', 'true')]).enabled, false, 'only the value true counts as on');
  for (const junk of [null, undefined, 'x', 5, {}, [], [null, 5, 'x', {}, { type: 'CheckBoxPreference' }]]) assert.equal(findMergedChaptersPreference(junk), null, JSON.stringify(junk));
});

// ── the Suwayomi service ─────────────────────────────────────────────────

const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
const clientWith = (answer) => {
  const calls = [];
  const service = createSuwayomiService({ readStore: async () => ({ settings: { suwayomiUrl: 'http://suwayomi.local:4567/', suwayomiUsername: 'u', suwayomiPassword: 'p' } }), fetchImpl: async (url, init) => { calls.push({ url, init }); return answer(url, init); } });
  return { service, calls };
};

test('the settings of a source come back as plain values; a server that cannot say gives none, and only a refused login is an answer of its own', async () => {
  const { service, calls } = clientWith(() => reply(200, [
    { type: 'CheckBoxPreference', props: { key: 'MERGE_CHAPTER_all', title: 'Merge Chapter', currentValue: false, summary: 'x'.repeat(500) } },
    null,
    { type: 'ListPreference', props: null },
    { type: 'T'.repeat(200), props: { key: 'k'.repeat(300), title: 'ti'.repeat(100) } },
  ]));
  const list = await service.getSourcePreferences(SOURCE_ID);
  assert.deepEqual(list[0], { type: 'CheckBoxPreference', key: 'MERGE_CHAPTER_all', title: 'Merge Chapter', currentValue: false });
  assert.equal(list.length, 4);
  assert.equal(list[3].type.length, 60);
  assert.equal(list[3].key.length, 100);
  assert.equal(calls[0].url, `http://suwayomi.local:4567/api/v1/source/${SOURCE_ID}/preferences`);
  for (const bad of ['', undefined, '../x', 'a b', '1/2']) assert.deepEqual(await service.getSourcePreferences(bad), [], String(bad));
  assert.equal(calls.length, 1, 'an id that is not digits asks nothing');
  assert.deepEqual(await clientWith(() => reply(500)).service.getSourcePreferences(SOURCE_ID), []);
  assert.deepEqual(await clientWith(() => reply(200, { not: 'a list' })).service.getSourcePreferences(SOURCE_ID), []);
  await assert.rejects(clientWith(() => reply(401)).service.getSourcePreferences(SOURCE_ID), (err) => err.statusCode === 401);
});

test('a setting is changed by its position, with the value as text, and anything that is not a position or an id asks nothing', async () => {
  const { service, calls } = clientWith(() => reply(200, {}));
  assert.equal(await service.setSourcePreference(SOURCE_ID, 1, true), true);
  assert.equal(calls[0].url, `http://suwayomi.local:4567/api/v1/source/${SOURCE_ID}/preferences`);
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { position: 1, value: 'true' });
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  for (const [id, position] of [['', 1], ['../x', 1], [SOURCE_ID, -1], [SOURCE_ID, 1.5], [SOURCE_ID, '1'], [SOURCE_ID, 500], [SOURCE_ID, null]]) await assert.rejects(service.setSourcePreference(id, position, true), (err) => err.statusCode === 400, `${id} ${position}`);
  assert.equal(calls.length, 1);
  await assert.rejects(clientWith(() => reply(500)).service.setSourcePreference(SOURCE_ID, 0, true), (err) => err.statusCode === 502 && /HTTP 500/.test(err.message));
  await assert.rejects(clientWith(() => reply(401)).service.setSourcePreference(SOURCE_ID, 0, true), (err) => err.statusCode === 401);
});

// ── the route ────────────────────────────────────────────────────────────

function fakeEngine(preferences, { failSet = false } = {}) {
  const calls = { set: [], prefs: [] };
  const suwayomi = {
    getConfig: async () => ({ baseUrl: 'http://suwayomi.local:4567' }),
    ensureExtensionStore: async () => ({ already: false }),
    installExtension: async () => ({ already: true }),
    listSources: async () => [{ id: SOURCE_ID, name: 'Alpha Scans', lang: 'en', supportsLatest: true, isNsfw: false, baseUrl: '' }],
    getSourcePreferences: async (id) => { calls.prefs.push(id); if (preferences instanceof Error) throw preferences; return preferences; },
    setSourcePreference: async (id, position, value) => { if (failSet) throw new Error('refused'); calls.set.push([id, position, value]); return true; },
  };
  const catalog = { engineSiteOf: async () => ({ pkg: PKG, sourceId: SOURCE_ID, name: 'Alpha Scans', lang: 'en', warning: 'SAFE', id: `sw-${SOURCE_ID}` }) };
  return { calls, suwayomi, catalog };
}

async function prepare(t, rig) {
  engineRoutes.configure({ suwayomi: rig.suwayomi, catalog: () => rig.catalog });
  const app = express();
  app.use(express.json());
  engineRoutes.registerSourceEngineRoutes(app);
  const server = await listen(app);
  closeAfter(t, server);
  const payload = JSON.stringify({ key: 'eu.kanade.tachiyomi.extension.en.alpha#0', acknowledge: true });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/sources/engine/prepare', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('a source whose extension can join pictures into long chapters has that turned on, for the source the server gave, and the notes say so', async (t) => {
  const rig = fakeEngine([pref('ListPreference', 'RESOLUTION', 'Image resolution', '1'), pref('CheckBoxPreference', 'MERGE_CHAPTER_all', 'Merge Chapter', false)]);
  const answer = await prepare(t, rig);
  assert.equal(answer.status, 200);
  assert.deepEqual(rig.calls.set, [[SOURCE_ID, 1, true]], 'only that setting, by its position');
  assert.ok(answer.body.notes.some((n) => /turned on in your Suwayomi-Server/.test(n)), answer.body.notes.join(' | '));
});

test('when it is already on nothing is changed, and an extension without the setting, a server that cannot list it or one that refuses the change is not an error', async (t) => {
  const on = fakeEngine([pref('CheckBoxPreference', 'MERGE_CHAPTER_all', 'Merge Chapter', true)]);
  const a = await prepare(t, on);
  assert.deepEqual(on.calls.set, []);
  assert.ok(a.body.notes.some((n) => /setting is on/.test(n)));
  const none = fakeEngine([pref('ListPreference', 'RESOLUTION', 'Image resolution', '1')]);
  const b = await prepare(t, none);
  assert.equal(b.status, 200);
  assert.deepEqual(none.calls.set, []);
  assert.ok(!b.body.notes.some((n) => /merge chapters/.test(n)));
  const down = await prepare(t, fakeEngine(new Error('older server')));
  assert.equal(down.status, 200);
  const refused = await prepare(t, fakeEngine([pref('CheckBoxPreference', 'MERGE_CHAPTER_all', 'Merge Chapter', false)], { failSet: true }));
  assert.equal(refused.status, 200);
  assert.ok(!refused.body.notes.some((n) => /merge chapters/.test(n)), 'a change that did not happen is not claimed');
});
