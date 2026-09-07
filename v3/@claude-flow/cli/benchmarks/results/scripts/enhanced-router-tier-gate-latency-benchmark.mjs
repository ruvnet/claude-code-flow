#!/usr/bin/env node
// enhanced-router-tier-gate-latency-benchmark.mjs — non-inferiority latency
// microbenchmark for the neuralFieldsFor() tier-match gate added to
// EnhancedModelRouter.route() (dream/2026-09-07-intelligence, #3220/#3221).
//
// The candidate fix replaces an unconditional field-spread with a
// baseResult.model === model closure check. This isolates and measures the
// per-call cost of OLD (unconditional spread) vs NEW (gated closure) against
// each other, in-memory, no I/O — the frozen hypothesis's "zero added
// latency" condition, made falsifiable with an explicit non-inferiority
// threshold rather than an unmeasured assertion (per 2026-09-07 PR review).
//
// Usage:
//   cd v3/@claude-flow/cli
//   node benchmarks/results/scripts/enhanced-router-tier-gate-latency-benchmark.mjs [--iters N] [--runs N]

function argNum(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? parseFloat(process.argv[i + 1]) : fallback;
}

const ITER = argNum('--iters', 2_000_000);
const RUNS = argNum('--runs', 5);
const THRESHOLD_PCT = argNum('--threshold-pct', 20); // non-inferiority band

const baseResult = {
  model: 'opus',
  confidence: 0.9,
  modelId: 'inclusionai/ling-2.6-flash',
  routedBy: 'hybrid',
  provider: 'openrouter',
  openrouterModel: 'inclusionai/ling-2.6-flash',
};

// OLD: the unconditional spread this PR replaced.
function oldWay() {
  const neuralFields = {
    ...(baseResult.modelId ? { modelId: baseResult.modelId } : {}),
    ...(baseResult.routedBy ? { routedBy: baseResult.routedBy } : {}),
    ...(baseResult.provider ? { provider: baseResult.provider } : {}),
    ...(baseResult.openrouterModel ? { openrouterModel: baseResult.openrouterModel } : {}),
  };
  return { tier: 3, model: 'opus', ...neuralFields };
}

// NEW: the tier-gated closure this PR introduces.
function neuralFieldsFor(model) {
  return baseResult.model === model
    ? {
        ...(baseResult.modelId ? { modelId: baseResult.modelId } : {}),
        ...(baseResult.routedBy ? { routedBy: baseResult.routedBy } : {}),
        ...(baseResult.provider ? { provider: baseResult.provider } : {}),
        ...(baseResult.openrouterModel ? { openrouterModel: baseResult.openrouterModel } : {}),
      }
    : {};
}
function newWay() {
  return { tier: 3, model: 'opus', ...neuralFieldsFor('opus') };
}

function bench(fn, iters) {
  for (let i = 0; i < 50_000; i++) fn(); // warmup
  const start = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn();
  const end = process.hrtime.bigint();
  return Number(end - start) / iters; // ns/call
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

const oldNs = [];
const newNs = [];
for (let r = 0; r < RUNS; r++) {
  oldNs.push(bench(oldWay, ITER));
  newNs.push(bench(newWay, ITER));
}
const oldMean = mean(oldNs);
const newMean = mean(newNs);
const deltaPct = ((newMean - oldMean) / oldMean) * 100;
const pass = Math.abs(deltaPct) <= THRESHOLD_PCT;

const result = {
  iters: ITER,
  runs: RUNS,
  thresholdPct: THRESHOLD_PCT,
  oldNsPerCall: oldNs,
  newNsPerCall: newNs,
  oldMeanNs: oldMean,
  newMeanNs: newMean,
  deltaPct,
  verdict: pass ? 'PASS' : 'FAIL',
  note: 'Single string-equality check added per branch, in-memory, no I/O. route()\'s own AST analysis / file reads / bandit-router call dominate end-to-end latency by 3-6 orders of magnitude (microseconds-to-milliseconds vs. ~100ns here).',
};

console.log(`old (unconditional spread): ${oldMean.toFixed(2)} ns/call  [${oldNs.map((x) => x.toFixed(1)).join(', ')}]`);
console.log(`new (gated closure):        ${newMean.toFixed(2)} ns/call  [${newNs.map((x) => x.toFixed(1)).join(', ')}]`);
console.log(`delta: ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%  (non-inferiority threshold: +/-${THRESHOLD_PCT}%)`);
console.log(`result: ${result.verdict}`);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
}

process.exitCode = pass ? 0 : 1;
