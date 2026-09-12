import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  executePublicWorkload, inspectPublicWorkloads, sha256, validatePublicWorkloads,
} from './public-workloads.mjs';

const PATH = fileURLToPath(new URL('./public-workloads.json', import.meta.url));
const original = () => JSON.parse(readFileSync(PATH, 'utf8'));
const mutate = edit => { const value = original(); edit(value); return value; };

test('freezes three distinct public repository and bug lineages', () => {
  const result = inspectPublicWorkloads(PATH);
  assert.equal(result.workloadCount, 3);
  assert.equal(result.repositoryCount, 3);
  assert.equal(result.clusterCount, 3);
  assert.equal(result.sourceLineagesFrozen, true);
});

test('freeze hash is deterministic and can be externally pinned', () => {
  const manifest = original(), expected = sha256(manifest);
  assert.equal(validatePublicWorkloads(manifest, expected).freezeHash, expected);
  assert.throws(() => validatePublicWorkloads(manifest, '0'.repeat(64)), /freeze hash mismatch/);
});

test('each fix is exactly one child of its bound base', () => {
  const manifest = original();
  for (const task of manifest.workloads) assert.deepEqual(task.source.fixParents, [task.source.baseCommit]);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].source.fixParents = []; })), /one child/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].source.fixParents = [m.workloads[1].source.baseCommit]; })), /one child/);
});

test('Git identities and immutable compare URLs reject revision drift', () => {
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].source.baseTree = 'x'.repeat(40); })), /Git identity/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].source.diffSha256 = '0'.repeat(63); })), /diff identity/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].source.compareUrl = 'https://github.com/example/example'; })), /compare URL/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].reference = m.workloads[1].reference; })), /commit reference/);
});

test('changed blobs must be different, content-addressed and path safe', () => {
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].changedFiles[0].fixBlob = m.workloads[0].changedFiles[0].baseBlob; })), /blob binding/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].changedFiles[0].path = '../../secret'; })), /changed path/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].changedFiles.push(structuredClone(m.workloads[0].changedFiles[0])); })), /changed path/);
});

test('license and dependency metadata are source-bound', () => {
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[1].supportBindings = m.workloads[1].supportBindings.filter(x => x.role !== 'license'); })), /license.*binding|license blob/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].supportBindings[0].blob = 'not-a-blob'; })), /support blob/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].license = 'UNKNOWN'; })), /permissive license/);
});

test('duplicate workloads, repositories and clusters reject', () => {
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[1].id = m.workloads[0].id; })), /duplicate workload/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[1].repository = m.workloads[0].repository; m.workloads[1].source.compareUrl = `https://github.com/${m.workloads[0].repository}/compare/${m.workloads[1].source.baseCommit}...${m.workloads[1].source.fixCommit}`; m.workloads[1].reference = `https://github.com/${m.workloads[0].repository}/commit/${m.workloads[1].source.fixCommit}`; })), /repository lineages/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[1].cluster = m.workloads[0].cluster; })), /bug clusters/);
});

test('selection stays frozen before any method comparison', () => {
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.selection.sampleFrozenBeforeMethodComparison = false; })), /frozen public selection/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.selection.excluded = []; })), /explicit exclusions/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads.pop(); })), /exactly three/);
});

test('published fixes cannot be relabeled as sealed or independent', () => {
  for (const edit of [
    m => { m.proofBoundary.fixesExposed = false; },
    m => { m.proofBoundary.sealedEvaluation = true; },
    m => { m.proofBoundary.clusterIndependenceReviewed = true; },
    m => { m.workloads[0].exposure = 'HIDDEN'; },
  ]) assert.throws(() => validatePublicWorkloads(mutate(edit)), /known-fix|sealed|exposure/);
});

test('local evaluator keys and RSI acceptance reject', () => {
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.proofBoundary.evaluatorKeys = ['local']; })), /evaluator keys/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.proofBoundary.boundedRsiEvidenceAccepted = true; })), /claim RSI/);
});

test('no resource use or legacy counter reset is admitted', () => {
  for (const key of ['newNativeFieldCalls', 'repairCandidateEvaluations', 'repairProcessStarts', 'repairWallMs', 'externalProviderSpendUsd']) {
    assert.throws(() => validatePublicWorkloads(mutate(m => { m.accounting[key] = 1; })), /unapproved resource/);
  }
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.accounting.legacyNativeFieldCallsReserved = 0; })), /mission counters/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.accounting.legacyEpochsConsumed = 0; })), /mission counters/);
});

test('unknown dollar costs cannot be fabricated as zero', () => {
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.accounting.totalAcquisitionUsd = 0; })), /unknown total dollar costs/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.accounting.totalEvaluationUsd = 0; })), /unknown total dollar costs/);
});

test('candidate admission requires mirrored sources, frozen dependencies and hidden tests', () => {
  const result = inspectPublicWorkloads(PATH);
  assert.equal(result.candidateAdmissible, false);
  assert(result.blockers.includes('SOURCE_ARCHIVES_NOT_YET_MIRRORED'));
  assert(result.blockers.includes('EVALUATOR_AUTHORED_HIDDEN_TESTS_NOT_YET_FROZEN'));
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].admission.eligibleForDevelopment = true; })), /cannot be admitted/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].admission.blockers = ['ONLY_ONE']; })), /cannot be admitted/);
});

test('test declarations are data and cannot authorize arbitrary launchers', () => {
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].test.argv[0] = 'bash'; })), /test argv/);
  assert.throws(() => validatePublicWorkloads(mutate(m => { m.workloads[0].test.environment = { 'BAD-KEY': '1' }; })), /test environment/);
  assert.throws(() => executePublicWorkload(original().workloads[0]), /EXECUTION_DISABLED/);
});

test('CLI inspection is read-only and reports the proof boundary', () => {
  const before = readFileSync(PATH), output = JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL('./public-workloads.mjs', import.meta.url)), 'inspect', PATH,
  ], { encoding: 'utf8', timeout: 5000 }));
  assert.equal(output.candidateExecutionEnabled, false);
  assert.equal(output.boundedRsiEvidenceAccepted, false);
  assert.deepEqual(readFileSync(PATH), before);
});
