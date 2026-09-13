#!/usr/bin/env node
/** Offline verification for complete source payloads of selected compact workloads. */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { sha256, validatePublicWorkloads } from './public-workloads.mjs';
import { validatePublicCapsules } from './public-capsules.mjs';
import {
  decodePublicInventoryRecord, gitTreeOid, validatePublicTreeInventories,
} from './public-tree-inventories.mjs';

export const TREE_PAYLOAD_SCHEMA = 'ruflo.public-repair-tree-payloads/v1';
const MAGIC = Buffer.from('RUFLO-GIT-TREE-PAYLOADS-V1\0');
const d40 = /^[a-f0-9]{40}$/, d64 = /^[a-f0-9]{64}$/;
const ok = (v, reason) => { if (!v) throw Error(reason); };
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const exactKeys = (v, expected, reason) => ok(v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...expected].sort().join(','), reason);
const safePath = path => !path.startsWith('/') && !path.includes('\\') &&
  path.split('/').every(p => p && p !== '.' && p !== '..');

export function parsePayloadPack(raw) {
  ok(raw.subarray(0, MAGIC.length).equals(MAGIC), 'payload pack magic');
  const payloads = new Map();
  let offset = MAGIC.length, payloadBytes = 0;
  while (offset < raw.length) {
    ok(raw.length - offset >= 12, 'truncated payload record header');
    const pathBytes = raw.readUInt32BE(offset);
    const contentBig = raw.readBigUInt64BE(offset + 4);
    ok(pathBytes > 0 && pathBytes <= 4096 && contentBig <= 50_000_000n, 'payload record bounds');
    const contentBytes = Number(contentBig);
    offset += 12;
    ok(offset + pathBytes + contentBytes <= raw.length, 'truncated payload record');
    const encodedPath = raw.subarray(offset, offset + pathBytes);
    const path = encodedPath.toString('utf8');
    ok(Buffer.from(path, 'utf8').equals(encodedPath) && safePath(path), 'unsafe or invalid payload path');
    offset += pathBytes;
    const content = raw.subarray(offset, offset + contentBytes);
    offset += contentBytes;
    ok(!payloads.has(path), 'duplicate payload path');
    payloads.set(path, content);
    payloadBytes += content.length;
  }
  return { payloads, payloadBytes };
}

function decodePack(record, payloadDir) {
  exactKeys(record, ['repository','baseTree','fixTree','path','encoding','blobCount','payloadBytes','rawBytes','compressedBytes','rawSha256','compressedSha256'], 'payload record fields');
  ok(d40.test(record.baseTree) && d40.test(record.fixTree) && record.encoding === 'ruflo-payload-pack-v1+gzip+base64' &&
    record.path === `public-tree-payloads/${record.baseTree}.payload-pack-v1.gz.b64`, 'payload record identity');
  const encoded = readFileSync(join(payloadDir, `${record.baseTree}.payload-pack-v1.gz.b64`), 'utf8').replace(/\s/g, '');
  ok(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && Buffer.from(encoded, 'base64').toString('base64') === encoded,
    'payload base64 encoding');
  const compressed = Buffer.from(encoded, 'base64');
  ok(compressed.length === record.compressedBytes && hash('sha256', compressed) === record.compressedSha256,
    'compressed payload identity');
  let raw;
  try { raw = gunzipSync(compressed, { maxOutputLength: 3_000_000 }); }
  catch { throw Error('payload decompression failed'); }
  ok(raw.length === record.rawBytes && hash('sha256', raw) === record.rawSha256, 'raw payload identity');
  const parsed = parsePayloadPack(raw);
  ok(parsed.payloads.size === record.blobCount && parsed.payloadBytes === record.payloadBytes,
    'payload count or byte total');
  return parsed;
}

export function validatePublicTreePayloads(manifest, workloads, capsules, inventories, options = {}) {
  exactKeys(manifest, ['schema','createdAt','workloadManifestHash','capsuleManifestHash','treeInventoryManifestHash','treeInventorySourceCommit','purpose','proofBoundary','coverage','payloads','accounting'], 'payload manifest fields');
  ok(manifest.schema === TREE_PAYLOAD_SCHEMA && Number.isFinite(Date.parse(manifest.createdAt)) &&
    d40.test(manifest.treeInventorySourceCommit) && typeof manifest.purpose === 'string' && manifest.purpose.length >= 100,
    'payload manifest header');
  validatePublicWorkloads(workloads, manifest.workloadManifestHash);
  ok(sha256(capsules) === manifest.capsuleManifestHash, 'payload capsule binding');
  ok(sha256(inventories) === manifest.treeInventoryManifestHash, 'payload inventory binding');
  const capsuleDir = options.capsuleDir;
  const inventoryDir = options.inventoryDir;
  validatePublicCapsules(capsules, workloads, { capsuleDir });
  validatePublicTreeInventories(inventories, workloads, capsules, { inventoryDir, capsuleDir });

  exactKeys(manifest.proofBoundary, ['use','fixesExposed','sealedEvaluation','evaluatorKeys','candidateExecutionEnabled','boundedRsiEvidenceAccepted'], 'payload proof boundary');
  const boundary = manifest.proofBoundary;
  ok(boundary.use === 'EXPOSED_DEVELOPMENT_ACQUISITION_ONLY' && boundary.fixesExposed === true &&
    boundary.sealedEvaluation === false && Array.isArray(boundary.evaluatorKeys) && boundary.evaluatorKeys.length === 0 &&
    boundary.candidateExecutionEnabled === false && boundary.boundedRsiEvidenceAccepted === false,
    'payload proof boundary changed');

  exactKeys(manifest.coverage, ['completePayloadRepositories','deferredPayloadRepositories','completeBaseAndFixTreePayloadsForCoveredRepositories','completeAllWorkloadPayloads','completeDependencyClosures','offlineExecutable','packedBlobCount','packedPayloadBytes','packRawBytes','packCompressedBytes'], 'payload coverage fields');
  const coverage = manifest.coverage;
  ok(coverage.completeBaseAndFixTreePayloadsForCoveredRepositories === true &&
    coverage.completeAllWorkloadPayloads === false && coverage.completeDependencyClosures === false &&
    coverage.offlineExecutable === false, 'payload coverage boundary changed');
  ok(Array.isArray(coverage.completePayloadRepositories) && new Set(coverage.completePayloadRepositories).size === 2 &&
    Array.isArray(coverage.deferredPayloadRepositories) && coverage.deferredPayloadRepositories.length === 1 &&
    coverage.deferredPayloadRepositories[0].repository === 'ruvnet/RuVector' &&
    coverage.deferredPayloadRepositories[0].reason === 'LARGE_TREE_REQUIRES_SEPARATE_BOUNDED_ACQUISITION',
    'payload coverage declaration');

  exactKeys(manifest.accounting, ['legacyLedgerHead','legacyNativeFieldCallsReserved','legacyEpochsConsumed','newNativeFieldCalls','repairCandidateEvaluations','repairProcessStarts','repairWallMs','externalProviderSpendUsd','totalAcquisitionUsd','totalEvaluationUsd'], 'payload accounting fields');
  ok(d64.test(manifest.accounting.legacyLedgerHead) && manifest.accounting.legacyNativeFieldCallsReserved === 209784 &&
    manifest.accounting.legacyEpochsConsumed === 7, 'legacy payload accounting changed');
  for (const key of ['newNativeFieldCalls','repairCandidateEvaluations','repairProcessStarts','repairWallMs','externalProviderSpendUsd'])
    ok(manifest.accounting[key] === 0, `unapproved payload resource use: ${key}`);
  ok(manifest.accounting.totalAcquisitionUsd === null && manifest.accounting.totalEvaluationUsd === null,
    'unknown payload dollar costs must remain explicit');

  ok(Array.isArray(manifest.payloads) && manifest.payloads.length === 2, 'payload repository count');
  const capsuleBlobs = new Set(capsules.blobs.map(record => record.blob));
  const payloadDir = options.payloadDir ?? join(dirname(options.manifestPath ?? new URL('./public-tree-payloads.json', import.meta.url).pathname), 'public-tree-payloads');
  const seen = new Set();
  let packedBlobCount = 0, packedPayloadBytes = 0, packRawBytes = 0, packCompressedBytes = 0;
  for (const record of manifest.payloads) {
    ok(!seen.has(record.repository) && coverage.completePayloadRepositories.includes(record.repository),
      'duplicate or undeclared payload repository');
    seen.add(record.repository);
    const workload = workloads.workloads.find(item => item.repository === record.repository);
    const inventoryRecord = inventories.inventories.find(item => item.repository === record.repository);
    ok(workload && inventoryRecord && record.baseTree === workload.source.baseTree &&
      record.fixTree === workload.source.fixTree, 'payload workload provenance');
    const entries = decodePublicInventoryRecord(inventoryRecord, inventoryDir);
    ok(gitTreeOid(entries) === record.baseTree, 'payload base tree identity');
    const packed = decodePack(record, payloadDir);
    const expected = [...entries].filter(([, value]) => value.type === 'blob');
    ok(packed.payloads.size === expected.length, 'incomplete base payload set');
    for (const [path, entry] of expected) {
      const bytes = packed.payloads.get(path);
      ok(bytes && gitBlob(bytes) === entry.oid, 'missing or mismatched base payload');
    }
    for (const changed of workload.changedFiles) {
      ok(capsuleBlobs.has(changed.fixBlob), 'missing fix payload capsule');
      const prior = entries.get(changed.path);
      ok(prior?.oid === changed.baseBlob, 'payload changed-base mismatch');
      entries.set(changed.path, { ...prior, oid: changed.fixBlob });
    }
    ok(gitTreeOid(entries) === record.fixTree, 'payload fix tree identity');
    packedBlobCount += record.blobCount;
    packedPayloadBytes += record.payloadBytes;
    packRawBytes += record.rawBytes;
    packCompressedBytes += record.compressedBytes;
  }
  ok(seen.size === coverage.completePayloadRepositories.length &&
    packedBlobCount === coverage.packedBlobCount && packedPayloadBytes === coverage.packedPayloadBytes &&
    packRawBytes === coverage.packRawBytes && packCompressedBytes === coverage.packCompressedBytes,
    'payload aggregate totals');
  const payloadManifestHash = sha256(manifest);
  if (options.expectedHash !== undefined)
    ok(d64.test(options.expectedHash) && payloadManifestHash === options.expectedHash, 'payload manifest hash mismatch');
  return { schema: 'ruflo.public-repair-tree-payload-check/v1', payloadManifestHash,
    completePayloadRepositories: [...seen].sort(), packedBlobCount, packedPayloadBytes,
    completeAllWorkloadPayloads: false, completeDependencyClosures: false, offlineExecutable: false,
    candidateExecutionEnabled: false, boundedRsiEvidenceAccepted: false };
}

export function inspectPublicTreePayloads(manifestPath, workloadPath, capsulePath, inventoryPath, expectedHash) {
  const load = path => JSON.parse(readFileSync(path, 'utf8'));
  const base = dirname(manifestPath);
  return validatePublicTreePayloads(load(manifestPath), load(workloadPath), load(capsulePath), load(inventoryPath), {
    manifestPath, expectedHash, payloadDir: join(base, 'public-tree-payloads'),
    inventoryDir: join(dirname(inventoryPath), 'public-tree-inventories'),
    capsuleDir: join(dirname(capsulePath), 'public-capsules'),
  });
}

export function executePublicTreePayload() {
  throw Error('PUBLIC_TREE_PAYLOAD_EXECUTION_DISABLED: RuVector payloads, dependency closures, pinned toolchains, hidden tests and resource authorization remain missing');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, manifest, workloads, capsules, inventories, expected, extra] = process.argv.slice(2);
    if (command !== 'inspect' || !manifest || !workloads || !capsules || !inventories || extra)
      throw Error('usage: public-tree-payloads.mjs inspect MANIFEST WORKLOADS CAPSULES INVENTORIES [HASH]');
    console.log(JSON.stringify(inspectPublicTreePayloads(resolve(manifest), resolve(workloads), resolve(capsules), resolve(inventories), expected), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
