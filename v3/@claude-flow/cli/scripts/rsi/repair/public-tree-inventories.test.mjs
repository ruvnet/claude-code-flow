import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executePublicTreeInventory, inspectPublicTreeInventories, validatePublicTreeInventories } from './public-tree-inventories.mjs';
import { sha256 } from './public-workloads.mjs';

const MANIFEST = fileURLToPath(new URL('./public-tree-inventories.json', import.meta.url));
const WORKLOADS = fileURLToPath(new URL('./public-workloads.json', import.meta.url));
const CAPSULES = fileURLToPath(new URL('./public-capsules.json', import.meta.url));
const load = p => JSON.parse(readFileSync(p, 'utf8'));
const original = () => load(MANIFEST);
const mutate = edit => { const value = original(); edit(value); return value; };
const validate = (manifest, options = {}) => validatePublicTreeInventories(manifest, load(WORKLOADS), load(CAPSULES), {
  inventoryDir: options.inventoryDir ?? join(dirname(MANIFEST), 'public-tree-inventories'),
  capsuleDir: join(dirname(CAPSULES), 'public-capsules'),
  expectedHash: options.expectedHash,
});

test('reconstructs all three public base and fix Git trees offline', () => {
  const result = inspectPublicTreeInventories(MANIFEST, WORKLOADS, CAPSULES);
  assert.equal(result.repositoriesVerified, 3);
  assert.equal(result.inventoryEntryCount, 12354);
  assert.equal(result.baseTreesVerified, true);
  assert.equal(result.fixTreesReconstructed, true);
});

test('manifest has a stable externally pinnable hash', () => {
  const manifest = original(), expected = sha256(manifest);
  assert.equal(validate(manifest, { expectedHash: expected }).inventoryManifestHash, expected);
  assert.throws(() => validate(manifest, { expectedHash: '0'.repeat(64) }), /manifest hash mismatch/);
});

test('compressed and raw inventory corruption fails closed', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rsi-trees-'));
  try {
    cpSync(join(dirname(MANIFEST), 'public-tree-inventories'), temp, { recursive: true });
    const record = original().inventories[1], path = join(temp, `${record.baseTree}.ls-tree.gz.b64`);
    const encoded = readFileSync(path, 'utf8');
    writeFileSync(path, `${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}`);
    assert.throws(() => validate(original(), { inventoryDir: temp }), /compressed inventory identity/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('base and fix tree identities cannot drift', () => {
  assert.throws(() => validate(mutate(m => { m.inventories[0].baseTree = '0'.repeat(40); })), /encoding path|provenance/);
  assert.throws(() => validate(mutate(m => { m.inventories[0].fixTree = '0'.repeat(40); })), /provenance/);
});

test('commit and repository provenance cannot drift', () => {
  assert.throws(() => validate(mutate(m => { m.inventories[0].baseCommit = '0'.repeat(40); })), /provenance/);
  assert.throws(() => validate(mutate(m => { m.inventories[0].repository = 'other/repo'; })), /repository coverage/);
});

test('workload and prior capsule manifests remain bound', () => {
  assert.throws(() => validate(mutate(m => { m.workloadManifestHash = '0'.repeat(64); })), /freeze hash mismatch/);
  assert.throws(() => validate(mutate(m => { m.capsuleManifestHash = '0'.repeat(64); })), /capsule manifest binding/);
});

test('missing, duplicate and extra repository inventory records reject', () => {
  assert.throws(() => validate(mutate(m => { m.inventories.pop(); })), /workload coverage/);
  assert.throws(() => validate(mutate(m => { m.inventories[2] = { ...m.inventories[0] }; })), /repository coverage/);
  assert.throws(() => validate(mutate(m => { m.inventories.push({ ...m.inventories[0] }); })), /workload coverage/);
});

test('entry counts and aggregate byte totals are verified', () => {
  assert.throws(() => validate(mutate(m => { m.inventories[1].entryCount += 1; })), /entry count/);
  assert.throws(() => validate(mutate(m => { m.coverage.inventoryRawBytes += 1; })), /coverage totals/);
  assert.throws(() => validate(mutate(m => { m.coverage.inventoryCompressedBytes += 1; })), /coverage totals/);
});

test('known public inventories cannot become sealed evaluation', () => {
  assert.throws(() => validate(mutate(m => { m.proofBoundary.fixesExposed = false; })), /proof boundary/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.sealedEvaluation = true; })), /proof boundary/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.evaluatorKeys = ['local']; })), /proof boundary/);
});

test('inventory coverage cannot become payload or dependency coverage', () => {
  for (const key of ['completeSourceTreePayloads', 'completeDependencyClosures', 'offlineExecutable'])
    assert.throws(() => validate(mutate(m => { m.coverage[key] = true; })), /acquisition boundary/);
});

test('tree inventory cannot enable candidate execution or RSI acceptance', () => {
  assert.throws(() => validate(mutate(m => { m.proofBoundary.candidateExecutionEnabled = true; })), /proof boundary/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.boundedRsiEvidenceAccepted = true; })), /proof boundary/);
  assert.throws(() => executePublicTreeInventory(), /EXECUTION_DISABLED/);
});

test('legacy mission counters and zero repair entitlements cannot change', () => {
  assert.throws(() => validate(mutate(m => { m.accounting.legacyNativeFieldCallsReserved = 0; })), /legacy tree accounting/);
  assert.throws(() => validate(mutate(m => { m.accounting.legacyEpochsConsumed = 0; })), /legacy tree accounting/);
  for (const key of ['newNativeFieldCalls','repairCandidateEvaluations','repairProcessStarts','repairWallMs','externalProviderSpendUsd'])
    assert.throws(() => validate(mutate(m => { m.accounting[key] = 1; })), /unapproved tree resource/);
});

test('unknown acquisition and evaluation dollars cannot be forged as zero', () => {
  assert.throws(() => validate(mutate(m => { m.accounting.totalAcquisitionUsd = 0; })), /unknown tree dollar costs/);
  assert.throws(() => validate(mutate(m => { m.accounting.totalEvaluationUsd = 0; })), /unknown tree dollar costs/);
});

test('decompression is bounded and malformed data rejects', () => {
  assert.throws(() => validate(mutate(m => { m.inventories[1].compressedSha256 = '0'.repeat(64); })), /compressed inventory identity/);
  assert.throws(() => validate(mutate(m => { m.inventories[1].rawSha256 = '0'.repeat(64); })), /raw inventory identity/);
});

test('CLI inspection is read-only and reports all execution gates closed', () => {
  const before = [MANIFEST, WORKLOADS, CAPSULES].map(path => readFileSync(path));
  const output = JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL('./public-tree-inventories.mjs', import.meta.url)),
    'inspect', MANIFEST, WORKLOADS, CAPSULES,
  ], { encoding: 'utf8', timeout: 5000 }));
  assert.equal(output.offlineExecutable, false);
  assert.equal(output.candidateExecutionEnabled, false);
  assert.equal(output.boundedRsiEvidenceAccepted, false);
  assert.deepEqual([MANIFEST, WORKLOADS, CAPSULES].map(path => readFileSync(path)), before);
});
