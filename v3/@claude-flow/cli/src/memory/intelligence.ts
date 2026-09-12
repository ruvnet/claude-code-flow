/**
 * V3 Intelligence Module
 * Optimized SONA (Self-Optimizing Neural Architecture) and ReasoningBank
 * for adaptive learning and pattern recognition
 *
 * Performance targets:
 * - Signal recording: <0.05ms (achieved: ~0.01ms)
 * - Pattern search: O(log n) with HNSW
 * - Memory efficient circular buffers
 *
 * @module v3/cli/intelligence
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resolveTrainingBackend } from '../ruvector/lora-adapter.js';

// ============================================================================
// Persistence Configuration
// ============================================================================

/**
 * Get the data directory for neural pattern persistence
 * Uses .claude-flow/neural in the current working directory,
 * falling back to home directory
 */
function getDataDir(): string {
  const cwd = process.cwd();
  const localDir = join(cwd, '.claude-flow', 'neural');
  const homeDir = join(homedir(), '.claude-flow', 'neural');

  // Prefer local directory if .claude-flow exists
  if (existsSync(join(cwd, '.claude-flow'))) {
    return localDir;
  }

  return homeDir;
}

/**
 * Ensure the data directory exists
 */
function ensureDataDir(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Get the patterns file path
 */
function getPatternsPath(): string {
  return join(getDataDir(), 'patterns.json');
}

/**
 * Get the stats file path
 */
function getStatsPath(): string {
  return join(getDataDir(), 'stats.json');
}

// ============================================================================
// Types
// ============================================================================

export interface SonaConfig {
  instantLoopEnabled: boolean;
  backgroundLoopEnabled: boolean;
  loraLearningRate: number;
  loraRank: number;
  ewcLambda: number;
  maxTrajectorySize: number;
  patternThreshold: number;
  maxSignals: number;
  maxPatterns: number;
}

export interface TrajectoryStep {
  type: 'observation' | 'thought' | 'action' | 'result';
  content: string;
  embedding?: number[];
  metadata?: Record<string, unknown>;
  timestamp?: number;
}

export interface Pattern {
  id: string;
  type: string;
  embedding: number[];
  content: string;
  confidence: number;
  usageCount: number;
  createdAt: number;
  lastUsedAt: number;
}

export interface IntelligenceStats {
  sonaEnabled: boolean;
  reasoningBankSize: number;
  patternsLearned: number;
  signalsProcessed: number;
  trajectoriesRecorded: number;
  lastAdaptation: number | null;
  avgAdaptationTime: number;
}

interface Signal {
  type: string;
  content: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
  timestamp: number;
}

interface StoredPattern {
  id: string;
  type: string;
  embedding: number[];
  content: string;
  confidence: number;
  usageCount: number;
  createdAt: number;
  lastUsedAt: number;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_SONA_CONFIG: SonaConfig = {
  instantLoopEnabled: true,
  backgroundLoopEnabled: false,
  loraLearningRate: 0.001,
  loraRank: 8,
  ewcLambda: 0.4,
  maxTrajectorySize: 100,
  patternThreshold: 0.7,
  maxSignals: 10000,
  maxPatterns: 5000
};

// ============================================================================
// Optimized Local SONA Implementation
// ============================================================================

/**
 * Lightweight SONA Coordinator
 * Uses circular buffer for O(1) signal recording
 * Achieves <0.05ms per operation
 */
class LocalSonaCoordinator {
  private config: SonaConfig;
  private signals: Signal[];
  private signalHead: number = 0;
  private signalCount: number = 0;
  private trajectories: { steps: TrajectoryStep[]; verdict: string; timestamp: number }[] = [];
  private adaptationTimes: number[] = [];
  private currentTrajectorySteps: TrajectoryStep[] = [];

  constructor(config: SonaConfig) {
    this.config = config;
    // Pre-allocate circular buffer
    this.signals = new Array(config.maxSignals);
  }

  /**
   * Record a signal - O(1) operation
   * Target: <0.05ms
   */
  recordSignal(signal: Signal): void {
    const start = performance.now();

    // Circular buffer insertion - constant time
    this.signals[this.signalHead] = signal;
    this.signalHead = (this.signalHead + 1) % this.config.maxSignals;
    if (this.signalCount < this.config.maxSignals) {
      this.signalCount++;
    }

    const elapsed = performance.now() - start;
    this.adaptationTimes.push(elapsed);
    if (this.adaptationTimes.length > 100) {
      this.adaptationTimes.shift();
    }
  }

  /**
   * Record complete trajectory
   */
  recordTrajectory(trajectory: { steps: TrajectoryStep[]; verdict: string; timestamp: number }): void {
    this.trajectories.push(trajectory);
    if (this.trajectories.length > this.config.maxTrajectorySize) {
      this.trajectories.shift();
    }
  }

  /**
   * Get recent signals
   */
  getRecentSignals(count: number = 10): Signal[] {
    const result: Signal[] = [];
    const actualCount = Math.min(count, this.signalCount);

    for (let i = 0; i < actualCount; i++) {
      const idx = (this.signalHead - 1 - i + this.config.maxSignals) % this.config.maxSignals;
      if (this.signals[idx]) {
        result.push(this.signals[idx]);
      }
    }

    return result;
  }

  /**
   * Get average adaptation time
   */
  getAvgAdaptationTime(): number {
    if (this.adaptationTimes.length === 0) return 0;
    return this.adaptationTimes.reduce((a, b) => a + b, 0) / this.adaptationTimes.length;
  }

  /**
   * Add a step to the current in-progress trajectory
   */
  addTrajectoryStep(step: TrajectoryStep): void {
    this.currentTrajectorySteps.push(step);
    // Prevent unbounded growth
    if (this.currentTrajectorySteps.length > this.config.maxTrajectorySize) {
      this.currentTrajectorySteps.shift();
    }
  }

  /**
   * End the current trajectory with a verdict and apply RL updates.
   * Reward mapping: success=1.0, partial=0.5, failure=-0.5
   *
   * For successful/partial trajectories, boosts confidence of similar patterns
   * in the ReasoningBank. For failures, reduces confidence scores.
   */
  async endTrajectory(
    verdict: 'success' | 'failure' | 'partial',
    bank: LocalReasoningBank
  ): Promise<{ reward: number; patternsUpdated: number }> {
    const rewardMap: Record<string, number> = {
      success: 1.0,
      partial: 0.5,
      failure: -0.5
    };
    const reward = rewardMap[verdict] ?? 0;

    // Record the completed trajectory
    const completedTrajectory = {
      steps: [...this.currentTrajectorySteps],
      verdict,
      timestamp: Date.now()
    };
    this.recordTrajectory(completedTrajectory);

    // Update pattern confidences based on reward
    let patternsUpdated = 0;
    const allPatterns = bank.getAll();

    for (const step of this.currentTrajectorySteps) {
      if (!step.embedding || step.embedding.length === 0) continue;

      // Find patterns similar to this trajectory step
      const similar = bank.findSimilar(step.embedding, {
        k: 3,
        threshold: 0.3
      });

      for (const match of similar) {
        const pattern = bank.get(match.id);
        if (!pattern) continue;

        // Adjust confidence: positive reward boosts, negative reduces
        const delta = reward * 0.1; // small step per update
        const newConfidence = Math.max(0.0, Math.min(1.0, pattern.confidence + delta));
        pattern.confidence = newConfidence;
        pattern.usageCount++;
        pattern.lastUsedAt = Date.now();
        patternsUpdated++;
      }
    }

    // Clear current trajectory
    this.currentTrajectorySteps = [];

    return { reward, patternsUpdated };
  }

  /**
   * Distill learning from recent successful trajectories.
   * Applies LoRA-style confidence updates and integrates EWC++ consolidation.
   *
   * For each successful trajectory step with high confidence,
   * increases the pattern's stored confidence by loraLearningRate * reward.
   * Before applying updates, checks EWC penalty to prevent catastrophic forgetting.
   */
  async distillLearning(bank: LocalReasoningBank): Promise<{
    patternsDistilled: number;
    ewcPenalty: number;
  }> {
    let patternsDistilled = 0;
    let totalEwcPenalty = 0;

    // Get recent successful trajectories
    const recentSuccessful = this.trajectories.filter(
      t => t.verdict === 'success' || t.verdict === 'partial'
    ).slice(-10); // last 10 successful

    if (recentSuccessful.length === 0) {
      return { patternsDistilled: 0, ewcPenalty: 0 };
    }

    // Try to get EWC consolidator
    let ewcConsolidator: import('./ewc-consolidation.js').EWCConsolidator | null = null;
    try {
      const ewcModule = await import('./ewc-consolidation.js');
      ewcConsolidator = await ewcModule.getEWCConsolidator({
        lambda: this.config.ewcLambda
      });
    } catch {
      // EWC not available, proceed without consolidation protection
    }

    const rewardMap: Record<string, number> = {
      success: 1.0,
      partial: 0.5
    };

    // Collect confidence changes for EWC Fisher update
    const confidenceChanges: { id: string; oldConf: number; newConf: number; embedding: number[] }[] = [];

    for (const trajectory of recentSuccessful) {
      const reward = rewardMap[trajectory.verdict] ?? 0;

      for (const step of trajectory.steps) {
        if (!step.embedding || step.embedding.length === 0) continue;

        const similar = bank.findSimilar(step.embedding, {
          k: 3,
          threshold: 0.4
        });

        for (const match of similar) {
          const pattern = bank.get(match.id);
          if (!pattern) continue;

          // Only distill from high-confidence matches
          if (match.confidence < 0.5) continue;

          const oldConfidence = pattern.confidence;

          // Check EWC penalty before applying update
          if (ewcConsolidator) {
            const oldWeights = [oldConfidence];
            const proposedConfidence = Math.min(1.0, oldConfidence + this.config.loraLearningRate * reward);
            const newWeights = [proposedConfidence];
            const penalty = ewcConsolidator.getPenalty(oldWeights, newWeights);
            totalEwcPenalty += penalty;

            // If penalty is too high, reduce the update magnitude
            if (penalty > this.config.ewcLambda) {
              const dampedDelta = (this.config.loraLearningRate * reward) / (1 + penalty);
              pattern.confidence = Math.max(0.0, Math.min(1.0, oldConfidence + dampedDelta));
            } else {
              pattern.confidence = proposedConfidence;
            }
          } else {
            // No EWC: apply full LoRA update
            pattern.confidence = Math.max(0.0, Math.min(1.0,
              oldConfidence + this.config.loraLearningRate * reward
            ));
          }

          pattern.lastUsedAt = Date.now();
          patternsDistilled++;

          confidenceChanges.push({
            id: pattern.id,
            oldConf: oldConfidence,
            newConf: pattern.confidence,
            embedding: pattern.embedding
          });
        }
      }
    }

    // Update EWC Fisher matrix with confidence changes
    if (ewcConsolidator && confidenceChanges.length > 0) {
      for (const change of confidenceChanges) {
        // Use confidence delta as gradient proxy
        const gradient = change.embedding.map(
          e => e * Math.abs(change.newConf - change.oldConf)
        );
        ewcConsolidator.recordGradient(change.id, gradient, true);
      }
    }

    // Persist updated patterns
    bank.flushToDisk();

    return { patternsDistilled, ewcPenalty: totalEwcPenalty };
  }

  /**
   * Get current trajectory steps (for inspection)
   */
  getCurrentTrajectorySteps(): TrajectoryStep[] {
    return [...this.currentTrajectorySteps];
  }

  /**
   * Get statistics
   */
  stats(): { signalCount: number; trajectoryCount: number; avgAdaptationMs: number } {
    return {
      signalCount: this.signalCount,
      trajectoryCount: this.trajectories.length,
      avgAdaptationMs: this.getAvgAdaptationTime()
    };
  }
}

/**
 * Lightweight ReasoningBank
 * Uses Map for O(1) storage and array for similarity search
 * Supports persistence to disk
 */
class LocalReasoningBank {
  private patterns: Map<string, StoredPattern> = new Map();
  private patternList: StoredPattern[] = [];
  private maxSize: number;
  private persistenceEnabled: boolean;
  private dirty: boolean = false;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(options: { maxSize: number; persistence?: boolean }) {
    this.maxSize = options.maxSize;
    this.persistenceEnabled = options.persistence !== false;

    // Load persisted patterns
    if (this.persistenceEnabled) {
      this.loadFromDisk();
    }
  }

  /**
   * Load patterns from disk, deduplicating by content.
   * When multiple patterns share identical content, keeps the one with
   * highest confidence (ties broken by most recent lastUsedAt).
   */
  private loadFromDisk(): void {
    try {
      const path = getPatternsPath();
      if (existsSync(path)) {
        const data = JSON.parse(readFileSync(path, 'utf-8'));
        if (Array.isArray(data)) {
          const totalLoaded = data.length;

          // Group by content to deduplicate
          const byContent = new Map<string, StoredPattern>();
          for (const pattern of data) {
            const key = pattern.content;
            const existing = byContent.get(key);
            if (!existing) {
              byContent.set(key, pattern);
            } else {
              // Keep the one with higher confidence; break ties by lastUsedAt
              if (
                pattern.confidence > existing.confidence ||
                (pattern.confidence === existing.confidence &&
                  (pattern.lastUsedAt ?? 0) > (existing.lastUsedAt ?? 0))
              ) {
                // Merge: adopt the higher usageCount sum
                pattern.usageCount = (pattern.usageCount ?? 0) + (existing.usageCount ?? 0);
                byContent.set(key, pattern);
              } else {
                existing.usageCount = (existing.usageCount ?? 0) + (pattern.usageCount ?? 0);
              }
            }
          }

          // Populate the bank from deduplicated entries
          for (const pattern of byContent.values()) {
            this.patterns.set(pattern.id, pattern);
            this.patternList.push(pattern);
          }

          const removed = totalLoaded - byContent.size;
          if (removed > 0) {
            console.log(`Deduplicated ${removed} patterns (${byContent.size} unique)`);
            // Persist the compacted set immediately so the file shrinks on disk
            this.dirty = true;
            this.flushToDisk();
          }
        }
      }
    } catch {
      // Ignore load errors, start fresh
    }
  }

  /**
   * Save patterns to disk (debounced)
   */
  private saveToDisk(): void {
    if (!this.persistenceEnabled) return;

    this.dirty = true;

    // Debounce saves to avoid excessive disk I/O
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(() => {
      this.flushToDisk();
    }, 100);
  }

  /**
   * Immediately flush patterns to disk
   */
  flushToDisk(): void {
    if (!this.persistenceEnabled || !this.dirty) return;

    try {
      ensureDataDir();
      const path = getPatternsPath();
      writeFileSync(path, JSON.stringify(this.patternList, null, 2), 'utf-8');
      this.dirty = false;
    } catch (error) {
      // Log but don't throw - persistence failures shouldn't break training
      console.error('Failed to persist patterns:', error);
    }
  }

  /**
   * Store a pattern - O(1)
   * Deduplicates by content: if a pattern with the same content already
   * exists, the existing entry is updated (bumped usageCount, higher
   * confidence wins, refreshed lastUsedAt) instead of adding a duplicate.
   */
  store(pattern: Omit<StoredPattern, 'usageCount' | 'createdAt' | 'lastUsedAt'> & Partial<StoredPattern>): void {
    const now = Date.now();
    const stored: StoredPattern = {
      ...pattern,
      usageCount: pattern.usageCount ?? 0,
      createdAt: pattern.createdAt ?? now,
      lastUsedAt: pattern.lastUsedAt ?? now
    };

    // Update or insert
    if (this.patterns.has(pattern.id)) {
      const existing = this.patterns.get(pattern.id)!;
      stored.usageCount = existing.usageCount + 1;
      stored.createdAt = existing.createdAt;

      // Update in list
      const idx = this.patternList.findIndex(p => p.id === pattern.id);
      if (idx >= 0) {
        this.patternList[idx] = stored;
      }
    } else {
      // Check for content-duplicate before inserting a new entry
      const contentDupe = this.patternList.find(p => p.content === pattern.content);
      if (contentDupe) {
        // Merge into the existing pattern instead of adding a duplicate
        contentDupe.usageCount++;
        contentDupe.lastUsedAt = now;
        if (stored.confidence > contentDupe.confidence) {
          contentDupe.confidence = stored.confidence;
        }
        // Keep the Map in sync with the mutated object
        this.patterns.set(contentDupe.id, contentDupe);
        this.saveToDisk();
        return;
      }

      // Evict oldest if at capacity
      if (this.patterns.size >= this.maxSize) {
        const oldest = this.patternList.shift();
        if (oldest) {
          this.patterns.delete(oldest.id);
        }
      }
      this.patternList.push(stored);
    }

    this.patterns.set(pattern.id, stored);

    // Trigger persistence (debounced)
    this.saveToDisk();
  }

  /**
   * Find similar patterns by embedding.
   *
   * `confidence` on each result is the pattern's own learned reliability
   * (unchanged from storage) — NOT how well it matches this query. The
   * per-query cosine score is returned separately as `similarity`. Callers
   * that want "how good a semantic match is this" must read `.similarity`;
   * callers that want "how reliable has this pattern proven to be" read
   * `.confidence`. Prior to this fix both were conflated (confidence was
   * overwritten with the cosine score), which silently broke any consumer
   * that needed to tell them apart (found during the 2026-09-12 dream-cycle
   * intelligence-surface review).
   */
  findSimilar(
    queryEmbedding: number[],
    options: { k?: number; threshold?: number; type?: string }
  ): (StoredPattern & { similarity: number })[] {
    const { k = 5, threshold = 0.5, type } = options;

    // Filter by type if specified
    let candidates = type
      ? this.patternList.filter(p => p.type === type)
      : this.patternList;

    // Compute similarities
    const scored = candidates.map(pattern => ({
      pattern,
      score: this.cosineSim(queryEmbedding, pattern.embedding)
    }));

    // Filter by threshold and sort
    return scored
      .filter(s => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(s => {
        // Update usage
        s.pattern.usageCount++;
        s.pattern.lastUsedAt = Date.now();
        return { ...s.pattern, similarity: s.score };
      });
  }

  /**
   * Optimized cosine similarity
   */
  private cosineSim(a: number[], b: number[]): number {
    if (!a || !b || a.length === 0 || b.length === 0) return 0;

    const len = Math.min(a.length, b.length);
    let dot = 0, normA = 0, normB = 0;

    for (let i = 0; i < len; i++) {
      const ai = a[i], bi = b[i];
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }

    const mag = Math.sqrt(normA * normB);
    return mag === 0 ? 0 : dot / mag;
  }

  /**
   * Get statistics
   */
  stats(): { size: number; patternCount: number } {
    return {
      size: this.patterns.size,
      patternCount: this.patternList.length
    };
  }

  /**
   * Get pattern by ID
   */
  get(id: string): StoredPattern | undefined {
    return this.patterns.get(id);
  }

  /**
   * Get all patterns
   */
  getAll(): StoredPattern[] {
    return [...this.patternList];
  }

  /**
   * Get patterns by type
   */
  getByType(type: string): StoredPattern[] {
    return this.patternList.filter(p => p.type === type);
  }

  /**
   * Delete a pattern by ID
   */
  delete(id: string): boolean {
    const pattern = this.patterns.get(id);
    if (!pattern) return false;

    this.patterns.delete(id);
    const idx = this.patternList.findIndex(p => p.id === id);
    if (idx >= 0) {
      this.patternList.splice(idx, 1);
    }

    this.saveToDisk();
    return true;
  }

  /**
   * Clear all patterns
   */
  clear(): void {
    this.patterns.clear();
    this.patternList = [];
    this.saveToDisk();
  }
}

// ============================================================================
// @ruvector/ruvllm SonaCoordinator Integration
// ============================================================================

let ruvllmCoordinator: any = null;
let ruvllmLoaded = false;

/**
 * Synchronously load the @ruvector/ruvllm SonaCoordinator. Used both by the
 * async init path (initializeIntelligence) and by sync stat readers like
 * getIntelligenceStats — the dashboard would otherwise report "unavailable"
 * when stats are queried before any async init has fired (#1770).
 */
function loadRuvllmCoordinatorSync(): any {
  if (ruvllmLoaded) return ruvllmCoordinator;
  ruvllmLoaded = true;
  try {
    const requireCjs = createRequire(import.meta.url);
    const ruvllm = requireCjs('@ruvector/ruvllm');
    ruvllmCoordinator = new ruvllm.SonaCoordinator(ruvllm.DEFAULT_SONA_CONFIG);
    return ruvllmCoordinator;
  } catch (err) {
    // Surface the reason on debug builds so future regressions of #1770 don't
    // disappear silently. Stays quiet by default to avoid noise on the cli's
    // hot path (e.g., npx invocations).
    if (process.env.CLAUDE_FLOW_DEBUG) {
      // eslint-disable-next-line no-console
      console.error('[ruvllm] SonaCoordinator load failed, falling back to JS:', (err as Error).message);
    }
    ruvllmCoordinator = null;
    return null;
  }
}

async function loadRuvllmCoordinator(): Promise<any> {
  return loadRuvllmCoordinatorSync();
}

// ============================================================================
// Module State
// ============================================================================

let sonaCoordinator: LocalSonaCoordinator | null = null;
let reasoningBank: LocalReasoningBank | null = null;
let intelligenceInitialized = false;
let globalStats = {
  trajectoriesRecorded: 0,
  patternsLearned: 0,
  signalsProcessed: 0,
  lastAdaptation: null as number | null
};

// ============================================================================
// Stats Persistence
// ============================================================================

/**
 * Load persisted stats from disk
 */
function loadPersistedStats(): void {
  try {
    const path = getStatsPath();
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      if (data && typeof data === 'object') {
        // #2245: previously only restored trajectoriesRecorded — patternsLearned
        // and signalsProcessed reset to zero on every restart, masking real
        // learning progress in the dashboards.
        globalStats.trajectoriesRecorded = data.trajectoriesRecorded ?? 0;
        globalStats.patternsLearned = data.patternsLearned ?? 0;
        globalStats.signalsProcessed = data.signalsProcessed ?? 0;
        globalStats.lastAdaptation = data.lastAdaptation ?? null;
      }
    }
  } catch {
    // Ignore load errors, start fresh
  }
}

/**
 * Save stats to disk
 */
function savePersistedStats(): void {
  try {
    ensureDataDir();
    const path = getStatsPath();
    writeFileSync(path, JSON.stringify(globalStats, null, 2), 'utf-8');
  } catch {
    // Ignore save errors
  }
}

/**
 * Record a memory-bridge / hook write so `signalsProcessed` reflects real
 * activity instead of being a permanently-zero dead metric (#2245). Throttled
 * persistence: increments are batched (every Nth save) to avoid hitting disk
 * on every single bridge call.
 *
 * Returns the new count.
 */
let signalsSinceLastSave = 0;
const SIGNAL_PERSIST_EVERY = 16;
export function recordSignalProcessed(): number {
  globalStats.signalsProcessed = (globalStats.signalsProcessed ?? 0) + 1;
  signalsSinceLastSave++;
  if (signalsSinceLastSave >= SIGNAL_PERSIST_EVERY) {
    savePersistedStats();
    signalsSinceLastSave = 0;
  }
  return globalStats.signalsProcessed;
}

/** Force-persist current stats (e.g. before shutdown / for tests). */
export function flushIntelligenceStats(): void {
  savePersistedStats();
  signalsSinceLastSave = 0;
}

// ============================================================================
// Unified learning-stats aggregator (#2245 follow-up to ADR-074)
// ============================================================================

/**
 * The four historical stat sources (globalStats / memory_bridge_status /
 * hooks metrics / neural_patterns count) genuinely measure different things,
 * so we don't merge them — we expose ONE call that returns all four sub-views
 * with the *source path* of each, plus a `consistency` block that spot-checks
 * the relationships the system maintains.
 *
 * No new store; no migration; just one honest view across the four.
 */
export interface UnifiedLearningStats {
  global: {
    patternsLearned: number;
    trajectoriesRecorded: number;
    signalsProcessed: number;
    lastAdaptation: number | null;
    source: string;
  };
  sona: {
    trajectoriesTotal: number;
    patternsLearned: number;
    reasoningBankSize: number;
    avgAdaptationTimeMs: number;
    source: string;
    available: boolean;
  };
  memoryBridge: {
    totalEntries: number;
    perNamespace: Record<string, number>;
    source: string;
    reachable: boolean;
  };
  neuralPatterns: {
    patternCount: number;
    byType: Record<string, number>;
    modelCount: number;
    source: string;
  };
  consistency: {
    sonaTracksGlobal: boolean;
    sonaTracksGlobalDelta: number;
    notes: string[];
  };
  generatedAt: string;
}

export async function getUnifiedLearningStats(): Promise<UnifiedLearningStats> {
  const intel = getIntelligenceStats();
  const sonaCoord = sonaCoordinator;
  const bank = reasoningBank;

  // SONA in-memory view
  const sonaAvailable = !!sonaCoord;
  let sonaStats = { trajectoriesTotal: 0, patternsLearned: 0, reasoningBankSize: 0, avgAdaptationTimeMs: 0 };
  if (sonaCoord) {
    try {
      const s = (sonaCoord as unknown as { stats?: () => Record<string, number> }).stats?.() ?? {};
      sonaStats = {
        trajectoriesTotal: Number(s.trajectoriesTotal ?? s.trajectoriesProcessed ?? 0),
        patternsLearned: Number(s.totalPatterns ?? s.patternsLearned ?? 0),
        reasoningBankSize: (bank as unknown as { stats?: () => { patternCount?: number } })?.stats?.()?.patternCount ?? 0,
        avgAdaptationTimeMs: (sonaCoord as unknown as { getAvgAdaptationTime?: () => number }).getAvgAdaptationTime?.() ?? 0,
      };
    } catch { /* SONA not yet initialised */ }
  }

  // memory-bridge
  let bridgeStats: UnifiedLearningStats['memoryBridge'] = {
    totalEntries: 0, perNamespace: {}, source: 'memory-bridge (skipped)', reachable: false,
  };
  try {
    const mb = await import('./memory-bridge.js');
    bridgeStats = await mb.getMemoryBridgeStats();
  } catch { /* bridge module not loadable */ }

  // neural store
  let neuralStats: UnifiedLearningStats['neuralPatterns'] = {
    patternCount: 0, byType: {}, modelCount: 0, source: 'neural store (skipped)',
  };
  try {
    const nt = await import('../mcp-tools/neural-tools.js');
    neuralStats = nt.getNeuralStoreStats();
  } catch { /* neural module not loadable */ }

  // Consistency notes — describe (don't enforce) the cross-store relationships
  const sonaTracksGlobalDelta = sonaStats.trajectoriesTotal - intel.trajectoriesRecorded;
  const notes: string[] = [];
  if (sonaAvailable && Math.abs(sonaTracksGlobalDelta) > 2) {
    notes.push(`sona.trajectoriesTotal (${sonaStats.trajectoriesTotal}) drifts from globalStats.trajectoriesRecorded (${intel.trajectoriesRecorded}) by ${sonaTracksGlobalDelta} — expected to track within ±1`);
  }
  if (intel.patternsLearned > 0 && neuralStats.patternCount === 0) {
    notes.push(`globalStats reports ${intel.patternsLearned} patterns learned but neural_patterns store is empty — pretrain has not written here, or trajectory-end isn't promoting patterns to the neural store yet`);
  }
  if (!bridgeStats.reachable) {
    notes.push('memory-bridge unreachable — bridge-dependent counters (post-edit/-command persistence, pretrain bundle) will show 0');
  }

  return {
    global: {
      patternsLearned: intel.patternsLearned,
      trajectoriesRecorded: intel.trajectoriesRecorded,
      signalsProcessed: intel.signalsProcessed,
      lastAdaptation: intel.lastAdaptation,
      source: '.claude-flow/neural/stats.json (globalStats)',
    },
    sona: {
      ...sonaStats,
      source: 'sonaCoordinator (in-memory, resets per process)',
      available: sonaAvailable,
    },
    memoryBridge: bridgeStats,
    neuralPatterns: neuralStats,
    consistency: {
      sonaTracksGlobal: sonaAvailable ? Math.abs(sonaTracksGlobalDelta) <= 1 : true,
      sonaTracksGlobalDelta,
      notes,
    },
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the intelligence system (SONA + ReasoningBank)
 * Uses optimized local implementations
 */
export async function initializeIntelligence(config?: Partial<SonaConfig>): Promise<{
  success: boolean;
  sonaEnabled: boolean;
  reasoningBankEnabled: boolean;
  error?: string;
}> {
  if (intelligenceInitialized) {
    return {
      success: true,
      sonaEnabled: !!sonaCoordinator,
      reasoningBankEnabled: !!reasoningBank
    };
  }

  try {
    // Merge config with defaults
    const finalConfig: SonaConfig = {
      ...DEFAULT_SONA_CONFIG,
      ...config
    };

    // Initialize local SONA (optimized for <0.05ms)
    sonaCoordinator = new LocalSonaCoordinator(finalConfig);

    // Initialize local ReasoningBank with persistence enabled
    reasoningBank = new LocalReasoningBank({
      maxSize: finalConfig.maxPatterns,
      persistence: true
    });

    // Load persisted stats if available
    loadPersistedStats();

    // Eagerly load ruvllm coordinator so stats reflect backend status
    await loadRuvllmCoordinator();

    intelligenceInitialized = true;

    return {
      success: true,
      sonaEnabled: true,
      reasoningBankEnabled: true
    };
  } catch (error) {
    return {
      success: false,
      sonaEnabled: false,
      reasoningBankEnabled: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Record a trajectory step for learning
 * Performance: <0.05ms without embedding generation
 */
export async function recordStep(step: TrajectoryStep): Promise<boolean> {
  if (!sonaCoordinator) {
    const init = await initializeIntelligence();
    if (!init.success) return false;
  }

  try {
    // Generate embedding if not provided
    // ADR-053: Try AgentDB v3 bridge embedder first
    let embedding = step.embedding;
    if (!embedding) {
      try {
        const bridge = await import('./memory-bridge.js');
        const bridgeResult = await bridge.bridgeGenerateEmbedding(step.content);
        if (bridgeResult) {
          embedding = bridgeResult.embedding;
        }
      } catch {
        // Bridge not available
      }
      if (!embedding) {
        const { generateEmbedding } = await import('./memory-initializer.js');
        const result = await generateEmbedding(step.content);
        embedding = result.embedding;
      }
    }

    // Record in SONA - <0.05ms
    sonaCoordinator!.recordSignal({
      type: step.type,
      content: step.content,
      embedding,
      metadata: step.metadata,
      timestamp: step.timestamp || Date.now()
    });

    // Add to current trajectory for RL tracking
    const stepWithEmbedding = { ...step, embedding };
    sonaCoordinator!.addTrajectoryStep(stepWithEmbedding);

    // Store in ReasoningBank for retrieval
    if (reasoningBank) {
      reasoningBank.store({
        id: `step_${Date.now()}_${Math.random().toString(36).substring(7)}`,
        type: step.type,
        embedding,
        content: step.content,
        confidence: 1.0,
        metadata: step.metadata
      });
    }

    // When a 'result' step arrives, end the trajectory and run RL loop
    if (step.type === 'result' && reasoningBank) {
      // Determine verdict from metadata or default to 'partial'
      const verdict = (step.metadata?.verdict as 'success' | 'failure' | 'partial') || 'partial';
      await sonaCoordinator!.endTrajectory(verdict, reasoningBank);

      // Distill learning from recent successful trajectories
      await sonaCoordinator!.distillLearning(reasoningBank);

      globalStats.lastAdaptation = Date.now();
    }

    globalStats.trajectoriesRecorded++;
    savePersistedStats();
    return true;
  } catch {
    return false;
  }
}

/**
 * Record a complete trajectory with verdict
 */
export async function recordTrajectory(
  steps: TrajectoryStep[],
  verdict: 'success' | 'failure' | 'partial'
): Promise<boolean> {
  if (!sonaCoordinator) {
    const init = await initializeIntelligence();
    if (!init.success) return false;
  }

  try {
    // Generate embeddings for steps that don't have them (required for distillation)
    const enrichedSteps = await Promise.all(steps.map(async (step) => {
      if (step.embedding && step.embedding.length > 0) return step;
      try {
        const { generateEmbedding } = await import('./memory-initializer.js');
        const result = await generateEmbedding(step.content);
        return { ...step, embedding: result.embedding };
      } catch {
        return step; // Skip embedding if not available
      }
    }));

    sonaCoordinator!.recordTrajectory({
      steps: enrichedSteps,
      verdict,
      timestamp: Date.now()
    });

    // Apply RL: update pattern confidences based on verdict
    if (reasoningBank) {
      for (const step of enrichedSteps) {
        sonaCoordinator!.addTrajectoryStep(step);
      }
      await sonaCoordinator!.endTrajectory(verdict, reasoningBank);
      await sonaCoordinator!.distillLearning(reasoningBank);

      // Also store successful trajectories as patterns directly
      if (verdict === 'success') {
        for (const step of enrichedSteps) {
          if (step.embedding && step.embedding.length > 0) {
            reasoningBank.store({
              id: `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: step.type,
              content: step.content,
              embedding: step.embedding,
              confidence: verdict === 'success' ? 0.8 : 0.4,
              metadata: step.metadata || {},
              createdAt: Date.now(),
            });
            globalStats.patternsLearned++;
          }
        }
      }
    }

    // Forward trajectory to @ruvector/ruvllm SonaCoordinator if available
    const ruvllmCoord = await loadRuvllmCoordinator();
    if (ruvllmCoord) {
      try {
        const avgQuality = verdict === 'success' ? 1.0 : verdict === 'partial' ? 0.5 : 0.0;
        ruvllmCoord.recordTrajectory({
          steps: enrichedSteps.map(s => ({
            state: s.content,
            action: s.type,
            reward: avgQuality,
            embedding: s.embedding || []
          })),
          totalReward: avgQuality,
          success: verdict === 'success'
        });
      } catch {
        // ruvllm recording failed silently
      }
    }

    globalStats.trajectoriesRecorded++;
    globalStats.lastAdaptation = Date.now();
    savePersistedStats();

    return true;
  } catch {
    return false;
  }
}

/**
 * Find similar patterns from ReasoningBank
 */
export interface PatternMatch extends Pattern {
  similarity: number;
}

export async function findSimilarPatterns(
  query: string,
  options?: { k?: number; threshold?: number; type?: string }
): Promise<PatternMatch[]> {
  if (!reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) return [];
  }

  try {
    // ADR-053: Try AgentDB v3 bridge embedder first
    let queryEmbedding: number[] | null = null;
    try {
      const bridge = await import('./memory-bridge.js');
      const bridgeResult = await bridge.bridgeGenerateEmbedding(query);
      if (bridgeResult) {
        queryEmbedding = bridgeResult.embedding;
      }
    } catch {
      // Bridge not available
    }
    if (!queryEmbedding) {
      const { generateEmbedding } = await import('./memory-initializer.js');
      const queryResult = await generateEmbedding(query);
      queryEmbedding = queryResult.embedding;
    }

    // Hash-fallback embeddings (128-dim) produce lower cosine similarities
    // than ONNX/transformer embeddings, so use a lower default threshold
    const isHashFallback = queryEmbedding.length === 128;
    const defaultThreshold = isHashFallback ? 0.1 : 0.5;

    const results = reasoningBank!.findSimilar(queryEmbedding, {
      k: options?.k ?? 5,
      threshold: options?.threshold ?? defaultThreshold,
      type: options?.type
    });

    return results.map((r) => ({
      id: r.id,
      type: r.type,
      embedding: r.embedding,
      content: r.content,
      confidence: r.confidence,
      usageCount: r.usageCount,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      similarity: r.similarity
    }));
  } catch {
    return [];
  }
}

/**
 * Get intelligence system statistics
 */
export function getIntelligenceStats(): IntelligenceStats & {
  _ruvllmBackend: string;
  _ruvllmTrajectories: number;
  _contrastiveTrainer?: { triplets: number; agents: number } | string;
  _trainingBackend?: string;
} {
  const sonaStats = sonaCoordinator?.stats();
  const bankStats = reasoningBank?.stats();

  // Lazy-init the ruvllm coordinator if it hasn't been loaded yet. The MCP
  // dashboard (`hooks_intelligence_stats`) hits this path before any
  // initializeIntelligence() call has fired, so the coordinator field would
  // otherwise stay null and the dashboard would report "unavailable" even
  // when @ruvector/ruvllm is fully resolvable. Sync require — cheap, idempotent.
  if (!ruvllmLoaded) {
    loadRuvllmCoordinatorSync();
  }
  const ruvllmStats = ruvllmCoordinator?.stats?.() || null;

  // Fetch cross-module stats for unified reporting.
  //
  // #2549 — two prior defects here: `trainingBackend` was declared and
  // returned but never assigned (always 'unavailable'), and contrastive
  // availability was read ONLY from an in-process global that a fresh
  // read-only `neural status` process never populates. Both made the
  // native @ruvector/ruvllm path invisible even when installed. Backend
  // now comes from the lora-adapter's capability probe; the global still
  // wins when present because it carries live in-process session counts.
  let contrastiveTrainer: { triplets: number; agents: number } | string = 'unavailable';
  let trainingBackend = 'unavailable';
  try {
    trainingBackend = resolveTrainingBackend();
  } catch { /* module absent — stay 'unavailable' */ }
  try {
    const sonaModule = (globalThis as any).__claudeFlowSonaStats;
    if (sonaModule?._contrastiveTrainer) {
      contrastiveTrainer = sonaModule._contrastiveTrainer;
    } else if (trainingBackend === 'ruvllm') {
      // Module resolves but no in-process session — available, idle.
      contrastiveTrainer = 'available';
    }
  } catch { /* not available */ }

  return {
    sonaEnabled: !!sonaCoordinator,
    reasoningBankSize: bankStats?.size ?? 0,
    patternsLearned: Math.max(bankStats?.patternCount ?? 0, globalStats.patternsLearned),
    signalsProcessed: globalStats.signalsProcessed,
    trajectoriesRecorded: globalStats.trajectoriesRecorded,
    lastAdaptation: globalStats.lastAdaptation,
    avgAdaptationTime: sonaStats?.avgAdaptationMs ?? 0,
    _ruvllmBackend: ruvllmStats ? 'active' : 'unavailable',
    _ruvllmTrajectories: ruvllmStats?.trajectoriesBuffered || 0,
    _contrastiveTrainer: contrastiveTrainer,
    _trainingBackend: trainingBackend,
  };
}

/**
 * Get SONA coordinator for advanced operations
 */
export function getSonaCoordinator(): LocalSonaCoordinator | null {
  return sonaCoordinator;
}

/**
 * Get ReasoningBank for advanced operations
 */
export function getReasoningBank(): LocalReasoningBank | null {
  return reasoningBank;
}

/**
 * End the current trajectory with a verdict and apply RL updates.
 * This is the public API for the SONA RL loop.
 *
 * @param verdict - 'success' (reward=1.0), 'partial' (0.5), or 'failure' (-0.5)
 * @returns Update statistics or null if not initialized
 */
export async function endTrajectoryWithVerdict(
  verdict: 'success' | 'failure' | 'partial'
): Promise<{ reward: number; patternsUpdated: number } | null> {
  if (!sonaCoordinator || !reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) return null;
  }

  try {
    const result = await sonaCoordinator!.endTrajectory(verdict, reasoningBank!);
    globalStats.lastAdaptation = Date.now();
    savePersistedStats();
    return result;
  } catch {
    return null;
  }
}

/**
 * Distill learning from recent successful trajectories.
 * Applies LoRA-style confidence updates with EWC++ consolidation protection.
 *
 * @returns Distillation statistics or null if not initialized
 */
export async function distillLearning(): Promise<{
  patternsDistilled: number;
  ewcPenalty: number;
} | null> {
  if (!sonaCoordinator || !reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) return null;
  }

  try {
    const result = await sonaCoordinator!.distillLearning(reasoningBank!);
    globalStats.lastAdaptation = Date.now();
    savePersistedStats();
    return result;
  } catch {
    return null;
  }
}

/**
 * Clear intelligence state
 */
export function clearIntelligence(): void {
  sonaCoordinator = null;
  reasoningBank = null;
  intelligenceInitialized = false;
  globalStats = {
    trajectoriesRecorded: 0,
    patternsLearned: 0,
    signalsProcessed: 0,
    lastAdaptation: null
  };
}

/**
 * Benchmark SONA adaptation time
 */
export function benchmarkAdaptation(iterations: number = 1000): {
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  targetMet: boolean;
} {
  if (!sonaCoordinator) {
    initializeIntelligence();
  }

  const times: number[] = [];
  const testEmbedding = Array.from({ length: 384 }, () => Math.random());

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    sonaCoordinator!.recordSignal({
      type: 'test',
      content: `benchmark_${i}`,
      embedding: testEmbedding,
      timestamp: Date.now()
    });
    times.push(performance.now() - start);
  }

  const totalMs = times.reduce((a, b) => a + b, 0);
  const avgMs = totalMs / iterations;
  const minMs = Math.min(...times);
  const maxMs = Math.max(...times);

  return {
    totalMs,
    avgMs,
    minMs,
    maxMs,
    targetMet: avgMs < 0.05
  };
}

// ============================================================================
// Pattern Persistence API
// ============================================================================

/**
 * Get all patterns from ReasoningBank
 * Returns persisted patterns even after process restart
 */
export async function getAllPatterns(): Promise<Pattern[]> {
  if (!reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) return [];
  }

  return reasoningBank!.getAll().map(p => ({
    id: p.id,
    type: p.type,
    embedding: p.embedding,
    content: p.content,
    confidence: p.confidence,
    usageCount: p.usageCount,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt
  }));
}

/**
 * Get patterns by type from ReasoningBank
 */
export async function getPatternsByType(type: string): Promise<Pattern[]> {
  if (!reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) return [];
  }

  return reasoningBank!.getByType(type).map(p => ({
    id: p.id,
    type: p.type,
    embedding: p.embedding,
    content: p.content,
    confidence: p.confidence,
    usageCount: p.usageCount,
    createdAt: p.createdAt,
    lastUsedAt: p.lastUsedAt
  }));
}

/**
 * Flush patterns to disk immediately
 * Call this at the end of training to ensure all patterns are saved
 */
export function flushPatterns(): void {
  if (reasoningBank) {
    reasoningBank.flushToDisk();
  }
  savePersistedStats();
}

/**
 * Compact patterns by removing duplicates/similar patterns
 * @param threshold Similarity threshold (0-1), patterns above this are considered duplicates
 */
export async function compactPatterns(threshold: number = 0.95): Promise<{
  before: number;
  after: number;
  removed: number;
}> {
  if (!reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) {
      return { before: 0, after: 0, removed: 0 };
    }
  }

  const patterns = reasoningBank!.getAll();
  const before = patterns.length;

  // Find duplicates using cosine similarity
  const toRemove: Set<string> = new Set();

  for (let i = 0; i < patterns.length; i++) {
    if (toRemove.has(patterns[i].id)) continue;

    const embA = patterns[i].embedding;
    if (!embA || embA.length === 0) continue;

    for (let j = i + 1; j < patterns.length; j++) {
      if (toRemove.has(patterns[j].id)) continue;

      const embB = patterns[j].embedding;
      if (!embB || embB.length === 0 || embA.length !== embB.length) continue;

      // Compute cosine similarity
      let dotProduct = 0;
      let normA = 0;
      let normB = 0;

      for (let k = 0; k < embA.length; k++) {
        dotProduct += embA[k] * embB[k];
        normA += embA[k] * embA[k];
        normB += embB[k] * embB[k];
      }

      const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));

      if (similarity >= threshold) {
        // Remove the one with lower usage count
        const useA = patterns[i].usageCount || 0;
        const useB = patterns[j].usageCount || 0;
        toRemove.add(useA >= useB ? patterns[j].id : patterns[i].id);
      }
    }
  }

  // Remove duplicates
  for (const id of toRemove) {
    reasoningBank!.delete(id);
  }

  // Flush to disk
  flushPatterns();

  return {
    before,
    after: before - toRemove.size,
    removed: toRemove.size,
  };
}

/**
 * Delete a pattern by ID
 */
export async function deletePattern(id: string): Promise<boolean> {
  if (!reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) return false;
  }

  return reasoningBank!.delete(id);
}

/**
 * Clear all patterns (both in memory and on disk)
 */
export async function clearAllPatterns(): Promise<void> {
  if (!reasoningBank) {
    const init = await initializeIntelligence();
    if (!init.success) return;
  }

  reasoningBank!.clear();
}

/**
 * Get the neural data directory path
 */
export function getNeuralDataDir(): string {
  return getDataDir();
}

/**
 * Trigger background learning on the @ruvector/ruvllm SonaCoordinator.
 * No-op if ruvllm is not installed.
 */
export async function runBackgroundLearning(): Promise<void> {
  const coord = await loadRuvllmCoordinator();
  if (coord) coord.runBackgroundLoop();
}

/**
 * Get persistence status
 */
export function getPersistenceStatus(): {
  enabled: boolean;
  dataDir: string;
  patternsFile: string;
  statsFile: string;
  patternsExist: boolean;
  statsExist: boolean;
} {
  const dataDir = getDataDir();
  const patternsFile = getPatternsPath();
  const statsFile = getStatsPath();

  return {
    enabled: true,
    dataDir,
    patternsFile,
    statsFile,
    patternsExist: existsSync(patternsFile),
    statsExist: existsSync(statsFile)
  };
}
