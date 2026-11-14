'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, validateAllowList, planSources, ALLOW_LIST_PATH } = require('../../tools/build-light');

test('the committed allow-list is valid and lists only plain source ids', () => {
  const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', ALLOW_LIST_PATH), 'utf8'));
  const ids = validateAllowList(parsed);
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
});

test('validateAllowList rejects anything that is not a non-empty array of safe ids', () => {
  for (const bad of [null, undefined, {}, { sources: [] }, { sources: 'mangadex' }, { sources: [''] }, { sources: ['../x'] }, { sources: ['a/b'] }, { sources: ['x.js'] }, { sources: [1] }]) {
    assert.throws(() => validateAllowList(bad), undefined, JSON.stringify(bad));
  }
});

test('only the edition without sources may bundle none: an empty list is refused unless asked for', () => {
  assert.throws(() => validateAllowList({ sources: [] }), /non-empty/);
  assert.throws(() => validateAllowList({ sources: [] }, { allowEmpty: false }), /non-empty/);
  assert.deepEqual(validateAllowList({ sources: [] }, { allowEmpty: true }), []);
  for (const bad of [null, {}, { sources: 'x' }, { sources: ['../x'] }]) assert.throws(() => validateAllowList(bad, { allowEmpty: true }), undefined, `a bad list is bad even when empty is allowed: ${JSON.stringify(bad)}`);
  const listed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'build-assets', 'sourceless-sources.json'), 'utf8'));
  assert.deepEqual(validateAllowList(listed, { allowEmpty: true }), [], 'the committed list of that edition is empty');
  assert.ok(parseArgs(['--edition', 'sourceless', '--allow-list', 'build-assets/sourceless-sources.json']).edition === 'sourceless');
});

test('parseArgs knows two editions, standard by default, and refuses any other name', () => {
  assert.equal(parseArgs([]).edition, 'standard');
  assert.equal(parseArgs(['--edition', 'standard']).edition, 'standard');
  for (const bad of ['', 'complete', 'Sourceless ', '../x', 'sourceless;']) assert.throws(() => parseArgs(['--edition', bad]), /--edition must be one of/, JSON.stringify(bad));
  assert.throws(() => parseArgs(['--edition']), /needs a value/);
});

test('the build writes edition.json into the folder it packages, and package.json bundles that file', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'build-light.js'), 'utf8');
  assert.match(source, /fs\.writeFileSync\(path\.join\(stage, 'edition\.json'\)/);
  assert.match(source, /allowEmpty: opts\.edition === 'sourceless'/);
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.ok(pkg.pkg.assets.includes('edition.json'));
  const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'edition.json'), 'utf8'));
  assert.equal(committed.edition, 'standard', 'the file in the repository says standard: only a build makes another edition');
});

test('validateAllowList de-duplicates', () => {
  assert.deepEqual(validateAllowList({ sources: ['a', 'b', 'a'] }), ['a', 'b']);
});

test('planSources copies only allowed ids and reports what it left out', () => {
  const plan = planSources(['alpha', 'beta'], ['alpha.js', 'beta.js', 'gamma.js', 'delta']);
  assert.deepEqual(plan.copy.map((c) => c.entry), ['alpha.js', 'beta.js']);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.leftOut, ['delta', 'gamma']);
});

test('planSources reports allowed ids that are not on disk', () => {
  const plan = planSources(['alpha', 'beta'], ['alpha.js']);
  assert.deepEqual(plan.missing, ['beta']);
});

test('planSources handles subfolder-layout sources and never copies a non-listed folder', () => {
  const plan = planSources(['alpha'], ['alpha', 'other']);
  assert.deepEqual(plan.copy, [{ id: 'alpha', entry: 'alpha' }]);
  assert.deepEqual(plan.leftOut, ['other']);
});

test('parseArgs defaults to building the main ref for win x64', () => {
  const opts = parseArgs([]);
  assert.equal(opts.ref, 'main');
  assert.equal(opts.target, 'node24-win-x64');
  assert.equal(opts.icon, false);
  assert.equal(opts.keepStage, false);
});

test('parseArgs takes a list of the build-assets folder and refuses any other path', () => {
  assert.equal(parseArgs([]).allowList, 'build-assets/light-sources.json');
  assert.equal(parseArgs(['--allow-list', 'build-assets/sourceless-sources.json']).allowList, 'build-assets/sourceless-sources.json');
  for (const bad of ['../x.json', 'build-assets/../x.json', '/etc/passwd', 'build-assets/sub/x.json', 'build-assets/x.txt', 'other/x.json', '', 'build-assets/x.json ']) {
    assert.throws(() => parseArgs(['--allow-list', bad]), /--allow-list must be/, JSON.stringify(bad));
  }
});

test('parseArgs reads every option and rejects unknown ones or a missing value', () => {
  const opts = parseArgs(['--ref', 'v1', '--target', 'node24-linux-x64', '--output', 'dist/x', '--icon', '--keep-stage']);
  assert.equal(opts.ref, 'v1');
  assert.equal(opts.target, 'node24-linux-x64');
  assert.equal(opts.output, 'dist/x');
  assert.equal(opts.icon, true);
  assert.equal(opts.keepStage, true);
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['--ref']), /needs a value/);
});
