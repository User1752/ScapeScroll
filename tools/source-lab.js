#!/usr/bin/env node
'use strict';

// source-lab: the steps of adding a source, from the command line, with no browser and no login. It is what the `add-source`
// skill (.claude/skills/add-source) drives, and it is just as usable by hand:
//
//   probe <url> [--path /x?q=a]... [--data /api/x]... [--app-fetch] [--json]
//                                           look at the site first: Cloudflare and other anti-bot services, CAPTCHAs, a login,
//                                           robots.txt, ads, an empty JS shell. Exit code 0 open, 10 needs FlareSolverr,
//                                           11 not viable, 12 unreachable. --data names the path the source reads its DATA from
//                                           (its API): asked once, because a site can open its pages to a plain request and keep
//                                           its data behind a protection of its own (then the verdict is not viable, not open).
//   check <file> [--id <id>] [--json]       what the Import tool's Check says (reads the text without running it), plus the
//                                           contract of the loaded module. Exit code 0 when it can be installed.
//   test <file|id> [--full] [--json]        the live Test against the real site (the same checklist as the button). A path
//                                           tests a file where it is; an id tests an installed source. Exit 0 when verified.
//   peek <url> [--grep <re> | --select <css> [--attr <name>]] [--limit n] [--method POST]
//                                           read a live page IN MEMORY and print only a small plain-text answer (a summary, the text
//                                           around a pattern, the values of a selector). Use this, never `curl -o` or a redirect to a
//                                           file: a page of a manga site can carry malicious JavaScript and an antivirus quarantines
//                                           it the moment it is written to disk. Nothing is ever written.
//   generate <url> [--out <file>] [--id <id>] [--no-test]
//                                           writes a source WITHOUT an AI: probe the site, name its engine, fill the template of that engine
//                                           with what was measured (name, genres, whether the text search is allowed), write it to --out
//                                           (default: the system temp folder) and run check and the live Test on it. It installs nothing.
//   install <file> [--id <id>]              puts a checked file in data/sources (the documented drop-in). It never replaces a
//                                           file that is already there and never touches data/store.json (the app may be running
//                                           and would overwrite it): it leaves a marker next to the file instead, and the app
//                                           lists the source as IMPORTED (Test and Uninstall in the Import card) when it next scans.
//   mark <id>                               the same marker for a file that is already in data/sources (one installed by an earlier
//                                           run, or written by hand). Only for files that are yours: Uninstall deletes the file.
//
// Run with the project's Node:  tools\node\node.exe tools\source-lab.js probe https://example.org
// It never starts the app or FlareSolverr: probe --app-fetch uses FlareSolverr only if it is already running.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeImportMarker } = require('../server/modules/common/import-marker');
const { parseDenylist } = require('../server/modules/source-import/site-denylist');
const { SERIOUS_RISK_IDS } = require('../server/modules/source-import/static-report');

const ROOT = path.join(__dirname, '..');
const EXIT = { open: 0, 'needs-solver': 10, 'not-viable': 11, unreachable: 12 };

// Flags that take a value, and flags that take a value and may be repeated.
const VALUE_FLAGS = new Set(['--id', '--out', '--grep', '--select', '--attr', '--limit', '--method']);
const LIST_FLAGS = new Set(['--path', '--data', '--allow-risk']);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) { flags[arg.slice(2)] = argv[i + 1]; i += 1; } else if (LIST_FLAGS.has(arg)) { const key = arg.slice(2).replace(/-(\w)/g, (_m, c) => c.toUpperCase()); (flags[key] = flags[key] || []).push(argv[i + 1]); i += 1; } else if (arg.startsWith('--')) flags[arg.slice(2)] = true; else positional.push(arg);
  }
  return { positional, flags };
}

// The domains the person added to data/site-denylist.txt (one per line) after a security product warned about them.
function extraDenylist() {
  try { return parseDenylist(fs.readFileSync(path.join(ROOT, 'data', 'site-denylist.txt'), 'utf8')); } catch (_) { return []; }
}

const out = (line = '') => process.stdout.write(`${line}\n`);
const fail = (message, code = 2) => { process.stderr.write(`${message}\n`); process.exit(code); };

// ── probe ──────────────────────────────────────────────────────────────────

const VERDICT_TEXT = {
  open: 'OPEN: the plain request gets the real pages',
  'needs-solver': 'NEEDS FLARESOLVERR: a challenge stands in front of the content',
  'not-viable': 'NOT VIABLE',
  unreachable: 'UNREACHABLE: nothing was learned about the site',
};

function printProbe(result) {
  out(`${result.input}`);
  out(`  verdict: ${VERDICT_TEXT[result.verdict]}`);
  if (result.engine) out(`  engine: ${result.engine.name} (${result.engine.confidence})`);
  out(`  ${result.requests} pages in ${(result.durationMs / 1000).toFixed(1)} s`);
  out('');
  for (const page of result.pages) {
    const s = page.signals;
    const bits = page.error ? [`ERROR ${page.error}`] : [
      String(page.status),
      s ? `challenge=${s.challenge}` : '',
      s && s.vendors.length ? `[${s.vendors.join(', ')}]` : '',
      s ? `links=${s.links}` : '',
      s && s.title ? `"${s.title.slice(0, 50)}"` : '',
      page.appFetch ? `app-fetch=${page.appFetch.ok ? 'ok' : `FAILED (${page.appFetch.message})`}` : '',
      page.chapter ? `images=${page.chapter.kind}${page.chapter.kind === 'inline' ? `(${page.chapter.real})` : ''}` : '',
      page.hotlink ? `hotlink=${page.hotlink.result}` : '',
    ].filter(Boolean);
    out(`  ${page.label.padEnd(7)} ${bits.join('  ')}${page.guessed ? '  (a guessed address: the site\'s real search may be elsewhere)' : ''}`);
    if (page.finalUrl !== page.url || page.redirects.length) out(`          -> ${page.finalUrl}`);
  }
  if (result.robots.rules) out(`  robots  ${result.robots.rules} rules for every robot${result.robots.disallowAll ? ', forbids everything' : ''}`);
  for (const c of result.robots.checked) out(`    robots.txt ${c.disallowed ? 'FORBIDS' : 'allows '} ${c.path}  (${c.label})`);
  out('');
  for (const r of result.reasons) out(`  [${r.severity.padEnd(5)}] ${r.text}`);
}

async function probeCommand({ positional, flags }) {
  if (!positional[0]) fail('usage: source-lab probe <url> [--app-fetch] [--json]');
  const { probeSite, BadUrl } = require('../server/modules/source-import/site-probe');
  const deps = { paths: [].concat(flags.path || []), dataPaths: [].concat(flags.data || []), denylist: extraDenylist() };
  const mangled = [...deps.paths, ...deps.dataPaths].find((p) => !String(p).startsWith('/'));
  if (mangled) fail(`--path and --data must start with "/" (got "${mangled}"). Git Bash rewrites arguments that start with "/": set MSYS_NO_PATHCONV=1 for this command, or run it from PowerShell.`);
  if (flags['app-fetch']) deps.appFetch = (url) => require('../server/modules/network/fetch-utils').fetchText(url, 0);
  let result;
  try { result = await probeSite(positional[0], deps); } catch (err) {
    if (err instanceof BadUrl) fail(err.message);
    throw err;
  }
  if (flags.json) out(JSON.stringify(result, null, 2)); else printProbe(result);
  return EXIT[result.verdict];
}

// ── peek ───────────────────────────────────────────────────────────────────

async function peekCommand({ positional, flags }) {
  if (!positional[0]) fail('usage: source-lab peek <url> [--grep <re> | --select <css> [--attr <name>]] [--limit n] [--method POST]');
  const { peekPage } = require('../server/modules/source-import/site-peek');
  let answer;
  try { answer = await peekPage(positional[0], { grep: flags.grep, select: flags.select, attr: flags.attr, limit: flags.limit, method: flags.method }, { denylist: extraDenylist() }); } catch (err) {
    out(`could not read it: ${String(err && err.message).slice(0, 160)}`);
    return 12;
  }
  out(`${answer.url}  (${answer.status})`);
  for (const line of answer.lines) out(`  ${line}`);
  return 0;
}

// ── the loader, configured the way server.js does, without the store ────────

function loaderOver() {
  const dataDir = path.join(ROOT, 'data');
  const sourcesDir = path.join(dataDir, 'sources');
  const loader = require('../server/sourceLoader');
  loader.configure({ sourcesDir, snapSourcesDir: sourcesDir, builtinSourcesDir: path.join(ROOT, 'sources-repo'), isPkg: false });
  return { loader, sourcesDir, dataDir };
}

function serviceOver(loader, dataDir, stagingDir) {
  const { createSourceImportService } = require('../server/modules/source-import/service');
  return createSourceImportService({
    stagingDir,
    sourcePath: loader.sourcePath,
    loadCandidateFromFile: loader.loadCandidateFromFile,
    loadSourceFromFile: loader.loadSourceFromFile,
    clearSourceCache: loader.clearSourceCache,
    // A store that is never the real one: nothing here reads or writes data/store.json.
    readStore: async () => ({ installedSources: {} }),
    writeStore: async () => {},
  });
}

function readSourceFile(file) {
  if (!file) fail('give the path of the source file');
  const full = path.resolve(file);
  if (!fs.existsSync(full)) fail(`not found: ${full}`);
  return { full, text: fs.readFileSync(full, 'utf8') };
}

// ── check ──────────────────────────────────────────────────────────────────

// "How the app will use it": what the Import card shows of meta.ui, so a declaration is read before it is trusted.
function printDeclaration(d) {
  if (!d || !d.present) { out('  meta.ui: NOT declared (the app falls back to generic filters)'); return; }
  if (!d.readable) { out(`  meta.ui: present but not readable without running it (${d.reason || 'computed'}); it is validated again when installed`); return; }
  const ui = d.ui || {};
  const f = ui.filters || {};
  const sort = Array.isArray(ui.orderBy) && ui.orderBy.length ? ui.orderBy.map((o) => o.label).join(', ') : (f.orderBy === false ? 'none' : 'the standard list');
  const real = (key) => (f[key] === false ? 'hidden' : 'offered');
  out('  meta.ui, how the app will use it:');
  out(`    sort: ${sort}`);
  out(`    filters: status ${real('publicationStatus')}, content rating ${real('contentRating')}, format ${real('format')}, genres ${f.genres === false ? 'hidden' : 'offered'}`);
  out(`    genres: ${Array.isArray(ui.genres) ? ui.genres.length : 0}${ui.nsfwGenres && ui.nsfwGenres.length ? `, ${ui.nsfwGenres.length} marked adult` : ''}${ui.adultOnly ? '; every title is adult (Hide NSFW hides the whole source)' : ''}`);
  out(`    chapter dates: ${ui.nativeDates ? 'real' : 'not declared real'}; image Referer rules: ${(d.imageReferers || []).length}`);
  for (const p of d.problems || []) out(`    [${p.level}] ${p.message}`);
}

async function checkCommand({ positional, flags }) {
  const { text } = readSourceFile(positional[0]);
  const { loader, dataDir } = loaderOver();
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-lab-'));
  const service = serviceOver(loader, dataDir, stagingDir);
  const report = await service.preview({ code: text, id: flags.id });
  let contract = null;
  if (report.canInstall) {
    const { checkSourceContract } = require('../server/modules/source-import/contract');
    try { contract = checkSourceContract(loader.loadCandidateFromFile(path.resolve(positional[0]), report.id, text), report.id); } catch (err) { contract = { ok: false, errors: [`The file could not be loaded: ${err.message}`], warnings: [] }; }
  }
  fs.rmSync(stagingDir, { recursive: true, force: true });
  const ok = report.canInstall && !!contract && contract.ok;
  if (flags.json) { out(JSON.stringify({ report, contract, ok }, null, 2)); return ok ? 0 : 1; }
  out(`${report.id || '(no id)'}  ${report.bytes} bytes, ${report.lines} lines, sha256 ${String(report.sha256).slice(0, 12)}`);
  out(`  hosts it names: ${(report.hosts || []).join(', ') || '(none)'}`);
  if (report.requires && report.requires.length) out(`  requires: ${report.requires.map((r) => `${r.specifier} (${r.kind})`).join(', ')}`);
  for (const risk of report.risks || []) out(`  risk (line ${risk.line}): ${risk.text}`);
  printDeclaration(report.declaration);
  for (const b of report.blockers || []) out(`  BLOCKER: ${b}`);
  if (contract) {
    for (const e of contract.errors) out(`  CONTRACT ERROR: ${e}`);
    for (const w of contract.warnings) out(`  contract warning: ${w}`);
  }
  out(ok ? '  -> can be installed' : '  -> cannot be installed yet');
  return ok ? 0 : 1;
}

// ── test ───────────────────────────────────────────────────────────────────

async function testCommand({ positional, flags }) {
  const target = positional[0];
  if (!target) fail('usage: source-lab test <file|id> [--full] [--json]');
  const { loader } = loaderOver();
  const sourceUi = require('../server/modules/common/source-ui');
  const { collectHostsOutsideDeclaration } = require('../server/modules/source-import/static-report');
  const isFile = /[\\/]|\.js$/i.test(target);
  let id = target;
  let loadSourceFromFile;
  if (isFile) {
    const { full, text } = readSourceFile(target);
    const mod = loader.loadCandidateFromFile(full, 'candidate', text);
    id = String(mod.meta && mod.meta.id) || path.basename(full, '.js');
    // What the loader does for an installed source: the declaration, with the hosts the code names, is registered.
    sourceUi.registerSourceUi(id, sourceUi.sanitizeSourceUi(mod.meta && mod.meta.ui, { knownHosts: collectHostsOutsideDeclaration(text) }).ui);
    loadSourceFromFile = () => mod;
  } else loadSourceFromFile = (sid) => loader.loadSourceFromFile(sid);

  const fetchUtils = require('../server/modules/network/fetch-utils');
  const { isSafeUrl } = require('../server/modules/common/sanitize');
  const { withTimeout, sleep } = require('../server/modules/common/async-utils');
  const { createLiveTest } = require('../server/modules/source-import/live-test');
  const run = createLiveTest({
    loadSourceFromFile,
    resolvePageUrl: fetchUtils.createPageUrlResolver({ isSafeUrl }).resolvePageUrl,
    fetchImage: fetchUtils.fetchImageBuffer,
    sleep,
    withTimeout,
  });
  const result = await run({ id, depth: flags.full ? 'full' : 'basic' });
  if (flags.json) { out(JSON.stringify(result, null, 2)); return result.verified ? 0 : 1; }
  out(`${id} (${result.depth}): ${result.verified ? 'VERIFIED' : 'NOT VERIFIED'}  ${result.counts.pass} passed, ${result.counts.fail} failed, ${result.counts.warn} warnings, ${result.counts.skip} not run  (${result.calls} calls, ${result.images} images, ${(result.durationMs / 1000).toFixed(1)} s)`);
  if (result.aborted) out(`  stopped early: ${result.aborted}`);
  for (const c of result.checks) out(`  ${c.status.toUpperCase().padEnd(4)} ${c.id.padEnd(26)} ${c.detail}`);
  return result.verified ? 0 : 1;
}

// ── install ────────────────────────────────────────────────────────────────

async function installCommand({ positional, flags }) {
  const { text } = readSourceFile(positional[0]);
  const { loader, dataDir, sourcesDir } = loaderOver();
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-lab-'));
  const service = serviceOver(loader, dataDir, stagingDir);
  try {
    const report = await service.preview({ code: text, id: flags.id });
    if (!report.canInstall) { for (const b of report.blockers) out(`BLOCKER: ${b}`); return 1; }
    const serious = (report.risks || []).filter((r) => SERIOUS_RISK_IDS.includes(r.id) && !(flags.allowRisk || []).includes(r.id));
    if (serious.length) {
      for (const r of serious) out(`REFUSED (line ${r.line}): the file ${r.text}. A source written for this app never needs it; a file copied from a page often has it. Read the code; if it is really needed, name it with --allow-risk ${r.id}.`);
      return 1;
    }
    if (report.existing) { out(`"${report.id}" already exists (${report.existing.reason || report.existing.state}): remove or rename it first; this command never replaces a file.`); return 1; }
    const done = await service.install({ sha256: report.sha256, id: report.id });
    const placed = path.join(sourcesDir, `${report.id}.js`);
    writeImportMarker(placed, text);
    out(`installed ${done.installed ? done.installed.id : report.id} -> ${placed}`);
    out('It is listed as an imported source the next time the app is asked for its state (reload the page); data/store.json is untouched.');
    return 0;
  } catch (err) {
    out(`NOT INSTALLED: ${err.message}`);
    for (const e of (err.data && err.data.errors) || []) out(`  ${e}`);
    return 1;
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

// ── mark ───────────────────────────────────────────────────────────────────

async function markCommand({ positional }) {
  const id = positional[0];
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) fail('usage: source-lab mark <id>');
  const file = path.join(ROOT, 'data', 'sources', `${id}.js`);
  if (!fs.existsSync(file)) fail(`not found: ${file}`);
  writeImportMarker(file, fs.readFileSync(file, 'utf8'));
  out(`${id} is marked as imported: the app lists it with Test and Uninstall the next time it is asked for its state.`);
  out('Uninstall in the app deletes data/sources/' + id + '.js (and its .bak). Only mark files that are yours.');
  return 0;
}

// ── generate ────────────────────────────────────────────────────────────────

async function generateCommand({ positional, flags }) {
  if (!positional[0]) fail('usage: source-lab generate <url> [--out <file>] [--id <id>] [--no-test]');
  const { generateFromLink } = require('../server/modules/source-import/generator/from-link');
  const result = await generateFromLink(positional[0], { id: flags.id, denylist: extraDenylist() });
  if (result.status === 'bad-url') fail(result.message);
  if (result.probe) {
    out(`1. probe: ${result.probe.verdict}${result.probe.engine ? `, engine ${result.probe.engine.name} (${result.probe.engine.confidence})` : ''}`);
    for (const r of result.probe.reasons) out(`   [${r.severity}] ${r.text}`);
  }
  if (result.status === 'refused') {
    out(`   ${result.message}`);
    if (result.stage === 'probe') return EXIT[result.probe.verdict] || 11;
    return { engine: 13, fit: 14 }[result.stage] || 11;
  }
  for (const n of result.notes) out(`   note: ${n}`);
  const target = path.resolve(flags.out || path.join(os.tmpdir(), 'source-lab', `${result.id}.js`));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, result.code);
  out(`2. generated ${result.id} ("${result.name}"): ${result.genres} genres, ${result.nsfw.length} marked adult, text search ${result.textSearch ? 'by the site' : 'by scanning the list (robots.txt forbids the search)'} -> ${target}`);
  out('3. check');
  const checked = await checkCommand({ positional: [target], flags: { id: result.id } });
  if (checked !== 0 && !String(flags.out || '').length) out('   (an existing source with this id makes check say it cannot be installed; the file itself is judged above)');
  if (flags['no-test']) return 0;
  out('4. live test');
  return testCommand({ positional: [target], flags: {} });
}

const COMMANDS = { generate: generateCommand, probe: probeCommand, peek: peekCommand, check: checkCommand, test: testCommand, install: installCommand, mark: markCommand };

async function main() {
  const [name, ...rest] = process.argv.slice(2);
  const command = COMMANDS[name];
  if (!command) fail('usage: source-lab <probe|peek|generate|check|test|install|mark> ...\n  see the header of tools/source-lab.js', 2);
  const code = await command(parseArgs(rest));
  process.exit(code);
}

if (require.main === module) {
  main().catch((err) => { process.stderr.write(`${err && err.stack ? err.stack : err}\n`); process.exit(2); });
}

module.exports = { parseArgs, EXIT };
