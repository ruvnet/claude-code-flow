#!/usr/bin/env node
/** Offline admission for frozen, exposed public repair lineages. Never executes candidates. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WORKLOAD_SCHEMA = 'ruflo.public-repair-workloads/v1';
const digest40 = /^[a-f0-9]{40}$/;
const digest64 = /^[a-f0-9]{64}$/;
const safeId = /^[a-z0-9][a-z0-9-]{2,79}$/;
const safeRepo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const assert = (condition, reason) => { if (!condition) throw Error(reason); };
const exactKeys = (value, keys, reason) => assert(
  value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(','), reason,
);

export const sha256 = value => createHash('sha256').update(
  typeof value === 'string' ? value : JSON.stringify(value),
).digest('hex');

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 240 &&
    !path.startsWith('/') && !path.includes('\\') &&
    path.split('/').every(part => part && part !== '.' && part !== '..');
}

function validateAccounting(accounting) {
  exactKeys(accounting, [
    'legacyLedgerHead', 'legacyNativeFieldCallsReserved', 'legacyEpochsConsumed',
    'newNativeFieldCalls', 'repairCandidateEvaluations', 'repairProcessStarts',
    'repairWallMs', 'externalProviderSpendUsd', 'totalAcquisitionUsd',
    'totalEvaluationUsd',
  ], 'accounting fields');
  assert(digest64.test(accounting.legacyLedgerHead), 'legacy ledger head');
  assert(accounting.legacyNativeFieldCallsReserved === 209784 && accounting.legacyEpochsConsumed === 7,
    'legacy mission counters changed');
  for (const key of ['newNativeFieldCalls', 'repairCandidateEvaluations', 'repairProcessStarts', 'repairWallMs', 'externalProviderSpendUsd']) {
    assert(accounting[key] === 0, `unapproved resource use: ${key}`);
  }
  assert(accounting.totalAcquisitionUsd === null && accounting.totalEvaluationUsd === null,
    'unknown total dollar costs must remain explicit');
}

function validateProofBoundary(boundary) {
  exactKeys(boundary, [
    'use', 'fixesExposed', 'sealedEvaluation', 'clusterIndependenceReviewed',
    'evaluatorKeys', 'candidateExecutionEnabled', 'boundedRsiEvidenceAccepted',
  ], 'proof boundary fields');
  assert(boundary.use === 'EXPOSED_DEVELOPMENT_ONLY' && boundary.fixesExposed === true,
    'known-fix development boundary required');
  assert(boundary.sealedEvaluation === false && boundary.clusterIndependenceReviewed === false,
    'unreviewed development tasks cannot be sealed or independent');
  assert(Array.isArray(boundary.evaluatorKeys) && boundary.evaluatorKeys.length === 0,
    'local evaluator keys forbidden');
  assert(boundary.candidateExecutionEnabled === false && boundary.boundedRsiEvidenceAccepted === false,
    'workload acquisition cannot enable execution or claim RSI');
}

function validateSource(source, repository) {
  exactKeys(source, [
    'baseCommit', 'fixCommit', 'fixParents', 'baseTree', 'fixTree',
    'diffSha256', 'diffBytes', 'compareUrl',
  ], 'source fields');
  for (const key of ['baseCommit', 'fixCommit', 'baseTree', 'fixTree']) {
    assert(digest40.test(source[key]), `invalid Git identity: ${key}`);
  }
  assert(source.baseCommit !== source.fixCommit && source.baseTree !== source.fixTree,
    'base and fix must differ');
  assert(Array.isArray(source.fixParents) && source.fixParents.length === 1 &&
    source.fixParents[0] === source.baseCommit, 'fix must be exactly one child of base');
  assert(digest64.test(source.diffSha256) && Number.isSafeInteger(source.diffBytes) && source.diffBytes > 0,
    'frozen diff identity');
  const expected = `https://github.com/${repository}/compare/${source.baseCommit}...${source.fixCommit}`;
  assert(source.compareUrl === expected, 'compare URL must bind exact revisions');
}

function validateTask(task) {
  exactKeys(task, [
    'id', 'repository', 'license', 'cluster', 'reference', 'source',
    'changedFiles', 'supportBindings', 'test', 'exposure', 'admission',
  ], 'workload fields');
  assert(safeId.test(task.id) && safeId.test(task.cluster), 'workload or cluster id');
  assert(safeRepo.test(task.repository), 'repository identity');
  assert(['MIT', 'BSD-3-Clause'].includes(task.license), 'reviewed permissive license required');
  validateSource(task.source, task.repository);
  assert(task.reference === `https://github.com/${task.repository}/commit/${task.source.fixCommit}`,
    'commit reference must bind fix');

  assert(Array.isArray(task.changedFiles) && task.changedFiles.length > 0, 'changed files required');
  const paths = new Set();
  for (const file of task.changedFiles) {
    exactKeys(file, ['path', 'baseBlob', 'fixBlob'], 'changed file fields');
    assert(safePath(file.path) && !paths.has(file.path), 'unsafe or duplicate changed path');
    paths.add(file.path);
    assert(digest40.test(file.baseBlob) && digest40.test(file.fixBlob) && file.baseBlob !== file.fixBlob,
      'changed file blob binding');
  }

  assert(Array.isArray(task.supportBindings) && task.supportBindings.length >= 2,
    'license and dependency metadata bindings required');
  const supportPaths = new Set();
  for (const binding of task.supportBindings) {
    exactKeys(binding, ['path', 'blob', 'role'], 'support binding fields');
    assert(safePath(binding.path) && !paths.has(binding.path) && !supportPaths.has(binding.path),
      'unsafe or duplicate support path');
    supportPaths.add(binding.path);
    assert(digest40.test(binding.blob) && ['license', 'dependency-lock', 'package-manifest'].includes(binding.role),
      'support blob or role');
  }
  assert(task.supportBindings.some(binding => binding.role === 'license'), 'license blob required');

  exactKeys(task.test, ['cwd', 'argv', 'environment', 'hiddenTestsFrozen'], 'test fields');
  assert(safePath(task.test.cwd) || task.test.cwd === '.', 'test cwd');
  assert(Array.isArray(task.test.argv) && task.test.argv.length >= 3 &&
    ['cargo', 'npx', 'python'].includes(task.test.argv[0]) &&
    task.test.argv.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 200),
    'declarative test argv');
  assert(task.test.environment && !Array.isArray(task.test.environment) &&
    Object.entries(task.test.environment).every(([key, value]) => /^[A-Z_a-z][A-Z_a-z0-9]*$/.test(key) && typeof value === 'string'),
    'test environment');
  assert(task.test.hiddenTestsFrozen === false, 'hidden tests are not yet frozen');

  assert(task.exposure === 'PUBLISHED_FIX_AND_UPSTREAM_TESTS_KNOWN', 'fix exposure must stay explicit');
  exactKeys(task.admission, ['eligibleForDevelopment', 'blockers'], 'admission fields');
  assert(task.admission.eligibleForDevelopment === false && Array.isArray(task.admission.blockers) &&
    task.admission.blockers.length >= 3, 'incomplete acquisitions cannot be admitted');
  assert(task.admission.blockers.includes('SOURCE_ARCHIVES_NOT_YET_MIRRORED') &&
    task.admission.blockers.includes('EVALUATOR_AUTHORED_HIDDEN_TESTS_NOT_YET_FROZEN'),
    'source and hidden-test blockers must be retained');
  return structuredClone(task);
}

export function validatePublicWorkloads(manifest, expectedFreezeHash) {
  exactKeys(manifest, ['schema', 'frozenAt', 'selection', 'proofBoundary', 'accounting', 'workloads'],
    'manifest fields');
  assert(manifest.schema === WORKLOAD_SCHEMA && Number.isFinite(Date.parse(manifest.frozenAt)),
    'manifest schema or freeze time');
  exactKeys(manifest.selection, ['source', 'sampleFrozenBeforeMethodComparison', 'selectionMethod', 'excluded'],
    'selection fields');
  assert(manifest.selection.source === 'PUBLIC_GITHUB_ONE_COMMIT_FIXES' &&
    manifest.selection.sampleFrozenBeforeMethodComparison === true &&
    typeof manifest.selection.selectionMethod === 'string' && manifest.selection.selectionMethod.length >= 40,
    'frozen public selection required');
  assert(Array.isArray(manifest.selection.excluded) && manifest.selection.excluded.length >= 2 &&
    manifest.selection.excluded.every(item => safeRepo.test(item?.repository) && typeof item?.reason === 'string' && item.reason.length >= 40),
    'explicit exclusions required');
  validateProofBoundary(manifest.proofBoundary);
  validateAccounting(manifest.accounting);
  assert(Array.isArray(manifest.workloads) && manifest.workloads.length === 3,
    'frozen increment must contain exactly three workloads');
  const tasks = manifest.workloads.map(validateTask);
  assert(new Set(tasks.map(task => task.id)).size === tasks.length, 'duplicate workload id');
  assert(new Set(tasks.map(task => task.repository)).size === tasks.length, 'repository lineages must be distinct');
  assert(new Set(tasks.map(task => task.cluster)).size === tasks.length, 'bug clusters must be distinct');
  const freezeHash = sha256(manifest);
  if (expectedFreezeHash !== undefined) {
    assert(digest64.test(expectedFreezeHash) && freezeHash === expectedFreezeHash, 'workload freeze hash mismatch');
  }
  return {
    schema: 'ruflo.public-repair-workload-admission/v1',
    freezeHash,
    workloadCount: tasks.length,
    repositoryCount: new Set(tasks.map(task => task.repository)).size,
    clusterCount: new Set(tasks.map(task => task.cluster)).size,
    sourceLineagesFrozen: true,
    fixesExposed: true,
    candidateAdmissible: false,
    candidateExecutionEnabled: false,
    boundedRsiEvidenceAccepted: false,
    blockers: [...new Set(tasks.flatMap(task => task.admission.blockers))].sort(),
  };
}

export function inspectPublicWorkloads(path = new URL('./public-workloads.json', import.meta.url), expectedFreezeHash) {
  return validatePublicWorkloads(JSON.parse(readFileSync(path, 'utf8')), expectedFreezeHash);
}

export function executePublicWorkload() {
  throw Error('PUBLIC_WORKLOAD_EXECUTION_DISABLED: frozen metadata is not source, dependency, evaluator or resource authorization');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, path, expectedHash, extra] = process.argv.slice(2);
    if (command !== 'inspect' || !path || extra) throw Error('usage: public-workloads.mjs inspect MANIFEST [FREEZE_HASH]');
    console.log(JSON.stringify(inspectPublicWorkloads(resolve(path), expectedHash), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
