'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { PassThrough } = require('node:stream');

const {
  readChoice,
  readSetupState,
  normalizeChoice,
  writeChoice,
  parseAnswer,
  askChoice,
  setupPath,
  runLauncherCommand,
} = require('../../server/modules/network/flaresolverr-choice');

// An in-memory file system with just the calls the module makes. Values may be
// strings or Buffers (to exercise byte-order marks); a missing file throws the
// way Node does.
function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const fsImpl = {
    files,
    readFileSync: (p) => {
      if (!files.has(p)) throw Object.assign(new Error(`ENOENT: no such file ${p}`), { code: 'ENOENT' });
      return files.get(p);
    },
    writeFileSync: (p, text) => { files.set(p, text); },
    mkdirSync: () => {},
    renameSync: (from, to) => {
      if (!files.has(from)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      files.set(to, files.get(from));
      files.delete(from);
    },
    copyFileSync: (from, to) => { files.set(to, files.get(from)); },
    rmSync: (p) => { files.delete(p); },
  };
  return fsImpl;
}

const ROOT = path.join('C:', 'app');
const FILE = setupPath(ROOT);

test('parseAnswer: yes installs, an explicit no skips for good, a bare Enter means "not now"', () => {
  for (const yes of ['y', 'Y', 'yes', 's', 'S', 'sim', ' Sim ']) assert.equal(parseAnswer(yes), 'install', yes);
  for (const no of ['n', 'N', 'no', 'nao', 'não']) assert.equal(parseAnswer(no), 'skip', no);
  for (const blank of ['', '  ']) assert.equal(parseAnswer(blank), 'later', JSON.stringify(blank));
  for (const unclear of ['maybe', 'ye', '1']) assert.equal(parseAnswer(unclear), undefined, unclear);
  assert.equal(parseAnswer(undefined), 'later');
});

test('the saved choice round-trips and bad files read as "no choice"', () => {
  const fsImpl = memoryFs();
  assert.equal(readChoice(ROOT, fsImpl), null);
  writeChoice(ROOT, 'install', fsImpl);
  assert.equal(readChoice(ROOT, fsImpl), 'install');
  writeChoice(ROOT, 'skip', fsImpl);
  assert.equal(readChoice(ROOT, fsImpl), 'skip');
  for (const bad of ['', 'not json', '[]', '{"flaresolverr":"maybe"}', 'null']) {
    assert.equal(readChoice(ROOT, memoryFs({ [FILE]: bad })), null, bad);
  }
});

test('setup.json is read leniently: BOMs, any case, and the spellings people actually type', () => {
  const read = (text) => readSetupState(ROOT, memoryFs({ [FILE]: text }));

  // A byte-order mark from Set-Content -Encoding UTF8 / an editor (as text or as bytes), or PowerShell's UTF-16LE.
  assert.equal(read('\uFEFF{"flaresolverr":"skip"}').choice, 'skip');
  assert.equal(read(Buffer.from('\uFEFF{"flaresolverr":"skip"}', 'utf8')).choice, 'skip');
  assert.equal(read(Buffer.from('\uFEFF{"flaresolverr":"install"}', 'utf16le')).choice, 'install');
  assert.equal(read(Buffer.from('{"flaresolverr":"skip"}', 'utf8')).choice, 'skip');

  for (const skip of ['skip', 'Skip', 'SKIP', 'no', 'No', 'n', 'nao', 'não', 'false', 'off', ' skip ']) {
    assert.equal(read(JSON.stringify({ flaresolverr: skip })).choice, 'skip', skip);
  }
  for (const install of ['install', 'Install', 'yes', 'YES', 'y', 's', 'sim', 'true', 'on', ' sim ']) {
    assert.equal(read(JSON.stringify({ flaresolverr: install })).choice, 'install', install);
  }
  assert.equal(read('{"flaresolverr":false}').choice, 'skip');
  assert.equal(read('{"flaresolverr":true}').choice, 'install');
  assert.equal(normalizeChoice('maybe'), null);
  assert.equal(normalizeChoice(1), null);
  assert.equal(normalizeChoice(undefined), null);
});

test('setup.json that exists but cannot be understood is "invalid", not "no answer"', () => {
  const missing = readSetupState(ROOT, memoryFs());
  assert.deepEqual([missing.status, missing.choice], ['missing', null]);

  const noKey = readSetupState(ROOT, memoryFs({ [FILE]: '{"other":1}' }));
  assert.deepEqual([noKey.status, noKey.choice], ['ok', null], 'a file with no answer in it is just unanswered');
  for (const empty of ['{"flaresolverr":null}', '{"flaresolverr":""}']) {
    assert.equal(readSetupState(ROOT, memoryFs({ [FILE]: empty })).status, 'ok', empty);
  }

  const cases = {
    '': /not valid JSON/,
    'not json': /not valid JSON/,
    '{"flaresolverr":"skip"': /not valid JSON/, // truncated by a crash
    '[]': /must hold a JSON object/,
    'null': /must hold a JSON object/,
    '"skip"': /must hold a JSON object/,
    '{"flaresolverr":"skpi"}': /expected "install" or "skip"/, // a typo must not read as "never answered"
    '{"flaresolverr":7}': /expected "install" or "skip"/,
  };
  for (const [text, reason] of Object.entries(cases)) {
    const state = readSetupState(ROOT, memoryFs({ [FILE]: text }));
    assert.equal(state.status, 'invalid', JSON.stringify(text));
    assert.equal(state.choice, null, JSON.stringify(text));
    assert.match(state.reason, reason, JSON.stringify(text));
  }

  const denied = memoryFs();
  denied.readFileSync = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
  const state = readSetupState(ROOT, denied);
  assert.equal(state.status, 'invalid');
  assert.match(state.reason, /cannot be read.*EACCES/);
});

test('saving a choice keeps other settings in the same file', () => {
  const fsImpl = memoryFs({ [FILE]: JSON.stringify({ other: 1 }) });
  assert.equal(writeChoice(ROOT, 'skip', fsImpl), true);
  assert.deepEqual(JSON.parse(fsImpl.files.get(FILE)), { other: 1, flaresolverr: 'skip' });
});

test('saving goes through a temporary file renamed into place, so the real file is never half written', () => {
  const fsImpl = memoryFs({ [FILE]: '{"flaresolverr":"skip"}' });
  const writes = [];
  const realWrite = fsImpl.writeFileSync;
  fsImpl.writeFileSync = (p, text) => { writes.push(p); realWrite(p, text); };
  assert.equal(writeChoice(ROOT, 'install', fsImpl), true);
  assert.equal(writes.length, 1);
  assert.notEqual(writes[0], FILE, 'the real file is not written to directly');
  assert.ok(writes[0].startsWith(FILE) && writes[0].endsWith('.tmp'), writes[0]);
  assert.equal(fsImpl.files.has(writes[0]), false, 'the temporary file is gone after the rename');
  assert.equal(readChoice(ROOT, fsImpl), 'install');
});

test('a save that fails midway leaves the previous answer intact and reports it', () => {
  const logs = [];
  const fsImpl = memoryFs({ [FILE]: '{"flaresolverr":"skip"}' });
  fsImpl.renameSync = () => { throw new Error('EPERM: file is locked'); };
  assert.equal(writeChoice(ROOT, 'install', fsImpl, (m) => logs.push(m)), false);
  assert.equal(readChoice(ROOT, fsImpl), 'skip', 'the saved "skip" survives a failed overwrite');
  assert.deepEqual([...fsImpl.files.keys()], [FILE], 'no temporary file left behind');
  assert.match(logs.join(' '), /EPERM.*asked again next time/);
});

test('a hand-edited file that has to be replaced is kept as setup.json.bad', () => {
  const fsImpl = memoryFs({ [FILE]: '{"flaresolverr":"skpi","note":"mine"' });
  assert.equal(writeChoice(ROOT, 'skip', fsImpl), true);
  assert.equal(fsImpl.files.get(`${FILE}.bad`), '{"flaresolverr":"skpi","note":"mine"');
  assert.equal(readChoice(ROOT, fsImpl), 'skip');

  // A parseable file with a bad answer keeps its other keys.
  const typo = memoryFs({ [FILE]: '{"flaresolverr":"skpi","note":"mine"}' });
  writeChoice(ROOT, 'skip', typo);
  assert.deepEqual(JSON.parse(typo.files.get(FILE)), { flaresolverr: 'skip', note: 'mine' });
});

test('a failed save is reported, not thrown', () => {
  const logs = [];
  const broken = {
    readFileSync: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
    mkdirSync: () => {},
    writeFileSync: () => { throw new Error('disk full'); },
    rmSync: () => {},
  };
  assert.doesNotThrow(() => writeChoice(ROOT, 'install', broken, (m) => logs.push(m)));
  assert.match(logs.join(' '), /disk full/);
});

test('saving really works on disk, creating the data folder and replacing a BOM-prefixed file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-choice-'));
  try {
    assert.equal(writeChoice(dir, 'skip'), true);
    assert.equal(readChoice(dir), 'skip');
    fs.writeFileSync(setupPath(dir), '\uFEFF{"flaresolverr":"skip"}');
    assert.equal(readChoice(dir), 'skip', 'a real file with a BOM reads as skip');
    assert.equal(writeChoice(dir, 'install'), true);
    assert.equal(readChoice(dir), 'install');
    assert.deepEqual(fs.readdirSync(path.dirname(setupPath(dir))), ['setup.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The command line Launch-ScrollScape.bat uses.
test('the launcher command prints the answer, and "invalid" with the reason on stderr', () => {
  const run = (args, files) => {
    const out = [];
    const err = [];
    const fsImpl = memoryFs(files);
    const code = runLauncherCommand(args, { root: ROOT, fsImpl, out: (m) => out.push(m), err: (m) => err.push(m) });
    return { code, out, err, fsImpl };
  };
  assert.deepEqual(run(['--choice'], {}).out, ['none']);
  assert.deepEqual(run(['--choice'], { [FILE]: '{"flaresolverr":"Skip"}' }).out, ['skip']);
  assert.deepEqual(run(['--choice'], { [FILE]: '\uFEFF{"flaresolverr":"yes"}' }).out, ['install']);
  assert.deepEqual(run(['--choice'], { [FILE]: '{"other":1}' }).out, ['none']);

  const broken = run(['--choice'], { [FILE]: '{oops' });
  assert.equal(broken.code, 0);
  assert.deepEqual(broken.out, ['invalid']);
  assert.match(broken.err.join(' '), /setup\.json is not valid JSON.*stays off until you fix or delete/);

  const saved = run(['--save', 'skip'], {});
  assert.equal(saved.code, 0);
  assert.equal(readChoice(ROOT, saved.fsImpl), 'skip');
  assert.equal(run(['--save', 'install'], { [FILE]: '{"flaresolverr":"skip"}' }).code, 0);

  for (const bad of [['--save'], ['--save', 'maybe'], ['--nope'], []]) {
    const result = run(bad, {});
    assert.equal(result.code, 2, bad.join(' '));
    assert.match(result.err.join(' '), /Usage/);
    assert.deepEqual(result.fsImpl.files.size, 0);
  }

  const failing = memoryFs();
  failing.renameSync = () => { throw new Error('locked'); };
  const errors = [];
  assert.equal(runLauncherCommand(['--save', 'skip'], { root: ROOT, fsImpl: failing, err: (m) => errors.push(m) }), 1);
  assert.match(errors.join(' '), /locked/);
});

// install_flaresolverr.js is only a thin wrapper around the above and the server's installer.
test('install_flaresolverr.js routes --choice/--save to the launcher command and installs otherwise', async () => {
  const { run } = require('../../install_flaresolverr');
  const calls = [];
  const deps = {
    root: ROOT,
    runLauncherCommand: (args, options) => { calls.push(['launcher', args, options.root]); return 0; },
    install: async () => { calls.push(['install']); return 'C:\\x\\flaresolverr.exe'; },
    log: (m) => calls.push(['log', m]),
    error: (m) => calls.push(['error', m]),
  };
  assert.equal(await run(['--choice'], deps), 0);
  assert.equal(await run(['--save', 'install'], deps), 0);
  assert.deepEqual(calls, [['launcher', ['--choice'], ROOT], ['launcher', ['--save', 'install'], ROOT]], 'nothing was installed');

  calls.length = 0;
  assert.equal(await run([], deps), 0);
  assert.deepEqual(calls.filter((c) => c[0] === 'install').length, 1);

  // A typo is not a request to download 700MB.
  calls.length = 0;
  assert.equal(await run(['--chioce'], deps), 2);
  assert.equal(await run(['--save'.slice(0, 3), 'x'], deps), 2);
  assert.equal(calls.filter((c) => c[0] === 'install').length, 0);
  assert.match(calls.find((c) => c[0] === 'error')[1], /Unknown argument/);

  calls.length = 0;
  assert.equal(await run([], { ...deps, install: async () => { throw new Error('GitHub API HTTP 403'); } }), 1);
  assert.match(calls.find((c) => c[0] === 'error')[1], /GitHub API HTTP 403/);
});

// askChoice, driven through in-memory streams.
function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  return { input, output, text: () => text };
}

const later = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('askChoice: y installs, n skips for good and says where to undo it, Enter just means not now', async () => {
  const yes = streams();
  const pending = askChoice({ input: yes.input, output: yes.output, setupFile: 'data/setup.json' });
  yes.input.write('y\n');
  assert.equal(await pending, 'install');
  assert.match(yes.text(), /Installing/);

  const no = streams();
  const second = askChoice({ input: no.input, output: no.output, setupFile: 'data/setup.json' });
  no.input.write('n\n');
  assert.equal(await second, 'skip');
  assert.match(no.text(), /setup\.json/);

  // A stray Enter must not be remembered as "never": nothing is saved, and it is asked again next launch.
  const notNow = streams();
  const third = askChoice({ input: notNow.input, output: notNow.output });
  notNow.input.write('\n');
  assert.equal(await third, null);
  assert.match(notNow.text(), /asked again next launch/);
});

test('askChoice: an unclear answer is asked again, and three of them save nothing', async () => {
  const ok = streams();
  const first = askChoice({ input: ok.input, output: ok.output });
  ok.input.write('maybe\nsim\n');
  assert.equal(await first, 'install');
  assert.match(ok.text(), /Not understood/);

  const bad = streams();
  const second = askChoice({ input: bad.input, output: bad.output });
  bad.input.write('a\nb\nc\n');
  assert.equal(await second, null);
});

test('askChoice: no answer in time, or the input closing, resolves null without keeping the process alive', async () => {
  const slow = streams();
  assert.equal(await askChoice({ input: slow.input, output: slow.output, timeoutMs: 20 }), null);
  assert.match(slow.text(), /asked again next launch/);

  const closed = streams();
  const pending = askChoice({ input: closed.input, output: closed.output });
  closed.input.end();
  assert.equal(await pending, null);
});

test('askChoice: keys already waiting in the buffer are not taken as the answer', async () => {
  // An Enter or a "y" pressed while the exe was still unpacking.
  const s = streams();
  s.input.write('\n');
  s.input.write('y\n');
  const pending = askChoice({ input: s.input, output: s.output, setupFile: 'data/setup.json' });
  await later(30);
  assert.match(s.text(), /Install it\?/, 'the question was shown');
  assert.doesNotMatch(s.text(), /Installing|Not now/, 'the stale keys answered nothing');
  s.input.write('n\n');
  assert.equal(await pending, 'skip');
});

test('askChoice: on a real console, type-ahead that arrives during the settle window is thrown away too', async () => {
  const s = streams();
  s.input.isTTY = true; // makes it wait for late type-ahead, like a console would
  const pending = askChoice({ input: s.input, output: s.output, drainMs: 60 });
  await later(10);
  s.input.write('y\n'); // still inside the window: stale
  await later(120);
  assert.match(s.text(), /Install it\?/);
  assert.doesNotMatch(s.text(), /Installing/);
  s.input.write('n\n');
  assert.equal(await pending, 'skip');
});

test('askChoice: every key press gives the person the full time again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = streams();
  const pending = askChoice({ input: s.input, output: s.output, timeoutMs: 1000 });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();

  t.mock.timers.tick(900);
  s.input.write('y'); // typing, no Enter yet: the clock starts over
  await settle();
  t.mock.timers.tick(900); // 1800 ms since the question, but only 900 since the last key
  s.input.write('\n');
  assert.equal(await pending, 'install', 'a person who is typing is not cut off');

  // And someone who has stopped typing still times out.
  const idle = streams();
  const gone = askChoice({ input: idle.input, output: idle.output, timeoutMs: 1000 });
  await settle();
  t.mock.timers.tick(1000);
  assert.equal(await gone, null);
  assert.match(idle.text(), /No answer.*asked again next launch/);
});
