import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateExecutorPolicy, buildIsolationLaunch, inspectExecutor, probeIsolation, recordIsolationProbe, reserveCandidateExecution, fixedProbeSource } from './executor.mjs';

const policy = () => JSON.parse(readFileSync(new URL('./executor-policy.json', import.meta.url)));
function temporary(fn) {
  const root = mkdtempSync(join(tmpdir(), 'ruflo-executor-test-'));
  const candidate = join(root, 'candidate'), output = join(root, 'output');
  mkdirSync(candidate); mkdirSync(output); writeFileSync(join(candidate, 'candidate.mjs'), 'console.log("ok")');
  writeFileSync(join(candidate, 'probe.mjs'), fixedProbeSource());
  try { return fn({ root, candidate, output }); } finally { rmSync(root, { recursive: true, force: true }); }
}

test('policy pins isolation, equal controls, original usage and zero authorization', () => {
  const result = validateExecutorPolicy(policy());
  assert.match(result.policyHash, /^[a-f0-9]{64}$/);
  assert.equal(result.candidateExecutionEnabled, false);
});
test('policy changes cannot authorize execution or weaken any limit', () => {
  for (const change of [p => { p.resourceProposal.approved = true; }, p => { p.limits.processes = 32; },
    p => { p.engine.requiredArguments = p.engine.requiredArguments.filter(x => x !== '--unshare-all'); },
    p => { p.controls.pop(); }, p => { p.candidateExecutionEnabled = true; }]) {
    const value = policy(); change(value); assert.throws(() => validateExecutorPolicy(value), /hash/);
  }
});
test('launch is shell-free, network-isolated and mounts candidate read-only', () => temporary(({ candidate, output }) => {
  const launch = buildIsolationLaunch(policy(), candidate, output);
  assert.equal(launch.shell, false);
  assert.equal(launch.networkNamespaceRequired, true);
  assert.equal(launch.candidateSourceReadOnly, true);
  assert(launch.args.includes('--unshare-all'));
  assert.deepEqual(launch.args.slice(launch.args.indexOf('--ro-bind', 6), launch.args.indexOf('--ro-bind', 6) + 3), ['--ro-bind','/usr','/usr']);
  const sourceAt = launch.args.lastIndexOf('--ro-bind');
  assert.deepEqual(launch.args.slice(sourceAt, sourceAt + 3), ['--ro-bind', candidate, '/workspace']);
  assert.equal(launch.args.at(-1), '/workspace/candidate.mjs');
  assert(launch.args.includes('--as=536870912'));
  assert(launch.args.includes('--cpu=5'));
  assert(launch.args.includes('--nproc=16'));
  assert(launch.args.includes('/usr/bin/prlimit'));
  assert.equal(launch.candidateExecutionEnabled, false);
}));
test('arguments, paths, symlinks and overlapping output cannot be injected', () => temporary(({ root, candidate, output }) => {
  for (const entry of ['../outside', '/etc/passwd', 'x;id', 'x/y']) assert.throws(() => buildIsolationLaunch(policy(), candidate, output, entry));
  symlinkSync(join(candidate, 'candidate.mjs'), join(candidate, 'linked.mjs'));
  assert.throws(() => buildIsolationLaunch(policy(), candidate, output, 'linked.mjs'), /candidate entry/);
  assert.throws(() => buildIsolationLaunch(policy(), candidate, candidate), /separate/);
  const alias = join(root, 'alias'); symlinkSync(candidate, alias);
  assert.throws(() => buildIsolationLaunch(policy(), alias, output), /directory/);
}));
test('inspection verifies mission but exposes both closed gates', () => {
  const result = inspectExecutor();
  assert.equal(result.mission.nativeFieldCallsReserved, 209784);
  assert.equal(result.mission.epochs, 7);
  assert.deepEqual(result.blockers, ['RESOURCE_AUTHORIZATION_ABSENT','COMPATIBLE_ISOLATION_RECEIPT_ABSENT']);
  assert.equal(result.boundedRsiEvidenceAccepted, false);
});
test('local capability probe preserves raw result and cannot enable candidates', () => temporary(({ candidate, output }) => {
  const result = probeIsolation(policy(), candidate, output);
  assert.equal(typeof result.compatible, 'boolean');
  assert.equal(result.candidateExecutionEnabled, false);
  assert.equal(typeof result.stderr, 'string');
}));
test('probe results and caller claims cannot create resource authority', () => {
  assert.throws(() => reserveCandidateExecution({ compatible: true, approved: true }), /CANDIDATE_EXECUTION_DISABLED/);
});
test('durable probe receipt is exclusive, source bound and retains negative results', () => temporary(({ root }) => {
  const path = join(root, 'receipt.json'), receipt = recordIsolationProbe(path);
  assert.equal(receipt.policyHash, validateExecutorPolicy(policy()).policyHash);
  assert.match(receipt.executorSourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.costs.engineeringProcessStarts, 2);
  assert.equal(receipt.costs.candidateEvaluations, 0);
  assert.equal(receipt.candidateExecutionEnabled, false);
  assert.deepEqual(JSON.parse(readFileSync(path)), receipt);
  assert.throws(() => recordIsolationProbe(path), /new absolute path/);
  assert.deepEqual(JSON.parse(readFileSync(path)), receipt);
}));
