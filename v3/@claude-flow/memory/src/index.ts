/**
 * @claude-flow/memory - V3 Unified Memory System
 *
 * Provides a unified memory interface backed by AgentDB with HNSW indexing
 * for 150x-12,500x faster vector search compared to brute-force approaches.
 *
 * @module @claude-flow/memory
 *
 * @example
 * ```typescript
 * import { UnifiedMemoryService, query, QueryTemplates } from '@claude-flow/memory';
 *
 * // Initialize the memory service
 * const memory = new UnifiedMemoryService({
 *   dimensions: 1536,
 *   cacheEnabled: true,
 *   embeddingGenerator: async (text) => embeddings.embed(text),
 * });
 *
 * await memory.initialize();
 *
 * // Store entries
 * await memory.store({
 *   key: 'auth-patterns',
 *   content: 'OAuth 2.0 implementation patterns for secure authentication',
 *   tags: ['auth', 'security', 'patterns'],
 * });
 *
 * // Semantic search
 * const results = await memory.semanticSearch('user authentication best practices', 5);
 *
 * // Query with fluent builder
 * const entries = await memory.query(
 *   query()
 *     .semantic('security vulnerabilities')
 *     .inNamespace('security')
 *     .withTags(['critical'])
 *     .threshold(0.8)
 *     .limit(10)
 *     .build()
 * );
 * ```
 */

// ===== Core Types =====
export type {
  // Memory Entry Types
  MemoryType,
  AccessLevel,
  ConsistencyLevel,
  DistanceMetric,
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryUpdate,

  // Query Types
  QueryType,
  MemoryQuery,
  SearchResult,
  SearchOptions,

  // HNSW Types
  HNSWConfig,
  HNSWStats,
  QuantizationConfig,

  // Backend Types
  IMemoryBackend,
  BackendStats,
  HealthCheckResult,
  ComponentHealth,

  // Cache Types
  CacheConfig,
  CacheStats,
  CachedEntry,

  // Migration Types
  MigrationSource,
  MigrationConfig,
  MigrationProgress,
  MigrationResult,
  MigrationError,

  // Event Types
  MemoryEventType,
  MemoryEvent,
  MemoryEventHandler,

  // SONA Types
  SONAMode,
  LearningPattern,

  // Utility Types
  EmbeddingGenerator,
  BatchEmbeddingGenerator,
} from './types.js';

// Utility Functions and Constants (runtime values)
export {
  generateMemoryId,
  createDefaultEntry,
  PERFORMANCE_TARGETS,
} from './types.js';

// ===== Auto Memory Bridge (ADR-048) =====
export { AutoMemoryBridge, resolveAutoMemoryDir, findGitRoot } from './auto-memory-bridge.js';
export type {
  AutoMemoryBridgeConfig,
  MemoryInsight,
  InsightCategory,
  SyncDirection,
  SyncMode,
  PruneStrategy,
  SyncResult,
  ImportResult,
} from './auto-memory-bridge.js';

// ===== Learning Bridge =====
export { LearningBridge } from './learning-bridge.js';
export type {
  LearningBridgeConfig,
  LearningStats,
  ConsolidateResult,
  PatternMatch,
} from './learning-bridge.js';

// ===== RVF Learning Persistence (ADR-057 Phase 6) =====
export { RvfLearningStore } from './rvf-learning-store.js';
export type {
  RvfLearningStoreConfig,
  PatternRecord,
  LoraRecord,
  EwcRecord,
  TrajectoryRecord,
} from './rvf-learning-store.js';
export { PersistentSonaCoordinator } from './persistent-sona.js';
export type { PersistentSonaConfig } from './persistent-sona.js';

// ===== RVF Migration (Bidirectional) =====
export { RvfMigrator } from './rvf-migration.js';
export type { RvfMigrationOptions, RvfMigrationResult } from './rvf-migration.js';

// ===== Knowledge Graph =====
export { MemoryGraph } from './memory-graph.js';
export type {
  MemoryGraphConfig,
  GraphNode,
  GraphEdge,
  GraphStats,
  RankedResult,
  EdgeType,
} from './memory-graph.js';

// ===== Agent-Scoped Memory =====
export {
  resolveAgentMemoryDir,
  createAgentBridge,
  transferKnowledge,
  listAgentScopes,
} from './agent-memory-scope.js';
export type {
  AgentMemoryScope,
  AgentScopedConfig,
  TransferOptions,
  TransferResult,
} from './agent-memory-scope.js';

// ===== Controller Registry (ADR-053) =====
export { ControllerRegistry, INIT_LEVELS } from './controller-registry.js';
export type {
  AgentDBControllerName,
  CLIControllerName,
  ControllerName,
  InitLevel,
  ControllerHealth,
  RegistryHealthReport,
  RuntimeConfig,
} from './controller-registry.js';

// ===== Tiered Memory with Temporal Validity (Zep/Graphiti-style) =====
export { TieredMemoryStore, isTemporallyValid } from './tiered-memory.js';
export type {
  TemporalStoreOptions,
  TieredRecallOptions,
  TieredMemoryEntry,
  TieredStoreResult,
  TieredExactGetResult,
  TieredCreateResult,
  ProtectedTieredRetention,
} from './tiered-memory.js';

// ===== Core Components =====
export { AgentDBAdapter } from './agentdb-adapter.js';
export type { AgentDBAdapterConfig } from './agentdb-adapter.js';
export { AgentDBBackend } from './agentdb-backend.js';
export type { AgentDBBackendConfig } from './agentdb-backend.js';
export {
  AgentDbRetrievalGuard,
  createAgentDbRetrievalGuard,
  isRetrievalGuardEnabled,
  isRetrievalGuardStrict,
} from './agentdb-retrieval-guard.js';
export type {
  RetrievalGuardConfig,
  GuardedSearchResult,
  FilteredSearchResults,
} from './agentdb-retrieval-guard.js';
export { SQLiteBackend } from './sqlite-backend.js';
export type { SQLiteBackendConfig } from './sqlite-backend.js';
export { SqlJsBackend } from './sqljs-backend.js';
export type { SqlJsBackendConfig } from './sqljs-backend.js';
export { HybridBackend } from './hybrid-backend.js';
export type {
  HybridBackendConfig,
  StructuredQuery,
  SemanticQuery,
  HybridQuery,
} from './hybrid-backend.js';
// `RvfBackend` and `HnswLite` are intentionally NOT re-exported from the top level
// per ADR-125 Phase 1. `RvfBackend` remains reachable via
// `createDatabase({ provider: 'rvf' })`. The legacy `hnsw-lite.ts` module was
// deleted by ADR-125 Phase 3; its brute-force-degrading code is inlined into
// `rvf-backend.ts` as a private helper.
export { HNSWIndex } from './hnsw-index.js';
export { CacheManager, TieredCacheManager } from './cache-manager.js';
export { QueryBuilder, query, QueryTemplates } from './query-builder.js';
export type { SortDirection, SortField } from './query-builder.js';
export { MemoryMigrator, createMigrator, migrateMultipleSources } from './migration.js';
export { createDatabase, getPlatformInfo, getAvailableProviders } from './database-provider.js';
export type { DatabaseProvider, DatabaseOptions } from './database-provider.js';

// ===== Smart Retrieval (ADR-090) =====
export { smartSearch, defaultQueryExpansions } from './smart-retrieval.js';
export type {
  SearchCandidate,
  RawSearchRequest,
  RawSearchResponse,
  SearchFn,
  SmartSearchOptions,
  SmartSearchStats,
  SmartSearchResult,
} from './smart-retrieval.js';

// ===== Unified Memory Service =====
import { EventEmitter } from 'node:events';
import {
  IMemoryBackend,
  MemoryEntry,
  MemoryEntryInput,
  MemoryEntryUpdate,
  MemoryQuery,
  SearchResult,
  SearchOptions,
  BackendStats,
  HealthCheckResult,
  EmbeddingGenerator,
  MigrationSource,
  MigrationConfig,
  MigrationResult,
} from './types.js';
import { AgentDBAdapter, AgentDBAdapterConfig } from './agentdb-adapter.js';
import { MemoryMigrator } from './migration.js';

/**
 * Configuration for UnifiedMemoryService
 */
export interface UnifiedMemoryServiceConfig extends Partial<AgentDBAdapterConfig> {
  /** Enable automatic embedding generation */
  autoEmbed?: boolean;

  /** Default embedding dimensions */
  dimensions?: number;

  /** Embedding generator function */
  embeddingGenerator?: EmbeddingGenerator;

  /**
   * Take an HNSW + metadata snapshot every N successful `store()` calls.
   * Set to `0` (or `Infinity`) to disable interval-based snapshots — `close()`
   * still flushes. Default: 1000.
   *
   * Only takes effect when `persistenceEnabled === true` and `persistencePath`
   * is set. Added by ADR-125 Phase 3.
   */
  snapshotInterval?: number;

  /**
   * Configuration for the background {@link MemoryConsolidator}. Added by
   * ADR-125 Phase 4. When `autoRun: true`, the service starts a `setInterval`
   * timer (default 6h) that runs sweep + dedup + compact and emits the
   * result via `'consolidation:complete'`.
   */
  consolidator?: {
    autoRun?: boolean;
    intervalMs?: number;
    dedupStrategy?: 'keep-newest' | 'keep-oldest' | 'merge-tags';
  };
}

/**
 * Memory Service implementation (legacy class name).
 *
 * @deprecated Use {@link MemoryService} — the canonical name introduced by
 *   ADR-125 Phase 1. `UnifiedMemoryService` is preserved as an alias and will
 *   continue to work through `@claude-flow/memory@3.0.0-rc`. Both names refer
 *   to the same class.
 *
 * High-level interface that provides:
 * - Simple API for common operations
 * - Automatic embedding generation
 * - Cross-agent memory sharing
 * - SONA integration for learning
 * - Event-driven notifications
 * - Performance monitoring
 *
 * @see {@link MemoryService} for the canonical alias.
 */
export class UnifiedMemoryService extends EventEmitter implements IMemoryBackend {
  private adapter: AgentDBAdapter;
  private config: UnifiedMemoryServiceConfig;
  private initialized: boolean = false;

  /** Total successful `store()` calls since last snapshot trigger (ADR-125 Phase 3). */
  private storeCountSinceSnapshot: number = 0;

  /** Resolved snapshot interval — see {@link UnifiedMemoryServiceConfig.snapshotInterval}. */
  private readonly snapshotInterval: number;

  /** Background consolidator timer (ADR-125 Phase 4). */
  private consolidatorTimer: ReturnType<typeof setInterval> | null = null;

  /** Lazy-loaded consolidator instance (ADR-125 Phase 4). */
  private consolidator: any | null = null;

  /**
   * The active memory backend. Defaults to the `AgentDBAdapter` created from
   * config, but can be any `IMemoryBackend` implementation (e.g. `HybridBackend`
   * when constructed via `createHybridService` per ADR-009 / ADR-125 Phase 2).
   *
   * Public so consumers can introspect the backend type without reaching for
   * `getAdapter()` (which is AgentDB-specific).
   */
  public backend: IMemoryBackend;

  constructor(config: UnifiedMemoryServiceConfig = {}) {
    super();
    this.config = {
      dimensions: 1536,
      cacheEnabled: true,
      autoEmbed: true,
      ...config,
    };

    // ADR-125 Phase 3 — snapshot every Nth store. 0/Infinity = disabled.
    const raw = this.config.snapshotInterval;
    this.snapshotInterval =
      raw === undefined ? 1000 : raw === 0 ? Infinity : raw;

    this.adapter = new AgentDBAdapter({
      dimensions: this.config.dimensions,
      cacheEnabled: this.config.cacheEnabled,
      cacheSize: this.config.cacheSize,
      cacheTtl: this.config.cacheTtl,
      hnswM: this.config.hnswM,
      hnswEfConstruction: this.config.hnswEfConstruction,
      defaultNamespace: this.config.defaultNamespace,
      embeddingGenerator: this.config.embeddingGenerator,
      persistenceEnabled: this.config.persistenceEnabled,
      persistencePath: this.config.persistencePath,
      maxEntries: this.config.maxEntries,
    });

    // Default backend is the AgentDB adapter — ADR-125 Phase 2 introduces the
    // ability to replace it via `withBackend()` / `createHybridService`.
    this.backend = this.adapter;

    // Forward adapter events
    this.adapter.on('entry:stored', (data) => this.emit('entry:stored', data));
    this.adapter.on('entry:updated', (data) => this.emit('entry:updated', data));
    this.adapter.on('entry:deleted', (data) => this.emit('entry:deleted', data));
    this.adapter.on('cache:hit', (data) => this.emit('cache:hit', data));
    this.adapter.on('cache:miss', (data) => this.emit('cache:miss', data));
    this.adapter.on('index:added', (data) => this.emit('index:added', data));
  }

  /**
   * Replace the active backend with a pre-built `IMemoryBackend`.
   *
   * Used by `createHybridService` (ADR-125 Phase 2) to wire `HybridBackend`
   * through `createDatabase` rather than instantiating `AgentDBAdapter`
   * directly. The legacy `AgentDBAdapter` instance is kept around for the
   * `storeEntry` / `semanticSearch` convenience methods that the IMemoryBackend
   * interface doesn't cover; those calls still flow through it.
   *
   * Returns `this` for chaining.
   *
   * @internal Prefer the factory functions (`createHybridService`,
   *   `createPersistentService`, etc.) over calling this directly.
   */
  withBackend(backend: IMemoryBackend): this {
    this.backend = backend;
    return this;
  }

  // ===== Lifecycle =====

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.backend.initialize();
    // If the active backend is something other than the adapter (e.g. a
    // HybridBackend wired by createHybridService), the adapter may never be
    // used — skip its initialize() in that case to avoid double-allocating.
    this.initialized = true;

    // ADR-125 Phase 4 — start background consolidator if requested.
    this.startConsolidatorTimer();

    this.emit('initialized');
  }

  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    // ADR-125 Phase 4 — stop consolidator timer first to prevent a sweep
    // from racing the snapshot below.
    if (this.consolidatorTimer) {
      clearInterval(this.consolidatorTimer);
      this.consolidatorTimer = null;
    }

    // ADR-125 Phase 3 — flush a final HNSW + meta snapshot before tearing the
    // backend down. Only meaningful when the AgentDBAdapter is the active
    // backend and persistence is enabled.
    if (this.backend === this.adapter) {
      try {
        await this.adapter.saveSnapshot();
      } catch {
        // saveToDisk already emits failure events; do not throw from shutdown.
      }
    }

    await this.backend.shutdown();
    this.initialized = false;
    this.emit('shutdown');
  }

  /**
   * Alias for {@link shutdown}. Matches the lifecycle name expected by callers
   * who treat `MemoryService` like a connection — referenced from ADR-125
   * Phase 3 (snapshot on close()) and Phase 4 (consolidator timer cleanup).
   */
  async close(): Promise<void> {
    return this.shutdown();
  }

  /**
   * Start the background consolidator timer if configured.
   * @internal
   */
  private startConsolidatorTimer(): void {
    const cfg = this.config.consolidator;
    if (!cfg?.autoRun) return;
    const intervalMs = cfg.intervalMs ?? 6 * 60 * 60 * 1000; // default 6h
    if (intervalMs <= 0) return;

    this.consolidatorTimer = setInterval(() => {
      void this.runAutoConsolidation();
    }, intervalMs);
    // Don't block process exit on the timer (Node-only; no-op elsewhere).
    if (typeof (this.consolidatorTimer as any).unref === 'function') {
      (this.consolidatorTimer as any).unref();
    }
  }

  /**
   * Run a single consolidator cycle on the active adapter. Emits a
   * `consolidation:complete` event with the {@link ConsolidationResult}.
   * @internal
   */
  private async runAutoConsolidation(): Promise<void> {
    try {
      const consolidator = await this.getConsolidator();
      const result = await consolidator.runAll();
      this.emit('consolidation:complete', result);
    } catch (err) {
      this.emit('consolidation:failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get (and lazily construct) the {@link MemoryConsolidator} bound to this
   * service. Added by ADR-125 Phase 4.
   */
  async getConsolidator(): Promise<any> {
    if (this.consolidator) return this.consolidator;
    const { MemoryConsolidator } = await import('./consolidator.js');
    // The consolidator reaches into AgentDBAdapter private state. Cast through
    // any to bypass TS's view of those fields (the runtime structure is stable
    // and tested by consolidator.test.ts).
    this.consolidator = new MemoryConsolidator(this as any, {
      dedupStrategy: this.config.consolidator?.dedupStrategy ?? 'keep-newest',
      intervalMs: this.config.consolidator?.intervalMs,
    });
    return this.consolidator;
  }

  // ===== IMemoryBackend Implementation =====

  async store(entry: MemoryEntry): Promise<void> {
    await this.backend.store(entry);
    this.maybeSnapshot();
  }

  /**
   * If a snapshot interval is configured and the threshold is hit, fire a
   * snapshot in the background. Only meaningful when the active backend is
   * the AgentDBAdapter with persistence enabled.
   *
   * @internal — ADR-125 Phase 3
   */
  private maybeSnapshot(): void {
    if (!Number.isFinite(this.snapshotInterval)) return;
    if (this.backend !== this.adapter) return;
    if (!this.config.persistenceEnabled || !this.config.persistencePath) return;

    this.storeCountSinceSnapshot += 1;
    if (this.storeCountSinceSnapshot >= this.snapshotInterval) {
      this.storeCountSinceSnapshot = 0;
      // Fire and forget — saveSnapshot emits its own lifecycle events.
      void this.adapter.saveSnapshot();
    }
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.backend.get(id);
  }

  async getByKey(namespace: string, key: string): Promise<MemoryEntry | null> {
    return this.backend.getByKey(namespace, key);
  }

  async update(id: string, update: MemoryEntryUpdate): Promise<MemoryEntry | null> {
    return this.backend.update(id, update);
  }

  async delete(id: string): Promise<boolean> {
    return this.backend.delete(id);
  }

  async query(query: MemoryQuery): Promise<MemoryEntry[]> {
    return this.backend.query(query);
  }

  async search(embedding: Float32Array, options: SearchOptions): Promise<SearchResult[]> {
    return this.backend.search(embedding, options);
  }

  async bulkInsert(entries: MemoryEntry[]): Promise<void> {
    await this.backend.bulkInsert(entries);
    // Count each entry toward the snapshot threshold (ADR-125 Phase 3).
    for (let i = 0; i < entries.length; i++) {
      this.maybeSnapshot();
    }
  }

  async bulkDelete(ids: string[]): Promise<number> {
    return this.backend.bulkDelete(ids);
  }

  async count(namespace?: string): Promise<number> {
    return this.backend.count(namespace);
  }

  async listNamespaces(): Promise<string[]> {
    return this.backend.listNamespaces();
  }

  async clearNamespace(namespace: string): Promise<number> {
    return this.backend.clearNamespace(namespace);
  }

  async getStats(): Promise<BackendStats> {
    return this.backend.getStats();
  }

  async healthCheck(): Promise<HealthCheckResult> {
    return this.backend.healthCheck();
  }

  // ===== Convenience Methods =====

  /**
   * Store an entry from simple input.
   *
   * When the active backend is the default AgentDBAdapter, delegates to its
   * native `storeEntry`. When a custom backend is wired (e.g. HybridBackend
   * via `createHybridService`), this builds a full `MemoryEntry` and stores
   * it through the IMemoryBackend interface.
   */
  async storeEntry(input: MemoryEntryInput): Promise<MemoryEntry> {
    if (this.backend === this.adapter) {
      return this.adapter.storeEntry(input);
    }
    // Generic path for non-AgentDBAdapter backends
    const { createDefaultEntry } = await import('./types.js');
    const entry = createDefaultEntry(input as any);
    // Generate an embedding on demand if needed
    if (!entry.embedding && this.config.embeddingGenerator && entry.content) {
      try {
        entry.embedding = await this.config.embeddingGenerator(entry.content);
      } catch {
        // Leave embedding undefined; backend may still accept the entry.
      }
    }
    await this.backend.store(entry);
    return entry;
  }

  /**
   * Semantic search by content string.
   *
   * When the active backend is the default AgentDBAdapter, delegates to its
   * native `semanticSearch`. Otherwise generates an embedding via the
   * configured generator and calls `backend.search()`.
   */
  async semanticSearch(
    content: string,
    k: number = 10,
    threshold?: number
  ): Promise<SearchResult[]> {
    if (this.backend === this.adapter) {
      return this.adapter.semanticSearch(content, k, threshold);
    }
    if (!this.config.embeddingGenerator) {
      throw new Error(
        'semanticSearch requires an embeddingGenerator when backend is not the AgentDBAdapter'
      );
    }
    const embedding = await this.config.embeddingGenerator(content);
    return this.backend.search(embedding, { k, threshold });
  }

  /**
   * Find similar entries to a given entry
   */
  async findSimilar(id: string, k: number = 5): Promise<SearchResult[]> {
    const entry = await this.get(id);
    if (!entry || !entry.embedding) {
      return [];
    }

    const results = await this.search(entry.embedding, { k: k + 1 });

    // Filter out the source entry
    return results.filter((r) => r.entry.id !== id).slice(0, k);
  }

  /**
   * Get or create an entry
   */
  async getOrCreate(
    namespace: string,
    key: string,
    creator: () => MemoryEntryInput | Promise<MemoryEntryInput>
  ): Promise<MemoryEntry> {
    const existing = await this.getByKey(namespace, key);
    if (existing) return existing;

    const input = await creator();
    return this.storeEntry({ ...input, namespace, key });
  }

  /**
   * Append content to an existing entry
   */
  async appendContent(id: string, content: string): Promise<MemoryEntry | null> {
    const entry = await this.get(id);
    if (!entry) return null;

    return this.update(id, {
      content: entry.content + '\n' + content,
    });
  }

  /**
   * Add tags to an existing entry
   */
  async addTags(id: string, tags: string[]): Promise<MemoryEntry | null> {
    const entry = await this.get(id);
    if (!entry) return null;

    const newTags = [...new Set([...entry.tags, ...tags])];
    return this.update(id, { tags: newTags });
  }

  /**
   * Remove tags from an existing entry
   */
  async removeTags(id: string, tags: string[]): Promise<MemoryEntry | null> {
    const entry = await this.get(id);
    if (!entry) return null;

    const newTags = entry.tags.filter((t) => !tags.includes(t));
    return this.update(id, { tags: newTags });
  }

  // ===== Migration =====

  /**
   * Migrate from a legacy memory source.
   *
   * The migrator is AgentDB-specific (writes through `AgentDBAdapter`).
   * When a custom backend is wired (e.g. HybridBackend), migration still
   * targets the local AgentDB adapter; the hybrid backend can pick up the
   * migrated entries on next read via its own AgentDB index.
   */
  async migrateFrom(
    source: MigrationSource,
    sourcePath: string,
    options: Partial<MigrationConfig> = {}
  ): Promise<MigrationResult> {
    const migrator = new MemoryMigrator(
      this.adapter,
      { source, sourcePath, ...options },
      this.config.embeddingGenerator
    );

    // Forward migration events
    migrator.on('migration:started', (data) => this.emit('migration:started', data));
    migrator.on('migration:progress', (data) => this.emit('migration:progress', data));
    migrator.on('migration:completed', (data) => this.emit('migration:completed', data));
    migrator.on('migration:failed', (data) => this.emit('migration:failed', data));
    migrator.on('migration:error', (data) => this.emit('migration:error', data));
    migrator.on('migration:warning', (data) => this.emit('migration:warning', data));

    return migrator.migrate();
  }

  // ===== Cross-Agent Memory Sharing =====

  /**
   * Share an entry with another agent
   */
  async shareWith(id: string, agentId: string): Promise<MemoryEntry | null> {
    const entry = await this.get(id);
    if (!entry) return null;

    const sharedWith = (entry.metadata.sharedWith as string[]) || [];
    if (!sharedWith.includes(agentId)) {
      sharedWith.push(agentId);
    }

    return this.update(id, {
      metadata: { ...entry.metadata, sharedWith },
    });
  }

  /**
   * Get entries shared with a specific agent
   */
  async getSharedWith(agentId: string): Promise<MemoryEntry[]> {
    const all = await this.query({ type: 'hybrid', limit: 10000 });
    return all.filter((entry) => {
      const sharedWith = (entry.metadata.sharedWith as string[]) || [];
      return sharedWith.includes(agentId);
    });
  }

  // ===== Utility =====

  /**
   * Get the underlying adapter for advanced operations
   */
  getAdapter(): AgentDBAdapter {
    return this.adapter;
  }

  /**
   * Check if the service is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// ===== Canonical Alias (ADR-125 Phase 1) =====

/**
 * Canonical memory service entry point (ADR-125).
 *
 * `MemoryService` is the preferred name as of `@claude-flow/memory@3.0.0-alpha.18`.
 * It is an alias of {@link UnifiedMemoryService}; both names refer to the same
 * class so existing callers continue working unchanged.
 *
 * @example
 * ```typescript
 * import { MemoryService } from '@claude-flow/memory';
 *
 * const memory = new MemoryService({ dimensions: 1536 });
 * await memory.initialize();
 * ```
 */
export const MemoryService = UnifiedMemoryService;

/**
 * @public
 * @typedef MemoryService
 *
 * Type alias matching the canonical {@link MemoryService} runtime export so that
 * `import type { MemoryService } from '@claude-flow/memory'` works alongside the
 * value import.
 */
export type MemoryService = UnifiedMemoryService;

/**
 * Config type alias for {@link MemoryService}.
 */
export type MemoryServiceConfig = UnifiedMemoryServiceConfig;

// ===== Factory Functions =====

/**
 * Create a simple in-memory service (for testing)
 */
export function createInMemoryService(): UnifiedMemoryService {
  return new UnifiedMemoryService({
    persistenceEnabled: false,
    cacheEnabled: true,
  });
}

/**
 * Create a persistent memory service
 */
export function createPersistentService(path: string): UnifiedMemoryService {
  return new UnifiedMemoryService({
    persistenceEnabled: true,
    persistencePath: path,
    cacheEnabled: true,
  });
}

/**
 * Create a memory service with embedding support
 */
export function createEmbeddingService(
  embeddingGenerator: EmbeddingGenerator,
  dimensions: number = 1536
): UnifiedMemoryService {
  return new UnifiedMemoryService({
    embeddingGenerator,
    dimensions,
    autoEmbed: true,
    cacheEnabled: true,
  });
}

/**
 * Create a hybrid memory service (SQLite + AgentDB).
 *
 * This is the DEFAULT recommended configuration per ADR-009. ADR-125 Phase 2
 * delivers the real wiring: the returned service's backend is a `HybridBackend`
 * created through `createDatabase({ provider: 'hybrid' })`, not an AgentDB-only
 * downgrade as in earlier versions.
 *
 * @example
 * ```typescript
 * const memory = await createHybridService('./data/memory.db', embeddingFn);
 * await memory.initialize();
 *
 * // Structured queries go to SQLite
 * const user = await memory.getByKey('users', 'john@example.com');
 *
 * // Semantic queries go to AgentDB
 * const similar = await memory.semanticSearch('authentication patterns', 10);
 *
 * // Verify the backend is actually hybrid
 * import { HybridBackend } from '@claude-flow/memory';
 * memory.backend instanceof HybridBackend; // true
 * ```
 */
export async function createHybridService(
  databasePath: string,
  embeddingGenerator: EmbeddingGenerator,
  dimensions: number = 1536
): Promise<UnifiedMemoryService> {
  const { createDatabase } = await import('./database-provider.js');
  const hybridBackend = await createDatabase(databasePath, {
    provider: 'hybrid',
    embeddingGenerator,
    dimensions,
  });
  const service = new UnifiedMemoryService({
    embeddingGenerator,
    dimensions,
    autoEmbed: true,
    cacheEnabled: true,
    persistenceEnabled: true,
    persistencePath: databasePath,
  });
  return service.withBackend(hybridBackend);
}

// Default export
export default UnifiedMemoryService;
