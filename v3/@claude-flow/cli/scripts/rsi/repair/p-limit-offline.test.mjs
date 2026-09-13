import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from './public-workloads.mjs';
import { validateDependency, prepareOfflineWitness, runOfflineWitness, executeRepairCandidate } from './p-limit-offline.mjs';

const dependency = () => JSON.parse(readFileSync(new URL('./p-limit-dependency.json', import.meta.url)));
function temporary(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ruflo-limit-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('runtime dependency is exact upstream code with no production dependencies', () => {
  const files = validateDependency(dependency());
  assert.equal(files.size, 3);
  assert.equal(JSON.parse(files.get('package.json')).dependencies, undefined);
});
test('altered dependency bytes cannot pass with a rewritten claimed identity', () => {
  const d = dependency(); d.files[0].content += '\n// changed';
  assert.throws(() => validateDependency(d), /Git blob mismatch/);
  d.files[0].oid = '0'.repeat(40);
  assert.throws(() => validateDependency(d));
});
test('missing, duplicate and traversal dependency entries are refused', () => {
  const d = dependency(); d.files.pop(); assert.throws(() => validateDependency(d));
  const duplicate = dependency(); duplicate.files[2] = duplicate.files[0];
  assert.throws(() => validateDependency(duplicate), /duplicate/);
  const traversal = dependency(); traversal.files[0].path = '../index.js';
  assert.throws(() => validateDependency(traversal), /unexpected/);
});
test('mutable dependency ref or substituted provenance is refused', () => {
  const d = dependency(); d.commit = 'main'; assert.throws(() => validateDependency(d));
  const changed = dependency(); changed.files[0].url = 'https://example.com/source';
  assert.throws(() => validateDependency(changed));
});
test('freeze binds runtime binary, witness bytes and original mission usage', () => {
  const plan = prepareOfflineWitness();
  assert.equal(plan.mission.epochs, 7);
  assert.equal(plan.mission.nativeFieldCallsReserved, 209784);
  assert.match(plan.runtime.executableSha256, /^[a-f0-9]{64}$/);
  assert.equal(plan.source.files.length, 6);
  assert.equal(plan.candidateExecutionEnabled, false);
});
test('changed plan, runtime, source and limits cannot execute even with a new hash', () => temporary(dir => {
  for (const mutate of [p => { p.limits.fixedWitnessProcesses = 3; },
    p => { p.runtime.executableSha256 = '0'.repeat(64); },
    p => { p.source.files[0].sha256 = '0'.repeat(64); },
    p => { p.candidateExecutionEnabled = true; }]) {
    const plan = prepareOfflineWitness(); mutate(plan);
    assert.throws(() => runOfflineWitness(plan, sha256(plan), join(dir, 'output')), /drift/);
  }
}));
test('wrong plan anchor is refused before writing a reservation', () => temporary(dir => {
  assert.throws(() => runOfflineWitness(prepareOfflineWitness(), '0'.repeat(64), join(dir, 'output')), /anchor/);
}));
test('ambiguous prior reservation remains intact and cannot be retried automatically', () => temporary(dir => {
  const output = join(dir, 'output'); mkdirSync(output);
  writeFileSync(join(output, 'reservation.json'), 'interrupted');
  const plan = prepareOfflineWitness();
  assert.throws(() => runOfflineWitness(plan, sha256(plan), output), /EEXIST/);
  assert.equal(readFileSync(join(output, 'reservation.json'), 'utf8'), 'interrupted');
}));
test('offline historical witness reproduces defect and preserves ordinary behavior', () => temporary(dir => {
  const plan = prepareOfflineWitness(), output = join(dir, 'output');
  const result = runOfflineWitness(plan, sha256(plan), output);
  assert.equal(result.historicalWitnessVerified, true, JSON.stringify(result));
  assert.deepEqual(result.rows.map(r => r.measurement.rows.map(x => x.passed)),
    [[true, true, true, false], [true, true, true, true]]);
  assert.equal(result.ledgerUnchanged, true);
  assert.equal(result.costs.engineeringWitnessProcessStarts, 2);
  assert.equal(result.costs.missionCandidateEvaluations, 0);
  assert.equal(result.costs.totalAcquisitionUsd, null);
  const reservation = JSON.parse(readFileSync(join(output, 'reservation.json')));
  assert.equal(reservation.reservedWitnessProcesses, 2);
  assert.equal(reservation.retainOnInterruption, true);
  assert.deepEqual(JSON.parse(readFileSync(join(output, 'result.json'))), result);
}));
test('historical calibration cannot authorize arbitrary candidate execution', () => {
  assert.throws(() => executeRepairCandidate({ approved: true, source: 'anything' }), /CANDIDATE_EXECUTION_DISABLED/);
});
