import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executePublicCapsule, inspectPublicCapsules, validatePublicCapsules,
} from './public-capsules.mjs';
import { sha256 } from './public-workloads.mjs';

const CAPSULES = fileURLToPath(new URL('./public-capsules.json', import.meta.url));
const WORKLOADS = fileURLToPath(new URL('./public-workloads.json', import.meta.url));
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const originalCapsules = () => load(CAPSULES);
const originalWorkloads = () => load(WORKLOADS);
const mutate = edit => { const value = originalCapsules(); edit(value); return value; };

function validate(capsules, options = {}) {
  return validatePublicCapsules(capsules, originalWorkloads(), {
    capsuleDir: options.capsuleDir ?? join(dirname(CAPSULES), 'public-capsules'),
    expectedCapsuleHash: options.expectedCapsuleHash,
  });
}

test('verifies every frozen non-lock blob and byte count', () => {
  const result = inspectPublicCapsules(CAPSULES, WORKLOADS);
  assert.equal(result.mirroredBlobCount, 23);
  assert.equal(result.mirroredByteCount, 289533);
  assert.equal(result.manifestBoundNonLockBlobsVerified, true);
});

test('capsule manifest has a stable externally pinnable hash', () => {
  const capsules = originalCapsules(), expected = sha256(capsules);
  assert.equal(validate(capsules, { expectedCapsuleHash: expected }).capsuleHash, expected);
  assert.throws(() => validate(capsules, { expectedCapsuleHash: '0'.repeat(64) }), /manifest hash mismatch/);
});

test('every decoded payload reproduces its original Git blob id and SHA256', () => {
  const capsules = originalCapsules();
  assert.equal(validate(capsules).mirroredBlobCount, capsules.blobs.length);
  assert.throws(() => validate(mutate(m => { m.blobs[0].sha256 = '0'.repeat(64); })), /byte hash mismatch/);
  assert.throws(() => validate(mutate(m => { m.blobs[0].bytes += 1; })), /byte hash mismatch/);
});

test('payload corruption fails closed against the frozen content identities', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rsi-capsules-'));
  try {
    cpSync(join(dirname(CAPSULES), 'public-capsules'), temp, { recursive: true });
    const record = originalCapsules().blobs[0], path = join(temp, `${record.blob}.b64`);
    const encoded = readFileSync(path, 'utf8');
    writeFileSync(path, `${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}`);
    assert.throws(() => validate(originalCapsules(), { capsuleDir: temp }), /byte hash mismatch|Git blob mismatch/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('missing, duplicate and unexpected capsule records reject', () => {
  assert.throws(() => validate(mutate(m => { m.blobs.pop(); })), /coverage count/);
  assert.throws(() => validate(mutate(m => { m.blobs.at(-1).blob = m.blobs[0].blob; m.blobs.at(-1).path = m.blobs[0].path; })), /duplicate or unexpected/);
  assert.throws(() => validate(mutate(m => { m.blobs[0].blob = '0'.repeat(40); m.blobs[0].path = `public-capsules/${'0'.repeat(40)}.b64`; })), /unexpected capsule/);
});

test('repository, role and original source path remain bound', () => {
  assert.throws(() => validate(mutate(m => { m.blobs[0].repo = 'other/repo'; })), /provenance mismatch/);
  assert.throws(() => validate(mutate(m => { m.blobs[0].role = 'changed-fix'; })), /provenance mismatch/);
  assert.throws(() => validate(mutate(m => { m.blobs[0].sourcePath = 'other.rs'; })), /provenance mismatch/);
});

test('workload freeze and reviewed source anchors cannot drift', () => {
  assert.throws(() => validate(mutate(m => { m.workloadManifestHash = '0'.repeat(64); })), /freeze hash mismatch/);
  assert.throws(() => validate(mutate(m => { m.workloadManifestSourceCommit = 'x'.repeat(40); })), /capsule source/);
});

test('both deferred dependency lockfiles remain explicit and source-bound', () => {
  assert.equal(originalCapsules().mirroring.deferred.length, 2);
  assert.throws(() => validate(mutate(m => { m.mirroring.deferred.pop(); })), /dependency-lock coverage/);
  assert.throws(() => validate(mutate(m => { m.mirroring.deferred[0].blob = '0'.repeat(40); })), /dependency-lock binding/);
  assert.throws(() => validate(mutate(m => { m.mirroring.deferred[0].reason = 'DONE'; })), /dependency-lock binding/);
});

test('partial capsules cannot be relabeled as complete or executable', () => {
  for (const key of ['completeDependencyLocks', 'completeSourceTrees', 'completeDependencyClosures', 'offlineExecutable']) {
    assert.throws(() => validate(mutate(m => { m.mirroring[key] = true; })), /partial capsule boundary/);
  }
  assert.equal(validate(originalCapsules()).offlineExecutable, false);
});

test('known public payloads cannot be relabeled as sealed evaluation', () => {
  assert.throws(() => validate(mutate(m => { m.proofBoundary.fixesExposed = false; })), /exposed acquisition/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.sealedEvaluation = true; })), /sealed/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.evaluatorKeys = ['local']; })), /sealed|evaluated/);
});

test('capsules cannot enable candidate execution or RSI acceptance', () => {
  assert.throws(() => validate(mutate(m => { m.proofBoundary.candidateExecutionEnabled = true; })), /enable execution/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.boundedRsiEvidenceAccepted = true; })), /claim RSI/);
  assert.throws(() => executePublicCapsule(), /EXECUTION_DISABLED/);
});

test('legacy counters and zero repair entitlements cannot be rewritten', () => {
  assert.throws(() => validate(mutate(m => { m.accounting.legacyNativeFieldCallsReserved = 0; })), /mission accounting/);
  assert.throws(() => validate(mutate(m => { m.accounting.legacyEpochsConsumed = 0; })), /mission accounting/);
  for (const key of ['newNativeFieldCalls', 'repairCandidateEvaluations', 'repairProcessStarts', 'repairWallMs', 'externalProviderSpendUsd']) {
    assert.throws(() => validate(mutate(m => { m.accounting[key] = 1; })), /unapproved capsule resource/);
  }
});

test('unknown acquisition and evaluation dollars cannot be forged as zero', () => {
  assert.throws(() => validate(mutate(m => { m.accounting.totalAcquisitionUsd = 0; })), /unknown capsule dollar costs/);
  assert.throws(() => validate(mutate(m => { m.accounting.totalEvaluationUsd = 0; })), /unknown capsule dollar costs/);
});

test('mirrored count and byte totals cannot be changed independently', () => {
  assert.throws(() => validate(mutate(m => { m.mirroring.mirroredBlobCount += 1; })), /coverage count/);
  assert.throws(() => validate(mutate(m => { m.mirroring.mirroredByteCount += 1; })), /byte total mismatch/);
});

test('CLI inspection is read-only and reports execution disabled', () => {
  const beforeCapsules = readFileSync(CAPSULES), beforeWorkloads = readFileSync(WORKLOADS);
  const output = JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL('./public-capsules.mjs', import.meta.url)),
    'inspect', CAPSULES, WORKLOADS,
  ], { encoding: 'utf8', timeout: 5000 }));
  assert.equal(output.candidateExecutionEnabled, false);
  assert.equal(output.boundedRsiEvidenceAccepted, false);
  assert.deepEqual(readFileSync(CAPSULES), beforeCapsules);
  assert.deepEqual(readFileSync(WORKLOADS), beforeWorkloads);
});
