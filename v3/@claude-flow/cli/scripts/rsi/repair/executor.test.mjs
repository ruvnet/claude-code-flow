import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import * as executor from './executor.mjs';
import { sha256 } from './public-workloads.mjs';
const { validateExecutorPolicy, buildIsolationLaunchForTest: buildIsolationLaunch, inspectExecutor, recordIsolationProbeForTest: recordIsolationProbe, reserveCandidateExecution, fixedProbeSource } = executor;

// Simulated host/child responses only: unit tests never execute the incompatible
// local engine. Actual capability receipts are separately reserved artifacts.
function simulatedEngine(t, spawn, fn) {
  const originalRead = fs.readFileSync, originalExists = fs.existsSync;
  t.mock.method(fs, 'readFileSync', (path, ...args) => path === '/usr/bin/bwrap' ? Buffer.from('simulated-engine') : originalRead(path, ...args));
  t.mock.method(fs, 'existsSync', path => path === '/usr/bin/bwrap' || originalExists(path));
  t.mock.method(childProcess, 'spawnSync', spawn);
  syncBuiltinESMExports();
  try { return fn(); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}

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
  const p = policy(); p.probe = {};
  assert.throws(() => validateExecutorPolicy(p, sha256(p)), /hash/, 'caller cannot supply a replacement policy anchor');
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
  assert.equal(launch.runtimeLayoutHash, '6bcfdb29967558abbcff13c5cb4b3cbad9adeab85f6c15d3cd69de05e4c9b439');
  const symlinkAt = launch.args.indexOf('--symlink');
  assert.deepEqual(launch.args.slice(symlinkAt, symlinkAt + 6),
    ['--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64']);
  assert.equal(launch.candidateExecutionEnabled, false);
}));
test('arguments, paths, symlinks and overlapping output cannot be injected', () => temporary(({ root, candidate, output }) => {
  for (const entry of ['../outside', '/etc/passwd', 'x;id', 'x/y']) assert.throws(() => buildIsolationLaunch(policy(), candidate, output, entry));
  symlinkSync(join(candidate, 'candidate.mjs'), join(candidate, 'linked.mjs'));
  assert.throws(() => buildIsolationLaunch(policy(), candidate, output, 'linked.mjs'), /candidate entry/);
  assert.throws(() => buildIsolationLaunch(policy(), candidate, candidate), /separate/);
  const alias = join(root, 'alias'); symlinkSync(candidate, alias);
  assert.throws(() => buildIsolationLaunch(policy(), alias, output), /directory/);
  const nestedOutput = join(candidate, '..output'); mkdirSync(nestedOutput);
  assert.throws(() => buildIsolationLaunch(policy(), candidate, nestedOutput), /separate/);
  const nestedCandidate = join(output, '..candidate'); mkdirSync(nestedCandidate);
  writeFileSync(join(nestedCandidate, 'candidate.mjs'), '');
  assert.throws(() => buildIsolationLaunch(policy(), nestedCandidate, output), /separate/);
}));
test('inspection verifies mission but exposes both closed gates', () => {
  const result = inspectExecutor();
  assert.equal(result.mission.nativeFieldCallsReserved, 209784);
  assert.equal(result.mission.epochs, 7);
  assert.deepEqual(result.blockers, ['RESOURCE_AUTHORIZATION_ABSENT','COMPATIBLE_ISOLATION_RECEIPT_ABSENT']);
  assert.equal(result.boundedRsiEvidenceAccepted, false);
});
test('module exposes no execution entry for caller-supplied probe paths', () => {
  assert.equal(Object.hasOwn(executor, 'probeIsolation'), false);
  assert.deepEqual(Object.keys(executor).sort(), ['buildIsolationLaunch','buildIsolationLaunchForTest','fixedProbeSource','inspectExecutor',
    'recordIsolationProbe','recordIsolationProbeForTest','reserveCandidateExecution','validateExecutorPolicy'].sort());
});
test('probe results and caller claims cannot create resource authority', () => {
  assert.throws(() => reserveCandidateExecution({ compatible: true, approved: true }), /CANDIDATE_EXECUTION_DISABLED/);
});
test('durable reservation precedes all spawn attempts and retains negative results', t => temporary(({ root }) => {
  const path = join(root, 'receipt.json'); let attempts = 0;
  const receipt = simulatedEngine(t, () => {
    attempts++;
    const reservation = JSON.parse(readFileSync(`${path}.reservation.json`));
    assert.equal(reservation.reservedParentSpawnAttempts, 2);
    assert.equal(reservation.retainOnInterruption, true);
    return { status: null, signal: null, error: { code: 'ENOENT' }, stdout: null, stderr: null };
  }, () => recordIsolationProbe(path));
  assert.equal(receipt.policyHash, validateExecutorPolicy(policy()).policyHash);
  assert.match(receipt.executorSourceSha256, /^[a-f0-9]{64}$/);
  assert(receipt.engine.sha256 === null || /^[a-f0-9]{64}$/.test(receipt.engine.sha256));
  assert.equal(attempts, 1);
  assert.equal(receipt.costs.parentSpawnAttempts, 1);
  assert.equal(receipt.costs.parentObservedProcessStarts, 0);
  assert.equal(receipt.costs.descendantProcessStarts, null);
  assert.equal(receipt.capability.attempted, false);
  assert.equal(receipt.engine.versionStdout, '');
  assert.equal(receipt.engine.versionError, 'ENOENT');
  assert.equal(receipt.reservationHash, sha256(JSON.parse(readFileSync(`${path}.reservation.json`))));
  assert.equal(receipt.costs.candidateEvaluations, 0);
  assert.equal(receipt.candidateExecutionEnabled, false);
  assert.deepEqual(JSON.parse(readFileSync(path)), receipt);
  assert.throws(() => recordIsolationProbe(path), /new absolute path/);
  assert.deepEqual(JSON.parse(readFileSync(path)), receipt);
}));

test('interrupted reservation survives exception and prevents automatic retry', t => temporary(({ root }) => {
  const path = join(root, 'interrupted.json'); let calls = 0;
  simulatedEngine(t, () => { calls++; throw Error('simulated interruption'); }, () => {
    assert.throws(() => recordIsolationProbe(path), /simulated interruption/);
    const before = readFileSync(`${path}.reservation.json`, 'utf8');
    assert(!existsSync(path));
    assert.throws(() => recordIsolationProbe(path), /existing reservation retained/);
    assert.equal(readFileSync(`${path}.reservation.json`, 'utf8'), before);
    assert.equal(calls, 1);
  });
}));

test('existing reservation and forged policy cannot reach a child process', t => temporary(({ root }) => {
  const path = join(root, 'reserved.json'); writeFileSync(`${path}.reservation.json`, 'retained');
  const forged = policy(); forged.resourceProposal.approved = true;
  const forgedPath = join(root, 'policy.json'); writeFileSync(forgedPath, JSON.stringify(forged));
  simulatedEngine(t, () => assert.fail('spawn must be unreachable'), () => {
    assert.throws(() => recordIsolationProbe(path), /existing reservation retained/);
    assert.throws(() => recordIsolationProbe(join(root, 'forged.json'), forgedPath), /hash/);
    assert(!existsSync(join(root, 'forged.json.reservation.json')));
  });
}));

test('unsupported or malformed engine versions stop before namespace launch', t => temporary(({ root }) => {
  for (const [i, version] of ['bubblewrap 0.8.9\n', 'bubblewrap latest', 'bubblewrap 0.9.0\nextra'].entries()) {
    let attempts = 0;
    const receipt = simulatedEngine(t, () => {
      attempts++; return { pid: 123, status: 0, signal: null, stdout: version, stderr: '' };
    }, () => recordIsolationProbe(join(root, `version-${i}.json`)));
    assert.equal(attempts, 1);
    assert.equal(receipt.capability.attempted, false);
    assert.equal(receipt.capability.compatible, false);
  }
}));

test('engine replacement during version discovery prevents namespace launch', t => temporary(({ root }) => {
  const originalRead = fs.readFileSync, originalExists = fs.existsSync;
  let changed = false, calls = 0;
  t.mock.method(fs, 'readFileSync', (path, ...args) => path === '/usr/bin/bwrap'
    ? Buffer.from(changed ? 'replacement-engine' : 'original-engine') : originalRead(path, ...args));
  t.mock.method(fs, 'existsSync', path => path === '/usr/bin/bwrap' || originalExists(path));
  t.mock.method(childProcess, 'spawnSync', () => {
    calls++; changed = true; return { pid: 1, status: 0, signal: null, stdout: 'bubblewrap 0.9.0', stderr: '' };
  });
  syncBuiltinESMExports();
  try {
    const result = recordIsolationProbe(join(root, 'replacement.json'));
    assert.equal(calls, 1);
    assert.equal(result.engine.unchangedAfterVersion, false);
    assert.equal(result.capability.attempted, false);
    assert.equal(result.capability.compatible, false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));

test('only private fixed bytes are staged; permission denial is not OS isolation', t => temporary(({ root }) => {
  let attempts = 0;
  const receipt = simulatedEngine(t, (command, args, options) => {
    assert.equal(command, '/usr/bin/bwrap');
    assert.deepEqual(options.env, {});
    if (++attempts === 1) return { pid: 1, status: 0, signal: null, stdout: 'bubblewrap 0.9.0\n', stderr: '' };
    const inputAt = args.lastIndexOf('--ro-bind'), outputAt = args.indexOf('--bind');
    const staged = args[inputAt + 1], output = args[outputAt + 1];
    assert.equal(readFileSync(join(staged, 'probe.mjs'), 'utf8'), fixedProbeSource());
    assert(args.includes('--permission'));
    writeFileSync(join(output, 'probe'), 'ok');
    return { pid: 2, status: 0, signal: null, stdout: JSON.stringify({ sourceWriteError: 'ERR_ACCESS_DENIED', interfaces: [] }), stderr: '' };
  }, () => recordIsolationProbe(join(root, 'partial.json')));
  assert.equal(attempts, 2);
  assert.equal(receipt.costs.parentObservedProcessStarts, 2);
  assert.equal(receipt.capability.checks.outputWritable, true);
  assert.equal(receipt.capability.checks.visibleInterfacesInternal, true);
  assert.equal(receipt.capability.checks.osSourceReadOnlyVerified, false);
  assert.equal(receipt.capability.checks.namespaceSeparationVerified, false);
  assert.equal(receipt.capability.compatible, false);
  assert.equal(receipt.candidateExecutionEnabled, false);
}));

test('malformed fixed-probe observations are retained without false compatibility', t => temporary(({ root }) => {
  for (const [i, stdout] of ['not-json', '{}', '{"interfaces":null}', '{"interfaces":[null]}'].entries()) {
    let calls = 0;
    const receipt = simulatedEngine(t, () => ++calls === 1
      ? { pid: 1, status: 0, signal: null, stdout: 'bubblewrap 0.9.0', stderr: '' }
      : { pid: 2, status: 0, signal: null, stdout, stderr: 'raw diagnostic' },
    () => recordIsolationProbe(join(root, `malformed-${i}.json`)));
    assert.equal(receipt.capability.stdout, stdout);
    assert.equal(receipt.capability.stderr, 'raw diagnostic');
    assert.equal(receipt.capability.compatible, false);
    assert.equal(receipt.capability.checks.visibleInterfacesInternal, false);
  }
}));
