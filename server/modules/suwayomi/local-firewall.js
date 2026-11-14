'use strict';

// Windows Firewall rules for the Suwayomi-Server that runs on this computer: it can reach the internet but not the other devices of the home network, so an
// extension (a program from a third party, which runs inside that server) cannot go looking around the network. Adding or removing a rule needs
// administrator rights, so that part is a small script that runs after a Windows prompt; asking whether the rules are there needs none.

const fs = require('fs');
const path = require('path');
const config = require('../../config/suwayomi-local');

const failure = (message, statusCode = 500) => Object.assign(new Error(message), { statusCode });
const quoted = (text) => `'${String(text).replace(/'/g, "''")}'`;

/** The text of the script that makes (or only removes) the rules for these programs. The program paths go in as quoted text, never as code. */
function rulesScript(action, programs) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `Get-NetFirewallRule -DisplayName ${quoted(config.firewallRuleName)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
  ];
  if (action === 'add') {
    const ranges = config.blockedRanges.map(quoted).join(',');
    for (const program of programs) {
      lines.push(`New-NetFirewallRule -DisplayName ${quoted(config.firewallRuleName)} -Direction Outbound -Action Block -Program ${quoted(program)} -RemoteAddress ${ranges} -Profile Any | Out-Null`);
    }
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * @param {object} deps
 * @param {(file: string, args: string[], options: object) => Promise<{ stdout: string }>} [deps.execFileImpl]   runs a program and gives what it printed
 * @param {(file: string, args: string[], options: object) => Promise<number>} [deps.runElevated]   runs a program and gives its exit code
 * @param {string} [deps.platform]
 */
function createFirewall(deps = {}) {
  const {
    platform = process.platform,
    execFileImpl = (file, args, options) => new Promise((resolve, reject) => {
      require('child_process').execFile(file, args, { windowsHide: true, timeout: 10_000, ...options }, (err, stdout) => (err && !stdout ? reject(err) : resolve({ stdout: String(stdout || '') })));
    }),
    runElevated = (file, args, options) => new Promise((resolve) => {
      const proc = require('child_process').spawn(file, args, { windowsHide: true, stdio: 'ignore', ...options });
      proc.once('error', () => resolve(1));
      proc.once('exit', (code) => resolve(code === null ? 1 : code));
    }),
  } = deps;

  /** Whether the rules are there. null when this cannot be asked (not Windows). Needs no administrator rights. */
  async function status() {
    if (platform !== 'win32') return null;
    try {
      const { stdout } = await execFileImpl('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${config.firewallRuleName}`], {});
      return !/No rules match/i.test(stdout) && stdout.includes(config.firewallRuleName);
    } catch (_) {
      return false;
    }
  }

  /**
   * Adds or removes the rules. Windows asks the person for permission; a refusal is an answer, not a crash.
   * @param {'add'|'remove'} action
   * @param {{ root: string, programs: string[] }} where   the Suwayomi folder (the script is written there) and the programs the rules are for
   * @returns {Promise<{ ok: boolean }>}
   */
  async function apply(action, { root, programs }) {
    if (platform !== 'win32') throw failure('Firewall rules are only available on Windows.', 409);
    if (action !== 'add' && action !== 'remove') throw failure('That is not something to do with the firewall rules.', 400);
    if (action === 'add' && !programs.length) throw failure('Suwayomi is not set up here yet.', 409);
    const script = path.join(root, 'firewall-rules.ps1');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(script, rulesScript(action, programs));
    // The script's own path travels in the environment, never inside the command text, so a folder name cannot change the command.
    const command = "$p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',('\"' + $env:SCROLLSCAPE_FIREWALL_SCRIPT + '\"'); exit $p.ExitCode";
    const code = await runElevated('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { env: { ...process.env, SCROLLSCAPE_FIREWALL_SCRIPT: script } });
    return { ok: code === 0 && (await status()) === (action === 'add') };
  }

  return { status, apply };
}

module.exports = { createFirewall, rulesScript };
