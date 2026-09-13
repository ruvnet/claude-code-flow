/** Real RuFlo BM25 implementation, public developer-authored queries. Never final RSI evidence. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tokenize, buildCorpusStats, bm25Score } from '../../../src/memory/hybrid-retrieval.ts';
import { hash, validatePolicy, RULES, ROOT_POLICY, currentSource } from './ledger.mjs';

export const CORPUS_COMMIT = 'b02c0cacec225deea01f586b66a9694393369432';
const repo = resolve(fileURLToPath(new URL('../../../../../../', import.meta.url)));
const prefix = 'v3/@claude-flow/cli/src/';
// File-disjoint train/selection query targets; all queries are developer-authored and public.
export const TASKS = [
  ['train', 'memory/hybrid-retrieval.ts', 'Search keeps returning near duplicates despite strong semantic matches. Where are lexical and vector ranks combined?'],
  ['train', 'memory/hybrid-retrieval.ts', 'A term in a short title should compete with the same term repeated in a long document. Where is this scored?'],
  ['train', 'memory/embedding-policy.ts', 'Offline workers need a compatible local representation when the configured remote model is unavailable. Where is that decision made?'],
  ['train', 'memory/embedding-policy.ts', 'An existing store has vectors of a different dimension from the newly selected backend. Which rules choose a compatible provider?'],
  ['train', 'memory/structured-distill.ts', 'A completed task contains a lesson and an approach to avoid. Where do we turn that into a validated record?'],
  ['train', 'memory/structured-distill.ts', 'Generated knowledge has missing required fields and an invalid confidence value. Where should it be checked before storage?'],
  ['train', 'services/flywheel-sequential-evidence.ts', 'We keep trying more candidate changes after failures. Where do we account for repeated statistical looks?'],
  ['train', 'services/flywheel-sequential-evidence.ts', 'The next experiment must retain the error allowance already spent on rejected candidates. Which module tracks it?'],
  ['train', 'services/harness-corpus-harvester.ts', 'We have stored successful work but need examples for testing a new agent. Where are those converted into questions and expected answers?'],
  ['train', 'services/harness-corpus-harvester.ts', 'Which component builds a reproducible task collection from existing patterns without calling a paid model?'],
  ['train', 'memory/ewc-consolidation.ts', 'New lessons are overwriting behavior that was useful on earlier tasks. Where are important parameters protected?'],
  ['train', 'memory/ewc-consolidation.ts', 'Which learning component penalizes changes according to how much each old parameter mattered?'],
  ['selection', 'memory/cross-encoder-rerank.ts', 'The first search pass is fast but its top results are not relevant enough. Where can a model read the question together with each result?'],
  ['selection', 'memory/cross-encoder-rerank.ts', 'A small shortlist needs a slower pairwise relevance pass after initial retrieval. Where is its model loaded and used?'],
  ['selection', 'memory/rabitq-index.ts', 'Millions of stored vectors use too much space. Which search structure keeps compact codes but can still retrieve nearby entries?'],
  ['selection', 'memory/rabitq-index.ts', 'A compressed nearest neighbor structure must survive a process restart. Where is its state serialized?'],
  ['selection', 'memory/graph-edge-writer.ts', 'Two learned records refer to related work. Where is their connection validated and persisted for later traversal?'],
  ['selection', 'memory/graph-edge-writer.ts', 'A relationship update must not link a record to itself or create an invalid endpoint. Which writer enforces this?'],
  ['selection', 'services/flywheel-receipt.ts', 'A claimed quality improvement came from another process. Where can we check the signed measurements and canonical payload?'],
  ['selection', 'services/flywheel-receipt.ts', 'Which artifact binds before and after evaluation results to the candidate that produced them?'],
  ['selection', 'services/evolve-proof.ts', 'An optimization run stopped making progress. Where can we inspect its ancestry and whether mutations still help?'],
  ['selection', 'services/evolve-proof.ts', 'After rolling back a proposed change we need evidence of the surviving lineage. Which component reconstructs it?'],
  ['selection', 'memory/embedding-quantization.ts', 'Float arrays consume too much memory in transit. Where can we reduce numeric precision and measure reconstruction error?'],
  ['selection', 'memory/embedding-quantization.ts', 'Stored representations need fewer bytes per dimension while preserving useful similarity. Where are encoding formats selected?'],
].map(([split, path, query], i) => ({ id: `development-v2/${i}`, split, target: prefix + path, query }));

export function sourceIdentity() {
  return currentSource();
}
export function loadCorpus() {
  // Include every pinned module in both directories, not just the labeled targets.
  const paths = execFileSync('git', ['ls-tree', '-r', '--name-only', CORPUS_COMMIT, '--',
    prefix + 'memory', prefix + 'services'], { cwd: repo, encoding: 'utf8' })
    .trim().split('\n').filter(p => p.endsWith('.ts')).sort();
  const docs = paths.map(path => {
    const body = execFileSync('git', ['show', `${CORPUS_COMMIT}:${path}`], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return { path, bodyHash: hash(body), subject: tokenize(path.replace(/[/.-]/g, ' ')), body: tokenize(body) };
  });
  const trainTargets = new Set(TASKS.filter(t => t.split === 'train').map(t => t.target));
  if (TASKS.some(t => t.split === 'selection' && trainTargets.has(t.target))) throw Error('target split leakage');
  if (TASKS.some(t => !paths.includes(t.target))) throw Error('missing labeled target');
  return { docs, subjectStats: buildCorpusStats(docs.map(d => d.subject)), bodyStats: buildCorpusStats(docs.map(d => d.body)),
    commitment: hash({ commit: CORPUS_COMMIT, docs: docs.map(({ path, bodyHash }) => ({ path, bodyHash })), tasks: TASKS }) };
}
export function scorePolicy(corpus, policy, tasks, meter) {
  validatePolicy(policy);
  return tasks.map(t => {
    const q = tokenize(t.query);
    const ranked = corpus.docs.map(d => {
      meter?.charge(2);
      return { path: d.path, score: policy.subjectWeight * bm25Score(q, d.subject, corpus.subjectStats, policy.k1, policy.b)
        + bm25Score(q, d.body, corpus.bodyStats, policy.k1, policy.b) };
    })
      .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const rank = ranked.findIndex(d => d.path === t.target) + 1;
    return { taskId: t.id, target: t.target, rank, score: 1 / rank };
  });
}
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
export const ARMS = Object.freeze(['adaptive', 'frozen', 'static', 'shuffled', 'previous', 'legacy']);
// Exact v2 proposer body retained as an implementation control, not an independent evaluator.
export function proposeLegacy(s, count = 2) {
  const axes = ['b', 'k1', 'subjectWeight'], values = [[0, 0.5, 0.75, 1], [0.5, 1.5, 2.5], [0, 1, 3, 6]];
  const candidates = [], seen = new Set([hash(s.champion)]);
  // Common random addresses across arms. Credits affect operator selection, not the seed.
  const seed = parseInt(hash([s.epochs + 1, s.champion]).slice(0, 8), 16);
  let random = seed;
  for (let i = 0; i < 80 && candidates.length < count; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    let ticket = random / 4294967296 * s.credits.reduce((a, b) => a + b, 0), axis = 2;
    for (let j = 0; j < 3; j++) { ticket -= s.credits[j]; if (ticket < 0) { axis = j; break; } }
    const p = { ...s.champion, [axes[axis]]: values[axis][(i + s.epochs) % values[axis].length] };
    if (i >= 12) for (let j = 0; j < 3; j++) p[axes[j]] = values[j][(random >>> (j * 5)) % values[j].length];
    if (!seen.has(hash(p))) { candidates.push({ axis, policy: p }); seen.add(hash(p)); }
  }
  return candidates;
}
export function propose(s, count = 2) {
  if (count !== 2) throw Error('joint coverage requires exactly two proposals');
  const axes = ['b', 'k1', 'subjectWeight'];
  // Predeclared alternating corners. The high corner was a known development
  // winner before this source was frozen; it is not a novel discovery or learned rule.
  const policy = (s.epochs + 1) % 2 === 1
    ? { b: 1, k1: 2.5, subjectWeight: 6 } : { b: 0, k1: 0.5, subjectWeight: 0 };
  const editedAxes = axes.flatMap((key, i) => policy[key] !== s.champion[key] ? [i] : []);
  const single = proposeLegacy(s, RULES.maxCandidates).find(c => axes.filter(key => c.policy[key] !== s.champion[key]).length === 1);
  if (editedAxes.length < 2 || !single) throw Error('joint and single-axis coverage unavailable');
  return [{ axis: editedAxes[0], editedAxes, operator: 'joint-corner', policy },
    { ...single, editedAxes: [single.axis], operator: 'credit-guided-single' }];
}
export function creditUpdate(before, attempts) {
  const credits = before.map(c => Math.max(1, c * 0.9)), allocations = [];
  for (const a of attempts.filter(a => a.arm === 'adaptive')) {
    const editedAxes = a.editedAxes ?? [a.axis], share = Math.max(0, a.delta) * 10 / editedAxes.length;
    const assigned = editedAxes.map(axis => {
      const added = Math.min(100 - credits[axis], share); credits[axis] += added;
      return { axis, added };
    });
    allocations.push({ policyHash: hash(a.policy), editedAxes, assigned });
  }
  return { credits, allocations };
}
export function makeReservation(s, corpus) {
  const previousSnapshot = s.snapshots.at(-2) ?? s.snapshots[0];
  const previousCredits = previousSnapshot.credits;
  if (s.completed.at(-1)?.beforeCredits && hash(previousCredits) !== hash(s.completed.at(-1).beforeCredits)) throw Error('previous optimizer ancestry mismatch');
  const optimizerInputs = {
    adaptive: { credits: s.credits, checkpoint: s.snapshots.at(-1).id },
    frozen: { credits: [1, 1, 1], checkpoint: s.snapshots[0].id },
    static: { rule: 'fixed-two-corners/v1' },
    shuffled: { credits: [s.credits[1], s.credits[2], s.credits[0]], checkpoint: s.snapshots.at(-1).id },
    previous: { credits: previousCredits, checkpoint: previousSnapshot.id },
    legacy: { credits: [1, 1, 1], checkpoint: s.snapshots[0].id, implementation: 'v2-uniform',
      sourceCommit: '959d70cebcd413cee16b181999b0fb6a962fed1b' },
  };
  const candidates = ARMS.flatMap(arm => (arm === 'static'
    ? [{ axis: 0, policy: { b: 0, k1: 0.5, subjectWeight: 0 } }, { axis: 2, policy: { b: 1, k1: 2.5, subjectWeight: 6 } }]
    : (arm === 'legacy' ? proposeLegacy : propose)({ epochs: s.epochs, champion: ROOT_POLICY, credits: optimizerInputs[arm].credits }))
    .map(c => ({ arm, ...c })));
  if (candidates.length !== 12 || candidates.length > RULES.maxCandidates) throw Error('matched candidate plan');
  const trainCount = TASKS.filter(t => t.split === 'train').length;
  const selectionCount = TASKS.length - trainCount;
  // Each native field BM25 call is metered; no uncharged baseline, failed candidate, or audit calls.
  // Six common-start baselines, twelve failed/successful proposals, six child
  // selection evaluations and six selection baselines. Parent audit is charged separately.
  const units = (trainCount * (ARMS.length + candidates.length) + selectionCount * (2 * ARMS.length + 1)) * corpus.docs.length * 2;
  return { epoch: s.epochs + 1, sourceHash: hash(s.source), corpusHash: corpus.commitment, units, candidates, optimizerInputs };
}
export function runReserved(s, corpus) {
  const reservation = s.pending;
  if (!reservation || hash(sourceIdentity()) !== reservation.sourceHash || corpus.commitment !== reservation.corpusHash) throw Error('source or corpus drift');
  const expected = makeReservation({ ...s, epochs: reservation.epoch - 1 }, corpus);
  if (hash(expected.candidates) !== hash(reservation.candidates) || hash(expected.optimizerInputs) !== hash(reservation.optimizerInputs)) throw Error('optimizer reservation drift');
  const started = performance.now(), cpu = process.cpuUsage();
  const meter = { used: 0, charge(n) { if (this.used + n > reservation.units) throw Error('evaluation reservation exhausted'); this.used += n; } };
  const train = TASKS.filter(t => t.split === 'train'), selection = TASKS.filter(t => t.split === 'selection');
  const attempts = [], improvementCapacity = [];
  for (const arm of ARMS) {
    const beforeUnits = meter.used;
    const baselineTrain = scorePolicy(corpus, ROOT_POLICY, train, meter), baselineMean = mean(baselineTrain.map(r => r.score));
    let winner = ROOT_POLICY, best = baselineMean;
    for (const c of reservation.candidates.filter(c => c.arm === arm)) {
      const a = { ...c, rows: scorePolicy(corpus, c.policy, train, meter) };
      a.mean = mean(a.rows.map(r => r.score)); a.delta = a.mean - baselineMean; attempts.push(a);
      if (a.mean > best + 1e-12) { winner = a.policy; best = a.mean; }
    }
    const baselineSelection = scorePolicy(corpus, ROOT_POLICY, selection, meter);
    const candidateSelection = scorePolicy(corpus, winner, selection, meter);
    const selectionGain = mean(candidateSelection.map((r, i) => r.score - baselineSelection[i].score));
    const actualUnits = meter.used - beforeUnits;
    improvementCapacity.push({ arm, optimizer: reservation.optimizerInputs[arm], optimizationStartPolicy: ROOT_POLICY,
      childPolicy: winner, baselineTrain, baselineSelection, candidateSelection, trainGain: best - baselineMean,
      selectionGain, actualUnits, gainPer10000Calls: selectionGain * 10000 / actualUnits });
  }
  const adaptive = improvementCapacity[0], winner = adaptive.childPolicy;
  // Shared credit for a joint mutation is a learning heuristic, not causal axis attribution.
  const { credits, allocations: creditAllocations } = creditUpdate(s.credits, attempts);
  const baselineSelection = scorePolicy(corpus, s.champion, selection, meter), candidateSelection = adaptive.candidateSelection;
  const selectionDelta = mean(candidateSelection.map((r, i) => r.score - baselineSelection[i].score));
  const selectionImproved = selectionDelta > 1e-12 && adaptive.trainGain > 1e-12;
  const measured = process.cpuUsage(cpu);
  return { dataSource: 'REPOSITORY_DEVELOPMENT', sourceHash: reservation.sourceHash, corpusHash: corpus.commitment,
    corpusCommit: CORPUS_COMMIT, corpusFiles: corpus.docs.map(d => ({ path: d.path, bodyHash: d.bodyHash })),
    epoch: reservation.epoch, beforePolicy: s.champion, proposedPolicy: winner, nextPolicy: selectionImproved ? winner : s.champion,
    optimizationStartPolicy: ROOT_POLICY, beforeCredits: s.credits, creditAllocations,
    baselineTrain: adaptive.baselineTrain, attempts, baselineSelection, candidateSelection, rootSelection: adaptive.baselineSelection, credits,
    improvementCapacity, controlComparisons: improvementCapacity.slice(1).map(c => ({ control: c.arm,
      pairedSelectionDeltas: candidateSelection.map((r, i) => ({ taskId: r.taskId, delta: r.score - c.candidateSelection[i].score })),
      capacityDeltaPer10000Calls: adaptive.gainPer10000Calls - c.gainPer10000Calls })),
    parentAuditUnits: selection.length * corpus.docs.length * 2,
    trainDelta: adaptive.trainGain, selectionDelta, selectionImproved,
    actualUnits: meter.used, unit: 'native BM25 field score calls', providerSpendUsd: 0,
    elapsedMs: performance.now() - started, cpuMicros: measured.user + measured.system,
    boundedRsiEvidenceAccepted: false, productionPromotion: false,
    limitation: 'Public developer-authored paraphrases with previously observed targets. Matched common-start improver probes use reused development queries and native-call costs, not full acquisition dollars. No independent generalization or RSI claim.' };
}
