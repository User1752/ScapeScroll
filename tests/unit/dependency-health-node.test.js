'use strict';

// The Node.js row of the dependency check (dependency-health.js). A newer Node is news, not a fault: while the running line still gets
// fixes it is a WARNING; only a line that no longer gets security fixes is a failure. Judged on the release list nodejs.org publishes
// (newest first) and a date, so none of it needs the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const { judgeNodeRuntime, describeNodeRuntime, checkNodeRuntime } = require('../../server/modules/system-health/dependency-health');

const release = (version, date, lts = false) => ({ version, date, lts });
const LIST = [
  release('v26.13.0', '2026-10-28', 'Next'),
  release('v26.12.0', '2026-10-14', 'Next'),
  release('v26.0.0', '2026-04-22'),
  release('v25.9.0', '2026-03-10'),
  release('v24.22.2', '2026-09-15', 'Krypton'),
  release('v24.11.0', '2025-10-28', 'Krypton'),
  release('v24.0.0', '2025-05-06'),
  release('v22.20.0', '2025-09-24', 'Jod'),
  release('v22.11.0', '2024-10-29', 'Jod'),
  release('v22.0.0', '2024-04-24'),
  release('v20.19.0', '2025-03-13', 'Iron'),
  release('v20.9.0', '2023-10-24', 'Iron'),
];
const NOW = new Date('2026-11-01T12:00:00Z');
const judge = (current) => judgeNodeRuntime(current, LIST, NOW);

test('the newest LTS, or a newer line, is current', () => {
  assert.equal(judge('26.13.0').state, 'current');
  assert.equal(judge('27.0.0').state, 'current');
});

test('an older release of the newest LTS line is a patch: a fix is out', () => {
  const v = judge('26.12.0');
  assert.equal(v.state, 'patch');
  assert.equal(v.sameLine, '26.13.0');
});

test('an older LTS line that still gets fixes says until when (30 months from its first LTS release)', () => {
  const v = judge('24.22.2');
  assert.equal(v.state, 'newer-lts');
  assert.equal(v.supportEnds, '2028-04');
  assert.equal(v.latest, '26.13.0');
  assert.equal(judge('22.20.0').state, 'newer-lts');
  assert.equal(judge('22.20.0').supportEnds, '2027-04');
});

test('a line past its 30 months, or one that never became LTS and was left behind, no longer gets fixes', () => {
  assert.equal(judge('20.19.0').state, 'unsupported', 'its LTS began in 2023-10: over in 2026-04');
  assert.equal(judge('25.9.0').state, 'unsupported', 'an odd line is never LTS');
  const earlier = judgeNodeRuntime('20.19.0', LIST, new Date('2026-04-01T00:00:00Z'));
  assert.equal(earlier.state, 'newer-lts', 'the same line a month earlier was still supported');
});

test('a list with no LTS entry is an error the row reports as "could not check", not a verdict', () => {
  assert.throws(() => judgeNodeRuntime('24.22.2', [release('v26.0.0', '2026-04-22')], NOW), /no LTS entry/);
});

test('the row: a supported line or a patch is a warning, an unsupported line is a failure, the current LTS passes', () => {
  const newer = describeNodeRuntime('24.22.2', judge('24.22.2'), false);
  assert.equal(newer.ok, false);
  assert.equal(newer.severity, 'warning');
  assert.match(newer.error, /still gets fixes until 2028-04 - the latest LTS is v26\.13\.0/);
  assert.equal(newer.latestVersion, '26.13.0', 'what the update button would install');

  const patch = describeNodeRuntime('26.12.0', judge('26.12.0'), true);
  assert.equal(patch.severity, 'warning');
  assert.match(patch.error, /a newer v26 release is out \(v26\.13\.0\)/);
  assert.equal(patch.updatable, true);

  const dead = describeNodeRuntime('20.19.0', judge('20.19.0'), false);
  assert.equal(dead.ok, false);
  assert.equal(dead.severity, undefined, 'no severity: a hard failure');
  assert.match(dead.error, /no longer gets security fixes/);

  const fine = describeNodeRuntime('26.13.0', judge('26.13.0'), true);
  assert.equal(fine.ok, true);
  assert.equal(fine.updatable, false, 'nothing to update');
});

test('checkNodeRuntime: the running version is judged against the list, and an unreachable nodejs.org never fails the row', async () => {
  const running = process.version.replace(/^v/, '');
  const same = await checkNodeRuntime(async () => [release(`v${running}`, '2026-01-01', 'Current')], NOW);
  assert.equal(same.ok, true);
  assert.match(same.details, /current LTS/);

  const offline = await checkNodeRuntime(async () => { throw new Error('getaddrinfo ENOTFOUND nodejs.org'); }, NOW);
  assert.equal(offline.ok, true);
  assert.match(offline.details, /couldn't reach nodejs\.org/);
});
