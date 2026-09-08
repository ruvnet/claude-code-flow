/**
 * Phase 4 — MemoryConsolidator (ADR-125)
 *
 * Verifies:
 * - `sweepExpired()` after 1000 entries with `expiresAt` in the past →
 *   `entries.size === 0` AND `hnsw.size === 0` (Acceptance Criterion #4).
 * - `dedup('keep-newest')` collapses content-hash duplicates and keeps the
 *   newest by `updatedAt`.
 * - `dedup('keep-oldest')` keeps the oldest by `createdAt`.
 * - `dedup('merge-tags')` unions tags and keeps the newest.
 * - `compactHnsw` rebuilds the index so size matches `entries.size`.
 * - Auto-run timer with a small interval calls `runAll()` at least once.
 * - `nightlyLearner` controller delegates to `MemoryConsolidator.runAll()`
 *   when a `MemoryService` is registered.
 */

import { describe, it, expect, vi } from 'vitest';
import { MemoryService } from './index.js';
import { MemoryConsolidator } from './consolidator.js';
import { HNSWIndex } from './hnsw-index.js';
import { ControllerRegistry } from './controller-registry.js';
import { createDefaultEntry } from './types.js';

function randomVec(dim: number, seed: number): Float32Array {
  const out = new Float32Array(dim);
  let s = seed | 0 || 1;
  for (let i = 0; i < dim; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = ((s | 0) / 2 ** 31);
  }
  return out;
}

async function newService(opts: Partial<ConstructorParameters<typeof MemoryService>[0]> = {}) {
  const svc = new MemoryService({
    dimensions: 8,
    persistenceEnabled: false,
    snapshotInterval: 0,
    ...opts,
  } as any);
  await svc.initialize();
  return svc;
}

describe('Phase 4 — MemoryConsolidator.sweepExpired', () => {
  it('Acceptance Criterion #4 — 1000 expired entries → 0 remaining + HNSW emptied', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);

    const past = Date.now() - 1;
    for (let i = 0; i < 1000; i++) {
      const entry = createDefaultEntry({
        key: `expired-${i}`,
        content: `content-${i}`,
        expiresAt: past,
      });
      entry.embedding = randomVec(8, i + 1);
      await svc.store(entry);
    }

    const adapter: any = svc.getAdapter();
    expect(adapter.entries.size).toBe(1000);
    expect(adapter.index.size).toBe(1000);

    const result = await consolidator.sweepExpired();

    expect(result.removed).toBe(1000);
    expect(result.remaining).toBe(0);
    expect(result.hnswRemoved).toBe(1000);
    expect(adapter.entries.size).toBe(0);
    expect(adapter.index.size).toBe(0);

    await svc.close();
  });

  it('leaves non-expired entries untouched', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);

    // 5 expired + 5 fresh
    for (let i = 0; i < 5; i++) {
      const entry = createDefaultEntry({
        key: `e-${i}`,
        content: `e-${i}`,
        expiresAt: Date.now() - 1,
      });
      entry.embedding = randomVec(8, i + 1);
      await svc.store(entry);
    }
    for (let i = 0; i < 5; i++) {
      const entry = createDefaultEntry({ key: `f-${i}`, content: `f-${i}` });
      entry.embedding = randomVec(8, i + 100);
      await svc.store(entry);
    }

    const result = await consolidator.sweepExpired();
    expect(result.removed).toBe(5);
    expect(result.remaining).toBe(5);
    await svc.close();
  });
});

describe('Phase 4 — MemoryConsolidator.dedup', () => {
  it('keep-newest: drops 10 duplicates and keeps newest by updatedAt', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);

    // 40 unique + 10 dupes of the same content as entry 0
    const dupContent = 'duplicate-marker';
    const newestTimestamps: number[] = [];
    for (let i = 0; i < 40; i++) {
      const entry = createDefaultEntry({ key: `u-${i}`, content: `unique-${i}` });
      entry.embedding = randomVec(8, i + 1);
      await svc.store(entry);
    }
    // The first dup has the OLDEST updatedAt; the last dup has the NEWEST.
    for (let i = 0; i < 10; i++) {
      const entry = createDefaultEntry({ key: `dup-${i}`, content: dupContent });
      entry.embedding = randomVec(8, i + 500);
      entry.updatedAt = 1_000_000_000 + i; // monotonic, last is newest
      await svc.store(entry);
      newestTimestamps.push(entry.updatedAt);
    }

    const result = await consolidator.dedup('keep-newest');
    expect(result.merged).toBe(9);
    expect(result.groups).toBe(1);

    // Survivor's updatedAt should equal the max of the dup timestamps
    const adapter: any = svc.getAdapter();
    const survivors = [...adapter.entries.values()].filter(
      (e: any) => e.content === dupContent
    );
    expect(survivors.length).toBe(1);
    expect(survivors[0].updatedAt).toBe(Math.max(...newestTimestamps));

    await svc.close();
  });

  it('keep-oldest: keeps the entry with the lowest createdAt', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const entry = createDefaultEntry({ key: `o-${i}`, content: 'same' });
      entry.embedding = randomVec(8, i + 1);
      entry.createdAt = 1000 + i; // i=0 is oldest
      await svc.store(entry);
      ids.push(entry.id);
    }

    const result = await consolidator.dedup('keep-oldest');
    expect(result.merged).toBe(2);

    const adapter: any = svc.getAdapter();
    expect(adapter.entries.size).toBe(1);
    expect(adapter.entries.has(ids[0])).toBe(true);
    await svc.close();
  });

  it('merge-tags: unions tag sets across the duplicates and keeps newest', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);

    for (let i = 0; i < 3; i++) {
      const entry = createDefaultEntry({
        key: `t-${i}`,
        content: 'same',
        tags: [`tag-${i}`, 'common'],
      });
      entry.embedding = randomVec(8, i + 1);
      entry.updatedAt = 1000 + i;
      await svc.store(entry);
    }

    const result = await consolidator.dedup('merge-tags');
    expect(result.merged).toBe(2);

    const adapter: any = svc.getAdapter();
    const survivors = [...adapter.entries.values()];
    expect(survivors.length).toBe(1);
    const survivor: any = survivors[0];
    expect(new Set(survivor.tags)).toEqual(new Set(['tag-0', 'tag-1', 'tag-2', 'common']));

    await svc.close();
  });
});

describe('Phase 4.1 — MemoryConsolidator.dedup embedding near-duplicates', () => {
  it('merges different-content entries whose embeddings are near-identical (cosine >= threshold)', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);

    const base = randomVec(8, 42);

    const a = createDefaultEntry({ key: 'a', content: 'paraphrase-one' });
    a.embedding = base;
    a.updatedAt = 1000;
    await svc.store(a);

    const b = createDefaultEntry({
      key: 'b',
      content: 'paraphrase-two-totally-different-text',
    });
    b.embedding = new Float32Array(base); // identical vector, different content/hash
    b.updatedAt = 2000;
    await svc.store(b);

    const result = await consolidator.dedup('keep-newest');
    expect(result.merged).toBe(1);
    expect(result.groups).toBe(1);

    const adapter: any = svc.getAdapter();
    expect(adapter.entries.size).toBe(1);
    expect(adapter.entries.has(b.id)).toBe(true); // newer of the pair survives

    await svc.close();
  });

  it('does not merge entries whose embeddings fall below the similarity threshold', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);

    const a = createDefaultEntry({ key: 'a', content: 'unrelated-one' });
    a.embedding = randomVec(8, 1);
    await svc.store(a);

    const b = createDefaultEntry({ key: 'b', content: 'unrelated-two' });
    b.embedding = randomVec(8, 999);
    await svc.store(b);

    const result = await consolidator.dedup();
    expect(result.merged).toBe(0);
    expect(result.groups).toBe(0);

    const adapter: any = svc.getAdapter();
    expect(adapter.entries.size).toBe(2);
    await svc.close();
  });

  it('falls back to hash-only behavior for entries with no embedding', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);

    const a = createDefaultEntry({ key: 'a', content: 'no-embedding-a' });
    await svc.store(a);
    const b = createDefaultEntry({ key: 'b', content: 'no-embedding-b' });
    await svc.store(b);

    const result = await consolidator.dedup();
    expect(result.merged).toBe(0);
    expect(result.groups).toBe(0);
    await svc.close();
  });

  it('respects a custom similarityThreshold option', async () => {
    const svc = await newService();
    // A threshold below cosine's minimum (-1) means every pair is "similar".
    const consolidator = new MemoryConsolidator(svc as any, { similarityThreshold: -1 });

    const a = createDefaultEntry({ key: 'a', content: 'threshold-one' });
    a.embedding = randomVec(8, 11);
    await svc.store(a);
    const b = createDefaultEntry({ key: 'b', content: 'threshold-two' });
    b.embedding = randomVec(8, 22);
    await svc.store(b);

    const result = await consolidator.dedup();
    expect(result.merged).toBe(1);
    expect(result.groups).toBe(1);
    await svc.close();
  });

  it('disables the embedding pass entirely when similarityThreshold >= 1', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any, { similarityThreshold: 1 });

    const embedding = randomVec(8, 5);
    const a = createDefaultEntry({ key: 'a', content: 'disabled-one' });
    a.embedding = embedding;
    await svc.store(a);
    const b = createDefaultEntry({ key: 'b', content: 'disabled-two' });
    b.embedding = new Float32Array(embedding); // identical vector, still not merged
    await svc.store(b);

    const result = await consolidator.dedup();
    expect(result.merged).toBe(0);
    expect(result.groups).toBe(0);
    await svc.close();
  });

  it('fully converges a near-duplicate cluster larger than the search neighborhood in one call', async () => {
    // Adversarial-critique regression: a cluster wider than
    // NEAR_DUP_SEARCH_K must still collapse to a single survivor from one
    // dedup() call, not split into multiple leftover sub-group survivors.
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);

    const base = randomVec(8, 12345);
    const n = 15; // > NEAR_DUP_SEARCH_K (8)
    for (let i = 0; i < n; i++) {
      const entry = createDefaultEntry({ key: `cluster-${i}`, content: `unique-content-${i}` });
      entry.embedding = new Float32Array(base); // pairwise cosine similarity 1.0
      entry.updatedAt = 1000 + i;
      await svc.store(entry);
    }

    const result = await consolidator.dedup('keep-newest');
    expect(result.merged).toBe(n - 1);

    const adapter: any = svc.getAdapter();
    expect(adapter.entries.size).toBe(1);
    // The single survivor should be the newest of the cluster.
    const survivor: any = [...adapter.entries.values()][0];
    expect(survivor.updatedAt).toBe(1000 + n - 1);

    await svc.close();
  });

  it('skips the near-duplicate pass entirely for a non-cosine-metric index', async () => {
    const index = new HNSWIndex({ dimensions: 8, metric: 'euclidean' });
    const embedding = randomVec(8, 7);

    const a = createDefaultEntry({ key: 'a', content: 'euclid-one' });
    a.embedding = embedding;
    const b = createDefaultEntry({ key: 'b', content: 'euclid-two' });
    b.embedding = new Float32Array(embedding); // identical vector, different content

    await index.addPoint(a.id, a.embedding);
    await index.addPoint(b.id, b.embedding);

    const entries = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    const namespaceIndex = new Map<string, Set<string>>([
      [a.namespace, new Set([a.id, b.id])],
    ]);
    const keyIndex = new Map<string, string>([
      [`${a.namespace}:${a.key}`, a.id],
      [`${b.namespace}:${b.key}`, b.id],
    ]);
    const tagIndex = new Map<string, Set<string>>();

    const fakeService = {
      getAdapter: () => ({ entries, namespaceIndex, keyIndex, tagIndex, index }),
    };
    const consolidator = new MemoryConsolidator(fakeService as any);

    const result = await consolidator.dedup();
    expect(result.merged).toBe(0);
    expect(result.groups).toBe(0);
    expect(entries.size).toBe(2);
  });
});

describe('Phase 4 — MemoryConsolidator.compactHnsw', () => {
  it('rebuilds the HNSW index so size matches entries.size after sweep', async () => {
    const svc = await newService();
    const consolidator = new MemoryConsolidator(svc as any);

    // Insert + expire half
    const half = 20;
    for (let i = 0; i < half * 2; i++) {
      const entry = createDefaultEntry({
        key: `c-${i}`,
        content: `c-${i}`,
        expiresAt: i < half ? Date.now() - 1 : undefined,
      });
      entry.embedding = randomVec(8, i + 1);
      await svc.store(entry);
    }

    await consolidator.sweepExpired();
    const result = await consolidator.compactHnsw();
    expect(result.before).toBeGreaterThanOrEqual(half);
    expect(result.after).toBe(half);

    const adapter: any = svc.getAdapter();
    expect(adapter.index.size).toBe(adapter.entries.size);

    await svc.close();
  });
});

describe('Phase 4 — MemoryService auto-run timer', () => {
  it('invokes consolidator.runAll() at the configured interval', async () => {
    const svc = new MemoryService({
      dimensions: 8,
      persistenceEnabled: false,
      snapshotInterval: 0,
      consolidator: { autoRun: true, intervalMs: 50 },
    });
    await svc.initialize();

    // Spy on the lazily-loaded consolidator. getConsolidator() returns a
    // singleton, so swap its runAll for a spy after first construction.
    const consolidator = await svc.getConsolidator();
    const spy = vi.spyOn(consolidator, 'runAll');

    // Wait long enough for at least one tick.
    await new Promise((r) => setTimeout(r, 180));

    expect(spy).toHaveBeenCalled();
    await svc.close();
  });

  it('close() clears the consolidator timer', async () => {
    const svc = new MemoryService({
      dimensions: 8,
      persistenceEnabled: false,
      snapshotInterval: 0,
      consolidator: { autoRun: true, intervalMs: 50 },
    });
    await svc.initialize();
    const consolidator = await svc.getConsolidator();
    const spy = vi.spyOn(consolidator, 'runAll');

    await svc.close();
    await new Promise((r) => setTimeout(r, 150));

    // No new calls after close()
    const callCountAtClose = spy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(spy.mock.calls.length).toBe(callCountAtClose);
  });
});

describe('Phase 4 — nightlyLearner controller delegates to MemoryConsolidator', () => {
  it('returns a wrapper bound to consolidator.runAll when memoryService is registered', async () => {
    const svc = await newService();
    const registry = new ControllerRegistry();
    await registry.initialize({ memoryService: svc });

    const inst = registry.get<any>('nightlyLearner');
    expect(inst).toBeTruthy();
    expect(inst.source).toBe('memory-consolidator');
    expect(typeof inst.runAll).toBe('function');

    const result = await inst.runAll();
    expect(result).toHaveProperty('sweep');
    expect(result).toHaveProperty('dedup');
    expect(result).toHaveProperty('compact');

    await registry.shutdown();
    await svc.close();
  });
});
