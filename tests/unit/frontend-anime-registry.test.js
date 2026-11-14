'use strict';

// The watch page and Settings > Anime Sources take their list of providers from the server's registry (GET /api/anime/providers)
// and keep a copy of it for when the registry cannot be reached. The real functions of public/modules/ui-anime-test.js run here with
// the two lists around them (the file itself needs a whole page), like the other tests that read that file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');


const ANIME_FILE = path.join(__dirname, '..', '..', 'public', 'modules', 'ui-anime-test.js');
const text = fs.readFileSync(ANIME_FILE, 'utf8').replace(/\r\n/g, '\n');
const plain = (value) => JSON.parse(JSON.stringify(value));

function parts() {
  const block = /const ANIME_PROVIDERS = \[([\s\S]*?)\n\];/.exec(text);
  const apply = /function _animeApplyProviders\(providers\) \{[\s\S]*?\n\}/.exec(text);
  const load = /async function _animeLoadProviders\(\) \{[\s\S]*?\n\}/.exec(text);
  assert.ok(block && apply && load, 'the provider list, _animeApplyProviders and _animeLoadProviders are in ui-anime-test.js');
  return { block, apply: apply[0], load: load[0] };
}

// The functions over a provider list that starts as the file's own, a fetch that answers `answer`, and a counter of list syncs.
function over(answer) {
  const { apply, load } = parts();
  const calls = [];
  const context = {
    syncs: 0,
    fetch: async (url) => { calls.push(url); if (answer instanceof Error) throw answer; return answer; },
    _animeSyncProviderSelectOptions() { context.syncs += 1; },
  };
  vm.createContext(context);
  vm.runInContext(`const ANIME_PROVIDERS = [{ id: 'old', name: '1 (Old)' }]; ${apply}; ${load}; this.list = ANIME_PROVIDERS; this.apply = _animeApplyProviders; this.loadProviders = _animeLoadProviders;`, context);
  return { context, calls, current: () => plain(context.list) };
}
const reply = (body, ok = true) => ({ ok, json: async () => body });

test('the providers of the registry replace the list in place, numbered as the player always labelled them, with their own warning', async () => {
  const { context, calls, current } = over(reply({ ok: true, providers: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two', warning: 'Careful.' }, { id: 'three', name: 'Three', warning: '' }] }));
  const same = context.list;
  await context.loadProviders();
  assert.deepEqual(calls, ['/api/anime/providers']);
  assert.deepEqual(current(), [{ id: 'one', name: '1 (One)' }, { id: 'two', name: '2 (Two)', warning: 'Careful.' }, { id: 'three', name: '3 (Three)' }]);
  assert.equal(context.list, same, 'the same array: Settings reads it by name');
  assert.equal(context.syncs, 1, 'the dropdown is rebuilt from it');
});

test('a registry that cannot be reached, or answers with nothing usable, leaves the list as it was', async () => {
  for (const answer of [new Error('offline'), reply({ ok: false }), reply({ ok: true, providers: [] }), reply({ ok: true, providers: 'x' }), reply({ ok: true, providers: [null, { id: 5, name: 'Bad' }, { id: '', name: 'Empty' }] }), reply({ ok: true, providers: [{ id: 'x', name: 'X' }] }, false), { ok: true, json: async () => { throw new Error('not json'); } }]) {
    const { context, current } = over(answer);
    await context.loadProviders();
    assert.deepEqual(current(), [{ id: 'old', name: '1 (Old)' }], String(answer && answer.message));
    assert.equal(context.syncs, 0);
  }
});

test('the registry is asked for as soon as the script loads, and again when the watch page starts', () => {
  assert.match(text, /\n_animeLoadProviders\(\);\n/);
  assert.match(text, /function _initAnimeTestView\(\) \{\n {2}_animeSyncProviderSelectOptions\(\);\n {2}_animeLoadProviders\(\);/);
});
