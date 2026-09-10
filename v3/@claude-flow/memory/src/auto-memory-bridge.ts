/**
 * AutoMemoryBridge - Bidirectional sync between Claude Code Auto Memory and AgentDB
 *
 * Per ADR-048: Bridges Claude Code's auto memory (markdown files at
 * ~/.claude/projects/<project>/memory/) with claude-flow's unified memory
 * system (AgentDB + HNSW).
 *
 * Auto memory files are human-readable markdown that Claude loads into its
 * system prompt. MEMORY.md (first 200 lines) is the entrypoint; topic files
 * store detailed notes and are read on demand.
 *
 * @module @claude-flow/memory/auto-memory-bridge
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import {
  createDefaultEntry,
  type IMemoryBackend,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemoryQuery,
} from './types.js';
import { LearningBridge, type LearningBridgeConfig } from './learning-bridge.js';
import { MemoryGraph, type MemoryGraphConfig } from './memory-graph.js';

// ===== Types =====

/** Insight category for organization in MEMORY.md */
export type InsightCategory =
  | 'project-patterns'
  | 'debugging'
  | 'architecture'
  | 'performance'
  | 'security'
  | 'preferences'
  | 'swarm-results';

/** Sync direction */
export type SyncDirection = 'to-auto' | 'from-auto' | 'bidirectional';

/** Sync mode determines when syncs occur */
export type SyncMode = 'on-write' | 'on-session-end' | 'periodic';

/** Prune strategy for keeping MEMORY.md under line limit */
export type PruneStrategy = 'confidence-weighted' | 'fifo' | 'lru';

/** Configuration for AutoMemoryBridge */
export interface AutoMemoryBridgeConfig {
  /** Auto memory directory path (auto-resolved if not provided) */
  memoryDir?: string;

  /** Working directory for git root detection */
  workingDir?: string;

  /** Max lines for MEMORY.md index (default: 180, Claude reads first 200) */
  maxIndexLines?: number;

  /** Topic file mapping: category → filename */
  topicMapping?: Partial<Record<InsightCategory, string>>;

  /** Sync mode (default: 'on-session-end') */
  syncMode?: SyncMode;

  /** Periodic sync interval in ms (if syncMode is 'periodic') */
  syncIntervalMs?: number;

  /** Minimum confidence for syncing to auto memory (default: 0.7) */
  minConfidence?: number;

  /** Maximum lines per topic file (default: 500) */
  maxTopicFileLines?: number;

  /** Prune strategy for MEMORY.md (default: 'confidence-weighted') */
  pruneStrategy?: PruneStrategy;

  /** Learning bridge config (ADR-049). When set, insights trigger neural learning. */
  learning?: LearningBridgeConfig;

  /** Knowledge graph config (ADR-049). When set, graph-aware curation is enabled. */
  graph?: MemoryGraphConfig;
}

/** A memory insight to record */
export interface MemoryInsight {
  /** Category for organization */
  category: InsightCategory;

  /** One-line summary for MEMORY.md index */
  summary: string;

  /** Detailed content (goes in topic file if > 2 lines) */
  detail?: string;

  /** Source: which agent/hook discovered this */
  source: string;

  /** Confidence score (0-1), used for curation priority */
  confidence: number;

  /** AgentDB entry ID for cross-reference */
  agentDbId?: string;
}

/** Result of a sync operation */
export interface SyncResult {
  /** Number of entries synced */
  synced: number;

  /** Categories that were updated */
  categories: string[];

  /** Duration of sync in milliseconds */
  durationMs: number;

  /** Any errors encountered */
  errors: string[];
}

/** Result of an import operation */
export interface ImportResult {
  /** Number of entries imported */
  imported: number;

  /** Number of entries skipped (already in AgentDB) */
  skipped: number;

  /** Files processed */
  files: string[];

  /** Duration in milliseconds */
  durationMs: number;
}

/** Parsed markdown entry from a topic file */
interface ParsedEntry {
  heading: string;
  content: string;
  metadata: Record<string, string>;
}

// ===== Constants =====

const DEFAULT_TOPIC_MAPPING: Record<InsightCategory, string> = {
  'project-patterns': 'patterns.md',
  'debugging': 'debugging.md',
  'architecture': 'architecture.md',
  'performance': 'performance.md',
  'security': 'security.md',
  'preferences': 'preferences.md',
  'swarm-results': 'swarm-results.md',
};

const CATEGORY_LABELS: Record<string, string> = {
  'project-patterns': 'Project Patterns',
  'debugging': 'Debugging',
  'architecture': 'Architecture',
  'performance': 'Performance',
  'security': 'Security',
  'preferences': 'Preferences',
  'swarm-results': 'Swarm Results',
};

type ResolvedConfig = Required<Omit<AutoMemoryBridgeConfig, 'learning' | 'graph'>> & Pick<AutoMemoryBridgeConfig, 'learning' | 'graph'>;

const DEFAULT_CONFIG: ResolvedConfig = {
  memoryDir: '',
  workingDir: process.env.CLAUDE_FLOW_CWD || process.cwd(),
  maxIndexLines: 180,
  topicMapping: DEFAULT_TOPIC_MAPPING,
  syncMode: 'on-session-end',
  syncIntervalMs: 60_000,
  minConfidence: 0.7,
  maxTopicFileLines: 500,
  pruneStrategy: 'confidence-weighted',
};

// ===== AutoMemoryBridge =====

/**
 * Bidirectional bridge between Claude Code auto memory and AgentDB.
 *
 * @example
 * ```typescript
 * const bridge = new AutoMemoryBridge(memoryBackend, {
 *   workingDir: '/workspaces/my-project',
 * });
 *
 * // Record an insight
 * await bridge.recordInsight({
 *   category: 'debugging',
 *   summary: 'HNSW index requires initialization before search',
 *   source: 'agent:tester',
 *   confidence: 0.95,
 * });
 *
 * // Sync to auto memory files
 * await bridge.syncToAutoMemory();
 *
 * // Import auto memory into AgentDB
 * await bridge.importFromAutoMemory();
 * ```
 */
export class AutoMemoryBridge extends EventEmitter {
  private config: ResolvedConfig;
  private backend: IMemoryBackend;
  private lastSyncTime: number = 0;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private insights: MemoryInsight[] = [];
  /** Track AgentDB keys of insights already written to files during this session */
  private syncedInsightKeys = new Set<string>();
  /** Monotonic counter to prevent key collisions within the same ms */
  private insightCounter = 0;
  /** Optional learning bridge (ADR-049) */
  private learningBridge?: LearningBridge;
  /** Optional knowledge graph (ADR-049) */
  private memoryGraph?: MemoryGraph;

  constructor(backend: IMemoryBackend, config: AutoMemoryBridgeConfig = {}) {
    super();
    this.backend = backend;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      topicMapping: {
        ...DEFAULT_TOPIC_MAPPING,
        ...(config.topicMapping || {}),
      },
    };

    if (!this.config.memoryDir) {
      this.config.memoryDir = resolveAutoMemoryDir(this.config.workingDir);
    }

    if (this.config.syncMode === 'periodic' && this.config.syncIntervalMs > 0) {
      this.startPeriodicSync();
    }

    // ADR-049: Initialize optional learning bridge and knowledge graph
    if (config.learning) {
      this.learningBridge = new LearningBridge(backend, config.learning);
    }
    if (config.graph) {
      this.memoryGraph = new MemoryGraph(config.graph);
    }
  }

  /** Get the resolved auto memory directory path */
  getMemoryDir(): string {
    return this.config.memoryDir;
  }

  /** Get the path to MEMORY.md */
  getIndexPath(): string {
    return path.join(this.config.memoryDir, 'MEMORY.md');
  }

  /** Get the path to a topic file */
  getTopicPath(category: InsightCategory): string {
    const filename = this.config.topicMapping[category] || `${category}.md`;
    return path.join(this.config.memoryDir, filename);
  }

  /**
   * Record a memory insight.
   * Stores in the in-memory buffer and optionally writes immediately.
   */
  async recordInsight(insight: MemoryInsight): Promise<void> {
    this.insights.push(insight);

    // Store in AgentDB
    const key = await this.storeInsightInAgentDB(insight);
    this.syncedInsightKeys.add(key);

    // If sync-on-write, write immediately to files
    if (this.config.syncMode === 'on-write') {
      await this.writeInsightToFiles(insight);
    }

    // ADR-049: Notify learning bridge
    if (this.learningBridge) {
      await this.learningBridge.onInsightRecorded(insight, key);
    }

    this.emit('insight:recorded', insight);
  }

  /**
   * Sync high-confidence AgentDB entries to auto memory files.
   * Called on session-end or periodically.
   */
  async syncToAutoMemory(): Promise<SyncResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    const updatedCategories = new Set<string>();

    try {
      // ADR-049: Consolidate learning trajectories before syncing
      if (this.learningBridge) {
        await this.learningBridge.consolidate();
      }

      // Ensure directory exists
      await this.ensureMemoryDir();

      // Snapshot and clear the buffer atomically to avoid race conditions
      const buffered = this.insights.splice(0, this.insights.length);

      // Flush buffered insights to files
      for (const insight of buffered) {
        try {
          await this.writeInsightToFiles(insight);
          updatedCategories.add(insight.category);
        } catch (err) {
          errors.push(`Failed to write insight: ${(err as Error).message}`);
        }
      }

      // Query AgentDB for high-confidence entries since last sync,
      // skipping entries we already wrote from the buffer above
      const entries = await this.queryRecentInsights();
      for (const entry of entries) {
        const entryKey = entry.key;
        if (this.syncedInsightKeys.has(entryKey)) continue;

        try {
          const category = this.classifyEntry(entry);
          await this.appendToTopicFile(category, entry);
          updatedCategories.add(category);
          this.syncedInsightKeys.add(entryKey);
        } catch (err) {
          errors.push(`Failed to sync entry ${entry.id}: ${(err as Error).message}`);
        }
      }

      // Curate MEMORY.md index
      await this.curateIndex();

      const synced = buffered.length + entries.length;
      this.lastSyncTime = Date.now();

      // Prevent unbounded growth of syncedInsightKeys
      if (this.syncedInsightKeys.size > 10_000) {
        const keys = [...this.syncedInsightKeys];
        this.syncedInsightKeys = new Set(keys.slice(keys.length - 5_000));
      }

      const result: SyncResult = {
        synced,
        categories: [...updatedCategories],
        durationMs: Date.now() - startTime,
        errors,
      };

      this.emit('sync:completed', result);
      return result;
    } catch (err) {
      errors.push(`Sync failed: ${(err as Error).message}`);
      this.emit('sync:failed', { error: err });
      return {
        synced: 0,
        categories: [],
        durationMs: Date.now() - startTime,
        errors,
      };
    }
  }

  /**
   * Import auto memory files into AgentDB.
   * Called on session-start to hydrate AgentDB with previous learnings.
   * Uses bulk insert for efficiency.
   */
  async importFromAutoMemory(): Promise<ImportResult> {
    const startTime = Date.now();
    const memoryDir = this.config.memoryDir;

    if (!existsSync(memoryDir)) {
      return { imported: 0, skipped: 0, files: [], durationMs: 0 };
    }

    let imported = 0;
    let skipped = 0;
    const processedFiles: string[] = [];

    const files = readdirSync(memoryDir).filter(f => f.endsWith('.md'));

    // Pre-fetch existing content hashes to avoid N queries
    const existingHashes = await this.fetchExistingContentHashes();

    // Batch entries for bulk insert
    const batch: MemoryEntry[] = [];

    for (const file of files) {
      const filePath = path.join(memoryDir, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const entries = parseMarkdownEntries(content);

      for (const entry of entries) {
        const contentHash = hashContent(entry.content);

        if (existingHashes.has(contentHash)) {
          skipped++;
          continue;
        }

        const input: MemoryEntryInput = {
          key: `auto-memory:${file}:${entry.heading}`,
          content: entry.content,
          namespace: 'auto-memory',
          type: 'semantic',
          tags: ['auto-memory', file.replace('.md', '')],
          metadata: {
            sourceFile: file,
            heading: entry.heading,
            importedAt: new Date().toISOString(),
            contentHash,
          },
        };

        batch.push(createDefaultEntry(input));
        existingHashes.add(contentHash);
        imported++;
      }

      processedFiles.push(file);
    }

    // Bulk insert all at once
    if (batch.length > 0) {
      await this.backend.bulkInsert(batch);
    }

    // ADR-049: Build knowledge graph from imported entries
    if (this.memoryGraph && batch.length > 0) {
      await this.memoryGraph.buildFromBackend(this.backend, 'auto-memory');
    }

    const result: ImportResult = {
      imported,
      skipped,
      files: processedFiles,
      durationMs: Date.now() - startTime,
    };

    this.emit('import:completed', result);
    return result;
  }

  /**
   * Curate MEMORY.md to stay under the line limit.
   * Groups entries by category and prunes low-confidence items.
   */
  async curateIndex(): Promise<void> {
    await this.ensureMemoryDir();

    // Collect summaries from all topic files
    const sections: Record<string, string[]> = {};

    for (const [category, filename] of Object.entries(this.config.topicMapping)) {
      const topicPath = path.join(this.config.memoryDir, filename as string);
      if (existsSync(topicPath)) {
        const content = await fs.readFile(topicPath, 'utf-8');
        const summaries = extractSummaries(content);
        if (summaries.length > 0) {
          sections[category] = summaries;
        }
      }
    }

    // Fix for #1556: if no topic files matched (e.g. the memory folder uses
    // Claude Code's native `<type>_<topic>.md` convention rather than the
    // hardcoded DEFAULT_TOPIC_MAPPING filenames), do NOT overwrite the
    // existing MEMORY.md with a one-line stub. A `curate` operation must be
    // non-destructive when there is nothing to curate.
    if (Object.keys(sections).length === 0) {
      this.emit('index:skipped', { reason: 'no-matching-topic-files' });
      return;
    }

    // ADR-049: Use graph PageRank to prioritize sections
    let sectionOrder: string[] | undefined;
    if (this.memoryGraph) {
      const topNodes = this.memoryGraph.getTopNodes(20);
      const categoryCounts = new Map<string, number>();
      for (const node of topNodes) {
        const cat = node.community || 'general';
        categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
      }
      sectionOrder = [...categoryCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cat]) => cat)
        .filter((cat) => sections[cat]);
    }

    // Prune sections before building the index to avoid O(n^2) rebuild loop
    const budget = this.config.maxIndexLines;
    pruneSectionsToFit(sections, budget, this.config.pruneStrategy);

    // Build the final index (with optional graph-aware ordering)
    const lines = buildIndexLines(
      sections,
      this.config.topicMapping as Record<string, string>,
      sectionOrder,
    );

    // #3224: never let a curate shrink somebody's index.
    //
    // The #1556 guard above only fires when NOTHING matched. Once the bridge has
    // written its own first topic file, that guard stops applying, and this write
    // replaces a hand-maintained MEMORY.md with a generated stub — 75 curated
    // lines and 49 links down to 6 in the reported case. The bridge only knows
    // about its own topic files, so "everything else" looks like nothing to it.
    //
    // Rule: a curate may grow or reorder the index, never shrink it. When the
    // generated view is smaller than what is on disk, keep the file, write the
    // generated view beside it, and say so.
    const indexPath = this.getIndexPath();
    const generated = lines.join('\n');
    let existing = '';
    try { existing = await fs.readFile(indexPath, 'utf-8'); } catch { /* first run */ }

    const linksIn = (text: string) => (text.match(/\]\(/g) ?? []).length;
    const wouldLose = existing.trim().length > 0
      && (linksIn(existing) > linksIn(generated) || existing.split('\n').length > lines.length);

    if (wouldLose) {
      const sidecar = indexPath.replace(/\.md$/, '') + '.generated.md';
      await fs.writeFile(sidecar, generated, 'utf-8');
      this.emit('index:preserved', {
        reason: 'would-shrink-user-index',
        indexPath,
        sidecar,
        existingLines: existing.split('\n').length,
        generatedLines: lines.length,
        existingLinks: linksIn(existing),
        generatedLinks: linksIn(generated),
      });
      return;
    }

    await fs.writeFile(indexPath, generated, 'utf-8');
    this.emit('index:curated', { lines: lines.length });
  }

  /**
   * Get auto memory status: directory info, file count, line counts.
   */
  getStatus(): {
    memoryDir: string;
    exists: boolean;
    files: { name: string; lines: number }[];
    totalLines: number;
    indexLines: number;
    lastSyncTime: number;
    bufferedInsights: number;
  } {
    const memoryDir = this.config.memoryDir;

    if (!existsSync(memoryDir)) {
      return {
        memoryDir,
        exists: false,
        files: [],
        totalLines: 0,
        indexLines: 0,
        lastSyncTime: this.lastSyncTime,
        bufferedInsights: this.insights.length,
      };
    }

    const fileStats: { name: string; lines: number }[] = [];
    let totalLines = 0;
    let indexLines = 0;

    let mdFiles: string[];
    try {
      mdFiles = readdirSync(memoryDir).filter(f => f.endsWith('.md'));
    } catch {
      return {
        memoryDir,
        exists: true,
        files: [],
        totalLines: 0,
        indexLines: 0,
        lastSyncTime: this.lastSyncTime,
        bufferedInsights: this.insights.length,
      };
    }

    for (const file of mdFiles) {
      try {
        const content = readFileSync(path.join(memoryDir, file), 'utf-8');
        const lineCount = content.split('\n').length;
        fileStats.push({ name: file, lines: lineCount });
        totalLines += lineCount;
        if (file === 'MEMORY.md') {
          indexLines = lineCount;
        }
      } catch {
        // Skip unreadable files
      }
    }

    return {
      memoryDir,
      exists: true,
      files: fileStats,
      totalLines,
      indexLines,
      lastSyncTime: this.lastSyncTime,
      bufferedInsights: this.insights.length,
    };
  }

  /** Stop periodic sync and clean up */
  destroy(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    // ADR-049: Clean up learning bridge
    if (this.learningBridge) {
      this.learningBridge.destroy();
    }
    this.removeAllListeners();
  }

  // ===== Private Methods =====

  private async ensureMemoryDir(): Promise<void> {
    const dir = this.config.memoryDir;
    if (!existsSync(dir)) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  private async storeInsightInAgentDB(insight: MemoryInsight): Promise<string> {
    const content = insight.detail
      ? `${insight.summary}\n\n${insight.detail}`
      : insight.summary;

    const key = `insight:${insight.category}:${Date.now()}:${this.insightCounter++}`;
    const input: MemoryEntryInput = {
      key,
      content,
      namespace: 'learnings',
      type: 'semantic',
      tags: ['insight', insight.category, `source:${insight.source}`],
      metadata: {
        category: insight.category,
        summary: insight.summary,
        source: insight.source,
        confidence: insight.confidence,
        contentHash: hashContent(content),
        ...(insight.agentDbId ? { linkedEntryId: insight.agentDbId } : {}),
      },
    };

    const entry = createDefaultEntry(input);
    await this.backend.store(entry);
    return key;
  }

  private async writeInsightToFiles(insight: MemoryInsight): Promise<void> {
    await this.ensureMemoryDir();

    const topicPath = this.getTopicPath(insight.category);
    const line = formatInsightLine(insight);

    if (existsSync(topicPath)) {
      const existing = await fs.readFile(topicPath, 'utf-8');

      // Exact line-based dedup: check if the summary already appears as a bullet
      if (hasSummaryLine(existing, insight.summary)) return;

      const lineCount = existing.split('\n').length;
      if (lineCount >= this.config.maxTopicFileLines) {
        const pruned = pruneTopicFile(existing, this.config.maxTopicFileLines - 10);
        await fs.writeFile(topicPath, pruned + '\n' + line, 'utf-8');
      } else {
        await fs.appendFile(topicPath, '\n' + line, 'utf-8');
      }
    } else {
      const label = CATEGORY_LABELS[insight.category] || insight.category;
      const header = `# ${label}\n\n`;
      await fs.writeFile(topicPath, header + line, 'utf-8');
    }
  }

  private async queryRecentInsights(): Promise<MemoryEntry[]> {
    const query: MemoryQuery = {
      type: 'hybrid',
      namespace: 'learnings',
      tags: ['insight'],
      updatedAfter: this.lastSyncTime || 0,
      limit: 50,
    };

    try {
      const entries = await this.backend.query(query);
      return entries.filter(e => {
        const confidence = (e.metadata?.confidence as number) || 0;
        return confidence >= this.config.minConfidence;
      });
    } catch {
      return [];
    }
  }

  private classifyEntry(entry: MemoryEntry): InsightCategory {
    const category = entry.metadata?.category as InsightCategory | undefined;
    if (category && category in DEFAULT_TOPIC_MAPPING) {
      return category;
    }

    const tags = entry.tags || [];
    if (tags.includes('debugging') || tags.includes('bug') || tags.includes('fix')) {
      return 'debugging';
    }
    if (tags.includes('architecture') || tags.includes('design')) {
      return 'architecture';
    }
    if (tags.includes('performance') || tags.includes('benchmark')) {
      return 'performance';
    }
    if (tags.includes('security') || tags.includes('cve')) {
      return 'security';
    }
    if (tags.includes('swarm') || tags.includes('agent')) {
      return 'swarm-results';
    }

    return 'project-patterns';
  }

  private async appendToTopicFile(
    category: InsightCategory,
    entry: MemoryEntry,
  ): Promise<void> {
    const insight: MemoryInsight = {
      category,
      summary: (entry.metadata?.summary as string) || entry.content.split('\n')[0],
      detail: entry.content,
      source: (entry.metadata?.source as string) || 'agentdb',
      confidence: (entry.metadata?.confidence as number) || 0.5,
      agentDbId: entry.id,
    };

    await this.writeInsightToFiles(insight);
  }

  /** Fetch all existing content hashes from the auto-memory namespace in one query */
  private async fetchExistingContentHashes(): Promise<Set<string>> {
    try {
      const entries = await this.backend.query({
        type: 'hybrid',
        namespace: 'auto-memory',
        limit: 10_000,
      });
      const hashes = new Set<string>();
      for (const entry of entries) {
        const hash = entry.metadata?.contentHash as string | undefined;
        if (hash) hashes.add(hash);
      }
      return hashes;
    } catch {
      return new Set();
    }
  }

  private startPeriodicSync(): void {
    this.syncTimer = setInterval(async () => {
      try {
        await this.syncToAutoMemory();
      } catch (err) {
        this.emit('sync:error', err);
      }
    }, this.config.syncIntervalMs);

    if (this.syncTimer.unref) {
      this.syncTimer.unref();
    }
  }
}

// ===== Utility Functions =====

/**
 * Resolve the auto memory directory for a given working directory.
 * Mirrors Claude Code's path derivation from git root.
 */
export function resolveAutoMemoryDir(workingDir: string): string {
  const gitRoot = findGitRoot(workingDir);
  const basePath = gitRoot || workingDir;

  // Claude Code normalizes to forward slashes then replaces both `/` and `_`
  // with dashes (e.g. /workspaces/RX_ERP -> -workspaces-RX-ERP). The leading
  // dash IS preserved.
  const normalized = basePath.split(path.sep).join('/');
  const projectKey = normalized.replace(/[\/_]/g, '-');

  return path.join(
    process.env.HOME || process.env.USERPROFILE || '~',
    '.claude',
    'projects',
    projectKey,
    'memory',
  );
}

/**
 * Find the git root directory by walking up from workingDir.
 */
export function findGitRoot(dir: string): string | null {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (current !== root) {
    if (existsSync(path.join(current, '.git'))) {
      return current;
    }
    current = path.dirname(current);
  }

  return null;
}

/**
 * Parse markdown content into structured entries.
 *
 * Three-tier strategy to handle both legacy topic files and Claude Code's
 * native auto-memory format:
 *  1. Strip YAML frontmatter if present and capture name/description/type.
 *  2. Split body on `## ` headings (legacy MEMORY.md-style topic files).
 *  3. If no `## ` headings were found, fall back to a single entry per file
 *     using frontmatter.name as the heading (or `(untitled)`), the
 *     post-frontmatter body as content, and frontmatter fields as metadata.
 *
 * Without (3), files like Claude Code's `~/.claude/projects/<key>/memory/*.md`
 * (frontmatter + free-text body, no `## ` sub-headings) parse to zero entries
 * and silently drop on import. See issue #2283.
 */
export function parseMarkdownEntries(content: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];

  // Strip YAML frontmatter and capture key fields.
  const frontmatter: Record<string, string> = {};
  let body = content;
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (fmMatch) {
    body = fmMatch[2];
    for (const fmLine of fmMatch[1].split(/\r?\n/)) {
      const kv = fmLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (kv) frontmatter[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
    }
  }

  const lines = body.split('\n');
  let currentHeading = '';
  let currentLines: string[] = [];
  let sawHeading = false;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      sawHeading = true;
      if (currentHeading && currentLines.length > 0) {
        entries.push({
          heading: currentHeading,
          content: currentLines.join('\n').trim(),
          metadata: {},
        });
      }
      currentHeading = headingMatch[1];
      currentLines = [];
    } else if (currentHeading) {
      currentLines.push(line);
    }
  }

  if (currentHeading && currentLines.length > 0) {
    entries.push({
      heading: currentHeading,
      content: currentLines.join('\n').trim(),
      metadata: {},
    });
  }

  if (!sawHeading) {
    const trimmedBody = body.trim();
    if (trimmedBody) {
      const heading = frontmatter.name || frontmatter.description || '(untitled)';
      const metadata: Record<string, string> = {};
      if (frontmatter.type) metadata.type = frontmatter.type;
      if (frontmatter.description) metadata.description = frontmatter.description;
      if (frontmatter.originSessionId) metadata.originSessionId = frontmatter.originSessionId;
      entries.push({ heading, content: trimmedBody, metadata });
    }
  }

  return entries;
}

/**
 * Extract clean one-line summaries from a topic file.
 * Returns bullet-point items (lines starting with '- '), stripping
 * metadata annotations like _(source, date, conf: 0.95)_.
 */
export function extractSummaries(content: string): string[] {
  return content
    .split('\n')
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(line => !line.startsWith('See `'))
    .map(line => line.replace(/\s*_\(.*?\)_\s*$/, '').trim())
    .filter(Boolean);
}

/**
 * Format an insight as a markdown line for topic files.
 */
export function formatInsightLine(insight: MemoryInsight): string {
  const timestamp = new Date().toISOString().split('T')[0];
  const prefix = `- ${insight.summary}`;
  const suffix = ` _(${insight.source}, ${timestamp}, conf: ${insight.confidence.toFixed(2)})_`;

  if (insight.detail && insight.detail.split('\n').length > 2) {
    return `${prefix}${suffix}\n  ${insight.detail.split('\n').join('\n  ')}`;
  }

  return `${prefix}${suffix}`;
}

/**
 * Hash content for deduplication.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Prune a topic file to stay under the line limit.
 * Removes oldest entries (those closest to the top after the header).
 */
export function pruneTopicFile(content: string, maxLines: number): string {
  const lines = content.split('\n');
  if (lines.length <= maxLines) return content;

  const header = lines.slice(0, 3);
  const entries = lines.slice(3);
  const kept = entries.slice(entries.length - (maxLines - 3));
  return [...header, ...kept].join('\n');
}

/**
 * Check if a summary already exists as a bullet line in topic file content.
 * Uses exact bullet prefix matching (not substring) to avoid false positives.
 */
export function hasSummaryLine(content: string, summary: string): boolean {
  // Match lines that start with "- <summary>" (possibly followed by metadata)
  return content.split('\n').some(line =>
    line.startsWith(`- ${summary}`)
  );
}

/**
 * Prune sections to fit within a line budget.
 * Removes entries from the largest sections first.
 */
function pruneSectionsToFit(
  sections: Record<string, string[]>,
  budget: number,
  strategy: PruneStrategy,
): void {
  // Pre-compute total line count: title(1) + blank(1) + per-section(heading + items + "See..." + blank)
  let totalLines = 2;
  for (const summaries of Object.values(sections)) {
    totalLines += 1 + summaries.length + 1 + 1;
  }

  while (totalLines > budget) {
    const sorted = Object.entries(sections)
      .filter(([, items]) => items.length > 1)
      .sort((a, b) => b[1].length - a[1].length);

    if (sorted.length === 0) break;

    const [targetCat, targetItems] = sorted[0];

    if (strategy === 'lru' || strategy === 'fifo') {
      targetItems.shift();
    } else {
      targetItems.pop();
    }
    totalLines--; // one fewer bullet line

    if (targetItems.length === 0) {
      delete sections[targetCat];
      totalLines -= 3; // heading + "See..." + blank removed
    }
  }
}

/**
 * Build MEMORY.md index lines from curated sections.
 */
function buildIndexLines(
  sections: Record<string, string[]>,
  topicMapping: Record<string, string>,
  sectionOrder?: string[],
): string[] {
  const lines: string[] = ['# Claude Flow V3 Project Memory', ''];

  // Use provided order, then append any remaining sections
  const orderedCategories = sectionOrder
    ? [...sectionOrder, ...Object.keys(sections).filter((k) => !sectionOrder.includes(k))]
    : Object.keys(sections);

  for (const category of orderedCategories) {
    const summaries = sections[category];
    if (!summaries || summaries.length === 0) continue;
    const label = CATEGORY_LABELS[category] || category;
    const filename = topicMapping[category] || `${category}.md`;

    lines.push(`## ${label}`);
    for (const summary of summaries) {
      lines.push(`- ${summary}`);
    }
    lines.push(`- See \`${filename}\` for details`);
    lines.push('');
  }

  return lines;
}

export default AutoMemoryBridge;
