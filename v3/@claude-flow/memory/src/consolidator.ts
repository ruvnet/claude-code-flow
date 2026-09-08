/**
 * MemoryConsolidator — ADR-125 Phase 4
 *
 * Periodic maintenance for the in-memory state owned by {@link UnifiedMemoryService}.
 *
 * Operations:
 * - `sweepExpired()` — drop entries past `expiresAt` from all indexes (including HNSW).
 * - `dedup(strategy)` — collapse content-hash duplicates per strategy.
 * - `compactHnsw()` — rebuild the HNSW index from current `entries`.
 * - `runAll()` — sweep → dedup → compact in order.
 *
 * Invoked from two paths:
 * 1. {@link UnifiedMemoryService}'s lifecycle (background timer when
 *    `consolidator.autoRun === true`, plus `close()`).
 * 2. The AgentDB `nightlyLearner` controller (`src/controller-registry.ts`)
 *    delegates to `runAll()` instead of hitting AgentDB directly.
 *
 * Phase 3 placeholder lives in this file too — it provides the typed
 * surface that {@link UnifiedMemoryService.getConsolidator} resolves to.
 * The real implementation lands with Phase 4.
 *
 * @module v3/memory/consolidator
 */

import { createHash } from 'node:crypto';
import { HNSWIndex } from './hnsw-index.js';
import type { MemoryEntry } from './types.js';

/**
 * Strategy for resolving content-hash duplicates inside {@link MemoryConsolidator.dedup}.
 */
export type DedupStrategy = 'keep-newest' | 'keep-oldest' | 'merge-tags';

export interface ConsolidatorOptions {
  /** Default strategy when `dedup()` is invoked with no argument. */
  dedupStrategy?: DedupStrategy;
  /** Used by `MemoryService` when scheduling automatic runs (ms). */
  intervalMs?: number;
  /**
   * Cosine-similarity floor (0-1) above which two entries with embeddings
   * are treated as near-duplicates by `dedup()`'s embedding pass, in
   * addition to its byte-exact content-hash pass. Set to `1` (or above) to
   * disable the embedding pass entirely and keep pre-Phase-4.1 hash-only
   * behavior. Default 0.95 — conservative, matches the threshold already
   * used by the (unwired) domain-layer consolidator for the same purpose.
   */
  similarityThreshold?: number;
}

const DEFAULT_SIMILARITY_THRESHOLD = 0.95;
/** Neighborhood size for the near-duplicate HNSW lookup — small and cheap. */
const NEAR_DUP_SEARCH_K = 8;

export interface SweepResult {
  removed: number;
  remaining: number;
  hnswRemoved: number;
}

export interface DedupResult {
  merged: number;
  groups: number;
}

export interface CompactResult {
  before: number;
  after: number;
  durationMs: number;
}

export interface ConsolidationResult {
  sweep: SweepResult;
  dedup: DedupResult;
  compact: CompactResult;
  totalDurationMs: number;
}

/**
 * Minimal surface the consolidator needs from `UnifiedMemoryService`. Avoids
 * a circular type import.
 */
interface ServiceLike {
  getAdapter(): {
    // Internals we mutate. Cast-safe at runtime.
    entries: Map<string, MemoryEntry>;
    namespaceIndex: Map<string, Set<string>>;
    keyIndex: Map<string, string>;
    tagIndex: Map<string, Set<string>>;
    // Public HNSW accessor exists on AgentDBAdapter; cast through.
    [key: string]: any;
  };
}

export class MemoryConsolidator {
  constructor(
    private readonly service: ServiceLike,
    private readonly opts: ConsolidatorOptions = {}
  ) {}

  /**
   * Drop all entries whose `expiresAt` is in the past.
   */
  async sweepExpired(): Promise<SweepResult> {
    const adapter = this.service.getAdapter() as any;
    const entries: Map<string, MemoryEntry> = adapter.entries;
    const namespaceIndex: Map<string, Set<string>> = adapter.namespaceIndex;
    const keyIndex: Map<string, string> = adapter.keyIndex;
    const tagIndex: Map<string, Set<string>> = adapter.tagIndex;
    const index: HNSWIndex = adapter.index;

    const now = Date.now();
    const toRemove: MemoryEntry[] = [];
    for (const entry of entries.values()) {
      if (entry.expiresAt != null && entry.expiresAt < now) {
        toRemove.push(entry);
      }
    }

    let hnswRemoved = 0;
    for (const entry of toRemove) {
      entries.delete(entry.id);
      namespaceIndex.get(entry.namespace)?.delete(entry.id);
      keyIndex.delete(`${entry.namespace}:${entry.key}`);
      for (const tag of entry.tags) tagIndex.get(tag)?.delete(entry.id);
      if (entry.embedding) {
        const removed = await index.removePoint(entry.id);
        if (removed) hnswRemoved += 1;
      }
    }

    // Clean up empty namespace/tag sets to keep memory bounded
    for (const [ns, ids] of namespaceIndex) {
      if (ids.size === 0) namespaceIndex.delete(ns);
    }
    for (const [tag, ids] of tagIndex) {
      if (ids.size === 0) tagIndex.delete(tag);
    }

    return {
      removed: toRemove.length,
      remaining: entries.size,
      hnswRemoved,
    };
  }

  /**
   * Pick the keeper for a duplicate group per `strategy` and, for
   * `merge-tags`, union the group's tag sets onto it. Shared by both the
   * content-hash pass and the embedding near-duplicate pass in `dedup()`.
   */
  private selectKeeper(bucket: MemoryEntry[], strategy: DedupStrategy): MemoryEntry {
    const keeper =
      strategy === 'keep-oldest'
        ? bucket.reduce((acc, e) => (e.createdAt < acc.createdAt ? e : acc))
        : // keep-newest + merge-tags share this branch
          bucket.reduce((acc, e) => (e.updatedAt > acc.updatedAt ? e : acc));
    return keeper;
  }

  /**
   * Drop every entry in `bucket` except the strategy-selected keeper,
   * updating all adapter indexes (and the HNSW index, for entries that have
   * an embedding) to match. Shared by both dedup passes.
   */
  private async mergeGroup(
    bucket: MemoryEntry[],
    strategy: DedupStrategy,
    ctx: {
      entries: Map<string, MemoryEntry>;
      namespaceIndex: Map<string, Set<string>>;
      keyIndex: Map<string, string>;
      tagIndex: Map<string, Set<string>>;
      index: HNSWIndex;
    }
  ): Promise<{ keeperId: string; dropped: number }> {
    const keeper = this.selectKeeper(bucket, strategy);

    if (strategy === 'merge-tags') {
      const tagSet = new Set<string>(keeper.tags);
      for (const e of bucket) for (const t of e.tags) tagSet.add(t);
      const oldTags = keeper.tags;
      keeper.tags = [...tagSet];
      // Update tagIndex membership for newly-added tags
      for (const t of keeper.tags) {
        if (!oldTags.includes(t)) {
          if (!ctx.tagIndex.has(t)) ctx.tagIndex.set(t, new Set());
          ctx.tagIndex.get(t)!.add(keeper.id);
        }
      }
    }

    let dropped = 0;
    for (const e of bucket) {
      if (e.id === keeper.id) continue;
      ctx.entries.delete(e.id);
      ctx.namespaceIndex.get(e.namespace)?.delete(e.id);
      const compositeKey = `${e.namespace}:${e.key}`;
      if (ctx.keyIndex.get(compositeKey) === e.id) {
        ctx.keyIndex.delete(compositeKey);
      }
      for (const tag of e.tags) ctx.tagIndex.get(tag)?.delete(e.id);
      if (e.embedding) {
        await ctx.index.removePoint(e.id);
      }
      dropped += 1;
    }
    return { keeperId: keeper.id, dropped };
  }

  /**
   * Collapse duplicates across all namespaces per `strategy`, in two passes:
   *
   * 1. Byte-exact content-hash buckets (unchanged from pre-4.1 behavior).
   * 2. Embedding near-duplicates: for entries that survive pass 1 and carry
   *    an `embedding`, query the already-populated `HNSWIndex` (the same
   *    index instance this method already holds a handle to for removal
   *    bookkeeping) for cosine-similarity neighbors above
   *    `opts.similarityThreshold` (default 0.95). This catches paraphrases
   *    and reformattings that byte-exact hashing structurally cannot, at no
   *    extra backend round-trip cost — the embedding and the index are both
   *    already resident in memory at this call site.
   *
   * Pass 2 only runs when the index's configured metric is `'cosine'` (its
   * distances are `1 - similarity`) and the threshold is `< 1`; otherwise
   * behavior is identical to hash-only dedup.
   *
   * - `keep-newest`: keep the entry with the highest `updatedAt`, drop the rest.
   * - `keep-oldest`: keep the entry with the lowest `createdAt`, drop the rest.
   * - `merge-tags`: keep newest, but union the tag sets of the duplicates first.
   */
  async dedup(strategy?: DedupStrategy): Promise<DedupResult> {
    const adapter = this.service.getAdapter() as any;
    const entries: Map<string, MemoryEntry> = adapter.entries;
    const namespaceIndex: Map<string, Set<string>> = adapter.namespaceIndex;
    const keyIndex: Map<string, string> = adapter.keyIndex;
    const tagIndex: Map<string, Set<string>> = adapter.tagIndex;
    const index: HNSWIndex = adapter.index;
    const ctx = { entries, namespaceIndex, keyIndex, tagIndex, index };

    const effective = strategy ?? this.opts.dedupStrategy ?? 'keep-newest';

    // Pass 1: bucket by content hash (byte-exact duplicates)
    const buckets = new Map<string, MemoryEntry[]>();
    for (const entry of entries.values()) {
      const hash = createHash('sha256').update(entry.content).digest('hex');
      const bucket = buckets.get(hash);
      if (bucket) bucket.push(entry);
      else buckets.set(hash, [entry]);
    }

    let merged = 0;
    let dupGroups = 0;
    for (const bucket of buckets.values()) {
      if (bucket.length <= 1) continue;
      dupGroups += 1;
      const { dropped } = await this.mergeGroup(bucket, effective, ctx);
      merged += dropped;
    }

    // Pass 2: embedding near-duplicates among pass-1 survivors.
    //
    // Each round only groups an entry with what its single
    // `NEAR_DUP_SEARCH_K`-wide HNSW query returns, so a duplicate cluster
    // larger than that window can split into more than one surviving
    // sub-group in a single round (each sub-group's keeper remains
    // un-merged with the others). Looping to a fixed point — re-scanning
    // until a full round produces zero merges — guarantees a single
    // `dedup()` call fully converges regardless of cluster size, at the
    // cost of one extra full round whenever a cluster does split (bounded:
    // strictly fewer entries remain each round that merges anything, so
    // this always terminates). `groups` therefore counts merge operations
    // across all rounds, which can exceed the number of ultimate
    // underlying duplicate clusters when one of them needed more than one
    // round to fully collapse.
    const threshold = this.opts.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    if (index.getConfig().metric === 'cosine' && threshold < 1) {
      let roundMerged: number;
      do {
        roundMerged = 0;
        const consumed = new Set<string>();
        // Snapshot survivors up front — mutated further as groups merge.
        for (const entry of [...entries.values()]) {
          if (consumed.has(entry.id) || !entry.embedding || !entries.has(entry.id)) {
            continue;
          }

          const hits = await index.search(entry.embedding, NEAR_DUP_SEARCH_K);
          const group: MemoryEntry[] = [entry];
          for (const hit of hits) {
            if (hit.id === entry.id || consumed.has(hit.id)) continue;
            const candidate = entries.get(hit.id);
            if (!candidate || !candidate.embedding) continue;
            const similarity = 1 - hit.distance;
            if (similarity >= threshold) group.push(candidate);
          }

          if (group.length <= 1) {
            consumed.add(entry.id);
            continue;
          }

          dupGroups += 1;
          const { dropped } = await this.mergeGroup(group, effective, ctx);
          merged += dropped;
          roundMerged += dropped;
          for (const e of group) consumed.add(e.id);
        }
      } while (roundMerged > 0);
    }

    return { merged, groups: dupGroups };
  }

  /**
   * Rebuild the HNSW index from the current set of entries with embeddings.
   * Returns a count snapshot + duration.
   */
  async compactHnsw(): Promise<CompactResult> {
    const adapter = this.service.getAdapter() as any;
    const entries: Map<string, MemoryEntry> = adapter.entries;
    const index: HNSWIndex = adapter.index;

    const before = index.size;
    const t0 = Date.now();

    // Build a fresh HNSW from current entries that have embeddings.
    const cfg = index.getConfig();
    const fresh = new HNSWIndex({
      dimensions: cfg.dimensions,
      M: cfg.M,
      efConstruction: cfg.efConstruction,
      maxElements: cfg.maxElements,
      metric: cfg.metric,
    });

    for (const entry of entries.values()) {
      if (entry.embedding) {
        try {
          await fresh.addPoint(entry.id, entry.embedding);
        } catch {
          // Tolerate dimension mismatches in malformed datasets.
        }
      }
    }

    // Swap pointers atomically and re-forward events
    adapter.index = fresh;
    if (typeof adapter.emit === 'function') {
      fresh.on('point:added', (data: any) => adapter.emit('index:added', data));
    }

    const durationMs = Date.now() - t0;
    return { before, after: fresh.size, durationMs };
  }

  /**
   * Sweep → dedup → compact. Used by the background timer and by the
   * `nightlyLearner` AgentDB controller.
   */
  async runAll(): Promise<ConsolidationResult> {
    const start = Date.now();
    const sweep = await this.sweepExpired();
    const dedup = await this.dedup();
    const compact = await this.compactHnsw();
    return {
      sweep,
      dedup,
      compact,
      totalDurationMs: Date.now() - start,
    };
  }
}

export default MemoryConsolidator;
