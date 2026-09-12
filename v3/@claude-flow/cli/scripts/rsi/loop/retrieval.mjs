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
  ['train', 'memory/hybrid-retrieval.ts', 'sparse dense search reranking diversity'],
  ['train', 'memory/hybrid-retrieval.ts', 'subject body term frequency document normalization'],
  ['train', 'memory/embedding-policy.ts', 'choose embedding backend when provider unavailable'],
  ['train', 'memory/embedding-policy.ts', 'embedding provider configuration fallback policy'],
  ['train', 'memory/structured-distill.ts', 'structured distilled memory schema validation'],
  ['train', 'memory/structured-distill.ts', 'distill task outcome into reusable lesson fields'],
  ['train', 'services/flywheel-sequential-evidence.ts', 'allocate alpha across adaptive candidate tests'],
  ['train', 'services/flywheel-sequential-evidence.ts', 'anytime valid significance betting evidence'],
  ['train', 'services/harness-corpus-harvester.ts', 'harvest self supervised benchmark tasks from patterns'],
  ['train', 'services/harness-corpus-harvester.ts', 'corpus query target generation sampling'],
  ['train', 'memory/ewc-consolidation.ts', 'prevent catastrophic forgetting consolidate memory'],
  ['train', 'memory/ewc-consolidation.ts', 'elastic weight consolidation importance fisher'],
  ['selection', 'memory/cross-encoder-rerank.ts', 'rerank search results using cross encoder'],
  ['selection', 'memory/cross-encoder-rerank.ts', 'query document pair relevance scoring model'],
  ['selection', 'memory/rabitq-index.ts', 'quantized vector index compressed similarity search'],
  ['selection', 'memory/rabitq-index.ts', 'rabitq index persistence nearest neighbors'],
  ['selection', 'memory/graph-edge-writer.ts', 'write relationship edges into memory graph'],
  ['selection', 'memory/graph-edge-writer.ts', 'graph edge persistence relationship validation'],
  ['selection', 'services/flywheel-receipt.ts', 'verify signed improvement receipt paired outcomes'],
  ['selection', 'services/flywheel-receipt.ts', 'receipt canonical serialization signature gate'],
  ['selection', 'services/evolve-proof.ts', 'reconstruct evolution lineage rollback proof'],
  ['selection', 'services/evolve-proof.ts', 'detect improvement plateau mutation effectiveness'],
  ['selection', 'memory/embedding-quantization.ts', 'compress embeddings quantization precision'],
  ['selection', 'memory/embedding-quantization.ts', 'quantization embedding dimensions reconstruction'],
].map(([split, path, query], i) => ({ id: `development/${i}`, split, target: prefix + path, query }));

export function sourceIdentity() {
  return currentSource();
}
export function loadCorpus() {
  const paths = [...new Set(TASKS.map(t => t.target)),
    prefix + 'memory/intelligence.ts', prefix + 'memory/memory-initializer.ts',
    prefix + 'memory/bge-embedder.ts', prefix + 'memory/sona-optimizer.ts'];
  const docs = paths.map(path => {
    const body = execFileSync('git', ['show', `${CORPUS_COMMIT}:${path}`], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    return { path, bodyHash: hash(body), subject: tokenize(path.replace(/[/.-]/g, ' ')), body: tokenize(body) };
  });
  const trainTargets = new Set(TASKS.filter(t => t.split === 'train').map(t => t.target));
  if (TASKS.some(t => t.split === 'selection' && trainTargets.has(t.target))) throw Error('target split leakage');
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
export function propose(s) {
  const axes = ['b', 'k1', 'subjectWeight'], values = [[0, 0.5, 0.75, 1], [0.5, 1.5, 2.5], [0, 1, 3, 6]];
  const candidates = [], seen = new Set([hash(s.champion)]);
  const seed = parseInt(hash([s.epochs + 1, s.champion, s.credits]).slice(0, 8), 16);
  let random = seed;
  for (let i = 0; i < 80 && candidates.length < RULES.maxCandidates; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    let ticket = random / 4294967296 * s.credits.reduce((a, b) => a + b, 0), axis = 2;
    for (let j = 0; j < 3; j++) { ticket -= s.credits[j]; if (ticket < 0) { axis = j; break; } }
    const p = { ...s.champion, [axes[axis]]: values[axis][(i + s.epochs) % values[axis].length] };
    if (i >= 12) for (let j = 0; j < 3; j++) p[axes[j]] = values[j][(random >>> (j * 5)) % values[j].length];
    if (!seen.has(hash(p))) { candidates.push({ axis, policy: p }); seen.add(hash(p)); }
  }
  return candidates;
}
export function makeReservation(s, corpus) {
  const candidates = propose(s);
  const trainCount = TASKS.filter(t => t.split === 'train').length;
  const selectionCount = TASKS.length - trainCount;
  // Each native field BM25 call is metered; no uncharged baseline, failed candidate, or audit calls.
  const units = (trainCount * (1 + candidates.length) + selectionCount * 3) * corpus.docs.length * 2;
  return { epoch: s.epochs + 1, sourceHash: hash(s.source), corpusHash: corpus.commitment, units, candidates };
}
export function runReserved(s, corpus) {
  const reservation = s.pending;
  if (!reservation || hash(sourceIdentity()) !== reservation.sourceHash || corpus.commitment !== reservation.corpusHash) throw Error('source or corpus drift');
  const started = performance.now(), cpu = process.cpuUsage();
  const meter = { used: 0, charge(n) { if (this.used + n > reservation.units) throw Error('evaluation reservation exhausted'); this.used += n; } };
  const train = TASKS.filter(t => t.split === 'train'), selection = TASKS.filter(t => t.split === 'selection');
  const baselineTrain = scorePolicy(corpus, s.champion, train, meter), baselineMean = mean(baselineTrain.map(r => r.score));
  const attempts = reservation.candidates.map(c => ({ ...c, rows: scorePolicy(corpus, c.policy, train, meter) }));
  let winner = s.champion, best = baselineMean;
  const credits = s.credits.map(c => Math.max(1, c * 0.9));
  for (const a of attempts) {
    a.mean = mean(a.rows.map(r => r.score)); a.delta = a.mean - baselineMean;
    // All attempts retained. Only positive training improvement increases operator credit.
    credits[a.axis] = Math.min(100, credits[a.axis] + Math.max(0, a.delta) * 10);
    if (a.mean > best + 1e-12) { winner = a.policy; best = a.mean; }
  }
  const baselineSelection = scorePolicy(corpus, s.champion, selection, meter), candidateSelection = scorePolicy(corpus, winner, selection, meter);
  const rootSelection = scorePolicy(corpus, ROOT_POLICY, selection, meter);
  const selectionDelta = mean(candidateSelection.map((r, i) => r.score - baselineSelection[i].score));
  const selectionImproved = selectionDelta > 1e-12 && best > baselineMean + 1e-12;
  const measured = process.cpuUsage(cpu);
  return { dataSource: 'REPOSITORY_DEVELOPMENT', sourceHash: reservation.sourceHash, corpusHash: corpus.commitment,
    corpusCommit: CORPUS_COMMIT, corpusFiles: corpus.docs.map(d => ({ path: d.path, bodyHash: d.bodyHash })),
    epoch: reservation.epoch, beforePolicy: s.champion, proposedPolicy: winner, nextPolicy: selectionImproved ? winner : s.champion,
    baselineTrain, attempts, baselineSelection, candidateSelection, rootSelection, credits,
    trainDelta: best - baselineMean, selectionDelta, selectionImproved,
    actualUnits: meter.used, unit: 'native BM25 field score calls', providerSpendUsd: 0,
    elapsedMs: performance.now() - started, cpuMicros: measured.user + measured.system,
    boundedRsiEvidenceAccepted: false, productionPromotion: false,
    limitation: 'Public developer-authored repository retrieval queries; reused selection is development feedback. No blind transfer or recursive improvement efficacy claim.' };
}
