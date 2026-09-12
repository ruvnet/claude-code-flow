// Dream Cycle 2026-09-12 (intelligence surface) — regression suite.
//
// LocalReasoningBank.findSimilar() used to overwrite each returned pattern's
// `confidence` (its learned reliability) with the per-query cosine score,
// instead of exposing the score as a distinct `similarity` field. That
// silently broke two things:
//   1. distillLearning()'s "only distill from high-confidence matches" gate
//      (`match.confidence < 0.5`) ended up testing query-similarity, not
//      the pattern's actual reliability — inverting its stated intent.
//   2. findSimilarPatterns()'s public PatternMatch API (which already
//      declared a distinct `similarity: number` field) could only ever
//      return `similarity === confidence`, via an unsafe type-cast fallback.
//
// Baseline (pre-fix) fails every assertion below; candidate (post-fix)
// passes all of them. See docs/dream-cycle/dream-gist-2026-09-12.md.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// findSimilarPatterns() generates a real query embedding (ONNX, falling back
// to a hash) before calling findSimilar(). That's an environment-dependent
// path (model cache/network availability) this file has no business
// depending on for a RETRIEVE-stage confidence/similarity contract test —
// mock both embedding sources so the query embedding is fixed and
// deterministic regardless of CI sandbox network/model-cache state.
const FIXED_QUERY_EMBEDDING = [1, 0, 0];
vi.mock('../src/memory/memory-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/memory/memory-bridge.js')>();
  return { ...actual, bridgeGenerateEmbedding: vi.fn(async () => null) };
});
vi.mock('../src/memory/memory-initializer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/memory/memory-initializer.js')>();
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => ({
      embedding: FIXED_QUERY_EMBEDDING,
      dimensions: FIXED_QUERY_EMBEDDING.length,
      model: 'mock-deterministic',
      backend: 'mock' as const,
    })),
  };
});

// IMPORTANT: do NOT process.chdir() at module load — vitest shares the
// process across files in a worker, so changing CWD here would break every
// other test file that relies on the repo CWD. Scope CWD changes to
// before/after this file only (mirrors __tests__/self-learning-2245.test.ts).
const SCRATCH = mkdtempSync(join(tmpdir(), 'intel-confsim-'));
let originalCwd: string;

beforeAll(() => {
  originalCwd = process.cwd();
  process.chdir(SCRATCH);
  // intelligence.ts's getDataDir() falls back to the real $HOME/.claude-flow
  // when cwd has no .claude-flow dir yet — creating this one keeps every
  // pattern this file persists fully inside SCRATCH, not the real home dir.
  mkdirSync(join(SCRATCH, '.claude-flow'), { recursive: true });
});

afterAll(() => {
  try { process.chdir(originalCwd); } catch { /* best-effort */ }
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(async () => {
  const intel = await import('../src/memory/intelligence.js');
  intel.clearIntelligence();
  // Start every test from a genuinely empty ReasoningBank: patterns.json is
  // disk-persisted (debounced), so without this, patterns saved by an
  // earlier test in this file can leak into a later test's findSimilar()
  // top-k selection.
  try { rmSync(join(SCRATCH, '.claude-flow', 'neural', 'patterns.json'), { force: true }); } catch { /* none yet */ }
  await intel.initializeIntelligence();
});

describe('findSimilar() keeps confidence and similarity distinct', () => {
  it('returns the stored confidence unchanged and the cosine score as `similarity`', async () => {
    const intel = await import('../src/memory/intelligence.js');
    const bank = intel.getReasoningBank()!;

    bank.store({
      id: 'p1',
      type: 'test',
      embedding: [1, 0, 0],
      content: 'unit-test pattern p1',
      confidence: 0.42,
    });

    // Look up by id rather than assuming array shape/order: findSimilar()
    // reads from a persisted, disk-backed bank, so unrelated patterns
    // written by earlier tests in this file's SCRATCH dir may also be
    // returned at threshold:0 — that's fine, we only assert on our own.
    const results = bank.findSimilar([1, 0, 0], { k: 50, threshold: 0 });
    const hit = results.find((r) => r.id === 'p1');
    expect(hit).toBeDefined();
    // Learned reliability must survive untouched.
    expect(hit!.confidence).toBe(0.42);
    // The per-query match score must be exposed separately.
    expect(typeof hit!.similarity).toBe('number');
    expect(hit!.similarity).toBeCloseTo(1.0, 5);
  });

  it('does not conflate the two for a partial (non-identical) match', async () => {
    const intel = await import('../src/memory/intelligence.js');
    const bank = intel.getReasoningBank()!;

    // cosine([1,0,0], [0.45, 0.8930..., 0]) == 0.45
    bank.store({
      id: 'p2',
      type: 'test',
      embedding: [0.45, 0.8930658, 0],
      content: 'unit-test pattern p2',
      confidence: 0.9,
    });

    const results = bank.findSimilar([1, 0, 0], { k: 50, threshold: 0 });
    const hit = results.find((r) => r.id === 'p2');
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe(0.9);
    expect(hit!.similarity).toBeCloseTo(0.45, 2);
  });
});

describe("distillLearning()'s confidence gate reflects reliability, not query-similarity", () => {
  it('skips a low-reliability/high-similarity pattern and boosts a high-reliability/low-similarity one', async () => {
    const intel = await import('../src/memory/intelligence.js');
    const bank = intel.getReasoningBank()!;

    // LOW: identical embedding to the trajectory step (similarity ~1.0) but
    // low stored reliability (0.2) — the bug would let this through the
    // DISTILL gate and reinforce a pattern we don't actually trust.
    bank.store({
      id: 'low-conf-high-sim',
      type: 'test',
      embedding: [1, 0, 0],
      content: 'low reliability, high query-similarity',
      confidence: 0.2,
    });

    // HIGH: only a loose match to the trajectory step (similarity ~0.45,
    // above the 0.3/0.4 outer thresholds but below the gate's 0.5) yet a
    // genuinely reliable pattern (0.6) — the bug would exclude this from
    // distillation despite its real reliability.
    bank.store({
      id: 'high-conf-low-sim',
      type: 'test',
      embedding: [0.45, 0.8930658, 0],
      content: 'high reliability, low query-similarity',
      confidence: 0.6,
    });

    await intel.recordStep({
      type: 'action',
      content: 'trajectory step matching both patterns',
      embedding: [1, 0, 0],
      timestamp: Date.now(),
    });

    // endTrajectory()'s own RL loop bumps matched patterns by
    // loraLearningRate-independent +0.1*reward — capture the confidence
    // right after this, before distillLearning() runs, as our baseline.
    await intel.endTrajectoryWithVerdict('success');

    const midLow = bank.get('low-conf-high-sim')!.confidence;
    const midHigh = bank.get('high-conf-low-sim')!.confidence;
    expect(midLow).toBeCloseTo(0.3, 5); // 0.2 + 0.1
    expect(midHigh).toBeCloseTo(0.7, 5); // 0.6 + 0.1
    expect(midLow).toBeLessThan(0.5);
    expect(midHigh).toBeGreaterThanOrEqual(0.5);

    await intel.distillLearning();

    const finalLow = bank.get('low-conf-high-sim')!.confidence;
    const finalHigh = bank.get('high-conf-low-sim')!.confidence;

    // Correctly excluded: real reliability (0.3) is below the 0.5 gate.
    expect(finalLow).toBe(midLow);
    // Correctly included: real reliability (0.7) clears the 0.5 gate, so it
    // must receive the additional LoRA-style distillation bump.
    expect(finalHigh).toBeGreaterThan(midHigh);
  });
});

describe('findSimilarPatterns() public API reports genuinely distinct fields', () => {
  it('confidence and similarity differ for a partial match', async () => {
    const intel = await import('../src/memory/intelligence.js');
    const bank = intel.getReasoningBank()!;

    bank.store({
      id: 'pub-api-pattern',
      type: 'test',
      embedding: [0.45, 0.8930658, 0],
      content: 'reasoningbank public search fixture, ewc consolidation review',
      confidence: 0.85,
    });

    const results = await intel.findSimilarPatterns(
      'reasoningbank public search fixture, ewc consolidation review',
      { k: 5, threshold: 0 },
    );

    const hit = results.find((r) => r.id === 'pub-api-pattern');
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe(0.85);
    expect(typeof hit!.similarity).toBe('number');
    // cosine([1,0,0], [0.45, 0.8930658, 0]) == 0.45 (mocked query embedding,
    // see the vi.mock block above — deterministic, no ONNX/network needed).
    // Prior to the fix these were structurally forced to be equal for every
    // result; a real embedding for this exact-content query won't land at
    // precisely 0.85, so a non-conflated implementation must diverge here.
    expect(hit!.similarity).not.toBe(hit!.confidence);
  });
});
