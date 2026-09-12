/** Native library checks of recorded adaptive-vs-static development outcomes. No independent evaluation. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { loadLedger, hash } from './ledger.mjs';
import { replayHistory } from './replay-history.mjs';

const [dir, head, metaArg, autoArg, out] = process.argv.slice(2);
if (!dir || !head || !metaArg || !autoArg || !out || process.argv.length !== 7) throw Error('usage: toolcheck-capacity.mjs LEDGER HEAD META_PACKAGE AUTOGENOUS_REPO NEW_OUTPUT');
const verified = replayHistory(dir, head), receipt = loadLedger(dir, head).completed.at(-1);
const adaptive = receipt.improvementCapacity.find(a => a.arm === 'adaptive');
const control = receipt.improvementCapacity.find(a => a.arm === 'static');
assert.equal(adaptive.actualUnits, control.actualUnits);
const metaRoot = resolve(metaArg), autoRoot = resolve(autoArg);
const pkg = JSON.parse(readFileSync(join(metaRoot, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@metaharness/flywheel'); assert.equal(pkg.version, '0.1.11');
const autoCommit = '7bf327a9754ce798364dbee8b2825af42a421fd4';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: autoRoot, encoding: 'utf8' }).trim(), autoCommit);
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: autoRoot, stdio: 'pipe' });
const meta = await import(pathToFileURL(join(metaRoot, 'dist/index.js')).href);
const mean = rows => rows.reduce((sum, r) => sum + r.score, 0) / rows.length;
const scores = arm => {
  const probe = arm === 'candidate' ? adaptive : control, rows = probe.candidateSelection;
  const wins = rows.filter(r => r.rank === 1).length;
  return { primary: mean(rows), noopRate: 1 - wins / rows.length,
    costPerWin: probe.actualUnits / Math.max(1, wins), regressed: mean(rows) < mean(control.candidateSelection) };
};
const run = await meta.runFlywheelGenerations({ rootPolicy: { arm: 'baseline' }, proposer: async () => 'candidate',
  evaluator: async p => scores(p.arm), mutationTargets: ['arm'], holdout: { id: 'reused-development-selection-v2', items: [] },
  maxGenerations: 1, signer: meta.makeSigner(), dataSource: 'REPOSITORY_DEVELOPMENT' });
const replay = meta.verifyReplayBundle(run.replayBundle, { pinnedGateFingerprint: meta.gateFingerprint(meta.meetsPromotionRule), promotionRule: meta.meetsPromotionRule });
assert.equal(replay.pass, true);
const mesh = await import(pathToFileURL(join(autoRoot, 'packages/radio-moe/src/mesh-evolve.ts')).href);
const candidate = { separation: mean(adaptive.candidateSelection), hardGatesPass: true };
const baseline = { separation: mean(control.candidateSelection), hardGatesPass: true };
const decision = mesh.promoteAuthorized(candidate, baseline, { authorized: true, reversible: true });
assert.equal(decision.promote, false);
const report = { version: 'ruflo.loop-capacity-toolcheck/v1', ledgerHead: head, receiptHash: hash(receipt),
  sourceReplay: verified, comparator: 'adaptive versus fixed static', adaptive: scores('candidate'), static: scores('baseline'),
  metaharness: { version: pkg.version, replay, improvements: run.replayBundle.verified_improvements, bundle: run.replayBundle },
  autogenous: { source: autoCommit, decision,
    projection: 'Recorded child MRR mapped to separation. Authorization flags and MetaHarness signer are local gate fixtures, not independent evaluator identities.' },
  providerSpendUsd: 0, newTaskMeasurements: 0,
  limitation: 'Same public development rows projected into two existing native library gates. Work-unit cost proxy is not full acquisition dollars. No independent replication.',
  boundedRsiEvidenceAccepted: false, productionPromotion: false };
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ metaharnessReplay: replay.pass, metaharnessImprovements: report.metaharness.improvements,
  autogenous: decision, newTaskMeasurements: 0, boundedRsiEvidenceAccepted: false }, null, 2));
