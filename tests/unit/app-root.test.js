'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  resolveAppRoot,
  acquireInstanceLock,
  classifyStore,
  isBlankLibrary,
  looksLikeProjectDir,
  PROJECT_DIR_NAME,
  LOCK_STALE_MS,
  GUARD_STALE_MS,
} = require('../../server/modules/common/app-root');
const { normaliseStore } = require('../../server/modules/store/schema');

// A tiny in-memory file system: just enough of fs for the functions under test.
// `clock` is the time stamped on modification times. Paths are compared through
// path.resolve so the same tests run on Windows and on the Linux CI.
function fakeFs(files = {}, { dirs = [], mkdirFails = false, unlinkFails = false, writeFails = null, readFails = [] } = {}) {
  const key = (p) => path.resolve(p);
  const map = new Map(Object.entries(files).map(([p, text]) => [key(p), { text, mtimeMs: 0 }]));
  const made = new Set(); // folders created through mkdirSync
  const known = new Set(dirs.map(key)); // folders that exist (possibly empty) from the start
  const faults = []; // { method, file, code, times }
  const err = (code) => Object.assign(new Error(code), { code });
  const hit = (method, p) => {
    const fault = faults.find((f) => f.method === method && f.times > 0 && (f.file === null || f.file === key(p)));
    if (!fault) return;
    fault.times -= 1;
    throw err(fault.code);
  };
  const below = (k) => [...map.keys(), ...made, ...known].filter((other) => other.startsWith(k + path.sep));
  const isDir = (k) => made.has(k) || known.has(k) || below(k).length > 0;

  const api = {
    map,
    clock: 0,
    writes: [],
    failOnce: (method, file, code, times = 1) => faults.push({ method, file: file === null ? null : key(file), code, times }),
    put: (p, text) => map.set(key(p), { text, mtimeMs: api.clock }),
    text: (p) => map.get(key(p))?.text,
    has: (p) => map.has(key(p)),
    drop: (p) => map.delete(key(p)),
    hasDir: (p) => made.has(key(p)),
    madeCount: () => made.size,
    snapshot: () => JSON.stringify([...map.entries()]),
    // Like the real one: any error at all reads as "does not exist".
    existsSync: (p) => {
      try {
        api.statSync(p);
        return true;
      } catch {
        return false;
      }
    },
    statSync: (p) => {
      hit('statSync', p);
      const k = key(p);
      if (map.has(k)) return { mtimeMs: map.get(k).mtimeMs, isDirectory: () => false };
      if (isDir(k)) return { mtimeMs: 0, isDirectory: () => true };
      throw err('ENOENT');
    },
    readFileSync: (p) => {
      hit('readFileSync', p);
      const k = key(p);
      if (readFails.includes(k)) throw err('EBUSY');
      if (!map.has(k)) throw err('ENOENT');
      return map.get(k).text;
    },
    readdirSync: (p) => {
      hit('readdirSync', p);
      const k = key(p);
      if (map.has(k)) throw err('ENOTDIR');
      if (!isDir(k)) throw err('ENOENT');
      return [...new Set(below(k).map((other) => other.slice(k.length + 1).split(path.sep)[0]))];
    },
    writeFileSync: (p, text, options = {}) => {
      const k = key(p);
      if (writeFails) throw err(writeFails);
      if (options.flag === 'wx' && map.has(k)) throw err('EEXIST');
      api.writes.push(k);
      map.set(k, { text: String(text), mtimeMs: api.clock });
    },
    utimesSync: () => {},
    unlinkSync: (p) => {
      hit('unlinkSync', p);
      if (unlinkFails) throw err('EPERM');
      if (!map.delete(key(p))) throw err('ENOENT');
    },
    mkdirSync: (p) => {
      if (mkdirFails) throw new Error('EACCES');
      made.add(key(p));
    },
  };
  return api;
}

// The same fs with every way of changing or removing something taken away, apart
// from creating the one empty folder a brand-new install is allowed to make.
function readOnly(fsImpl, allowedMkdir) {
  const refuse = (name) => () => { throw new Error(`resolving the data folder must not call ${name}`); };
  return {
    existsSync: fsImpl.existsSync,
    statSync: fsImpl.statSync,
    readFileSync: fsImpl.readFileSync,
    readdirSync: fsImpl.readdirSync,
    mkdirSync: (p, o) => {
      assert.equal(path.resolve(p), path.resolve(allowedMkdir), 'only the new ScrollScape folder may be created');
      return fsImpl.mkdirSync(p, o);
    },
    writeFileSync: refuse('writeFileSync'),
    appendFileSync: refuse('appendFileSync'),
    unlinkSync: refuse('unlinkSync'),
    renameSync: refuse('renameSync'),
    rmSync: refuse('rmSync'),
    rmdirSync: refuse('rmdirSync'),
    copyFileSync: refuse('copyFileSync'),
    utimesSync: refuse('utimesSync'),
  };
}

const EXE = path.join('C:', 'Users', 'me', 'Downloads', 'ScrollScape.exe');
const DL = path.dirname(EXE);
const HOME = path.join(DL, PROJECT_DIR_NAME);
const LOOSE_STORE = path.join(DL, 'data', 'store.json');
const HOME_STORE = path.join(HOME, 'data', 'store.json');
const CUSTOM = path.resolve('scrollscape-test-home');
const quiet = () => {};
const BOM = String.fromCharCode(0xFEFF); // what Notepad or PowerShell 5.1 can leave at the start of a hand-edited file

// What ensureDirs writes into a new library, and the same after a few sessions
// of the app normalising and flushing it (counters, theme, settings and the
// sources it auto-installs: none of that is the user's data).
const FRESH = { repos: [], installedSources: {}, history: [], favorites: [] };
const BLANK = JSON.stringify(FRESH);
const NORMALISED_BLANK = (() => {
  const store = JSON.parse(BLANK);
  normaliseStore(store);
  store.installedSources = { mangadex: { name: 'MangaDex', installedVia: 'local' } };
  store.settings.proxyUrl = 'http://127.0.0.1:8080';
  store.analytics.totalTimeAfk = 5000;
  return store;
})();
const REAL = JSON.stringify({ ...FRESH, favorites: [{ id: 'one-piece', sourceId: 'mangadex' }] });

// Did the log say a library at `dir` is being skipped?
const warnedAbout = (logs, dir) => logs.some((line) => line.includes(`Warning: a library also exists at ${dir} and is NOT being used`));

const resolve = (fsImpl, env = {}, logs = null, execPath = EXE) => resolveAppRoot({
  execPath, env, fsImpl, log: logs ? (m) => logs.push(m) : quiet,
});

test('a folder named after the project is used as is', () => {
  for (const name of ['ScrollScape', 'scrollscape', 'ScrollScapeLight', 'ScrollScape-v3']) {
    assert.equal(looksLikeProjectDir(path.join('C:', 'x', name)), true, name);
  }
  assert.equal(looksLikeProjectDir(DL), false);
  const exe = path.join('C:', 'Games', 'ScrollScapeLight', 'a.exe');
  assert.equal(resolveAppRoot({ execPath: exe, env: {}, fsImpl: fakeFs(), log: quiet }), path.dirname(exe));
});

test('a fresh run from Downloads gets its own ScrollScape folder', () => {
  const fsImpl = fakeFs();
  assert.equal(resolve(fsImpl), HOME);
  assert.equal(fsImpl.hasDir(HOME), true);
});

test('empty folders left behind do not count as an install', () => {
  const fsImpl = fakeFs({}, { dirs: [
    path.join(DL, 'data'), path.join(DL, 'data', 'sources'), path.join(DL, 'data', 'cache'),
    path.join(DL, 'Local'), path.join(DL, 'tools', 'flaresolverr'),
  ] });
  assert.equal(resolve(fsImpl), HOME);
});

test('an existing ScrollScape folder with a library is used', () => {
  const fsImpl = fakeFs({ [HOME_STORE]: REAL });
  assert.equal(resolve(fsImpl), HOME);
  assert.equal(fsImpl.madeCount(), 0);
});

test('a library already sitting loose next to the exe stays where it is, and nothing is moved', () => {
  const fsImpl = fakeFs({ [LOOSE_STORE]: REAL });
  const before = fsImpl.snapshot();
  const logs = [];
  assert.equal(resolve(readOnly(fsImpl, HOME), {}, logs), DL);
  assert.equal(fsImpl.madeCount(), 0);
  assert.equal(fsImpl.snapshot(), before);
  assert.match(logs.join('\n'), /already here/);
});

test('any JSON object at data/store.json is the user\'s library, whatever keys it has', () => {
  for (const text of ['{"todos":[]}', '{}', '{"favorites":[1]}', JSON.stringify({ repos: [] })]) {
    const fsImpl = fakeFs({ [LOOSE_STORE]: text });
    assert.equal(classifyStore(LOOSE_STORE, fsImpl), 'library', text);
    assert.equal(resolve(fsImpl), DL, text);
    assert.equal(fsImpl.madeCount(), 0, text);
  }
  assert.equal(classifyStore(path.join(DL, 'nope.json'), fakeFs()), 'missing');
});

test('a store.json that cannot be parsed or read is still kept, and no sibling library is created beside it', () => {
  const cases = {
    'half-written JSON': ['{"repos": [', 'corrupt', /not a readable library file/],
    'a JSON array': ['[]', 'corrupt', /not a readable library file/],
    'JSON null': ['null', 'corrupt', /not a readable library file/],
  };
  for (const [name, [text, state, message]] of Object.entries(cases)) {
    const fsImpl = fakeFs({ [LOOSE_STORE]: text });
    const logs = [];
    assert.equal(classifyStore(LOOSE_STORE, fsImpl), state, name);
    assert.equal(resolve(fsImpl, {}, logs), DL, name);
    assert.match(logs.join('\n'), message, name);
    assert.equal(fsImpl.madeCount(), 0, name);
  }

  const busy = fakeFs({ [LOOSE_STORE]: REAL }, { readFails: [path.resolve(LOOSE_STORE)] });
  const logs = [];
  assert.equal(classifyStore(LOOSE_STORE, busy), 'unknown');
  assert.equal(resolve(busy, {}, logs), DL);
  assert.match(logs.join('\n'), /could not read/);
  assert.equal(busy.madeCount(), 0);
});

test('a store.json with a BOM or only whitespace is classified, not treated as missing', () => {
  assert.equal(classifyStore(LOOSE_STORE, fakeFs({ [LOOSE_STORE]: `${BOM}${REAL}` })), 'library');
  assert.equal(classifyStore(LOOSE_STORE, fakeFs({ [LOOSE_STORE]: '  \n' })), 'empty');
  assert.equal(resolve(fakeFs({ [LOOSE_STORE]: '' })), DL);
});

test('one failed stat on the loose library never makes the app start a blank one beside it', () => {
  // The old check used existsSync, which turns EACCES/EIO/EBUSY into "missing":
  // the first start after such a hiccup created a blank ScrollScape\ and hid the library for good.
  for (const code of ['EACCES', 'EIO', 'EBUSY', 'EPERM']) {
    const fsImpl = fakeFs({ [LOOSE_STORE]: REAL });
    fsImpl.failOnce('statSync', LOOSE_STORE, code);
    const logs = [];
    assert.equal(classifyStore(LOOSE_STORE, fakeFs({ [LOOSE_STORE]: REAL })), 'library');
    assert.equal(resolve(fsImpl, {}, logs), DL, code);
    assert.equal(fsImpl.madeCount(), 0, code);
    assert.match(logs.join('\n'), /could not read/, code);
    // The next start sees the same library, because no blank sibling was ever created.
    assert.equal(resolve(fsImpl), DL, `${code}, second start`);
  }
  const probe = fakeFs({ [LOOSE_STORE]: REAL });
  probe.failOnce('statSync', LOOSE_STORE, 'EIO');
  assert.equal(classifyStore(LOOSE_STORE, probe), 'unknown');
});

test('a folder that cannot be listed right now counts as having content', () => {
  const fsImpl = fakeFs({}, { dirs: [path.join(DL, 'Local')] });
  fsImpl.failOnce('readdirSync', path.join(DL, 'Local'), 'EIO');
  assert.equal(resolve(fsImpl), DL);
  assert.equal(fsImpl.madeCount(), 0);
});

test('a loose install without a store.json is still found by its sources, books, cache or FlareSolverr', () => {
  const markers = {
    sources: path.join(DL, 'data', 'sources', 'mangadex.js'),
    'imported books': path.join(DL, 'Local', 'One Piece', 'ch1.cbz'),
    cache: path.join(DL, 'data', 'cache', 'cover.jpg'),
    flaresolverr: path.join(DL, 'tools', 'flaresolverr', 'flaresolverr.exe'),
  };
  for (const [name, file] of Object.entries(markers)) {
    const fsImpl = fakeFs({ [file]: 'x' });
    const before = fsImpl.snapshot();
    assert.equal(resolve(readOnly(fsImpl, HOME)), DL, name);
    assert.equal(fsImpl.madeCount(), 0, name);
    assert.equal(fsImpl.snapshot(), before, name);
  }
});

test('with a blank ScrollScape folder and a real loose library, the loose one is used', () => {
  const blanks = {
    'fresh store': BLANK,
    'empty object': '{}',
    'after normalising and some use': JSON.stringify(NORMALISED_BLANK),
    'zero-byte store': '',
  };
  for (const [name, text] of Object.entries(blanks)) {
    const fsImpl = fakeFs({ [LOOSE_STORE]: REAL, [HOME_STORE]: text });
    const before = fsImpl.snapshot();
    const logs = [];
    assert.equal(resolve(readOnly(fsImpl, HOME), {}, logs), DL, name);
    assert.equal(fsImpl.snapshot(), before, name);
    assert.match(logs.join('\n'), /holds no library data, so it is not used/, name);
  }
});

test('a loose library without a store.json still wins over a blank ScrollScape folder', () => {
  const fsImpl = fakeFs({
    [path.join(DL, 'Local', 'book.cbz')]: 'x',
    [HOME_STORE]: BLANK,
  });
  assert.equal(resolve(fsImpl), DL);
});

test('with a real ScrollScape folder and nothing of value loose, ScrollScape wins', () => {
  const cases = {
    'blank loose store': { [LOOSE_STORE]: BLANK },
    'only a cache and FlareSolverr left over': {
      [path.join(DL, 'data', 'cache', 'c.jpg')]: 'x',
      [path.join(DL, 'tools', 'flaresolverr', 'f.exe')]: 'x',
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    const logs = [];
    assert.equal(resolve(fakeFs({ ...files, [HOME_STORE]: REAL }), {}, logs), HOME, name);
    assert.match(logs.join('\n'), /not used/, name);
  }
});

test('with two blank libraries the designated ScrollScape folder wins', () => {
  assert.equal(resolve(fakeFs({ [LOOSE_STORE]: BLANK, [HOME_STORE]: BLANK })), HOME);
});

test('when both places hold real data the app refuses to start and says how to choose', () => {
  const cases = {
    'two real stores': { [LOOSE_STORE]: REAL, [HOME_STORE]: REAL },
    'corrupt loose store': { [LOOSE_STORE]: '{"repos": [', [HOME_STORE]: REAL },
    'blank ScrollScape store but books inside it': { [LOOSE_STORE]: REAL, [HOME_STORE]: BLANK, [path.join(HOME, 'Local', 'b.cbz')]: 'x' },
  };
  for (const [name, files] of Object.entries(cases)) {
    const fsImpl = fakeFs(files);
    const before = fsImpl.snapshot();
    assert.throws(() => resolve(readOnly(fsImpl, HOME)), (err) => {
      assert.equal(err.code, 'SCROLLSCAPE_LIBRARY_CONFLICT', name);
      assert.ok(err.message.includes(DL) && err.message.includes(HOME), `${name}: names both folders`);
      assert.match(err.message, /SCROLLSCAPE_HOME/, name);
      assert.match(err.message, /move the other folder/, name);
      return true;
    }, name);
    assert.equal(fsImpl.snapshot(), before, name);
  }
});

// "Local" and "data\sources" are generic names: next to the exe, without a store.json, they
// are not a second library to hide, so a working ScrollScape\ must not be refused over them.
test('loose Local / sources folders WITHOUT a store.json do not block a real ScrollScape library', () => {
  const cases = {
    'loose books only': { [path.join(DL, 'Local', 'book.cbz')]: 'x', [HOME_STORE]: REAL },
    'loose sources only': { [path.join(DL, 'data', 'sources', 'a.js')]: 'x', [HOME_STORE]: REAL },
  };
  for (const [name, files] of Object.entries(cases)) {
    const fsImpl = fakeFs(files);
    const before = fsImpl.snapshot();
    const logs = [];
    assert.equal(resolve(readOnly(fsImpl, HOME), {}, logs), HOME, name);
    assert.equal(fsImpl.snapshot(), before, name);
    const warning = logs.join(' ');
    assert.match(warning, /Warning/, name);
    assert.ok(warning.includes(DL), name + ': names the folder that is not used');
    assert.match(warning, /SCROLLSCAPE_HOME/, name);
  }
});

test('a store that cannot be read right now counts as data when both places exist', () => {
  const fsImpl = fakeFs({ [LOOSE_STORE]: REAL, [HOME_STORE]: REAL });
  fsImpl.failOnce('statSync', HOME_STORE, 'EIO');
  assert.throws(() => resolve(fsImpl), { code: 'SCROLLSCAPE_LIBRARY_CONFLICT' });
});

test('"blank" means no user content: the defaults the app fills in do not count, anything else does', () => {
  assert.equal(isBlankLibrary(FRESH), true);
  assert.equal(isBlankLibrary(NORMALISED_BLANK), true);
  assert.equal(isBlankLibrary({}), true);
  assert.equal(isBlankLibrary(null), false);
  assert.equal(isBlankLibrary([]), false);

  const content = {
    favorites: [{ id: 'a' }],
    animeFavorites: [{ idMal: 1 }],
    history: [{ id: 'a' }],
    animeHistory: [{ idMal: 1 }],
    downloadHistory: [{ id: 'a' }],
    customLists: [{ id: 'l', name: 'Reading', mangaItems: [], animeItems: [] }],
    achievements: ['first-chapter'],
    repos: [{ url: 'https://example.invalid/index.json' }],
    readingStatus: { 'a:mangadex': 'reading' },
    animeWatchStatus: { 1: 'watching' },
    mangaTags: { 'a:mangadex': ['artist:oda'] },
    animeTags: { 1: ['x'] },
    coverOverrides: { 'a:mangadex': 'cover.png' },
    animeCoverOverrides: { 1: 'cover.png' },
    nsfwOverrides: { 'a:mangadex': true },
    reviews: { 'a:mangadex': { rating: 5 } },
    purchasedThemes: ['default', 'sakura'],
    ap: { bonus: 5, spent: 0 },
    someFutureCollection: ['kept'],
  };
  for (const [keyName, value] of Object.entries(content)) {
    assert.equal(isBlankLibrary({ ...NORMALISED_BLANK, [keyName]: value }), false, keyName);
  }
});

test('SCROLLSCAPE_PORTABLE keeps the old layout, and accepts 1, true, yes and on', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'Yes', 'on', ' on ']) {
    assert.equal(resolve(fakeFs(), { SCROLLSCAPE_PORTABLE: value }), DL, value);
  }
  for (const value of ['', '0', 'no', 'off', 'false', 'maybe']) {
    assert.equal(resolve(fakeFs(), { SCROLLSCAPE_PORTABLE: value }), HOME, `"${value}" is not an opt-in`);
  }
});

test('SCROLLSCAPE_HOME must be a full path: a relative one is an explained error, not resolved against the working directory', () => {
  const relative = ['manga', path.join('.', 'manga'), path.join('..', 'manga'), '.', 'manga/library'];
  if (path.sep === '\\') relative.push('\\manga', 'D:manga', '/manga');
  for (const value of relative) {
    const fsImpl = fakeFs();
    assert.throws(() => resolve(fsImpl, { SCROLLSCAPE_HOME: value }), (err) => {
      assert.match(err.message, /not a full path/, value);
      assert.match(err.message, /SCROLLSCAPE_HOME/, value);
      return true;
    }, value);
    assert.equal(fsImpl.madeCount(), 0, value);
    assert.deepEqual(fsImpl.writes, [], value);
  }
});

test('SCROLLSCAPE_HOME picks the folder, logs the full path and proves it can write there', () => {
  const fsImpl = fakeFs();
  const logs = [];
  assert.equal(resolve(fsImpl, { SCROLLSCAPE_HOME: CUSTOM }, logs), CUSTOM);
  assert.ok(logs.some((line) => line.includes(CUSTOM) && line.includes('SCROLLSCAPE_HOME')), 'the resolved path is logged');
  assert.equal(fsImpl.writes.some((file) => path.basename(file).startsWith('.scrollscape-write-test-')), true, 'it probed by writing');
  assert.deepEqual([...fsImpl.map.keys()].filter((file) => file.includes('write-test')), [], 'and removed the probe again');
  assert.match(logs.join('\n'), /did not exist and was created/);

  const existing = [];
  assert.equal(resolve(fakeFs({}, { dirs: [CUSTOM] }), { SCROLLSCAPE_HOME: CUSTOM }, existing), CUSTOM);
  assert.doesNotMatch(existing.join('\n'), /did not exist/);
});

test('an unusable SCROLLSCAPE_HOME stops the app instead of starting a blank library elsewhere', () => {
  assert.throws(
    () => resolve(fakeFs({}, { mkdirFails: true }), { SCROLLSCAPE_HOME: CUSTOM }),
    /cannot be used/,
  );
  // An existing folder that refuses writes passes mkdir -p; only the write probe catches it.
  assert.throws(
    () => resolve(fakeFs({}, { dirs: [CUSTOM], writeFails: 'EACCES' }), { SCROLLSCAPE_HOME: CUSTOM }),
    (err) => /cannot be used/.test(err.message) && err.cause?.code === 'EACCES',
  );
});

test('an override that skips a populated library says so in the log', () => {
  const both = { [LOOSE_STORE]: REAL, [HOME_STORE]: REAL };

  const home = [];
  resolve(fakeFs(both), { SCROLLSCAPE_HOME: CUSTOM }, home);
  assert.equal(warnedAbout(home, DL), true);
  assert.equal(warnedAbout(home, HOME), true);

  // Pointing SCROLLSCAPE_HOME at one of the two only reports the other.
  const chosen = [];
  // SCROLLSCAPE_HOME must be absolute: path.resolve(HOME) is HOME on Windows and a real absolute path on Linux (CI).
  assert.equal(resolve(fakeFs(both), { SCROLLSCAPE_HOME: path.resolve(HOME) }, chosen), path.resolve(HOME));
  assert.equal(warnedAbout(chosen, HOME), false);
  assert.equal(warnedAbout(chosen, DL), true);

  // A blank library is not worth a warning.
  const blank = [];
  resolve(fakeFs({ [HOME_STORE]: BLANK }), { SCROLLSCAPE_HOME: CUSTOM }, blank);
  assert.doesNotMatch(blank.join('\n'), /Warning/);

  const portable = [];
  assert.equal(resolve(fakeFs({ [HOME_STORE]: REAL }), { SCROLLSCAPE_PORTABLE: '1' }, portable), DL);
  assert.equal(warnedAbout(portable, HOME), true);
});

test('the exe-folder-name shortcut warns about a library it skips, one level down or one level up', () => {
  const exe = path.join('C:', 'Games', 'ScrollScape-3.1', 'ScrollScape.exe');
  const nested = path.join('C:', 'Games', 'ScrollScape-3.1', PROJECT_DIR_NAME);
  const parentStore = path.join('C:', 'Games', 'data', 'store.json');

  const logs = [];
  const files = {
    [path.join(nested, 'data', 'store.json')]: REAL,
    [parentStore]: REAL,
  };
  assert.equal(resolve(fakeFs(files), {}, logs, exe), path.dirname(exe));
  assert.equal(warnedAbout(logs, nested), true);
  assert.equal(warnedAbout(logs, path.dirname(path.dirname(exe))), true);

  // The parent of an exe is usually Downloads: a generic folder called Local there is not a library.
  const quietLogs = [];
  resolve(fakeFs({ [path.join('C:', 'Games', 'Local', 'x.txt')]: 'x' }), {}, quietLogs, exe);
  assert.doesNotMatch(quietLogs.join('\n'), /Warning/);
});

test('resolving never deletes, moves or rewrites anything that already exists', () => {
  const scenarios = {
    'fresh': {},
    'loose library': { [LOOSE_STORE]: REAL, [path.join(DL, 'Local', 'a.cbz')]: 'book', [path.join(DL, 'data', 'sources', 's.js')]: 'src' },
    'loose without a store': { [path.join(DL, 'Local', 'a.cbz')]: 'book' },
    'loose corrupt store': { [LOOSE_STORE]: '{' },
    'scrollscape library': { [HOME_STORE]: REAL, [path.join(HOME, 'Local', 'a.cbz')]: 'book' },
    'blank scrollscape + loose library': { [LOOSE_STORE]: REAL, [HOME_STORE]: BLANK },
    'real scrollscape + blank loose': { [LOOSE_STORE]: BLANK, [HOME_STORE]: REAL },
    'conflict': { [LOOSE_STORE]: REAL, [HOME_STORE]: REAL },
  };
  for (const [name, files] of Object.entries(scenarios)) {
    const fsImpl = fakeFs(files);
    const before = fsImpl.snapshot();
    try {
      resolve(readOnly(fsImpl, HOME));
    } catch (err) {
      assert.equal(err.code, 'SCROLLSCAPE_LIBRARY_CONFLICT', `${name}: ${err.message}`);
    }
    assert.equal(fsImpl.snapshot(), before, name);
  }
});

// ── instance lock ────────────────────────────────────────────────────────────

const ROOT = path.join('C:', 'lib');
const LOCK = path.join(ROOT, 'data', '.scrollscape.lock');
const GUARD = `${LOCK}.takeover`;
const lockText = (pid, host = 'pc-a') => `${pid}\n${host}\n`;
const lockOptions = (base, extra = {}) => ({ fsImpl: base, startHeartbeat: false, now: () => base.clock, hostname: 'pc-a', ...extra });

// A view of `base` where chosen calls run extra code first, to interleave a
// second process at an exact point. Each hook gets the real method as its first argument.
function interleaved(base, hooks) {
  const view = { ...base };
  for (const [method, hook] of Object.entries(hooks)) view[method] = (...args) => hook(base[method], ...args);
  return view;
}
const isLock = (p) => path.resolve(p) === path.resolve(LOCK);

test('only one live instance can hold a library', () => {
  const fsImpl = fakeFs();
  const first = acquireInstanceLock(ROOT, lockOptions(fsImpl, { pid: 100, isAlive: () => true }));
  assert.equal(first.ok, true);
  assert.equal(fsImpl.text(LOCK), lockText(100), 'the lock records the owner and the machine');

  const second = acquireInstanceLock(ROOT, lockOptions(fsImpl, { pid: 200, isAlive: (pid) => pid === 100 }));
  assert.equal(second.ok, false);
  assert.equal(second.pid, 100);

  first.release();
  assert.equal(fsImpl.has(LOCK), false);
  assert.equal(acquireInstanceLock(ROOT, lockOptions(fsImpl, { pid: 200, isAlive: () => false })).ok, true);
});

test('a lock whose owner is gone, or that has not been touched for two minutes, is replaced', () => {
  const dead = fakeFs({ [LOCK]: '100\n' });
  assert.equal(acquireInstanceLock(ROOT, lockOptions(dead, { pid: 300, isAlive: () => false })).ok, true);

  // The PID was reused by another live process, but the lock stopped being refreshed long ago.
  const reused = fakeFs({ [LOCK]: '100\n' });
  reused.clock = LOCK_STALE_MS + 1000;
  assert.equal(acquireInstanceLock(ROOT, lockOptions(reused, { pid: 300, isAlive: () => true })).ok, true);

  // A freshly refreshed lock held by a live process is respected.
  const live = fakeFs({ [LOCK]: '100\n' });
  live.clock = 5000;
  assert.equal(acquireInstanceLock(ROOT, lockOptions(live, { pid: 300, isAlive: () => true })).ok, false);

  // Garbage in an old lock file is stale; in a brand-new one it is another process mid-start.
  const old = fakeFs({ [LOCK]: 'zzz' });
  old.clock = 60000;
  assert.equal(acquireInstanceLock(ROOT, lockOptions(old, { pid: 300, isAlive: () => true })).ok, true);
  const fresh = fakeFs({ [LOCK]: '' });
  assert.equal(acquireInstanceLock(ROOT, lockOptions(fresh, { pid: 300, isAlive: () => true })).ok, false);
});

test('a stale lock is replaced and nothing is left behind', () => {
  const fsImpl = fakeFs({ [LOCK]: lockText(100) });
  fsImpl.clock = 5000;
  const lock = acquireInstanceLock(ROOT, lockOptions(fsImpl, { pid: 300, isAlive: () => false }));
  assert.equal(lock.ok, true);
  assert.equal(lock.warning, undefined);
  assert.equal(fsImpl.text(LOCK), lockText(300));
  assert.equal(fsImpl.has(GUARD), false, 'the takeover guard is cleaned up');
});

test('the lock fails open on environmental problems: they only warn', () => {
  const cases = {
    'cannot create the data folder': fakeFs({}, { mkdirFails: true }),
    'cannot create the lock file': fakeFs({}, { writeFails: 'EPERM' }),
    'cannot remove a stale lock': fakeFs({ [LOCK]: '100\n' }, { unlinkFails: true }),
  };
  for (const [name, fsImpl] of Object.entries(cases)) {
    const lock = acquireInstanceLock(ROOT, lockOptions(fsImpl, { pid: 300, isAlive: () => false }));
    assert.equal(lock.ok, true, name);
    assert.equal(typeof lock.warning, 'string', name);
  }
});

test('a stale lock that another process removes first is not a reason to run without a lock', () => {
  const base = fakeFs({ [LOCK]: lockText(100) });
  base.clock = 5000;
  let raced = false;
  const view = interleaved(base, {
    // The other launch got its unlink in first: ours finds nothing left to remove.
    unlinkSync: (real, p) => {
      if (isLock(p) && !raced) {
        raced = true;
        real(p);
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return real(p);
    },
  });
  const lock = acquireInstanceLock(ROOT, lockOptions(base, { fsImpl: view, pid: 300, isAlive: () => false }));
  assert.equal(raced, true);
  assert.equal(lock.ok, true);
  assert.equal(lock.warning, undefined, 'it took the lock instead of giving up on it');
  assert.equal(base.text(LOCK), lockText(300));
  assert.equal(base.has(GUARD), false);
});

test('two launches racing on one stale lock: the late one must not remove the winner\'s fresh lock', () => {
  const base = fakeFs({ [LOCK]: lockText(100) });
  base.clock = 5000;
  let winner = null;
  // Right after the late launch has read the stale lock, the early one completes its whole takeover.
  const view = interleaved(base, {
    readFileSync: (real, p, enc) => {
      const out = real(p, enc);
      if (!winner && isLock(p)) {
        winner = acquireInstanceLock(ROOT, lockOptions(base, { pid: 200, isAlive: (pid) => pid === 200 }));
      }
      return out;
    },
  });
  const late = acquireInstanceLock(ROOT, lockOptions(base, { fsImpl: view, pid: 300, isAlive: (pid) => pid === 200 }));
  assert.equal(winner.ok, true);
  assert.equal(late.ok, false, 'two instances must not both own one library');
  assert.equal(late.pid, 200);
  assert.equal(base.text(LOCK), lockText(200), 'the winner\'s lock is still there, untouched');
});

test('a launch that arrives while another is mid-takeover is told the app is already starting', () => {
  const base = fakeFs({ [LOCK]: lockText(100) });
  base.clock = 5000;
  let arrival = null;
  const view = interleaved(base, {
    unlinkSync: (real, p) => {
      if (isLock(p) && !arrival) arrival = acquireInstanceLock(ROOT, lockOptions(base, { pid: 200, isAlive: () => false }));
      return real(p);
    },
  });
  const first = acquireInstanceLock(ROOT, lockOptions(base, { fsImpl: view, pid: 300, isAlive: () => false }));
  assert.equal(first.ok, true);
  assert.equal(arrival.ok, false);
  assert.equal(arrival.file, GUARD);
  assert.equal(base.text(LOCK), lockText(300));
  assert.equal(base.has(GUARD), false);
});

test('a takeover guard left behind by a crash expires; a fresh one is respected', () => {
  const held = fakeFs({ [LOCK]: lockText(100), [GUARD]: lockText(200) });
  held.clock = GUARD_STALE_MS - 1000;
  const blocked = acquireInstanceLock(ROOT, lockOptions(held, { pid: 300, isAlive: () => false }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.file, GUARD);
  assert.equal(held.text(LOCK), lockText(100), 'nothing was removed while someone else is taking over');

  const crashed = fakeFs({ [LOCK]: lockText(100), [GUARD]: lockText(200) });
  crashed.clock = GUARD_STALE_MS + 1000;
  const lock = acquireInstanceLock(ROOT, lockOptions(crashed, { pid: 300, isAlive: () => false }));
  assert.equal(lock.ok, true);
  assert.equal(crashed.text(LOCK), lockText(300));
  assert.equal(crashed.has(GUARD), false);
});

test('our own lock is read back: if a contender replaced it, we do not claim it', () => {
  const base = fakeFs();
  base.clock = 5000;
  let replaced = false;
  const view = interleaved(base, {
    writeFileSync: (real, p, text, options) => {
      real(p, text, options);
      if (isLock(p) && options?.flag === 'wx' && !replaced) {
        replaced = true;
        base.put(LOCK, lockText(200)); // a contender judged the previous lock stale and swapped in its own
      }
    },
  });
  const lock = acquireInstanceLock(ROOT, lockOptions(base, { fsImpl: view, pid: 300, isAlive: (pid) => pid === 200 }));
  assert.equal(lock.ok, false);
  assert.equal(lock.pid, 200);
  assert.equal(base.text(LOCK), lockText(200));
});

test('our own lock vanishing right after we create it is retried, not ignored', () => {
  const base = fakeFs();
  let dropped = false;
  const view = interleaved(base, {
    writeFileSync: (real, p, text, options) => {
      real(p, text, options);
      if (isLock(p) && !dropped) {
        dropped = true;
        base.drop(LOCK);
      }
    },
  });
  const lock = acquireInstanceLock(ROOT, lockOptions(base, { fsImpl: view, pid: 300, isAlive: () => false }));
  assert.equal(lock.ok, true);
  assert.equal(base.text(LOCK), lockText(300), 'the lock file really exists');
});

test('a lock that disappears between our failed create and our read is simply created again', () => {
  const base = fakeFs({ [LOCK]: lockText(100) });
  let vanished = false;
  const view = interleaved(base, {
    readFileSync: (real, p, enc) => {
      if (isLock(p) && !vanished) {
        vanished = true;
        base.drop(LOCK); // its owner released it just now
      }
      return real(p, enc);
    },
  });
  const lock = acquireInstanceLock(ROOT, lockOptions(base, { fsImpl: view, pid: 300, isAlive: () => true }));
  assert.equal(lock.ok, true);
  assert.equal(lock.warning, undefined);
  assert.equal(base.text(LOCK), lockText(300));
});

test('running out of attempts on a stale lock that will not go away reports "already running"', () => {
  const base = fakeFs({ [LOCK]: lockText(100) });
  base.clock = 5000;
  let removals = 0;
  const view = interleaved(base, {
    unlinkSync: (real, p) => {
      if (isLock(p)) { removals += 1; return undefined; } // claims success, removes nothing
      return real(p);
    },
  });
  const lock = acquireInstanceLock(ROOT, lockOptions(base, { fsImpl: view, pid: 300, isAlive: () => false }));
  assert.equal(lock.ok, false);
  assert.equal(lock.file, LOCK);
  assert.ok(removals > 0 && removals <= 10, `bounded retries (${removals})`);
});

test('a lock from another PC is judged by how recently it was refreshed, never by a PID that means nothing here', () => {
  const checked = [];
  const isAlive = (pid) => { checked.push(pid); return false; }; // the PID does not exist on THIS machine

  const fresh = fakeFs({ [LOCK]: lockText(100, 'pc-b') });
  fresh.clock = 5000;
  const refused = acquireInstanceLock(ROOT, lockOptions(fresh, { pid: 300, isAlive }));
  assert.equal(refused.ok, false);
  assert.equal(Number.isNaN(refused.pid), true, 'a foreign PID is not reported as if it were local');
  assert.equal(refused.host, 'pc-b');
  assert.deepEqual(checked, [], 'the local process table was not consulted');
  assert.equal(fresh.text(LOCK), lockText(100, 'pc-b'));

  const old = fakeFs({ [LOCK]: lockText(100, 'pc-b') });
  old.clock = LOCK_STALE_MS + 1000;
  assert.equal(acquireInstanceLock(ROOT, lockOptions(old, { pid: 300, isAlive })).ok, true);
  assert.equal(old.text(LOCK), lockText(300));

  const sameHost = fakeFs({ [LOCK]: lockText(100, 'PC-A') });
  sameHost.clock = 5000;
  const local = acquireInstanceLock(ROOT, lockOptions(sameHost, { pid: 300, isAlive: (pid) => pid === 100 }));
  assert.equal(local.ok, false, 'host names are compared case-insensitively');
  assert.equal(local.pid, 100);
  assert.equal(local.host, undefined);
});

test('releasing only removes a lock that is still ours', () => {
  const fsImpl = fakeFs();
  const mine = acquireInstanceLock(ROOT, lockOptions(fsImpl, { pid: 100, isAlive: () => false }));
  fsImpl.put(LOCK, '999\n');
  mine.release();
  assert.equal(fsImpl.text(LOCK), '999\n');

  // The same PID on another machine is somebody else's lock.
  const shared = fakeFs();
  const own = acquireInstanceLock(ROOT, lockOptions(shared, { pid: 100, isAlive: () => false }));
  shared.put(LOCK, lockText(100, 'pc-b'));
  own.release();
  assert.equal(shared.text(LOCK), lockText(100, 'pc-b'));
});
