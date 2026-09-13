#!/usr/bin/env node
/** Explicit optional tooling check. Never changes the experiment or promotes a policy. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { replay, digest } from './experiment.mjs';

const AUTOGENOUS_SHA = '7bf327a9754ce798364dbee8b2825af42a421fd4';
const METAHARNESS_VERSION = '0.1.11';
const here = fileURLToPath(new URL('.', import.meta.url));
const [metaArg, autoArg, outArg] = process.argv.slice(2);
if (!metaArg || !autoArg || !outArg || process.argv.length !== 5) throw new Error('usage: crosscheck.mjs METAHARNESS_PACKAGE_ROOT AUTOGENOUS_REPO NEW_OUTPUT');
const metaRoot = resolve(metaArg), autoRoot = resolve(autoArg);
const packageMeta = JSON.parse(readFileSync(join(metaRoot, 'package.json'), 'utf8'));
assert.equal(packageMeta.name, '@metaharness/flywheel');
assert.equal(packageMeta.version, METAHARNESS_VERSION);
assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: autoRoot, encoding: 'utf8' }).trim(), AUTOGENOUS_SHA);
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--'], { cwd: autoRoot, stdio: 'pipe' });

const bundle = JSON.parse(readFileSync(join(here, 'evidence/default.json'), 'utf8'));
const originalReplay = replay(bundle, readFileSync(join(here, 'evidence/public.pem'), 'utf8'));
const data = bundle.result;
const meta = await import(pathToFileURL(join(metaRoot, 'dist/index.js')).href);
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const scoreFor = (arm, suite) => {
  const families = suite.id === 'anchor' ? ['stationary'] : ['stationary', 'shifted'];
  const gains = data.runs.flatMap(r => families.flatMap(f => r.results[arm].gains[f]));
  const successes = gains.filter(x => x > 0).length;
  return { primary: mean(gains), noopRate: 1 - successes / gains.length,
    costPerWin: data.runs.reduce((s, r) => s + r.results[arm].costs.evaluations, 0) / Math.max(1, successes), regressed: false };
};
// One candidate, no new optimization against already observed outer data.
const metaRun = await meta.runFlywheelGenerations({
  rootPolicy: { optimizer: 'frozen' },
  proposer: async () => 'adaptive',
  evaluator: async (policy, suite) => { assert.ok(['frozen', 'adaptive'].includes(policy.optimizer)); return scoreFor(policy.optimizer, suite); },
  holdout: { id: 'holdout', items: [] }, anchor: { id: 'anchor', items: [] },
  mutationTargets: ['optimizer'], maxGenerations: 1, signer: meta.makeSigner(),
  now: g => `SYNTHETIC-CROSSCHECK-${g}`, dataSource: 'SYNTHETIC',
});
const metaReplay = meta.verifyReplayBundle(metaRun.replayBundle, { pinnedGateFingerprint: meta.gateFingerprint(meta.meetsPromotionRule), promotionRule: meta.meetsPromotionRule });
assert.equal(metaReplay.pass, true);
assert.equal(metaRun.replayBundle.verified_improvements, 0);
const rejected = metaRun.replayBundle.all_commits.filter(c => c.verdict === 'REJECTED');
assert.ok(rejected.some(c => c.failureReasons.includes('primary_regressed')));

// Execute Autogenous's own mesh domain without mislabeling its separation metric as RSI.
// Requires its locked tsx loader; caller passes --import explicitly (see README).
const mesh = await import(pathToFileURL(join(autoRoot, 'packages/radio-moe/src/mesh-evolve.ts')).href);
const { PeerIdentity } = await import(pathToFileURL(join(autoRoot, 'packages/radio-moe/src/transport.ts')).href);
const { DEFAULT_INDEPENDENCE_WEIGHTS } = await import(pathToFileURL(join(autoRoot, 'packages/radio-moe/src/lineage-independence.ts')).href);
const identity = PeerIdentity.generate();
const initial = mesh.evaluate({ weights: { ...DEFAULT_INDEPENDENCE_WEIGHTS }, quorumThreshold: 2 });
const evolved = mesh.evolveMesh(identity, 42, 30, 4);
const repeated = mesh.evolveMesh(identity, 42, 30, 4);
assert.deepEqual(evolved.champion, repeated.champion);
assert.equal(mesh.verifyLedger(evolved, identity.publicKeyDer.toString('hex')), true);
const corrupt = { ...evolved, ledgerFrames: evolved.ledgerFrames.map((f, i) => i === 0 ? { ...f, value: 'forged' } : f) };
assert.equal(mesh.verifyLedger(corrupt, identity.publicKeyDer.toString('hex')), false);
assert.ok(evolved.promotions > 0);
assert.ok(evolved.fitness.separation > initial.separation);
assert.equal(mesh.promoteAuthorized(evolved.fitness, initial, { authorized: false, reversible: true }).promote, false);
assert.equal(mesh.promoteAuthorized(evolved.fitness, initial, { authorized: true, reversible: false }).promote, false);

const report = {
  version: 'ruflo.rsi-crosscheck/v1', dataSource: 'SYNTHETIC', experimentDigest: digest(data), originalReplay,
  metaharness: { version: METAHARNESS_VERSION, projection: 'recorded fresh optimizer gains, not independent task measurements',
    defaultGateFingerprint: meta.gateFingerprint(meta.meetsPromotionRule), replay: metaReplay,
    improvements: metaRun.replayBundle.verified_improvements, rejectedReasons: rejected.map(c => c.failureReasons), bundle: metaRun.replayBundle },
  autogenous: { source: AUTOGENOUS_SHA, domain: 'native fixed mesh separation fixture, NOT optimizer-efficiency benchmark',
    seed: 42, generations: 30, population: 4, initial: initial.separation, final: evolved.fitness.separation,
    promotions: evolved.promotions, hardGates: evolved.fitness.hardGatesPass, deterministicChampion: true,
    signatureAndChainVerified: true, tamperRejected: true, unauthorizedRejected: true, irreversibleRejected: true,
    publicKeyDerHex: identity.publicKeyDer.toString('hex'), history: evolved.history,
    ledgerFrames: evolved.ledgerFrames, ledger: evolved.ledger,
    nativeRustVerifierExecuted: false, nativeRustBlocker: 'cargo unavailable' },
  decision: { rsiEfficacy: 'NOT_PROVEN', deploy: false,
    explanation: 'MetaHarness rejects the measured RSI candidate. Autogenous demonstrates bounded mesh parameter evolution on its existing fixture, not recursive improvement efficiency.' },
};
writeFileSync(outArg, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ metaharness: { replay: metaReplay.pass, rejectedReasons: report.metaharness.rejectedReasons },
  autogenous: { initial: initial.separation, final: evolved.fitness.separation, promotions: evolved.promotions, ledgerVerified: true }, decision: report.decision }, null, 2));
