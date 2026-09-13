import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executePublicTargetPayload, inspectPublicTargetPayloads, validatePublicTargetPayloads,
} from './public-target-payloads.mjs';
import { sha256 } from './public-workloads.mjs';

const MANIFEST = fileURLToPath(new URL('./public-target-payloads.json', import.meta.url));
const WORKLOADS = fileURLToPath(new URL('./public-workloads.json', import.meta.url));
const CAPSULES = fileURLToPath(new URL('./public-capsules.json', import.meta.url));
const INVENTORIES = fileURLToPath(new URL('./public-tree-inventories.json', import.meta.url));
const PRIOR = fileURLToPath(new URL('./public-tree-payloads.json', import.meta.url));
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const original = () => load(MANIFEST);
const mutate = edit => { const value = original(); edit(value); return value; };
const dirs = {
  targetPayloadDir: join(dirname(MANIFEST), 'public-target-payloads'),
  priorPayloadDir: join(dirname(PRIOR), 'public-tree-payloads'),
  inventoryDir: join(dirname(INVENTORIES), 'public-tree-inventories'),
  capsuleDir: join(dirname(CAPSULES), 'public-capsules'),
};
const validate = (manifest, options = {}) => validatePublicTargetPayloads(
  manifest, load(WORKLOADS), load(CAPSULES), load(INVENTORIES), load(PRIOR), { ...dirs, ...options },
);

test('verifies the complete RuVector graph local source closure', () => {
  const result = inspectPublicTargetPayloads(MANIFEST, WORKLOADS, CAPSULES, INVENTORIES, PRIOR);
  assert.equal(result.targetPackage, 'ruvector-graph');
  assert.equal(result.selectedBlobCount, 169);
  assert.equal(result.selectedPayloadBytes, 2448546);
  assert.equal(result.completeTargetLocalSourceClosure, true);
});

test('manifest has a stable externally pinnable hash', () => {
  const manifest = original(), expected = sha256(manifest);
  assert.equal(validate(manifest, { expectedHash: expected }).targetPayloadManifestHash, expected);
  assert.throws(() => validate(manifest, { expectedHash: '0'.repeat(64) }), /manifest hash mismatch/);
});

function corrupt(name) {
  const temp = mkdtempSync(join(tmpdir(), 'rsi-target-'));
  cpSync(dirs.targetPayloadDir, temp, { recursive: true });
  const path = join(temp, name), encoded = readFileSync(path, 'utf8');
  writeFileSync(path, `${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}`);
  return { temp, path };
}

test('target payload corruption fails closed', () => {
  const file = original().selection.path.split('/').at(-1), { temp } = corrupt(file);
  try { assert.throws(() => validate(original(), { targetPayloadDir: temp }), /compressed identity/); }
  finally { rmSync(temp, { recursive: true, force: true }); }
});

test('full-tree size-table corruption fails closed', () => {
  const file = original().fullTreeSizing.path.split('/').at(-1), { temp } = corrupt(file);
  try { assert.throws(() => validate(original(), { targetPayloadDir: temp }), /compressed identity/); }
  finally { rmSync(temp, { recursive: true, force: true }); }
});

test('target selection paths and tree identities cannot drift', () => {
  assert.throws(() => validate(mutate(m => { m.selection.baseTree = '0'.repeat(40); })), /selection identity/);
  assert.throws(() => validate(mutate(m => { m.selection.rootFiles.pop(); })), /selection changed/);
  assert.throws(() => validate(mutate(m => { m.selection.cratePrefixes.reverse(); })), /selection changed/);
});

test('both local path-dependency edges are source verified', () => {
  assert.equal(original().selection.pathDependencyEdges.length, 2);
  assert.throws(() => validate(mutate(m => { m.selection.pathDependencyEdges[0].literal = '../other'; })), /dependency binding/);
  assert.throws(() => validate(mutate(m => { m.selection.pathDependencyEdges[1].to = 'crates/other/'; })), /uncovered target path dependency/);
});

test('prior workload inventory and payload manifests remain bound', () => {
  assert.throws(() => validate(mutate(m => { m.workloadManifestHash = '0'.repeat(64); })), /freeze hash mismatch/);
  assert.throws(() => validate(mutate(m => { m.treeInventoryManifestHash = '0'.repeat(64); })), /inventory binding/);
  assert.throws(() => validate(mutate(m => { m.priorPayloadManifestHash = '0'.repeat(64); })), /prior payload binding/);
});

test('payload counts byte totals and hashes cannot drift', () => {
  assert.throws(() => validate(mutate(m => { m.selection.blobCount += 1; })), /totals or selection coverage/);
  assert.throws(() => validate(mutate(m => { m.selection.payloadBytes += 1; })), /totals or selection coverage/);
  assert.throws(() => validate(mutate(m => { m.selection.rawSha256 = '0'.repeat(64); })), /raw identity/);
});

test('full workspace size observations cover every unique inventory blob', () => {
  const result = validate(original());
  assert.equal(result.fullTreeUniqueBlobs, 11997);
  assert.equal(result.fullTreeReferencedBytes, 316496519);
  assert.throws(() => validate(mutate(m => { m.fullTreeSizing.records -= 1; })), /sizing inventory coverage/);
});

test('full-tree size aggregates cannot be rewritten', () => {
  for (const key of ['fullTreeBlobEntries','fullTreeUniqueBlobs','fullTreeReferencedBytes','fullTreeBlobsOverOneMiB','fullTreeBlobsOverTenMiB','fullTreeLargestBlobBytes'])
    assert.throws(() => validate(mutate(m => { m.coverage[key] += 1; })), /sizing aggregates/);
});

test('observed object sizes cannot be relabeled as payload proof', () => {
  assert.throws(() => validate(mutate(m => { m.fullTreeSizing.provenance = 'PAYLOADS_VERIFIED'; })), /sizing boundary/);
  assert.throws(() => validate(mutate(m => { m.coverage.completeWorkspacePayloads = true; })), /coverage boundary/);
});

test('missing runtime dependencies and hidden tests remain explicit', () => {
  for (const key of ['completeCratesIoDependencyClosure','pinnedRustToolchain','hiddenDevelopmentTestsFrozen','offlineExecutable'])
    assert.throws(() => validate(mutate(m => { m.coverage[key] = true; })), /coverage boundary/);
});

test('exposed acquisition cannot become sealed execution or RSI evidence', () => {
  assert.throws(() => validate(mutate(m => { m.proofBoundary.sealedEvaluation = true; })), /proof boundary/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.evaluatorKeys = ['local']; })), /proof boundary/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.candidateExecutionEnabled = true; })), /proof boundary/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.boundedRsiEvidenceAccepted = true; })), /proof boundary/);
  assert.throws(() => executePublicTargetPayload(), /EXECUTION_DISABLED/);
});

test('legacy counters zero entitlements and unknown dollar costs cannot change', () => {
  assert.throws(() => validate(mutate(m => { m.accounting.legacyEpochsConsumed = 0; })), /legacy target accounting/);
  for (const key of ['newNativeFieldCalls','repairCandidateEvaluations','repairProcessStarts','repairWallMs','externalProviderSpendUsd'])
    assert.throws(() => validate(mutate(m => { m.accounting[key] = 1; })), /unapproved target resource/);
  assert.throws(() => validate(mutate(m => { m.accounting.totalAcquisitionUsd = 0; })), /unknown target dollar costs/);
});

test('CLI inspection is read-only and reports all execution gaps', () => {
  const files = [MANIFEST, WORKLOADS, CAPSULES, INVENTORIES, PRIOR];
  const before = files.map(path => readFileSync(path));
  const output = JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL('./public-target-payloads.mjs', import.meta.url)),
    'inspect', MANIFEST, WORKLOADS, CAPSULES, INVENTORIES, PRIOR,
  ], { encoding: 'utf8', timeout: 5000 }));
  assert.equal(output.completeWorkspacePayloads, false);
  assert.equal(output.completeCratesIoDependencyClosure, false);
  assert.equal(output.offlineExecutable, false);
  assert.equal(output.boundedRsiEvidenceAccepted, false);
  assert.deepEqual(files.map(path => readFileSync(path)), before);
});
