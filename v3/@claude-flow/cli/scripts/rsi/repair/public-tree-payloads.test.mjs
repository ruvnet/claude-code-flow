import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executePublicTreePayload, inspectPublicTreePayloads, validatePublicTreePayloads,
} from './public-tree-payloads.mjs';
import { sha256 } from './public-workloads.mjs';

const MANIFEST = fileURLToPath(new URL('./public-tree-payloads.json', import.meta.url));
const WORKLOADS = fileURLToPath(new URL('./public-workloads.json', import.meta.url));
const CAPSULES = fileURLToPath(new URL('./public-capsules.json', import.meta.url));
const INVENTORIES = fileURLToPath(new URL('./public-tree-inventories.json', import.meta.url));
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const original = () => load(MANIFEST);
const mutate = edit => { const value = original(); edit(value); return value; };
const dirs = {
  payloadDir: join(dirname(MANIFEST), 'public-tree-payloads'),
  inventoryDir: join(dirname(INVENTORIES), 'public-tree-inventories'),
  capsuleDir: join(dirname(CAPSULES), 'public-capsules'),
};
const validate = (manifest, options = {}) => validatePublicTreePayloads(
  manifest, load(WORKLOADS), load(CAPSULES), load(INVENTORIES), { ...dirs, ...options },
);

test('verifies every base and fix payload for two compact repositories', () => {
  const result = inspectPublicTreePayloads(MANIFEST, WORKLOADS, CAPSULES, INVENTORIES);
  assert.deepEqual(result.completePayloadRepositories, ['pallets/click', 'sindresorhus/p-limit']);
  assert.equal(result.packedBlobCount, 182);
  assert.equal(result.packedPayloadBytes, 1648424);
});

test('payload manifest has a stable externally pinnable hash', () => {
  const manifest = original(), expected = sha256(manifest);
  assert.equal(validate(manifest, { expectedHash: expected }).payloadManifestHash, expected);
  assert.throws(() => validate(manifest, { expectedHash: '0'.repeat(64) }), /manifest hash mismatch/);
});

test('compressed payload corruption fails closed', () => {
  const temp = mkdtempSync(join(tmpdir(), 'rsi-payloads-'));
  try {
    cpSync(dirs.payloadDir, temp, { recursive: true });
    const record = original().payloads[0], path = join(temp, `${record.baseTree}.payload-pack-v1.gz.b64`);
    const encoded = readFileSync(path, 'utf8');
    writeFileSync(path, `${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}`);
    assert.throws(() => validate(original(), { payloadDir: temp }), /compressed payload identity/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('raw and compressed identities and byte counts cannot drift', () => {
  assert.throws(() => validate(mutate(m => { m.payloads[0].rawSha256 = '0'.repeat(64); })), /raw payload identity/);
  assert.throws(() => validate(mutate(m => { m.payloads[0].compressedSha256 = '0'.repeat(64); })), /compressed payload identity/);
  assert.throws(() => validate(mutate(m => { m.payloads[0].payloadBytes += 1; })), /payload count or byte total/);
});

test('repository and tree provenance cannot drift', () => {
  assert.throws(() => validate(mutate(m => { m.payloads[0].repository = 'other/repo'; })), /undeclared|provenance/);
  assert.throws(() => validate(mutate(m => { m.payloads[0].baseTree = '0'.repeat(40); })), /identity|provenance/);
  assert.throws(() => validate(mutate(m => { m.payloads[0].fixTree = '0'.repeat(40); })), /provenance/);
});

test('workload capsule and inventory manifests remain bound', () => {
  assert.throws(() => validate(mutate(m => { m.workloadManifestHash = '0'.repeat(64); })), /freeze hash mismatch/);
  assert.throws(() => validate(mutate(m => { m.capsuleManifestHash = '0'.repeat(64); })), /capsule binding/);
  assert.throws(() => validate(mutate(m => { m.treeInventoryManifestHash = '0'.repeat(64); })), /inventory binding/);
});

test('missing duplicate and extra payload records reject', () => {
  assert.throws(() => validate(mutate(m => { m.payloads.pop(); })), /repository count/);
  assert.throws(() => validate(mutate(m => { m.payloads[1] = { ...m.payloads[0] }; })), /duplicate or undeclared/);
  assert.throws(() => validate(mutate(m => { m.payloads.push({ ...m.payloads[0] }); })), /repository count/);
});

test('aggregate counts cannot be changed independently', () => {
  assert.throws(() => validate(mutate(m => { m.coverage.packedBlobCount += 1; })), /aggregate totals/);
  assert.throws(() => validate(mutate(m => { m.coverage.packedPayloadBytes += 1; })), /aggregate totals/);
  assert.throws(() => validate(mutate(m => { m.coverage.packCompressedBytes += 1; })), /aggregate totals/);
});

test('RuVector remains an explicit bounded acquisition deferral', () => {
  assert.equal(original().coverage.deferredPayloadRepositories[0].repository, 'ruvnet/RuVector');
  assert.throws(() => validate(mutate(m => { m.coverage.deferredPayloadRepositories = []; })), /coverage declaration/);
  assert.throws(() => validate(mutate(m => { m.coverage.completePayloadRepositories.push('ruvnet/RuVector'); })), /coverage declaration|aggregate/);
});

test('partial payload coverage cannot become complete or executable', () => {
  for (const key of ['completeAllWorkloadPayloads','completeDependencyClosures','offlineExecutable'])
    assert.throws(() => validate(mutate(m => { m.coverage[key] = true; })), /coverage boundary/);
});

test('exposed fixes cannot be relabeled as sealed or independently evaluated', () => {
  assert.throws(() => validate(mutate(m => { m.proofBoundary.fixesExposed = false; })), /proof boundary/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.sealedEvaluation = true; })), /proof boundary/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.evaluatorKeys = ['local']; })), /proof boundary/);
});

test('payload acquisition cannot enable candidate execution or RSI', () => {
  assert.throws(() => validate(mutate(m => { m.proofBoundary.candidateExecutionEnabled = true; })), /proof boundary/);
  assert.throws(() => validate(mutate(m => { m.proofBoundary.boundedRsiEvidenceAccepted = true; })), /proof boundary/);
  assert.throws(() => executePublicTreePayload(), /EXECUTION_DISABLED/);
});

test('legacy counters and zero repair entitlements cannot change', () => {
  assert.throws(() => validate(mutate(m => { m.accounting.legacyNativeFieldCallsReserved = 0; })), /legacy payload accounting/);
  for (const key of ['newNativeFieldCalls','repairCandidateEvaluations','repairProcessStarts','repairWallMs','externalProviderSpendUsd'])
    assert.throws(() => validate(mutate(m => { m.accounting[key] = 1; })), /unapproved payload resource/);
});

test('unknown acquisition and evaluation dollars cannot be forged as zero', () => {
  assert.throws(() => validate(mutate(m => { m.accounting.totalAcquisitionUsd = 0; })), /unknown payload dollar costs/);
  assert.throws(() => validate(mutate(m => { m.accounting.totalEvaluationUsd = 0; })), /unknown payload dollar costs/);
});

test('CLI inspection is read-only and leaves all execution gates closed', () => {
  const files = [MANIFEST, WORKLOADS, CAPSULES, INVENTORIES];
  const before = files.map(path => readFileSync(path));
  const output = JSON.parse(execFileSync(process.execPath, [
    fileURLToPath(new URL('./public-tree-payloads.mjs', import.meta.url)),
    'inspect', MANIFEST, WORKLOADS, CAPSULES, INVENTORIES,
  ], { encoding: 'utf8', timeout: 5000 }));
  assert.equal(output.completeAllWorkloadPayloads, false);
  assert.equal(output.offlineExecutable, false);
  assert.equal(output.candidateExecutionEnabled, false);
  assert.equal(output.boundedRsiEvidenceAccepted, false);
  assert.deepEqual(files.map(path => readFileSync(path)), before);
});
