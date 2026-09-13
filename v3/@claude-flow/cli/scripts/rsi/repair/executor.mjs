#!/usr/bin/env node
/** Fail-closed candidate isolation contract. Only its fixed capability probe executes. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { arch, platform, release, tmpdir } from 'node:os';
import { inspectMission, LEDGER } from './admission.mjs';
import { readBoundRegularFile } from './bounded-file.mjs';
import { sha256 } from './public-workloads.mjs';
import { inspectRuntimeLayout, runtimeSymlinkArguments, RUNTIME_LAYOUT_HASH } from './runtime-layout.mjs';
import { discardRuntimeSnapshot, snapshotMounts, stagePinnedExecutable, stageRuntimeSnapshot,
  validatePinnedExecutable, validateRuntimeSnapshot } from './runtime-snapshot.mjs';

const ROOT = dirname(new URL(import.meta.url).pathname);
const EXPECTED_POLICY_HASH = '333f2dfe6820f1fc39f4c27050d89ea82de4834be7bae0e6b51c9bf7569dd339';
const MAX_CONFIG_BYTES = 1048576;
const MAX_SOURCE_BYTES = 134217728;
const exact = (value, keys, reason) => assert(value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(','), reason);
const fileHash = path => createHash('sha256').update(
  readBoundRegularFile(path, MAX_SOURCE_BYTES, 'executor source').bytes).digest('hex');
const injectedFileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const readJson = (path, label) => JSON.parse(
  readBoundRegularFile(path, MAX_CONFIG_BYTES, label).bytes.toString('utf8'));

export function validateExecutorPolicy(policy) {
  exact(policy, ['schema','purpose','engine','limits','environment','mounts','probe','controls','resourceProposal','legacyMission','candidateExecutionEnabled','boundedRsiEvidenceAccepted'], 'executor policy fields');
  assert.equal(policy.schema, 'ruflo.repair-isolated-executor-policy/v1');
  assert.equal(sha256(policy), EXPECTED_POLICY_HASH, 'executor policy hash mismatch');
  exact(policy.engine, ['name','minimumVersion','binary','sha256','sizeBytes','requiredArguments','networkMode','rootMode','candidateSourceMode','outputMode','shellEnabled'], 'engine fields');
  assert.deepEqual(policy.engine, {
    name: 'bubblewrap', minimumVersion: '0.9.0', binary: '/usr/bin/bwrap',
    sha256: '52231e1caf55bcbc667b269f49c63599a6f7db4767ae6a039580d0ff853db712', sizeBytes: 72160,
    requiredArguments: ['--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL','--clearenv'],
    networkMode: 'NEW_EMPTY_NETWORK_NAMESPACE', rootMode: 'ALLOWLISTED_READ_ONLY_BINDS',
    candidateSourceMode: 'READ_ONLY', outputMode: 'DEDICATED_WRITABLE_BIND', shellEnabled: false,
  });
  assert.deepEqual(policy.limits, { wallMsPerProcess: 5000, addressSpaceBytes: 536870912,
    cpuSeconds: 5, openFiles: 64, processes: 16, outputBytes: 65536 });
  assert.deepEqual(policy.environment, { LANG: 'C', TZ: 'UTC', HOME: '/nonexistent' });
  assert.deepEqual(policy.mounts, { runtimeParents: ['/opt','/opt/codex','/opt/codex/runtimes','/opt/codex/runtimes/codex-primary-runtime','/opt/codex/runtimes/codex-primary-runtime/dependencies'],
    runtime: ['/usr','/opt/codex/runtimes/codex-primary-runtime/dependencies/node'],
    proc: '/proc', dev: '/dev', tmpfs: '/tmp', candidate: '/workspace', output: '/output' });
  assert.deepEqual(policy.probe, { requiresUserNamespace: true, requiresPidNamespace: true,
    requiresNetworkNamespace: true, requiresMountNamespace: true, requiresNoNonLoopbackInterfaces: true,
    requiresReadOnlyCandidateSource: true, requiresWritableDedicatedOutput: true });
  assert.deepEqual(policy.controls, ['frozen','static','shuffled','previous']);
  assert.deepEqual(policy.resourceProposal, { candidateEvaluations: 36, isolatedProcessStarts: 216,
    summedProcessWallMs: 1080000, approved: false, approvalReceiptHash: null });
  assert.equal(policy.legacyMission.head, '5a0e219e871fcf616209807c828c5793c29752f8d190fc38a0bc95e4db88422e');
  assert.equal(policy.legacyMission.nativeFieldCallsReserved, 209784);
  assert.equal(policy.legacyMission.epochsConsumed, 7);
  assert.equal(policy.legacyMission.originalAnchor, 'c5c6da0b728c52414f2dff86f9d23121776d600defff0f214f1502a091f69088');
  assert.equal(policy.candidateExecutionEnabled, false);
  assert.equal(policy.boundedRsiEvidenceAccepted, false);
  return { policyHash: EXPECTED_POLICY_HASH, candidateExecutionEnabled: false };
}

function confinedDirectory(path, label) {
  assert(isAbsolute(path) && existsSync(path) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), `${label} directory`);
  const canonical = realpathSync(path);
  assert.equal(canonical, path, `${label} must be canonical`);
  return canonical;
}

function buildLaunch(policy, candidateDirectory, outputDirectory, entry, runtimeLayout, runtimeSnapshot, enginePath) {
  const check = validateExecutorPolicy(policy);
  assert.equal(runtimeLayout.runtimeLayoutHash, RUNTIME_LAYOUT_HASH, 'reviewed runtime layout required');
  assert.equal(runtimeLayout.runtimeLayoutVerified, true, 'verified runtime layout required');
  assert.equal(runtimeLayout.candidateExecutionEnabled, false);
  const candidate = confinedDirectory(candidateDirectory, 'candidate');
  const output = confinedDirectory(outputDirectory, 'output');
  const outside = (base, path) => { const rel = relative(base, path); return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel); };
  assert(outside(candidate, output) && outside(output, candidate), 'candidate and output must be separate');
  const snapshotRoot = confinedDirectory(runtimeSnapshot.root, 'runtime snapshot');
  assert(outside(candidate, snapshotRoot) && outside(snapshotRoot, candidate) &&
    outside(output, snapshotRoot) && outside(snapshotRoot, output), 'runtime snapshot must be separate');
  assert.equal(runtimeSnapshot.runtimeLayoutHash, runtimeLayout.runtimeLayoutHash, 'snapshot runtime layout mismatch');
  assert(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(entry), 'fixed candidate entry filename');
  const source = join(candidate, entry);
  assert(existsSync(source) && lstatSync(source).isFile() && !lstatSync(source).isSymbolicLink() && realpathSync(source) === source, 'candidate entry file');
  const args = [...policy.engine.requiredArguments];
  for (const path of policy.mounts.runtimeParents) args.push('--dir', path);
  const mounts = runtimeSnapshot.snapshotHash === 'test-only' && process.env.NODE_TEST_CONTEXT
    ? [{ source: join(runtimeSnapshot.root, 'usr'), target: '/usr' },
      { source: join(runtimeSnapshot.root, 'opt/codex/runtimes/codex-primary-runtime/dependencies/node'),
        target: '/opt/codex/runtimes/codex-primary-runtime/dependencies/node' }]
    : snapshotMounts(runtimeSnapshot);
  assert.deepEqual(mounts.map(item => item.target), policy.mounts.runtime, 'snapshot mount targets');
  for (const mount of mounts) args.push('--ro-bind', mount.source, mount.target);
  args.push(...runtimeSymlinkArguments(runtimeLayout));
  args.push('--proc', policy.mounts.proc, '--dev', policy.mounts.dev, '--tmpfs', policy.mounts.tmpfs,
    '--ro-bind', candidate, policy.mounts.candidate, '--bind', output, policy.mounts.output,
    '--chdir', policy.mounts.candidate);
  for (const [key, value] of Object.entries(policy.environment)) args.push('--setenv', key, value);
  args.push('/usr/bin/prlimit', `--as=${policy.limits.addressSpaceBytes}`,
    `--cpu=${policy.limits.cpuSeconds}`, `--nofile=${policy.limits.openFiles}`,
    `--nproc=${policy.limits.processes}`, '--',
    '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/bin/node',
    '--permission', '--allow-fs-read=/workspace', '--allow-fs-write=/output', `/workspace/${entry}`);
  return { schema: 'ruflo.repair-isolation-launch/v2', policyHash: check.policyHash,
    runtimeLayoutHash: runtimeLayout.runtimeLayoutHash, runtimeSnapshotHash: runtimeSnapshot.snapshotHash,
    runtimeIdentities: runtimeLayout.identities,
    command: enginePath, args, timeoutMs: policy.limits.wallMsPerProcess,
    maxBuffer: policy.limits.outputBytes, shell: false, candidateSha256: fileHash(source),
    networkNamespaceRequired: true, candidateSourceReadOnly: true, candidateExecutionEnabled: false };
}

export function buildIsolationLaunch(policy, candidateDirectory, outputDirectory, entry = 'candidate.mjs') {
  throw Error('DIRECT_LAUNCH_DISABLED: use the durably reserved fixed probe, which owns snapshot lifetime');
}

export function buildIsolationLaunchForTest(policy, candidateDirectory, outputDirectory, entry = 'candidate.mjs') {
  assert(process.env.NODE_TEST_CONTEXT, 'test-only launch builder');
  const snapshotRoot = join(dirname(candidateDirectory), 'test-runtime-snapshot');
  mkdirSync(join(snapshotRoot, 'usr'), { recursive: true });
  mkdirSync(join(snapshotRoot, 'opt/codex/runtimes/codex-primary-runtime/dependencies/node'), { recursive: true });
  return buildLaunch(policy, candidateDirectory, outputDirectory, entry, {
    schema: 'ruflo.repair-runtime-layout-observation/v2', runtimeLayoutHash: RUNTIME_LAYOUT_HASH,
    runtimeLayoutVerified: true, candidateExecutionEnabled: false,
    identities: { node: {}, prlimit: {}, interpreter: {} },
    syntheticSymlinks: [{ target: 'usr/lib', link: '/lib' }, { target: 'usr/lib64', link: '/lib64' }],
  }, { root: realpathSync(snapshotRoot), snapshotHash: 'test-only', runtimeLayoutHash: RUNTIME_LAYOUT_HASH,
    readOnlyStaged: true, candidateExecutionEnabled: false }, policy.engine.binary);
}

const PROBE_SOURCE = `import fs from 'node:fs';import os from 'node:os';
let sourceWriteError=null;try{fs.writeFileSync('/workspace/probe.mjs','changed')}catch(error){sourceWriteError=error.code??'UNKNOWN'}
fs.writeFileSync('/output/probe','ok');
const interfaces=Object.entries(os.networkInterfaces()).flatMap(([name,rows])=>(rows??[]).map(row=>({name,address:row.address,internal:row.internal})));
console.log(JSON.stringify({sourceWriteError,interfaces}));`;

// No exported function may execute a caller-supplied path or source. This helper
// is reachable only after recordIsolationProbe durably reserves work and stages
// the module-owned fixed bytes in its own private temporary directory.
function probeIsolation(policy, candidateDirectory, outputDirectory, runtimeLayout, runtimeSnapshot, engineIdentity, revalidateRuntime) {
  const launch = buildLaunch(policy, candidateDirectory, outputDirectory, 'probe.mjs', runtimeLayout, runtimeSnapshot,
    engineIdentity?.path ?? policy.engine.binary);
  assert.equal(launch.candidateSha256, createHash('sha256').update(PROBE_SOURCE).digest('hex'), 'fixed probe bytes required');
  if (revalidateRuntime) {
    const current = inspectRuntimeLayout();
    assert.deepEqual(current.identities, runtimeLayout.identities, 'runtime identity drift before spawn');
    validateRuntimeSnapshot(runtimeSnapshot);
    validatePinnedExecutable(engineIdentity);
  }
  const started = performance.now();
  const child = spawnSync(launch.command, launch.args, { cwd: '/', env: {}, encoding: 'utf8',
    timeout: launch.timeoutMs, maxBuffer: launch.maxBuffer, shell: false, killSignal: 'SIGKILL' });
  let observation = null;
  try { observation = JSON.parse(child.stdout); } catch { /* raw error retained */ }
  const outputPath = join(outputDirectory, 'probe');
  let outputWritable = false, outputInspectionError = null;
  try {
    outputWritable = existsSync(outputPath) && lstatSync(outputPath).isFile() && !lstatSync(outputPath).isSymbolicLink() &&
      lstatSync(outputPath).size === 2 && readFileSync(outputPath, 'utf8') === 'ok';
  } catch (error) { outputInspectionError = error.code ?? 'UNKNOWN'; }
  const interfaces = observation?.interfaces;
  const visibleInterfacesInternal = Array.isArray(interfaces) && interfaces.every(item => item &&
    typeof item.name === 'string' && typeof item.address === 'string' && item.internal === true);
  // Node's own permission denial cannot prove a read-only OS mount. Interface
  // enumeration cannot prove network namespace separation or denied egress.
  // No receipt from this partial probe can claim a compatible candidate runner.
  return { schema: 'ruflo.repair-isolation-probe/v2', policyHash: launch.policyHash,
    compatible: false, status: child.status, signal: child.signal, error: child.error?.code ?? null,
    stdout: child.stdout ?? '', stderr: child.stderr ?? '', observation, elapsedMs: performance.now() - started,
    outputInspectionError, runtimeSnapshotHash: launch.runtimeSnapshotHash,
    parentObservedProcessStarts: child.pid > 0 ? 1 : 0,
    checks: { fixedProbeExited: child.status === 0 && !child.error && !child.signal,
      outputWritable, visibleInterfacesInternal, osSourceReadOnlyVerified: false,
      namespaceSeparationVerified: false, networkEgressDeniedVerified: false },
    blockers: ['OS_MOUNT_AND_NAMESPACE_VERIFICATION_INCOMPLETE'],
    candidateExecutionEnabled: false };
}

function durableNew(path, value) {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  const dfd = openSync(dirname(path), 'r'); try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

function supportedVersion(version) {
  if (version.status !== 0 || version.error || version.signal) return false;
  const match = /^bubblewrap (\d+)\.(\d+)\.(\d+)\s*$/.exec(version.stdout ?? '');
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) && (parts[0] > 0 || parts[1] >= 9);
}

function recordProbe(receiptPath, policyPath, injectedRuntimeLayout) {
  assert(isAbsolute(receiptPath) && !existsSync(receiptPath), 'probe receipt must be a new absolute path');
  const policy = readJson(policyPath, 'executor policy');
  validateExecutorPolicy(policy);
  const reservationPath = `${receiptPath}.reservation.json`;
  assert(!existsSync(reservationPath), 'existing reservation retained; explicit anchored recovery required');
  const reservation = { schema: 'ruflo.repair-isolation-engineering-reservation/v1',
    policyHash: sha256(policy), executorSourceSha256: fileHash(fileURLToPath(import.meta.url)),
    fixedProbeSha256: createHash('sha256').update(PROBE_SOURCE).digest('hex'),
    startedAt: new Date().toISOString(), reservedParentSpawnAttempts: 2,
    reservedParentWaitMs: 6000, descendantProcessStarts: null, retainOnInterruption: true,
    scope: 'FIXED_ENGINEERING_CAPABILITY_PROBE_ONLY', missionBudgetChanged: false,
    candidateExecutionEnabled: false };
  // Exclusive durable reservation precedes staging, version discovery and every
  // spawn. Never remove it, refund it, or retry it automatically after a crash.
  durableNew(reservationPath, reservation);
  const started = performance.now();
  let temp, runtimeSnapshot, runtimeParent;
  try {
    const runtimeLayout = injectedRuntimeLayout ?? inspectRuntimeLayout();
    temp = mkdtempSync(join(tmpdir(), 'ruflo-isolation-probe-'));
    let engineIdentity = null, engineHash = null, engineStageError = null, versionAttempted = false;
    let versionObservationComplete = true;
    let version = { pid: null, status: null, signal: null, error: null, stdout: '', stderr: '' };
    let engineUnchanged = false;
    if (injectedRuntimeLayout) {
      // Test-only injection keeps mocked pathname reads separate from the
      // production descriptor-bound engine staging path.
      engineHash = existsSync(policy.engine.binary) ? injectedFileHash(policy.engine.binary) : null;
      version = spawnSync(policy.engine.binary, ['--version'], { env: {}, cwd: '/', encoding: 'utf8', timeout: 1000, maxBuffer: 4096, shell: false, killSignal: 'SIGKILL' });
      versionAttempted = true;
      engineUnchanged = engineHash !== null && existsSync(policy.engine.binary) && engineHash === injectedFileHash(policy.engine.binary);
    } else {
      const engineDirectory = join(temp, 'engine'); mkdirSync(engineDirectory, { mode: 0o700 });
      try {
        engineIdentity = stagePinnedExecutable(policy.engine.binary, join(engineDirectory, 'bwrap'),
          policy.engine.sha256, policy.engine.sizeBytes);
        engineHash = engineIdentity.sha256;
        versionAttempted = true;
        try {
          version = spawnSync(engineIdentity.path, ['--version'], { env: {}, cwd: '/', encoding: 'utf8',
            timeout: 1000, maxBuffer: 4096, shell: false, killSignal: 'SIGKILL' });
        } catch (error) {
          versionObservationComplete = false;
          version = { pid: null, status: null, signal: null,
            error: { code: error.code ?? 'SPAWN_THROW' }, stdout: '', stderr: String(error.message ?? error) };
        }
        validatePinnedExecutable(engineIdentity); engineUnchanged = true;
      } catch (error) { engineStageError = error.code ?? error.message; }
    }
    const admitted = supportedVersion(version) && engineUnchanged;
    let capability = { compatible: false, attempted: false,
      blockers: [engineStageError ? 'ENGINE_IDENTITY_REJECTED' :
        (engineUnchanged ? 'ENGINE_VERSION_UNSUPPORTED' : 'ENGINE_MISSING_OR_CHANGED')], candidateExecutionEnabled: false };
    if (admitted) {
      const candidate = join(temp, 'candidate'), output = join(temp, 'output');
      mkdirSync(candidate); mkdirSync(output); writeFileSync(join(candidate, 'probe.mjs'), PROBE_SOURCE, { flag: 'wx', mode: 0o600 });
      runtimeParent = join(temp, 'runtime-snapshots'); mkdirSync(runtimeParent);
      if (injectedRuntimeLayout) {
        const root = join(runtimeParent, 'test-only');
        mkdirSync(join(root, 'usr'), { recursive: true });
        mkdirSync(join(root, 'opt/codex/runtimes/codex-primary-runtime/dependencies/node'), { recursive: true });
        runtimeSnapshot = { root: realpathSync(root), snapshotHash: 'test-only', runtimeLayoutHash: runtimeLayout.runtimeLayoutHash,
          readOnlyStaged: true, candidateExecutionEnabled: false };
      } else runtimeSnapshot = stageRuntimeSnapshot(realpathSync(runtimeParent));
      capability = { attempted: true, ...probeIsolation(policy, candidate, output, runtimeLayout, runtimeSnapshot,
        engineIdentity, !injectedRuntimeLayout) };
    }
    const receipt = { schema: 'ruflo.repair-isolation-capability-receipt/v2',
      reservationHash: sha256(reservation), policyHash: reservation.policyHash,
      runtimeLayoutHash: runtimeLayout.runtimeLayoutHash, runtimeSnapshotHash: runtimeSnapshot?.snapshotHash ?? null,
      runtimeIdentities: runtimeLayout.identities,
      executorSourceSha256: reservation.executorSourceSha256, fixedProbeSha256: reservation.fixedProbeSha256,
      host: { platform: platform(), release: release(), arch: arch() },
      engine: { sourcePath: policy.engine.binary, stagedPathUsed: engineIdentity !== null, sha256: engineHash,
        expectedSha256: policy.engine.sha256, expectedSizeBytes: policy.engine.sizeBytes,
        stageError: engineStageError, unchangedAfterVersion: engineUnchanged,
        versionAttempted, versionObservationComplete,
        versionStatus: version.status, versionSignal: version.signal ?? null, versionError: version.error?.code ?? null,
        versionStdout: version.stdout ?? '', versionStderr: version.stderr ?? '' },
      capability, costs: { parentSpawnAttempts: (versionAttempted ? 1 : 0) + (admitted ? 1 : 0),
        parentObservedProcessStarts: versionObservationComplete
          ? (version.pid > 0 ? 1 : 0) + (capability.parentObservedProcessStarts ?? 0) : null,
        descendantProcessStarts: null, wallMs: performance.now() - started,
        wallMsScope: 'PRE_RECEIPT_WRITE_AND_CLEANUP',
        candidateEvaluations: 0, externalProviderSpendUsd: 0, totalAcquisitionUsd: null, totalEvaluationUsd: null },
      resourceAuthorizationPresent: false, candidateExecutionEnabled: false, boundedRsiEvidenceAccepted: false };
    durableNew(receiptPath, receipt);
    return receipt;
  } finally {
    if (runtimeSnapshot && runtimeParent && runtimeSnapshot.snapshotHash !== 'test-only' && existsSync(runtimeSnapshot.root))
      discardRuntimeSnapshot(runtimeSnapshot, runtimeParent);
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

export function recordIsolationProbe(receiptPath, policyPath = join(ROOT, 'executor-policy.json')) {
  return recordProbe(receiptPath, policyPath, null);
}

export function recordIsolationProbeForTest(receiptPath, policyPath = join(ROOT, 'executor-policy.json')) {
  assert(process.env.NODE_TEST_CONTEXT, 'test-only probe recorder');
  return recordProbe(receiptPath, policyPath, {
    schema: 'ruflo.repair-runtime-layout-observation/v2', runtimeLayoutHash: RUNTIME_LAYOUT_HASH,
    runtimeLayoutVerified: true, candidateExecutionEnabled: false,
    identities: { node: {}, prlimit: {}, interpreter: {} },
    syntheticSymlinks: [{ target: 'usr/lib', link: '/lib' }, { target: 'usr/lib64', link: '/lib64' }],
  });
}

export function inspectExecutor(policyPath = join(ROOT, 'executor-policy.json')) {
  const policy = readJson(policyPath, 'executor policy');
  const policyCheck = validateExecutorPolicy(policy);
  const mission = inspectMission(LEDGER, policy.legacyMission.head);
  return { schema: 'ruflo.repair-isolated-executor-inspection/v1', ...policyCheck,
    mission: { head: mission.head, nativeFieldCallsReserved: mission.nativeFieldCallsReserved, epochs: mission.epochs },
    resourceAuthorizationPresent: false, capabilityReceiptPresent: false,
    blockers: ['RESOURCE_AUTHORIZATION_ABSENT','COMPATIBLE_ISOLATION_RECEIPT_ABSENT'],
    boundedRsiEvidenceAccepted: false };
}

export function reserveCandidateExecution() {
  throw Error('CANDIDATE_EXECUTION_DISABLED: reviewed resource authorization and compatible isolation receipt are both absent');
}

export function fixedProbeSource() { return PROBE_SOURCE; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, path, extra] = process.argv.slice(2);
    if (command === 'inspect' && !path) console.log(JSON.stringify(inspectExecutor(), null, 2));
    else if (command === 'probe' && path && !extra) console.log(JSON.stringify(recordIsolationProbe(resolve(path)), null, 2));
    else throw Error('usage: executor.mjs inspect | probe NEW_ABSOLUTE_RECEIPT');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
