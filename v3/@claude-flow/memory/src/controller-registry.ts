/**
 * ControllerRegistry - Central controller lifecycle management for AgentDB v3
 *
 * Wraps the AgentDB class and adds CLI-specific controllers from @claude-flow/memory.
 * Manages initialization (level-based ordering), health checks, and graceful shutdown.
 *
 * Per ADR-053: Replaces memory-initializer.js's raw sql.js usage with a unified
 * controller ecosystem routing all memory operations through AgentDB v3.
 *
 * @module @claude-flow/memory/controller-registry
 */

import { EventEmitter } from 'node:events';
import type {
  IMemoryBackend,
  HealthCheckResult,
  ComponentHealth,
  BackendStats,
  EmbeddingGenerator,
  SONAMode,
} from './types.js';
import { LearningBridge } from './learning-bridge.js';
import type { LearningBridgeConfig } from './learning-bridge.js';
import { MemoryGraph } from './memory-graph.js';
import type { MemoryGraphConfig } from './memory-graph.js';
import { TieredCacheManager } from './cache-manager.js';
import type { CacheConfig } from './types.js';
import { TieredMemoryStore } from './tiered-memory.js';

// ===== Types =====

/**
 * Controllers accessible via AgentDB.getController()
 */
export type AgentDBControllerName =
  | 'reasoningBank'
  | 'skills'
  | 'reflexion'
  | 'causalGraph'
  | 'causalRecall'
  | 'learningSystem'
  | 'explainableRecall'
  | 'nightlyLearner'
  | 'graphTransformer'
  | 'mutationGuard'
  | 'attestationLog'
  | 'vectorBackend'
  | 'graphAdapter';

/**
 * CLI-layer controllers (from @claude-flow/memory or new)
 */
export type CLIControllerName =
  | 'learningBridge'
  | 'memoryGraph'
  | 'agentMemoryScope'
  | 'tieredCache'
  | 'hybridSearch'
  | 'federatedSession'
  | 'semanticRouter'
  | 'sonaTrajectory'
  | 'hierarchicalMemory'
  | 'memoryConsolidation'
  | 'batchOperations'
  | 'contextSynthesizer'
  | 'gnnService'
  | 'rvfOptimizer'
  | 'mmrDiversityRanker'
  | 'guardedVectorBackend';

/**
 * Minimal surface the `hybridSearch` controller needs from a backend when
 * falling back to `this.backend` (no `memoryService` supplied) — the same
 * two methods `AgentDBAdapter` exposes and the only two this factory calls.
 * A named guard instead of ad-hoc `typeof` checks so a future backend that
 * happens to define same-named-but-differently-shaped methods is easier to
 * catch and reason about at one call site (Dream Cycle 2026-08-18).
 */
interface HybridCapableBackend {
  semanticSearch(query: string, k?: number, threshold?: number): Promise<unknown[]>;
  searchKeyword(query: string, options?: { k?: number }): Promise<unknown[]>;
}

function isHybridCapableBackend(backend: unknown): backend is HybridCapableBackend {
  if (!backend || typeof backend !== 'object') return false;
  const b = backend as Record<string, unknown>;
  return typeof b.semanticSearch === 'function' && typeof b.searchKeyword === 'function';
}

/**
 * All controller names
 */
export type ControllerName = AgentDBControllerName | CLIControllerName;

/**
 * Initialization level for dependency ordering
 */
export interface InitLevel {
  level: number;
  controllers: ControllerName[];
}

/**
 * Individual controller health status
 */
export interface ControllerHealth {
  name: ControllerName;
  status: 'healthy' | 'degraded' | 'unavailable';
  initTimeMs: number;
  error?: string;
}

/**
 * Aggregated health report for all controllers
 */
export interface RegistryHealthReport {
  status: 'healthy' | 'degraded' | 'unhealthy';
  controllers: ControllerHealth[];
  agentdbAvailable: boolean;
  initTimeMs: number;
  timestamp: number;
  activeControllers: number;
  totalControllers: number;
}

/**
 * Runtime configuration for controller activation
 */
export interface RuntimeConfig {
  /** Database path for AgentDB */
  dbPath?: string;

  /** Vector dimension (default: 384 for MiniLM) */
  dimension?: number;

  /** Embedding generator function */
  embeddingGenerator?: EmbeddingGenerator;

  /** Memory backend config */
  memory?: {
    enableHNSW?: boolean;
    learningBridge?: Partial<LearningBridgeConfig>;
    memoryGraph?: Partial<MemoryGraphConfig>;
    tieredCache?: Partial<CacheConfig>;
  };

  /** Neural config */
  neural?: {
    enabled?: boolean;
    modelPath?: string;
    sonaMode?: SONAMode;
  };

  /** Controllers to explicitly enable/disable */
  controllers?: Partial<Record<ControllerName, boolean>>;

  /** Backend instance to use (if pre-created) */
  backend?: IMemoryBackend;

  /**
   * Pre-initialized AgentDB instance to use. When provided, the
   * registry skips its own dynamic-import / initialize cycle and uses
   * this instance as-is — useful for testing, multi-registry sharing,
   * and consumers that already hold an AgentDB they want governed by
   * the registry. Issue #2019 added the regression tests that depend
   * on this injection point.
   */
  agentdb?: unknown;

  /**
   * `MemoryService` (or compatible) used to back the `nightlyLearner`
   * controller. When provided, ADR-125 Phase 4 wraps it with
   * `MemoryConsolidator.runAll()` instead of delegating directly to AgentDB's
   * `NightlyLearner`. Accepts `any` to avoid a circular import.
   */
  memoryService?: any;
}

/**
 * Controller instance wrapper
 */
interface ControllerEntry {
  name: ControllerName;
  instance: unknown;
  level: number;
  initTimeMs: number;
  enabled: boolean;
  error?: string;
}

// ===== Initialization Levels =====

/**
 * Level-based initialization order per ADR-053.
 * Controllers at each level can be initialized in parallel.
 * Each level must complete before the next begins.
 */
export const INIT_LEVELS: InitLevel[] = [
  // Level 0: Foundation - already exists
  { level: 0, controllers: [] },
  // Level 1: Core intelligence
  { level: 1, controllers: ['reasoningBank', 'hierarchicalMemory', 'learningBridge', 'hybridSearch', 'tieredCache'] },
  // Level 2: Graph & security
  { level: 2, controllers: ['memoryGraph', 'agentMemoryScope', 'vectorBackend', 'mutationGuard', 'gnnService'] },
  // Level 3: Specialization
  { level: 3, controllers: ['skills', 'explainableRecall', 'reflexion', 'attestationLog', 'batchOperations', 'memoryConsolidation'] },
  // Level 4: Causal & routing
  { level: 4, controllers: ['causalGraph', 'nightlyLearner', 'learningSystem', 'semanticRouter'] },
  // Level 5: Advanced services
  { level: 5, controllers: ['graphTransformer', 'sonaTrajectory', 'contextSynthesizer', 'rvfOptimizer', 'mmrDiversityRanker', 'guardedVectorBackend'] },
  // Level 6: Session management
  { level: 6, controllers: ['federatedSession', 'graphAdapter'] },
];

// ===== ControllerRegistry =====

/**
 * Central registry for AgentDB v3 controller lifecycle management.
 *
 * Handles:
 * - Level-based initialization ordering (levels 0-6)
 * - Graceful degradation (each controller fails independently)
 * - Config-driven activation (controllers only instantiate when enabled)
 * - Health check aggregation across all controllers
 * - Ordered shutdown (reverse initialization order)
 *
 * @example
 * ```typescript
 * const registry = new ControllerRegistry();
 * await registry.initialize({
 *   dbPath: './data/memory.db',
 *   dimension: 384,
 *   memory: {
 *     enableHNSW: true,
 *     learningBridge: { sonaMode: 'balanced' },
 *     memoryGraph: { pageRankDamping: 0.85 },
 *   },
 * });
 *
 * const reasoning = registry.get<ReasoningBank>('reasoningBank');
 * const graph = registry.get<MemoryGraph>('memoryGraph');
 *
 * await registry.shutdown();
 * ```
 */
export class ControllerRegistry extends EventEmitter {
  private controllers: Map<ControllerName, ControllerEntry> = new Map();
  private agentdb: any = null;
  private backend: IMemoryBackend | null = null;
  private config: RuntimeConfig = {};
  private initialized = false;
  private initTimeMs = 0;
  private hierarchicalFallback: { reason: string; persistence: string } | null = null;

  /**
   * Initialize all controllers in level-based order.
   *
   * Each level's controllers are initialized in parallel within the level.
   * Failures are isolated: a controller that fails to init is marked as
   * unavailable but does not block other controllers.
   */
  async initialize(config: RuntimeConfig = {}): Promise<void> {
    if (this.initialized) return;
    this.initialized = true; // Set early to prevent concurrent re-entry

    this.config = config;
    const startTime = performance.now();

    // Step 1: Initialize AgentDB (the core)
    await this.initAgentDB(config);

    // Step 2: Set up the backend
    this.backend = config.backend || null;

    // Step 3: Initialize controllers level by level
    for (const level of INIT_LEVELS) {
      const controllersToInit = level.controllers.filter(
        (name) => this.isControllerEnabled(name),
      );

      if (controllersToInit.length === 0) continue;

      // Initialize all controllers in this level in parallel
      const results = await Promise.allSettled(
        controllersToInit.map((name) => this.initController(name, level.level)),
      );

      // Process results
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const name = controllersToInit[i];

        if (result.status === 'rejected') {
          const errorMsg = result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);

          // #2432 — close any prior instance before replacing.
          await this.closePriorIfAny(name);

          this.controllers.set(name, {
            name,
            instance: null,
            level: level.level,
            initTimeMs: 0,
            enabled: false,
            error: errorMsg,
          });

          this.emit('controller:failed', { name, error: errorMsg, level: level.level });
        }
      }
    }

    this.initTimeMs = performance.now() - startTime;
    this.emit('initialized', {
      initTimeMs: this.initTimeMs,
      activeControllers: this.getActiveCount(),
      totalControllers: this.controllers.size,
    });
  }

  /**
   * Shutdown all controllers in reverse initialization order.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) return;

    // Shutdown in reverse level order
    const reverseLevels = [...INIT_LEVELS].reverse();

    for (const level of reverseLevels) {
      const controllersToShutdown = level.controllers
        .filter((name) => {
          const entry = this.controllers.get(name);
          return entry?.enabled && entry?.instance;
        });

      await Promise.allSettled(
        controllersToShutdown.map((name) => this.shutdownController(name)),
      );
    }

    // Shutdown AgentDB
    if (this.agentdb) {
      try {
        if (typeof this.agentdb.close === 'function') {
          await this.agentdb.close();
        }
      } catch {
        // Best-effort cleanup
      }
      this.agentdb = null;
    }

    this.controllers.clear();
    this.initialized = false;
    this.emit('shutdown');
  }

  /**
   * Get a controller instance by name.
   * Returns null if the controller is not initialized or unavailable.
   */
  get<T>(name: ControllerName): T | null {
    // First check CLI-layer controllers
    const entry = this.controllers.get(name);
    if (entry?.enabled && entry?.instance) {
      return entry.instance as T;
    }

    // Fall back to AgentDB internal controllers. Issue #2019:
    // probe `agentdb[name]` first so we don't depend on the upstream
    // getController switch knowing about every field it carries.
    if (this.agentdb) {
      const agentdb: any = this.agentdb;
      const direct = agentdb[name];
      if (direct) return direct as T;
      if (typeof agentdb.getController === 'function') {
        try {
          const controller = agentdb.getController(name);
          if (controller) return controller as T;
        } catch {
          // Upstream switch threw for an unknown name — fine, fall through.
        }
      }
    }

    return null;
  }

  /**
   * Check if a controller is enabled and initialized.
   */
  isEnabled(name: ControllerName): boolean {
    const entry = this.controllers.get(name);
    if (entry?.enabled) return true;

    // Issue #2019: same direct-then-fallback shape as get() above.
    if (this.agentdb) {
      const agentdb: any = this.agentdb;
      if (agentdb[name]) return true;
      if (typeof agentdb.getController === 'function') {
        try {
          return agentdb.getController(name) !== null;
        } catch {
          return false;
        }
      }
    }

    return false;
  }

  /**
   * Aggregate health check across all controllers.
   */
  async healthCheck(): Promise<RegistryHealthReport> {
    const controllerHealth: ControllerHealth[] = [];

    for (const [name, entry] of this.controllers) {
      controllerHealth.push({
        name,
        status: entry.enabled
          ? 'healthy'
          : entry.error
            ? 'unavailable'
            : 'degraded',
        initTimeMs: entry.initTimeMs,
        error: entry.error,
      });
    }

    // Check AgentDB health
    let agentdbAvailable = false;
    if (this.agentdb) {
      try {
        agentdbAvailable = typeof this.agentdb.getController === 'function';
      } catch {
        agentdbAvailable = false;
      }
    }

    const active = controllerHealth.filter((c) => c.status === 'healthy').length;
    const unavailable = controllerHealth.filter((c) => c.status === 'unavailable').length;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (unavailable > 0 && active === 0) {
      status = 'unhealthy';
    } else if (unavailable > 0) {
      status = 'degraded';
    }

    return {
      status,
      controllers: controllerHealth,
      agentdbAvailable,
      initTimeMs: this.initTimeMs,
      timestamp: Date.now(),
      activeControllers: active,
      totalControllers: controllerHealth.length,
    };
  }

  /**
   * Get the underlying AgentDB instance.
   */
  getAgentDB(): any {
    return this.agentdb;
  }

  /**
   * Get the memory backend.
   */
  getBackend(): IMemoryBackend | null {
    return this.backend;
  }

  /**
   * Check if the registry is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the number of active (successfully initialized) controllers.
   */
  getActiveCount(): number {
    let count = 0;
    for (const entry of this.controllers.values()) {
      if (entry.enabled) count++;
    }
    return count;
  }

  /**
   * List all registered controller names and their status.
   */
  listControllers(): Array<{ name: ControllerName; enabled: boolean; level: number }> {
    return Array.from(this.controllers.entries()).map(([name, entry]) => ({
      name,
      enabled: entry.enabled,
      level: entry.level,
    }));
  }

  // ===== Private Methods =====

  /**
   * Initialize AgentDB instance with dynamic import and fallback chain.
   */
  private async initAgentDB(config: RuntimeConfig): Promise<void> {
    // Caller-supplied agentdb wins — used by tests (#2019 regression
    // guards) and by consumers that own the AgentDB lifecycle.
    if (config.agentdb) {
      this.agentdb = config.agentdb;
      this.emit('agentdb:initialized');
      return;
    }

    try {
      // Validate dbPath to prevent path traversal
      const dbPath = config.dbPath || ':memory:';
      if (dbPath !== ':memory:') {
        // Use dynamic import instead of require() — require() is not defined in ESM
        // context and silently kills initAgentDB(), disabling all 15+ controllers (#1492).
        const { resolve: resolvePath } = await import('node:path');
        const resolved = resolvePath(dbPath);
        if (resolved.includes('..')) {
          this.emit('agentdb:unavailable', { reason: 'Invalid dbPath' });
          return;
        }
      }

      const agentdbModule: any = await import('agentdb');
      const AgentDBClass = agentdbModule.AgentDB || agentdbModule.default;

      if (!AgentDBClass) {
        this.emit('agentdb:unavailable', { reason: 'No AgentDB class found' });
        return;
      }

      this.agentdb = new AgentDBClass({ dbPath });

      // Suppress agentdb's noisy info-level output during init
      // using stderr redirect instead of monkey-patching console.log
      const origLog = console.log;
      const suppressFilter = (args: unknown[]) => {
        const msg = String(args[0] ?? '');
        return msg.includes('Transformers.js') ||
               msg.includes('better-sqlite3') ||
               msg.includes('[AgentDB]');
      };
      console.log = (...args: unknown[]) => {
        if (!suppressFilter(args)) origLog.apply(console, args);
      };
      try {
        await this.agentdb.initialize();
      } finally {
        console.log = origLog;
      }
      this.emit('agentdb:initialized');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.emit('agentdb:unavailable', { reason: msg.substring(0, 200) });
      this.agentdb = null;
    }
  }

  /**
   * Check whether a controller should be initialized based on config.
   */
  private isControllerEnabled(name: ControllerName): boolean {
    // Explicit enable/disable from config
    if (this.config.controllers) {
      const explicit = this.config.controllers[name];
      if (explicit !== undefined) return explicit;
    }

    // Default behavior: enable based on category
    switch (name) {
      // Core intelligence — enabled by default
      case 'reasoningBank':
      case 'learningBridge':
      case 'tieredCache':
      case 'hierarchicalMemory':
        return true;

      // Graph — enabled if backend available
      case 'memoryGraph':
        return !!(this.config.memory?.memoryGraph || this.backend);

      // Security — enabled if AgentDB available
      case 'mutationGuard':
      case 'attestationLog':
      case 'vectorBackend':
      case 'guardedVectorBackend':
        return this.agentdb !== null;

      // AgentDB-internal controllers — only if AgentDB available
      case 'skills':
      case 'reflexion':
      case 'causalGraph':
      case 'causalRecall':
      case 'learningSystem':
      case 'explainableRecall':
      case 'graphTransformer':
      case 'graphAdapter':
      case 'gnnService':
      case 'memoryConsolidation':
      case 'batchOperations':
      case 'contextSynthesizer':
      case 'rvfOptimizer':
      case 'mmrDiversityRanker':
        return this.agentdb !== null;

      // ADR-125 Phase 4 — nightlyLearner is enabled when EITHER an AgentDB
      // is present (legacy path) OR a MemoryService is registered (new path
      // backed by MemoryConsolidator.runAll).
      case 'nightlyLearner':
        return this.agentdb !== null || !!this.config.memoryService;

      // SemanticRouter — auto-enable if agentdb available (exported since alpha.10)
      case 'semanticRouter':
        return this.agentdb !== null;

      // ADR-125 Phase 5 — hybridSearch auto-enables when a MemoryService is
      // registered. Replaces the prior "placeholder, require explicit enable"
      // posture.
      case 'hybridSearch':
        return !!this.config.memoryService;

      // Optional controllers
      case 'agentMemoryScope':
      case 'sonaTrajectory':
      case 'federatedSession':
        return false; // Require explicit enabling

      default:
        return false;
    }
  }

  /**
   * Close any prior controller instance for `name` before it is replaced.
   *
   * #2432 fix — pre-fix, `controllers.set(name, ...)` silently orphaned the
   * prior instance. For backends that allocate native / WASM resources
   * (notably `SqlJsRvfBackend` which keeps an Emscripten MEMFS file ~11 MB
   * per `new SQL.Database(buffer)` until `close()` runs), GC'ing the JS
   * wrapper does NOT reclaim the underlying allocation. A long-running
   * `mcp start` process that re-init'd controllers hundreds of times grew
   * external memory by ~36 GB in production over 6 weeks.
   *
   * Best-effort close: catch and ignore errors — replacement must proceed
   * even if the prior instance's close throws (it's already orphaned at
   * this point either way).
   */
  private async closePriorIfAny(name: ControllerName): Promise<void> {
    const prior = this.controllers.get(name);
    if (!prior?.instance) return;
    const inst = prior.instance as { close?: () => unknown; dispose?: () => unknown };
    try {
      if (typeof inst.close === 'function') {
        await inst.close();
      } else if (typeof inst.dispose === 'function') {
        await inst.dispose();
      }
    } catch {
      // Best-effort — leak is preferable to crashing init on a replacement.
    }
  }

  /**
   * Initialize a single controller with error isolation.
   */
  private async initController(name: ControllerName, level: number): Promise<void> {
    const startTime = performance.now();

    // #2432 — close any prior instance before replacing the map entry,
    // otherwise its native/WASM resources leak (e.g. sql.js MEMFS files).
    await this.closePriorIfAny(name);

    try {
      const instance = await this.createController(name);

      const initTimeMs = performance.now() - startTime;

      this.controllers.set(name, {
        name,
        instance,
        level,
        initTimeMs,
        enabled: instance !== null,
        error: instance === null ? 'Controller returned null' : undefined,
      });

      if (instance !== null) {
        this.emit('controller:initialized', { name, level, initTimeMs });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const initTimeMs = performance.now() - startTime;

      this.controllers.set(name, {
        name,
        instance: null,
        level,
        initTimeMs,
        enabled: false,
        error: errorMsg,
      });

      throw error;
    }
  }

  /**
   * Factory method to create a controller instance.
   * Handles CLI-layer controllers; AgentDB-internal controllers are
   * accessed via agentdb.getController().
   */
  private async createController(name: ControllerName): Promise<unknown> {
    switch (name) {
      // ----- CLI-layer controllers -----

      case 'learningBridge': {
        if (!this.backend) return null;
        const config = this.config.memory?.learningBridge || {};
        const bridge = new LearningBridge(this.backend, {
          sonaMode: config.sonaMode || this.config.neural?.sonaMode || 'balanced',
          confidenceDecayRate: config.confidenceDecayRate,
          accessBoostAmount: config.accessBoostAmount,
          consolidationThreshold: config.consolidationThreshold,
          enabled: true,
        });
        return bridge;
      }

      case 'memoryGraph': {
        const config = this.config.memory?.memoryGraph || {};
        const graph = new MemoryGraph({
          pageRankDamping: config.pageRankDamping,
          maxNodes: config.maxNodes,
          ...config,
        });
        // Build from backend if available
        if (this.backend) {
          try {
            await graph.buildFromBackend(this.backend);
          } catch {
            // Graph build from backend failed — empty graph is still usable
          }
        }
        return graph;
      }

      case 'tieredCache': {
        const config = this.config.memory?.tieredCache || {};
        const cache = new TieredCacheManager({
          maxSize: config.maxSize || 10000,
          ttl: config.ttl || 300000,
          lruEnabled: true,
          writeThrough: false,
          ...config,
        });
        return cache;
      }

      case 'hybridSearch': {
        // ADR-125 Phase 5 + ADR-147 P2 — three-arm RRF + MMR hybrid search.
        // Runs semanticSearch() (dense, with graceful fallback),
        // searchKeyword() (sparse FTS5), and a per-entity keyword search
        // (entity arm, gated on extractEntities(query) returning anything)
        // independently in parallel, fuses via RRF, diversifies via MMR.
        // Results carry a `signals` field naming which arms surfaced each
        // entry (provenance for debugging + downstream rerankers).
        //
        // Dream Cycle 2026-08-18: the auto-enable gate (`isControllerEnabled`)
        // already honors an explicit `controllers: { hybridSearch: true }`
        // override, but until now this factory unconditionally required
        // `config.memoryService` regardless of that override — so explicitly
        // opting in without also hand-building a `UnifiedMemoryService`
        // silently produced a disabled controller (no error, no signal why).
        // When no `memoryService` was supplied, fall back to `this.backend`
        // if it duck-types as AgentDBAdapter-compatible (has `semanticSearch`
        // + `searchKeyword`) — the same two methods this factory already
        // calls below. Only reachable when a caller explicitly requests
        // `hybridSearch`; the default (memoryService-only) auto-enable
        // condition and its behavior are unchanged.
        const memSvc = this.config.memoryService;
        const directBackend =
          !memSvc && isHybridCapableBackend(this.backend) ? this.backend : null;
        const adapter = memSvc
          ? typeof memSvc.getAdapter === 'function'
            ? memSvc.getAdapter()
            : null
          : directBackend;
        if (!adapter) return null;

        const { applyRRF, applyMMR } = await import('./smart-retrieval.js');
        const { extractEntities } = await import('./entity-tagger.js');

        return {
          /**
           * Run a fused hybrid search.
           * @param query        Free-form query string.
           * @param opts.limit   Final result count (default 10).
           * @param opts.fanOutK Per-arm fanout before fusion (default = limit * 3).
           * @param opts.mmrLambda MMR relevance/diversity balance (default 0.7).
           */
          search: async (
            query: string,
            opts: { limit?: number; fanOutK?: number; mmrLambda?: number } = {}
          ) => {
            const limit = opts.limit ?? 10;
            const fanOutK = opts.fanOutK ?? Math.max(limit * 3, 20);
            const mmrLambda = opts.mmrLambda ?? 0.7;

            // Adapt SearchResult[] → SearchCandidate[] expected by RRF
            const toCands = (results: any[]) =>
              results.map((r: any) => ({
                id: r.entry.id,
                key: r.entry.key,
                content: r.entry.content,
                namespace: r.entry.namespace,
                metadata: r.entry.metadata,
                createdAt: r.entry.createdAt,
                updatedAt: r.entry.updatedAt,
                score: r.score,
                _entry: r.entry,
              }));

            // Entity arm — only fire if the query actually contains
            // extractable entities. Empty arm is dropped from RRF input
            // so it doesn't dilute the fusion.
            const entities = extractEntities(query);
            const entityFanOut = entities.length > 0
              ? Math.max(1, Math.ceil(fanOutK / entities.length))
              : 0;

            // Run all three arms in parallel. Per-arm try/catch (via the
            // .catch(...) tails) keeps one failing backend from blanking
            // the other arms — the same defensive shape used pre-ADR-147.
            const [dense, sparse, entityHits] = await Promise.all([
              adapter.semanticSearch(query, fanOutK).catch(() => [] as any[]),
              adapter.searchKeyword(query, { k: fanOutK }).catch(() => [] as any[]),
              entities.length > 0
                ? Promise.all(
                    entities.map((e: string) =>
                      adapter.searchKeyword(e, { k: entityFanOut }).catch(() => [] as any[]),
                    ),
                  ).then((perEntity: any[][]) => perEntity.flat())
                : Promise.resolve([] as any[]),
            ]);

            const denseCands = toCands(dense);
            const sparseCands = toCands(sparse);
            const entityCands = toCands(entityHits);

            // Build signal-provenance sets keyed by candidate id BEFORE
            // RRF so we can stamp `signals` onto the fused output.
            const candKey = (c: { id?: string; key?: string; content: string }) =>
              c.id || c.key || c.content.slice(0, 128);
            const denseIds = new Set(denseCands.map(candKey));
            const sparseIds = new Set(sparseCands.map(candKey));
            const entityIds = new Set(entityCands.map(candKey));

            const arms = [denseCands, sparseCands];
            if (entityCands.length > 0) arms.push(entityCands);

            const fused = applyRRF(arms, 60);
            const diverse = applyMMR(fused, mmrLambda, limit);

            return diverse.map((s: any) => {
              const key = candKey(s.candidate);
              const signals: ('vector' | 'bm25' | 'entity')[] = [];
              if (denseIds.has(key)) signals.push('vector');
              if (sparseIds.has(key)) signals.push('bm25');
              if (entityIds.has(key)) signals.push('entity');
              return {
                entry: s.candidate._entry,
                score: s.score,
                signals,
              };
            });
          },
          source: 'hybrid-rrf-mmr' as const,
        };
      }

      case 'agentMemoryScope':
        // Agent memory scope — placeholder, activated when explicitly enabled
        return null;

      case 'semanticRouter':
        // SemanticRouter was exported by agentdb 3.0.0-alpha.10 (ADR-062) but
        // dropped from every installable range (`^3.0.0-alpha.17`) — issue
        // #2977. No fallback implementation exists for this controller;
        // returning null directly instead of attempting a dynamic import
        // that never resolves.
        return null;

      case 'sonaTrajectory':
        // Delegate to AgentDB's SonaTrajectoryService if available
        if (this.agentdb && typeof this.agentdb.getController === 'function') {
          try {
            return this.agentdb.getController('sonaTrajectory');
          } catch {
            return null;
          }
        }
        return null;

      case 'hierarchicalMemory': {
        // HierarchicalMemory was exported by agentdb 3.0.0-alpha.10 (ADR-066
        // Phase P2-3) and REMOVED again at alpha.17 — every installable range
        // (`^3.0.0-alpha.17`) is missing it, and alpha.10 — the one version
        // that DOES export it — throws `RangeError: Too few parameter values
        // were provided` on the very first store() call (issue #2977), so
        // there is no version of agentdb where the native path actually
        // works. The dynamic-import/instantiate attempt is dead code on
        // every install; the tiered fallback is the only implementation that
        // has ever worked here, so it is promoted to first-class instead of
        // being attempted-and-discarded on every init. Still records *why*
        // it's in use, because taking a fallback silently is what made
        // stores look successful while landing nowhere (#2887).
        return this.tieredMemoryFallback(
          this.agentdb ? 'agentdb-export-missing' : 'agentdb-unavailable',
        );
      }

      case 'memoryConsolidation': {
        // MemoryConsolidation was exported by agentdb 3.0.0-alpha.10 (ADR-066
        // Phase P2-3) and removed at alpha.14 — no installable range exports
        // it, and it requires a working HierarchicalMemory instance to
        // construct, which is itself dead (see hierarchicalMemory above,
        // #2977). The no-op stub is therefore the only implementation that
        // has ever worked here; it is promoted to first-class instead of
        // attempting a dynamic import that never resolves.
        return this.createConsolidationStub();
      }

      case 'federatedSession':
        // Federated session — placeholder for Phase 4
        return null;

      // ----- AgentDB-internal controllers (via getController) -----
      // AgentDB.getController() only supports: reflexion/memory, skills, causalGraph/causal
      case 'reasoningBank': {
        // ReasoningBank is exported directly, not via getController
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const RB = agentdbModule.ReasoningBank;
          if (!RB) return null;
          const embedder = this.createEmbeddingService();
          return new RB(this.agentdb.database, embedder);
        } catch { return null; }
      }

      case 'skills':
      case 'reflexion':
      case 'causalGraph': {
        if (!this.agentdb || typeof this.agentdb.getController !== 'function') return null;
        try {
          return this.agentdb.getController(name) ?? null;
        } catch { return null; }
      }

      case 'causalRecall': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const CR = agentdbModule.CausalRecall;
          if (!CR) return null;
          return new CR(this.agentdb.database);
        } catch { return null; }
      }

      case 'learningSystem': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const LS = agentdbModule.LearningSystem;
          if (!LS) return null;
          return new LS(this.agentdb.database);
        } catch { return null; }
      }

      case 'explainableRecall': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const ER = agentdbModule.ExplainableRecall;
          if (!ER) return null;
          return new ER(this.agentdb.database);
        } catch { return null; }
      }

      case 'nightlyLearner': {
        // ADR-125 Phase 4 — prefer the MemoryConsolidator when a
        // MemoryService is registered. The consolidator's `runAll()` is the
        // documented entry point for sweep + dedup + compact and replaces the
        // thin delegate to AgentDB's NightlyLearner.
        const memSvc = this.config.memoryService;
        if (memSvc && typeof memSvc.getConsolidator === 'function') {
          try {
            const consolidator = await memSvc.getConsolidator();
            return {
              run: () => consolidator.runAll(),
              runAll: () => consolidator.runAll(),
              sweepExpired: () => consolidator.sweepExpired(),
              dedup: (s?: any) => consolidator.dedup(s),
              compactHnsw: () => consolidator.compactHnsw(),
              source: 'memory-consolidator' as const,
            };
          } catch { /* fall through to AgentDB */ }
        }

        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const NL = agentdbModule.NightlyLearner;
          if (!NL) return null;
          return new NL(this.agentdb.database);
        } catch { return null; }
      }

      case 'graphTransformer': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const GT = agentdbModule.CausalMemoryGraph;
          if (!GT) return null;
          return new GT(this.agentdb.database);
        } catch { return null; }
      }

      // ----- Direct-instantiation controllers -----
      case 'batchOperations': {
        if (!this.agentdb) return null;
        try {
          const agentdbModule: any = await import('agentdb');
          const BO = agentdbModule.BatchOperations;
          if (!BO) return null;
          const embedder = this.config.embeddingGenerator || null;
          return new BO(this.agentdb.database, embedder);
        } catch { return null; }
      }

      case 'contextSynthesizer': {
        // ContextSynthesizer.synthesize is static — return the class itself
        try {
          const agentdbModule: any = await import('agentdb');
          return agentdbModule.ContextSynthesizer ?? null;
        } catch { return null; }
      }

      case 'mmrDiversityRanker': {
        try {
          const agentdbModule: any = await import('agentdb');
          const MMR = agentdbModule.MMRDiversityRanker;
          if (!MMR) return null;
          return new MMR();
        } catch { return null; }
      }

      // MutationGuard, AttestationLog, GNNService, RVFOptimizer, and
      // GuardedVectorBackend were all exported by agentdb 3.0.0-alpha.10
      // (ADR-060/062/065) but dropped from every installable range
      // (`^3.0.0-alpha.17`) — issue #2977. No fallback implementation exists
      // for any of these five controllers; they return null directly instead
      // of attempting a dynamic import that never resolves.
      case 'mutationGuard':
      case 'attestationLog':
      case 'gnnService':
      case 'rvfOptimizer':
      case 'guardedVectorBackend':
        return null;

      case 'vectorBackend':
      case 'graphAdapter': {
        // These are accessed via AgentDB internal state, not direct
        // construction. Issue #2019: agentdb@3.0.0-alpha.14's
        // `getController()` switch only handles
        // memory/reflexion/skills/causal/causalGraph and throws
        // `Unknown controller: vectorBackend` for everything else —
        // which a try/catch silently swallowed, leaving the controller
        // permanently `enabled: false` even though the field is right
        // there on the agentdb instance (`agentdb.vectorBackend` is
        // assigned in AgentDB.initialize()).
        //
        // Prefer the direct-property access. Fall back to
        // `getController` only if the field is absent — preserves
        // forward-compat with a future agentdb that wires
        // vectorBackend / graphAdapter into the switch but stops
        // exposing them as public fields.
        if (!this.agentdb) return null;
        const agentdb: any = this.agentdb;
        const direct = agentdb[name];
        if (direct) return direct;
        try {
          if (typeof agentdb.getController === 'function') {
            return agentdb.getController(name) ?? null;
          }
        } catch { /* upstream switch threw for an unknown name */ }
        return null;
      }

      default:
        return null;
    }
  }

  /**
   * Shutdown a single controller gracefully.
   */
  private async shutdownController(name: ControllerName): Promise<void> {
    const entry = this.controllers.get(name);
    if (!entry?.instance) return;

    try {
      const instance = entry.instance as any;

      // Try known shutdown methods (always await for safety)
      if (typeof instance.destroy === 'function') {
        await instance.destroy();
      } else if (typeof instance.shutdown === 'function') {
        await instance.shutdown();
      } else if (typeof instance.close === 'function') {
        await instance.close();
      }
    } catch {
      // Best-effort cleanup
    }

    entry.enabled = false;
    entry.instance = null;
  }

  /**
   * Create an EmbeddingService for controllers that need it.
   * Uses the config's embedding generator or creates a minimal local service.
   */
  private createEmbeddingService(): any {
    // If user provided an embedding generator, wrap it
    if (this.config.embeddingGenerator) {
      return {
        embed: async (text: string) => this.config.embeddingGenerator!(text),
        embedBatch: async (texts: string[]) => Promise.all(texts.map(t => this.config.embeddingGenerator!(t))),
        initialize: async () => {},
      };
    }
    // Return a minimal stub — HierarchicalMemory falls back to manualSearch without embeddings
    return {
      embed: async () => new Float32Array(this.config.dimension || 384),
      embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(this.config.dimension || 384)),
      initialize: async () => {},
    };
  }

  /**
   * Tiered store used when agentdb's HierarchicalMemory is unavailable.
   *
   * Since agentdb 3.0.0-alpha.17 dropped the `HierarchicalMemory` export
   * entirely, this is the ONLY backing store for `agentdb_hierarchical-*`
   * in practice — so it is handed AgentDB's SQLite connection and writes
   * through to it. Without a connection it stays volatile and reports
   * `isDurable() === false` so callers can refuse to claim success (#2887).
   *
   * Keeps the legacy duck-typed API — store(key, value, tier) /
   * recall(query, topK) / getTierStats() — plus Zep/Graphiti-style temporal
   * validity (validFrom / validUntil / supersededBy).
   */
  private createTieredMemoryStub(): TieredMemoryStore {
    const db = this.agentdb?.database ?? null;
    const usable = db && typeof db.prepare === 'function' && typeof db.exec === 'function'
      ? db
      : null;
    // Operator configuration only. It is persisted in the database; subsequent
    // processes without this environment variable still honor the stored policy.
    const retention = process.env.RUFLO_HIERARCHICAL_PROTECTED_RETENTION;
    return new TieredMemoryStore({ db: usable,
      ...(retention === undefined ? {} : { protectedRetention: JSON.parse(retention) }) });
  }

  /** Build the tiered fallback and record/emit why the native one was skipped. */
  private tieredMemoryFallback(reason: string): TieredMemoryStore {
    const store = this.createTieredMemoryStub();
    this.hierarchicalFallback = { reason, persistence: store.getPersistence() };
    this.emit('controller:degraded', {
      name: 'hierarchicalMemory',
      reason,
      persistence: store.getPersistence(),
    });
    return store;
  }

  /**
   * Why `hierarchicalMemory` is served by the tiered fallback, and whether
   * that fallback is durable. Null when the native controller is in use.
   */
  getHierarchicalFallback(): { reason: string; persistence: string } | null {
    return this.hierarchicalFallback;
  }

  /**
   * No-op consolidation stub — the first-class implementation for
   * `memoryConsolidation` since agentdb has never shipped a working native
   * MemoryConsolidation on any installable range (#2977). `promoted: 0,
   * pruned: 0` on its own reads as "ran and found nothing to do"; `source`
   * and `note` make it explicit that consolidation never actually ran.
   */
  private createConsolidationStub() {
    return {
      consolidate() {
        return {
          promoted: 0,
          pruned: 0,
          timestamp: Date.now(),
          source: 'stub' as const,
          note: 'no-op: native MemoryConsolidation is unavailable (agentdb never exports a working implementation, #2977) — nothing was consolidated, this did not run',
        };
      },
    };
  }
}

export default ControllerRegistry;
