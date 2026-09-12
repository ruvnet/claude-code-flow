import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash } from '../loop/ledger.mjs';
import { ROOT, LEDGER, prepare, admit, executeCandidate, inspectCorpus, inspectMission, ledgerFingerprint, readBoundFile } from './admission.mjs';
import { calibrate, freezeInputs } from './run.mjs';

const HEAD = '5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e';
const corpus = () => JSON.parse(readFileSync(join(ROOT, 'corpus.json')));
function temporary(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'repair-admission-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('admission preserves the original mission, consumption and proof boundary', () => {
  const before = ledgerFingerprint(LEDGER), plan = prepare(LEDGER, HEAD);
  assert.equal(plan.mission.epochs, 7);
  assert.equal(plan.mission.nativeFieldCallsReserved, 209784);
  const result = admit(plan, hash(plan));
  assert.equal(result.calibrationReady, true);
  assert.equal(result.candidateExecutionEnabled, false);
  assert.equal(result.boundedRsiEvidenceAccepted, false);
  assert.equal(ledgerFingerprint(LEDGER), before);
});
test('forged success and enabled execution cannot enter a frozen plan', () => {
  const plan = prepare(LEDGER, HEAD), anchor = hash(plan);
  plan.candidateExecutionEnabled = true;
  assert.throws(() => admit(plan, anchor), /plan anchor/);
  assert.throws(() => admit(plan, hash(plan)), /drift/);
  assert.throws(() => executeCandidate({ approved: true }), /MIGRATION_REQUIRED/);
});
test('wrong head and corrupted historical bytes reject', () => temporary(dir => {
  assert.throws(() => inspectMission(LEDGER, '0'.repeat(64)), /anchored head/);
  cpSync(LEDGER, join(dir, 'ledger'), { recursive: true });
  const path = join(dir, 'ledger', '00000000.json');
  const event = JSON.parse(readFileSync(path)); event.payload.mission = 'replacement';
  writeFileSync(path, JSON.stringify(event));
  assert.throws(() => inspectMission(join(dir, 'ledger'), HEAD), /chain mismatch/);
}));
test('a live or ambiguous lock is refused and retained', () => temporary(dir => {
  cpSync(LEDGER, join(dir, 'ledger'), { recursive: true });
  const lock = join(dir, 'ledger', '.writer-lock'); writeFileSync(lock, 'ambiguous');
  assert.throws(() => inspectMission(join(dir, 'ledger'), HEAD), /mission lock/);
  assert.equal(readFileSync(lock, 'utf8'), 'ambiguous');
}));
test('paths, command strings and symlinks cannot escape source snapshots', () => temporary(dir => {
  for (const path of ['../outside', '/etc/passwd', 'a/../../b', 'a;command', 'a\\b']) assert.throws(() => readBoundFile(ROOT, path), /unsafe/);
  symlinkSync(join(ROOT, 'corpus.json'), join(dir, 'linked'));
  assert.throws(() => readBoundFile(dir, 'linked'), /escapes/);
  const c = corpus(); c.tasks[0].command = 'node anything';
  assert.throws(() => inspectCorpus(c), /task fields/);
}));
test('duplicate tasks and inflated independence are refused', () => {
  const duplicate = corpus(); duplicate.tasks[1] = duplicate.tasks[0];
  assert.throws(() => inspectCorpus(duplicate), /duplicate/);
  const inflated = corpus(); inflated.independentClusters = 3;
  assert.throws(() => inspectCorpus(inflated), /cluster count/);
});
test('known fixes cannot be relabeled as sealed tasks', () => {
  const c = corpus(); c.tasks[0].role = 'confirmation';
  assert.throws(() => inspectCorpus(c), /cannot be held out/);
});
test('mutable revisions and mismatched public provenance are refused', () => {
  const c = corpus(); c.tasks[0].base.commit = 'main';
  assert.throws(() => inspectCorpus(c), /immutable/);
  const other = corpus(); other.tasks[0].base.modules[0].url = 'https://example.com/source';
  assert.throws(() => inspectCorpus(other), /provenance/);
});
test('source changes invalidate an existing plan even when workload bytes are unchanged', () => temporary(dir => {
  cpSync(ROOT, dir, { recursive: true });
  const plan = prepare(LEDGER, HEAD, dir);
  const path = join(dir, 'witness.mjs'); writeFileSync(path, readFileSync(path, 'utf8') + '\n// mutation\n');
  assert.throws(() => admit(plan, hash(plan), LEDGER, dir), /drift/);
}));
test('mutated snapshot bytes reject against the original Git blob', () => temporary(dir => {
  cpSync(ROOT, dir, { recursive: true });
  const c = corpus(), path = join(dir, c.tasks[0].base.modules[0].stored);
  writeFileSync(path, readFileSync(path, 'utf8') + '\n');
  assert.throws(() => inspectCorpus(c, dir), /Git blob mismatch/);
}));
test('execution uses checked immutable bytes and refuses a changed reread', () => temporary(dir => {
  cpSync(ROOT, dir, { recursive: true });
  const plan = prepare(LEDGER, HEAD, dir), frozen = freezeInputs(plan, dir);
  const path = join(dir, 'witness.mjs'), original = readFileSync(path);
  writeFileSync(path, 'throw Error("changed after admission");');
  assert.deepEqual(frozen.witness, original);
  assert.throws(() => freezeInputs(plan, dir), /execution bytes changed/);
}));
test('a claimed source revision must match the recorded acquisition binding', () => temporary(dir => {
  cpSync(ROOT, dir, { recursive: true });
  const path = join(dir, 'acquisition.json'), acquisition = JSON.parse(readFileSync(path));
  acquisition.bindings[0].response.sha = '0'.repeat(40); writeFileSync(path, JSON.stringify(acquisition));
  assert.throws(() => prepare(LEDGER, HEAD, dir), /acquisition binding mismatch/);
}));
test('three native historical defects reproduce and all fixed revisions pass', () => {
  const before = ledgerFingerprint(LEDGER), plan = prepare(LEDGER, HEAD);
  const result = calibrate(plan, hash(plan));
  assert.equal(result.regressionWitnessesVerified, true, JSON.stringify(result.pairs));
  assert.equal(result.rows.length, 6);
  assert.equal(result.independentClusters, 1);
  assert.equal(result.costs.missionCandidateEvaluations, 0);
  assert.equal(result.costs.missionNativeFieldCallsAdded, 0);
  assert.equal(result.costs.totalAcquisitionUsd, null);
  assert.equal(result.costs.externalProviderSpendUsd, 0);
  assert.equal(result.candidateExecutionEnabled, false);
  assert.equal(ledgerFingerprint(LEDGER), before);
});
