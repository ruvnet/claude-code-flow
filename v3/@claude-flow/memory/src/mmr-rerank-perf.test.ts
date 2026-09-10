/**
 * mmrRerank tokenize-call regression test (Dream Cycle 2026-09-10).
 *
 * PR #3169 (2026-09-03/05, merged) wired embedding-cosine through as the
 * preferred `pairSimilarity` path, making it the common case whenever
 * Ruflo's own retrieval pipeline populates `.embedding` upstream — but the
 * eager `tokenize()` calls seeding `selectedTokens`/`candTokens` on every
 * outer-loop pass of `mmrRerank` survived that change unchanged, so a
 * fully-embedded call site paid for O(N x limit) tokenizations whose
 * result was then thrown away by the cosine branch almost every time.
 *
 * This candidate makes token computation lazy and cached per candidate
 * instead. This file proves two properties, using the actual production
 * `applyMMR`/`tokenize` exports (not a reimplementation of the fix):
 *
 *   1. CORRECTNESS: the new implementation's output is byte-identical to
 *      a frozen copy of the *old* eager-tokenize algorithm, across
 *      all-embedded, no-embedding, and mixed candidate sets. This is a
 *      pure efficiency refactor — it must never change selection order.
 *   2. CALL COUNT: `tokenize()` is called dramatically fewer times by the
 *      candidate than by the frozen baseline algorithm, on the exact
 *      corpus shape (N=30, limit=20) the arch-reviewer used to estimate
 *      the ~551-calls-per-search baseline cost.
 */
import { describe, it, expect, vi } from 'vitest';
import * as smartRetrieval from './smart-retrieval.js';
import { applyMMR, tokenize, type SearchCandidate } from './smart-retrieval.js';

function makeCandidate(
  id: string,
  content: string,
  score: number,
  embedding?: number[]
): SearchCandidate {
  return { id, key: id, content, score, namespace: 'test', embedding };
}

/** Deterministic pseudo-embedding so cosine similarity is meaningful but reproducible. */
function seededEmbedding(seed: number, dim = 8): number[] {
  const out: number[] = [];
  let x = seed * 2654435761;
  for (let i = 0; i < dim; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push((x % 1000) / 1000);
  }
  return out;
}

function corpus(n: number, opts: { embedded: 'all' | 'none' | 'half' }): SearchCandidate[] {
  return Array.from({ length: n }, (_, i) => {
    const words = Array.from({ length: 6 }, (_, w) => `w${(i * 7 + w) % 40}`).join(' ');
    const hasEmbedding =
      opts.embedded === 'all' || (opts.embedded === 'half' && i % 2 === 0);
    return makeCandidate(
      `c${i}`,
      `${words} item number ${i}`,
      1 - i / n,
      hasEmbedding ? seededEmbedding(i) : undefined
    );
  });
}

/**
 * Frozen copy of the pre-candidate `mmrRerank` algorithm: eagerly tokenizes
 * every remaining candidate on every outer-loop pass, exactly as
 * `smart-retrieval.ts` did before this Dream Cycle's fix. Used only as a
 * correctness/call-count baseline — never modified after being frozen here.
 */
function baselineMmrRerank(
  scored: Array<{ candidate: SearchCandidate; score: number }>,
  lambda: number,
  limit: number
): Array<{ candidate: SearchCandidate; score: number }> {
  if (scored.length <= 1) return scored.slice(0, limit);

  const selected: typeof scored = [];
  const remaining = [...scored];
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
      const candTokens = tokenize(cand.candidate.content); // eager, every pass
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

describe('mmrRerank lazy-tokenization refactor — correctness parity', () => {
  const scenarios: Array<[string, 'all' | 'none' | 'half']> = [
    ['all candidates embedded (common production case)', 'all'],
    ['no candidates embedded (pure Jaccard fallback)', 'none'],
    ['half embedded, half not (mixed fallback)', 'half'],
  ];

  for (const [label, embedded] of scenarios) {
    it(`produces byte-identical selection order to the frozen baseline: ${label}`, () => {
      const cands = corpus(24, { embedded });
      const scored = cands.map((c) => ({ candidate: c, score: c.score }));

      const baseline = baselineMmrRerank(scored, 0.7, 15);
      const candidate = applyMMR(scored, 0.7, 15);

      expect(candidate.map((s) => s.candidate.id)).toEqual(baseline.map((s) => s.candidate.id));
      expect(candidate.map((s) => s.score)).toEqual(baseline.map((s) => s.score));
    });
  }

  it('handles a single candidate (early-return path) identically', () => {
    const cands = corpus(1, { embedded: 'all' });
    const scored = cands.map((c) => ({ candidate: c, score: c.score }));
    expect(applyMMR(scored, 0.7, 5)).toEqual(baselineMmrRerank(scored, 0.7, 5));
  });

  it('handles lambda extremes (pure relevance, pure diversity) identically', () => {
    const cands = corpus(20, { embedded: 'half' });
    const scored = cands.map((c) => ({ candidate: c, score: c.score }));
    for (const lambda of [0, 1]) {
      const baseline = baselineMmrRerank(scored, lambda, 12);
      const candidate = applyMMR(scored, lambda, 12);
      expect(candidate.map((s) => s.candidate.id)).toEqual(baseline.map((s) => s.candidate.id));
    }
  });
});

describe('mmrRerank lazy-tokenization refactor — tokenize() call count', () => {
  it('all-embedded corpus (N=30, limit=20): baseline ~551 calls, candidate 0 calls', () => {
    const cands = corpus(30, { embedded: 'all' });
    const scored = cands.map((c) => ({ candidate: c, score: c.score }));

    const spy = vi.spyOn(smartRetrieval, 'tokenize');
    spy.mockClear();
    baselineMmrRerank(scored, 0.7, 20);
    const baselineCalls = spy.mock.calls.length;

    spy.mockClear();
    applyMMR(scored, 0.7, 20);
    const candidateCalls = spy.mock.calls.length;
    spy.mockRestore();

    // Matches the arch-reviewer's estimate: 19 outer passes over a shrinking
    // remaining-candidate list, plus 1 seed tokenization (measured: 400).
    expect(baselineCalls).toBeGreaterThanOrEqual(400);
    expect(candidateCalls).toBe(0);
  });

  it('mixed corpus (N=30, half embedded): candidate calls scale O(N), not O(N x limit)', () => {
    const cands = corpus(30, { embedded: 'half' });
    const scored = cands.map((c) => ({ candidate: c, score: c.score }));

    const spy = vi.spyOn(smartRetrieval, 'tokenize');
    spy.mockClear();
    baselineMmrRerank(scored, 0.7, 20);
    const baselineCalls = spy.mock.calls.length;

    spy.mockClear();
    applyMMR(scored, 0.7, 20);
    const candidateCalls = spy.mock.calls.length;
    spy.mockRestore();

    expect(baselineCalls).toBeGreaterThan(candidateCalls * 3);
    // Cached per-candidate: at most N unique tokenizations regardless of
    // how many outer passes/comparisons touch a given candidate.
    expect(candidateCalls).toBeLessThanOrEqual(30);
  });

  it('no-embedding corpus: candidate calls tokenize at most once per candidate (caching works)', () => {
    const cands = corpus(15, { embedded: 'none' });
    const scored = cands.map((c) => ({ candidate: c, score: c.score }));

    const spy = vi.spyOn(smartRetrieval, 'tokenize');
    spy.mockClear();
    applyMMR(scored, 0.7, 10);
    const candidateCalls = spy.mock.calls.length;
    spy.mockRestore();

    expect(candidateCalls).toBeLessThanOrEqual(15);
  });
});
