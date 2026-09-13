#!/usr/bin/env node
/** Fixed historical p-limit witness with offline runtime payloads; never arbitrary candidates. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { sha256 } from './public-workloads.mjs';
import { parsePayloadPack } from './public-tree-payloads.mjs';
import { inspectMission, ledgerFingerprint, LEDGER } from './admission.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const LEGACY_HEAD = '5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e';
const ORIGIN = 'c5c6da0b728c52414f2dff86f9d23121776d600defff0f214f1502a091f69088';
const NODE_VERSION = 'v24.19.0';
const BLOB = {
  base: '5ecd39257c623b6dd4df204bbd7c94fbdf0b8d12',
  fix: 'b74d48ab0e37788e657e5ad12d90e281ef1f39d1',
};
const DEPENDENCY_BLOBS = {
  'index.js': 'fb645592b5e17d1b8f876a747757d5686e011d04',
  'package.json': '7fde9acb43a5ec3abed97b481ae36de4d24a8a43',
  license: 'fa7ceba3eb4a9657a9db7f3ffca4e4e97a9019de',
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const readJson = name => JSON.parse(readFileSync(join(ROOT, name), 'utf8'));

export function validateDependency(manifest) {
  assert.equal(manifest.schema, 'ruflo.p-limit-runtime-dependency/v1');
  assert.equal(manifest.repository, 'sindresorhus/yocto-queue');
  assert.equal(manifest.version, '1.2.1');
  assert.equal(manifest.commit, 'ce72d41de87b2a4ec7c50e10480300bee674d845');
  assert.equal(manifest.tagObject, '38094e00614829af560bfc151a55ee2d30e0a481');
  assert.equal(manifest.files.length, 3);
  const files = new Map();
  for (const file of manifest.files) {
    assert(Object.hasOwn(DEPENDENCY_BLOBS, file.path), 'unexpected dependency path');
    assert(!files.has(file.path), 'duplicate dependency path');
    assert.equal(file.oid, DEPENDENCY_BLOBS[file.path]);
    assert.equal(file.url, `https://api.github.com/repos/sindresorhus/yocto-queue/git/blobs/${file.oid}`);
    assert.equal(file.encoding, 'utf8');
    const bytes = Buffer.from(file.content, 'utf8');
    assert.equal(gitBlob(bytes), file.oid, 'dependency Git blob mismatch');
    files.set(file.path, bytes);
  }
  const pkg = JSON.parse(files.get('package.json'));
  assert.equal(pkg.version, '1.2.1');
  assert.equal(pkg.exports, './index.js');
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
  return files;
}

function snapshots() {
  const manifest = readJson('public-tree-payloads.json');
  assert.equal(sha256(manifest), '154d9f56893cd5f1f78ac141a0de69f1b6b15ac21762948e03bf243ca2204ecb');
  const record = manifest.payloads.find(r => r.repository === 'sindresorhus/p-limit');
  const compressed = Buffer.from(readFileSync(join(ROOT, record.path), 'utf8').replace(/\s/g, ''), 'base64');
  assert.equal(digest(compressed), record.compressedSha256);
  const raw = gunzipSync(compressed, { maxOutputLength: 100_000 });
  assert.equal(digest(raw), record.rawSha256);
  const { payloads } = parsePayloadPack(raw);
  const base = payloads.get('index.js');
  assert.equal(gitBlob(base), BLOB.base);
  const fix = Buffer.from(readFileSync(join(ROOT, 'public-capsules', `${BLOB.fix}.b64`), 'utf8').replace(/\s/g, ''), 'base64');
  assert.equal(gitBlob(fix), BLOB.fix);
  const pkg = JSON.parse(payloads.get('package.json'));
  assert.equal(pkg.dependencies['yocto-queue'], '^1.2.1');
  const dependencies = validateDependency(readJson('p-limit-dependency.json'));
  const common = new Map([
    ['package.json', payloads.get('package.json')], ['license', payloads.get('license')],
    ['witness.mjs', readFileSync(join(ROOT, 'p-limit-witness.mjs'))],
    ...[...dependencies].map(([path, bytes]) => [`node_modules/yocto-queue/${path}`, bytes]),
  ]);
  return { base, fix, common };
}

export function prepareOfflineWitness() {
  assert.equal(process.version, NODE_VERSION, 'fixed Node runtime version required');
  inspectMission(LEDGER, LEGACY_HEAD);
  const data = snapshots();
  return {
    schema: 'ruflo.p-limit-offline-plan/v1',
    mission: { originalAnchor: ORIGIN, head: LEGACY_HEAD, fingerprint: ledgerFingerprint(LEDGER),
      epochs: 7, nativeFieldCallsReserved: 209784 },
    runtime: { version: process.version, platform: process.platform, arch: process.arch,
      executableSha256: digest(readFileSync(process.execPath)) },
    source: { runnerSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
      supportModules: Object.fromEntries(['admission.mjs', 'public-workloads.mjs',
        'public-tree-payloads.mjs', 'public-tree-inventories.mjs', 'public-capsules.mjs',
        '../loop/ledger.mjs', '../loop/proof.mjs', '../loop/run.mjs', '../loop/retrieval.mjs']
        .map(path => [path, digest(readFileSync(join(ROOT, path)))])),
      dependencyManifestSha256: digest(readFileSync(join(ROOT, 'p-limit-dependency.json'))),
      baseBlob: BLOB.base, fixBlob: BLOB.fix,
      baseSha256: digest(data.base), fixSha256: digest(data.fix),
      files: [...data.common].map(([path, bytes]) => ({ path, sha256: digest(bytes) })) },
    limits: { fixedWitnessProcesses: 2, timeoutMsPerProcess: 5000, outputBytesPerProcess: 65536, heapMb: 128 },
    scope: 'EXPOSED_HISTORICAL_RUNTIME_WITNESS_ONLY',
    completeUpstreamTestEnvironment: false, adversarialSandbox: false,
    candidateExecutionEnabled: false, boundedRsiEvidenceAccepted: false,
  };
}

function durableNew(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  const parent = openSync(dirname(path), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

export function runOfflineWitness(plan, expectedHash, outputDirectory) {
  assert.equal(sha256(plan), expectedHash, 'plan anchor mismatch');
  assert.deepEqual(plan, prepareOfflineWitness(), 'frozen source, runtime or policy drift');
  // Capture verified bytes before any subprocess. No command or patch comes from the plan.
  const data = snapshots();
  const start = performance.now(), cpu = process.cpuUsage();
  assert.equal(digest(data.base), plan.source.baseSha256, 'base execution bytes drift');
  assert.equal(digest(data.fix), plan.source.fixSha256, 'fix execution bytes drift');
  assert.deepEqual([...data.common].map(([path, bytes]) => ({ path, sha256: digest(bytes) })),
    plan.source.files, 'witness execution bytes drift');
  // Existing output directories are never reused or automatically recovered.
  mkdirSync(outputDirectory, { mode: 0o700 });
  const parentfd = openSync(dirname(outputDirectory), 'r');
  try { fsyncSync(parentfd); } finally { closeSync(parentfd); }
  durableNew(join(outputDirectory, 'reservation.json'), {
    schema: 'ruflo.p-limit-engineering-reservation/v1', planHash: expectedHash,
    startedAt: new Date().toISOString(), scope: plan.scope,
    reservedWitnessProcesses: 2, reservedWitnessWallMs: 10000,
    missionBudgetChanged: false, retainOnInterruption: true,
  });
  const dirfd = openSync(outputDirectory, 'r');
  try { fsyncSync(dirfd); } finally { closeSync(dirfd); }
  const temp = mkdtempSync(join(tmpdir(), 'ruflo-limit-witness-'));
  const rows = [];
  try {
    for (const role of ['base', 'fix']) {
      const work = join(temp, role);
      mkdirSync(join(work, 'node_modules', 'yocto-queue'), { recursive: true });
      for (const [path, bytes] of data.common) writeFileSync(join(work, path), bytes, { flag: 'wx' });
      writeFileSync(join(work, 'index.js'), data[role], { flag: 'wx' });
      const before = performance.now();
      const child = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${work}`,
        '--max-old-space-size=128', join(work, 'witness.mjs')], {
        cwd: work, env: { LANG: 'C', TZ: 'UTC' }, timeout: 5000, killSignal: 'SIGKILL',
        maxBuffer: 65536, encoding: 'utf8',
      });
      let measurement = null;
      try { measurement = JSON.parse(child.stdout); } catch { /* raw failure retained */ }
      const row = { role, elapsedMs: performance.now() - before, status: child.status,
        signal: child.signal, error: child.error?.code ?? null,
        stdout: child.stdout, stderr: child.stderr, measurement };
      rows.push(row);
      durableNew(join(outputDirectory, `${role}.json`), row);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  const expected = [[true, true, true, false], [true, true, true, true]];
  const verified = rows.length === 2 && rows.every((r, i) => r.status === 0 && !r.error && !r.signal &&
    JSON.stringify(r.measurement?.rows?.map(x => x.passed)) === JSON.stringify(expected[i]));
  const result = { schema: 'ruflo.p-limit-offline-result/v1', planHash: expectedHash,
    historicalWitnessVerified: verified, rows,
    ledgerUnchanged: ledgerFingerprint(LEDGER) === plan.mission.fingerprint,
    costs: { engineeringWitnessProcessStarts: rows.length,
      summedWitnessWallMs: rows.reduce((sum, r) => sum + r.elapsedMs, 0),
      runnerWallMs: performance.now() - start, parentCpuMicros: process.cpuUsage(cpu),
      missionCandidateEvaluations: 0, missionNativeFieldCallsAdded: 0,
      externalProviderSpendUsd: 0, totalAcquisitionUsd: null, totalEvaluationUsd: null,
      scope: 'Only this fixed witness run. Preparation, research, tool acquisition, other tests and CI excluded. Child CPU in each raw row excludes startup.' },
    completeUpstreamTestEnvironment: false, adversarialSandbox: false,
    candidateExecutionEnabled: false, boundedRsiEvidenceAccepted: false };
  durableNew(join(outputDirectory, 'result.json'), result);
  return result;
}

export function executeRepairCandidate() {
  throw Error('CANDIDATE_EXECUTION_DISABLED: isolated executor and approved resource migration required');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, file, anchor, output, extra] = process.argv.slice(2);
    if (command === 'prepare' && file && !anchor) {
      const plan = prepareOfflineWitness(); durableNew(file, plan);
      console.log(JSON.stringify({ planHash: sha256(plan), candidateExecutionEnabled: false }));
    } else if (command === 'run' && file && anchor && output && !extra) {
      const result = runOfflineWitness(JSON.parse(readFileSync(file, 'utf8')), anchor, output);
      console.log(JSON.stringify(result, null, 2));
      if (!result.historicalWitnessVerified || !result.ledgerUnchanged) process.exitCode = 1;
    } else throw Error('usage: p-limit-offline.mjs prepare NEW_PLAN | run PLAN HASH NEW_OUTPUT_DIRECTORY');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
