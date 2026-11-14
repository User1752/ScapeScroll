'use strict';

// The two pure checks behind the source import tool (server/modules/source-import/): the contract a candidate's
// exports have to meet, and the static report that reads a file's text without running it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkSourceContract, REQUIRED_METHODS, OPTIONAL_METHODS } = require('../../server/modules/source-import/contract');
const { analyzeSourceCode, sha256Of } = require('../../server/modules/source-import/static-report');
const { ALLOWED_METHODS } = require('../../server/modules/sources/dispatch-service');

const noop = async () => ({});
const validSource = (over = {}) => ({
  meta: { id: 'demo', name: 'Demo', version: '1.2.0', author: 'Me', ...(over.meta || {}) },
  search: noop, mangaDetails: noop, chapters: noop, pages: noop,
  ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'meta')),
});

// ── contract ────────────────────────────────────────────────────────────────

test('a source with meta and the four calls passes, and the summary says what it exports', () => {
  const verdict = checkSourceContract(validSource({ trending: noop, healthCheck: noop }), 'demo');
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.errors, []);
  assert.deepEqual(verdict.summary.methods, REQUIRED_METHODS);
  assert.deepEqual(verdict.summary.optionalMethods, ['trending', 'healthCheck']);
  assert.equal(verdict.summary.name, 'Demo');
  assert.equal(verdict.summary.version, '1.2.0');
});

test('the optional calls are the dispatcher\'s whitelist minus the required ones, plus the two probe-only ones', () => {
  assert.deepEqual([...OPTIONAL_METHODS].sort(), [...[...ALLOWED_METHODS].filter((n) => !REQUIRED_METHODS.includes(n)), 'healthCheck', 'firstPage'].sort());
  assert.ok(!OPTIONAL_METHODS.includes('search'));
});

test('anything that is not an exports object is refused without throwing', () => {
  for (const bad of [undefined, null, 'text', 5, true]) {
    const verdict = checkSourceContract(bad, 'demo');
    assert.equal(verdict.ok, false, String(bad));
    assert.equal(verdict.errors.length, 1);
  }
});

test('meta.id must exist, be a valid id and be the very text the source is installed as', () => {
  const idErrors = (meta) => checkSourceContract(validSource({ meta }), 'demo').errors;
  assert.match(idErrors({ id: undefined })[0], /meta\.id is missing/);
  assert.match(idErrors({ id: 'Demo' })[0], /must be the same text/, 'case counts');
  assert.match(idErrors({ id: 'other' })[0], /"other" but the source would be installed as "demo"/);
  assert.match(idErrors({ id: 'a b' })[0], /letters, digits/);
  assert.match(idErrors({ id: '../x' })[0], /letters, digits/);
  assert.match(idErrors({ id: 5 })[0], /meta\.id is missing/);
  assert.deepEqual(idErrors({ id: 'demo' }), []);
});

test('a missing meta, a meta that is not an object and a missing name are errors; a missing version is only a warning', () => {
  assert.match(checkSourceContract({ search: noop, mangaDetails: noop, chapters: noop, pages: noop }, 'demo').errors[0], /meta is missing/);
  for (const notAnObject of [[], 'text', 5]) {
    const verdict = checkSourceContract({ meta: notAnObject, search: noop, mangaDetails: noop, chapters: noop, pages: noop }, 'demo');
    assert.equal(verdict.ok, false);
    assert.match(verdict.errors[0], /meta is missing/);
  }
  const noName = checkSourceContract(validSource({ meta: { name: '' } }), 'demo');
  assert.equal(noName.ok, false);
  assert.match(noName.errors.join(' '), /meta\.name is missing/);
  const noVersion = checkSourceContract(validSource({ meta: { version: undefined } }), 'demo');
  assert.equal(noVersion.ok, true);
  assert.match(noVersion.warnings.join(' '), /meta\.version is missing/);
});

test('each missing required call is named; an optional export that is not a function is an error', () => {
  const missing = checkSourceContract({ meta: { id: 'demo', name: 'Demo' }, search: noop }, 'demo');
  assert.equal(missing.ok, false);
  for (const name of ['mangaDetails', 'chapters', 'pages']) assert.match(missing.errors.join(' '), new RegExp(`${name}\\(\\) is missing`));
  assert.doesNotMatch(missing.errors.join(' '), /search\(\) is missing/);
  const wrongType = checkSourceContract(validSource({ trending: 'yes', firstPage: {} }), 'demo');
  assert.equal(wrongType.ok, false);
  assert.match(wrongType.errors.join(' '), /trending is exported but is not a function/);
  assert.match(wrongType.errors.join(' '), /firstPage is exported but is not a function/);
});

test('meta flags that are not true/false and over-long text only warn, and long text is cut in the summary', () => {
  const verdict = checkSourceContract(validSource({ meta: { supportsTrending: 'no', beta: true, name: 'N'.repeat(500), icon: 42 } }), 'demo');
  assert.equal(verdict.ok, true);
  assert.match(verdict.warnings.join(' '), /meta\.supportsTrending should be true or false/);
  assert.match(verdict.warnings.join(' '), /meta\.name is very long/);
  assert.equal(verdict.summary.name.length, 200);
  assert.equal(verdict.summary.flags.beta, true);
  assert.equal(verdict.summary.icon, '42', 'a number is shown as text');
});

test('a getter that throws is reported, not thrown', () => {
  const hostile = { get meta() { throw new Error('boom'); } };
  const verdict = checkSourceContract(hostile, 'demo');
  assert.equal(verdict.ok, false);
  assert.match(verdict.errors[0], /exports could not be read: boom/);
});

// ── static report ───────────────────────────────────────────────────────────

test('the report fingerprints the exact text and counts bytes and lines', () => {
  const code = 'exports.meta = { id: "x" };\n// é\n';
  const report = analyzeSourceCode(code);
  assert.equal(report.sha256, sha256Of(code));
  assert.match(report.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.bytes, Buffer.byteLength(code, 'utf8'));
  assert.equal(report.lines, 3);
  assert.notEqual(analyzeSourceCode(code + ' ').sha256, report.sha256);
});

test('a file is parsed but never run', () => {
  delete globalThis.__SS_IMPORT_RAN__;
  const report = analyzeSourceCode('globalThis.__SS_IMPORT_RAN__ = true; exports.meta = {};');
  assert.equal(report.syntaxError, null);
  assert.equal(globalThis.__SS_IMPORT_RAN__, undefined);
});

test('a syntax error is reported with the file\'s own line number, no local path, and top-level return is still allowed', () => {
  const report = analyzeSourceCode('exports.a = 1;\nexports.b = ;\n');
  assert.ok(report.syntaxError);
  assert.equal(report.syntaxError.line, 2);
  assert.doesNotMatch(JSON.stringify(report.syntaxError), /[A-Za-z]:\\|\/home\//);
  assert.equal(analyzeSourceCode('if (!process) return;\nexports.a = 1;').syntaxError, null, 'CommonJS allows return at the top');
  assert.ok(analyzeSourceCode('exports.a = {').syntaxError);
  assert.ok(analyzeSourceCode('})(); exports.a = 1; (function(){').syntaxError, 'text cannot close the wrapper early');
});

test('requires are listed once, classified, and dynamic ones are counted', () => {
  const code = [
    "const cheerio = require('cheerio');",
    "const { fetchText } = require('../../server/modules/network/fetch-utils');",
    "const fs = require('node:fs');",
    "const again = require('cheerio');",
    "const crypto = require(\"crypto\");",
    "const sub = require('fs/promises');",
    'const dyn = require(name); const dyn2 = require(`./x${y}`);',
  ].join('\n');
  const report = analyzeSourceCode(code);
  const bySpec = Object.fromEntries(report.requires.map((r) => [r.specifier, r.kind]));
  assert.deepEqual(bySpec, {
    cheerio: 'npm',
    '../../server/modules/network/fetch-utils': 'relative',
    'node:fs': 'builtin',
    crypto: 'builtin',
    'fs/promises': 'builtin',
  });
  assert.equal(report.requires.filter((r) => r.specifier === 'cheerio').length, 1);
  assert.equal(report.requires.find((r) => r.specifier === 'cheerio').line, 1);
  assert.equal(report.dynamicRequires, 2);
});

test('hosts come from URL literals only, once each, sorted, and a template is not a host', () => {
  const code = [
    "const a = 'https://b.example.com/path?x=1';",
    'const b = "http://a.example.org";',
    "const c = 'https://b.example.com/other';",
    'const d = `https://${host}/x`;',
    "const e = 'http://localhost:4000/api';",
    '// see https://docs.example.net/guide.',
  ].join('\n');
  assert.deepEqual(analyzeSourceCode(code).hosts, ['a.example.org', 'b.example.com', 'docs.example.net']);
});

test('risky calls are flagged with a line, and a clean source has none', () => {
  const risky = [
    "const cp = require('child_process');",
    'cp.exec(cmd);',
    'eval(text);',
    "const fs = require('node:fs');",
    'const k = process.env.KEY;',
    "const store = require('../../server/store');",
    "const net = require('net');",
    'WebAssembly.instantiate(x);',
  ].join('\n');
  const ids = analyzeSourceCode(risky).risks.map((r) => r.id).sort();
  assert.deepEqual(ids, ['app-store', 'child-process', 'eval', 'filesystem', 'process-control', 'raw-network', 'wasm']);
  const child = analyzeSourceCode(risky).risks.find((r) => r.id === 'child-process');
  assert.equal(child.line, 1);
  const clean = analyzeSourceCode("const { fetchText } = require('../../server/modules/network/fetch-utils');\nexports.meta = { id: 'x' };");
  assert.deepEqual(clean.risks, []);
  assert.equal(clean.syntaxError, null);
});

test('a very long line of slashes and quotes does not stall the analysis', () => {
  const started = Date.now();
  analyzeSourceCode(`require('${'/'.repeat(100000)}`);
  analyzeSourceCode('http://' + 'a'.repeat(100000));
  analyzeSourceCode('"'.repeat(100000));
  assert.ok(Date.now() - started < 3000);
});
