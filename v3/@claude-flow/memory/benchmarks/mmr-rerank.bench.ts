/**
 * mmrRerank wall-clock benchmark (Dream Cycle 2026-09-10).
 *
 * Measures `applyMMR` (candidate: lazy, cached tokenization) against a
 * frozen copy of the pre-candidate algorithm (baseline: eager tokenization
 * on every outer-loop pass) on the same synthetic corpus, so the tokenize()
 * call-count reduction proven in `src/mmr-rerank-perf.test.ts` has a real
 * measured latency number behind it, not just an asserted call count.
 *
 * Corpus: N=30 candidates, limit=20, all with well-formed matching-dimension
 * embeddings — the common production shape since PR #3169 wired embeddings
 * through `smartSearch`'s call sites.
 *
 * @see {@link ../docs/adr/ADR-125-memory-consolidation.md}
 */
import { describe, bench } from 'vitest';
import { applyMMR, tokenize, type SearchCandidate } from '../src/smart-retrieval.js';

function seededEmbedding(seed: number, dim = 8): number[] {
  const out: number[] = [];
  let x = seed * 2654435761;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push((x % 1000) / 1000);
  }
  return out;
}

const N = 30;
const LIMIT = 20;

const corpus: SearchCandidate[] = Array.from({ length: N }, (_, i) => ({
  id: `c${i}`,
  key: `c${i}`,
  namespace: 'bench',
  content: Array.from({ length: 6 }, (_, w) => `w${(i * 7 + w) % 40}`).join(' ') + ` item ${i}`,
  score: 1 - i / N,
  embedding: seededEmbedding(i),
}));
const scored = corpus.map((c) => ({ candidate: c, score: c.score }));

/** Frozen copy of the pre-candidate algorithm — eager tokenize() every outer pass. */
function baselineMmrRerank(
  input: Array<{ candidate: SearchCandidate; score: number }>,
  lambda: number,
  limit: number
): Array<{ candidate: SearchCandidate; score: number }> {
  if (input.length <= 1) return input.slice(0, limit);
  const selected: typeof input = [];
  const remaining = [...input];
  const selectedTokens: Set<string>[] = [];
  const selectedEmbeddings: Array<number[] | undefined> = [];
  const isWellFormed = (emb: number[] | undefined): emb is number[] =>
    Array.isArray(emb) && emb.length > 0 && emb.every((v) => typeof v === 'number' && Number.isFinite(v));
  const cosine = (a: number[], b: number[]): number => {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  };
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    const union = a.size + b.size - inter;
    return union === 0 ? 0 : inter / union;
  };
  const pairSim = (embA: number[] | undefined, embB: number[] | undefined, tA: Set<string>, tB: Set<string>) =>
    isWellFormed(embA) && isWellFormed(embB) && embA.length === embB.length ? cosine(embA, embB) : jaccard(tA, tB);

  const first = remaining.shift()!;
  selected.push(first);
  selectedTokens.push(tokenize(first.candidate.content));
  selectedEmbeddings.push(first.candidate.embedding);

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = -1;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      const candTokens = tokenize(cand.candidate.content);
      const candEmbedding = cand.candidate.embedding;
      let maxOverlap = 0;
      for (let j = 0; j < selectedTokens.length; j++) {
        const sim = pairSim(candEmbedding, selectedEmbeddings[j], candTokens, selectedTokens[j]);
        if (sim > maxOverlap) maxOverlap = sim;
      }
      const mmr = lambda * cand.score - (1 - lambda) * maxOverlap;
      if (mmr > bestMmr) { bestMmr = mmr; bestIdx = i; }
    }
    if (bestIdx < 0) break;
    const [chosen] = remaining.splice(bestIdx, 1);
    selected.push(chosen);
    selectedTokens.push(tokenize(chosen.candidate.content));
    selectedEmbeddings.push(chosen.candidate.embedding);
  }
  return selected;
}

describe('mmrRerank: baseline (eager tokenize) vs candidate (lazy cached)', () => {
  bench('baseline — eager tokenize every outer pass', () => {
    baselineMmrRerank(scored, 0.7, LIMIT);
  });

  bench('candidate — lazy cached tokenize (applyMMR)', () => {
    applyMMR(scored, 0.7, LIMIT);
  });
});
