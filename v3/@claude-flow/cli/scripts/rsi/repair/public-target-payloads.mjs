#!/usr/bin/env node
/** Offline verifier for the bounded RuVector graph local-source payload closure. */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { sha256, validatePublicWorkloads } from './public-workloads.mjs';
import { validatePublicCapsules } from './public-capsules.mjs';
import { decodePublicInventoryRecord, validatePublicTreeInventories } from './public-tree-inventories.mjs';
import { parsePayloadPack, validatePublicTreePayloads } from './public-tree-payloads.mjs';

export const TARGET_PAYLOAD_SCHEMA = 'ruflo.public-repair-target-payloads/v1';
const d40 = /^[a-f0-9]{40}$/, d64 = /^[a-f0-9]{64}$/;
const ok = (value, reason) => { if (!value) throw Error(reason); };
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const exactKeys = (v, expected, reason) => ok(v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...expected].sort().join(','), reason);

function decodeBase64Gzip(path, compressedBytes, compressedSha256, rawBytes, rawSha256, maxOutputLength) {
  const encoded = readFileSync(path, 'utf8').replace(/\s/g, '');
  ok(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && Buffer.from(encoded, 'base64').toString('base64') === encoded,
    'target payload base64');
  const compressed = Buffer.from(encoded, 'base64');
  ok(compressed.length === compressedBytes && hash('sha256', compressed) === compressedSha256,
    'target payload compressed identity');
  let raw;
  try { raw = gunzipSync(compressed, { maxOutputLength }); }
  catch { throw Error('target payload decompression failed'); }
  ok(raw.length === rawBytes && hash('sha256', raw) === rawSha256, 'target payload raw identity');
  return raw;
}

function parseSizeTable(raw) {
  const records = raw.toString('utf8').split('\0');
  ok(records.pop() === '', 'size table termination');
  const sizes = new Map();
  let previous = '';
  for (const record of records) {
    const match = /^([a-f0-9]{40}) ([0-9]+)$/.exec(record);
    ok(match, 'size table record');
    const size = Number(match[2]);
    ok(Number.isSafeInteger(size) && size >= 0 && match[1] > previous && !sizes.has(match[1]), 'size table ordering');
    previous = match[1];
    sizes.set(match[1], size);
  }
  return sizes;
}

export function validatePublicTargetPayloads(manifest, workloads, capsules, inventories, priorPayloads, options = {}) {
  exactKeys(manifest, ['schema','createdAt','workloadManifestHash','treeInventoryManifestHash','priorPayloadManifestHash','priorPayloadSourceCommit','purpose','proofBoundary','selection','fullTreeSizing','coverage','accounting'], 'target manifest fields');
  ok(manifest.schema === TARGET_PAYLOAD_SCHEMA && Number.isFinite(Date.parse(manifest.createdAt)) &&
    d40.test(manifest.priorPayloadSourceCommit) && typeof manifest.purpose === 'string' && manifest.purpose.length >= 100,
    'target manifest header');
  validatePublicWorkloads(workloads, manifest.workloadManifestHash);
  ok(sha256(inventories) === manifest.treeInventoryManifestHash, 'target inventory binding');
  ok(sha256(priorPayloads) === manifest.priorPayloadManifestHash, 'prior payload binding');
  const capsuleDir = options.capsuleDir, inventoryDir = options.inventoryDir;
  validatePublicCapsules(capsules, workloads, { capsuleDir });
  validatePublicTreeInventories(inventories, workloads, capsules, { inventoryDir, capsuleDir });
  validatePublicTreePayloads(priorPayloads, workloads, capsules, inventories, {
    payloadDir: options.priorPayloadDir, inventoryDir, capsuleDir,
  });

  exactKeys(manifest.proofBoundary, ['use','fixesExposed','sealedEvaluation','evaluatorKeys','candidateExecutionEnabled','boundedRsiEvidenceAccepted'], 'target proof boundary');
  const boundary = manifest.proofBoundary;
  ok(boundary.use === 'EXPOSED_DEVELOPMENT_ACQUISITION_ONLY' && boundary.fixesExposed === true &&
    boundary.sealedEvaluation === false && Array.isArray(boundary.evaluatorKeys) && boundary.evaluatorKeys.length === 0 &&
    boundary.candidateExecutionEnabled === false && boundary.boundedRsiEvidenceAccepted === false,
    'target proof boundary changed');

  exactKeys(manifest.selection, ['repository','baseTree','fixTree','targetPackage','rootFiles','cratePrefixes','pathDependencyEdges','path','encoding','blobCount','payloadBytes','rawBytes','compressedBytes','rawSha256','compressedSha256'], 'target selection fields');
  const selection = manifest.selection;
  ok(selection.repository === 'ruvnet/RuVector' && selection.targetPackage === 'ruvector-graph' &&
    selection.baseTree === 'c342b626d419ccc782850fd7bf918252f3c5b0d4' &&
    selection.fixTree === 'ddaa12ef4bb8447d4c2758479ae94d9e62f6e35f', 'target selection identity');
  ok(JSON.stringify(selection.rootFiles) === JSON.stringify(['.cargo/audit.toml','.cargo/config.toml','Cargo.lock','Cargo.toml']) &&
    JSON.stringify(selection.cratePrefixes) === JSON.stringify(['crates/ruvector-core/','crates/ruvector-graph/','crates/ruvector-turboquant/']),
    'target selection changed');
  ok(selection.encoding === 'ruflo-payload-pack-v1+gzip+base64' &&
    selection.path === `public-target-payloads/${selection.baseTree}.ruvector-graph-local-closure.payload-pack-v1.gz.b64`,
    'target payload encoding path');
  ok(d64.test(selection.rawSha256) && d64.test(selection.compressedSha256), 'target payload digests');

  exactKeys(manifest.fullTreeSizing, ['path','encoding','records','rawBytes','compressedBytes','rawSha256','compressedSha256','provenance'], 'full tree sizing fields');
  const sizing = manifest.fullTreeSizing;
  ok(sizing.path === `public-target-payloads/${selection.baseTree}.unique-blob-sizes.gz.b64` &&
    sizing.encoding === 'oid-size-nul+gzip+base64' &&
    sizing.provenance === 'REMOTE_GIT_OBJECT_DATABASE_OBSERVATION_NOT_PAYLOAD_PROOF',
    'full tree sizing boundary');

  exactKeys(manifest.coverage, ['completeTargetLocalSourceClosure','changedFixPayloadPresent','completeWorkspacePayloads','completeCratesIoDependencyClosure','pinnedRustToolchain','hiddenDevelopmentTestsFrozen','offlineExecutable','fullTreeBlobEntries','fullTreeUniqueBlobs','fullTreeReferencedBytes','fullTreeBlobsOverOneMiB','fullTreeBlobsOverTenMiB','fullTreeLargestBlobBytes','fullWorkspaceDeferralReason'], 'target coverage fields');
  const coverage = manifest.coverage;
  ok(coverage.completeTargetLocalSourceClosure === true && coverage.changedFixPayloadPresent === true &&
    coverage.completeWorkspacePayloads === false && coverage.completeCratesIoDependencyClosure === false &&
    coverage.pinnedRustToolchain === false && coverage.hiddenDevelopmentTestsFrozen === false &&
    coverage.offlineExecutable === false &&
    coverage.fullWorkspaceDeferralReason === '316496519_REFERENCED_BYTES_REQUIRES_SEPARATE_STORAGE_AND_ACQUISITION_APPROVAL',
    'target coverage boundary changed');

  exactKeys(manifest.accounting, ['legacyLedgerHead','legacyNativeFieldCallsReserved','legacyEpochsConsumed','newNativeFieldCalls','repairCandidateEvaluations','repairProcessStarts','repairWallMs','externalProviderSpendUsd','totalAcquisitionUsd','totalEvaluationUsd'], 'target accounting fields');
  ok(d64.test(manifest.accounting.legacyLedgerHead) && manifest.accounting.legacyNativeFieldCallsReserved === 209784 &&
    manifest.accounting.legacyEpochsConsumed === 7, 'legacy target accounting changed');
  for (const key of ['newNativeFieldCalls','repairCandidateEvaluations','repairProcessStarts','repairWallMs','externalProviderSpendUsd'])
    ok(manifest.accounting[key] === 0, `unapproved target resource use: ${key}`);
  ok(manifest.accounting.totalAcquisitionUsd === null && manifest.accounting.totalEvaluationUsd === null,
    'unknown target dollar costs must remain explicit');

  const workload = workloads.workloads.find(item => item.repository === selection.repository);
  const inventoryRecord = inventories.inventories.find(item => item.repository === selection.repository);
  ok(workload && inventoryRecord && workload.source.baseTree === selection.baseTree &&
    workload.source.fixTree === selection.fixTree, 'target workload provenance');
  const entries = decodePublicInventoryRecord(inventoryRecord, inventoryDir);
  const selectedEntries = [...entries].filter(([path, entry]) => entry.type === 'blob' &&
    (selection.rootFiles.includes(path) || selection.cratePrefixes.some(prefix => path.startsWith(prefix))));
  const targetDir = options.targetPayloadDir;
  const raw = decodeBase64Gzip(join(targetDir, selection.path.split('/').at(-1)),
    selection.compressedBytes, selection.compressedSha256, selection.rawBytes, selection.rawSha256, 4_000_000);
  const packed = parsePayloadPack(raw);
  ok(packed.payloads.size === selection.blobCount && packed.payloadBytes === selection.payloadBytes &&
    selectedEntries.length === selection.blobCount, 'target payload totals or selection coverage');
  for (const [path, entry] of selectedEntries) {
    const bytes = packed.payloads.get(path);
    ok(bytes && gitBlob(bytes) === entry.oid, 'missing or mismatched target payload');
  }
  ok(packed.payloads.size === selectedEntries.length, 'unexpected target payload');
  exactKeys(selection.pathDependencyEdges[0], ['from','to','literal'], 'target path dependency edge');
  exactKeys(selection.pathDependencyEdges[1], ['from','to','literal'], 'target path dependency edge');
  for (const edge of selection.pathDependencyEdges) {
    ok(selection.cratePrefixes.includes(edge.to), 'uncovered target path dependency');
    const manifestBytes = packed.payloads.get(edge.from);
    ok(manifestBytes && manifestBytes.toString('utf8').includes(`path = "${edge.literal}"`),
      'target path dependency binding');
  }
  const fix = workload.changedFiles[0];
  ok(fix.path.startsWith('crates/ruvector-graph/') && capsules.blobs.some(record => record.blob === fix.fixBlob),
    'target fix payload missing');

  const sizeRaw = decodeBase64Gzip(join(targetDir, sizing.path.split('/').at(-1)),
    sizing.compressedBytes, sizing.compressedSha256, sizing.rawBytes, sizing.rawSha256, 1_000_000);
  const sizes = parseSizeTable(sizeRaw);
  const inventoryBlobOids = [...entries.values()].filter(entry => entry.type === 'blob').map(entry => entry.oid);
  const uniqueInventoryOids = new Set(inventoryBlobOids);
  ok(sizes.size === sizing.records && sizes.size === uniqueInventoryOids.size &&
    [...uniqueInventoryOids].every(oid => sizes.has(oid)), 'full tree sizing inventory coverage');
  const observed = [...sizes.values()];
  ok(coverage.fullTreeBlobEntries === inventoryBlobOids.length &&
    coverage.fullTreeUniqueBlobs === sizes.size &&
    coverage.fullTreeReferencedBytes === observed.reduce((a, b) => a + b, 0) &&
    coverage.fullTreeBlobsOverOneMiB === observed.filter(v => v > 1048576).length &&
    coverage.fullTreeBlobsOverTenMiB === observed.filter(v => v > 10485760).length &&
    coverage.fullTreeLargestBlobBytes === Math.max(...observed), 'full tree sizing aggregates');

  const targetPayloadManifestHash = sha256(manifest);
  if (options.expectedHash !== undefined)
    ok(d64.test(options.expectedHash) && targetPayloadManifestHash === options.expectedHash, 'target manifest hash mismatch');
  return { schema: 'ruflo.public-repair-target-payload-check/v1', targetPayloadManifestHash,
    targetPackage: selection.targetPackage, selectedBlobCount: packed.payloads.size,
    selectedPayloadBytes: packed.payloadBytes, fullTreeUniqueBlobs: sizes.size,
    fullTreeReferencedBytes: coverage.fullTreeReferencedBytes, completeTargetLocalSourceClosure: true,
    completeWorkspacePayloads: false, completeCratesIoDependencyClosure: false, pinnedRustToolchain: false,
    hiddenDevelopmentTestsFrozen: false, offlineExecutable: false, candidateExecutionEnabled: false,
    boundedRsiEvidenceAccepted: false };
}

export function inspectPublicTargetPayloads(manifestPath, workloadPath, capsulePath, inventoryPath, priorPayloadPath, expectedHash) {
  const load = path => JSON.parse(readFileSync(path, 'utf8'));
  const base = dirname(manifestPath);
  return validatePublicTargetPayloads(load(manifestPath), load(workloadPath), load(capsulePath), load(inventoryPath), load(priorPayloadPath), {
    expectedHash, targetPayloadDir: join(base, 'public-target-payloads'),
    priorPayloadDir: join(dirname(priorPayloadPath), 'public-tree-payloads'),
    inventoryDir: join(dirname(inventoryPath), 'public-tree-inventories'),
    capsuleDir: join(dirname(capsulePath), 'public-capsules'),
  });
}

export function executePublicTargetPayload() {
  throw Error('PUBLIC_TARGET_PAYLOAD_EXECUTION_DISABLED: full workspace, crates.io closure, pinned Rust, hidden tests, sandbox and resource authorization remain missing');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, manifest, workloads, capsules, inventories, priorPayloads, expected, extra] = process.argv.slice(2);
    if (command !== 'inspect' || !manifest || !workloads || !capsules || !inventories || !priorPayloads || extra)
      throw Error('usage: public-target-payloads.mjs inspect MANIFEST WORKLOADS CAPSULES INVENTORIES PRIOR_PAYLOADS [HASH]');
    console.log(JSON.stringify(inspectPublicTargetPayloads(resolve(manifest), resolve(workloads), resolve(capsules), resolve(inventories), resolve(priorPayloads), expected), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
