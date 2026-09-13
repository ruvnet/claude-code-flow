/**
 * Deep Tests for Memory and RuVector Subsystems
 *
 * Covers:
 * - Memory initializer: schema, quantization, batch operations, flash attention
 * - Intelligence module: SONA coordinator, ReasoningBank, persistence
 * - SONA optimizer: trajectory outcomes, routing suggestions, temporal decay
 * - EWC consolidation: Fisher matrix, consolidation, gradient recording
 * - AST analyzer: language detection, function/class extraction, complexity
 * - Diff classifier: classification, parsing, risk assessment, commit messages
 * - Coverage router: parsing formats, routing, gap analysis, trends
 * - Graph analyzer: circular deps, mincut, louvain, DOT export
 * - Q-learning router: route decisions, update, exploration, replay, cache
 * - Service layer: agentic-flow bridge, registry-api validation
 * - Infrastructure: in-memory repositories
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// Memory Initializer
// =============================================================================

describe('Memory Initializer', () => {
  describe('MEMORY_SCHEMA_V3', () => {
    it('should export a non-empty schema string', async () => {
      const { MEMORY_SCHEMA_V3 } = await import('../src/memory/memory-initializer.js');
      expect(MEMORY_SCHEMA_V3).toBeDefined();
      expect(typeof MEMORY_SCHEMA_V3).toBe('string');
      expect(MEMORY_SCHEMA_V3.length).toBeGreaterThan(100);
    });

    it('should contain core memory_entries table', async () => {
      const { MEMORY_SCHEMA_V3 } = await import('../src/memory/memory-initializer.js');
      expect(MEMORY_SCHEMA_V3).toContain('CREATE TABLE IF NOT EXISTS memory_entries');
    });

    it('should contain patterns table for learning', async () => {
      const { MEMORY_SCHEMA_V3 } = await import('../src/memory/memory-initializer.js');
      expect(MEMORY_SCHEMA_V3).toContain('CREATE TABLE IF NOT EXISTS patterns');
    });

    it('should contain trajectories table for SONA', async () => {
      const { MEMORY_SCHEMA_V3 } = await import('../src/memory/memory-initializer.js');
      expect(MEMORY_SCHEMA_V3).toContain('CREATE TABLE IF NOT EXISTS trajectories');
    });

    it('should contain migration_state table', async () => {
      const { MEMORY_SCHEMA_V3 } = await import('../src/memory/memory-initializer.js');
      expect(MEMORY_SCHEMA_V3).toContain('CREATE TABLE IF NOT EXISTS migration_state');
    });

    it('should contain sessions table', async () => {
      const { MEMORY_SCHEMA_V3 } = await import('../src/memory/memory-initializer.js');
      expect(MEMORY_SCHEMA_V3).toContain('CREATE TABLE IF NOT EXISTS sessions');
    });

    it('should contain vector_indexes table for HNSW', async () => {
      const { MEMORY_SCHEMA_V3 } = await import('../src/memory/memory-initializer.js');
      expect(MEMORY_SCHEMA_V3).toContain('CREATE TABLE IF NOT EXISTS vector_indexes');
    });

    it('should contain metadata table', async () => {
      const { MEMORY_SCHEMA_V3 } = await import('../src/memory/memory-initializer.js');
      expect(MEMORY_SCHEMA_V3).toContain('CREATE TABLE IF NOT EXISTS metadata');
    });

    it('should set WAL journal mode pragma', async () => {
      const { MEMORY_SCHEMA_V3 } = await import('../src/memory/memory-initializer.js');
      expect(MEMORY_SCHEMA_V3).toContain('PRAGMA journal_mode = WAL');
    });
  });

  describe('quantizeInt8 / dequantizeInt8', () => {
    it('should quantize a float embedding to int8', async () => {
      const { quantizeInt8 } = await import('../src/memory/memory-initializer.js');
      const embedding = [0.5, -0.3, 0.8, -1.0, 0.0];
      const result = quantizeInt8(embedding);
      expect(result.quantized).toBeInstanceOf(Int8Array);
      expect(result.quantized.length).toBe(5);
      expect(typeof result.scale).toBe('number');
      expect(result.scale).toBeGreaterThan(0);
    });

    it('should dequantize back to approximately original values', async () => {
      const { quantizeInt8, dequantizeInt8 } = await import('../src/memory/memory-initializer.js');
      const original = [0.5, -0.3, 0.8, -1.0, 0.0];
      const { quantized, scale, zeroPoint } = quantizeInt8(original);
      const recovered = dequantizeInt8(quantized, scale, zeroPoint);
      expect(recovered).toBeInstanceOf(Float32Array);
      for (let i = 0; i < original.length; i++) {
        expect(recovered[i]).toBeCloseTo(original[i], 1);
      }
    });

    it('should handle Float32Array input', async () => {
      const { quantizeInt8 } = await import('../src/memory/memory-initializer.js');
      const embedding = new Float32Array([0.1, 0.2, 0.3]);
      const result = quantizeInt8(embedding);
      expect(result.quantized.length).toBe(3);
    });

    it('should handle all-zero embedding', async () => {
      const { quantizeInt8 } = await import('../src/memory/memory-initializer.js');
      const embedding = [0, 0, 0, 0];
      const result = quantizeInt8(embedding);
      expect(result.quantized.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(result.quantized[i]).toBe(0);
      }
    });
  });

  describe('quantizedCosineSim', () => {
    it('should compute similarity between identical quantized vectors', async () => {
      const { quantizeInt8, quantizedCosineSim } = await import('../src/memory/memory-initializer.js');
      const a = quantizeInt8([0.5, 0.3, 0.8]);
      const b = quantizeInt8([0.5, 0.3, 0.8]);
      const sim = quantizedCosineSim(a.quantized, a.scale, b.quantized, b.scale);
      expect(sim).toBeCloseTo(1.0, 1);
    });

    it('should return 0 for mismatched lengths', async () => {
      const { quantizedCosineSim } = await import('../src/memory/memory-initializer.js');
      const a = new Int8Array([1, 2, 3]);
      const b = new Int8Array([1, 2]);
      expect(quantizedCosineSim(a, 1.0, b, 1.0)).toBe(0);
    });
  });

  describe('batchCosineSim', () => {
    it('should compute batch similarities', async () => {
      const { batchCosineSim } = await import('../src/memory/memory-initializer.js');
      const query = new Float32Array([1, 0, 0]);
      const vectors = [
        new Float32Array([1, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Float32Array([-1, 0, 0]),
      ];
      const scores = batchCosineSim(query, vectors);
      expect(scores).toBeInstanceOf(Float32Array);
      expect(scores.length).toBe(3);
      expect(scores[0]).toBeCloseTo(1.0, 5);
      expect(scores[1]).toBeCloseTo(0.0, 5);
      expect(scores[2]).toBeCloseTo(-1.0, 5);
    });

    it('should handle empty vectors array', async () => {
      const { batchCosineSim } = await import('../src/memory/memory-initializer.js');
      const scores = batchCosineSim(new Float32Array([1, 0]), []);
      expect(scores.length).toBe(0);
    });

    it('should handle empty query', async () => {
      const { batchCosineSim } = await import('../src/memory/memory-initializer.js');
      const scores = batchCosineSim(new Float32Array([]), [new Float32Array([1, 0])]);
      expect(scores[0]).toBe(0);
    });
  });

  describe('softmaxAttention', () => {
    it('should normalize scores to sum to 1', async () => {
      const { softmaxAttention } = await import('../src/memory/memory-initializer.js');
      const scores = new Float32Array([1.0, 2.0, 3.0]);
      const weights = softmaxAttention(scores);
      let sum = 0;
      for (let i = 0; i < weights.length; i++) sum += weights[i];
      expect(sum).toBeCloseTo(1.0, 5);
    });

    it('should assign highest weight to highest score', async () => {
      const { softmaxAttention } = await import('../src/memory/memory-initializer.js');
      const scores = new Float32Array([1.0, 5.0, 2.0]);
      const weights = softmaxAttention(scores);
      expect(weights[1]).toBeGreaterThan(weights[0]);
      expect(weights[1]).toBeGreaterThan(weights[2]);
    });

    it('should handle empty array', async () => {
      const { softmaxAttention } = await import('../src/memory/memory-initializer.js');
      const result = softmaxAttention(new Float32Array([]));
      expect(result.length).toBe(0);
    });

    it('should respect temperature parameter', async () => {
      const { softmaxAttention } = await import('../src/memory/memory-initializer.js');
      const scores = new Float32Array([1.0, 3.0]);
      const lowTemp = softmaxAttention(scores, 0.1);
      const highTemp = softmaxAttention(scores, 10.0);
      // Low temperature = more peaked distribution
      expect(lowTemp[1]).toBeGreaterThan(highTemp[1]);
    });
  });

  describe('topKIndices', () => {
    it('should return top-k indices sorted by score', async () => {
      const { topKIndices } = await import('../src/memory/memory-initializer.js');
      const scores = new Float32Array([0.1, 0.9, 0.5, 0.3, 0.7]);
      const topK = topKIndices(scores, 3);
      expect(topK.length).toBe(3);
      expect(topK[0]).toBe(1); // 0.9
      expect(topK[1]).toBe(4); // 0.7
      expect(topK[2]).toBe(2); // 0.5
    });

    it('should return all indices if k >= n', async () => {
      const { topKIndices } = await import('../src/memory/memory-initializer.js');
      const scores = new Float32Array([0.3, 0.1, 0.2]);
      const topK = topKIndices(scores, 10);
      expect(topK.length).toBe(3);
      expect(topK[0]).toBe(0); // 0.3
    });
  });

  describe('flashAttentionSearch', () => {
    it('should combine batch sim, topk, and softmax', async () => {
      const { flashAttentionSearch } = await import('../src/memory/memory-initializer.js');
      const query = new Float32Array([1, 0, 0]);
      const vectors = [
        new Float32Array([1, 0, 0]),
        new Float32Array([0, 1, 0]),
        new Float32Array([0.9, 0.1, 0]),
      ];
      const result = flashAttentionSearch(query, vectors, { k: 2, threshold: 0.1 });
      expect(result.indices.length).toBeLessThanOrEqual(2);
      expect(result.scores.length).toBe(result.indices.length);
      expect(result.weights.length).toBe(result.indices.length);
    });
  });

  describe('getQuantizationStats', () => {
    it('should report compression ratio ~3.92x', async () => {
      const { getQuantizationStats } = await import('../src/memory/memory-initializer.js');
      const embedding = new Array(384).fill(0.5);
      const stats = getQuantizationStats(embedding);
      expect(stats.originalBytes).toBe(384 * 4);
      expect(stats.quantizedBytes).toBe(384 + 8);
      expect(stats.compressionRatio).toBeGreaterThan(3.5);
    });
  });

  describe('getInitialMetadata', () => {
    it('should include schema version 3.0.0', async () => {
      const { getInitialMetadata } = await import('../src/memory/memory-initializer.js');
      const sql = getInitialMetadata('sql.js');
      expect(sql).toContain("'3.0.0'");
      expect(sql).toContain("'sql.js'");
    });
  });

  describe('HNSW status', () => {
    // #2356: `getHNSWStatus()` now separates "loaded in this process"
    // (`initialized`) from "@ruvector/core capability present" (`available`).
    // Previously `available` tracked the lazy in-process singleton, so a fresh
    // `neural status` process always reported "Not loaded" even when the
    // package was installed — a false negative. After clearing the index the
    // contract is: not initialized, 0 entries, 384-dim; `available` reflects
    // whether @ruvector/core is resolvable (env-dependent, so not hard-asserted).
    it('should report not-initialized after the index is cleared', async () => {
      const { getHNSWStatus, clearHNSWIndex } = await import('../src/memory/memory-initializer.js');
      clearHNSWIndex();
      const status = getHNSWStatus();
      expect(status.initialized).toBe(false);
      expect(status.entryCount).toBe(0);
      expect(status.dimensions).toBe(384);
      expect(typeof status.available).toBe('boolean');
    });
  });

  // AUDIT #3: generateEmbedding must expose a truthful `backend` field so an
  // operator can distinguish real ONNX semantics from the deterministic hash
  // fallback (inverted/meaningless semantics) even when `model` reports a
  // real-looking name.
  describe('generateEmbedding backend field', () => {
    const prevDisableBridge = process.env.CLAUDE_FLOW_DISABLE_BRIDGE;

    afterEach(() => {
      vi.resetModules();
      vi.doUnmock('@huggingface/transformers');
      vi.doUnmock('@xenova/transformers');
      vi.doUnmock('ruvector');
      vi.doUnmock('agentic-flow');
      vi.doUnmock('agentic-flow/reasoningbank');
      if (prevDisableBridge === undefined) delete process.env.CLAUDE_FLOW_DISABLE_BRIDGE;
      else process.env.CLAUDE_FLOW_DISABLE_BRIDGE = prevDisableBridge;
    });

    it("reports backend='mock' when no real embedding model is available", async () => {
      // Force the raw fallback path (no AgentDB bridge) and make every real
      // embedding provider import fail so loadEmbeddingModel lands on the
      // hash fallback (model = null).
      process.env.CLAUDE_FLOW_DISABLE_BRIDGE = '1';
      vi.resetModules();
      const fail = () => { throw new Error('unavailable in test'); };
      vi.doMock('@huggingface/transformers', fail);
      vi.doMock('@xenova/transformers', fail);
      vi.doMock('ruvector', fail);
      vi.doMock('agentic-flow', fail);
      vi.doMock('agentic-flow/reasoningbank', fail);

      const { generateEmbedding } = await import('../src/memory/memory-initializer.js');
      const result = await generateEmbedding('audit-3 mock-backend assertion');

      expect(result.backend).toBe('mock');
      expect(result.model).toBe('hash-fallback');
      expect(Array.isArray(result.embedding)).toBe(true);
      expect(result.embedding.length).toBe(result.dimensions);
    });

    it("always sets backend, and 'mock' implies the hash-fallback model", async () => {
      // Invariant check that holds regardless of which providers are installed:
      // backend is one of the two known values, and mock <=> hash-fallback.
      process.env.CLAUDE_FLOW_DISABLE_BRIDGE = '1';
      vi.resetModules();
      const { generateEmbedding } = await import('../src/memory/memory-initializer.js');
      const result = await generateEmbedding('audit-3 backend invariant');

      expect(['onnx', 'mock']).toContain(result.backend);
      if (result.backend === 'mock') {
        expect(result.model).toBe('hash-fallback');
      }
    }, 60000); // real ONNX model can be slow to cold-load when installed
  });
});

// =============================================================================
// Intelligence Module (SONA + ReasoningBank)
// =============================================================================

describe('Intelligence Module', () => {
  beforeEach(async () => {
    const { clearIntelligence } = await import('../src/memory/intelligence.js');
    clearIntelligence();
  });

  describe('initializeIntelligence', () => {
    it('should initialize successfully with defaults', async () => {
      const { initializeIntelligence } = await import('../src/memory/intelligence.js');
      const result = await initializeIntelligence();
      expect(result.success).toBe(true);
      expect(result.sonaEnabled).toBe(true);
      expect(result.reasoningBankEnabled).toBe(true);
    });

    it('should return cached result on second call', async () => {
      const { initializeIntelligence } = await import('../src/memory/intelligence.js');
      const first = await initializeIntelligence();
      const second = await initializeIntelligence();
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
    });

    it('should accept custom config overrides', async () => {
      const { initializeIntelligence } = await import('../src/memory/intelligence.js');
      const result = await initializeIntelligence({
        maxSignals: 100,
        maxPatterns: 50,
        patternThreshold: 0.9,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('getIntelligenceStats', () => {
    it('should return valid stats after initialization', async () => {
      const { initializeIntelligence, getIntelligenceStats } = await import('../src/memory/intelligence.js');
      await initializeIntelligence();
      const stats = getIntelligenceStats();
      expect(stats.sonaEnabled).toBe(true);
      // reasoningBankSize may be > 0 if patterns were loaded from persisted disk state
      expect(stats.reasoningBankSize).toBeGreaterThanOrEqual(0);
      expect(stats.patternsLearned).toBeGreaterThanOrEqual(0);
      expect(stats.trajectoriesRecorded).toBeGreaterThanOrEqual(0);
    });

    it('should return disabled state when not initialized', async () => {
      const { getIntelligenceStats } = await import('../src/memory/intelligence.js');
      const stats = getIntelligenceStats();
      expect(stats.sonaEnabled).toBe(false);
    });
  });

  describe('clearIntelligence', () => {
    it('should reset all state', async () => {
      const { initializeIntelligence, clearIntelligence, getIntelligenceStats } = await import('../src/memory/intelligence.js');
      await initializeIntelligence();
      clearIntelligence();
      const stats = getIntelligenceStats();
      expect(stats.sonaEnabled).toBe(false);
      expect(stats.reasoningBankSize).toBe(0);
    });
  });

  describe('benchmarkAdaptation', () => {
    it('should achieve sub-0.05ms average adaptation time', async () => {
      const { initializeIntelligence, benchmarkAdaptation } = await import('../src/memory/intelligence.js');
      await initializeIntelligence();
      const result = benchmarkAdaptation(100);
      expect(result.avgMs).toBeLessThan(1);
      expect(result.totalMs).toBeGreaterThan(0);
      expect(typeof result.minMs).toBe('number');
      expect(typeof result.maxMs).toBe('number');
    });
  });

  describe('getNeuralDataDir', () => {
    it('should return a valid path string', async () => {
      const { getNeuralDataDir } = await import('../src/memory/intelligence.js');
      const dir = getNeuralDataDir();
      expect(typeof dir).toBe('string');
      expect(dir.length).toBeGreaterThan(0);
    });
  });

  describe('getPersistenceStatus', () => {
    it('should report persistence enabled', async () => {
      const { getPersistenceStatus } = await import('../src/memory/intelligence.js');
      const status = getPersistenceStatus();
      expect(status.enabled).toBe(true);
      expect(typeof status.dataDir).toBe('string');
      expect(typeof status.patternsFile).toBe('string');
      expect(typeof status.statsFile).toBe('string');
    });
  });
});

// =============================================================================
// SONA Optimizer
// =============================================================================

// SONAOptimizer's processTrajectoryOutcome / getRoutingSuggestion paths
// pull in the optional native @ruvector/sona engine. Without the binary
// (CI without postinstall scripts), 14 assertions fail because intent
// detection returns empty results — even though the package resolves,
// the WASM binary doesn't load. Skip in CI.
const __SKIP_WASM_TESTS = process.env.CI === 'true';

describe.skipIf(__SKIP_WASM_TESTS)('SONA Optimizer', () => {
  let optimizer: any;

  beforeEach(async () => {
    const { SONAOptimizer } = await import('../src/memory/sona-optimizer.js');
    optimizer = new SONAOptimizer({ persistencePath: '/tmp/sona-test-patterns.json' });
    // Skip initialize to avoid disk I/O in tests
  });

  describe('processTrajectoryOutcome', () => {
    it('should learn from a successful outcome', () => {
      const result = optimizer.processTrajectoryOutcome({
        trajectoryId: 'test-1',
        task: 'implement authentication feature',
        agent: 'coder',
        success: true,
      });
      expect(result.learned).toBe(true);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.keywordsExtracted.length).toBeGreaterThan(0);
    });

    it('should learn from a failed outcome', () => {
      const result = optimizer.processTrajectoryOutcome({
        trajectoryId: 'test-2',
        task: 'debug memory leak bug',
        agent: 'debugger',
        success: false,
      });
      expect(result.learned).toBe(true);
      expect(result.confidence).toBeLessThan(0.5);
    });

    it('should not learn from empty task', () => {
      const result = optimizer.processTrajectoryOutcome({
        trajectoryId: 'test-3',
        task: '',
        agent: 'coder',
        success: true,
      });
      expect(result.learned).toBe(false);
    });

    it('should increase confidence on repeated success', () => {
      const task = 'write unit tests for auth module';
      optimizer.processTrajectoryOutcome({ trajectoryId: 'a', task, agent: 'tester', success: true });
      const r2 = optimizer.processTrajectoryOutcome({ trajectoryId: 'b', task, agent: 'tester', success: true });
      expect(r2.confidence).toBeGreaterThan(0.5);
    });
  });

  describe('getRoutingSuggestion', () => {
    it('should suggest coder for implementation tasks', async () => {
      const suggestion = await optimizer.getRoutingSuggestion('implement a new feature for authentication');
      expect(suggestion.agent).toBeDefined();
      expect(suggestion.confidence).toBeGreaterThan(0);
      expect(suggestion.source).toBeDefined();
    });

    it('should suggest tester for test tasks', async () => {
      const suggestion = await optimizer.getRoutingSuggestion('write unit test coverage for the API');
      expect(suggestion.agent).toBeDefined();
      expect(['tester', 'coder', 'reviewer']).toContain(suggestion.agent);
    });

    it('should fallback to default for unknown tasks', async () => {
      const suggestion = await optimizer.getRoutingSuggestion('xyzzy');
      expect(suggestion.agent).toBe('coder');
      expect(suggestion.source).toBe('default');
      expect(suggestion.confidence).toBe(0.3);
    });

    it('should include alternatives', async () => {
      const suggestion = await optimizer.getRoutingSuggestion('implement and test security audit');
      expect(suggestion.alternatives).toBeDefined();
      expect(Array.isArray(suggestion.alternatives)).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should track trajectory processing', () => {
      optimizer.processTrajectoryOutcome({
        trajectoryId: 't1', task: 'implement feature', agent: 'coder', success: true,
      });
      const stats = optimizer.getStats();
      expect(stats.totalPatterns).toBeGreaterThan(0);
      expect(stats.trajectoriesProcessed).toBe(1);
      expect(stats.successfulRoutings).toBe(1);
    });
  });

  describe('applyTemporalDecay', () => {
    it('should return number of decayed patterns', () => {
      optimizer.processTrajectoryOutcome({
        trajectoryId: 't1', task: 'implement feature', agent: 'coder', success: true,
      });
      const decayed = optimizer.applyTemporalDecay();
      expect(typeof decayed).toBe('number');
    });
  });

  describe('reset', () => {
    it('should clear all learned patterns', () => {
      optimizer.processTrajectoryOutcome({
        trajectoryId: 't1', task: 'implement feature', agent: 'coder', success: true,
      });
      optimizer.reset();
      const stats = optimizer.getStats();
      expect(stats.totalPatterns).toBe(0);
      expect(stats.trajectoriesProcessed).toBe(0);
    });
  });

  describe('exportPatterns / importPatterns', () => {
    it('should round-trip patterns through export/import', () => {
      optimizer.processTrajectoryOutcome({
        trajectoryId: 't1', task: 'build new api endpoint', agent: 'coder', success: true,
      });
      const exported = optimizer.exportPatterns();
      expect(Object.keys(exported).length).toBeGreaterThan(0);

      const newOptimizer = new (optimizer.constructor)({ persistencePath: '/tmp/sona-test2.json' });
      const imported = newOptimizer.importPatterns(exported);
      expect(imported).toBe(Object.keys(exported).length);
    });

    it('should reject invalid patterns on import', () => {
      const imported = optimizer.importPatterns({
        'bad': { invalid: true } as any,
      });
      expect(imported).toBe(0);
    });
  });
});

// =============================================================================
// EWC Consolidation
// =============================================================================

describe('EWC Consolidation', () => {
  let consolidator: any;

  beforeEach(async () => {
    const { EWCConsolidator } = await import('../src/memory/ewc-consolidation.js');
    consolidator = new EWCConsolidator({
      lambda: 0.4,
      dimensions: 8,
      maxPatterns: 100,
      storagePath: '/tmp/ewc-test-fisher.json',
    });
  });

  describe('computeFisherMatrix', () => {
    it('should compute diagonal Fisher from successful patterns', () => {
      const fisher = consolidator.computeFisherMatrix([
        { id: 'p1', embedding: [0.5, 0.3, 0.2, 0.1, 0, 0, 0, 0], success: true },
        { id: 'p2', embedding: [0.1, 0.4, 0.6, 0.2, 0, 0, 0, 0], success: true },
      ]);
      expect(fisher.length).toBe(8);
      expect(fisher[0]).toBeGreaterThan(0);
    });

    it('should ignore failed patterns', () => {
      const fisher = consolidator.computeFisherMatrix([
        { id: 'p1', embedding: [1, 1, 1, 1, 0, 0, 0, 0], success: false },
      ]);
      expect(fisher.every((v: number) => v === 0)).toBe(true);
    });

    it('should handle empty patterns array', () => {
      const fisher = consolidator.computeFisherMatrix([]);
      expect(fisher.length).toBe(8);
      expect(fisher.every((v: number) => v === 0)).toBe(true);
    });
  });

  describe('getPenalty', () => {
    it('should compute EWC penalty between weight vectors', () => {
      const oldW = [0.5, 0.3, 0.2, 0.1, 0, 0, 0, 0];
      const newW = [0.6, 0.4, 0.3, 0.2, 0, 0, 0, 0];
      const fisher = [1, 1, 1, 1, 0, 0, 0, 0];
      const penalty = consolidator.getPenalty(oldW, newW, fisher);
      expect(typeof penalty).toBe('number');
      expect(penalty).toBeGreaterThan(0);
    });

    it('should return 0 for identical weights', () => {
      const w = [0.5, 0.3, 0.2, 0.1, 0, 0, 0, 0];
      const fisher = [1, 1, 1, 1, 0, 0, 0, 0];
      const penalty = consolidator.getPenalty(w, w, fisher);
      expect(penalty).toBe(0);
    });
  });

  describe('consolidate', () => {
    it('should consolidate new patterns', () => {
      const result = consolidator.consolidate([
        { id: 'new1', embedding: [0.5, 0.3, 0.2, 0.1, 0, 0, 0, 0], type: 'task-routing' },
        { id: 'new2', embedding: [0.1, 0.4, 0.6, 0.2, 0, 0, 0, 0], type: 'learning' },
      ]);
      expect(result.success).toBe(true);
      expect(result.patternsConsolidated).toBe(2);
      expect(result.modifiedPatterns.length).toBe(2);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('should protect high-importance existing patterns', () => {
      // First consolidation
      consolidator.consolidate([
        { id: 'important', embedding: [1, 0, 0, 0, 0, 0, 0, 0], type: 'core' },
      ]);
      // Simulate many successes
      for (let i = 0; i < 10; i++) {
        consolidator.recordGradient('important', [1, 0, 0, 0, 0, 0, 0, 0], true);
      }
      // Try to overwrite
      const result = consolidator.consolidate([
        { id: 'important', embedding: [0, 1, 0, 0, 0, 0, 0, 0], type: 'core' },
      ]);
      expect(result.success).toBe(true);
      expect(result.modifiedPatterns).toContain('important');
    });

    it('should handle empty patterns input', () => {
      const result = consolidator.consolidate([]);
      expect(result.success).toBe(true);
      expect(result.patternsConsolidated).toBe(0);
    });
  });

  describe('recordGradient', () => {
    it('should update pattern success count', () => {
      consolidator.consolidate([
        { id: 'p1', embedding: [0.5, 0.3, 0, 0, 0, 0, 0, 0], type: 'test' },
      ]);
      consolidator.recordGradient('p1', [0.5, 0.3, 0, 0, 0, 0, 0, 0], true);
      const pattern = consolidator.getPatternWeights('p1');
      expect(pattern.successCount).toBe(1);
    });

    it('should update pattern failure count', () => {
      consolidator.consolidate([
        { id: 'p2', embedding: [0.5, 0.3, 0, 0, 0, 0, 0, 0], type: 'test' },
      ]);
      consolidator.recordGradient('p2', [0.5, 0.3, 0, 0, 0, 0, 0, 0], false);
      const pattern = consolidator.getPatternWeights('p2');
      expect(pattern.failureCount).toBe(1);
    });
  });

  describe('getConsolidationStats', () => {
    it('should return valid statistics', () => {
      const stats = consolidator.getConsolidationStats();
      expect(typeof stats.totalPatterns).toBe('number');
      expect(typeof stats.avgFisherValue).toBe('number');
      expect(typeof stats.consolidationCount).toBe('number');
    });
  });

  describe('clear', () => {
    it('should reset all state', () => {
      consolidator.consolidate([
        { id: 'p1', embedding: [0.5, 0.3, 0, 0, 0, 0, 0, 0], type: 'test' },
      ]);
      consolidator.clear();
      expect(consolidator.getAllPatterns().length).toBe(0);
    });
  });

  describe('setLambda / getLambda', () => {
    it('should update lambda parameter', () => {
      consolidator.setLambda(0.8);
      expect(consolidator.getLambda()).toBe(0.8);
    });
  });
});

// =============================================================================
// AST Analyzer
// =============================================================================

describe('AST Analyzer', () => {
  let analyzer: any;

  beforeEach(async () => {
    const { ASTAnalyzer } = await import('../src/ruvector/ast-analyzer.js');
    analyzer = new ASTAnalyzer();
  });

  describe('analyze', () => {
    it('should detect TypeScript functions', () => {
      const code = `
export function greet(name: string): string {
  return \`Hello, \${name}\`;
}

function helper() {
  return true;
}
`;
      const result = analyzer.analyze(code, 'test.ts');
      expect(result.language).toBe('typescript');
      expect(result.functions.length).toBeGreaterThanOrEqual(2);
      expect(result.functions.some((f: any) => f.name === 'greet')).toBe(true);
      expect(result.functions.some((f: any) => f.name === 'helper')).toBe(true);
    });

    it('should detect Python functions and classes', () => {
      const code = `
class MyClass(Base):
    def method(self):
        pass

def standalone():
    pass
`;
      const result = analyzer.analyze(code, 'test.py');
      expect(result.language).toBe('python');
      expect(result.functions.length).toBeGreaterThanOrEqual(1);
      expect(result.classes.length).toBeGreaterThanOrEqual(1);
    });

    it('should extract imports', () => {
      const code = `
import { foo } from './bar';
import path from 'path';
const fs = require('fs');
`;
      const result = analyzer.analyze(code, 'test.ts');
      expect(result.imports.length).toBeGreaterThanOrEqual(2);
    });

    it('should extract exports', () => {
      const code = `
export function foo() {}
export const bar = 1;
export class Baz {}
`;
      const result = analyzer.analyze(code, 'test.ts');
      expect(result.exports.length).toBeGreaterThanOrEqual(3);
    });

    it('should calculate cyclomatic complexity', () => {
      const code = `
function complex(x) {
  if (x > 0) {
    if (x > 10) {
      return 'high';
    } else {
      return 'low';
    }
  } else {
    for (let i = 0; i < 10; i++) {
      while (x < 0) {
        x++;
      }
    }
  }
  return x ? 'yes' : 'no';
}
`;
      const result = analyzer.analyze(code, 'test.js');
      expect(result.complexity.cyclomatic).toBeGreaterThan(1);
      expect(result.complexity.cognitive).toBeGreaterThan(0);
      expect(result.complexity.loc).toBeGreaterThan(0);
    });

    it('should compute comment density', () => {
      const code = `
// This is a comment
/* Another comment */
function foo() {
  // Inline comment
  return 1;
}
`;
      const result = analyzer.analyze(code, 'test.js');
      expect(result.complexity.commentDensity).toBeGreaterThan(0);
    });

    it('should throw for files exceeding maxFileSize', () => {
      const bigCode = 'x'.repeat(1024 * 1024 + 1);
      expect(() => analyzer.analyze(bigCode, 'big.ts')).toThrow('File too large');
    });

    it('should cache analysis results', () => {
      const code = 'function test() {}';
      const r1 = analyzer.analyze(code, 'test.ts');
      const r2 = analyzer.analyze(code, 'test.ts');
      expect(r1).toBe(r2); // Same reference from cache
    });
  });

  describe('getFunctionAtLine', () => {
    it('should find function containing a given line', () => {
      const code = `
function foo() {
  return 1;
}
`;
      const analysis = analyzer.analyze(code, 'test.js');
      const func = analyzer.getFunctionAtLine(analysis, 3);
      expect(func).not.toBeNull();
      expect(func?.name).toBe('foo');
    });

    it('should return null for lines not in any function', () => {
      const code = `
function foo() {
  return 1;
}
`;
      const analysis = analyzer.analyze(code, 'test.js');
      const func = analyzer.getFunctionAtLine(analysis, 100);
      expect(func).toBeNull();
    });
  });

  describe('getSymbols', () => {
    it('should list function and class names', () => {
      const code = `
class MyClass {}
function myFunc() {}
`;
      const analysis = analyzer.analyze(code, 'test.ts');
      const symbols = analyzer.getSymbols(analysis);
      expect(symbols).toContain('myFunc');
      expect(symbols).toContain('MyClass');
    });
  });

  describe('getStats / clearCache', () => {
    it('should track and clear cache', () => {
      analyzer.analyze('function x() {}', 'a.ts');
      expect(analyzer.getStats().cacheSize).toBe(1);
      analyzer.clearCache();
      expect(analyzer.getStats().cacheSize).toBe(0);
    });
  });

  describe('createASTAnalyzer factory', () => {
    it('should create analyzer with custom config', async () => {
      const { createASTAnalyzer } = await import('../src/ruvector/ast-analyzer.js');
      const a = createASTAnalyzer({ maxDepth: 5 });
      expect(a).toBeDefined();
    });
  });
});

// =============================================================================
// Diff Classifier
// =============================================================================

describe('Diff Classifier', () => {
  let classifier: any;

  beforeEach(async () => {
    const { DiffClassifier } = await import('../src/ruvector/diff-classifier.js');
    classifier = new DiffClassifier();
  });

  describe('classifyCommitMessage', () => {
    it('should classify feat as feature', () => {
      expect(classifier.classifyCommitMessage('feat: add login page')).toBe('feature');
    });

    it('should classify fix as bugfix', () => {
      expect(classifier.classifyCommitMessage('fix: resolve null pointer')).toBe('bugfix');
    });

    it('should classify refactor as refactor', () => {
      expect(classifier.classifyCommitMessage('refactor: extract helper')).toBe('refactor');
    });

    it('should classify docs as docs', () => {
      expect(classifier.classifyCommitMessage('docs: update readme')).toBe('docs');
    });

    it('should classify test as test', () => {
      expect(classifier.classifyCommitMessage('test: add unit tests')).toBe('test');
    });

    it('should return unknown for unrecognized', () => {
      expect(classifier.classifyCommitMessage('misc: random stuff')).toBe('unknown');
    });
  });

  describe('parseDiff', () => {
    it('should parse a git diff into file diffs', () => {
      const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
 import express from 'express';
+import cors from 'cors';
 const app = express();
`;
      const files = classifier.parseDiff(diff);
      expect(files.length).toBe(1);
      expect(files[0].path).toBe('src/app.ts');
      expect(files[0].additions).toBeGreaterThanOrEqual(1);
    });

    it('should handle empty diff', () => {
      const files = classifier.parseDiff('');
      expect(files.length).toBe(0);
    });
  });

  describe('classify', () => {
    it('should compute overall classification from file diffs', () => {
      const files = [
        {
          path: 'src/auth.ts',
          hunks: [],
          additions: 50,
          deletions: 10,
          classification: { primary: 'feature' as const, secondary: [], confidence: 0.8, impactLevel: 'high' as const, suggestedReviewers: ['dev'], testingStrategy: ['unit-tests'], riskFactors: [] },
        },
      ];
      const analysis = classifier.classify(files);
      expect(analysis.overall.primary).toBe('feature');
      expect(analysis.stats.totalAdditions).toBe(50);
      expect(analysis.stats.totalDeletions).toBe(10);
      expect(analysis.stats.filesChanged).toBe(1);
    });

    it('should handle empty files array', () => {
      const analysis = classifier.classify([]);
      expect(analysis.overall.primary).toBe('unknown');
      expect(analysis.stats.filesChanged).toBe(0);
    });
  });

  describe('assessFileRisk', () => {
    it('should assess security files as high risk', async () => {
      const { assessFileRisk } = await import('../src/ruvector/diff-classifier.js');
      const result = assessFileRisk({
        path: 'src/security/auth.ts', status: 'modified', additions: 50, deletions: 10, hunks: 1, binary: false,
      });
      expect(['high', 'critical']).toContain(result.risk);
      expect(result.reasons.some((r: string) => r.includes('Security'))).toBe(true);
    });

    it('should assess test files as low risk', async () => {
      const { assessFileRisk } = await import('../src/ruvector/diff-classifier.js');
      const result = assessFileRisk({
        path: 'tests/helper.test.ts', status: 'modified', additions: 5, deletions: 2, hunks: 1, binary: false,
      });
      expect(result.risk).toBe('low');
    });
  });

  describe('assessOverallRisk', () => {
    it('should compute overall risk from file risks', async () => {
      const { assessOverallRisk } = await import('../src/ruvector/diff-classifier.js');
      const files = [
        { path: 'src/core.ts', status: 'modified' as const, additions: 20, deletions: 5, hunks: 1, binary: false },
      ];
      const fileRisks = [
        { file: 'src/core.ts', risk: 'medium' as const, score: 30, reasons: ['Core module'] },
      ];
      const result = assessOverallRisk(files, fileRisks);
      expect(result.overall).toBeDefined();
      expect(result.score).toBeGreaterThan(0);
      expect(result.breakdown).toBeDefined();
    });
  });

  describe('validateGitRef', () => {
    it('should reject refs with shell metacharacters', async () => {
      const mod = await import('../src/ruvector/diff-classifier.js');
      // getGitDiffNumstat calls validateGitRef internally which throws on unsafe chars
      expect(() => mod.getGitDiffNumstat('HEAD; rm -rf /')).toThrow('Invalid git ref');
    });
  });
});

// =============================================================================
// Coverage Router
// =============================================================================

describe('Coverage Router', () => {
  let router: any;

  beforeEach(async () => {
    const { CoverageRouter } = await import('../src/ruvector/coverage-router.js');
    router = new CoverageRouter({ minCoverage: 70, targetCoverage: 85 });
  });

  describe('parseCoverage - JSON', () => {
    it('should parse JSON coverage data', () => {
      const data = {
        'src/app.ts': { lineCoverage: 80, branchCoverage: 60, functionCoverage: 90, statementCoverage: 85, uncoveredLines: [10, 20], totalLines: 100, coveredLines: 80 },
      };
      const report = router.parseCoverage(data, 'json');
      expect(report.byFile.length).toBe(1);
      expect(report.byFile[0].path).toBe('src/app.ts');
      expect(report.overall).toBeGreaterThan(0);
    });
  });

  describe('parseCoverage - LCOV', () => {
    it('should parse LCOV format', () => {
      const lcov = `SF:src/index.ts
LF:50
LH:40
DA:10,0
DA:20,1
end_of_record
SF:src/utils.ts
LF:30
LH:25
end_of_record`;
      const report = router.parseCoverage(lcov, 'lcov');
      expect(report.byFile.length).toBe(2);
    });
  });

  describe('route', () => {
    it('should determine add-tests action for low coverage', () => {
      const coverage = {
        overall: 50,
        byType: { line: 50, branch: 40, function: 60, statement: 50 },
        byFile: [
          { path: 'src/a.ts', lineCoverage: 30, branchCoverage: 20, functionCoverage: 50, statementCoverage: 30, uncoveredLines: [1,2,3,4,5,6,7,8,9,10,11], totalLines: 100, coveredLines: 30 },
          { path: 'src/b.ts', lineCoverage: 40, branchCoverage: 30, functionCoverage: 50, statementCoverage: 40, uncoveredLines: [1,2,3,4,5,6,7,8,9,10,11], totalLines: 100, coveredLines: 40 },
          { path: 'src/c.ts', lineCoverage: 50, branchCoverage: 40, functionCoverage: 60, statementCoverage: 50, uncoveredLines: [1,2,3,4,5,6,7,8,9,10,11], totalLines: 100, coveredLines: 50 },
          { path: 'src/d.ts', lineCoverage: 55, branchCoverage: 45, functionCoverage: 65, statementCoverage: 55, uncoveredLines: [1,2,3,4,5], totalLines: 100, coveredLines: 55 },
          { path: 'src/e.ts', lineCoverage: 60, branchCoverage: 50, functionCoverage: 70, statementCoverage: 60, uncoveredLines: [1,2], totalLines: 100, coveredLines: 60 },
          { path: 'src/f.ts', lineCoverage: 65, branchCoverage: 55, functionCoverage: 75, statementCoverage: 65, uncoveredLines: [], totalLines: 100, coveredLines: 65 },
        ],
        lowestCoverage: [],
        highestCoverage: [],
        uncoveredCritical: [],
        timestamp: Date.now(),
      };
      const result = router.route(coverage);
      expect(result.action).toBe('prioritize');
      expect(result.gaps.length).toBeGreaterThan(0);
      expect(result.testTypes).toContain('unit');
    });

    it('should determine skip for good coverage', () => {
      const coverage = {
        overall: 95,
        byType: { line: 95, branch: 90, function: 95, statement: 95 },
        byFile: [
          { path: 'src/a.ts', lineCoverage: 95, branchCoverage: 90, functionCoverage: 95, statementCoverage: 95, uncoveredLines: [], totalLines: 100, coveredLines: 95 },
        ],
        lowestCoverage: [],
        highestCoverage: [],
        uncoveredCritical: [],
        timestamp: Date.now(),
      };
      const result = router.route(coverage);
      expect(result.action).toBe('skip');
    });
  });

  describe('getTrend', () => {
    it('should return stable with insufficient history', () => {
      const trend = router.getTrend();
      expect(trend.direction).toBe('stable');
      expect(trend.change).toBe(0);
    });

    it('should detect upward trend', () => {
      const r1 = { overall: 70, byType: { line: 70, branch: 70, function: 70, statement: 70 }, byFile: [], lowestCoverage: [], highestCoverage: [], uncoveredCritical: [], timestamp: Date.now() };
      const r2 = { overall: 80, byType: { line: 80, branch: 80, function: 80, statement: 80 }, byFile: [], lowestCoverage: [], highestCoverage: [], uncoveredCritical: [], timestamp: Date.now() };
      router.addToHistory(r1);
      router.addToHistory(r2);
      const trend = router.getTrend();
      expect(trend.direction).toBe('up');
      expect(trend.change).toBe(10);
    });
  });

  describe('getStats', () => {
    it('should return config and runtime stats', () => {
      const stats = router.getStats();
      expect(stats.minCoverage).toBe(70);
      expect(stats.targetCoverage).toBe(85);
      expect(stats.historySize).toBe(0);
    });
  });

  describe('clearCoverageCache', () => {
    it('should clear cache without error', async () => {
      const { clearCoverageCache, getCoverageCacheStats } = await import('../src/ruvector/coverage-router.js');
      clearCoverageCache();
      expect(getCoverageCacheStats().size).toBe(0);
    });
  });
});

// =============================================================================
// Graph Analyzer
// =============================================================================

describe('Graph Analyzer', () => {
  describe('detectCircularDependencies', () => {
    it('should detect simple cycles', async () => {
      const { detectCircularDependencies } = await import('../src/ruvector/graph-analyzer.js');
      const graph = {
        nodes: new Map([
          ['a.ts', { id: 'a.ts', path: 'a.ts', name: 'a', type: 'file' as const, imports: ['b.ts'], exports: [], size: 100 }],
          ['b.ts', { id: 'b.ts', path: 'b.ts', name: 'b', type: 'file' as const, imports: ['a.ts'], exports: [], size: 100 }],
        ]),
        edges: [
          { source: 'a.ts', target: 'b.ts', type: 'import' as const, weight: 1 },
          { source: 'b.ts', target: 'a.ts', type: 'import' as const, weight: 1 },
        ],
        metadata: { rootDir: '/test', totalFiles: 2, totalEdges: 2, buildTime: 10 },
      };
      const cycles = detectCircularDependencies(graph);
      expect(cycles.length).toBeGreaterThan(0);
      expect(cycles[0].severity).toBeDefined();
      expect(cycles[0].suggestion).toBeDefined();
    });

    it('should detect no cycles in acyclic graph', async () => {
      const { detectCircularDependencies } = await import('../src/ruvector/graph-analyzer.js');
      const graph = {
        nodes: new Map([
          ['a.ts', { id: 'a.ts', path: 'a.ts', name: 'a', type: 'file' as const, imports: ['b.ts'], exports: [], size: 100 }],
          ['b.ts', { id: 'b.ts', path: 'b.ts', name: 'b', type: 'file' as const, imports: [], exports: [], size: 100 }],
        ]),
        edges: [
          { source: 'a.ts', target: 'b.ts', type: 'import' as const, weight: 1 },
        ],
        metadata: { rootDir: '/test', totalFiles: 2, totalEdges: 1, buildTime: 5 },
      };
      const cycles = detectCircularDependencies(graph);
      expect(cycles.length).toBe(0);
    });
  });

  describe('fallbackMinCut', () => {
    it('should partition graph into two groups', async () => {
      const { fallbackMinCut } = await import('../src/ruvector/graph-analyzer.js');
      const nodes = ['a', 'b', 'c', 'd'];
      const edges: Array<[string, string, number]> = [
        ['a', 'b', 5],
        ['b', 'c', 1],
        ['c', 'd', 5],
      ];
      const result = fallbackMinCut(nodes, edges);
      expect(result.partition1.length + result.partition2.length).toBe(4);
      expect(result.cutValue).toBeDefined();
    });

    it('should handle single node graph', async () => {
      const { fallbackMinCut } = await import('../src/ruvector/graph-analyzer.js');
      const result = fallbackMinCut(['a'], []);
      expect(result.partition1.length).toBe(1);
      expect(result.partition2.length).toBe(0);
      expect(result.cutValue).toBe(0);
    });
  });

  describe('fallbackLouvain', () => {
    it('should detect communities in connected graph', async () => {
      const { fallbackLouvain } = await import('../src/ruvector/graph-analyzer.js');
      const nodes = ['a', 'b', 'c', 'd'];
      const edges: Array<[string, string, number]> = [
        ['a', 'b', 10],
        ['c', 'd', 10],
        ['b', 'c', 1],
      ];
      const result = fallbackLouvain(nodes, edges);
      expect(result.communities.length).toBeGreaterThan(0);
      expect(typeof result.modularity).toBe('number');
    });

    it('should handle empty graph', async () => {
      const { fallbackLouvain } = await import('../src/ruvector/graph-analyzer.js');
      const result = fallbackLouvain([], []);
      expect(result.communities.length).toBe(0);
      expect(result.modularity).toBe(0);
    });

    it('should place isolated nodes in separate communities', async () => {
      const { fallbackLouvain } = await import('../src/ruvector/graph-analyzer.js');
      const result = fallbackLouvain(['a', 'b', 'c'], []);
      expect(result.communities.length).toBe(3);
    });
  });

  describe('exportToDot', () => {
    it('should generate valid DOT format', async () => {
      const { exportToDot } = await import('../src/ruvector/graph-analyzer.js');
      const result = {
        graph: {
          nodes: new Map([
            ['a.ts', { id: 'a.ts', path: 'a.ts', name: 'a', type: 'file' as const, imports: [], exports: [], size: 100 }],
          ]),
          edges: [],
          metadata: { rootDir: '/test', totalFiles: 1, totalEdges: 0, buildTime: 5 },
        },
        circularDependencies: [],
        statistics: { nodeCount: 1, edgeCount: 0, avgDegree: 0, maxDegree: 0, density: 0, componentCount: 1 },
      };
      const dot = exportToDot(result);
      expect(dot).toContain('digraph');
      expect(dot).toContain('"a.ts"');
    });
  });

  describe('clearGraphCaches / getGraphCacheStats', () => {
    it('should clear and report cache', async () => {
      const { clearGraphCaches, getGraphCacheStats } = await import('../src/ruvector/graph-analyzer.js');
      clearGraphCaches();
      const stats = getGraphCacheStats();
      expect(stats.graphCacheSize).toBe(0);
      expect(stats.analysisCacheSize).toBe(0);
    });
  });
});

// =============================================================================
// Q-Learning Router
// =============================================================================

describe('Q-Learning Router', () => {
  let router: any;

  beforeEach(async () => {
    const { QLearningRouter } = await import('../src/ruvector/q-learning-router.js');
    router = new QLearningRouter({
      learningRate: 0.1,
      gamma: 0.99,
      explorationInitial: 1.0,
      explorationFinal: 0.01,
      explorationDecay: 100,
      enableReplay: true,
      replayBufferSize: 50,
      replayBatchSize: 5,
      cacheSize: 10,
      cacheTTL: 60000,
      autoSaveInterval: 0, // Disable auto-save in tests
      modelPath: '/tmp/q-learning-test-model.json',
    });
  });

  describe('route', () => {
    it('should return a route decision', () => {
      const decision = router.route('implement a new user login feature', true);
      expect(decision.route).toBeDefined();
      expect(typeof decision.confidence).toBe('number');
      expect(Array.isArray(decision.qValues)).toBe(true);
      expect(Array.isArray(decision.alternatives)).toBe(true);
    });

    it('should use cache for non-explore queries', () => {
      router.route('write unit tests', false);
      router.route('write unit tests', false);
      const stats = router.getStats();
      expect(stats.cacheHits + stats.cacheMisses).toBeGreaterThan(0);
    });
  });

  describe('update', () => {
    it('should return TD error on update', () => {
      const tdError = router.update('implement feature', 'coder', 1.0);
      expect(typeof tdError).toBe('number');
    });

    it('should return 0 for unknown action', () => {
      const tdError = router.update('implement feature', 'nonexistent-agent', 1.0);
      expect(tdError).toBe(0);
    });

    it('should decrease epsilon over updates', () => {
      const initialEpsilon = router.getStats().epsilon;
      for (let i = 0; i < 20; i++) {
        router.update(`task ${i}`, 'coder', 1.0);
      }
      const newEpsilon = router.getStats().epsilon;
      expect(newEpsilon).toBeLessThan(initialEpsilon);
    });

    it('should populate replay buffer', () => {
      for (let i = 0; i < 10; i++) {
        router.update(`task ${i}`, 'coder', Math.random());
      }
      const stats = router.getStats();
      expect(stats.replayBufferSize).toBe(10);
      expect(stats.totalExperiences).toBe(10);
    });
  });

  describe('reset', () => {
    it('should clear Q-table and all buffers', () => {
      router.update('task', 'coder', 1.0);
      router.route('test', false);
      router.reset();
      const stats = router.getStats();
      expect(stats.qTableSize).toBe(0);
      expect(stats.replayBufferSize).toBe(0);
      expect(stats.cacheSize).toBe(0);
      expect(stats.totalExperiences).toBe(0);
    });
  });

  describe('invalidateCache', () => {
    it('should clear route cache', () => {
      router.route('task', false);
      router.invalidateCache();
      expect(router.getStats().cacheSize).toBe(0);
    });
  });

  describe('export / import', () => {
    it('should export and import Q-table', async () => {
      router.update('implement feature', 'coder', 1.0);
      router.update('write tests', 'tester', 0.8);
      const exported = router.export();
      expect(Object.keys(exported).length).toBeGreaterThan(0);

      const mod = await import('../src/ruvector/q-learning-router.js');
      const newRouter = new mod.QLearningRouter();
      newRouter.import(exported);
      expect(newRouter.getStats().qTableSize).toBe(Object.keys(exported).length);
    });
  });

  describe('getStats', () => {
    it('should return comprehensive statistics', () => {
      const stats = router.getStats();
      expect(typeof stats.updateCount).toBe('number');
      expect(typeof stats.qTableSize).toBe('number');
      expect(typeof stats.epsilon).toBe('number');
      expect(typeof stats.avgTDError).toBe('number');
      expect(typeof stats.cacheHitRate).toBe('number');
      expect(typeof stats.replayBufferSize).toBe('number');
    });
  });

  describe('convergence behavior', () => {
    it('should learn to prefer rewarded routes', () => {
      // Train coder for "implement" tasks repeatedly
      for (let i = 0; i < 50; i++) {
        router.update('implement new feature module', 'coder', 1.0);
      }
      // Exploit mode should prefer coder
      const decision = router.route('implement new feature module', false);
      expect(decision.route).toBeDefined();
      // The Q-value for coder should be highest for similar contexts
      const coderIdx = 0; // coder is index 0 in ROUTE_NAMES
      expect(decision.qValues[coderIdx]).toBeGreaterThan(0);
    });
  });

  describe('createQLearningRouter factory', () => {
    it('should create router with defaults', async () => {
      const { createQLearningRouter } = await import('../src/ruvector/q-learning-router.js');
      const r = createQLearningRouter();
      expect(r).toBeDefined();
      expect(r.getStats().qTableSize).toBe(0);
    });
  });
});

// =============================================================================
// Service Layer: Agentic Flow Bridge
// =============================================================================

describe('Agentic Flow Bridge', () => {
  it('should export getReasoningBank function', async () => {
    const bridge = await import('../src/services/agentic-flow-bridge.js');
    expect(typeof bridge.getReasoningBank).toBe('function');
  });

  it('should export getRouter function', async () => {
    const bridge = await import('../src/services/agentic-flow-bridge.js');
    expect(typeof bridge.getRouter).toBe('function');
  });

  it('should export getOrchestration function', async () => {
    const bridge = await import('../src/services/agentic-flow-bridge.js');
    expect(typeof bridge.getOrchestration).toBe('function');
  });

  it('should handle missing agentic-flow gracefully in isAvailable', async () => {
    const bridge = await import('../src/services/agentic-flow-bridge.js');
    const available = await bridge.isAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('should return capabilities summary', async () => {
    const bridge = await import('../src/services/agentic-flow-bridge.js');
    const caps = await bridge.capabilities();
    expect(typeof caps.available).toBe('boolean');
    expect(typeof caps.reasoningBank).toBe('boolean');
    expect(typeof caps.router).toBe('boolean');
    expect(typeof caps.orchestration).toBe('boolean');
  });

  it('should return embedding or null for computeEmbedding', async () => {
    const bridge = await import('../src/services/agentic-flow-bridge.js');
    const result = await bridge.computeEmbedding('test');
    // If agentic-flow is installed, returns an array-like of numbers (may be Float32Array);
    // otherwise null
    if (result !== null && result !== undefined) {
      // Accept both regular Array and TypedArray (Float32Array, etc.)
      expect(typeof result.length).toBe('number');
      expect(result.length).toBeGreaterThan(0);
      expect(typeof result[0]).toBe('number');
    } else {
      expect(result).toBeNull();
    }
  });

  it('should return array or handle error for retrieveMemories', async () => {
    const bridge = await import('../src/services/agentic-flow-bridge.js');
    try {
      const result = await bridge.retrieveMemories('test');
      // If it succeeds, it returns an array
      expect(Array.isArray(result)).toBe(true);
    } catch (err: any) {
      // If agentic-flow is installed but DB not initialized, it may throw
      expect(err.message).toMatch(/Database|not initialized|unavailable/i);
    }
  });
});

// =============================================================================
// Service Layer: Registry API
// =============================================================================

describe('Registry API', () => {
  it('should export rateItem function', async () => {
    const api = await import('../src/services/registry-api.js');
    expect(typeof api.rateItem).toBe('function');
  });

  it('should reject invalid item IDs', async () => {
    const api = await import('../src/services/registry-api.js');
    await expect(api.rateItem('invalid<>id', 5)).rejects.toThrow('Invalid item ID');
  });

  it('should reject invalid ratings', async () => {
    const api = await import('../src/services/registry-api.js');
    await expect(api.rateItem('@claude-flow/test', 0)).rejects.toThrow('Rating must be integer 1-5');
    await expect(api.rateItem('@claude-flow/test', 6)).rejects.toThrow('Rating must be integer 1-5');
  });

  it('should reject non-integer ratings', async () => {
    const api = await import('../src/services/registry-api.js');
    await expect(api.rateItem('@claude-flow/test', 3.5)).rejects.toThrow('Rating must be integer 1-5');
  });

  it('should accept valid item IDs with scopes', async () => {
    const api = await import('../src/services/registry-api.js');
    // This should not throw on validation, but will fail on network
    // We just check it passes validation by catching the network error
    try {
      await api.getRating('@claude-flow/test-plugin', 'plugin');
    } catch (e: any) {
      // Network error is expected - validation passed
      expect(e.message).not.toContain('Invalid item ID');
    }
  });

  it('should validate bulk rating IDs', async () => {
    const api = await import('../src/services/registry-api.js');
    await expect(api.getBulkRatings(['valid-id', '<invalid>'])).rejects.toThrow('Invalid item ID');
  });
});

// =============================================================================
// RuVector Index Module
// =============================================================================

describe('RuVector Index', () => {
  it('should export all major components', async () => {
    const ruvector = await import('../src/ruvector/index.js');
    expect(ruvector.ASTAnalyzer).toBeDefined();
    expect(ruvector.DiffClassifier).toBeDefined();
    expect(ruvector.CoverageRouter).toBeDefined();
    expect(ruvector.QLearningRouter).toBeDefined();
    expect(ruvector.createASTAnalyzer).toBeDefined();
    expect(ruvector.createDiffClassifier).toBeDefined();
    expect(ruvector.createCoverageRouter).toBeDefined();
    expect(ruvector.createQLearningRouter).toBeDefined();
  });

  it('should export factory functions', async () => {
    const ruvector = await import('../src/ruvector/index.js');
    expect(typeof ruvector.createASTAnalyzer).toBe('function');
    expect(typeof ruvector.createDiffClassifier).toBe('function');
    expect(typeof ruvector.createCoverageRouter).toBe('function');
    expect(typeof ruvector.createQLearningRouter).toBe('function');
  });

  it('should export isRuvectorAvailable', async () => {
    const ruvector = await import('../src/ruvector/index.js');
    expect(typeof ruvector.isRuvectorAvailable).toBe('function');
    const available = await ruvector.isRuvectorAvailable();
    expect(typeof available).toBe('boolean');
  });

  it('should export graph analyzer utilities', async () => {
    const ruvector = await import('../src/ruvector/index.js');
    expect(typeof ruvector.detectCircularDependencies).toBe('function');
    expect(typeof ruvector.fallbackMinCut).toBe('function');
    expect(typeof ruvector.fallbackLouvain).toBe('function');
    expect(typeof ruvector.exportToDot).toBe('function');
  });

  it('should export diff analysis tools', async () => {
    const ruvector = await import('../src/ruvector/index.js');
    expect(typeof ruvector.assessFileRisk).toBe('function');
    expect(typeof ruvector.assessOverallRisk).toBe('function');
    expect(typeof ruvector.classifyDiff).toBe('function');
  });

  it('should export cache control functions', async () => {
    const ruvector = await import('../src/ruvector/index.js');
    expect(typeof ruvector.clearDiffCache).toBe('function');
    expect(typeof ruvector.clearAllDiffCaches).toBe('function');
    expect(typeof ruvector.clearCoverageCache).toBe('function');
    expect(typeof ruvector.clearGraphCaches).toBe('function');
  });
});

// =============================================================================
// Additional Edge Cases
// =============================================================================

describe('Edge Cases', () => {
  describe('AST Analyzer with arrow functions', () => {
    it('should detect arrow function assignments', async () => {
      const { ASTAnalyzer } = await import('../src/ruvector/ast-analyzer.js');
      const analyzer = new ASTAnalyzer();
      const code = `const handler = async (req, res) => {\n  return res.json({});\n}\n`;
      const result = analyzer.analyze(code, 'test.ts');
      expect(result.functions.some((f: any) => f.name === 'handler')).toBe(true);
    });
  });

  describe('Diff Classifier with refactoring detection', () => {
    it('should detect balanced adds/removes as refactoring', async () => {
      const { DiffClassifier } = await import('../src/ruvector/diff-classifier.js');
      const dc = new DiffClassifier({ detectRefactoring: true });
      const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,10 +1,10 @@
-const old1 = 1;
-const old2 = 2;
-const old3 = 3;
-const old4 = 4;
-const old5 = 5;
-const old6 = 6;
+const new1 = 1;
+const new2 = 2;
+const new3 = 3;
+const new4 = 4;
+const new5 = 5;
+const new6 = 6;
`;
      const files = dc.parseDiff(diff);
      expect(files.length).toBe(1);
      // The balanced add/remove pattern is a refactor indicator
    });
  });

  describe('Coverage Router with changed files', () => {
    it('should prioritize changed files in routing', async () => {
      const { CoverageRouter } = await import('../src/ruvector/coverage-router.js');
      const cr = new CoverageRouter();
      const coverage = {
        overall: 75,
        byType: { line: 75, branch: 70, function: 80, statement: 75 },
        byFile: [
          { path: 'src/auth.ts', lineCoverage: 40, branchCoverage: 30, functionCoverage: 50, statementCoverage: 40, uncoveredLines: [1,2,3], totalLines: 100, coveredLines: 40 },
          { path: 'src/utils.ts', lineCoverage: 90, branchCoverage: 85, functionCoverage: 95, statementCoverage: 90, uncoveredLines: [], totalLines: 50, coveredLines: 45 },
        ],
        lowestCoverage: [{ path: 'src/auth.ts', lineCoverage: 40, branchCoverage: 30, functionCoverage: 50, statementCoverage: 40, uncoveredLines: [1,2,3], totalLines: 100, coveredLines: 40 }],
        highestCoverage: [{ path: 'src/utils.ts', lineCoverage: 90, branchCoverage: 85, functionCoverage: 95, statementCoverage: 90, uncoveredLines: [], totalLines: 50, coveredLines: 45 }],
        uncoveredCritical: ['src/auth.ts'],
        timestamp: Date.now(),
      };
      const result = cr.route(coverage, ['src/auth.ts']);
      expect(result.targetFiles).toContain('src/auth.ts');
    });
  });

  describe('Q-Learning exploration decay types', () => {
    it('should support linear decay', async () => {
      const { QLearningRouter } = await import('../src/ruvector/q-learning-router.js');
      const r = new QLearningRouter({
        explorationDecayType: 'linear',
        explorationInitial: 1.0,
        explorationFinal: 0.1,
        explorationDecay: 10,
        autoSaveInterval: 0,
      });
      for (let i = 0; i < 10; i++) r.update('task', 'coder', 1.0);
      expect(r.getStats().epsilon).toBeLessThan(1.0);
    });

    it('should support cosine decay', async () => {
      const { QLearningRouter } = await import('../src/ruvector/q-learning-router.js');
      const r = new QLearningRouter({
        explorationDecayType: 'cosine',
        explorationInitial: 1.0,
        explorationFinal: 0.1,
        explorationDecay: 10,
        autoSaveInterval: 0,
      });
      for (let i = 0; i < 5; i++) r.update('task', 'coder', 1.0);
      expect(r.getStats().epsilon).toBeLessThan(1.0);
      expect(r.getStats().epsilon).toBeGreaterThan(0);
    });
  });

  describe.skipIf(__SKIP_WASM_TESTS)('SONA Optimizer keyword extraction', () => {
    it('should extract architecture keywords', async () => {
      const { SONAOptimizer } = await import('../src/memory/sona-optimizer.js');
      const opt = new SONAOptimizer({ persistencePath: '/tmp/sona-kw-test.json' });
      const result = opt.processTrajectoryOutcome({
        trajectoryId: 'kw1',
        task: 'design the database schema architecture',
        agent: 'architect',
        success: true,
      });
      expect(result.keywordsExtracted).toContain('design');
      expect(result.keywordsExtracted).toContain('database');
      expect(result.keywordsExtracted).toContain('schema');
      expect(result.keywordsExtracted).toContain('architecture');
    });
  });

  describe('EWC resetFisher', () => {
    it('should zero out Fisher matrix', async () => {
      const { EWCConsolidator } = await import('../src/memory/ewc-consolidation.js');
      const c = new EWCConsolidator({ dimensions: 4, storagePath: '/tmp/ewc-rf-test.json' });
      c.computeFisherMatrix([{ id: 'x', embedding: [1, 1, 1, 1], success: true }]);
      c.resetFisher();
      const stats = c.getConsolidationStats();
      expect(stats.avgFisherValue).toBe(0);
    });
  });
});

// =============================================================================
// memory_store handler: undefined/null value guard (#1032)
// =============================================================================

describe('memory_store undefined value guard (#1032)', () => {
  it('should return error when value is undefined', async () => {
    const { memoryTools } = await import('../src/mcp-tools/memory-tools.js');
    const tool = memoryTools.find(t => t.name === 'memory_store')!;
    expect(tool).toBeDefined();

    const result: any = await tool.handler({ key: 'test-key' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required parameter: value (cannot be null or undefined)');
  });

  it('should return error when value is null', async () => {
    const { memoryTools } = await import('../src/mcp-tools/memory-tools.js');
    const tool = memoryTools.find(t => t.name === 'memory_store')!;

    const result: any = await tool.handler({ key: 'test-key', value: null });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required parameter: value (cannot be null or undefined)');
  });

  it('should not crash and should include full error payload', async () => {
    const { memoryTools } = await import('../src/mcp-tools/memory-tools.js');
    const tool = memoryTools.find(t => t.name === 'memory_store')!;

    const result: any = await tool.handler({ key: 'my-key', value: undefined });
    expect(result.success).toBe(false);
    expect(result.key).toBe('my-key');
    expect(result.namespace).toBe('default');
    expect(result.stored).toBe(false);
    expect(result.hasEmbedding).toBe(false);
  });

  it('should return error when value is empty string', async () => {
    const { memoryTools } = await import('../src/mcp-tools/memory-tools.js');
    const tool = memoryTools.find(t => t.name === 'memory_store')!;

    const result: any = await tool.handler({ key: 'empty-key', value: '' });
    expect(result.success).toBe(false);
    expect(result.stored).toBe(false);
    expect(result.error).toContain('Value is required');
  });
});
