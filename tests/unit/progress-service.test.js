'use strict';

// The reading progress on the server (modules/progress/service.js). It is changed only by ops, and every op is idempotent: a request
// sent twice (a retry after a lost answer) must change nothing the second time; two browsers must not overwrite each other; and the
// day a chapter was first read is kept (without ever turning a library read before this existed into "read today").

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createProgressService } = require('../../server/modules/progress/service');

const silent = { log() {}, warn() {} };
const DAY = 86_400_000;

function setup(t, { clock = Date.UTC(2026, 9, 31, 12) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrollscape-progress-'));
  const filePath = path.join(dir, 'reading-progress.json');
  const state = { clock };
  const created = [];
  const make = () => {
    const service = createProgressService({ filePath, now: () => state.clock, log: silent, debounceMs: 5 });
    created.push(service);
    return service;
  };
  // A service saves a little after a change (and makes its folder if it is missing): let every one finish before the folder goes,
  // or a save that comes after the removal makes the folder again and it stays in %TEMP%.
  t.after(async () => {
    for (const service of created) await service.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { svc: make(), make, filePath, state, dir };
}

test('a new server has no progress and says so; any change marks it as started, even an empty one', (t) => {
  const { svc } = setup(t);
  assert.equal(svc.get().initialized, false);
  assert.deepEqual(svc.get().read, []);
  svc.applyOps({ init: true });
  assert.equal(svc.get().initialized, true);
});

test('chapters read, flagged and the places left are kept; keys are opaque (ids can contain ":" and "/")', (t) => {
  const { svc } = setup(t);
  svc.applyOps({
    readAdd: ['Rebirth:-Monarch-of-the-Dead:13732/40', 'kingdom:ch-1'],
    flaggedAdd: ['kingdom:ch-1'],
    last: { kingdom: { c: 'ch-1', at: 5 } },
    highest: { kingdom: 300 },
    pages: { 'kingdom:ch-1': 7 },
    totals: { 'kingdom:ch-1': 30 },
  });
  const got = svc.get();
  assert.deepEqual(got.read.sort(), ['Rebirth:-Monarch-of-the-Dead:13732/40', 'kingdom:ch-1']);
  assert.deepEqual(got.flagged, ['kingdom:ch-1']);
  assert.deepEqual(got.last, { kingdom: { c: 'ch-1', at: 5 } });
  assert.deepEqual([got.highest.kingdom, got.pages['kingdom:ch-1'], got.totals['kingdom:ch-1']], [300, 7, 30]);
});

test('every op is idempotent: the same request twice changes nothing the second time', (t) => {
  const { svc } = setup(t);
  const ops = { readAdd: ['a:1', 'a:2'], readRemove: ['a:9'], flaggedAdd: ['a:1'], last: { a: { c: '2', at: 10 } }, highest: { a: 2 }, pages: { 'a:2': 3 } };
  svc.applyOps(ops);
  const first = JSON.stringify(svc.get());
  svc.applyOps(ops);
  const second = svc.get();
  assert.equal(JSON.stringify({ ...second, rev: 0 }), JSON.stringify({ ...JSON.parse(first), rev: 0 }));
});

test('unmarking a chapter removes it, and a chapter marked again is not given a new day', (t) => {
  const { svc, state } = setup(t);
  svc.applyOps({ readAdd: ['a:1'] });
  state.clock += 3 * DAY;
  svc.applyOps({ readAdd: ['a:1'] });
  assert.equal(svc.readEntries().find(([k]) => k === 'a:1')[1], Math.floor(Date.UTC(2026, 9, 31, 12) / DAY), 'the day of the FIRST time');
  svc.applyOps({ readRemove: ['a:1'] });
  assert.deepEqual(svc.get().read, []);
});

test('where a manga was left: the newer time wins, whichever browser sends it first; null forgets it', (t) => {
  const { svc } = setup(t);
  svc.applyOps({ last: { m: { c: 'ch-9', at: 200 } } });
  svc.applyOps({ last: { m: { c: 'ch-5', at: 100 } } }); // an older browser's late request
  assert.equal(svc.get().last.m.c, 'ch-9');
  svc.applyOps({ last: { m: { c: 'ch-10', at: 300 } } });
  assert.equal(svc.get().last.m.c, 'ch-10');
  svc.applyOps({ last: { m: null } });
  assert.deepEqual(svc.get().last, {});
});

test('the time a browser stamps (milliseconds since 1970, ~1.7e12) is kept, so the newer one really wins whatever the order of arrival', (t) => {
  const { svc } = setup(t);
  const newer = Date.UTC(2026, 9, 31, 12, 0, 5);
  const older = Date.UTC(2026, 9, 31, 12, 0, 1);
  svc.applyOps({ last: { m: { c: 'ch-9', at: newer } } });
  assert.equal(svc.get().last.m.at, newer, 'not cut to 0');
  svc.applyOps({ last: { m: { c: 'ch-5', at: older } } });
  assert.equal(svc.get().last.m.c, 'ch-9', 'the older one arrived later and lost');
});

test('the highest chapter number only goes up (a late, lower value from another browser cannot lower it); null forgets it', (t) => {
  const { svc } = setup(t);
  svc.applyOps({ highest: { m: 300 } });
  svc.applyOps({ highest: { m: 120 } });
  assert.equal(svc.get().highest.m, 300);
  svc.applyOps({ highest: { m: 301 } });
  assert.equal(svc.get().highest.m, 301);
  svc.applyOps({ highest: { m: null } });
  assert.deepEqual(svc.get().highest, {});
});

test('legacy chapters (a browser\'s first upload) are recorded with an unknown day, never today', (t) => {
  const { svc } = setup(t);
  svc.applyOps({ readAdd: ['old:1', 'old:2'], legacy: true });
  svc.applyOps({ readAdd: ['new:1'] });
  const days = Object.fromEntries(svc.readEntries());
  assert.equal(days['old:1'], 0);
  assert.equal(days['old:2'], 0);
  assert.equal(days['new:1'], Math.floor(Date.UTC(2026, 9, 31, 12) / DAY));
  assert.deepEqual([...svc.readDays()], [[Math.floor(Date.UTC(2026, 9, 31, 12) / DAY), 1]], 'only the dated one counts for a review');
});

test('reset forgets everything first, so a browser can replace the server\'s copy with its own', (t) => {
  const { svc } = setup(t);
  svc.applyOps({ readAdd: ['a:1', 'a:2'], last: { a: { c: '2', at: 1 } }, highest: { a: 2 } });
  svc.applyOps({ reset: true, readAdd: ['b:1'], legacy: true });
  const got = svc.get();
  assert.deepEqual(got.read, ['b:1']);
  assert.deepEqual([got.last, got.highest], [{}, {}]);
});

test('what is not a valid op is refused or dropped, never stored', (t) => {
  const { svc } = setup(t);
  for (const bad of [null, 'x', 5, [], undefined]) assert.throws(() => svc.applyOps(bad), (e) => e.statusCode === 400, JSON.stringify(bad));
  svc.applyOps({
    readAdd: ['ok:1', '', 5, null, 'x'.repeat(601), { a: 1 }],
    last: { m: { c: 5 }, n: { c: '' }, o: 'text', p: { c: 'fine', at: -1 }, ['q'.repeat(401)]: { c: 'x', at: 1 } },
    highest: { a: -3, b: Infinity, c: 'x', d: 7 },
    pages: { k: NaN, j: 2 },
    __proto__: { polluted: true },
  });
  const got = svc.get();
  assert.deepEqual(got.read, ['ok:1']);
  assert.deepEqual(Object.keys(got.last), ['p']);
  assert.equal(got.last.p.at, 0);
  assert.deepEqual(got.highest, { d: 7 });
  assert.deepEqual(got.pages, { j: 2 });
  assert.equal({}.polluted, undefined);
});

test('the file survives a restart, is written compactly, and the server does not write when nothing changed', async (t) => {
  const { svc, make, filePath } = setup(t);
  svc.applyOps({ readAdd: ['a:1'], highest: { a: 3 }, legacy: true });
  await svc.flush();
  const text = fs.readFileSync(filePath, 'utf8');
  assert.ok(!text.includes('\n'), 'compact JSON, one line');
  const again = make();
  assert.deepEqual(again.get().read, ['a:1']);
  assert.equal(again.get().initialized, true);
  assert.equal(again.get().highest.a, 3);
  const before = fs.statSync(filePath).mtimeMs;
  await again.flush();
  assert.equal(fs.statSync(filePath).mtimeMs, before, 'nothing changed: nothing written');
});

test('a progress file that cannot be read is kept aside and the server starts empty, never over it', (t) => {
  const { filePath, make, dir } = setup(t);
  fs.writeFileSync(filePath, '{"read": {"a:1": 0}, "bro');
  const svc = make();
  assert.equal(svc.get().initialized, false);
  assert.deepEqual(svc.get().read, []);
  const aside = fs.readdirSync(dir).filter((n) => n.includes('.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"read": {"a:1": 0}, "bro', 'the damaged file is untouched');
});

test('status() counts without sending the keys', (t) => {
  const { svc } = setup(t);
  svc.applyOps({ readAdd: ['a:1', 'a:2', 'b:1'], last: { a: { c: '2', at: 1 }, b: { c: '1', at: 1 } } });
  assert.deepEqual({ ...svc.status(), lastWriteAt: null }, { rev: 1, initialized: true, read: 3, flagged: 0, mangas: 2, lastWriteAt: null });
});
