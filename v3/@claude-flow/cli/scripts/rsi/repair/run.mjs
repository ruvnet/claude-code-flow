#!/usr/bin/env node
/** Bounded calibration of known source pairs. No optimizer, signer provisioning or ledger writes. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { hash } from '../loop/ledger.mjs';
import { ROOT, LEDGER, LIMITS, prepare, admit, readBoundFile, sha256, ledgerFingerprint } from './admission.mjs';

export function freezeInputs(plan, root = ROOT) {
  const read = (path, digest) => { const bytes = readBoundFile(root, path); if (sha256(bytes) !== digest) throw Error('frozen execution bytes changed'); return bytes; };
  const corpus = JSON.parse(read('corpus.json', plan.corpusSha256));
  const witness = read('witness.mjs', plan.adapterSource['witness.mjs']);
  const snapshots = Object.fromEntries(Object.entries(plan.snapshotHashes).map(([path, digest]) => [path, read(path, digest)]));
  return { corpus, witness, snapshots };
}
export function calibrate(plan, expectedPlanHash, dir = LEDGER, root = ROOT) {
  const admission = admit(plan, expectedPlanHash, dir, root), before = ledgerFingerprint(dir);
  const start = performance.now(), cpu = process.cpuUsage(), rows = [];
  const { corpus, witness, snapshots } = freezeInputs(plan, root);
  const temp = mkdtempSync(join(tmpdir(), 'ruflo-repair-calibration-'));
  let processes = 0;
  try {
    writeFileSync(join(temp, 'witness.mjs'), witness);
    for (const task of corpus.tasks) for (const role of ['base', 'fixed']) {
      if (++processes > LIMITS.witnessProcesses) throw Error('calibration process ceiling');
      const transformed = {};
      for (const m of task[role].modules) {
        const original = snapshots[m.stored].toString('utf8');
        // The sole runtime-relative dependency is preserved from the same revision.
        const code = stripTypeScriptTypes(original).replace("'./flywheel-sequential-evidence.js'", "'./flywheel-sequential-evidence.mjs'");
        const filename = m.path.replace(/\.ts$/, '.mjs');
        transformed[filename] = sha256(code);
        writeFileSync(join(temp, filename), code);
      }
      const wall = performance.now();
      const result = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${temp}`, `--max-old-space-size=${LIMITS.heapMb}`, join(temp, 'witness.mjs'), task.id], {
        cwd: temp, env: { TZ: 'UTC', LANG: 'C', NODE_NO_WARNINGS: '1' }, encoding: 'utf8',
        timeout: LIMITS.timeoutMs, killSignal: 'SIGKILL', maxBuffer: LIMITS.maxOutputBytes,
      });
      const row = { taskId: task.id, cluster: task.cluster, role, commit: task[role].commit,
        sourceBlobs: task[role].modules.map(m => m.gitBlob), transformed,
        processWallMs: performance.now() - wall, exitCode: result.status, signal: result.signal,
        stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
      try { row.measurement = result.status === 0 && !result.error ? JSON.parse(result.stdout) : null; } catch { row.measurement = null; }
      rows.push(row);
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
  const ledgerUnchanged = before === ledgerFingerprint(dir);
  if (!ledgerUnchanged) throw Error('mission changed during calibration; discard results');
  const pairs = corpus.tasks.map(task => {
    const base = rows.find(r => r.taskId === task.id && r.role === 'base');
    const fixed = rows.find(r => r.taskId === task.id && r.role === 'fixed');
    const b = base.measurement?.observations, f = fixed.measurement?.observations;
    return { taskId: task.id, basePasses: b?.filter(o => o.passed).length ?? null,
      fixedPasses: f?.filter(o => o.passed).length ?? null, checks: f?.length ?? null,
      witnessed: !!b && !!f && b.length === f.length && b.slice(0, 2).every(o => o.passed) && b.some(o => !o.passed) && f.every(o => o.passed) };
  });
  return { schema: 'ruflo.repair-calibration-result/v1', ...admission,
    regressionWitnessesVerified: pairs.every(p => p.witnessed), missionHead: plan.mission.head,
    ledgerUnchanged, independentClusters: corpus.independentClusters, exposure: corpus.exposure,
    nodeVersion: process.version, platform: process.platform, arch: process.arch, pairs, rows,
    costs: { scope: 'FIXED_REGRESSION_CALIBRATION_ONLY', witnessProcesses: processes,
      totalWallMs: performance.now() - start, parentCpuMicros: process.cpuUsage(cpu),
      childMeasuredCpuMicros: rows.every(r => r.measurement) ? rows.reduce((sum, r) => sum + r.measurement.cpuMicros.user + r.measurement.cpuMicros.system, 0) : null,
      childCpuScope: 'module import and witness checks; excludes Node startup',
      externalProviderSpendUsd: 0, totalAcquisitionUsd: null, totalEvaluationUsd: null,
      missionCandidateEvaluations: 0, missionNativeFieldCallsAdded: 0,
      exclusions: ['source acquisition', 'research and code generation', 'other tests and CI', 'host dollar allocation'],
    } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, file, anchor, extra] = process.argv.slice(2);
    if (!file || !anchor || extra) throw Error('usage: run.mjs prepare LEDGER HEAD | inspect PLAN PLAN_HASH | replay PLAN PLAN_HASH');
    if (command === 'prepare') {
      const plan = prepare(resolve(file), anchor); console.log(JSON.stringify({ plan, planHash: hash(plan) }, null, 2));
    } else if (command === 'inspect' || command === 'replay') {
      const { plan } = JSON.parse(readFileSync(resolve(file), 'utf8'));
      const report = command === 'inspect' ? admit(plan, anchor) : calibrate(plan, anchor);
      console.log(JSON.stringify(report, null, 2));
      if (command === 'replay' && !report.regressionWitnessesVerified) process.exitCode = 1;
    } else throw Error('unknown command; candidate execution is not implemented');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
