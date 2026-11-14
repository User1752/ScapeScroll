'use strict';

/**
 * Builds the standalone general-audience executable.
 *
 * The packaged .exe bundles every .js file in data/sources/ at build time
 * (package.json `pkg.scripts`). That folder is git-ignored and is YOUR local
 * collection — it routinely holds sources you never want shipped — so a plain
 * `pkg .` run from a working copy bundles whatever happens to be lying there
 * (and a build from a fresh clone bundles nothing at all). This script makes
 * the result independent of both:
 *
 *   1. exports the tracked files of a git ref (default `main`) into a
 *      throwaway folder, so what is built is that branch, not whatever the
 *      working copy has checked out;
 *   2. copies into it ONLY the sources named in build-assets/light-sources.json
 *      (read from the same ref) out of data/sources/;
 *   3. installs production dependencies there and runs pkg on that folder.
 *
 * Nothing in the working copy is moved, renamed or deleted.
 *
 *   node tools/build-light.js [--ref main] [--allow-list build-assets/light-sources.json] [--sources <dir>] [--target node24-win-x64]
 *                           [--output dist/ScrollScape-win.exe] [--icon] [--keep-stage]
 *
 * The same tool builds the edition WITHOUT SOURCES: `--edition sourceless --allow-list build-assets/sourceless-sources.json` (an empty list; the only edition that
 * may have one). It writes edition.json into the folder it packages, which is what tells the app which edition it is (server/config/edition.js).
 *
 * The same tool builds the full edition: `--ref complete --allow-list build-assets/complete-sources.json`. The list is read from the ref
 * that is built, so a source that is only in the working copy (one the person generated, or keeps for themselves) can never be bundled.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const ALLOW_LIST_PATH = 'build-assets/light-sources.json';
// Any list of this folder: a name, never a path that leaves it.
const ALLOW_LIST_RE = /^build-assets\/[A-Za-z0-9._-]+\.json$/;
const SOURCE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/i;
// The editions a build can be: the code line's own, or the one with no source bundled.
const EDITIONS = Object.freeze(['standard', 'sourceless']);

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = {
    ref: 'main',
    allowList: ALLOW_LIST_PATH,
    edition: 'standard',
    sourcesDir: path.join(REPO_ROOT, 'data', 'sources'),
    target: 'node24-win-x64',
    output: path.join('dist', 'ScrollScape-win.exe'),
    icon: false,
    keepStage: false,
  };
  const takeValue = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ref') opts.ref = takeValue(i++, arg);
    else if (arg === '--allow-list') opts.allowList = takeValue(i++, arg);
    else if (arg === '--edition') opts.edition = takeValue(i++, arg);
    else if (arg === '--sources') opts.sourcesDir = path.resolve(takeValue(i++, arg));
    else if (arg === '--target') opts.target = takeValue(i++, arg);
    else if (arg === '--output') opts.output = takeValue(i++, arg);
    else if (arg === '--icon') opts.icon = true;
    else if (arg === '--keep-stage') opts.keepStage = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!ALLOW_LIST_RE.test(opts.allowList) || opts.allowList.includes('..')) throw new Error(`--allow-list must be a .json file of build-assets/, got ${JSON.stringify(opts.allowList)}`);
  if (!EDITIONS.includes(opts.edition)) throw new Error(`--edition must be one of ${EDITIONS.join(', ')}, got ${JSON.stringify(opts.edition)}`);
  return opts;
}

/**
 * Validates the allow-list file's parsed content.
 * @param {unknown} parsed
 * @param {{ allowEmpty?: boolean }} [options]   only the edition without sources may bundle none
 * @returns {string[]} unique, safe source ids
 */
function validateAllowList(parsed, { allowEmpty = false } = {}) {
  const ids = parsed && typeof parsed === 'object' ? parsed.sources : null;
  if (!Array.isArray(ids) || (ids.length === 0 && !allowEmpty)) {
    throw new Error(`${ALLOW_LIST_PATH} must contain a non-empty "sources" array`);
  }
  for (const id of ids) {
    if (typeof id !== 'string' || !SOURCE_ID_RE.test(id)) {
      throw new Error(`${ALLOW_LIST_PATH} has an invalid source id: ${JSON.stringify(id)}`);
    }
  }
  return [...new Set(ids)];
}

/**
 * Decides what to copy out of data/sources/.
 * @param {string[]} allowedIds
 * @param {string[]} entryNames names found in the sources folder (`x.js` files or `x` folders)
 * @returns {{ copy: {id: string, entry: string}[], missing: string[], leftOut: string[] }}
 */
function planSources(allowedIds, entryNames) {
  const found = new Map();
  for (const name of entryNames) {
    found.set(name.endsWith('.js') ? name.slice(0, -3) : name, name);
  }
  const copy = [];
  const missing = [];
  for (const id of allowedIds) {
    if (found.has(id)) copy.push({ id, entry: found.get(id) });
    else missing.push(id);
  }
  const allowed = new Set(allowedIds);
  const leftOut = [...found.keys()].filter((id) => !allowed.has(id)).sort();
  return { copy, missing, leftOut };
}

function findNpmCliJs() {
  const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return fs.existsSync(bundled) ? bundled : null;
}

function run(file, args, options = {}) {
  execFileSync(file, args, { stdio: 'inherit', windowsHide: true, ...options });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const output = path.resolve(REPO_ROOT, opts.output);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-light-build-'));

  try {
    console.log(`[build] exporting "${opts.ref}" to ${stage}`);
    const tarPath = path.join(stage, '_export.tar');
    run('git', ['-C', REPO_ROOT, 'archive', '--format=tar', '-o', tarPath, opts.ref]);
    // Relative name + cwd, never an absolute path: GNU tar (the one Git Bash
    // puts first on PATH) reads "C:\..." as host "C" and fails, while the
    // Windows tar accepts either — a bare file name works with both.
    run('tar', ['-xf', '_export.tar'], { cwd: stage });
    fs.rmSync(tarPath, { force: true });

    const allowed = validateAllowList(JSON.parse(fs.readFileSync(path.join(stage, opts.allowList), 'utf8')), { allowEmpty: opts.edition === 'sourceless' });
    // The edition is what the file in the folder to package says, not what the branch has: this is the one place that decides it.
    fs.writeFileSync(path.join(stage, 'edition.json'), `${JSON.stringify({ edition: opts.edition }, null, 2)}\n`);
    console.log(`[build] edition: ${opts.edition}`);
    if (!fs.existsSync(opts.sourcesDir)) {
      throw new Error(`Sources folder not found: ${opts.sourcesDir} (use --sources <dir>)`);
    }
    const plan = planSources(allowed, fs.readdirSync(opts.sourcesDir));
    if (plan.missing.length) {
      throw new Error(`These allowed sources are not in ${opts.sourcesDir}: ${plan.missing.join(', ')}. `
        + `Put their files there, or remove them from ${opts.allowList}.`);
    }

    const stageSources = path.join(stage, 'data', 'sources');
    fs.rmSync(stageSources, { recursive: true, force: true });
    fs.mkdirSync(stageSources, { recursive: true });
    for (const { entry } of plan.copy) {
      fs.cpSync(path.join(opts.sourcesDir, entry), path.join(stageSources, entry), { recursive: true });
    }

    // Defence in depth: whatever else happens above, the build folder must
    // hold exactly the allow-list and nothing more before pkg sees it.
    const staged = fs.readdirSync(stageSources).map((n) => (n.endsWith('.js') ? n.slice(0, -3) : n)).sort();
    if (staged.join(',') !== [...allowed].sort().join(',')) {
      throw new Error(`Build folder sources (${staged.join(', ')}) do not match the allow-list (${allowed.join(', ')})`);
    }
    console.log(`[build] bundling ${staged.length} sources${staged.length ? `: ${staged.join(', ')}` : ''}`);
    if (plan.leftOut.length) {
      console.log(`[build] left out of the build (in ${opts.sourcesDir} but not in the allow-list): ${plan.leftOut.join(', ')}`);
    }

    console.log('[build] installing production dependencies');
    const npmCli = findNpmCliJs();
    if (npmCli) run(process.execPath, [npmCli, 'ci', '--omit=dev', '--no-fund', '--no-audit'], { cwd: stage });
    else run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--no-fund', '--no-audit'], { cwd: stage, shell: process.platform === 'win32' });

    const pkgBin = path.join(REPO_ROOT, 'node_modules', '@yao-pkg', 'pkg', 'lib-es5', 'bin.js');
    if (!fs.existsSync(pkgBin)) throw new Error('pkg is not installed here: run `npm install` in the repo first (it is a devDependency)');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    console.log(`[build] pkg -> ${output} (${opts.target})`);
    run(process.execPath, [pkgBin, '.', '--targets', opts.target, '--output', output, '--compress', 'GZip'], {
      cwd: stage,
      env: { ...process.env, PKG_CACHE_PATH: path.join(REPO_ROOT, 'tools', 'pkg-cache') },
    });

    if (opts.icon) {
      // The repo's own copy, not the exported one: it finds resedit-cli (a
      // devDependency, absent from the production-only build folder) at a
      // fixed path relative to itself.
      console.log('[build] injecting icon');
      run(process.execPath, [path.join(REPO_ROOT, 'tools', 'set-exe-icon.js'), output], { cwd: REPO_ROOT });
    }

    const mb = (fs.statSync(output).size / 1048576).toFixed(1);
    console.log(`[build] done: ${output} (${mb} MB) - sources bundled: ${staged.length}`);
  } finally {
    if (opts.keepStage) console.log(`[build] stage kept at ${stage}`);
    else fs.rmSync(stage, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[build] FAILED: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { parseArgs, validateAllowList, planSources, ALLOW_LIST_PATH, ALLOW_LIST_RE, EDITIONS };
