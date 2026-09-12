import { fork, execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { Coordinator, digest } from './coordinator.mjs';
import { createExecutionServer } from './service.mjs';
import { client, command } from './client.mjs';
import { createRouter } from './routing.mjs';
import { fixtures, expectedArtifact, capabilities } from './fixtures.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function runBenchmark({ mode = 'fixed', timeoutMs = 30000, fault = null } = {}) {
  if (fault !== null && fault !== 'disconnect') throw new Error('unsupported fault');
  const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
  const sourceFiles = (await readdir(sourceRoot)).filter(n => n.endsWith('.mjs')).sort();
  const sourceHash = createHash('sha256');
  for (const name of sourceFiles) { const bytes = await readFile(join(sourceRoot, name)); sourceHash.update(`${name}\0${bytes.length}\0`).update(bytes); }
  const packageBytes = await readFile(new URL('../package.json', import.meta.url));
  sourceHash.update(`package.json\0${packageBytes.length}\0`).update(packageBytes);
  const lockBytes = await readFile(new URL('../package-lock.json', import.meta.url));
  sourceHash.update(`package-lock.json\0${lockBytes.length}\0`).update(lockBytes);
  const sourceFingerprint = sourceHash.digest('hex');
  const directory = await mkdtemp(join(tmpdir(), 'federation-proof-'));
  const controllerKey = generateSecretKey(), verifierKey = generateSecretKey();
  const identities = Array.from({ length: mode === 'single' ? 1 : 3 }, (_, i) => {
    const secretKey = generateSecretKey();
    return { secretKey, pubkey: getPublicKey(secretKey), capabilities: mode === 'single' ? capabilities : [capabilities[i]], cost: 0.01 };
  });
  const workers = identities.map(({ secretKey, ...publicPolicy }) => publicPolicy);
  const audience = `local-proof-${crypto.randomUUID()}`;
  let coordinator, service, router;
  const activeChildren = new Map(), intentionalStops = new Set();
  const faultResult = { requested: fault, injected: false, recovered: false };
  const children = [], errors = [], completedAt = new Map(), assignments = new Map();
  const started = performance.now();
  try {
    coordinator = new Coordinator({ dbPath: join(directory, 'coordinator.db'), controllerPubkey: getPublicKey(controllerKey), verifierPubkeys: [getPublicKey(verifierKey)], workerPolicies: workers, audience, leaseMs: 2000 });
    service = createExecutionServer(coordinator);
    const port = await service.listen(0), base = `http://127.0.0.1:${port}`;
    const controller = client(base, controllerKey, audience), verifier = client(base, verifierKey, audience);
    // No synthetic successes are passed as observed evidence. Cold start history
    // is empty and evaluation records are never fed back during this run.
    router = await createRouter({ mode, dimensions: 8, storagePath: join(directory, 'routing.db'), history: [] });
    const spawnWorker = identity => new Promise((resolve, reject) => {
      const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
      children.push(child);
      activeChildren.set(identity.pubkey, child);
      const timer = setTimeout(() => reject(new Error('worker startup timeout')), 10000);
      child.on('error', error => { clearTimeout(timer); reject(error); errors.push(error.message); });
      child.on('exit', (code, signal) => { if (!intentionalStops.has(child) && (code || signal)) { clearTimeout(timer); reject(new Error(`worker exit ${code}`)); errors.push(`worker exit ${code}`); } });
      child.on('message', message => {
        if (message.type === 'ready') { clearTimeout(timer); resolve(); }
        if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)); errors.push(message.message); }
      });
      child.stderr.on('data', () => {});
      child.send({ base, audience, secretKey: Array.from(identity.secretKey), capabilities: identity.capabilities });
    });
    await Promise.all(identities.map(spawnWorker));
    const tasks = fixtures();
    for (const task of tasks) await controller('submit', { ...task, deadlineMs: Date.now() + timeoutMs });
    let status;
    while (performance.now() - started < timeoutMs) {
      if (errors.length) throw new Error(errors[0]);
      status = await controller('status');
      if (fault === 'disconnect' && !faultResult.injected) {
        const victim = status.tasks.find(t => ['leased', 'submitted'].includes(t.status));
        if (victim) {
          const child = activeChildren.get(victim.owner);
          intentionalStops.add(child);
          const exited = new Promise(resolve => child.once('exit', resolve));
          child.kill('SIGKILL');
          await exited;
          Object.assign(faultResult, { injected: true, worker: victim.owner, taskId: victim.spec.id, expiredEpoch: victim.epoch, leaseUntil: victim.leaseUntil });
        }
      }
      if (faultResult.injected && !faultResult.restarted && Date.now() > faultResult.leaseUntil) {
        await spawnWorker(identities.find(w => w.pubkey === faultResult.worker));
        faultResult.restarted = true;
      }
      for (const task of status.tasks) {
        if (faultResult.injected && task.spec.id === faultResult.taskId && task.epoch === faultResult.expiredEpoch) continue;
        if (task.status === 'submitted') {
          const original = tasks.find(t => t.id === task.spec.id);
          const accepted = Boolean(original) && isDeepStrictEqual(task.artifact, expectedArtifact(original));
          await verifier('verify', { taskId: task.spec.id, epoch: task.epoch, artifactHash: task.artifactHash, accepted });
          if (!accepted) throw new Error(`incorrect artifact: ${task.spec.id}`);
          completedAt.set(task.spec.id, performance.now() - started);
        }
      }
      // Refresh after verification so freed workers can receive the next task.
      status = await controller('status');
      const pending = new Set(status.tasks.filter(t => t.status === 'queued' && t.assigned).map(t => t.assigned));
      const available = status.workers.map(w => ({ ...w, available: w.available && !pending.has(w.pubkey) }));
      for (const task of status.tasks) {
        if (task.status !== 'queued' || task.assigned) continue;
        const ranked = await router.rank(task.spec, available);
        const candidate = ranked[0];
        if (!candidate) continue;
        await controller('assign', { taskId: task.spec.id, worker: candidate.pubkey });
        assignments.set(task.spec.id, candidate.pubkey);
        available.find(w => w.pubkey === candidate.pubkey).available = false;
      }
      if (completedAt.size === tasks.length) break;
      await pause(10);
    }
    status = await controller('status');
    const verified = status.tasks.filter(task => task.status === 'completed').length;
    if (verified !== tasks.length) throw new Error(`benchmark incomplete: ${verified}/${tasks.length}`);
    if (faultResult.injected) {
      const retried = status.tasks.find(t => t.spec.id === faultResult.taskId);
      faultResult.recovered = retried.status === 'completed' && retried.attempts > 1 && retried.epoch > faultResult.expiredEpoch;
      faultResult.attempts = retried.attempts;
    }
    if (fault && !faultResult.recovered) throw new Error('disconnect recovery not demonstrated');
    const latency = [...completedAt.values()].sort((a, b) => a - b);
    let sourceSha = null, sourceDirty = null;
    try {
      sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim();
      sourceDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim());
    } catch {}
    const report = { schema: 1, mode, scope: 'Local child processes controlled by one operator; not independent remote hosts',
      runtime: process.version, platform: `${process.platform}/${process.arch}`, sourceSha, sourceDirty, sourceFingerprint, sourceFingerprintScope: 'sorted src/*.mjs filenames, byte lengths and bytes, then package.json and package-lock.json filenames, byte lengths and bytes', fault: faultResult,
      tasks: tasks.length, verified, audience, controllerIdentity: getPublicKey(controllerKey), verifierIdentity: getPublicKey(verifierKey), workerIdentities: workers.map(w => w.pubkey), participatingWorkers: new Set(assignments.values()).size,
      elapsedMs: performance.now() - started, p95RunRelativeCompletionMs: latency[Math.ceil(latency.length * 0.95) - 1],
      syntheticQuotedCost: status.tasks.reduce((sum, task) => sum + task.spent, 0),
      costUnit: 'synthetic quote units, not actual compute billing', routingHistory: 'empty cold start; no evaluation leakage',
      outcomes: status.tasks.map(t => ({ id: t.spec.id, status: t.status, worker: assignments.get(t.spec.id), epoch: t.epoch, attempts: t.attempts, spent: t.spent, latencyMs: completedAt.get(t.spec.id), latencyBasis: 'run-relative verified completion', artifactHash: t.artifactHash, artifact: t.artifact, submissionEnvelope: t.submissionEnvelope, resultReceipt: t.resultReceipt, verification: t.verification })) };
    report.reportEnvelope=command(controllerKey,audience,'benchmark-report',{digest:digest(report)});
    return report;
  } finally {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.kill('SIGTERM');
    })));
    await service?.close();
    coordinator?.close();
    await router?.close?.();
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modes = process.argv[2] ? [process.argv[2]] : ['single', 'fixed', 'ruvector'];
  for (const mode of modes) console.log(JSON.stringify(await runBenchmark({ mode, fault: process.argv[3] ?? null })));
}
