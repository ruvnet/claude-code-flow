/** Optional existing-library gates over recorded native retrieval outcomes. No new task measurements. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { loadLedger, hash } from './ledger.mjs';
import { replayDevelopment } from './run.mjs';
const [dir, head, metaArg, autoArg, out] = process.argv.slice(2);
if (!dir || !head || !metaArg || !autoArg || !out || process.argv.length !== 7) throw Error('usage: toolcheck.mjs LEDGER HEAD META_PACKAGE AUTOGENOUS_REPO NEW_OUTPUT');
const verified = replayDevelopment(dir, head), state = loadLedger(dir, head), receipt = state.completed.at(-1);
assert.ok(receipt, 'completed development epoch required');
const metaRoot = resolve(metaArg), autoRoot = resolve(autoArg);
const pkg = JSON.parse(readFileSync(join(metaRoot, 'package.json'), 'utf8'));
assert.equal(pkg.name, '@metaharness/flywheel'); assert.equal(pkg.version, '0.1.11');
const autoCommit = '7bf327a9754ce798364dbee8b2825af42a421fd4';
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: autoRoot, encoding: 'utf8' }).trim(), autoCommit);
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: autoRoot, stdio: 'pipe' });
const meta = await import(pathToFileURL(join(metaRoot, 'dist/index.js')).href);
const mean = rows => rows.reduce((sum, r) => sum + r.score, 0) / rows.length;
const scores = arm => {
  const rows = arm === 'candidate' ? receipt.candidateSelection : receipt.baselineSelection;
  const wins = rows.filter(r => r.rank === 1).length;
  return { primary: mean(rows), noopRate: 1 - wins / rows.length, costPerWin: rows.length * receipt.corpusFiles.length * 2 / Math.max(1, wins), regressed: false };
};
const run = await meta.runFlywheelGenerations({ rootPolicy: { arm: 'baseline' }, proposer: async () => 'candidate',
  evaluator: async p => scores(p.arm), mutationTargets: ['arm'], holdout: { id: 'development-selection', items: [] },
  maxGenerations: 1, signer: meta.makeSigner(), dataSource: 'REPOSITORY_DEVELOPMENT' });
const replay = meta.verifyReplayBundle(run.replayBundle, { pinnedGateFingerprint: meta.gateFingerprint(meta.meetsPromotionRule), promotionRule: meta.meetsPromotionRule });
assert.equal(replay.pass, true);
const mesh = await import(pathToFileURL(join(autoRoot, 'packages/radio-moe/src/mesh-evolve.ts')).href);
const candidate = { separation: mean(receipt.candidateSelection), hardGatesPass: true };
const baseline = { separation: mean(receipt.baselineSelection), hardGatesPass: true };
const allowedFixture = mesh.promoteAuthorized(candidate, baseline, { authorized: true, reversible: true });
assert.equal(mesh.promoteAuthorized(candidate, baseline, { authorized: false, reversible: true }).promote, false);
assert.equal(mesh.promoteAuthorized(candidate, baseline, { authorized: true, reversible: false }).promote, false);
const report = { version: 'ruflo.loop-toolcheck/v1', ledgerHead: head, receiptHash: hash(receipt), replayedEpochs: verified.replayedEpochs,
  metaharness: { version: pkg.version, replay, improvements: run.replayBundle.verified_improvements, bundle: run.replayBundle },
  autogenous: { source: autoCommit, projection: 'MRR mapped onto separation solely to exercise native gate; authorization context is a local test fixture',
    decision: allowedFixture, unauthorizedRejected: true, irreversibleRejected: true },
  limitation: 'Library gate projections of the same recorded developer data, not independent task evaluation. Work-unit cost proxy is not dollars.',
  boundedRsiEvidenceAccepted: false, productionPromotion: false };
writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ledgerHead: head, metaharnessReplay: replay.pass, metaharnessImprovements: report.metaharness.improvements,
  autogenous: allowedFixture, boundedRsiEvidenceAccepted: false }, null, 2));
