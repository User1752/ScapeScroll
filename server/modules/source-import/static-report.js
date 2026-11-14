'use strict';

const nodeCrypto = require('crypto');
const vm = require('vm');
const { builtinModules } = require('module');
const { readDeclaredUiLiteral, withoutComments } = require('../common/source-ui');
const { firstAdNetworkIndex } = require('./ad-networks');

// A look at a source file WITHOUT running it: does it parse, what does it pull in, which hosts does it name, what
// looks dangerous. The report exists so a person can read what they are about to install, not to make a hostile file
// safe: the checks are plain text matches that string-building trivially gets around, and a source runs in the server
// process with full privileges once it is installed (manual-tecnico/04 and 11). It says so in the interface too.

const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '').split('/')[0]));
const REQUIRE_LITERAL = /\brequire\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\\n])*)\1\s*\)/g;
const REQUIRE_DYNAMIC = /\brequire\s*\(\s*(?![\s'"`])/g;
const URL_LITERAL = /\bhttps?:\/\/[^\s'"`)<>\\]+/gi;
const MAX_LISTED = 50;

const OBFUSCATION_RE = /\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){11,}|\\u[0-9a-f]{4}(?:\\u[0-9a-f]{4}){11,}|\b_0x[0-9a-f]{4,}\b|String\.fromCharCode\s*\((?:[^()]*,){7,}|\batob\s*\(|\bunescape\s*\(/i;
const ENCODED_BLOB_RE = /['"`][A-Za-z0-9+/=_-]{400,}['"`]/;
const BROWSER_CODE_RE = /\bdocument\.(?:write|writeln|cookie)\b|\bwindow\.(?:open|location)\b|<script\b/i;
// id -> what to look for, and the sentence the person reads. Informational only (the command line refuses the serious ones, see
// SERIOUS_RISK_IDS).
const RISK_CHECKS = Object.freeze([
  { id: 'child-process', test: /\bchild_process\b|(?<![.\w$])(?:spawn(?:Sync)?|exec(?:Sync|File)?)\s*\(/, text: 'starts other programs (child_process / spawn / exec)' },
  { id: 'eval', test: /\beval\s*\(|\bnew\s+Function\s*\(/, text: 'builds code from text (eval / new Function)' },
  { id: 'dynamic-import', test: /\bimport\s*\(/, text: 'loads code with import()' },
  { id: 'filesystem', test: /require\s*\(\s*['"`](?:node:)?fs(?:\/promises)?['"`]\s*\)/, text: 'reads or writes files (fs)' },
  { id: 'raw-network', test: /require\s*\(\s*['"`](?:node:)?(?:net|tls|dgram|http2?|https)['"`]\s*\)/, text: 'opens network connections itself instead of the shared fetch helpers' },
  { id: 'process-control', test: /\bprocess\.(?:exit|kill|binding|dlopen|chdir)\b|\bprocess\.env\b/, text: 'touches the process or its environment (process.exit / kill / env)' },
  { id: 'worker', test: /\bworker_threads\b|\bcluster\b|\bnew\s+Worker\s*\(/, text: 'starts threads or workers' },
  { id: 'vm', test: /require\s*\(\s*['"`](?:node:)?vm['"`]\s*\)/, text: 'compiles code with the vm module' },
  { id: 'app-store', test: /server[\\/]+store\b/, text: 'reads the app\'s own library store (server/store)' },
  { id: 'wasm', test: /\bWebAssembly\b/, text: 'loads WebAssembly' },
  // What a file copied from a hostile page looks like. Read on the text with its comments blanked: a comment that talks about
  // one of these is not the code doing it.
  { id: 'obfuscated', masked: true, test: OBFUSCATION_RE, text: 'is obfuscated (long runs of escaped characters, _0x names, String.fromCharCode, atob / unescape)' },
  { id: 'encoded-blob', masked: true, test: ENCODED_BLOB_RE, text: 'holds a very long encoded string (base64 or hex): code or data that cannot be read' },
  { id: 'browser-code', masked: true, test: BROWSER_CODE_RE, text: 'is browser code, not server code (document.write / document.cookie / window.open / a <script> tag)' },
  { id: 'ad-network', masked: true, find: (masked) => { const index = firstAdNetworkIndex(masked); return index >= 0 ? { index } : null; }, text: 'names an advertising or pop-under network' },
]);

// The parameters Node gives a CommonJS file's top-level function.
const MODULE_PARAMS = Object.freeze(['exports', 'require', 'module', '__filename', '__dirname']);

function sha256Of(code) {
  return nodeCrypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

function lineOf(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i += 1) if (code.charCodeAt(i) === 10) line += 1;
  return line;
}

// Compiles only: vm.compileFunction parses the text as the body of a CommonJS module function, the way Node's own
// loader does (so text that closes the function early is refused here too), and never runs it. A reported line number
// is the file's own. The file name is fixed text, never a path.
function checkSyntax(code) {
  try {
    vm.compileFunction(code, [...MODULE_PARAMS], { filename: 'source.js' });
    return null;
  } catch (err) {
    const match = /source\.js:(\d+)/.exec(String(err && err.stack));
    return { message: String(err && err.message || 'Syntax error').slice(0, 300), line: match ? Number(match[1]) : null };
  }
}

function classifyRequire(specifier) {
  if (specifier.startsWith('.')) return 'relative';
  const head = specifier.replace(/^node:/, '').split('/')[0];
  return BUILTINS.has(head) ? 'builtin' : 'npm';
}

function listRequires(code) {
  const seen = new Map();
  const distinct = new Set(); // every distinct name, so the report can say how many it did not list
  let dynamicCount = [...code.matchAll(REQUIRE_DYNAMIC)].length;
  for (const match of code.matchAll(REQUIRE_LITERAL)) {
    const specifier = match[2];
    // A template with a placeholder is built at run time, so it counts as dynamic, not as a name.
    if (match[1] === '`' && specifier.includes('${')) {
      dynamicCount += 1;
      continue;
    }
    // Only the names that will be listed pay for a line lookup (a scan from the start of the file): a file with tens of
    // thousands of distinct requires would otherwise stall the server for seconds while only MAX_LISTED are shown.
    distinct.add(specifier);
    if (seen.size < MAX_LISTED && !seen.has(specifier)) {
      seen.set(specifier, { specifier: specifier.slice(0, 200), kind: classifyRequire(specifier), line: lineOf(code, match.index) });
    }
  }
  return { requires: [...seen.values()], requiresMore: distinct.size - seen.size, dynamicRequires: dynamicCount };
}

// Every host the text names as a URL (lower case). The sanitiser of meta.ui uses it to hold a declared Referer to hosts
// the source already names; the report below lists at most MAX_LISTED of them.
function collectHosts(code) {
  const hosts = new Set();
  for (const match of code.matchAll(URL_LITERAL)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase();
      if (host && host.includes('.')) hosts.add(host);
    } catch { /* a template like https://${host}/ is not a URL: skipped */ }
  }
  return hosts;
}

// The hosts the file names OUTSIDE its own meta.ui literal. A Referer rule in the declaration is judged against this: the
// declaration cannot vouch for itself by quoting the address it asks for.
function collectHostsOutsideDeclaration(code) {
  const text = String(code);
  const found = readDeclaredUiLiteral(text);
  // Comments are blanked first: a URL in a comment is not the code naming a host.
  const bare = withoutComments(text);
  return collectHosts(found.range ? bare.slice(0, found.range[0]) + bare.slice(found.range[1]) : bare);
}

function listHosts(code) {
  const sorted = [...collectHosts(code)].sort();
  return { hosts: sorted.slice(0, MAX_LISTED), hostsMore: Math.max(0, sorted.length - MAX_LISTED) };
}

function listRisks(code) {
  const risks = [];
  let masked = null; // computed once, and only if a check asks for it
  for (const check of RISK_CHECKS) {
    const subject = check.masked ? (masked = masked === null ? withoutComments(code) : masked) : code;
    const hit = check.find ? check.find(subject) : check.test.exec(subject);
    if (hit) risks.push({ id: check.id, text: check.text, line: lineOf(code, check.find ? Math.max(0, hit.index) : hit.index) });
  }
  return risks;
}

// What a source written for this app never needs and a file copied from a hostile page often has. The card only shows them (the
// person reads and decides); tools/source-lab.js install refuses them unless the person names the id with --allow-risk.
const SERIOUS_RISK_IDS = Object.freeze(['obfuscated', 'encoded-blob', 'browser-code', 'ad-network', 'child-process', 'eval', 'raw-network', 'dynamic-import', 'vm', 'worker', 'wasm']);

/**
 * @param {string} code  the source file's text (already size-checked by the caller)
 * @returns {{ sha256: string, bytes: number, lines: number, syntaxError: object|null, requires: object[],
 *             requiresMore: number, dynamicRequires: number, hosts: string[], hostsMore: number, risks: object[] }}
 *   requires and hosts list at most MAX_LISTED names; requiresMore / hostsMore say how many distinct ones were left out.
 */
function analyzeSourceCode(code) {
  const text = String(code);
  return {
    sha256: sha256Of(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: text.split('\n').length,
    syntaxError: checkSyntax(text),
    ...listRequires(text),
    ...listHosts(text),
    risks: listRisks(text),
  };
}

// The ids the report can carry in `risks[].id`; the Settings card has a translated sentence for each (a test keeps the two lists equal).
const RISK_IDS = Object.freeze(RISK_CHECKS.map((check) => check.id));

module.exports = { analyzeSourceCode, collectHosts, collectHostsOutsideDeclaration, sha256Of, RISK_IDS, SERIOUS_RISK_IDS };
