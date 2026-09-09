/**
 * Deep validation: SONA optimizer, embeddings transparency, neural tools
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SONAOptimizer, resetSONAOptimizer } from '../src/memory/sona-optimizer.js';
import { generateEmbedding } from '../src/ruvector/vector-db.js';

// ---------- SONA Optimizer ----------
describe('SONA Optimizer', () => {
  let sona: SONAOptimizer;

  beforeEach(() => {
    resetSONAOptimizer();
    sona = new SONAOptimizer({ persistencePath: '/tmp/sona-test-' + Date.now() + '.json' });
  });

  it('1: getRoutingSuggestion() is async and returns a result with source field', async () => {
    const result = await sona.getRoutingSuggestion('implement a login page');
    expect(result).toBeDefined();
    expect(typeof result.source).toBe('string');
  });

  it('2: source field is one of the allowed values', async () => {
    const allowed = ['sona-native', 'sona-pattern', 'q-learning', 'sona-keyword', 'default'];
    const result = await sona.getRoutingSuggestion('write unit tests for the api');
    expect(allowed).toContain(result.source);
  });

  it('3: keyword routing maps "implement authentication" to coder or security-architect', async () => {
    const result = await sona.getRoutingSuggestion('implement authentication');
    // "implement" is a coder keyword, "authentication" is security-architect
    expect(['coder', 'security-architect']).toContain(result.agent);
    expect(result.source).toMatch(/sona-keyword|default/);
  });

  it('4: loadSonaEngine() gracefully handles missing @ruvector/sona', async () => {
    // With no @ruvector/sona installed, should still return a result via keyword/default
    const result = await sona.getRoutingSuggestion('design a database schema');
    expect(['sona-keyword', 'default', 'sona-pattern']).toContain(result.source);
    expect(result.agent).toBeDefined();
  });

  it('5: return type has agentType-equivalent, confidence, source, reasoning-equivalent fields', async () => {
    const result = await sona.getRoutingSuggestion('optimize performance of the cache layer');
    // RoutingSuggestion uses `agent` (not `agentType`) and `alternatives` (not `reasoning`)
    expect(typeof result.agent).toBe('string');
    expect(typeof result.confidence).toBe('number');
    expect(typeof result.source).toBe('string');
    expect(Array.isArray(result.alternatives)).toBe(true);
    expect(typeof result.usedQLearning).toBe('boolean');
  });
});

// ---------- Embeddings Transparency ----------
describe('Embeddings Transparency (vector-db)', () => {
  it('6: generateHashEmbedding via generateEmbedding returns Float32Array of length 384', () => {
    // generateEmbedding defaults to 768, but we request 384
    const emb = generateEmbedding('hello world', 384);
    expect(emb).toBeInstanceOf(Float32Array);
    expect(emb.length).toBe(384);
  });

  it('7: hash embedding is deterministic (same input -> same output)', () => {
    const a = generateEmbedding('deterministic test input', 384);
    const b = generateEmbedding('deterministic test input', 384);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('8: hash embedding has _warning property (non-enumerable) on fallback', () => {
    const emb = generateEmbedding('test transparency', 384);
    // _warning is defined as non-enumerable
    const descriptor = Object.getOwnPropertyDescriptor(emb, '_warning');
    expect(descriptor).toBeDefined();
    expect(descriptor!.enumerable).toBe(false);
    expect(typeof descriptor!.value).toBe('string');
    expect(descriptor!.value).toContain('hash-based');
  });
});

// ---------- Neural Tools ----------
describe('Neural Tools (neural-tools)', () => {
  it('9: generateEmbedding function exists in neural-tools and is callable', async () => {
    // neural-tools has a module-scoped generateEmbedding; we test it indirectly
    // by importing the neuralTools array and calling the neural_predict handler
    const { neuralTools } = await import('../src/mcp-tools/neural-tools.js');
    const predictTool = neuralTools.find(t => t.name === 'neural_predict');
    expect(predictTool).toBeDefined();
    // Call it — should succeed without real embeddings
    const result = await predictTool!.handler({ input: 'test embedding generation' });
    expect(result).toHaveProperty('embeddingDims', 384);
  });

  it('10: embeddingServiceName reflects active provider (real or hash-fallback)', async () => {
    const { neuralTools } = await import('../src/mcp-tools/neural-tools.js');
    const statusTool = neuralTools.find(t => t.name === 'neural_status');
    expect(statusTool).toBeDefined();
    const result = await statusTool!.handler({});
    const provider = (result as any).embeddingProvider as string;
    // Must be a non-empty string indicating which embedding backend is active
    expect(typeof provider).toBe('string');
    expect(provider.length).toBeGreaterThan(0);
    // Must match one of the known provider tiers or fallback
    // Every backend neural-tools can actually report. The three added here
    // (ruvector, wasm-embedder, @claude-flow/embeddings) are real provider
    // strings the allowlist predated — see neural-tools.ts:115/141/1073.
    const knownProviders =
      /agentic-flow|onnx|mock|hash|fallback|reasoningbank|none|ruvector|wasm-embedder|@claude-flow\/embeddings/i;
    expect(provider).toMatch(knownProviders);
  });
});
