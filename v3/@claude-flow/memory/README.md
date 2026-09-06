# @claude-flow/memory

[![npm version](https://img.shields.io/npm/v/@claude-flow/memory.svg)](https://www.npmjs.com/package/@claude-flow/memory)
[![Ecosystem downloads](https://img.shields.io/badge/ecosystem%20downloads-22.2M%2B-blue.svg)](https://github.com/ruvnet/ruflo/blob/main/data/clone-data.proof.json)
[![Git clones (14d)](https://img.shields.io/badge/git%20clones%2014d-115k-blueviolet.svg)](https://github.com/ruvnet/ruflo/blob/main/data/clone-data.ledger.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)
[![HNSW search](https://img.shields.io/badge/HNSW-0.53ms%20%7C%201%2C889%20ops%2Fs-brightgreen.svg)](./benchmarks/results/)

> High-performance memory for Claude Flow V3 — one canonical `MemoryService` API on top of a real hybrid backend (sql.js + AgentDB), persistent HNSW vector search that survives restart, a memory-bound consolidator, graceful keyword (FTS5) fallback when the embedder isn't available, plus the AutoMemoryBridge, self-learning, and knowledge-graph layers that build on top.

## What's new in `3.0.0-alpha.18` (ADR-125)

This release closes out [ADR-125 — Memory Consolidation](../../../v3/docs/adr/ADR-125-memory-consolidation.md). If you're upgrading from `3.0.0-alpha.17` or earlier, this is the headline:

- **One canonical entry point.** `MemoryService` replaces the old `UnifiedMemoryService` name (both still exported — the old one is `@deprecated` and will be removed at `3.0.0-rc`). See [Migration](#migrating-from-30-0-alpha-17-or-earlier) below.
- **A real hybrid default.** `createHybridService(...)` finally returns a service whose backend is an actual `HybridBackend` (sql.js + AgentDB). Earlier releases silently downgraded this to AgentDB-only — ADR-009's promise wasn't delivered until now.
- **Persistent HNSW.** Closing a service snapshots its HNSW index to a sidecar (`<dbPath>.hnsw` + `<dbPath>.meta.json`). Reopening on the same path restores in milliseconds rather than rebuilding from scratch — search-ready cold start.
- **`MemoryConsolidator`.** A background service that evicts expired entries from indexes *and* HNSW, deduplicates by content hash, and rebuilds the HNSW index when it gets fragmented. Auto-runs on a configurable timer (default 6 hours) so memory stays bounded.
- **Graceful retrieval.** `service.search('query')` no longer throws when `@claude-flow/embeddings` is unavailable — it degrades to FTS5 keyword search and emits `health.embedder = 'degraded'`. The full hybrid path also adds real Reciprocal Rank Fusion + MMR diversity rerank.
- **Reproducible benchmarks.** `npm run bench` now actually runs. The HNSW search baseline (single-threaded, 1k × 128-dim cosine vectors on Apple Silicon, Node 22): **0.53 ms / search · 1,889 ops/s · 533 ms to build 1k**. See [`benchmarks/results/baseline-20260519T212453Z.md`](./benchmarks/results/baseline-20260519T212453Z.md).
- **Node 26 install support** ([#1867](https://github.com/ruvnet/ruflo/issues/1867)) — `better-sqlite3` is fully optional; installs succeed on Node 24/26 and the package falls back to sql.js when the native build isn't available.

## Features

- **Canonical `MemoryService` API** — one entry point for store / retrieve / search / hybrid query
- **Real hybrid backend** — `HybridBackend` (sql.js + AgentDB) for structured + vector queries (ADR-009 / ADR-125 Phase 2)
- **Persistent HNSW** — index survives `close()` and restart; auto-snapshots every Nth write (ADR-125 Phase 3)
- **`MemoryConsolidator`** — `sweepExpired()` + `dedup()` + `compactHnsw()` + auto-run timer (ADR-125 Phase 4)
- **Graceful retrieval** — automatic FTS5 keyword fallback when embedder is unreachable; RRF + MMR for hybrid (ADR-125 Phase 5)
- **HNSW vector search** — measured **0.53 ms / search at 1k × 128 dim** on Apple Silicon; see baseline above
- **Auto Memory Bridge** — Bidirectional sync between Claude Code auto memory and AgentDB (ADR-048)
- **Self-Learning** — LearningBridge connects insights to SONA/ReasoningBank neural pipeline (ADR-049)
- **Knowledge Graph** — PageRank + label propagation community detection over memory entries (ADR-049)
- **Agent-Scoped Memory** — 3-scope agent memory (project/local/user) with cross-agent knowledge transfer (ADR-049)
- **Vector Quantization** — Binary, scalar, and product quantization for 4–32x memory reduction
- **Multiple Distance Metrics** — Cosine, Euclidean, dot product, and Manhattan
- **Query Builder** — Fluent API for building complex memory queries
- **Cache Manager** — LRU caching with configurable size and TTL
- **Migration Tools** — `MemoryMigrator` for moving from V2 memory systems
- **Cross-platform** — Works on Linux, macOS, and Windows; Node 18+ (including Node 24/26)

## Installation

```bash
npm install @claude-flow/memory
```

## Standalone use (without the Ruflo CLI)

This package works on its own — you don't need `@claude-flow/cli` or the
full Ruflo install. Use it any time you want HNSW vector search, an
AgentDB façade, or the v3 controller registry from your own app.

Two recipes that exercise the most-installed surface:

### Recipe 1 — HNSW index with built-in quantization (no other deps)

```typescript
// recipe.mjs
import { HNSWIndex } from '@claude-flow/memory';

const index = new HNSWIndex({
  dimensions: 8,
  M: 16,
  efConstruction: 200,
  metric: 'cosine',
});

// Add a few vectors
await index.addPoint('doc-a', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]));
await index.addPoint('doc-b', new Float32Array([0.9, 0.1, 0, 0, 0, 0, 0, 0]));
await index.addPoint('doc-c', new Float32Array([0, 1, 0, 0, 0, 0, 0, 0]));

// Search — top 2 nearest to "doc-a"-shaped query
const hits = await index.search(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]), 2);
console.log(hits); // [{ id: 'doc-a', distance: 0 }, { id: 'doc-b', distance: ~0.005 }]
```

### Recipe 2 — Drive the controller registry against your own AgentDB

The registry coordinates 15+ memory controllers (learning bridge, memory
graph, tiered cache, vector backend, etc.) on top of an AgentDB instance
you own. Useful when you already have an AgentDB lifecycle and just
want the v3 governance layer (issue #2019 added the `agentdb` injection
field that makes this clean).

```typescript
import { ControllerRegistry } from '@claude-flow/memory';
import { AgentDB } from 'agentdb';

const agentdb = new AgentDB({ dbPath: ':memory:' });
await agentdb.initialize();

const registry = new ControllerRegistry();
await registry.initialize({ agentdb });

// Now everything backed by AgentDB is reachable through the registry
const reflexion = registry.get('reflexion');     // ReflexionMemory
const vectorBackend = registry.get('vectorBackend'); // live vector backend
const enabled = registry.isEnabled('skills');    // true

const health = await registry.healthCheck();
console.log(`${health.activeControllers}/${health.controllers.length} controllers active`);

await registry.shutdown();
```

## Quick Start

The fastest way to get a full-featured memory service — hybrid backend, HNSW vector index, FTS5 keyword fallback, persistent snapshots, consolidation timer — is `createHybridService`:

```typescript
import { createHybridService } from '@claude-flow/memory';

async function embedder(text: string): Promise<Float32Array> {
  // Use any embedding provider — OpenAI, @claude-flow/embeddings, your own model.
  // If the embedder ever fails, MemoryService falls back to FTS5 keyword search
  // automatically (emitting `health.embedder = 'degraded'`).
  return new Float32Array(/* ... */);
}

const memory = await createHybridService('./data/memory.db', embedder, 1536);
await memory.initialize();

// Store an entry — content is embedded and added to both SQLite and HNSW
await memory.store({
  key: 'auth-patterns',
  content: 'OAuth 2.0 implementation patterns for secure authentication',
  tags: ['auth', 'security', 'patterns'],
});

// Semantic search via HNSW
const similar = await memory.semanticSearch('user authentication best practices', 5);

// Keyword search via FTS5 (also used as the automatic fallback)
const exact = await memory.searchKeyword('OAuth 2.0', { limit: 10 });

// Hybrid search — RRF-fused dense + sparse, MMR-diversified
const blended = await memory.search('authentication patterns', { limit: 10 });

// Clean shutdown — flushes the consolidator timer and snapshots HNSW to disk
await memory.close();

// Reopen the same path — entries AND HNSW index are restored from sidecar
const reopened = await createHybridService('./data/memory.db', embedder, 1536);
await reopened.initialize();
// memory.search() is immediately fast — no rebuild
```

You can also use the lower-level primitives directly. `HNSWIndex` is exported and works without any of the service layer if you just want a vector index:

```typescript
import { HNSWIndex } from '@claude-flow/memory';

const index = new HNSWIndex({
  dimensions: 1536,  // OpenAI embedding size
  M: 16,             // Max connections per node
  efConstruction: 200,
  metric: 'cosine',
});

await index.addPoint('memory-1', new Float32Array(embedding));
await index.addPoint('memory-2', new Float32Array(embedding2));

const results = await index.search(queryVector, 10);
// [{ id: 'memory-1', distance: 0.05 }, { id: 'memory-2', distance: 0.12 }]

// New in 3.0.0-alpha.18: persist the index to a buffer for restore later
const snapshot: Buffer = index.serialize();
const restored = HNSWIndex.deserialize(snapshot);
```

## Migrating from `3.0.0-alpha.17` or earlier

If you're already using this package:

```typescript
// Before
import { UnifiedMemoryService } from '@claude-flow/memory';
const memory = new UnifiedMemoryService({ /* ... */ });

// After (recommended) — both names resolve to the same class
import { MemoryService } from '@claude-flow/memory';
const memory = new MemoryService({ /* ... */ });

// `UnifiedMemoryService` continues to work through 3.0.0-rc as a `@deprecated` alias.
```

Two other things changed in `3.0.0-alpha.18`:

1. **`createHybridService` now does what its name says.** If you were relying on the old AgentDB-only downgrade, you'll get a real `HybridBackend` now — semantic search and structured queries both work without extra wiring.
2. **`semanticSearch` no longer throws when the embedder is absent.** Code that relied on a thrown error to detect a misconfigured embedder should listen for `health.embedder = 'degraded'` events instead. See [Graceful retrieval](#graceful-retrieval-fts5-fallback) below.

The `HnswLite` and `RvfBackend` classes are no longer top-level exports (they were internal implementation details). If your code imported them, switch to `HNSWIndex` (more capable, persistent) — they're verified to have zero external importers.

## Persistence

In `3.0.0-alpha.18` the HNSW index survives `close()` and restart. Snapshots happen automatically:

- On `service.close()`, the index is serialized to `<dbPath>.hnsw` and the in-memory entry/namespace/key/tag maps go to `<dbPath>.meta.json`.
- During the lifetime of the service, the index also auto-snapshots every Nth `store()` call (default `N=1000`, configurable via `MemoryServiceConfig.snapshotInterval`).
- On initialize, if both sidecars exist, they're restored. The service emits one of three `health.persistence` events: `'restored'` (success), `'fresh'` (no sidecar found — first run), or `'corrupt'` (deserialize failed — automatic fallback to fresh state).

```typescript
import { MemoryService, HNSWIndex } from '@claude-flow/memory';

const memory = new MemoryService({
  persistenceEnabled: true,
  persistencePath: './data/memory.db',
  snapshotInterval: 500,   // snapshot every 500 stores
  embeddingGenerator,
});

memory.on('health.persistence', (status) => {
  // 'restored' | 'fresh' | 'corrupt'
  console.log('Persistence state:', status);
});

await memory.initialize();
// ...store, query...
await memory.close();   // flushes a final snapshot
```

Manual snapshot/restore on a raw `HNSWIndex`:

```typescript
const buf: Buffer = index.serialize();
// write buf to disk, transfer between processes, etc.

const restored = HNSWIndex.deserialize(buf);
// search works immediately — no rebuild
```

The serialized format is versioned with a magic header (`HNSW\x01`) — a corrupted or stale snapshot is detected and rejected loudly rather than silently producing wrong neighbors.

## Memory consolidation

`MemoryConsolidator` keeps the index bounded. Three operations:

```typescript
import { MemoryConsolidator } from '@claude-flow/memory';

const consolidator = new MemoryConsolidator(memory, {
  dedupStrategy: 'merge-tags',   // 'keep-newest' | 'keep-oldest' | 'merge-tags'
  intervalMs: 6 * 60 * 60 * 1000, // auto-run every 6h
});

// Evict expired entries from all indexes (including HNSW)
const swept = await consolidator.sweepExpired();
// { removed: 142, remaining: 8503 }

// Deduplicate by SHA-256 content hash
const dedup = await consolidator.dedup('keep-newest');
// { merged: 23 }

// Rebuild HNSW to reclaim space after large churn
const compaction = await consolidator.compactHnsw();
// { before: 8503, after: 8503, durationMs: 198 }

// Or run all three in sequence
const result = await consolidator.runAll();
```

You don't have to construct it manually — `MemoryService` will wire it up if you opt in:

```typescript
const memory = new MemoryService({
  consolidator: {
    autoRun: true,                     // start a setInterval that runs runAll()
    intervalMs: 6 * 60 * 60 * 1000,    // every 6h (default)
  },
});

memory.on('consolidation.complete', (result) => {
  console.log(`Swept ${result.swept.removed}, deduped ${result.dedup.merged}`);
});
```

The `nightlyLearner` controller in the AgentDB controller registry now delegates to `MemoryConsolidator.runAll()` instead of the old AgentDB pass-through, so the consolidator is invoked from every layer that expects the "nightly memory hygiene" hook.

## Graceful retrieval (FTS5 fallback)

`MemoryService.search()` and `semanticSearch()` no longer hard-fail when `@claude-flow/embeddings` (or whatever embedder you injected) is unavailable. They:

1. Try the embedder.
2. If it throws or is missing, emit `health.embedder = 'degraded'`.
3. Run the same query through FTS5 keyword search (porter + unicode61 tokenizer) and return those results.

```typescript
const memory = new MemoryService({
  // No embeddingGenerator — semantic queries will fall back to FTS5
});
await memory.initialize();

memory.on('health.embedder', (state) => {
  // 'available' | 'degraded'
  console.warn(`Embedder is ${state}`);
});

await memory.store({ key: 'note-1', content: 'OAuth pattern review' });
const results = await memory.search('OAuth', { limit: 5 });
// Returns FTS-ranked matches; no throw
```

When **both** dense (HNSW) and sparse (FTS5) paths are available, `service.search(query)` runs both, fuses the rankings with Reciprocal Rank Fusion (`k=60`), and reranks with MMR (`λ=0.7`) for diversity. This is what the AgentDB `hybridSearch` controller exposes too — it used to be a stub that returned `null`; in `3.0.0-alpha.18` it's a real implementation.

## API Reference

### HNSW Index

```typescript
import { HNSWIndex } from '@claude-flow/memory';

const index = new HNSWIndex({
  dimensions: 1536,
  M: 16,                    // Max connections per layer
  efConstruction: 200,      // Construction-time search depth
  maxElements: 1000000,     // Max vectors
  metric: 'cosine',         // 'cosine' | 'euclidean' | 'dot' | 'manhattan'
  quantization: {           // Optional quantization
    type: 'scalar',         // 'binary' | 'scalar' | 'product'
    bits: 8
  }
});

// Add vectors
await index.addPoint(id: string, vector: Float32Array);

// Search
const results = await index.search(
  query: Float32Array,
  k: number,
  ef?: number  // Search-time depth (higher = more accurate)
);

// Search with filters
const filtered = await index.searchWithFilters(
  query,
  k,
  (id) => id.startsWith('session-')
);

// Remove vectors
await index.removePoint(id);

// Get statistics
const stats = index.getStats();
// { vectorCount, memoryUsage, avgSearchTime, compressionRatio }
```

### AgentDB Adapter

```typescript
import { AgentDBAdapter } from '@claude-flow/memory';

const adapter = new AgentDBAdapter({
  dimension: 1536,
  indexType: 'hnsw',
  metric: 'cosine',
  hnswM: 16,
  hnswEfConstruction: 200,
  enableCache: true,
  cacheSizeMb: 256
});

await adapter.initialize();

// Store memory
await adapter.store({
  id: 'mem-123',
  content: 'User prefers dark mode',
  embedding: vector,
  metadata: { type: 'preference', agentId: 'agent-1' }
});

// Semantic search
const memories = await adapter.search(queryVector, {
  limit: 10,
  threshold: 0.7,
  filter: { type: 'preference' }
});

// Cross-agent memory sharing
await adapter.enableCrossAgentSharing({
  shareTypes: ['patterns', 'preferences'],
  excludeTypes: ['secrets']
});
```

### Cache Manager

```typescript
import { CacheManager } from '@claude-flow/memory';

const cache = new CacheManager({
  maxSize: 1000,
  ttlMs: 3600000,  // 1 hour
  strategy: 'lru'
});

// Cache operations
cache.set('key', value);
const value = cache.get('key');
const exists = cache.has('key');
cache.delete('key');
cache.clear();

// Statistics
const stats = cache.getStats();
// { size, hits, misses, hitRate }
```

### Query Builder

```typescript
import { QueryBuilder } from '@claude-flow/memory';

const results = await new QueryBuilder()
  .semantic(queryVector)
  .where('agentId', '=', 'agent-1')
  .where('type', 'in', ['pattern', 'strategy'])
  .where('createdAt', '>', Date.now() - 86400000)
  .orderBy('relevance', 'desc')
  .limit(20)
  .execute();
```

### Migration

```typescript
import { MemoryMigrator, createMigrator } from '@claude-flow/memory';

const migrator = createMigrator({
  source: './data/v2-memory.db',
  destination: './data/v3-memory.db',
});

// Inspect what will be migrated
const preview = await migrator.preview();
console.log(`Will migrate ${preview.recordCount} records`);

// Execute migration
await migrator.execute({
  batchSize: 1000,
  onProgress: (progress) => console.log(`${progress.percent}%`),
});
```

## Quantization Options

```typescript
// Binary quantization (32x compression)
const binaryIndex = new HNSWIndex({
  dimensions: 1536,
  quantization: { type: 'binary' }
});

// Scalar quantization (4x compression)
const scalarIndex = new HNSWIndex({
  dimensions: 1536,
  quantization: { type: 'scalar', bits: 8 }
});

// Product quantization (8x compression)
const productIndex = new HNSWIndex({
  dimensions: 1536,
  quantization: { type: 'product', subquantizers: 8 }
});
```

## Auto Memory Bridge (ADR-048)

Bidirectional sync between Claude Code's [auto memory](https://code.claude.com/docs/en/memory) files and AgentDB. Auto memory is a persistent directory (`~/.claude/projects/<project>/memory/`) where Claude writes learnings as markdown. `MEMORY.md` (first 200 lines) is loaded into the system prompt; topic files are read on demand.

### Quick Start

```typescript
import { AutoMemoryBridge } from '@claude-flow/memory';

const bridge = new AutoMemoryBridge(memoryBackend, {
  workingDir: '/workspaces/my-project',
  syncMode: 'on-session-end', // 'on-write' | 'on-session-end' | 'periodic'
  pruneStrategy: 'confidence-weighted', // 'confidence-weighted' | 'fifo' | 'lru'
});

// Record an insight (stores in AgentDB + optionally writes to files)
await bridge.recordInsight({
  category: 'debugging',
  summary: 'HNSW index requires initialization before search',
  source: 'agent:tester',
  confidence: 0.95,
});

// Sync buffered insights to auto memory files
const syncResult = await bridge.syncToAutoMemory();

// Import existing auto memory files into AgentDB (on session start)
const importResult = await bridge.importFromAutoMemory();

// Curate MEMORY.md index (stays under 200-line limit)
await bridge.curateIndex();

// Check status
const status = bridge.getStatus();
```

### Sync Modes

| Mode | Behavior |
|------|----------|
| `on-write` | Writes to files immediately on `recordInsight()` |
| `on-session-end` | Buffers insights, flushes on `syncToAutoMemory()` |
| `periodic` | Auto-syncs on a configurable interval |

### Insight Categories

| Category | Topic File | Description |
|----------|-----------|-------------|
| `project-patterns` | `patterns.md` | Code patterns and conventions |
| `debugging` | `debugging.md` | Bug fixes and debugging insights |
| `architecture` | `architecture.md` | Design decisions and module relationships |
| `performance` | `performance.md` | Benchmarks and optimization results |
| `security` | `security.md` | Security findings and CVE notes |
| `preferences` | `preferences.md` | User and project preferences |
| `swarm-results` | `swarm-results.md` | Multi-agent swarm outcomes |

### Key Optimizations

- **Batch import** - `bulkInsert()` instead of individual `store()` calls
- **Pre-fetched hashes** - Single query for content-hash dedup during import
- **Async I/O** - `node:fs/promises` for non-blocking writes
- **Exact dedup** - `hasSummaryLine()` uses bullet-prefix matching, not substring
- **O(1) sync tracking** - `syncedInsightKeys` Set prevents double-write race
- **Prune-before-build** - Avoids O(n^2) index rebuild loop

### Utility Functions

```typescript
import {
  resolveAutoMemoryDir,  // Derive auto memory path from working dir
  findGitRoot,           // Walk up to find .git root
  parseMarkdownEntries,  // Parse ## headings into structured entries
  extractSummaries,      // Extract bullet summaries, strip metadata
  formatInsightLine,     // Format insight as markdown bullet
  hashContent,           // SHA-256 truncated to 16 hex chars
  pruneTopicFile,        // Keep topic files under line limit
  hasSummaryLine,        // Exact bullet-prefix dedup check
} from '@claude-flow/memory';
```

### Types

```typescript
import type {
  AutoMemoryBridgeConfig,
  MemoryInsight,
  InsightCategory,
  SyncDirection,
  SyncMode,
  PruneStrategy,
  SyncResult,
  ImportResult,
} from '@claude-flow/memory';
```

## Self-Learning Bridge (ADR-049)

Connects insights to the `@claude-flow/neural` learning pipeline. When neural is unavailable, all operations degrade to no-ops.

### Quick Start

```typescript
import { AutoMemoryBridge, LearningBridge } from '@claude-flow/memory';

const bridge = new AutoMemoryBridge(backend, {
  workingDir: '/workspaces/my-project',
  learning: {
    sonaMode: 'balanced',
    confidenceDecayRate: 0.005,   // Per-hour decay
    accessBoostAmount: 0.03,      // Boost per access
    consolidationThreshold: 10,   // Min insights before consolidation
  },
});

// Insights now trigger learning trajectories automatically
await bridge.recordInsight({
  category: 'debugging',
  summary: 'Connection pool exhaustion on high load',
  source: 'agent:tester',
  confidence: 0.9,
});

// Consolidation runs JUDGE/DISTILL/CONSOLIDATE pipeline
await bridge.syncToAutoMemory(); // Calls consolidate() first
```

### Standalone Usage

```typescript
import { LearningBridge } from '@claude-flow/memory';

const lb = new LearningBridge(backend, {
  // Optional: inject neural loader for custom setups
  neuralLoader: async () => {
    const { NeuralLearningSystem } = await import('@claude-flow/neural');
    return new NeuralLearningSystem();
  },
});

// Boost confidence when insight is accessed
await lb.onInsightAccessed('entry-123'); // +0.03 confidence

// Apply time-based decay
const decayed = await lb.decayConfidences('default'); // -0.005/hour

// Find similar patterns via ReasoningBank
const patterns = await lb.findSimilarPatterns('connection pooling');

// Get learning statistics
const stats = lb.getStats();
// { totalTrajectories, activeTrajectories, completedTrajectories,
//   totalConsolidations, accessBoosts, ... }
```

### Confidence Lifecycle

| Event | Effect | Range |
|-------|--------|-------|
| Insight recorded | Initial confidence from source | 0.1 - 1.0 |
| Insight accessed | +0.03 per access | Capped at 1.0 |
| Time decay | -0.005 per hour since last access | Floored at 0.1 |
| Consolidation | Neural pipeline may adjust | 0.1 - 1.0 |

## Knowledge Graph (ADR-049)

Pure TypeScript knowledge graph with PageRank and community detection. No external graph libraries required.

### Quick Start

```typescript
import { AutoMemoryBridge, MemoryGraph } from '@claude-flow/memory';

const bridge = new AutoMemoryBridge(backend, {
  workingDir: '/workspaces/my-project',
  graph: {
    similarityThreshold: 0.8,
    pageRankDamping: 0.85,
    maxNodes: 5000,
  },
});

// Graph builds automatically on import
await bridge.importFromAutoMemory();

// Curation uses PageRank to prioritize influential insights
await bridge.curateIndex();
```

### Standalone Usage

```typescript
import { MemoryGraph } from '@claude-flow/memory';

const graph = new MemoryGraph({
  pageRankDamping: 0.85,
  pageRankIterations: 50,
  pageRankConvergence: 1e-6,
  maxNodes: 5000,
});

// Build from backend entries
await graph.buildFromBackend(backend, 'my-namespace');

// Or build manually
graph.addNode(entry);
graph.addEdge('entry-1', 'entry-2', 'reference', 1.0);
graph.addEdge('entry-1', 'entry-3', 'similar', 0.9);

// Compute PageRank (power iteration)
const ranks = graph.computePageRank();

// Detect communities (label propagation)
const communities = graph.detectCommunities();

// Graph-aware ranking: blend vector score + PageRank
const ranked = graph.rankWithGraph(searchResults, 0.7);
// alpha=0.7 means 70% vector score + 30% PageRank

// Get most influential insights for MEMORY.md
const topNodes = graph.getTopNodes(20);

// BFS traversal for related insights
const neighbors = graph.getNeighbors('entry-1', 2); // depth=2
```

### Edge Types

| Type | Source | Description |
|------|--------|-------------|
| `reference` | `MemoryEntry.references` | Explicit cross-references between entries |
| `similar` | HNSW search | Auto-created when similarity > threshold |
| `temporal` | Timestamps | Entries created in same time window |
| `co-accessed` | Access patterns | Entries frequently accessed together |
| `causal` | Learning pipeline | Cause-effect relationships |

### Performance

| Operation | Result | Target |
|-----------|--------|--------|
| Graph build (1k nodes) | 2.78 ms | <200 ms |
| PageRank (1k nodes) | 12.21 ms | <100 ms |
| Community detection (1k) | 19.62 ms | — |
| `rankWithGraph(10)` | 0.006 ms | — |
| `getTopNodes(20)` | 0.308 ms | — |
| `getNeighbors(d=2)` | 0.005 ms | — |

## Agent-Scoped Memory (ADR-049)

Maps Claude Code's 3-scope agent memory directories for per-agent knowledge isolation and cross-agent transfer.

### Quick Start

```typescript
import { createAgentBridge, transferKnowledge } from '@claude-flow/memory';

// Create a bridge for a specific agent scope
const agentBridge = createAgentBridge(backend, {
  agentName: 'my-coder',
  scope: 'project', // 'project' | 'local' | 'user'
  workingDir: '/workspaces/my-project',
});

// Record insights scoped to this agent
await agentBridge.recordInsight({
  category: 'debugging',
  summary: 'Use connection pooling for DB calls',
  source: 'agent:my-coder',
  confidence: 0.95,
});

// Transfer high-confidence insights between agents
const result = await transferKnowledge(sourceBackend, targetBridge, {
  sourceNamespace: 'learnings',
  minConfidence: 0.8,   // Only transfer confident insights
  maxEntries: 20,
  categories: ['debugging', 'architecture'],
});
// { transferred: 15, skipped: 5 }
```

### Scope Paths

| Scope | Directory | Use Case |
|-------|-----------|----------|
| `project` | `<gitRoot>/.claude/agent-memory/<agent>/` | Project-specific learnings |
| `local` | `<gitRoot>/.claude/agent-memory-local/<agent>/` | Machine-local data |
| `user` | `~/.claude/agent-memory/<agent>/` | Cross-project user knowledge |

### Utilities

```typescript
import {
  resolveAgentMemoryDir,  // Get scope directory path
  createAgentBridge,       // Create scoped AutoMemoryBridge
  transferKnowledge,       // Cross-agent knowledge sharing
  listAgentScopes,         // Discover existing agent scopes
} from '@claude-flow/memory';

// Resolve path for an agent scope
const dir = resolveAgentMemoryDir('my-agent', 'project');
// → /workspaces/my-project/.claude/agent-memory/my-agent/

// List all agent scopes in a directory
const scopes = await listAgentScopes('/workspaces/my-project');
// [{ agentName: 'coder', scope: 'project', path: '...' }, ...]
```

## Performance Benchmarks

Reproducible benchmarks ship in `benchmarks/*.bench.ts`. Run them yourself:

```bash
cd v3/@claude-flow/memory
npm run build
npm run bench         # runs benchmarks/*.bench.ts under vitest
```

### HNSW search baseline ([`baseline-20260519T212453Z.md`](./benchmarks/results/baseline-20260519T212453Z.md))

Measured on Apple Silicon (M-series), Node 22.22.1, vitest 4.0.16. Scenario: 1,000 random 128-dim cosine-normalized vectors loaded into a single `HNSWIndex`, then 200 query iterations after warmup.

| Metric | Value | Notes |
|---|---|---|
| `build_time_ms` | **533.42 ms** | Sequential `addPoint()` × 1,000 |
| `search_k10_avg_ms` | **0.5294 ms** | Post-warmup, average of 200 iterations |
| `search_k50_avg_ms` | **0.5235 ms** | k=50 ≈ k=10 — heap-based selection dominates |
| `add_avg_ms` | **0.8656 ms** | Incremental insert after the initial 1k |
| `search_k10_ops_per_sec` | **1,888.9 ops/s** | Derived |
| `search_k50_ops_per_sec` | **1,910.1 ops/s** | Derived |

These numbers are device-specific; CI baselines will replace this file once the GitHub Actions bench job lands. ADR-125 Phase 3 (persistent HNSW) means **cold-start** restoration should be a small fraction of `build_time_ms` once the snapshot benchmark is added.

### ADR-049 Benchmarks

| Operation | Actual | Target | Headroom |
|-----------|--------|--------|----------|
| Graph build (1k nodes) | 2.78 ms | <200 ms | **71.9x** |
| PageRank (1k nodes) | 12.21 ms | <100 ms | **8.2x** |
| Insight recording | 0.12 ms/each | <5 ms/each | **41.0x** |
| Consolidation | 0.26 ms | <500 ms | **1,955x** |
| Confidence decay (1k) | 0.23 ms | <50 ms | **215x** |
| Knowledge transfer | 1.25 ms | <100 ms | **80.0x** |

## TypeScript Types

```typescript
import type {
  // Core
  HNSWConfig, HNSWStats, SearchResult, MemoryEntry,
  QuantizationConfig, DistanceMetric,

  // Auto Memory Bridge (ADR-048)
  AutoMemoryBridgeConfig, MemoryInsight, InsightCategory,
  SyncDirection, SyncMode, PruneStrategy,
  SyncResult, ImportResult,

  // Learning Bridge (ADR-049)
  LearningBridgeConfig, LearningStats,
  ConsolidateResult, PatternMatch,

  // Knowledge Graph (ADR-049)
  MemoryGraphConfig, GraphNode, GraphEdge,
  GraphStats, RankedResult, EdgeType,

  // Agent Scope (ADR-049)
  AgentMemoryScope, AgentScopedConfig,
  TransferOptions, TransferResult,
} from '@claude-flow/memory';
```

## Dependencies

Protected `TieredMemoryStore` retention requires a native, file-backed synchronous
SQLite connection. Configured or persisted protection adopts `synchronous=FULL`
before protected initialization, verifies the effective setting independently,
and rejects later drift before returning protected reads or committing writes.
An ordinary unconfigured store retains its existing synchronization setting.
Ordinary writes recheck namespace protection under a SQLite writer lock, while
preserving an existing native caller-owned transaction. If protection appears
during such a transaction, the caller must end it before retrying adoption.

`getProtectedDurability()` and the CLI bridge health response expose metadata
for effective synchronization, journal mode, SQLite version and the known
[SQLite WAL-reset fix](https://www.sqlite.org/wal.html#walreset). A successful
FULL check alone does not prove deployment durability: release validation must
also verify the exact engine, same-host storage, exclusive ownership and recovery.
The sql.js fallback remains available for ordinary memory; it cannot attest
native protected commits. The readiness diagnostic does not replace an
independent deployment gate or upgrade an installed SQLite dependency.

- `agentdb` `^3.0.0-alpha.14` — Vector database engine
- `sql.js` — SQLite driver via WASM (always available; no native build required)
- `better-sqlite3` — **Optional** native SQLite driver for higher throughput. The package works without it (sql.js fallback), so installs succeed on Node 24/26 even when the native build can't compile ([#1867](https://github.com/ruvnet/ruflo/issues/1867))
- `@claude-flow/embeddings` — **Optional** for semantic search. When absent or failing, `search()` automatically falls back to FTS5 keyword (see [Graceful retrieval](#graceful-retrieval-fts5-fallback))
- `@claude-flow/neural` — **Optional** peer dependency for self-learning (graceful fallback when unavailable)

## Related Packages

- [@claude-flow/neural](../neural) - Neural learning integration (SONA, ReasoningBank, EWC++)
- [@claude-flow/shared](../shared) - Shared types and utilities
- [@claude-flow/hooks](../hooks) - Session lifecycle hooks for auto memory sync

## License

MIT
