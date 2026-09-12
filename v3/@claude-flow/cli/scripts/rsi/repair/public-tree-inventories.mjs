#!/usr/bin/env node
/** Deterministic offline Git tree inventory verifier. No candidate execution path. */
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { sha256, validatePublicWorkloads } from './public-workloads.mjs';
import { validatePublicCapsules } from './public-capsules.mjs';

export const TREE_INVENTORY_SCHEMA = 'ruflo.public-repair-tree-inventories/v1';
const d40 = /^[a-f0-9]{40}$/, d64 = /^[a-f0-9]{64}$/;
const ok = (v, reason) => { if (!v) throw Error(reason); };
const hash = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const keys = (v, expected, reason) => ok(v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...expected].sort().join(','), reason);

function parseInventory(raw) {
  const records = raw.toString('utf8').split('\0');
  ok(records.pop() === '', 'inventory must be NUL terminated');
  const entries = new Map();
  for (const record of records) {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40})\t(.+)$/.exec(record);
    ok(match, 'invalid ls-tree record');
    const [, mode, type, oid, path] = match;
    ok(!path.startsWith('/') && !path.includes('\\') && path.split('/').every(p => p && p !== '.' && p !== '..'),
      'unsafe inventory path');
    ok((mode === '160000') === (type === 'commit'), 'invalid inventory object type');
    ok(!entries.has(path), 'duplicate inventory path');
    entries.set(path, { mode, type, oid });
  }
  return entries;
}

function treeOid(entries) {
  const root = { children: new Map() };
  for (const [path, leaf] of entries) {
    let node = root;
    const parts = path.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const existing = node.children.get(parts[i]);
      ok(!existing || existing.children, 'file-directory collision');
      if (!existing) node.children.set(parts[i], { children: new Map() });
      node = node.children.get(parts[i]);
    }
    ok(!node.children.has(parts.at(-1)), 'duplicate tree entry');
    node.children.set(parts.at(-1), leaf);
  }
  const digest = node => {
    const material = [...node.children].map(([name, value]) => {
      const directory = Boolean(value.children);
      return { name, value, directory, sort: Buffer.from(directory ? name + '/' : name) };
    }).sort((a, b) => Buffer.compare(a.sort, b.sort)).map(({ name, value, directory }) => {
      const mode = directory ? '40000' : value.mode;
      const oid = directory ? digest(value) : value.oid;
      return Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(oid, 'hex')]);
    });
    const body = Buffer.concat(material);
    return hash('sha1', Buffer.concat([Buffer.from(`tree ${body.length}\0`), body]));
  };
  return digest(root);
}

function decode(record, inventoryDir) {
  keys(record, ['repository','baseCommit','baseTree','fixCommit','fixTree','path','encoding','entryCount','rawBytes','compressedBytes','rawSha256','compressedSha256'], 'inventory record fields');
  ok(d40.test(record.baseCommit) && d40.test(record.baseTree) && d40.test(record.fixCommit) && d40.test(record.fixTree),
    'inventory Git identity');
  ok(record.encoding === 'gzip+base64' && record.path === `public-tree-inventories/${record.baseTree}.ls-tree.gz.b64`,
    'inventory encoding path');
  const encoded = readFileSync(join(inventoryDir, `${record.baseTree}.ls-tree.gz.b64`), 'utf8').replace(/\s/g, '');
  ok(/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) && Buffer.from(encoded, 'base64').toString('base64') === encoded,
    'inventory base64 encoding');
  const compressed = Buffer.from(encoded, 'base64');
  ok(compressed.length === record.compressedBytes && hash('sha256', compressed) === record.compressedSha256,
    'compressed inventory identity');
  let raw;
  try { raw = gunzipSync(compressed, { maxOutputLength: 2_000_000 }); } catch { throw Error('inventory decompression failed'); }
  ok(raw.length === record.rawBytes && hash('sha256', raw) === record.rawSha256, 'raw inventory identity');
  const entries = parseInventory(raw);
  ok(entries.size === record.entryCount, 'inventory entry count');
  return entries;
}

export function validatePublicTreeInventories(manifest, workloads, capsules, options = {}) {
  keys(manifest, ['schema','createdAt','workloadManifestHash','workloadManifestSourceCommit','capsuleManifestHash','capsuleManifestSourceCommit','purpose','proofBoundary','coverage','inventories','accounting'], 'tree inventory manifest fields');
  ok(manifest.schema === TREE_INVENTORY_SCHEMA && Number.isFinite(Date.parse(manifest.createdAt)) &&
    d40.test(manifest.workloadManifestSourceCommit) && d40.test(manifest.capsuleManifestSourceCommit) &&
    typeof manifest.purpose === 'string' && manifest.purpose.length >= 80, 'tree inventory header');
  validatePublicWorkloads(workloads, manifest.workloadManifestHash);
  ok(sha256(capsules) === manifest.capsuleManifestHash, 'capsule manifest binding');
  validatePublicCapsules(capsules, workloads, { capsuleDir: options.capsuleDir });
  keys(manifest.proofBoundary, ['use','fixesExposed','sealedEvaluation','evaluatorKeys','candidateExecutionEnabled','boundedRsiEvidenceAccepted'], 'tree proof boundary');
  ok(manifest.proofBoundary.use === 'EXPOSED_DEVELOPMENT_ACQUISITION_ONLY' && manifest.proofBoundary.fixesExposed === true &&
    manifest.proofBoundary.sealedEvaluation === false && Array.isArray(manifest.proofBoundary.evaluatorKeys) &&
    manifest.proofBoundary.evaluatorKeys.length === 0 && manifest.proofBoundary.candidateExecutionEnabled === false &&
    manifest.proofBoundary.boundedRsiEvidenceAccepted === false, 'tree proof boundary changed');
  keys(manifest.coverage, ['completeBaseTreeInventories','fixTreesReconstructedFromFrozenChanges','completeSourceTreePayloads','completeDependencyClosures','offlineExecutable','inventoryEntryCount','inventoryRawBytes','inventoryCompressedBytes'], 'tree coverage fields');
  ok(manifest.coverage.completeBaseTreeInventories === true && manifest.coverage.fixTreesReconstructedFromFrozenChanges === true &&
    manifest.coverage.completeSourceTreePayloads === false && manifest.coverage.completeDependencyClosures === false &&
    manifest.coverage.offlineExecutable === false, 'inventory acquisition boundary changed');
  keys(manifest.accounting, ['legacyLedgerHead','legacyNativeFieldCallsReserved','legacyEpochsConsumed','newNativeFieldCalls','repairCandidateEvaluations','repairProcessStarts','repairWallMs','externalProviderSpendUsd','totalAcquisitionUsd','totalEvaluationUsd'], 'tree accounting fields');
  ok(d64.test(manifest.accounting.legacyLedgerHead) && manifest.accounting.legacyNativeFieldCallsReserved === 209784 &&
    manifest.accounting.legacyEpochsConsumed === 7, 'legacy tree accounting changed');
  for (const k of ['newNativeFieldCalls','repairCandidateEvaluations','repairProcessStarts','repairWallMs','externalProviderSpendUsd'])
    ok(manifest.accounting[k] === 0, `unapproved tree resource use: ${k}`);
  ok(manifest.accounting.totalAcquisitionUsd === null && manifest.accounting.totalEvaluationUsd === null,
    'unknown tree dollar costs must remain explicit');

  ok(Array.isArray(manifest.inventories) && manifest.inventories.length === workloads.workloads.length, 'inventory workload coverage');
  const inventoryDir = options.inventoryDir ?? join(dirname(options.manifestPath ?? new URL('./public-tree-inventories.json', import.meta.url).pathname), 'public-tree-inventories');
  const seen = new Set(); let entryCount = 0, rawBytes = 0, compressedBytes = 0;
  for (const workload of workloads.workloads) {
    const matches = manifest.inventories.filter(r => r.repository === workload.repository);
    ok(matches.length === 1, 'inventory repository coverage');
    const record = matches[0];
    ok(!seen.has(record.baseTree), 'duplicate inventory tree');
    seen.add(record.baseTree);
    ok(record.baseCommit === workload.source.baseCommit && record.baseTree === workload.source.baseTree &&
      record.fixCommit === workload.source.fixCommit && record.fixTree === workload.source.fixTree,
      'inventory workload provenance');
    const entries = decode(record, inventoryDir);
    ok(treeOid(entries) === record.baseTree, 'base tree reconstruction mismatch');
    for (const changed of workload.changedFiles) {
      const prior = entries.get(changed.path);
      ok(prior?.oid === changed.baseBlob && prior.type === 'blob', 'changed base blob not in inventory');
      entries.set(changed.path, { ...prior, oid: changed.fixBlob });
    }
    ok(treeOid(entries) === record.fixTree, 'fix tree reconstruction mismatch');
    entryCount += record.entryCount; rawBytes += record.rawBytes; compressedBytes += record.compressedBytes;
  }
  ok(entryCount === manifest.coverage.inventoryEntryCount && rawBytes === manifest.coverage.inventoryRawBytes &&
    compressedBytes === manifest.coverage.inventoryCompressedBytes, 'inventory coverage totals');
  const inventoryManifestHash = sha256(manifest);
  if (options.expectedHash !== undefined) ok(d64.test(options.expectedHash) && inventoryManifestHash === options.expectedHash,
    'tree inventory manifest hash mismatch');
  return { schema: 'ruflo.public-repair-tree-inventory-check/v1', inventoryManifestHash,
    repositoriesVerified: seen.size, inventoryEntryCount: entryCount, baseTreesVerified: true,
    fixTreesReconstructed: true, completeSourceTreePayloads: false, completeDependencyClosures: false,
    offlineExecutable: false, candidateExecutionEnabled: false, boundedRsiEvidenceAccepted: false };
}

export function inspectPublicTreeInventories(manifestPath, workloadPath, capsulePath, expectedHash) {
  const load = p => JSON.parse(readFileSync(p, 'utf8'));
  return validatePublicTreeInventories(load(manifestPath), load(workloadPath), load(capsulePath), {
    manifestPath, expectedHash, capsuleDir: join(dirname(capsulePath), 'public-capsules'),
  });
}

export function executePublicTreeInventory() {
  throw Error('PUBLIC_TREE_INVENTORY_EXECUTION_DISABLED: inventories prove Git tree identity but omit most blob payloads, dependency closures, hidden tests and authorization');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, manifest, workloads, capsules, expected, extra] = process.argv.slice(2);
    if (command !== 'inspect' || !manifest || !workloads || !capsules || extra)
      throw Error('usage: public-tree-inventories.mjs inspect MANIFEST WORKLOADS CAPSULES [HASH]');
    console.log(JSON.stringify(inspectPublicTreeInventories(resolve(manifest), resolve(workloads), resolve(capsules), expected), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
