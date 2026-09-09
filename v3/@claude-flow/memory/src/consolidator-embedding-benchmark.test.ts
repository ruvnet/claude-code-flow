/**
 * Phase 4.1 — embedding near-duplicate pass: precision/recall, latency,
 * namespace-isolation, and determinism receipts (response to PR #3232
 * review: "the 0.95 threshold needs an empirical contract rather than a
 * smoke fixture").
 *
 * IMPORTANT — corpus provenance: this file does NOT use a real pinned
 * embedding model. Both real ONNX backends this monorepo ships
 * (`@huggingface/transformers` and the legacy `@xenova/transformers`) were
 * attempted directly in this environment and both fail for reasons
 * unrelated to this candidate:
 *   - `@huggingface/transformers@4.2.0`: `transformers.node.mjs` does
 *     `import { Tensor } from "onnxruntime-common"` against a CJS module,
 *     a real ESM/CJS interop break under this Node version — reproduces
 *     on an unmodified checkout, confirmed before writing this file.
 *   - `@xenova/transformers@2.17.0`: pulls in `sharp@0.32.6`, whose
 *     native binding (`sharp-linux-x64.node`) isn't present for this
 *     sandbox's platform.
 * Neither is fixable within this PR's scope without touching unrelated,
 * pre-existing native/module-resolution infrastructure this diff never
 * touches. This package's own `__tests__/embeddings.test.ts` exercises
 * only the `mock` provider — it never invokes a real transformer either,
 * consistent with what was found here.
 *
 * What this file DOES provide instead: a deterministic synthetic corpus
 * where pairwise cosine similarity is constructed EXACTLY (not measured
 * after the fact) via `pairAtSimilarity()` below — for every pair the
 * ground-truth similarity is known analytically, not estimated. That
 * makes this a rigorous test of the near-dup pass's THRESHOLD MECHANICS
 * (precision/recall as a function of `similarityThreshold`, exactly where
 * the boundary is) — arguably a cleaner instrument for that specific
 * question than a real corpus would be, since there is no measurement
 * noise in the "true" similarity. It does NOT validate that 0.95 is the
 * right cutoff for real-world semantic paraphrase detection with a real
 * embedding model — that claim remains open pending the blocked ONNX
 * path, and is called out explicitly, not implied.
 */

import { describe, it, expect } from 'vitest';
import { MemoryService } from './index.js';
import { MemoryConsolidator } from './consolidator.js';
import { createDefaultEntry } from './types.js';

/** Deterministic xorshift PRNG, seeded — matches consolidator.test.ts's randomVec. */
function seededRng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s | 0) / 2 ** 31;
  };
}

function randomUnitVector(dim: number, seed: number): Float32Array {
  const rng = seededRng(seed);
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rng();
  return normalize(v);
}

function normalize(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Construct a unit vector `b` such that cosine(a, b) === targetSimilarity
 * exactly (up to float precision), by mixing `a` with a vector orthogonal
 * to it: b = s*a + sqrt(1-s^2)*orth, |a|=|orth|=1, a⊥orth.
 */
function vectorAtSimilarity(a: Float32Array, targetSimilarity: number, seed: number): Float32Array {
  const dim = a.length;
  // Random candidate, then Gram-Schmidt to make it orthogonal to `a`.
  let orth = randomUnitVector(dim, seed);
  const proj = dot(orth, a);
  const raw = new Float32Array(dim);
  for (let i = 0; i < dim; i++) raw[i] = orth[i] - proj * a[i];
  orth = normalize(raw);

  const s = targetSimilarity;
  const c = Math.sqrt(Math.max(0, 1 - s * s));
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = s * a[i] + c * orth[i];
  return out;
}

async function newService(dimensions = 32) {
  const svc = new MemoryService({ dimensions, persistenceEnabled: false, snapshotInterval: 0 } as any);
  await svc.initialize();
  return svc;
}

interface Pair {
  label: string;
  targetSimilarity: number;
  shouldMergeAtDefault: boolean; // ground truth given the shipped 0.95 default
}

const DIM = 32;

// Base anchor vectors, one per pair, all mutually near-orthogonal (distinct
// content clusters) so pairs don't cross-contaminate each other's matches.
function buildCorpus(): { anchors: Float32Array[]; pairs: Pair[] } {
  const pairs: Pair[] = [
    { label: 'near-dup-0.999', targetSimilarity: 0.999, shouldMergeAtDefault: true },
    { label: 'near-dup-0.98', targetSimilarity: 0.98, shouldMergeAtDefault: true },
    { label: 'near-dup-0.96', targetSimilarity: 0.96, shouldMergeAtDefault: true },
    { label: 'boundary-0.955', targetSimilarity: 0.955, shouldMergeAtDefault: true },
    { label: 'hard-negative-0.94', targetSimilarity: 0.94, shouldMergeAtDefault: false },
    { label: 'hard-negative-0.90', targetSimilarity: 0.90, shouldMergeAtDefault: false },
    { label: 'hard-negative-0.85', targetSimilarity: 0.85, shouldMergeAtDefault: false },
    { label: 'easy-negative-0.30', targetSimilarity: 0.30, shouldMergeAtDefault: false },
  ];
  const anchors = pairs.map((_, i) => randomUnitVector(DIM, 1000 + i * 7));
  return { anchors, pairs };
}

describe('Phase 4.1 embedding benchmark — pairwise similarity is exact by construction', () => {
  it('vectorAtSimilarity produces the requested cosine similarity to within 1e-5', () => {
    const a = randomUnitVector(DIM, 42);
    for (const target of [0.999, 0.96, 0.955, 0.9, 0.85, 0.3, 0, -0.5]) {
      const b = vectorAtSimilarity(a, target, 99);
      expect(dot(a, b)).toBeCloseTo(target, 5);
    }
  });
});

describe('Phase 4.1 embedding benchmark — precision/recall across a threshold sweep', () => {
  it('at the shipped default (0.95), every near-dup pair merges and every hard negative does not', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);
    const { anchors, pairs } = buildCorpus();

    const ids: Record<string, [string, string]> = {};
    for (let i = 0; i < pairs.length; i++) {
      const a = createDefaultEntry({ key: `${pairs[i].label}-a`, content: `${pairs[i].label} canonical text ${i}` });
      a.embedding = anchors[i];
      await svc.store(a);
      const b = createDefaultEntry({ key: `${pairs[i].label}-b`, content: `${pairs[i].label} variant text ${i}` });
      b.embedding = vectorAtSimilarity(anchors[i], pairs[i].targetSimilarity, 5000 + i);
      await svc.store(b);
      ids[pairs[i].label] = [a.id, b.id];
    }

    await consolidator.dedup('keep-newest');
    const adapter: any = svc.getAdapter();

    let truePositives = 0;
    let falseNegatives = 0;
    let trueNegatives = 0;
    let falsePositives = 0;
    for (const pair of pairs) {
      const [idA, idB] = ids[pair.label];
      const bothSurvive = adapter.entries.has(idA) && adapter.entries.has(idB);
      const merged = !bothSurvive;
      if (pair.shouldMergeAtDefault) {
        if (merged) truePositives++;
        else falseNegatives++;
      } else {
        if (merged) falsePositives++;
        else trueNegatives++;
      }
    }

    // Ground-truth contract for the shipped default: clean separation
    // around the 0.95 boundary in this corpus — no false merges, no
    // false splits among the near-dup/hard-negative pairs constructed
    // above.
    expect(falsePositives).toBe(0); // no hard negative incorrectly merged
    expect(falseNegatives).toBe(0); // no true near-dup left unmerged
    expect(truePositives).toBe(pairs.filter((p) => p.shouldMergeAtDefault).length);
    expect(trueNegatives).toBe(pairs.filter((p) => !p.shouldMergeAtDefault).length);

    await svc.close();
  });

  it('reports precision/recall/false-merge-rate across a threshold sweep', async () => {
    // Deliberately offset from every corpus pair's constructed similarity
    // (0.999/0.98/0.96/0.955/0.94/0.90/0.85/0.30) by a margin large enough
    // to absorb float32 precision jitter from HNSW's internal
    // normalize-then-dot-product distance computation (empirically <1e-5
    // here, but a boundary value with ZERO margin — e.g. sweeping exactly
    // 0.90 against a pair constructed at exactly 0.90 — is a real flake
    // this file hit and fixed while writing it; the margin here is the fix).
    const thresholds = [0.5, 0.8, 0.875, 0.92, 0.97];
    const rows: Array<{
      threshold: number;
      precision: number;
      recall: number;
      falseMergeRate: number;
    }> = [];

    for (const threshold of thresholds) {
      const svc = await newService();
      const consolidator = new MemoryConsolidator(svc as any, { similarityThreshold: threshold });
      const { anchors, pairs: p2 } = buildCorpus();
      const ids: Record<string, [string, string]> = {};
      for (let i = 0; i < p2.length; i++) {
        const a = createDefaultEntry({ key: `${p2[i].label}-a`, content: `${p2[i].label} canonical text ${i}` });
        a.embedding = anchors[i];
        await svc.store(a);
        const b = createDefaultEntry({ key: `${p2[i].label}-b`, content: `${p2[i].label} variant text ${i}` });
        b.embedding = vectorAtSimilarity(anchors[i], p2[i].targetSimilarity, 5000 + i);
        await svc.store(b);
        ids[p2[i].label] = [a.id, b.id];
      }
      await consolidator.dedup('keep-newest');
      const adapter: any = svc.getAdapter();

      // Ground truth here is "similarity >= threshold" (not the fixed
      // 0.95-default contract used above), so precision/recall are
      // measured against what SHOULD merge at each threshold under test.
      let tp = 0;
      let fp = 0;
      let fn = 0;
      let tn = 0;
      for (const pair of p2) {
        const [idA, idB] = ids[pair.label];
        const merged = !(adapter.entries.has(idA) && adapter.entries.has(idB));
        const shouldMerge = pair.targetSimilarity >= threshold;
        if (shouldMerge && merged) tp++;
        else if (shouldMerge && !merged) fn++;
        else if (!shouldMerge && merged) fp++;
        else tn++;
      }
      const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
      const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
      const falseMergeRate = fp + tn === 0 ? 0 : fp / (fp + tn);
      rows.push({ threshold, precision, recall, falseMergeRate });

      await svc.close();
    }

    // eslint-disable-next-line no-console
    console.log('similarityThreshold sweep (synthetic exact-similarity corpus):', JSON.stringify(rows));

    // Every threshold in this sweep gets perfect precision/recall on this
    // corpus, because pair similarities were deliberately placed with a
    // >=0.005 margin on either side of each candidate threshold. That is
    // the corpus proving the near-dup pass's comparison (`similarity >=
    // threshold`) is exact and monotonic, not that any one threshold is
    // "best" — this sweep is a mechanics check, not a model-selection
    // benchmark.
    for (const row of rows) {
      expect(row.precision).toBe(1);
      expect(row.recall).toBe(1);
      expect(row.falseMergeRate).toBe(0);
    }
  });
});

describe('Phase 4.1 embedding benchmark — namespace isolation (pre-existing behavior, unchanged)', () => {
  it('cross-namespace near-duplicates merge exactly as cross-namespace hash-exact duplicates already did', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);

    // Hash-exact case: identical content, two namespaces. dedup()'s
    // bucket-by-hash pass has never scoped by namespace (grep-confirmed
    // on the pre-candidate code: `for (const entry of entries.values())`
    // with no namespace filter) — this candidate does not change that.
    const h1 = createDefaultEntry({ key: 'h', content: 'exact-duplicate-content', namespace: 'ns-a' });
    await svc.store(h1);
    const h2 = createDefaultEntry({ key: 'h', content: 'exact-duplicate-content', namespace: 'ns-b' });
    await svc.store(h2);

    // Near-dup case: different content, identical embedding, two namespaces.
    const anchor = randomUnitVector(DIM, 777);
    const e1 = createDefaultEntry({ key: 'e', content: 'namespace-a-phrasing', namespace: 'ns-a' });
    e1.embedding = anchor;
    await svc.store(e1);
    const e2 = createDefaultEntry({ key: 'e', content: 'namespace-b-phrasing', namespace: 'ns-b' });
    e2.embedding = new Float32Array(anchor);
    await svc.store(e2);

    const result = await consolidator.dedup('keep-newest');

    const adapter: any = svc.getAdapter();
    // Both the hash-exact pair and the near-dup pair merge across the
    // namespace boundary — documented, not silently changed. If Ruflo
    // later decides dedup() should be namespace-scoped, that's a
    // separate, pre-existing-behavior-affecting decision spanning both
    // passes, not something introduced by this candidate.
    const hashSurvivors = [h1.id, h2.id].filter((id) => adapter.entries.has(id));
    const embedSurvivors = [e1.id, e2.id].filter((id) => adapter.entries.has(id));
    expect(hashSurvivors.length).toBe(1);
    expect(embedSurvivors.length).toBe(1);
    expect(result.merged).toBe(2);

    await svc.close();
  });
});

describe('Phase 4.1 embedding benchmark — determinism / replay', () => {
  it('the same corpus produces byte-identical merge/group counts and survivor keys across 3 independent runs', async () => {
    // Entry ids are randomly generated per store() call (mem_<ts>_<rand>),
    // so they are NOT expected to match across independent runs even when
    // merge behavior is fully deterministic — comparing raw ids here would
    // be testing the id generator, not dedup(). Compare by `key` instead,
    // which this corpus constructs deterministically from `pairs`.
    async function runOnce() {
      const svc = await newService();
      const consolidator = new MemoryConsolidator(svc as any);
      const { anchors, pairs } = buildCorpus();
      const idToKey = new Map<string, string>();
      for (let i = 0; i < pairs.length; i++) {
        const aKey = `${pairs[i].label}-a`;
        const a = createDefaultEntry({ key: aKey, content: `${pairs[i].label} canonical text ${i}` });
        a.embedding = anchors[i];
        a.updatedAt = 1000 + i * 2;
        await svc.store(a);
        idToKey.set(a.id, aKey);
        const bKey = `${pairs[i].label}-b`;
        const b = createDefaultEntry({ key: bKey, content: `${pairs[i].label} variant text ${i}` });
        b.embedding = vectorAtSimilarity(anchors[i], pairs[i].targetSimilarity, 5000 + i);
        b.updatedAt = 1000 + i * 2 + 1; // always the newer of the pair
        await svc.store(b);
        idToKey.set(b.id, bKey);
      }
      const result = await consolidator.dedup('keep-newest');
      const adapter: any = svc.getAdapter();
      const survivorKeys = [...idToKey.entries()]
        .filter(([id]) => adapter.entries.has(id))
        .map(([, key]) => key)
        .sort();
      await svc.close();
      return { merged: result.merged, groups: result.groups, survivorKeys };
    }

    // Sequential, not parallel — isolates each run's timing/state fully,
    // removing any doubt about event-loop interleaving as a confound.
    const r1 = await runOnce();
    const r2 = await runOnce();
    const r3 = await runOnce();
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
  });
});

describe('Phase 4.1 embedding benchmark — latency/memory at realistic cardinality', () => {
  it('dedup() at N=5000 (matching this repo\'s own HNSW benchmark convention) completes within a generous ceiling, baseline vs candidate', async () => {
    const N = 5000;
    const DUP_FRACTION = 0.1; // 10% of entries are near-duplicates of an earlier entry

    async function buildAndRun(similarityThreshold: number) {
      const svc = await newService();
      const consolidator = new MemoryConsolidator(svc as any, { similarityThreshold });
      const anchors: Float32Array[] = [];
      for (let i = 0; i < N; i++) {
        const isDup = i > 0 && i % Math.round(1 / DUP_FRACTION) === 0;
        let embedding: Float32Array;
        if (isDup) {
          const anchor = anchors[Math.floor(Math.random() * anchors.length)];
          embedding = vectorAtSimilarity(anchor, 0.985, i);
        } else {
          embedding = randomUnitVector(DIM, 20000 + i);
          anchors.push(embedding);
        }
        const entry = createDefaultEntry({ key: `n-${i}`, content: `entry-${i}-${isDup ? 'dup' : 'unique'}` });
        entry.embedding = embedding;
        await svc.store(entry);
      }

      const memBefore = process.memoryUsage().heapUsed;
      const t0 = Date.now();
      const result = await consolidator.dedup('keep-newest');
      const durationMs = Date.now() - t0;
      const memAfter = process.memoryUsage().heapUsed;

      await svc.close();
      return { durationMs, heapDeltaMb: (memAfter - memBefore) / (1024 * 1024), merged: result.merged };
    }

    const baseline = await buildAndRun(1); // near-dup pass disabled — hash-only, matches pre-candidate behavior
    const candidate = await buildAndRun(0.95); // shipped default

    // eslint-disable-next-line no-console
    console.log('latency/memory @ N=5000:', JSON.stringify({ baseline, candidate }));

    // Generous ceilings — this is a regression guard against a pathological
    // blowup (e.g., an accidental O(n^2) reintroduction), not a tight perf
    // assertion; CI hardware varies. Real numbers are logged above for the
    // reviewer regardless of pass/fail margin.
    expect(candidate.durationMs).toBeLessThan(15_000);
    expect(candidate.merged).toBeGreaterThan(0); // the injected near-dups were actually caught
    expect(baseline.merged).toBe(0); // hash-only baseline: all content strings are unique, so 0 hash-exact merges
  }, 30_000);
});
