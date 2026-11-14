'use strict';

// FlareSolverr helper for Launch-ScrollScape.bat. Source (non-packaged) runs only.
//
//   node install_flaresolverr.js                    download FlareSolverr into tools\flaresolverr
//   node install_flaresolverr.js --choice           print the saved answer: install | skip | none | invalid
//   node install_flaresolverr.js --save install|skip   remember the answer
//
// Downloading is something the launcher only does after the user said yes (it
// asks, and remembers the answer in data\setup.json). The answer is read and
// written here, through the same module the server uses, so the .bat does not
// carry its own copy of the file format. The download itself is the server's
// installFlaresolverr(): one implementation, one place to keep safe.

const prefix = '  \x1b[96m[ .. ]\x1b[0m ';
const errPrefix = '  \x1b[91m[ ERR ]\x1b[0m ';

/** @returns {Promise<number>} the process exit code */
async function run(args, {
  root = __dirname,
  runLauncherCommand = (...a) => require('./server/modules/network/flaresolverr-choice').runLauncherCommand(...a),
  install = () => require('./server/modules/network/flaresolverr-lifecycle').installFlaresolverr(),
  log = console.log,
  error = console.error,
} = {}) {
  if (args[0] === '--choice' || args[0] === '--save') return runLauncherCommand(args, { root });
  // A 700MB download only starts from a bare invocation. A typo such as '--chioce' (or any other
  // argument) used to count as "download" too; refuse it instead of fetching something unasked.
  if (args.length > 0) {
    error(`${errPrefix}Unknown argument: ${args.join(' ')}. Use no argument to download, --choice, or --save install|skip.`);
    return 2;
  }
  log(`${prefix}Fetching latest release...`);
  try {
    const exePath = await install();
    log(`${prefix}\x1b[92m[ OK ]\x1b[0m Successfully installed ${exePath}`);
    return 0;
  } catch (err) {
    error(`${errPrefix}Error during download/extract: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { run };
