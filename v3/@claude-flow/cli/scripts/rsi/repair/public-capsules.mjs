#!/usr/bin/env node
/** Offline verification for partial public Git-blob capsules. No execution path. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, validatePublicWorkloads } from './public-workloads.mjs';

export const CAPSULE_SCHEMA = 'ruflo.public-repair-source-capsules/v1';
const digest40 = /^[a-f0-9]{40}$/;
const digest64 = /^[a-f0-9]{64}$/;
const assert = (condition, reason) => { if (!condition) throw Error(reason); };
const exactKeys = (value, keys, reason) => assert(
  value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(','), reason,
);
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const byteSha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function expectedBlobs(workloads) {
  const expected = new Map();
  for (const workload of workloads.workloads) {
    for (const file of workload.changedFiles) {
      for (const [role, blob] of [['changed-base', file.baseBlob], ['changed-fix', file.fixBlob]]) {
        assert(!expected.has(blob), 'workload manifest reuses a changed blob');
        expected.set(blob, { repo: workload.repository, role, sourcePath: file.path });
      }
    }
    for (const support of workload.supportBindings) {
      if (support.role === 'dependency-lock') continue;
      assert(!expected.has(support.blob), 'workload manifest reuses a support blob');
      expected.set(support.blob, { repo: workload.repository, role: support.role, sourcePath: support.path });
    }
  }
  return expected;
}

function expectedDeferredLocks(workloads) {
  return workloads.workloads.flatMap(workload => workload.supportBindings
    .filter(binding => binding.role === 'dependency-lock')
    .map(binding => ({ repository: workload.repository, sourcePath: binding.path, blob: binding.blob })));
}

function validateBoundary(boundary) {
  exactKeys(boundary, ['use', 'fixesExposed', 'sealedEvaluation', 'evaluatorKeys', 'candidateExecutionEnabled', 'boundedRsiEvidenceAccepted'], 'capsule proof boundary fields');
  assert(boundary.use === 'EXPOSED_DEVELOPMENT_ACQUISITION_ONLY' && boundary.fixesExposed === true,
    'exposed acquisition boundary required');
  assert(boundary.sealedEvaluation === false && Array.isArray(boundary.evaluatorKeys) && boundary.evaluatorKeys.length === 0,
    'capsules cannot become sealed or locally evaluated');
  assert(boundary.candidateExecutionEnabled === false && boundary.boundedRsiEvidenceAccepted === false,
    'capsules cannot enable execution or claim RSI');
}

function validateAccounting(accounting) {
  exactKeys(accounting, ['legacyLedgerHead', 'legacyNativeFieldCallsReserved', 'legacyEpochsConsumed', 'newNativeFieldCalls', 'repairCandidateEvaluations', 'repairProcessStarts', 'repairWallMs', 'externalProviderSpendUsd', 'totalAcquisitionUsd', 'totalEvaluationUsd'], 'capsule accounting fields');
  assert(digest64.test(accounting.legacyLedgerHead) && accounting.legacyNativeFieldCallsReserved === 209784 && accounting.legacyEpochsConsumed === 7,
    'legacy mission accounting changed');
  for (const key of ['newNativeFieldCalls', 'repairCandidateEvaluations', 'repairProcessStarts', 'repairWallMs', 'externalProviderSpendUsd']) {
    assert(accounting[key] === 0, `unapproved capsule resource use: ${key}`);
  }
  assert(accounting.totalAcquisitionUsd === null && accounting.totalEvaluationUsd === null,
    'unknown capsule dollar costs must remain explicit');
}

function readCapsule(record, capsuleDir) {
  exactKeys(record, ['repo', 'blob', 'role', 'sourcePath', 'sha256', 'bytes', 'encoding', 'path'], 'capsule blob fields');
  assert(digest40.test(record.blob) && digest64.test(record.sha256) && Number.isSafeInteger(record.bytes) && record.bytes > 0,
    'capsule content identity');
  assert(record.encoding === 'base64' && record.path === `public-capsules/${record.blob}.b64`, 'capsule encoding path');
  const encoded = readFileSync(join(capsuleDir, `${record.blob}.b64`), 'utf8').replace(/\s/g, '');
  assert(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded), 'capsule base64 syntax');
  const bytes = Buffer.from(encoded, 'base64');
  assert(bytes.toString('base64') === encoded, 'capsule base64 canonical encoding');
  assert(bytes.length === record.bytes && byteSha256(bytes) === record.sha256, 'capsule byte hash mismatch');
  assert(gitBlob(bytes) === record.blob, 'capsule Git blob mismatch');
  return bytes.length;
}

export function validatePublicCapsules(capsules, workloads, options = {}) {
  exactKeys(capsules, ['schema', 'createdAt', 'workloadManifestHash', 'workloadManifestSourceCommit', 'purpose', 'proofBoundary', 'mirroring', 'blobs', 'accounting'], 'capsule manifest fields');
  assert(capsules.schema === CAPSULE_SCHEMA && Number.isFinite(Date.parse(capsules.createdAt)), 'capsule schema or time');
  assert(digest40.test(capsules.workloadManifestSourceCommit) && typeof capsules.purpose === 'string' && capsules.purpose.length >= 60,
    'capsule source or purpose');
  const workloadCheck = validatePublicWorkloads(workloads, capsules.workloadManifestHash);
  assert(workloadCheck.freezeHash === capsules.workloadManifestHash, 'workload manifest binding');
  validateBoundary(capsules.proofBoundary);
  validateAccounting(capsules.accounting);

  exactKeys(capsules.mirroring, ['mirroredBlobCount', 'mirroredByteCount', 'completeManifestBoundNonLockBlobs', 'completeDependencyLocks', 'completeSourceTrees', 'completeDependencyClosures', 'offlineExecutable', 'deferred'], 'mirroring fields');
  assert(capsules.mirroring.completeManifestBoundNonLockBlobs === true &&
    capsules.mirroring.completeDependencyLocks === false && capsules.mirroring.completeSourceTrees === false &&
    capsules.mirroring.completeDependencyClosures === false && capsules.mirroring.offlineExecutable === false,
    'partial capsule boundary changed');

  const expected = expectedBlobs(workloads);
  assert(Array.isArray(capsules.blobs) && capsules.blobs.length === expected.size &&
    capsules.mirroring.mirroredBlobCount === expected.size, 'capsule coverage count');
  const seen = new Set();
  let mirroredBytes = 0;
  const capsuleDir = options.capsuleDir ?? join(dirname(options.manifestPath ?? fileURLToPathSafe(new URL('./public-capsules.json', import.meta.url))), 'public-capsules');
  for (const record of capsules.blobs) {
    assert(!seen.has(record.blob) && expected.has(record.blob), 'duplicate or unexpected capsule blob');
    seen.add(record.blob);
    const identity = expected.get(record.blob);
    assert(record.repo === identity.repo && record.role === identity.role && record.sourcePath === identity.sourcePath,
      'capsule provenance mismatch');
    mirroredBytes += readCapsule(record, capsuleDir);
  }
  assert(seen.size === expected.size && mirroredBytes === capsules.mirroring.mirroredByteCount,
    'capsule coverage or byte total mismatch');

  const deferred = expectedDeferredLocks(workloads);
  assert(Array.isArray(capsules.mirroring.deferred) && capsules.mirroring.deferred.length === deferred.length,
    'deferred dependency-lock coverage');
  for (const expectedLock of deferred) {
    const match = capsules.mirroring.deferred.filter(item => item.repository === expectedLock.repository && item.sourcePath === expectedLock.sourcePath && item.blob === expectedLock.blob);
    assert(match.length === 1 && /^FREEZE_WITH_COMPLETE_OFFLINE_[A-Z_]+_DEPENDENCY_CLOSURE$/.test(match[0].reason),
      'deferred dependency-lock binding');
  }

  const capsuleHash = sha256(capsules);
  if (options.expectedCapsuleHash !== undefined) {
    assert(digest64.test(options.expectedCapsuleHash) && capsuleHash === options.expectedCapsuleHash,
      'capsule manifest hash mismatch');
  }
  return {
    schema: 'ruflo.public-repair-source-capsule-check/v1', capsuleHash,
    workloadManifestHash: capsules.workloadManifestHash,
    mirroredBlobCount: seen.size, mirroredByteCount: mirroredBytes,
    manifestBoundNonLockBlobsVerified: true,
    completeDependencyLocks: false, completeSourceTrees: false,
    completeDependencyClosures: false, offlineExecutable: false,
    candidateAdmissible: false, candidateExecutionEnabled: false,
    boundedRsiEvidenceAccepted: false,
  };
}

function fileURLToPathSafe(url) {
  return decodeURIComponent(url.pathname);
}

export function inspectPublicCapsules(capsuleManifestPath, workloadManifestPath, expectedCapsuleHash) {
  const capsules = JSON.parse(readFileSync(capsuleManifestPath, 'utf8'));
  const workloads = JSON.parse(readFileSync(workloadManifestPath, 'utf8'));
  return validatePublicCapsules(capsules, workloads, {
    manifestPath: capsuleManifestPath,
    expectedCapsuleHash,
  });
}

export function executePublicCapsule() {
  throw Error('PUBLIC_CAPSULE_EXECUTION_DISABLED: partial source blobs are not a source tree, dependency closure, hidden evaluator or resource authorization');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, capsulePath, workloadPath, expectedHash, extra] = process.argv.slice(2);
    if (command !== 'inspect' || !capsulePath || !workloadPath || extra) {
      throw Error('usage: public-capsules.mjs inspect CAPSULE_MANIFEST WORKLOAD_MANIFEST [CAPSULE_HASH]');
    }
    console.log(JSON.stringify(inspectPublicCapsules(resolve(capsulePath), resolve(workloadPath), expectedHash), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
